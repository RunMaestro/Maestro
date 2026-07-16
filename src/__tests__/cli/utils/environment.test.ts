import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import {
	parseEnvironmentAssignments,
	parseEnvironmentBoolean,
	parsePositiveInteger,
	resolveCliConfigDirectory,
} from '../../../cli/utils/environment';

describe('CLI environment parsing', () => {
	it.each([
		['absent override', {}, path.join('/home/alice', '.config', 'Maestro')],
		[
			'empty override',
			{ MAESTRO_USER_DATA: '', XDG_CONFIG_HOME: '' },
			path.join('/home/alice', '.config', 'Maestro'),
		],
		[
			'custom XDG root',
			{ XDG_CONFIG_HOME: '/custom/config' },
			path.join('/custom/config', 'Maestro'),
		],
		[
			'casing remains explicit for plain records',
			{ xdg_config_home: '/ignored' },
			path.join('/home/alice', '.config', 'Maestro'),
		],
	])('resolves Linux config paths for %s', (_name, env, expected) => {
		expect(
			resolveCliConfigDirectory(env, {
				platform: 'linux',
				home: '/home/alice',
				cwd: process.cwd(),
				appName: 'Maestro',
			})
		).toBe(expected);
	});

	it('honors a non-empty user-data path without trimming it', () => {
		const override = '  relative data  ';

		expect(
			resolveCliConfigDirectory(
				{ MAESTRO_USER_DATA: override },
				{
					platform: 'win32',
					home: 'C:\\Users\\Alice',
					cwd: process.cwd(),
					appName: 'Maestro',
					userDataKey: 'MAESTRO_USER_DATA',
				}
			)
		).toBe(path.resolve(override));
	});

	it.each([
		['true', true],
		['TRUE', true],
		['1', true],
		['yes', true],
		['false', false],
		['False', false],
		['0', false],
		['no', false],
	])('parses compatible boolean values: %s', (value, expected) => {
		expect(parseEnvironmentBoolean(value, '--sync-history-to-remote')).toBe(expected);
	});

	it('retains invalid boolean and positive-integer diagnostics', () => {
		expect(() => parseEnvironmentBoolean('—', '--sync-history-to-remote')).toThrow(
			'--sync-history-to-remote expects true or false, got "—"'
		);
		expect(() => parsePositiveInteger('0', '--context-window')).toThrow(
			'--context-window must be a positive integer'
		);
	});

	it.each([
		['1', 1],
		['16', 16],
		['1.5', 1],
		['1e3', 1],
	])('preserves create-agent positive-integer coercion: %s', (value, expected) => {
		expect(parsePositiveInteger(value, '--context-window')).toBe(expected);
	});

	it('parses repeatable KEY=VALUE assignments without shell evaluation', () => {
		expect(
			parseEnvironmentAssignments([
				'CamelCase=value',
				'EMPTY=',
				'COMMAND=$(not-evaluated)',
				'A=B=C',
			])
		).toEqual({
			CamelCase: 'value',
			EMPTY: '',
			COMMAND: '$(not-evaluated)',
			A: 'B=C',
		});
	});

	it('retains the compatible invalid assignment diagnostic', () => {
		expect(() => parseEnvironmentAssignments(['MISSING_DELIMITER'])).toThrow(
			'Invalid --env format "MISSING_DELIMITER". Expected KEY=VALUE'
		);
	});
});
