import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockSession } from '../../../../helpers/mockSession';
import { buildAgentPanelCommands } from '../../../../../renderer/components/QuickActionsModal/commands/agentPanelCommands';
import { buildAgentSwitcherCommands } from '../../../../../renderer/components/QuickActionsModal/commands/agentSwitcherCommands';
import { buildActiveTabContextCommands } from '../../../../../renderer/components/QuickActionsModal/commands/contextCommands';
import { buildDebugCommands } from '../../../../../renderer/components/QuickActionsModal/commands/debugCommands';
import {
	buildDelegationGraphCommands,
	delegationGraphGroupCommandId,
} from '../../../../../renderer/components/QuickActionsModal/commands/delegationGraphCommands';
import { buildFeatureCommands } from '../../../../../renderer/components/QuickActionsModal/commands/featureCommands';
import { buildGitWorktreeCommands } from '../../../../../renderer/components/QuickActionsModal/commands/gitWorktreeCommands';
import {
	buildGroupChatCommands,
	buildGroupChatJumpCommands,
	buildGroupChatSwitcherCommands,
} from '../../../../../renderer/components/QuickActionsModal/commands/groupChatCommands';
import { buildMoveToGroupCommands } from '../../../../../renderer/components/QuickActionsModal/commands/moveToGroupCommands';
import { buildNavigationCommands } from '../../../../../renderer/components/QuickActionsModal/commands/navigationCommands';
import { buildRightPanelCommands } from '../../../../../renderer/components/QuickActionsModal/commands/rightPanelCommands';
import { buildSearchCommands } from '../../../../../renderer/components/QuickActionsModal/commands/searchCommands';
import {
	buildSessionJumpCommands,
	buildSessionManagementCommands,
} from '../../../../../renderer/components/QuickActionsModal/commands/sessionCommands';
import {
	buildNewTabCommands,
	buildTabCommands,
} from '../../../../../renderer/components/QuickActionsModal/commands/tabCommands';
import { buildTabGroupCommands } from '../../../../../renderer/components/QuickActionsModal/commands/tabGroupCommands';
import { buildSupportCommands } from '../../../../../renderer/components/QuickActionsModal/commands/supportCommands';
import { createGroupFromTabRefs } from '../../../../../renderer/utils/panelLayout';
import { createMockAITab } from '../../../../helpers/mockTab';
import { useModalStore } from '../../../../../renderer/stores/modalStore';

const noop = () => {};
const setSessions = vi.fn();
const close = vi.fn();

describe('QuickActions command builders', () => {
	it('builds session jump and management commands', () => {
		const session = createMockSession({ id: 's1', name: 'Atlas', bookmarked: true });
		const jump = buildSessionJumpCommands({
			sessions: [session],
			setActiveSessionId: vi.fn(),
			revealJumpTarget: vi.fn(),
		});
		expect(jump[0]).toMatchObject({ id: 'jump-s1', label: 'Jump to: Atlas' });

		const management = buildSessionManagementCommands({
			activeSession: session,
			activeSessionId: 's1',
			sessions: [session],
			setSessions,
			setQuickActionOpen: close,
			setRenameInstanceModalOpen: vi.fn(),
			setRenameInstanceValue: vi.fn(),
			deleteSession: vi.fn(),
			openClearBookmarksConfirm: vi.fn(),
		});
		expect(management.map((a) => a.id)).toContain('toggleBookmark');
		expect(management.map((a) => a.id)).toContain('clearAllBookmarks');
	});

	it('builds agent panel, move-to-group, switcher, and group-chat commands', () => {
		const session = createMockSession({
			id: 's1',
			name: 'Atlas',
			state: 'busy',
			fileTree: [{ name: 'src', path: '/src', type: 'folder', children: [] }] as any,
		});
		expect(
			buildAgentPanelCommands({
				activeSession: session,
				groups: [{ id: 'g1', name: 'Group', emoji: 'G', collapsed: true }],
				sessions: [session],
				setGroups: vi.fn(),
				setSessions,
				setQuickActionOpen: close,
				setRenameGroupModalOpen: vi.fn(),
				setRenameGroupId: vi.fn(),
				setRenameGroupValue: vi.fn(),
				setRenameGroupEmoji: vi.fn(),
				setRenameGroupIcon: vi.fn(),
				setRenameGroupColor: vi.fn(),
				setCreateGroupModalOpen: vi.fn(),
				setRightPanelOpen: vi.fn(),
				setActiveRightTab: vi.fn(),
				setMode: vi.fn(),
				resetSelectionToFirst: vi.fn(),
				ungroupedCollapsed: false,
				setUngroupedCollapsed: vi.fn(),
				bookmarksCollapsed: false,
				setBookmarksCollapsed: vi.fn(),
				groupChatsExpanded: true,
				setGroupChatsExpanded: vi.fn(),
			}).map((a) => a.id)
		).toContain('expandAllFolders');

		expect(
			buildMoveToGroupCommands({
				initialMode: 'main',
				groups: [{ id: 'g1', name: 'Group', emoji: 'G', collapsed: false }],
				handleMoveToGroup: vi.fn(),
				handleCreateGroup: vi.fn(),
				setMode: vi.fn(),
				resetSelectionToFirst: vi.fn(),
			}).map((a) => a.id)
		).toEqual(['back', 'no-group', 'group-g1', 'create-new']);

		expect(
			buildAgentSwitcherCommands({
				sessions: [session],
				activeBatchSessionIds: ['s1'],
				setActiveSessionId: vi.fn(),
				revealJumpTarget: vi.fn(),
			})[0]
		).toMatchObject({ label: 'Atlas', isRunningAgent: true, isInBatch: true });

		expect(
			buildGroupChatJumpCommands({
				groupChats: [{ id: 'chat1', name: 'Squad', participants: ['s1', 's2'] } as any],
				onOpenGroupChat: vi.fn(),
				setQuickActionOpen: close,
			})[0].subtext
		).toBe('2 participants');
		expect(
			buildGroupChatCommands({
				sessions: [session, createMockSession({ id: 's2', toolType: 'codex' })],
				activeGroupChatId: 'chat1',
				groupChats: [{ id: 'chat1', name: 'Squad', participants: [] } as any],
				onNewGroupChat: vi.fn(),
				onCloseGroupChat: vi.fn(),
				onDeleteGroupChat: vi.fn(),
				setQuickActionOpen: close,
			}).map((a) => a.id)
		).toEqual([
			'newGroupChat',
			'closeGroupChat',
			'toggleGroupChatModeratorOnly',
			'deleteGroupChat',
		]);
	});

	it('lists only running group chats in the agent switcher, bucketed live', () => {
		const chats = [
			{ id: 'chat1', name: 'Squad', participants: [] },
			{ id: 'chat2', name: 'Idle Room', participants: [] },
		] as any;
		const onOpenGroupChat = vi.fn();
		const commands = buildGroupChatSwitcherCommands({
			groupChats: chats,
			busySnapshot: {
				activeGroupChatId: 'chat1',
				groupChatState: 'moderator-thinking',
			},
			onOpenGroupChat,
		});

		expect(commands).toHaveLength(1);
		expect(commands[0]).toMatchObject({
			id: 'jump-groupchat-chat1',
			label: 'Group Chat: Squad',
			isRunningAgent: true,
			runningInfo: { state: 'busy', statusLabel: 'Moderator thinking', queueCount: 0 },
		});

		commands[0].action();
		expect(onOpenGroupChat).toHaveBeenCalledWith('chat1');
	});

	it('builds navigation, tab, context, right-panel, and search commands', async () => {
		const session = createMockSession({
			id: 's1',
			name: 'Atlas',
			activeTabId: 'tab-1',
			aiTabs: [
				{ id: 'tab-1', name: 'Tab', logs: [{ id: 'l1' }], agentSessionId: 'provider-1' },
			] as any,
			unifiedTabOrder: [
				{ type: 'ai', id: 'tab-1' },
				{ type: 'file', id: 'file-1' },
			],
		});

		expect(
			buildNavigationCommands({
				activeSession: session,
				activeSessionId: 's1',
				setQuickActionOpen: close,
				setLeftSidebarOpen: vi.fn(),
				setRightPanelOpen: vi.fn(),
				addNewSession: vi.fn(),
				deleteSession: vi.fn(),
				getOpenInLabel: () => 'Open',
				platform: 'darwin',
				openPath: vi.fn(),
				onGoToNextUnread: vi.fn(),
				onGoToPreviousUnread: vi.fn(),
				shortcuts: {},
			}).map((a) => a.id)
		).toEqual(expect.arrayContaining(['nextUnreadTab', 'previousUnreadTab']));

		expect(
			buildNewTabCommands({
				activeSession: session,
				onNewTab: vi.fn(),
				setQuickActionOpen: close,
			}).map((a) => a.id)
		).toEqual(['newAiChat']);
		expect(
			buildTabCommands({
				activeSession: session,
				isAiMode: true,
				activeTabInfo: {
					isTerminalMode: false,
					hasActiveTab: true,
					activeUnifiedIndex: 0,
					unifiedTabCount: 2,
					activeTabType: 'ai',
				},
				enterToSendAI: true,
				onRenameTab: vi.fn(),
				onCloseOtherTabs: vi.fn(),
				setQuickActionOpen: close,
				shortcuts: {},
				toggleInputMode: vi.fn(),
			}).map((a) => a.id)
		).toContain('closeOtherTabs');

		const copied: string[] = [];
		const context = buildActiveTabContextCommands({
			activeSession: session,
			activeSessionId: 's1',
			activeTabType: 'ai',
			ghCliAvailable: true,
			setSessions,
			setQuickActionOpen: close,
			safeClipboardWrite: async (text) => {
				copied.push(text);
				return true;
			},
			flashCopiedToClipboard: vi.fn(),
			onCopyTabContext: vi.fn(),
			onExportTabHtml: vi.fn(),
			onPublishTabGist: vi.fn(),
		});
		await context.find((a) => a.id === 'copySessionId')!.action();
		expect(copied).toContain('provider-1');

		expect(
			buildRightPanelCommands({
				autoRunDisabled: false,
				autoRunSelectedDocument: 'todo.md',
				autoRunCompletedTaskCount: 1,
				setRightPanelOpen: vi.fn(),
				setActiveRightTab: vi.fn(),
				setQuickActionOpen: close,
				onAutoRunResetTasks: vi.fn(),
				shortcuts: {},
			}).map((a) => a.id)
		).toContain('resetAutoRunTasks');

		expect(
			buildSearchCommands({
				setQuickActionOpen: close,
				setLeftSidebarOpen: vi.fn(),
				setRightPanelOpen: vi.fn(),
				setActiveRightTab: vi.fn(),
				setActiveFocus: vi.fn(),
				setSessionFilterOpen: vi.fn(),
				setOutputSearchOpen: vi.fn(),
				setFileTreeFilterOpen: vi.fn(),
				setHistorySearchFilterOpen: vi.fn(),
			}).map((a) => a.id)
		).toEqual(['searchAgents', 'searchMessages', 'searchFiles', 'searchHistory']);
	});

	it('builds tab-type-aware Context / Buffer / Content commands', () => {
		const session = createMockSession({
			id: 's1',
			activeTabId: 'tab-1',
			aiTabs: [{ id: 'tab-1', name: 'Tab', logs: [{ id: 'l1' }], agentSessionId: 'p1' }] as any,
		});
		const baseArgs = {
			activeSession: session,
			activeSessionId: 's1',
			ghCliAvailable: true,
			setSessions,
			setQuickActionOpen: close,
			safeClipboardWrite: async () => true,
			flashCopiedToClipboard: vi.fn(),
			onCopyTabContext: vi.fn(),
			onExportTabHtml: vi.fn(),
			onPublishTabGist: vi.fn(),
		};

		// Terminal tab -> "Buffer" actions routed through the MainPanel handle.
		const sendActiveTerminalBufferToAgent = vi.fn();
		const terminalRef = {
			current: {
				copyActiveTerminalBuffer: vi.fn(),
				sendActiveTerminalBufferToAgent,
				publishActiveTerminalBufferGist: vi.fn(),
			},
		} as any;
		const terminal = buildActiveTabContextCommands({
			...baseArgs,
			activeTabType: 'terminal',
			mainPanelRef: terminalRef,
		});
		expect(terminal.map((a) => a.id)).toEqual([
			'copyTerminalBuffer',
			'sendTerminalBufferToAgent',
			'publishTerminalBufferGist',
		]);
		terminal.find((a) => a.id === 'sendTerminalBufferToAgent')!.action();
		expect(sendActiveTerminalBufferToAgent).toHaveBeenCalled();

		// Browser tab -> "Content" actions, no Gist option.
		const copyActiveBrowserContent = vi.fn();
		const browserRef = {
			current: { copyActiveBrowserContent, sendActiveBrowserContentToAgent: vi.fn() },
		} as any;
		const browser = buildActiveTabContextCommands({
			...baseArgs,
			activeTabType: 'browser',
			mainPanelRef: browserRef,
		});
		expect(browser.map((a) => a.id)).toEqual(['copyBrowserContent', 'sendBrowserContentToAgent']);
		browser.find((a) => a.id === 'copyBrowserContent')!.action();
		expect(copyActiveBrowserContent).toHaveBeenCalled();

		// File previews expose no context/buffer/content actions, and no delete
		// entry either while there is no open preview tab to act on.
		expect(buildActiveTabContextCommands({ ...baseArgs, activeTabType: 'file' })).toEqual([]);

		// ...but an open file preview offers the (confirmed) delete action.
		const fileSession = createMockSession({
			id: 's1',
			inputMode: 'ai',
			activeFileTabId: 'file-1',
			filePreviewTabs: [
				{ id: 'file-1', path: '/repo/notes.md', name: 'notes', extension: '.md' },
			] as any,
		});
		const fileCommands = buildActiveTabContextCommands({
			...baseArgs,
			activeSession: fileSession,
			activeTabType: 'file',
		});
		expect(fileCommands.map((a) => a.id)).toEqual([
			// Chat is offered without the A Cappella flag: typing needs no voice
			// stack, so gating it would take text chat away from a default install.
			'chatWithPreviewedDocument',
			'deletePreviewedFile',
		]);
		expect(fileCommands[0].subtext).toBe('notes.md');

		// A file tab selected while the panel shows a terminal is not a live
		// preview, so the delete entry stays out of the palette.
		expect(
			buildActiveTabContextCommands({
				...baseArgs,
				activeSession: { ...fileSession, inputMode: 'terminal' } as any,
				activeTabType: 'file',
			})
		).toEqual([]);

		// AI-context feature commands (Compact / Merge / Send) hide on non-AI tabs.
		const featureArgs = {
			activeSession: session,
			canSummarizeActiveTab: true,
			hasActiveSessionCapability: () => true,
			setQuickActionOpen: close,
			setSuccessFlashNotification: vi.fn(),
			setAgentSessionsOpen: vi.fn(),
			setActiveAgentSessionId: vi.fn(),
			onSummarizeAndContinue: vi.fn(),
			onOpenMergeSession: vi.fn(),
			onOpenSendToAgent: vi.fn(),
			bionifyReadingMode: false,
			setBionifyReadingMode: vi.fn(),
			audioFeedbackEnabled: false,
			setAudioFeedbackEnabled: vi.fn(),
			idleNotificationEnabled: false,
			setIdleNotificationEnabled: vi.fn(),
			showStarredSessionsSection: true,
			setShowStarredSessionsSection: vi.fn(),
			shortcuts: {},
		};
		const aiFeatureIds = buildFeatureCommands({ ...featureArgs, activeTabType: 'ai' }).map(
			(a) => a.id
		);
		expect(aiFeatureIds).toEqual(
			expect.arrayContaining(['summarizeAndContinue', 'mergeSession', 'sendToAgent'])
		);
		const terminalFeatureIds = buildFeatureCommands({
			...featureArgs,
			activeTabType: 'terminal',
		}).map((a) => a.id);
		// The AgentRun Dashboard is offered only when App hands the opener down,
		// which it does only while the Pianola Encore Feature is on.
		expect(aiFeatureIds).not.toContain('agent-run-dashboard');
		expect(
			buildFeatureCommands({ ...featureArgs, setAgentRunDashboardOpen: vi.fn() }).map((a) => a.id)
		).toContain('agent-run-dashboard');
		expect(terminalFeatureIds).not.toContain('summarizeAndContinue');
		expect(terminalFeatureIds).not.toContain('mergeSession');
		expect(terminalFeatureIds).not.toContain('sendToAgent');
	});

	it('builds git/worktree, feature, support, and debug commands', async () => {
		const session = createMockSession({
			id: 's1',
			name: 'Atlas',
			isGitRepo: true,
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' } as any,
			worktreeBranch: 'feat/test',
			parentSessionId: 'parent',
		});
		// The git entries delegate to useGitAgentActions (exercised in its own
		// suite); here we assert the palette surfaces the whole set and wires
		// each entry to the matching action.
		const gitActions = {
			isGitRepo: true,
			branch: 'feat/test',
			ahead: 2,
			behind: 1,
			canCreatePR: true,
			canConfigureWorktrees: true,
			changes: { fileCount: 5, additions: 206, deletions: 37, modified: 5 },
			viewLog: vi.fn(),
			viewDiff: vi.fn().mockResolvedValue(undefined),
			pull: vi.fn(),
			push: vi.fn(),
			switchBranch: vi.fn(),
			createPR: vi.fn(),
			configureWorktrees: vi.fn(),
		};
		const git = buildGitWorktreeCommands({
			activeSession: session,
			sessions: [createMockSession({ id: 'parent', name: 'Parent' }), session],
			gitActions,
			setQuickActionOpen: close,
			onQuickCreateWorktree: vi.fn(),
			onOpenCreatePR: vi.fn(),
			onRefreshGitFileState: vi.fn(),
			shortcuts: {},
			gitService: { getRemoteBrowserUrl: vi.fn().mockResolvedValue(null) },
			notifyToast: vi.fn(),
			openUrl: vi.fn(),
			logger: { error: vi.fn() },
		});

		// Every git menu entry has a palette equivalent.
		expect(git.map((a) => a.id)).toEqual(
			expect.arrayContaining([
				'gitLog',
				'gitDiff',
				'gitPull',
				'gitPush',
				'changeBranch',
				'createPR',
				'configureWorktrees',
			])
		);

		// The palette says whether the diff has anything in it, like the menu badges.
		expect(git.find((a) => a.id === 'gitDiff')!.subtext).toBe('+206 −37 ~5 in 5 files');

		await git.find((a) => a.id === 'gitDiff')!.action();
		expect(gitActions.viewDiff).toHaveBeenCalled();
		git.find((a) => a.id === 'gitPull')!.action();
		expect(gitActions.pull).toHaveBeenCalled();
		git.find((a) => a.id === 'gitPush')!.action();
		expect(gitActions.push).toHaveBeenCalled();
		git.find((a) => a.id === 'changeBranch')!.action();
		expect(gitActions.switchBranch).toHaveBeenCalled();
		git.find((a) => a.id === 'configureWorktrees')!.action();
		expect(gitActions.configureWorktrees).toHaveBeenCalled();

		expect(
			buildFeatureCommands({
				activeSession: session,
				activeTabType: 'ai',
				canSummarizeActiveTab: true,
				isFilePreviewOpen: true,
				ghCliAvailable: true,
				lastGraphFocusFile: 'README.md',
				hasActiveSessionCapability: () => true,
				setQuickActionOpen: close,
				setSuccessFlashNotification: vi.fn(),
				setAgentSessionsOpen: vi.fn(),
				setActiveAgentSessionId: vi.fn(),
				setMemoryViewerOpen: vi.fn(),
				setFuzzyFileSearchOpen: vi.fn(),
				setUsageDashboardOpen: vi.fn(),
				onSummarizeAndContinue: vi.fn(),
				onOpenMergeSession: vi.fn(),
				onOpenSendToAgent: vi.fn(),
				onOpenQueueBrowser: vi.fn(),
				onOpenPlaybookExchange: vi.fn(),
				onOpenSymphony: vi.fn(),
				onOpenDirectorNotes: vi.fn(),
				onOpenMaestroCue: vi.fn(),
				onConfigureCue: vi.fn(),
				onOpenLastDocumentGraph: vi.fn(),
				onPublishGist: vi.fn(),
				bionifyReadingMode: false,
				setBionifyReadingMode: vi.fn(),
				audioFeedbackEnabled: false,
				setAudioFeedbackEnabled: vi.fn(),
				idleNotificationEnabled: false,
				setIdleNotificationEnabled: vi.fn(),
				showStarredSessionsSection: true,
				setShowStarredSessionsSection: vi.fn(),
				shortcuts: {},
			}).map((a) => a.id)
		).toContain('maestro-cue');

		// "View in Document Graph" appears only when an active markdown file is open,
		// and its action focuses the graph on that file then closes the palette.
		const onOpenCurrentFileInGraph = vi.fn();
		const graphCommands = buildFeatureCommands({
			activeSession: session,
			currentGraphFile: 'NOTES.md',
			onOpenCurrentFileInGraph,
			setQuickActionOpen: close,
			setSuccessFlashNotification: vi.fn(),
			setAgentSessionsOpen: vi.fn(),
			setActiveAgentSessionId: vi.fn(),
			bionifyReadingMode: false,
			setBionifyReadingMode: vi.fn(),
			audioFeedbackEnabled: false,
			setAudioFeedbackEnabled: vi.fn(),
			idleNotificationEnabled: false,
			setIdleNotificationEnabled: vi.fn(),
			showStarredSessionsSection: true,
			setShowStarredSessionsSection: vi.fn(),
			shortcuts: {},
		});
		const viewInGraph = graphCommands.find((a) => a.id === 'viewInDocumentGraph');
		expect(viewInGraph).toBeDefined();
		viewInGraph!.action();
		expect(onOpenCurrentFileInGraph).toHaveBeenCalled();

		// Hidden when no markdown file is active.
		expect(
			buildFeatureCommands({
				activeSession: session,
				onOpenCurrentFileInGraph,
				setQuickActionOpen: close,
				setSuccessFlashNotification: vi.fn(),
				setAgentSessionsOpen: vi.fn(),
				setActiveAgentSessionId: vi.fn(),
				bionifyReadingMode: false,
				setBionifyReadingMode: vi.fn(),
				audioFeedbackEnabled: false,
				setAudioFeedbackEnabled: vi.fn(),
				idleNotificationEnabled: false,
				setIdleNotificationEnabled: vi.fn(),
				showStarredSessionsSection: true,
				setShowStarredSessionsSection: vi.fn(),
				shortcuts: {},
			}).map((a) => a.id)
		).not.toContain('viewInDocumentGraph');

		const supportIds = buildSupportCommands({
			setQuickActionOpen: close,
			setSettingsModalOpen: vi.fn(),
			setSettingsTab: vi.fn(),
			setShortcutsHelpOpen: vi.fn(),
			setAboutModalOpen: vi.fn(),
			onOpenLeaderboardRegistration: vi.fn(),
			isLeaderboardRegistered: false,
			setFeedbackModalOpen: vi.fn(),
			setLogViewerOpen: vi.fn(),
			setProcessMonitorOpen: vi.fn(),
			setUpdateCheckModalOpen: vi.fn(),
			setDebugPackageModalOpen: vi.fn(),
			getFeedbackDraft: () => ({ isMinimized: false, setMinimized: vi.fn() }),
			createDebugPackage: vi.fn(),
			notifyToast: vi.fn(),
			openUrl: vi.fn(),
			toggleDevtools: vi.fn(),
			shortcuts: {},
		}).map((a) => a.id);
		expect(supportIds).toContain('createDebugPackage');
		expect(supportIds).toContain('leaderboard');

		const debugCommandIds = buildDebugCommands({
			activeSession: createMockSession({
				executionQueue: [{ type: 'message', text: 'x' }] as any,
			}),
			activeSessionId: 'session-1',
			sessions: [createMockSession()],
			setSessions,
			setQuickActionOpen: close,
			setPlaygroundOpen: vi.fn(),
			setDebugApplicationStatsOpen: vi.fn(),
			setDebugAgentProbeOpen: vi.fn(),
			onDebugReleaseQueuedItem: vi.fn(),
			getInstallationId: vi.fn().mockResolvedValue('install-1'),
			safeClipboardWrite: vi.fn().mockResolvedValue(true),
			flashCopiedToClipboard: vi.fn(),
			notifyToast: vi.fn(),
			logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		}).map((a) => a.id);
		expect(debugCommandIds).toContain('debugReleaseQueued');
		expect(debugCommandIds).toContain('debugAgentProbe');
	});

	describe('buildTabGroupCommands', () => {
		const groupSession = (activeGroupId: string | null) => {
			const group = createGroupFromTabRefs(
				[
					{ type: 'ai', id: 'tab-a' },
					{ type: 'ai', id: 'tab-b' },
				],
				'My Group'
			);
			const session = createMockSession({
				id: 's1',
				tabGroups: [group],
				activeGroupId: activeGroupId === 'match' ? group.id : activeGroupId,
			});
			return { session, group };
		};

		it('emits no commands when not under a tab group', () => {
			const { session } = groupSession(null);
			expect(buildTabGroupCommands({ activeSession: session, setQuickActionOpen: close })).toEqual(
				[]
			);
		});

		it('emits no commands when activeGroupId does not resolve to a group', () => {
			const { session } = groupSession('missing-group');
			expect(buildTabGroupCommands({ activeSession: session, setQuickActionOpen: close })).toEqual(
				[]
			);
		});

		it('emits rename and break-apart when under a tab group', () => {
			const { session } = groupSession('match');
			const ids = buildTabGroupCommands({
				activeSession: session,
				setQuickActionOpen: close,
			}).map((a) => a.id);
			expect(ids).toEqual(['renameTabGroup', 'breakApartTabGroup']);
		});
	});
});

// Command-K agent-switching must respect window ownership (Phase 5, task 7):
// picking an agent owned by another window focuses that window instead of
// yanking the agent into this one. Both the main-mode "Jump to: X" list and the
// dedicated agents-mode switcher route through the shared makeAgentJumpAction.
describe('agent-switch window scoping', () => {
	const focusWindow = vi.mocked(window.maestro.windows.focusWindow);

	beforeEach(() => {
		focusWindow.mockClear();
	});

	it('jumps locally when no window context is provided (single-window default)', () => {
		const session = createMockSession({ id: 's1', name: 'Atlas' });
		const setActiveSessionId = vi.fn();
		const revealJumpTarget = vi.fn();

		buildSessionJumpCommands({
			sessions: [session],
			setActiveSessionId,
			revealJumpTarget,
		})[0].action();

		expect(setActiveSessionId).toHaveBeenCalledWith('s1');
		expect(revealJumpTarget).toHaveBeenCalledWith(session);
		expect(focusWindow).not.toHaveBeenCalled();
	});

	it('jumps locally when this window owns the agent (getSessionWindow returns null)', () => {
		const session = createMockSession({ id: 's1', name: 'Atlas' });
		const setActiveSessionId = vi.fn();
		const revealJumpTarget = vi.fn();

		buildSessionJumpCommands({
			sessions: [session],
			setActiveSessionId,
			revealJumpTarget,
			getSessionWindow: () => null,
		})[0].action();

		expect(setActiveSessionId).toHaveBeenCalledWith('s1');
		expect(revealJumpTarget).toHaveBeenCalledWith(session);
		expect(focusWindow).not.toHaveBeenCalled();
	});

	it('focuses the owning window (no local switch) when another window owns the agent', () => {
		const session = createMockSession({ id: 's1', name: 'Atlas' });
		const setActiveSessionId = vi.fn();
		const revealJumpTarget = vi.fn();

		buildSessionJumpCommands({
			sessions: [session],
			setActiveSessionId,
			revealJumpTarget,
			getSessionWindow: (id) => (id === 's1' ? { windowId: 'win-2', windowNumber: 2 } : null),
		})[0].action();

		expect(focusWindow).toHaveBeenCalledWith('win-2');
		expect(setActiveSessionId).not.toHaveBeenCalled();
		expect(revealJumpTarget).not.toHaveBeenCalled();
	});

	it('agents-mode switcher: switches locally for an owned agent', () => {
		const session = createMockSession({ id: 's1', name: 'Atlas' });
		const setActiveSessionId = vi.fn();
		const revealJumpTarget = vi.fn();

		buildAgentSwitcherCommands({
			sessions: [session],
			activeBatchSessionIds: [],
			setActiveSessionId,
			revealJumpTarget,
			getSessionWindow: () => null,
		})[0].action();

		expect(setActiveSessionId).toHaveBeenCalledWith('s1');
		expect(revealJumpTarget).toHaveBeenCalledWith(session);
		expect(focusWindow).not.toHaveBeenCalled();
	});

	it('agents-mode switcher: focuses the owning window for a remote agent', () => {
		const session = createMockSession({ id: 's1', name: 'Atlas' });
		const setActiveSessionId = vi.fn();
		const revealJumpTarget = vi.fn();

		buildAgentSwitcherCommands({
			sessions: [session],
			activeBatchSessionIds: [],
			setActiveSessionId,
			revealJumpTarget,
			getSessionWindow: () => ({ windowId: 'win-3', windowNumber: 3 }),
		})[0].action();

		expect(focusWindow).toHaveBeenCalledWith('win-3');
		expect(setActiveSessionId).not.toHaveBeenCalled();
		expect(revealJumpTarget).not.toHaveBeenCalled();
	});
	it('offers the model/effort picker for an AI tab and targets the focused pane', () => {
		const session = createMockSession({
			id: 's1',
			aiTabs: [createMockAITab({ id: 'tab-1' }), createMockAITab({ id: 'tab-2' })],
			activeTabId: 'tab-1',
		});
		const args = {
			activeSession: session,
			isAiMode: true,
			activeTabInfo: {
				isTerminalMode: false,
				hasActiveTab: true,
				activeUnifiedIndex: 0,
				unifiedTabCount: 2,
				activeTabType: 'ai' as const,
			},
			enterToSendAI: true,
			setQuickActionOpen: close,
			shortcuts: {},
			toggleInputMode: vi.fn(),
		};

		const command = buildTabCommands(args).find((a) => a.id === 'changeModelEffort');
		expect(command?.label).toBe('Change Tabs Model and Effort');
		command!.action();
		expect(useModalStore.getState().modals.get('modelEffort')).toMatchObject({
			open: true,
			data: { tabId: 'tab-1' },
		});

		// A tiled group owns the panel: the focused pane wins over the standalone
		// tab hidden behind it.
		useModalStore.getState().closeModal('modelEffort');
		const group = createGroupFromTabRefs([
			{ type: 'ai', id: 'tab-2' },
			{ type: 'ai', id: 'tab-1' },
		]);
		const grouped = createMockSession({
			...session,
			tabGroups: [group],
			activeGroupId: group.id,
		});
		buildTabCommands({ ...args, activeSession: grouped })
			.find((a) => a.id === 'changeModelEffort')!
			.action();
		expect(useModalStore.getState().modals.get('modelEffort')?.data).toMatchObject({
			tabId: 'tab-2',
		});
	});

	// A group chat has no model of its own, and opening one does not clear
	// `activeSession` - it still points at whichever agent was selected before the
	// room was opened. So the entry has to be ABSENT, not merely inert: left in
	// place it resolved a live target and retuned a background agent's tab.
	it('withholds the model/effort picker while a group chat owns the view', () => {
		const session = createMockSession({
			id: 's1',
			aiTabs: [createMockAITab({ id: 'tab-1' })],
			activeTabId: 'tab-1',
		});
		const args = {
			activeSession: session,
			isAiMode: true,
			activeTabInfo: {
				isTerminalMode: false,
				hasActiveTab: true,
				activeUnifiedIndex: 0,
				unifiedTabCount: 1,
				activeTabType: 'ai' as const,
			},
			enterToSendAI: true,
			setQuickActionOpen: close,
			shortcuts: {},
			toggleInputMode: vi.fn(),
		};

		expect(buildTabCommands(args).find((a) => a.id === 'changeModelEffort')).toBeDefined();
		expect(
			buildTabCommands({ ...args, activeGroupChatId: 'chat-1' }).find(
				(a) => a.id === 'changeModelEffort'
			)
		).toBeUndefined();
	});

	// The count in "Close all N tabs" has to match what a close-all actually takes
	// out, and hidden consult tabs survive it.
	it('counts only visible tabs in the Close All Tabs subtext', () => {
		const session = createMockSession({
			id: 's1',
			aiTabs: [
				createMockAITab({ id: 'tab-1' }),
				createMockAITab({ id: 'tab-2' }),
				createMockAITab({ id: 'consult', hidden: true }),
			],
			activeTabId: 'tab-1',
		});

		const command = buildTabCommands({
			activeSession: session,
			isAiMode: true,
			activeTabInfo: {
				isTerminalMode: false,
				hasActiveTab: true,
				activeUnifiedIndex: 0,
				unifiedTabCount: 2,
				activeTabType: 'ai',
			},
			enterToSendAI: true,
			onCloseAllTabs: vi.fn(),
			setQuickActionOpen: vi.fn(),
			shortcuts: {},
			toggleInputMode: vi.fn(),
		}).find((a) => a.id === 'closeAllTabs');

		expect(command?.subtext).toBe('Close all 2 tabs');
	});

	// An agent whose only other tabs are hidden consults has one closable tab, so
	// the entry must not offer to close a plural it cannot reach.
	it('omits Close All Tabs when every tab is a hidden consult', () => {
		const session = createMockSession({
			id: 's1',
			aiTabs: [createMockAITab({ id: 'consult', hidden: true })],
			activeTabId: 'consult',
		});

		const ids = buildTabCommands({
			activeSession: session,
			isAiMode: true,
			activeTabInfo: {
				isTerminalMode: false,
				hasActiveTab: true,
				activeUnifiedIndex: 0,
				unifiedTabCount: 0,
				activeTabType: 'ai',
			},
			enterToSendAI: true,
			onCloseAllTabs: vi.fn(),
			setQuickActionOpen: vi.fn(),
			shortcuts: {},
			toggleInputMode: vi.fn(),
		}).map((a) => a.id);

		expect(ids).not.toContain('closeAllTabs');
	});

	it('hides the model/effort picker when the active tab is not an AI tab', () => {
		const session = createMockSession({
			id: 's1',
			aiTabs: [createMockAITab({ id: 'tab-1' })],
			activeTabId: 'tab-1',
			inputMode: 'terminal',
			activeTerminalTabId: 'term-1',
		});

		const ids = buildTabCommands({
			activeSession: session,
			isAiMode: false,
			activeTabInfo: {
				isTerminalMode: true,
				hasActiveTab: true,
				activeUnifiedIndex: 0,
				unifiedTabCount: 1,
				activeTabType: 'terminal',
			},
			enterToSendAI: true,
			setQuickActionOpen: close,
			shortcuts: {},
			toggleInputMode: vi.fn(),
		}).map((a) => a.id);

		expect(ids).not.toContain('changeModelEffort');
	});
});

describe('buildTabCommands: Tab Cleanup Suggestions', () => {
	const args = {
		activeSession: createMockSession({ id: 's1' }),
		isAiMode: true,
		activeTabInfo: {
			isTerminalMode: false,
			hasActiveTab: false,
			activeUnifiedIndex: -1,
			unifiedTabCount: 0,
			activeTabType: null,
		},
		enterToSendAI: true,
		shortcuts: {},
		toggleInputMode: vi.fn(),
	};

	it('opens the modal and closes the palette', () => {
		const setQuickActionOpen = vi.fn();
		const command = buildTabCommands({ ...args, setQuickActionOpen }).find(
			(a) => a.id === 'tabCleanupSuggestions'
		);

		expect(command?.label).toBe('Tab Cleanup Suggestions');
		try {
			command!.action();
			expect(setQuickActionOpen).toHaveBeenCalledWith(false);
			expect(useModalStore.getState().isOpen('tabCleanup')).toBe(true);
		} finally {
			useModalStore.getState().closeModal('tabCleanup');
		}
	});

	it('shows the chord the user bound, and none by default', () => {
		const bound = { id: 'tabCleanupSuggestions', label: 'Tab Cleanup Suggestions', keys: ['k'] };
		const find = (shortcuts: Record<string, unknown>) =>
			buildTabCommands({ ...args, setQuickActionOpen: vi.fn(), shortcuts }).find(
				(a) => a.id === 'tabCleanupSuggestions'
			);

		expect(find({})?.shortcut).toBeUndefined();
		expect(find({ tabCleanupSuggestions: bound })?.shortcut).toBe(bound);
	});
});

describe('buildSupportCommands: Models settings', () => {
	it('opens Settings on the Models tab and closes the palette', () => {
		const setQuickActionOpen = vi.fn();
		const setSettingsModalOpen = vi.fn();
		const setSettingsTab = vi.fn();
		const commands = buildSupportCommands({
			setQuickActionOpen,
			setSettingsModalOpen,
			setSettingsTab,
			setShortcutsHelpOpen: vi.fn(),
			setAboutModalOpen: vi.fn(),
			onOpenLeaderboardRegistration: vi.fn(),
			isLeaderboardRegistered: false,
			setFeedbackModalOpen: vi.fn(),
			setLogViewerOpen: vi.fn(),
			setProcessMonitorOpen: vi.fn(),
			getFeedbackDraft: () => ({ isMinimized: false, setMinimized: vi.fn() }),
			createDebugPackage: vi.fn(),
			notifyToast: vi.fn(),
			openUrl: vi.fn(),
			toggleDevtools: vi.fn(),
			shortcuts: {},
		});

		const entry = commands.find((c) => c.id === 'openLocalModelsSettings');
		expect(entry?.label).toBe('Open Models Settings');
		entry!.action();

		expect(setSettingsModalOpen).toHaveBeenCalledWith(true);
		expect(setSettingsTab).toHaveBeenCalledWith('models');
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
	});
});

describe('Group Settings command', () => {
	const setQuickActionOpen = vi.fn();

	function build(group: Record<string, unknown> | null, groupId: string | undefined = 'g1') {
		return buildAgentPanelCommands({
			activeSession: createMockSession({ id: 's1', groupId }),
			groups: group ? [{ id: 'g1', name: 'Backend', emoji: '🚀', collapsed: false, ...group }] : [],
			sessions: [],
			setGroups: vi.fn(),
			setSessions,
			setQuickActionOpen,
			setRenameGroupModalOpen: vi.fn(),
			setRenameGroupId: vi.fn(),
			setRenameGroupValue: vi.fn(),
			setRenameGroupEmoji: vi.fn(),
			setRenameGroupIcon: vi.fn(),
			setRenameGroupColor: vi.fn(),
			setCreateGroupModalOpen: vi.fn(),
			setRightPanelOpen: vi.fn(),
			setActiveRightTab: vi.fn(),
			setMode: vi.fn(),
			resetSelectionToFirst: vi.fn(),
			ungroupedCollapsed: false,
			setUngroupedCollapsed: vi.fn(),
			bookmarksCollapsed: false,
			setBookmarksCollapsed: vi.fn(),
			groupChatsExpanded: true,
			setGroupChatsExpanded: vi.fn(),
		});
	}

	beforeEach(() => {
		setQuickActionOpen.mockClear();
		useModalStore.getState().closeModal('groupSettings');
	});

	it("sits directly after Rename Group and names the active agent's group", () => {
		const ids = build({}).map((command) => command.id);
		expect(ids.indexOf('groupSettings')).toBe(ids.indexOf('renameGroup') + 1);

		const command = build({}).find((entry) => entry.id === 'groupSettings');
		expect(command).toMatchObject({
			label: 'Group Settings',
			subtext: 'Defaults for new agents in 🚀 Backend',
		});
	});

	it('opens Group Settings on that group and closes the palette', () => {
		build({})
			.find((entry) => entry.id === 'groupSettings')
			?.action();

		expect(useModalStore.getState().isOpen('groupSettings')).toBe(true);
		expect(useModalStore.getState().getData('groupSettings')).toEqual({ groupId: 'g1' });
		expect(setQuickActionOpen).toHaveBeenCalledWith(false);
	});

	it('is absent for a worktree group, by kind or by the worktree emoji', () => {
		expect(build({ kind: 'worktree' }).map((command) => command.id)).not.toContain('groupSettings');
		expect(build({ emoji: '🌳' }).map((command) => command.id)).not.toContain('groupSettings');
		// Rename Group has no such gate.
		expect(build({ kind: 'worktree' }).map((command) => command.id)).toContain('renameGroup');
	});

	it('is absent when the active agent is in no group, or in one that no longer exists', () => {
		expect(build({}, '').map((command) => command.id)).not.toContain('groupSettings');
		expect(build(null).map((command) => command.id)).not.toContain('groupSettings');
	});
});

describe('buildDelegationGraphCommands', () => {
	it('opens the Delegation Graph on every agent and closes the palette', () => {
		const setQuickActionOpen = vi.fn();
		const [command] = buildDelegationGraphCommands({ setQuickActionOpen });

		expect(command.label).toBe('Delegation Graph');
		try {
			command.action();
			expect(setQuickActionOpen).toHaveBeenCalledWith(false);
			expect(useModalStore.getState().isOpen('delegationGraph')).toBe(true);
			// No scope: the graph opens on every agent.
			expect(useModalStore.getState().getData('delegationGraph')).toBeUndefined();
		} finally {
			useModalStore.getState().closeModal('delegationGraph');
		}
	});

	it('shows the chord the user bound, and none by default', () => {
		const bound = { id: 'openDelegationGraph', label: 'Delegation Graph', keys: ['y'] };

		expect(buildDelegationGraphCommands({ setQuickActionOpen: vi.fn() })[0].shortcut).toBe(
			undefined
		);
		expect(
			buildDelegationGraphCommands({
				setQuickActionOpen: vi.fn(),
				openDelegationGraphShortcut: bound,
			})[0].shortcut
		).toBe(bound);
	});

	describe('one command per group', () => {
		const PLATFORM = { id: 'g-platform', name: 'Platform', emoji: '' };
		const RESEARCH = { id: 'g-research', name: 'Research', emoji: '🔬' };
		const bound = { id: 'openDelegationGraph', label: 'Delegation Graph', keys: ['y'] };

		it('adds none when there is no group', () => {
			expect(buildDelegationGraphCommands({ setQuickActionOpen: vi.fn() })).toHaveLength(1);
			expect(
				buildDelegationGraphCommands({ setQuickActionOpen: vi.fn(), groups: [] })
			).toHaveLength(1);
		});

		it('follows the all-agents command, in the order the scope picker lists groups', () => {
			const commands = buildDelegationGraphCommands({
				setQuickActionOpen: vi.fn(),
				// Given out of order, and the emoji must not decide the order.
				groups: [RESEARCH, PLATFORM],
			});

			expect(commands.map((command) => command.id)).toEqual([
				'openDelegationGraph',
				delegationGraphGroupCommandId(PLATFORM.id),
				delegationGraphGroupCommandId(RESEARCH.id),
			]);
			expect(commands.map((command) => command.label)).toEqual([
				'Delegation Graph',
				'Delegation Graph: Platform',
				'Delegation Graph: 🔬 Research',
			]);
		});

		it('opens the graph on that group and closes the palette', () => {
			const setQuickActionOpen = vi.fn();
			const commands = buildDelegationGraphCommands({
				setQuickActionOpen,
				groups: [PLATFORM, RESEARCH],
			});
			const research = commands.find(
				(command) => command.id === delegationGraphGroupCommandId(RESEARCH.id)
			)!;

			try {
				research.action();
				expect(setQuickActionOpen).toHaveBeenCalledWith(false);
				expect(useModalStore.getState().isOpen('delegationGraph')).toBe(true);
				expect(useModalStore.getState().getData('delegationGraph')).toEqual({
					scope: { kind: 'group', groupId: RESEARCH.id },
				});
			} finally {
				useModalStore.getState().closeModal('delegationGraph');
			}
		});

		it('still opens on every agent from the first command', () => {
			const [all] = buildDelegationGraphCommands({
				setQuickActionOpen: vi.fn(),
				groups: [PLATFORM],
			});

			try {
				all.action();
				expect(useModalStore.getState().getData('delegationGraph')).toBeUndefined();
			} finally {
				useModalStore.getState().closeModal('delegationGraph');
			}
		});

		it('keeps the chord on the all-agents command only', () => {
			const commands = buildDelegationGraphCommands({
				setQuickActionOpen: vi.fn(),
				openDelegationGraphShortcut: bound,
				groups: [PLATFORM],
			});

			expect(commands[0].shortcut).toBe(bound);
			expect(commands[1].shortcut).toBeUndefined();
		});

		it('gives every group its own id, so two groups with one name are two commands', () => {
			const commands = buildDelegationGraphCommands({
				setQuickActionOpen: vi.fn(),
				groups: [PLATFORM, { ...PLATFORM, id: 'g-platform-2' }],
			});

			expect(new Set(commands.map((command) => command.id)).size).toBe(3);
		});
	});
});
