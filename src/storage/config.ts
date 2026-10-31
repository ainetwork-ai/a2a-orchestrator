import { readFileSync, statSync } from "node:fs";
import { AinTransport, AinTransportConfig } from "./ain-transport";
import { AinStateStore, DEFAULT_STATE_CACHE_BYTES, legacyStateChunksWriteRule, stateChunksWriteRule, stateHeadWriteRule } from "./ain-state-store";
import { EncryptedStateCodec } from "./encrypted-state";

interface StateConfig extends AinTransportConfig {
  organizationId: string;
  application: string;
  encryptionKey: string;
}
export async function createAinStateStore(path: string): Promise<AinStateStore> {
  if (!path) throw Error("AIN_STATE_CONFIG is required for Blockchain state");
  const file = statSync(path);
  if (!file.isFile() || (file.mode & 0o077) !== 0 || (process.getuid && file.uid !== process.getuid())) throw Error("AIN state configuration must be private and owned by the service user");
  const config: StateConfig = JSON.parse(readFileSync(path, "utf8"));
  if (!config.organizationId || !/^[a-zA-Z0-9_]+$/.test(config.application) || !/^[a-fA-F0-9]{64}$/.test(config.encryptionKey)) throw Error("Invalid organization state configuration");
  const chain = new AinTransport(config);
  await chain.verifyNetwork();
  const root = `/apps/${config.application}/state`;
  const metadata = await chain.get<{ organizationId: string }>(`/apps/${config.application}/state_metadata`);
  if (metadata?.organizationId !== config.organizationId) throw Error("AIN state application organization mismatch");
  const writeRule = async (ref: string) => (await chain.rpc<{ ".rule"?: { write: unknown } } | null>("ain_get", { type: "GET_RULE", ref, is_final: true }))?.[".rule"]?.write;
  for (const [ref, expected] of [
    [root, false],
    [`${root}/heads/$recordId`, stateHeadWriteRule(chain.address)],
  ] as const) {
    if (await writeRule(ref) !== expected) throw Error("AIN state write rules are not provisioned correctly");
  }
  // The legacy chunk rule still works but cannot remove superseded revisions;
  // `npm run state:maintain -- upgrade-rule` replaces it.
  const chunkRule = await writeRule(`${root}/chunks/$recordId/$revision/$index`);
  const prune = chunkRule === stateChunksWriteRule(chain.address);
  if (!prune && chunkRule !== legacyStateChunksWriteRule(chain.address)) throw Error("AIN state write rules are not provisioned correctly");
  const cacheBytes = process.env.AIN_STATE_CACHE_MAX_BYTES ? Number(process.env.AIN_STATE_CACHE_MAX_BYTES) : DEFAULT_STATE_CACHE_BYTES;
  return new AinStateStore(chain, new EncryptedStateCodec(config.organizationId, Buffer.from(config.encryptionKey, "hex")), root, Date.now, cacheBytes, prune);
}
