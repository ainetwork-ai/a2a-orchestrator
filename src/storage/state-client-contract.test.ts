import assert from "node:assert/strict";
import { after, before, describe, test, test as nodeTest } from "node:test";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { AinStateStore } from "./ain-state-store";
import { EncryptedStateCodec } from "./encrypted-state";
import { TestChain } from "./ain-test-chain";
import type { StateClient } from "./state-client";
import { DevStore, ainStoreAvailable, startDevStore } from "./ain-store-dev-server";
import { ainStoreStateClient, collectionsFor, docToKey, keyToDoc } from "./ain-store-state-client";

/**
 * The StateClient contract the app relies on, run against every backend: the encrypted chain
 * records (AinStateStore over an in-memory chain) and AIN Store (a real Store service in dev mode).
 */
interface Backend {
  /** A client whose clock the test controls. */
  client(): StateClient;
  /** Another process on the same state. */
  other(): StateClient;
  advance(ms: number): void;
  close(): Promise<void>;
}

function contract(name: string, open: () => Promise<Backend>, options: { skip?: string | false } = {}) {
  // Every test gets fresh state.
  const test = (title: string, body: (b: Backend) => Promise<void>) => nodeTest(title, async () => {
    const b = await open();
    try { await body(b); } finally { await b.close(); }
  });
  describe(`StateClient contract: ${name}`, { skip: options.skip ?? false }, () => {
    test("strings, sets, batch reads, keys and deletion", async b => {
      const store = b.client();
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
      assert.equal(await store.sRem("threads:list", "id"), 1);
      assert.equal(await store.exists("threads:list"), 0, "an emptied set disappears");
      await store.quit();
    });
    test("keys and scanIterator cover every key family", async b => {
      const store = b.client();
      for (const key of ["thread:a", "messages:a", "report:job:1", "report:job:2", "report:index:x", "threads:list", "orchestrator:agents", "report:"]) await store.set(key, key);
      assert.deepEqual((await store.keys("report:job:*")).sort(), ["report:job:1", "report:job:2"]);
      assert.deepEqual((await store.keys("report:*")).sort(), ["report:", "report:index:x", "report:job:1", "report:job:2"]);
      assert.deepEqual((await store.keys("thread*")).sort(), ["thread:a", "threads:list"]);
      const scanned: string[] = [];
      for await (const key of store.scanIterator({ MATCH: "*" })) scanned.push(key);
      assert.equal(scanned.length, 8);
      await assert.rejects(store.keys("thread:?"), /Unsupported/);
    });
    test("expiry survives a new process; a plain SET clears it", async b => {
      const store = b.client();
      await store.setEx("report:cache:a", 1, "temporary");
      await store.setEx("report:cache:b", 1, "temporary");
      await store.set("report:cache:b", "durable");
      b.advance(1000);
      assert.equal(await store.get("report:cache:a"), null);
      assert.deepEqual(await store.keys("report:cache:*"), ["report:cache:b"]);
      const restarted = b.other();
      assert.equal(await restarted.get("report:cache:a"), null);
      assert.equal(await restarted.get("report:cache:b"), "durable");
      assert.equal(await restarted.setNX("report:cache:a", "again"), true, "an expired key counts as absent");
      await assert.rejects(store.setEx("report:cache:c", 0, "x"), /Invalid state expiry/);
    });
    test("setNX writes only absent keys, also against a competing process", async b => {
      const store = b.client(), other = b.other();
      assert.equal(await store.setNX("report:summary:a", "first"), true);
      assert.equal(await store.setNX("report:summary:a", "second"), false);
      assert.equal(await store.get("report:summary:a"), "first");
      const results = await Promise.all([store.setNX("report:summary:b", "mine"), other.setNX("report:summary:b", "theirs")]);
      assert.equal(results.filter(Boolean).length, 1, "exactly one competing writer succeeds");
      assert.equal(await other.get("report:summary:b"), results[0] ? "mine" : "theirs");
      await store.set("report:summary:c", "fresh");
      await store.del("report:summary:c");
      assert.equal(await store.setNX("report:summary:c", "after-delete"), true);
    });
    test("competing processes cannot lose set members or resurrect a deleted set", async b => {
      const store = b.client(), other = b.other();
      await Promise.all([store.sAdd("orchestrator:agents", "first"), other.sAdd("orchestrator:agents", "second")]);
      assert.deepEqual((await store.sMembers("orchestrator:agents")).sort(), ["first", "second"]);
      await store.del("orchestrator:agents");
      await other.sAdd("orchestrator:agents", "new");
      assert.deepEqual(await store.sMembers("orchestrator:agents"), ["new"]);
    });
    test("wrong value types fail closed", async b => {
      const store = b.client();
      await store.sAdd("report:ainmem:pending", "a");
      await assert.rejects(store.get("report:ainmem:pending"), /WRONGTYPE/);
      await store.set("thread:x", "a");
      await assert.rejects(store.sAdd("thread:x", "a"), /WRONGTYPE/);
      await assert.rejects(store.sMembers("thread:x"), /WRONGTYPE/);
    });
    test("the cache pipeline commits every record with its expiry", async b => {
      const store = b.client();
      assert.deepEqual(await store.multi().setEx("report:cache:x", 5, "x").setEx("report:cache:y", 1, "y").setEx("report:cache:x", 5, "x2").exec(), ["OK", "OK", "OK"]);
      assert.deepEqual(await store.mGet(["report:cache:x", "report:cache:y"]), ["x2", "y"]);
      b.advance(1000);
      assert.deepEqual(await b.other().mGet(["report:cache:x", "report:cache:y"]), ["x2", null]);
    });
    test("large values round-trip exactly", async b => {
      const store = b.client();
      const value = JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ id: i, text: "대화 내용 🙂 ".repeat(20) })));
      await store.set("messages:big", value);
      assert.equal(await store.get("messages:big"), value);
    });
  });
}

const root = "/apps/uncommon_gallery_orchestrator/state";
contract("encrypted chain records (AinStateStore)", async () => {
  const chain = new TestChain(), codec = new EncryptedStateCodec("org-uncommon", randomBytes(32));
  let now = 1_000_000;
  const clock = () => now;
  return { client: () => new AinStateStore(chain, codec, root, clock), other: () => new AinStateStore(chain, codec, root, clock), advance: ms => { now += ms; }, close: async () => {} };
});

const skip = ainStoreAvailable() ? false : "set AIN_STORE_REPO to a built ain-store checkout";
contract("AIN Store (dev mode: fake chain + filesystem drive)", async () => {
  const dev = await startDevStore();
  let now = 2_000_000;
  const clock = () => now;
  return { client: () => dev.client(clock), other: () => dev.client(clock), advance: ms => { now += ms; }, close: () => dev.stop() };
}, { skip });

describe("AIN Store backend", { skip }, () => {
  let dev: DevStore;
  before(async () => { dev = await startDevStore(); });
  after(async () => { await dev?.stop(); });

  test("the chain sees only HMAC ids and body hashes; bodies live encrypted on the drive", async () => {
    const store = dev.client();
    const secret = "secret conversation " + randomBytes(8).toString("hex");
    await store.set("thread:privacy-check", secret);
    await store.sAdd("threads:list", "privacy-check");
    const onChain = JSON.stringify(dev.chain.transactions.map(tx => tx.tx_body));
    assert.ok(!onChain.includes("privacy-check"), "no plain key or id on chain");
    assert.ok(!onChain.includes(secret), "no value on chain");
    for (const tx of dev.chain.transactions) for (const operation of tx.tx_body.operation.op_list ?? [tx.tx_body.operation]) {
      if (operation.type === "SET_VALUE" && /\/writes\/[a-z_]+\/[0-9A-Za-z_-]{20}$/.test(operation.ref)) {
        assert.match(operation.value.id, /^[0-9a-f]{64}$/);
        assert.equal(operation.value.v, undefined, "no inline value");
      }
    }
    // The only chain state the Store keeps is its MMR (and, when posting, its state root).
    assert.deepEqual([...dev.chain.values.keys()], ["/apps/uncommon_gallery_orchestrator/store/mmr"]);
    // Bodies are on the drive, salted and encrypted at rest (AES-256-GCM under the collection key).
    const files = walk(dev.driveRoot).map(file => readFileSync(file));
    assert.ok(files.length >= 2, "bodies are on the drive");
    assert.ok(!files.some(body => body.includes(secret) || body.includes("privacy-check")), "no plaintext body on the drive");
    assert.equal(await dev.client().get("thread:privacy-check"), secret);
  });

  test("private record ids are the domain-separated HMAC, and the SDK refuses any other id", async () => {
    const { privateId } = require("@ainize/store-core") as { privateId(key: string, app: string, collection: string, id: string): string };
    const store = dev.client();
    const before = dev.chain.transactions.length;
    await store.set("thread:hmac-check", "v");
    const op = dev.chain.transactions[before].tx_body.operation;
    const record = (op.op_list ?? [op])[0];
    assert.match(record.ref, /\/writes\/threads\//);
    assert.equal(record.value.id, privateId(dev.hmacKey, "uncommon_gallery_orchestrator", "threads", "hmac-check"));
    const wrongKey = ainStoreStateClient({ url: dev.url, app: "uncommon_gallery_orchestrator", chainId: 0, writerKey: dev.writerKey, serviceToken: dev.serviceToken, hmacKey: randomBytes(32).toString("hex"), writeTimeoutMs: 5000 }, dev.sdk);
    await assert.rejects(wrongKey.set("thread:hmac-check", "forged"));
    assert.equal(dev.chain.transactions.length, before + 1, "nothing was signed or sent");
    assert.equal(await store.get("thread:hmac-check"), "v");
  });

  test("writes signed by any other key are refused by the chain rule and change nothing", async () => {
    const store = dev.client();
    await store.set("orchestrator:rule-check", "original");
    const intruder = dev.client(undefined, randomBytes(32).toString("hex"));
    await assert.rejects(intruder.set("orchestrator:rule-check", "forged"), /rule|rejected/i);
    assert.equal(await store.get("orchestrator:rule-check"), "original");
  });

  test("a cache pipeline is one chain transaction", async () => {
    const store = dev.client();
    const before = dev.chain.transactions.length;
    await store.multi().setEx("report:cache:p1", 50, "1").setEx("report:cache:p2", 50, "2").setEx("report:cache:p3", 50, "3").exec();
    assert.equal(dev.chain.transactions.length - before, 1);
  });

  test("sweepExpired removes expired documents only", async () => {
    let clock = 5_000_000;
    const store = dev.client(() => clock);
    await store.setEx("report:cache:sweep-a", 1, "a");
    await store.set("report:cache:sweep-b", "b");
    clock += 2000;
    assert.ok(await store.sweepExpired() >= 1);
    assert.equal(await store.get("report:cache:sweep-b"), "b");
    assert.deepEqual((await store.keys("report:cache:sweep-*")).sort(), ["report:cache:sweep-b"]);
  });
});

test("key mapping is reversible and routes each family to its collection", () => {
  for (const [key, collection] of [["thread:1b4e28ba", "threads"], ["messages:x/y%z", "messages"], ["report:job:9", "reports"], ["threads:list", "meta"], ["orchestrator:agents", "meta"], ["report:", "meta"], ["a//b", "meta"]] as const) {
    const doc = keyToDoc(key);
    assert.equal(doc.collection, collection, key);
    assert.ok(!doc.id.split("/").some(part => !part), "ids never contain empty segments");
    assert.equal(docToKey(doc.collection, doc.id), key);
  }
  assert.deepEqual(collectionsFor("report:job:").sort(), ["reports"]);
  assert.deepEqual(collectionsFor("report:").sort(), ["meta", "reports"]);
  assert.deepEqual(collectionsFor("").sort(), ["messages", "meta", "reports", "threads"]);
  assert.throws(() => keyToDoc(""), /empty/);
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? walk(path) : [path]; });
}
