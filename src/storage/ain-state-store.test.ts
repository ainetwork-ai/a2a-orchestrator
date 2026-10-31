import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { AinStateStore } from "./ain-state-store";
import { EncryptedStateCodec } from "./encrypted-state";
import { TestChain } from "./ain-test-chain";

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

test("setNX writes only absent keys, including against a competing process", async () => {
  const { chain, codec, store } = setup();
  assert.equal(await store.setNX("report:summary:a", "first"), true);
  assert.equal(await store.setNX("report:summary:a", "second"), false);
  assert.equal(await store.get("report:summary:a"), "first");
  const other = new AinStateStore(chain, codec, root);
  const results = await Promise.all([store.setNX("report:summary:b", "mine"), other.setNX("report:summary:b", "theirs")]);
  assert.deepEqual(results.filter(Boolean).length, 1, "exactly one competing writer succeeds");
  assert.equal(await other.get("report:summary:b"), results[0] ? "mine" : "theirs");
  await store.set("report:summary:c", "fresh");
  await store.del("report:summary:c");
  assert.equal(await store.setNX("report:summary:c", "after-delete"), true);
});

const revisionsOf = (chain: TestChain, id: string) => chain.childLabels(`${root}/chunks/${id}`);

test("updating or deleting a record removes the revision it replaced", async () => {
  const { chain, codec, store } = setup();
  const id = codec.recordId("thread:a");
  await store.set("thread:a", "x".repeat(10000));
  await store.set("thread:a", "y".repeat(10000));
  await store.sAdd("threads", ["a"]);
  await store.set("thread:a", "z");
  const head = await chain.get<{ revision: string }>(`${root}/heads/${id}`);
  assert.deepEqual(await revisionsOf(chain, id), [head!.revision], "only the live revision keeps chunks");
  assert.equal(await store.get("thread:a"), "z");
  await store.del("thread:a");
  assert.deepEqual(await revisionsOf(chain, id), []);
  await store.multi().setEx("cache:a", 50, "1").exec();
  await store.multi().setEx("cache:a", 50, "2").exec();
  assert.equal((await revisionsOf(chain, codec.recordId("cache:a"))).length, 1, "the cache pipeline prunes too");
});

test("with the legacy chunk rule nothing is removed and writes keep working", async () => {
  const { chain, codec } = setup();
  chain.legacyChunkRule = true;
  const store = new AinStateStore(chain, codec, root, Date.now, undefined, false);
  await store.set("thread:a", "1");
  await store.set("thread:a", "2");
  assert.equal((await revisionsOf(chain, codec.recordId("thread:a"))).length, 2);
  assert.equal(await store.get("thread:a"), "2");
  await assert.rejects(store.sweep({ graceMs: 0 }), /legacy chunk rule/);
});

test("a reader whose revision is pruned underneath it rereads the new head", async () => {
  const { chain, codec, store } = setup();
  await store.set("thread:a", "old");
  const reader = new AinStateStore(chain, codec, root);
  const originalGet = chain.get.bind(chain);
  let raced = false;
  chain.get = async <T>(ref: string): Promise<T | null> => {
    if (!raced && ref.includes("/chunks/")) { raced = true; await store.set("thread:a", "new"); }
    return originalGet<T>(ref);
  };
  assert.equal(await reader.get("thread:a"), "new");
});

test("sweep removes superseded and expired revisions but not an in-flight commit", async () => {
  const { chain, codec, advance } = setup();
  chain.legacyChunkRule = true;
  let now = 1000;
  const legacy = new AinStateStore(chain, codec, root, () => now, undefined, false);
  await legacy.set("thread:a", "1"); await legacy.set("thread:a", "2"); await legacy.set("thread:a", "3");
  await legacy.setEx("cache:a", 1, "temporary");
  await legacy.set("thread:b", "live");
  chain.legacyChunkRule = false;
  const store = new AinStateStore(chain, codec, root, () => now);
  now += 2000; advance(0);
  // Another process has confirmed chunks for its next revision but not its header yet.
  const inflight = `${root}/chunks/${codec.recordId("thread:b")}/${"f".repeat(32)}/0`;
  let finished = false;
  const result = await store.sweep({ graceMs: 1, sleep: async () => { chain.values.set(inflight, "AAAA"); finished = true; } });
  assert.ok(finished);
  assert.deepEqual(result, { records: 3, expired: 1, revisionsRemoved: 2 });
  assert.equal((await revisionsOf(chain, codec.recordId("thread:a"))).length, 1);
  assert.deepEqual(await revisionsOf(chain, codec.recordId("cache:a")), []);
  assert.ok(chain.values.has(inflight), "a revision that appeared during the grace period is left alone");
  assert.equal(await store.get("thread:a"), "3");
  assert.equal(await store.get("thread:b"), "live");
  assert.equal(await store.get("cache:a"), null);
});
test("compact rewrites old uncompressed records in place and removes their old revisions", async () => {
  const { chain, codec, store } = setup();
  const legacy = { key: "messages:old", type: "string" as const, value: "오래된 대화 ".repeat(2000), expiresAt: null };
  const sealed = codec.seal(legacy, 1);
  sealed.chunks.forEach((chunk, index) => chain.values.set(`${root}/chunks/${sealed.recordId}/${sealed.head.revision}/${index}`, chunk));
  chain.values.set(`${root}/heads/${sealed.recordId}`, { ...sealed.head, previousRevision: null });
  await store.set("thread:new", "already compressed");
  const before = [...chain.values.values()].filter(value => typeof value === "string").join("").length;
  assert.deepEqual(await store.compact(), { records: 2, rewritten: 1, failed: 0 });
  assert.equal((await chain.get<{ version: number }>(`${root}/heads/${sealed.recordId}`))?.version, 2);
  assert.deepEqual(await chain.childLabels(`${root}/chunks/${sealed.recordId}`), [(await chain.get<{ revision: string }>(`${root}/heads/${sealed.recordId}`))!.revision]);
  assert.ok([...chain.values.values()].filter(value => typeof value === "string").join("").length * 4 < before);
  assert.equal(await new AinStateStore(chain, codec, root).get("messages:old"), legacy.value);
  assert.deepEqual(await store.compact(), { records: 2, rewritten: 0, failed: 0 });
});
