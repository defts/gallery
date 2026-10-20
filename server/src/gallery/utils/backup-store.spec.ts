import { beforeEach, describe, expect, it } from 'vitest';
import { DiskStorageBackend } from 'src/backends/disk-storage.backend.js';
import { S3StorageConfig } from 'src/backends/s3-storage.backend.js';
import { SystemConfig, defaults } from 'src/dtos/config.dto.js';
import { BackupStoreResolver, normalizeBackupPrefix, validateBackupS3Config } from 'src/gallery/utils/backup-store.js';
import { StorageBackend } from 'src/interfaces/storage-backend.interface.js';
import { mockEnvData } from 'test/repositories/config.repository.mock.js';
import { ServiceMocks, getMocks } from 'test/utils.js';

/** Overrides the one seam that would otherwise build a real S3 client. */
class TestBackupStoreResolver extends BackupStoreResolver {
  readonly built: S3StorageConfig[] = [];

  constructor(...args: ConstructorParameters<typeof BackupStoreResolver>) {
    super(...args);
    this.createS3Backend = (config) => {
      this.built.push(config);
      return { id: `s3:${config.bucket}` } as unknown as StorageBackend;
    };
  }
}

describe('BackupStoreResolver', () => {
  let sut: TestBackupStoreResolver;
  let mocks: ServiceMocks;

  const withS3Config = (s3: { enabled?: boolean; bucket?: string; prefix?: string }) =>
    mocks.systemMetadata.get.mockResolvedValue({ backup: { database: { s3 } } });

  beforeEach(() => {
    mocks = getMocks();
    sut = new TestBackupStoreResolver(
      mocks.config,
      mocks.storage as never,
      mocks.systemMetadata as never,
      mocks.logger as never,
    );
  });

  it('always resolves a disk staging backend, keyed under the backups folder', async () => {
    const store = await sut.resolve();

    expect(store.staging).toBeInstanceOf(DiskStorageBackend);
    expect(store.stagingKey('immich-db-backup-1.sql.gz')).toBe('backups/immich-db-backup-1.sql.gz');
  });

  describe('the gate', () => {
    it('leaves the remote unset by default (upstream behaviour out of the box)', async () => {
      const store = await sut.resolve();

      expect(defaults.backup.database.s3.enabled).toBe(false);
      expect(store.remote).toBeUndefined();
    });

    it('leaves the remote unset when the storage backend is not s3, and warns', async () => {
      withS3Config({ enabled: true, bucket: 'db-backups' });
      mocks.config.getEnv.mockReturnValue(mockEnvData({ storage: { backend: 'disk' } }));

      const store = await sut.resolve();

      expect(store.remote).toBeUndefined();
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('storage backend is not S3'));
    });

    it('leaves the remote unset when no bucket is resolvable, and warns', async () => {
      withS3Config({ enabled: true, bucket: '' });
      mocks.config.getEnv.mockReturnValue(mockEnvData({ storage: { backend: 's3', s3: { bucket: '' } as never } }));

      const store = await sut.resolve();

      expect(store.remote).toBeUndefined();
      expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('no bucket is set'));
    });

    it('warns only once while the same misconfiguration persists', async () => {
      withS3Config({ enabled: true, bucket: 'db-backups' });
      mocks.config.getEnv.mockReturnValue(mockEnvData({ storage: { backend: 'disk' } }));

      await sut.resolve();
      await sut.resolve();
      await sut.resolve();

      expect(mocks.logger.warn).toHaveBeenCalledTimes(1);
    });

    it('resolves a remote when the backend is s3, the flag is on and a bucket is set', async () => {
      withS3Config({ enabled: true, bucket: 'db-backups', prefix: 'nightly/' });
      mocks.config.getEnv.mockReturnValue(mockEnvData({ storage: { backend: 's3' } }));

      const store = await sut.resolve();

      expect(store.remote?.bucket).toBe('db-backups');
      expect(store.remote?.key('immich-db-backup-1.sql.gz')).toBe('nightly/immich-db-backup-1.sql.gz');
    });
  });

  describe('credential reuse', () => {
    it('builds the S3 client from the media credentials with only the bucket substituted', async () => {
      withS3Config({ enabled: true, bucket: 'db-backups' });
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({
          storage: {
            backend: 's3',
            s3: {
              bucket: 'media',
              region: 'eu-central-1',
              endpoint: 'http://minio:9000',
              accessKeyId: 'key',
              secretAccessKey: 'secret',
              presignedUrlExpiry: 900,
              serveMode: 'proxy',
            },
          },
        }),
      );

      await sut.resolve();

      expect(sut.built).toEqual([
        {
          bucket: 'db-backups',
          region: 'eu-central-1',
          endpoint: 'http://minio:9000',
          accessKeyId: 'key',
          secretAccessKey: 'secret',
          presignedUrlExpiry: 900,
          serveMode: 'proxy',
        },
      ]);
    });

    it('falls back to the media bucket when the backup bucket is empty', async () => {
      withS3Config({ enabled: true, bucket: '' });
      mocks.config.getEnv.mockReturnValue(
        mockEnvData({ storage: { backend: 's3', s3: { bucket: 'media' } as never } }),
      );

      const store = await sut.resolve();

      expect(store.remote?.bucket).toBe('media');
    });
  });

  describe('client caching', () => {
    beforeEach(() => {
      mocks.config.getEnv.mockReturnValue(mockEnvData({ storage: { backend: 's3' } }));
    });

    it('reuses the client across resolves while the settings are unchanged', async () => {
      withS3Config({ enabled: true, bucket: 'db-backups' });

      const first = await sut.resolve();
      const second = await sut.resolve();

      expect(sut.built).toHaveLength(1);
      expect(second.remote?.backend).toBe(first.remote?.backend);
    });

    it('rebuilds the client when the resolved settings change', async () => {
      withS3Config({ enabled: true, bucket: 'db-backups' });
      await sut.resolve();

      withS3Config({ enabled: true, bucket: 'other-bucket' });
      const store = await sut.resolve();

      expect(sut.built.map(({ bucket }) => bucket)).toEqual(['db-backups', 'other-bucket']);
      expect(store.remote?.bucket).toBe('other-bucket');
    });

    it('reads the config fresh on every resolve, so an admin edit applies without a restart', async () => {
      withS3Config({ enabled: false, bucket: 'db-backups' });
      const offStore = await sut.resolve();
      expect(offStore.remote).toBeUndefined();

      withS3Config({ enabled: true, bucket: 'db-backups' });
      const onStore = await sut.resolve();
      expect(onStore.remote?.bucket).toBe('db-backups');
    });
  });
});

describe('normalizeBackupPrefix', () => {
  it.each`
    input                  | expected
    ${'immich-db-backups'} | ${'immich-db-backups/'}
    ${'immich/db/'}        | ${'immich/db/'}
    ${'/leading'}          | ${'leading/'}
    ${''}                  | ${''}
    ${' '.repeat(3)}       | ${''}
  `('normalizes $input to $expected', ({ input, expected }) => {
    expect(normalizeBackupPrefix(input)).toBe(expected);
  });
});

const configWith = (enabled: boolean) =>
  ({
    backup: { database: { ...defaults.backup.database, s3: { enabled, bucket: '', prefix: '' } } },
  }) as SystemConfig;

describe('validateBackupS3Config', () => {
  it('refuses to enable S3 backups while the storage backend is disk', () => {
    expect(() => validateBackupS3Config(configWith(true), { storage: { backend: 'disk' } })).toThrow(
      /S3 storage backend/,
    );
  });

  it('allows enabling S3 backups on the s3 storage backend', () => {
    expect(() => validateBackupS3Config(configWith(true), { storage: { backend: 's3' } })).not.toThrow();
  });

  it('allows a disk-backed server to leave S3 backups off', () => {
    expect(() => validateBackupS3Config(configWith(false), { storage: { backend: 'disk' } })).not.toThrow();
  });
});
