import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QuickActionsModal } from '../../renderer/components/QuickActionsModal';
import { GitStatusProvider } from '../../renderer/contexts/GitStatusContext';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import { useFileExplorerStore } from '../../renderer/stores/fileExplorerStore';
import { useUIStore } from '../../renderer/stores/uiStore';
import { outputSearchKeyFor } from '../../renderer/utils/outputSearch';
import { logger } from '../../renderer/utils/logger';
import type { Group, Session, Shortcut, Theme } from '../../renderer/types';
import type { GroupChat } from '../../shared/group-chat-types';

const theme: Theme = {
	id: 'custom',
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

const shortcutNames = [
	'newInstance',
	'openWizard',
	'agentSettings',
	'toggleSidebar',
	'toggleRightPanel',
	'toggleMode',
	'toggleMarkdownMode',
	'settings',
	'help',
	'systemLogs',
	'processMonitor',
	'usageDashboard',
	'agentSessions',
	'mergeSession',
	'sendToAgent',
	'viewGitDiff',
	'viewGitLog',
	'goToFiles',
	'goToHistory',
	'goToAutoRun',
	'openSymphony',
	'directorNotes',
	'toggleAutoScroll',
	'fuzzyFileSearch',
	'killInstance',
] as const;

const shortcuts = Object.fromEntries(
	shortcutNames.map((name) => [name, { id: name, keys: ['Meta', name], enabled: true }])
) as Record<string, Shortcut>;

const tabShortcuts = Object.fromEntries(
	[
		'tabSwitcher',
		'renameTab',
		'toggleReadOnlyMode',
		'toggleShowThinking',
		'closeAllTabs',
		'closeOtherTabs',
		'closeTabsLeft',
		'closeTabsRight',
		'summarizeAndContinue',
	].map((name) => [name, { id: name, keys: ['Alt', name], enabled: true }])
) as Record<string, Shortcut>;

function createSession(overrides: Partial<Session> = {}): Session {
	return {
		activeTabId: 'tab-2',
		aiLogs: [],
		aiTabs: [
			{ id: 'tab-1', name: 'Plan', logs: [] },
			{ id: 'tab-2', name: 'Implement', logs: [], showThinking: false, readOnlyMode: false },
			{ id: 'tab-3', name: 'Verify', logs: [] },
		],
		bookmarked: false,
		closedTabHistory: [],
		cwd: '/repo/main',
		executionQueue: [{ id: 'queue-1', text: 'queued prompt' }] as any,
		fileExplorerExpanded: [],
		fileTree: [],
		groupId: 'group-1',
		id: 'child',
		inputMode: 'terminal',
		isGitRepo: true,
		messageQueue: [],
		name: 'Worker Agent',
		parentSessionId: 'parent',
		projectRoot: '/repo/main',
		shellCwd: '/repo/main-shell',
		shellLogs: [{ id: 'log-1', content: 'hello', type: 'stdout', timestamp: Date.now() }],
		state: 'thinking',
		toolType: 'claude-code',
		worktreeBranch: 'feature/integration-coverage',
		...overrides,
	} as Session;
}

const parentSession = createSession({
	activeTabId: 'parent-tab',
	aiTabs: [{ id: 'parent-tab', name: 'Parent', logs: [] }],
	executionQueue: [],
	groupId: undefined,
	id: 'parent',
	name: 'Parent Agent',
	parentSessionId: undefined,
	state: 'idle',
	worktreeBranch: undefined,
});

const activeSession = createSession({
	unifiedTabOrder: [
		{ type: 'ai', id: 'tab-1' },
		{ type: 'ai', id: 'tab-2' },
		{ type: 'ai', id: 'tab-3' },
	],
});
const secondAgent = createSession({
	activeTabId: 'second-tab',
	aiTabs: [{ id: 'second-tab', name: 'Second', logs: [] }],
	executionQueue: [],
	groupId: undefined,
	id: 'second',
	name: 'Second Agent',
	parentSessionId: undefined,
	state: 'idle',
	worktreeBranch: undefined,
});
const terminalSession = createSession({
	activeTabId: undefined,
	aiTabs: [],
	executionQueue: [],
	groupId: undefined,
	id: 'terminal',
	inputMode: 'terminal',
	name: 'Shell',
	parentSessionId: undefined,
	state: 'idle',
	toolType: 'terminal',
	worktreeBranch: undefined,
});

const groups: Group[] = [
	{ collapsed: true, emoji: 'P', id: 'group-1', name: 'Project Group' },
	{ collapsed: false, emoji: 'R', id: 'group-2', name: 'Review Group' },
];

const groupChats: GroupChat[] = [
	{
		createdAt: Date.now(),
		id: 'chat-1',
		name: 'Coverage Guild',
		participants: [
			{ agentId: 'child', name: 'Worker Agent' },
			{ agentId: 'second', name: 'Second Agent' },
		],
		updatedAt: Date.now(),
	} as GroupChat,
];

function createProps(
	overrides: Partial<ComponentProps<typeof QuickActionsModal>> = {}
): ComponentProps<typeof QuickActionsModal> {
	return {
		activeGroupChatId: 'chat-1',
		activeSessionId: activeSession.id,
		addNewSession: vi.fn(),
		autoRunCompletedTaskCount: 2,
		autoRunSelectedDocument: 'plan.md',
		autoScrollAiMode: false,
		canSummarizeActiveTab: true,
		deleteSession: vi.fn(),
		ghCliAvailable: true,
		groupChats,
		groups,
		hasActiveSessionCapability: vi.fn().mockReturnValue(true),
		initialMode: 'main',
		isAiMode: true,
		isFilePreviewOpen: true,
		lastGraphFocusFile: 'docs/plan.md',
		markdownEditMode: false,
		onAutoRunResetTasks: vi.fn(),
		onCloseAllTabs: vi.fn(),
		onCloseGroupChat: vi.fn(),
		onCloseOtherTabs: vi.fn(),
		onCloseTabsLeft: vi.fn(),
		onCloseTabsRight: vi.fn(),
		onClearActiveTerminal: vi.fn(),
		onDebugReleaseQueuedItem: vi.fn(),
		onDeleteGroupChat: vi.fn(),
		onEditAgent: vi.fn(),
		onNewGroupChat: vi.fn(),
		onOpenCreatePR: vi.fn(),
		onOpenDirectorNotes: vi.fn(),
		onOpenGroupChat: vi.fn(),
		onOpenLastDocumentGraph: vi.fn(),
		onOpenMergeSession: vi.fn(),
		onOpenPlaybookExchange: vi.fn(),
		onOpenSendToAgent: vi.fn(),
		onOpenSymphony: vi.fn(),
		onOpenTabSwitcher: vi.fn(),
		onPublishGist: vi.fn(),
		onRefreshGitFileState: vi.fn().mockResolvedValue(undefined),
		onRenameTab: vi.fn(),
		onSummarizeAndContinue: vi.fn(),
		onToggleMarkdownEditMode: vi.fn(),
		onToggleReadOnlyMode: vi.fn(),
		onToggleRemoteControl: vi.fn(),
		onToggleTabShowThinking: vi.fn(),
		openWizard: vi.fn(),
		sessions: [parentSession, activeSession, secondAgent, terminalSession],
		setAboutModalOpen: vi.fn(),
		setActiveAgentSessionId: vi.fn(),
		setActiveRightTab: vi.fn(),
		setActiveSessionId: vi.fn(),
		setAgentSessionsOpen: vi.fn(),
		setAutoScrollAiMode: vi.fn(),
		setCreateGroupModalOpen: vi.fn(),
		setDebugPackageModalOpen: vi.fn(),
		setDebugWizardModalOpen: vi.fn(),
		setFuzzyFileSearchOpen: vi.fn(),
		setGitDiffPreview: vi.fn(),
		setGitLogOpen: vi.fn(),
		setGroups: vi.fn(),
		setLeftSidebarOpen: vi.fn(),
		setLogViewerOpen: vi.fn(),
		setPlaygroundOpen: vi.fn(),
		setProcessMonitorOpen: vi.fn(),
		setQuickActionOpen: vi.fn(),
		setRenameGroupEmoji: vi.fn(),
		setRenameGroupId: vi.fn(),
		setRenameGroupModalOpen: vi.fn(),
		setRenameGroupValue: vi.fn(),
		setRenameInstanceModalOpen: vi.fn(),
		setRenameInstanceValue: vi.fn(),
		setRightPanelOpen: vi.fn(),
		setSettingsModalOpen: vi.fn(),
		setSettingsTab: vi.fn(),
		setSessions: vi.fn(),
		setShortcutsHelpOpen: vi.fn(),
		setUpdateCheckModalOpen: vi.fn(),
		setUsageDashboardOpen: vi.fn(),
		shortcuts,
		startTour: vi.fn(),
		tabShortcuts,
		theme,
		toggleInputMode: vi.fn(),
		wizardGoToStep: vi.fn(),
		...overrides,
	};
}

function renderQuickActions(overrides: Partial<ComponentProps<typeof QuickActionsModal>> = {}) {
	const props = createProps(overrides);
	render(
		<LayerStackProvider>
			<GitStatusProvider sessions={props.sessions} activeSessionId={props.activeSessionId}>
				<QuickActionsModal {...props} />
			</GitStatusProvider>
		</LayerStackProvider>
	);
	return props;
}

function searchInput() {
	return screen.getByPlaceholderText(/Type a command|Move .* to/i);
}

async function chooseAction(label: RegExp, query: string = '') {
	fireEvent.change(searchInput(), { target: { value: query } });
	const action = await screen.findByRole('button', { name: label });
	fireEvent.click(action);
	return action;
}

function latestMockArg<T>(fn: unknown): T {
	const calls = (fn as ReturnType<typeof vi.fn>).mock.calls;
	expect(calls.length).toBeGreaterThan(0);
	return calls[calls.length - 1][0] as T;
}

describe('QuickActionsModal integration', () => {
	let consoleLogSpy: ReturnType<typeof vi.spyOn>;
	let loggerErrorSpy: ReturnType<typeof vi.spyOn>;
	let loggerWarnSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
		loggerWarnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		useUIStore.setState({
			activeFocus: 'main',
			historySearchFilterOpen: false,
			outputSearchByKey: {},
			sessionFilterOpen: false,
		});
		useFileExplorerStore.setState({ fileTreeFilterOpen: false });
		Object.assign(window.maestro, {
			debug: {
				createPackage: vi.fn().mockResolvedValue({ path: '/tmp/debug.zip', success: true }),
			},
			devtools: {
				toggle: vi.fn(),
			},
		});
		Object.assign(window.maestro.git, {
			diff: vi.fn().mockResolvedValue({ stdout: 'diff --git a/file b/file' }),
			remote: vi.fn().mockResolvedValue({ stdout: 'git@github.com:RunMaestro/Maestro.git' }),
		});
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: {
				writeText: vi.fn().mockResolvedValue(undefined),
			},
		});
		window.maestro.leaderboard.getInstallationId = vi.fn().mockResolvedValue('install-guid-123');
		window.maestro.shell.openExternal = vi.fn().mockResolvedValue(undefined);
	});

	afterEach(() => {
		cleanup();
		consoleLogSpy.mockRestore();
		loggerErrorSpy.mockRestore();
		loggerWarnSpy.mockRestore();
	});

	it('renders, filters, navigates with the keyboard, and moves sessions between groups', async () => {
		const props = renderQuickActions();

		expect(screen.getByRole('dialog', { name: 'Quick Actions' })).toBeInTheDocument();
		expect(searchInput()).toBeInTheDocument();
		expect(screen.getByText('ESC')).toBeInTheDocument();
		expect(screen.getByText('Jump to Parent Agent subagent: Worker Agent')).toBeInTheDocument();
		expect(screen.queryByText('Debug: Reset Busy State')).not.toBeInTheDocument();

		fireEvent.change(searchInput(), { target: { value: 'create new agent' } });
		fireEvent.keyDown(searchInput(), { key: 'Enter' });
		expect(props.addNewSession).toHaveBeenCalled();

		await chooseAction(/Jump to Parent Agent subagent: Worker Agent/i, 'worker');
		expect(props.setActiveSessionId).toHaveBeenCalledWith('child');

		await chooseAction(/^1 Group Chat: Coverage Guild/i, 'coverage guild');
		expect(props.onOpenGroupChat).toHaveBeenCalledWith('chat-1');

		await chooseAction(/Move to Group/i, 'move to group');
		expect(screen.getByPlaceholderText('Move Worker Agent to...')).toBeInTheDocument();
		fireEvent.click(await screen.findByRole('button', { name: /Review Group/i }));
		expect(props.setSessions).toHaveBeenCalledWith(
			expect.arrayContaining([expect.objectContaining({ id: 'child', groupId: 'group-2' })])
		);

		cleanup();
		const moveProps = renderQuickActions({ initialMode: 'move-to-group' });
		expect(screen.queryByRole('button', { name: /Back to main menu/i })).not.toBeInTheDocument();
		expect(screen.getByPlaceholderText('Move Worker Agent to...')).toBeInTheDocument();
		fireEvent.change(searchInput(), { target: { value: 'missing command' } });
		expect(screen.getByText('No actions found')).toBeInTheDocument();
		expect(moveProps.setQuickActionOpen).not.toHaveBeenCalledWith(false);
	});

	it('executes modal, session, tab, context, and panel commands', async () => {
		const props = renderQuickActions();

		await chooseAction(/Rename Agent: Worker Agent/i, 'rename agent');
		expect(props.setRenameInstanceValue).toHaveBeenCalledWith('Worker Agent');
		expect(props.setRenameInstanceModalOpen).toHaveBeenCalledWith(true);

		await chooseAction(/Edit Agent: Worker Agent/i, 'edit agent');
		expect(props.onEditAgent).toHaveBeenCalledWith(activeSession);

		await chooseAction(/Bookmark: Worker Agent/i, 'bookmark');
		expect(props.setSessions).toHaveBeenCalledWith(expect.any(Function));

		await chooseAction(/Rename Group/i, 'rename group');
		expect(props.setRenameGroupId).toHaveBeenCalledWith('group-1');
		expect(props.setRenameGroupValue).toHaveBeenCalledWith('Project Group');
		expect(props.setRenameGroupEmoji).toHaveBeenCalledWith('P');
		expect(props.setRenameGroupModalOpen).toHaveBeenCalledWith(true);

		await chooseAction(/Create New Group/i, 'create new group');
		expect(props.setCreateGroupModalOpen).toHaveBeenCalledWith(true);

		await chooseAction(/Toggle Sidebar/i, 'toggle sidebar');
		expect(props.setLeftSidebarOpen).toHaveBeenCalledWith(expect.any(Function));
		await chooseAction(/Toggle Right Panel/i, 'toggle right panel');
		expect(props.setRightPanelOpen).toHaveBeenCalledWith(expect.any(Function));
		await chooseAction(/Switch AI\/Shell Mode/i, 'switch ai');
		expect(props.toggleInputMode).toHaveBeenCalled();

		await chooseAction(/Tab Switcher/i, 'tab switcher');
		expect(props.onOpenTabSwitcher).toHaveBeenCalled();
		await chooseAction(/Rename Tab/i, 'rename tab');
		expect(props.onRenameTab).toHaveBeenCalled();
		await chooseAction(/Toggle Read-Only Mode/i, 'read-only');
		expect(props.onToggleReadOnlyMode).toHaveBeenCalled();
		await chooseAction(/Toggle Show Thinking/i, 'show thinking');
		expect(props.onToggleTabShowThinking).toHaveBeenCalled();
		await chooseAction(/Toggle Edit\/Preview/i, 'toggle edit');
		expect(props.onToggleMarkdownEditMode).toHaveBeenCalled();

		await chooseAction(/Close All Tabs/i, 'close all');
		expect(props.onCloseAllTabs).toHaveBeenCalled();
		await chooseAction(/Close Other Tabs/i, 'close other');
		expect(props.onCloseOtherTabs).toHaveBeenCalled();
		await chooseAction(/Close Tabs to Left/i, 'tabs to left');
		expect(props.onCloseTabsLeft).toHaveBeenCalled();
		await chooseAction(/Close Tabs to Right/i, 'tabs to right');
		expect(props.onCloseTabsRight).toHaveBeenCalled();

		await chooseAction(/Clear Terminal History/i, 'clear terminal');
		expect(props.onClearActiveTerminal).toHaveBeenCalled();
		await chooseAction(/Remove Agent: Worker Agent/i, 'remove agent');
		expect(props.deleteSession).toHaveBeenCalledWith('child');

		await chooseAction(/^.*Settings/i, 'settings');
		expect(props.setSettingsModalOpen).toHaveBeenCalledWith(true);
		await chooseAction(/Change Theme/i, 'theme');
		expect(props.setSettingsTab).toHaveBeenCalledWith('theme');
		await chooseAction(/Configure Global Environment Variables/i, 'environment');
		expect(props.setSettingsTab).toHaveBeenCalledWith('general');
		await chooseAction(/View Shortcuts/i, 'shortcuts');
		expect(props.setShortcutsHelpOpen).toHaveBeenCalledWith(true);

		await chooseAction(/Start Introductory Tour/i, 'tour');
		expect(props.startTour).toHaveBeenCalled();
		await chooseAction(/View System Logs/i, 'system logs');
		expect(props.setLogViewerOpen).toHaveBeenCalledWith(true);
		await chooseAction(/View System Processes/i, 'processes');
		expect(props.setProcessMonitorOpen).toHaveBeenCalledWith(true);
		await chooseAction(/Usage Dashboard/i, 'usage');
		expect(props.setUsageDashboardOpen).toHaveBeenCalledWith(true);
		await chooseAction(/View Agent Sessions for Worker Agent/i, 'agent sessions');
		expect(props.setActiveAgentSessionId).toHaveBeenCalledWith(null);
		expect(props.setAgentSessionsOpen).toHaveBeenCalledWith(true);

		await chooseAction(/Context: Compact/i, 'compact');
		expect(props.onSummarizeAndContinue).toHaveBeenCalled();
		await chooseAction(/Context: Merge Into/i, 'merge into');
		expect(props.onOpenMergeSession).toHaveBeenCalled();
		await chooseAction(/Context: Send to Agent/i, 'send to agent');
		expect(props.onOpenSendToAgent).toHaveBeenCalled();

		await chooseAction(/Go to Files Tab/i, 'files tab');
		expect(props.setActiveRightTab).toHaveBeenCalledWith('files');
		await chooseAction(/Go to History Tab/i, 'history tab');
		expect(props.setActiveRightTab).toHaveBeenCalledWith('history');
		await chooseAction(/Go to Auto Run Tab/i, 'auto run tab');
		expect(props.setActiveRightTab).toHaveBeenCalledWith('autorun');
	});

	it('executes git, external-link, debug, ecosystem, and search commands', async () => {
		const props = renderQuickActions();

		await chooseAction(/View Git Diff/i, 'git diff');
		await waitFor(() =>
			expect(props.setGitDiffPreview).toHaveBeenCalledWith('diff --git a/file b/file')
		);

		await chooseAction(/View Git Log/i, 'git log');
		expect(props.setGitLogOpen).toHaveBeenCalledWith(true);

		await chooseAction(/Open Repository in Browser/i, 'open repository');
		await waitFor(() =>
			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
				'https://github.com/RunMaestro/Maestro'
			)
		);
		expect(window.maestro.git.remote).toHaveBeenCalledWith('/repo/main-shell', undefined);

		await chooseAction(/Create Pull Request: feature\/integration-coverage/i, 'pull request');
		expect(props.onOpenCreatePR).toHaveBeenCalledWith(activeSession);

		await chooseAction(/Refresh Files, Git, History/i, 'refresh files');
		await waitFor(() => expect(props.onRefreshGitFileState).toHaveBeenCalled());

		await chooseAction(/Toggle JavaScript Console/i, 'javascript console');
		expect(window.maestro.devtools.toggle).toHaveBeenCalled();
		await chooseAction(/About Maestro/i, 'about maestro');
		expect(props.setAboutModalOpen).toHaveBeenCalledWith(true);

		await chooseAction(/Maestro Website/i, 'maestro website');
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
			'https://runmaestro.ai/?theme=dracula'
		);
		await chooseAction(/Documentation and User Guide/i, 'documentation');
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
			'https://docs.runmaestro.ai/?theme=dracula'
		);
		await chooseAction(/Join Discord/i, 'discord');
		expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
			'https://runmaestro.ai/discord?theme=dracula'
		);

		await chooseAction(/Check for Updates/i, 'updates');
		expect(props.setUpdateCheckModalOpen).toHaveBeenCalledWith(true);
		await chooseAction(/Create Debug Package/i, 'debug package');
		expect(props.setDebugPackageModalOpen).toHaveBeenCalledWith(true);

		await chooseAction(/Playbook Exchange/i, 'playbook');
		expect(props.onOpenPlaybookExchange).toHaveBeenCalled();
		await chooseAction(/Maestro Symphony/i, 'symphony');
		expect(props.onOpenSymphony).toHaveBeenCalled();
		await chooseAction(/Director's Notes/i, 'director');
		expect(props.onOpenDirectorNotes).toHaveBeenCalled();
		await chooseAction(/Open Last Document Graph/i, 'last document');
		expect(props.onOpenLastDocumentGraph).toHaveBeenCalled();
		await chooseAction(/Reset Finished Tasks in plan\.md/i, 'reset finished');
		expect(props.onAutoRunResetTasks).toHaveBeenCalled();
		await chooseAction(/Fuzzy File Search/i, 'fuzzy');
		expect(props.setFuzzyFileSearchOpen).toHaveBeenCalledWith(true);
		await chooseAction(/Publish Document as GitHub Gist/i, 'gist');
		expect(props.onPublishGist).toHaveBeenCalled();

		await chooseAction(/New Group Chat/i, 'new group chat');
		expect(props.onNewGroupChat).toHaveBeenCalled();
		await chooseAction(/Close Group Chat/i, 'close group chat');
		expect(props.onCloseGroupChat).toHaveBeenCalled();
		await chooseAction(/Remove Group Chat: Coverage Guild/i, 'remove group chat');
		expect(props.onDeleteGroupChat).toHaveBeenCalledWith('chat-1');

		await chooseAction(/Search: Agents/i, 'search:');
		await waitFor(() => expect(useUIStore.getState().sessionFilterOpen).toBe(true));
		expect(useUIStore.getState().activeFocus).toBe('sidebar');
		await chooseAction(/Search: Message History/i, 'search:');
		await waitFor(() =>
			expect(
				useUIStore.getState().outputSearchByKey[
					outputSearchKeyFor(activeSession.id, activeSession.activeTabId)
				]?.open
			).toBe(true)
		);
		await chooseAction(/Search: Files/i, 'search:');
		await waitFor(() => expect(useFileExplorerStore.getState().fileTreeFilterOpen).toBe(true));
		expect(props.setActiveRightTab).toHaveBeenCalledWith('files');
		await chooseAction(/Search: History/i, 'search:');
		await waitFor(() => expect(useUIStore.getState().historySearchFilterOpen).toBe(true));

		await chooseAction(/Debug: Reset Busy State/i, 'debug');
		expect(props.setSessions).toHaveBeenCalledWith(expect.any(Function));
		await chooseAction(/Debug: Reset Current Session/i, 'debug');
		expect(props.setSessions).toHaveBeenCalledWith(expect.any(Function));
		await chooseAction(/Debug: Log Session State/i, 'debug');
		expect(consoleLogSpy).toHaveBeenCalled();
		await chooseAction(/Debug: Playground/i, 'debug');
		expect(props.setPlaygroundOpen).toHaveBeenCalledWith(true);
		await chooseAction(/Debug: Release Next Queued Item/i, 'debug');
		expect(props.onDebugReleaseQueuedItem).toHaveBeenCalled();
		await chooseAction(/Debug: Wizard .* Review Playbooks/i, 'debug');
		expect(props.setDebugWizardModalOpen).toHaveBeenCalledWith(true);
		await chooseAction(/Debug: Copy Install GUID to Clipboard/i, 'debug');
		await waitFor(() =>
			expect(navigator.clipboard.writeText).toHaveBeenCalledWith('install-guid-123')
		);
	});

	it('handles optional fallback and disabled-state branches', async () => {
		const props = renderQuickActions({
			activeGroupChatId: null,
			ghCliAvailable: false,
			groupChats: [],
			hasActiveSessionCapability: vi.fn().mockReturnValue(false),
			isAiMode: false,
			isFilePreviewOpen: false,
			lastGraphFocusFile: undefined,
			onEditAgent: undefined,
			onOpenCreatePR: undefined,
			setDebugPackageModalOpen: undefined,
			setPlaygroundOpen: undefined,
			sessions: [activeSession],
		});

		expect(screen.queryByText(/Edit Agent/)).not.toBeInTheDocument();
		expect(screen.getByText(/Tab Switcher/)).toBeInTheDocument();
		expect(screen.queryByText(/View Agent Sessions/)).not.toBeInTheDocument();
		expect(screen.queryByText(/Publish Document as GitHub Gist/)).not.toBeInTheDocument();

		await chooseAction(/Create Debug Package/i, 'debug package');
		await waitFor(() => expect(window.maestro.debug.createPackage).toHaveBeenCalled());

		window.maestro.git.remote = vi.fn().mockResolvedValue({ stdout: '' });
		await chooseAction(/Open Repository in Browser/i, 'open repository');
		await waitFor(() => expect(window.maestro.git.remote).toHaveBeenCalled());

		expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('executes session and group state updater callbacks', async () => {
		const props = renderQuickActions();

		await chooseAction(/Jump to Parent Agent subagent: Worker Agent/i, 'worker');
		const expandGroup = latestMockArg<(prev: Group[]) => Group[]>(props.setGroups);
		expect(expandGroup(groups)).toEqual([
			expect.objectContaining({ id: 'group-1', collapsed: false }),
			expect.objectContaining({ id: 'group-2', collapsed: false }),
		]);

		await chooseAction(/Bookmark: Worker Agent/i, 'bookmark');
		const bookmarkUpdater = latestMockArg<(prev: Session[]) => Session[]>(props.setSessions);
		expect(bookmarkUpdater([activeSession, secondAgent])).toEqual([
			expect.objectContaining({ id: 'child', bookmarked: true }),
			expect.objectContaining({ id: 'second', bookmarked: false }),
		]);

		await chooseAction(/Clear Terminal History/i, 'clear terminal');
		expect(props.onClearActiveTerminal).toHaveBeenCalled();

		await chooseAction(/Debug: Reset Busy State/i, 'debug');
		const resetAllUpdater = latestMockArg<(prev: Session[]) => Session[]>(props.setSessions);
		expect(
			resetAllUpdater([
				createSession({
					id: 'busy-1',
					state: 'thinking',
					busySource: 'ai',
					thinkingStartTime: 123,
					currentCycleTokens: 12,
					currentCycleBytes: 34,
					aiTabs: [{ id: 'tab-busy', name: 'Busy', logs: [], state: 'thinking' } as any],
				}),
			])
		).toEqual([
			expect.objectContaining({
				id: 'busy-1',
				state: 'idle',
				busySource: undefined,
				thinkingStartTime: undefined,
				currentCycleTokens: undefined,
				currentCycleBytes: undefined,
				aiTabs: [expect.objectContaining({ id: 'tab-busy', state: 'idle' })],
			}),
		]);

		await chooseAction(/Debug: Reset Current Session/i, 'debug');
		const resetCurrentUpdater = latestMockArg<(prev: Session[]) => Session[]>(props.setSessions);
		expect(
			resetCurrentUpdater([
				createSession({
					id: 'child',
					state: 'thinking',
					busySource: 'ai',
					thinkingStartTime: 123,
					currentCycleTokens: 12,
					currentCycleBytes: 34,
					aiTabs: [{ id: 'tab-child', name: 'Child', logs: [], state: 'thinking' } as any],
				}),
				createSession({ id: 'other', state: 'thinking' }),
			])
		).toEqual([
			expect.objectContaining({
				id: 'child',
				state: 'idle',
				busySource: undefined,
				aiTabs: [expect.objectContaining({ id: 'tab-child', state: 'idle' })],
			}),
			expect.objectContaining({ id: 'other', state: 'thinking' }),
		]);
	});

	it('covers move-to-root, missing active group, and missing active-session fallbacks', async () => {
		const missingGroupSession = createSession({ groupId: 'missing-group' });
		const props = renderQuickActions({
			activeSessionId: missingGroupSession.id,
			sessions: [parentSession, missingGroupSession],
		});

		await chooseAction(/Rename Group/i, 'rename group');
		expect(props.setRenameGroupModalOpen).not.toHaveBeenCalled();

		await chooseAction(/Move to Group/i, 'move to group');
		fireEvent.click(await screen.findByRole('button', { name: /No Group/i }));
		expect(props.setSessions).toHaveBeenCalledWith(
			expect.arrayContaining([expect.objectContaining({ id: 'child', groupId: undefined })])
		);

		cleanup();
		renderQuickActions({ activeSessionId: 'missing', initialMode: 'move-to-group' });
		expect(screen.getByPlaceholderText('Move session to...')).toBeInTheDocument();
	});

	it('handles repository browser and fallback debug package failures', async () => {
		const props = renderQuickActions({ setDebugPackageModalOpen: undefined });

		await chooseAction(/Open Repository in Browser/i, 'open repository');
		await waitFor(() =>
			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith(
				'https://github.com/RunMaestro/Maestro'
			)
		);

		window.maestro.debug.createPackage = vi
			.fn()
			.mockResolvedValueOnce({ success: false, error: 'zip failed' })
			.mockResolvedValueOnce({ success: false, error: 'Cancelled by user' });

		await chooseAction(/Create Debug Package/i, 'debug package');
		await waitFor(() => expect(window.maestro.debug.createPackage).toHaveBeenCalledTimes(1));
		await chooseAction(/Create Debug Package/i, 'debug package');
		await waitFor(() => expect(window.maestro.debug.createPackage).toHaveBeenCalledTimes(2));
		expect(props.setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('handles install GUID missing and rejected clipboard paths', async () => {
		window.maestro.leaderboard.getInstallationId = vi.fn().mockResolvedValueOnce(null);
		renderQuickActions();

		await chooseAction(/Debug: Copy Install GUID to Clipboard/i, 'debug');
		await waitFor(() =>
			expect(loggerWarnSpy).toHaveBeenCalledWith('[Debug] No installation GUID found')
		);

		cleanup();
		window.maestro.leaderboard.getInstallationId = vi
			.fn()
			.mockRejectedValueOnce(new Error('guid lookup failed'));
		renderQuickActions();

		await chooseAction(/Debug: Copy Install GUID to Clipboard/i, 'debug');
		await waitFor(() =>
			expect(loggerErrorSpy).toHaveBeenCalledWith(
				'[Debug] Failed to copy installation GUID:',
				undefined,
				expect.any(Error)
			)
		);
	});

	it('handles escape, scroll tracking, wizard, and panel toggle updater callbacks', async () => {
		const props = renderQuickActions();

		const scrollContainer = document.querySelector('.overflow-y-auto') as HTMLDivElement;
		fireEvent.scroll(scrollContainer, { target: { scrollTop: 156 } });
		fireEvent.keyDown(searchInput(), { key: 'Meta', metaKey: true });

		await chooseAction(/Toggle Sidebar/i, 'toggle sidebar');
		const toggleSidebar = latestMockArg<(open: boolean) => boolean>(props.setLeftSidebarOpen);
		expect(toggleSidebar(true)).toBe(false);

		await chooseAction(/Toggle Right Panel/i, 'toggle right panel');
		const toggleRightPanel = latestMockArg<(open: boolean) => boolean>(props.setRightPanelOpen);
		expect(toggleRightPanel(false)).toBe(true);

		await chooseAction(/New Agent Wizard/i, 'wizard');
		expect(props.openWizard).toHaveBeenCalled();

		await chooseAction(/Move to Group/i, 'move to group');
		expect(screen.getByPlaceholderText('Move Worker Agent to...')).toBeInTheDocument();
		fireEvent.keyDown(window, { key: 'Escape' });
		expect(
			await screen.findByPlaceholderText('Type a command or jump to agent...')
		).toBeInTheDocument();

		fireEvent.keyDown(window, { key: 'Escape' });
		await waitFor(() => expect(props.setQuickActionOpen).toHaveBeenCalledWith(false));
	});
});
