import { randomBytes } from "node:crypto";
import { EncryptedStateCodec, StateHead, StateValue } from "./encrypted-state";
import { AinWriteRejected, ChainOperation, StateChainTransport } from "./ain-transport";

interface StoredHead extends StateHead { previousRevision: string | null; deleted?: boolean }
class StateRevisionConflict extends Error {}
/** Install this exact rule at heads/$recordId before enabling the adapter. */
export function stateHeadWriteRule(address: string): string {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw Error("Invalid state signer address");
  return `auth.addr === '${address}' && util.isDict(newData) && util.checkValuePathLen(parsedValuePath, 5) === true && newData.previousRevision === (data === null ? null : data.revision) && newData.revision !== (data === null ? null : data.revision)`;
}
export function stateChunksWriteRule(address: string): string {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw Error("Invalid state signer address");
  return `auth.addr === '${address}' && data === null && util.isString(newData) && util.checkValuePathLen(parsedValuePath, 7) === true`;
}

export class AinStateStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly cache = new Map<string, { revision: string; state: StateValue }>();
  constructor(private readonly chain: StateChainTransport, private readonly codec: EncryptedStateCodec,
    private readonly root: string, private readonly clock = Date.now) {
    if (!/^\/apps\/[a-zA-Z0-9_]+\/state$/.test(root)) throw Error("State root must be an organization app's state path");
  }
  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const pending = this.queue.then(action, action);
    this.queue = pending.catch(() => {});
    return pending;
  }
  private headPath(id: string) { return `${this.root}/heads/${id}`; }
  private async read(id: string): Promise<{ head: StoredHead | null; state: StateValue | null }> {
    const head = await this.chain.get<StoredHead>(this.headPath(id));
    if (!head || head.deleted) { this.cache.delete(id); return { head, state: null }; }
    const cached = this.cache.get(id);
    let state: StateValue;
    if (cached?.revision === head.revision) state = cached.state;
    else {
      // Reject untrusted sizes before allocating requests for a forged header.
      if (!Number.isInteger(head.chunks) || head.chunks < 1 || head.chunks > 21846) throw Error("Invalid AIN state chunk count");
      const chunks: string[] = [];
      for (let index = 0; index < head.chunks; index++) {
        const chunk = await this.chain.get<string>(`${this.root}/chunks/${id}/${head.revision}/${index}`);
        if (typeof chunk !== "string") throw Error("Committed AIN state is missing a chunk");
        chunks.push(chunk);
      }
      state = this.codec.openRecord(id, head, chunks);
      this.cache.set(id, { revision: head.revision, state });
    }
    return { head, state: state.expiresAt !== null && state.expiresAt <= this.clock() ? null : state };
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
    try {
      // Confirm chunk batches in order; publish the header in the last batch.
      // Normal small records commit all chunks and the CAS header together.
      const budget = this.chain.operationJsonBytesLimit ?? 4500;
      let batch: ChainOperation[] = [];
      for (const operation of operations) {
        if (batch.length && Buffer.byteLength(JSON.stringify([...batch, operation])) > budget) {
          await this.chain.write(batch); batch = [];
        }
        if (Buffer.byteLength(JSON.stringify([operation])) > budget) throw Error("AIN state operation exceeds the transaction size bound");
        batch.push(operation);
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
    this.cache.delete(id);
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
        const headers: ChainOperation[] = [], chunks: ChainOperation[] = [];
        for (const op of latest.values()) {
          if (!Number.isSafeInteger(op.seconds) || op.seconds <= 0) throw Error("Invalid state expiry");
          const id = this.codec.recordId(op.key);
          const previous = await this.chain.get<StoredHead>(this.headPath(id));
          const sealed = this.codec.seal({ key: op.key, type: "string", value: op.value, expiresAt: this.clock() + op.seconds * 1000 });
          sealed.chunks.forEach((value, index) => chunks.push({ type: "SET_VALUE", ref: `${this.root}/chunks/${id}/${sealed.head.revision}/${index}`, value }));
          headers.push({ type: "SET_VALUE", ref: this.headPath(id), value: { ...sealed.head, previousRevision: previous?.revision ?? null } });
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
        for (const key of latest.keys()) this.cache.delete(this.codec.recordId(key));
        return operations.map(() => "OK");
      }),
    };
    return pipeline;
  }
  async quit(): Promise<void> { await this.queue; this.cache.clear(); }
}
