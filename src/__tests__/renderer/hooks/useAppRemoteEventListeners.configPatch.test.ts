/**
 * @file useAppRemoteEventListeners.configPatch.test.ts
 * @description Covers the `maestro:remoteUpdateSessionConfig` branch, which
 * applies `maestro-cli update-agent` patches to a session. Scoped to the
 * context-window provenance rules from finding AD1: the allowlist has to carry
 * `contextWindowSource`, and clearing the window has to clear its provenance.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import { useAppRemoteEventListeners } from '../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { RUN_ON_GATEWAY_SKIPPED_REASON } from '../../../shared/local-models/run-on';
import type { Session } from '../../../renderer/types';

// The mode switch is its own suite (agentGateway.test.ts). Here it is the one
// call a `tokenProxyMode` patch must make, and whose answer it must carry.
// The background requests target is the same kind of call. What the record
// holds once it is off the proxy is the service's own constant, restated here
// because the module is mocked whole.
const gatewayService = vi.hoisted(() => ({
	setAgentTokenProxyMode: vi.fn(),
	setAgentBackgroundRequests: vi.fn(),
	flushAgentToStore: vi.fn(async () => {}),
	setAgentGatewayUrl: vi.fn(),
	OFF_TOKEN_PROXY_FIELDS: { tokenProxyMode: undefined, backgroundRequests: undefined },
}));
vi.mock('../../../renderer/services/agentGateway', () => gatewayService);

const RESPONSE_CHANNEL = 'remote:updateSessionConfig:response:test';

function makeSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Agent',
		toolType: 'claude-code',
		projectRoot: '/project',
		cwd: '/project',
		aiTabs: [],
		activeTabId: null,
		...overrides,
	} as unknown as Session;
}

/** Only the deps this branch actually touches; the rest are inert spies. */
function makeDeps(session: Session) {
	return {
		sessionsRef: { current: [session] },
		setActiveSessionId: vi.fn(),
		setSessions: vi.fn(),
		setGroups: vi.fn(),
		handleOpenFileTab: vi.fn(),
		refreshFileTree: vi.fn(),
		handleAutoRunRefresh: vi.fn(),
		startBatchRun: vi.fn().mockResolvedValue(undefined),
		stopBatchRun: vi.fn(),
		resumeAfterError: vi.fn(),
		skipCurrentDocument: vi.fn(),
		abortBatchOnError: vi.fn(),
	} as unknown as Parameters<typeof useAppRemoteEventListeners>[0];
}

/** Dispatch a config patch and return what was written onto the session. */
async function applyPatch(
	session: Session,
	configPatch: Record<string, unknown>
): Promise<Partial<Session>> {
	const deps = makeDeps(session);
	renderHook(() => useAppRemoteEventListeners(deps));

	await act(async () => {
		window.dispatchEvent(
			new CustomEvent('maestro:remoteUpdateSessionConfig', {
				detail: { sessionId: session.id, configPatch, responseChannel: RESPONSE_CHANNEL },
			})
		);
		// Let the handler's awaited persist call settle.
		await Promise.resolve();
	});

	const setSessions = (deps as unknown as { setSessions: ReturnType<typeof vi.fn> }).setSessions;
	expect(setSessions).toHaveBeenCalled();
	const updater = setSessions.mock.calls[0][0] as (prev: Session[]) => Session[];
	return updater([session])[0];
}

beforeEach(() => {
	gatewayService.setAgentTokenProxyMode.mockReset();
	gatewayService.setAgentBackgroundRequests.mockReset();
	vi.mocked(window.maestro.sessions.setMany).mockResolvedValue(undefined as never);
	// Not part of the shared preload mock in setup.ts, so stub it here rather
	// than widening the global surface for one branch.
	(
		window.maestro.process as unknown as Record<string, unknown>
	).sendRemoteUpdateSessionConfigResponse = vi.fn();
});

afterEach(() => cleanup());

/** Dispatch a patch the handler is expected to refuse; returns its reply. */
async function refusePatch(session: Session, configPatch: Record<string, unknown>) {
	const deps = makeDeps(session);
	renderHook(() => useAppRemoteEventListeners(deps));

	await act(async () => {
		window.dispatchEvent(
			new CustomEvent('maestro:remoteUpdateSessionConfig', {
				detail: { sessionId: session.id, configPatch, responseChannel: RESPONSE_CHANNEL },
			})
		);
		await Promise.resolve();
	});

	expect(
		(deps as unknown as { setSessions: ReturnType<typeof vi.fn> }).setSessions
	).not.toHaveBeenCalled();
	const respond = (window.maestro.process as unknown as Record<string, ReturnType<typeof vi.fn>>)
		.sendRemoteUpdateSessionConfigResponse;
	return respond.mock.calls[0][1] as { success: boolean; error?: string };
}

describe('remoteUpdateSessionConfig - Local Models gateway', () => {
	it('stores a gateway URL in its normalized form and flushes it to main', async () => {
		const session = makeSession();
		const updated = await applyPatch(session, { gatewayUrl: 'http://127.0.0.1:8787/anthropic/' });

		expect(updated.gatewayUrl).toBe('http://127.0.0.1:8787/anthropic');
		// The desktop spawn reads the gateway from main's store, so the write
		// must not wait on the debounced persistence.
		expect(window.maestro.sessions.setMany).toHaveBeenCalledWith(
			[expect.objectContaining({ id: session.id, gatewayUrl: 'http://127.0.0.1:8787/anthropic' })],
			[]
		);
	});

	it('clears the gateway on null', async () => {
		const updated = await applyPatch(makeSession({ gatewayUrl: 'http://127.0.0.1:8787' }), {
			gatewayUrl: null,
		});

		expect(updated.gatewayUrl).toBeUndefined();
	});

	it('refuses a gateway for a provider that cannot use one, and writes nothing', async () => {
		const reply = await refusePatch(makeSession({ toolType: 'copilot-cli' }), {
			gatewayUrl: 'http://127.0.0.1:8787',
		});

		expect(reply.success).toBe(false);
		expect(reply.error).toContain('ignores base-URL variables');
	});

	it('refuses a value that is not a URL, even beside a valid field', async () => {
		const reply = await refusePatch(makeSession(), { gatewayUrl: 'nope', customModel: 'opus' });

		expect(reply.success).toBe(false);
		expect(reply.error).toContain('not a URL');
	});
});

describe('remoteUpdateSessionConfig - token proxy mode', () => {
	const onProxy = 'http://127.0.0.1:48123/anthropic';

	it('applies the mode through the gateway service and carries the gateway it chose', async () => {
		gatewayService.setAgentTokenProxyMode.mockResolvedValue({
			ok: true,
			mode: 'compress',
			gatewayUrl: onProxy,
		});
		const session = makeSession();

		const updated = await applyPatch(session, { tokenProxyMode: 'compress' });

		expect(gatewayService.setAgentTokenProxyMode).toHaveBeenCalledWith(session.id, 'compress');
		expect(updated).toMatchObject({ gatewayUrl: onProxy, tokenProxyMode: 'compress' });
		// The final write is built from the session as it was before the
		// service ran. It must restate both fields, or it would undo them.
		expect(window.maestro.sessions.setMany).toHaveBeenCalledWith(
			[expect.objectContaining({ gatewayUrl: onProxy, tokenProxyMode: 'compress' })],
			[]
		);
	});

	it('off clears the gateway and the stored mode', async () => {
		gatewayService.setAgentTokenProxyMode.mockResolvedValue({
			ok: true,
			mode: 'off',
			gatewayUrl: undefined,
		});

		const updated = await applyPatch(
			makeSession({ gatewayUrl: onProxy, tokenProxyMode: 'compress' }),
			{ tokenProxyMode: 'off' }
		);

		expect(updated.gatewayUrl).toBeUndefined();
		expect(updated.tokenProxyMode).toBeUndefined();
	});

	it('reports the reason the service refused, and writes nothing', async () => {
		gatewayService.setAgentTokenProxyMode.mockResolvedValue({
			ok: false,
			error: 'Copilot CLI ignores base-URL variables',
		});

		const reply = await refusePatch(makeSession({ toolType: 'copilot-cli' } as Partial<Session>), {
			tokenProxyMode: 'compress',
		});

		expect(reply.success).toBe(false);
		expect(reply.error).toContain('Copilot CLI ignores base-URL variables');
	});

	it('refuses a value that is not a mode, without asking the service', async () => {
		const reply = await refusePatch(makeSession(), { tokenProxyMode: 'on' });

		expect(reply).toEqual({
			success: false,
			error: 'tokenProxyMode must be one of: off, passthrough, compress, compress-early.',
		});
		expect(gatewayService.setAgentTokenProxyMode).not.toHaveBeenCalled();
	});

	it('refuses a mode beside a gateway URL: the mode chooses the URL', async () => {
		const reply = await refusePatch(makeSession(), {
			tokenProxyMode: 'compress',
			gatewayUrl: 'http://127.0.0.1:8787',
		});

		expect(reply.success).toBe(false);
		expect(reply.error).toContain('not both');
		expect(gatewayService.setAgentTokenProxyMode).not.toHaveBeenCalled();
	});

	it('drops the stored mode when a patch changes the gateway', async () => {
		const updated = await applyPatch(
			makeSession({ gatewayUrl: onProxy, tokenProxyMode: 'compress' }),
			{ gatewayUrl: 'http://127.0.0.1:8787' }
		);

		expect(updated.gatewayUrl).toBe('http://127.0.0.1:8787');
		expect(updated.tokenProxyMode).toBeUndefined();
	});

	it('keeps the stored mode when a patch restates the same gateway', async () => {
		const updated = await applyPatch(
			makeSession({ gatewayUrl: onProxy, tokenProxyMode: 'compress' }),
			{ gatewayUrl: `${onProxy}/` }
		);

		expect(updated.tokenProxyMode).toBe('compress');
	});
});

describe('remoteUpdateSessionConfig - Run on target', () => {
	const OLLAMA = {
		id: 'ep-ollama',
		name: 'Ollama',
		kind: 'ollama' as const,
		baseUrl: 'http://127.0.0.1:11434',
		enabled: true,
	};
	const QWEN = {
		type: 'source' as const,
		endpointId: OLLAMA.id,
		model: 'qwen3:latest',
		contextTokens: 65_536,
	};

	beforeEach(() => {
		useSettingsStore.setState({ localModelEndpoints: [OLLAMA] });
		// The shared preload mock keeps its calls across tests in this file.
		vi.mocked(window.maestro.sessions.setMany).mockClear();
	});
	afterEach(() => {
		useSettingsStore.setState({ localModelEndpoints: [] });
	});

	it('stores a target in its stored form and flushes it to main', async () => {
		const session = makeSession();
		const updated = await applyPatch(session, {
			runOn: { ...QWEN, model: ' qwen3:latest ', unknown: true },
		});

		expect(updated.runOn).toEqual(QWEN);
		// The launch reads the target from main's store; a miss there sends a turn
		// to the provider's cloud model the caller just turned away from.
		expect(window.maestro.sessions.setMany).toHaveBeenCalledWith(
			[expect.objectContaining({ id: session.id, runOn: QWEN })],
			[]
		);
	});

	it.each([[null], [{ type: 'provider' }]])('clears the target on %j', async (runOn) => {
		const updated = await applyPatch(makeSession({ runOn: QWEN }), { runOn });

		expect(updated.runOn).toBeUndefined();
		expect(
			vi.mocked(window.maestro.sessions.setMany).mock.calls[0][0][0] as Partial<Session>
		).toMatchObject({ runOn: undefined });
	});

	it('still clears a target left on a provider with no recipe', async () => {
		const updated = await applyPatch(makeSession({ toolType: 'gemini-cli', runOn: QWEN }), {
			runOn: null,
		});

		expect(updated.runOn).toBeUndefined();
	});

	it.each([
		['a provider with no recipe', { toolType: 'gemini-cli' }, QWEN, 'speaks only the Gemini API'],
		[
			'a source id that names nothing',
			{},
			{ ...QWEN, endpointId: 'ep-typo' },
			'No source has the id "ep-typo"',
		],
		['a target with no model', {}, { type: 'source', endpointId: OLLAMA.id }, 'names a model'],
		['a context under the agent minimum', {}, { ...QWEN, contextTokens: 8192 }, 'at least 40960'],
		['a value that is not a target', {}, 'ep-ollama:qwen3', 'object with a type'],
	])('refuses %s, and writes nothing', async (_name, agent, runOn, expected) => {
		const reply = await refusePatch(makeSession(agent as Partial<Session>), {
			runOn,
			customModel: 'opus',
		});

		expect(reply.success).toBe(false);
		expect(reply.error).toContain(expected);
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	describe('and the gateway', () => {
		it('refuses a gateway URL for an agent on a source, with the reason the dialog shows', async () => {
			const reply = await refusePatch(makeSession({ runOn: QWEN }), {
				gatewayUrl: 'http://127.0.0.1:8787',
			});

			expect(reply).toEqual({ success: false, error: RUN_ON_GATEWAY_SKIPPED_REASON });
		});

		it('refuses a proxy mode for an agent on a source, and never starts the proxy', async () => {
			const reply = await refusePatch(makeSession({ runOn: QWEN }), { tokenProxyMode: 'compress' });

			expect(reply).toEqual({ success: false, error: RUN_ON_GATEWAY_SKIPPED_REASON });
			expect(gatewayService.setAgentTokenProxyMode).not.toHaveBeenCalled();
		});

		it('refuses a gateway set in the same patch as a source target', async () => {
			const reply = await refusePatch(makeSession(), {
				runOn: QWEN,
				gatewayUrl: 'http://127.0.0.1:8787',
			});

			expect(reply).toEqual({ success: false, error: RUN_ON_GATEWAY_SKIPPED_REASON });
		});

		it('allows clearing the gateway of an agent on a source', async () => {
			const updated = await applyPatch(
				makeSession({ runOn: QWEN, gatewayUrl: 'http://127.0.0.1:8787' }),
				{ gatewayUrl: null }
			);

			expect(updated.gatewayUrl).toBeUndefined();
			expect(updated.runOn).toEqual(QWEN);
		});

		it('allows switching the proxy off for an agent on a source', async () => {
			gatewayService.setAgentTokenProxyMode.mockResolvedValue({
				ok: true,
				mode: 'off',
				gatewayUrl: undefined,
			});

			const updated = await applyPatch(makeSession({ runOn: QWEN }), { tokenProxyMode: 'off' });

			expect(gatewayService.setAgentTokenProxyMode).toHaveBeenCalledWith('session-1', 'off');
			expect(updated.tokenProxyMode).toBeUndefined();
		});

		it('allows a gateway in the patch that moves the agent back to its provider', async () => {
			const updated = await applyPatch(makeSession({ runOn: QWEN }), {
				runOn: null,
				gatewayUrl: 'http://127.0.0.1:8787',
			});

			expect(updated.runOn).toBeUndefined();
			expect(updated.gatewayUrl).toBe('http://127.0.0.1:8787');
		});

		it('leaves a gateway stored before the target alone: the launch skips it', async () => {
			const updated = await applyPatch(makeSession({ gatewayUrl: 'http://127.0.0.1:8787' }), {
				runOn: QWEN,
			});

			expect(updated.runOn).toEqual(QWEN);
			expect(updated.gatewayUrl).toBe('http://127.0.0.1:8787');
		});
	});
});

describe('remoteUpdateSessionConfig - tier targets', () => {
	const OLLAMA = {
		id: 'ep-ollama',
		name: 'Ollama',
		kind: 'ollama' as const,
		baseUrl: 'http://127.0.0.1:11434',
		enabled: true,
	};
	const LOCAL = { type: 'source' as const, endpointId: OLLAMA.id, model: 'qwen3:latest' };
	const OPUS = { type: 'provider-model' as const, model: 'opus' };

	beforeEach(() => {
		useSettingsStore.setState({ localModelEndpoints: [OLLAMA] });
		vi.mocked(window.maestro.sessions.setMany).mockClear();
	});
	afterEach(() => {
		useSettingsStore.setState({ localModelEndpoints: [] });
	});

	it('stores each tier named in its stored form and flushes it to main', async () => {
		const session = makeSession();
		const updated = await applyPatch(session, {
			tierTargets: { low: { ...LOCAL, stray: true }, high: { type: 'provider' } },
		});

		const tierTargets = { low: LOCAL, high: { type: 'provider-model' } };
		expect(updated.tierTargets).toEqual(tierTargets);
		// The CLI's Auto Run reads the tiers from main's store.
		expect(window.maestro.sessions.setMany).toHaveBeenCalledWith(
			[expect.objectContaining({ id: session.id, tierTargets })],
			[]
		);
	});

	it('is a patch: a tier it does not name keeps what the agent holds', async () => {
		const updated = await applyPatch(makeSession({ tierTargets: { low: LOCAL, medium: OPUS } }), {
			tierTargets: { high: OPUS, medium: null },
		});

		expect(updated.tierTargets).toEqual({ low: LOCAL, high: OPUS });
	});

	it('stores the absence of the field when the last tier is cleared', async () => {
		const updated = await applyPatch(makeSession({ tierTargets: { low: LOCAL } }), {
			tierTargets: { low: null },
		});

		expect('tierTargets' in updated).toBe(true);
		expect(updated.tierTargets).toBeUndefined();
	});

	it('clears every tier on null', async () => {
		const updated = await applyPatch(makeSession({ tierTargets: { low: LOCAL, high: OPUS } }), {
			tierTargets: null,
		});

		expect(updated.tierTargets).toBeUndefined();
	});

	it('refuses a source that does not exist, naming the tier, and writes nothing', async () => {
		const reply = await refusePatch(makeSession(), {
			tierTargets: { low: { type: 'source', endpointId: 'ep-gone', model: 'm' } },
			customModel: 'opus',
		});

		expect(reply.success).toBe(false);
		expect(reply.error).toMatch(/^low: No source has the id "ep-gone"/);
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('refuses a source on a harness with no Run on recipe', async () => {
		const reply = await refusePatch(makeSession({ toolType: 'factory-droid' }), {
			tierTargets: { high: LOCAL },
		});

		expect(reply.success).toBe(false);
		expect(reply.error).toMatch(/^high: /);
	});

	it('refuses a key that is not a tier', async () => {
		const reply = await refusePatch(makeSession(), { tierTargets: { turbo: OPUS } });

		expect(reply).toEqual({ success: false, error: expect.stringContaining('"turbo"') });
	});
});

describe('remoteUpdateSessionConfig - background requests', () => {
	const onProxy = 'http://127.0.0.1:48123/anthropic';
	const QWEN = { type: 'source' as const, endpointId: 'ep-ollama', model: 'qwen3:4b' };

	beforeEach(() => {
		vi.mocked(window.maestro.sessions.setMany).mockClear();
	});

	it('sets the target through the service and carries what it stored', async () => {
		gatewayService.setAgentBackgroundRequests.mockResolvedValue({
			ok: true,
			backgroundRequests: { target: QWEN },
		});
		const session = makeSession({ gatewayUrl: onProxy, tokenProxyMode: 'passthrough' });

		const updated = await applyPatch(session, {
			backgroundRequests: { target: { ...QWEN, contextTokens: 65_536 } },
		});

		expect(gatewayService.setAgentBackgroundRequests).toHaveBeenCalledWith(session.id, {
			target: { ...QWEN, contextTokens: 65_536 },
		});
		// The service's form is what the write below carries, not the caller's.
		expect(updated.backgroundRequests).toEqual({ target: QWEN });
	});

	it('turns it off on null', async () => {
		gatewayService.setAgentBackgroundRequests.mockResolvedValue({
			ok: true,
			backgroundRequests: undefined,
		});

		const updated = await applyPatch(
			makeSession({ gatewayUrl: onProxy, backgroundRequests: { target: QWEN } }),
			{ backgroundRequests: null }
		);

		expect(gatewayService.setAgentBackgroundRequests).toHaveBeenCalledWith('session-1', null);
		expect('backgroundRequests' in updated).toBe(true);
		expect(updated.backgroundRequests).toBeUndefined();
	});

	it('reports the reason the service refused, and writes nothing', async () => {
		gatewayService.setAgentBackgroundRequests.mockResolvedValue({
			ok: false,
			error: 'this agent does not use the proxy',
		});

		const reply = await refusePatch(makeSession(), { backgroundRequests: { target: QWEN } });

		expect(reply).toEqual({ success: false, error: 'this agent does not use the proxy' });
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('turns the proxy on and names the target in one patch, mode first', async () => {
		const order: string[] = [];
		gatewayService.setAgentTokenProxyMode.mockImplementation(async () => {
			order.push('mode');
			return { ok: true, mode: 'passthrough', gatewayUrl: onProxy };
		});
		gatewayService.setAgentBackgroundRequests.mockImplementation(async () => {
			order.push('background');
			return { ok: true, backgroundRequests: { target: QWEN } };
		});

		const updated = await applyPatch(makeSession(), {
			backgroundRequests: { target: QWEN },
			tokenProxyMode: 'passthrough',
		});

		expect(order).toEqual(['mode', 'background']);
		expect(updated).toMatchObject({
			gatewayUrl: onProxy,
			tokenProxyMode: 'passthrough',
			backgroundRequests: { target: QWEN },
		});
	});

	it.each([
		['the proxy mode off', { tokenProxyMode: 'off' }],
		['a gateway of its own', { gatewayUrl: 'http://127.0.0.1:8787' }],
	])('refuses a target beside %s, before either is acted on', async (_what, rest) => {
		const reply = await refusePatch(makeSession({ gatewayUrl: onProxy }), {
			backgroundRequests: { target: QWEN },
			...rest,
		});

		expect(reply.success).toBe(false);
		expect(reply.error).toContain('routed by the token proxy');
		expect(gatewayService.setAgentTokenProxyMode).not.toHaveBeenCalled();
		expect(gatewayService.setAgentBackgroundRequests).not.toHaveBeenCalled();
	});

	it('drops the target when the mode goes off: the write starts from the record before it', async () => {
		gatewayService.setAgentTokenProxyMode.mockResolvedValue({
			ok: true,
			mode: 'off',
			gatewayUrl: undefined,
		});

		const updated = await applyPatch(
			makeSession({
				gatewayUrl: onProxy,
				tokenProxyMode: 'passthrough',
				backgroundRequests: { target: QWEN },
			}),
			{ tokenProxyMode: 'off' }
		);

		expect('backgroundRequests' in updated).toBe(true);
		expect(updated.backgroundRequests).toBeUndefined();
	});

	it('drops the target when a patch changes the gateway, and keeps it when it does not', async () => {
		const session = () =>
			makeSession({ gatewayUrl: onProxy, backgroundRequests: { target: QWEN } });

		const moved = await applyPatch(session(), { gatewayUrl: 'http://127.0.0.1:8787' });
		expect(moved.backgroundRequests).toBeUndefined();
		cleanup();

		const same = await applyPatch(session(), { gatewayUrl: `${onProxy}/` });
		expect(same.backgroundRequests).toEqual({ target: QWEN });
	});
});

describe('remoteUpdateSessionConfig - context window provenance (finding AD1)', () => {
	it('writes contextWindowSource through the editable-key allowlist', async () => {
		// Without the allowlist entry the CLI writes the number but not its
		// provenance, so the deliberate edit stays outranked by the provider's
		// report and silently does not apply.
		const updated = await applyPatch(makeSession(), {
			customContextWindow: 120000,
			contextWindowSource: 'user-edited',
		});

		expect(updated.customContextWindow).toBe(120000);
		expect(updated.contextWindowSource).toBe('user-edited');
	});

	it('clears provenance when a patch clears the window, even alone', async () => {
		// Review of PR #1362. A patch carrying only `customContextWindow: null`
		// left a stale 'user-edited' behind, so the next window set without
		// provenance inherited precedence nobody asked for.
		const updated = await applyPatch(
			makeSession({ customContextWindow: 120000, contextWindowSource: 'user-edited' }),
			{ customContextWindow: null }
		);

		expect(updated.customContextWindow).toBeUndefined();
		expect(updated.contextWindowSource).toBeUndefined();
	});

	it('leaves provenance alone when the patch does not touch the window', async () => {
		const updated = await applyPatch(
			makeSession({ customContextWindow: 120000, contextWindowSource: 'user-edited' }),
			{ customModel: 'opus' }
		);

		expect(updated.customModel).toBe('opus');
		expect(updated.contextWindowSource).toBe('user-edited');
	});
});

describe('remoteUpdateSessionConfig - System One switch', () => {
	beforeEach(() => {
		vi.mocked(window.maestro.sessions.setMany).mockClear();
	});

	it('stores the opt-out and flushes it to main, where a request and the prompt read it', async () => {
		const session = makeSession();

		const updated = await applyPatch(session, { systemOneOptOut: true });

		expect(updated.systemOneOptOut).toBe(true);
		expect(window.maestro.sessions.setMany).toHaveBeenCalledWith(
			[expect.objectContaining({ id: session.id, systemOneOptOut: true })],
			[]
		);
	});

	it.each([null, false])('clears it on %j: on is the absence of the field', async (value) => {
		const updated = await applyPatch(makeSession({ systemOneOptOut: true }), {
			systemOneOptOut: value,
		});

		expect('systemOneOptOut' in updated).toBe(true);
		expect(updated.systemOneOptOut).toBeUndefined();
	});

	it.each(['off', 1, {}])('refuses %j, and writes nothing', async (value) => {
		const reply = await refusePatch(makeSession(), { systemOneOptOut: value });

		expect(reply.success).toBe(false);
		expect(reply.error).toContain('systemOneOptOut');
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});
});
