import { readFileSync } from "node:fs";
import { AinTransport, AinTransportConfig } from "./ain-transport";
import { legacyStateChunksWriteRule, stateChunksWriteRule } from "./ain-state-store";
import { createAinStateStore } from "./config";

/**
 * Maintenance for the Blockchain state application:
 *   upgrade-rule  replace the legacy chunk rule with one that allows removing superseded revisions
 *   sweep         remove chunks no live head points at (run after upgrade-rule)
 * Both read AIN_STATE_CONFIG, the same private file the service uses.
 */
async function main(command: string | undefined): Promise<void> {
  const path = process.env.AIN_STATE_CONFIG ?? "";
  if (command === "upgrade-rule") {
    const config: AinTransportConfig & { application: string } = JSON.parse(readFileSync(path, "utf8"));
    const chain = new AinTransport(config);
    await chain.verifyNetwork();
    const ref = `/apps/${config.application}/state/chunks/$recordId/$revision/$index`;
    const current = (await chain.rpc<{ ".rule"?: { write: unknown } } | null>("ain_get", { type: "GET_RULE", ref, is_final: true }))?.[".rule"]?.write;
    if (current === stateChunksWriteRule(chain.address)) { console.log(JSON.stringify({ ref, upgraded: false, reason: "already current" })); return; }
    if (current !== legacyStateChunksWriteRule(chain.address)) throw Error("Unexpected chunk rule; refusing to overwrite it");
    await chain.write([{ type: "SET_RULE", ref, value: { ".rule": { write: stateChunksWriteRule(chain.address) } } }]);
    console.log(JSON.stringify({ ref, upgraded: true }));
    return;
  }
  if (command === "sweep") {
    const graceMs = process.env.STATE_SWEEP_GRACE_MS ? Number(process.env.STATE_SWEEP_GRACE_MS) : undefined;
    const store = await createAinStateStore(path);
    console.log(JSON.stringify(await store.sweep({ graceMs })));
    await store.quit();
    return;
  }
  throw Error("usage: maintain-state upgrade-rule | sweep");
}

main(process.argv[2]).catch(error => {
  console.error("state maintenance failed: " + (error instanceof Error ? error.message : "unknown"));
  process.exit(1);
});
