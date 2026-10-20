import { BadRequestException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { debounce } from 'lodash-es';
import { DateTime } from 'luxon';
import { basename } from 'node:path';
import { Duplex, PassThrough, Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { coerce, satisfies } from 'semver';
import type { ArgOf } from 'src/repositories/event.repository.js';
import { serverVersion } from 'src/constants.js';
import { OnEvent, OnJob } from 'src/decorators.js';
import { SystemConfig } from 'src/dtos/config.dto.js';
import { DatabaseBackupListResponseDto } from 'src/dtos/database-backup.dto.js';
import { CacheControl, DatabaseLock, ImmichWorker, JobName, JobStatus, QueueName } from 'src/enum.js';
import { BackupStore, BackupStoreResolver, validateBackupS3Config } from 'src/gallery/utils/backup-store.js';
import { StorageBackend } from 'src/interfaces/storage-backend.interface.js';
import { MaintenanceHealthRepository } from 'src/maintenance/maintenance-health.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CronRepository } from 'src/repositories/cron.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { ProcessRepository } from 'src/repositories/process.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { getConfig } from 'src/utils/config.js';
import {
  UnsupportedPostgresError,
  findDatabaseBackupVersion,
  isFailedDatabaseBackupName,
  isValidDatabaseBackupName,
  isValidDatabaseRoutineBackupName,
} from 'src/utils/database-backups.js';
import {
  ImmichFileResponse,
  ImmichMediaResponse,
  ImmichRedirectResponse,
  ImmichStreamResponse,
  getResponseSignal,
} from 'src/utils/file.js';
import { handlePromiseError } from 'src/utils/misc.js';

const backupContentType = (filename: string) => (filename.endsWith('.gz') ? 'application/gzip' : 'application/sql');

@Injectable()
export class DatabaseBackupService {
  constructor(
    private readonly logger: LoggingRepository,
    private readonly storageRepository: StorageRepository,
    private readonly configRepository: ConfigRepository,
    private readonly systemMetadataRepository: SystemMetadataRepository,
    private readonly processRepository: ProcessRepository,
    private readonly databaseRepository: DatabaseRepository,
    private readonly userRepository: UserRepository,
    @Optional()
    private readonly cronRepository: CronRepository,
    @Optional()
    private readonly jobRepository: JobRepository,
    @Optional()
    private readonly maintenanceHealthRepository: MaintenanceHealthRepository,
    // Gallery-fork: all backup file IO goes through storage backends, so the destination is
    // configuration rather than a hardcoded path. See src/gallery/utils/backup-store.ts.
    private readonly backupStore: BackupStoreResolver,
  ) {
    this.logger.setContext(this.constructor.name);
  }

  private backupLock = false;

  private loadConfig(): Promise<SystemConfig> {
    return getConfig(
      {
        configRepo: this.configRepository,
        metadataRepo: this.systemMetadataRepository,
        logger: this.logger,
      },
      { withCache: false },
    );
  }

  @OnEvent({ name: 'ConfigValidate' })
  onConfigValidate({ newConfig }: ArgOf<'ConfigValidate'>) {
    validateBackupS3Config(newConfig, this.configRepository.getEnv());
  }

  @OnEvent({ name: 'ConfigInit', workers: [ImmichWorker.Microservices] })
  async onConfigInit({
    newConfig: {
      backup: { database },
    },
  }: ArgOf<'ConfigInit'>) {
    if (!this.cronRepository || !this.jobRepository) {
      return;
    }

    this.backupLock = await this.databaseRepository.tryLock(DatabaseLock.BackupDatabase);

    if (this.backupLock) {
      this.cronRepository.create({
        name: 'backupDatabase',
        expression: database.cronExpression,
        onTick: () => handlePromiseError(this.jobRepository.queue({ name: JobName.DatabaseBackup }), this.logger),
        start: database.enabled,
      });
    }
  }

  @OnEvent({ name: 'ConfigUpdate', server: true })
  onConfigUpdate({ newConfig: { backup } }: ArgOf<'ConfigUpdate'>) {
    if (!this.cronRepository || !this.jobRepository || !this.backupLock) {
      return;
    }

    this.cronRepository.update({
      name: 'backupDatabase',
      expression: backup.database.cronExpression,
      start: backup.database.enabled,
    });
  }

  @OnJob({ name: JobName.DatabaseBackup, queue: QueueName.BackupDatabase })
  async handleBackupDatabase(): Promise<JobStatus> {
    try {
      await this.createDatabaseBackup();
    } catch (error) {
      if (error instanceof UnsupportedPostgresError) {
        return JobStatus.Failed;
      }

      throw error;
    }

    await this.cleanupDatabaseBackups();
    return JobStatus.Success;
  }

  async buildPostgresLaunchArguments(
    bin: 'pg_dump' | 'pg_dumpall' | 'psql',
    options: {
      singleTransaction?: boolean;
    } = {},
  ): Promise<{
    bin: string;
    args: string[];
    databaseUsername: string;
    databasePassword: string;
    databaseVersion: string;
    databaseMajorVersion?: number;
  }> {
    const {
      database: { config: databaseConfig },
    } = this.configRepository.getEnv();
    const isUrlConnection = databaseConfig.connectionType === 'url';

    const databaseVersion = await this.databaseRepository.getPostgresVersion();
    const databaseSemver = coerce(databaseVersion);
    const databaseMajorVersion = databaseSemver?.major;

    const args: string[] = [];
    let databaseUsername;
    let databasePassword;

    if (isUrlConnection) {
      if (bin !== 'pg_dump') {
        args.push('--dbname');
      }

      let url = databaseConfig.url;
      if (URL.canParse(databaseConfig.url)) {
        const parsedUrl = new URL(databaseConfig.url);
        // remove known bad parameters
        parsedUrl.searchParams.delete('uselibpqcompat');

        databaseUsername = parsedUrl.username || parsedUrl.searchParams.get('user');
        databasePassword = parsedUrl.password;

        url = parsedUrl.href;
      }

      // assume typical values if we can't parse URL or not present
      databaseUsername ??= 'postgres';
      databasePassword ??= '';

      args.push(url);
    } else {
      databaseUsername = databaseConfig.username;
      databasePassword = databaseConfig.password;

      args.push(
        '--username',
        databaseUsername,
        '--host',
        databaseConfig.host,
        '--port',
        databaseConfig.port.toString(),
      );

      switch (bin) {
        case 'pg_dump': {
          break;
        }
        case 'pg_dumpall': {
          args.push('--database');
          break;
        }
        case 'psql': {
          args.push('--dbname');
          break;
        }
      }

      args.push(databaseConfig.database);
    }

    switch (bin) {
      case 'pg_dump':
      case 'pg_dumpall': {
        args.push('--clean', '--if-exists');
        break;
      }
      case 'psql': {
        if (options.singleTransaction) {
          args.push(
            // don't commit any transaction on failure
            '--single-transaction',
            // exit with non-zero code on error
            '--set',
            'ON_ERROR_STOP=on',
          );
        }

        args.push(
          // used for progress monitoring
          '--echo-all',
          '--output=/dev/null',
        );
        break;
      }
    }

    if (!databaseMajorVersion || !databaseSemver || !satisfies(databaseSemver, '>=14.0.0 <19.0.0')) {
      this.logger.error(`Database Restore Failure: Unsupported PostgreSQL version: ${databaseVersion}`);
      throw new UnsupportedPostgresError(databaseVersion);
    }

    return {
      bin: `/usr/lib/postgresql/${databaseMajorVersion}/bin/${bin}`,
      args,
      databaseUsername,
      databasePassword,
      databaseVersion,
      databaseMajorVersion,
    };
  }

  /**
   * Returns the backup's filename, which every other operation here resolves to a backend key.
   *
   * Staged write: `pg_dump | gzip` lands on the staging disk under a `.tmp` key, the finished file is
   * promoted to its real name (so a dump killed half way can never be mistaken for a valid backup),
   * and only then is it uploaded to S3 and the local copy removed. A prefixed backup is a restore
   * point, which is the restore flow's own local safety net and so is never uploaded.
   */
  async createDatabaseBackup(filenamePrefix: string = ''): Promise<string> {
    this.logger.debug(`Database Backup Started`);

    const { bin, args, databasePassword, databaseVersion, databaseMajorVersion } =
      await this.buildPostgresLaunchArguments('pg_dump');

    this.logger.log(`Database Backup Starting. Database Version: ${databaseMajorVersion}`);

    const filename = `${filenamePrefix}immich-db-backup-${DateTime.now().toFormat("yyyyLLdd'T'HHmmss")}-v${serverVersion.toString()}-pg${databaseVersion.split(' ', 1)[0]}.sql.gz`;
    const store = await this.backupStore.resolve();
    const backupKey = store.key(filename);
    const temporaryKey = `${backupKey}.tmp`;

    let pgdump: Duplex | undefined;
    let gzip: Duplex | undefined;

    try {
      pgdump = this.processRepository.spawnDuplexStream(bin, args, {
        env: {
          PATH: process.env.PATH,
          PGPASSWORD: databasePassword,
        },
      });

      gzip = this.processRepository.spawnDuplexStream('gzip', ['--rsyncable']);

      // The backend owns the destination, so it consumes the stream rather than being handed a write
      // stream. `pipeline`'s own completion is tracked separately: a pg_dump or gzip failure destroys
      // `dump`, which surfaces as `put` rejecting, and the captured error is the one worth reporting.
      const dump = new PassThrough();
      let dumpError: unknown;
      const dumpPipeline = pipeline(pgdump, gzip, dump).catch((error: unknown) => {
        dumpError = error;
      });

      await store.staging.put(temporaryKey, dump, { contentType: backupContentType(filename) });
      await dumpPipeline;
      if (dumpError) {
        throw dumpError;
      }

      await store.staging.rename(temporaryKey, backupKey);
    } catch (error) {
      this.logger.error(`Database Backup Failure: ${error}`);
      pgdump?.destroy();
      gzip?.destroy();
      await store.staging
        .delete(temporaryKey)
        .catch((error) => this.logger.error(`Failed to delete failed backup file: ${error}`));
      throw error;
    }

    if (filenamePrefix === '') {
      await this.promoteToRemote(store, filename);
    }

    this.logger.log(`Database Backup Success`);
    return filename;
  }

  /**
   * The staged promote. An upload failure throws, so the job reports `Failed` with the bucket named and
   * the local file still in place for the next run to retry; a delete failure after a good upload is
   * only logged, because the object is safely in S3 and the straggler is swept by the next cleanup.
   * A no-op when no remote is configured.
   */
  private async promoteToRemote(store: BackupStore, filename: string): Promise<void> {
    const { remote } = store;
    if (!remote) {
      return;
    }

    const key = store.key(filename);

    try {
      const { stream } = await store.staging.get(key);
      await remote.backend.put(key, stream, { contentType: backupContentType(filename) });
    } catch (error) {
      throw new Error(
        `Failed to upload database backup ${filename} to S3 bucket "${remote.bucket}" (key ${key}). The backup is still on local disk and the next run will retry the upload.`,
        { cause: error },
      );
    }

    this.logger.log(`Database Backup uploaded to S3 (bucket: ${remote.bucket}, key: ${key})`);

    await store.staging
      .delete(key)
      .catch((error) => this.logger.warn(`Uploaded ${filename} to S3 but failed to delete the local copy: ${error}`));
  }

  /** Filenames under a backend prefix, with the prefix stripped, so both key spaces compare alike. */
  private async filenamesIn(backend: StorageBackend, prefix: string): Promise<string[]> {
    const entries = await backend.list(prefix);
    return entries.map(({ key }) => basename(key));
  }

  /**
   * Local first, then remote. A backup whose upload failed is still on disk, and must stay downloadable
   * and restorable from there; everything else has been promoted and only exists in the bucket.
   */
  private async locate(store: BackupStore, filename: string): Promise<{ backend: StorageBackend; key: string }> {
    const key = store.key(filename);
    if (await store.staging.exists(key)) {
      return { backend: store.staging, key };
    }

    if (store.remote && (await store.remote.backend.exists(key))) {
      return { backend: store.remote.backend, key };
    }

    throw new NotFoundException(`Backup ${filename} was not found`);
  }

  async uploadBackup(file: Express.Multer.File): Promise<void> {
    const fn = basename(file.originalname);
    if (!isValidDatabaseBackupName(fn)) {
      throw new BadRequestException('Invalid backup name!');
    }

    const filename = `uploaded-${fn}`;
    const store = await this.backupStore.resolve();
    await store.staging.put(store.key(filename), file.buffer, { contentType: backupContentType(filename) });
    await this.promoteToRemote(store, filename);
  }

  /**
   * Returns a served response rather than a path, because an S3 object has no path. The three
   * strategies a backend can answer with map onto the three responses `sendFile` already handles, so
   * both call sites (the admin controller and the maintenance worker) are unchanged.
   */
  async downloadBackup(fileName: string): Promise<ImmichMediaResponse> {
    if (!isValidDatabaseBackupName(fileName)) {
      throw new BadRequestException('Invalid backup name!');
    }

    const store = await this.backupStore.resolve();
    const { backend, key } = await this.locate(store, fileName);
    const contentType = backupContentType(fileName);
    const cacheControl = CacheControl.PrivateWithoutCache;

    const strategy = await backend.getServeStrategy(key, {
      contentType,
      cacheControl,
      fileName,
      signal: getResponseSignal(),
    });

    switch (strategy.type) {
      case 'file': {
        return new ImmichFileResponse({ path: strategy.path, contentType, cacheControl, fileName });
      }
      case 'redirect': {
        return new ImmichRedirectResponse({ url: strategy.url, cacheControl });
      }
      case 'stream': {
        return new ImmichStreamResponse({
          stream: strategy.stream,
          contentType,
          length: strategy.length,
          cacheControl,
          fileName,
        });
      }
    }
  }

  async listBackups(): Promise<DatabaseBackupListResponseDto> {
    const store = await this.backupStore.resolve();
    const timezone = DateTime.local().zoneName;

    // Union of both backends, deduplicated by filename, so a partial outage still shows one coherent
    // set. Local is read last and wins: during a failed upload it is the copy an admin can download.
    const sizes = new Map<string, number>();
    if (store.remote) {
      const remoteEntries = await store.remote.backend.list(store.prefix);
      for (const { key, size } of remoteEntries) {
        sizes.set(basename(key), size);
      }
    }
    const localEntries = await store.staging.list(store.prefix);
    for (const { key, size } of localEntries) {
      sizes.set(basename(key), size);
    }

    const backups = sizes
      .keys()
      .filter((fn) => isValidDatabaseBackupName(fn))
      .toArray()
      .toSorted((a, b) => (a.startsWith('uploaded-') === b.startsWith('uploaded-') ? a.localeCompare(b) : 1))
      .toReversed()
      .map((filename) => ({ filename, filesize: sizes.get(filename) ?? 0, timezone }));

    return {
      backups,
    };
  }

  async deleteBackup(files: string[]): Promise<void> {
    if (files.some((filename) => !isValidDatabaseBackupName(filename))) {
      throw new BadRequestException('Invalid backup name!');
    }

    const store = await this.backupStore.resolve();
    const { remote } = store;

    // Delete from wherever it is. The local copy is normally already gone once promoted, and
    // `delete` is a no-op on a missing disk file, so both sides are safe to attempt.
    await Promise.all(
      files.flatMap((filename) => {
        const key = store.key(filename);
        return [store.staging.delete(key), ...(remote ? [remote.backend.delete(key)] : [])];
      }),
    );
  }

  async cleanupDatabaseBackups() {
    this.logger.debug(`Database Backup Cleanup Started`);
    const {
      backup: { database: config },
    } = await this.loadConfig();

    const store = await this.backupStore.resolve();
    const { remote } = store;

    const localNames = () => this.filenamesIn(store.staging, store.prefix);

    // Retry stragglers first: a backup left on disk by a failed upload is promoted rather than
    // orphaned, and a local copy that is already in the bucket is just a duplicate.
    if (remote) {
      const remoteNames = new Set(await this.filenamesIn(remote.backend, store.prefix));
      for (const filename of await localNames()) {
        if (!isValidDatabaseRoutineBackupName(filename)) {
          continue;
        }
        if (remoteNames.has(filename)) {
          await store.staging.delete(store.key(filename));
          continue;
        }
        await this.promoteToRemote(store, filename);
      }
    }

    // Retention applies to whichever backend holds the canonical set. Pruning the staging disk while
    // S3 is on would delete a straggler the next run could still promote.
    const canonical = remote
      ? {
          list: () => this.filenamesIn(remote.backend, store.prefix),
          delete: (filename: string) => remote.backend.delete(store.key(filename)),
        }
      : {
          list: localNames,
          delete: (filename: string) => store.staging.delete(store.key(filename)),
        };

    const canonicalNames = await canonical.list();
    const toDelete = canonicalNames
      .filter((filename) => isValidDatabaseRoutineBackupName(filename))
      .toSorted()
      .toReversed()
      .slice(config.keepLastAmount);

    for (const filename of toDelete) {
      await canonical.delete(filename);
    }

    // Failed dumps are always local — the promote only ever runs on a finished file — so the staging
    // disk is swept for them whichever backend is canonical.
    const localNamesAfterPromote = await localNames();
    const failedBackups = localNamesAfterPromote.filter((filename) => isFailedDatabaseBackupName(filename));
    for (const filename of failedBackups) {
      await store.staging.delete(store.key(filename));
    }

    this.logger.debug(`Database Backup Cleanup Finished, deleted ${toDelete.length + failedBackups.length} backups`);
  }

  async restoreDatabaseBackup(
    filename: string,
    progressCb?: (action: 'backup' | 'restore' | 'migrations' | 'rollback', progress: number) => void,
  ): Promise<void> {
    this.logger.debug(`Database Restore Started`);

    let isComplete = false;
    try {
      if (!isValidDatabaseBackupName(filename)) {
        throw new Error('Invalid backup file format!');
      }

      const store = await this.backupStore.resolve();
      // resolves to the bucket when the backup has already been promoted, so restoring from S3 needs
      // no separate download step
      const source = await this.locate(store, filename);

      let isPgClusterDump = false;
      const version = findDatabaseBackupVersion(filename);
      if (version && satisfies(version, '<= 2.4')) {
        isPgClusterDump = true;
      }

      const { bin, args, databaseUsername, databasePassword, databaseMajorVersion } =
        await this.buildPostgresLaunchArguments('psql', {
          singleTransaction: !isPgClusterDump,
        });

      progressCb?.('backup', 0.05);

      const restorePointFilename = await this.createDatabaseBackup('restore-point-');

      this.logger.log(`Database Restore Starting. Database Version: ${databaseMajorVersion}`);

      let inputStream: Readable;
      const { stream: backupStream } = await source.backend.get(source.key);
      if (filename.endsWith('.gz')) {
        const gunzip = this.storageRepository.createGunzip();
        backupStream.pipe(gunzip);
        inputStream = gunzip;
      } else {
        inputStream = backupStream;
      }

      const sqlStream = Readable.from(sql(inputStream, databaseUsername, isPgClusterDump));
      const psql = this.processRepository.spawnDuplexStream(bin, args, {
        env: {
          PATH: process.env.PATH,
          PGPASSWORD: databasePassword,
        },
      });

      const [progressSource, progressSink] = createSqlProgressStreams((progress) => {
        if (isComplete) {
          return;
        }

        this.logger.log(`Restore progress ~ ${(progress * 100).toFixed(2)}%`);
        progressCb?.('restore', progress);
      });

      await pipeline(sqlStream, createSqlOwnerTransformStream(databaseUsername), progressSource, psql, progressSink);

      try {
        progressCb?.('migrations', 0.9);

        await this.databaseRepository.runMigrations();

        const hasAdmin = await this.userRepository.hasAdmin();
        if (!hasAdmin) {
          throw new Error('Server health check failed, no admin exists.');
        }

        await this.maintenanceHealthRepository.checkApiHealth();
      } catch (error) {
        progressCb?.('rollback', 0);

        // the restore point is never promoted, so it is always on the staging disk
        const { stream: restorePointStream } = await store.staging.get(store.key(restorePointFilename));
        const gunzip = this.storageRepository.createGunzip();
        restorePointStream.pipe(gunzip);
        inputStream = gunzip;

        const sqlStream = Readable.from(sqlRollback(inputStream, databaseUsername));
        const psql = this.processRepository.spawnDuplexStream(bin, args, {
          env: {
            PATH: process.env.PATH,
            PGPASSWORD: databasePassword,
          },
        });

        const [progressSource, progressSink] = createSqlProgressStreams((progress) => {
          if (isComplete) {
            return;
          }

          this.logger.log(`Rollback progress ~ ${(progress * 100).toFixed(2)}%`);
          progressCb?.('rollback', progress);
        });

        await pipeline(sqlStream, progressSource, psql, progressSink);

        throw error;
      }
    } catch (error) {
      this.logger.error(`Database Restore Failure: ${error}`);
      throw error;
    } finally {
      isComplete = true;
    }

    this.logger.log(`Database Restore Success`);
  }
}

const SQL_DROP_CONNECTIONS = `
  -- drop all other database connections
  SELECT pg_terminate_backend(pid)
  FROM pg_stat_activity
  WHERE datname = current_database()
    AND pid <> pg_backend_pid();
`;

const SQL_RESET_SCHEMA = (username: string) => `
  -- re-create the default schema
  DROP SCHEMA public CASCADE;
  CREATE SCHEMA public;

  -- restore access to schema
  GRANT ALL ON SCHEMA public TO "${username}";
  GRANT ALL ON SCHEMA public TO public;
`;

async function* sql(inputStream: Readable, databaseUsername: string, isPgClusterDump: boolean) {
  yield SQL_DROP_CONNECTIONS;
  yield isPgClusterDump
    ? // it is likely the dump contains SQL to try to drop the currently active
      // database to ensure we have a fresh slate; if the `postgres` database exists
      // then prefer to switch before continuing otherwise this will just silently fail
      String.raw`
        \c postgres
      `
    : SQL_RESET_SCHEMA(databaseUsername);

  for await (const chunk of inputStream) {
    yield chunk;
  }
}

async function* sqlRollback(inputStream: Readable, databaseUsername: string) {
  yield SQL_DROP_CONNECTIONS;
  yield SQL_RESET_SCHEMA(databaseUsername);

  for await (const chunk of inputStream) {
    yield chunk;
  }
}

function createSqlProgressStreams(cb: (progress: number) => void) {
  const STDIN_START_MARKER = new TextEncoder().encode('FROM stdin');
  const STDIN_END_MARKER = new TextEncoder().encode(String.raw`\.`);

  let isReadingStdin = false;
  let sequenceIdx = 0;

  let linesSent = 0;
  let linesProcessed = 0;

  const startedAt = +Date.now();
  const cbDebounced = debounce(
    () => {
      const progress = source.writableEnded
        ? Math.min(1, linesProcessed / linesSent)
        : // progress simulation while we're in an indeterminate state
          Math.min(0.3, 0.1 + (Date.now() - startedAt) / 1e4);
      cb(progress);
    },
    100,
    {
      maxWait: 100,
    },
  );

  let lastByte = -1;
  const source = new PassThrough({
    transform(chunk, _encoding, callback) {
      for (const byte of chunk) {
        if (!isReadingStdin && byte === 10 && lastByte !== 10) {
          linesSent += 1;
        }

        lastByte = byte;

        const sequence = isReadingStdin ? STDIN_END_MARKER : STDIN_START_MARKER;
        if (sequence[sequenceIdx] === byte) {
          sequenceIdx += 1;

          if (sequence.length === sequenceIdx) {
            sequenceIdx = 0;
            isReadingStdin = !isReadingStdin;
          }
        } else {
          sequenceIdx = 0;
        }
      }

      cbDebounced();
      // eslint-disable-next-line unicorn/no-this-outside-of-class
      this.push(chunk);
      callback();
    },
  });

  const sink = new Writable({
    write(chunk, _encoding, callback) {
      for (const byte of chunk) {
        if (byte === 10) {
          linesProcessed++;
        }
      }

      cbDebounced();
      callback();
    },
  });

  return [source, sink];
}

function createSqlOwnerTransformStream(databaseUsername: string) {
  const OWNER_MARKER_START = new TextEncoder().encode('OWNER TO ');
  const DATA_MARKER_START = new TextEncoder().encode('FROM stdin');
  const LINE_END = new TextEncoder().encode(';');

  const owner = new TextEncoder().encode(`"${databaseUsername}"`);

  let ownerSequenceIndex = 0;

  let replacingOwnerIndex = 0;
  let replacingOwner = false;

  let readingDataIndex = 0;

  let dataPart = false;

  return new PassThrough({
    transform(chunk, _encoding, callback) {
      let result = chunk;
      if (!dataPart) {
        for (let index = 0; index < result.length; index++) {
          if (replacingOwner) {
            if (result[index] === LINE_END[0]) {
              result = Buffer.concat([result.slice(0, index), owner.slice(replacingOwnerIndex), result.slice(index)]);
              replacingOwnerIndex = owner.length;
            } else {
              result[index] = owner[replacingOwnerIndex];
              replacingOwnerIndex++;
            }
          }

          if (replacingOwnerIndex === owner.length) {
            replacingOwner = false;
          }

          if (result[index] === OWNER_MARKER_START[ownerSequenceIndex]) {
            ownerSequenceIndex++;
          } else {
            ownerSequenceIndex = 0;
          }

          if (ownerSequenceIndex === OWNER_MARKER_START.length) {
            ownerSequenceIndex = 0;
            replacingOwner = true;
            replacingOwnerIndex = 0;
          }

          if (result[index] === DATA_MARKER_START[readingDataIndex]) {
            readingDataIndex++;
          } else {
            readingDataIndex = 0;
          }

          if (readingDataIndex === DATA_MARKER_START.length) {
            dataPart = true;
            break;
          }
        }
      }

      // eslint-disable-next-line unicorn/no-this-outside-of-class
      this.push(result);
      callback();
    },
  });
}
