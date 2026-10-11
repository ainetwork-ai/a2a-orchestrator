import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { AinTransport } from "./ain-transport";

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
