import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	buildAgentLaunchPlan,
	type AgentLaunchInput,
} from '../../../../shared/maestro-lib/launch/launch-plan';
import { resolveSshLaunchTarget } from '../../../../shared/maestro-lib/launch/ssh-remote-resolver';
import { getAgentDefinition } from '../../../../shared/maestro-lib/providers/definitions';
import { getAgentCapabilities } from '../../../../shared/maestro-lib/providers/capabilities';
import type { SshRemoteConfig } from '../../../../shared/types';
import type { LocalModelEndpoint } from '../../../../shared/local-models/endpoints';
import {
	OPENCODE_CONFIG_ENV_VAR,
	RUN_ON_KEY_ENV_VAR,
	RUN_ON_DEFAULT_CONTEXT_TOKENS,
	RUN_ON_PLACEHOLDER_KEY,
	type ResolvedRunOn,
} from '../../../../shared/local-models/run-on';

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

function claude(): AgentLaunchInput['agent'] {
	return {
		...getAgentDefinition('claude-code'),
		capabilities: getAgentCapabilities('claude-code'),
	};
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

	describe("the agent's Local Models gateway", () => {
		const url = 'http://127.0.0.1:8787';

		it.each([
			['claude-code', 'ANTHROPIC_BASE_URL'],
			['codex', 'OPENAI_BASE_URL'],
		])('sets the base-URL variable for %s on every surface', (toolType, envVar) => {
			for (const surface of ['desktop', 'cli', 'cue'] as const) {
				const result = buildAgentLaunchPlan(input({ surface, gateway: { toolType, url } }));

				if (!result.ok) throw new Error(result.error);
				expect(result.plan.gateway).toMatchObject({ envVar, url });
				expect(result.plan.envVars).toMatchObject({ [envVar]: url });
				expect(result.plan.env?.[envVar]).toBe(url);
			}
		});

		it('puts the Codex config argument ahead of the subcommand, on every surface', () => {
			const override = ['-c', `openai_base_url=${JSON.stringify(url)}`];
			for (const surface of ['desktop', 'cli', 'cue'] as const) {
				const result = buildAgentLaunchPlan(
					input({ surface, gateway: { toolType: 'codex', url } })
				);

				if (!result.ok) throw new Error(result.error);
				// A global option: `codex -c ... exec --json ...`, never after `exec`'s
				// own arguments, where a resume subcommand would read it as its own.
				expect(result.plan.args.slice(0, 4)).toEqual([...override, 'exec', '--json']);
				expect(result.plan.gateway?.args).toEqual(override);
			}
		});

		it('adds no argument for a provider whose variable is enough, or with no gateway', () => {
			const claude = buildAgentLaunchPlan(input({ gateway: { toolType: 'claude-code', url } }));
			if (!claude.ok) throw new Error(claude.error);
			expect(claude.plan.gateway?.args).toEqual([]);
			expect(claude.plan.args.slice(0, 2)).toEqual(['exec', '--json']);

			const none = buildAgentLaunchPlan(input({ gateway: { toolType: 'codex', url: '' } }));
			if (!none.ok) throw new Error(none.error);
			expect(none.plan.gateway).toBeUndefined();
			expect(none.plan.args.slice(0, 2)).toEqual(['exec', '--json']);
		});

		it('beats the provider defaults, the global Settings vars and the inherited value', () => {
			process.env.OPENAI_BASE_URL = 'https://from-the-shell.example.com';
			for (const surface of ['desktop', 'cli', 'cue'] as const) {
				const result = buildAgentLaunchPlan(
					input({
						surface,
						agent: { defaultEnvVars: { OPENAI_BASE_URL: 'https://default.example.com' } },
						globalShellEnvVars: { OPENAI_BASE_URL: 'https://global.example.com' },
						gateway: { toolType: 'codex', url },
					})
				);

				if (!result.ok) throw new Error(result.error);
				expect(result.plan.env?.OPENAI_BASE_URL).toBe(url);
			}
		});

		it("yields to the variable in the agent's own vars", () => {
			for (const surface of ['desktop', 'cli', 'cue'] as const) {
				const result = buildAgentLaunchPlan(
					input({
						surface,
						sessionCustomEnvVars: { OPENAI_BASE_URL: 'https://mine.example.com' },
						gateway: { toolType: 'codex', url },
					})
				);

				if (!result.ok) throw new Error(result.error);
				expect(result.plan.gateway).toBeUndefined();
				expect(result.plan.envVars?.OPENAI_BASE_URL).toBe('https://mine.example.com');
				expect(result.plan.env?.OPENAI_BASE_URL).toBe('https://mine.example.com');
			}
		});

		it('yields to the provider-level var only when the agent has no vars of its own', () => {
			const providerLevel = { OPENAI_BASE_URL: 'https://provider.example.com' };

			const inherited = buildAgentLaunchPlan(
				input({ agentCustomEnvVars: providerLevel, gateway: { toolType: 'codex', url } })
			);
			// The agent's own record replaces the provider-level set, so that
			// set's base URL never reaches the process and cannot win.
			const replaced = buildAgentLaunchPlan(
				input({
					agentCustomEnvVars: providerLevel,
					sessionCustomEnvVars: { OTHER: 'x' },
					gateway: { toolType: 'codex', url },
				})
			);

			if (!inherited.ok || !replaced.ok) throw new Error('plan failed');
			expect(inherited.plan.envVars?.OPENAI_BASE_URL).toBe('https://provider.example.com');
			expect(replaced.plan.envVars?.OPENAI_BASE_URL).toBe(url);
		});

		it('leaves an agent with no gateway alone', () => {
			const result = buildAgentLaunchPlan(input({ gateway: { toolType: 'codex', url: '' } }));

			if (!result.ok) throw new Error(result.error);
			expect(result.plan.gateway).toBeUndefined();
			expect(result.plan.envVars).toBeUndefined();
		});

		it('refuses a loopback gateway for an SSH remote, by name, instead of running without it', () => {
			const result = buildAgentLaunchPlan(
				input({
					sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
					sshStore: storeWith(remote()),
					gateway: { toolType: 'codex', url },
				})
			);

			expect(result).toMatchObject({ ok: false, reason: 'gateway-loopback-on-remote' });
			if (result.ok) throw new Error('expected failure');
			expect(result.error).toContain(url);
			expect(result.error).toContain('"Build Box"');
		});

		it('carries a reachable gateway to an SSH remote in the remote env record', () => {
			const result = buildAgentLaunchPlan(
				input({
					sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
					sshStore: storeWith(remote()),
					gateway: { toolType: 'codex', url: 'https://proxy.example.com' },
				})
			);

			if (!result.ok) throw new Error(result.error);
			expect(result.plan.target.kind).toBe('remote');
			expect(result.plan.envVars).toEqual({ OPENAI_BASE_URL: 'https://proxy.example.com' });
		});

		it('refuses a gateway on a provider that cannot use one', () => {
			const result = buildAgentLaunchPlan(input({ gateway: { toolType: 'copilot-cli', url } }));

			expect(result).toMatchObject({ ok: false, reason: 'gateway-unsupported-provider' });
		});

		it('reports an unresolvable SSH remote before it looks at the gateway', () => {
			const result = buildAgentLaunchPlan(
				input({
					sshRemoteConfig: { enabled: true, remoteId: 'gone' },
					sshStore: storeWith(),
					gateway: { toolType: 'codex', url },
				})
			);

			expect(result).toMatchObject({ ok: false, reason: 'remote-not-found' });
		});
	});

	describe("the agent's Run on target", () => {
		const SURFACES = ['desktop', 'cli', 'cue'] as const;
		const OLLAMA: LocalModelEndpoint = {
			id: 'ep-ollama',
			name: 'Ollama',
			kind: 'ollama',
			baseUrl: 'http://127.0.0.1:11434',
			enabled: true,
		};
		const WORKSTATION: LocalModelEndpoint = {
			id: 'ep-ws',
			name: 'Workstation',
			kind: 'openai-compatible',
			baseUrl: 'https://models.example.com',
			apiKeyEnvVar: 'WORKSTATION_KEY',
			enabled: true,
		};

		function runOn(overrides: Partial<ResolvedRunOn> = {}): ResolvedRunOn {
			return {
				toolType: 'claude-code',
				target: { type: 'source', endpointId: OLLAMA.id, model: 'qwen3:latest' },
				endpoint: OLLAMA,
				...overrides,
			};
		}

		function claudeInput(overrides: Partial<AgentLaunchInput> = {}): AgentLaunchInput {
			return input({
				agent: claude(),
				command: '/usr/local/bin/claude',
				args: ['--print', '--model', 'opus', '--effort', 'high'],
				runOn: runOn(),
				...overrides,
			});
		}

		function codexRunOn(): ResolvedRunOn {
			return runOn({
				toolType: 'codex',
				target: { type: 'source', endpointId: WORKSTATION.id, model: 'gpt-oss-20b' },
				endpoint: WORKSTATION,
				key: 'sk-workstation',
			});
		}

		it('leaves a launch alone for an agent on its provider', () => {
			for (const target of [undefined, { type: 'provider' } as const]) {
				const result = buildAgentLaunchPlan(input({ runOn: { toolType: 'codex', target } }));

				if (!result.ok) throw new Error(result.error);
				expect(result.plan.runOn).toBeUndefined();
				expect(result.plan.launchArgs).toEqual(['exec', '--json']);
				expect(result.plan.envVars).toBeUndefined();
			}
		});

		it('points Claude Code at the source on every surface, with the model in place of its own', () => {
			for (const surface of SURFACES) {
				const result = buildAgentLaunchPlan(claudeInput({ surface }));

				if (!result.ok) throw new Error(result.error);
				const { plan } = result;
				// The agent's stored model is replaced where it stood, not joined by a
				// second flag the CLI would have to choose between.
				expect(plan.launchArgs).toEqual(['--print', '--model', 'qwen3:latest', '--effort', 'high']);
				expect(plan.launchArgs.filter((arg) => arg === '--model')).toHaveLength(1);
				expect(plan.envVars).toMatchObject({
					ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
					ANTHROPIC_AUTH_TOKEN: RUN_ON_PLACEHOLDER_KEY,
					ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3:latest',
					ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3:latest',
					ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3:latest',
					CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(RUN_ON_DEFAULT_CONTEXT_TOKENS),
				});
				expect(plan.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:11434');
				expect(plan.runOn).toMatchObject({
					model: 'qwen3:latest',
					contextTokens: RUN_ON_DEFAULT_CONTEXT_TOKENS,
					args: [],
					subcommandArgs: [],
					userOverrides: [],
					clearedEnvVars: ['ANTHROPIC_API_KEY'],
				});
				expect(plan.runOn?.skippedGatewayUrl).toBeUndefined();
			}
		});

		it('adds the model flag when the launch named no model', () => {
			const result = buildAgentLaunchPlan(claudeInput({ args: ['--print'] }));

			if (!result.ok) throw new Error(result.error);
			expect(result.plan.launchArgs).toEqual(['--print', '--model', 'qwen3:latest']);
		});

		it('gives Codex a provider of its own ahead of the subcommand, and the model after it', () => {
			for (const surface of SURFACES) {
				const result = buildAgentLaunchPlan(
					input({ surface, args: ['exec', '--json', '-m', 'gpt-5.3-codex'], runOn: codexRunOn() })
				);

				if (!result.ok) throw new Error(result.error);
				const { plan } = result;
				expect(plan.launchArgs.slice(0, 6)).toEqual(plan.runOn?.args);
				expect(plan.launchArgs[1]).toContain("base_url='https://models.example.com/v1'");
				// `-m` belongs to `exec`: a root `-m` is the TUI's.
				expect(plan.launchArgs.slice(6)).toEqual(['exec', '--json', '-m', 'gpt-oss-20b']);
				expect(plan.envVars).toEqual({ [RUN_ON_KEY_ENV_VAR]: 'sk-workstation' });
				expect(plan.env?.[RUN_ON_KEY_ENV_VAR]).toBe('sk-workstation');
			}
		});

		function openCodeInput(overrides: Partial<AgentLaunchInput> = {}): AgentLaunchInput {
			return input({
				agent: {
					...getAgentDefinition('opencode'),
					capabilities: getAgentCapabilities('opencode'),
				},
				command: '/opt/homebrew/bin/opencode',
				args: ['run', '--format', 'json', '--model', 'anthropic/claude-sonnet-4'],
				runOn: runOn({ toolType: 'opencode' }),
				...overrides,
			});
		}

		/** The inline config a plan carries, in the record and in the local environment. */
		function openCodeConfigs(plan: {
			envVars?: Record<string, string>;
			env?: NodeJS.ProcessEnv;
		}): Array<Record<string, any>> {
			return [plan.envVars?.[OPENCODE_CONFIG_ENV_VAR], plan.env?.[OPENCODE_CONFIG_ENV_VAR]].map(
				(text) => JSON.parse(text ?? 'null')
			);
		}

		it('runs OpenCode on a private server, with the model under its own provider', () => {
			for (const surface of SURFACES) {
				const result = buildAgentLaunchPlan(openCodeInput({ surface }));

				if (!result.ok) throw new Error(result.error);
				const { plan } = result;
				// `--standalone` belongs to `run`: OpenCode rejects it in front.
				expect(plan.launchArgs).toEqual([
					'run',
					'--standalone',
					'--format',
					'json',
					'--model',
					'maestro/qwen3:latest',
				]);
				// The prompt still follows OpenCode's `--` separator, after everything.
				expect(plan.args.slice(plan.launchArgs.length)).toEqual(['--', 'fix the bug']);
				expect(plan.runOn).toMatchObject({
					// What a person is shown: the source's own name for the model.
					model: 'qwen3:latest',
					args: [],
					subcommandArgs: ['--standalone'],
					envVarNames: [RUN_ON_KEY_ENV_VAR, OPENCODE_CONFIG_ENV_VAR],
				});
				expect(plan.env?.[RUN_ON_KEY_ENV_VAR]).toBe(RUN_ON_PLACEHOLDER_KEY);
			}
		});

		it("adds OpenCode's provider to the permission block, in a read-only turn too", () => {
			const permissions = JSON.parse(
				getAgentDefinition('opencode')?.defaultEnvVars?.[OPENCODE_CONFIG_ENV_VAR] ?? 'null'
			);
			for (const surface of SURFACES) {
				for (const readOnlyMode of [false, true]) {
					const result = buildAgentLaunchPlan(openCodeInput({ surface, readOnlyMode }));

					if (!result.ok) throw new Error(result.error);
					for (const config of openCodeConfigs(result.plan)) {
						// The read-only override sets the same variable above every other
						// layer. It must not take the provider with it.
						expect(config).toMatchObject(permissions);
						expect(config.provider.maestro.options.baseURL).toBe('http://127.0.0.1:11434/v1');
					}
				}
			}
		});

		it("adds OpenCode's provider to the agent's own inline config instead of yielding to it", () => {
			const mine = JSON.stringify({ theme: 'mine', provider: { ollama: { models: {} } } });
			for (const surface of SURFACES) {
				const result = buildAgentLaunchPlan(
					openCodeInput({ surface, sessionCustomEnvVars: { [OPENCODE_CONFIG_ENV_VAR]: mine } })
				);

				if (!result.ok) throw new Error(result.error);
				for (const config of openCodeConfigs(result.plan)) {
					expect(config.theme).toBe('mine');
					expect(Object.keys(config.provider)).toEqual(['ollama', 'maestro']);
				}
				expect(result.plan.runOn?.userOverrides).toEqual([]);
			}
		});

		it('sends the OpenCode provider and its key variable to an SSH remote', () => {
			const result = buildAgentLaunchPlan(
				openCodeInput({
					sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
					sshStore: storeWith(remote()),
					runOn: runOn({
						toolType: 'opencode',
						target: { type: 'source', endpointId: WORKSTATION.id, model: 'big-model' },
						endpoint: WORKSTATION,
						key: 'sk-workstation',
					}),
				})
			);

			if (!result.ok) throw new Error(result.error);
			expect(result.plan.target.kind).toBe('remote');
			expect(result.plan.envVars?.[RUN_ON_KEY_ENV_VAR]).toBe('sk-workstation');
			const config = JSON.parse(result.plan.envVars?.[OPENCODE_CONFIG_ENV_VAR] ?? 'null');
			expect(config.provider.maestro.options).toEqual({
				baseURL: 'https://models.example.com/v1',
				apiKey: `{env:${RUN_ON_KEY_ENV_VAR}}`,
			});
			expect(result.plan.envVars?.[OPENCODE_CONFIG_ENV_VAR]).not.toContain('sk-workstation');
		});

		it('points Copilot CLI at the source by its provider variables alone', () => {
			process.env.COPILOT_PROVIDER_BEARER_TOKEN = 'another-providers-token';
			try {
				for (const surface of SURFACES) {
					const result = buildAgentLaunchPlan(
						input({
							surface,
							agent: {
								...getAgentDefinition('copilot-cli'),
								capabilities: getAgentCapabilities('copilot-cli'),
							},
							command: '/opt/homebrew/bin/copilot',
							args: ['--allow-all', '--output-format', 'json', '--model', 'gpt-5.4'],
							runOn: runOn({ toolType: 'copilot-cli' }),
						})
					);

					if (!result.ok) throw new Error(result.error);
					const { plan } = result;
					expect(plan.launchArgs).toEqual([
						'--allow-all',
						'--output-format',
						'json',
						'--model',
						'qwen3:latest',
					]);
					expect(plan.env).toMatchObject({
						COPILOT_PROVIDER_BASE_URL: 'http://127.0.0.1:11434/v1',
						COPILOT_PROVIDER_API_KEY: RUN_ON_PLACEHOLDER_KEY,
						COPILOT_PROVIDER_WIRE_MODEL: 'qwen3:latest',
						COPILOT_PROVIDER_MODEL_ID: 'maestro-run-on',
					});
					// A bearer token exported for another provider would go out in place
					// of the source's key.
					expect(plan.env?.COPILOT_PROVIDER_BEARER_TOKEN ?? '').toBe('');
				}
			} finally {
				delete process.env.COPILOT_PROVIDER_BEARER_TOKEN;
			}
		});

		it('keeps the prompt out of launchArgs and at the end of args', () => {
			const result = buildAgentLaunchPlan(claudeInput({ args: ['--print'] }));

			if (!result.ok) throw new Error(result.error);
			expect(result.plan.launchArgs).not.toContain('fix the bug');
			expect(result.plan.args.slice(0, 3)).toEqual(result.plan.launchArgs);
			expect(result.plan.args[result.plan.args.length - 1]).toBe('fix the bug');
		});

		it('names only the variables in its record, never the key', () => {
			const result = buildAgentLaunchPlan(input({ runOn: codexRunOn() }));

			if (!result.ok) throw new Error(result.error);
			expect(result.plan.runOn?.envVarNames).toEqual([RUN_ON_KEY_ENV_VAR]);
			expect(JSON.stringify(result.plan.runOn)).not.toContain('sk-workstation');
		});

		it('keeps the Run on model when translation adds Claude memory settings', () => {
			const result = buildAgentLaunchPlan(
				claudeInput({
					prompt: undefined,
					maestroEnvVars: {
						MAESTRO_TRANSLATION_KNOWLEDGE: '/project/.maestro/provider-knowledge/migrated',
					},
				})
			);
			if (!result.ok) throw new Error(result.error);
			expect(result.plan.launchArgs).toEqual([
				'--print',
				'--model',
				'qwen3:latest',
				'--effort',
				'high',
				'--settings',
				JSON.stringify({
					autoMemoryDirectory: '/project/.maestro/provider-knowledge/migrated/memory',
				}),
			]);
			expect(result.plan.envVars?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:11434');
		});

		it('takes the place of the gateway, and says which gateway was passed over', () => {
			const gatewayUrl = 'http://127.0.0.1:8787/anthropic';
			for (const surface of SURFACES) {
				const result = buildAgentLaunchPlan(
					claudeInput({ surface, gateway: { toolType: 'claude-code', url: gatewayUrl } })
				);

				if (!result.ok) throw new Error(result.error);
				expect(result.plan.gateway).toBeUndefined();
				expect(result.plan.runOn?.skippedGatewayUrl).toBe(gatewayUrl);
				// The base URL is the source's, not the gateway's.
				expect(result.plan.envVars?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:11434');
				expect(result.plan.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:11434');
			}
		});

		it('does not let a gateway that could not be used refuse a launch that skips it', () => {
			// A loopback gateway refuses an SSH launch on its own. With a Run on
			// target the launch never goes through it.
			const result = buildAgentLaunchPlan(
				input({
					sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
					sshStore: storeWith(remote()),
					gateway: { toolType: 'codex', url: 'http://127.0.0.1:8787' },
					runOn: codexRunOn(),
				})
			);

			if (!result.ok) throw new Error(result.error);
			expect(result.plan.target.kind).toBe('remote');
			expect(result.plan.gateway).toBeUndefined();
			// What crosses to the remote host: the key variable and the arguments.
			expect(result.plan.envVars).toEqual({ [RUN_ON_KEY_ENV_VAR]: 'sk-workstation' });
			expect(result.plan.args).toEqual(result.plan.launchArgs);
			expect(result.plan.args).toContain('gpt-oss-20b');
		});

		it("keeps the provider's own key from the source, whoever set it", () => {
			process.env.ANTHROPIC_API_KEY = 'sk-ant-from-the-shell';
			for (const surface of SURFACES) {
				const result = buildAgentLaunchPlan(
					claudeInput({
						surface,
						globalShellEnvVars: { ANTHROPIC_API_KEY: 'sk-ant-from-settings' },
						sessionCustomEnvVars: { ANTHROPIC_API_KEY: 'sk-ant-from-the-agent' },
					})
				);

				if (!result.ok) throw new Error(result.error);
				// Blank in the record that crosses to a remote, and unset or blank in
				// the local environment: Claude Code sends no `x-api-key` for either.
				expect(result.plan.envVars?.ANTHROPIC_API_KEY).toBe('');
				expect(result.plan.env?.ANTHROPIC_API_KEY ?? '').toBe('');
				expect(JSON.stringify(result.plan.env)).not.toContain('sk-ant-from');
			}
		});

		it("yields to a recipe variable in the agent's own vars, one variable at a time", () => {
			const result = buildAgentLaunchPlan(
				claudeInput({ sessionCustomEnvVars: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '100000' } })
			);

			if (!result.ok) throw new Error(result.error);
			expect(result.plan.env?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('100000');
			expect(result.plan.env?.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:11434');
			expect(result.plan.runOn?.userOverrides).toEqual(['CLAUDE_CODE_MAX_CONTEXT_TOKENS']);
		});

		it.each<[string, Partial<ResolvedRunOn>, string]>([
			['a source that is gone', { endpoint: null }, 'run-on-source-missing'],
			[
				'a source that is disabled',
				{ endpoint: { ...OLLAMA, enabled: false } },
				'run-on-source-disabled',
			],
			['a harness with no recipe', { toolType: 'factory-droid' }, 'run-on-unsupported-provider'],
			[
				'a target that is not a source and a model',
				{ target: { type: 'source', endpointId: 'ep-ollama' } as never },
				'run-on-invalid-target',
			],
		])('refuses %s on every surface, and plans nothing', (_case, overrides, reason) => {
			for (const surface of SURFACES) {
				const result = buildAgentLaunchPlan(claudeInput({ surface, runOn: runOn(overrides) }));

				expect(result).toMatchObject({ ok: false, reason });
				if (result.ok) throw new Error('expected a refusal');
				expect(result.error).toContain('Run on');
			}
		});

		it('refuses a loopback source for an SSH remote, as the gateway does', () => {
			const result = buildAgentLaunchPlan(
				claudeInput({
					sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
					sshStore: storeWith(remote()),
				})
			);

			expect(result).toMatchObject({ ok: false, reason: 'run-on-loopback-on-remote' });
			if (result.ok) throw new Error('expected a refusal');
			expect(result.error).toContain('loopback address');
			expect(result.error).toContain('"Build Box"');
		});

		it('refuses a recipe whose provider has no model flag to carry the model', () => {
			const result = buildAgentLaunchPlan(claudeInput({ agent: {} }));

			expect(result).toMatchObject({ ok: false, reason: 'run-on-unsupported-provider' });
			if (result.ok) throw new Error('expected a refusal');
			expect(result.error).toContain('no model flag');
		});

		it('reports an unresolvable SSH remote before it looks at the target', () => {
			const result = buildAgentLaunchPlan(
				claudeInput({
					sshRemoteConfig: { enabled: true, remoteId: 'gone' },
					sshStore: storeWith(),
					runOn: runOn({ endpoint: null }),
				})
			);

			expect(result).toMatchObject({ ok: false, reason: 'remote-not-found' });
		});
	});
});
