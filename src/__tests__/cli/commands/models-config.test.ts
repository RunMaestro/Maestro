/**
 * @file models-config.test.ts
 * @description Tests for `maestro-cli models config show|set`: the download
 * base is read and written through the settings file with the shared validator,
 * so the CLI cannot save a value the app would ignore.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({
	readSettingValue: vi.fn(),
	writeSettingValue: vi.fn(),
}));

import { modelsConfigSet, modelsConfigShow } from '../../../cli/commands/models-config';
import { readSettingValue, writeSettingValue } from '../../../cli/services/storage';
import { ExitCode } from '../../../cli/exit-codes';
import { formatError } from '../../../cli/output/formatter';

const SETTING = 'localModelsDownloadBase';

/** Last JSON line printed to stdout. */
function lastJson(spy: MockInstance): Record<string, unknown> {
	const calls = spy.mock.calls;
	return JSON.parse(calls[calls.length - 1][0] as string);
}

describe('models config command', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
		vi.mocked(readSettingValue).mockReturnValue(undefined);
	});

	describe('show', () => {
		it('reports the default when nothing is stored', () => {
			modelsConfigShow({ json: true });

			expect(readSettingValue).toHaveBeenCalledWith(SETTING);
			expect(lastJson(logSpy)).toEqual({
				success: true,
				downloadBase: 'https://huggingface.co',
				default: 'https://huggingface.co',
				mirror: false,
			});
		});

		it('reports a stored mirror', () => {
			vi.mocked(readSettingValue).mockReturnValue('https://hf-mirror.com/');

			modelsConfigShow({ json: true });

			expect(lastJson(logSpy)).toMatchObject({
				downloadBase: 'https://hf-mirror.com',
				mirror: true,
			});
		});

		it('prints the value and marks the default in text mode', () => {
			modelsConfigShow({});
			expect(logSpy).toHaveBeenCalledWith('download-base: https://huggingface.co (default)');

			vi.mocked(readSettingValue).mockReturnValue('https://hf-mirror.com');
			modelsConfigShow({});
			expect(logSpy).toHaveBeenLastCalledWith('download-base: https://hf-mirror.com');
		});

		it('reads a hand-edited bad value as the default, as the app does', () => {
			vi.mocked(readSettingValue).mockReturnValue('ftp://nope');

			modelsConfigShow({ json: true });

			expect(lastJson(logSpy)).toMatchObject({ downloadBase: 'https://huggingface.co' });
		});
	});

	describe('set', () => {
		it('saves a normalized mirror URL', () => {
			modelsConfigSet('download-base', ' https://hf-mirror.com/ ', { json: true });

			expect(writeSettingValue).toHaveBeenCalledWith(SETTING, 'https://hf-mirror.com');
			expect(lastJson(logSpy)).toEqual({
				success: true,
				downloadBase: 'https://hf-mirror.com',
				mirror: true,
			});
		});

		it('puts the default back for the word default', () => {
			modelsConfigSet('download-base', 'default', { json: true });

			expect(writeSettingValue).toHaveBeenCalledWith(SETTING, 'https://huggingface.co');
			expect(lastJson(logSpy)).toMatchObject({ mirror: false });
		});

		it('refuses a value that is not a usable URL, writing nothing', () => {
			expect(() => modelsConfigSet('download-base', 'ftp://mirror', { json: true })).toThrow(
				'__exit__'
			);

			expect(writeSettingValue).not.toHaveBeenCalled();
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
			expect(lastJson(logSpy)).toMatchObject({ success: false });
		});

		it('refuses credentials in the URL', () => {
			expect(() => modelsConfigSet('download-base', 'https://user:pw@mirror.example', {})).toThrow(
				'__exit__'
			);

			expect(writeSettingValue).not.toHaveBeenCalled();
			expect(errorSpy).toHaveBeenCalledWith(formatError('Do not put credentials in the URL.'));
		});

		it('refuses an unknown key', () => {
			expect(() => modelsConfigSet('mirror', 'https://hf-mirror.com', { json: true })).toThrow(
				'__exit__'
			);

			expect(writeSettingValue).not.toHaveBeenCalled();
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		});
	});
});
