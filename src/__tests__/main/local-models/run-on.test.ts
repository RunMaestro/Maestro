/**
 * @file run-on.test.ts
 *
 * Run on in a process that can reach the sources: what a launch learns before
 * it is planned, and what a spawn with no plan gets. The stores, the model
 * server and the source's model list are injected, so no network is touched.
 *
 * What is pinned: an agent on its provider's model costs nothing and reads no
 * store; every refusal that needs no network is decided before the model
 * server is started or a source is asked; a source that cannot serve the model
 * refuses by name; and a target is never dropped so the turn can run on the
 * provider's model.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../../main/utils/logger';
import { LocalModelEndpointError } from '../../../main/local-models/errors';
import {
	applyAgentRunOnToSpawn,
	configureAgentRunOn,
	isAgentRunOnConfigured,
	logRunOnLaunch,
	prepareAgentRunOn,
	prepareLaunchRunOn,
	resetAgentRunOnForTests,
	resolveSourceCallTarget,
	storedAgentRunOn,
	type AgentRunOnDeps,
	type AgentRunOnRequest,
} from '../../../main/local-models/run-on';
import type { LocalModelEndpoint } from '../../../shared/local-models/endpoints';
import { MODEL_SERVER_ENDPOINT_ID } from '../../../shared/local-models/model-server';
import {
	OPENCODE_CONFIG_ENV_VAR,
	RUN_ON_KEY_ENV_VAR,
	RUN_ON_PLACEHOLDER_KEY,
	type RunOnSourceTarget,
} from '../../../shared/local-models/run-on';
import { getAgentDefinition } from '../../../shared/maestro-lib/providers/definitions';

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

const QWEN: RunOnSourceTarget = { type: 'source', endpointId: OLLAMA.id, model: 'qwen3:latest' };
const BIG: RunOnSourceTarget = { type: 'source', endpointId: WORKSTATION.id, model: 'big-model' };
const ON_SERVER: RunOnSourceTarget = {
	type: 'source',
	endpointId: MODEL_SERVER_ENDPOINT_ID,
	model: 'gpt-oss-20b',
};
const SERVER_URL = 'http://127.0.0.1:52100';

let deps: {
	[K in keyof Required<AgentRunOnDeps>]: ReturnType<typeof vi.fn>;
};

function configure(sessions: Array<Record<string, unknown>> = []): void {
	deps = {
		sessions: vi.fn(() => sessions),
		endpoints: vi.fn(() => [OLLAMA, WORKSTATION]),
		shellEnvVars: vi.fn(() => ({ WORKSTATION_KEY: 'sk-workstation' })),
		modelServer: vi.fn(async () => ({ ok: true, baseUrl: SERVER_URL, key: 'sk-server' })),
		listModels: vi.fn(async () => [{ id: 'qwen3:latest' }, { id: 'big-model' }]),
	};
	configureAgentRunOn(deps as unknown as AgentRunOnDeps);
}

function prepare(overrides: Partial<AgentRunOnRequest> = {}) {
	return prepareAgentRunOn({ toolType: 'claude-code', target: QWEN, ...overrides });
}

beforeEach(() => {
	vi.clearAllMocks();
	configure();
});

afterEach(() => {
	resetAgentRunOnForTests();
});

describe('prepareAgentRunOn: an agent on its provider', () => {
	it.each([[undefined], [null], [{ type: 'provider' }]])(
		'answers none for %j and reads no store',
		async (target) => {
			expect(await prepare({ target })).toEqual({ kind: 'none' });
			expect(deps.endpoints).not.toHaveBeenCalled();
			expect(deps.modelServer).not.toHaveBeenCalled();
			expect(deps.listModels).not.toHaveBeenCalled();
		}
	);

	it('needs no configuration at all', async () => {
		resetAgentRunOnForTests();

		expect(isAgentRunOnConfigured()).toBe(false);
		expect(await prepare({ target: undefined })).toEqual({ kind: 'none' });
	});
});

describe('prepareAgentRunOn: a saved source', () => {
	it('asks the source for its models and hands back its record and key', async () => {
		const prepared = await prepare({ target: BIG });

		expect(prepared).toEqual({
			kind: 'ready',
			runOn: { toolType: 'claude-code', target: BIG, endpoint: WORKSTATION, key: 'sk-workstation' },
			model: 'big-model',
			label: 'big-model on Workstation',
		});
		expect(deps.listModels).toHaveBeenCalledWith(WORKSTATION, {
			shellEnvVars: { WORKSTATION_KEY: 'sk-workstation' },
		});
		expect(deps.modelServer).not.toHaveBeenCalled();
	});

	it('hands back no key for a source that has none', async () => {
		const prepared = await prepare();

		if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
		expect(prepared.runOn.endpoint).toEqual(OLLAMA);
		expect(prepared.runOn.key).toBeUndefined();
	});

	it('refuses a source that does not answer, with what it said', async () => {
		deps.listModels.mockRejectedValue(
			new LocalModelEndpointError('Could not reach "Ollama" (http://127.0.0.1:11434).', {
				kind: 'network',
				endpointId: OLLAMA.id,
				endpointName: OLLAMA.name,
				url: OLLAMA.baseUrl,
			})
		);

		const prepared = await prepare();

		expect(prepared).toMatchObject({ kind: 'refused', code: 'run-on-source-unreachable' });
		if (prepared.kind !== 'refused') throw new Error('expected a refusal');
		expect(prepared.message).toContain('qwen3:latest on Ollama');
		expect(prepared.message).toContain('Could not reach "Ollama"');
		expect(prepared.message).toContain('set Run on to Provider');
	});

	it('refuses a model the source does not serve, and names what it does serve', async () => {
		deps.listModels.mockResolvedValue(
			['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((id) => ({ id: `model-${id}` }))
		);

		const prepared = await prepare();

		expect(prepared).toMatchObject({ kind: 'refused', code: 'run-on-model-not-served' });
		if (prepared.kind !== 'refused') throw new Error('expected a refusal');
		expect(prepared.message).toContain('does not serve "qwen3:latest"');
		expect(prepared.message).toContain('model-a, model-b, model-c, model-d, model-e and 2 more');
	});

	it('says so when the source serves nothing', async () => {
		deps.listModels.mockResolvedValue([]);

		const prepared = await prepare();

		if (prepared.kind !== 'refused') throw new Error('expected a refusal');
		expect(prepared.message).toContain('it serves no models');
	});

	it('lets a failure that is not an endpoint error through', async () => {
		deps.listModels.mockRejectedValue(new Error('out of memory'));

		await expect(prepare()).rejects.toThrow('out of memory');
	});
});

describe('prepareAgentRunOn: the Maestro model server', () => {
	it('makes the server ready for the model and hands back where it listens and its key', async () => {
		const prepared = await prepare({ toolType: 'codex', target: ON_SERVER });

		expect(deps.modelServer).toHaveBeenCalledWith('gpt-oss-20b');
		if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
		expect(prepared.runOn.endpoint).toMatchObject({
			id: MODEL_SERVER_ENDPOINT_ID,
			baseUrl: SERVER_URL,
			enabled: true,
		});
		expect(prepared.runOn.key).toBe('sk-server');
		// The server is not a saved endpoint: no list is read for it and no models asked.
		expect(deps.listModels).not.toHaveBeenCalled();
	});

	it('refuses by name when the server cannot serve the model', async () => {
		deps.modelServer.mockResolvedValue({ ok: false, error: 'gpt-oss 20B is not downloaded.' });

		const prepared = await prepare({ toolType: 'codex', target: ON_SERVER });

		expect(prepared).toMatchObject({ kind: 'refused', code: 'run-on-server-failed' });
		if (prepared.kind !== 'refused') throw new Error('expected a refusal');
		expect(prepared.message).toContain('Maestro model server could not serve it');
		expect(prepared.message).toContain('gpt-oss 20B is not downloaded');
	});

	it('is a loopback source for an SSH remote, and is refused before it is started', async () => {
		const prepared = await prepare({
			toolType: 'codex',
			target: ON_SERVER,
			remote: { name: 'Build Box' },
		});

		expect(prepared).toMatchObject({ kind: 'refused', code: 'run-on-loopback-on-remote' });
		expect(deps.modelServer).not.toHaveBeenCalled();
	});
});

describe('prepareAgentRunOn: refusals that need no network come first', () => {
	const untouched = () => {
		expect(deps.modelServer).not.toHaveBeenCalled();
		expect(deps.listModels).not.toHaveBeenCalled();
	};

	it('refuses a harness with no recipe without starting the model server', async () => {
		const prepared = await prepare({ toolType: 'factory-droid', target: ON_SERVER });

		expect(prepared).toMatchObject({ kind: 'refused', code: 'run-on-unsupported-provider' });
		untouched();
	});

	it('refuses a source that is no longer configured', async () => {
		const prepared = await prepare({ target: { ...QWEN, endpointId: 'ep-gone' } });

		expect(prepared).toMatchObject({ kind: 'refused', code: 'run-on-source-missing' });
		untouched();
	});

	it('refuses a source that is disabled', async () => {
		deps.endpoints.mockReturnValue([{ ...OLLAMA, enabled: false }]);

		expect(await prepare()).toMatchObject({ kind: 'refused', code: 'run-on-source-disabled' });
		untouched();
	});

	it('refuses a loopback source for an SSH remote', async () => {
		const prepared = await prepare({ remote: { name: 'Build Box' } });

		expect(prepared).toMatchObject({ kind: 'refused', code: 'run-on-loopback-on-remote' });
		untouched();
	});

	it('refuses a malformed target instead of reading it as the provider', async () => {
		const prepared = await prepare({ target: { type: 'source', endpointId: OLLAMA.id } });

		expect(prepared).toMatchObject({ kind: 'refused', code: 'run-on-invalid-target' });
		untouched();
	});

	it('refuses a malformed target even in a process that was never configured', async () => {
		resetAgentRunOnForTests();

		expect(await prepare({ target: 'qwen3' })).toMatchObject({
			kind: 'refused',
			code: 'run-on-invalid-target',
		});
	});
});

describe('prepareAgentRunOn: an agent that routes itself', () => {
	it('does not ask a source the launch is not sent to', async () => {
		deps.listModels.mockRejectedValue(new Error('must not be asked'));

		const prepared = await prepare({
			userEnvVars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000' },
		});

		expect(prepared).toMatchObject({ kind: 'ready', model: 'qwen3:latest' });
		expect(deps.listModels).not.toHaveBeenCalled();
	});

	it('does not start the model server for it either', async () => {
		const prepared = await prepare({
			target: ON_SERVER,
			userEnvVars: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:4000' },
		});

		expect(prepared.kind).toBe('ready');
		expect(deps.modelServer).not.toHaveBeenCalled();
	});

	it('still asks for Codex, whose address is an argument the agent cannot set', async () => {
		await prepare({
			toolType: 'codex',
			userEnvVars: { OPENAI_BASE_URL: 'http://127.0.0.1:4000' },
		});

		expect(deps.listModels).toHaveBeenCalled();
	});
});

describe('prepareAgentRunOn: a process that was never configured', () => {
	it('throws for a source target rather than run the agent on its provider', async () => {
		resetAgentRunOnForTests();

		await expect(prepare()).rejects.toThrow('configureAgentRunOn');
	});
});

describe('resolveSourceCallTarget', () => {
	it('hands back a saved source and its key without asking it anything', async () => {
		await expect(resolveSourceCallTarget(BIG)).resolves.toEqual({
			ok: true,
			endpoint: WORKSTATION,
			key: 'sk-workstation',
		});
		// The request about to be sent is the question: no listing first.
		expect(deps.listModels).not.toHaveBeenCalled();
		expect(deps.modelServer).not.toHaveBeenCalled();
	});

	it('has no key for a source that names none', async () => {
		const call = await resolveSourceCallTarget(QWEN);

		expect(call).toEqual({ ok: true, endpoint: OLLAMA, key: undefined });
	});

	it('starts the Maestro model server for the model and hands back where it listens', async () => {
		const call = await resolveSourceCallTarget(ON_SERVER);

		expect(deps.modelServer).toHaveBeenCalledWith('gpt-oss-20b');
		if (!call.ok) throw new Error(JSON.stringify(call));
		expect(call.endpoint).toMatchObject({ id: MODEL_SERVER_ENDPOINT_ID, baseUrl: SERVER_URL });
		expect(call.key).toBe('sk-server');
	});

	it('says why the model server cannot serve the model', async () => {
		deps.modelServer.mockResolvedValue({ ok: false, error: 'gpt-oss 20B is not downloaded.' });

		const call = await resolveSourceCallTarget(ON_SERVER);

		expect(call).toMatchObject({
			ok: false,
			reason: 'server-failed',
			detail: 'gpt-oss 20B is not downloaded.',
		});
		if (call.ok) throw new Error('expected a failure');
		expect(call.endpoint?.id).toBe(MODEL_SERVER_ENDPOINT_ID);
	});

	it('reports a source that is gone, and one that is switched off, and starts nothing', async () => {
		await expect(
			resolveSourceCallTarget({ type: 'source', endpointId: 'ep-gone', model: 'm' })
		).resolves.toEqual({ ok: false, reason: 'missing', endpoint: null });

		const off = { ...OLLAMA, enabled: false };
		deps.endpoints.mockReturnValue([off]);
		await expect(resolveSourceCallTarget(QWEN)).resolves.toEqual({
			ok: false,
			reason: 'disabled',
			endpoint: off,
		});
		expect(deps.modelServer).not.toHaveBeenCalled();
	});

	it('throws in a process that was never configured', async () => {
		resetAgentRunOnForTests();

		await expect(resolveSourceCallTarget(QWEN)).rejects.toThrow('configureAgentRunOn');
	});
});

describe('prepareLaunchRunOn', () => {
	const buildBox = {
		id: 'remote-1',
		name: 'Build Box',
		host: 'build.example.com',
		port: 22,
		username: 'dev',
		privateKeyPath: '',
		enabled: true,
	};
	const sshStore = { getSshRemotes: vi.fn(() => [buildBox]) };

	it('reads nothing for an agent on its provider, the SSH remote included', async () => {
		const prepared = await prepareLaunchRunOn({
			toolType: 'claude-code',
			target: undefined,
			sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			sshStore,
		});

		expect(prepared).toEqual({ kind: 'none' });
		expect(sshStore.getSshRemotes).not.toHaveBeenCalled();
		expect(deps.endpoints).not.toHaveBeenCalled();
	});

	it('prepares a local launch like prepareAgentRunOn', async () => {
		const prepared = await prepareLaunchRunOn({ toolType: 'claude-code', target: QWEN });

		expect(prepared).toMatchObject({ kind: 'ready', model: 'qwen3:latest' });
		expect(deps.listModels).toHaveBeenCalledTimes(1);
	});

	it('names the resolved remote in a loopback refusal', async () => {
		const prepared = await prepareLaunchRunOn({
			toolType: 'claude-code',
			target: QWEN,
			sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			sshStore,
		});

		expect(prepared).toMatchObject({ kind: 'refused', code: 'run-on-loopback-on-remote' });
		if (prepared.kind !== 'refused') throw new Error('expected a refusal');
		expect(prepared.message).toContain('"Build Box"');
	});

	it('lets a remote host reach a source that is not loopback', async () => {
		const prepared = await prepareLaunchRunOn({
			toolType: 'claude-code',
			target: BIG,
			sshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			sshStore,
		});

		expect(prepared).toMatchObject({ kind: 'ready', model: 'big-model' });
	});

	it('looks nothing up and starts nothing for an SSH remote the plan will refuse', async () => {
		const prepared = await prepareLaunchRunOn({
			toolType: 'codex',
			target: ON_SERVER,
			sshRemoteConfig: { enabled: true, remoteId: 'gone' },
			sshStore,
		});

		// `none` here is not "runs on the provider": buildAgentLaunchPlan refuses
		// this launch for its remote, and it is handed this result.
		expect(prepared).toEqual({ kind: 'none' });
		expect(deps.modelServer).not.toHaveBeenCalled();
		expect(deps.endpoints).not.toHaveBeenCalled();
	});
});

describe('storedAgentRunOn', () => {
	it("reads the agent's stored target by its id", () => {
		configure([{ id: 'a1', runOn: QWEN }, { id: 'a2' }]);

		expect(storedAgentRunOn('a1')).toEqual(QWEN);
		expect(storedAgentRunOn('a2')).toBeUndefined();
		expect(storedAgentRunOn('gone')).toBeUndefined();
	});
});

describe('applyAgentRunOnToSpawn', () => {
	const claude = getAgentDefinition('claude-code');
	const codex = getAgentDefinition('codex');
	const input = {
		agentId: 'a1',
		toolType: 'claude-code',
		agent: claude,
		args: ['--print', '--model', 'opus'],
	};

	it('leaves the spawn alone for an agent with no target, and for one that is gone', async () => {
		configure([{ id: 'a1' }]);
		const customEnvVars = { FOO: 'bar' };
		const unchanged = { ok: true, args: input.args, customEnvVars, runOn: null };

		expect(await applyAgentRunOnToSpawn({ ...input, customEnvVars })).toEqual(unchanged);
		expect(await applyAgentRunOnToSpawn({ ...input, customEnvVars, agentId: 'gone' })).toEqual(
			unchanged
		);
	});

	it("puts the recipe's variables and the model on a Claude Code spawn", async () => {
		configure([{ id: 'a1', runOn: QWEN }]);

		const result = await applyAgentRunOnToSpawn({ ...input, customEnvVars: { FOO: 'bar' } });

		if (!result.ok) throw new Error(result.error);
		expect(result.args).toEqual(['--print', '--model', 'qwen3:latest']);
		expect(result.customEnvVars).toMatchObject({
			FOO: 'bar',
			ANTHROPIC_BASE_URL: 'http://127.0.0.1:11434',
			ANTHROPIC_AUTH_TOKEN: RUN_ON_PLACEHOLDER_KEY,
			ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3:latest',
			// Blank, so the agent's own Anthropic key is not sent to the source.
			ANTHROPIC_API_KEY: '',
		});
		expect(result.runOn).toMatchObject({
			model: 'qwen3:latest',
			clearedEnvVars: ['ANTHROPIC_API_KEY'],
		});
	});

	it("puts Codex's provider ahead of its arguments and the model after its subcommand", async () => {
		configure([{ id: 'a1', runOn: ON_SERVER }]);

		const result = await applyAgentRunOnToSpawn({
			...input,
			toolType: 'codex',
			agent: codex,
			args: ['exec', '--json'],
		});

		if (!result.ok) throw new Error(result.error);
		expect(result.args.slice(0, 2)).toEqual([
			'-c',
			`model_providers.maestro={name='Maestro',base_url='${SERVER_URL}/v1',env_key='${RUN_ON_KEY_ENV_VAR}',wire_api='responses'}`,
		]);
		expect(result.args.slice(-4)).toEqual(['exec', '--json', '-m', 'gpt-oss-20b']);
		expect(result.customEnvVars).toEqual({ [RUN_ON_KEY_ENV_VAR]: 'sk-server' });
	});

	it("adds OpenCode's provider to the permission block the spawn would otherwise cover", async () => {
		configure([{ id: 'a1', runOn: QWEN }]);
		const openCode = getAgentDefinition('opencode');

		const result = await applyAgentRunOnToSpawn({
			...input,
			toolType: 'opencode',
			agent: openCode,
			args: ['run', '--format', 'json', '--model', 'anthropic/claude-sonnet-4'],
			customEnvVars: { FOO: 'bar' },
		});

		if (!result.ok) throw new Error(result.error);
		expect(result.args).toEqual([
			'run',
			'--standalone',
			'--format',
			'json',
			'--model',
			'maestro/qwen3:latest',
		]);
		expect(result.customEnvVars).toMatchObject({
			FOO: 'bar',
			[RUN_ON_KEY_ENV_VAR]: RUN_ON_PLACEHOLDER_KEY,
		});
		// These variables sit over the provider's defaults in the process, so the
		// document is built from the default it covers.
		const config = JSON.parse(result.customEnvVars?.[OPENCODE_CONFIG_ENV_VAR] ?? 'null');
		expect(config).toMatchObject(
			JSON.parse(openCode?.defaultEnvVars?.[OPENCODE_CONFIG_ENV_VAR] ?? 'null')
		);
		expect(config.provider.maestro.options.baseURL).toBe('http://127.0.0.1:11434/v1');
		expect(result.runOn).toMatchObject({ model: 'qwen3:latest', subcommandArgs: ['--standalone'] });
	});

	it("adds OpenCode's provider to the agent's own inline config when it has one", async () => {
		configure([{ id: 'a1', runOn: QWEN }]);

		const result = await applyAgentRunOnToSpawn({
			...input,
			toolType: 'opencode',
			agent: getAgentDefinition('opencode'),
			args: ['run'],
			customEnvVars: { [OPENCODE_CONFIG_ENV_VAR]: '{"theme":"mine"}' },
		});

		if (!result.ok) throw new Error(result.error);
		const config = JSON.parse(result.customEnvVars?.[OPENCODE_CONFIG_ENV_VAR] ?? 'null');
		expect(config.theme).toBe('mine');
		expect(config).not.toHaveProperty('permission');
		expect(config.provider).toHaveProperty('maestro');
	});

	it("says which gateway the agent's target took the place of", async () => {
		configure([{ id: 'a1', runOn: QWEN, gatewayUrl: 'http://127.0.0.1:8787/anthropic' }]);

		const result = await applyAgentRunOnToSpawn(input);

		if (!result.ok) throw new Error(result.error);
		expect(result.runOn?.skippedGatewayUrl).toBe('http://127.0.0.1:8787/anthropic');
	});

	it('leaves a recipe variable the agent sets itself alone', async () => {
		configure([{ id: 'a1', runOn: QWEN }]);

		const result = await applyAgentRunOnToSpawn({
			...input,
			customEnvVars: { CLAUDE_CODE_MAX_CONTEXT_TOKENS: '100000' },
		});

		if (!result.ok) throw new Error(result.error);
		expect(result.customEnvVars?.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('100000');
		expect(result.runOn?.userOverrides).toEqual(['CLAUDE_CODE_MAX_CONTEXT_TOKENS']);
	});

	it.each<[string, object, Partial<typeof input> & { remote?: { name: string } }, string]>([
		['a source that is gone', { ...QWEN, endpointId: 'ep-gone' }, {}, 'no longer configured'],
		['a loopback source for a remote host', QWEN, { remote: { name: 'Build Box' } }, 'loopback'],
		['a harness with no recipe', QWEN, { toolType: 'factory-droid' }, 'only from a settings file'],
		['a malformed target', { type: 'source' }, {}, 'cannot be used'],
	])(
		'refuses %s with an error the caller must fail the spawn with',
		async (_case, runOn, extra, text) => {
			configure([{ id: 'a1', runOn }]);

			const result = await applyAgentRunOnToSpawn({ ...input, ...extra });

			expect(result.ok).toBe(false);
			if (result.ok) throw new Error('expected a refusal');
			expect(result.error).toContain(text);
		}
	);

	it('refuses when the source cannot serve the model', async () => {
		configure([{ id: 'a1', runOn: ON_SERVER }]);
		deps.modelServer.mockResolvedValue({ ok: false, error: 'the port is taken' });

		const result = await applyAgentRunOnToSpawn({ ...input, toolType: 'codex', agent: codex });

		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error('expected a refusal');
		expect(result.error).toContain('the port is taken');
	});

	it('refuses a provider with no model flag to carry the model', async () => {
		configure([{ id: 'a1', runOn: QWEN }]);

		const result = await applyAgentRunOnToSpawn({ ...input, agent: {} });

		expect(result).toMatchObject({ ok: false });
		if (result.ok) throw new Error('expected a refusal');
		expect(result.error).toContain('no model flag');
	});
});

describe('logRunOnLaunch', () => {
	const runOn = {
		model: 'qwen3:latest',
		contextTokens: 40_960,
		args: [],
		envVarNames: ['ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN'],
		userOverrides: [],
		clearedEnvVars: ['ANTHROPIC_API_KEY'],
	};
	const launch = { sessionId: 'a1-ai-t1', toolType: 'claude-code' };

	it('says where the model runs, with variable names and no values', () => {
		logRunOnLaunch('[Test]', launch, runOn);

		expect(logger.info).toHaveBeenCalledTimes(1);
		const [message, context, data] = vi.mocked(logger.info).mock.calls[0];
		expect(message).toBe('Running claude-code on qwen3:latest (Run on)');
		expect(context).toBe('[Test]');
		expect(data).toMatchObject({ sessionId: 'a1-ai-t1', envVars: runOn.envVarNames });
	});

	it('says that the gateway was skipped when the agent has one', () => {
		logRunOnLaunch('[Test]', launch, { ...runOn, skippedGatewayUrl: 'http://127.0.0.1:8787' });

		expect(logger.info).toHaveBeenCalledTimes(2);
		const [message, , data] = vi.mocked(logger.info).mock.calls[1];
		expect(message).toContain('Skipped the Local Models gateway');
		expect(data).toMatchObject({ gatewayUrl: 'http://127.0.0.1:8787' });
	});
});
