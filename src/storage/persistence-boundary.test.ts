import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AinTransport } from "./ain-transport";
import { stateHeadWriteRule, stateChunksWriteRule } from "./ain-state-store";
import { initStateStore, closeStateStore, getStateClient } from "../utils/state";
import ThreadManager from "../world/threadManager";
import ReportService from "../services/reportService";

test("thread and ingest acknowledgement waits for authoritative persistence; failures remain retryable", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ain-state-boundary-"));
  const previousBackend = process.env.STATE_BACKEND, previousConfig = process.env.AIN_STATE_CONFIG;
  const values = new Map<string, unknown>(), receipts = new Map<string, unknown>();
  let failNextWrite = false, release: (() => void) | undefined, waitForWrite: Promise<void> | undefined, counter = 0;
  const root = "/apps/test_org_state/state", genesisHash = "0x" + "c".repeat(64);
  let address = "";
  const server = createServer(async (req, res) => {
    const buffers: Buffer[] = []; for await (const chunk of req) buffers.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(buffers).toString());
    const { method, params } = body; let result: unknown;
    if (method === "net_getChainId") result = 1;
    else if (method === "ain_getBlockByNumber") result = { hash: genesisHash };
    else if (method === "ain_get") {
      assert.equal(params.is_final, true);
      if (params.type === "GET_RULE") {
        const write = params.ref === root ? false : params.ref.includes("/heads/") ? stateHeadWriteRule(address) : stateChunksWriteRule(address);
        result = { ".rule": { write } };
      } else if (params.ref === "/blockchain_params/resource/tx_bytes_limit") result = 100000;
      else if (params.ref === "/apps/test_org_state/state_metadata") result = { organizationId: "org-test" };
      else result = values.get(params.ref) ?? null;
    } else if (method === "ain_sendSignedTransaction") {
      if (failNextWrite) { failNextWrite = false; res.writeHead(503).end(); return; }
      if (waitForWrite) await waitForWrite;
      for (const operation of params.tx_body.operation.op_list) values.set(operation.ref, operation.value);
      const hash = "0x" + (++counter).toString(16).padStart(64, "0");
      receipts.set(hash, { is_finalized: true, state: "FINALIZED", receipt: { code: 0 } });
      result = { tx_hash: hash, result: { code: 0 } };
    } else if (method === "ain_getTransactionByHash") result = receipts.get(params.hash);
    else { res.writeHead(500).end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { result, protoVer: "1.6.1" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const config = { rpcUrl: `http://127.0.0.1:${port}/json-rpc`, chainId: 1, genesisHash,
    privateKey: randomBytes(32).toString("hex"), gasPrice: 0, transactionBytesLimit: 100000,
    organizationId: "org-test", application: "test_org_state", encryptionKey: randomBytes(32).toString("hex") };
  address = new AinTransport(config).address;
  const path = join(directory, "state.json"); writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  process.env.STATE_BACKEND = "ain-blockchain"; process.env.AIN_STATE_CONFIG = path;
  try {
    await initStateStore();
    const manager = ThreadManager.initialize("http://unused.invalid", "unused");
    waitForWrite = new Promise<void>(resolve => { release = resolve; });
    let acknowledged = false;
    const creating = manager.createThread("original", "original-user", []).then(thread => { acknowledged = true; return thread; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(acknowledged, false); assert.equal(manager.getAllThreads().length, 0);
    release!(); waitForWrite = undefined;
    const thread = await creating;
    assert.equal(thread.userId, "original-user");
    failNextWrite = true;
    await assert.rejects(manager.updateThreadName(thread.id, "uncommitted"), /HTTP 503/);
    assert.equal(manager.getThread(thread.id)?.name, "original");
    const world = manager.getWorld(thread.id)!;
    const message = { id: "caller-message-id", speaker: "User", content: "비공개 대화", timestamp: 1234 };
    failNextWrite = true;
    await assert.rejects(world.ingestMessage(message), /HTTP 503/);
    assert.throws(() => world.getHistory(), /HTTP 503/);
    await world.ingestMessage(message);
    assert.deepEqual(world.getHistory(), [{ ...message, status: "accepted" }]);
    assert.ok(!JSON.stringify([...values]).includes(message.content));
    const input = { id: "concurrent-original-id", userId: "same-original-user", agents: [] };
    const [one, two] = await Promise.all([manager.getOrCreateThread(input), manager.getOrCreateThread(input)]);
    assert.equal(one, two, "Concurrent first ingests must share the same World");
    await Promise.all([one.ingestMessage({ ...message, id: "first-id" }), two.ingestMessage({ ...message, id: "second-id" })]);
    assert.deepEqual(one.getHistory().map(item => item.id), ["first-id", "second-id"]);
    await Promise.all([manager.saveUserIdToRedis(input.id, "updated-user"), manager.updateThreadName(input.id, "updated-name")]);
    assert.equal(manager.getThread(input.id)?.userId, "updated-user");
    assert.equal(manager.getThread(input.id)?.name, "updated-name");
    const reports = ReportService.initialize("http://unused.invalid", "unused");
    const reportJob = { id: "original-report-id", status: "completed", title: "confirmed-title", createdAt: 100, updatedAt: 100, params: {} };
    await getStateClient().set("report:job:" + reportJob.id, JSON.stringify(reportJob));
    assert.equal((await reports.getJob(reportJob.id))?.title, "confirmed-title");
    failNextWrite = true;
    await assert.rejects(reports.updateJob(reportJob.id, { title: "uncommitted-title" }), /HTTP 503/);
    assert.equal((await reports.getJob(reportJob.id))?.title, "confirmed-title", "Failed report metadata writes must not leak into the polling cache");
    assert.equal(JSON.parse((await getStateClient().get("report:job:" + reportJob.id))!).title, "confirmed-title");
    await reports.updateJob(reportJob.id, { title: "new-confirmed-title" });
    assert.equal((await reports.getJob(reportJob.id))?.title, "new-confirmed-title");
    await getStateClient().sAdd("report:index:job_ids", [reportJob.id, "missing-report-id"]);
    await getStateClient().set("report:index:job_ids:v1_ready", "1");
    const indexed = await reports.queryJobs({});
    assert.deepEqual(indexed.items.map(item => item.jobId), [reportJob.id], "Missing indexed jobs must be skipped");
    // Finished jobs are listed from their small summary record and are not held in memory.
    assert.equal(JSON.parse((await getStateClient().get("report:summary:" + reportJob.id))!).title, "new-confirmed-title");
    assert.equal((reports as unknown as { jobs: Map<string, unknown> }).jobs.has(reportJob.id), false);
    await getStateClient().set("report:summary:" + reportJob.id, JSON.stringify({ ...indexed.items[0], title: "from-summary" }));
    assert.equal((await reports.queryJobs({})).items[0].title, "from-summary", "Listing must not read the full job when a summary exists");
    // Jobs written before summaries existed are listed from the full job and backfilled once.
    const legacyJob = { id: "legacy-report-id", status: "completed", title: "legacy-title", createdAt: 50, updatedAt: 50, params: {} };
    await getStateClient().set("report:job:" + legacyJob.id, JSON.stringify(legacyJob));
    await getStateClient().sAdd("report:index:job_ids", legacyJob.id);
    const withLegacy = await reports.queryJobs({ sortBy: "createdAt", sortOrder: "asc" });
    assert.deepEqual(withLegacy.items.map(item => item.title), ["legacy-title", "from-summary"]);
    for (let attempt = 0; attempt < 50 && !(await getStateClient().get("report:summary:" + legacyJob.id)); attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(JSON.parse((await getStateClient().get("report:summary:" + legacyJob.id))!).title, "legacy-title");
    assert.equal(await reports.deleteJob(legacyJob.id), true);
    assert.equal(await getStateClient().get("report:summary:" + legacyJob.id), null);
    await closeStateStore();
    process.env.STATE_BACKEND = "redis";
    await assert.rejects(initStateStore(), /Redis state is deprecated/);
    delete process.env.STATE_BACKEND; process.env.AIN_STATE_CONFIG = "";
    await assert.rejects(initStateStore(), /AIN_STATE_CONFIG is required/);
    process.env.STATE_BACKEND = "invalid";
    await assert.rejects(initStateStore(), /Unsupported STATE_BACKEND/);
    process.env.STATE_BACKEND = "ain-blockchain"; process.env.AIN_STATE_CONFIG = "";
    await assert.rejects(initStateStore(), /AIN_STATE_CONFIG is required/);
  } finally {
    release?.(); await closeStateStore();
    if (previousBackend === undefined) delete process.env.STATE_BACKEND; else process.env.STATE_BACKEND = previousBackend;
    if (previousConfig === undefined) delete process.env.AIN_STATE_CONFIG; else process.env.AIN_STATE_CONFIG = previousConfig;
    await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true });
  }
});
