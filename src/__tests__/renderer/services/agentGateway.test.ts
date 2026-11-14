/**
 * Tests for the agentGateway service - validating an agent's Local Models
 * gateway and getting it to the main process before the next spawn reads it.
 * Also the Maestro token proxy mode switch, which is the same kind of write:
 * the mode and the gateway URL it implies are stored and flushed together.
 * And the background requests target, which belongs to the proxy: refused for
 * an agent that is not on it, and gone when the agent leaves it. And the
 * retrieval switch, refused unless the proxy compresses, and cleared the same way.
 * And the proxy default: the agents that follow it move with it, overrides stay.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	applyDefaultAgentTokenProxy,
	chooseTokenProxyDefault,
	flushAgentToStore,
	followTokenProxyDefault,
	setAgentBackgroundRequests,
	setAgentGatewayUrl,
	setAgentTokenProxyMode,
	setAgentTokenProxyRetrieval,
	syncAgentsToTokenProxyDefault,
	tokenProxyDefaultBlocker,
} from '../../../renderer/services/agentGateway';
import {
	TOKEN_PROXY_DEFAULT_APPLIED_SETTING,
	TOKEN_PROXY_RETRIEVAL_NEEDS_COMPRESSION,
} from '../../../shared/local-models/token-proxy';
import { BACKGROUND_REQUESTS_NEEDS_PROXY } from '../../../shared/local-models/background-requests';
import { RUN_ON_GATEWAY_SKIPPED_REASON } from '../../../shared/local-models/run-on';
import type { LocalModelEndpoint } from '../../../shared/local-models/endpoints';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { useNotificationStore } from '../../../renderer/stores/notificationStore';
import type { Session } from '../../../renderer/types';

function seed(overrides: Partial<Session> = {}): Session {
	const session = {
		id: 'agent-1',
		name: 'Agent',
		toolType: 'claude-code',
		aiTabs: [],
		...overrides,
	} as unknown as Session;
	useSessionStore.setState({ sessions: [session] });
	return session;
}

function stored(): Session {
	return useSessionStore.getState().sessions[0];
}

const PROXY_PORT = 48123;
const proxyUrl = (path: string) => `http://127.0.0.1:${PROXY_PORT}${path}`;

/** What `proxy.report()` answers, for a proxy with or without a port. */
function proxyReport(port: number | null) {
	return {
		status: { port, running: false, agentIds: [], lastError: null, gatewayUrls: null },
		agents: [],
		usage: null,
		recentCompressions: [],
	};
}

const OLLAMA: LocalModelEndpoint = {
	id: 'ep-ollama',
	name: 'Ollama',
	kind: 'ollama',
	baseUrl: 'http://127.0.0.1:11434',
	enabled: true,
};
const CLOUD: LocalModelEndpoint = {
	id: 'ep-cloud',
	name: 'OpenRouter',
	kind: 'openai-compatible',
	baseUrl: 'https://openrouter.ai/api/v1',
	enabled: true,
};
const QWEN = { type: 'source' as const, endpointId: OLLAMA.id, model: 'qwen3:4b' };

beforeEach(() => {
	useNotificationStore.setState({ toasts: [] });
	vi.mocked(window.maestro.sessions.setMany).mockReset();
	vi.mocked(window.maestro.sessions.setMany).mockResolvedValue(undefined as never);
	const proxy = window.maestro.localModels.proxy;
	vi.mocked(proxy.ensurePort).mockReset();
	vi.mocked(proxy.ensurePort).mockResolvedValue(PROXY_PORT);
	vi.mocked(proxy.report).mockReset();
	vi.mocked(proxy.report).mockResolvedValue(proxyReport(PROXY_PORT) as never);
	vi.mocked(window.maestro.agents.getCustomEnvVars).mockReset();
	vi.mocked(window.maestro.agents.getCustomEnvVars).mockResolvedValue(null);
	// `settingsFile()` gives a test a settings file it can read back; reset it.
	vi.mocked(window.maestro.settings.get).mockReset();
	vi.mocked(window.maestro.settings.get).mockResolvedValue(undefined);
	vi.mocked(window.maestro.settings.set).mockReset();
	vi.mocked(window.maestro.settings.set).mockResolvedValue(undefined);
	useSettingsStore.setState({
		shellEnvVars: {},
		localModelEndpoints: [OLLAMA, CLOUD],
		defaultTokenProxyMode: 'off',
	});
});

describe('applyDefaultAgentTokenProxy', () => {
	it.each(['passthrough', 'compress', 'compress-early'] as const)(
		'copies %s onto a new agent and persists its gateway before returning',
		async (mode) => {
			seed();
			useSettingsStore.setState({ defaultTokenProxyMode: mode });
			await applyDefaultAgentTokenProxy('agent-1');
			expect(stored()).toMatchObject({ gatewayUrl: proxyUrl('/anthropic'), tokenProxyMode: mode });
			expect(window.maestro.sessions.setMany).toHaveBeenCalledWith(
				[expect.objectContaining({ tokenProxyMode: mode, gatewayUrl: proxyUrl('/anthropic') })],
				[]
			);
		}
	);

	it.each(['passthrough', 'compress', 'compress-early'] as const)(
		'applies %s when the provider is explicitly selected',
		async (mode) => {
			seed({ runOn: { type: 'provider' } });
			useSettingsStore.setState({ defaultTokenProxyMode: mode });
			await applyDefaultAgentTokenProxy('agent-1');
			expect(stored()).toMatchObject({
				runOn: { type: 'provider' },
				gatewayUrl: proxyUrl('/anthropic'),
				tokenProxyMode: mode,
			});
			expect(window.maestro.sessions.setMany).toHaveBeenCalledWith(
				[expect.objectContaining({ tokenProxyMode: mode, gatewayUrl: proxyUrl('/anthropic') })],
				[]
			);
		}
	);

	it.each<Partial<Session>>([
		{ gatewayUrl: 'https://external.example.com' },
		{ tokenProxyMode: 'off' },
		{ tokenProxyMode: 'passthrough', gatewayUrl: proxyUrl('/anthropic') },
		{ runOn: QWEN },
		{ runOn: { type: 'source' } as Session['runOn'] },
		{ sessionSshRemoteConfig: { enabled: true, remoteId: 'box' } },
		{ toolType: 'copilot-cli' },
		{ toolType: 'terminal' },
	])('preserves explicit routing and skips ineligible agents: %j', async (overrides) => {
		const original = seed(overrides);
		useSettingsStore.setState({ defaultTokenProxyMode: 'compress' });
		await applyDefaultAgentTokenProxy('agent-1');
		expect(stored()).toBe(original);
		expect(window.maestro.localModels.proxy.ensurePort).not.toHaveBeenCalled();
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('leaves a new agent direct when the default is off', async () => {
		const original = seed();
		await applyDefaultAgentTokenProxy('agent-1');
		expect(stored()).toBe(original);
		expect(window.maestro.localModels.proxy.ensurePort).not.toHaveBeenCalled();
	});

	it('reports a refused default so the user can see that routing was not applied', async () => {
		const original = seed();
		useSettingsStore.setState({ defaultTokenProxyMode: 'compress' });
		vi.mocked(window.maestro.localModels.proxy.ensurePort).mockRejectedValueOnce(
			new Error('Port unavailable')
		);
		await applyDefaultAgentTokenProxy('agent-1');
		expect(stored()).toBe(original);
		expect(useNotificationStore.getState().toasts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					title: 'Proxy default was not applied',
					message: 'Agent: Port unavailable',
				}),
			])
		);
	});
});

/** Several agents at once, for the proxy default. */
function seedMany(...sessions: Array<Partial<Session> & { id: string }>): void {
	useSessionStore.setState({
		sessions: sessions.map(
			(overrides) =>
				({
					name: overrides.id,
					toolType: 'claude-code',
					aiTabs: [],
					...overrides,
				}) as unknown as Session
		),
	});
}

function agentById(id: string): Session | undefined {
	return useSessionStore.getState().sessions.find((s) => s.id === id);
}

/** A settings file the service reads back what it wrote to. */
function settingsFile(initial: Record<string, unknown> = {}): Map<string, unknown> {
	const file = new Map<string, unknown>(Object.entries(initial));
	vi.mocked(window.maestro.settings.get).mockImplementation(async (key: string) => file.get(key));
	vi.mocked(window.maestro.settings.set).mockImplementation(async (key: string, value: unknown) => {
		file.set(key, value);
	});
	return file;
}

describe('tokenProxyDefaultBlocker', () => {
	it('names why an agent cannot use the proxy, and passes one that can', () => {
		expect(tokenProxyDefaultBlocker(seed())).toBeNull();
		expect(tokenProxyDefaultBlocker(seed({ runOn: { type: 'provider' } }))).toBeNull();
		expect(tokenProxyDefaultBlocker(seed({ runOn: QWEN }))).toBe(RUN_ON_GATEWAY_SKIPPED_REASON);
		expect(
			tokenProxyDefaultBlocker(seed({ sessionSshRemoteConfig: { enabled: true, remoteId: 'box' } }))
		).toMatch(/SSH remote/);
		expect(tokenProxyDefaultBlocker(seed({ toolType: 'copilot-cli' }))).toEqual(expect.any(String));
	});
});

describe('syncAgentsToTokenProxyDefault', () => {
	it('moves the agents that followed the old default and leaves the overrides', async () => {
		const file = settingsFile({ [TOKEN_PROXY_DEFAULT_APPLIED_SETTING]: 'off' });
		seedMany(
			{ id: 'follower' },
			{ id: 'external', gatewayUrl: 'https://external.example.com' },
			{ id: 'remote', sessionSshRemoteConfig: { enabled: true, remoteId: 'box' } },
			{ id: 'routed', runOn: QWEN }
		);
		useSettingsStore.setState({ defaultTokenProxyMode: 'compress' });

		const result = await syncAgentsToTokenProxyDefault();

		expect(result).toEqual({ mode: 'compress', moved: 1, failed: [] });
		expect(agentById('follower')).toMatchObject({
			gatewayUrl: proxyUrl('/anthropic'),
			tokenProxyMode: 'compress',
		});
		expect(agentById('external')?.gatewayUrl).toBe('https://external.example.com');
		expect(agentById('remote')?.gatewayUrl).toBeUndefined();
		expect(agentById('routed')?.gatewayUrl).toBeUndefined();
		expect(file.get(TOKEN_PROXY_DEFAULT_APPLIED_SETTING)).toBe('compress');
	});

	it('takes the followers off the proxy and keeps an agent set to another mode', async () => {
		settingsFile({ [TOKEN_PROXY_DEFAULT_APPLIED_SETTING]: 'compress' });
		seedMany(
			{ id: 'follower', gatewayUrl: proxyUrl('/anthropic'), tokenProxyMode: 'compress' },
			{ id: 'counter', gatewayUrl: proxyUrl('/anthropic'), tokenProxyMode: 'passthrough' }
		);
		useSettingsStore.setState({ defaultTokenProxyMode: 'off' });

		const result = await syncAgentsToTokenProxyDefault();

		expect(result).toEqual({ mode: 'off', moved: 1, failed: [] });
		expect(agentById('follower')?.gatewayUrl).toBeUndefined();
		expect(agentById('follower')?.tokenProxyMode).toBeUndefined();
		expect(agentById('counter')).toMatchObject({ tokenProxyMode: 'passthrough' });
		// The port is read once for the pass, not once per agent.
		expect(window.maestro.localModels.proxy.report).toHaveBeenCalledTimes(1);
	});

	it('records the first default it sees without moving anyone', async () => {
		const file = settingsFile();
		const original = seed();
		useSettingsStore.setState({ defaultTokenProxyMode: 'compress' });

		expect(await syncAgentsToTokenProxyDefault()).toBeNull();
		expect(stored()).toBe(original);
		expect(file.get(TOKEN_PROXY_DEFAULT_APPLIED_SETTING)).toBe('compress');
	});

	it('does nothing when the agents already follow the current default', async () => {
		settingsFile({ [TOKEN_PROXY_DEFAULT_APPLIED_SETTING]: 'off' });
		const original = seed();
		expect(await syncAgentsToTokenProxyDefault()).toBeNull();
		expect(stored()).toBe(original);
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('shares one run between callers', async () => {
		settingsFile({ [TOKEN_PROXY_DEFAULT_APPLIED_SETTING]: 'off' });
		seed();
		useSettingsStore.setState({ defaultTokenProxyMode: 'compress' });
		const [first, second] = [syncAgentsToTokenProxyDefault(), syncAgentsToTokenProxyDefault()];
		expect(second).toBe(first);
		expect(await first).toEqual({ mode: 'compress', moved: 1, failed: [] });
		expect(window.maestro.sessions.setMany).toHaveBeenCalledTimes(1);
	});

	it('names an agent it could not move, keeps its routing and still records the default', async () => {
		const file = settingsFile({ [TOKEN_PROXY_DEFAULT_APPLIED_SETTING]: 'off' });
		seedMany({ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' });
		useSettingsStore.setState({ defaultTokenProxyMode: 'compress' });
		vi.mocked(window.maestro.localModels.proxy.ensurePort).mockRejectedValueOnce(
			new Error('Port unavailable')
		);

		const result = await syncAgentsToTokenProxyDefault();

		expect(result).toEqual({ mode: 'compress', moved: 1, failed: ['Alpha: Port unavailable'] });
		expect(agentById('a')?.gatewayUrl).toBeUndefined();
		expect(agentById('b')?.tokenProxyMode).toBe('compress');
		expect(file.get(TOKEN_PROXY_DEFAULT_APPLIED_SETTING)).toBe('compress');
		expect(useNotificationStore.getState().toasts).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					title: 'Proxy default not applied to 1 agent',
					message: 'Alpha: Port unavailable',
				}),
			])
		);
	});
});

describe('chooseTokenProxyDefault', () => {
	it('saves the default and moves the followers', async () => {
		const file = settingsFile({ [TOKEN_PROXY_DEFAULT_APPLIED_SETTING]: 'off' });
		seed();
		const result = await chooseTokenProxyDefault('passthrough', { sync: true });
		expect(result).toEqual({ mode: 'passthrough', moved: 1, failed: [] });
		expect(file.get('defaultTokenProxyMode')).toBe('passthrough');
		expect(useSettingsStore.getState().defaultTokenProxyMode).toBe('passthrough');
		expect(stored().tokenProxyMode).toBe('passthrough');
	});

	it('records the old default first on an install that never synced', async () => {
		const file = settingsFile();
		seed();
		await chooseTokenProxyDefault('compress', { sync: true });
		// The baseline was off, so the agent with no gateway followed it and moved.
		expect(stored().tokenProxyMode).toBe('compress');
		expect(file.get(TOKEN_PROXY_DEFAULT_APPLIED_SETTING)).toBe('compress');
	});

	it('leaves the agents to the owning window when told not to sync', async () => {
		settingsFile({ [TOKEN_PROXY_DEFAULT_APPLIED_SETTING]: 'off' });
		const original = seed();
		expect(await chooseTokenProxyDefault('compress', { sync: false })).toBeNull();
		expect(useSettingsStore.getState().defaultTokenProxyMode).toBe('compress');
		expect(stored()).toBe(original);
	});

	it('changes no agent when the default cannot be saved', async () => {
		settingsFile({ [TOKEN_PROXY_DEFAULT_APPLIED_SETTING]: 'off' });
		const original = seed();
		vi.mocked(window.maestro.settings.set).mockRejectedValueOnce(new Error('Write failed'));
		await expect(chooseTokenProxyDefault('compress', { sync: true })).rejects.toThrow(
			'Write failed'
		);
		expect(useSettingsStore.getState().defaultTokenProxyMode).toBe('off');
		expect(stored()).toBe(original);
	});
});

describe('followTokenProxyDefault', () => {
	it('puts an agent that opted out back on an on default', async () => {
		useSettingsStore.setState({ defaultTokenProxyMode: 'compress' });
		seed();
		const result = await followTokenProxyDefault('agent-1');
		expect(result).toMatchObject({ ok: true, mode: 'compress' });
		expect(stored()).toMatchObject({
			gatewayUrl: proxyUrl('/anthropic'),
			tokenProxyMode: 'compress',
		});
	});

	it('replaces a gateway set by hand with the default', async () => {
		useSettingsStore.setState({ defaultTokenProxyMode: 'off' });
		seed({ gatewayUrl: 'https://external.example.com' });
		expect(await followTokenProxyDefault('agent-1')).toMatchObject({ ok: true, mode: 'off' });
		expect(stored().gatewayUrl).toBeUndefined();
	});

	it('sends an agent that cannot use the proxy direct', async () => {
		useSettingsStore.setState({ defaultTokenProxyMode: 'compress' });
		seed({
			gatewayUrl: 'https://external.example.com',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'box' },
		});
		expect(await followTokenProxyDefault('agent-1')).toMatchObject({ ok: true, mode: 'off' });
		expect(stored().gatewayUrl).toBeUndefined();
		expect(window.maestro.localModels.proxy.ensurePort).not.toHaveBeenCalled();
	});
});

describe('setAgentGatewayUrl', () => {
	it('stores the normalized URL and flushes the agent to main', async () => {
		seed();

		const result = await setAgentGatewayUrl('agent-1', ' http://127.0.0.1:8787/anthropic/ ');

		expect(result).toEqual({ ok: true, gatewayUrl: 'http://127.0.0.1:8787/anthropic' });
		expect(stored().gatewayUrl).toBe('http://127.0.0.1:8787/anthropic');
		// The desktop spawn reads the gateway from main's store; the debounced
		// persistence would leave it stale for a message sent straight after.
		expect(window.maestro.sessions.setMany).toHaveBeenCalledWith(
			[expect.objectContaining({ id: 'agent-1', gatewayUrl: 'http://127.0.0.1:8787/anthropic' })],
			[]
		);
	});

	it.each(['', 'none'])('clears the gateway for %j', async (raw) => {
		seed({ gatewayUrl: 'http://127.0.0.1:8787' });

		const result = await setAgentGatewayUrl('agent-1', raw);

		expect(result).toEqual({ ok: true, gatewayUrl: undefined });
		expect(stored().gatewayUrl).toBeUndefined();
		expect(window.maestro.sessions.setMany).toHaveBeenCalledTimes(1);
	});

	it('writes nothing when the value did not change', async () => {
		seed({ gatewayUrl: 'http://127.0.0.1:8787' });

		const result = await setAgentGatewayUrl('agent-1', 'http://127.0.0.1:8787/');

		expect(result).toEqual({ ok: true, gatewayUrl: 'http://127.0.0.1:8787' });
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('refuses a value that is not a URL and leaves the agent alone', async () => {
		seed();

		const result = await setAgentGatewayUrl('agent-1', 'nope');

		expect(result.ok).toBe(false);
		expect(stored().gatewayUrl).toBeUndefined();
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('refuses a provider that cannot use a gateway, with the reason', async () => {
		seed({ toolType: 'copilot-cli' } as Partial<Session>);

		const result = await setAgentGatewayUrl('agent-1', 'http://127.0.0.1:8787');

		expect(result).toEqual({
			ok: false,
			error: expect.stringContaining('reads a base URL only for a BYOK provider'),
		});
	});

	it('reports an agent that does not exist', async () => {
		seed();

		expect(await setAgentGatewayUrl('missing', 'http://127.0.0.1:8787')).toEqual({
			ok: false,
			error: 'Agent not found',
		});
	});

	it('still reports success when the flush fails: the renderer store holds the value', async () => {
		seed();
		vi.mocked(window.maestro.sessions.setMany).mockRejectedValue(new Error('disk full'));

		const result = await setAgentGatewayUrl('agent-1', 'http://127.0.0.1:8787');

		expect(result.ok).toBe(true);
		expect(stored().gatewayUrl).toBe('http://127.0.0.1:8787');
	});
});

describe('flushAgentToStore', () => {
	it('keeps best-effort callers nonthrowing when persistence fails', async () => {
		seed();
		vi.mocked(window.maestro.sessions.setMany).mockRejectedValueOnce(
			new Error('Store unavailable')
		);
		await expect(flushAgentToStore('agent-1')).resolves.toBeUndefined();
	});

	it('does nothing for an agent that does not exist', async () => {
		seed();

		await flushAgentToStore('missing');

		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});
});

describe('setAgentTokenProxyMode', () => {
	it.each(['passthrough', 'compress', 'compress-early'] as const)(
		'refuses %s on a model source before setting up or persisting the proxy',
		async (mode) => {
			const original = seed({ runOn: QWEN });
			expect(await setAgentTokenProxyMode('agent-1', mode)).toEqual({
				ok: false,
				error: RUN_ON_GATEWAY_SKIPPED_REASON,
			});
			expect(stored()).toBe(original);
			expect(window.maestro.localModels.proxy.ensurePort).not.toHaveBeenCalled();
			expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
		}
	);

	it('still clears stale proxy settings on a model source', async () => {
		seed({ runOn: QWEN, gatewayUrl: proxyUrl('/anthropic'), tokenProxyMode: 'compress' });
		expect(await setAgentTokenProxyMode('agent-1', 'off')).toMatchObject({ ok: true, mode: 'off' });
		expect(stored().gatewayUrl).toBeUndefined();
		expect(stored().tokenProxyMode).toBeUndefined();
	});

	it.each(['compress', 'off'] as const)(
		'rejects a failed immediate %s write and retries it even when renderer state matches',
		async (mode) => {
			seed({ gatewayUrl: proxyUrl('/anthropic'), tokenProxyMode: 'passthrough' });
			vi.mocked(window.maestro.sessions.setMany).mockRejectedValueOnce(
				new Error('Store unavailable')
			);
			await expect(setAgentTokenProxyMode('agent-1', mode)).rejects.toThrow('Store unavailable');
			await expect(setAgentTokenProxyMode('agent-1', mode)).resolves.toMatchObject({
				ok: true,
				mode,
			});
			expect(window.maestro.sessions.setMany).toHaveBeenCalledTimes(2);
		}
	);

	it('makes a failed blanket-default write visible', async () => {
		seed();
		useSettingsStore.setState({ defaultTokenProxyMode: 'compress' });
		vi.mocked(window.maestro.sessions.setMany).mockRejectedValueOnce(
			new Error('Store unavailable')
		);
		await applyDefaultAgentTokenProxy('agent-1');
		expect(useNotificationStore.getState().toasts).toEqual(
			expect.arrayContaining([expect.objectContaining({ title: 'Proxy default was not applied' })])
		);
	});

	it('points the agent at the proxy and stores the mode, in one flushed write', async () => {
		seed();

		const result = await setAgentTokenProxyMode('agent-1', 'compress');

		expect(result).toEqual({ ok: true, mode: 'compress', gatewayUrl: proxyUrl('/anthropic') });
		expect(stored().gatewayUrl).toBe(proxyUrl('/anthropic'));
		expect(stored().tokenProxyMode).toBe('compress');
		// The proxy reads the mode from main's store on the next request.
		expect(window.maestro.sessions.setMany).toHaveBeenCalledWith(
			[
				expect.objectContaining({
					id: 'agent-1',
					gatewayUrl: proxyUrl('/anthropic'),
					tokenProxyMode: 'compress',
				}),
			],
			[]
		);
	});

	it('replaces a gateway that points somewhere else', async () => {
		seed({ gatewayUrl: 'http://127.0.0.1:8787' });

		await setAgentTokenProxyMode('agent-1', 'passthrough');

		expect(stored().gatewayUrl).toBe(proxyUrl('/anthropic'));
		expect(stored().tokenProxyMode).toBe('passthrough');
	});

	it('keeps the route of a gateway that is already the proxy, and changes only the mode', async () => {
		// The user picked the API-key route by hand; a mode switch must not undo it.
		seed({ toolType: 'codex', gatewayUrl: proxyUrl('/openai/v1') } as Partial<Session>);

		const result = await setAgentTokenProxyMode('agent-1', 'compress');

		expect(result).toEqual({ ok: true, mode: 'compress', gatewayUrl: proxyUrl('/openai/v1') });
		expect(stored().tokenProxyMode).toBe('compress');
	});

	it('routes Codex by its credential, read from the environment the spawn would use', async () => {
		seed({ toolType: 'codex' } as Partial<Session>);
		await setAgentTokenProxyMode('agent-1', 'passthrough');
		expect(stored().gatewayUrl).toBe(proxyUrl('/chatgpt'));

		// A key in the provider-level vars is in force when the agent has none.
		seed({ toolType: 'codex' } as Partial<Session>);
		vi.mocked(window.maestro.agents.getCustomEnvVars).mockResolvedValue({ OPENAI_API_KEY: 'sk-1' });
		await setAgentTokenProxyMode('agent-1', 'passthrough');
		expect(stored().gatewayUrl).toBe(proxyUrl('/openai/v1'));
		expect(window.maestro.agents.getCustomEnvVars).toHaveBeenCalledWith('codex');

		// The agent's own vars replace the provider-level set.
		seed({ toolType: 'codex', customEnvVars: { OTHER: '1' } } as Partial<Session>);
		await setAgentTokenProxyMode('agent-1', 'passthrough');
		expect(stored().gatewayUrl).toBe(proxyUrl('/chatgpt'));

		// A key in Settings -> Environment reaches every agent.
		seed({ toolType: 'codex', customEnvVars: { OTHER: '1' } } as Partial<Session>);
		useSettingsStore.setState({ shellEnvVars: { OPENAI_API_KEY: 'sk-global' } });
		await setAgentTokenProxyMode('agent-1', 'passthrough');
		expect(stored().gatewayUrl).toBe(proxyUrl('/openai/v1'));
	});

	it("routes OpenCode by its model's provider, on a URL that carries /v1", async () => {
		seed({ toolType: 'opencode', customModel: 'anthropic/claude-opus-4-5' } as Partial<Session>);
		await setAgentTokenProxyMode('agent-1', 'passthrough');
		expect(stored().gatewayUrl).toBe(proxyUrl('/anthropic/v1'));

		// With no model of its own, the provider default decides.
		seed({ toolType: 'opencode' } as Partial<Session>);
		vi.mocked(window.maestro.agents.getConfig).mockResolvedValueOnce({ model: 'openai/gpt-5' });
		await setAgentTokenProxyMode('agent-1', 'passthrough');
		expect(stored().gatewayUrl).toBe(proxyUrl('/openai/v1'));

		// A model the proxy cannot carry is refused, and nothing is stored.
		const original = seed({
			toolType: 'opencode',
			customModel: 'ollama/qwen3:8b',
		} as Partial<Session>);
		const refused = await setAgentTokenProxyMode('agent-1', 'passthrough');
		expect(refused.ok).toBe(false);
		expect(stored()).toBe(original);
	});

	it('confirms main holds an unchanged mode before reporting success', async () => {
		seed({ gatewayUrl: proxyUrl('/anthropic'), tokenProxyMode: 'compress' });

		const result = await setAgentTokenProxyMode('agent-1', 'compress');

		expect(result.ok).toBe(true);
		expect(window.maestro.sessions.setMany).toHaveBeenCalledTimes(1);
	});

	it('off clears a gateway that is the proxy, and the stored mode with it', async () => {
		seed({ gatewayUrl: proxyUrl('/anthropic'), tokenProxyMode: 'compress' });

		const result = await setAgentTokenProxyMode('agent-1', 'off');

		expect(result).toEqual({ ok: true, mode: 'off', gatewayUrl: undefined });
		expect(stored().gatewayUrl).toBeUndefined();
		expect(stored().tokenProxyMode).toBeUndefined();
		expect(window.maestro.sessions.setMany).toHaveBeenCalledTimes(1);
		// Turning the proxy off must never be what creates its port.
		expect(window.maestro.localModels.proxy.ensurePort).not.toHaveBeenCalled();
	});

	it("off leaves somebody else's gateway alone", async () => {
		seed({ gatewayUrl: 'http://127.0.0.1:8787' });

		const result = await setAgentTokenProxyMode('agent-1', 'off');

		expect(result).toEqual({ ok: true, mode: 'off', gatewayUrl: 'http://127.0.0.1:8787' });
		expect(stored().gatewayUrl).toBe('http://127.0.0.1:8787');
		expect(window.maestro.sessions.setMany).toHaveBeenCalledWith(
			[expect.objectContaining({ gatewayUrl: 'http://127.0.0.1:8787' })],
			[]
		);
	});

	it('off changes nothing before the proxy has a port', async () => {
		vi.mocked(window.maestro.localModels.proxy.report).mockResolvedValue(
			proxyReport(null) as never
		);
		seed({ gatewayUrl: proxyUrl('/anthropic') });

		await setAgentTokenProxyMode('agent-1', 'off');

		expect(stored().gatewayUrl).toBe(proxyUrl('/anthropic'));
	});

	it('refuses a provider that cannot use a gateway, and chooses no port for it', async () => {
		seed({ toolType: 'copilot-cli' } as Partial<Session>);

		const result = await setAgentTokenProxyMode('agent-1', 'compress');

		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.error).toContain('Copilot CLI reads a base URL only for a BYOK provider');
		expect(window.maestro.localModels.proxy.ensurePort).not.toHaveBeenCalled();
		expect(stored().gatewayUrl).toBeUndefined();
	});

	it('refuses an agent on an SSH remote, which cannot reach loopback here', async () => {
		seed({ sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' } } as Partial<Session>);

		const result = await setAgentTokenProxyMode('agent-1', 'passthrough');

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('SSH remote');
		expect(stored().gatewayUrl).toBeUndefined();
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('reports an agent that does not exist', async () => {
		seed();
		expect(await setAgentTokenProxyMode('missing', 'compress')).toEqual({
			ok: false,
			error: 'Agent not found',
		});
	});
});

describe('setAgentGatewayUrl and the proxy mode', () => {
	it('refuses setting a gateway on a model source while allowing it to be cleared', async () => {
		const original = seed({ runOn: QWEN, gatewayUrl: 'https://old.example.com' });
		expect(await setAgentGatewayUrl('agent-1', 'https://new.example.com')).toEqual({
			ok: false,
			error: RUN_ON_GATEWAY_SKIPPED_REASON,
		});
		expect(stored()).toBe(original);
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
		expect(await setAgentGatewayUrl('agent-1', '')).toEqual({ ok: true, gatewayUrl: undefined });
		expect(stored().gatewayUrl).toBeUndefined();
	});

	it('drops the stored mode when the gateway changes, so it starts from the default', async () => {
		seed({ gatewayUrl: proxyUrl('/anthropic'), tokenProxyMode: 'compress' });

		await setAgentGatewayUrl('agent-1', 'http://127.0.0.1:8787');

		expect(stored().tokenProxyMode).toBeUndefined();
	});
});

describe('setAgentBackgroundRequests', () => {
	const onProxy = (overrides: Partial<Session> = {}) =>
		seed({ gatewayUrl: proxyUrl('/anthropic'), tokenProxyMode: 'passthrough', ...overrides });

	it('stores the target in its one form and flushes the agent to main', async () => {
		onProxy();

		const result = await setAgentBackgroundRequests('agent-1', {
			target: { ...QWEN, contextTokens: 65_536, stray: true },
		});

		expect(result).toEqual({ ok: true, backgroundRequests: { target: QWEN } });
		expect(stored().backgroundRequests).toEqual({ target: QWEN });
		// The proxy reads the target from main's store on every request.
		expect(window.maestro.sessions.setMany).toHaveBeenCalledWith(
			[expect.objectContaining({ id: 'agent-1', backgroundRequests: { target: QWEN } })],
			[]
		);
	});

	it('counts a gateway pointed at the proxy by hand: no stored mode is passthrough', async () => {
		seed({ gatewayUrl: proxyUrl('/anthropic') });

		expect((await setAgentBackgroundRequests('agent-1', { target: QWEN })).ok).toBe(true);
	});

	it('refuses an agent that is not on the proxy, and stores nothing', async () => {
		seed({ gatewayUrl: 'http://127.0.0.1:8787' });

		const result = await setAgentBackgroundRequests('agent-1', { target: QWEN });

		expect(result).toEqual({ ok: false, error: BACKGROUND_REQUESTS_NEEDS_PROXY });
		expect(stored().backgroundRequests).toBeUndefined();
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('refuses before the proxy has a port: nothing can be on it yet', async () => {
		vi.mocked(window.maestro.localModels.proxy.report).mockResolvedValue(
			proxyReport(null) as never
		);
		onProxy();

		const result = await setAgentBackgroundRequests('agent-1', { target: QWEN });

		expect(result).toEqual({ ok: false, error: BACKGROUND_REQUESTS_NEEDS_PROXY });
	});

	it('refuses a provider the proxy cannot route for', async () => {
		onProxy({ toolType: 'codex' } as Partial<Session>);

		const result = await setAgentBackgroundRequests('agent-1', { target: QWEN });

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('Claude Code agents only');
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('refuses a source that names nothing, and one not known to serve the route', async () => {
		onProxy();

		const gone = await setAgentBackgroundRequests('agent-1', {
			target: { type: 'source', endpointId: 'ep-gone', model: 'm' },
		});
		const cloud = await setAgentBackgroundRequests('agent-1', {
			target: { type: 'source', endpointId: CLOUD.id, model: 'm' },
		});

		expect(gone).toEqual({ ok: false, error: expect.stringContaining('ep-gone') });
		expect(cloud).toEqual({ ok: false, error: expect.stringContaining('/v1/messages') });
		expect(stored().backgroundRequests).toBeUndefined();
	});

	it.each([undefined, null])('turns it off for %j, without asking the proxy', async (value) => {
		// Off is always allowed, on the proxy or not.
		seed({ backgroundRequests: { target: QWEN } });

		const result = await setAgentBackgroundRequests('agent-1', value);

		expect(result).toEqual({ ok: true, backgroundRequests: undefined });
		expect(stored().backgroundRequests).toBeUndefined();
		expect(window.maestro.localModels.proxy.report).not.toHaveBeenCalled();
		expect(window.maestro.sessions.setMany).toHaveBeenCalledTimes(1);
	});

	it('writes nothing when the value did not change', async () => {
		onProxy({ backgroundRequests: { target: QWEN } });

		const result = await setAgentBackgroundRequests('agent-1', { target: QWEN });

		expect(result.ok).toBe(true);
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('reports an agent that does not exist', async () => {
		seed();
		expect(await setAgentBackgroundRequests('missing', { target: QWEN })).toEqual({
			ok: false,
			error: 'Agent not found',
		});
	});
});

describe('background requests leave with the proxy', () => {
	it('is dropped when the proxy is turned off', async () => {
		seed({
			gatewayUrl: proxyUrl('/anthropic'),
			tokenProxyMode: 'passthrough',
			backgroundRequests: { target: QWEN },
		});

		await setAgentTokenProxyMode('agent-1', 'off');

		expect(stored().backgroundRequests).toBeUndefined();
		expect(stored().gatewayUrl).toBeUndefined();
	});

	it('is dropped by off even when only the target is left to clear', async () => {
		// A record with no gateway and no mode still holds a target nobody can see.
		seed({ backgroundRequests: { target: QWEN } });

		await setAgentTokenProxyMode('agent-1', 'off');

		expect(stored().backgroundRequests).toBeUndefined();
		expect(window.maestro.sessions.setMany).toHaveBeenCalledTimes(1);
	});

	it('is dropped when the gateway is set to another address', async () => {
		seed({ gatewayUrl: proxyUrl('/anthropic'), backgroundRequests: { target: QWEN } });

		await setAgentGatewayUrl('agent-1', 'http://127.0.0.1:8787');

		expect(stored().backgroundRequests).toBeUndefined();
	});

	it('is kept when the mode changes and the agent stays on the proxy', async () => {
		seed({
			gatewayUrl: proxyUrl('/anthropic'),
			tokenProxyMode: 'passthrough',
			backgroundRequests: { target: QWEN },
		});

		await setAgentTokenProxyMode('agent-1', 'compress');

		expect(stored().backgroundRequests).toEqual({ target: QWEN });
	});
});

describe('setAgentTokenProxyRetrieval', () => {
	it('turns it on for an agent the proxy compresses for, in a flushed write', async () => {
		seed({ gatewayUrl: proxyUrl('/anthropic'), tokenProxyMode: 'compress-early' });

		const result = await setAgentTokenProxyRetrieval('agent-1', true);

		expect(result).toEqual({ ok: true, retrieval: true });
		expect(stored().tokenProxyRetrieval).toBe(true);
		expect(window.maestro.sessions.setMany).toHaveBeenCalledWith(
			[expect.objectContaining({ id: 'agent-1', tokenProxyRetrieval: true })],
			[]
		);
	});

	it('turns it on in compress mode too', async () => {
		seed({ gatewayUrl: proxyUrl('/anthropic'), tokenProxyMode: 'compress' });

		expect(await setAgentTokenProxyRetrieval('agent-1', true)).toEqual({
			ok: true,
			retrieval: true,
		});
	});

	it.each([
		['passthrough', { gatewayUrl: proxyUrl('/anthropic'), tokenProxyMode: 'passthrough' }],
		['off the proxy', {}],
		['another gateway', { gatewayUrl: 'http://127.0.0.1:8787', tokenProxyMode: 'compress' }],
	] as const)('refuses on for an agent %s, and writes nothing', async (_label, record) => {
		seed(record as Partial<Session>);

		const result = await setAgentTokenProxyRetrieval('agent-1', true);

		expect(result).toEqual({ ok: false, error: TOKEN_PROXY_RETRIEVAL_NEEDS_COMPRESSION });
		expect(stored().tokenProxyRetrieval).toBeUndefined();
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it.each([false, null])('turns it off with %s, which removes the field', async (value) => {
		seed({
			gatewayUrl: proxyUrl('/anthropic'),
			tokenProxyMode: 'compress-early',
			tokenProxyRetrieval: true,
		});

		const result = await setAgentTokenProxyRetrieval('agent-1', value);

		expect(result).toEqual({ ok: true, retrieval: false });
		expect(stored().tokenProxyRetrieval).toBeUndefined();
		expect(window.maestro.sessions.setMany).toHaveBeenCalledTimes(1);
	});

	it('allows off for an agent that is not on the proxy, without reading the proxy', async () => {
		seed();

		expect(await setAgentTokenProxyRetrieval('agent-1', false)).toEqual({
			ok: true,
			retrieval: false,
		});
		expect(window.maestro.localModels.proxy.report).not.toHaveBeenCalled();
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('refuses a value that is not a boolean', async () => {
		seed({ gatewayUrl: proxyUrl('/anthropic'), tokenProxyMode: 'compress' });

		const result = await setAgentTokenProxyRetrieval('agent-1', 'on');

		expect(result.ok).toBe(false);
		expect(stored().tokenProxyRetrieval).toBeUndefined();
	});

	it('reports an agent that does not exist', async () => {
		seed();

		expect(await setAgentTokenProxyRetrieval('missing', true)).toEqual({
			ok: false,
			error: 'Agent not found',
		});
	});

	it('is cleared by mode off, even when it is the only proxy field left', async () => {
		seed({ tokenProxyRetrieval: true });

		await setAgentTokenProxyMode('agent-1', 'off');

		expect(stored().tokenProxyRetrieval).toBeUndefined();
		expect(window.maestro.sessions.setMany).toHaveBeenCalledTimes(1);
	});

	it('is cleared when the gateway is set to another address', async () => {
		seed({
			gatewayUrl: proxyUrl('/anthropic'),
			tokenProxyMode: 'compress-early',
			tokenProxyRetrieval: true,
		});

		await setAgentGatewayUrl('agent-1', 'http://127.0.0.1:8787');

		expect(stored().tokenProxyRetrieval).toBeUndefined();
	});

	it('is kept when the mode changes and the agent stays on the proxy', async () => {
		seed({
			gatewayUrl: proxyUrl('/anthropic'),
			tokenProxyMode: 'compress-early',
			tokenProxyRetrieval: true,
		});

		await setAgentTokenProxyMode('agent-1', 'compress');

		expect(stored().tokenProxyRetrieval).toBe(true);
	});
});
