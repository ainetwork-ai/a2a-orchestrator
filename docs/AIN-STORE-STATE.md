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
- **Privacy.** All four collections are private:
  - On chain, a write record carries only the record id and the body hash. The record id is
    `HMAC(hmacKey, "ain-store:v1:<app>:<collection>:<id>")`, the domain-separated `privateId` form.
  - The body goes to AinDrive, with a random `__salt` and AES-256-GCM encryption at rest.
  - The read rule is `none`, so only the service token can read. A document the caller can't read
    answers 404, like a missing one.
- **Writes.** Each write is signed by the orchestrator's writer key through the SDK's
  `privateKeySigner`.
  - The collection rule is `compileServiceOnlyRule({ serviceAddress: <writer>, checkShape: true })`
    (`stateCollectionWriteRule`), so only that address can write.
  - The client sends `prepare → check → sign → submit`. The SDK lists the four collections in
    `privateCollections` with the HMAC key. It refuses to sign unless the Store prepared exactly the
    expected record ids, ops, bases and body hashes, and it builds the transaction itself.
  - It then waits until the write is applied in chain order, matching the status by (tx hash, key).
    This is the same acknowledgement guarantee the chain adapter gave.
- **Deletes.** A deleted document keeps a tombstone version, and the next create uses that version
  as its base. The adapter reads the tombstone version and handles this.
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

### SDK calls this depends on (`@ainize/store` 0.1.0 at ain-store `84af1b3`)

- `createStore({ url, app, getToken, signer, writeTimeoutMs, privateCollections: { <c>: { hmacKey } } })`.
- `privateKeySigner(hex, chainId)`.
- `collection(name).doc(id).get()`, `.set(data, { ifVersion })` and `.delete({ ifVersion })`.
- `collection(name).limit(n).startAfter(cursor).get()`, giving `{ docs, nextCursor }`.
- `batch().set(ref, data, { ifVersion }).commit()`.
- The error names `ConflictError` and `RuleRejectedError`.
- From `@ainize/store-core`: `compileServiceOnlyRule(...)` (the SDK doesn't re-export it) and
  `storeAppendFunctionConfig()`, both used by `setup-ops`. The tests also use `privateId(...)`.

The adapter doesn't use these:
- `verify()`, which now needs a chain reader.
- AIN-Session credentials, which are now request-bound. The orchestrator authenticates with the
  Store's service bearer token instead.

The SDK is not on npm yet. `vendor/` holds tarballs packed from ain-store `main` at `84af1b3`,
listed as **optional** dependencies:

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
  "hmacKey": "<the Store's AIN_STORE_STATE_HMAC_KEY: the SDK computes the exact private ids with it>",
  "writeTimeoutMs": 120000
}
```

On ainize, store this file as the secret `AIN_STORE_CONFIG_B64`.

The Store side of this project is `deploy/ain-store/store.config.json`:
- **Database:** managed Postgres through `DATABASE_URL`.
- **Chain:** mainnet, `activationBlock` 1586503, `startBlock` 1587800. That was a recent block on
  2026-11-01, before any `_storeAppend` exists under the app. If the functions are installed much
  later, any block before the install also works.
- **Storage:** an AinDrive OAuth grant.
- **Collections:** four private ones, sharing one HMAC key and one encryption key.

Before deploying, fill in `storage.driveId` and `storage.oauth.clientId`. You can optionally add the
orchestrator's writer address to `chain.trustedSigners`.

Keep encrypted copies of every key in Ain Vault.

## Tests

```sh
npm ci && npm run build
# The AIN Store suites need a built ain-store checkout (dev mode: in-process chain + filesystem drive).
AIN_STORE_REPO=/path/to/ain-store node --test dist/storage/*.test.js
```

- `state-client-contract.test.ts` runs the same `StateClient` contract against `AinStateStore`
  and against a real Store service in dev mode. In dev mode the chain evaluates the compiled
  `compileServiceOnlyRule` and mirrors the `_storeAppend` function tree. The file also covers:
  - privacy: no plain key or value on chain, nothing on chain except `store/mmr`, and no plaintext
    on the drive;
  - the domain-separated `privateId`, and the SDK refusing a write under a wrong HMAC key;
  - the writer-only rule;
  - the one-transaction pipeline;
  - the expiry sweep.
- `migrate-to-store.test.ts` covers the dry run, resume after failure, idempotent rerun,
  verification (count plus a hash per key), catching up and pruning, tamper detection, and a chain
  write during verification.
- `cleanup-chain-state.test.ts` covers refusal without a passing, current report, the read-only
  plan, freezing writes, batched deletes, and resume after a rejected batch.

Without `AIN_STORE_REPO`, the Store suites are skipped.

## Cutover runbook

Run each step only after the previous one succeeds. Nothing in this PR deploys, deletes or sends
a mainnet transaction by itself.

0. **Prerequisite.** The chain's `ain_store` timer flag must be active, because the Store relies on
   `_storeAppend`. On mainnet it activates at block **1586503**. The head was 1587804 on 2026-11-01.

1. **Deploy the Store for this project on ainize.** The Store keeps no state in its read-only
   container; everything lives in the organization's managed Postgres.
   1. **Create the org store.** Use the Storage tab, or
      `POST /api/orgs/<org>/stores { "name": "uncommon_gallery_orchestrator-store", "kind": "postgres" }`.
      Wait for `ready`.
   2. **Create the Store's ainize project** from `ain-store`, with its `ainize.json` and
      `Dockerfile`. Add `deploy/ain-store/store.config.json` as its `store.config.json`.
   3. **Connect the store to the project.** Use the Storage tab, or
      `POST /api/stores/<sid>/attachments { "projectId": "<Store project>", "binding": "db" }`.
      The container then gets `DATABASE_URL`. The `release` command (`ain-store migrate`) creates
      the schema on each deploy.
   4. **Set up the AinDrive credential** (one AinDrive account per project):
      1. Create a dedicated AinDrive account, for example `store-uncommon@…`, with **editor**
         access on `<org drive>/store/uncommon_gallery_orchestrator` only.
      2. Register an OAuth client (`POST https://aindrive.ainetwork.ai/api/oauth/register`) and
         put its `client_id` in `storage.oauth.clientId`.
      3. Signed in as that account, authorize `drives:read drives:write` with no `resource`
         parameter, then exchange the code for tokens. The ain-store README has the exact requests.
      4. Store the `refresh_token` as the secret `AINDRIVE_REFRESH_TOKEN` and use it nowhere else.
         Reusing a rotated refresh token revokes the grant. The Store moves it into Postgres and
         rotates it from then on.
   5. **Set the project secrets** (`PUT /api/projects/<id>/secrets/<name>`):
      - `AIN_STORE_SERVICE_KEY`: the Store service account key, which signs `/store/state`.
      - `AIN_STORE_SERVICE_TOKEN`: the bearer token the orchestrator uses.
      - `AIN_STORE_STATE_HMAC_KEY`: the private record ids. The orchestrator's `hmacKey` has the
        same value.
      - `AIN_STORE_STATE_ENCRYPT_KEY`: body encryption at rest. To rotate it, set a new key and list
        the old variable in `previousEncryptKeyEnvs`.
      - `AIN_STORE_TOKEN_KEY`: encrypts the stored AinDrive tokens.
      - `AINDRIVE_REFRESH_TOKEN`.
      - Optionally, `AIN_STORE_ALERT_WEBHOOK_URL`.
   6. **Push to AinDrive** so ainize builds and deploys it. Readiness is `/healthz`.
   7. **Print the app-owner operations** and review them:

      ```sh
      AIN_STORE_CONFIG=/private/ain-store-state.json npm run state:migrate -- setup-ops --store-service-address 0x<Store service account, checksummed>
      ```

      This prints, for each of `threads`, `messages`, `reports` and `meta`:
      - a `SET_RULE` with `compileServiceOnlyRule` for the writer address;
      - a `SET_FUNCTION` that installs `_storeAppend`.

      It also prints the writer rule of `/apps/<app>/store/state` for the Store service account.
   8. **Have the app owner sign and send those operations.** The block they land in must come after
      `startBlock`.
   9. **Check the Store.** `/healthz` should answer 200 with `ready: true` (it answers 503 under an
      alert), and `/v1/status` (with the service token) should show it following the chain.

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
