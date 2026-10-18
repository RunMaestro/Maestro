/**
 * `--data-dir` is applied by writing MAESTRO_USER_DATA, because every reader
 * of the data directory resolves it from there. These pin the precedence and
 * the path resolution; `data-dir-guard.test.ts` covers the commands.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import { applyDataDirOption, describeDataDirSource } from '../../../cli/services/data-dir-option';

afterEach(() => vi.restoreAllMocks());

describe('applyDataDirOption', () => {
	it('sets MAESTRO_USER_DATA from the flag, overriding an inherited value', () => {
		const env: NodeJS.ProcessEnv = { MAESTRO_USER_DATA: '/srv/old' };
		const result = applyDataDirOption('/srv/maestro', env);
		expect(result).toEqual({ dir: path.resolve('/srv/maestro'), source: 'flag' });
		expect(env.MAESTRO_USER_DATA).toBe(path.resolve('/srv/maestro'));
	});

	it('expands a leading ~ and resolves relative paths against the working directory', () => {
		const env: NodeJS.ProcessEnv = {};
		expect(applyDataDirOption('~/maestro-data', env).dir).toBe(
			path.join(os.homedir(), 'maestro-data')
		);
		vi.spyOn(process, 'cwd').mockReturnValue(path.resolve('/work'));
		expect(applyDataDirOption('data', env).dir).toBe(path.resolve('/work', 'data'));
	});

	it('leaves the environment alone without the flag and reports where the dir came from', () => {
		const env: NodeJS.ProcessEnv = { MAESTRO_USER_DATA: '/srv/env' };
		expect(applyDataDirOption(undefined, env)).toEqual({
			dir: path.resolve('/srv/env'),
			source: 'env',
		});
		expect(env.MAESTRO_USER_DATA).toBe('/srv/env');
		expect(applyDataDirOption('  ', env).source).toBe('env');
		expect(applyDataDirOption(undefined, {}).source).toBe('default');
	});

	it('names each source for the startup log line', () => {
		expect(describeDataDirSource('flag')).toBe('--data-dir');
		expect(describeDataDirSource('env')).toBe('MAESTRO_USER_DATA');
		expect(describeDataDirSource('default')).toBe('platform default');
	});
});
