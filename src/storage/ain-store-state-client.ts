import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import type { StateValue } from "./encrypted-state";
import type { StateClient, StatePipeline } from "./state-client";

/**
 * StateClient over AIN Store (`@ainize/store`). Each state key is one document in a private
 * collection: the chain sees only a write record with an HMAC id and a body hash, the body lives on
 * AinDrive, and the Store's SQLite index serves reads. Chain usage is the Store's MMR and state root,
 * a few hundred bytes, instead of every record's encrypted chunks.
 *
 *   thread:<id>    → threads/<id>
 *   messages:<id>  → messages/<id>
 *   report:<rest>  → reports/<rest>   (report:job:*, report:index:*, report:ainmem:*, caches, …)
 *   anything else  → meta/<key>       (threads:list, orchestrator:agents, …)
 *
 * The document body is `{ k: key, t: "string" | "set", v: value, x?: expiresAt }`. Concurrency uses
 * the Store's optimistic versions (`ifVersion` = the document's `base`), so set updates and setNX
 * stay correct across processes; a stale base is retried like the chain adapter's head CAS.
 */

/*
 * The parts of the `@ainize/store` SDK this adapter uses, declared structurally. The SDK is an
 * optional dependency (vendored tarball until it is published), so builds that do not ship it —
 * and the chain backend — compile and run without it.
 */
export interface StoreSnapshot { readonly id: string; readonly exists: boolean; readonly version: number; data(): unknown }
export interface StoreDocumentRef {
  get(): Promise<StoreSnapshot>;
  set(data: Record<string, unknown>, options?: { ifVersion?: number }): Promise<unknown>;
  delete(options?: { ifVersion?: number }): Promise<unknown>;
}
export interface StoreQuery {
  limit(count: number): StoreQuery;
  startAfter(cursor: string): StoreQuery;
  get(): Promise<{ docs: StoreSnapshot[]; nextCursor: string | null }>;
}
export interface StoreCollectionRef extends StoreQuery { doc(id: string): StoreDocumentRef }
export interface StoreWriteBatch {
  set(ref: StoreDocumentRef, data: Record<string, unknown>, options?: { ifVersion?: number }): StoreWriteBatch;
  commit(): Promise<unknown>;
}
export interface Store { collection(name: string): StoreCollectionRef; batch(): StoreWriteBatch }
export interface StoreOptions {
  url: string; app: string; getToken?: () => string | null; signer?: unknown; writeTimeoutMs?: number; fetch?: typeof fetch;
  /** Private collections; with `hmacKey` the SDK checks that the Store prepared the exact HMAC record id. */
  privateCollections?: Record<string, { hmacKey?: string }>;
}
export interface StoreSdk {
  createStore(options: StoreOptions): Store;
  privateKeySigner(privateKeyHex: string, chainId: number): unknown;
}

export const STATE_COLLECTIONS = ["threads", "messages", "reports", "meta"] as const;
export type StateCollection = typeof STATE_COLLECTIONS[number];
const ROUTES: ReadonlyArray<[prefix: string, collection: StateCollection]> = [["thread:", "threads"], ["messages:", "messages"], ["report:", "reports"]];
const MAX_ID_LENGTH = 512;

// Store ids may contain "/" only between non-empty segments; escape it (and "%") so any key maps.
const encodeId = (value: string) => value.replace(/%/g, "%25").replace(/\//g, "%2F");
const decodeId = (value: string) => value.replace(/%2F/g, "/").replace(/%25/g, "%");

export function keyToDoc(key: string): { collection: StateCollection; id: string } {
  if (!key) throw Error("State key must not be empty");
  const route = ROUTES.find(([prefix]) => key.startsWith(prefix) && key.length > prefix.length);
  const doc = route ? { collection: route[1], id: encodeId(key.slice(route[0].length)) } : { collection: "meta" as const, id: encodeId(key) };
  if (doc.id.length > MAX_ID_LENGTH) throw Error("State key is too long for AIN Store");
  return doc;
}
export function docToKey(collection: StateCollection, id: string): string {
  if (collection === "meta") return decodeId(id);
  return ROUTES.find(([, name]) => name === collection)![0] + decodeId(id);
}
/** Collections that can hold a key starting with `prefix`. */
export function collectionsFor(prefix: string): StateCollection[] {
  const out = new Set<StateCollection>();
  for (const [routed, collection] of ROUTES) if (prefix.startsWith(routed) || routed.startsWith(prefix)) out.add(collection);
  // meta holds every key outside the routed prefixes, plus a bare prefix such as "report:".
  if (!ROUTES.some(([routed]) => prefix.startsWith(routed) && prefix.length > routed.length)) out.add("meta");
  return [...out];
}

interface Body { k: string; t: "string" | "set"; v: string | string[]; x?: number }
function encode(state: StateValue): Record<string, unknown> {
  return { k: state.key, t: state.type, v: state.type === "set" ? [...state.value as string[]] : state.value as string, ...(state.expiresAt === null ? {} : { x: state.expiresAt }) };
}
function decode(key: string, data: unknown): StateValue {
  const body = data as Partial<Body> | undefined;
  const valid = body && body.k === key && ((body.t === "string" && typeof body.v === "string")
    || (body.t === "set" && Array.isArray(body.v) && body.v.every(member => typeof member === "string")))
    && (body.x === undefined || Number.isSafeInteger(body.x));
  if (!valid) throw Error("AIN Store state document does not match its key");
  return { key, type: body.t!, value: body.t === "set" ? [...body.v as string[]] : body.v as string, expiresAt: body.x ?? null };
}

/** Order-insensitive for sets: what migration verification compares. */
export function stateDigest(state: StateValue): string {
  const value = state.type === "set" ? [...state.value as string[]].sort() : state.value;
  return createHash("sha256").update(JSON.stringify([state.key, state.type, value, state.expiresAt])).digest("hex");
}

const isConflict = (error: unknown) => (error as { name?: string })?.name === "ConflictError";

export interface AinStoreStateClientOptions {
  /** Store used for reads. It never writes, so it never shows a write that may still roll back. */
  reader: Store;
  /** Store with the orchestrator's signer, used for writes. */
  writer: Store;
  clock?: () => number;
  /** Retries after a stale base (another writer got in first). */
  conflictRetries?: number;
  /** Page size for listings (Store maximum 1000). */
  pageSize?: number;
}

export class AinStoreStateClient implements StateClient {
  private readonly reader: Store;
  private readonly writer: Store;
  private readonly clock: () => number;
  private readonly retries: number;
  private readonly pageSize: number;
  private readonly locks = new Map<string, Promise<unknown>>();

  constructor(options: AinStoreStateClientOptions) {
    this.reader = options.reader; this.writer = options.writer;
    this.clock = options.clock ?? Date.now;
    this.retries = options.conflictRetries ?? 5;
    this.pageSize = options.pageSize ?? 500;
  }

  private ref(store: Store, key: string): StoreDocumentRef {
    const { collection, id } = keyToDoc(key);
    return store.collection(collection).doc(id);
  }
  private expired(state: StateValue) { return state.expiresAt !== null && state.expiresAt <= this.clock(); }

  /** Writes to one key run one at a time in this process; the Store's versions cover other processes. */
  private lock<T>(keys: string[], action: () => Promise<T>): Promise<T> {
    const unique = [...new Set(keys)];
    const previous = Promise.all(unique.map(key => this.locks.get(key)?.catch(() => {})));
    const run = previous.then(action);
    const tail = run.catch(() => {});
    for (const key of unique) this.locks.set(key, tail);
    void tail.then(() => { for (const key of unique) if (this.locks.get(key) === tail) this.locks.delete(key); });
    return run;
  }

  /**
   * The stored record, expired or not, with the document version to use as `base`. A deleted
   * document reads as absent but keeps its tombstone version (> 0), which the next create must use.
   */
  private async load(key: string): Promise<{ version: number; state: StateValue | null }> {
    const snapshot = await this.ref(this.reader, key).get();
    return { version: snapshot.version, state: snapshot.exists ? decode(key, snapshot.data()) : null };
  }

  private change<T>(key: string, modify: (current: StateValue | null, stored: { version: number; state: StateValue | null }) => { state: StateValue | null; result: T; unchanged?: boolean }): Promise<T> {
    return this.lock([key], async () => {
      for (let attempt = 0; ; attempt++) {
        const stored = await this.load(key);
        const current = stored.state && this.expired(stored.state) ? null : stored.state;
        const change = modify(current, stored);
        if (change.unchanged) return change.result;
        const ref = this.ref(this.writer, key);
        try {
          if (change.state) await ref.set(encode(change.state), { ifVersion: stored.version });
          else if (stored.state) await ref.delete({ ifVersion: stored.version });
          return change.result;
        } catch (error) {
          if (!isConflict(error) || attempt >= this.retries) throw error;
        }
      }
    });
  }

  /** Write several records in one Store transaction (one chain transaction). */
  private writeAll(states: StateValue[]): Promise<void> {
    if (states.length > 50) return Promise.reject(Error("AIN Store batches carry at most 50 writes"));
    return this.lock(states.map(state => state.key), async () => {
      for (let attempt = 0; ; attempt++) {
        const versions = await Promise.all(states.map(state => this.load(state.key).then(stored => stored.version)));
        const batch = this.writer.batch();
        states.forEach((state, index) => batch.set(this.ref(this.writer, state.key), encode(state), { ifVersion: versions[index] }));
        try { await batch.commit(); return; }
        catch (error) { if (!isConflict(error) || attempt >= this.retries) throw error; }
      }
    });
  }

  async get(key: string): Promise<string | null> {
    const state = await this.readRecord(key);
    if (!state) return null;
    if (state.type !== "string") throw Error("WRONGTYPE state value is not a string");
    return state.value as string;
  }
  mGet(keys: string[]): Promise<(string | null)[]> { return Promise.all(keys.map(key => this.get(key))); }
  set(key: string, value: string): Promise<string> {
    return this.change(key, () => ({ state: { key, type: "string", value, expiresAt: null }, result: "OK" }));
  }
  setNX(key: string, value: string): Promise<boolean> {
    return this.change(key, current => current
      ? { state: current, result: false, unchanged: true }
      : { state: { key, type: "string", value, expiresAt: null }, result: true });
  }
  setEx(key: string, seconds: number, value: string): Promise<string> {
    if (!Number.isSafeInteger(seconds) || seconds <= 0) return Promise.reject(Error("Invalid state expiry"));
    const expiresAt = this.clock() + seconds * 1000;
    return this.change(key, () => ({ state: { key, type: "string", value, expiresAt }, result: "OK" }));
  }
  async sMembers(key: string): Promise<string[]> {
    const state = await this.readRecord(key);
    if (!state) return [];
    if (state.type !== "set") throw Error("WRONGTYPE state value is not a set");
    return [...state.value as string[]];
  }
  private setMutation(key: string, members: string | string[], remove: boolean): Promise<number> {
    const values = typeof members === "string" ? [members] : members;
    return this.change(key, current => {
      if (current && current.type !== "set") throw Error("WRONGTYPE state value is not a set");
      const result = new Set(current?.value as string[] ?? []); let changed = 0;
      for (const value of values) {
        if (remove) { if (result.delete(value)) changed++; }
        else if (!result.has(value)) { result.add(value); changed++; }
      }
      return { result: changed, unchanged: changed === 0, state: result.size ? { key, type: "set", value: [...result], expiresAt: current?.expiresAt ?? null } : null };
    });
  }
  sAdd(key: string, members: string | string[]) { return this.setMutation(key, members, false); }
  sRem(key: string, members: string | string[]) { return this.setMutation(key, members, true); }
  async sCard(key: string): Promise<number> { return (await this.sMembers(key)).length; }
  async exists(key: string): Promise<number> { return (await this.readRecord(key)) ? 1 : 0; }
  async del(keys: string | string[]): Promise<number> {
    let removed = 0;
    for (const key of typeof keys === "string" ? [keys] : keys) {
      // An expired document still exists in the Store; remove it, but it does not count (as in Redis).
      removed += await this.change(key, (current, stored) => ({ result: current ? 1 : 0, state: null, unchanged: !stored.state }));
    }
    return removed;
  }
  async keys(pattern: string): Promise<string[]> {
    if (pattern.includes("?") || pattern.includes("[") || pattern.includes("\\")) throw Error("Unsupported state key pattern");
    const regex = new RegExp("^" + pattern.split("*").map(part => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    const prefix = pattern.split("*")[0];
    const keys: string[] = [];
    for (const collection of collectionsFor(prefix)) {
      for await (const state of this.scanCollection(collection)) if (regex.test(state.key)) keys.push(state.key);
    }
    return keys;
  }
  async *scanIterator(options: { MATCH?: string; COUNT?: number } = {}): AsyncGenerator<string> {
    for (const key of await this.keys(options.MATCH ?? "*")) yield key;
  }
  multi(): StatePipeline {
    const operations: { key: string; seconds: number; value: string }[] = [];
    const pipeline: StatePipeline = {
      setEx: (key, seconds, value) => { operations.push({ key, seconds, value }); return pipeline; },
      exec: async () => {
        const latest = new Map(operations.map(operation => [operation.key, operation]));
        for (const operation of latest.values()) if (!Number.isSafeInteger(operation.seconds) || operation.seconds <= 0) throw Error("Invalid state expiry");
        const now = this.clock();
        // All records commit in one chain transaction, or none do.
        if (latest.size) await this.writeAll([...latest.values()].map(({ key, seconds, value }) => ({ key, type: "string" as const, value, expiresAt: now + seconds * 1000 })));
        return operations.map(() => "OK");
      },
    };
    return pipeline;
  }
  async quit(): Promise<void> { await Promise.all([...this.locks.values()]); }

  // ---- migration and maintenance ----

  /** The live record (expired records read as absent). */
  async readRecord(key: string): Promise<StateValue | null> {
    const { state } = await this.load(key);
    return state && !this.expired(state) ? state : null;
  }
  /** Write records exactly as given (type, members, expiry), in one transaction per call. */
  importRecords(states: StateValue[]): Promise<void> { return this.writeAll(states); }
  /** Every live record of one collection, in Store order. */
  async *scanCollection(collection: StateCollection, includeExpired = false): AsyncGenerator<StateValue> {
    let cursor: string | null = null;
    do {
      let query = this.reader.collection(collection).limit(this.pageSize);
      if (cursor) query = query.startAfter(cursor);
      const page = await query.get();
      for (const doc of page.docs) {
        const state = decode(docToKey(collection, doc.id), doc.data());
        if (includeExpired || !this.expired(state)) yield state;
      }
      cursor = page.docs.length ? page.nextCursor : null;
    } while (cursor);
  }
  /** Every live record in every state collection. */
  async *records(): AsyncGenerator<StateValue> {
    for (const collection of STATE_COLLECTIONS) yield* this.scanCollection(collection);
  }
  /** Delete documents whose expiry has passed. They already read as absent; this frees the index. */
  async sweepExpired(): Promise<number> {
    let removed = 0;
    for (const collection of STATE_COLLECTIONS) {
      const expired: string[] = [];
      for await (const state of this.scanCollection(collection, true)) if (this.expired(state)) expired.push(state.key);
      for (const key of expired) {
        // Rewritten since the scan (current is live again) or already gone: leave it.
        removed += await this.change(key, (current, stored) => ({ result: current || !stored.state ? 0 : 1, state: null, unchanged: !!current || !stored.state }));
      }
    }
    return removed;
  }
}

/**
 * Chain write rule for each state collection: only the orchestrator's writer address may write,
 * with the Store's record shape (`compileServiceOnlyRule` from @ainize/store-core, `checkShape`).
 */
export function stateCollectionWriteRule(address: string, core: StoreCore = loadCore()): string {
  return core.compileServiceOnlyRule({ serviceAddress: address, checkShape: true });
}

export interface StoreCore { compileServiceOnlyRule(options: { serviceAddress: string; checkShape?: boolean }): string; storeAppendFunctionConfig(): Record<string, unknown> }

export interface AinStoreStateConfig {
  /** Store service base URL of this project's Store. */
  url: string;
  /** AIN app the Store serves (the orchestrator's app). */
  app: string;
  /** Chain id for transaction signatures (mainnet 1). */
  chainId: number;
  /** Hex secp256k1 key that signs write transactions; the collection rules allow only its address. */
  writerKey: string;
  /** The Store's service bearer token: reads private collections and prepares writes. */
  serviceToken: string;
  /**
   * The Store's HMAC key for the state collections (its AIN_STORE_STATE_HMAC_KEY). The SDK uses it to
   * compute the exact private record ids (`HMAC(key, "ain-store:v1:<app>:<collection>:<id>")`) and
   * refuses a prepared write for any other id.
   */
  hmacKey: string;
  writeTimeoutMs?: number;
}

export function readAinStoreStateConfig(path: string): AinStoreStateConfig {
  if (!path) throw Error("AIN_STORE_CONFIG is required for AIN Store state");
  const file = statSync(path);
  if (!file.isFile() || (file.mode & 0o077) !== 0 || (process.getuid && file.uid !== process.getuid())) throw Error("AIN Store configuration must be private and owned by the service user");
  const config: AinStoreStateConfig = JSON.parse(readFileSync(path, "utf8"));
  let url: URL | null = null;
  try { url = new URL(config.url); } catch { /* invalid below */ }
  if (!url || !/^https?:$/.test(url.protocol) || url.username || url.password
    || !/^[a-z][a-z0-9_]*$/i.test(config.app ?? "") || !Number.isSafeInteger(config.chainId) || config.chainId < 0
    || !/^(0x)?[a-fA-F0-9]{64}$/.test(config.writerKey ?? "") || typeof config.serviceToken !== "string" || config.serviceToken.length < 16
    || typeof config.hmacKey !== "string" || config.hmacKey.length < 32
    || (config.writeTimeoutMs !== undefined && (!Number.isSafeInteger(config.writeTimeoutMs) || config.writeTimeoutMs <= 0))) throw Error("Invalid AIN Store state configuration");
  return config;
}

/** Build the client from a config; `sdk` is injectable for tests (defaults to `@ainize/store`). */
export function ainStoreStateClient(config: AinStoreStateConfig, sdk: StoreSdk = loadSdk(), extra: Partial<StoreOptions> = {}, clock?: () => number): AinStoreStateClient {
  const getToken = () => config.serviceToken;
  const privateCollections = Object.fromEntries(STATE_COLLECTIONS.map(name => [name, { hmacKey: config.hmacKey }]));
  const reader = sdk.createStore({ url: config.url, app: config.app, getToken, privateCollections, ...extra });
  const writer = sdk.createStore({
    url: config.url, app: config.app, getToken, privateCollections, writeTimeoutMs: config.writeTimeoutMs ?? 120_000, ...extra,
    signer: sdk.privateKeySigner(config.writerKey.replace(/^0x/, ""), config.chainId),
  });
  return new AinStoreStateClient({ reader, writer, clock });
}

export async function createAinStoreStateClient(path: string): Promise<AinStoreStateClient> {
  const client = ainStoreStateClient(readAinStoreStateConfig(path));
  // Fail at startup, not on the first request, if the Store is unreachable or refuses the token.
  await client.exists("orchestrator:agents");
  return client;
}

export function loadCore(): StoreCore {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@ainize/store-core") as StoreCore;
  } catch (error) {
    throw Error("The AIN Store tools need @ainize/store-core (optional dependency in vendor/): " + (error instanceof Error ? error.message : "load failed"));
  }
}

// Loaded on demand so the chain backend never needs the SDK. The package is ESM; Node 22.12+ can require it.
export function loadSdk(): StoreSdk {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("@ainize/store") as StoreSdk;
  } catch (error) {
    throw Error("STATE_BACKEND=ain-store needs the @ainize/store SDK (optional dependency; copy vendor/ into the image before npm ci): "
      + (error instanceof Error ? error.message : "load failed"));
  }
}
