import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DateTime } from 'luxon';
import { Duplex, PassThrough, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { SystemConfig, defaults } from 'src/dtos/config.dto.js';
import { ImmichWorker, JobStatus } from 'src/enum.js';
import { BackupStore } from 'src/gallery/utils/backup-store.js';
import { MaintenanceHealthRepository } from 'src/maintenance/maintenance-health.repository.js';
import { DatabaseBackupService } from 'src/services/database-backup.service.js';
import { systemConfigStub } from 'test/fixtures/system-config.stub.js';
import { AutoMocked, ServiceMocks, automock, getMocks, mockDuplex, mockSpawn } from 'test/utils.js';

/**
 * Every backup file operation now goes through a storage backend, so these are the seams the service
 * is asserted against. `put` drains its source: the dump pipeline only completes once something has
 * consumed the gzip output, exactly as a real backend does.
 */
const fakeBackend = () => ({
  put: vitest.fn(async (_key: string, source: Readable | Buffer) => {
    if (!Buffer.isBuffer(source)) {
      await buffer(source);
    }
  }),
  get: vitest.fn((_key: string) => Promise.resolve({ stream: Readable.from(mockData()) })),
  delete: vitest.fn((_key: string) => Promise.resolve()),
  exists: vitest.fn((_key: string) => Promise.resolve(true)),
  list: vitest.fn((_prefix: string) => Promise.resolve([] as Array<{ key: string; size: number }>)),
  rename: vitest.fn((_from: string, _to: string) => Promise.resolve()),
  getServeStrategy: vitest.fn((key: string) => Promise.resolve({ type: 'file' as const, path: `/data/${key}` })),
});

type FakeBackend = ReturnType<typeof fakeBackend>;

const listingUnder =
  (prefix: string) =>
  (...filenames: string[]) =>
    filenames.map((filename) => ({ key: `${prefix}${filename}`, size: 1 }));

const configWithS3 = (enabled: boolean) =>
  ({
    backup: { database: { ...defaults.backup.database, s3: { enabled, prefix: 'immich-db-backups/' } } },
  }) as SystemConfig;

describe(DatabaseBackupService.name, () => {
  let sut: DatabaseBackupService;
  let mocks: ServiceMocks;
  let maintenanceHealthRepositoryMock: AutoMocked<MaintenanceHealthRepository>;
  let staging: FakeBackend;
  let remote: FakeBackend;
  let store: BackupStore;
  let resolver: { resolve: () => Promise<BackupStore> };

  /** Turns the remote on for a test, as a configured S3 bucket would. */
  const enableRemote = () => {
    store.remote = { backend: remote as never, bucket: 'db-backups', key: (filename) => `nightly/${filename}` };
  };

  beforeEach(() => {
    mocks = getMocks();
    staging = fakeBackend();
    remote = fakeBackend();
    store = { staging: staging as never, stagingKey: (filename) => `backups/${filename}` };
    resolver = { resolve: () => Promise.resolve(store) };
    maintenanceHealthRepositoryMock = automock(MaintenanceHealthRepository, {
      args: [mocks.logger],
      strict: false,
    });
    sut = new DatabaseBackupService(
      mocks.logger as never,
      mocks.storage as never,
      mocks.config,
      mocks.systemMetadata as never,
      mocks.process,
      mocks.database as never,
      mocks.user as never,
      mocks.cron as never,
      mocks.job as never,
      maintenanceHealthRepositoryMock as never,
      resolver as never,
    );
  });

  it('should work', () => {
    expect(sut).toBeDefined();
  });

  describe('onBootstrapEvent', () => {
    it('should init cron job and handle config changes', async () => {
      mocks.database.tryLock.mockResolvedValue(true);
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: systemConfigStub.backupEnabled as SystemConfig });

      expect(mocks.cron.create).toHaveBeenCalled();
    });

    it('should not initialize backup database cron job when lock is taken', async () => {
      mocks.database.tryLock.mockResolvedValue(false);

      await sut.onConfigInit({ newConfig: systemConfigStub.backupEnabled as SystemConfig });

      expect(mocks.cron.create).not.toHaveBeenCalled();
    });

    it('should not initialise backup database job when running on microservices', async () => {
      mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);
      await sut.onConfigInit({ newConfig: systemConfigStub.backupEnabled as SystemConfig });

      expect(mocks.cron.create).not.toHaveBeenCalled();
    });
  });

  describe('onConfigUpdateEvent', () => {
    beforeEach(async () => {
      mocks.database.tryLock.mockResolvedValue(true);
      mocks.cron.create.mockResolvedValue();

      await sut.onConfigInit({ newConfig: defaults });
    });

    it('should update cron job if backup is enabled', () => {
      mocks.cron.update.mockResolvedValue();

      sut.onConfigUpdate({
        oldConfig: defaults,
        newConfig: {
          backup: {
            database: {
              enabled: true,
              cronExpression: '0 1 * * *',
            },
          },
        } as SystemConfig,
      });

      expect(mocks.cron.update).toHaveBeenCalledWith({ name: 'backupDatabase', expression: '0 1 * * *', start: true });
      expect(mocks.cron.update).toHaveBeenCalled();
    });

    it('should do nothing if instance does not have the backup database lock', async () => {
      mocks.database.tryLock.mockResolvedValue(false);
      await sut.onConfigInit({ newConfig: defaults });
      sut.onConfigUpdate({ newConfig: systemConfigStub.backupEnabled as SystemConfig, oldConfig: defaults });
      expect(mocks.cron.update).not.toHaveBeenCalled();
    });
  });

  describe('cleanupDatabaseBackups', () => {
    const listing = listingUnder('backups/');
    const remoteListing = listingUnder('nightly/');

    beforeEach(() => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.backupEnabled);
    });

    it('should do nothing if not reached keepLastAmount', async () => {
      staging.list.mockResolvedValue(listing('immich-db-backup-1.sql.gz'));
      await sut.cleanupDatabaseBackups();
      expect(staging.delete).not.toHaveBeenCalled();
    });

    it('should remove failed backup files', async () => {
      staging.list.mockResolvedValue(
        listing(
          'immich-db-backup-123.sql.gz.tmp',
          `immich-db-backup-${DateTime.fromISO('2025-07-25T11:02:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg14.5.sql.gz.tmp`,
          `immich-db-backup-${DateTime.fromISO('2025-07-27T11:01:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg14.5.sql.gz`,
          `immich-db-backup-${DateTime.fromISO('2025-07-29T11:01:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg14.5.sql.gz.tmp`,
        ),
      );
      await sut.cleanupDatabaseBackups();
      expect(staging.delete).toHaveBeenCalledTimes(3);
      expect(staging.delete).toHaveBeenCalledWith('backups/immich-db-backup-123.sql.gz.tmp');
      expect(staging.delete).toHaveBeenCalledWith(
        'backups/immich-db-backup-20250725T110216-v1.234.5-pg14.5.sql.gz.tmp',
      );
      expect(staging.delete).toHaveBeenCalledWith(
        'backups/immich-db-backup-20250729T110116-v1.234.5-pg14.5.sql.gz.tmp',
      );
    });

    it('should remove old backup files over keepLastAmount', async () => {
      staging.list.mockResolvedValue(listing('immich-db-backup-1.sql.gz', 'immich-db-backup-2.sql.gz'));
      await sut.cleanupDatabaseBackups();
      expect(staging.delete).toHaveBeenCalledTimes(1);
      expect(staging.delete).toHaveBeenCalledWith('backups/immich-db-backup-1.sql.gz');
    });

    it('should remove old backup files over keepLastAmount and failed backups', async () => {
      staging.list.mockResolvedValue(
        listing(
          `immich-db-backup-${DateTime.fromISO('2025-07-25T11:02:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg14.5.sql.gz.tmp`,
          `immich-db-backup-${DateTime.fromISO('2025-07-27T11:01:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg14.5.sql.gz`,
          'immich-db-backup-1753789649000.sql.gz',
          `immich-db-backup-${DateTime.fromISO('2025-07-29T11:01:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg14.5.sql.gz`,
        ),
      );
      await sut.cleanupDatabaseBackups();
      expect(staging.delete).toHaveBeenCalledTimes(3);
      expect(staging.delete).toHaveBeenCalledWith('backups/immich-db-backup-1753789649000.sql.gz');
      expect(staging.delete).toHaveBeenCalledWith(
        'backups/immich-db-backup-20250725T110216-v1.234.5-pg14.5.sql.gz.tmp',
      );
      expect(staging.delete).toHaveBeenCalledWith('backups/immich-db-backup-20250727T110116-v1.234.5-pg14.5.sql.gz');
    });

    describe('with S3 enabled', () => {
      beforeEach(() => {
        enableRemote();
      });

      it('should prune the S3 objects over keepLastAmount, not the local folder', async () => {
        staging.list.mockResolvedValue([]);
        remote.list.mockResolvedValue(remoteListing('immich-db-backup-1.sql.gz', 'immich-db-backup-2.sql.gz'));

        await sut.cleanupDatabaseBackups();

        expect(remote.delete).toHaveBeenCalledTimes(1);
        expect(remote.delete).toHaveBeenCalledWith('nightly/immich-db-backup-1.sql.gz');
      });

      it('should promote a straggler left by a failed upload rather than orphaning it', async () => {
        staging.list.mockResolvedValue(listing('immich-db-backup-1.sql.gz'));
        remote.list.mockResolvedValue([]);

        await sut.cleanupDatabaseBackups();

        expect(remote.put).toHaveBeenCalledWith('nightly/immich-db-backup-1.sql.gz', expect.anything(), {
          contentType: 'application/gzip',
        });
        expect(staging.delete).toHaveBeenCalledWith('backups/immich-db-backup-1.sql.gz');
      });

      it('should delete a local copy that is already in the bucket without re-uploading it', async () => {
        staging.list.mockResolvedValue(listing('immich-db-backup-1.sql.gz'));
        remote.list.mockResolvedValue(remoteListing('immich-db-backup-1.sql.gz'));

        await sut.cleanupDatabaseBackups();

        expect(remote.put).not.toHaveBeenCalled();
        expect(staging.delete).toHaveBeenCalledWith('backups/immich-db-backup-1.sql.gz');
      });

      it('should still sweep local .tmp files, which only ever exist on the staging disk', async () => {
        staging.list.mockResolvedValue(listing('immich-db-backup-123.sql.gz.tmp'));
        remote.list.mockResolvedValue([]);

        await sut.cleanupDatabaseBackups();

        expect(remote.put).not.toHaveBeenCalled();
        expect(staging.delete).toHaveBeenCalledWith('backups/immich-db-backup-123.sql.gz.tmp');
      });

      it('should leave a restore point alone: it is local by design and never promoted', async () => {
        staging.list.mockResolvedValue(listing('restore-point-immich-db-backup-1.sql.gz'));
        remote.list.mockResolvedValue([]);

        await sut.cleanupDatabaseBackups();

        expect(remote.put).not.toHaveBeenCalled();
        expect(staging.delete).not.toHaveBeenCalled();
      });
    });
  });

  describe('handleBackupDatabase / createDatabaseBackup', () => {
    beforeEach(() => {
      mocks.process.spawn.mockReturnValue(mockSpawn(0, 'data', ''));
      mocks.process.spawnDuplexStream.mockImplementation(() => mockDuplex()('command', 0, 'data', ''));
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.backupEnabled);
    });

    it('should sanitize DB_URL (remove uselibpqcompat) before calling pg_dumpall', async () => {
      // create a service instance with a URL connection that includes libpqcompat
      const dbUrl = 'postgresql://postgres:pwd@host:5432/immich?sslmode=require&uselibpqcompat=true';
      const configMock = {
        getEnv: () => ({ database: { config: { connectionType: 'url', url: dbUrl }, skipMigrations: false } }),
        getWorker: () => ImmichWorker.Api,
        isDev: () => false,
      } as unknown as any;

      sut = new DatabaseBackupService(
        mocks.logger as never,
        mocks.storage as never,
        configMock as never,
        mocks.systemMetadata as never,
        mocks.process,
        mocks.database as never,
        mocks.user as never,
        mocks.cron as never,
        mocks.job as never,
        void 0 as never,
        resolver as never,
      );

      mocks.process.spawnDuplexStream.mockImplementation(() => mockDuplex()('command', 0, 'data', ''));
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.backupEnabled);
      mocks.database.getPostgresVersion.mockResolvedValue('14.10');

      await sut.handleBackupDatabase();

      expect(mocks.process.spawnDuplexStream).toHaveBeenCalled();
      const call = mocks.process.spawnDuplexStream.mock.calls[0];
      const args = call[1] as string[];
      expect(args).toMatchInlineSnapshot(`
        [
          "postgresql://postgres:pwd@host:5432/immich?sslmode=require",
          "--clean",
          "--if-exists",
        ]
      `);
    });

    it('should run a database backup successfully', async () => {
      const result = await sut.handleBackupDatabase();
      expect(result).toBe(JobStatus.Success);
      expect(staging.put).toHaveBeenCalledWith(
        expect.stringMatching(/^backups\/immich-db-backup-.*\.sql\.gz\.tmp$/),
        expect.anything(),
        { contentType: 'application/gzip' },
      );
    });

    it('should promote the .tmp file to its real name on success', async () => {
      const result = await sut.handleBackupDatabase();
      expect(result).toBe(JobStatus.Success);
      expect(staging.rename).toHaveBeenCalledWith(
        expect.stringMatching(/\.sql\.gz\.tmp$/),
        expect.stringMatching(/\.sql\.gz$/),
      );
    });

    it('should not upload anything when no remote is configured', async () => {
      await sut.handleBackupDatabase();
      expect(remote.put).not.toHaveBeenCalled();
      expect(staging.delete).not.toHaveBeenCalled();
    });

    it('should fail if pg_dump fails', async () => {
      mocks.process.spawnDuplexStream.mockReturnValueOnce(mockDuplex()('pg_dump', 1, '', 'error'));
      await expect(sut.handleBackupDatabase()).rejects.toThrow('pg_dump non-zero exit code (1)');
    });

    it('should not promote the file if pgdump fails and gzip succeeds', async () => {
      mocks.process.spawnDuplexStream.mockReturnValueOnce(mockDuplex()('pg_dump', 1, '', 'error'));
      await expect(sut.handleBackupDatabase()).rejects.toThrow('pg_dump non-zero exit code (1)');
      expect(staging.rename).not.toHaveBeenCalled();
    });

    it('should fail if gzip fails', async () => {
      mocks.process.spawnDuplexStream.mockReturnValueOnce(mockDuplex()('pg_dump', 0, 'data', ''));
      mocks.process.spawnDuplexStream.mockReturnValueOnce(mockDuplex()('gzip', 1, '', 'error'));
      await expect(sut.handleBackupDatabase()).rejects.toThrow('gzip non-zero exit code (1)');
    });

    it('should fail if the staging write fails', async () => {
      staging.put.mockRejectedValue(new Error('error'));
      await expect(sut.handleBackupDatabase()).rejects.toThrow('error');
    });

    it('should destroy the spawned processes if the staging write fails', async () => {
      const spawned: Duplex[] = [];
      mocks.process.spawnDuplexStream.mockImplementation(() => {
        const duplex = mockDuplex()('command', 0, 'data', '');
        spawned.push(duplex);
        return duplex;
      });
      staging.put.mockRejectedValue(new Error('ENOENT: no such file or directory'));

      await expect(sut.handleBackupDatabase()).rejects.toThrow('ENOENT');

      expect(spawned).toHaveLength(2);
      for (const stream of spawned) {
        expect(stream.destroyed).toBe(true);
      }
    });

    it('should fail if the promote fails', async () => {
      staging.rename.mockRejectedValue(new Error('error'));
      await expect(sut.handleBackupDatabase()).rejects.toThrow('error');
    });

    it('should delete the .tmp file when the dump fails', async () => {
      mocks.process.spawnDuplexStream.mockReturnValueOnce(mockDuplex()('pg_dump', 1, '', 'error'));
      await expect(sut.handleBackupDatabase()).rejects.toThrow('pg_dump non-zero exit code (1)');
      expect(staging.delete).toHaveBeenCalledWith(expect.stringMatching(/\.sql\.gz\.tmp$/));
    });

    it('should ignore the .tmp delete failing and still surface the dump error', async () => {
      mocks.process.spawnDuplexStream.mockReturnValueOnce(mockDuplex()('pg_dump', 1, '', 'error'));
      staging.delete.mockRejectedValue(new Error('error'));
      await expect(sut.handleBackupDatabase()).rejects.toThrow('pg_dump non-zero exit code (1)');
      expect(staging.delete).toHaveBeenCalled();
    });

    describe('the staged promote to S3', () => {
      beforeEach(() => {
        enableRemote();
        staging.list.mockResolvedValue([]);
        remote.list.mockResolvedValue([]);
      });

      it('should upload the finished backup and then delete the local copy', async () => {
        const result = await sut.handleBackupDatabase();

        expect(result).toBe(JobStatus.Success);
        const [backupKey] = staging.rename.mock.calls[0].slice(1);
        const filename = backupKey.replace('backups/', '');
        expect(remote.put).toHaveBeenCalledWith(`nightly/${filename}`, expect.anything(), {
          contentType: 'application/gzip',
        });
        expect(staging.delete).toHaveBeenCalledWith(backupKey);
      });

      it('should only upload after the dump is complete, never a .tmp key', async () => {
        await sut.handleBackupDatabase();

        for (const [key] of remote.put.mock.calls) {
          expect(key).not.toContain('.tmp');
        }
      });

      it('should keep the local file and fail the job when the upload fails, naming the bucket', async () => {
        remote.put.mockRejectedValue(new Error('NoSuchBucket'));

        await expect(sut.handleBackupDatabase()).rejects.toThrow(/db-backups/);

        const [, backupKey] = staging.rename.mock.calls[0];
        expect(staging.delete).not.toHaveBeenCalledWith(backupKey);
      });

      it('should still succeed when the local delete fails after a good upload', async () => {
        staging.delete.mockRejectedValue(new Error('EBUSY'));

        await expect(sut.handleBackupDatabase()).resolves.toBe(JobStatus.Success);
        expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining('failed to delete the local copy'));
      });

      it('should keep a restore point local, because the restore flow needs it on disk', async () => {
        await sut.createDatabaseBackup('restore-point-');

        expect(remote.put).not.toHaveBeenCalled();
        expect(staging.delete).not.toHaveBeenCalled();
      });
    });

    it.each`
      postgresVersion                       | expectedVersion
      ${'14.10'}                            | ${14}
      ${'14.10.3'}                          | ${14}
      ${'14.10 (Debian 14.10-1.pgdg120+1)'} | ${14}
      ${'15.3.3'}                           | ${15}
      ${'16.4.2'}                           | ${16}
      ${'17.15.1'}                          | ${17}
      ${'18.0.0'}                           | ${18}
    `(
      `should use pg_dump $expectedVersion with postgres version $postgresVersion`,
      async ({ postgresVersion, expectedVersion }) => {
        mocks.database.getPostgresVersion.mockResolvedValue(postgresVersion);
        await sut.handleBackupDatabase();
        expect(mocks.process.spawnDuplexStream).toHaveBeenCalledWith(
          `/usr/lib/postgresql/${expectedVersion}/bin/pg_dump`,
          expect.any(Array),
          expect.any(Object),
        );
      },
    );
    it.each`
      postgresVersion
      ${'13.99.99'}
      ${'19.0.0'}
    `(`should fail if postgres version $postgresVersion is not supported`, async ({ postgresVersion }) => {
      mocks.database.getPostgresVersion.mockResolvedValue(postgresVersion);
      const result = await sut.handleBackupDatabase();
      expect(mocks.process.spawn).not.toHaveBeenCalled();
      expect(result).toBe(JobStatus.Failed);
    });
  });

  describe('buildPostgresLaunchArguments', () => {
    describe('default config', () => {
      it('should generate pg_dump arguments', async () => {
        await expect(sut.buildPostgresLaunchArguments('pg_dump')).resolves.toMatchInlineSnapshot(`
        {
          "args": [
            "--username",
            "postgres",
            "--host",
            "database",
            "--port",
            "5432",
            "immich",
            "--clean",
            "--if-exists",
          ],
          "bin": "/usr/lib/postgresql/14/bin/pg_dump",
          "databaseMajorVersion": 14,
          "databasePassword": "postgres",
          "databaseUsername": "postgres",
          "databaseVersion": "14.10 (Debian 14.10-1.pgdg120+1)",
        }
      `);
      });

      it('should generate psql arguments', async () => {
        await expect(sut.buildPostgresLaunchArguments('psql')).resolves.toMatchInlineSnapshot(`
        {
          "args": [
            "--username",
            "postgres",
            "--host",
            "database",
            "--port",
            "5432",
            "--dbname",
            "immich",
            "--echo-all",
            "--output=/dev/null",
          ],
          "bin": "/usr/lib/postgresql/14/bin/psql",
          "databaseMajorVersion": 14,
          "databasePassword": "postgres",
          "databaseUsername": "postgres",
          "databaseVersion": "14.10 (Debian 14.10-1.pgdg120+1)",
        }
      `);
      });

      it('should generate psql (single transaction) arguments', async () => {
        await expect(sut.buildPostgresLaunchArguments('psql', { singleTransaction: true })).resolves
          .toMatchInlineSnapshot(`
        {
          "args": [
            "--username",
            "postgres",
            "--host",
            "database",
            "--port",
            "5432",
            "--dbname",
            "immich",
            "--single-transaction",
            "--set",
            "ON_ERROR_STOP=on",
            "--echo-all",
            "--output=/dev/null",
          ],
          "bin": "/usr/lib/postgresql/14/bin/psql",
          "databaseMajorVersion": 14,
          "databasePassword": "postgres",
          "databaseUsername": "postgres",
          "databaseVersion": "14.10 (Debian 14.10-1.pgdg120+1)",
        }
      `);
      });
    });

    describe('using custom parts', () => {
      beforeEach(() => {
        const configMock = {
          getEnv: () => ({
            database: {
              config: {
                connectionType: 'parts',
                host: 'myhost',
                port: 1234,
                username: 'mypg',
                password: 'mypwd',
                database: 'myimmich',
              },
              skipMigrations: false,
            },
          }),
          getWorker: () => ImmichWorker.Api,
          isDev: () => false,
        } as unknown as any;

        sut = new DatabaseBackupService(
          mocks.logger as never,
          mocks.storage as never,
          configMock as never,
          mocks.systemMetadata as never,
          mocks.process,
          mocks.database as never,
          mocks.user as never,
          mocks.cron as never,
          mocks.job as never,
          void 0 as never,
          resolver as never,
        );
      });

      it('should generate pg_dump arguments', async () => {
        await expect(sut.buildPostgresLaunchArguments('pg_dump')).resolves.toMatchInlineSnapshot(`
          {
            "args": [
              "--username",
              "mypg",
              "--host",
              "myhost",
              "--port",
              "1234",
              "myimmich",
              "--clean",
              "--if-exists",
            ],
            "bin": "/usr/lib/postgresql/14/bin/pg_dump",
            "databaseMajorVersion": 14,
            "databasePassword": "mypwd",
            "databaseUsername": "mypg",
            "databaseVersion": "14.10 (Debian 14.10-1.pgdg120+1)",
          }
        `);
      });

      it('should generate psql (single transaction) arguments', async () => {
        await expect(sut.buildPostgresLaunchArguments('psql', { singleTransaction: true })).resolves
          .toMatchInlineSnapshot(`
          {
            "args": [
              "--username",
              "mypg",
              "--host",
              "myhost",
              "--port",
              "1234",
              "--dbname",
              "myimmich",
              "--single-transaction",
              "--set",
              "ON_ERROR_STOP=on",
              "--echo-all",
              "--output=/dev/null",
            ],
            "bin": "/usr/lib/postgresql/14/bin/psql",
            "databaseMajorVersion": 14,
            "databasePassword": "mypwd",
            "databaseUsername": "mypg",
            "databaseVersion": "14.10 (Debian 14.10-1.pgdg120+1)",
          }
        `);
      });
    });

    describe('using URL', () => {
      beforeEach(() => {
        const dbUrl = 'postgresql://mypg:mypwd@myhost:1234/myimmich?sslmode=require&uselibpqcompat=true';
        const configMock = {
          getEnv: () => ({ database: { config: { connectionType: 'url', url: dbUrl }, skipMigrations: false } }),
          getWorker: () => ImmichWorker.Api,
          isDev: () => false,
        } as unknown as any;

        sut = new DatabaseBackupService(
          mocks.logger as never,
          mocks.storage as never,
          configMock as never,
          mocks.systemMetadata as never,
          mocks.process,
          mocks.database as never,
          mocks.user as never,
          mocks.cron as never,
          mocks.job as never,
          void 0 as never,
          resolver as never,
        );
      });

      it('should generate pg_dump arguments', async () => {
        await expect(sut.buildPostgresLaunchArguments('pg_dump')).resolves.toMatchInlineSnapshot(`
          {
            "args": [
              "postgresql://mypg:mypwd@myhost:1234/myimmich?sslmode=require",
              "--clean",
              "--if-exists",
            ],
            "bin": "/usr/lib/postgresql/14/bin/pg_dump",
            "databaseMajorVersion": 14,
            "databasePassword": "mypwd",
            "databaseUsername": "mypg",
            "databaseVersion": "14.10 (Debian 14.10-1.pgdg120+1)",
          }
        `);
      });

      it('should generate psql (single transaction) arguments', async () => {
        await expect(sut.buildPostgresLaunchArguments('psql', { singleTransaction: true })).resolves
          .toMatchInlineSnapshot(`
          {
            "args": [
              "--dbname",
              "postgresql://mypg:mypwd@myhost:1234/myimmich?sslmode=require",
              "--single-transaction",
              "--set",
              "ON_ERROR_STOP=on",
              "--echo-all",
              "--output=/dev/null",
            ],
            "bin": "/usr/lib/postgresql/14/bin/psql",
            "databaseMajorVersion": 14,
            "databasePassword": "mypwd",
            "databaseUsername": "mypg",
            "databaseVersion": "14.10 (Debian 14.10-1.pgdg120+1)",
          }
        `);
      });
    });

    describe('using bad URL', () => {
      beforeEach(() => {
        const dbUrl = 'post://gresql://mypg:myp@wd@myhos:t:1234/myimmich?sslmode=require&uselibpqcompat=true';
        const configMock = {
          getEnv: () => ({ database: { config: { connectionType: 'url', url: dbUrl }, skipMigrations: false } }),
          getWorker: () => ImmichWorker.Api,
          isDev: () => false,
        } as unknown as any;

        sut = new DatabaseBackupService(
          mocks.logger as never,
          mocks.storage as never,
          configMock as never,
          mocks.systemMetadata as never,
          mocks.process,
          mocks.database as never,
          mocks.user as never,
          mocks.cron as never,
          mocks.job as never,
          void 0 as never,
          resolver as never,
        );
      });

      it('should fallback to reasonable defaults', async () => {
        await expect(sut.buildPostgresLaunchArguments('psql')).resolves.toMatchInlineSnapshot(`
          {
            "args": [
              "--dbname",
              "post://gresql//mypg:myp@wd@myhos:t:1234/myimmich?sslmode=require",
              "--echo-all",
              "--output=/dev/null",
            ],
            "bin": "/usr/lib/postgresql/14/bin/psql",
            "databaseMajorVersion": 14,
            "databasePassword": "",
            "databaseUsername": "postgres",
            "databaseVersion": "14.10 (Debian 14.10-1.pgdg120+1)",
          }
        `);
      });
    });

    describe('using an unparsable URL', () => {
      beforeEach(() => {
        // unix domain socket URLs cannot be parsed by `new URL`
        const dbUrl = 'socket://mypg:mypwd@/var/run/postgresql?db=myimmich';
        const configMock = {
          getEnv: () => ({ database: { config: { connectionType: 'url', url: dbUrl }, skipMigrations: false } }),
          getWorker: () => ImmichWorker.Api,
          isDev: () => false,
        } as unknown as any;

        sut = new DatabaseBackupService(
          mocks.logger as never,
          mocks.storage as never,
          configMock as never,
          mocks.systemMetadata as never,
          mocks.process,
          mocks.database as never,
          mocks.user as never,
          mocks.cron as never,
          mocks.job as never,
          void 0 as never,
          resolver as never,
        );
      });

      it('should fallback to reasonable defaults', async () => {
        await expect(sut.buildPostgresLaunchArguments('pg_dump')).resolves.toMatchInlineSnapshot(`
          {
            "args": [
              "socket://mypg:mypwd@/var/run/postgresql?db=myimmich",
              "--clean",
              "--if-exists",
            ],
            "bin": "/usr/lib/postgresql/14/bin/pg_dump",
            "databaseMajorVersion": 14,
            "databasePassword": "",
            "databaseUsername": "postgres",
            "databaseVersion": "14.10 (Debian 14.10-1.pgdg120+1)",
          }
        `);
      });
    });
  });

  describe('uploadBackup', () => {
    it('should reject invalid file names', async () => {
      await expect(sut.uploadBackup({ originalname: 'invalid backup' } as never)).rejects.toThrowError(
        new BadRequestException('Invalid backup name!'),
      );
    });

    it('should write file', async () => {
      await sut.uploadBackup({ originalname: 'path.sql.gz', buffer: 'buffer' } as never);
      expect(staging.put).toBeCalledWith('backups/uploaded-path.sql.gz', 'buffer', {
        contentType: 'application/gzip',
      });
    });

    it('should promote an uploaded backup to S3 like any other', async () => {
      enableRemote();
      await sut.uploadBackup({ originalname: 'path.sql.gz', buffer: 'buffer' } as never);
      expect(remote.put).toBeCalledWith('nightly/uploaded-path.sql.gz', expect.anything(), {
        contentType: 'application/gzip',
      });
      expect(staging.delete).toBeCalledWith('backups/uploaded-path.sql.gz');
    });
  });

  describe('downloadBackup', () => {
    it('should reject invalid file names', async () => {
      await expect(sut.downloadBackup('invalid backup')).rejects.toThrowError(
        new BadRequestException('Invalid backup name!'),
      );
    });

    it('should serve a local backup as a file response', async () => {
      await expect(sut.downloadBackup('hello.sql.gz')).resolves.toEqual(
        expect.objectContaining({ path: '/data/backups/hello.sql.gz', contentType: 'application/gzip' }),
      );
    });

    it('should serve an uncompressed backup as plain sql', async () => {
      await expect(sut.downloadBackup('hello.sql')).resolves.toEqual(
        expect.objectContaining({ contentType: 'application/sql' }),
      );
    });

    it('should serve from S3 once the local copy has been promoted away', async () => {
      enableRemote();
      staging.exists.mockResolvedValue(false);
      remote.getServeStrategy.mockResolvedValue({ type: 'redirect', url: 'https://s3/presigned' } as never);

      await expect(sut.downloadBackup('hello.sql.gz')).resolves.toEqual(
        expect.objectContaining({ url: 'https://s3/presigned' }),
      );
      expect(remote.getServeStrategy).toHaveBeenCalledWith('nightly/hello.sql.gz', expect.anything());
    });

    it('should relay a proxied S3 read as a stream response', async () => {
      enableRemote();
      staging.exists.mockResolvedValue(false);
      const stream = Readable.from(['payload']);
      remote.getServeStrategy.mockResolvedValue({ type: 'stream', stream, length: 7 } as never);

      await expect(sut.downloadBackup('hello.sql.gz')).resolves.toEqual(expect.objectContaining({ stream, length: 7 }));
    });

    it('should prefer the local copy of a backup that is in both places', async () => {
      enableRemote();

      await sut.downloadBackup('hello.sql.gz');

      expect(staging.getServeStrategy).toHaveBeenCalled();
      expect(remote.getServeStrategy).not.toHaveBeenCalled();
    });

    it('should 404 a backup that is in neither place', async () => {
      enableRemote();
      staging.exists.mockResolvedValue(false);
      remote.exists.mockResolvedValue(false);

      await expect(sut.downloadBackup('hello.sql.gz')).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listBackups', () => {
    it('should give us all backups', async () => {
      staging.list.mockResolvedValue([
        {
          key: `backups/immich-db-backup-${DateTime.fromISO('2025-07-25T11:02:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg14.5.sql.gz.tmp`,
          size: 1024,
        },
        {
          key: `backups/immich-db-backup-${DateTime.fromISO('2025-07-27T11:01:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg14.5.sql.gz`,
          size: 1024,
        },
        { key: 'backups/immich-db-backup-1753789649000.sql.gz', size: 1024 },
        {
          key: `backups/immich-db-backup-${DateTime.fromISO('2025-07-29T11:01:16Z').toFormat("yyyyLLdd'T'HHmmss")}-v1.234.5-pg14.5.sql.gz`,
          size: 1024,
        },
      ]);

      await expect(sut.listBackups()).resolves.toMatchObject({
        backups: [
          { filename: 'immich-db-backup-20250729T110116-v1.234.5-pg14.5.sql.gz', filesize: 1024 },
          { filename: 'immich-db-backup-20250727T110116-v1.234.5-pg14.5.sql.gz', filesize: 1024 },
          { filename: 'immich-db-backup-1753789649000.sql.gz', filesize: 1024 },
        ],
      });
    });

    it('should union both backends, deduplicated by filename', async () => {
      enableRemote();
      remote.list.mockResolvedValue([
        { key: 'nightly/immich-db-backup-1.sql.gz', size: 10 },
        { key: 'nightly/immich-db-backup-2.sql.gz', size: 20 },
      ]);
      staging.list.mockResolvedValue([{ key: 'backups/immich-db-backup-3.sql.gz', size: 30 }]);

      await expect(sut.listBackups()).resolves.toMatchObject({
        backups: [
          { filename: 'immich-db-backup-3.sql.gz', filesize: 30 },
          { filename: 'immich-db-backup-2.sql.gz', filesize: 20 },
          { filename: 'immich-db-backup-1.sql.gz', filesize: 10 },
        ],
      });
    });

    it('should report the local size for a backup still awaiting its upload', async () => {
      enableRemote();
      remote.list.mockResolvedValue([{ key: 'nightly/immich-db-backup-1.sql.gz', size: 10 }]);
      staging.list.mockResolvedValue([{ key: 'backups/immich-db-backup-1.sql.gz', size: 99 }]);

      await expect(sut.listBackups()).resolves.toMatchObject({
        backups: [{ filename: 'immich-db-backup-1.sql.gz', filesize: 99 }],
      });
    });

    it('should ignore objects under the prefix that are not backups', async () => {
      enableRemote();
      remote.list.mockResolvedValue([{ key: 'nightly/notes.txt', size: 5 }]);

      await expect(sut.listBackups()).resolves.toEqual({ backups: [] });
    });
  });

  describe('deleteBackup', () => {
    it('should reject invalid file names', async () => {
      await expect(sut.deleteBackup(['filename'])).rejects.toThrowError(
        new BadRequestException('Invalid backup name!'),
      );
    });

    it('should delete the target file', async () => {
      await sut.deleteBackup(['filename.sql']);
      expect(staging.delete).toHaveBeenCalledTimes(1);
      expect(staging.delete).toHaveBeenCalledWith('backups/filename.sql');
    });

    it('should delete from both backends, wherever the backup actually is', async () => {
      enableRemote();
      await sut.deleteBackup(['filename.sql']);
      expect(staging.delete).toHaveBeenCalledWith('backups/filename.sql');
      expect(remote.delete).toHaveBeenCalledWith('nightly/filename.sql');
    });
  });

  describe('restoreDatabaseBackup', () => {
    beforeEach(() => {
      mocks.process.spawn.mockReturnValue(mockSpawn(0, 'data', ''));
      mocks.process.spawnDuplexStream.mockImplementation(() => mockDuplex()('command', 0, 'data', ''));
      mocks.process.fork.mockImplementation(() => mockSpawn(0, 'Immich Server is listening', ''));
      mocks.storage.createGzip.mockReturnValue(new PassThrough());
      mocks.storage.createGunzip.mockReturnValue(new PassThrough());

      const configMock = {
        getEnv: () => ({
          database: {
            config: {
              connectionType: 'parts',
              host: 'myhost',
              port: 1234,
              username: 'mypg',
              password: 'mypwd',
              database: 'myimmich',
            },
            skipMigrations: false,
          },
        }),
        getWorker: () => ImmichWorker.Api,
        isDev: () => false,
      } as unknown as any;

      sut = new DatabaseBackupService(
        mocks.logger as never,
        mocks.storage as never,
        configMock as never,
        mocks.systemMetadata as never,
        mocks.process,
        mocks.database as never,
        mocks.user as never,
        mocks.cron as never,
        mocks.job as never,
        maintenanceHealthRepositoryMock,
        resolver as never,
      );
    });

    it('should fail to restore invalid backup', async () => {
      await expect(sut.restoreDatabaseBackup('filename')).rejects.toThrowErrorMatchingInlineSnapshot(
        `[Error: Invalid backup file format!]`,
      );
    });

    it('should successfully restore a backup', async () => {
      let writtenToPsql = '';

      mocks.user.hasAdmin.mockResolvedValue(true);

      mocks.process.spawnDuplexStream.mockImplementationOnce(() => mockDuplex()('command', 0, 'data', ''));
      mocks.process.spawnDuplexStream.mockImplementationOnce(() => mockDuplex()('command', 0, 'data', ''));
      mocks.process.spawnDuplexStream.mockImplementationOnce(() => {
        return mockDuplex((chunk) => (writtenToPsql += chunk))('command', 0, 'data', '');
      });

      const progress = vitest.fn();
      await sut.restoreDatabaseBackup('development-filename.sql', progress);

      expect(progress).toHaveBeenCalledWith('backup', 0.05);
      expect(progress).toHaveBeenCalledWith('migrations', 0.9);

      expect(maintenanceHealthRepositoryMock.checkApiHealth).toHaveBeenCalled();
      expect(mocks.process.spawnDuplexStream).toHaveBeenCalledTimes(3);

      expect(mocks.process.spawnDuplexStream).toHaveBeenLastCalledWith(
        expect.stringMatching('/bin/psql'),
        [
          '--username',
          'mypg',
          '--host',
          'myhost',
          '--port',
          '1234',
          '--dbname',
          'myimmich',
          '--single-transaction',
          '--set',
          'ON_ERROR_STOP=on',
          '--echo-all',
          '--output=/dev/null',
        ],
        expect.objectContaining({
          env: expect.objectContaining({
            PATH: expect.any(String),
            PGPASSWORD: 'mypwd',
          }),
        }),
      );

      expect(writtenToPsql).toMatchInlineSnapshot(`
        "
          -- drop all other database connections
          SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid();

          -- re-create the default schema
          DROP SCHEMA public CASCADE;
          CREATE SCHEMA public;

          -- restore access to schema
          GRANT ALL ON SCHEMA public TO "mypg";
          GRANT ALL ON SCHEMA public TO public;
        SELECT 1;"
      `);
    });

    it('should generate pg_dumpall specific SQL instructions', async () => {
      let writtenToPsql = '';

      mocks.user.hasAdmin.mockResolvedValue(true);

      mocks.process.spawnDuplexStream.mockImplementationOnce(() => mockDuplex()('command', 0, 'data', ''));
      mocks.process.spawnDuplexStream.mockImplementationOnce(() => mockDuplex()('command', 0, 'data', ''));
      mocks.process.spawnDuplexStream.mockImplementationOnce(() => {
        return mockDuplex((chunk) => (writtenToPsql += chunk))('command', 0, 'data', '');
      });

      const progress = vitest.fn();
      await sut.restoreDatabaseBackup('development-v2.4.0-.sql', progress);

      expect(progress).toHaveBeenCalledWith('backup', 0.05);
      expect(progress).toHaveBeenCalledWith('migrations', 0.9);

      expect(maintenanceHealthRepositoryMock.checkApiHealth).toHaveBeenCalled();
      expect(mocks.process.spawnDuplexStream).toHaveBeenCalledTimes(3);

      expect(mocks.process.spawnDuplexStream).toHaveBeenLastCalledWith(
        expect.stringMatching('/bin/psql'),
        [
          '--username',
          'mypg',
          '--host',
          'myhost',
          '--port',
          '1234',
          '--dbname',
          'myimmich',
          '--echo-all',
          '--output=/dev/null',
        ],
        expect.objectContaining({
          env: expect.objectContaining({
            PATH: expect.any(String),
            PGPASSWORD: 'mypwd',
          }),
        }),
      );

      expect(writtenToPsql).toMatchInlineSnapshot(String.raw`
        "
          -- drop all other database connections
          SELECT pg_terminate_backend(pid)
          FROM pg_stat_activity
          WHERE datname = current_database()
            AND pid <> pg_backend_pid();

                \c postgres
              SELECT 1;"
      `);
    });

    it('should fail if backup creation fails', async () => {
      mocks.process.spawnDuplexStream.mockReturnValueOnce(mockDuplex()('pg_dump', 1, '', 'error'));

      const progress = vitest.fn();
      await expect(sut.restoreDatabaseBackup('development-filename.sql', progress)).rejects
        .toThrowErrorMatchingInlineSnapshot(`
          [Error: pg_dump non-zero exit code (1)
          error]
        `);

      expect(progress).toHaveBeenCalledWith('backup', 0.05);
    });

    it('should fail if restore itself fails', async () => {
      mocks.process.spawnDuplexStream
        .mockReturnValueOnce(mockDuplex()('pg_dump', 0, 'data', ''))
        .mockReturnValueOnce(mockDuplex()('gzip', 0, 'data', ''))
        .mockReturnValueOnce(mockDuplex()('psql', 1, '', 'error'));

      const progress = vitest.fn();
      await expect(sut.restoreDatabaseBackup('development-filename.sql', progress)).rejects
        .toThrowErrorMatchingInlineSnapshot(`
          [Error: psql non-zero exit code (1)
          error]
        `);

      expect(progress).toHaveBeenCalledWith('backup', 0.05);
    });

    it('should rollback if database migrations fail', async () => {
      mocks.database.runMigrations.mockRejectedValue(new Error('Migrations Error'));

      const progress = vitest.fn();
      await expect(
        sut.restoreDatabaseBackup('development-filename.sql', progress),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`[Error: Migrations Error]`);

      expect(progress).toHaveBeenCalledWith('backup', 0.05);
      expect(progress).toHaveBeenCalledWith('migrations', 0.9);

      expect(maintenanceHealthRepositoryMock.checkApiHealth).toHaveBeenCalledTimes(0);
      expect(mocks.process.spawnDuplexStream).toHaveBeenCalledTimes(4);
    });

    it('should rollback if there is no admin user', async () => {
      mocks.user.hasAdmin.mockResolvedValue(false);

      const progress = vitest.fn();
      await expect(
        sut.restoreDatabaseBackup('development-filename.sql', progress),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`[Error: Server health check failed, no admin exists.]`);

      expect(progress).toHaveBeenCalledWith('backup', 0.05);
      expect(progress).toHaveBeenCalledWith('migrations', 0.9);
      expect(progress).toHaveBeenCalledWith('rollback', 0);

      expect(mocks.user.hasAdmin).toHaveBeenCalled();
      expect(mocks.process.spawnDuplexStream).toHaveBeenCalledTimes(4);
    });

    it('should rollback if API healthcheck fails', async () => {
      mocks.user.hasAdmin.mockResolvedValue(true);
      maintenanceHealthRepositoryMock.checkApiHealth.mockRejectedValue(new Error('Health Error'));

      const progress = vitest.fn();
      await expect(
        sut.restoreDatabaseBackup('development-filename.sql', progress),
      ).rejects.toThrowErrorMatchingInlineSnapshot(`[Error: Health Error]`);

      expect(progress).toHaveBeenCalledWith('backup', 0.05);
      expect(progress).toHaveBeenCalledWith('migrations', 0.9);
      expect(progress).toHaveBeenCalledWith('rollback', 0);

      expect(mocks.user.hasAdmin).toHaveBeenCalled();
      expect(maintenanceHealthRepositoryMock.checkApiHealth).toHaveBeenCalled();
      expect(mocks.process.spawnDuplexStream).toHaveBeenCalledTimes(4);
    });

    // The abstraction is what makes this possible at all: a backup that has been promoted only exists
    // in the bucket, and restoring reads it straight from there with no separate download step.
    it('should restore a backup that only exists in S3', async () => {
      enableRemote();
      staging.exists.mockResolvedValue(false);
      mocks.user.hasAdmin.mockResolvedValue(true);

      await sut.restoreDatabaseBackup('development-filename.sql');

      expect(remote.get).toHaveBeenCalledWith('nightly/development-filename.sql');
      expect(maintenanceHealthRepositoryMock.checkApiHealth).toHaveBeenCalled();
    });

    it('should reject a backup that is in neither place', async () => {
      enableRemote();
      staging.exists.mockResolvedValue(false);
      remote.exists.mockResolvedValue(false);

      await expect(sut.restoreDatabaseBackup('development-filename.sql')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should read the rollback restore point from the staging disk, never from S3', async () => {
      enableRemote();
      staging.exists.mockResolvedValue(true);
      mocks.user.hasAdmin.mockResolvedValue(false);

      await expect(sut.restoreDatabaseBackup('development-filename.sql')).rejects.toThrow('no admin exists');

      expect(staging.get).toHaveBeenCalledWith(expect.stringMatching(/^backups\/restore-point-/));
      expect(remote.get).not.toHaveBeenCalled();
    });
  });

  describe('onConfigValidate', () => {
    it('should refuse to enable S3 backups while the storage backend is disk', () => {
      expect(() => sut.onConfigValidate({ newConfig: configWithS3(true), oldConfig: defaults })).toThrow(
        /S3 storage backend/,
      );
    });

    it('should allow the default config', () => {
      expect(() => sut.onConfigValidate({ newConfig: defaults, oldConfig: defaults })).not.toThrow();
    });
  });
});

function* mockData() {
  yield 'SELECT 1;';
}
