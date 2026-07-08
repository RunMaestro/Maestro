import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SettingCategory } from '../../shared/settingsMetadata';

const originalShell = process.env.SHELL;

async function loadSettingsMetadata({
	isWindows = false,
	shell = '/bin/zsh',
}: {
	isWindows?: boolean;
	shell?: string | null;
} = {}) {
	vi.resetModules();
	vi.doMock('../../shared/platformDetection', () => ({
		isWindows: () => isWindows,
	}));

	if (shell === null) {
		delete process.env.SHELL;
	} else {
		process.env.SHELL = shell;
	}

	return import('../../shared/settingsMetadata');
}

describe('settingsMetadata', () => {
	afterEach(() => {
		if (originalShell === undefined) {
			delete process.env.SHELL;
		} else {
			process.env.SHELL = originalShell;
		}
		vi.doUnmock('../../shared/platformDetection');
		vi.resetModules();
	});

	it('returns metadata and defaults for known settings', async () => {
		const { SETTINGS_METADATA, getAllDefaults, getSettingDefault, getSettingMetadata } =
			await loadSettingsMetadata({ shell: '/usr/local/bin/fish' });

		expect(getSettingMetadata('activeThemeId')).toBe(SETTINGS_METADATA.activeThemeId);
		expect(getSettingMetadata('missing-setting')).toBeUndefined();
		expect(getSettingDefault('activeThemeId')).toBe('dracula');
		expect(getSettingDefault('defaultShell')).toBe('fish');
		expect(getSettingDefault('missing-setting')).toBeUndefined();

		const defaults = getAllDefaults();
		expect(defaults.activeThemeId).toBe('dracula');
		expect(defaults.defaultShell).toBe('fish');
		expect(defaults.webAuthToken).toBeNull();
		expect(Object.keys(defaults).sort()).toEqual(Object.keys(SETTINGS_METADATA).sort());

		defaults.activeThemeId = 'mutated';
		expect(SETTINGS_METADATA.activeThemeId.default).toBe('dracula');
	});

	it('tracks sensitive settings for masked output', async () => {
		const { SENSITIVE_KEYS } = await loadSettingsMetadata();

		expect(SENSITIVE_KEYS).toEqual(new Set(['apiKey', 'webAuthToken', 'wakatimeApiKey']));
		expect(SENSITIVE_KEYS.has('activeThemeId')).toBe(false);
	});

	it('has labels and ordering for every category used by the registry', async () => {
		const { CATEGORY_LABELS, CATEGORY_ORDER, SETTINGS_METADATA } = await loadSettingsMetadata();
		const usedCategories = new Set(
			Object.values(SETTINGS_METADATA).map((metadata) => metadata.category)
		);

		for (const category of usedCategories) {
			expect(CATEGORY_LABELS[category]).toEqual(expect.any(String));
			expect(CATEGORY_ORDER).toContain(category);
		}

		expect(new Set(CATEGORY_ORDER).size).toBe(CATEGORY_ORDER.length);
		expect(Object.keys(CATEGORY_LABELS).sort()).toEqual([...CATEGORY_ORDER].sort());
	});

	it('keeps setting metadata structurally valid', async () => {
		const { SETTINGS_METADATA } = await loadSettingsMetadata();
		const validTypes = new Set(['string', 'number', 'boolean', 'object', 'array', 'null']);

		for (const [key, metadata] of Object.entries(SETTINGS_METADATA)) {
			expect(key).not.toHaveLength(0);
			expect(metadata.description.trim()).not.toHaveLength(0);
			expect(validTypes.has(metadata.type)).toBe(true);
			expect(metadata.category).toEqual(expect.any(String));
		}
	});

	it('defaults to PowerShell on Windows', async () => {
		const { getSettingDefault } = await loadSettingsMetadata({
			isWindows: true,
			shell: '/bin/fish',
		});

		expect(getSettingDefault('defaultShell')).toBe('powershell');
	});

	it('uses supported Unix shell basenames from the environment', async () => {
		const { getSettingDefault } = await loadSettingsMetadata({ shell: '/opt/homebrew/bin/tcsh' });

		expect(getSettingDefault('defaultShell')).toBe('tcsh');
	});

	it('falls back to bash for unsupported or missing Unix shells', async () => {
		const unsupported = await loadSettingsMetadata({ shell: '/opt/custom/elvish' });
		expect(unsupported.getSettingDefault('defaultShell')).toBe('bash');

		const missing = await loadSettingsMetadata({ shell: null });
		expect(missing.getSettingDefault('defaultShell')).toBe('bash');
	});

	it('exports all declared category labels in the configured display order', async () => {
		const { CATEGORY_LABELS, CATEGORY_ORDER } = await loadSettingsMetadata();
		const labelsByOrder = CATEGORY_ORDER.map(
			(category: SettingCategory) => CATEGORY_LABELS[category]
		);

		expect(labelsByOrder).toContain('Appearance');
		expect(labelsByOrder).toContain('Shell & Terminal');
		expect(labelsByOrder).toContain('Internal (auto-managed)');
		expect(labelsByOrder.at(0)).toBe('Appearance');
		expect(labelsByOrder.at(-1)).toBe('Internal (auto-managed)');
	});
});
