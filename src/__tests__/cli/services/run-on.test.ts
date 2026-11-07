/**
 * @file run-on.test.ts
 *
 * Run on for the agents `maestro-cli` launches in its own process. What is
 * pinned: an agent on its provider's model costs one parse (nothing is read,
 * imported or asked); a saved source is read from the settings file and asked
 * directly, with no running app; the Maestro model server is asked of the
 * running app; and with the app closed the launch is refused by name, never run
 * on the provider's model.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const storage = vi.hoisted(() => ({
	readLocalModelEndpoints: vi.fn(),
	readSessions: vi.fn(() => []),
	readSettingValue: vi.fn(),
	readSshRemotes: vi.fn(() => []),
}));
vi.mock('../../../cli/services/storage', () => storage);

const bridge = vi.hoisted(() => ({ sendCommand: vi.fn(), connectError: null as Error | null }));
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(async (action: (client: unknown) => Promise<unknown>) => {
		if (bridge.connectError) throw bridge.connectError;
		return action({ sendCommand: bridge.sendCommand });
	}),
}));

const endpointClient = vi.hoisted(() => ({ listEndpointModels: vi.fn() }));
vi.mock('../../../main/local-models/endpoint-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/local-models/endpoint-client')>()),
	listEndpointModels: endpointClient.listEndpointModels,
}));

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { configureCliRunOn, prepareCliRunOn, readRunOnFlags } from '../../../cli/services/run-on';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { isAgentRunOnConfigured, resetAgentRunOnForTests } from '../../../main/local-models/run-on';
import { GPT_OSS_20B_ID, getLocalModel } from '../../../shared/local-models/model-catalog';
import { MODEL_SERVER_ENDPOINT_ID } from '../../../shared/local-models/model-server';
import {
	RUN_ON_DEFAULT_CONTEXT_TOKENS,
	RUN_ON_MIN_CONTEXT_TOKENS,
} from '../../../shared/local-models/run-on';

const WORKSTATION = {
	id: 'ep-ws',
	name: 'Workstation',
	kind: 'openai-compatible' as const,
	baseUrl: 'https://models.example.com',
	apiKeyEnvVar: 'WORKSTATION_KEY',
	enabled: true,
};
const BIG = { type: 'source', endpointId: WORKSTATION.id, model: 'big-model' };
const ON_SERVER = { type: 'source', endpointId: MODEL_SERVER_ENDPOINT_ID, model: 'gpt-oss-20b' };

beforeEach(() => {
	vi.clearAllMocks();
	bridge.connectError = null;
	storage.readLocalModelEndpoints.mockReturnValue([WORKSTATION]);
	storage.readSettingValue.mockImplementation((key: string) =>
		key === 'shellEnvVars' ? { WORKSTATION_KEY: 'sk-workstation' } : undefined
	);
	storage.readSshRemotes.mockReturnValue([]);
	endpointClient.listEndpointModels.mockResolvedValue([{ id: 'big-model' }]);
});

afterEach(() => {
	resetAgentRunOnForTests();
});

describe('prepareCliRunOn: an agent on its provider', () => {
	it.each([[undefined], [{ type: 'provider' }]])(
		'answers none for %j without reading a store or wiring anything',
		async (target) => {
			expect(await prepareCliRunOn({ toolType: 'claude-code', target })).toEqual({ kind: 'none' });
			expect(isAgentRunOnConfigured()).toBe(false);
			expect(storage.readLocalModelEndpoints).not.toHaveBeenCalled();
			expect(storage.readSshRemotes).not.toHaveBeenCalled();
			expect(withMaestroClient).not.toHaveBeenCalled();
		}
	);
});

describe('prepareCliRunOn: a saved source', () => {
	it('reads the source and its key from the settings file and asks it, with no running app', async () => {
		bridge.connectError = new Error('Maestro desktop app is not running');

		const prepared = await prepareCliRunOn({ toolType: 'claude-code', target: BIG });

		expect(prepared).toEqual({
			kind: 'ready',
			runOn: { toolType: 'claude-code', target: BIG, endpoint: WORKSTATION, key: 'sk-workstation' },
			model: 'big-model',
			label: 'big-model on Workstation',
		});
		expect(endpointClient.listEndpointModels).toHaveBeenCalledWith(WORKSTATION, {
			shellEnvVars: { WORKSTATION_KEY: 'sk-workstation' },
		});
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	it('refuses a model the source does not serve', async () => {
		endpointClient.listEndpointModels.mockResolvedValue([{ id: 'another' }]);

		const prepared = await prepareCliRunOn({ toolType: 'claude-code', target: BIG });

		expect(prepared).toMatchObject({ kind: 'refused', code: 'run-on-model-not-served' });
	});

	it('tolerates a settings file with no shell variables', async () => {
		storage.readSettingValue.mockReturnValue(undefined);
		storage.readLocalModelEndpoints.mockReturnValue([{ ...WORKSTATION, apiKeyEnvVar: undefined }]);

		const prepared = await prepareCliRunOn({ toolType: 'claude-code', target: BIG });

		if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
		expect(prepared.runOn.key).toBeUndefined();
	});

	it('refuses a loopback source for an SSH remote read from the remotes file', async () => {
		storage.readLocalModelEndpoints.mockReturnValue([
			{ ...WORKSTATION, baseUrl: 'http://127.0.0.1:11434', apiKeyEnvVar: undefined },
		]);
		storage.readSshRemotes.mockReturnValue([
			{
				id: 'r1',
				name: 'Build Box',
				host: 'build.example.com',
				port: 22,
				username: 'dev',
				privateKeyPath: '',
				enabled: true,
			},
		]);

		const prepared = await prepareCliRunOn({
			toolType: 'claude-code',
			target: BIG,
			sshRemoteConfig: { enabled: true, remoteId: 'r1' },
		});

		expect(prepared).toMatchObject({ kind: 'refused', code: 'run-on-loopback-on-remote' });
		if (prepared.kind !== 'refused') throw new Error('expected a refusal');
		expect(prepared.message).toContain('"Build Box"');
		expect(endpointClient.listEndpointModels).not.toHaveBeenCalled();
	});
});

describe('prepareCliRunOn: the Maestro model server', () => {
	it('asks the running app to make the server ready, and takes its address and key', async () => {
		bridge.sendCommand.mockResolvedValue({
			success: true,
			baseUrl: 'http://127.0.0.1:52100',
			key: 'sk-server',
		});

		const prepared = await prepareCliRunOn({ toolType: 'codex', target: ON_SERVER });

		expect(bridge.sendCommand).toHaveBeenCalledWith(
			{ type: 'local_models_server_ensure', model: 'gpt-oss-20b' },
			'local_models_server_ensure_result',
			expect.any(Number)
		);
		// A large model can take ten minutes to load; the wait covers it.
		expect(bridge.sendCommand.mock.calls[0][2]).toBeGreaterThanOrEqual(10 * 60 * 1000);
		if (prepared.kind !== 'ready') throw new Error(JSON.stringify(prepared));
		expect(prepared.runOn.endpoint).toMatchObject({
			id: MODEL_SERVER_ENDPOINT_ID,
			baseUrl: 'http://127.0.0.1:52100',
		});
		expect(prepared.runOn.key).toBe('sk-server');
	});

	it("refuses by name when the app is not running, and never falls back to the provider's model", async () => {
		bridge.connectError = new Error('Maestro desktop app is not running');

		const prepared = await prepareCliRunOn({ toolType: 'codex', target: ON_SERVER });

		expect(prepared).toMatchObject({ kind: 'refused', code: 'run-on-server-failed' });
		if (prepared.kind !== 'refused') throw new Error('expected a refusal');
		expect(prepared.message).toContain('runs inside the Maestro app');
		expect(prepared.message).toContain('Maestro desktop app is not running');
		expect(prepared.message).toContain('set Run on to Provider');
	});

	it("refuses with the app's reason when the server cannot serve the model", async () => {
		bridge.sendCommand.mockResolvedValue({
			success: false,
			error: 'gpt-oss 20B is not downloaded.',
		});

		const prepared = await prepareCliRunOn({ toolType: 'codex', target: ON_SERVER });

		if (prepared.kind !== 'refused') throw new Error('expected a refusal');
		expect(prepared.message).toContain('gpt-oss 20B is not downloaded');
	});

	it('refuses an answer that carries no address or key', async () => {
		bridge.sendCommand.mockResolvedValue({ success: true, baseUrl: 'http://127.0.0.1:52100' });

		const prepared = await prepareCliRunOn({ toolType: 'codex', target: ON_SERVER });

		expect(prepared).toMatchObject({ kind: 'refused', code: 'run-on-server-failed' });
	});
});

describe('configureCliRunOn', () => {
	it('wires the stores once, and leaves an earlier wiring alone', async () => {
		await configureCliRunOn();
		expect(isAgentRunOnConfigured()).toBe(true);

		await configureCliRunOn();
		// Still nothing read: wiring is not a lookup.
		expect(storage.readLocalModelEndpoints).not.toHaveBeenCalled();
	});
});

describe('readRunOnFlags', () => {
	const CLAUDE = { toolType: 'claude-code' };
	const BIG_DEFAULT = { ...BIG, contextTokens: RUN_ON_DEFAULT_CONTEXT_TOKENS };

	it('leaves the target alone, and reads nothing, when neither flag is passed', () => {
		expect(readRunOnFlags({}, { ...CLAUDE, runOn: BIG })).toEqual({ kind: 'unchanged' });
		expect(storage.readLocalModelEndpoints).not.toHaveBeenCalled();
	});

	it.each(['provider', 'Provider', ' provider '])('clears the target for %j', (runOn) => {
		expect(readRunOnFlags({ runOn }, { ...CLAUDE, runOn: BIG })).toEqual({
			kind: 'set',
			target: undefined,
		});
	});

	it('names a saved source, at the context the picker field starts at', () => {
		expect(readRunOnFlags({ runOn: 'ep-ws:big-model' }, CLAUDE)).toEqual({
			kind: 'set',
			target: BIG_DEFAULT,
		});
	});

	it("starts a model on the Maestro model server at the catalog's context", () => {
		const edit = readRunOnFlags({ runOn: `${MODEL_SERVER_ENDPOINT_ID}:${GPT_OSS_20B_ID}` }, CLAUDE);

		expect(edit).toEqual({
			kind: 'set',
			target: {
				type: 'source',
				endpointId: MODEL_SERVER_ENDPOINT_ID,
				model: GPT_OSS_20B_ID,
				contextTokens: Math.max(
					getLocalModel(GPT_OSS_20B_ID)?.defaultContext ?? 0,
					RUN_ON_MIN_CONTEXT_TOKENS
				),
			},
		});
	});

	it('ends the source id at the first colon, so a model name may hold one', () => {
		storage.readLocalModelEndpoints.mockReturnValue([{ ...WORKSTATION, id: 'ep-ollama' }]);

		const edit = readRunOnFlags({ runOn: 'ep-ollama:qwen3:latest' }, CLAUDE);

		expect(edit).toMatchObject({
			kind: 'set',
			target: { endpointId: 'ep-ollama', model: 'qwen3:latest' },
		});
	});

	it('stores the context it is given', () => {
		expect(readRunOnFlags({ runOn: 'ep-ws:big-model', runOnContext: ' 131072 ' }, CLAUDE)).toEqual({
			kind: 'set',
			target: { ...BIG, contextTokens: 131_072 },
		});
	});

	it('keeps the stored context when the same target is named again', () => {
		const stored = { ...BIG, contextTokens: 131_072 };

		expect(readRunOnFlags({ runOn: 'ep-ws:big-model' }, { ...CLAUDE, runOn: stored })).toEqual({
			kind: 'set',
			target: stored,
		});
	});

	it('starts another model on the same source from its own default', () => {
		const stored = { ...BIG, contextTokens: 131_072 };

		expect(readRunOnFlags({ runOn: 'ep-ws:other' }, { ...CLAUDE, runOn: stored })).toEqual({
			kind: 'set',
			target: { ...BIG, model: 'other', contextTokens: RUN_ON_DEFAULT_CONTEXT_TOKENS },
		});
	});

	it("changes only the context of the agent's current target when given the context alone", () => {
		expect(
			readRunOnFlags(
				{ runOnContext: '65536' },
				{ ...CLAUDE, runOn: { ...BIG, contextTokens: 131_072 } }
			)
		).toEqual({ kind: 'set', target: { ...BIG, contextTokens: 65_536 } });
	});

	it.each([[undefined], [{ type: 'provider' }], [{ type: 'source' }]])(
		'refuses the context alone for an agent with no usable source target (%j)',
		(runOn) => {
			const edit = readRunOnFlags({ runOnContext: '65536' }, { ...CLAUDE, runOn });

			expect(edit.kind).toBe('refused');
			if (edit.kind === 'refused') expect(edit.error).toContain('Pass --run-on');
		}
	);

	it('refuses a context beside --run-on provider', () => {
		const edit = readRunOnFlags({ runOn: 'provider', runOnContext: '65536' }, CLAUDE);

		expect(edit.kind).toBe('refused');
		if (edit.kind === 'refused')
			expect(edit.error).toContain('does not apply to --run-on provider');
	});

	it.each(['64k', '65536.5', '-1', '', '1e5'])('refuses %j as a context size', (runOnContext) => {
		const edit = readRunOnFlags({ runOn: 'ep-ws:big-model', runOnContext }, CLAUDE);

		expect(edit.kind).toBe('refused');
		if (edit.kind === 'refused') {
			expect(edit.error).toContain('--run-on-context expects a whole number of tokens');
		}
	});

	it('refuses a context under the agent minimum, by the shared rule', () => {
		const edit = readRunOnFlags({ runOn: 'ep-ws:big-model', runOnContext: '8192' }, CLAUDE);

		expect(edit.kind).toBe('refused');
		if (edit.kind === 'refused') {
			expect(edit.error).toMatch(/^--run-on-context: .*at least 40960 tokens/);
		}
	});

	it('refuses a spelling that is not a target', () => {
		const edit = readRunOnFlags({ runOn: 'big-model' }, CLAUDE);

		expect(edit.kind).toBe('refused');
		if (edit.kind === 'refused') expect(edit.error).toMatch(/^--run-on: .*<source id>:<model>/);
	});

	it('refuses a source id that names nothing, before any launch does', () => {
		const edit = readRunOnFlags({ runOn: 'ep-typo:big-model' }, CLAUDE);

		expect(edit.kind).toBe('refused');
		if (edit.kind === 'refused') {
			expect(edit.error).toContain('--run-on: No source has the id "ep-typo"');
			expect(edit.error).toContain('ep-ws (Workstation)');
		}
	});

	it("refuses a source for a provider with no recipe, with the provider's reason", () => {
		const edit = readRunOnFlags({ runOn: 'ep-ws:big-model' }, { toolType: 'gemini-cli' });

		expect(edit.kind).toBe('refused');
		if (edit.kind === 'refused') expect(edit.error).toContain('speaks only the Gemini API');
	});

	it('still clears a target left on a provider with no recipe', () => {
		expect(readRunOnFlags({ runOn: 'provider' }, { toolType: 'gemini-cli', runOn: BIG })).toEqual({
			kind: 'set',
			target: undefined,
		});
	});

	it("asks no source and no app: whether the model is served is the test verb's question", () => {
		readRunOnFlags({ runOn: 'ep-ws:big-model' }, CLAUDE);

		expect(endpointClient.listEndpointModels).not.toHaveBeenCalled();
		expect(withMaestroClient).not.toHaveBeenCalled();
	});
});
