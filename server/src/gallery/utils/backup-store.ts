import { DiskStorageBackend } from 'src/backends/disk-storage.backend.js';
import { S3StorageBackend, S3StorageConfig } from 'src/backends/s3-storage.backend.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import { StorageFolder } from 'src/enum.js';
import { StorageBackend } from 'src/interfaces/storage-backend.interface.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';

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

type BackupStoreDependencies = {
  configRepository: ConfigRepository;
  storageRepository: StorageRepository;
  logger: LoggingRepository;
  getConfig: () => Promise<SystemConfig>;
  /** Seam for tests: production builds a real `S3StorageBackend`. */
  createS3Backend?: (config: S3StorageConfig) => StorageBackend;
};

/** Trailing slash normalised so `<prefix><filename>` is always a well-formed key. */
export const normalizeBackupPrefix = (prefix: string): string => {
  const trimmed = prefix.replace(/^\/+/, '').trim();
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
export const validateBackupS3Config = (
  newConfig: SystemConfig,
  env: { storage: { backend: 'disk' | 's3' } },
): void => {
  if (newConfig.backup.database.s3.enabled && env.storage.backend !== 's3') {
    throw new Error(
      'Database backups can only be uploaded to S3 while the server is running on the S3 storage backend. Set IMMICH_STORAGE_BACKEND=s3 first, or leave this off.',
    );
  }
};

/**
 * Plain class, not an `@Injectable` (the `BackendMediaServer` precedent): built once in
 * `DatabaseBackupService`'s constructor from deps it already has. `resolve()` reads the config fresh
 * on every call so an admin edit applies without restarting the server; the S3 client itself is cached
 * and only rebuilt when the resolved settings change.
 */
export class BackupStoreResolver {
  private cached?: { signature: string; backend: StorageBackend };
  private warned?: string;

  constructor(private deps: BackupStoreDependencies) {}

  async resolve(): Promise<BackupStore> {
    const staging = new DiskStorageBackend(StorageCore.getMediaLocation(), this.deps.storageRepository);
    const stagingFolder = StorageFolder.Backups;
    const store: BackupStore = {
      staging,
      stagingKey: (filename: string) => `${stagingFolder}/${filename}`,
    };

    const config = await this.deps.getConfig();
    const s3Settings = config.backup.database.s3;
    if (!s3Settings.enabled) {
      return store;
    }

    // Degrade to local-only rather than failing the backup: an admin who sets IMMICH_STORAGE_BACKEND
    // back to disk should still get backups, and the ConfigValidate guard already stops this state
    // being reached by a save.
    const env = this.deps.configRepository.getEnv();
    if (env.storage.backend !== 's3') {
      this.warnOnce(
        'local-backend',
        'Database backups are configured to upload to S3, but the server storage backend is not S3. Keeping backups on local disk only.',
      );
      return store;
    }

    const bucket = s3Settings.bucket || env.storage.s3.bucket;
    if (!bucket) {
      this.warnOnce(
        'no-bucket',
        'Database backups are configured to upload to S3, but no bucket is set (neither in the backup settings nor IMMICH_S3_BUCKET). Keeping backups on local disk only.',
      );
      return store;
    }

    const prefix = normalizeBackupPrefix(s3Settings.prefix);
    const backendConfig: S3StorageConfig = { ...env.storage.s3, bucket };
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
      const createS3Backend = this.deps.createS3Backend ?? ((c: S3StorageConfig) => new S3StorageBackend(c));
      this.cached = { signature, backend: createS3Backend(config) };
      this.deps.logger.log(`Database backups will be uploaded to S3 (bucket: ${config.bucket}, prefix: ${prefix})`);
    }
    return this.cached.backend;
  }

  /** The backup job runs on a cron, so an unchanged misconfiguration must not fill the log. */
  private warnOnce(reason: string, message: string) {
    if (this.warned === reason) {
      return;
    }
    this.warned = reason;
    this.deps.logger.warn(message);
  }
}
