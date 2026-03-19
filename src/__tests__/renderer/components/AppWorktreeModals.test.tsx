import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AppWorktreeModals } from '../../../renderer/components/AppModals';
import type { Theme, Session } from '../../../renderer/types';

vi.mock('../../../renderer/components/WorktreeConfigModal', () => ({
	WorktreeConfigModal: (props: any) => <div data-testid="worktree-config-modal" />,
}));
vi.mock('../../../renderer/components/CreateWorktreeModal', () => ({
	CreateWorktreeModal: (props: any) => <div data-testid="create-worktree-modal" />,
}));
vi.mock('../../../renderer/components/CreatePRModal', () => ({
	CreatePRModal: (props: any) => <div data-testid="create-pr-modal" />,
}));
vi.mock('../../../renderer/components/DeleteWorktreeModal', () => ({
	DeleteWorktreeModal: (props: any) => <div data-testid="delete-worktree-modal" />,
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
		name: 'Test Session',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/test/project',
		fullPath: '/test/project',
		projectRoot: '/test/project',
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
		isGitRepo: true,
		gitBranches: ['main', 'feature-branch'],
		fileTree: [],
		fileExplorerExpanded: [],
		fileExplorerScrollPos: 0,
		...overrides,
	} as Session;
}

const defaultProps = {
	theme: testTheme,
	activeSession: null as Session | null,
	// WorktreeConfigModal
	worktreeConfigModalOpen: false,
	onCloseWorktreeConfigModal: vi.fn(),
	onSaveWorktreeConfig: vi.fn(),
	onCreateWorktreeFromConfig: vi.fn(),
	onDisableWorktreeConfig: vi.fn(),
	// CreateWorktreeModal
	createWorktreeModalOpen: false,
	createWorktreeSession: null as Session | null,
	onCloseCreateWorktreeModal: vi.fn(),
	onCreateWorktree: vi.fn(),
	// CreatePRModal
	createPRModalOpen: false,
	createPRSession: null as Session | null,
	onCloseCreatePRModal: vi.fn(),
	onPRCreated: vi.fn(),
	// DeleteWorktreeModal
	deleteWorktreeModalOpen: false,
	deleteWorktreeSession: null as Session | null,
	onCloseDeleteWorktreeModal: vi.fn(),
	onConfirmDeleteWorktree: vi.fn(),
	onConfirmAndDeleteWorktreeOnDisk: vi.fn(),
};

describe('AppWorktreeModals', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('does not render any modals when all booleans are false', () => {
		render(<AppWorktreeModals {...defaultProps} />);
		expect(screen.queryByTestId('worktree-config-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('create-worktree-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('create-pr-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('delete-worktree-modal')).not.toBeInTheDocument();
	});

	it('renders WorktreeConfigModal when worktreeConfigModalOpen and activeSession exist', () => {
		render(
			<AppWorktreeModals
				{...defaultProps}
				worktreeConfigModalOpen={true}
				activeSession={createMockSession()}
			/>
		);
		expect(screen.getByTestId('worktree-config-modal')).toBeInTheDocument();
		expect(screen.queryByTestId('create-worktree-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('create-pr-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('delete-worktree-modal')).not.toBeInTheDocument();
	});

	it('does not render WorktreeConfigModal when activeSession is null', () => {
		render(
			<AppWorktreeModals {...defaultProps} worktreeConfigModalOpen={true} activeSession={null} />
		);
		expect(screen.queryByTestId('worktree-config-modal')).not.toBeInTheDocument();
	});

	it('renders CreateWorktreeModal when createWorktreeModalOpen and createWorktreeSession are set', () => {
		render(
			<AppWorktreeModals
				{...defaultProps}
				createWorktreeModalOpen={true}
				createWorktreeSession={createMockSession({ id: 'wt-session' })}
			/>
		);
		expect(screen.getByTestId('create-worktree-modal')).toBeInTheDocument();
		expect(screen.queryByTestId('worktree-config-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('create-pr-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('delete-worktree-modal')).not.toBeInTheDocument();
	});

	it('renders CreatePRModal using createPRSession when available', () => {
		render(
			<AppWorktreeModals
				{...defaultProps}
				createPRModalOpen={true}
				createPRSession={createMockSession({ id: 'pr-session' })}
				activeSession={createMockSession({ id: 'active-session' })}
			/>
		);
		expect(screen.getByTestId('create-pr-modal')).toBeInTheDocument();
		expect(screen.queryByTestId('worktree-config-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('create-worktree-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('delete-worktree-modal')).not.toBeInTheDocument();
	});

	it('renders CreatePRModal falling back to activeSession when createPRSession is null', () => {
		render(
			<AppWorktreeModals
				{...defaultProps}
				createPRModalOpen={true}
				createPRSession={null}
				activeSession={createMockSession({ id: 'active-session' })}
			/>
		);
		expect(screen.getByTestId('create-pr-modal')).toBeInTheDocument();
		expect(screen.queryByTestId('worktree-config-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('create-worktree-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('delete-worktree-modal')).not.toBeInTheDocument();
	});

	it('renders DeleteWorktreeModal when deleteWorktreeModalOpen and deleteWorktreeSession are set', () => {
		render(
			<AppWorktreeModals
				{...defaultProps}
				deleteWorktreeModalOpen={true}
				deleteWorktreeSession={createMockSession({ id: 'del-session' })}
			/>
		);
		expect(screen.getByTestId('delete-worktree-modal')).toBeInTheDocument();
		expect(screen.queryByTestId('worktree-config-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('create-worktree-modal')).not.toBeInTheDocument();
		expect(screen.queryByTestId('create-pr-modal')).not.toBeInTheDocument();
	});
});
