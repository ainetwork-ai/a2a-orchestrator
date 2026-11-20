import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AinStateStore, stateChunksWriteRule, stateHeadWriteRule } from "./ain-state-store";
import { EncryptedStateCodec } from "./encrypted-state";
import { TestChain } from "./ain-test-chain";
import { StateValue } from "./encrypted-state";
import { verifyState, writeReport } from "./migrate-to-store";
import { cleanupChainState, stateChunksDeleteRule, stateHeadDeleteRule } from "./cleanup-chain-state";

const app = "uncommon_gallery_orchestrator", root = `/apps/${app}/state`;

async function setup() {
  const chain = new TestChain();
  chain.rules.set(`${root}/heads/$recordId`, stateHeadWriteRule(chain.address));
  chain.rules.set(`${root}/chunks/$recordId/$revision/$index`, stateChunksWriteRule(chain.address));
  const codec = new EncryptedStateCodec("org-uncommon", randomBytes(32));
  const store = new AinStateStore(chain, codec, root);
  for (let i = 0; i < 15; i++) await store.set(`messages:t${i}`, "긴 대화 ".repeat(800 * (i % 3 + 1)));
  await store.sAdd("threads:list", ["t0", "t1"]);
  const directory = mkdtempSync(join(tmpdir(), "a2a-cleanup-"));
  /** A verification against a Store holding an exact copy (what migrate-to-store produces). */
  const verify = async (name = "report.json") => {
    const copy: StateValue[] = [];
    for await (const { state } of store.entries()) copy.push(state);
    const target = { records: async function* () { yield* copy; }, readRecord: async () => null, importRecords: async () => {}, del: async () => 0 };
    const report = await verifyState(store, target, { root, url: "http://store.test", app });
    writeReport(join(directory, name), report);
    return join(directory, name);
  };
  return { chain, codec, store, directory, verify };
}

test("cleanup refuses to run without a passing, current verification report", async () => {
  const { chain, store, directory, verify } = await setup();
  const before = chain.values.size, writes = chain.writes;
  await assert.rejects(cleanupChainState(chain, root, { execute: true, confirm: app }), /--report/);
  await assert.rejects(cleanupChainState(chain, root, { reportPath: join(directory, "missing.json"), execute: true, confirm: app }), /does not exist/);
  writeFileSync(join(directory, "garbage.json"), "{");
  await assert.rejects(cleanupChainState(chain, root, { reportPath: join(directory, "garbage.json"), execute: true, confirm: app }), /not valid JSON/);
  const path = await verify();
  const failed = JSON.parse(readFileSync(path, "utf8"));
  failed.ok = false; failed.mismatched = 1;
  writeFileSync(join(directory, "failed.json"), JSON.stringify(failed));
  await assert.rejects(cleanupChainState(chain, root, { reportPath: join(directory, "failed.json"), execute: true, confirm: app }), /did not pass/);
  await assert.rejects(cleanupChainState(chain, "/apps/other_app/state", { reportPath: path, execute: true, confirm: "other_app" }), /verified \/apps\/uncommon_gallery_orchestrator\/state/);
  // A write after verification makes the report stale.
  await store.set("thread:new", "written after verification");
  await assert.rejects(cleanupChainState(chain, root, { reportPath: path, execute: true, confirm: app }), /changed after verification/);
  // Even a current report needs the application named explicitly.
  const fresh = await verify("fresh.json");
  await assert.rejects(cleanupChainState(chain, root, { reportPath: fresh, execute: true }), /--confirm/);
  assert.equal(chain.writes, writes + 1, "only the test's own write reached the chain");
  assert.ok(chain.values.size > before);
});

test("plan is read-only; execute freezes writes, deletes in batches, and resumes after a rejection", async () => {
  const { chain, codec, verify } = await setup();
  const path = await verify();
  const writes = chain.writes, values = chain.values.size;
  const planned = await cleanupChainState(chain, root, { reportPath: path });
  assert.equal(planned.executed, false);
  assert.equal(planned.heads, 16);
  assert.equal(planned.ruleOperations.length, 2);
  assert.equal(chain.writes, writes);
  assert.equal(chain.values.size, values);

  // The chain refuses the third delete batch (e.g. over budget before ain_store activation).
  let sent = 0;
  chain.rejectWrite = () => ++sent === 3;
  await assert.rejects(cleanupChainState(chain, root, { reportPath: path, execute: true, confirm: app, maxOperations: 5 }), /free-tier budget/);
  assert.equal(chain.rules.get(`${root}/heads/$recordId`), stateHeadDeleteRule(chain.address));
  assert.equal(chain.rules.get(`${root}/chunks/$recordId/$revision/$index`), stateChunksDeleteRule(chain.address));
  // Frozen: the old backend can no longer write.
  await assert.rejects(new AinStateStore(chain, codec, root).set("thread:late", "x"));

  chain.rejectWrite = null;
  const done = await cleanupChainState(chain, root, { reportPath: path, execute: true, confirm: app, maxOperations: 5 });
  assert.equal(done.frozen, true, "the rerun continues without re-checking the frozen state");
  assert.equal(done.remaining, 0);
  assert.ok(done.transactions > 1);
  assert.deepEqual([...chain.values.keys()].filter(key => key.startsWith(root)), []);
});
