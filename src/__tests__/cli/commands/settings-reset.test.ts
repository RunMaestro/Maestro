/**
 * Tests for settings-reset CLI command.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockDeleteSettingValue, mockReadSettingValue } = vi.hoisted(() => ({
	mockDeleteSettingValue: vi.fn(),
	mockReadSettingValue: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	deleteSettingValue: (...args: unknown[]) => mockDeleteSettingValue(...args),
	readSettingValue: (...args: unknown[]) => mockReadSettingValue(...args),
}));

const { mockFormatError, mockFormatSuccess } = vi.hoisted(() => ({
	mockFormatError: vi.fn((message: string) => `Error: ${message}`),
	mockFormatSuccess: vi.fn((message: string) => `Success: ${message}`),
}));

vi.mock('../../../cli/output/formatter', () => ({
	formatError: (...args: unknown[]) => mockFormatError(...args),
	formatSuccess: (...args: unknown[]) => mockFormatSuccess(...args),
}));

const mockEmitJsonl = vi.hoisted(() => vi.fn());

vi.mock('../../../cli/output/jsonl', () => ({
	emitJsonl: (...args: unknown[]) => mockEmitJsonl(...args),
}));

import { settingsReset } from '../../../cli/commands/settings-reset';

describe('settings-reset command', () => {
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
		mockReadSettingValue.mockReturnValue('old-value');
	});

	afterEach(() => {
		consoleLog.mockRestore();
		consoleError.mockRestore();
		processExit.mockRestore();
	});

	it('resets known settings to their top-level default in human-readable mode', () => {
		settingsReset('activeThemeId', {});

		expect(mockReadSettingValue).toHaveBeenCalledWith('activeThemeId');
		expect(mockDeleteSettingValue).toHaveBeenCalledWith('activeThemeId');
		expect(mockFormatSuccess).toHaveBeenCalledWith('activeThemeId reset to default ("dracula")');
		expect(consoleLog).toHaveBeenCalledWith('Success: activeThemeId reset to default ("dracula")');
	});

	it('uses top-level metadata and defaults for dot-notation settings', () => {
		settingsReset('customThemeColors.accent', {});

		expect(mockReadSettingValue).toHaveBeenCalledWith('customThemeColors.accent');
		expect(mockDeleteSettingValue).toHaveBeenCalledWith('customThemeColors.accent');
		expect(mockFormatSuccess).toHaveBeenCalledWith(
			'customThemeColors.accent reset to default ({})'
		);
	});

	it('emits JSONL reset events with old and default values', () => {
		mockReadSettingValue.mockReturnValue('nord');

		settingsReset('activeThemeId', { json: true });

		expect(mockEmitJsonl).toHaveBeenCalledWith({
			type: 'setting_reset',
			key: 'activeThemeId',
			oldValue: 'nord',
			defaultValue: 'dracula',
		});
	});

	it('throws for unknown settings in human-readable mode', () => {
		expect(() => settingsReset('unknownSetting', {})).toThrow('process.exit(1)');

		expect(mockFormatError).toHaveBeenCalledWith(
			expect.stringContaining('Failed to reset "unknownSetting": Unknown setting')
		);
		expect(processExit).toHaveBeenCalledWith(1);
	});

	it('prints JSON errors for non-Error delete failures', () => {
		mockDeleteSettingValue.mockImplementationOnce(() => {
			throw 'delete failed';
		});

		expect(() => settingsReset('activeThemeId', { json: true })).toThrow('process.exit(1)');

		expect(JSON.parse(consoleError.mock.calls[0][0])).toEqual({ error: 'Unknown error' });
		expect(processExit).toHaveBeenCalledWith(1);
	});
});
