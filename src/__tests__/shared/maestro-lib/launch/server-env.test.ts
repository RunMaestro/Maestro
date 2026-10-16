/**
 * Tests for the server-mode environment allowlist (`filterServerProcessEnv`
 * and its use by the Cue agent environment in `env.ts`).
 *
 * The point of the allowlist is that an agent prompted by third-party text on
 * a shared server cannot read the engine's own secrets back out of its
 * environment, so most cases here assert that something is DROPPED.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	buildAgentEnvironment,
	filterServerProcessEnv,
	isServerModeActive,
	SERVER_ENV_ALLOW_ENV_VAR,
	SERVER_MODE_ENV_VAR,
} from '../../../../shared/maestro-lib/launch/env';
import { QUERY_SOURCE_ENV_VAR } from '../../../../shared/querySource';
import { CALLER_AGENT_ID_ENV_VAR, CALLER_TAB_ID_ENV_VAR } from '../../../../shared/agentDelegation';

const ENGINE_SECRETS = {
	ODIN_API_TOKEN: 'odin-secret',
	CUE_WEBHOOK_SECRET: 'whsec-123',
	GITHUB_WEBHOOK_SECRET: 'gh-whsec',
	AWS_SECRET_ACCESS_KEY: 'aws-secret',
	DATABASE_URL: 'postgres://user:pass@db/prod',
};

describe('filterServerProcessEnv', () => {
	const originalAllow = process.env[SERVER_ENV_ALLOW_ENV_VAR];

	afterEach(() => {
		if (originalAllow === undefined) delete process.env[SERVER_ENV_ALLOW_ENV_VAR];
		else process.env[SERVER_ENV_ALLOW_ENV_VAR] = originalAllow;
	});

	it('drops engine secrets and anything else not on the allowlist', () => {
		const filtered = filterServerProcessEnv({ ...ENGINE_SECRETS, RANDOM_VAR: 'x', PATH: '/bin' });
		for (const key of Object.keys(ENGINE_SECRETS)) expect(filtered).not.toHaveProperty(key);
		expect(filtered).not.toHaveProperty('RANDOM_VAR');
		expect(filtered.PATH).toBe('/bin');
	});

	it('keeps essential system variables and the LC_/XDG_/SSH_ families', () => {
		const env = {
			PATH: '/bin',
			HOME: '/home/cue',
			USER: 'cue',
			LOGNAME: 'cue',
			SHELL: '/bin/bash',
			LANG: 'C.UTF-8',
			LC_ALL: 'C.UTF-8',
			TERM: 'xterm',
			TMPDIR: '/tmp',
			XDG_CONFIG_HOME: '/home/cue/.config',
			SSH_AUTH_SOCK: '/tmp/agent.sock',
		};
		expect(filterServerProcessEnv(env)).toEqual(env);
	});

	it('keeps proxy and TLS trust variables, in either case', () => {
		const env = {
			HTTP_PROXY: 'http://proxy:3128',
			https_proxy: 'http://proxy:3128',
			ALL_PROXY: 'socks5://proxy',
			NO_PROXY: 'localhost',
			SSL_CERT_FILE: '/etc/ssl/cert.pem',
			SSL_CERT_DIR: '/etc/ssl/certs',
			NODE_EXTRA_CA_CERTS: '/etc/ssl/corp.pem',
			REQUESTS_CA_BUNDLE: '/etc/ssl/corp.pem',
		};
		expect(filterServerProcessEnv(env)).toEqual(env);
	});

	it('keeps common toolchain variables', () => {
		const env = {
			NVM_DIR: '/home/cue/.nvm',
			JAVA_HOME: '/usr/lib/jvm',
			GOPATH: '/home/cue/go',
			CARGO_HOME: '/home/cue/.cargo',
			PYTHONPATH: '/opt/lib',
			DENO_INSTALL_ROOT: '/home/cue/.deno',
		};
		expect(filterServerProcessEnv(env)).toEqual(env);
	});

	it('keeps every provider variable from the env catalog', () => {
		const env = {
			ANTHROPIC_API_KEY: 'sk-ant',
			OPENAI_API_KEY: 'sk-oai',
			CLAUDE_CONFIG_DIR: '/home/cue/.claude-work',
			CODEX_HOME: '/home/cue/.codex',
			GH_TOKEN: 'ghp_x',
			FACTORY_API_KEY: 'fk',
		};
		expect(filterServerProcessEnv(env)).toEqual(env);
	});

	it('keeps MAESTRO_* except the caller identity and query source', () => {
		const filtered = filterServerProcessEnv({
			MAESTRO_USER_DATA: '/data',
			MAESTRO_CUE_WEBHOOK_PORT: '8787',
			[CALLER_AGENT_ID_ENV_VAR]: 'agent-1',
			[CALLER_TAB_ID_ENV_VAR]: 'tab-1',
			[QUERY_SOURCE_ENV_VAR]: 'user',
		});
		expect(filtered).toEqual({ MAESTRO_USER_DATA: '/data', MAESTRO_CUE_WEBHOOK_PORT: '8787' });
	});

	it('lets operator-named variables through MAESTRO_SERVER_ENV_ALLOW', () => {
		process.env[SERVER_ENV_ALLOW_ENV_VAR] = ' NPM_TOKEN , COMPANY_REGISTRY,, ';
		const filtered = filterServerProcessEnv({
			NPM_TOKEN: 'npm',
			COMPANY_REGISTRY: 'https://registry',
			ODIN_API_TOKEN: 'odin-secret',
		});
		expect(filtered).toEqual({ NPM_TOKEN: 'npm', COMPANY_REGISTRY: 'https://registry' });
	});
});

describe('isServerModeActive', () => {
	const original = process.env[SERVER_MODE_ENV_VAR];
	afterEach(() => {
		if (original === undefined) delete process.env[SERVER_MODE_ENV_VAR];
		else process.env[SERVER_MODE_ENV_VAR] = original;
	});

	it('is off by default, so a standalone run on a laptop keeps its environment', () => {
		delete process.env[SERVER_MODE_ENV_VAR];
		expect(isServerModeActive()).toBe(false);
		expect(isServerModeActive(false)).toBe(false);
	});

	it('is on when the caller says so or MAESTRO_SERVER_MODE=1', () => {
		delete process.env[SERVER_MODE_ENV_VAR];
		expect(isServerModeActive(true)).toBe(true);
		process.env[SERVER_MODE_ENV_VAR] = '1';
		expect(isServerModeActive()).toBe(true);
		process.env[SERVER_MODE_ENV_VAR] = 'true';
		expect(isServerModeActive()).toBe(false);
	});
});

describe('Cue agent environment in server mode', () => {
	const saved: Record<string, string | undefined> = {};
	const keys = [...Object.keys(ENGINE_SECRETS), 'ANTHROPIC_API_KEY', SERVER_MODE_ENV_VAR];

	beforeEach(() => {
		for (const key of keys) saved[key] = process.env[key];
		Object.assign(process.env, ENGINE_SECRETS, { ANTHROPIC_API_KEY: 'sk-ant' });
		delete process.env[SERVER_MODE_ENV_VAR];
	});

	afterEach(() => {
		for (const key of keys) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	});

	it('inherits everything outside server mode', () => {
		const env = buildAgentEnvironment({ surface: 'cue' });
		expect(env.ODIN_API_TOKEN).toBe('odin-secret');
	});

	it('drops engine secrets but keeps provider keys and the layers Maestro sets', () => {
		const env = buildAgentEnvironment({
			surface: 'cue',
			isServerMode: true,
			defaultEnvVars: { PROVIDER_DEFAULT: 'on' },
			sessionCustomEnvVars: { MY_AGENT_VAR: 'mine' },
			querySource: 'cue',
		});
		for (const key of Object.keys(ENGINE_SECRETS)) expect(env).not.toHaveProperty(key);
		expect(env.ANTHROPIC_API_KEY).toBe('sk-ant');
		expect(env.PROVIDER_DEFAULT).toBe('on');
		expect(env.MY_AGENT_VAR).toBe('mine');
		expect(env[QUERY_SOURCE_ENV_VAR]).toBe('cue');
		expect(env.PATH).toBeTruthy();
	});

	it('applies the allowlist when MAESTRO_SERVER_MODE=1 without the option', () => {
		process.env[SERVER_MODE_ENV_VAR] = '1';
		const env = buildAgentEnvironment({ surface: 'cue' });
		expect(env).not.toHaveProperty('ODIN_API_TOKEN');
	});

	it('leaves the desktop and CLI surfaces untouched', () => {
		process.env[SERVER_MODE_ENV_VAR] = '1';
		expect(buildAgentEnvironment({ surface: 'cli' }).ODIN_API_TOKEN).toBe('odin-secret');
	});
});
