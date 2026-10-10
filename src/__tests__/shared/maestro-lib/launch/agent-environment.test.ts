/**
 * An agent's environment, per launching surface.
 *
 * Desktop chat, the CLI and Cue each layer it their own way, and the library
 * reproduces each one as it was before the launch plan existed:
 *
 *   desktop  process.env (stripped) < global < defaults < user < read-only
 *   cli      process.env, defaults fill only what the shell left unset
 *              < user < read-only
 *   cue      process.env < defaults < user < read-only
 *
 * `user` is `sessionCustomEnvVars ?? agentCustomEnvVars` everywhere. Each layer
 * is tested against the one directly beneath it, with the same key set at
 * both, so a swapped pair fails here rather than in someone's agent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as os from 'os';
import * as path from 'path';
import {
	buildAgentEnvironment,
	resolveAgentEnvVars,
	type AgentEnvSurface,
} from '../../../../shared/maestro-lib/launch/env';
import { QUERY_SOURCE_ENV_VAR } from '../../../../shared/querySource';

const SURFACES: AgentEnvSurface[] = ['desktop', 'cli', 'cue'];

let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
	savedEnv = { ...process.env };
	process.env.LAYER_KEY = 'from-process';
	process.env.INHERITED_ONLY = 'kept';
	delete process.env.UNSET_KEY;
	delete process.env.MAESTRO_SESSION_RESUMED;
	// An agent shell exports its own config dir, and the inherited environment is
	// the bottom layer here, so it would read as a provider var that survived.
	delete process.env.CLAUDE_CONFIG_DIR;
});

afterEach(() => {
	process.env = savedEnv;
});

describe.each(SURFACES)('buildAgentEnvironment on every surface (%s)', (surface) => {
	it('inherits process.env when nothing overrides it', () => {
		const env = buildAgentEnvironment({ surface });

		expect(env.LAYER_KEY).toBe('from-process');
		expect(env.INHERITED_ONLY).toBe('kept');
	});

	it('provider defaults fill a variable nothing else set', () => {
		const env = buildAgentEnvironment({ surface, defaultEnvVars: { UNSET_KEY: 'from-default' } });

		expect(env.UNSET_KEY).toBe('from-default');
	});

	it('per-provider agent vars override the inherited value and the defaults', () => {
		const env = buildAgentEnvironment({
			surface,
			defaultEnvVars: { LAYER_KEY: 'from-default' },
			agentCustomEnvVars: { LAYER_KEY: 'from-agent' },
		});

		expect(env.LAYER_KEY).toBe('from-agent');
	});

	it('the agent session vars override per-provider vars', () => {
		const env = buildAgentEnvironment({
			surface,
			agentCustomEnvVars: { LAYER_KEY: 'from-agent' },
			sessionCustomEnvVars: { LAYER_KEY: 'from-session' },
		});

		expect(env.LAYER_KEY).toBe('from-session');
	});

	it('session vars REPLACE the provider set rather than layering over it', () => {
		// An agent that sets only an API key must not also receive the
		// provider-level config dir: that is a different account.
		const env = buildAgentEnvironment({
			surface,
			agentCustomEnvVars: { CLAUDE_CONFIG_DIR: '/provider/dir', PROVIDER_ONLY: 'x' },
			sessionCustomEnvVars: { ANTHROPIC_API_KEY: 'sk-session' },
		});

		expect(env.ANTHROPIC_API_KEY).toBe('sk-session');
		expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
		expect(env.PROVIDER_ONLY).toBeUndefined();
	});

	it('an EMPTY session record still replaces the provider set', () => {
		const env = buildAgentEnvironment({
			surface,
			agentCustomEnvVars: { PROVIDER_ONLY: 'x' },
			sessionCustomEnvVars: {},
		});

		expect(env.PROVIDER_ONLY).toBeUndefined();
	});

	it('read-only overrides win over every user layer', () => {
		const env = buildAgentEnvironment({
			surface,
			sessionCustomEnvVars: { OPENCODE_CONFIG_CONTENT: 'session' },
			readOnlyEnvOverrides: { OPENCODE_CONFIG_CONTENT: 'read-only' },
		});

		expect(env.OPENCODE_CONFIG_CONTENT).toBe('read-only');
	});

	it('Maestro-stated vars override the user layers, and the query source is stamped last', () => {
		const env = buildAgentEnvironment({
			surface,
			sessionCustomEnvVars: { MAESTRO_CALLER_AGENT_ID: 'spoofed', [QUERY_SOURCE_ENV_VAR]: 'x' },
			maestroEnvVars: { MAESTRO_CALLER_AGENT_ID: 'agent-1' },
			querySource: 'cue',
		});

		expect(env.MAESTRO_CALLER_AGENT_ID).toBe('agent-1');
		expect(env[QUERY_SOURCE_ENV_VAR]).toBe('cue');
	});

	it('stamps the default query source when the caller names none', () => {
		expect(buildAgentEnvironment({ surface })[QUERY_SOURCE_ENV_VAR]).toBe('user');
	});
});

describe('buildAgentEnvironment: desktop', () => {
	const surface = 'desktop';

	it('global Settings vars override process.env', () => {
		const env = buildAgentEnvironment({
			surface,
			globalShellEnvVars: { LAYER_KEY: 'from-global' },
		});

		expect(env.LAYER_KEY).toBe('from-global');
	});

	it('provider defaults override global Settings vars', () => {
		// The order desktop has always had: a provider default is applied with the
		// agent's own vars, over Settings -> Environment.
		const env = buildAgentEnvironment({
			surface,
			defaultEnvVars: { LAYER_KEY: 'from-default' },
			globalShellEnvVars: { LAYER_KEY: 'from-global' },
		});

		expect(env.LAYER_KEY).toBe('from-default');
	});

	it('provider defaults override an inherited value', () => {
		const env = buildAgentEnvironment({ surface, defaultEnvVars: { LAYER_KEY: 'from-default' } });

		expect(env.LAYER_KEY).toBe('from-default');
	});

	it('per-provider agent vars override global vars', () => {
		const env = buildAgentEnvironment({
			surface,
			globalShellEnvVars: { LAYER_KEY: 'from-global' },
			agentCustomEnvVars: { LAYER_KEY: 'from-agent' },
		});

		expect(env.LAYER_KEY).toBe('from-agent');
	});

	it('global vars still apply underneath the session record', () => {
		const env = buildAgentEnvironment({
			surface,
			globalShellEnvVars: { GLOBAL_ONLY: 'g' },
			sessionCustomEnvVars: { SESSION_ONLY: 's' },
		});

		expect(env.GLOBAL_ONLY).toBe('g');
		expect(env.SESSION_ONLY).toBe('s');
	});

	it('a blank agent value unsets the variable, inherited and global values included', () => {
		const env = buildAgentEnvironment({
			surface,
			globalShellEnvVars: { LAYER_KEY: 'from-global' },
			sessionCustomEnvVars: { LAYER_KEY: '' },
		});

		expect('LAYER_KEY' in env).toBe(false);
	});

	it('a blank global value does not cancel a provider default above it', () => {
		const env = buildAgentEnvironment({
			surface,
			defaultEnvVars: { LAYER_KEY: 'from-default' },
			globalShellEnvVars: { LAYER_KEY: '' },
		});

		expect(env.LAYER_KEY).toBe('from-default');
	});

	it('strips the Electron and IDE vars inherited from Maestro itself', () => {
		process.env.ELECTRON_RUN_AS_NODE = '1';
		process.env.CLAUDECODE = '1';

		const env = buildAgentEnvironment({ surface });

		expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
		expect(env.CLAUDECODE).toBeUndefined();
	});

	it('expands ~/ in every layer', () => {
		const env = buildAgentEnvironment({ surface, defaultEnvVars: { DIR: '~/work' } });

		expect(env.DIR).toBe(path.join(os.homedir(), 'work'));
	});

	it('marks a resumed session', () => {
		expect(buildAgentEnvironment({ surface, isResuming: true }).MAESTRO_SESSION_RESUMED).toBe('1');
		expect(buildAgentEnvironment({ surface }).MAESTRO_SESSION_RESUMED).toBeUndefined();
	});
});

describe('buildAgentEnvironment: cli', () => {
	const surface = 'cli';

	it('a value exported in the shell wins over a provider default', () => {
		// A user who exported the variable in the shell that runs the command
		// keeps it: defaults only fill what the shell left unset.
		const env = buildAgentEnvironment({ surface, defaultEnvVars: { LAYER_KEY: 'from-default' } });

		expect(env.LAYER_KEY).toBe('from-process');
	});

	it('a batch-mode var beats a default for the same key, and both yield to the shell', () => {
		const unset = buildAgentEnvironment({
			surface,
			defaultEnvVars: { UNSET_KEY: 'from-default' },
			batchModeEnvVars: { UNSET_KEY: 'from-batch' },
		});
		const shellSet = buildAgentEnvironment({
			surface,
			batchModeEnvVars: { LAYER_KEY: 'from-batch' },
		});

		expect(unset.UNSET_KEY).toBe('from-batch');
		expect(shellSet.LAYER_KEY).toBe('from-process');
	});

	it('the user vars override the shell, because the user opted into them', () => {
		const env = buildAgentEnvironment({
			surface,
			agentCustomEnvVars: { LAYER_KEY: 'from-agent' },
		});

		expect(env.LAYER_KEY).toBe('from-agent');
	});

	it('does not apply the global Settings vars', () => {
		const env = buildAgentEnvironment({
			surface,
			globalShellEnvVars: { LAYER_KEY: 'from-global', GLOBAL_ONLY: 'g' },
		});

		expect(env.LAYER_KEY).toBe('from-process');
		expect(env.GLOBAL_ONLY).toBeUndefined();
	});

	it('inherits the environment as it is, without stripping', () => {
		process.env.ELECTRON_RUN_AS_NODE = '1';

		expect(buildAgentEnvironment({ surface }).ELECTRON_RUN_AS_NODE).toBe('1');
	});

	it('writes values as given: no ~/ expansion, and a blank value stays blank', () => {
		const env = buildAgentEnvironment({
			surface,
			sessionCustomEnvVars: { DIR: '~/work', LAYER_KEY: '' },
		});

		expect(env.DIR).toBe('~/work');
		expect(env.LAYER_KEY).toBe('');
	});

	it('marks a resumed session, as desktop does', () => {
		expect(buildAgentEnvironment({ surface, isResuming: true }).MAESTRO_SESSION_RESUMED).toBe('1');
		expect(buildAgentEnvironment({ surface }).MAESTRO_SESSION_RESUMED).toBeUndefined();
	});

	it('does not pass a resume marker inherited from the shell to a fresh turn', () => {
		process.env.MAESTRO_SESSION_RESUMED = '1';

		expect(buildAgentEnvironment({ surface }).MAESTRO_SESSION_RESUMED).toBeUndefined();
	});
});

describe('buildAgentEnvironment: cue', () => {
	const surface = 'cue';

	it('provider defaults override an inherited value', () => {
		const env = buildAgentEnvironment({ surface, defaultEnvVars: { LAYER_KEY: 'from-default' } });

		expect(env.LAYER_KEY).toBe('from-default');
	});

	it('does not apply the global Settings vars', () => {
		const env = buildAgentEnvironment({
			surface,
			globalShellEnvVars: { LAYER_KEY: 'from-global', GLOBAL_ONLY: 'g' },
		});

		expect(env.LAYER_KEY).toBe('from-process');
		expect(env.GLOBAL_ONLY).toBeUndefined();
	});

	it('inherits the environment as it is, without stripping', () => {
		process.env.ELECTRON_RUN_AS_NODE = '1';

		expect(buildAgentEnvironment({ surface }).ELECTRON_RUN_AS_NODE).toBe('1');
	});

	it('writes values as given: no ~/ expansion', () => {
		const env = buildAgentEnvironment({ surface, sessionCustomEnvVars: { DIR: '~/work' } });

		expect(env.DIR).toBe('~/work');
	});

	it('does not mark a resumed session', () => {
		expect(
			buildAgentEnvironment({ surface, isResuming: true }).MAESTRO_SESSION_RESUMED
		).toBeUndefined();
	});
});

describe('resolveAgentEnvVars: the record Maestro sets (and sends over SSH)', () => {
	it('returns undefined when no layer sets anything', () => {
		expect(resolveAgentEnvVars({})).toBeUndefined();
	});

	it('merges in tier order without touching process.env', () => {
		const record = resolveAgentEnvVars({
			defaultEnvVars: { A: 'default', B: 'default', C: 'default' },
			batchModeEnvVars: { B: 'batch', C: 'batch' },
			sessionCustomEnvVars: { C: 'session', D: 'session' },
			readOnlyEnvOverrides: { D: 'read-only' },
		});

		expect(record).toEqual({ A: 'default', B: 'batch', C: 'session', D: 'read-only' });
		expect(record).not.toHaveProperty('PATH');
	});

	it('leaves the global Settings vars out of the record', () => {
		expect(
			resolveAgentEnvVars({ defaultEnvVars: { A: 'default' }, globalShellEnvVars: { G: 'global' } })
		).toEqual({ A: 'default' });
		expect(resolveAgentEnvVars({ globalShellEnvVars: { G: 'global' } })).toBeUndefined();
	});

	it('keeps a blank value so it can cancel a lower layer at spawn time', () => {
		expect(
			resolveAgentEnvVars({ defaultEnvVars: { A: 'x' }, sessionCustomEnvVars: { A: '' } })
		).toEqual({ A: '' });
	});

	it('drops an unnamed row', () => {
		expect(resolveAgentEnvVars({ sessionCustomEnvVars: { '  ': 'x', A: 'y' } })).toEqual({
			A: 'y',
		});
	});
});
