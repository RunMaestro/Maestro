/**
 * The five sources of an agent's environment, in the order every surface
 * applies them:
 *
 *   process.env < defaultEnvVars < globalShellEnvVars
 *     < (sessionCustomEnvVars ?? agentCustomEnvVars) < readOnlyEnvOverrides
 *
 * Each layer is tested against the one directly beneath it, with the same key
 * set at both, so a swapped pair fails here rather than in someone's agent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import {
	buildAgentEnvironment,
	resolveAgentEnvVars,
} from '../../../../shared/maestro-lib/launch/env';
import { QUERY_SOURCE_ENV_VAR } from '../../../../shared/querySource';

describe('buildAgentEnvironment: the five layers', () => {
	let savedEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
		process.env.LAYER_KEY = 'from-process';
		process.env.INHERITED_ONLY = 'kept';
	});

	afterEach(() => {
		process.env = savedEnv;
	});

	it('1. inherits process.env when nothing overrides it', () => {
		const env = buildAgentEnvironment({});

		expect(env.LAYER_KEY).toBe('from-process');
		expect(env.INHERITED_ONLY).toBe('kept');
	});

	it('2. provider defaults override process.env', () => {
		const env = buildAgentEnvironment({ defaultEnvVars: { LAYER_KEY: 'from-default' } });

		expect(env.LAYER_KEY).toBe('from-default');
	});

	it('3. global Settings vars override provider defaults', () => {
		const env = buildAgentEnvironment({
			defaultEnvVars: { LAYER_KEY: 'from-default' },
			globalShellEnvVars: { LAYER_KEY: 'from-global' },
		});

		expect(env.LAYER_KEY).toBe('from-global');
	});

	it('4. per-provider agent vars override global vars', () => {
		const env = buildAgentEnvironment({
			defaultEnvVars: { LAYER_KEY: 'from-default' },
			globalShellEnvVars: { LAYER_KEY: 'from-global' },
			agentCustomEnvVars: { LAYER_KEY: 'from-agent' },
		});

		expect(env.LAYER_KEY).toBe('from-agent');
	});

	it('5. the agent session vars override per-provider vars', () => {
		const env = buildAgentEnvironment({
			globalShellEnvVars: { LAYER_KEY: 'from-global' },
			agentCustomEnvVars: { LAYER_KEY: 'from-agent' },
			sessionCustomEnvVars: { LAYER_KEY: 'from-session' },
		});

		expect(env.LAYER_KEY).toBe('from-session');
	});

	it('session vars REPLACE the provider set rather than layering over it', () => {
		// An agent that sets only an API key must not also receive the
		// provider-level config dir: that is a different account.
		const env = buildAgentEnvironment({
			agentCustomEnvVars: { CLAUDE_CONFIG_DIR: '/provider/dir', PROVIDER_ONLY: 'x' },
			sessionCustomEnvVars: { ANTHROPIC_API_KEY: 'sk-session' },
		});

		expect(env.ANTHROPIC_API_KEY).toBe('sk-session');
		expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
		expect(env.PROVIDER_ONLY).toBeUndefined();
	});

	it('an EMPTY session record still replaces the provider set', () => {
		const env = buildAgentEnvironment({
			agentCustomEnvVars: { PROVIDER_ONLY: 'x' },
			sessionCustomEnvVars: {},
		});

		expect(env.PROVIDER_ONLY).toBeUndefined();
	});

	it('global vars still apply underneath the session record', () => {
		const env = buildAgentEnvironment({
			globalShellEnvVars: { GLOBAL_ONLY: 'g' },
			sessionCustomEnvVars: { SESSION_ONLY: 's' },
		});

		expect(env.GLOBAL_ONLY).toBe('g');
		expect(env.SESSION_ONLY).toBe('s');
	});

	it('read-only overrides win over every user layer', () => {
		const env = buildAgentEnvironment({
			globalShellEnvVars: { OPENCODE_CONFIG_CONTENT: 'global' },
			sessionCustomEnvVars: { OPENCODE_CONFIG_CONTENT: 'session' },
			readOnlyEnvOverrides: { OPENCODE_CONFIG_CONTENT: 'read-only' },
		});

		expect(env.OPENCODE_CONFIG_CONTENT).toBe('read-only');
	});

	it('batch-mode vars sit just above the defaults and below global', () => {
		const underGlobal = buildAgentEnvironment({
			defaultEnvVars: { LAYER_KEY: 'from-default' },
			batchModeEnvVars: { LAYER_KEY: 'from-batch' },
		});
		const overBatch = buildAgentEnvironment({
			batchModeEnvVars: { LAYER_KEY: 'from-batch' },
			globalShellEnvVars: { LAYER_KEY: 'from-global' },
		});

		expect(underGlobal.LAYER_KEY).toBe('from-batch');
		expect(overBatch.LAYER_KEY).toBe('from-global');
	});

	it('a blank value at a higher layer unsets the variable, inherited value included', () => {
		const env = buildAgentEnvironment({
			defaultEnvVars: { LAYER_KEY: 'from-default' },
			globalShellEnvVars: { LAYER_KEY: '' },
		});

		expect('LAYER_KEY' in env).toBe(false);
	});

	it('Maestro-stated vars override the user layers, and the query source is stamped last', () => {
		const env = buildAgentEnvironment({
			sessionCustomEnvVars: { MAESTRO_CALLER_AGENT_ID: 'spoofed', [QUERY_SOURCE_ENV_VAR]: 'x' },
			maestroEnvVars: { MAESTRO_CALLER_AGENT_ID: 'agent-1' },
			querySource: 'cue',
		});

		expect(env.MAESTRO_CALLER_AGENT_ID).toBe('agent-1');
		expect(env[QUERY_SOURCE_ENV_VAR]).toBe('cue');
	});

	it('strips the Electron and IDE vars inherited from Maestro itself', () => {
		process.env.ELECTRON_RUN_AS_NODE = '1';
		process.env.CLAUDECODE = '1';

		const env = buildAgentEnvironment({});

		expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
		expect(env.CLAUDECODE).toBeUndefined();
	});

	it('expands ~/ in every layer', () => {
		const env = buildAgentEnvironment({ defaultEnvVars: { DIR: '~/work' } });

		expect(env.DIR).toBe(path.join(os.homedir(), 'work'));
	});

	it('marks a resumed session', () => {
		expect(buildAgentEnvironment({ isResuming: true }).MAESTRO_SESSION_RESUMED).toBe('1');
		expect(buildAgentEnvironment({}).MAESTRO_SESSION_RESUMED).toBeUndefined();
	});
});

describe('resolveAgentEnvVars: the record Maestro sets (and sends over SSH)', () => {
	it('returns undefined when no layer sets anything', () => {
		expect(resolveAgentEnvVars({})).toBeUndefined();
	});

	it('merges in tier order without touching process.env', () => {
		const record = resolveAgentEnvVars({
			defaultEnvVars: { A: 'default', B: 'default' },
			globalShellEnvVars: { B: 'global', C: 'global' },
			sessionCustomEnvVars: { C: 'session' },
		});

		expect(record).toEqual({ A: 'default', B: 'global', C: 'session' });
		expect(record).not.toHaveProperty('PATH');
	});

	it('keeps a blank value so it can cancel a lower layer at spawn time', () => {
		expect(
			resolveAgentEnvVars({ defaultEnvVars: { A: 'x' }, globalShellEnvVars: { A: '' } })
		).toEqual({ A: '' });
	});

	it('drops an unnamed row', () => {
		expect(resolveAgentEnvVars({ globalShellEnvVars: { '  ': 'x', A: 'y' } })).toEqual({ A: 'y' });
	});
});
