/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-require-imports */
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AinStoreStateClient, STATE_COLLECTIONS, StoreSdk, ainStoreStateClient, stateCollectionWriteRule } from "./ain-store-state-client";

/**
 * A real AIN Store service for tests, in its development mode: the Store server from an ain-store
 * checkout (AIN_STORE_REPO, built with `npm run build`) on SQLite, a filesystem "drive" for bodies,
 * and an in-process chain that checks signatures, evaluates each collection's compiled `.rule`
 * expression (the production `compileServiceOnlyRule`), mirrors the `_storeAppend` function tree
 * (an owner transaction installs it at block 1; leaf → MMR, slot erased) and finalizes every
 * transaction in its own block.
 * Returns null when AIN_STORE_REPO is not set, so the suites skip instead of failing.
 */
export const AIN_STORE_REPO = process.env.AIN_STORE_REPO ?? "";
export function ainStoreAvailable(): boolean {
  return !!AIN_STORE_REPO && existsSync(join(AIN_STORE_REPO, "packages/server/dist/index.js"));
}

export const DEV_CHAIN_ID = 0;
export const DEV_APP = "uncommon_gallery_orchestrator";

export interface DevStore {
  url: string;
  chain: DevChain;
  driveRoot: string;
  writerKey: string;
  writerAddress: string;
  serviceToken: string;
  hmacKey: string;
  sdk: StoreSdk;
  client(clock?: () => number, writerKey?: string): AinStoreStateClient;
  stop(): Promise<void>;
}

export interface DevChain {
  /** Every transaction body the chain accepted or rejected, as sent. */
  transactions: Array<{ tx_body: any; ok: boolean }>;
  values: Map<string, unknown>;
  rules: Map<string, (auth: string, record: any) => boolean>;
  /** Install a compiled `.rule` write expression for a collection, evaluated like the chain does. */
  setCompiledRule(collection: string, expression: string): void;
}

export async function startDevStore(): Promise<DevStore> {
  const server = require(join(AIN_STORE_REPO, "packages/server/dist/index.js"));
  const core = require(join(AIN_STORE_REPO, "packages/core/dist/index.js"));
  let sdk: StoreSdk;
  try { sdk = require("@ainize/store"); } catch { sdk = require(join(AIN_STORE_REPO, "packages/sdk/dist/index.js")); }

  const app = DEV_APP;
  const blocks: any[] = [];
  const chain = {
    transactions: [] as DevChain["transactions"],
    values: new Map<string, unknown>(),
    rules: new Map<string, (auth: string, record: any) => boolean>(),
    async getLastBlockNumber() { return blocks.length - 1; },
    async getBlocks(from: number, to: number) { return JSON.parse(JSON.stringify(blocks.slice(from, to))); },
    async getValue(ref: string) { return chain.values.has(ref) ? JSON.parse(JSON.stringify(chain.values.get(ref))) : null; },
    async getFunction(ref: string) { return ref === `/apps/${app}/writes` ? JSON.parse(JSON.stringify(functions.toJSON())) : null; },
    async getStateUsage() { return null; },
    setCompiledRule(collection: string, expression: string) {
      const rule = new Function("auth", "newData", "util", `return ${expression};`);
      const util = { isDict: (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v), isString: (v: unknown) => typeof v === "string", isInteger: Number.isInteger };
      chain.rules.set(collection, (auth, record) => rule({ addr: auth }, record, util) === true);
    },
    mine(transactions: any[], receipts: any[]) {
      blocks.push({ number: blocks.length, hash: "0x" + blocks.length.toString(16).padStart(64, "0"), timestamp: Date.now(), transactions, receipts });
    },
    async sendSignedTransaction(txBody: any, signature: string) {
      const address = server.recoverTxSigner(txBody, signature, DEV_CHAIN_ID);
      if (!address) return { ok: false, txHash: null, code: 30304, message: "Invalid transaction signature." };
      const hash = server.txHashOf(txBody);
      const operations: any[] = txBody.operation.type === "SET" ? txBody.operation.op_list : [txBody.operation];
      const results: Record<string, { code: number }> = {};
      let failed = false;
      operations.forEach((operation, index) => {
        const slot = core.parseSlotPath(app, operation.ref);
        const allowed = slot ? (chain.rules.get(slot.collection) ?? (() => true))(address, operation.value) : operation.ref !== core.mmrPath(app);
        results[index] = { code: failed || allowed ? 0 : 12103 };
        if (!allowed) failed = true;
      });
      const tx = { tx_body: txBody, signature, hash, address };
      chain.transactions.push({ tx_body: JSON.parse(JSON.stringify(txBody)), ok: !failed });
      if (failed) { chain.mine([tx], [{ result_list: results }]); return { ok: false, txHash: hash, code: 12103, message: "Write rule evaluated false" }; }
      let mmr = core.mmrFromChain(chain.values.get(core.mmrPath(app)) ?? null);
      // SET_FUNCTION ops update the function tree; `_storeAppend` folds slots only where installed.
      for (const write of core.extractAppendedSlots(functions, txBody).slots) mmr = core.mmrAppend(mmr, core.leafHash({ a: app, c: write.collection, k: write.key, r: write.record, t: hash })).state;
      if (mmr.n) chain.values.set(core.mmrPath(app), core.mmrToChain(mmr));
      for (const operation of operations) if (operation.type === "SET_VALUE" && !core.parseSlotPath(app, operation.ref)) chain.values.set(operation.ref, operation.value);
      chain.mine([tx], [{ result_list: results }]);
      return { ok: true, txHash: hash };
    },
  };
  const functions = new core.StoreFunctionTree(app);
  chain.mine([], []);
  // Block 1: the app owner installs `_storeAppend` on every collection (setup-ops does this on mainnet).
  const owner = randomBytes(32).toString("hex");
  const install = { operation: { type: "SET_FUNCTION", ref: `/apps/${app}/writes/$collection/$key`, value: { ".function": core.storeAppendFunctionConfig() } }, nonce: -1, timestamp: Date.now(), gas_price: 0 };
  await chain.sendSignedTransaction(install, core.signTransaction(install, owner, DEV_CHAIN_ID));

  const dir = mkdtempSync(join(tmpdir(), "a2a-ain-store-"));
  const driveRoot = join(dir, "drive");
  const hmacEnv = "A2A_TEST_STATE_HMAC_KEY";
  const hmacKey = randomBytes(32).toString("hex");
  process.env[hmacEnv] = hmacKey;
  const collections = Object.fromEntries(STATE_COLLECTIONS.map(name => [name, { private: { hmacKeyEnv: hmacEnv }, read: "none" }]));
  const config = server.normalizeConfig({
    app, dataDir: dir, storage: { kind: "fs", root: driveRoot },
    chain: { chainId: DEV_CHAIN_ID, pollMs: 10, batchBlocks: 100 },
    state: { enabled: false, everyWrites: 1000, everyMs: 3_600_000 },
    archive: { segmentSize: 1000, flushMs: 3_600_000 },
    auth: { sessions: false }, collections,
  });
  const serviceToken = randomBytes(24).toString("hex");
  const service = await server.StoreService.create(config, {
    chain, storage: new server.FsStorage(driveRoot), db: server.openDb(join(dir, "store.db")), log: () => {}, signer: null,
    verifiers: [new server.ServiceTokenVerifier(serviceToken)],
  });
  service.start();
  const http = server.createHttpServer(service) as ReturnType<typeof createServer>;
  await new Promise<void>(resolve => http.listen(0, "127.0.0.1", () => resolve()));
  const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;

  const writerKey = randomBytes(32).toString("hex");
  const writerAddress = (sdk.privateKeySigner(writerKey, DEV_CHAIN_ID) as { address: string }).address;
  // The production collection rule (stateCollectionWriteRule → compileServiceOnlyRule): only the writer may write.
  for (const name of STATE_COLLECTIONS) chain.setCompiledRule(name, stateCollectionWriteRule(writerAddress, core));
  // Reads answer 503 until the Store has matched its MMR with the chain once.
  for (let waited = 0; !service.readsReady(); waited += 10) {
    if (waited > 10_000) throw Error("dev Store did not become ready");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  return {
    url, chain, driveRoot, writerKey, writerAddress, serviceToken, hmacKey, sdk,
    client: (clock, key = writerKey) => ainStoreStateClient({ url, app, chainId: DEV_CHAIN_ID, writerKey: key, serviceToken, hmacKey, writeTimeoutMs: 10_000 }, sdk, {}, clock),
    stop: async () => { await service.stop(); await new Promise(resolve => http.close(resolve)); },
  };
}
