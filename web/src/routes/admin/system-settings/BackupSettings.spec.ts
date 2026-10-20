import type { AdminConfigDto } from '@immich/sdk';
import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleSystemConfigSave } from '$lib/services/system-config.service';
import BackupSettings from './BackupSettings.svelte';

const makeConfig = (s3: { enabled: boolean; bucket: string; prefix: string }) =>
  ({
    backup: {
      database: {
        enabled: true,
        cronExpression: '0 02 * * *',
        keepLastAmount: 14,
        s3,
      },
    },
  }) as AdminConfigDto;

const mocks = vi.hoisted(() => ({
  featureFlags: { configFile: false, s3Storage: false },
  systemConfig: {} as AdminConfigDto,
  defaultSystemConfig: {} as AdminConfigDto,
  cloneValue: vi.fn(),
  cloneDefaultValue: vi.fn(),
}));

vi.mock(import('$lib/managers/feature-flags-manager.svelte'), () => ({
  featureFlagsManager: {
    get value() {
      return mocks.featureFlags;
    },
  } as never,
}));

vi.mock(import('$lib/managers/system-config-manager.svelte'), () => ({
  systemConfigManager: {
    get value() {
      return mocks.systemConfig;
    },
    get defaultValue() {
      return mocks.defaultSystemConfig;
    },
    cloneValue: mocks.cloneValue,
    cloneDefaultValue: mocks.cloneDefaultValue,
  } as never,
}));

vi.mock(import('$lib/services/system-config.service'), () => ({
  handleSystemConfigSave: vi.fn(),
}));

/**
 * `SettingInputField` renders `aria-labelledby="<label>-label"` pointing at an id that does not exist,
 * so its inputs have no accessible name and `getByLabelText` cannot find them. They are addressed by
 * the `name` attribute the component sets from the label instead.
 */
const field = (container: HTMLElement, label: string) =>
  container.querySelector<HTMLInputElement>(`input[name="${CSS.escape(label)}"]`);

describe('BackupSettings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.featureFlags.configFile = false;
    mocks.featureFlags.s3Storage = false;
    mocks.systemConfig = makeConfig({ enabled: false, bucket: '', prefix: 'immich-db-backups/' });
    mocks.defaultSystemConfig = makeConfig({ enabled: false, bucket: '', prefix: 'immich-db-backups/' });
    mocks.cloneValue.mockImplementation(() => structuredClone(mocks.systemConfig));
    mocks.cloneDefaultValue.mockImplementation(() => structuredClone(mocks.defaultSystemConfig));
  });

  // The gate: the feature reuses the media backend's S3 credentials, so it cannot apply at all on a
  // disk-backed server. The group is absent rather than disabled.
  describe('when the server is not on the S3 storage backend', () => {
    it('renders no S3 options at all', () => {
      const { container } = render(BackupSettings);

      expect(screen.queryByRole('switch', { name: 'admin.backup_s3_enabled' })).not.toBeInTheDocument();
      expect(field(container, 'admin.backup_s3_bucket')).toBeNull();
      expect(field(container, 'admin.backup_s3_prefix')).toBeNull();
      expect(screen.queryByText('admin.backup_s3_credentials_hint')).not.toBeInTheDocument();
    });

    it('still renders the upstream backup options', () => {
      const { container } = render(BackupSettings);

      expect(screen.getByRole('switch', { name: 'admin.backup_database_enable_description' })).toBeInTheDocument();
      expect(field(container, 'admin.backup_keep_last_amount')).toBeInTheDocument();
    });
  });

  describe('when the server is on the S3 storage backend', () => {
    beforeEach(() => {
      mocks.featureFlags.s3Storage = true;
    });

    it('renders the toggle, the bucket and prefix fields, and the credentials hint', () => {
      const { container } = render(BackupSettings);

      expect(screen.getByRole('switch', { name: 'admin.backup_s3_enabled' })).not.toBeChecked();
      expect(field(container, 'admin.backup_s3_bucket')).toBeInTheDocument();
      expect(field(container, 'admin.backup_s3_prefix')).toBeInTheDocument();
      expect(screen.getByText('admin.backup_s3_credentials_hint')).toBeInTheDocument();
    });

    it('disables the bucket and prefix fields while the toggle is off', () => {
      const { container } = render(BackupSettings);

      expect(field(container, 'admin.backup_s3_bucket')).toBeDisabled();
      expect(field(container, 'admin.backup_s3_prefix')).toBeDisabled();
    });

    it('enables the bucket and prefix fields once the toggle is on', async () => {
      const user = userEvent.setup();
      const { container } = render(BackupSettings);

      await user.click(screen.getByRole('switch', { name: 'admin.backup_s3_enabled' }));

      expect(field(container, 'admin.backup_s3_bucket')).toBeEnabled();
      expect(field(container, 'admin.backup_s3_prefix')).toBeEnabled();
    });

    it('saves the S3 settings with the rest of the backup section', async () => {
      const user = userEvent.setup();
      const { container } = render(BackupSettings);

      await user.click(screen.getByRole('switch', { name: 'admin.backup_s3_enabled' }));
      await user.type(field(container, 'admin.backup_s3_bucket')!, 'db-backups');
      await user.click(screen.getByRole('button', { name: 'save' }));

      expect(handleSystemConfigSave).toHaveBeenCalledWith({
        backup: {
          database: {
            enabled: true,
            cronExpression: '0 02 * * *',
            keepLastAmount: 14,
            s3: { enabled: true, bucket: 'db-backups', prefix: 'immich-db-backups/' },
          },
        },
      });
    });

    // Config-file mode makes the whole section read-only upstream; the new fields must follow.
    it('keeps everything disabled in config-file mode', () => {
      mocks.featureFlags.configFile = true;
      mocks.systemConfig = makeConfig({ enabled: true, bucket: 'db-backups', prefix: 'db/' });
      mocks.cloneValue.mockImplementation(() => structuredClone(mocks.systemConfig));

      const { container } = render(BackupSettings);

      expect(screen.getByRole('switch', { name: 'admin.backup_s3_enabled' })).toBeDisabled();
      expect(field(container, 'admin.backup_s3_bucket')).toBeDisabled();
      expect(field(container, 'admin.backup_s3_prefix')).toBeDisabled();
    });
  });
});
