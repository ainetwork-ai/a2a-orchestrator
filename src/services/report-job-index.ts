import type { StateClient } from "../storage/state-client";
export const REPORT_JOB_PREFIX = "report:job:";
const IDS = "report:index:job_ids";
const READY = "report:index:job_ids:v1_ready";

/** Encrypted on-chain index. Existing jobs are discovered once, never on every list request. */
export class ReportJobIndex {
  private bootstrap: Promise<void> | null = null;
  constructor(private readonly store: StateClient) {}
  private async ready(): Promise<void> {
    if (await this.store.get(READY) === "1") return;
    if (!this.bootstrap) {
      this.bootstrap = (async () => {
        const keys = await this.store.keys(`${REPORT_JOB_PREFIX}*`);
        if (keys.length) await this.store.sAdd(IDS, keys.map(key => key.slice(REPORT_JOB_PREFIX.length)));
        // Publish readiness only after all discovered jobs are indexed.
        await this.store.set(READY, "1");
      })().finally(() => { this.bootstrap = null; });
    }
    await this.bootstrap;
  }
  async keys(): Promise<string[]> {
    await this.ready();
    return (await this.store.sMembers(IDS)).map(id => REPORT_JOB_PREFIX + id);
  }
  // Add before saving the job: a failed save may leave a harmless missing ID,
  // but no acknowledged job can become invisible to the list.
  async add(id: string): Promise<void> { await this.store.sAdd(IDS, id); }
  async remove(id: string): Promise<void> { await this.store.sRem(IDS, id); }
}
