import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	act,
	cleanup,
	fireEvent,
	render,
	renderHook,
	screen,
	waitFor,
} from '@testing-library/react';
import { useMemoryCommandEditor } from '../../../renderer/hooks/settings/useMemoryCommandEditor';
import { useModalStore } from '../../../renderer/stores/modalStore';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { AICommandsPanel } from '../../../renderer/components/AICommandsPanel';
import { mockTheme } from '../../helpers/mockTheme';
import type { MemoryCommandEditorPreview } from '../../../shared/memoryCommandDraft';

const draft = {
	command: 'synthetic',
	description: 'Synthetic description',
	prompt: 'Synthetic prompt',
};
const preview: MemoryCommandEditorPreview = {
	requestId: 'host-request',
	viewerId: 'host-alias',
	background: true,
	draft,
};
let deliver: (value: MemoryCommandEditorPreview) => void;
let off: ReturnType<typeof vi.fn>;
let close: ReturnType<typeof vi.fn>;
let save: ReturnType<typeof vi.fn>;

beforeEach(() => {
	useSettingsStore.setState({
		customAICommands: [],
		encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, plugins: true },
	});
	useModalStore.getState().closeModal('settings');
	off = vi.fn();
	close = vi.fn(async () => {});
	save = vi.fn(async (_viewer, requestId, fields) => ({
		requestId,
		status: 'saved',
		commands: [{ id: 'saved-command', ...fields }],
	}));
	window.maestro.memory = {
		...window.maestro.memory,
		onCommandEditor: vi.fn((callback) => {
			deliver = callback;
			return off;
		}),
		closeCommandViewer: close,
		saveCommand: save,
	} as typeof window.maestro.memory;
});
afterEach(cleanup);

describe('CLI preview in the existing command editor', () => {
	it('keeps an already open Settings section on background and foreground delivery', () => {
		useModalStore.getState().openModal('settings', { tab: 'general' });
		const { result } = renderHook(() => useMemoryCommandEditor(true));
		act(() => deliver(preview));
		act(() => deliver({ ...preview, background: false }));
		expect(useModalStore.getState().getData('settings')).toMatchObject({ tab: 'general' });
		expect(result.current.preview).toBeNull();
		expect(result.current.staged).toEqual(preview);
		expect(save).not.toHaveBeenCalled();
	});
	it('stages in the background, opens Settings only on explicit focus, and preserves the same preview on redelivery', () => {
		const { result, unmount } = renderHook(() => useMemoryCommandEditor(false));
		act(() => deliver(preview));
		expect(result.current.preview).toBeNull();
		expect(result.current.staged).toEqual(preview);
		expect(useModalStore.getState().isOpen('settings')).toBe(false);
		const first = result.current.staged;
		act(() => deliver({ ...preview, background: false }));
		expect(result.current.staged).toBe(first);
		expect(result.current.preview).toBeNull();
		expect(useModalStore.getState().isOpen('settings')).toBe(true);
		expect(useModalStore.getState().getData('settings')).toMatchObject({ tab: 'aicommands' });
		expect(save).not.toHaveBeenCalled();
		unmount();
		expect(off).toHaveBeenCalledOnce();
		expect(close).toHaveBeenCalledExactlyOnceWith(preview.viewerId);
	});

	it('discards a preview when Settings closes and ignores completion for an older request', () => {
		const { result, rerender } = renderHook(({ open }) => useMemoryCommandEditor(open), {
			initialProps: { open: false },
		});
		act(() => deliver(preview));
		act(() => result.current.activate(preview.requestId));
		act(() => result.current.complete('saved', 'older-request'));
		expect(result.current.preview).toEqual(preview);
		rerender({ open: true });
		rerender({ open: false });
		expect(result.current.preview).toBeNull();
		expect(close).toHaveBeenCalledExactlyOnceWith(preview.viewerId);
		expect(save).not.toHaveBeenCalled();
	});

	it.each(['retry', 'collision', 'failure', 'foreign'])(
		'retains edits on %s without a local settings write',
		async (status) => {
			const { result } = renderHook(() => useMemoryCommandEditor(false));
			act(() => deliver(preview));
			act(() => result.current.activate(preview.requestId));
			if (status === 'failure') save.mockRejectedValueOnce(new Error('MemoryCommandUnavailable'));
			else
				save.mockResolvedValueOnce({
					requestId: status === 'foreign' ? 'wrong' : preview.requestId,
					status: status === 'foreign' ? 'saved' : status,
					commands: [{ id: 'bad', ...draft }],
				});
			const pending = result.current.save(draft);
			if (status === 'collision' || status === 'failure') await expect(pending).rejects.toThrow();
			else expect(await pending).toBe(false);
			expect(result.current.preview).toEqual(preview);
			expect(useSettingsStore.getState().customAICommands).toEqual([]);
			expect(close).not.toHaveBeenCalled();
		}
	);

	it('uses the real global create form for edited fields and a confirmed save without a follow-up cancel', async () => {
		function Editor() {
			const editor = useMemoryCommandEditor(true);
			return (
				<AICommandsPanel
					theme={mockTheme}
					customAICommands={[]}
					setCustomAICommands={vi.fn()}
					memoryCommandDraft={editor.preview ?? undefined}
					stagedMemoryCommandDraft={editor.staged ?? undefined}
					onReviewMemoryCommandDraft={editor.activate}
					saveMemoryCommandDraft={editor.save}
					onDraftComplete={(status) => {
						if (editor.preview) editor.complete(status, editor.preview.requestId);
					}}
				/>
			);
		}
		render(<Editor />);
		act(() => deliver(preview));
		fireEvent.click(screen.getByRole('button', { name: 'Review draft' }));
		expect(save).not.toHaveBeenCalled();
		fireEvent.change(screen.getByPlaceholderText('/mycommand'), { target: { value: '/edited' } });
		fireEvent.change(screen.getByPlaceholderText('Short description for autocomplete'), {
			target: { value: 'Edited description' },
		});
		fireEvent.change(
			screen.getByPlaceholderText(
				'The actual prompt sent to the AI agent when this command is invoked... (type {{ for variables)'
			),
			{ target: { value: 'Edited prompt' } }
		);
		act(() => deliver({ ...preview, background: false }));
		expect(screen.getByPlaceholderText('/mycommand')).toHaveValue('/edited');
		fireEvent.click(screen.getByRole('button', { name: 'Create' }));
		await waitFor(() =>
			expect(save).toHaveBeenCalledExactlyOnceWith(preview.viewerId, preview.requestId, {
				command: '/edited',
				description: 'Edited description',
				prompt: 'Edited prompt',
			})
		);
		await waitFor(() =>
			expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument()
		);
		expect(useSettingsStore.getState().customAICommands[0]).toMatchObject({
			command: '/edited',
			prompt: 'Edited prompt',
		});
		expect(close).not.toHaveBeenCalled();
	});

	it('keeps active and staged requests separate across foreign completions, cancellations and late delivery', () => {
		const { result } = renderHook(() => useMemoryCommandEditor(true));
		const next = { ...preview, requestId: 'next', viewerId: 'next-alias' };
		act(() => deliver(preview));
		act(() => result.current.activate(preview.requestId));
		const active = result.current.preview;
		act(() => deliver(next));
		act(() => result.current.complete('saved', 'foreign'));
		act(() => result.current.activate(next.requestId));
		expect(result.current.preview).toBe(active);
		expect(result.current.staged).toEqual(next);
		act(() => result.current.complete('cancelled', next.requestId));
		expect(result.current.preview).toBe(active);
		expect(result.current.staged).toBeNull();
		expect(close).toHaveBeenCalledExactlyOnceWith(next.viewerId);
		act(() => {
			deliver(next);
			deliver({ ...preview, background: false });
		});
		expect(result.current.preview).toBe(active);
		expect(result.current.staged).toBeNull();
		const savedElsewhere = { ...next, requestId: 'saved-elsewhere', viewerId: 'saved-alias' };
		act(() => deliver(savedElsewhere));
		act(() => result.current.complete('saved', savedElsewhere.requestId));
		expect(result.current.preview).toBe(active);
		expect(result.current.staged).toBeNull();
		expect(close).toHaveBeenCalledTimes(1);
		act(() => result.current.complete('saved', preview.requestId));
		act(() => deliver(preview));
		expect(result.current.preview).toBeNull();
		expect(result.current.staged).toBeNull();
		expect(close).toHaveBeenCalledTimes(1);
	});

	it('rejects redelivery under a foreign viewer without focusing Settings or replacing the staged owner', () => {
		const { result } = renderHook(() => useMemoryCommandEditor(false));
		act(() => deliver(preview));
		const staged = result.current.staged;
		act(() => deliver({ ...preview, viewerId: 'foreign-alias', background: false }));
		expect(result.current.staged).toBe(staged);
		expect(result.current.preview).toBeNull();
		expect(useModalStore.getState().isOpen('settings')).toBe(false);
		act(() => result.current.activate(preview.requestId));
		expect(result.current.preview?.viewerId).toBe(preview.viewerId);
		expect(close).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
	});

	it.each(['saved', 'cancelled'] as const)(
		'rejects an old save callback after %s while preserving the next staged request',
		async (status) => {
			const { result } = renderHook(() => useMemoryCommandEditor(true));
			act(() => deliver(preview));
			act(() => result.current.activate(preview.requestId));
			const oldSave = result.current.save;
			const next = { ...preview, requestId: 'next', viewerId: 'next-alias' };
			act(() => deliver(next));
			act(() => result.current.complete(status, preview.requestId));
			expect(await oldSave(draft)).toBe(false);
			expect(result.current.preview).toBeNull();
			expect(result.current.staged).toEqual(next);
			expect(save).not.toHaveBeenCalled();
			expect(close.mock.calls).toEqual(status === 'cancelled' ? [[preview.viewerId]] : []);
			act(() => result.current.activate(next.requestId));
			expect(result.current.preview).toEqual(next);
		}
	);

	it('cancels both active and staged requests when plugins turn off', () => {
		const { result, unmount } = renderHook(() => useMemoryCommandEditor(true));
		act(() => deliver(preview));
		act(() => result.current.activate(preview.requestId));
		act(() => deliver({ ...preview, requestId: 'second', viewerId: 'second-alias' }));
		act(() =>
			useSettingsStore.setState({
				encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, plugins: false },
			})
		);
		expect(close.mock.calls).toEqual([[preview.viewerId], ['second-alias']]);
		expect(result.current.preview).toBeNull();
		expect(result.current.staged).toBeNull();
		unmount();
		expect(close).toHaveBeenCalledTimes(2);
	});

	it('does not subscribe or accept events while plugins are disabled', () => {
		useSettingsStore.setState({
			encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, plugins: false },
		});
		const { result } = renderHook(() => useMemoryCommandEditor(false));
		expect(window.maestro.memory.onCommandEditor).not.toHaveBeenCalled();
		expect(result.current.preview).toBeNull();
		expect(result.current.staged).toBeNull();
	});

	it.each(['active', 'staged'])(
		'cancels %s drafts on plugins-off and rejects stale events, saves and resurrection',
		async (state) => {
			const { result } = renderHook(() => useMemoryCommandEditor(true));
			act(() => deliver(preview));
			if (state === 'active') act(() => result.current.activate(preview.requestId));
			const lateEvent = deliver;
			const lateSave = result.current.save;
			act(() =>
				useSettingsStore.setState({
					encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, plugins: false },
				})
			);
			expect(off).toHaveBeenCalledOnce();
			expect(close).toHaveBeenCalledExactlyOnceWith(preview.viewerId);
			expect(result.current.preview).toBeNull();
			expect(result.current.staged).toBeNull();
			act(() => lateEvent({ ...preview, background: false }));
			expect(await lateSave(draft)).toBe(false);
			expect(save).not.toHaveBeenCalled();
			expect(useModalStore.getState().isOpen('settings')).toBe(false);
			act(() =>
				useSettingsStore.setState({
					encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, plugins: true },
				})
			);
			act(() => {
				lateEvent(preview);
				deliver(preview);
			});
			expect(result.current.preview).toBeNull();
			expect(result.current.staged).toBeNull();
		}
	);
});
