import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { AinTransport } from "./ain-transport";

test("temporary verified-layer refusal retries only reads without changing the request or endpoint", async () => {
  const calls: { method: string; params: unknown }[] = [], delays: number[] = [];
  let mode: "recover" | "permanent" | "unavailable" = "recover";
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body);
    const code = mode === "permanent" ? -32602 : mode === "unavailable" ? -32052 : calls.length === 1 ? -32052 : calls.length === 2 ? -32050 : undefined;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(code ? { jsonrpc: "2.0", id: body.id, error: { code } } : { jsonrpc: "2.0", id: body.id, result: { result: "finalized-value" } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const transport = new AinTransport({ rpcUrl: `http://127.0.0.1:${port}/json-rpc`, chainId: 1,
    genesisHash: "0x" + "a".repeat(64), privateKey: "b".repeat(64), gasPrice: 0, transactionBytesLimit: 100000 },
    async milliseconds => { delays.push(milliseconds); });
  try {
    assert.equal(await transport.get("/apps/test/state/value"), "finalized-value");
    assert.equal(calls.length, 3); assert.deepEqual(calls[1], calls[0]); assert.deepEqual(calls[2], calls[0]);
    assert.deepEqual(delays, [2000, 4000]);
    mode = "permanent"; const before = calls.length;
    await assert.rejects(transport.get("/apps/test/state/value"), /code -32602/); assert.equal(calls.length, before + 1);
    mode = "unavailable"; const writesBefore = calls.length;
    await assert.rejects(transport.rpc("ain_sendSignedTransaction", { tx_body: {} }), /code -32052/);
    assert.equal(calls.length, writesBefore + 1); assert.deepEqual(delays, [2000, 4000]);
    const readsBefore = calls.length;
    await assert.rejects(transport.get("/apps/test/state/value"), /code -32052/);
    assert.equal(calls.length, readsBefore + 5); assert.deepEqual(delays.slice(2), [2000, 4000, 8000, 16000]);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("finalized child listing follows native pagination and rejects repeated cursors", async () => {
  const seen: unknown[] = [];
  let malformed = false;
  const server = createServer(async (req, res) => {
    const buffers: Buffer[] = []; for await (const chunk of req) buffers.push(Buffer.from(chunk));
    const { params } = JSON.parse(Buffer.concat(buffers).toString());
    assert.equal(params.is_final, true); assert.equal(params.is_partial, true); assert.equal(params.is_shallow, true);
    seen.push(params.last_end_label);
    const page = params.last_end_label === undefined ? { first: {}, "#end_label": "cursor-1" }
      : params.last_end_label === "cursor-1" ? { second: {}, "#end_label": malformed ? "cursor-1" : "cursor-2" } : {};
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { result: page } }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const transport = new AinTransport({ rpcUrl: `http://127.0.0.1:${port}/json-rpc`, chainId: 1,
    genesisHash: "0x" + "a".repeat(64), privateKey: "b".repeat(64), gasPrice: 0, transactionBytesLimit: 100000 });
  try {
    assert.deepEqual(await transport.childLabels("/apps/test/state/heads"), ["first", "second"]);
    assert.deepEqual(seen, [undefined, "cursor-1", "cursor-2"]);
    malformed = true;
    await assert.rejects(transport.childLabels("/apps/test/state/heads"), /cursor did not advance/);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
