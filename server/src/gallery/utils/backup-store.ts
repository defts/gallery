import { Injectable } from '@nestjs/common';
import { DiskStorageBackend } from 'src/backends/disk-storage.backend.js';
import { S3StorageBackend, S3StorageConfig } from 'src/backends/s3-storage.backend.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import { StorageFolder } from 'src/enum.js';
import { StorageBackend } from 'src/interfaces/storage-backend.interface.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { getConfig } from 'src/utils/config.js';

/**
 * Where a database backup lives.
 *
 * `staging` is always the disk backend: `pg_dump` writes there, and a backup that fails to reach S3
 * stays there rather than being lost. It is typed as the concrete `DiskStorageBackend` (not the
 * `StorageBackend` interface) because the local-only promote needs its disk-only `rename`.
 *
 * `remote` is present only when the gate in {@link BackupStoreResolver.resolve} is satisfied. Its
 * keys live in their own key space — `<prefix><filename>` rather than the staging `backups/<filename>`
 * — so the admin's prefix lands at the top of the bucket instead of nested under a `backups/` folder
 * that only means something on disk.
 */
export interface BackupStore {
  staging: DiskStorageBackend;
  stagingKey: (filename: string) => string;
  remote?: {
    backend: StorageBackend;
    bucket: string;
    key: (filename: string) => string;
  };
}

/**
 * Where dumps go when the admin leaves the prefix blank. Since the bucket is always the media bucket,
 * an empty prefix would put dumps at its root and make every listing enumerate the whole media bucket,
 * so the prefix is never allowed to be empty in practice.
 */
export const DEFAULT_BACKUP_PREFIX = 'immich-db-backups/';

/** Trailing slash normalised so `<prefix><filename>` is always a well-formed key. */
export const normalizeBackupPrefix = (prefix: string): string => {
  // trim first, then strip leading slashes: the other order leaves a padded '  /db' as '/db/', and an
  // S3 key starting with '/' creates an unnamed top-level folder rather than the one the admin typed
  const trimmed = prefix.trim().replace(/^\/+/, '');
  if (!trimmed) {
    return '';
  }
  return trimmed.endsWith('/') ? trimmed : `${trimmed}/`;
};

/**
 * Cross-field rule for the `ConfigValidate` event. It cannot be a `superRefine` on the config schema:
 * those schemas feed `createZodDto` and OpenAPI generation (see src/utils/config.ts), which a refinement
 * would not survive. Without this an admin could reach a state over the API that the UI never offers,
 * because the UI hides the whole group when the storage backend is not S3.
 */
export const validateBackupS3Config = (newConfig: SystemConfig, env: { storage: { backend: 'disk' | 's3' } }): void => {
  const { enabled, prefix } = newConfig.backup.database.s3;
  if (!enabled) {
    return;
  }

  if (env.storage.backend !== 's3') {
    throw new Error(
      'Database backups can only be uploaded to S3 while the server is running on the S3 storage backend. Set IMMICH_STORAGE_BACKEND=s3 first, or leave this off.',
    );
  }

  // Backups share the media bucket, so the prefix is the only thing keeping them out of the media key
  // space. An empty one would also make every backup listing enumerate the entire bucket.
  if (!normalizeBackupPrefix(prefix)) {
    throw new Error('A key prefix is required for database backups to S3, so they stay separate from your media.');
  }
};

/**
 * Resolves where the next database backup goes. `resolve()` reads the config fresh on every call, so an
 * admin edit applies without restarting the server; only the S3 client is cached, and it is rebuilt
 * when the resolved settings change.
 *
 * A provider rather than a static, so the backup service can be given a stub, and so the S3 client is
 * owned by something with a lifecycle rather than by module scope.
 */
@Injectable()
export class BackupStoreResolver {
  private cached?: { signature: string; backend: StorageBackend };
  private warned?: string;
  /** Overridden in tests so no real S3 client is built. */
  protected createS3Backend: (config: S3StorageConfig) => StorageBackend = (config) => new S3StorageBackend(config);

  constructor(
    private readonly configRepository: ConfigRepository,
    private readonly storageRepository: StorageRepository,
    private readonly systemMetadataRepository: SystemMetadataRepository,
    private readonly logger: LoggingRepository,
  ) {}

  async resolve(): Promise<BackupStore> {
    const staging = new DiskStorageBackend(StorageCore.getMediaLocation(), this.storageRepository);
    const stagingFolder = StorageFolder.Backups;
    const store: BackupStore = {
      staging,
      stagingKey: (filename: string) => `${stagingFolder}/${filename}`,
    };

    const config = await getConfig(
      {
        configRepo: this.configRepository,
        metadataRepo: this.systemMetadataRepository,
        logger: this.logger,
      },
      { withCache: false },
    );
    const s3Settings = config.backup.database.s3;
    if (!s3Settings.enabled) {
      return store;
    }

    // Degrade to local-only rather than failing the backup: an admin who sets IMMICH_STORAGE_BACKEND
    // back to disk should still get backups, and the ConfigValidate guard already stops this state
    // being reached by a save.
    const env = this.configRepository.getEnv();
    if (env.storage.backend !== 's3') {
      this.warnOnce(
        'local-backend',
        'Database backups are configured to upload to S3, but the server storage backend is not S3. Keeping backups on local disk only.',
      );
      return store;
    }

    // The same bucket media is written to: the gate guarantees an S3 media backend, so this is the
    // only bucket the server is credentialed for. `prefix` is what separates the dumps from the media.
    const bucket = env.storage.s3.bucket;
    if (!bucket) {
      this.warnOnce(
        'no-bucket',
        'Database backups are configured to upload to S3, but IMMICH_S3_BUCKET is not set. Keeping backups on local disk only.',
      );
      return store;
    }

    // Defence in depth with the ConfigValidate guard above: a config written before that guard existed,
    // or by an IMMICH_CONFIG_FILE that bypasses it, must still not target the bucket root.
    const prefix = normalizeBackupPrefix(s3Settings.prefix) || DEFAULT_BACKUP_PREFIX;
    const backendConfig: S3StorageConfig = env.storage.s3;
    store.remote = {
      backend: this.getRemoteBackend(backendConfig, prefix),
      bucket,
      key: (filename: string) => `${prefix}${filename}`,
    };
    this.warned = undefined;

    return store;
  }

  private getRemoteBackend(config: S3StorageConfig, prefix: string): StorageBackend {
    // `accessKeyId` is part of the identity of the client, so a rotated credential rebuilds it; the
    // secret is not included, since a signature is a cache key and nothing more.
    const signature = JSON.stringify([config.bucket, config.region, config.endpoint, config.accessKeyId, prefix]);
    if (this.cached?.signature !== signature) {
      this.cached = { signature, backend: this.createS3Backend(config) };
      this.logger.log(`Database backups will be uploaded to S3 (bucket: ${config.bucket}, prefix: ${prefix})`);
    }
    return this.cached.backend;
  }

  /** The backup job runs on a cron, so an unchanged misconfiguration must not fill the log. */
  private warnOnce(reason: string, message: string) {
    if (this.warned === reason) {
      return;
    }
    this.warned = reason;
    this.logger.warn(message);
  }
}
