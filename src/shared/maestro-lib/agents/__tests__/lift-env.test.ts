/**
 * Federation lift env rules: non-secret vars always go, secrets only with `--with-env`, and the
 * provider's session-dir selector always goes and must name a dir that exists on the host.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { liftSessionDirProblem, planLiftEnv, providerSessionDirSelector } from '../lift-env';

describe('planLiftEnv', () => {
	const env = {
		CLAUDE_CONFIG_DIR: '/home/me/.claude-work',
		DEBUG: '1',
		ANTHROPIC_API_KEY: 'sk-ant-secret',
		GITHUB_TOKEN: 'ghp_secret',
		ANTHROPIC_AUTH_TYPE: 'oauth',
	};

	it('sends non-secret vars and the selector, and withholds secrets without --with-env', () => {
		expect(planLiftEnv({ provider: 'claude-code', customEnvVars: env, withEnv: false })).toEqual({
			send: {
				CLAUDE_CONFIG_DIR: '/home/me/.claude-work',
				DEBUG: '1',
				ANTHROPIC_AUTH_TYPE: 'oauth',
			},
			secretsSent: [],
			withheld: ['ANTHROPIC_API_KEY', 'GITHUB_TOKEN'],
			sessionDir: { key: 'CLAUDE_CONFIG_DIR', value: '/home/me/.claude-work' },
		});
	});

	it('sends secrets too with --with-env, and names them', () => {
		const plan = planLiftEnv({ provider: 'claude-code', customEnvVars: env, withEnv: true });
		expect(plan.send).toEqual(env);
		expect(plan.secretsSent).toEqual(['ANTHROPIC_API_KEY', 'GITHUB_TOKEN']);
		expect(plan.withheld).toEqual([]);
	});

	it.each([
		['claude-code', 'CLAUDE_CONFIG_DIR'],
		['codex', 'CODEX_HOME'],
		['copilot-cli', 'COPILOT_HOME'],
	])('always sends the %s session-dir selector %s', (provider, key) => {
		const plan = planLiftEnv({ provider, customEnvVars: { [key]: '/d' }, withEnv: false });
		expect(plan.send).toEqual({ [key]: '/d' });
		expect(plan.sessionDir).toEqual({ key, value: '/d' });
	});

	it('treats a selector of another provider as an ordinary var', () => {
		const plan = planLiftEnv({
			provider: 'codex',
			customEnvVars: { CLAUDE_CONFIG_DIR: '/d' },
			withEnv: false,
		});
		expect(plan.send).toEqual({ CLAUDE_CONFIG_DIR: '/d' });
		expect(plan).not.toHaveProperty('sessionDir');
	});

	it('drops blank values and unnamed rows: blank means unset', () => {
		const plan = planLiftEnv({
			provider: 'claude-code',
			customEnvVars: { CLAUDE_CONFIG_DIR: '  ', DEBUG: '', '': 'x', KEEP: 'y' },
			withEnv: true,
		});
		expect(plan.send).toEqual({ KEEP: 'y' });
		expect(plan).not.toHaveProperty('sessionDir');
	});

	it('uses the provider-level set when the agent has no record of its own', () => {
		const plan = planLiftEnv({
			provider: 'codex',
			providerEnvVars: { CODEX_HOME: '/p', OPENAI_API_KEY: 'k' },
			withEnv: false,
		});
		expect(plan.send).toEqual({ CODEX_HOME: '/p' });
		expect(plan.withheld).toEqual(['OPENAI_API_KEY']);
	});

	it('ignores the provider-level set once the agent has a record, even an empty one', () => {
		const plan = planLiftEnv({
			provider: 'codex',
			customEnvVars: {},
			providerEnvVars: { CODEX_HOME: '/p' },
			withEnv: false,
		});
		expect(plan).toEqual({ send: {}, secretsSent: [], withheld: [] });
	});
});

describe('providerSessionDirSelector', () => {
	it('is undefined for a provider with no account dir', () => {
		expect(providerSessionDirSelector('opencode', { XDG_DATA_HOME: '/d' })).toBeUndefined();
	});

	it('is undefined when the env does not set it', () => {
		expect(providerSessionDirSelector('claude-code', undefined)).toBeUndefined();
		expect(providerSessionDirSelector('claude-code', { DEBUG: '1' })).toBeUndefined();
	});
});

describe('liftSessionDirProblem', () => {
	let home: string;

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-lift-env-'));
		fs.mkdirSync(path.join(home, '.claude-work'));
		fs.writeFileSync(path.join(home, 'file'), '');
	});

	afterEach(() => {
		fs.rmSync(home, { recursive: true, force: true });
	});

	it('accepts a selector that names a directory on the host', () => {
		const dir = path.join(home, '.claude-work');
		expect(liftSessionDirProblem('claude-code', { CLAUDE_CONFIG_DIR: dir })).toBeNull();
	});

	it('expands ~ against the host home', () => {
		expect(
			liftSessionDirProblem('claude-code', { CLAUDE_CONFIG_DIR: '~/.claude-work' }, home)
		).toBeNull();
	});

	it('accepts no selector: the default dir is the one the SSH agent used', () => {
		expect(liftSessionDirProblem('claude-code', {})).toBeNull();
		expect(liftSessionDirProblem('opencode', { CLAUDE_CONFIG_DIR: '/nope' })).toBeNull();
	});

	it('refuses a selector naming a missing directory, and says the resume would not happen', () => {
		const missing = path.join(home, 'gone');
		const problem = liftSessionDirProblem('codex', { CODEX_HOME: missing });
		expect(problem).toContain(
			`The provider session directory set by CODEX_HOME does not exist: ${missing}`
		);
		expect(problem).toContain('start a new session instead of resuming');
	});

	it('refuses a selector naming a file', () => {
		const file = path.join(home, 'file');
		expect(liftSessionDirProblem('claude-code', { CLAUDE_CONFIG_DIR: file })).toContain(
			`set by CLAUDE_CONFIG_DIR is not a directory: ${file}`
		);
	});
});
