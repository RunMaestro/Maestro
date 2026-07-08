import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React, { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PromptComposerModal } from '../../renderer/components/PromptComposerModal';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { Group, Session, Theme, ThinkingMode } from '../../renderer/types';

const theme: Theme = {
	id: 'integration-dark',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#101114',
		bgSidebar: '#20242b',
		bgActivity: '#181b20',
		border: '#3f3f46',
		textMain: '#f4f4f5',
		textDim: '#a1a1aa',
		accent: '#4f8cff',
		accentDim: '#1d4ed8',
		accentText: '#4f8cff',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const sessions: Session[] = [
	{ id: 's-ada', name: 'Ada Dev', groupId: 'core', toolType: 'codex' },
	{ id: 's-grace', name: 'Grace Hopper', groupId: 'core', toolType: 'claude-code' },
	{ id: 's-terminal', name: 'Terminal', groupId: 'core', toolType: 'terminal' },
] as Session[];

const groups: Group[] = [{ id: 'core', name: 'Core Team', emoji: 'CT', collapsed: false }];

interface HarnessProps {
	initialValue?: string;
	isOpen?: boolean;
	initialImages?: string[];
	withImageSetter?: boolean;
	supportsThinking?: boolean;
	initialThinking?: ThinkingMode;
	enterToSend?: boolean;
	composerSessions?: Session[] | null;
	composerGroups?: Group[] | null;
	tabSaveToHistory?: boolean;
	tabReadOnlyMode?: boolean;
	disableLightbox?: boolean;
	composerAgentId?: string | null;
	onClose?: ReturnType<typeof vi.fn>;
	onSubmit?: ReturnType<typeof vi.fn>;
	onSend?: ReturnType<typeof vi.fn>;
	onImageAttachBlocked?: ReturnType<typeof vi.fn>;
	onOpenLightbox?: ReturnType<typeof vi.fn>;
	onToggleTabSaveToHistory?: ReturnType<typeof vi.fn>;
	onToggleTabReadOnlyMode?: ReturnType<typeof vi.fn>;
	onToggleTabShowThinking?: ReturnType<typeof vi.fn>;
	onToggleEnterToSend?: ReturnType<typeof vi.fn>;
}

function PromptComposerHarness({
	initialValue = 'Draft prompt',
	isOpen = true,
	initialImages = [],
	withImageSetter = true,
	supportsThinking = true,
	initialThinking = 'off',
	enterToSend = false,
	composerSessions,
	composerGroups,
	tabSaveToHistory = true,
	tabReadOnlyMode = true,
	disableLightbox = false,
	composerAgentId,
	onClose = vi.fn(),
	onSubmit = vi.fn(),
	onSend = vi.fn(),
	onImageAttachBlocked = vi.fn(),
	onOpenLightbox = vi.fn(),
	onToggleTabSaveToHistory = vi.fn(),
	onToggleTabReadOnlyMode = vi.fn(),
	onToggleTabShowThinking = vi.fn(),
	onToggleEnterToSend = vi.fn(),
}: HarnessProps) {
	const [stagedImages, setStagedImages] = useState(initialImages);
	const [thinking, setThinking] = useState<ThinkingMode>(initialThinking);

	return (
		<LayerStackProvider>
			<PromptComposerModal
				isOpen={isOpen}
				onClose={onClose}
				theme={theme}
				initialValue={initialValue}
				onSubmit={onSubmit}
				onSend={onSend}
				sessionName="Codex"
				stagedImages={stagedImages}
				setStagedImages={withImageSetter ? setStagedImages : undefined}
				onImageAttachBlocked={onImageAttachBlocked}
				onOpenLightbox={disableLightbox ? undefined : onOpenLightbox}
				tabSaveToHistory={tabSaveToHistory}
				onToggleTabSaveToHistory={onToggleTabSaveToHistory}
				tabReadOnlyMode={tabReadOnlyMode}
				onToggleTabReadOnlyMode={onToggleTabReadOnlyMode}
				agentId={composerAgentId === undefined ? 'codex' : (composerAgentId ?? undefined)}
				tabShowThinking={thinking}
				onToggleTabShowThinking={() => {
					onToggleTabShowThinking();
					setThinking((current) =>
						current === 'off' ? 'on' : current === 'on' ? 'sticky' : 'off'
					);
				}}
				supportsThinking={supportsThinking}
				enterToSend={enterToSend}
				onToggleEnterToSend={onToggleEnterToSend}
				sessions={composerSessions === undefined ? sessions : (composerSessions ?? undefined)}
				groups={composerGroups === undefined ? groups : (composerGroups ?? undefined)}
			/>
		</LayerStackProvider>
	);
}

function renderComposer(props: HarnessProps = {}) {
	return render(<PromptComposerHarness {...props} />);
}

function textarea() {
	return screen.getByPlaceholderText(/write your prompt/i) as HTMLTextAreaElement;
}

let fileReadCount = 0;

class MockFileReader {
	onload: ((event: ProgressEvent<FileReader>) => void) | null = null;

	readAsDataURL(file: Blob) {
		fileReadCount += 1;
		this.onload?.({
			target: { result: `data:${file.type || 'image/png'};base64,ZmFrZQ${fileReadCount}=` },
		} as ProgressEvent<FileReader>);
	}
}

describe('PromptComposerModal integration', () => {
	const originalFileReader = globalThis.FileReader;
	const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
	const originalScrollIntoView = Element.prototype.scrollIntoView;

	beforeEach(() => {
		fileReadCount = 0;
		globalThis.FileReader = MockFileReader as unknown as typeof FileReader;
		globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
			callback(0);
			return 0;
		};
		Element.prototype.scrollIntoView = vi.fn();
	});

	afterEach(() => {
		globalThis.FileReader = originalFileReader;
		globalThis.requestAnimationFrame = originalRequestAnimationFrame;
		Element.prototype.scrollIntoView = originalScrollIntoView;
		vi.restoreAllMocks();
		cleanup();
	});

	it('renders null when closed and saves the current draft on close paths', async () => {
		const closed = renderComposer({ isOpen: false });
		expect(screen.queryByText('Prompt Composer')).not.toBeInTheDocument();
		closed.unmount();

		const onClose = vi.fn();
		const onSubmit = vi.fn();
		renderComposer({ initialValue: 'Initial draft', onClose, onSubmit });

		expect(textarea()).toHaveValue('Initial draft');
		fireEvent.change(textarea(), { target: { value: 'Edited draft' } });
		fireEvent.click(screen.getByTitle('Close (Escape)'));
		expect(onSubmit).toHaveBeenCalledWith('Edited draft');
		expect(onClose).toHaveBeenCalledTimes(1);

		cleanup();
		onClose.mockClear();
		onSubmit.mockClear();
		renderComposer({ initialValue: 'Backdrop draft', onClose, onSubmit });
		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
		expect(onSubmit).toHaveBeenCalledWith('Backdrop draft');
	});

	it('sends non-empty prompts and routes footer and keyboard toggles', () => {
		const onClose = vi.fn();
		const onSend = vi.fn();
		const onToggleTabSaveToHistory = vi.fn();
		const onToggleTabReadOnlyMode = vi.fn();
		const onToggleTabShowThinking = vi.fn();
		const onToggleEnterToSend = vi.fn();

		renderComposer({
			initialValue: 'Ship this',
			onClose,
			onSend,
			onToggleTabSaveToHistory,
			onToggleTabReadOnlyMode,
			onToggleTabShowThinking,
			onToggleEnterToSend,
		});

		fireEvent.keyDown(textarea(), { key: 's', metaKey: true });
		fireEvent.keyDown(textarea(), { key: 'r', ctrlKey: true });
		expect(onToggleTabSaveToHistory).toHaveBeenCalledTimes(1);
		expect(onToggleTabReadOnlyMode).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: /thinking/i }));
		expect(onToggleTabShowThinking).toHaveBeenCalledTimes(1);
		expect(screen.getByRole('button', { name: /thinking/i })).toHaveStyle({
			color: theme.colors.accentText,
		});

		fireEvent.click(screen.getByRole('button', { name: /enter/i }));
		expect(onToggleEnterToSend).toHaveBeenCalledTimes(1);

		fireEvent.keyDown(textarea(), { key: 'Enter', metaKey: true });
		expect(onSend).toHaveBeenCalledWith('Ship this');
		expect(onClose).toHaveBeenCalledTimes(1);

		cleanup();
		renderComposer({ initialValue: '   ', onSend, onClose });
		fireEvent.click(screen.getByRole('button', { name: /send/i }));
		expect(onSend).toHaveBeenCalledTimes(1);
	});

	it('handles mention filtering, keyboard navigation, group insertion, and Escape precedence', async () => {
		const onClose = vi.fn();
		const onSubmit = vi.fn();
		renderComposer({ initialValue: '', onClose, onSubmit });

		fireEvent.change(textarea(), { target: { value: '@' } });
		expect(screen.getByText('@Core-Team')).toBeInTheDocument();
		expect(screen.getByText('@Ada-Dev')).toBeInTheDocument();
		expect(screen.queryByText('@Terminal')).not.toBeInTheDocument();

		fireEvent.keyDown(textarea(), { key: 'ArrowDown' });
		fireEvent.keyDown(textarea(), { key: 'ArrowUp' });
		fireEvent.change(textarea(), { target: { value: '@core' } });
		fireEvent.keyDown(textarea(), { key: 'Enter' });

		expect(textarea()).toHaveValue('@Ada-Dev @Grace-Hopper ');
		expect(onSubmit).toHaveBeenCalledWith('@Ada-Dev @Grace-Hopper ');

		fireEvent.change(textarea(), { target: { value: '@Ada' } });
		expect(screen.getByText('@Ada-Dev')).toBeInTheDocument();
		fireEvent.keyDown(window, { key: 'Escape' });
		expect(screen.queryByText('@Ada-Dev')).not.toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();

		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
	});

	it('trims text paste, inserts tab characters, and handles staged image shortcuts', () => {
		const onOpenLightbox = vi.fn();
		renderComposer({
			initialValue: 'abc',
			initialImages: ['data:image/png;base64,one', 'data:image/png;base64,two'],
			onOpenLightbox,
		});

		const input = textarea();
		input.selectionStart = 1;
		input.selectionEnd = 2;
		fireEvent.paste(input, {
			clipboardData: {
				items: [],
				getData: () => '  pasted text  ',
			},
		});
		expect(input).toHaveValue('apasted textc');

		input.selectionStart = 1;
		input.selectionEnd = 1;
		fireEvent.keyDown(input, { key: 'Tab' });
		expect(input.value).toContain('\t');

		fireEvent.keyDown(input, { key: 'l', metaKey: true, shiftKey: true });
		expect(onOpenLightbox).toHaveBeenCalledWith(
			'data:image/png;base64,one',
			['data:image/png;base64,one', 'data:image/png;base64,two'],
			'staged'
		);

		fireEvent.click(screen.getByAltText('Prompt composer staged image 2'));
		expect(onOpenLightbox).toHaveBeenLastCalledWith(
			'data:image/png;base64,two',
			['data:image/png;base64,one', 'data:image/png;base64,two'],
			'staged'
		);

		fireEvent.keyDown(screen.getByAltText('Prompt composer staged image 1'), { key: 'Enter' });
		expect(onOpenLightbox).toHaveBeenLastCalledWith(
			'data:image/png;base64,one',
			['data:image/png;base64,one', 'data:image/png;base64,two'],
			'staged'
		);
		fireEvent.keyDown(screen.getByAltText('Prompt composer staged image 1'), { key: ' ' });
		expect(onOpenLightbox).toHaveBeenLastCalledWith(
			'data:image/png;base64,one',
			['data:image/png;base64,one', 'data:image/png;base64,two'],
			'staged'
		);
		const lightboxCallsBeforeIgnoredKey = onOpenLightbox.mock.calls.length;
		fireEvent.keyDown(screen.getByAltText('Prompt composer staged image 1'), { key: 'x' });
		expect(onOpenLightbox).toHaveBeenCalledTimes(lightboxCallsBeforeIgnoredKey);

		fireEvent.click(screen.getAllByTestId('x-icon').at(-1)!.closest('button')!);
		expect(screen.queryByAltText('Prompt composer staged image 2')).not.toBeInTheDocument();
	});

	it('handles no-mention mode, inactive footer toggles, and empty sends', () => {
		const onSend = vi.fn();
		const onToggleTabSaveToHistory = vi.fn();
		const onToggleTabReadOnlyMode = vi.fn();
		renderComposer({
			initialValue: '',
			composerSessions: null,
			composerGroups: null,
			tabSaveToHistory: false,
			tabReadOnlyMode: false,
			initialThinking: 'sticky',
			composerAgentId: null,
			onSend,
			onToggleTabSaveToHistory,
			onToggleTabReadOnlyMode,
		});

		expect(textarea()).toBeInTheDocument();
		fireEvent.change(textarea(), { target: { value: '@' } });
		expect(screen.queryByText('@Ada-Dev')).not.toBeInTheDocument();

		fireEvent.change(textarea(), { target: { value: '   ' } });
		fireEvent.keyDown(textarea(), { key: 'Enter', metaKey: true });
		expect(onSend).not.toHaveBeenCalled();

		fireEvent.click(screen.getByRole('button', { name: /history/i }));
		fireEvent.click(screen.getByRole('button', { name: /read-only/i }));
		expect(onToggleTabSaveToHistory).toHaveBeenCalledTimes(1);
		expect(onToggleTabReadOnlyMode).toHaveBeenCalledTimes(1);
		expect(screen.getByRole('button', { name: /read-only/i })).toHaveAttribute(
			'title',
			"Toggle Read-Only mode (agent won't modify files)"
		);
		expect(screen.getByRole('button', { name: /thinking/i })).toHaveTextContent('Thinking');

		fireEvent.keyDown(textarea(), { key: 'l', ctrlKey: true, shiftKey: true });
		fireEvent.keyDown(textarea(), { key: 's', ctrlKey: true });
		expect(onToggleTabSaveToHistory).toHaveBeenCalledTimes(2);
	});

	it('handles mention clicks, empty filters, and navigation wrapping', () => {
		const onSubmit = vi.fn();
		renderComposer({
			initialValue: '',
			onSubmit,
			composerGroups: [
				...groups,
				{ id: 'empty', name: 'Empty Group', emoji: 'EG', collapsed: false },
			],
		});

		fireEvent.change(textarea(), { target: { value: '@zzz' } });
		expect(screen.queryByText('@Ada-Dev')).not.toBeInTheDocument();

		fireEvent.change(textarea(), { target: { value: '@Ada Dev' } });
		expect(screen.queryByText('@Ada-Dev')).not.toBeInTheDocument();

		fireEvent.change(textarea(), { target: { value: '@' } });
		fireEvent.keyDown(textarea(), { key: 'ArrowUp' });
		fireEvent.keyDown(textarea(), { key: 'ArrowDown' });
		fireEvent.keyDown(textarea(), { key: 'Enter', shiftKey: true });
		expect(textarea()).toHaveValue('@');

		fireEvent.change(textarea(), { target: { value: '@Ada' } });
		fireEvent.click(screen.getByText('@Ada-Dev'));
		expect(textarea()).toHaveValue('@Ada-Dev ');
		expect(onSubmit).toHaveBeenCalledWith('@Ada-Dev ');
	});

	it('builds mentions when groups are omitted', () => {
		renderComposer({
			initialValue: '',
			composerGroups: null,
		});

		fireEvent.change(textarea(), { target: { value: '@Gra' } });
		expect(screen.getByText('@Grace-Hopper')).toBeInTheDocument();
		expect(screen.queryByText('@Core-Team')).not.toBeInTheDocument();
	});

	it('routes backdrop, hidden close button, and attachment button clicks', () => {
		const onClose = vi.fn();
		const onSubmit = vi.fn();
		const inputClick = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(() => {});
		const first = renderComposer({ initialValue: 'Backdrop save', onClose, onSubmit });

		fireEvent.click(screen.getByTitle('Attach Image'));
		expect(inputClick).toHaveBeenCalledTimes(1);

		fireEvent.click(first.container.firstElementChild!);
		expect(onSubmit).toHaveBeenCalledWith('Backdrop save');
		expect(onClose).toHaveBeenCalledTimes(1);

		cleanup();
		onClose.mockClear();
		onSubmit.mockClear();
		renderComposer({ initialValue: 'Button save', onClose, onSubmit });
		fireEvent.click(screen.getByLabelText('Close prompt composer'));
		expect(onSubmit).toHaveBeenCalledWith('Button save');
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('allows default paste paths and ignores unusable image data', async () => {
		renderComposer({ initialValue: 'abc', initialImages: [] });
		const input = textarea();
		input.selectionStart = 1;
		input.selectionEnd = 1;

		fireEvent.paste(input, {
			clipboardData: {
				items: [],
				getData: () => 'trimmed',
			},
		});
		expect(input).toHaveValue('abc');

		fireEvent.paste(input, {
			clipboardData: {
				items: [],
				getData: () => '',
			},
		});
		expect(input).toHaveValue('abc');

		fireEvent.paste(input, {
			clipboardData: {
				items: [{ type: 'image/png', getAsFile: () => null }],
				getData: () => '',
			},
		});
		expect(screen.queryByAltText('Prompt composer staged image 1')).not.toBeInTheDocument();

		const OriginalReader = globalThis.FileReader;
		class EmptyResultFileReader {
			onload: ((event: ProgressEvent<FileReader>) => void) | null = null;

			readAsDataURL() {
				this.onload?.({ target: { result: '' } } as ProgressEvent<FileReader>);
			}
		}
		globalThis.FileReader = EmptyResultFileReader as unknown as typeof FileReader;

		const image = new File(['image'], 'image.png', { type: 'image/png' });
		fireEvent.paste(input, {
			clipboardData: {
				items: [
					{ type: 'text/plain', getAsFile: () => null },
					{ type: 'image/png', getAsFile: () => image },
				],
				getData: () => '',
			},
		});
		const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
		await act(async () => {
			fireEvent.change(fileInput, { target: { files: null } });
			fireEvent.change(fileInput, { target: { files: [image] } });
		});
		expect(screen.queryByAltText('Prompt composer staged image 1')).not.toBeInTheDocument();
		globalThis.FileReader = OriginalReader;
	});

	it('loads pasted and selected image files, and blocks image paste without an image setter', async () => {
		renderComposer({ initialValue: '', initialImages: [] });
		const image = new File(['image'], 'image.png', { type: 'image/png' });

		fireEvent.paste(textarea(), {
			clipboardData: {
				items: [{ type: 'image/png', getAsFile: () => image }],
				getData: () => '',
			},
		});
		expect(await screen.findByAltText('Prompt composer staged image 1')).toBeInTheDocument();

		const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
		await act(async () => {
			fireEvent.change(fileInput, { target: { files: [image] } });
		});
		expect(screen.getByAltText('Prompt composer staged image 2')).toBeInTheDocument();
		expect(fileInput.value).toBe('');

		cleanup();
		const onImageAttachBlocked = vi.fn();
		renderComposer({
			initialValue: '',
			withImageSetter: false,
			onImageAttachBlocked,
		});
		fireEvent.paste(textarea(), {
			clipboardData: {
				items: [{ type: 'image/png', getAsFile: () => image }],
				getData: () => '',
			},
		});
		expect(onImageAttachBlocked).toHaveBeenCalledTimes(1);
	});
});
