import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupChatParticipants } from '../../../renderer/components/GroupChatParticipants';
import type { GroupChatParticipant, SessionState, Theme } from '../../../renderer/types';

const mocks = vi.hoisted(() => ({
	buildParticipantColorMap: vi.fn(),
	onResizeStart: vi.fn(),
	useResizablePanel: vi.fn(() => ({
		panelRef: { current: null },
		onResizeStart: vi.fn(),
		transitionClass: 'mock-transition',
	})),
	participantLiveOutput: new Map<string, string>(),
	participantCards: [] as Array<{
		participant: GroupChatParticipant;
		state: SessionState;
		color?: string;
		groupChatId?: string;
		onContextReset?: (participantName: string) => Promise<void>;
		onRemove?: (participantName: string) => Promise<void>;
		liveOutput?: string;
	}>,
}));

vi.mock('../../../renderer/components/ParticipantCard', () => ({
	ParticipantCard: ({
		participant,
		state,
		color,
		groupChatId,
		onContextReset,
		onRemove,
		liveOutput,
	}: {
		participant: GroupChatParticipant;
		state: SessionState;
		color?: string;
		groupChatId?: string;
		onContextReset?: (participantName: string) => Promise<void>;
		onRemove?: (participantName: string) => Promise<void>;
		liveOutput?: string;
	}) => {
		mocks.participantCards.push({
			participant,
			state,
			color,
			groupChatId,
			onContextReset,
			onRemove,
			liveOutput,
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

vi.mock('../../../renderer/utils/participantColors', () => ({
	buildParticipantColorMap: mocks.buildParticipantColorMap,
}));

vi.mock('../../../renderer/hooks', () => ({
	useResizablePanel: mocks.useResizablePanel,
}));

vi.mock('../../../renderer/stores/groupChatStore', () => ({
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
		error: '#ff3333',
		warning: '#ffaa00',
		success: '#00cc88',
		info: '#4488ff',
		textInverse: '#000000',
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
};

function installGroupChatApi(overrides: Partial<typeof window.maestro.groupChat> = {}) {
	const groupChat = {
		resetParticipantContext: vi.fn().mockResolvedValue(undefined),
		removeParticipant: vi.fn().mockResolvedValue(undefined),
		...overrides,
	};
	window.maestro.groupChat = {
		...window.maestro.groupChat,
		...groupChat,
	};
	return groupChat;
}

function renderParticipants(overrides: Partial<ComponentProps<typeof GroupChatParticipants>> = {}) {
	const props: ComponentProps<typeof GroupChatParticipants> = {
		theme,
		participants: [zoe, alice],
		participantStates: new Map([['Alice', 'busy']]),
		isOpen: true,
		onToggle: vi.fn(),
		width: 340,
		setWidthState: vi.fn(),
		shortcuts,
		groupChatId: 'group-1',
		moderatorAgentId: 'claude-code',
		moderatorSessionId: 'moderator-process',
		moderatorAgentSessionId: 'moderator-agent-session',
		moderatorState: 'idle',
		moderatorUsage: { contextUsage: 44, totalCost: 0.42, tokenCount: 12000 },
		...overrides,
	};

	return {
		...render(<GroupChatParticipants {...props} />),
		props,
	};
}

describe('GroupChatParticipants', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.participantCards.length = 0;
		mocks.participantLiveOutput = new Map([['Zoe', 'Zoe is checking files']]);
		mocks.onResizeStart = vi.fn();
		mocks.useResizablePanel.mockReturnValue({
			panelRef: { current: null },
			onResizeStart: mocks.onResizeStart,
			transitionClass: 'mock-transition',
		});
		mocks.buildParticipantColorMap.mockReturnValue({
			Moderator: '#0000ff',
			Alice: '#ff0000',
			Zoe: '#00ff00',
		});
		vi.spyOn(Date, 'now').mockReturnValue(1770000000000);
		installGroupChatApi();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('does not render or create participant cards when closed', () => {
		const { container } = renderParticipants({ isOpen: false });

		expect(container.firstChild).toBeNull();
		expect(mocks.participantCards).toEqual([]);
	});

	it('renders the moderator, empty participant guidance, collapse shortcut, and resize behavior', () => {
		const { container, props } = renderParticipants({
			participants: [],
			participantStates: new Map(),
			moderatorAgentSessionId: undefined,
			moderatorUsage: null,
		});

		expect(container.firstElementChild).toHaveStyle({
			width: '340px',
			backgroundColor: '#222222',
			borderColor: '#444444',
		});
		expect(container.firstElementChild).toHaveClass('mock-transition');
		expect(mocks.useResizablePanel).toHaveBeenCalledWith({
			width: 340,
			minWidth: 200,
			maxWidth: 600,
			settingsKey: 'rightPanelWidth',
			setWidth: props.setWidthState,
			side: 'right',
		});
		expect(mocks.buildParticipantColorMap).toHaveBeenCalledWith(['Moderator'], theme);

		fireEvent.mouseDown(container.querySelector('.cursor-col-resize') as Element);
		fireEvent.click(screen.getByTitle(/Collapse Participants/));

		expect(mocks.onResizeStart).toHaveBeenCalled();
		expect(props.onToggle).toHaveBeenCalled();
		expect(screen.getByTitle(/Collapse Participants/)).toHaveAttribute(
			'title',
			expect.stringMatching(/Collapse Participants \(.+\)/)
		);
		expect(container).toHaveTextContent('No participants yet.');
		expect(container).toHaveTextContent('Ask the moderator to add agents.');

		expect(mocks.participantCards).toHaveLength(1);
		expect(mocks.participantCards[0]).toMatchObject({
			participant: {
				name: 'Moderator',
				agentId: 'claude-code',
				sessionId: 'moderator-process',
				agentSessionId: undefined,
				addedAt: 1770000000000,
			},
			state: 'idle',
			color: '#0000ff',
			groupChatId: undefined,
			onContextReset: undefined,
			onRemove: undefined,
			liveOutput: undefined,
		});
	});

	it('sorts participants alphabetically and passes state, colors, usage, and live output to cards', () => {
		renderParticipants();

		expect(mocks.buildParticipantColorMap).toHaveBeenCalledWith(
			['Moderator', 'Zoe', 'Alice'],
			theme
		);

		expect(mocks.participantCards.map((card) => card.participant.name)).toEqual([
			'Moderator',
			'Alice',
			'Zoe',
		]);
		expect(mocks.participantCards[0]).toMatchObject({
			participant: {
				name: 'Moderator',
				contextUsage: 44,
				tokenCount: 12000,
				totalCost: 0.42,
			},
			state: 'idle',
			color: '#0000ff',
		});
		expect(mocks.participantCards[1]).toMatchObject({
			participant: alice,
			state: 'busy',
			color: '#ff0000',
			groupChatId: 'group-1',
			liveOutput: undefined,
		});
		expect(mocks.participantCards[2]).toMatchObject({
			participant: zoe,
			state: 'idle',
			color: '#00ff00',
			groupChatId: 'group-1',
			liveOutput: 'Zoe is checking files',
		});
	});

	it('resets participant context, logs expected reset failures, and removes participants', async () => {
		const resetFailure = new Error('reset failed');
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
		const groupChat = installGroupChatApi({
			resetParticipantContext: vi
				.fn()
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(resetFailure),
			removeParticipant: vi.fn().mockResolvedValue(undefined),
		});

		renderParticipants();

		fireEvent.click(screen.getByRole('button', { name: /Reset Alice/i }));
		await waitFor(() => {
			expect(groupChat.resetParticipantContext).toHaveBeenCalledWith('group-1', 'Alice');
		});

		fireEvent.click(screen.getByRole('button', { name: /Reset Zoe/i }));
		await waitFor(() => {
			expect(consoleError).toHaveBeenCalledWith('Failed to reset context for Zoe:', resetFailure);
		});

		fireEvent.click(screen.getByRole('button', { name: /Remove Alice/i }));
		await waitFor(() => {
			expect(groupChat.removeParticipant).toHaveBeenCalledWith('group-1', 'Alice');
		});
	});
});
