# Organization state on AIN Blockchain

Set `STATE_BACKEND=ain-blockchain` and `AIN_STATE_CONFIG` to a private JSON file owned by the runtime user (mode `0600`). Explicit Blockchain configuration never falls back to Redis. Redis remains the default for existing deployments and can be retained separately for migration comparison and rollback.

The configuration contains `organizationId`, `application`, `rpcUrl`, `chainId`, `genesisHash`, `privateKey`, `encryptionKey`, `gasPrice`, and `transactionBytesLimit`. Both keys are 32-byte hexadecimal strings. Keep an encrypted backup of this file in Ain Vault. The transaction signing domain and genesis hash must come from the intended running chain; an L2 execution signing domain can differ from its genesis/checkpoint chain ID.

Provision a dedicated application through `/manage_app/<application>/create/<timestamp>` with the service signer as administrator. Set `/apps/<application>/state_metadata/organizationId` to the canonical AIN SSO organization ID. Before enabling the adapter, install these native rules:

- `/apps/<application>/state`: `{ ".rule": { "write": false } }`.
- `state/heads/$recordId`: the expression returned by `stateHeadWriteRule(address)` in `src/storage/ain-state-store.ts`.
- `state/chunks/$recordId/$revision/$index`: the expression returned by `stateChunksWriteRule(address)` (write-once chunks that may be removed).

Startup checks the chain identity, transaction limit, organization binding, and exact rules. Applications provisioned before revision pruning still carry `legacyStateChunksWriteRule`; the service accepts it but cannot remove anything under it.

## Revision pruning and sweep

Each write publishes a new revision under `chunks/<id>/<revision>/`. The revision a new header replaces is removed in the header's own transaction when it fits, otherwise right after it; deletions and tombstones remove the last revision too. Removal is cleanup: a failure never fails the acknowledged write and is picked up by the next sweep. Without this, every update and every expired cache entry stayed on chain for good, and `uncommon_gallery_orchestrator` grew to 112 MB, filling the mainnet free-tier state budget (100 MB, shared by every unstaked app) so that unstaked apps such as `baby_shark` could no longer write.

Upgrade an existing application once, as its service signer:

```sh
npm run build
AIN_STATE_CONFIG=/path/to/state.json npm run state:maintain -- upgrade-rule   # legacy → removable chunk rule
# restart the service so it starts pruning
AIN_STATE_CONFIG=/path/to/state.json npm run state:maintain -- sweep          # remove existing garbage
```

`sweep` tombstones expired records, then removes every revision no head points at. A revision is removed only if it is still unreferenced after `STATE_SWEEP_GRACE_MS` (default 10 minutes), so another process's commit that has confirmed its chunks but not yet its header is never touched. The application's rules accept writes only from its dedicated service signer. Organization membership for the application API must still be enforced by its hosting gateway; native chain reads expose ciphertext, rather than readable conversations.

## Keeping state small

The chain bills every stored character as two bytes, and chunks are base64, so an uncompressed byte costs about 2.7 bytes of state. Records are therefore Brotli-compressed before encryption (header `version: 2`); text shrinks about 3.7× on the production data. Version 1 records remain readable; rewrite them once with `npm run state:maintain -- compact`.

Keep caches and derived data off chain. Message embeddings used to be cached here (a 1536-float vector is ~160 KB of state) and now live in an in-process LRU (`EMBEDDING_CACHE_ENTRIES`, default 5000). Remove the old entries with `npm run state:maintain -- delete 'emb:msg:*'`.

Records preserve original keys, string values, set members, IDs, and expiry inside AES-256-GCM envelopes. Organization-derived HMAC IDs hide original key names. Large records use immutable encrypted chunks; a revision header is published after the chunks are confirmed. The native header rule compares the previous revision at execution, preventing concurrent set updates from overwriting one another. Acknowledgement waits for a finalized successful native receipt. Missing chunks, authentication failures, reversion, and uncertain finality propagate as failures.

The existing string/set/cache operations use the selected state adapter. `multi().setEx().exec()` publishes all cache headers in one native atomic transaction; an oversized batch fails before authoritative changes. Thread and ingest endpoints await persistence, preserve caller IDs, and report Blockchain failures instead of acknowledging uncommitted state. Agent memory remains on AIN Drive; readable report publication to Ainmem is a separate integration.

For authenticated model endpoints, configure `LLM_API_KEY`. Its Bearer header is sent only when the request destination exactly matches `LLM_API_URL`.

Build and verify locally:

```sh
npm ci
npm run build
node --test dist/storage/*.test.js dist/world/requestManager.test.js dist/migration/transform.test.js dist/services/reportPipeline/opinionExtractor.test.js
```

Before production cutover, import the entire source snapshot and compare every original record and API response after restarting the Blockchain adapter. Local tests alone do not prove real-chain durability, organization access, report publication, or agent behavior parity.

For future readable reports, set `AINMEM_REPORT_CONFIG` to another runtime-owned `0600` JSON file with `organizationId`, the Ainmem `/api/integrations/orchestrator/reports` endpoint, its organization-specific machine `token`, and an HTTPS `publicBaseUrl`. Enable Ainmem's matching scoped publisher configuration separately. New jobs enter a persistent `report:ainmem:pending` set before their creation is acknowledged. Completed jobs publish with their original IDs and payload, then store a publication receipt before leaving the queue. HTTP failures and uncertain receipt writes retain the queue entry for retry after restart. Existing historical report jobs are not automatically republished.
