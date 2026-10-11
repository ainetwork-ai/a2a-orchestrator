import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import RequestManager from "./requestManager";

test("model credential reaches its configured endpoint and is withheld from other destinations", async () => {
  const seen: { path: string; authorization?: string }[] = [];
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* Consume the request before replying. */ }
    seen.push({ path: request.url!, authorization: request.headers.authorization });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const url = `http://127.0.0.1:${port}/configured`;
  const originalUrl = process.env.LLM_API_URL, originalKey = process.env.LLM_API_KEY;
  process.env.LLM_API_URL = url; process.env.LLM_API_KEY = "test-model-service-secret";
  try {
    const manager = RequestManager.getInstance();
    assert.equal(await manager.request(url, "test", [{ role: "user", content: "test" }], 128, 0), '{"ok":true}');
    await manager.request(`http://127.0.0.1:${port}/other`, "test", [{ role: "user", content: "test" }], 128, 0);
    assert.equal(seen[0].authorization, "Bearer test-model-service-secret");
    assert.equal(seen[1].authorization, undefined);
  } finally {
    if (originalUrl === undefined) delete process.env.LLM_API_URL; else process.env.LLM_API_URL = originalUrl;
    if (originalKey === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = originalKey;
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
