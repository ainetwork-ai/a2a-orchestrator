import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { AinmemReportPublisher } from "./ainmemReports";

test("publication retries after a restart without losing the completed source job or duplicating its receipt", async () => {
  const jobId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", pageId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  const job = { id: jobId, status: "completed", createdAt: 1, updatedAt: 2, params: {}, report: { topics: [] } };
  const values = new Map<string, string>([["report:job:" + jobId, JSON.stringify(job)]]), pending = new Set<string>();
  let refuse = true, failReceiptWrite = false, acceptedRequests = 0;
  const store = {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => { if (failReceiptWrite) { failReceiptWrite = false; throw Error("Chain receipt commit failed"); } values.set(key, value); return "OK"; },
    sAdd: async (_: string, member: string | string[]) => { pending.add(member as string); return 1; },
    sMembers: async () => [...pending],
    sRem: async (_: string, member: string | string[]) => { pending.delete(member as string); return 1; },
  };
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer " + "t".repeat(40));
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(body.organizationId, "org-test"); assert.deepEqual(body.job, job);
    if (refuse) { res.writeHead(503).end(); return; }
    acceptedRequests++; res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jobId, pageId, url: "/p/" + pageId, created: acceptedRequests === 1 }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const config = { organizationId: "org-test", endpoint: `http://127.0.0.1:${port}/api/integrations/orchestrator/reports`, token: "t".repeat(40), publicBaseUrl: "https://ainmem.example.test" };
  try {
    const first = new AinmemReportPublisher(store, config); await first.enqueue(jobId);
    await assert.rejects(first.flush(), /HTTP 503/); assert.equal(pending.has(jobId), true);
    refuse = false; failReceiptWrite = true;
    await assert.rejects(first.flush(), /receipt commit failed/); assert.equal(pending.has(jobId), true);
    const restarted = new AinmemReportPublisher(store, config); await restarted.flush();
    assert.equal(pending.size, 0); assert.equal(acceptedRequests, 2);
    assert.deepEqual(JSON.parse(values.get("report:ainmem:published:" + jobId)!), { jobId, pageId, url: "https://ainmem.example.test/p/" + pageId });
    assert.deepEqual(JSON.parse(values.get("report:job:" + jobId)!), job);
    await restarted.enqueue(jobId); await restarted.flush(); assert.equal(acceptedRequests, 2);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
