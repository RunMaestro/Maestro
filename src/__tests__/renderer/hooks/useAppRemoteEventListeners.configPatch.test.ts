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
import type { Session } from '../../../renderer/types';

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
	vi.mocked(window.maestro.sessions.setMany).mockResolvedValue(undefined as never);
	// Not part of the shared preload mock in setup.ts, so stub it here rather
	// than widening the global surface for one branch.
	(
		window.maestro.process as unknown as Record<string, unknown>
	).sendRemoteUpdateSessionConfigResponse = vi.fn();
});

afterEach(() => cleanup());

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

describe('remoteUpdateSessionConfig - a Move Back restore (#2195)', () => {
	const moved = () =>
		makeSession({
			liftedTo: { peer: 'build-box', agentId: 'host-1', at: 1 },
		} as unknown as Partial<Session>);

	beforeEach(() => vi.mocked(window.maestro.sessions.setMany).mockClear());

	async function dispatchRestore(session: Session, configPatch: Record<string, unknown>) {
		const deps = makeDeps(session);
		renderHook(() => useAppRemoteEventListeners(deps));
		await act(async () => {
			window.dispatchEvent(
				new CustomEvent('maestro:remoteUpdateSessionConfig', {
					detail: { sessionId: session.id, configPatch, responseChannel: RESPONSE_CHANNEL },
				})
			);
			await Promise.resolve();
			await Promise.resolve();
		});
		const respond = (
			window.maestro.process as unknown as {
				sendRemoteUpdateSessionConfigResponse: ReturnType<typeof vi.fn>;
			}
		).sendRemoteUpdateSessionConfigResponse;
		return {
			setSessions: (deps as unknown as { setSessions: ReturnType<typeof vi.fn> }).setSessions,
			reply: respond.mock.calls.at(-1)?.[1] as { success: boolean; error?: string },
		};
	}

	it('refuses a restore that reaches the window after its deadline, and applies nothing', async () => {
		const { setSessions, reply } = await dispatchRestore(moved(), {
			returnedFromHost: { tabs: [] },
			restoreBy: Date.now() - 1,
		});
		expect(reply).toEqual({
			success: false,
			error: 'The move back reached this window after Maestro stopped waiting for it',
		});
		expect(setSessions).not.toHaveBeenCalled();
		expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
	});

	it('applies a restore in time, saved before it is shown', async () => {
		const { setSessions, reply } = await dispatchRestore(moved(), {
			returnedFromHost: { tabs: [] },
			restoreBy: Date.now() + 60_000,
		});
		expect(reply).toEqual({ success: true });
		expect(vi.mocked(window.maestro.sessions.setMany).mock.invocationCallOrder[0]).toBeLessThan(
			setSessions.mock.invocationCallOrder[0]
		);
		const updater = setSessions.mock.calls[0][0] as (prev: Session[]) => Session[];
		expect((updater([moved()])[0] as unknown as { liftedTo?: unknown }).liftedTo).toBeUndefined();
	});

	it('a save that fails applies nothing here, so the host may run what it held', async () => {
		vi.mocked(window.maestro.sessions.setMany).mockRejectedValueOnce(new Error('disk full'));
		const { setSessions, reply } = await dispatchRestore(moved(), {
			returnedFromHost: { tabs: [] },
		});
		expect(reply).toEqual({ success: false, error: 'Could not save the agent: disk full' });
		expect(setSessions).not.toHaveBeenCalled();
	});
});
