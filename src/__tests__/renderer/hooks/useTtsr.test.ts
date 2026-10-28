import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockAITab, createMockSession } from '../../helpers';
import type { Session } from '../../../renderer/types';
import type { TtsrMatchedPayload, TtsrTriggeredPayload } from '../../../shared/ttsr-types';

const { context, notify } = vi.hoisted(() => ({
	context: { web: false, owns: true },
	notify: vi.fn(),
}));
vi.mock('../../../renderer/contexts/WindowContext', () => ({
	useWindowContextOptional: () => ({ ownsSession: () => context.owns }),
}));
vi.mock('../../../renderer/utils/runtimeContext', async (original) => ({
	...(await original<typeof import('../../../renderer/utils/runtimeContext')>()),
	isWebDesktop: () => context.web,
}));
vi.mock('../../../renderer/stores/notificationStore', async (original) => ({
	...(await original<typeof import('../../../renderer/stores/notificationStore')>()),
	notifyToast: notify,
}));
import { runTtsrSteering, useTtsr } from '../../../renderer/hooks/useTtsr';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import { matchKey, useTtsrStore } from '../../../renderer/stores/ttsrStore';
import { registerSessionPersistenceFlush } from '../../../renderer/services/sessionPersistenceFlush';
import { mergeSessionPersistenceChanges } from '../../../shared/sessionPersistenceMerge';
import {
	applySteeringVerdict,
	resetPendingSteersForTests,
	settlePendingSteersOnExit,
} from '../../../renderer/services/chatSteering';

const payload: TtsrTriggeredPayload = {
	sessionId: 'sess-1-ai-tab-1',
	tabId: 'tab-1',
	agentId: 'claude-code',
	requestId: 'ttsr-request-1',
	rules: [{ name: 'logger', path: '.maestro/rules/logger.md' }],
	injectionPrompt: '<system-interrupt rule="logger">Use the logger.</system-interrupt>',
};
const claim = vi.fn();
const steer = vi.fn();
const interrupt = vi.fn();
const kill = vi.fn();
const flush = vi.fn();
let stored: Session[];
let onTriggered: (request: TtsrTriggeredPayload) => void;
let onMatched: (request: TtsrMatchedPayload) => void;
const offTriggered = vi.fn();
const offMatched = vi.fn();
const bridge = window.maestro as unknown as {
	process: Record<string, unknown>;
	ttsr: Record<string, unknown>;
	sessions: Record<string, unknown>;
};
const originalBridge = {
	steer: bridge.process.steer,
	interrupt: bridge.process.interrupt,
	kill: bridge.process.kill,
	ttsr: bridge.ttsr,
	getBootstrap: bridge.sessions.getBootstrap,
};
function seed(overrides: Partial<Session> = {}) {
	const session = createMockSession({
		id: 'sess-1',
		toolType: 'claude-code',
		aiTabs: [createMockAITab({ id: 'tab-1', state: 'busy' })],
		activeTabId: 'tab-1',
		claudeInteractive: { mode: 'interactive', modeReason: 'auto' },
		executionQueue: [],
		...overrides,
	});
	useSessionStore.setState({ sessions: [session] });
	return session;
}
function current() {
	return useSessionStore.getState().sessions[0];
}
beforeEach(() => {
	vi.clearAllMocks();
	resetPendingSteersForTests();
	stored = [];
	context.web = false;
	context.owns = true;
	seed();
	useTtsrStore.setState({ matches: {} });
	bridge.process.steer = steer;
	bridge.process.interrupt = interrupt;
	bridge.process.kill = kill;
	steer.mockResolvedValue({ type: 'steering', id: 'native-steer-1', verdict: 'delivered' });
	claim.mockResolvedValue(true);
	flush.mockImplementation(async (sessions: Session[]) => {
		stored = structuredClone(sessions);
	});
	registerSessionPersistenceFlush(flush);
	bridge.sessions.getBootstrap = vi.fn(async () => stored);
	bridge.ttsr = {
		claimSteeringRequest: claim,
		onTriggered: vi.fn((callback) => {
			onTriggered = callback;
			return offTriggered;
		}),
		onMatched: vi.fn((callback) => {
			onMatched = callback;
			return offMatched;
		}),
	};
});
afterEach(() => {
	registerSessionPersistenceFlush(null);
	bridge.process.steer = originalBridge.steer;
	bridge.process.interrupt = originalBridge.interrupt;
	bridge.process.kill = originalBridge.kill;
	bridge.ttsr = originalBridge.ttsr;
	bridge.sessions.getBootstrap = originalBridge.getBootstrap;
});

describe('TTSR through the native Steer lifecycle', () => {
	it('persists held guidance before claiming and parks it in native pendingSteers', async () => {
		claim.mockImplementation(async () => {
			expect(stored[0].executionQueue).toEqual([
				expect.objectContaining({
					id: expect.stringMatching(new RegExp(`^${payload.requestId}:`)),
					paused: true,
				}),
			]);
			expect(steer).not.toHaveBeenCalled();
			return true;
		});
		expect(await runTtsrSteering(payload)).toEqual({ outcome: 'delivered', verdict: 'delivered' });
		expect(steer).toHaveBeenCalledWith(payload.sessionId, payload.injectionPrompt);
		expect(current().executionQueue).toEqual([]);
		expect(current().pendingSteers).toEqual([
			expect.objectContaining({
				steerId: 'native-steer-1',
				item: expect.objectContaining({
					id: expect.stringMatching(new RegExp(`^${payload.requestId}:`)),
				}),
			}),
		]);
		expect(current().aiTabs[0].logs[0]).toMatchObject({ steered: true, steerState: 'pending' });
		expect(window.maestro.process.spawn).not.toHaveBeenCalled();
		expect(interrupt).not.toHaveBeenCalled();
		expect(kill).not.toHaveBeenCalled();
	});
	it.each(['absorbed', 'queued'] as const)(
		'settles %s through the same native verdict owner',
		async (verdict) => {
			await runTtsrSteering(payload);
			applySteeringVerdict(payload.sessionId, { type: 'steering', id: 'native-steer-1', verdict });
			expect(current().pendingSteers).toEqual([]);
			expect(current().executionQueue).toEqual([]);
			expect(current().aiTabs[0].logs[0]).toMatchObject({ steerState: verdict });
		}
	);
	it('returns an explicitly refused steer through the native queue', async () => {
		steer.mockResolvedValue({
			type: 'steering',
			id: 'native-steer-1',
			verdict: 'refused',
			refusal: 'blocking-dialog',
		});
		expect(await runTtsrSteering(payload)).toMatchObject({ outcome: 'refused' });
		expect(current().executionQueue).toEqual([
			expect.objectContaining({
				id: expect.stringMatching(new RegExp(`^${payload.requestId}:`)),
				paused: undefined,
			}),
		]);
		expect(current().aiTabs[0].logs).toEqual([]);
	});
	it('holds an unconfirmed native steer instead of sending it twice', async () => {
		steer.mockResolvedValue({ type: 'steering', id: 'native-steer-1', verdict: 'unknown' });
		expect(await runTtsrSteering(payload)).toMatchObject({ outcome: 'unconfirmed' });
		expect(current().executionQueue).toEqual([expect.objectContaining({ paused: true })]);
		expect(current().pendingSteers).toEqual([]);
	});
	it('uses native exit restoration when the turn ends without a verdict', async () => {
		await runTtsrSteering(payload);
		settlePendingSteersOnExit(payload.sessionId);
		expect(current().executionQueue).toEqual([
			expect.objectContaining({
				id: expect.stringMatching(new RegExp(`^${payload.requestId}:`)),
				paused: true,
			}),
		]);
		expect(current().pendingSteers).toEqual([]);
	});
	it('does not duplicate an offer already held or parked by native Steer', async () => {
		let release!: (value: boolean) => void;
		claim.mockReturnValue(
			new Promise<boolean>((resolve) => {
				release = resolve;
			})
		);
		const first = runTtsrSteering(payload);
		await waitFor(() => expect(claim).toHaveBeenCalledOnce());
		expect(await runTtsrSteering(payload)).toBeNull();
		release(true);
		await first;
		expect(await runTtsrSteering(payload)).toBeNull();
		expect(steer).toHaveBeenCalledOnce();
	});
	it('keeps rule mentions literal without dispatching cross-agent consults', async () => {
		await runTtsrSteering({
			...payload,
			injectionPrompt: '<system-interrupt>@Other use the logger</system-interrupt>',
		});
		expect(current().pendingSteers?.[0].item.crossAgentMention).toBeUndefined();
		expect(current().pendingSteers?.[0].item.crossAgentOnly).toBeUndefined();
	});
	it('supports Codex only on the existing app-server transport', async () => {
		seed({ toolType: 'codex', codexTransport: 'app-server' });
		await runTtsrSteering({ ...payload, agentId: 'codex' });
		expect(steer).toHaveBeenCalledOnce();
	});
	it.each([
		['Codex exec', { toolType: 'codex', codexTransport: 'exec' }],
		['Claude API', { claudeInteractive: { mode: 'api', modeReason: 'api' } }],
		['SSH Claude', { sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } }],
		['another provider', { toolType: 'opencode' }],
	] as Array<[string, Partial<Session>]>)(
		'leaves %s guidance with main deferred reminders',
		async (_name, overrides) => {
			seed(overrides);
			expect(await runTtsrSteering(payload)).toBeNull();
			expect(claim).not.toHaveBeenCalled();
			expect(steer).not.toHaveBeenCalled();
			expect(current().executionQueue).toEqual([]);
		}
	);
	it('never steers a sibling process for a forced-parallel offer', async () => {
		await runTtsrSteering({ ...payload, sessionId: `${payload.sessionId}-fp-1234` });
		expect(claim).not.toHaveBeenCalled();
		expect(steer).not.toHaveBeenCalled();
	});
});

describe('TTSR handoff races', () => {
	it('does not claim guidance when persistence failed or no flush owner is registered', async () => {
		registerSessionPersistenceFlush(null);
		expect(await runTtsrSteering(payload)).toBeNull();
		expect(claim).not.toHaveBeenCalled();
		expect(current().executionQueue).toEqual([]);
	});
	it('waits for the canonical persistence acknowledgement', async () => {
		let release!: () => void;
		flush.mockImplementation(async (sessions: Session[]) => {
			await new Promise<void>((resolve) => {
				release = resolve;
			});
			stored = structuredClone(sessions);
		});
		const pending = runTtsrSteering(payload);
		expect(claim).not.toHaveBeenCalled();
		expect(current().executionQueue[0].paused).toBe(true);
		release();
		await pending;
		expect(claim).toHaveBeenCalledOnce();
	});
	it('removes the held copy when main rejects a stale or revoked claim', async () => {
		claim.mockResolvedValue(false);
		expect(await runTtsrSteering(payload)).toBeNull();
		expect(current().executionQueue).toEqual([]);
		expect(steer).not.toHaveBeenCalled();
	});
	it('retains a durable held copy when claim outcome is uncertain', async () => {
		claim.mockRejectedValue(new Error('IPC disconnected'));
		expect(await runTtsrSteering(payload)).toBeNull();
		expect(current().executionQueue[0]).toMatchObject({
			id: expect.stringMatching(new RegExp(`^${payload.requestId}:`)),
			paused: true,
		});
		expect(stored[0].executionQueue[0].paused).toBe(true);
		expect(steer).not.toHaveBeenCalled();
	});
	it('retains claimed held guidance when the hook unmounts during the claim', async () => {
		let release!: (value: boolean) => void;
		claim.mockReturnValue(
			new Promise<boolean>((resolve) => {
				release = resolve;
			})
		);
		const hook = renderHook(() => useTtsr(true));
		act(() => onTriggered(payload));
		await waitFor(() => expect(claim).toHaveBeenCalledOnce());
		hook.unmount();
		release(true);
		await waitFor(() => expect(current().executionQueue[0]?.paused).toBe(true));
		expect(current().executionQueue[0].id).toMatch(new RegExp(`^${payload.requestId}:`));
		expect(steer).not.toHaveBeenCalled();
	});
	it('a losing window cannot erase the winning window durable held row', async () => {
		const initial = structuredClone(current());
		let host = structuredClone(initial) as unknown as Record<string, unknown>;
		let baseline = structuredClone(host);
		flush.mockImplementation(async (sessions: Session[]) => {
			const incoming = sessions[0] as unknown as Record<string, unknown>;
			host = mergeSessionPersistenceChanges(incoming, host, baseline);
			baseline = structuredClone(incoming);
			stored = [host as unknown as Session];
		});
		let firstActive = true;
		claim.mockImplementationOnce(async () => {
			firstActive = false;
			return true;
		});
		await runTtsrSteering(payload, () => firstActive);
		const winner = (host.executionQueue as Array<{ id: string }>)[0].id;
		expect(current().executionQueue[0].paused).toBe(true);
		// Independent renderer snapshot and persistence baseline, sharing only main's store.
		useSessionStore.setState({ sessions: [structuredClone(initial)] });
		baseline = structuredClone(initial) as unknown as Record<string, unknown>;
		claim.mockResolvedValueOnce(false);
		await runTtsrSteering(payload);
		const loserId = (baseline.executionQueue as Array<{ id: string }>)[0].id;
		expect(loserId).not.toBe(winner);
		expect(current().executionQueue).toEqual([]);
		await flush(useSessionStore.getState().sessions);
		expect(host.executionQueue).toEqual([expect.objectContaining({ id: winner, paused: true })]);
		expect(steer).not.toHaveBeenCalled();
	});
	it('uses native queue fallback if the transport changes after a successful claim', async () => {
		claim.mockImplementation(async () => {
			seed({ toolType: 'codex', codexTransport: 'exec', executionQueue: current().executionQueue });
			return true;
		});
		expect(await runTtsrSteering(payload)).toMatchObject({
			outcome: 'not-steerable',
			blockedReason: 'codex-exec',
		});
		expect(current().executionQueue[0]).toMatchObject({
			id: expect.stringMatching(new RegExp(`^${payload.requestId}:`)),
			paused: undefined,
		});
		expect(steer).not.toHaveBeenCalled();
	});
});

describe('useTtsr subscriptions', () => {
	it.each([
		[true, false],
		[false, true],
	])('keeps web=%s/nonowner=%s clients display-only', async (web, nonowner) => {
		context.web = web;
		context.owns = !nonowner;
		const hook = renderHook(() => useTtsr(true));
		act(() => onTriggered(payload));
		expect(claim).not.toHaveBeenCalled();
		expect(current().executionQueue).toEqual([]);
		hook.unmount();
	});
	it('records matches on every client and cleans up both subscriptions', () => {
		const hook = renderHook(() => useTtsr(true));
		act(() => onMatched({ ...payload, source: 'text', willInterrupt: true }));
		expect(
			useTtsrStore.getState().matches[matchKey(current().cwd, payload.rules[0].path)].count
		).toBe(1);
		hook.unmount();
		expect(offTriggered).toHaveBeenCalledOnce();
		expect(offMatched).toHaveBeenCalledOnce();
	});
	it('subscribes to nothing while disabled', () => {
		renderHook(() => useTtsr(false));
		expect(bridge.ttsr.onTriggered).not.toHaveBeenCalled();
	});
});
