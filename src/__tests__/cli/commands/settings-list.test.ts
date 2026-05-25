/**
 * Tests for settings-list CLI command.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadSettings = vi.hoisted(() => vi.fn());

vi.mock('../../../cli/services/storage', () => ({
	readSettings: (...args: unknown[]) => mockReadSettings(...args),
}));

const { mockFormatError, mockFormatSettingsList } = vi.hoisted(() => ({
	mockFormatError: vi.fn((message: string) => `Error: ${message}`),
	mockFormatSettingsList: vi.fn(() => 'formatted settings'),
}));

vi.mock('../../../cli/output/formatter', () => ({
	formatError: (...args: unknown[]) => mockFormatError(...args),
	formatSettingsList: (...args: unknown[]) => mockFormatSettingsList(...args),
}));

const mockEmitJsonl = vi.hoisted(() => vi.fn());

vi.mock('../../../cli/output/jsonl', () => ({
	emitJsonl: (...args: unknown[]) => mockEmitJsonl(...args),
}));

import { settingsList } from '../../../cli/commands/settings-list';

describe('settings-list command', () => {
	let consoleLog: ReturnType<typeof vi.spyOn>;
	let consoleError: ReturnType<typeof vi.spyOn>;
	let processExit: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExit = vi.spyOn(process, 'exit').mockImplementation((code) => {
			throw new Error(`process.exit(${code})`);
		});
		mockReadSettings.mockReturnValue({
			activeThemeId: 'nord',
			apiKey: 'secret-key',
		});
	});

	afterEach(() => {
		consoleLog.mockRestore();
		consoleError.mockRestore();
		processExit.mockRestore();
	});

	it('formats all settings in human-readable mode with display options', () => {
		settingsList({ verbose: true, keysOnly: true, defaults: true });

		expect(mockFormatSettingsList).toHaveBeenCalledWith(
			expect.arrayContaining([
				expect.objectContaining({
					key: 'activeThemeId',
					value: 'nord',
					category: 'Appearance',
					isDefault: false,
				}),
				expect.objectContaining({
					key: 'fontSize',
					value: 14,
					isDefault: true,
				}),
			]),
			{ verbose: true, keysOnly: true, showDefaults: true }
		);
		expect(consoleLog).toHaveBeenCalledWith('formatted settings');
	});

	it('filters settings by category label before formatting', () => {
		settingsList({ category: 'appearance' });

		const entries = mockFormatSettingsList.mock.calls[0][0] as Array<{ category: string }>;
		expect(entries.length).toBeGreaterThan(0);
		expect(entries.every((entry) => entry.category === 'Appearance')).toBe(true);
	});

	it('prints JSON key lists when requested', () => {
		settingsList({ json: true, keysOnly: true, category: 'appearance' });

		const keys = JSON.parse(consoleLog.mock.calls[0][0]);
		expect(keys).toContain('activeThemeId');
		expect(keys).toContain('fontSize');
		expect(mockEmitJsonl).not.toHaveBeenCalled();
	});

	it('emits JSONL entries with masking, descriptions, and default metadata', () => {
		settingsList({ json: true, verbose: true, defaults: true });

		const apiKeyEntry = mockEmitJsonl.mock.calls
			.map(([entry]) => entry)
			.find((entry) => entry.key === 'apiKey');
		const themeEntry = mockEmitJsonl.mock.calls
			.map(([entry]) => entry)
			.find((entry) => entry.key === 'activeThemeId');

		expect(apiKeyEntry).toMatchObject({
			type: 'setting',
			key: 'apiKey',
			value: '***',
			valueType: 'string',
			category: 'Advanced',
			defaultValue: '',
			isDefault: false,
		});
		expect(apiKeyEntry.description).toContain('API key');
		expect(themeEntry).toMatchObject({
			value: 'nord',
			defaultValue: 'dracula',
			isDefault: false,
		});
	});

	it('does not mask sensitive JSONL values when showSecrets is enabled', () => {
		settingsList({ json: true, showSecrets: true });

		const apiKeyEntry = mockEmitJsonl.mock.calls
			.map(([entry]) => entry)
			.find((entry) => entry.key === 'apiKey');
		expect(apiKeyEntry.value).toBe('secret-key');
		expect(apiKeyEntry).not.toHaveProperty('description');
		expect(apiKeyEntry).not.toHaveProperty('defaultValue');
	});

	it('prints formatted errors for unknown categories in human-readable mode', () => {
		expect(() => settingsList({ category: 'does-not-exist' })).toThrow('process.exit(1)');

		expect(mockFormatError).toHaveBeenCalledWith(
			expect.stringContaining('Failed to list settings: No settings found for category')
		);
		expect(consoleError).toHaveBeenCalledWith(
			expect.stringContaining('Error: Failed to list settings:')
		);
		expect(processExit).toHaveBeenCalledWith(1);
	});

	it('prints JSON errors for non-Error read failures', () => {
		mockReadSettings.mockImplementationOnce(() => {
			throw 'bad settings';
		});

		expect(() => settingsList({ json: true })).toThrow('process.exit(1)');

		expect(JSON.parse(consoleError.mock.calls[0][0])).toEqual({ error: 'Unknown error' });
		expect(processExit).toHaveBeenCalledWith(1);
	});

	it('falls back to raw category names when a display label is unavailable', async () => {
		vi.resetModules();
		vi.doMock('../../../shared/settingsMetadata', () => ({
			SETTINGS_METADATA: {
				experimentalSetting: {
					description: 'Experimental setting',
					type: 'string',
					default: 'default-value',
					category: 'experimental',
				},
			},
			CATEGORY_ORDER: ['experimental'],
			CATEGORY_LABELS: {},
		}));
		const { settingsList: isolatedSettingsList } =
			await import('../../../cli/commands/settings-list');
		mockReadSettings.mockReturnValueOnce({ experimentalSetting: 'custom-value' });

		isolatedSettingsList({});

		const entries = mockFormatSettingsList.mock.calls.at(-1)?.[0] as Array<{
			category: string;
			value: string;
		}>;
		expect(entries).toEqual([
			expect.objectContaining({
				category: 'experimental',
				value: 'custom-value',
			}),
		]);
		vi.doUnmock('../../../shared/settingsMetadata');
	});
});
