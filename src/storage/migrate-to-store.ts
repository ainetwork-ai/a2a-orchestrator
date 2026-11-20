import { createHash } from "node:crypto";
import { writeFileSync, renameSync } from "node:fs";
import type { StateValue } from "./encrypted-state";
import { AinStoreStateClient, STATE_COLLECTIONS, StoreCore, StoreSdk, ainStoreStateClient, loadCore, loadSdk, readAinStoreStateConfig, stateCollectionWriteRule, stateDigest } from "./ain-store-state-client";

/**
 * Move the orchestrator's state from encrypted chain records (AinStateStore) to AIN Store.
 *
 *   migrate [--dry-run] [--batch N] [--prune]   copy every live record; rerun to resume or catch up
 *   verify  --report <file>                     compare every record (count + hash per key), write the report
 *   sweep                                       delete Store documents whose expiry has passed
 *   setup-ops [--store-service-address 0x…]     print the app-owner operations that install the collections
 *
 * Source: AIN_STATE_CONFIG (the service's private chain state file). Target: AIN_STORE_CONFIG.
 * Nothing here deletes or changes chain state records; `cleanup-chain-state` does that, later.
 */

export interface StateSource {
  entries(): AsyncIterable<{ state: StateValue }>;
  headsFingerprint(): Promise<{ heads: number; sha256: string }>;
}
export type StateTarget = Pick<AinStoreStateClient, "readRecord" | "importRecords" | "records" | "del">;

export interface MigrateResult {
  dryRun: boolean;
  scanned: number;
  unchanged: number;
  /** Written (or, in a dry run, that would be written). */
  written: number;
  /** Store records with no live source record; removed only with `prune`. */
  extra: number;
  pruned: number;
}

/**
 * Copy every live source record whose Store copy is missing or different. Idempotent: a record
 * already identical in the Store is skipped, so a rerun resumes after a failure and catches up
 * writes made since the last run. A dry run reads both sides and writes nothing.
 */
export async function migrateState(source: StateSource, target: StateTarget | null, options: { dryRun?: boolean; batchSize?: number; prune?: boolean; log?: (line: string) => void } = {}): Promise<MigrateResult> {
  const dryRun = options.dryRun ?? false, batchSize = options.batchSize ?? 20, log = options.log ?? (() => {});
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 50) throw Error("Batch size must be 1..50");
  if (!target && !dryRun) throw Error("A target Store is required unless --dry-run");
  const result: MigrateResult = { dryRun, scanned: 0, unchanged: 0, written: 0, extra: 0, pruned: 0 };
  const seen = new Set<string>();
  let pending: StateValue[] = [];
  const flush = async () => {
    if (!pending.length) return;
    if (!dryRun) await target!.importRecords(pending);
    result.written += pending.length;
    pending = [];
    log(`${dryRun ? "would write" : "written"} ${result.written} (scanned ${result.scanned}, unchanged ${result.unchanged})`);
  };
  for await (const { state } of source.entries()) {
    result.scanned++;
    seen.add(state.key);
    const existing = target ? await target.readRecord(state.key) : null;
    if (existing && stateDigest(existing) === stateDigest(state)) { result.unchanged++; continue; }
    pending.push(state);
    if (pending.length >= batchSize) await flush();
  }
  await flush();
  if (target) {
    const extra: string[] = [];
    for await (const state of target.records()) if (!seen.has(state.key)) extra.push(state.key);
    result.extra = extra.length;
    if (options.prune && extra.length && !dryRun) result.pruned = await target.del(extra);
  }
  return result;
}

export const REPORT_KIND = "a2a-orchestrator/ain-store-verification";
export interface VerificationReport {
  kind: typeof REPORT_KIND;
  version: 1;
  ok: boolean;
  reasons: string[];
  generatedAt: string;
  source: { root: string; records: number; heads: number; headsSha256: string };
  target: { url: string; app: string; records: number };
  matched: number;
  missing: number;
  mismatched: number;
  extra: number;
  /** SHA-256 over the sorted `key<TAB>digest` lines of every source record. */
  digest: string;
  /** First problem keys of each kind (at most 50). */
  samples: { missing: string[]; mismatched: string[]; extra: string[] };
  /** Per-key digest of every source record: sha256 of [key, type, value (sets sorted), expiresAt]. */
  records: Record<string, string>;
}

/**
 * Compare every live source record with the Store. The source's head fingerprint is taken before
 * and after; a write in between fails the verification, because the comparison may be stale.
 */
export async function verifyState(source: StateSource, target: StateTarget, meta: { root: string; url: string; app: string }): Promise<VerificationReport> {
  const before = await source.headsFingerprint();
  const records: Record<string, string> = {};
  for await (const { state } of source.entries()) records[state.key] = stateDigest(state);
  const stored = new Map<string, string>();
  for await (const state of target.records()) stored.set(state.key, stateDigest(state));
  const after = await source.headsFingerprint();
  const missing: string[] = [], mismatched: string[] = [], extra: string[] = [];
  for (const [key, digest] of Object.entries(records)) {
    const other = stored.get(key);
    if (other === undefined) missing.push(key); else if (other !== digest) mismatched.push(key);
  }
  for (const key of stored.keys()) if (!(key in records)) extra.push(key);
  const reasons: string[] = [];
  if (before.sha256 !== after.sha256) reasons.push("chain state changed during verification; stop writers and verify again");
  if (missing.length) reasons.push(`${missing.length} records missing from the Store`);
  if (mismatched.length) reasons.push(`${mismatched.length} records differ`);
  if (extra.length) reasons.push(`${extra.length} Store records have no source record (migrate --prune)`);
  const lines = Object.entries(records).map(([key, digest]) => `${key}\t${digest}`).sort();
  return {
    kind: REPORT_KIND, version: 1, ok: reasons.length === 0, reasons, generatedAt: new Date().toISOString(),
    source: { root: meta.root, records: lines.length, heads: after.heads, headsSha256: after.sha256 },
    target: { url: meta.url, app: meta.app, records: stored.size },
    matched: lines.length - missing.length - mismatched.length, missing: missing.length, mismatched: mismatched.length, extra: extra.length,
    digest: createHash("sha256").update(lines.join("\n")).digest("hex"),
    samples: { missing: missing.slice(0, 50), mismatched: mismatched.slice(0, 50), extra: extra.slice(0, 50) },
    records,
  };
}

/** Written atomically with mode 0600: it lists record keys (thread ids), not contents. */
export function writeReport(path: string, report: VerificationReport): void {
  writeFileSync(path + ".tmp", JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  renameSync(path + ".tmp", path);
}

/**
 * App-owner operations that install the state collections for the Store (for review and signing
 * by the app owner; this tool never sends them).
 */
export function setupOperations(app: string, writerAddress: string, core: StoreCore, storeServiceAddress?: string): Array<{ type: string; ref: string; value: unknown }> {
  const operations: Array<{ type: string; ref: string; value: unknown }> = [];
  for (const collection of STATE_COLLECTIONS) {
    operations.push({ type: "SET_RULE", ref: `/apps/${app}/writes/${collection}`, value: { ".rule": { write: stateCollectionWriteRule(writerAddress, core) } } });
    operations.push({ type: "SET_FUNCTION", ref: `/apps/${app}/writes/${collection}/$key`, value: { ".function": core.storeAppendFunctionConfig() } });
  }
  operations.push({ type: "SET_RULE", ref: `/apps/${app}/store/state`, value: { ".rule": { write: `auth.addr === '${storeServiceAddress ?? "<Store service account address>"}'` } } });
  return operations;
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}

async function main(command: string | undefined): Promise<void> {
  const log = (line: string) => console.error(line);
  if (command === "setup-ops") {
    const config = readAinStoreStateConfig(process.env.AIN_STORE_CONFIG ?? "");
    const sdk: StoreSdk = loadSdk();
    const writer = sdk.privateKeySigner(config.writerKey.replace(/^0x/, ""), config.chainId) as { address: string };
    console.log(JSON.stringify({ app: config.app, writerAddress: writer.address, operations: setupOperations(config.app, writer.address, loadCore(), argument("store-service-address")) }, null, 2));
    return;
  }
  const storePath = process.env.AIN_STORE_CONFIG ?? "";
  const dryRun = process.argv.includes("--dry-run");
  const storeConfig = storePath || !dryRun ? readAinStoreStateConfig(storePath) : null;
  const target = storeConfig ? ainStoreStateClient(storeConfig) : null;
  if (command === "sweep") {
    console.log(JSON.stringify({ expiredRemoved: await target!.sweepExpired() }));
    return;
  }
  // Imported here so `setup-ops` and `sweep` need no chain configuration.
  const { createAinStateStore } = await import("./config");
  const source = await createAinStateStore(process.env.AIN_STATE_CONFIG ?? "");
  try {
    if (command === "migrate") {
      const batch = argument("batch");
      console.log(JSON.stringify(await migrateState(source, target, { dryRun, batchSize: batch ? Number(batch) : undefined, prune: process.argv.includes("--prune"), log })));
      return;
    }
    if (command === "verify") {
      const path = argument("report");
      if (!path || !target || !storeConfig) throw Error("verify needs --report <file> and AIN_STORE_CONFIG");
      const report = await verifyState(source, target, { root: source.root, url: storeConfig.url, app: storeConfig.app });
      writeReport(path, report);
      const { records: _records, ...summary } = report;
      console.log(JSON.stringify(summary));
      if (!report.ok) process.exitCode = 2;
      return;
    }
  } finally { await source.quit(); await target?.quit(); }
  throw Error("usage: migrate-to-store migrate [--dry-run] [--batch N] [--prune] | verify --report <file> | sweep | setup-ops [--store-service-address 0x…]");
}

if (require.main === module) {
  main(process.argv[2]).catch(error => {
    console.error("state migration failed: " + (error instanceof Error ? error.message : "unknown"));
    process.exit(1);
  });
}
