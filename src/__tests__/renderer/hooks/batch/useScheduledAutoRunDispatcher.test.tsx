/**
 * @file useScheduledAutoRunDispatcher.test.tsx
 * @description Tests the one-shot Auto Run scheduling flow (issue #716) end to
 * end across the two halves that own it:
 *
 *   1. handleStartBatchRun parks a run with a future `scheduledFor` instead of
 *      launching it, and launches normally otherwise.
 *   2. useScheduledAutoRunDispatcher fires parked runs once the wall clock
 *      passes them, defers while the agent is occupied, and drops runs missed
 *      by more than the grace window.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAutoRunHandlers } from '../../../../renderer/hooks';
import { useScheduledAutoRunDispatcher } from '../../../../renderer/hooks/batch/useScheduledAutoRunDispatcher';
import type { Session, BatchRunConfig } from '../../../../renderer/types';
import { createMockSession as baseCreateMockSession } from '../../../helpers/mockSession';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { useBatchStore } from '../../../../renderer/stores/batchStore';
import {
	useScheduledAutoRunStore,
	SCHEDULED_AUTO_RUN_GRACE_MS,
} from '../../../../renderer/stores/scheduledAutoRunStore';

vi.mock('../../../../renderer/stores/notificationStore', async () => {
	const actual = await vi.importActual('../../../../renderer/stores/notificationStore');
	return { ...actual, notifyToast: vi.fn() };
});

const createMockSession = (overrides: Partial<Session> = {}): Session =>
	baseCreateMockSession({
		id: 'session-1',
		name: 'Docs Agent',
		cwd: '/projects/my-repo',
		autoRunFolderPath: '/projects/autorun-docs',
		...overrides,
	});

function seedActiveSession(session: Session) {
	useSessionStore.setState({
		sessions: [session],
		activeSessionId: session.id,
	} as never);
}

const createMockDeps = () => ({
	setSessions: vi.fn(),
	setAutoRunDocumentList: vi.fn(),
	setAutoRunDocumentTree: vi.fn(),
	setAutoRunIsLoadingDocuments: vi.fn(),
	setAutoRunSetupModalOpen: vi.fn(),
	setBatchRunnerModalOpen: vi.fn(),
	setActiveRightTab: vi.fn(),
	setRightPanelOpen: vi.fn(),
	setActiveFocus: vi.fn(),
	setSuccessFlashNotification: vi.fn(),
	autoRunDocumentList: ['Phase 1'],
	startBatchRun: vi.fn(),
});

const baseConfig: BatchRunConfig = {
	documents: [{ id: '1', filename: 'Phase 1', resetOnCompletion: false, isDuplicate: false }],
	prompt: 'Work the next - [ ] task',
	loopEnabled: false,
};

beforeEach(() => {
	vi.clearAllMocks();
	useSessionStore.setState({ sessions: [], activeSessionId: '' } as never);
	useBatchStore.setState({ batchRunStates: {} } as never);
	// Pre-hydrated so the dispatcher's tick runs without awaiting settings IPC.
	useScheduledAutoRunStore.setState({ scheduled: {}, hydrated: true });
});

afterEach(() => {
	vi.useRealTimers();
});

describe('handleStartBatchRun - scheduling', () => {
	it('parks a run with a future scheduledFor instead of launching it', async () => {
		const session = createMockSession();
		seedActiveSession(session);
		const deps = createMockDeps();
		const { result } = renderHook(() => useAutoRunHandlers(deps));

		const scheduledFor = Date.now() + 60 * 60 * 1000;
		await act(async () => {
			await result.current.handleStartBatchRun({ ...baseConfig, scheduledFor });
		});

		expect(deps.startBatchRun).not.toHaveBeenCalled();
		expect(deps.setBatchRunnerModalOpen).toHaveBeenCalledWith(false);

		const parked = useScheduledAutoRunStore.getState().scheduled['session-1'];
		expect(parked).toMatchObject({
			sessionId: 'session-1',
			folderPath: '/projects/autorun-docs',
			scheduledFor,
		});
	});

	it('launches immediately when scheduledFor is already in the past', async () => {
		const session = createMockSession();
		seedActiveSession(session);
		const deps = createMockDeps();
		const { result } = renderHook(() => useAutoRunHandlers(deps));

		await act(async () => {
			await result.current.handleStartBatchRun({
				...baseConfig,
				scheduledFor: Date.now() - 1_000,
			});
		});

		expect(useScheduledAutoRunStore.getState().scheduled).toEqual({});
		expect(deps.startBatchRun).toHaveBeenCalledTimes(1);
		// The timestamp must not leak into the config the runner receives.
		expect(deps.startBatchRun.mock.calls[0][1]).not.toHaveProperty('scheduledFor');
	});

	it('targets the session passed via options rather than the active one', async () => {
		const active = createMockSession({ id: 'active-session' });
		const other = createMockSession({ id: 'other-session', name: 'Other Agent' });
		useSessionStore.setState({
			sessions: [active, other],
			activeSessionId: active.id,
		} as never);
		const deps = createMockDeps();
		const { result } = renderHook(() => useAutoRunHandlers(deps));

		await act(async () => {
			await result.current.handleStartBatchRun(baseConfig, { session: other });
		});

		expect(deps.startBatchRun).toHaveBeenCalledWith(
			'other-session',
			expect.anything(),
			'/projects/autorun-docs'
		);
	});
});

describe('useScheduledAutoRunDispatcher', () => {
	it('launches a parked run once its timestamp passes', async () => {
		vi.useFakeTimers();
		const session = createMockSession();
		seedActiveSession(session);
		useScheduledAutoRunStore.setState({
			hydrated: true,
			scheduled: {
				'session-1': {
					sessionId: 'session-1',
					folderPath: '/projects/autorun-docs',
					config: { ...baseConfig, scheduledFor: Date.now() - 1_000 },
					scheduledFor: Date.now() - 1_000,
					createdAt: Date.now() - 10_000,
				},
			},
		});

		const onLaunch = vi.fn();
		renderHook(() => useScheduledAutoRunDispatcher({ onLaunch }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(20_000);
		});

		expect(onLaunch).toHaveBeenCalledTimes(1);
		const [config, options] = onLaunch.mock.calls[0];
		expect(config).not.toHaveProperty('scheduledFor');
		expect(options.session.id).toBe('session-1');
		// Cleared so a later tick can't fire it twice.
		expect(useScheduledAutoRunStore.getState().scheduled).toEqual({});
	});

	it('leaves a future schedule parked', async () => {
		vi.useFakeTimers();
		const session = createMockSession();
		seedActiveSession(session);
		useScheduledAutoRunStore.setState({
			hydrated: true,
			scheduled: {
				'session-1': {
					sessionId: 'session-1',
					folderPath: '/projects/autorun-docs',
					config: baseConfig,
					scheduledFor: Date.now() + 60 * 60 * 1000,
					createdAt: Date.now(),
				},
			},
		});

		const onLaunch = vi.fn();
		renderHook(() => useScheduledAutoRunDispatcher({ onLaunch }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60_000);
		});

		expect(onLaunch).not.toHaveBeenCalled();
		expect(useScheduledAutoRunStore.getState().scheduled['session-1']).toBeDefined();
	});

	it('defers a due run while the agent is busy, then fires when it frees up', async () => {
		vi.useFakeTimers();
		const session = createMockSession({ state: 'busy' });
		seedActiveSession(session);
		useScheduledAutoRunStore.setState({
			hydrated: true,
			scheduled: {
				'session-1': {
					sessionId: 'session-1',
					folderPath: '/projects/autorun-docs',
					config: baseConfig,
					scheduledFor: Date.now() - 1_000,
					createdAt: Date.now() - 10_000,
				},
			},
		});

		const onLaunch = vi.fn();
		renderHook(() => useScheduledAutoRunDispatcher({ onLaunch }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(20_000);
		});
		expect(onLaunch).not.toHaveBeenCalled();
		expect(useScheduledAutoRunStore.getState().scheduled['session-1']).toBeDefined();

		seedActiveSession(createMockSession({ state: 'ready' }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(20_000);
		});
		expect(onLaunch).toHaveBeenCalledTimes(1);
	});

	it('defers while an Auto Run is already in flight for that agent', async () => {
		vi.useFakeTimers();
		seedActiveSession(createMockSession());
		useBatchStore.setState({
			batchRunStates: { 'session-1': { isRunning: true } },
		} as never);
		useScheduledAutoRunStore.setState({
			hydrated: true,
			scheduled: {
				'session-1': {
					sessionId: 'session-1',
					folderPath: '/projects/autorun-docs',
					config: baseConfig,
					scheduledFor: Date.now() - 1_000,
					createdAt: Date.now() - 10_000,
				},
			},
		});

		const onLaunch = vi.fn();
		renderHook(() => useScheduledAutoRunDispatcher({ onLaunch }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(20_000);
		});

		expect(onLaunch).not.toHaveBeenCalled();
		expect(useScheduledAutoRunStore.getState().scheduled['session-1']).toBeDefined();
	});

	it('drops a run missed by more than the grace window without firing it', async () => {
		vi.useFakeTimers();
		seedActiveSession(createMockSession());
		useScheduledAutoRunStore.setState({
			hydrated: true,
			scheduled: {
				'session-1': {
					sessionId: 'session-1',
					folderPath: '/projects/autorun-docs',
					config: baseConfig,
					scheduledFor: Date.now() - SCHEDULED_AUTO_RUN_GRACE_MS - 60_000,
					createdAt: Date.now() - SCHEDULED_AUTO_RUN_GRACE_MS - 120_000,
				},
			},
		});

		const onLaunch = vi.fn();
		renderHook(() => useScheduledAutoRunDispatcher({ onLaunch }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(20_000);
		});

		expect(onLaunch).not.toHaveBeenCalled();
		expect(useScheduledAutoRunStore.getState().scheduled).toEqual({});
	});

	it('drops a schedule whose agent no longer exists', async () => {
		vi.useFakeTimers();
		useSessionStore.setState({ sessions: [], activeSessionId: '' } as never);
		useScheduledAutoRunStore.setState({
			hydrated: true,
			scheduled: {
				'ghost-session': {
					sessionId: 'ghost-session',
					folderPath: '/projects/autorun-docs',
					config: baseConfig,
					scheduledFor: Date.now() - 1_000,
					createdAt: Date.now() - 10_000,
				},
			},
		});

		const onLaunch = vi.fn();
		renderHook(() => useScheduledAutoRunDispatcher({ onLaunch }));
		await act(async () => {
			await vi.advanceTimersByTimeAsync(20_000);
		});

		expect(onLaunch).not.toHaveBeenCalled();
		expect(useScheduledAutoRunStore.getState().scheduled).toEqual({});
	});
});
