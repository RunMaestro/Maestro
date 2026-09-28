/**
 * @file child-env.test.ts
 * @description Tests for src/maestro-p/child-env.ts - the environment maestro-p
 * hands the claude TUI it spawns.
 */

import * as os from 'os';
import { describe, expect, it, vi } from 'vitest';

import { buildChildEnv, CLAUDE_SESSION_IDENTITY_ENV_VARS } from '../../maestro-p/child-env';

const posix = { platform: 'darwin' as const, loginName: () => 'alice' };

describe('buildChildEnv', () => {
	it('strips every Claude session identity marker and keeps auth and config', () => {
		const parent: NodeJS.ProcessEnv = {
			USER: 'alice',
			LOGNAME: 'alice',
			CLAUDE_CONFIG_DIR: '/cfg',
			ANTHROPIC_MODEL: 'fable',
			MAESTRO_CLAUDE_BIN: '/bin/claude',
		};
		for (const key of CLAUDE_SESSION_IDENTITY_ENV_VARS) parent[key] = 'x';

		const env = buildChildEnv(parent, posix);

		for (const key of CLAUDE_SESSION_IDENTITY_ENV_VARS) expect(env).not.toHaveProperty(key);
		expect(env.CLAUDE_CONFIG_DIR).toBe('/cfg');
		expect(env.ANTHROPIC_MODEL).toBe('fable');
		expect(env.MAESTRO_CLAUDE_BIN).toBe('/bin/claude');
	});

	// #1577: with USER unset, claude misses its keychain login and starts on API
	// Usage Billing. `env -i` wrappers, launchd jobs, and cron all hit this.
	it('fills USER and LOGNAME from the OS account when the caller left them unset', () => {
		const env = buildChildEnv({ HOME: '/Users/alice', PATH: '/usr/bin:/bin' }, posix);
		expect(env.USER).toBe('alice');
		expect(env.LOGNAME).toBe('alice');
	});

	it('treats a blank login name as unset', () => {
		const env = buildChildEnv({ USER: '', LOGNAME: '  ' }, posix);
		expect(env.USER).toBe('alice');
		expect(env.LOGNAME).toBe('alice');
	});

	it('never overwrites a login name the caller set', () => {
		const env = buildChildEnv({ USER: 'bob' }, posix);
		expect(env.USER).toBe('bob');
		expect(env.LOGNAME).toBe('alice');
	});

	it('does not read the OS account when both names are already set', () => {
		const loginName = vi.fn(() => 'alice');
		const env = buildChildEnv({ USER: 'bob', LOGNAME: 'bob' }, { platform: 'linux', loginName });
		expect(loginName).not.toHaveBeenCalled();
		expect(env.USER).toBe('bob');
	});

	it('leaves the login name unset when the OS account cannot be read', () => {
		const env = buildChildEnv({ HOME: '/' }, { platform: 'linux', loginName: () => undefined });
		expect(env).not.toHaveProperty('USER');
		expect(env).not.toHaveProperty('LOGNAME');
	});

	it('does not add USER on Windows, which names the account in USERNAME', () => {
		const env = buildChildEnv(
			{ USERNAME: 'alice' },
			{ platform: 'win32', loginName: () => 'alice' }
		);
		expect(env).not.toHaveProperty('USER');
		expect(env).not.toHaveProperty('LOGNAME');
	});

	it('does not mutate the parent environment', () => {
		const parent: NodeJS.ProcessEnv = { CLAUDECODE: '1' };
		buildChildEnv(parent, posix);
		expect(parent).toEqual({ CLAUDECODE: '1' });
	});

	it('reads the real OS account by default', () => {
		const env = buildChildEnv({ PATH: '/usr/bin' }, { platform: 'linux' });
		expect(env.USER).toBe(os.userInfo().username);
	});
});
