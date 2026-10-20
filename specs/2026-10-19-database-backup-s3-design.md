# Database Backups to S3 Design

## Overview

Scheduled `pg_dump` backups used to land only on the same disk as the server: every path in
`DatabaseBackupService` was built from `StorageCore.getBaseFolder(StorageFolder.Backups)` and written with raw
`StorageRepository` file IO. A host failure took the library and every backup with it, which defeats the point of
having them.

This makes the backups folder **backend-addressable**. `DatabaseBackupService` stops doing its own file IO and
works through the `StorageBackend` interface the fork already uses for media, so the destination is configuration
rather than a hardcoded path. On top of that abstraction sits a staged write: dump to disk → on success upload to
S3 → on success delete the local copy.

The feature is offered only when the server's storage backend is already S3 (`IMMICH_STORAGE_BACKEND=s3`), with an
enable/disable flag in Admin → System Settings → Backup that is absent otherwise. Because an S3 backend is already
constructed and credentialed when it applies, the feature reuses the existing `IMMICH_S3_*` bucket, credentials,
region and endpoint: no new environment variables, no secrets in the database, and nothing new that
`GET /admin/config` would hand back in the clear (it redacts nothing today —
`notifications.smtp.transport.password` and `oauth.clientSecret` both come back as stored). The admin is left with
the two things that are genuinely a choice: on/off, and where in the bucket the dumps land.

## Decisions

- **The destination is a `StorageBackend`, not a post-hoc uploader.** A second service that uploaded finished
  backups after the fact would have left every other operation — retention, listing, restore, download, delete —
  still disk-only, and restore-from-S3 would have had to be deferred. Going through the interface makes all of them
  backend-aware at once. The owner rejected the post-hoc-uploader shape explicitly.
- **Staged, in this order:** dump to the staging disk, upload, then delete the local copy. Streaming `pg_dump`
  straight at S3 would hold a multipart upload open for the length of the dump; staging keeps the dump local and
  fast, then moves a finished file. The failure semantics fall out of the ordering and are the main reason to
  prefer it (section 3).
- **Gated on the env storage backend being S3.** That gate is what keeps the feature small: it is the reason no
  credentials, region or endpoint belong in the saved config. Letting backups go to S3 while media stays on disk is
  out of scope, and lifting the gate is what would bring back a bucket/region/endpoint/credentials block of its own.
- **Two config fields only:** `backup.database.s3 = { enabled, prefix }`. An earlier draft allowed a separate
  bucket, on the grounds that backups want their own lifecycle rules and access policy. The owner removed it: the
  gate already guarantees the server is credentialed for exactly one bucket, so a second bucket field is a way to
  configure a destination the server cannot necessarily write to, and the failure would only surface at backup
  time. Lifecycle rules can be scoped to the prefix instead.
- **The prefix is therefore required and may not be empty.** It is the only thing separating dumps from the media
  key space, and an empty prefix would also make every listing (retention, the backup list, restore) enumerate the
  entire media bucket. `ConfigValidate` rejects a blank prefix while the flag is on, and the resolver independently
  falls back to `DEFAULT_BACKUP_PREFIX` for any config that predates the guard or arrives through
  `IMMICH_CONFIG_FILE`.
- **Off by default** (`enabled: false`), so a fresh install behaves exactly like upstream Immich.
- **Two independent key spaces.** The staging key is `backups/<filename>`, which `DiskStorageBackend` resolves under
  the media location; the remote key is `<prefix><filename>`. One shared key would have put the admin's prefix
  under a `backups/` folder that only means anything on disk, or required prefix support inside
  `S3StorageBackend`, which media does not need.
- **`list(prefix)` is the only addition to `StorageBackend`.** `rename` is added to `DiskStorageBackend` alone,
  because S3 has no move — only a copy-then-delete that is neither atomic nor cheap for a multi-gigabyte object —
  and the single caller only ever moves a file on the staging disk.
- **The cross-field rule lives in `ConfigValidate`, not in a `superRefine`.** The config schemas feed
  `createZodDto` and OpenAPI generation (see `server/src/utils/config.ts`), which a refinement would not survive.
- **`downloadBackup` returns an `ImmichMediaResponse`, not a `ServeStrategy`.** `sendFile` already dispatches the
  three cases, and both call sites (`database-backup.controller.ts` and `maintenance-worker.controller.ts`) go
  through it, so converting in the service leaves both controllers untouched instead of duplicating the dispatch.

## 1. The abstraction

`DatabaseBackupService` takes its storage from a fork-owned resolver rather than touching the filesystem:

```ts
// server/src/gallery/utils/backup-store.ts
export interface BackupStore {
  staging: DiskStorageBackend; // always the disk backend — where pg_dump writes
  stagingKey: (filename: string) => string; // `backups/<filename>`
  remote?: {
    // present only when the gate below is satisfied
    backend: StorageBackend;
    bucket: string;
    key: (filename: string) => string; // `<prefix><filename>`
  };
}
```

`staging` is typed as the concrete `DiskStorageBackend` rather than the interface, because the local-only promote
needs its disk-only `rename`.

`BackupStoreResolver.resolve()` reads the saved config fresh on every call, so an admin edit applies without
restarting the server. Only the S3 client is cached, keyed on bucket, region, endpoint, access key id and prefix,
and rebuilt when any of those change. It is a Nest provider (registered in `galleryServices`) rather than a static,
so the backup service can be given a stub and the client is owned by something with a lifecycle.

**The gate.** `remote` is set only when all of: the env storage backend is `s3`, `backup.database.s3.enabled` is
on, and `IMMICH_S3_BUCKET` is set. The S3 backend is built from `envData.storage.s3` verbatim — nothing about the
destination comes from the saved config except the prefix. A failed gate degrades to local-only with a warning
logged once per distinct misconfiguration, so an admin who sets `IMMICH_STORAGE_BACKEND` back to disk still gets
backups instead of none.

## 2. What each operation became

Keys are relative throughout. Today's absolute paths always resolved to disk, because `isDiskPath` is
`isAbsolute`; relative keys are what make one call site work against either backend.

| Operation                | Behaviour                                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createDatabaseBackup`   | Pipes `pg_dump \| gzip` into `staging.put(<key>.tmp)`, promotes with `staging.rename`, then uploads and deletes the local copy. A `restore-point-` prefixed backup is never uploaded.                     |
| `promoteToRemote`        | The shared staged promote: `staging.get` streamed into `remote.backend.put`, then `staging.delete`. Also used by `uploadBackup` and by the straggler retry in cleanup.                                    |
| `uploadBackup`           | Admin-supplied file, same staged path through the shared helper.                                                                                                                                          |
| `listBackups`            | Unions `remote.backend.list()` with `staging.list()`, deduplicated by filename, so a partial outage still shows one coherent set. Local is read last and wins, because it is the copy an admin can fetch. |
| `cleanupDatabaseBackups` | Retries stragglers, prunes the canonical set to `keepLastAmount`, and always sweeps the staging disk for `.tmp` files (section 4).                                                                        |
| `downloadBackup`         | Resolves the backup, asks that backend for a serve strategy, and converts it to the matching `ImmichMediaResponse`.                                                                                       |
| `restoreDatabaseBackup`  | Reads through `backend.get`, so **restore-from-S3 comes free**. The rollback restore point is always read from the staging disk.                                                                          |
| `deleteBackup`           | Deletes from both backends; `delete` is a no-op on a missing disk file, so attempting both is safe.                                                                                                       |

`locate(filename)` is local-first, then remote: a backup whose upload failed is still on disk and must stay
downloadable and restorable from there, while everything else exists only in the bucket. Neither place holding it
is a `NotFoundException`.

**The `.tmp` promote still matters.** `isValidDatabaseBackupName` excludes `.tmp` and `isFailedDatabaseBackupName`
matches it, so a dump killed half way can never be listed or restored as a valid backup. With a remote configured
the upload only ever runs on the promoted file, so no `.tmp` key ever reaches S3.

## 3. Failure semantics

| Step fails                       | Result                                                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `pg_dump` / `gzip`               | Unchanged from before: the `.tmp` key is deleted, nothing is promoted, the job fails.                                                       |
| S3 upload                        | **The local file is kept.** The job fails and the error names the bucket and key. Nothing is lost, and the next run promotes the straggler. |
| Local delete after a good upload | Warned, job still succeeds — the object is safely in S3, and the straggler is swept by the next cleanup.                                    |

So a broken bucket or an expired credential degrades to the old local-only behaviour rather than losing backups.

The dump pipeline is wired so the backend owns the destination: `pipeline(pgdump, gzip, passthrough)` runs
alongside `staging.put(key, passthrough)`, with the pipeline's own rejection captured and rethrown after the put
settles. A `pg_dump` failure destroys the passthrough, which surfaces as the put rejecting, and the captured error
is the one reported.

## 4. Retention with two backends

Retention applies to whichever backend holds the canonical set — S3 when the gate is satisfied, the staging disk
otherwise. Pruning the staging disk while S3 is on would delete a straggler the next run could still promote.

Cleanup therefore does three things, in order:

1. **Retry stragglers.** Each local routine backup is promoted if the bucket does not have it, or deleted locally
   if it does (it is then just a duplicate).
2. **Prune the canonical set** to `keepLastAmount`, newest first.
3. **Sweep the staging disk** for `.tmp` files, which only ever exist locally.

`restore-point-*` files are untouched, as before: they match neither the routine nor the failed-backup pattern, and
they are the restore flow's own local safety net.

## 5. Gating the UI

There was no client-side signal for "the server is running on S3", so one feature flag was added, following
`peopleStatistics` (itself fork-added) through the same files: `s3Storage` on `ServerFeaturesSchema`
(`server/src/dtos/server.dto.ts`), set from `envData.storage.backend === 's3'` in `ServerService.getFeatures()`.
`config.repository.ts` needed no change.

The web wraps the whole S3 group in `{#if featureFlagsManager.value.s3Storage}`, so the section is absent rather
than disabled when it cannot apply (`AuthSettings.svelte` is the in-repo precedent for `{#if}`-hiding a dependent
config group). Bucket and prefix are additionally disabled while the toggle is off, and the existing
`SettingButtonsRow keys={['backup']}` already covers saving.

Server-side the `ConfigValidate` handler rejects a save that enables S3 backups while the storage backend is not
S3, or with a blank prefix, so the API cannot be used to reach a state the UI will not show. `DatabaseBackupService` holds the handler but
delegates to `validateBackupS3Config` in the fork namespace, keeping the upstream file to one call into a fork
module.

## 6. Layering

New fork code is in `server/src/gallery/utils/backup-store.ts` and
`server/src/gallery/dtos/config.dto.ts`. The upstream files carry seams, not new logic:

- `storage-backend.interface.ts`, `disk-storage.backend.ts`, `s3-storage.backend.ts` — one new interface method and
  its two implementations, plus the disk-only `rename`. These three are already fork-owned under
  `storage-and-media`.
- `src/dtos/config.dto.ts` — one spread of the fork schema into `backup.database` and one spread of the defaults.
- `src/dtos/server.dto.ts`, `src/services/server.service.ts` — one feature flag each.
- `src/services/database-backup.service.ts` — the substantive edit, and the one upstream file whose diff against
  the tag grows materially. It is the price of the owner's decision: the alternative was leaving the service
  disk-only and bolting an uploader beside it.
- `src/app.module.ts` — one provider line, because `MaintenanceModule` lists its providers explicitly rather than
  spreading `services`. A spec in `backup-store.spec.ts` fails for any future non-optional dependency of
  `DatabaseBackupService` that is missing there, since nothing else would catch it before the restore flow failed
  to boot.
- `web/src/routes/admin/system-settings/BackupSettings.svelte` — one `{#if}` group inside the existing section.

Measured against the `v3.3.3` tag, the upstream files this touches go from +337/-9 to +691/-77 lines. Two of them
were byte-identical to upstream before: `database-backup.service.ts` (now +254/-67) and `BackupSettings.svelte`
(now +35/-1). The service is where the whole change lives, so that is the cost being paid; the rest are one or two
lines each.

No database migration, no new dependency (`@aws-sdk/client-s3`, `@aws-sdk/lib-storage` and
`@aws-sdk/s3-request-presigner` are already server dependencies), and no fork table, so
`scripts/revert-to-immich.sql` is unaffected: turning the toggle off, or reverting to Immich, leaves backups
local-only with nothing to clean up. The only trace in the database is the `backup.database.s3` block in the saved
system config, which a stock Immich server's config schema strips as an unknown key.

`AdminConfigDatabaseBackupDto.s3` and `ServerFeaturesDto.s3Storage` are newly required fields on DTOs the mobile
client deserializes, so both have backward-compatibility defaults in `mobile/lib/utils/openapi_patching.dart`,
which is what lets an older app talk to a newer server.

## 7. Out of scope

- Wiring the declared-but-unused `NotificationType.BackupFailed` so a failed upload emails the admin, instead of
  only surfacing as a failed job.
- A "Test connection" button. `POST /admin/test-email` is the precedent, but endpoint plus UI is its own slice.
  `specs/s3-startup-health-check.md` plans a `HeadBucket` check that is not yet implemented and would be the
  natural place to share that code.
- Letting backups go to S3 while media stays on disk.
