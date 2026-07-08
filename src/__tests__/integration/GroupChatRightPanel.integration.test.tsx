import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupChatRightPanel } from '../../renderer/components/GroupChatRightPanel';
import { logger } from '../../renderer/utils/logger';
import type { GroupChatParticipant, Theme } from '../../renderer/types';
import type { GroupChatHistoryEntry } from '../../shared/group-chat-types';

const mocks = vi.hoisted(() => ({
	participantLiveOutput: new Map<string, string>(),
	buildParticipantColorMapWithPreferences: vi.fn(),
	loadColorPreferences: vi.fn(),
	saveColorPreferences: vi.fn(),
	onResizeStart: vi.fn(),
	participantCards: [] as Array<{
		name: string;
		state: string;
		color?: string;
		sshRemoteName?: string;
		liveOutput?: string;
		contextUsage?: number;
		totalCost?: number;
		tokenCount?: number;
	}>,
	historyProps: [] as Array<{
		groupChatId: string;
		entries: GroupChatHistoryEntry[];
		isLoading: boolean;
		participantColors: Record<string, string>;
	}>,
}));

vi.mock('../../renderer/components/ParticipantCard', () => ({
	ParticipantCard: ({ participant, state, color, onContextReset, onRemove, liveOutput }: any) => {
		mocks.participantCards.push({
			name: participant.name,
			state,
			color,
			sshRemoteName: participant.sshRemoteName,
			liveOutput,
			contextUsage: participant.contextUsage,
			totalCost: participant.totalCost,
			tokenCount: participant.tokenCount,
		});
		return (
			<div data-testid="participant-card" data-name={participant.name} data-state={state}>
				<span>{participant.name}</span>
				<span>{color ?? 'no-color'}</span>
				<span>{liveOutput ?? 'no-live-output'}</span>
				{onContextReset && (
					<button onClick={() => void onContextReset(participant.name)}>
						Reset {participant.name}
					</button>
				)}
				{onRemove && (
					<button onClick={() => void onRemove(participant.name)}>Remove {participant.name}</button>
				)}
			</div>
		);
	},
}));

vi.mock('../../renderer/components/GroupChatHistoryPanel', () => ({
	GroupChatHistoryPanel: ({
		groupChatId,
		entries,
		isLoading,
		participantColors,
		onJumpToMessage,
	}: any) => {
		mocks.historyProps.push({ groupChatId, entries, isLoading, participantColors });
		return (
			<div data-testid="history-panel" data-loading={String(isLoading)}>
				<span>
					entries:{entries.map((entry: GroupChatHistoryEntry) => entry.summary).join('|')}
				</span>
				<span>colors:{Object.keys(participantColors).join('|')}</span>
				<button onClick={() => onJumpToMessage?.(12345)}>Jump mocked history</button>
			</div>
		);
	},
}));

vi.mock('../../renderer/utils/participantColors', () => ({
	buildParticipantColorMapWithPreferences: mocks.buildParticipantColorMapWithPreferences,
	loadColorPreferences: mocks.loadColorPreferences,
	saveColorPreferences: mocks.saveColorPreferences,
}));

vi.mock('../../renderer/hooks', () => ({
	useResizablePanel: vi.fn(() => ({
		panelRef: { current: null },
		onResizeStart: mocks.onResizeStart,
		transitionClass: 'mock-transition',
	})),
}));

vi.mock('../../renderer/stores/groupChatStore', () => ({
	useGroupChatStore: (
		selector: (state: { participantLiveOutput: Map<string, string> }) => unknown
	) => selector({ participantLiveOutput: mocks.participantLiveOutput }),
}));

const theme = {
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
} as Theme;

const shortcuts = {
	toggleRightPanel: { id: 'toggleRightPanel', label: 'Toggle Right Panel', keys: ['Meta', 'b'] },
};

const alice: GroupChatParticipant = {
	name: 'Alice',
	agentId: 'claude-code',
	sessionId: 'alice-session',
	addedAt: 1,
};

const zoe: GroupChatParticipant = {
	name: 'Zoe',
	agentId: 'codex',
	sessionId: 'zoe-session',
	addedAt: 2,
	sshRemoteName: 'stored-remote',
};

const historyEntry: GroupChatHistoryEntry = {
	id: 'entry-1',
	timestamp: 100,
	type: 'response',
	participantName: 'Alice',
	summary: 'Alice responded',
	fullResponse: 'Full response',
	participantColor: '#ff0000',
};

function installGroupChatApi(overrides: Partial<typeof window.maestro.groupChat> = {}) {
	const groupChat = {
		getHistory: vi.fn().mockResolvedValue([historyEntry]),
		onHistoryEntry: vi.fn().mockReturnValue(vi.fn()),
		resetParticipantContext: vi.fn().mockResolvedValue(undefined),
		removeParticipant: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
	window.maestro.groupChat = groupChat;
	return groupChat;
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof GroupChatRightPanel>> = {}) {
	const props: React.ComponentProps<typeof GroupChatRightPanel> = {
		theme,
		groupChatId: 'group-1',
		participants: [zoe, alice],
		participantStates: new Map([
			['Alice', 'working'],
			['Zoe', 'idle'],
		]),
		participantSessionPaths: new Map([['alice-session', '/repo/alice']]),
		sessionSshRemoteNames: new Map([['Alice', 'fallback-remote']]),
		isOpen: true,
		onToggle: vi.fn(),
		width: 320,
		setWidthState: vi.fn(),
		shortcuts,
		moderatorAgentId: 'claude-code',
		moderatorSessionId: 'moderator-process',
		moderatorAgentSessionId: 'moderator-agent-session',
		moderatorState: 'idle',
		moderatorUsage: { contextUsage: 40, totalCost: 0.12, tokenCount: 9000 },
		activeTab: 'participants',
		onTabChange: vi.fn(),
		onJumpToMessage: vi.fn(),
		onColorsComputed: vi.fn(),
		...overrides,
	};
	return {
		...render(<GroupChatRightPanel {...props} />),
		props,
	};
}

describe('GroupChatRightPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.participantCards.length = 0;
		mocks.historyProps.length = 0;
		mocks.participantLiveOutput = new Map([['group-1:Alice', 'Alice is working']]);
		mocks.loadColorPreferences.mockResolvedValue({ '/repo/alice': 3 });
		mocks.buildParticipantColorMapWithPreferences.mockReturnValue({
			colors: {
				Moderator: '#0000ff',
				Alice: '#ff0000',
				Zoe: '#00ff00',
			},
			newPreferences: { '/repo/zoe': 4 },
		});
		mocks.saveColorPreferences.mockResolvedValue(undefined);
		installGroupChatApi();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('renders participant cards sorted with moderator first, live output, colors, and actions', async () => {
		const { container, props, rerender } = renderPanel();

		expect(container.firstElementChild).toHaveStyle({ width: '320px' });
		expect(container.firstElementChild).toHaveClass('mock-transition');
		fireEvent.mouseDown(container.querySelector('.cursor-col-resize') as Element);
		expect(mocks.onResizeStart).toHaveBeenCalled();

		await waitFor(() => {
			expect(props.onColorsComputed).toHaveBeenCalledWith({
				Moderator: '#0000ff',
				Alice: '#ff0000',
				Zoe: '#00ff00',
			});
		});
		await waitFor(() => {
			expect(mocks.saveColorPreferences).toHaveBeenCalledWith(
				expect.objectContaining({ '/repo/zoe': 4 })
			);
		});
		const duplicateColorsComputed = vi.fn();
		rerender(<GroupChatRightPanel {...props} onColorsComputed={duplicateColorsComputed} />);
		await act(async () => {});
		expect(duplicateColorsComputed).not.toHaveBeenCalled();

		expect(mocks.buildParticipantColorMapWithPreferences).toHaveBeenCalledWith(
			[
				{ name: 'Moderator' },
				{ name: 'Zoe', sessionPath: undefined },
				{ name: 'Alice', sessionPath: '/repo/alice' },
			],
			theme,
			expect.any(Object)
		);
		const latestCards = mocks.participantCards.slice(-3);
		expect(latestCards.map((card) => card.name)).toEqual(['Moderator', 'Alice', 'Zoe']);
		expect(latestCards[0]).toMatchObject({
			name: 'Moderator',
			state: 'idle',
			color: '#0000ff',
			contextUsage: 40,
			totalCost: 0.12,
			tokenCount: 9000,
		});
		expect(latestCards[1]).toMatchObject({
			name: 'Alice',
			state: 'busy',
			color: '#ff0000',
			sshRemoteName: 'fallback-remote',
			liveOutput: 'Alice is working',
		});
		expect(latestCards[2]).toMatchObject({
			name: 'Zoe',
			state: 'idle',
			color: '#00ff00',
			sshRemoteName: 'stored-remote',
		});

		fireEvent.click(screen.getByTitle('View task history'));
		fireEvent.click(screen.getByTitle(/Collapse Panel/));
		fireEvent.click(screen.getByRole('button', { name: /Reset Alice/i }));
		fireEvent.click(screen.getByRole('button', { name: /Remove Alice/i }));

		expect(props.onTabChange).toHaveBeenCalledWith('history');
		expect(props.onToggle).toHaveBeenCalled();
		expect(window.maestro.groupChat.resetParticipantContext).toHaveBeenCalledWith(
			'group-1',
			'Alice'
		);
		expect(window.maestro.groupChat.removeParticipant).toHaveBeenCalledWith('group-1', 'Alice');
	});

	it('shows the empty participant message when only the moderator is present', async () => {
		mocks.buildParticipantColorMapWithPreferences.mockReturnValue({
			colors: { Moderator: '#0000ff' },
			newPreferences: {},
		});

		renderPanel({
			participants: [],
			participantStates: new Map(),
			participantSessionPaths: undefined,
			sessionSshRemoteNames: undefined,
			onColorsComputed: undefined,
			moderatorAgentSessionId: undefined,
			moderatorUsage: null,
		});

		expect(await screen.findByText(/No participants yet/)).toBeInTheDocument();
		expect(screen.getByText(/Ask the moderator to add agents/)).toBeInTheDocument();
		expect(mocks.saveColorPreferences).not.toHaveBeenCalled();
	});

	it('loads history, appends matching live entries, ignores other chats, and unsubscribes', async () => {
		const unsubscribe = vi.fn();
		let historyCallback: ((chatId: string, entry: GroupChatHistoryEntry) => void) | undefined;
		const groupChat = installGroupChatApi({
			getHistory: vi.fn().mockResolvedValue([historyEntry]),
			onHistoryEntry: vi.fn((callback) => {
				historyCallback = callback;
				return unsubscribe;
			}),
		});
		const onJumpToMessage = vi.fn();
		const liveEntry = { ...historyEntry, id: 'entry-2', timestamp: 200, summary: 'Live entry' };
		const ignoredEntry = {
			...historyEntry,
			id: 'entry-3',
			timestamp: 300,
			summary: 'Ignored entry',
		};

		const { unmount } = renderPanel({
			activeTab: 'history',
			onJumpToMessage,
		});

		expect(screen.getByTestId('history-panel')).toHaveAttribute('data-loading', 'true');
		await waitFor(() => {
			expect(screen.getByText('entries:Alice responded')).toBeInTheDocument();
		});
		expect(groupChat.getHistory).toHaveBeenCalledWith('group-1');

		act(() => {
			historyCallback?.('other-group', ignoredEntry);
		});
		expect(screen.queryByText(/Ignored entry/)).not.toBeInTheDocument();

		act(() => {
			historyCallback?.('group-1', liveEntry);
		});
		await waitFor(() => {
			expect(screen.getByText('entries:Live entry|Alice responded')).toBeInTheDocument();
		});

		fireEvent.click(screen.getByRole('button', { name: /jump mocked history/i }));
		expect(onJumpToMessage).toHaveBeenCalledWith(12345);

		unmount();
		expect(unsubscribe).toHaveBeenCalled();
	});

	it('handles missing preload history APIs without adding console noise beyond expected warnings', async () => {
		const loggerWarn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		installGroupChatApi({
			getHistory: undefined as unknown as typeof window.maestro.groupChat.getHistory,
			onHistoryEntry: undefined as unknown as typeof window.maestro.groupChat.onHistoryEntry,
		});

		renderPanel({ activeTab: 'history' });

		await waitFor(() => {
			expect(screen.getByTestId('history-panel')).toHaveAttribute('data-loading', 'false');
		});
		expect(screen.getByText('entries:')).toBeInTheDocument();
		expect(loggerWarn).toHaveBeenCalledWith(
			'groupChat.getHistory not available - restart dev server to update preload'
		);
		expect(loggerWarn).toHaveBeenCalledWith(
			'groupChat.onHistoryEntry not available - restart dev server to update preload'
		);
	});

	it('logs expected recoverable failures for history loading and participant reset', async () => {
		const loggerError = vi.spyOn(logger, 'error').mockImplementation(() => {});
		installGroupChatApi({
			getHistory: vi.fn().mockRejectedValue(new Error('history failed')),
			resetParticipantContext: vi.fn().mockRejectedValue(new Error('reset failed')),
		});

		renderPanel({ activeTab: 'history' });

		await waitFor(() => {
			expect(screen.getByTestId('history-panel')).toHaveAttribute('data-loading', 'false');
		});

		renderPanel();
		fireEvent.click(screen.getByRole('button', { name: /Reset Alice/i }));

		await waitFor(() => {
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to load group chat history:',
				undefined,
				expect.any(Error)
			);
			expect(loggerError).toHaveBeenCalledWith(
				'Failed to reset context for Alice:',
				undefined,
				expect.any(Error)
			);
		});
	});

	it('does not render panel content or load history when closed or missing a group chat id', () => {
		const groupChat = installGroupChatApi();
		mocks.loadColorPreferences.mockReturnValue(new Promise(() => {}));
		const { container, props, rerender } = renderPanel({ isOpen: false, activeTab: 'history' });

		expect(container.firstChild).toBeNull();
		expect(groupChat.getHistory).not.toHaveBeenCalled();

		rerender(<GroupChatRightPanel {...props} isOpen groupChatId="" activeTab="history" />);

		expect(groupChat.getHistory).not.toHaveBeenCalled();
	});
});
