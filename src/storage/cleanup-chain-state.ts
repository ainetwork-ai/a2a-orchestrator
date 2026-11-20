import { existsSync, readFileSync } from "node:fs";
import { AinTransport, AinTransportConfig, AinWriteRejected, ChainOperation, StateChainTransport } from "./ain-transport";
import { headsFingerprint, legacyStateChunksWriteRule, stateChunksWriteRule, stateHeadWriteRule } from "./ain-state-store";
import { REPORT_KIND, VerificationReport } from "./migrate-to-store";

/**
 * Remove the old encrypted state (`/apps/<application>/state`) from chain once AIN Store holds a
 * verified copy. NOT run as part of the cutover by default; see docs/AIN-STORE-STATE.md.
 *
 *   cleanup-chain-state plan    --report <file>                          read-only: what would be removed
 *   cleanup-chain-state execute --report <file> --confirm <application>  freeze writes and delete in batches
 *   cleanup-chain-state usage                                            the application's state usage
 *
 * It refuses to run unless a verification report from `migrate-to-store verify` exists, passed,
 * names this state root, and still matches the chain (no record changed after verification).
 *
 * Deletion first installs delete-only rules on heads and chunks, so no writer (including a forgotten
 * old deployment) can add state while it runs; the old backend then refuses to start. Before the
 * chain's `ain_store` activation a delete is accepted only while the app is within the free-tier
 * budget; after activation deletes are always accepted. A rejected batch stops the run with that
 * hint, and a rerun continues where it stopped (it lists what is left).
 */

export interface CleanupChain extends StateChainTransport {
  readonly address: string;
  childLabels(ref: string): Promise<string[]>;
  getRule(ref: string): Promise<unknown>;
}

export function stateHeadDeleteRule(address: string): string {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw Error("Invalid state signer address");
  return `auth.addr === '${address}' && util.checkValuePathLen(parsedValuePath, 5) === true && newData === null`;
}
export function stateChunksDeleteRule(address: string): string {
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) throw Error("Invalid state signer address");
  return `auth.addr === '${address}' && util.checkValuePathLen(parsedValuePath, 7) === true && newData === null`;
}

/** Throws unless the report is a passing verification of `root`. */
export function readVerificationReport(path: string | undefined, root: string): VerificationReport {
  if (!path) throw Error("Refusing to delete chain state: --report <verification report> is required");
  if (!existsSync(path)) throw Error(`Refusing to delete chain state: verification report ${path} does not exist; run migrate-to-store verify first`);
  let report: VerificationReport;
  try { report = JSON.parse(readFileSync(path, "utf8")); } catch { throw Error("Refusing to delete chain state: the verification report is not valid JSON"); }
  if (report?.kind !== REPORT_KIND || report.version !== 1) throw Error("Refusing to delete chain state: not a migrate-to-store verification report");
  if (report.ok !== true || report.missing !== 0 || report.mismatched !== 0 || report.extra !== 0) throw Error("Refusing to delete chain state: the verification did not pass");
  if (report.source?.root !== root) throw Error(`Refusing to delete chain state: the report verified ${report.source?.root}, not ${root}`);
  if (report.target?.records < report.source.records) throw Error("Refusing to delete chain state: the Store held fewer records than the chain");
  return report;
}

export interface CleanupPlan { frozen: boolean; ruleOperations: ChainOperation[]; heads: number; chunkRecords: number }
export interface CleanupResult extends CleanupPlan { executed: boolean; transactions: number; removed: number; remaining: number }

const headsRule = (root: string) => `${root}/heads/$recordId`;
const chunksRule = (root: string) => `${root}/chunks/$recordId/$revision/$index`;

async function plan(chain: CleanupChain, root: string, report: VerificationReport): Promise<CleanupPlan> {
  const head = await chain.getRule(headsRule(root)), chunk = await chain.getRule(chunksRule(root));
  const frozen = head === stateHeadDeleteRule(chain.address) && chunk === stateChunksDeleteRule(chain.address);
  const ruleOperations: ChainOperation[] = [];
  if (!frozen) {
    if (head !== stateHeadWriteRule(chain.address) && head !== stateHeadDeleteRule(chain.address)) throw Error("Unexpected head rule; refusing to overwrite it");
    if (![stateChunksWriteRule(chain.address), legacyStateChunksWriteRule(chain.address), stateChunksDeleteRule(chain.address)].includes(chunk as string)) throw Error("Unexpected chunk rule; refusing to overwrite it");
    // Writers are still possible: the chain must be exactly what was verified.
    const current = await headsFingerprint(chain, root);
    if (current.sha256 !== report.source.headsSha256) throw Error("Refusing to delete chain state: records changed after verification; migrate and verify again");
    ruleOperations.push(
      { type: "SET_RULE", ref: headsRule(root), value: { ".rule": { write: stateHeadDeleteRule(chain.address) } } },
      { type: "SET_RULE", ref: chunksRule(root), value: { ".rule": { write: stateChunksDeleteRule(chain.address) } } });
  }
  return { frozen, ruleOperations, heads: (await chain.childLabels(`${root}/heads`)).length, chunkRecords: (await chain.childLabels(`${root}/chunks`)).length };
}

export async function cleanupChainState(chain: CleanupChain, root: string, options: { reportPath?: string; execute?: boolean; confirm?: string; maxOperations?: number; log?: (line: string) => void }): Promise<CleanupResult> {
  if (!/^\/apps\/[a-zA-Z0-9_]+\/state$/.test(root)) throw Error("State root must be an application's state path");
  const report = readVerificationReport(options.reportPath, root);
  const log = options.log ?? (() => {});
  const planned = await plan(chain, root, report);
  if (!options.execute) return { ...planned, executed: false, transactions: 0, removed: 0, remaining: planned.heads + planned.chunkRecords };
  if (options.confirm !== root.split("/")[2]) throw Error("Refusing to delete chain state: --confirm <application> must name the application");
  const limit = Math.min(options.maxOperations ?? chain.operationCountLimit ?? 50, chain.operationCountLimit ?? 50);
  const bytes = chain.operationJsonBytesLimit ?? 4500;
  let transactions = 0, removed = 0, batch: ChainOperation[] = [];
  const send = async (operations: ChainOperation[]) => {
    try { await chain.write(operations); }
    catch (error) {
      if (error instanceof AinWriteRejected) throw Error("The chain rejected a delete batch. Before ain_store activation, deletes are accepted only while the app is within the free-tier budget; retry after activation or with a smaller --max-ops. Rerunning continues from what is left.");
      throw error;
    }
    transactions++;
    if (transactions % 20 === 0) log(`${transactions} transactions, ${removed} values removed`);
  };
  const add = async (operation: ChainOperation) => {
    if (batch.length && (batch.length >= limit || Buffer.byteLength(JSON.stringify([...batch, operation])) > bytes)) { await send(batch); removed += batch.length; batch = []; }
    batch.push(operation);
  };
  if (planned.ruleOperations.length) { await send(planned.ruleOperations); log("delete-only rules installed: state writes are frozen"); }
  const ids = new Set([...await chain.childLabels(`${root}/chunks`), ...await chain.childLabels(`${root}/heads`)]);
  for (const id of ids) {
    for (const revision of await chain.childLabels(`${root}/chunks/${id}`)) {
      for (const index of await chain.childLabels(`${root}/chunks/${id}/${revision}`)) await add({ type: "SET_VALUE", ref: `${root}/chunks/${id}/${revision}/${index}`, value: null });
    }
    // The head goes last; a rerun lists heads and chunks again, so an interrupted run loses nothing.
    if (await chain.get(`${root}/heads/${id}`) !== null) await add({ type: "SET_VALUE", ref: `${root}/heads/${id}`, value: null });
  }
  if (batch.length) { await send(batch); removed += batch.length; batch = []; }
  const remaining = (await chain.childLabels(`${root}/heads`)).length + (await chain.childLabels(`${root}/chunks`)).length;
  return { ...planned, executed: true, transactions, removed, remaining };
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index > 0 ? process.argv[index + 1] : undefined;
}

async function main(command: string | undefined): Promise<void> {
  const config: AinTransportConfig & { application: string } = JSON.parse(readFileSync(process.env.AIN_STATE_CONFIG ?? "", "utf8"));
  if (!/^[a-zA-Z0-9_]+$/.test(config.application)) throw Error("Invalid application in AIN_STATE_CONFIG");
  const transport = new AinTransport(config);
  await transport.verifyNetwork();
  if (command === "usage") {
    console.log(JSON.stringify(await transport.rpc("ain_getStateUsage", { app_name: config.application })));
    return;
  }
  if (command !== "plan" && command !== "execute") throw Error("usage: cleanup-chain-state plan --report <file> | execute --report <file> --confirm <application> [--max-ops N] | usage");
  const chain: CleanupChain = {
    address: transport.address, operationCountLimit: transport.operationCountLimit, operationJsonBytesLimit: transport.operationJsonBytesLimit,
    get: ref => transport.get(ref), childLabels: ref => transport.childLabels(ref), write: operations => transport.write(operations),
    getRule: async ref => (await transport.rpc<{ ".rule"?: { write: unknown } } | null>("ain_get", { type: "GET_RULE", ref, is_final: true }))?.[".rule"]?.write ?? null,
  };
  const maxOps = argument("max-ops");
  const result = await cleanupChainState(chain, `/apps/${config.application}/state`, {
    reportPath: argument("report"), execute: command === "execute", confirm: argument("confirm"),
    maxOperations: maxOps ? Number(maxOps) : undefined, log: line => console.error(line),
  });
  const { ruleOperations, ...summary } = result;
  console.log(JSON.stringify({ ...summary, ruleChanges: ruleOperations.map(operation => operation.ref) }));
  if (result.executed) console.log(JSON.stringify({ usage: await transport.rpc("ain_getStateUsage", { app_name: config.application }) }));
}

if (require.main === module) {
  main(process.argv[2]).catch(error => {
    console.error("chain state cleanup failed: " + (error instanceof Error ? error.message : "unknown"));
    process.exit(1);
  });
}
