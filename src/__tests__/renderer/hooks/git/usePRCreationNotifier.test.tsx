/**
 * Tests for usePRCreationNotifier - reports PR creations that settle while the
 * Create PR form is closed.
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { usePRCreationNotifier } from '../../../../renderer/hooks/git/usePRCreationNotifier';
import { notifyToast } from '../../../../renderer/stores/notificationStore';
import { usePRCreationStore, prRunKey } from '../../../../renderer/stores/prCreationStore';
import type { PRDetails } from '../../../../renderer/components/CreatePRModal';

vi.mock('../../../../renderer/stores/notificationStore', () => ({
	notifyToast: vi.fn(),
}));

const TARGET = {
	sessionId: 'session-1',
	worktreePath: '/test/worktree',
	sourceBranch: 'visual-polish',
	targetBranch: 'main',
	title: 'visual polish',
	description: 'body',
};
const KEY = prRunKey(TARGET.worktreePath);

type CreatePRResult = { success: boolean; prUrl?: string; error?: string };
let settle: (result: CreatePRResult) => void = () => {};
const createPR = vi.fn();

describe('usePRCreationNotifier', () => {
	let onPRCreated: Mock<(details: PRDetails) => void>;
	let onCloseModal: Mock<() => void>;

	beforeEach(() => {
		vi.clearAllMocks();
		usePRCreationStore.setState({ runs: {} });
		onPRCreated = vi.fn<(details: PRDetails) => void>();
		onCloseModal = vi.fn<() => void>();
		createPR.mockImplementation(
			() =>
				new Promise<CreatePRResult>((resolve) => {
					settle = resolve;
				})
		);
		(globalThis as unknown as { window: { maestro: unknown } }).window.maestro = {
			git: { createPR },
		};
	});

	it('hands a PR created off-screen to the host and forgets the run', async () => {
		renderHook(() => usePRCreationNotifier(null, onPRCreated, onCloseModal));
		usePRCreationStore.getState().startPRCreation(TARGET);

		settle({ success: true, prUrl: 'https://github.com/o/r/pull/7' });

		await waitFor(() => expect(onPRCreated).toHaveBeenCalledTimes(1));
		expect(onPRCreated).toHaveBeenCalledWith({
			url: 'https://github.com/o/r/pull/7',
			title: 'visual polish',
			description: 'body',
			sourceBranch: 'visual-polish',
			targetBranch: 'main',
			sessionId: 'session-1',
		});
		// Nothing was on screen to close.
		expect(onCloseModal).not.toHaveBeenCalled();
		expect(usePRCreationStore.getState().runs[KEY]).toBeUndefined();
	});

	it('closes the form when the PR it is showing succeeds', async () => {
		renderHook(() => usePRCreationNotifier(KEY, onPRCreated, onCloseModal));
		usePRCreationStore.getState().startPRCreation(TARGET);

		settle({ success: true, prUrl: 'https://github.com/o/r/pull/7' });

		await waitFor(() => expect(onCloseModal).toHaveBeenCalledTimes(1));
		expect(onPRCreated).toHaveBeenCalledTimes(1);
	});

	it('toasts a failure the user never saw, and keeps it for a second look', async () => {
		renderHook(() => usePRCreationNotifier(null, onPRCreated, onCloseModal));
		usePRCreationStore.getState().startPRCreation(TARGET);

		settle({ success: false, error: 'no commits between main and visual-polish' });

		await waitFor(() => expect(notifyToast).toHaveBeenCalledTimes(1));
		expect(notifyToast).toHaveBeenCalledWith(
			expect.objectContaining({
				color: 'red',
				title: 'Pull request failed',
				message: 'no commits between main and visual-polish',
				dismissible: true,
				clickAction: { kind: 'jump-session', sessionId: 'session-1' },
			})
		);
		// Reopening Create Pull Request has to be able to show why it died.
		expect(usePRCreationStore.getState().runs[KEY]?.status).toBe('failed');
		expect(onPRCreated).not.toHaveBeenCalled();
	});

	it('stays quiet when the form is showing the failure inline', async () => {
		renderHook(() => usePRCreationNotifier(KEY, onPRCreated, onCloseModal));
		usePRCreationStore.getState().startPRCreation(TARGET);

		settle({ success: false, error: 'gh auth expired' });

		await waitFor(() => expect(usePRCreationStore.getState().runs[KEY]?.announced).toBe(true));
		expect(notifyToast).not.toHaveBeenCalled();
		expect(onCloseModal).not.toHaveBeenCalled();
	});

	it('reports a creation that settled before it mounted', async () => {
		usePRCreationStore.getState().startPRCreation(TARGET);
		settle({ success: false, error: 'boom' });
		await waitFor(() => expect(usePRCreationStore.getState().runs[KEY]?.status).toBe('failed'));

		renderHook(() => usePRCreationNotifier(null, onPRCreated, onCloseModal));

		await waitFor(() => expect(notifyToast).toHaveBeenCalledTimes(1));
	});

	it('reports each settlement exactly once', async () => {
		renderHook(() => usePRCreationNotifier(null, onPRCreated, onCloseModal));
		usePRCreationStore.getState().startPRCreation(TARGET);
		settle({ success: false, error: 'boom' });

		await waitFor(() => expect(notifyToast).toHaveBeenCalledTimes(1));
		// Any unrelated store write must not re-announce the same failure.
		usePRCreationStore.setState((state) => ({ runs: { ...state.runs } }));
		expect(notifyToast).toHaveBeenCalledTimes(1);
	});
});
