import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	WorktreeCleanup,
	WorktreeCleanupResults,
	useWorktreeCleanup,
} from '../../../renderer/components/WorktreeCleanup';
import { useWorktreeCleanupStore } from '../../../renderer/stores/worktreeCleanupStore';
import { useModalStore } from '../../../renderer/stores/modalStore';

const prepare = vi.fn();
const abort = vi.fn();
const remove = vi.fn();
const listRecoveries = vi.fn();
const completeRecovery = vi.fn();
const cancelRecovery = vi.fn();
beforeEach(() => {
	vi.resetAllMocks();
	useWorktreeCleanupStore.setState({
		runs: {},
		recoveries: [],
		recoveryRuns: {},
		recoveryError: undefined,
	});
	window.maestro.git.prepareWorktreeRetirement = prepare;
	window.maestro.git.abortWorktreeRetirement = abort;
	window.maestro.git.removeWorktreeRetirement = remove;
	window.maestro.git.getWorktreeRetirementRecoveries = listRecoveries;
	window.maestro.git.completeWorktreeRetirementRecovery = completeRecovery;
	window.maestro.git.cancelWorktreeRetirementRecovery = cancelRecovery;
	listRecoveries.mockResolvedValue([]);
	prepare.mockResolvedValue({ ok: true, token: 'owned', revision: 1 });
	abort.mockResolvedValue(true);
	remove.mockResolvedValue({ status: 'removed' });
});

function Details({ present = true }: { present?: boolean }) {
	// Like the production host, this owner survives child registration removal.
	const controller = useWorktreeCleanup('child');
	return (
		<WorktreeCleanup
			controller={controller}
			path={present ? '/owned/child' : undefined}
			eligible={present}
		/>
	);
}

describe('desktop worktree cleanup', () => {
	it('keeps by default and requires preparation followed by explicit confirmation', async () => {
		render(<Details />);
		expect(prepare).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		fireEvent.click(screen.getByText('Prepare worktree cleanup'));
		fireEvent.click(await screen.findByText('Confirm worktree removal'));
		await screen.findByText(/Worktree removed\. Saved chat/);
		expect(prepare).toHaveBeenCalledWith('child');
		expect(remove).toHaveBeenCalledExactlyOnceWith('owned');
	});
	it('keeps the same token and visible pending result after the child row disappears', async () => {
		let finish!: (value: unknown) => void;
		remove.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			})
		);
		const view = render(<Details />);
		fireEvent.click(screen.getByText('Prepare worktree cleanup'));
		fireEvent.click(await screen.findByText('Confirm worktree removal'));
		view.rerender(<Details present={false} />);
		await act(async () => finish({ status: 'pending', reason: 'Archive flush pending' }));
		await screen.findByText('Cleanup pending: Archive flush pending');
		fireEvent.click(screen.getByText('Retry cleanup settlement'));
		await screen.findByText(/Worktree removed\. Saved chat/);
		expect(remove.mock.calls).toEqual([['owned'], ['owned']]);
		expect(prepare).toHaveBeenCalledOnce();
	});
	it('aborts when choosing keep and can prepare again after a blocked attempt', async () => {
		prepare.mockResolvedValueOnce({ ok: false, reason: 'open file tabs' });
		render(<Details />);
		fireEvent.click(screen.getByText('Prepare worktree cleanup'));
		await screen.findByText('Cleanup blocked: open file tabs');
		fireEvent.click(screen.getByText('Prepare worktree cleanup'));
		fireEvent.click(await screen.findByText('Keep checkout'));
		await waitFor(() => expect(screen.queryByText('Confirm worktree removal')).toBeNull());
		expect(abort).toHaveBeenCalledWith('owned');
		expect(remove).not.toHaveBeenCalled();
	});
	it('aborts a late preparation reply after close or retarget, without freezing the new target', async () => {
		let finish!: (value: unknown) => void;
		prepare.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			})
		);
		const hook = renderHook(({ id }) => useWorktreeCleanup(id), { initialProps: { id: 'child' } });
		let pending!: Promise<void>;
		act(() => {
			pending = hook.result.current.prepare();
		});
		hook.rerender({ id: 'sibling' });
		await act(async () => {
			finish({ ok: true, token: 'old', revision: 1 });
			await pending;
		});
		expect(abort).toHaveBeenCalledWith('old');
		expect(hook.result.current.token).toBeUndefined();
		expect(hook.result.current.result).toBeUndefined();
	});
	it('serializes double clicks and treats lost commit replies as pending with same-token retry', async () => {
		remove.mockRejectedValueOnce(new Error('Reply lost'));
		render(<Details />);
		fireEvent.click(screen.getByText('Prepare worktree cleanup'));
		const confirm = await screen.findByText('Confirm worktree removal');
		fireEvent.click(confirm);
		fireEvent.click(confirm);
		await screen.findByText('Cleanup pending: Reply lost');
		expect(remove).toHaveBeenCalledOnce();
		fireEvent.click(screen.getByText('Retry cleanup settlement'));
		await screen.findByText(/Worktree removed\. Saved chat/);
		expect(remove.mock.calls).toEqual([['owned'], ['owned']]);
	});
	it('retains an uncertain commit across close and retarget, then retries the original token', async () => {
		remove.mockRejectedValueOnce(new Error('Reply lost'));
		const hook = renderHook(({ id }) => useWorktreeCleanup(id), {
			initialProps: { id: 'child' as string | undefined },
		});
		await act(async () => hook.result.current.prepare());
		await act(async () => hook.result.current.remove());
		hook.rerender({ id: undefined });
		hook.rerender({ id: 'sibling' });
		expect(hook.result.current.token).toBeUndefined();
		hook.rerender({ id: 'child' });
		expect(hook.result.current.token).toBe('owned');
		expect(hook.result.current.result).toMatchObject({ status: 'pending', reason: 'Reply lost' });
		await act(async () => hook.result.current.remove());
		expect(remove.mock.calls).toEqual([['owned'], ['owned']]);
		expect(prepare).toHaveBeenCalledOnce();
	});
	it('parks an in-flight removal through unmount, rejects duplicate submissions and preserves the original path', async () => {
		let finish!: (value: unknown) => void;
		remove.mockReturnValueOnce(
			new Promise((resolve) => {
				finish = resolve;
			})
		);
		const first = renderHook(() =>
			useWorktreeCleanup('child', { path: '/original', name: 'Original' })
		);
		await act(async () => first.result.current.prepare());
		let pending!: Promise<void>;
		act(() => {
			pending = first.result.current.remove();
		});
		first.unmount();
		const reopened = renderHook(() => useWorktreeCleanup('child', { path: '/replacement' }));
		expect(reopened.result.current.busy).toBe(true);
		expect(reopened.result.current.path).toBe('/original');
		await act(async () => {
			await reopened.result.current.prepare();
			await reopened.result.current.remove();
		});
		expect(remove).toHaveBeenCalledOnce();
		expect(abort).not.toHaveBeenCalled();
		await act(async () => {
			finish({ status: 'removed' });
			await pending;
		});
		expect(reopened.result.current.result).toEqual({ status: 'removed' });
		expect(prepare).toHaveBeenCalledOnce();
	});
	it('aborts unused preparation on close and preserves keep intent after a lost abort reply', async () => {
		abort.mockRejectedValueOnce(new Error('Keep reply lost'));
		const first = renderHook(() => useWorktreeCleanup('child'));
		await act(async () => first.result.current.prepare());
		first.unmount();
		await waitFor(() =>
			expect(useWorktreeCleanupStore.getState().runs.child.result?.status).toBe('pending')
		);
		render(<Details />);
		expect(screen.queryByText('Confirm worktree removal')).toBeNull();
		await act(async () => useWorktreeCleanupStore.getState().remove('child'));
		expect(remove).not.toHaveBeenCalled();
		fireEvent.click(screen.getByText('Retry keeping checkout'));
		await waitFor(() => expect(useWorktreeCleanupStore.getState().runs.child).toBeUndefined());
		expect(abort.mock.calls).toEqual([['owned'], ['owned']]);
	});
	it('makes parked cleanup discoverable from another target even after child registration disappears', async () => {
		remove.mockRejectedValueOnce(new Error('Reply lost'));
		const first = renderHook(() => useWorktreeCleanup('child', { name: 'Original child' }));
		await act(async () => first.result.current.prepare());
		await act(async () => first.result.current.remove());
		first.unmount();
		render(<WorktreeCleanupResults sessionId="parent" />);
		fireEvent.click(screen.getByText('View cleanup for Original child'));
		expect(useModalStore.getState().getData('worktreePRDetails')).toEqual({ sessionId: 'child' });
		expect(screen.queryByText('Dismiss result')).toBeNull();
	});
	it('shows explicit restart recovery without offering to adopt the old runner', async () => {
		remove.mockResolvedValue({
			status: 'pending',
			reason: 'Original primary document lost',
			recovery: 'restart-required',
		});
		render(<Details />);
		fireEvent.click(screen.getByText('Prepare worktree cleanup'));
		fireEvent.click(await screen.findByText('Confirm worktree removal'));
		await screen.findByText('Cleanup pending: Original primary document lost');
		expect(screen.queryByText('Retry cleanup settlement')).toBeNull();
		expect(screen.queryByText('Prepare worktree cleanup')).toBeNull();
	});
	it('does not prepare unsupported targets', () => {
		render(<Details present={false} />);
		expect(screen.getByText('Prepare worktree cleanup')).toBeDisabled();
	});
});

describe('startup cleanup recovery in the PR details surface', () => {
	const target = { id: 'original-journal', sessionId: 'absent-child', path: '/removed/child' };
	it('ignores a stale list response after a newer recovery refresh', async () => {
		let finish!: (value: unknown) => void;
		listRecoveries
			.mockReturnValueOnce(
				new Promise((resolve) => {
					finish = resolve;
				})
			)
			.mockResolvedValueOnce([]);
		const old = useWorktreeCleanupStore.getState().refreshRecoveries();
		await useWorktreeCleanupStore.getState().refreshRecoveries();
		finish([target]);
		await old;
		expect(useWorktreeCleanupStore.getState().recoveries).toEqual([]);
	});
	it('completes only the original journal and preserves its result after close/reopen', async () => {
		listRecoveries.mockResolvedValueOnce([target]).mockResolvedValue([]);
		completeRecovery.mockResolvedValue({ status: 'removed' });
		await act(async () => useWorktreeCleanupStore.getState().refreshRecoveries());
		const view = render(<WorktreeCleanupResults />);
		fireEvent.click(screen.getByText('Complete removed checkout recovery'));
		await screen.findByText(/Recovery complete\. Saved chat/);
		expect(completeRecovery).toHaveBeenCalledExactlyOnceWith('original-journal');
		expect(prepare).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
		view.unmount();
		render(<WorktreeCleanupResults />);
		expect(screen.getByText(/Recovery complete\. Saved chat/)).toBeInTheDocument();
	});
	it('reports present and partial-outcome refusals and allows explicit keep with the same journal', async () => {
		listRecoveries.mockResolvedValue([target]);
		completeRecovery.mockResolvedValue({ status: 'blocked', reason: 'checkout is fully present' });
		cancelRecovery.mockResolvedValue({ ok: false, reason: 'ownership changed' });
		await act(async () => useWorktreeCleanupStore.getState().refreshRecoveries());
		render(<WorktreeCleanupResults />);
		fireEvent.click(screen.getByText('Complete removed checkout recovery'));
		await screen.findByText(/Recovery blocked: checkout is fully present/);
		fireEvent.click(screen.getByText('Keep present checkout'));
		await screen.findByText(/Recovery blocked: ownership changed/);
		expect(cancelRecovery).toHaveBeenCalledExactlyOnceWith('original-journal');
		expect(remove).not.toHaveBeenCalled();
	});
	it('serializes conflicting recovery actions and reattaches after a lost reply', async () => {
		let fail!: (reason: unknown) => void;
		completeRecovery
			.mockReturnValueOnce(
				new Promise((_resolve, reject) => {
					fail = reject;
				})
			)
			.mockResolvedValue({ status: 'removed' });
		listRecoveries.mockResolvedValue([target]);
		await act(async () => useWorktreeCleanupStore.getState().refreshRecoveries());
		const view = render(<WorktreeCleanupResults />);
		fireEvent.click(screen.getByText('Complete removed checkout recovery'));
		expect(screen.getByText('Keep present checkout')).toBeDisabled();
		await act(async () => useWorktreeCleanupStore.getState().recover(target, 'cancel'));
		view.unmount();
		await act(async () => fail(new Error('lost reply')));
		render(<WorktreeCleanupResults />);
		await screen.findByText(/Recovery reply unavailable: lost reply/);
		fireEvent.click(screen.getByText('Complete removed checkout recovery'));
		await screen.findByText(/Recovery complete\. Saved chat/);
		expect(completeRecovery.mock.calls).toEqual([['original-journal'], ['original-journal']]);
		expect(cancelRecovery).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
	});
	it('keeps a present checkout and reports list failures without presenting them as no pending work', async () => {
		listRecoveries.mockResolvedValueOnce([target]).mockRejectedValue(new Error('Store unreadable'));
		cancelRecovery.mockResolvedValue({ ok: true });
		await act(async () => useWorktreeCleanupStore.getState().refreshRecoveries());
		render(<WorktreeCleanupResults />);
		fireEvent.click(screen.getByText('Keep present checkout'));
		await screen.findByText(/Recovery cancelled\. The checkout and registrations are kept/);
		await screen.findByText('Recovery unavailable: Store unreadable');
		expect(screen.queryByText('No startup cleanup recoveries.')).toBeNull();
		expect(completeRecovery).not.toHaveBeenCalled();
		expect(remove).not.toHaveBeenCalled();
	});
});
