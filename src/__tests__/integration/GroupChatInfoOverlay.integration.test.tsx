import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupChatInfoOverlay } from '../../renderer/components/GroupChatInfoOverlay';
import type {
	GroupChat,
	GroupChatHistoryEntry,
	GroupChatMessage,
	Theme,
} from '../../renderer/types';

const mocks = vi.hoisted(() => ({
	safeClipboardWrite: vi.fn(),
	downloadGroupChatExport: vi.fn(),
	getHistory: vi.fn(),
	loggerError: vi.fn(),
	loggerWarn: vi.fn(),
	openPath: vi.fn(),
}));

vi.mock('../../renderer/components/ui/Modal', () => ({
	Modal: ({ title, onClose, children }: any) => (
		<section role="dialog" aria-label={title}>
			<button type="button" onClick={onClose}>
				Close modal
			</button>
			{children}
		</section>
	),
}));

vi.mock('../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: mocks.safeClipboardWrite,
}));

vi.mock('../../renderer/utils/groupChatExport', () => ({
	downloadGroupChatExport: mocks.downloadGroupChatExport,
}));

vi.mock('../../renderer/utils/logger', () => ({
	logger: {
		error: mocks.loggerError,
		warn: mocks.loggerWarn,
	},
}));

const theme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#222222',
		bgActivity: '#333333',
		textMain: '#ffffff',
		textDim: '#999999',
		accent: '#00aaff',
		accentForeground: '#ffffff',
		border: '#444444',
	},
};

const historyEntry: GroupChatHistoryEntry = {
	id: 'history-1',
	timestamp: 100,
	type: 'response',
	participantName: 'Alice',
	participantColor: '#ff0000',
	summary: 'Alice completed the task',
	fullResponse: 'Done',
};

function createGroupChat(overrides: Partial<GroupChat> = {}): GroupChat {
	return {
		id: 'group-1',
		name: 'Launch Chat',
		createdAt: Date.parse('2026-01-01T10:00:00Z'),
		updatedAt: Date.parse('2026-01-01T11:15:00Z'),
		moderatorAgentId: 'claude-code',
		moderatorSessionId: 'moderator-session-1',
		participants: [
			{
				name: 'Alice',
				agentId: 'claude-code',
				sessionId: 'alice-session',
				addedAt: 1,
			},
			{
				name: 'Zoe',
				agentId: 'codex',
				sessionId: 'zoe-session',
				addedAt: 2,
			},
		],
		logPath: '/tmp/group-chat/chat.jsonl',
		imagesDir: '/tmp/group-chat/images/',
		...overrides,
	};
}

function createMessages(): GroupChatMessage[] {
	return [
		{ timestamp: '2026-01-01T10:00:00Z', from: 'user', content: 'Start' },
		{ timestamp: '2026-01-01T10:05:00Z', from: 'moderator', content: 'Delegating' },
		{ timestamp: '2026-01-01T10:20:00Z', from: 'Alice', content: 'Working' },
		{ timestamp: '2026-01-01T11:15:00Z', from: 'Zoe', content: 'Done' },
	];
}

function installMaestroApis() {
	window.maestro.groupChat = {
		...(window.maestro.groupChat ?? {}),
		getHistory: mocks.getHistory,
	} as typeof window.maestro.groupChat;
	window.maestro.shell.openPath = mocks.openPath;
}

function invokeReactClickHandler(button: HTMLElement) {
	const reactPropsKey = Object.getOwnPropertyNames(button).find((key) =>
		key.startsWith('__reactProps$')
	);
	expect(reactPropsKey).toBeDefined();

	const reactProps = (button as unknown as Record<string, { onClick?: () => void }>)[
		reactPropsKey as string
	];
	expect(reactProps.onClick).toEqual(expect.any(Function));
	reactProps.onClick?.();
}

function renderOverlay(overrides: Partial<React.ComponentProps<typeof GroupChatInfoOverlay>> = {}) {
	const props: React.ComponentProps<typeof GroupChatInfoOverlay> = {
		theme,
		isOpen: true,
		groupChat: createGroupChat(),
		messages: createMessages(),
		onClose: vi.fn(),
		onOpenModeratorSession: vi.fn(),
		...overrides,
	};

	return {
		...render(<GroupChatInfoOverlay {...props} />),
		props,
	};
}

describe('GroupChatInfoOverlay', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.safeClipboardWrite.mockResolvedValue(undefined);
		mocks.downloadGroupChatExport.mockResolvedValue(undefined);
		mocks.getHistory.mockResolvedValue([historyEntry]);
		installMaestroApis();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('does not render while closed', () => {
		renderOverlay({ isOpen: false, messages: [] });

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});

	it('renders metadata, copies values, opens paths, and opens the moderator session', async () => {
		const { props } = renderOverlay();

		expect(screen.getByRole('dialog', { name: 'Group Chat Info' })).toBeInTheDocument();
		expect(screen.getByText('Agents')).toBeInTheDocument();
		expect(screen.getByText('Messages')).toBeInTheDocument();
		expect(screen.getByText('Agent Replies')).toBeInTheDocument();
		expect(screen.getByText('Duration')).toBeInTheDocument();
		expect(screen.getByText('1h 15m')).toBeInTheDocument();
		expect(screen.getByText('Group Chat ID')).toBeInTheDocument();
		expect(screen.getByText('group-1')).toBeInTheDocument();
		expect(screen.getByText('/tmp/group-chat/chat.jsonl')).toBeInTheDocument();
		expect(screen.getByText('/tmp/group-chat/images/')).toBeInTheDocument();
		expect(screen.getByText('Participant Sessions')).toBeInTheDocument();
		expect(screen.getByText('alice-session')).toBeInTheDocument();
		expect(screen.getByText('zoe-session')).toBeInTheDocument();

		const copyButtons = screen.getAllByTitle('Copy to clipboard');
		fireEvent.click(copyButtons[0]);
		fireEvent.click(copyButtons[1]);
		fireEvent.click(copyButtons[2]);
		fireEvent.click(copyButtons[3]);
		fireEvent.click(copyButtons[4]);

		await waitFor(() => {
			expect(mocks.safeClipboardWrite).toHaveBeenNthCalledWith(1, 'group-1');
			expect(mocks.safeClipboardWrite).toHaveBeenNthCalledWith(2, '/tmp/group-chat/chat.jsonl');
			expect(mocks.safeClipboardWrite).toHaveBeenNthCalledWith(3, '/tmp/group-chat/images/');
			expect(mocks.safeClipboardWrite).toHaveBeenNthCalledWith(4, 'moderator-session-1');
			expect(mocks.safeClipboardWrite).toHaveBeenNthCalledWith(5, 'alice-session');
		});

		fireEvent.click(screen.getByRole('button', { name: 'Open in Finder' }));
		expect(mocks.openPath).toHaveBeenCalledWith('/tmp/group-chat');

		fireEvent.click(screen.getByRole('button', { name: /moderator-session-1/i }));
		expect(props.onOpenModeratorSession).toHaveBeenCalledWith('moderator-session-1');
		expect(props.onClose).toHaveBeenCalled();
	});

	it('renders minute-only duration, no participants, and not-started moderator state', () => {
		renderOverlay({
			groupChat: createGroupChat({
				moderatorSessionId: '',
				participants: [],
				imagesDir: '/tmp/group-chat/images',
			}),
			messages: [
				{ timestamp: '2026-01-01T10:00:00Z', from: 'user', content: 'Start' },
				{ timestamp: '2026-01-01T10:20:00Z', from: 'moderator', content: 'Plan' },
			],
		});

		expect(screen.getByText('20m')).toBeInTheDocument();
		expect(screen.getByText('Not started')).toBeInTheDocument();
		expect(screen.queryByText('Participant Sessions')).not.toBeInTheDocument();
	});

	it('renders zero-minute duration for an empty chat', () => {
		const { unmount } = renderOverlay({ messages: [] });

		expect(screen.getByText('0m')).toBeInTheDocument();
		unmount();
	});

	it('closes without an opener callback when opening a moderator session', () => {
		const onClose = vi.fn();
		renderOverlay({
			onClose,
			onOpenModeratorSession: undefined,
			messages: [{ timestamp: '2026-01-01T10:00:00Z', from: 'user', content: 'Start' }],
		});

		expect(screen.getByText('0m')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /moderator-session-1/i }));
		expect(onClose).toHaveBeenCalled();
	});

	it('exports history once while an export is already pending', async () => {
		let resolveExport: () => void = () => {};
		mocks.downloadGroupChatExport.mockReturnValue(
			new Promise<void>((resolve) => {
				resolveExport = resolve;
			})
		);
		const groupChat = createGroupChat();
		const messages = createMessages();

		renderOverlay({ groupChat, messages });

		fireEvent.click(screen.getByRole('button', { name: 'Export HTML' }));

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Exporting...' })).toBeDisabled();
		});

		const exportingButton = screen.getByRole('button', { name: 'Exporting...' });
		// Native click events are suppressed while disabled; invoke the handler to prove the guard.
		invokeReactClickHandler(exportingButton);
		expect(mocks.getHistory).toHaveBeenCalledTimes(1);

		resolveExport();

		await waitFor(() => {
			expect(screen.getByRole('button', { name: 'Export HTML' })).not.toBeDisabled();
		});
		expect(mocks.getHistory).toHaveBeenCalledWith('group-1');
		expect(mocks.downloadGroupChatExport).toHaveBeenCalledWith(
			groupChat,
			messages,
			[historyEntry],
			theme
		);
	});

	it('exports with empty history and logs the expected warning when history loading fails', async () => {
		const historyError = new Error('history failed');
		mocks.getHistory.mockRejectedValue(historyError);
		const groupChat = createGroupChat();
		const messages = createMessages();

		renderOverlay({ groupChat, messages });
		fireEvent.click(screen.getByRole('button', { name: 'Export HTML' }));

		await waitFor(() => {
			expect(mocks.loggerWarn).toHaveBeenCalledWith(
				'Failed to fetch history for export:',
				undefined,
				historyError
			);
			expect(mocks.downloadGroupChatExport).toHaveBeenCalledWith(groupChat, messages, [], theme);
		});
	});

	it('logs the expected export failure and restores the export button', async () => {
		const exportError = new Error('download failed');
		mocks.downloadGroupChatExport.mockRejectedValue(exportError);

		renderOverlay();
		fireEvent.click(screen.getByRole('button', { name: 'Export HTML' }));

		await waitFor(() => {
			expect(mocks.loggerError).toHaveBeenCalledWith('Export failed:', undefined, exportError);
			expect(screen.getByRole('button', { name: 'Export HTML' })).not.toBeDisabled();
		});
	});
});
