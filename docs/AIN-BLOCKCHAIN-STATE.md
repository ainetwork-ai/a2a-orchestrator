# Organization state on AIN Blockchain

Set `STATE_BACKEND=ain-blockchain` and `AIN_STATE_CONFIG` to a private JSON file owned by the runtime user (mode `0600`). Explicit Blockchain configuration never falls back to Redis. Redis remains the default for existing deployments and can be retained separately for migration comparison and rollback.

The configuration contains `organizationId`, `application`, `rpcUrl`, `chainId`, `genesisHash`, `privateKey`, `encryptionKey`, `gasPrice`, and `transactionBytesLimit`. Both keys are 32-byte hexadecimal strings. Keep an encrypted backup of this file in Ain Vault. The transaction signing domain and genesis hash must come from the intended running chain; an L2 execution signing domain can differ from its genesis/checkpoint chain ID.

Provision a dedicated application through `/manage_app/<application>/create/<timestamp>` with the service signer as administrator. Set `/apps/<application>/state_metadata/organizationId` to the canonical AIN SSO organization ID. Before enabling the adapter, install these native rules:

- `/apps/<application>/state`: `{ ".rule": { "write": false } }`.
- `state/heads/$recordId`: the expression returned by `stateHeadWriteRule(address)` in `src/storage/ain-state-store.ts`.
- `state/chunks/$recordId/$revision/$index`: the expression returned by `stateChunksWriteRule(address)`.

Startup checks the chain identity, transaction limit, organization binding, and exact rules. The application's rules accept writes only from its dedicated service signer. Organization membership for the application API must still be enforced by its hosting gateway; native chain reads expose ciphertext, rather than readable conversations.

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
