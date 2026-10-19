/**
 * Tests for services/tabCloseConfirm: what closing a tab asks first.
 *
 * An app window's chip close and a tab window's run the same rules (Tab
 * Windows: the confirm runs in the tab window, and only the confirmed close
 * goes to the owner), so each rule is pinned here once.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
	closeAiTabWithConfirm,
	closeFileTabWithConfirm,
	closeTerminalTabWithConfirm,
} from '../../../renderer/services/tabCloseConfirm';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { setLiveDraft } from '../../../renderer/utils/liveDraftStore';
import { createMockAITab, createMockFileTab } from '../../helpers/mockTab';

vi.mock('../../../renderer/utils/sentry', () => ({ captureMessage: vi.fn() }));

const confirmData = () => useModalStore.getState().getData('confirm');

beforeEach(() => {
	useModalStore.getState().closeModal('confirm');
});

describe('closeAiTabWithConfirm', () => {
	it('closes a clean tab at once', () => {
		const close = vi.fn();
		closeAiTabWithConfirm(createMockAITab({ id: 'clean' }), close);
		expect(close).toHaveBeenCalled();
		expect(useModalStore.getState().isOpen('confirm')).toBe(false);
	});

	it('asks first for an unsent draft, and closes on confirm', () => {
		const close = vi.fn();
		setLiveDraft('draft-tab', 'half a thought');
		closeAiTabWithConfirm(createMockAITab({ id: 'draft-tab' }), close);
		expect(close).not.toHaveBeenCalled();
		expect(confirmData()?.message).toMatch(/unsent draft/);
		confirmData()!.onConfirm();
		expect(close).toHaveBeenCalled();
		setLiveDraft('draft-tab', '');
	});

	it('asks first for a wizard the user has talked to', () => {
		const close = vi.fn();
		closeAiTabWithConfirm(
			createMockAITab({
				id: 'wizard',
				wizardState: {
					isActive: true,
					conversationHistory: [{ role: 'user', content: 'plan it' }],
				} as never,
			}),
			close
		);
		expect(confirmData()?.message).toMatch(/Close this wizard/);
	});

	it('closes a tab that is gone without asking', () => {
		const close = vi.fn();
		closeAiTabWithConfirm(undefined, close);
		expect(close).toHaveBeenCalled();
	});
});

describe('closeFileTabWithConfirm', () => {
	it('asks first for unsaved edits, naming the file', () => {
		const close = vi.fn();
		closeFileTabWithConfirm(
			createMockFileTab({ name: 'notes', extension: '.md', editContent: 'changed' }),
			close
		);
		expect(close).not.toHaveBeenCalled();
		expect(confirmData()?.message).toBe(
			'"notes.md" has unsaved changes. Are you sure you want to close it?'
		);
	});

	it('closes a saved file at once', () => {
		const close = vi.fn();
		closeFileTabWithConfirm(createMockFileTab(), close);
		expect(close).toHaveBeenCalled();
	});
});

describe('closeTerminalTabWithConfirm', () => {
	it('asks first while the shell runs a command, and closes an idle one at once', async () => {
		const isTerminalBusy = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
		(window as any).maestro = { ...(window as any).maestro, process: { isTerminalBusy } };

		const busyClose = vi.fn();
		closeTerminalTabWithConfirm('agent-1-terminal-t1', busyClose);
		await Promise.resolve();
		await Promise.resolve();
		expect(isTerminalBusy).toHaveBeenCalledWith('agent-1-terminal-t1');
		expect(busyClose).not.toHaveBeenCalled();
		expect(confirmData()).toMatchObject({ destructive: true });

		const idleClose = vi.fn();
		closeTerminalTabWithConfirm('agent-1-terminal-t2', idleClose);
		await Promise.resolve();
		await Promise.resolve();
		expect(idleClose).toHaveBeenCalled();
	});

	it('closes without asking when the busy check fails', async () => {
		const isTerminalBusy = vi.fn().mockRejectedValue(new Error('ipc down'));
		(window as any).maestro = { ...(window as any).maestro, process: { isTerminalBusy } };
		const close = vi.fn();
		closeTerminalTabWithConfirm('agent-1-terminal-t1', close);
		await Promise.resolve();
		await Promise.resolve();
		expect(close).toHaveBeenCalled();
	});
});
