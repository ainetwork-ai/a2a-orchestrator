import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AinStateStore } from "./ain-state-store";
import { EncryptedStateCodec } from "./encrypted-state";
import { TestChain } from "./ain-test-chain";
import { DevStore, ainStoreAvailable, startDevStore } from "./ain-store-dev-server";
import { StateTarget, migrateState, verifyState, writeReport } from "./migrate-to-store";
import { stateDigest } from "./ain-store-state-client";

const root = "/apps/uncommon_gallery_orchestrator/state";

/** The old store, as production has it: encrypted records on a (fake) chain. */
async function oldStore(now = () => Date.now()) {
  const chain = new TestChain(), codec = new EncryptedStateCodec("org-uncommon", randomBytes(32));
  const store = new AinStateStore(chain, codec, root, now);
  for (let i = 0; i < 12; i++) {
    await store.set(`thread:t${i}`, JSON.stringify({ id: `t${i}`, title: `스레드 ${i} 🙂` }));
    await store.set(`messages:t${i}`, JSON.stringify(Array.from({ length: i + 1 }, (_, n) => ({ n, text: "메시지 ".repeat(n + 1) }))));
  }
  await store.sAdd("threads:list", Array.from({ length: 12 }, (_, i) => `t${i}`));
  await store.sAdd("orchestrator:agents", ["agent-b", "agent-a"]);
  await store.set("report:job:1", JSON.stringify({ status: "completed" }));
  await store.sAdd("report:index:all", ["1"]);
  await store.sAdd("report:ainmem:pending", ["1"]);
  await store.setEx("report:cache:live", 3600, "cached");
  await store.setEx("report:cache:gone", 1, "expired soon");
  return { chain, codec, store };
}
const LIVE = 12 * 2 + 6; // the expired cache entry is not migrated

describe("migrate-to-store", { skip: ainStoreAvailable() ? false : "set AIN_STORE_REPO to a built ain-store checkout" }, () => {
  let dev: DevStore;
  before(async () => { dev = await startDevStore(); });
  after(async () => { await dev?.stop(); });

  test("dry run reads both sides and writes nothing", async () => {
    let now = Date.now();
    const { store } = await oldStore(() => now);
    now += 2000;
    const target = dev.client();
    const before = dev.chain.transactions.length;
    const sourceOnly = await migrateState(store, null, { dryRun: true });
    assert.deepEqual(sourceOnly, { dryRun: true, scanned: LIVE, unchanged: 0, written: LIVE, extra: 0, pruned: 0 });
    const planned = await migrateState(store, target, { dryRun: true });
    assert.equal(planned.written, LIVE);
    assert.equal(dev.chain.transactions.length, before, "no chain transaction");
    assert.equal(await target.get("thread:t0"), null);
    await assert.rejects(migrateState(store, null), /target Store is required/);
  });

  test("migrate, verify, rerun idempotently, resume after a failure, catch up and prune", async () => {
    const isolated = await startDevStore();
    try {
      let now = Date.now();
      const { chain, codec, store } = await oldStore(() => now);
      now += 2000;
      const target = isolated.client(() => now);

      // A run that dies after two batches…
      let calls = 0;
      const flaky: StateTarget = {
        readRecord: key => target.readRecord(key), records: () => target.records(), del: keys => target.del(keys),
        importRecords: states => { if (++calls > 2) return Promise.reject(Error("network down")); return target.importRecords(states); },
      };
      await assert.rejects(migrateState(store, flaky, { batchSize: 7 }), /network down/);
      // …resumes: what was written is skipped, the rest is written.
      const resumed = await migrateState(store, target, { batchSize: 7 });
      assert.equal(resumed.unchanged, 14);
      assert.equal(resumed.written, LIVE - 14);

      const report = await verifyState(store, target, { root, url: isolated.url, app: "uncommon_gallery_orchestrator" });
      assert.equal(report.ok, true, report.reasons.join("; "));
      assert.equal(report.source.records, LIVE);
      assert.equal(report.target.records, LIVE);
      assert.equal(report.matched, LIVE);
      assert.equal(Object.keys(report.records).length, LIVE);
      for (const { state } of await collect(store.entries())) {
        assert.equal(report.records[state.key], stateDigest(state));
        assert.deepEqual(await target.readRecord(state.key), state, `${state.key} round-trips with type, members and expiry`);
      }
      assert.equal(await target.get("report:cache:gone"), null);

      const again = await migrateState(store, target);
      assert.deepEqual(again, { dryRun: false, scanned: LIVE, unchanged: LIVE, written: 0, extra: 0, pruned: 0 });

      // The service keeps writing to chain until the switch: verification notices, migration catches up.
      await store.set("thread:t0", "changed");
      await store.del("messages:t11");
      const stale = await verifyState(store, target, { root, url: isolated.url, app: "x" });
      assert.equal(stale.ok, false);
      assert.equal(stale.mismatched, 1);
      assert.equal(stale.extra, 1);
      const caughtUp = await migrateState(store, target, { prune: true });
      assert.equal(caughtUp.written, 1);
      assert.equal(caughtUp.pruned, 1);
      assert.equal((await verifyState(store, target, { root, url: isolated.url, app: "x" })).ok, true);

      // A Store copy that differs is caught.
      await target.set("report:job:1", "tampered");
      const tampered = await verifyState(store, target, { root, url: isolated.url, app: "x" });
      assert.deepEqual([tampered.ok, tampered.mismatched, tampered.samples.mismatched], [false, 1, ["report:job:1"]]);

      // A chain write during verification fails it.
      await migrateState(store, target);
      const racing = { entries: () => store.entries(), headsFingerprint: async () => { const result = await store.headsFingerprint(); await new AinStateStore(chain, codec, root).set(`thread:race${randomBytes(2).toString("hex")}`, "x"); return result; } };
      const raced = await verifyState(racing, target, { root, url: isolated.url, app: "x" });
      assert.equal(raced.ok, false);
      assert.match(raced.reasons.join(), /changed during verification/);

      const directory = mkdtempSync(join(tmpdir(), "a2a-report-"));
      writeReport(join(directory, "report.json"), report);
      assert.equal(statSync(join(directory, "report.json")).mode & 0o777, 0o600);
      assert.equal(JSON.parse(readFileSync(join(directory, "report.json"), "utf8")).digest, report.digest);
    } finally { await isolated.stop(); }
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}
