// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { SETTINGS_DEFAULTS } from '../../main/stores/defaults';
import {
	getSettingDefault,
	getSettingMetadata,
	resolveDefaultShell,
} from '../../shared/settingsMetadata';
import { createSettingsStoreDefaults } from '../../renderer/stores/settingsStore';

function expectMetadataType(value: unknown, type: string): void {
	if (value === null || type === 'null') {
		expect(value).toBeNull();
		return;
	}
	expect(Array.isArray(value) ? 'array' : typeof value).toBe(type);
}

describe('canonical settings defaults', () => {
	it('resolves platform-dependent defaults consistently', () => {
		expect(resolveDefaultShell({ platform: 'win32', shell: '/bin/zsh' })).toBe('powershell');
		expect(resolveDefaultShell({ platform: 'darwin' })).toBe('zsh');
		expect(resolveDefaultShell({ platform: 'linux', shell: '/usr/bin/fish' })).toBe('fish');
		expect(resolveDefaultShell({ platform: 'linux', shell: '/usr/bin/unsupported' })).toBe('bash');

		expect(getSettingDefault('useNativeTitleBar', { platform: 'win32' })).toBe(true);
		expect(getSettingDefault('useNativeTitleBar', { platform: 'linux' })).toBe(false);
	});

	it('keeps main, shared, and renderer defaults aligned for shared settings', () => {
		for (const [key, mainDefault] of Object.entries(SETTINGS_DEFAULTS)) {
			const metadata = getSettingMetadata(key);
			expect(metadata, `missing metadata for ${key}`).toBeDefined();
			expectMetadataType(mainDefault, metadata!.type);
			expect(getSettingDefault(key)).toEqual(mainDefault);
		}

		for (const platform of ['win32', 'linux'] as const) {
			const rendererDefaults = createSettingsStoreDefaults(platform);
			expect(rendererDefaults.defaultShell).toBe(getSettingDefault('defaultShell', { platform }));
			expect(rendererDefaults.sshRemoteIgnorePatterns).toEqual(
				getSettingDefault('sshRemoteIgnorePatterns', { platform })
			);
			expect(rendererDefaults.sshRemoteHonorGitignore).toBe(
				getSettingDefault('sshRemoteHonorGitignore', { platform })
			);
			expect(rendererDefaults.useNativeTitleBar).toBe(
				getSettingDefault('useNativeTitleBar', { platform })
			);
		}
	});

	it('keeps renderer-only materialized presentation defaults outside persistence policy', () => {
		const rendererDefaults = createSettingsStoreDefaults('linux');
		expect(getSettingDefault('customThemeColors')).toEqual({});
		expect(rendererDefaults.customThemeColors).toEqual(
			expect.objectContaining({ bgMain: expect.any(String) })
		);
	});
});
