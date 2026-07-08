/**
 * Tests for settings-set CLI command.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { mockReadSettingValue, mockWriteSettingValue } = vi.hoisted(() => ({
	mockReadSettingValue: vi.fn(),
	mockWriteSettingValue: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	readSettingValue: (...args: unknown[]) => mockReadSettingValue(...args),
	writeSettingValue: (...args: unknown[]) => mockWriteSettingValue(...args),
}));

const { mockFormatError, mockFormatSuccess, mockFormatWarning } = vi.hoisted(() => ({
	mockFormatError: vi.fn((message: string) => `Error: ${message}`),
	mockFormatSuccess: vi.fn((message: string) => `Success: ${message}`),
	mockFormatWarning: vi.fn((message: string) => `Warning: ${message}`),
}));

vi.mock('../../../cli/output/formatter', () => ({
	formatError: (...args: unknown[]) => mockFormatError(...args),
	formatSuccess: (...args: unknown[]) => mockFormatSuccess(...args),
	formatWarning: (...args: unknown[]) => mockFormatWarning(...args),
}));

const mockEmitJsonl = vi.hoisted(() => vi.fn());

vi.mock('../../../cli/output/jsonl', () => ({
	emitJsonl: (...args: unknown[]) => mockEmitJsonl(...args),
}));

import { settingsSet } from '../../../cli/commands/settings-set';

describe('settings-set command', () => {
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

	it.each([
		['true', true],
		['false', false],
		['null', null],
		['42', 42],
		['3.5', 3.5],
		['007', '007'],
		['', ''],
		['["a","b"]', ['a', 'b']],
		['{"enabled":true}', { enabled: true }],
		['{not-json}', '{not-json}'],
	])('parses %s into the expected setting value', (input, expectedValue) => {
		settingsSet('fontSize', input, {});

		expect(mockWriteSettingValue).toHaveBeenCalledWith('fontSize', expectedValue);
		expect(mockFormatSuccess).toHaveBeenCalledWith(`fontSize = ${JSON.stringify(expectedValue)}`);
		expect(consoleLog).toHaveBeenCalledWith(`Success: fontSize = ${JSON.stringify(expectedValue)}`);
	});

	it('writes raw JSON values when --raw is provided', () => {
		settingsSet('customThemeColors', 'ignored', { raw: '{"accent":"#fff"}' });

		expect(mockWriteSettingValue).toHaveBeenCalledWith('customThemeColors', { accent: '#fff' });
	});

	it('emits JSONL with old and new values in JSON mode', () => {
		mockReadSettingValue.mockReturnValue('dracula');

		settingsSet('activeThemeId', 'nord', { json: true });

		expect(mockEmitJsonl).toHaveBeenCalledWith({
			type: 'setting_set',
			key: 'activeThemeId',
			oldValue: 'dracula',
			newValue: 'nord',
		});
		expect(consoleError).not.toHaveBeenCalled();
	});

	it('warns for unknown keys in human-readable mode but still writes the value', () => {
		settingsSet('unknownSetting', 'value', {});

		expect(mockFormatWarning).toHaveBeenCalledWith(
			'"unknownSetting" is not a known setting. Writing anyway.'
		);
		expect(consoleError).toHaveBeenCalledWith(
			'Warning: "unknownSetting" is not a known setting. Writing anyway.'
		);
		expect(mockWriteSettingValue).toHaveBeenCalledWith('unknownSetting', 'value');
	});

	it('does not warn for unknown keys in JSON mode', () => {
		settingsSet('unknownSetting', 'value', { json: true });

		expect(mockFormatWarning).not.toHaveBeenCalled();
		expect(mockEmitJsonl).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'setting_set',
				key: 'unknownSetting',
				newValue: 'value',
			})
		);
	});

	it('prints formatted errors and exits for invalid raw JSON', () => {
		expect(() => settingsSet('fontSize', 'ignored', { raw: '{bad}' })).toThrow('process.exit(1)');

		expect(mockFormatError).toHaveBeenCalledWith(
			expect.stringContaining('Failed to set "fontSize": Invalid JSON in --raw:')
		);
		expect(processExit).toHaveBeenCalledWith(1);
	});

	it('includes non-Error raw JSON parse failures in formatted errors', () => {
		const parseSpy = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
			throw 'raw parser failed';
		});

		expect(() => settingsSet('fontSize', 'ignored', { raw: '{"value":1}' })).toThrow(
			'process.exit(1)'
		);

		expect(mockFormatError).toHaveBeenCalledWith(
			'Failed to set "fontSize": Invalid JSON in --raw: raw parser failed'
		);
		parseSpy.mockRestore();
	});

	it('prints JSON errors and exits for non-Error storage failures', () => {
		mockWriteSettingValue.mockImplementationOnce(() => {
			throw 'write failed';
		});

		expect(() => settingsSet('fontSize', '16', { json: true })).toThrow('process.exit(1)');

		expect(JSON.parse(consoleError.mock.calls[0][0])).toEqual({ error: 'Unknown error' });
		expect(processExit).toHaveBeenCalledWith(1);
	});
});
