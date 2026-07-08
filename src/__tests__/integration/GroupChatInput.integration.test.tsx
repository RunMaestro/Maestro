import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GroupChatInput } from '../../renderer/components/GroupChatInput';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import type { Group, QueuedItem, Session, Theme } from '../../renderer/types';

const theme: Theme = {
	id: 'integration-dark',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#101010',
		bgSidebar: '#181818',
		bgActivity: '#242424',
		textMain: '#f8fafc',
		textDim: '#94a3b8',
		accent: '#38bdf8',
		border: '#334155',
		error: '#ef4444',
		warning: '#f59e0b',
		success: '#22c55e',
	},
};

function session(id: string, name: string, groupId?: string, toolType = 'claude-code'): Session {
	return {
		id,
		name,
		groupId,
		toolType,
		state: 'idle',
		cwd: '/repo',
		fullPath: '/repo',
		projectRoot: '/repo',
		aiLogs: [],
		shellLogs: [],
		workLog: [],
		contextUsage: 0,
		inputMode: 'ai',
		aiPid: 0,
		terminalPid: 0,
		port: 0,
		isLive: false,
		changedFiles: [],
		isGitRepo: false,
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		executionQueue: [],
		activeTimeMs: 0,
		aiTabs: [],
		activeTabId: '',
		closedTabHistory: [],
	} as Session;
}

function group(id: string, name: string): Group {
	return { id, name, emoji: '#', collapsed: false };
}

function baseProps(overrides: Partial<React.ComponentProps<typeof GroupChatInput>> = {}) {
	return {
		theme,
		state: 'idle' as const,
		onSend: vi.fn(),
		participants: [],
		sessions: [],
		groupChatId: 'group-chat-1',
		...overrides,
	};
}

function ImageHarness(props: Partial<React.ComponentProps<typeof GroupChatInput>>) {
	const [stagedImages, setStagedImages] = useState<string[]>([]);
	return (
		<GroupChatInput
			{...baseProps(props)}
			stagedImages={stagedImages}
			setStagedImages={setStagedImages}
		/>
	);
}

describe('GroupChatInput integration', () => {
	beforeEach(() => {
		useSettingsStore.setState({ spellCheck: true });
		vi.clearAllMocks();
	});

	afterEach(() => {
		cleanup();
		useSettingsStore.setState({ spellCheck: false });
		vi.restoreAllMocks();
	});

	it('coordinates mention insertion, read-only mode, queued-state send styling, and draft reset', () => {
		const onSend = vi.fn();
		const onDraftChange = vi.fn();
		const sessions = [
			session('builder-1', 'Builder One', 'group-1'),
			session('reviewer-1', 'Reviewer One', 'group-1'),
			session('terminal-1', 'Terminal', 'group-1', 'terminal'),
			session('solo-1', 'Solo Agent'),
		];

		render(
			<GroupChatInput
				{...baseProps({
					state: 'agent-working',
					onSend,
					onDraftChange,
					sessions,
					groups: [group('group-1', 'Platform Team')],
				})}
			/>
		);

		const textarea = screen.getByPlaceholderText(/Type to queue message/i) as HTMLTextAreaElement;
		expect(textarea).toHaveAttribute('spellcheck', 'true');

		fireEvent.change(textarea, { target: { value: 'Ask @plat' } });
		expect(screen.getByText('@Platform-Team')).toBeInTheDocument();
		fireEvent.keyDown(textarea, { key: 'Enter' });
		expect(textarea).toHaveValue('Ask @Builder-One @Reviewer-One ');

		fireEvent.change(textarea, { target: { value: `${textarea.value}ship it` } });
		fireEvent.keyDown(textarea, { key: 'r', metaKey: true });
		expect(screen.getByText('Read-Only').closest('button')).toHaveStyle({
			color: theme.colors.warning,
		});

		fireEvent.click(screen.getByTitle('Queue message'));
		expect(onSend).toHaveBeenCalledWith('Ask @Builder-One @Reviewer-One ship it', undefined, true);
		expect(onDraftChange).toHaveBeenLastCalledWith('');
		expect(textarea).toHaveValue('');
	});

	it('stages selected images, opens the lightbox, and rejects invalid attachments', async () => {
		const onOpenLightbox = vi.fn();
		const showFlashNotification = vi.fn();

		render(
			<ImageHarness onOpenLightbox={onOpenLightbox} showFlashNotification={showFlashNotification} />
		);

		const input = document.getElementById('group-chat-image-input') as HTMLInputElement;
		const png = new File(['png'], 'capture.png', { type: 'image/png' });
		fireEvent.change(input, { target: { files: [png] } });

		const preview = await screen.findByAltText('Staged image');
		fireEvent.click(preview);
		expect(onOpenLightbox).toHaveBeenCalledWith(
			expect.stringMatching(/^data:image\/png;base64,/),
			[expect.stringMatching(/^data:image\/png;base64,/)],
			'staged'
		);

		const textarea = screen.getByPlaceholderText(/Type a message/i);
		fireEvent.keyDown(textarea, { key: 'y', metaKey: true });
		expect(onOpenLightbox).toHaveBeenCalledTimes(2);

		fireEvent.change(input, { target: { files: [png] } });
		await waitFor(() =>
			expect(showFlashNotification).toHaveBeenCalledWith('Duplicate image ignored')
		);

		fireEvent.change(input, {
			target: { files: [new File(['not-image'], 'notes.txt', { type: 'text/plain' })] },
		});
		fireEvent.change(input, {
			target: {
				files: [{ name: 'huge.png', type: 'image/png', size: 11 * 1024 * 1024 }],
			},
		});
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'warn',
			'[GroupChatInput] Invalid file type rejected: text/plain',
			undefined,
			undefined
		);
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'warn',
			'[GroupChatInput] File too large rejected: 11.00MB (max: 10MB)',
			undefined,
			undefined
		);
	});

	it('trims text paste, delegates image paste and drops, and supports Enter-to-send mode', () => {
		const onSend = vi.fn();
		const onDraftChange = vi.fn();
		const handlePaste = vi.fn();
		const handleDrop = vi.fn();

		render(
			<GroupChatInput
				{...baseProps({
					onSend,
					onDraftChange,
					handlePaste,
					handleDrop,
					onOpenPromptComposer: vi.fn(),
					shortcuts: {
						openPromptComposer: {
							id: 'openPromptComposer',
							label: 'Open Prompt Composer',
							keys: ['Meta', 'P'],
						},
					},
				})}
			/>
		);

		const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
		fireEvent.change(textarea, { target: { value: 'prefix ' } });
		textarea.setSelectionRange(textarea.value.length, textarea.value.length);
		fireEvent.paste(textarea, {
			clipboardData: {
				items: [],
				getData: () => '  pasted text  ',
			},
		});
		expect(textarea).toHaveValue('prefix pasted text');
		expect(onDraftChange).toHaveBeenLastCalledWith('prefix pasted text');

		fireEvent.paste(textarea, {
			clipboardData: {
				items: [{ type: 'image/png' }],
				getData: () => '',
			},
		});
		expect(handlePaste).toHaveBeenCalledTimes(1);

		fireEvent.drop(textarea, { dataTransfer: { files: [] } });
		expect(handleDrop).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByTitle('Switch to Enter to send'));
		expect(screen.getByTitle('Switch to Ctrl+Enter to send')).toBeInTheDocument();

		fireEvent.change(textarea, { target: { value: 'send with enter' } });
		fireEvent.keyDown(textarea, { key: 'Enter' });
		expect(onSend).toHaveBeenCalledWith('send with enter', undefined, false);
	});

	it('renders and manages the execution queue embedded above the input', async () => {
		const onRemoveQueuedItem = vi.fn();
		const onReorderQueuedItems = vi.fn();
		const longMessage = `${'Queued message '.repeat(20)}final line`;
		const executionQueue: QueuedItem[] = [
			{
				id: 'queue-1',
				timestamp: 1,
				tabId: 'tab-1',
				type: 'message',
				text: longMessage,
				images: ['data:image/png;base64,one'],
			},
			{
				id: 'queue-2',
				timestamp: 2,
				tabId: 'tab-1',
				type: 'command',
				command: '/review',
			},
		];

		render(
			<LayerStackProvider>
				<GroupChatInput
					{...baseProps({
						executionQueue,
						onRemoveQueuedItem,
						onReorderQueuedItems,
					})}
				/>
			</LayerStackProvider>
		);

		expect(screen.getByText('QUEUED (2)')).toBeInTheDocument();
		expect(screen.getByText('/review')).toBeInTheDocument();
		expect(screen.getByText('1 image attached')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Show all/ }));
		expect(screen.getByText(longMessage)).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: /Show less/ }));
		expect(screen.queryByText(longMessage)).not.toBeInTheDocument();

		const firstQueuedItem = screen.getByText((content) =>
			content.startsWith('Queued message Queued message')
		);
		const secondQueuedItem = screen.getByText('/review');
		fireEvent.mouseDown(firstQueuedItem, { button: 0 });
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 170));
		});
		fireEvent.mouseMove(secondQueuedItem, { clientY: 1 });
		fireEvent.mouseUp(firstQueuedItem);
		expect(onReorderQueuedItems).toHaveBeenCalledWith(0, 1);

		fireEvent.click(screen.getAllByTitle('Remove from queue')[0]);
		expect(screen.getByRole('heading', { name: 'Remove Queued Message?' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Remove' }));
		expect(onRemoveQueuedItem).toHaveBeenCalledWith('queue-1');
	});

	it('navigates mentions, inserts agents, scrolls selection, and syncs external drafts', async () => {
		const originalScrollIntoView = Element.prototype.scrollIntoView;
		const scrollIntoView = vi.fn();
		Element.prototype.scrollIntoView = scrollIntoView;
		const onDraftChange = vi.fn();
		const sessions = [
			session('builder-1', 'Builder One', 'group-1'),
			session('reviewer-1', 'Reviewer One', 'group-1'),
			session('solo-1', 'Solo'),
			session('terminal-1', 'Terminal', 'group-1', 'terminal'),
			session('terminal-2', 'Terminal Only', 'terminal-only', 'terminal'),
		];

		try {
			const { rerender } = render(
				<GroupChatInput
					{...baseProps({
						draftMessage: 'initial draft',
						groups: [group('group-1', 'Platform Team'), group('terminal-only', 'Ops')],
						onDraftChange,
						sessions,
					})}
				/>
			);
			const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
			expect(textarea).toHaveValue('initial draft');

			rerender(
				<GroupChatInput
					{...baseProps({
						draftMessage: 'next draft',
						groupChatId: 'group-chat-2',
						groups: [group('group-1', 'Platform Team'), group('terminal-only', 'Ops')],
						onDraftChange,
						sessions,
					})}
				/>
			);
			expect(textarea).toHaveValue('next draft');

			rerender(
				<GroupChatInput
					{...baseProps({
						draftMessage: undefined,
						groupChatId: 'group-chat-3',
						groups: [group('group-1', 'Platform Team'), group('terminal-only', 'Ops')],
						onDraftChange,
						sessions,
					})}
				/>
			);
			expect(textarea).toHaveValue('');

			rerender(
				<GroupChatInput
					{...baseProps({
						draftMessage: 'external draft',
						groupChatId: 'group-chat-3',
						groups: [group('group-1', 'Platform Team'), group('terminal-only', 'Ops')],
						onDraftChange,
						sessions,
					})}
				/>
			);
			expect(textarea).toHaveValue('external draft');

			fireEvent.change(textarea, { target: { value: 'Ask @' } });
			expect(screen.getByText('@Platform-Team')).toBeInTheDocument();
			await act(async () => {
				await new Promise(requestAnimationFrame);
			});
			expect(scrollIntoView).toHaveBeenCalled();

			fireEvent.keyDown(textarea, { key: 'ArrowUp' });
			fireEvent.keyDown(textarea, { key: 'ArrowDown' });
			fireEvent.keyDown(textarea, { key: 'ArrowDown' });
			fireEvent.keyDown(textarea, { key: 'ArrowDown' });
			fireEvent.keyDown(textarea, { key: 'ArrowDown' });
			fireEvent.keyDown(textarea, { key: 'ArrowUp' });
			fireEvent.keyDown(textarea, { key: 'ArrowUp' });
			fireEvent.keyDown(textarea, { key: 'a' });
			fireEvent.keyDown(textarea, { key: 'Escape' });
			expect(screen.queryByText('@Platform-Team')).not.toBeInTheDocument();

			fireEvent.change(textarea, { target: { value: 'Ask @platform-team' } });
			expect(screen.getByText('@Platform-Team')).toBeInTheDocument();
			fireEvent.keyDown(textarea, { key: 'Tab' });
			expect(textarea.value).toContain('@Builder-One @Reviewer-One');

			fireEvent.change(textarea, { target: { value: 'Ask @builder' } });
			expect(screen.getByText('(Builder One)')).toBeInTheDocument();
			fireEvent.click(screen.getByText('@Builder-One'));
			expect(textarea.value).toBe('Ask @Builder-One ');

			fireEvent.change(textarea, { target: { value: 'Ask @solo' } });
			expect(screen.getByText('@Solo')).toBeInTheDocument();
			expect(screen.queryByText('(Solo)')).not.toBeInTheDocument();
		} finally {
			Element.prototype.scrollIntoView = originalScrollIntoView;
		}
	});

	it('covers send shortcuts, empty sends, staged-image send, and image removal', async () => {
		const onSend = vi.fn();
		const onOpenLightbox = vi.fn();
		const { rerender } = render(<ImageHarness onOpenLightbox={onOpenLightbox} onSend={onSend} />);

		let textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
		fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
		expect(onSend).not.toHaveBeenCalled();

		const input = document.getElementById('group-chat-image-input') as HTMLInputElement;
		fireEvent.change(input, {
			target: { files: [new File(['png'], 'capture.png', { type: 'image/png' })] },
		});
		expect(await screen.findByAltText('Staged image')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: '×' }));
		expect(screen.queryByAltText('Staged image')).not.toBeInTheDocument();

		fireEvent.change(input, {
			target: { files: [new File(['png'], 'capture-2.png', { type: 'image/png' })] },
		});
		expect(await screen.findByAltText('Staged image')).toBeInTheDocument();
		fireEvent.change(textarea, { target: { value: 'send image' } });
		fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
		await waitFor(() =>
			expect(onSend).toHaveBeenCalledWith(
				'send image',
				[expect.stringMatching(/^data:image\/png;base64,/)],
				false
			)
		);

		const setEnterToSendAI = vi.fn();
		rerender(
			<GroupChatInput
				{...baseProps({
					enterToSendAI: true,
					onSend,
					setEnterToSendAI,
				})}
			/>
		);
		textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
		fireEvent.change(textarea, { target: { value: 'cmd enter ignored' } });
		fireEvent.keyDown(textarea, { key: 'Enter', metaKey: true });
		expect(onSend).toHaveBeenCalledTimes(1);
		fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
		expect(onSend).toHaveBeenCalledTimes(1);

		fireEvent.keyDown(textarea, { key: 'k', metaKey: true });
		expect(onSend).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByText('Read-Only').closest('button')!);
		expect(screen.getByText('Read-Only')).toBeInTheDocument();
		fireEvent.click(screen.getByTitle('Switch to Ctrl+Enter to send'));
		expect(setEnterToSendAI).toHaveBeenCalledWith(false);
	});

	it('covers paste fallbacks, prompt composer fallback title, and empty file-reader results', async () => {
		const onOpenPromptComposer = vi.fn();
		const onDraftChange = vi.fn();
		const handlePaste = vi.fn();
		const handleDrop = vi.fn();
		const originalFileReader = globalThis.FileReader;
		const { rerender } = render(
			<GroupChatInput
				{...baseProps({
					handleDrop,
					handlePaste,
					onDraftChange,
					onOpenPromptComposer,
				})}
			/>
		);

		const composerButton = screen.getByTitle('Open Prompt Composer');
		fireEvent.click(composerButton);
		expect(onOpenPromptComposer).toHaveBeenCalled();

		const imageInput = document.getElementById('group-chat-image-input') as HTMLInputElement;
		const inputClick = vi.spyOn(imageInput, 'click').mockImplementation(() => undefined);
		fireEvent.click(screen.getByTitle('Attach Image'));
		expect(inputClick).toHaveBeenCalled();

		const textarea = screen.getByPlaceholderText(/Type a message/i) as HTMLTextAreaElement;
		fireEvent.paste(textarea, {
			clipboardData: {
				items: [],
				getData: () => '',
			},
		});
		fireEvent.paste(textarea, {
			clipboardData: {
				items: [],
				getData: () => 'plain',
			},
		});
		expect(onDraftChange).not.toHaveBeenCalledWith('plain');

		fireEvent.change(textarea, { target: { value: 'prefix' } });
		let selectionStart: number | null = null;
		let selectionEnd: number | null = null;
		Object.defineProperty(textarea, 'selectionStart', {
			configurable: true,
			get: () => selectionStart,
			set: (value) => {
				selectionStart = value;
			},
		});
		Object.defineProperty(textarea, 'selectionEnd', {
			configurable: true,
			get: () => selectionEnd,
			set: (value) => {
				selectionEnd = value;
			},
		});
		fireEvent.paste(textarea, {
			clipboardData: {
				items: [],
				getData: () => '  pasted  ',
			},
		});
		expect(textarea).toHaveValue('pastedprefix');
		await act(async () => {
			await new Promise(requestAnimationFrame);
		});
		expect(selectionStart).toBe('pasted'.length);
		expect(selectionEnd).toBe('pasted'.length);

		fireEvent.change(imageInput, { target: { files: null } });

		class EmptyResultReader {
			onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
			readAsDataURL() {
				this.onload?.({ target: { result: '' } } as unknown as ProgressEvent<FileReader>);
			}
		}
		vi.stubGlobal('FileReader', EmptyResultReader);
		fireEvent.change(imageInput, {
			target: { files: [new File(['png'], 'empty.png', { type: 'image/png' })] },
		});
		await waitFor(() => expect(screen.queryByAltText('Staged image')).not.toBeInTheDocument());
		vi.stubGlobal('FileReader', originalFileReader);

		rerender(
			<GroupChatInput
				{...baseProps({
					handleDrop,
					handlePaste,
				})}
			/>
		);
		const dropTextarea = screen.getByPlaceholderText(/Type a message/i);
		fireEvent.dragOver(dropTextarea);
		fireEvent.drop(dropTextarea, { dataTransfer: { files: [] } });
		expect(handleDrop).toHaveBeenCalled();
	});
});
