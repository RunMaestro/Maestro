/**
 * Tests for settings-get CLI command.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockReadSettingValue = vi.hoisted(() => vi.fn());

vi.mock('../../cli/services/storage', () => ({
	readSettingValue: (...args: unknown[]) => mockReadSettingValue(...args),
}));

const { mockFormatError, mockFormatSettingDetail } = vi.hoisted(() => ({
	mockFormatError: vi.fn((message: string) => `Error: ${message}`),
	mockFormatSettingDetail: vi.fn(() => 'formatted setting'),
}));

vi.mock('../../cli/output/formatter', () => ({
	formatError: (...args: unknown[]) => mockFormatError(...args),
	formatSettingDetail: (...args: unknown[]) => mockFormatSettingDetail(...args),
}));

const mockEmitJsonl = vi.hoisted(() => vi.fn());

vi.mock('../../cli/output/jsonl', () => ({
	emitJsonl: (...args: unknown[]) => mockEmitJsonl(...args),
}));

import { settingsGet } from '../../cli/commands/settings-get';

describe('settings-get command', () => {
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
	});

	afterEach(() => {
		consoleLog.mockRestore();
		consoleError.mockRestore();
		processExit.mockRestore();
	});

	it('prints primitive values directly for scripting', () => {
		mockReadSettingValue.mockReturnValue('nord');

		settingsGet('activeThemeId', {});

		expect(consoleLog).toHaveBeenCalledWith('nord');
	});

	it('prints object values as pretty JSON and undefined known values as blank strings', () => {
		mockReadSettingValue.mockReturnValueOnce({ accent: '#fff' }).mockReturnValueOnce(undefined);

		settingsGet('customThemeColors', {});
		settingsGet('activeThemeId', {});

		expect(consoleLog).toHaveBeenNthCalledWith(1, JSON.stringify({ accent: '#fff' }, null, 2));
		expect(consoleLog).toHaveBeenNthCalledWith(2, '');
	});

	it('formats verbose known settings with default metadata', () => {
		mockReadSettingValue.mockReturnValue('dracula');

		settingsGet('activeThemeId', { verbose: true });

		expect(mockFormatSettingDetail).toHaveBeenCalledWith(
			expect.objectContaining({
				key: 'activeThemeId',
				value: 'dracula',
				category: 'Appearance',
				defaultValue: 'dracula',
				isDefault: true,
			})
		);
		expect(consoleLog).toHaveBeenCalledWith('formatted setting');
	});

	it('emits JSONL with verbose metadata for known and dot-notation settings', () => {
		mockReadSettingValue.mockReturnValueOnce('nord').mockReturnValueOnce('#fff');

		settingsGet('activeThemeId', { json: true, verbose: true });
		settingsGet('customThemeColors.accent', { json: true, verbose: true });

		expect(mockEmitJsonl).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				type: 'setting',
				key: 'activeThemeId',
				value: 'nord',
				valueType: 'string',
				category: 'Appearance',
				description: expect.any(String),
				defaultValue: 'dracula',
				isDefault: false,
			})
		);
		expect(mockEmitJsonl).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				key: 'customThemeColors.accent',
				value: '#fff',
				defaultValue: undefined,
				isDefault: undefined,
			})
		);
	});

	it('throws for unknown undefined settings in human-readable mode', () => {
		mockReadSettingValue.mockReturnValue(undefined);

		expect(() => settingsGet('unknownSetting', {})).toThrow('process.exit(1)');

		expect(mockFormatError).toHaveBeenCalledWith(expect.stringContaining('Unknown setting'));
		expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('Error: Unknown setting'));
	});

	it('emits JSONL for unknown settings that have stored values', () => {
		mockReadSettingValue.mockReturnValue('custom');

		settingsGet('unknownSetting', { json: true });

		expect(mockEmitJsonl).toHaveBeenCalledWith(
			expect.objectContaining({
				key: 'unknownSetting',
				value: 'custom',
				valueType: 'string',
				category: 'unknown',
			})
		);
	});

	it('prints JSON errors for non-Error read failures', () => {
		mockReadSettingValue.mockImplementationOnce(() => {
			throw 'bad read';
		});

		expect(() => settingsGet('activeThemeId', { json: true })).toThrow('process.exit(1)');

		expect(JSON.parse(consoleError.mock.calls[0][0])).toEqual({ error: 'Unknown error' });
	});

	it('falls back to raw category names and handles verbose dot-notation defaults', async () => {
		vi.resetModules();
		vi.doMock('../../shared/settingsMetadata', () => ({
			SETTINGS_METADATA: {
				experimentalSetting: {
					description: 'Experimental setting',
					type: 'string',
					default: 'default-value',
					category: 'experimental',
				},
			},
			CATEGORY_LABELS: {},
			getSettingDefault: () => 'default-value',
		}));
		const { settingsGet: isolatedSettingsGet } = await import('../../cli/commands/settings-get');
		mockReadSettingValue.mockReturnValueOnce('custom-value').mockReturnValueOnce('nested-value');

		isolatedSettingsGet('experimentalSetting', { json: true, verbose: true });
		isolatedSettingsGet('experimentalSetting.nested', { verbose: true });

		expect(mockEmitJsonl).toHaveBeenCalledWith(
			expect.objectContaining({
				key: 'experimentalSetting',
				category: 'experimental',
			})
		);
		expect(mockFormatSettingDetail).toHaveBeenCalledWith(
			expect.objectContaining({
				key: 'experimentalSetting.nested',
				category: 'experimental',
				defaultValue: undefined,
				isDefault: undefined,
			})
		);
		vi.doUnmock('../../shared/settingsMetadata');
	});
});
