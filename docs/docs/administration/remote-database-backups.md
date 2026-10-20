# Remote Database Backups

By default, Gallery's [automatic database backups](/administration/backup-and-restore#automatic-database-backups) are written to `UPLOAD_LOCATION/backups`, on the same disk as the server. If that host dies, the library and every backup of it go together.

When Gallery is already running on the [S3-compatible storage backend](/features/s3-storage), it can upload each scheduled backup to object storage instead and keep nothing on local disk.

:::info
This option only appears when the server is started with `IMMICH_STORAGE_BACKEND=s3`. It reuses that backend's credentials, region and endpoint, so there is nothing new to configure and no new secret stored in the database. On a disk-backed server the whole section is hidden, and the API refuses to enable it.
:::

## Turning it on

1. Go to **Administration > Settings > Backup Settings**.
2. Turn on **Upload backups to S3**.
3. Optionally set a **Backup bucket**. Leave it empty to use the same bucket as your media (`IMMICH_S3_BUCKET`). A separate bucket is worth considering if you want backups to have their own lifecycle rules, retention or access policy.
4. Optionally set a **Backup key prefix** — the folder inside the bucket that backup objects are written to. The default is `immich-db-backups/`.
5. Save.

The next scheduled or manual backup is uploaded. From then on, **Administration > Settings > Backup Settings** and the restore picker list the backups in your bucket.

## How a backup reaches the bucket

Each backup is written in stages:

1. `pg_dump` writes a compressed dump to `UPLOAD_LOCATION/backups`, under a temporary name.
2. The finished file is given its real name, so a dump interrupted half way can never be mistaken for a usable backup.
3. The file is uploaded to the bucket.
4. The local copy is deleted.

This ordering is what makes the failure cases safe:

| What goes wrong        | What happens                                                                                                                                     |
| :--------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------- |
| The dump itself fails  | The temporary file is removed and the job fails, exactly as it does without S3.                                                                  |
| The upload fails       | **The backup stays on local disk** and the job fails with the bucket named in the error. Nothing is lost, and the next run retries the upload.   |
| The local delete fails | A warning is logged and the job still succeeds — the backup is safely in the bucket, and the leftover file is cleaned up on the next backup run. |

So a wrong bucket name or an expired key leaves you with exactly the local-only behaviour you had before, not with no backups at all.

## Retention, downloads and restores

- **Retention** (`Keep last amount`) applies to the objects in your bucket. Any local file left behind by a failed upload is retried rather than counted or pruned.
- **The backup list** merges both places, so during an outage you still see one coherent set.
- **Downloading** a backup serves it from wherever it is. With `IMMICH_S3_SERVE_MODE=redirect` (the default) your browser is redirected to a short-lived presigned URL; in `proxy` mode the server streams it to you.
- **Restoring** reads straight from the bucket, so a backup that has already been uploaded can be restored without downloading it first. The automatic restore point Gallery takes before a restore is always kept on local disk, since it exists to recover a restore that goes wrong.
- **Uploading** a backup through the admin UI follows the same staged path and ends up in the bucket.

## Turning it off

Turn the toggle off and save. The next backup stays on local disk, and retention goes back to pruning the local folder. Objects already in the bucket are left alone — delete them yourself if you no longer want them.

:::caution
Database backups contain metadata only, never photos or videos. They must be paired with a copy of the files in `UPLOAD_LOCATION`, as described in [Backup and Restore](/administration/backup-and-restore). Putting the dumps in the same bucket as your media does not back the media up.
:::
