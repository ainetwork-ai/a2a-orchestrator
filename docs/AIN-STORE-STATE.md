# Orchestrator state on AIN Store

`STATE_BACKEND=ain-store` keeps the orchestrator's state in this project's AIN Store instead of
encrypted records under `/apps/uncommon_gallery_orchestrator/state`. The chain then holds only the
Store's MMR and state root (well under 1 MB) instead of every record's encrypted chunks (~80 MB
for ~6,000 live records).

Design: ainize-web `docs/en/design/ain-data-platform.md`. Store service and SDK: `ain-store`
(`@ainize/store`).

## How the adapter works

`src/storage/ain-store-state-client.ts` implements the same `StateClient` interface
(`get/mGet/set/setNX/setEx/sAdd/sMembers/sRem/sCard/exists/del/keys/scanIterator/multi/quit`), so
the rest of the app is unchanged.

| State key | Store document |
| --- | --- |
| `thread:<id>` | `threads/<id>` |
| `messages:<id>` | `messages/<id>` |
| `report:<rest>` (`report:job:*`, `report:index:*`, `report:ainmem:*`, `report:cache:*`, …) | `reports/<rest>` |
| anything else (`threads:list`, `orchestrator:agents`, …) | `meta/<key>` |

`/` and `%` in ids are escaped, so any key maps and maps back.

- **Body.** Each document is `{ k: key, t: "string" | "set", v: value, x?: expiresAt }`. A read
  checks that `k` matches the key it asked for.
- **Privacy.** All four collections are private: on chain a write record carries only the HMAC id
  and the body hash, and the body itself goes to AinDrive. The read rule is `none`, so only the
  service token can read.
- **Writes.** Each write is signed by the orchestrator's writer key through the SDK's
  `privateKeySigner`, and the collection rule (`stateCollectionWriteRule`) accepts only that
  address. The client sends `prepare → sign → submit` and waits until the write is applied in chain
  order, the same acknowledgement guarantee the chain adapter gave.
- **Concurrency.** Every write passes the document's version as `ifVersion` (the record `base`).
  If another writer got in first, the client gets a `ConflictError`, reads again and retries. That
  keeps `sAdd`/`sRem` free of lost updates and makes `setNX` exclusive across processes. Within one
  process, writes to the same key are queued.
- **Sets.** A set is stored as an array that keeps insertion order. A set that becomes empty is
  deleted.
- **TTL.** `setEx` stores `x`. An expired document reads as absent everywhere (`get`, `exists`,
  `keys`, `setNX`). `npm run state:migrate -- sweep` deletes expired documents.
- **Atomic pipeline.** `multi().setEx(…).exec()` is a single `batch()`: one chain transaction, at
  most 50 keys.
- **Reads.** Reads use a separate SDK `Store` instance that never writes, so a reader never sees a
  write that might still roll back.

### SDK calls this depends on (`@ainize/store` 0.1.0)

- `createStore({ url, app, getToken, signer, writeTimeoutMs })`.
- `privateKeySigner(hex, chainId)`.
- `collection(name).doc(id).get()`, `.set(data, { ifVersion })` and `.delete({ ifVersion })`.
- `collection(name).limit(n).startAfter(cursor).get()`, giving `{ docs, nextCursor }`.
- `batch().set(ref, data, { ifVersion }).commit()`.
- The error names `ConflictError` and `RuleRejectedError`.
- `storeAppendFunctionConfig()`, used only by `setup-ops`.

The SDK is not on npm yet. `vendor/` holds tarballs packed from ain-store commit `0154441`, listed
as **optional** dependencies:

- A build that does not copy `vendor/` still runs `npm ci` and compiles.
- `STATE_BACKEND=ain-blockchain` never loads the SDK.
- `ain-store` fails at startup with a clear message if the SDK is missing.

Once `@ainize/store` is published, replace the `file:` specs with the registry version.

## Configuration

`AIN_STORE_CONFIG` points to a private JSON file (mode `0600`, owned by the runtime user):

```json
{
  "url": "https://<the project's Store URL>",
  "app": "uncommon_gallery_orchestrator",
  "chainId": 1,
  "writerKey": "<hex secp256k1 key; only its address may write the state collections>",
  "serviceToken": "<the Store's AIN_STORE_SERVICE_TOKEN>",
  "writeTimeoutMs": 120000
}
```

On ainize, store this file as the secret `AIN_STORE_CONFIG_B64`.

The Store side of this project is `deploy/ain-store/store.config.json`. Fill in `startBlock` and
`driveId` before deploying. Its secrets are `AIN_STORE_SERVICE_KEY`, `AINDRIVE_TOKEN`,
`AIN_STORE_SERVICE_TOKEN` and `AIN_STORE_STATE_HMAC_KEY`. Keep encrypted copies of every key in
Ain Vault.

## Tests

```sh
npm ci && npm run build
# The AIN Store suites need a built ain-store checkout (dev mode: in-process chain + filesystem drive).
AIN_STORE_REPO=/path/to/ain-store node --test dist/storage/*.test.js
```

- `state-client-contract.test.ts` runs the same `StateClient` contract against `AinStateStore`
  and against a real Store service in dev mode. It also covers privacy (no plain key or value on
  chain, and nothing on chain except `store/mmr`), the writer-only rule, the one-transaction
  pipeline, and the expiry sweep.
- `migrate-to-store.test.ts` covers the dry run, resume after failure, idempotent rerun,
  verification (count plus a hash per key), catching up and pruning, tamper detection, and a chain
  write during verification.
- `cleanup-chain-state.test.ts` covers refusal without a passing, current report, the read-only
  plan, freezing writes, batched deletes, and resume after a rejected batch.

Without `AIN_STORE_REPO`, the Store suites are skipped.

## Cutover runbook

Run each step only after the previous one succeeds. Nothing in this PR deploys, deletes or sends
a mainnet transaction by itself.

0. **Prerequisite.** The chain's `ain_store` timer flag must be active on mainnet, because the
   Store relies on `_storeAppend`. Until then, run steps 1–3 only against a dev chain.

1. **Deploy the Store for this project.**
   1. Create the Store's ainize project from `ain-store` (its `ainize.json` and `Dockerfile`)
      using `deploy/ain-store/store.config.json`, and set its four secrets.
   2. Print the app-owner operations and review them:

      ```sh
      AIN_STORE_CONFIG=/private/ain-store-state.json npm run state:migrate -- setup-ops --store-service-address 0x<Store service account>
      ```

      This prints a `SET_RULE` (writer-only) and a `SET_FUNCTION` (`_storeAppend`) for each of
      `threads`, `messages`, `reports` and `meta`, plus the writer rule of `/apps/<app>/store/state`.
   3. Have the app owner sign and send those operations.
   4. Check that the Store's `/healthz` shows `alert: null` and that `/v1/status` is following
      the chain.

2. **Migrate while the service keeps running.** The migration only reads chain state.

   ```sh
   export AIN_STATE_CONFIG=/private/blockchain-state.json AIN_STORE_CONFIG=/private/ain-store-state.json
   npm run build
   npm run state:migrate -- migrate --dry-run          # counts: scanned / would write
   npm run state:migrate -- migrate --batch 20         # rerun as often as needed: it skips identical records
   ```

   Each batch is one chain transaction. If a run fails, run it again: records that already match
   are skipped.

3. **Freeze, catch up and verify.**
   1. Stop the orchestrator's writes. Use the ainize project's stop or scale-down; do not
      `docker restart` the container.
   2. Catch up the last changes:

      ```sh
      npm run state:migrate -- migrate --prune            # last changes; removes Store docs deleted on chain
      npm run state:migrate -- verify --report /private/state-verification.json
      ```

   `verify` compares every live record by count and by a hash per key, including type, set members
   and expiry. It also fails if chain state changed while it ran. It exits with code 2 unless the
   report says `"ok": true`. Keep the report, because the cleanup needs it.

4. **Switch the backend.** Make these changes to the AinDrive copy of the deploy files, which do
   not exist on GitHub `main`:
   - `ainize.json`: set `"STATE_BACKEND": "ain-store"`, add the secret `AIN_STORE_CONFIG_B64`, and
     add the Store's host to `allowedHosts`.
   - `deploy/ainize-entrypoint.sh`: add
     `materialize AIN_STORE_CONFIG_B64 AIN_STORE_CONFIG ain-store-state.json`.
   - `Dockerfile.ainize`: add `COPY vendor ./vendor` after `COPY --chmod=644 package*.json ./` in
     **both** stages, so the optional SDK is installed.

   Redeploy by pushing to AinDrive `main`. Keep `AIN_STATE_CONFIG_B64` until the cleanup is done.

5. **Check the ainspace flows.**
   - **Chat.** Open an existing thread in ainspace: `GET /api/threads/:id` and
     `/api/threads/:id/messages` return the migrated history. Post a message and check that the
     agents answer. Create a new thread, redeploy, and check that it is still there.
   - **Reports.** Check that `GET /api/reports` lists the migrated jobs and that an old report
     opens. Create a report with `POST /api/reports`, check that it completes, and check that the
     `report:ainmem:pending` set drains (Ainmem publication).
   - **Ingest.** Make a dual-write from ainspace (`POST /api/ingest/conversation`) and check that
     it is acknowledged and readable.

   **Rollback** until step 6: set `STATE_BACKEND=ain-blockchain` and redeploy. The chain records are
   intact, but they lack anything written since step 3. A later rollback would first need the Store's records copied back to
   chain, and this PR has no tool for that.

6. **Clean up the chain.** Do this only after several days on the Store with no problems. First
   run a read-only plan:

   ```sh
   AIN_STATE_CONFIG=/private/blockchain-state.json npm run state:cleanup -- plan --report /private/state-verification.json
   ```

   Then execute:

   ```sh
   AIN_STATE_CONFIG=/private/blockchain-state.json npm run state:cleanup -- execute --report /private/state-verification.json --confirm uncommon_gallery_orchestrator
   ```

   The cleanup refuses to run in any of these cases:
   - the report is missing, failed, or names another root;
   - any record changed after verification (head fingerprint).

   When it runs, it first installs delete-only rules on `state/heads/$recordId` and
   `state/chunks/$recordId/$revision/$index`. That freezes the old state, and the
   `ain-blockchain` backend then refuses to start. It then deletes every chunk and head in batches
   of at most 50 operations.

   Deletes on chain have one limit. Before `ain_store` activation, a delete is accepted only while
   the app is within the free-tier budget. After activation, deletes are always accepted. If a
   batch is rejected, the run stops with that hint. Run it again (optionally with `--max-ops N`) and
   it continues with what is left.

7. **Confirm the footprint.** Run:

   ```sh
   AIN_STATE_CONFIG=/private/blockchain-state.json npm run state:cleanup -- usage
   ```

   `usage.tree_bytes` for the app should be under 1 MB. What remains is `store/mmr`, `store/state`,
   the collection rules and functions, `state_metadata`, and the old state rules. Then remove
   `AIN_STATE_CONFIG_B64` from the project.
