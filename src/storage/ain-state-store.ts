import { createHash, randomBytes } from "node:crypto";
import { EncryptedStateCodec, STATE_VERSION, StateHead, StateValue } from "./encrypted-state";
import { AinWriteRejected, ChainOperation, StateChainTransport } from "./ain-transport";

interface StoredHead extends StateHead { previousRevision: string | null; deleted?: boolean }
class StateRevisionConflict extends Error {}
/** Install this exact rule at heads/$recordId before enabling the adapter. */
export function stateHeadWriteRule(address: string): string {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw Error("Invalid state signer address");
  return `auth.addr === '${address}' && util.isDict(newData) && util.checkValuePathLen(parsedValuePath, 5) === true && newData.previousRevision === (data === null ? null : data.revision) && newData.revision !== (data === null ? null : data.revision)`;
}
/** Chunks are write-once; a revision no head points at any more may only be removed. */
export function stateChunksWriteRule(address: string): string {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw Error("Invalid state signer address");
  return `auth.addr === '${address}' && util.checkValuePathLen(parsedValuePath, 7) === true && (newData === null || (data === null && util.isString(newData)))`;
}
/** The original chunk rule. It cannot remove anything, so every superseded revision stayed on chain. */
export function legacyStateChunksWriteRule(address: string): string {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw Error("Invalid state signer address");
  return `auth.addr === '${address}' && data === null && util.isString(newData) && util.checkValuePathLen(parsedValuePath, 7) === true`;
}

/**
 * SHA-256 over the sorted `recordId:revision` of every head that is not a tombstone. Any write
 * changes it, so chain cleanup can refuse a verification that is no longer current.
 */
export async function headsFingerprint(chain: StateChainTransport, root: string): Promise<{ heads: number; sha256: string }> {
  if (!chain.childLabels) throw Error("Fingerprinting needs a chain transport that lists child labels");
  const lines: string[] = [];
  for (const id of await chain.childLabels(`${root}/heads`)) {
    const head = await chain.get<StoredHead>(`${root}/heads/${id}`);
    if (head && !head.deleted) lines.push(`${id}:${head.revision}`);
  }
  lines.sort();
  return { heads: lines.length, sha256: createHash("sha256").update(lines.join("\n")).digest("hex") };
}

/** Default budget for decrypted records kept in memory. */
export const DEFAULT_STATE_CACHE_BYTES = 32 * 1024 * 1024;

export class AinStateStore {
  private queue: Promise<unknown> = Promise.resolve();
  // Decrypted records by revision, least recently used first. Bounded by an
  // approximate byte budget: an unbounded cache grew until the heap ran out.
  private readonly cache = new Map<string, { revision: string; state: StateValue; bytes: number }>();
  private cacheBytes = 0;
  constructor(private readonly chain: StateChainTransport, private readonly codec: EncryptedStateCodec,
    readonly root: string, private readonly clock = Date.now,
    private readonly cacheMaxBytes = DEFAULT_STATE_CACHE_BYTES,
    // Off only while the chain still carries the legacy chunk rule, which rejects removals.
    private readonly pruneRevisions = true) {
    if (!/^\/apps\/[a-zA-Z0-9_]+\/state$/.test(root)) throw Error("State root must be an organization app's state path");
    if (!Number.isSafeInteger(cacheMaxBytes) || cacheMaxBytes < 0) throw Error("Invalid state cache size");
  }
  get cachedBytes(): number { return this.cacheBytes; }
  private cacheGet(id: string, revision: string): StateValue | null {
    const entry = this.cache.get(id);
    if (entry?.revision !== revision) return null;
    this.cache.delete(id); this.cache.set(id, entry);
    return entry.state;
  }
  private cacheSet(id: string, revision: string, state: StateValue): void {
    this.cacheDelete(id);
    // Strings dominate record size; UTF-16 keeps two bytes per code unit.
    const bytes = 2 * (state.key.length + JSON.stringify(state.value).length);
    // A single record larger than a quarter of the budget would evict most others.
    if (bytes > this.cacheMaxBytes / 4) return;
    this.cache.set(id, { revision, state, bytes });
    this.cacheBytes += bytes;
    for (const [oldest, entry] of this.cache) {
      if (this.cacheBytes <= this.cacheMaxBytes) break;
      this.cache.delete(oldest); this.cacheBytes -= entry.bytes;
    }
  }
  private cacheDelete(id: string): void {
    const entry = this.cache.get(id);
    if (!entry) return;
    this.cache.delete(id); this.cacheBytes -= entry.bytes;
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(action, action);
    this.queue = pending.catch(() => {});
    return pending;
  }
  private headPath(id: string) { return `${this.root}/heads/${id}`; }
  private chunkPath(id: string, revision: string, index: number) { return `${this.root}/chunks/${id}/${revision}/${index}`; }
  /** The committed record, expired or not. */
  private async load(id: string): Promise<{ head: StoredHead | null; state: StateValue | null }> {
    for (let attempt = 0; ; attempt++) {
      const head = await this.chain.get<StoredHead>(this.headPath(id));
      if (!head || head.deleted) { this.cacheDelete(id); return { head, state: null }; }
      let state = this.cacheGet(id, head.revision);
      if (state) return { head, state };
      // Reject untrusted sizes before allocating requests for a forged header.
      if (!Number.isInteger(head.chunks) || head.chunks < 1 || head.chunks > 21846) throw Error("Invalid AIN state chunk count");
      const chunks: string[] = [];
      for (let index = 0; index < head.chunks; index++) {
        const chunk = await this.chain.get<string>(this.chunkPath(id, head.revision, index));
        if (typeof chunk !== "string") break;
        chunks.push(chunk);
      }
      if (chunks.length < head.chunks) {
        // Another writer may have superseded this revision and removed its chunks
        // between our two reads; only a head that stays put proves loss.
        const latest = await this.chain.get<StoredHead>(this.headPath(id));
        if (latest?.revision !== head.revision && attempt < 4) continue;
        throw Error("Committed AIN state is missing a chunk");
      }
      state = this.codec.openRecord(id, head, chunks);
      this.cacheSet(id, head.revision, state);
      return { head, state };
    }
  }
  private async read(id: string): Promise<{ head: StoredHead | null; state: StateValue | null }> {
    const { head, state } = await this.load(id);
    return { head, state: state && this.expired(state) ? null : state };
  }
  private expired(state: StateValue) { return state.expiresAt !== null && state.expiresAt <= this.clock(); }
  /** Removals for every chunk of a revision that a new head has replaced. */
  private supersededChunks(id: string, previous: StoredHead | null): ChainOperation[] {
    if (!this.pruneRevisions || !previous || previous.deleted || !Number.isInteger(previous.chunks) || previous.chunks < 1 || previous.chunks > 21846) return [];
    return Array.from({ length: previous.chunks }, (_, index) => ({ type: "SET_VALUE" as const, ref: this.chunkPath(id, previous.revision, index), value: null }));
  }
  private fits(batch: ChainOperation[], operation: ChainOperation): boolean {
    return batch.length < (this.chain.operationCountLimit ?? 50)
      && Buffer.byteLength(JSON.stringify([...batch, operation])) <= (this.chain.operationJsonBytesLimit ?? 4500);
  }
  /** Removal is cleanup, never part of the acknowledged write: leftovers are found again by sweep(). */
  private async removeQuietly(operations: ChainOperation[]): Promise<void> {
    let batch: ChainOperation[] = [];
    try {
      for (const operation of operations) {
        if (batch.length && !this.fits(batch, operation)) { await this.chain.write(batch); batch = []; }
        batch.push(operation);
      }
      if (batch.length) await this.chain.write(batch);
    } catch { /* left for sweep() */ }
  }
  private async commit(key: string, previous: StoredHead | null, state: StateValue | null): Promise<void> {
    const id = this.codec.recordId(key);
    let head: StoredHead;
    const operations: ChainOperation[] = [];
    if (state) {
      const sealed = this.codec.seal(state);
      for (let index = 0; index < sealed.chunks.length; index++) {
        operations.push({ type: "SET_VALUE", ref: `${this.root}/chunks/${id}/${sealed.head.revision}/${index}`, value: sealed.chunks[index] });
      }
      head = { ...sealed.head, previousRevision: previous?.revision ?? null };
    } else head = { version: 1, revision: randomBytes(16).toString("hex"), chunks: 0, sha256: "0".repeat(64), previousRevision: previous?.revision ?? null, deleted: true };
    // The on-chain rule compares previousRevision at execution, including other
    // processes. A read/check alone cannot provide this guarantee.
    operations.push({ type: "SET_VALUE", ref: this.headPath(id), value: head });
    const leftovers: ChainOperation[] = [];
    try {
      // Confirm chunk batches in order; publish the header in the last batch.
      // Normal small records commit all chunks and the CAS header together.
      const budget = this.chain.operationJsonBytesLimit ?? 4500;
      let batch: ChainOperation[] = [];
      for (const operation of operations) {
        if (batch.length && !this.fits(batch, operation)) {
          await this.chain.write(batch); batch = [];
        }
        if (Buffer.byteLength(JSON.stringify([operation])) > budget) throw Error("AIN state operation exceeds the transaction size bound");
        batch.push(operation);
      }
      // Removing the superseded revision rides in the header's transaction when it
      // fits, so it commits or fails together with the CAS.
      for (const operation of this.supersededChunks(id, previous)) {
        if (this.fits(batch, operation)) batch.push(operation); else leftovers.push(operation);
      }
      if (batch.length) await this.chain.write(batch);
    }
    catch (error) {
      if (error instanceof AinWriteRejected) {
        // The competing write can be executed in the pending tree while our
        // reads still see finalized state. Wait briefly for its confirmation.
        const deadline = Date.now() + 5000;
        do {
          const latest = await this.chain.get<StoredHead>(this.headPath(id));
          if (latest?.revision !== previous?.revision && latest?.revision !== head.revision) throw new StateRevisionConflict("AIN state revision changed");
          if (Date.now() >= deadline) break;
          await new Promise(resolve => setTimeout(resolve, 500));
        } while (true);
      }
      throw error;
    }
    this.cacheDelete(id);
    await this.removeQuietly(leftovers);
  }
  private async change<T>(key: string, modify: (current: StateValue | null) => { state: StateValue | null; result: T; unchanged?: boolean }): Promise<T> {
    const id = this.codec.recordId(key);
    for (let attempt = 0; ; attempt++) {
      const current = await this.read(id), change = modify(current.state);
      if (change.unchanged) return change.result;
      try { await this.commit(key, current.head, change.state); return change.result; }
      catch (error) {
        // Network/finality failures are ambiguous and must never become a pass.
        if (attempt >= 4 || !(error instanceof StateRevisionConflict)) throw error;
      }
    }
  }
  async get(key: string): Promise<string | null> {
    const { state } = await this.read(this.codec.recordId(key));
    if (!state) return null;
    if (state.type !== "string") throw Error("WRONGTYPE state value is not a string");
    return state.value as string;
  }
  mGet(keys: string[]): Promise<(string | null)[]> { return Promise.all(keys.map(key => this.get(key))); }
  set(key: string, value: string): Promise<string> {
    return this.serialize(() => this.change(key, () => ({ state: { key, type: "string", value, expiresAt: null }, result: "OK" })));
  }
  /** Write only when the key is absent. The head CAS makes this hold across processes too. */
  setNX(key: string, value: string): Promise<boolean> {
    return this.serialize(() => this.change(key, current => current
      ? { state: current, result: false, unchanged: true }
      : { state: { key, type: "string", value, expiresAt: null }, result: true }));
  }
  setEx(key: string, seconds: number, value: string): Promise<string> {
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return Promise.reject(Error("Invalid state expiry"));
    const expiresAt = this.clock() + seconds * 1000;
    return this.serialize(() => this.change(key, () => ({ state: { key, type: "string", value, expiresAt }, result: "OK" })));
  }
  sMembers(key: string): Promise<string[]> {
    return this.read(this.codec.recordId(key)).then(({ state }) => {
      if (!state) return [];
      if (state.type !== "set") throw Error("WRONGTYPE state value is not a set");
      return [...state.value as string[]];
    });
  }
  private setMutation(key: string, members: string | string[], remove: boolean): Promise<number> {
    const values = typeof members === "string" ? [members] : members;
    return this.serialize(() => this.change(key, current => {
      if (current && current.type !== "set") throw Error("WRONGTYPE state value is not a set");
      const result = new Set(current?.value as string[] ?? []); let changed = 0;
      for (const value of values) {
        if (remove) { if (result.delete(value)) changed++; }
        else if (!result.has(value)) { result.add(value); changed++; }
      }
      return { result: changed, unchanged: changed === 0, state: result.size ? { key, type: "set", value: [...result], expiresAt: current?.expiresAt ?? null } : null };
    }));
  }
  sAdd(key: string, members: string | string[]) { return this.setMutation(key, members, false); }
  sRem(key: string, members: string | string[]) { return this.setMutation(key, members, true); }
  async del(keys: string | string[]): Promise<number> {
    let removed = 0;
    for (const key of typeof keys === "string" ? [keys] : keys) removed += await this.serialize(() => this.change(key, current => ({ result: current ? 1 : 0, state: null, unchanged: !current })));
    return removed;
  }
  async keys(pattern: string): Promise<string[]> {
    if (pattern.includes("?") || pattern.includes("[") || pattern.includes("\\")) throw Error("Unsupported state key pattern");
    const regex = new RegExp("^" + pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    const ids = this.chain.childLabels
      ? await this.chain.childLabels(`${this.root}/heads`)
      : Object.keys(await this.chain.get<Record<string, StoredHead>>(`${this.root}/heads`) ?? {});
    // Bound RPC fan-out while avoiding thousands of sequential round trips.
    // Keep source order and surface every authoritative read failure.
    const matches: (string | null)[] = new Array(ids.length).fill(null);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(8, ids.length) }, async () => {
      while (next < ids.length) {
        const index = next++;
        const { state } = await this.read(ids[index]);
        if (state && regex.test(state.key)) matches[index] = state.key;
      }
    }));
    return matches.filter((key): key is string => key !== null);
  }
  async exists(key: string): Promise<number> { return (await this.read(this.codec.recordId(key))).state ? 1 : 0; }
  async sCard(key: string): Promise<number> { return (await this.sMembers(key)).length; }
  async *scanIterator(options: { MATCH?: string; COUNT?: number } = {}): AsyncGenerator<string> {
    for (const key of await this.keys(options.MATCH ?? "*")) yield key;
  }
  multi() {
    const operations: { key: string; seconds: number; value: string }[] = [];
    const pipeline = {
      setEx: (key: string, seconds: number, value: string) => { operations.push({ key, seconds, value }); return pipeline; },
      exec: () => this.serialize(async () => {
        const latest = new Map(operations.map(operation => [operation.key, operation]));
        const headers: ChainOperation[] = [], chunks: ChainOperation[] = [], superseded: ChainOperation[] = [];
        for (const op of latest.values()) {
          if (!Number.isSafeInteger(op.seconds) || op.seconds <= 0) throw Error("Invalid state expiry");
          const id = this.codec.recordId(op.key);
          const previous = await this.chain.get<StoredHead>(this.headPath(id));
          const sealed = this.codec.seal({ key: op.key, type: "string", value: op.value, expiresAt: this.clock() + op.seconds * 1000 });
          sealed.chunks.forEach((value, index) => chunks.push({ type: "SET_VALUE", ref: `${this.root}/chunks/${id}/${sealed.head.revision}/${index}`, value }));
          headers.push({ type: "SET_VALUE", ref: this.headPath(id), value: { ...sealed.head, previousRevision: previous?.revision ?? null } });
          superseded.push(...this.supersededChunks(id, previous));
        }
        const budget = this.chain.operationJsonBytesLimit ?? 4500;
        // All authoritative headers must fit one native atomic SET. Oversized
        // transactions fail before writing instead of degrading to partial commits.
        if (Buffer.byteLength(JSON.stringify(headers)) > budget) throw Error("Atomic state pipeline exceeds the chain transaction size limit");
        let batch: ChainOperation[] = [];
        for (const chunk of chunks) {
          if (batch.length && Buffer.byteLength(JSON.stringify([...batch, chunk])) > budget) { await this.chain.write(batch); batch = []; }
          if (Buffer.byteLength(JSON.stringify([chunk])) > budget) throw Error("AIN state chunk exceeds the transaction size bound");
          batch.push(chunk);
        }
        if (batch.length) await this.chain.write(batch);
        if (headers.length) await this.chain.write(headers);
        for (const key of latest.keys()) this.cacheDelete(this.codec.recordId(key));
        await this.removeQuietly(superseded);
        return operations.map(() => "OK");
      }),
    };
    return pipeline;
  }
  /**
   * Remove chunks that no live head points at: revisions superseded before pruning
   * existed, removals that failed, and records whose expiry has passed (those are
   * tombstoned first). A revision is removed only if it is still unreferenced after
   * `graceMs`, so another process's in-flight commit — chunks confirmed, header not
   * yet published — is never touched.
   */
  async sweep(options: { graceMs?: number; sleep?: (ms: number) => Promise<void> } = {}): Promise<{ records: number; expired: number; revisionsRemoved: number }> {
    if (!this.pruneRevisions) throw Error("Install stateChunksWriteRule before sweeping: the legacy chunk rule rejects removals");
    if (!this.chain.childLabels) throw Error("Sweeping needs a chain transport that lists child labels");
    const list = this.chain.childLabels.bind(this.chain);
    const graceMs = options.graceMs ?? 10 * 60 * 1000;
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    const ids = await list(`${this.root}/chunks`);
    let expired = 0;
    const candidates = new Map<string, string[]>();
    for (const id of ids) {
      const { head, state } = await this.load(id);
      if (head && !head.deleted && state && this.expired(state)) {
        // Tombstoning goes through the normal CAS and removes the live revision too.
        await this.serialize(() => this.commit(state.key, head, null)).then(() => { expired++; }, () => {});
      }
      const live = (await this.chain.get<StoredHead>(this.headPath(id)))?.revision;
      const stale = (await list(`${this.root}/chunks/${id}`)).filter(revision => revision !== live);
      if (stale.length) candidates.set(id, stale);
    }
    if (candidates.size && graceMs > 0) await sleep(graceMs);
    let revisionsRemoved = 0;
    for (const [id, stale] of candidates) {
      const head = await this.chain.get<StoredHead>(this.headPath(id));
      for (const revision of stale) {
        if (head?.revision === revision) continue;
        const indexes = await list(`${this.root}/chunks/${id}/${revision}`);
        if (!indexes.length) continue;
        await this.removeQuietly(indexes.map(index => ({ type: "SET_VALUE" as const, ref: `${this.root}/chunks/${id}/${revision}/${index}`, value: null })));
        revisionsRemoved++;
      }
    }
    return { records: ids.length, expired, revisionsRemoved };
  }
  /**
   * Rewrite every live record stored in an older encoding (uncompressed version 1) in the current
   * one. Each rewrite is a normal CAS commit that also removes the old revision, so it is safe while
   * the service runs; a record changed concurrently is simply left for the service's own write.
   */
  async compact(): Promise<{ records: number; rewritten: number; failed: number }> {
    if (!this.chain.childLabels) throw Error("Compacting needs a chain transport that lists child labels");
    const ids = await this.chain.childLabels(`${this.root}/heads`);
    let rewritten = 0, failed = 0;
    for (const id of ids) {
      const head = await this.chain.get<StoredHead>(this.headPath(id));
      if (!head || head.deleted || head.version === STATE_VERSION) continue;
      try {
        const { state } = await this.read(id);
        if (!state) continue; // expired: sweep() removes it
        await this.serialize(() => this.change(state.key, current => current
          ? { state: current, result: undefined }
          : { state: null, result: undefined, unchanged: true }));
        rewritten++;
      } catch { failed++; }
    }
    return { records: ids.length, rewritten, failed };
  }
  /**
   * Every live (unexpired) record with its id and revision, in head order. Read-only; used to
   * migrate state off chain (`migrate-to-store`).
   */
  async *entries(): AsyncGenerator<{ recordId: string; revision: string; state: StateValue }> {
    if (!this.chain.childLabels) throw Error("Exporting needs a chain transport that lists child labels");
    for (const id of await this.chain.childLabels(`${this.root}/heads`)) {
      const { head, state } = await this.read(id);
      if (head && state) yield { recordId: id, revision: head.revision, state };
    }
  }
  /**
   * SHA-256 over the sorted `recordId:revision` of every head that is not a tombstone. Any write
   * after a verification run changes it, so chain cleanup can refuse a stale verification.
   */
  headsFingerprint(): Promise<{ heads: number; sha256: string }> { return headsFingerprint(this.chain, this.root); }
  async quit(): Promise<void> { await this.queue; this.cache.clear(); this.cacheBytes = 0; }
}
