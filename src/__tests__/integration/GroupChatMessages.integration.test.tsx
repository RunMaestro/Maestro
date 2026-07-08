import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, createEvent, fireEvent, render, screen } from '@testing-library/react';
import {
	GroupChatMessages,
	type GroupChatMessagesHandle,
} from '../../renderer/components/GroupChatMessages';
import type {
	GroupChatMessage,
	GroupChatParticipant,
	GroupChatState,
	Theme,
} from '../../renderer/types';
import { useMessageGistStore } from '../../renderer/stores/messageGistStore';

const mocks = vi.hoisted(() => ({
	safeClipboardWrite: vi.fn(),
}));

vi.mock('../../renderer/components/MarkdownRenderer', () => ({
	MarkdownRenderer: ({ content, onCopy }: { content: string; onCopy?: (text: string) => void }) => (
		<div data-testid="markdown-renderer">
			<span>{content}</span>
			<button type="button" onClick={() => onCopy?.(content)}>
				Copy rendered markdown
			</button>
		</div>
	),
}));

vi.mock('../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: mocks.safeClipboardWrite,
}));

vi.mock('../../renderer/utils/markdownConfig', async () => {
	const actual = await vi.importActual<typeof import('../../renderer/utils/markdownConfig')>(
		'../../renderer/utils/markdownConfig'
	);
	return {
		...actual,
		generateTerminalProseStyles: vi.fn(() => '.group-chat-messages { color: inherit; }'),
	};
});

vi.mock('../../renderer/utils/shortcutFormatter', () => ({
	formatShortcutKeys: (keys: string[]) => keys.join('+'),
}));

vi.mock('lucide-react', () => {
	const Icon = ({ className, style }: { className?: string; style?: React.CSSProperties }) => (
		<svg data-testid="icon" className={className} style={style} />
	);
	return {
		ArrowUp: Icon,
		Eye: Icon,
		FileText: Icon,
		Copy: Icon,
		ChevronDown: Icon,
		ChevronUp: Icon,
		Share2: Icon,
	};
});

const theme: Theme = {
	id: 'test',
	name: 'Test',
	mode: 'dark',
	colors: {
		bgMain: '#101010',
		bgSidebar: '#151515',
		bgActivity: '#202020',
		textMain: '#f5f5f5',
		textDim: '#999999',
		accent: '#3b82f6',
		accentDim: '#1d4ed8',
		accentText: '#ffffff',
		accentForeground: '#000000',
		border: '#333333',
		error: '#ef4444',
		warning: '#f59e0b',
		success: '#22c55e',
	},
};

const participants: GroupChatParticipant[] = [
	{
		name: 'Alice',
		agentId: 'codex',
		sessionId: 'alice-session',
		addedAt: 1700000000000,
	},
];

function createMessage(overrides: Partial<GroupChatMessage> = {}): GroupChatMessage {
	return {
		timestamp: '2026-05-13T12:00:00.000Z',
		from: 'moderator',
		content: 'Hello from **moderator**',
		...overrides,
	};
}

function renderMessages(
	props: Partial<React.ComponentProps<typeof GroupChatMessages>> = {},
	ref?: React.Ref<GroupChatMessagesHandle>
) {
	return render(
		<GroupChatMessages
			ref={ref}
			theme={theme}
			messages={[]}
			participants={participants}
			state="idle"
			{...props}
		/>
	);
}

describe('GroupChatMessages', () => {
	const originalScrollIntoView = Element.prototype.scrollIntoView;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-13T12:30:00.000Z'));
		Element.prototype.scrollIntoView = vi.fn();
		mocks.safeClipboardWrite.mockResolvedValue(true);
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		Element.prototype.scrollIntoView = originalScrollIntoView;
		useMessageGistStore.getState().clearAll();
	});

	it('renders empty state and typing indicators for active group chat states', () => {
		const { rerender } = renderMessages({ state: 'idle' });

		expect(screen.getByText('Beta')).toBeInTheDocument();
		expect(screen.getByText(/Messages you send go directly to the/)).toBeInTheDocument();
		expect(screen.queryByText('Moderator is thinking...')).not.toBeInTheDocument();

		rerender(
			<GroupChatMessages
				theme={theme}
				messages={[]}
				participants={participants}
				state={'moderator-thinking' satisfies GroupChatState}
			/>
		);
		expect(screen.getByText('Moderator is thinking...')).toBeInTheDocument();

		rerender(
			<GroupChatMessages
				theme={theme}
				messages={[]}
				participants={participants}
				state={'agent-working' satisfies GroupChatState}
			/>
		);
		expect(screen.getByText('Agent is working...')).toBeInTheDocument();
	});

	it('renders sender labels, markdown, raw text mode, actions, and copy callbacks', async () => {
		const onToggleMarkdownEditMode = vi.fn();
		renderMessages({
			markdownEditMode: false,
			onToggleMarkdownEditMode,
			participantColors: { Moderator: '#ff00ff', Alice: '#00ffff' },
			messages: [
				createMessage({ from: 'user', content: 'User request' }),
				createMessage({ from: 'moderator', content: 'Moderator **reply**' }),
				createMessage({ from: 'system', content: 'System notice' }),
				createMessage({ from: 'Alice', content: 'Agent response' }),
				createMessage({
					timestamp: '2026-05-12T09:15:00.000Z',
					from: 'Alice',
					content: 'Old response',
				}),
			],
		});

		expect(screen.getByText('User request')).toBeInTheDocument();
		expect(screen.getByText('Moderator')).toBeInTheDocument();
		expect(screen.getByText('System')).toBeInTheDocument();
		expect(screen.getAllByText('Alice')).toHaveLength(2);
		expect(screen.getByText('2026-05-12')).toBeInTheDocument();
		expect(screen.getAllByTestId('markdown-renderer').length).toBeGreaterThanOrEqual(4);

		fireEvent.click(screen.getAllByTitle('Show plain text (Meta+e)')[0]);
		expect(onToggleMarkdownEditMode).toHaveBeenCalledOnce();

		fireEvent.click(screen.getAllByTitle('Copy to clipboard')[1]);
		expect(mocks.safeClipboardWrite).toHaveBeenCalledWith('Moderator **reply**');

		fireEvent.click(screen.getAllByText('Copy rendered markdown')[1]);
		expect(mocks.safeClipboardWrite).toHaveBeenCalledWith('Moderator **reply**');
	});

	it('renders non-user messages as stripped plain text in markdown edit mode', () => {
		const onToggleMarkdownEditMode = vi.fn();
		renderMessages({
			markdownEditMode: true,
			onToggleMarkdownEditMode,
			messages: [createMessage({ content: '**Bold** _plain_ [link](https://example.com)' })],
		});

		expect(screen.queryByTestId('markdown-renderer')).not.toBeInTheDocument();
		expect(screen.getByText('Bold plain link')).toBeInTheDocument();

		fireEvent.click(screen.getByTitle('Show formatted (Meta+e)'));
		expect(onToggleMarkdownEditMode).toHaveBeenCalledOnce();
	});

	it('collapses long non-user output and toggles expanded content', () => {
		renderMessages({
			maxOutputLines: 2,
			messages: [
				createMessage({
					content: ['line one', 'line two', 'line three', 'line four'].join('\n'),
				}),
			],
		});

		expect(screen.getByText('line one', { exact: false })).toBeInTheDocument();
		expect(screen.queryByText('line four', { exact: false })).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Show all 4 lines' }));
		expect(screen.getByText('line four', { exact: false })).toBeInTheDocument();

		const expandedContainer = screen
			.getByText('line four', { exact: false })
			.closest('.overflow-auto')!;
		Object.defineProperties(expandedContainer, {
			scrollTop: { configurable: true, value: 10 },
			scrollHeight: { configurable: true, value: 100 },
			clientHeight: { configurable: true, value: 30 },
		});
		const wheelEvent = createEvent.wheel(expandedContainer, { deltaY: -1 });
		const stopPropagation = vi.spyOn(wheelEvent, 'stopPropagation');
		fireEvent(expandedContainer, wheelEvent);
		expect(stopPropagation).toHaveBeenCalledOnce();

		fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
		expect(screen.queryByText('line four', { exact: false })).not.toBeInTheDocument();
	});

	it('renders collapsed markdown-edit output as stripped text and contains downward wheel scrolls', () => {
		renderMessages({
			markdownEditMode: true,
			maxOutputLines: 2,
			messages: [
				createMessage({
					content: ['**line one**', '_line two_', '[line three](https://example.com)'].join('\n'),
				}),
			],
		});

		expect(screen.queryByTestId('markdown-renderer')).not.toBeInTheDocument();
		expect(screen.getByText('line one', { exact: false })).toBeInTheDocument();
		expect(screen.queryByText('line three', { exact: false })).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Show all 3 lines' }));
		expect(screen.getByText('line three', { exact: false })).toBeInTheDocument();

		const expandedContainer = screen
			.getByText('line three', { exact: false })
			.closest('.overflow-auto')!;
		Object.defineProperties(expandedContainer, {
			scrollTop: { configurable: true, value: 0 },
			scrollHeight: { configurable: true, value: 100 },
			clientHeight: { configurable: true, value: 30 },
		});
		const downwardWheelEvent = createEvent.wheel(expandedContainer, { deltaY: 1 });
		const stopDownwardPropagation = vi.spyOn(downwardWheelEvent, 'stopPropagation');
		fireEvent(expandedContainer, downwardWheelEvent);
		expect(stopDownwardPropagation).toHaveBeenCalledOnce();

		Object.defineProperty(expandedContainer, 'scrollTop', { configurable: true, value: 70 });
		const bottomWheelEvent = createEvent.wheel(expandedContainer, { deltaY: 1 });
		const stopBottomPropagation = vi.spyOn(bottomWheelEvent, 'stopPropagation');
		fireEvent(expandedContainer, bottomWheelEvent);
		expect(stopBottomPropagation).not.toHaveBeenCalled();
	});

	it('does not collapse when maxOutputLines is Infinity', () => {
		renderMessages({
			maxOutputLines: Infinity,
			messages: [
				createMessage({
					content: ['line one', 'line two', 'line three'].join('\n'),
				}),
			],
		});

		expect(screen.getByText('line three', { exact: false })).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /Show all/ })).not.toBeInTheDocument();
	});

	it('exposes scrollToMessage for exact and nearby timestamps', () => {
		const ref = React.createRef<GroupChatMessagesHandle>();
		const { unmount } = renderMessages(
			{
				messages: [
					createMessage({ timestamp: '2026-05-13T12:00:00.000Z', content: 'First message' }),
					createMessage({ timestamp: '1700000000000', content: 'Numeric timestamp' }),
				],
			},
			ref
		);
		const scrollToMessage = ref.current!.scrollToMessage;

		scrollToMessage(new Date('2026-05-13T12:00:00.000Z').getTime());
		expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
			behavior: 'smooth',
			block: 'center',
		});

		scrollToMessage(1700000000000);
		expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(2);

		scrollToMessage(1700000001000);
		expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(3);

		scrollToMessage(1);
		expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(3);

		unmount();
		scrollToMessage(new Date('2026-05-13T12:00:00.000Z').getTime());
		expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(3);

		vi.advanceTimersByTime(1000);
	});

	it('skips empty timestamp attributes while finding the nearest scroll target', () => {
		const ref = React.createRef<GroupChatMessagesHandle>();
		renderMessages(
			{
				messages: [
					createMessage({ timestamp: '', content: 'Empty timestamp' }),
					createMessage({
						timestamp: '2026-05-13T12:00:00.000Z',
						content: 'Nearby timestamp',
					}),
				],
			},
			ref
		);

		ref.current!.scrollToMessage(new Date('2026-05-13T12:00:01.000Z').getTime());

		expect(Element.prototype.scrollIntoView).toHaveBeenCalledWith({
			behavior: 'smooth',
			block: 'center',
		});
	});

	it('handles keyboard scroll shortcuts on the message region', () => {
		renderMessages({
			messages: [
				createMessage({ timestamp: '2026-05-13T12:00:00.000Z', content: 'First message' }),
				createMessage({ timestamp: '2026-05-13T12:00:01.000Z', content: 'Second message' }),
			],
		});
		const region = screen.getByRole('region', { name: 'Group chat messages' });
		const scrollBy = vi.fn();
		Object.defineProperty(region, 'scrollBy', { configurable: true, value: scrollBy });

		fireEvent.keyDown(region, { key: 'Escape' });
		expect(scrollBy).not.toHaveBeenCalled();

		fireEvent.keyDown(region, { key: 'ArrowDown' });
		fireEvent.keyDown(region, { key: 'ArrowUp' });
		expect(scrollBy).toHaveBeenNthCalledWith(1, { top: 100 });
		expect(scrollBy).toHaveBeenNthCalledWith(2, { top: -100 });

		fireEvent.keyDown(region, { key: 'ArrowUp', shiftKey: true });
		fireEvent.keyDown(region, { key: 'ArrowDown', shiftKey: true });
		expect(scrollBy).toHaveBeenCalledTimes(2);
	});

	it('renders image attachments and sends history context to the lightbox', () => {
		const onOpenLightbox = vi.fn();
		const images = ['maestro://first-image.png', 'maestro://second-image.png'];
		renderMessages({
			onOpenLightbox,
			messages: [createMessage({ images })],
		});

		const imageButtons = screen.getAllByRole('button', { name: /Attached image/ });
		expect(imageButtons).toHaveLength(2);

		fireEvent.click(imageButtons[1]);
		expect(onOpenLightbox).toHaveBeenCalledWith(images[1], images, 'history');
	});

	it('does not require a lightbox handler for image attachment clicks', () => {
		renderMessages({
			messages: [createMessage({ images: ['maestro://first-image.png'] })],
		});

		expect(() => {
			fireEvent.click(screen.getByRole('button', { name: 'Attached image 1' }));
		}).not.toThrow();
	});

	it('publishes non-user messages as gists and reflects existing gist state', () => {
		const onPublishGist = vi.fn();
		const publishedTimestamp = '2026-05-13T12:01:00.000Z';
		const unpublishedTimestamp = '2026-05-13T12:02:00.000Z';
		const gistUrl = 'https://gist.github.com/test/published';
		useMessageGistStore.getState().setMessageGist(`${publishedTimestamp}-0`, {
			gistUrl,
			isPublic: false,
			publishedAt: 1700000000000,
		});

		renderMessages({
			ghCliAvailable: true,
			onPublishGist,
			messages: [
				createMessage({ timestamp: publishedTimestamp, content: 'Published content' }),
				createMessage({ timestamp: unpublishedTimestamp, content: 'Fresh content' }),
			],
		});

		fireEvent.click(screen.getByTitle(`Published as Gist: ${gistUrl}`));
		fireEvent.click(screen.getByTitle('Publish as GitHub Gist'));

		expect(onPublishGist).toHaveBeenNthCalledWith(
			1,
			'Published content',
			`${publishedTimestamp}-0`
		);
		expect(onPublishGist).toHaveBeenNthCalledWith(2, 'Fresh content', `${unpublishedTimestamp}-1`);
	});

	it('does not show gist publishing actions on user messages', () => {
		renderMessages({
			ghCliAvailable: true,
			onPublishGist: vi.fn(),
			messages: [createMessage({ from: 'user', content: 'User message' })],
		});

		expect(screen.queryByTitle('Publish as GitHub Gist')).not.toBeInTheDocument();
	});

	it('keeps user-authored markdown edit text literal in raw mode', () => {
		renderMessages({
			markdownEditMode: true,
			messages: [
				createMessage({
					from: 'user',
					content: ['**line one**', '_line two_'].join('\n'),
				}),
			],
		});

		expect(screen.getByText('**line one**', { exact: false })).toBeInTheDocument();
		expect(screen.getByText('_line two_', { exact: false })).toBeInTheDocument();
	});
});
