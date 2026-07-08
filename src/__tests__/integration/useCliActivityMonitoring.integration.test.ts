import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useCliActivityMonitoring } from '../../renderer/hooks/remote/useCliActivityMonitoring';
import type { Session } from '../../renderer/types';

const mocks = vi.hoisted(() => ({
	loggerError: vi.fn(),
}));

vi.mock('../../renderer/utils/logger', () => ({
	logger: {
		error: mocks.loggerError,
	},
}));

function makeSession(overrides: Partial<Session> & { id: string }): Session {
	return {
		id: overrides.id,
		name: overrides.name ?? overrides.id,
		state: overrides.state ?? 'idle',
		aiPid: overrides.aiPid ?? 0,
		cliActivity: overrides.cliActivity,
	} as Session;
}

function makeActivity(
	overrides: Partial<NonNullable<Session['cliActivity']>> & { sessionId: string }
) {
	return {
		sessionId: overrides.sessionId,
		playbookId: overrides.playbookId ?? 'playbook-1',
		playbookName: overrides.playbookName ?? 'Regression Sweep',
		startedAt: overrides.startedAt ?? '2026-05-14T12:00:00.000Z',
	};
}

describe('useCliActivityMonitoring', () => {
	const originalMaestro = window.maestro;
	const unsubscribe = vi.fn();
	let activityChangeHandler: (() => void) | undefined;
	let mockCli: {
		getActivity: ReturnType<typeof vi.fn>;
		onActivityChange: ReturnType<typeof vi.fn>;
	};

	beforeEach(() => {
		vi.clearAllMocks();
		activityChangeHandler = undefined;
		mockCli = {
			getActivity: vi.fn().mockResolvedValue([]),
			onActivityChange: vi.fn((handler: () => void) => {
				activityChangeHandler = handler;
				return unsubscribe;
			}),
		};
		window.maestro = {
			...originalMaestro,
			cli: mockCli,
		} as typeof window.maestro;
	});

	afterEach(() => {
		cleanup();
		window.maestro = originalMaestro;
		vi.restoreAllMocks();
	});

	function renderMonitoringHook(initialSessions: Session[]) {
		let sessions = initialSessions;
		const setSessions = vi.fn((updater: React.SetStateAction<Session[]>) => {
			sessions = typeof updater === 'function' ? updater(sessions) : updater;
		});
		const hook = renderHook(() => useCliActivityMonitoring({ setSessions }));

		return {
			...hook,
			getSessions: () => sessions,
			setSessions,
		};
	}

	it('returns an empty API and skips work when the CLI bridge is unavailable', () => {
		window.maestro = undefined as typeof window.maestro;
		const setSessions = vi.fn();

		const { result } = renderHook(() => useCliActivityMonitoring({ setSessions }));

		expect(result.current).toEqual({});
		expect(setSessions).not.toHaveBeenCalled();
	});

	it('ignores non-array activity payloads while still registering cleanup', async () => {
		mockCli.getActivity.mockResolvedValue({ active: true });
		const rendered = renderMonitoringHook([makeSession({ id: 'session-1' })]);

		await waitFor(() => {
			expect(mockCli.getActivity).toHaveBeenCalledTimes(1);
		});

		expect(rendered.setSessions).not.toHaveBeenCalled();
		expect(mockCli.onActivityChange).toHaveBeenCalledTimes(1);

		rendered.unmount();

		expect(unsubscribe).toHaveBeenCalledTimes(1);
	});

	it('marks matching idle sessions busy and preserves sessions already busy', async () => {
		const alreadyBusy = makeSession({ id: 'already-busy', state: 'busy', aiPid: 42 });
		mockCli.getActivity.mockResolvedValue([
			makeActivity({ sessionId: 'idle-session', playbookId: 'playbook-a' }),
			makeActivity({ sessionId: 'already-busy', playbookId: 'playbook-b' }),
		]);
		const rendered = renderMonitoringHook([
			makeSession({ id: 'idle-session' }),
			alreadyBusy,
			makeSession({ id: 'inactive-session' }),
		]);

		await waitFor(() => {
			expect(rendered.setSessions).toHaveBeenCalledTimes(1);
		});

		expect(rendered.getSessions()).toEqual([
			expect.objectContaining({
				id: 'idle-session',
				state: 'busy',
				cliActivity: expect.objectContaining({ playbookId: 'playbook-a' }),
			}),
			alreadyBusy,
			expect.objectContaining({ id: 'inactive-session', state: 'idle' }),
		]);
	});

	it('clears ended CLI activity only when no process is still running', async () => {
		const runningProcess = makeSession({
			id: 'running-process',
			state: 'busy',
			aiPid: 123,
			cliActivity: { playbookId: 'old', playbookName: 'Old', startedAt: 'earlier' },
		});
		mockCli.getActivity.mockResolvedValue([]);
		const rendered = renderMonitoringHook([
			makeSession({
				id: 'finished-cli',
				state: 'busy',
				cliActivity: { playbookId: 'old', playbookName: 'Old', startedAt: 'earlier' },
			}),
			runningProcess,
		]);

		await waitFor(() => {
			expect(rendered.setSessions).toHaveBeenCalledTimes(1);
		});

		expect(rendered.getSessions()).toEqual([
			expect.objectContaining({
				id: 'finished-cli',
				state: 'idle',
				cliActivity: undefined,
			}),
			runningProcess,
		]);
	});

	it('refreshes session state when the CLI activity change event fires', async () => {
		mockCli.getActivity
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce([makeActivity({ sessionId: 'session-1' })]);
		const rendered = renderMonitoringHook([makeSession({ id: 'session-1' })]);

		await waitFor(() => {
			expect(mockCli.getActivity).toHaveBeenCalledTimes(1);
		});

		act(() => {
			activityChangeHandler?.();
		});

		await waitFor(() => {
			expect(mockCli.getActivity).toHaveBeenCalledTimes(2);
			expect(rendered.getSessions()[0]).toMatchObject({
				id: 'session-1',
				state: 'busy',
				cliActivity: expect.objectContaining({ playbookId: 'playbook-1' }),
			});
		});
	});

	it('logs activity lookup failures without changing sessions', async () => {
		const error = new Error('activity unavailable');
		mockCli.getActivity.mockRejectedValue(error);
		const rendered = renderMonitoringHook([makeSession({ id: 'session-1' })]);

		await waitFor(() => {
			expect(mocks.loggerError).toHaveBeenCalledWith(
				'[CLI Activity] Error checking activity:',
				undefined,
				error
			);
		});

		expect(rendered.setSessions).not.toHaveBeenCalled();
		expect(rendered.getSessions()).toEqual([makeSession({ id: 'session-1' })]);
	});
});
