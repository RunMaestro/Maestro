import React from 'react';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WorktreeCleanup, useWorktreeCleanup } from '../../../renderer/components/WorktreeCleanup';

const prepare = vi.fn();
const abort = vi.fn();
const remove = vi.fn();
beforeEach(() => {
	vi.resetAllMocks();
	window.maestro.git.prepareWorktreeRetirement = prepare;
	window.maestro.git.abortWorktreeRetirement = abort;
	window.maestro.git.removeWorktreeRetirement = remove;
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
