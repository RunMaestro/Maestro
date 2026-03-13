/**
 * Tests for AppSessionModals component
 *
 * Focuses on modal render gating:
 * - NewInstanceModal renders when newInstanceModalOpen is true
 * - EditAgentModal renders when editAgentModalOpen is true
 * - RenameSessionModal renders when renameSessionModalOpen is true
 * - RenameTabModal renders for AI tabs (renameTabId not in terminalTabs)
 * - TerminalTabRenameModal renders for terminal tabs (renameTabId in terminalTabs)
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppSessionModals } from '../../../renderer/components/AppModals';
import type { Theme, Session } from '../../../renderer/types';

// Mock all child modal components
vi.mock('../../../renderer/components/NewInstanceModal', () => ({
	NewInstanceModal: (props: any) => <div data-testid="new-instance-modal" />,
	EditAgentModal: (props: any) => <div data-testid="edit-agent-modal" />,
}));
vi.mock('../../../renderer/components/RenameSessionModal', () => ({
	RenameSessionModal: (props: any) => <div data-testid="rename-session-modal" />,
}));
vi.mock('../../../renderer/components/RenameTabModal', () => ({
	RenameTabModal: (props: any) => <div data-testid="rename-tab-modal" />,
}));
vi.mock('../../../renderer/components/TerminalTabRenameModal', () => ({
	TerminalTabRenameModal: (props: any) => <div data-testid="terminal-tab-rename-modal" />,
}));
vi.mock('../../../renderer/utils/terminalTabHelpers', () => ({
	getTerminalTabDisplayName: vi.fn(() => 'Terminal 1'),
}));

const testTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1e1e1e',
		bgSidebar: '#252526',
		bgActivity: '#333333',
		textMain: '#d4d4d4',
		textDim: '#808080',
		accent: '#007acc',
		accentForeground: '#ffffff',
		border: '#404040',
		error: '#f14c4c',
		warning: '#cca700',
		success: '#89d185',
	},
};

function createMockSession(overrides: Partial<Session> = {}): Session {
	return {
		id: 'session-1',
		name: 'Agent 1',
		state: 'idle',
		toolType: 'claude-code',
		cwd: '/tmp',
		terminalTabs: [],
		activeTerminalTabId: null,
		aiTabs: [],
		...overrides,
	} as Session;
}

const defaultProps = {
	theme: testTheme,
	sessions: [] as Session[],
	activeSessionId: 'session-1',
	activeSession: createMockSession(),
	// NewInstanceModal
	newInstanceModalOpen: false,
	onCloseNewInstanceModal: vi.fn(),
	onCreateSession: vi.fn(),
	existingSessions: [] as Session[],
	// EditAgentModal
	editAgentModalOpen: false,
	onCloseEditAgentModal: vi.fn(),
	onSaveEditAgent: vi.fn(),
	editAgentSession: null as Session | null,
	// RenameSessionModal
	renameSessionModalOpen: false,
	renameSessionValue: '',
	setRenameSessionValue: vi.fn(),
	onCloseRenameSessionModal: vi.fn(),
	setSessions: vi.fn(),
	renameSessionTargetId: null as string | null,
	// RenameTabModal
	renameTabModalOpen: false,
	renameTabId: null as string | null,
	renameTabInitialName: '',
	onCloseRenameTabModal: vi.fn(),
	onRenameTab: vi.fn(),
};

describe('AppSessionModals', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('does not render any modals when all booleans are false', () => {
		const { container } = render(<AppSessionModals {...defaultProps} />);

		expect(screen.queryByTestId('new-instance-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('edit-agent-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('rename-session-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('rename-tab-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('terminal-tab-rename-modal')).not.toBeInTheDocument();
	});

	it('renders NewInstanceModal when newInstanceModalOpen is true', () => {
		render(<AppSessionModals {...defaultProps} newInstanceModalOpen={true} />);

		expect(screen.getByTestId('new-instance-modal')).toBeInTheDocument();
		expect(screen.queryByTestId('edit-agent-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('rename-session-modal')).not.toBeInTheDocument();
	});

	it('renders EditAgentModal when editAgentModalOpen is true', () => {
		render(<AppSessionModals {...defaultProps} editAgentModalOpen={true} />);

		expect(screen.getByTestId('edit-agent-modal')).toBeInTheDocument();
		expect(screen.queryByTestId('new-instance-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('rename-session-modal')).not.toBeInTheDocument();
	});

	it('renders RenameSessionModal when renameSessionModalOpen is true', () => {
		render(<AppSessionModals {...defaultProps} renameSessionModalOpen={true} />);

		expect(screen.getByTestId('rename-session-modal')).toBeInTheDocument();
		expect(screen.queryByTestId('new-instance-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('edit-agent-modal')).not.toBeInTheDocument();
	});

	it('renders RenameTabModal for AI tabs when renameTabModalOpen and renameTabId set', () => {
		const session = createMockSession({
			terminalTabs: [],
			aiTabs: [{ id: 'ai-tab-1', agentSessionId: 'agent-session-1' }] as any[],
		});

		render(
			<AppSessionModals
				{...defaultProps}
				activeSession={session}
				renameTabModalOpen={true}
				renameTabId="ai-tab-1"
				renameTabInitialName="My Tab"
			/>
		);

		expect(screen.getByTestId('rename-tab-modal')).toBeInTheDocument();
		expect(screen.queryByTestId('terminal-tab-rename-modal')).not.toBeInTheDocument();
	});

	it('renders TerminalTabRenameModal when renameTabId matches a terminal tab', () => {
		const session = createMockSession({
			terminalTabs: [{ id: 'term-1', shellType: 'bash' }] as any[],
		});

		render(
			<AppSessionModals
				{...defaultProps}
				activeSession={session}
				renameTabModalOpen={true}
				renameTabId="term-1"
				renameTabInitialName="Terminal 1"
			/>
		);

		expect(screen.getByTestId('terminal-tab-rename-modal')).toBeInTheDocument();
		expect(screen.queryByTestId('rename-tab-modal')).not.toBeInTheDocument();
	});
});
