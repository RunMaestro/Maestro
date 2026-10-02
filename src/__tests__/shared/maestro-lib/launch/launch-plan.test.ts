import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	buildAgentLaunchPlan,
	type AgentLaunchInput,
} from '../../../../shared/maestro-lib/launch/launch-plan';
import { resolveSshLaunchTarget } from '../../../../shared/maestro-lib/launch/ssh-remote-resolver';
import { getAgentDefinition } from '../../../../shared/maestro-lib/providers/definitions';
import { getAgentCapabilities } from '../../../../shared/maestro-lib/providers/capabilities';
import type { SshRemoteConfig } from '../../../../shared/types';

function remote(overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig {
	return {
		id: 'remote-1',
		name: 'Build Box',
		host: 'build.example.com',
		port: 22,
		username: 'dev',
		privateKeyPath: '',
		enabled: true,
		...overrides,
	} as SshRemoteConfig;
}

function storeWith(...remotes: SshRemoteConfig[]) {
	return { getSshRemotes: () => remotes };
}

function codex(): AgentLaunchInput['agent'] {
	return { ...getAgentDefinition('codex'), capabilities: getAgentCapabilities('codex') };
}

function input(overrides: Partial<AgentLaunchInput> = {}): AgentLaunchInput {
	return {
		surface: 'desktop',
		agent: codex(),
		command: '/usr/local/bin/codex',
		args: ['exec', '--json'],
		cwd: '/project',
		prompt: 'fix the bug',
		isWindowsHost: false,
		...overrides,
	};
}

describe('resolveSshLaunchTarget: an unusable remote is an error, never a local run', () => {
	it('is local when SSH is off or unset', () => {
		expect(resolveSshLaunchTarget(storeWith(remote()), undefined)).toEqual({ kind: 'local' });
		expect(
			resolveSshLaunchTarget(storeWith(remote()), { enabled: false, remoteId: 'remote-1' })
		).toEqual({ kind: 'local' });
	});

	it('resolves an enabled remote', () => {
		const target = resolveSshLaunchTarget(storeWith(remote()), {
			enabled: true,
			remoteId: 'remote-1',
		});

		expect(target.kind).toBe('remote');
	});

	it.each([
		[
			'no remote is selected',
			storeWith(remote()),
			{ enabled: true, remoteId: null },
			'no-remote-selected',
			'no remote is selected',
		],
		[
			'the remote was deleted',
			storeWith(),
			{ enabled: true, remoteId: 'remote-1' },
			'remote-not-found',
			'"remote-1" no longer exists',
		],
		[
			'the remote is disabled',
			storeWith(remote({ enabled: false })),
			{ enabled: true, remoteId: 'remote-1' },
			'remote-disabled',
			'"Build Box" is disabled',
		],
		[
			'there is no remote list to look it up in',
			undefined,
			{ enabled: true, remoteId: 'remote-1' },
			'no-remote-store',
			'cannot be looked up',
		],
	])('fails with a specific message when %s', (_case, store, config, reason, fragment) => {
		const target = resolveSshLaunchTarget(store, config);

		expect(target).toMatchObject({ kind: 'unresolved', reason });
		if (target.kind !== 'unresolved') throw new Error('expected unresolved');
		expect(target.message).toContain(fragment);
		expect(target.message).toContain('nothing ran on this machine');
	});
});

describe('buildAgentLaunchPlan', () => {
	let savedEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		savedEnv = { ...process.env };
	});

	afterEach(() => {
		process.env = savedEnv;
	});

	it('fails before planning anything when the SSH remote cannot be resolved', () => {
		const result = buildAgentLaunchPlan(
			input({ sshRemoteConfig: { enabled: true, remoteId: 'gone' }, sshStore: storeWith() })
		);

		expect(result).toMatchObject({ ok: false, reason: 'remote-not-found' });
		if (result.ok) throw new Error('expected failure');
		expect(result.error).toContain('"gone" no longer exists');
	});

	it('plans a local launch: command, argv prompt, cwd and the full environment', () => {
		process.env.FROM_PROCESS = 'yes';
		const result = buildAgentLaunchPlan(
			input({
				globalShellEnvVars: { GLOBAL: 'g' },
				sessionCustomEnvVars: { SESSION: 's' },
				querySource: 'auto',
			})
		);

		if (!result.ok) throw new Error(result.error);
		const { plan } = result;
		expect(plan.target).toEqual({ kind: 'local' });
		expect(plan.command).toBe('/usr/local/bin/codex');
		expect(plan.args).toEqual(['exec', '--json', '--', 'fix the bug']);
		expect(plan.cwd).toBe('/project');
		expect(plan.prompt.via).toBe('argv');
		expect(plan.stdin).toBeUndefined();
		expect(plan.env?.FROM_PROCESS).toBe('yes');
		expect(plan.env?.GLOBAL).toBe('g');
		expect(plan.env?.SESSION).toBe('s');
		expect(plan.env?.MAESTRO_QUERY_SOURCE).toBe('auto');
		// The global Settings vars reach the local process but are not part of
		// the record Maestro sets: that record also crosses to an SSH remote.
		expect(plan.envVars).toEqual({ SESSION: 's' });
	});

	it('builds the environment by the rules of the launching surface', () => {
		process.env.SHELL_SET = 'from-shell';
		const agent = { defaultEnvVars: { SHELL_SET: 'from-default' } };
		const planned = (surface: AgentLaunchInput['surface']) => {
			const result = buildAgentLaunchPlan(
				input({ surface, agent, globalShellEnvVars: { GLOBAL: 'g' } })
			);
			if (!result.ok) throw new Error(result.error);
			return result.plan.env;
		};

		// Desktop and Cue put a provider default over the inherited value; the
		// CLI lets the shell that ran the command keep its own.
		expect(planned('desktop')?.SHELL_SET).toBe('from-default');
		expect(planned('cue')?.SHELL_SET).toBe('from-default');
		expect(planned('cli')?.SHELL_SET).toBe('from-shell');
		// Settings -> Environment is a desktop layer.
		expect(planned('desktop')?.GLOBAL).toBe('g');
		expect(planned('cue')?.GLOBAL).toBeUndefined();
		expect(planned('cli')?.GLOBAL).toBeUndefined();
	});

	it('plans stdin delivery on a Windows host: prompt on stdin, not in argv', () => {
		const result = buildAgentLaunchPlan(input({ isWindowsHost: true }));

		if (!result.ok) throw new Error(result.error);
		expect(result.plan.args).toEqual(['exec', '--json']);
		expect(result.plan.prompt).toEqual({ via: 'stdin', format: 'raw', args: [] });
		expect(result.plan.stdin).toBe('fix the bug');
	});

	it.each(['cli', 'cue'] as const)(
		'keeps the prompt on the command line on a Windows host for the %s surface',
		(surface) => {
			const result = buildAgentLaunchPlan(input({ surface, isWindowsHost: true }));

			if (!result.ok) throw new Error(result.error);
			expect(result.plan.args).toEqual(['exec', '--json', '--', 'fix the bug']);
			expect(result.plan.prompt.via).toBe('argv');
			expect(result.plan.stdin).toBeUndefined();
		}
	);

	it('plans a remote launch: bare binary name, no local env, remote env record', () => {
		const result = buildAgentLaunchPlan(
			input({
				sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				sshStore: storeWith(remote()),
				globalShellEnvVars: { GLOBAL: 'g' },
				sessionCustomEnvVars: { SESSION: 's' },
				readOnlyMode: true,
			})
		);

		if (!result.ok) throw new Error(result.error);
		const { plan } = result;
		expect(plan.target.kind).toBe('remote');
		expect(plan.command).toBe('codex');
		// The SSH wrapper places the prompt; the plan does not.
		expect(plan.args).toEqual(['exec', '--json']);
		expect(plan.prompt).toEqual({ via: 'ssh' });
		expect(plan.env).toBeUndefined();
		// Settings -> Environment is not in the plan's record. (Desktop's SSH
		// wrapper still merges it beneath this record on the remote, as `rc` does.)
		expect(plan.envVars).toEqual({ SESSION: 's' });
	});

	it('applies the provider defaults, batch vars and read-only overrides from the definition', () => {
		const agent = {
			defaultEnvVars: { A: 'default' },
			batchModeEnvVars: { B: 'batch' },
			readOnlyEnvOverrides: { A: 'read-only' },
		};

		const batch = buildAgentLaunchPlan(input({ agent, batchMode: true }));
		const readOnly = buildAgentLaunchPlan(input({ agent, readOnlyMode: true }));
		const plain = buildAgentLaunchPlan(input({ agent }));

		if (!batch.ok || !readOnly.ok || !plain.ok) throw new Error('plan failed');
		expect(batch.plan.envVars).toEqual({ A: 'default', B: 'batch' });
		expect(readOnly.plan.envVars).toEqual({ A: 'read-only' });
		expect(plain.plan.envVars).toEqual({ A: 'default' });
	});
});
