import { readFileSync, statSync } from "node:fs";

function canonical(url: string): string {
  const value = new URL(url);
  if (!["http:", "https:"].includes(value.protocol) || value.username || value.password || value.search || value.hash) throw Error("Invalid agent endpoint");
  return value.toString().replace(/\/\.well-known\/(?:agent-card|agent)\.json\/?$/, "").replace(/\/$/, "");
}
export class AgentEndpointMap {
  private readonly routes = new Map<string, string | null>();
  constructor(config: { organizationId: string; mappings: { sourceUrl: string; destinationId: string }[]; dropped?: string[] }) {
    if (!config.organizationId || !Array.isArray(config.mappings)) throw Error("Invalid organization endpoint mapping");
    for (const row of config.mappings) {
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(row.destinationId)) throw Error("Invalid destination agent ID");
      this.add(row.sourceUrl, "https://ainize.ai/agents/" + row.destinationId + "/.well-known/agent-card.json");
    }
    for (const url of config.dropped ?? []) this.add(url, null);
  }
  private add(source: string, destination: string | null): void {
    const key = canonical(source);
    if (this.routes.has(key) && this.routes.get(key) !== destination) throw Error("Conflicting agent endpoint mapping");
    this.routes.set(key, destination);
  }
  resolve(source: string): string {
    const key = canonical(source);
    if (!this.routes.has(key)) return source;
    const target = this.routes.get(key);
    if (target === null) throw Error("This source agent was retired during migration");
    return target!;
  }
}
let configured: { path: string; routes: AgentEndpointMap } | undefined;
export function loadAgentEndpointMap(path: string): AgentEndpointMap {
  const file = statSync(path);
  if (!file.isFile() || (file.mode & 0o077) !== 0 || (process.getuid && file.uid !== process.getuid())) throw Error("Agent endpoint mapping must be private and owned by the runtime user");
  return new AgentEndpointMap(JSON.parse(readFileSync(path, "utf8")));
}
export function resolveAgentCardUrl(source: string): string {
  const path = process.env.AGENT_ENDPOINT_MAP;
  if (!path) return source;
  if (!configured || configured.path !== path) configured = { path, routes: loadAgentEndpointMap(path) };
  return configured.routes.resolve(source);
}
