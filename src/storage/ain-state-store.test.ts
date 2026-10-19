import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { AinStateStore } from "./ain-state-store";
import { EncryptedStateCodec } from "./encrypted-state";
import { AinWriteRejected, ChainOperation, StateChainTransport } from "./ain-transport";

class TestChain implements StateChainTransport {
  values = new Map<string, unknown>();
  rejectChunks = false;
  unconfirmed = false;
  rejectHeadId: string | null = null;
  async get<T>(ref: string): Promise<T | null> {
    if (ref.endsWith("/heads")) return Object.fromEntries([...this.values].filter(([key]) => key.startsWith(ref + "/")).map(([key, value]) => [key.slice(ref.length + 1), value])) as T;
    return this.values.has(ref) ? structuredClone(this.values.get(ref)) as T : null;
  }
  async write(operations: ChainOperation[]): Promise<void> {
    const draft = new Map(this.values);
    for (const op of operations) {
      if (op.ref.includes("/heads/")) {
        if (this.rejectHeadId && op.ref.endsWith("/" + this.rejectHeadId)) throw new AinWriteRejected("Head rejected");
        const before = draft.get(op.ref) as { revision: string } | undefined;
        const after = op.value as { previousRevision: string | null };
        if (after.previousRevision !== (before?.revision ?? null)) throw new AinWriteRejected("CAS rejected");
      } else if (this.rejectChunks) throw Error("Chunk confirmation failed");
      draft.set(op.ref, structuredClone(op.value));
    }
    this.values = draft;
    if (this.unconfirmed) throw Error("Finality timed out");
  }
}
const root = "/apps/uncommon_gallery_orchestrator/state";
function setup() {
  const chain = new TestChain(), codec = new EncryptedStateCodec("org-uncommon", randomBytes(32));
  let now = 1000;
  return { chain, codec, store: new AinStateStore(chain, codec, root, () => now), advance: (ms: number) => { now += ms; } };
}
test("string, set, batch read, keys and deletion preserve the existing state contract", async () => {
  const { store } = setup();
  assert.equal(await store.get("thread:id"), null);
  assert.equal(await store.set("thread:id", "한글🙂"), "OK");
  assert.equal(await store.sAdd("threads:list", ["id", "id", "second"]), 2);
  assert.equal(await store.sRem("threads:list", ["second", "missing"]), 1);
  assert.deepEqual(await store.sMembers("threads:list"), ["id"]);
  assert.deepEqual(await store.mGet(["missing", "thread:id"]), [null, "한글🙂"]);
  assert.deepEqual(await store.keys("thread:*"), ["thread:id"]);
  assert.equal(await store.del(["thread:id", "missing"]), 1);
  assert.equal(await store.exists("thread:id"), 0);
  assert.equal(await store.sCard("threads:list"), 1);
  await store.quit();
});
test("expiry survives a new process; normal SET clears previous expiry", async () => {
  const { chain, codec, store, advance } = setup();
  await store.setEx("cache:a", 1, "temporary");
  advance(1000);
  assert.equal(await store.get("cache:a"), null);
  await store.setEx("cache:b", 1, "temporary");
  await store.set("cache:b", "durable");
  advance(1000);
  assert.equal(await store.get("cache:b"), "durable");
  const restored = new AinStateStore(chain, codec, root, () => 3000);
  assert.equal(await restored.get("cache:a"), null);
  assert.equal(await restored.get("cache:b"), "durable");
});
test("competing processes cannot lose set members or resurrect a deleted revision", async () => {
  const { chain, codec, store } = setup();
  const second = new AinStateStore(chain, codec, root);
  await Promise.all([store.sAdd("agents", "first"), second.sAdd("agents", "second")]);
  assert.deepEqual((await store.sMembers("agents")).sort(), ["first", "second"]);
  await store.del("agents");
  await second.sAdd("agents", "new");
  assert.deepEqual(await store.sMembers("agents"), ["new"]);
});
test("a failed chunk write leaves the last committed value readable", async () => {
  const { chain, store } = setup();
  await store.set("messages:id", "original");
  chain.rejectChunks = true;
  await assert.rejects(store.set("messages:id", "new"), /confirmation/);
  assert.equal(await store.get("messages:id"), "original");
});
test("unconfirmed finality is surfaced and cannot be changed into success by readback", async () => {
  const { chain, store } = setup();
  await store.set("messages:id", "original");
  chain.unconfirmed = true;
  await assert.rejects(store.set("messages:id", "new"), /Finality timed out/);
});
test("missing committed chunks and wrong value types fail closed", async () => {
  const { chain, codec, store } = setup();
  await store.sAdd("set", "a");
  await assert.rejects(store.get("set"), /WRONGTYPE/);
  await store.set("value", "a");
  await assert.rejects(store.sAdd("value", "a"), /WRONGTYPE/);
  for (const key of chain.values.keys()) if (key.includes("/chunks/")) chain.values.delete(key);
  const restored = new AinStateStore(chain, codec, root);
  await assert.rejects(restored.get("value"), /missing a chunk/);
});
test("cache pipeline propagates failures", async () => {
  const { chain, store } = setup();
  const pipeline = store.multi().setEx("cache:a", 5, "a").setEx("cache:b", 5, "b");
  assert.deepEqual(await pipeline.exec(), ["OK", "OK"]);
  chain.rejectChunks = true;
  await assert.rejects(store.multi().setEx("cache:c", 5, "c").exec());
});
test("a rejected atomic cache pipeline leaves every previously committed record unchanged", async () => {
  const { chain, codec, store } = setup();
  await store.set("cache:a", "old-a"); await store.set("cache:b", "old-b");
  chain.rejectHeadId = codec.recordId("cache:b");
  await assert.rejects(store.multi().setEx("cache:a", 50, "new-a").setEx("cache:b", 50, "new-b").exec());
  const restarted = new AinStateStore(chain, codec, root);
  assert.deepEqual(await restarted.mGet(["cache:a", "cache:b"]), ["old-a", "old-b"]);
});
test("an oversized atomic pipeline fails before any chain write", async () => {
  const { chain, store } = setup(); const pipeline = store.multi();
  for (let i = 0; i < 100; i++) pipeline.setEx("cache:" + i, 50, "value");
  await assert.rejects(pipeline.exec(), /exceeds/);
  assert.equal(chain.values.size, 0);
});

test("key enumeration bounds concurrent reads, preserves order and propagates failures", async () => {
  const { chain, codec, store } = setup();
  for (let i = 0; i < 20; i++) await store.set(`report:job:${i}`, String(i));
  const originalGet = chain.get.bind(chain);
  let active = 0, peak = 0, fail = false;
  chain.get = async <T>(ref: string): Promise<T | null> => {
    if (!ref.includes("/heads/")) return originalGet<T>(ref);
    active++; peak = Math.max(peak, active);
    try {
      await new Promise(resolve => setTimeout(resolve, 2));
      if (fail) throw Error("authoritative enumeration failed");
      return await originalGet<T>(ref);
    } finally { active--; }
  };
  const restored = new AinStateStore(chain, codec, root);
  assert.deepEqual(await restored.keys("report:job:*"), Array.from({ length: 20 }, (_, i) => `report:job:${i}`));
  assert.ok(peak > 1 && peak <= 8);
  fail = true;
  await assert.rejects(restored.keys("report:job:*"), /authoritative enumeration failed/);
});

test("decrypted record cache stays within its byte budget and evicts least recently used records", async () => {
  const { chain, codec } = setup();
  const writer = new AinStateStore(chain, codec, root);
  for (let i = 0; i < 20; i++) await writer.set(`thread:${i}`, "x".repeat(200));
  await writer.set("report:job:large", "y".repeat(5000));
  const originalGet = chain.get.bind(chain);
  let chunkReads = 0;
  chain.get = async <T>(ref: string): Promise<T | null> => { if (ref.includes("/chunks/")) chunkReads++; return originalGet<T>(ref); };
  const store = new AinStateStore(chain, codec, root, Date.now, 2000);
  for (let i = 0; i < 20; i++) assert.equal(await store.get(`thread:${i}`), "x".repeat(200));
  assert.ok(store.cachedBytes > 0 && store.cachedBytes <= 2000);
  chunkReads = 0; await store.get("thread:19");
  assert.equal(chunkReads, 0, "a recently used record is served from memory");
  await store.get("thread:0");
  assert.ok(chunkReads > 0, "the least recently used record was evicted and is read again");
  const before = store.cachedBytes;
  assert.equal(await store.get("report:job:large"), "y".repeat(5000));
  assert.equal(store.cachedBytes, before, "a record larger than a quarter of the budget is not cached");
  await store.quit();
  assert.equal(store.cachedBytes, 0);
});
