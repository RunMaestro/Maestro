/**
 * Declared secrets (`requiredSecrets`) in the launch plan: resolved for the
 * agent that declared them and no other, on the CLI and Cue surfaces only,
 * into the spawn environment and never into `envVars` (which is shown in
 * Process Details and crosses to an SSH remote).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	buildAgentLaunchPlan,
	describeUndeliveredSecrets,
	type AgentLaunchInput,
	type AgentLaunchPlan,
} from '../../../../shared/maestro-lib/launch/launch-plan';
import {
	getAgentDefinition,
	GROK_COMPAT_ISOLATION_ENV_VARS,
} from '../../../../shared/maestro-lib/providers/definitions';
import { getAgentCapabilities } from '../../../../shared/maestro-lib/providers/capabilities';
import type { SshRemoteConfig } from '../../../../shared/types';

const SENTINEL = 'sentinel-7f3a91c2-do-not-leak';

let tmp: string;
let runSecrets: string;
let savedEnv: NodeJS.ProcessEnv;

beforeEach(() => {
	tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'launch-plan-secrets-')));
	runSecrets = path.join(tmp, 'run-secrets');
	fs.mkdirSync(runSecrets);
	fs.writeFileSync(path.join(runSecrets, 'GITHUB_TOKEN'), `${SENTINEL}\n`);
	savedEnv = { ...process.env };
	// An engine secret no agent declared, and an unrelated engine variable.
	process.env.ENGINE_ONLY_SECRET = 'engine-only';
	process.env.UNRELATED_ENGINE_VAR = 'unrelated';
	delete process.env.MAESTRO_SERVER_MODE;
	delete process.env.GITHUB_TOKEN;
});

afterEach(() => {
	process.env = savedEnv;
	fs.rmSync(tmp, { recursive: true, force: true });
});

function input(overrides: Partial<AgentLaunchInput> = {}): AgentLaunchInput {
	return {
		surface: 'cue',
		agent: { ...getAgentDefinition('codex'), capabilities: getAgentCapabilities('codex') },
		command: '/usr/local/bin/codex',
		args: ['exec', '--json'],
		cwd: '/project',
		prompt: 'fix the bug',
		isWindowsHost: false,
		secretLookup: { env: {}, runSecretsDir: runSecrets },
		...overrides,
	};
}

function plan(overrides: Partial<AgentLaunchInput> = {}): AgentLaunchPlan {
	const result = buildAgentLaunchPlan(input(overrides));
	if (!result.ok) throw new Error(result.error);
	return result.plan;
}

describe('declared secrets under server mode (Cue)', () => {
	it('reach the agent that declared them even though they are not allowlisted', () => {
		const p = plan({ isServerMode: true, requiredSecrets: ['GITHUB_TOKEN'] });
		expect(p.env?.GITHUB_TOKEN).toBe(SENTINEL);
		expect(p.secrets).toEqual({
			injected: [{ name: 'GITHUB_TOKEN', source: 'run-secrets' }],
			missing: [],
			unusable: [],
			notDeliveredToRemote: [],
		});
	});

	it('keep the rest of the engine environment out', () => {
		const p = plan({ isServerMode: true, requiredSecrets: ['GITHUB_TOKEN'] });
		expect(p.env?.ENGINE_ONLY_SECRET).toBeUndefined();
		expect(p.env?.UNRELATED_ENGINE_VAR).toBeUndefined();
	});

	it('are not given to an agent that did not declare them', () => {
		const p = plan({ isServerMode: true });
		expect(p.env?.GITHUB_TOKEN).toBeUndefined();
		expect(p.secrets).toBeUndefined();
	});

	it('never appear in envVars, the record that is shown and sent to remotes', () => {
		const p = plan({ isServerMode: true, requiredSecrets: ['GITHUB_TOKEN'] });
		expect(JSON.stringify(p.envVars ?? {})).not.toContain(SENTINEL);
		const { env: _env, ...rest } = p;
		expect(JSON.stringify(rest)).not.toContain(SENTINEL);
	});

	it('lose to a value the agent record sets for the same name', () => {
		const p = plan({
			isServerMode: true,
			requiredSecrets: ['GITHUB_TOKEN'],
			sessionCustomEnvVars: { GITHUB_TOKEN: 'set-on-the-agent' },
		});
		expect(p.env?.GITHUB_TOKEN).toBe('set-on-the-agent');
	});

	it('never touch process.env', () => {
		plan({ isServerMode: true, requiredSecrets: ['GITHUB_TOKEN'] });
		expect(process.env.GITHUB_TOKEN).toBeUndefined();
	});

	it('report a missing secret by name', () => {
		const p = plan({ isServerMode: true, requiredSecrets: ['GITHUB_TOKEN', 'NPM_TOKEN'] });
		expect(p.secrets?.missing).toEqual(['NPM_TOKEN']);
		const warning = describeUndeliveredSecrets('Deployer', p.secrets);
		expect(warning).toContain('Agent "Deployer" requires secrets it did not receive');
		expect(warning).toContain('NPM_TOKEN');
		expect(warning).not.toContain(SENTINEL);
		expect(
			describeUndeliveredSecrets('Deployer', plan({ requiredSecrets: ['GITHUB_TOKEN'] }).secrets)
		).toBeUndefined();
	});
});

describe('declared secrets on the CLI surface', () => {
	it('win over the same name exported in the shell (files before environment)', () => {
		process.env.GITHUB_TOKEN = 'stale-shell-value';
		const p = plan({ surface: 'cli', requiredSecrets: ['GITHUB_TOKEN'] });
		expect(p.env?.GITHUB_TOKEN).toBe(SENTINEL);
	});

	it('are not overwritten by provider defaults, which only fill unset names', () => {
		const p = plan({
			surface: 'cli',
			requiredSecrets: ['GITHUB_TOKEN'],
			agent: {
				...getAgentDefinition('codex'),
				capabilities: getAgentCapabilities('codex'),
				defaultEnvVars: { GITHUB_TOKEN: 'provider-default' },
			},
		});
		expect(p.env?.GITHUB_TOKEN).toBe(SENTINEL);
	});

	it('are not given to an agent that did not declare them', () => {
		expect(plan({ surface: 'cli' }).env?.GITHUB_TOKEN).toBeUndefined();
	});
});

describe('surfaces that never read secret files', () => {
	it('desktop ignores requiredSecrets entirely', () => {
		const p = plan({ surface: 'desktop', requiredSecrets: ['GITHUB_TOKEN'] });
		expect(p.env?.GITHUB_TOKEN).toBeUndefined();
		expect(p.secrets).toBeUndefined();
	});

	it('an SSH remote gets no value, and the plan says so', () => {
		const remote = {
			id: 'remote-1',
			name: 'Build Box',
			host: 'build.example.com',
			port: 22,
			username: 'dev',
			privateKeyPath: '',
			enabled: true,
		} as SshRemoteConfig;
		const p = plan({
			requiredSecrets: ['GITHUB_TOKEN'],
			sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			sshStore: { getSshRemotes: () => [remote] },
		});
		expect(p.target.kind).toBe('remote');
		expect(JSON.stringify(p)).not.toContain(SENTINEL);
		expect(p.secrets?.notDeliveredToRemote).toEqual(['GITHUB_TOKEN']);
	});
});

// Grok declared secrets and account homes in generated plans (not a native
// process smoke; live remote and native evidence is not claimed here).
describe('Grok secrets and account homes (generated plans)', () => {
	const grok = { ...getAgentDefinition('grok'), capabilities: getAgentCapabilities('grok') };
	const sshRemote = {
		id: 'remote-1',
		name: 'Build Box',
		host: 'build.example.com',
		port: 22,
		username: 'dev',
		privateKeyPath: '',
		enabled: true,
	} as SshRemoteConfig;
	const grokInput = (overrides: Partial<AgentLaunchInput> = {}) =>
		input({ agent: grok, command: '/opt/grok', args: [], prompt: 'review it', ...overrides });

	it.each(['cue', 'cli'] as const)(
		'%s: a declared secret reaches the env only, never envVars, argv or the prompt file',
		(surface) => {
			const p = plan(
				grokInput({
					surface,
					isServerMode: surface === 'cue',
					requiredSecrets: ['GITHUB_TOKEN'],
					sessionCustomEnvVars: { GROK_HOME: '/accounts/a' },
				})
			);
			expect(p.env?.GITHUB_TOKEN).toBe(SENTINEL);
			expect(p.env?.GROK_HOME).toBe('/accounts/a');
			expect(p.envVars).toEqual({ ...GROK_COMPAT_ISOLATION_ENV_VARS, GROK_HOME: '/accounts/a' });
			const { env: _env, ...shown } = p;
			expect(JSON.stringify(shown)).not.toContain(SENTINEL);
			if (p.prompt.via !== 'file') throw new Error('expected Grok prompt file');
			expect(p.prompt.artifact.content).not.toContain(SENTINEL);
		}
	);

	it('an SSH remote gets neither the secret value nor a local account home', () => {
		process.env.GROK_HOME = '/local/shell/home';
		const p = plan(
			grokInput({
				requiredSecrets: ['GITHUB_TOKEN'],
				sessionCustomEnvVars: { GROK_HOME: '/remote/accounts/b' },
				sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				sshStore: { getSshRemotes: () => [sshRemote] },
				promptFileDestination: {
					owner: 'remote',
					path: '/remote/tmp/p.json',
					sshRemoteId: 'remote-1',
				},
			})
		);
		expect(p.target.kind).toBe('remote');
		expect(p.env).toBeUndefined();
		expect(p.envVars).toEqual({
			...GROK_COMPAT_ISOLATION_ENV_VARS,
			GROK_HOME: '/remote/accounts/b',
		});
		expect(p.secrets?.notDeliveredToRemote).toEqual(['GITHUB_TOKEN']);
		expect(JSON.stringify(p)).not.toContain(SENTINEL);
		expect(JSON.stringify(p)).not.toContain('/local/shell/home');
	});

	it('two accounts plan separate homes with nothing copied between them', () => {
		const a = plan(
			grokInput({ sessionCustomEnvVars: { GROK_HOME: '/accounts/a', XAI_API_KEY: 'key-a' } })
		);
		const b = plan(grokInput({ sessionCustomEnvVars: { GROK_HOME: '/accounts/b' } }));
		expect(a.env?.GROK_HOME).toBe('/accounts/a');
		expect(b.env?.GROK_HOME).toBe('/accounts/b');
		expect(JSON.stringify(b)).not.toContain('key-a');
		expect(JSON.stringify(b)).not.toContain('/accounts/a');
	});

	it('a refused prompt reports no secret, prompt text or path', () => {
		const result = buildAgentLaunchPlan(
			grokInput({
				surface: 'cli',
				requiredSecrets: ['GITHUB_TOKEN'],
				prompt: 'private-\uDC00-text',
				promptFileDestination: { owner: 'local', path: path.join(tmp, 'p.json') },
			})
		);
		expect(result).toMatchObject({ ok: false, reason: 'prompt-delivery-refused' });
		const shown = JSON.stringify(result);
		expect(shown).not.toContain(SENTINEL);
		expect(shown).not.toContain('private-');
		expect(shown).not.toContain(tmp);
		expect(fs.existsSync(path.join(tmp, 'p.json'))).toBe(false);
	});
});
