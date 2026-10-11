import { readFileSync, statSync } from "node:fs";
import type { StateClient } from "../storage/state-client";
import type { ReportJob } from "../types/report";
const PENDING = "report:ainmem:pending";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export interface AinmemReportConfig { organizationId: string; endpoint: string; token: string; publicBaseUrl: string }
export function loadAinmemReportConfig(path: string): AinmemReportConfig {
  const file = statSync(path);
  if (!file.isFile() || (file.mode & 0o777) !== 0o600 || (process.getuid && file.uid !== process.getuid())) throw Error("Ainmem report configuration must be private and owned by the runtime user");
  const config = JSON.parse(readFileSync(path, "utf8")) as AinmemReportConfig;
  const endpoint = new URL(config.endpoint), publicBase = new URL(config.publicBaseUrl);
  if (!config.organizationId || !/^[A-Za-z0-9_-]{32,256}$/.test(config.token)
    || !["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || endpoint.pathname !== "/api/integrations/orchestrator/reports"
    || publicBase.protocol !== "https:" || publicBase.username || publicBase.password || publicBase.search || publicBase.hash || publicBase.pathname !== "/") throw Error("Invalid Ainmem report configuration");
  return config;
}
type PublicationStore = Pick<StateClient, "get" | "set" | "sAdd" | "sMembers" | "sRem">;
export class AinmemReportPublisher {
  private running: Promise<void> | undefined;
  constructor(private readonly store: PublicationStore, private readonly config: AinmemReportConfig) {}
  async enqueue(jobId: string): Promise<void> {
    if (!UUID.test(jobId)) throw Error("Invalid report publication ID");
    await this.store.sAdd(PENDING, jobId);
  }
  flush(): Promise<void> {
    if (this.running) return this.running;
    const running = this.publishPending(); this.running = running;
    return running.finally(() => { if (this.running === running) this.running = undefined; });
  }
  private async publishPending(): Promise<void> {
    for (const jobId of await this.store.sMembers(PENDING)) {
      if (!UUID.test(jobId)) throw Error("Invalid persisted report publication ID");
      const raw = await this.store.get("report:job:" + jobId);
      if (!raw) continue;
      const job = JSON.parse(raw) as ReportJob;
      if (job.id !== jobId) throw Error("Report publication identity mismatch");
      if (job.status === "failed") { await this.store.sRem(PENDING, jobId); continue; }
      if (job.status !== "completed") continue;
      const receiptKey = "report:ainmem:published:" + jobId;
      if (!(await this.store.get(receiptKey))) {
        const response = await fetch(this.config.endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + this.config.token },
          body: JSON.stringify({ organizationId: this.config.organizationId, job }), signal: AbortSignal.timeout(60000) });
        if (!response.ok) throw Error(`Ainmem report publication HTTP ${response.status}`);
        const receipt = await response.json() as { jobId: string; pageId: string; url: string };
        if (receipt.jobId !== jobId || !UUID.test(receipt.pageId) || receipt.url !== "/p/" + receipt.pageId) throw Error("Invalid Ainmem report publication receipt");
        await this.store.set(receiptKey, JSON.stringify({ jobId, pageId: receipt.pageId, url: new URL(receipt.url, this.config.publicBaseUrl).toString() }));
      }
      await this.store.sRem(PENDING, jobId);
    }
  }
}
