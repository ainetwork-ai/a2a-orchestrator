import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import RequestManager from "./requestManager";
import { llmEndpoint } from "../utils/llmEndpoint";

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

test("on ainize, with no model service named, requests go to the project's gateway with the project's own key", async () => {
  const seen: { path: string; authorization?: string }[] = [], bodies: any[] = [];
  const server = createServer(async (request, response) => {
    let raw = ""; for await (const chunk of request) raw += chunk;
    bodies.push(JSON.parse(raw));
    seen.push({ path: request.url!, authorization: request.headers.authorization });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  const names = ["LLM_API_URL", "LLM_API_KEY", "AINIZE_URL", "AINIZE_API_KEY"] as const;
  const original = names.map(name => process.env[name]);
  delete process.env.LLM_API_URL;
  process.env.LLM_API_KEY = "left-over-model-service-secret";   // a stored secret that outlives its endpoint must not be sent
  process.env.AINIZE_URL = `http://127.0.0.1:${port}/t/project-token/`;
  process.env.AINIZE_API_KEY = "project-own-key";
  try {
    const { apiUrl } = llmEndpoint();
    assert.equal(apiUrl, `http://127.0.0.1:${port}/t/project-token/v1/chat/completions`);
    const manager = RequestManager.getInstance();
    assert.equal(await manager.request(apiUrl!, "test", [{ role: "user", content: "test" }], 128, 0), '{"ok":true}');
    await manager.request(`http://127.0.0.1:${port}/agent`, "test", [{ role: "user", content: "test" }], 128, 0);
    assert.deepEqual(seen, [
      { path: "/t/project-token/v1/chat/completions", authorization: "Bearer project-own-key" },
      { path: "/agent", authorization: undefined },
    ]);
    // The gateway's models answer only after reasoning unless told not to; a report call then returns no text.
    assert.deepEqual(bodies[0].chat_template_kwargs, { thinking: false, enable_thinking: false });
    assert.equal(bodies[0].reasoning_effort, "low");
    assert.equal(bodies[0].max_tokens, 128);
    assert.equal("chat_template_kwargs" in bodies[1] || "reasoning_effort" in bodies[1], false);
    process.env.LLM_API_URL = "http://model.example/v1/chat/completions";
    assert.deepEqual(llmEndpoint(), { apiUrl: "http://model.example/v1/chat/completions", apiKey: "left-over-model-service-secret" });
  } finally {
    names.forEach((name, i) => { if (original[i] === undefined) delete process.env[name]; else process.env[name] = original[i]; });
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
