import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEndpointMap, loadAgentEndpointMap } from "./agentEndpointMap";

test("old endpoint and card spellings route to the same migrated identity", () => {
  const source = "https://builder.example/api/agents/original";
  const routes = new AgentEndpointMap({ organizationId: "org", mappings: [{ sourceUrl: source, destinationId: "new-agent" }] });
  for (const suffix of ["", "/", "/.well-known/agent-card.json", "/.well-known/agent.json"]) {
    assert.equal(routes.resolve(source + suffix), "https://ainize.ai/agents/new-agent/.well-known/agent-card.json");
  }
  assert.equal(routes.resolve("https://unrelated.example/agent"), "https://unrelated.example/agent");
});

test("retired endpoints fail before calling the old service and conflicting mappings are refused", () => {
  const routes = new AgentEndpointMap({ organizationId: "org", mappings: [], dropped: ["https://retired.example"] });
  assert.throws(() => routes.resolve("https://retired.example/.well-known/agent-card.json"), /retired/);
  assert.throws(() => new AgentEndpointMap({ organizationId: "org", mappings: [{ sourceUrl: "https://source.example", destinationId: "a" }, { sourceUrl: "https://source.example/", destinationId: "b" }] }), /Conflicting/);
  for (const sourceUrl of ["file:///tmp/data", "https://secret@source.example", "https://source.example/?token=secret"]) {
    assert.throws(() => new AgentEndpointMap({ organizationId: "org", mappings: [{ sourceUrl, destinationId: "a" }] }), /Invalid/);
  }
  assert.throws(() => new AgentEndpointMap({ organizationId: "org", mappings: [{ sourceUrl: "https://source.example", destinationId: "../a" }] }), /Invalid/);
});

test("endpoint mappings require private runtime-owned configuration", () => {
  const dir = mkdtempSync(join(tmpdir(), "endpoint-map-")), path = join(dir, "map.json");
  try {
    writeFileSync(path, JSON.stringify({ organizationId: "org", mappings: [] }), { mode: 0o600 });
    assert.equal(loadAgentEndpointMap(path).resolve("https://example.test"), "https://example.test");
    chmodSync(path, 0o644); assert.throws(() => loadAgentEndpointMap(path), /private/);
  } finally { rmSync(dir, { recursive: true }); }
});


test("the A2A client calls the mapped service while preserving persona and conversation context", async () => {
  const { Agent } = await import("./agents");
  const dir = mkdtempSync(join(tmpdir(), "endpoint-live-client-")), path = join(dir, "map.json");
  writeFileSync(path, JSON.stringify({ organizationId: "org", mappings: [{ sourceUrl: "https://old.example/agent", destinationId: "mapped-agent" }] }), { mode: 0o600 });
  const previous = process.env.AGENT_ENDPOINT_MAP, originalFetch = global.fetch;
  process.env.AGENT_ENDPOINT_MAP = path;
  const seen: { url: string; body?: any }[] = [];
  global.fetch = async (input, init) => {
    const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    seen.push({ url, body });
    if (url.endsWith("agent-card.json")) return new Response(JSON.stringify({ name: "Mapped", description: "Test", version: "1", protocolVersion: "0.3.0", url: "https://ainize.ai/agents/mapped-agent", capabilities: {}, defaultInputModes: ["text"], defaultOutputModes: ["text"], skills: [] }), { headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { kind: "message", messageId: "reply", role: "agent", contextId: "preserved-context", parts: [{ kind: "text", text: "mapped reply" }] } }), { headers: { "Content-Type": "application/json" } });
  };
  const persona = { name: "Original", role: "guide", color: "blue", a2aUrl: "https://old.example/agent/.well-known/agent-card.json", backendAgentId: "original-backend-id" };
  try {
    const agent = new Agent(persona, "original-thread-id");
    const message = { id: "m", speaker: "User", content: "hello", timestamp: 1 };
    assert.equal(await agent.respond([], message), "mapped reply");
    assert.equal(await agent.respond([], message), "mapped reply");
    assert.deepEqual(agent.getPersona(), persona);
    assert.equal(seen[0].url, "https://ainize.ai/agents/mapped-agent/.well-known/agent-card.json");
    assert.ok(seen.every(request => request.url.startsWith("https://ainize.ai/agents/mapped-agent")));
    assert.equal(seen[2].body.params.message.contextId, "preserved-context");
  } finally {
    global.fetch = originalFetch;
    if (previous === undefined) delete process.env.AGENT_ENDPOINT_MAP; else process.env.AGENT_ENDPOINT_MAP = previous;
    rmSync(dir, { recursive: true });
  }
});
