import React, {
	useRef,
	useCallback,
	useMemo,
	useState,
	useEffect,
	forwardRef,
	useImperativeHandle,
} from 'react';
import { Wand2 } from 'lucide-react';
import { LogViewer } from '../LogViewer';
import { FilePreviewHandle } from '../FilePreview';
import { ErrorBoundary } from '../ErrorBoundary';
import { AgentSessionsBrowser } from '../AgentSessionsBrowser';
import { MemoryViewer } from '../MemoryViewer';
import { TabBar } from '../TabBar';
import type { BrowserTabViewHandle } from './BrowserTabView';
import { gitService } from '../../services/git';
import { useAgentCapabilities } from '../../hooks';
import { useUIStore } from '../../stores/uiStore';
import { useSessionStore, selectActiveSession, updateSessionWith } from '../../stores/sessionStore';
import { useTabStore } from '../../stores/tabStore';
import { getTabDerivedState } from '../../hooks/tabs/useTabHandlers';
import {
	breakApartGroup,
	collectLeafTabRefs,
	generateGroupName,
	resolveTabRefTitle,
} from '../../utils/panelLayout';
import { useSettingsStore } from '../../stores/settingsStore';
import { notifyCenterFlash } from '../../stores/centerFlashStore';
import { useTerminalMounting } from '../../hooks/terminal/useTerminalMounting';
import { useCoworkingBufferResponder } from '../../hooks/coworking/useCoworkingBufferResponder';
import { useCoworkingRegistrySync } from '../../hooks/coworking/useCoworkingRegistrySync';
import { useCoworkingBrowserResponder } from '../../hooks/coworking/useCoworkingBrowserResponder';
import { getTerminalTabDisplayName } from '../../utils/terminalTabHelpers';
import {
	aiTabFocusFields,
	computeQueuedTabIds,
	computeUnreadGroupIds,
	focusAiTabInSession,
} from '../../utils/tabHelpers';
import { readEffortFromConfig } from '../../utils/agentEffort';
import { useSshRemoteName } from '../../hooks/mainPanel/useSshRemoteName';
import { useContextWindow } from '../../hooks/mainPanel/useContextWindow';
import { useFilePreviewHandlers } from '../../hooks/mainPanel/useFilePreviewHandlers';
import { useGitInfo } from '../../hooks/mainPanel/useGitInfo';
import { useChatFileDropZone } from '../../hooks/ui/useChatFileDropZone';
import { MainPanelHeader } from './MainPanelHeader';
import { MainPanelContent } from './MainPanelContent';
import { AgentErrorBanner } from './AgentErrorBanner';
import { PianolaDashboard } from '../PianolaDashboard';
import { PianolaDashboardTab } from '../PianolaDashboard/PianolaTabControls';
import { CoworkingApprovalHost } from '../coworking/CoworkingApprovalHost';
import { CoworkingBackgroundBrowsers } from '../coworking/CoworkingBackgroundBrowsers';
import { useWindowOwnsSession } from '../../contexts/WindowContext';
import type { PaneTabActions } from './TiledLayout';
import type { Theme, UnifiedTabRef } from '../../types';
import type { MainPanelHandle, MainPanelProps } from './types';

/**
 * Empty placeholder shown when this window has no agent to display - either no
 * agent is active, or the active agent now lives in another window (multi-window
 * scoping). Kept module-scope so both the "no active session" and "active agent
 * owned elsewhere" branches render the identical clean state.
 */
function EmptyMainPanel({ theme }: { theme: Theme }) {
	return (
		<div
			className="flex-1 flex flex-col items-center justify-center min-w-0 relative opacity-30"
			style={{ backgroundColor: theme.colors.bgMain }}
		>
			<Wand2 className="w-16 h-16 mb-4" style={{ color: theme.colors.textDim }} />
			<p className="text-sm" style={{ color: theme.colors.textDim }}>
				No agents. Create one to get started.
			</p>
		</div>
	);
}

// PERFORMANCE: Wrap with React.memo to prevent re-renders when parent (App.tsx) re-renders
// due to input value changes. The component will only re-render when its props actually change.
export const MainPanel = React.memo(
	forwardRef<MainPanelHandle, MainPanelProps>(function MainPanel(props, ref) {
		// PERF: Self-source the full active Session so streaming log/token updates
		// re-render MainPanel without requiring MaestroConsoleInner to re-render.
		const activeSession = useSessionStore(selectActiveSession);

		const {
			logViewerOpen,
			agentSessionsOpen,
			memoryViewerOpen,
			activeAgentSessionId,
			theme,
			stagedImages,
			commandHistoryOpen,
			commandHistoryFilter,
			commandHistorySelectedIndex,
			slashCommandOpen,
			slashCommands,
			selectedSlashCommandIndex,
			tabCompletionOpen,
			tabCompletionSuggestions,
			selectedTabCompletionIndex,
			tabCompletionFilter,
			setTabCompletionOpen,
			setSelectedTabCompletionIndex,
			setTabCompletionFilter,
			atMentionOpen,
			atMentionFilter,
			atMentionStartIndex,
			atMentionItems,
			atMentionCounts,
			atMentionCategory,
			selectedAtMentionIndex,
			setAtMentionOpen,
			setAtMentionFilter,
			setAtMentionStartIndex,
			setSelectedAtMentionIndex,
			setAtMentionCategory,
			setGitDiffPreview,
			setLogViewerOpen,
			setAgentSessionsOpen,
			setMemoryViewerOpen,
			setActiveAgentSessionId,
			onResumeAgentSession,
			onNewAgentSession,
			setInputValue,
			setStagedImages,
			setLightboxImage,
			setCommandHistoryOpen,
			setCommandHistoryFilter,
			setCommandHistorySelectedIndex,
			setSlashCommandOpen,
			setSelectedSlashCommandIndex,
			setGitLogOpen,
			inputRef,
			logsEndRef,
			terminalOutputRef,
			toggleInputMode,
			processInput,
			handleInterrupt,
			handleInputKeyDown,
			handlePaste,
			handleDrop,
			getContextColor,
			setActiveSessionId,
			currentSessionBatchState,
			onStopBatchRun,
			onRemoveQueuedItem,
			onTogglePauseQueuedItem,
			onEditQueuedItem,
			onReorderQueuedItem,
			onForceSendQueuedItem,
			forcedParallelEnabled,
			getForceSendContext,
			onOpenQueueBrowser,
			isMobileLandscape = false,
			showFlashNotification,
			onOpenWorktreeConfig,
			onOpenCreatePR,
			isWorktreeChild,
			onSummarizeAndContinue,
			onMergeWith,
			onSendToAgent,
			onCopyContext,
			onExportHtml,
			// Summarization progress props
			summarizeProgress,
			summarizeResult,
			summarizeStartTime = 0,
			isSummarizing = false,
			onCancelSummarize,
			// Merge progress props
			mergeProgress,
			mergeResult,
			mergeStartTime = 0,
			isMerging = false,
			mergeSourceName,
			mergeTargetName,
			onCancelMerge,
			// Inline wizard exit handler
			onExitWizard,
		} = props;

		// Phase 3C: Direct store subscriptions (migrated from props)
		const logLevel = useSettingsStore((s) => s.logLevel);
		const logViewerSelectedLevels = useSettingsStore((s) => s.logViewerSelectedLevels);
		const colorBlindMode = useSettingsStore((s) => s.colorBlindMode);
		const contextWarningsEnabled = useSettingsStore(
			(s) => s.contextManagementSettings.contextWarningsEnabled ?? false
		);
		const contextWarningYellowThreshold = useSettingsStore(
			(s) => s.contextManagementSettings.contextWarningYellowThreshold ?? 60
		);
		const contextWarningRedThreshold = useSettingsStore(
			(s) => s.contextManagementSettings.contextWarningRedThreshold ?? 80
		);
		const showUnreadOnly = useUIStore((s) => s.showUnreadOnly);

		// Pianola workspace: the pinned Chat/Dashboard view toggle and a live count
		// of agents waiting on the user (badged on the Dashboard tab).
		const pianolaView = useUIStore((s) => s.pianolaView);
		const setPianolaView = useUIStore((s) => s.setPianolaView);
		const pianolaNeedsInputCount = useSessionStore(
			(s) =>
				s.sessions.filter((x) => !x.isPianola && !x.parentSessionId && x.state === 'waiting_input')
					.length
		);

		// isCurrentSessionAutoMode: THIS session has active batch run (for all UI indicators)
		const isCurrentSessionAutoMode = currentSessionBatchState?.isRunning || false;
		const isCurrentSessionStopping = currentSessionBatchState?.isStopping || false;

		// Pianola uses the standard multi-type TabBar. Selecting or creating ANY
		// tab must leave the pinned Dashboard view and show that tab's content, so
		// wrap the tab handlers to flip pianolaView→'chat' first. Memoized to keep
		// TabBar's React.memo effective (stable identities across renders).
		const pianolaTabHandlers = useMemo(() => {
			// Required handlers stay functions (safe no-op if the raw prop is
			// missing); optional handlers preserve `undefined` so NewTabPopover
			// doesn't show dead File/Browser/Terminal actions.
			const req =
				<A extends unknown[]>(fn?: (...a: A) => void) =>
				(...a: A) => {
					setPianolaView('chat');
					fn?.(...a);
				};
			const opt = <A extends unknown[]>(fn?: (...a: A) => void) =>
				fn
					? (...a: A) => {
							setPianolaView('chat');
							fn(...a);
						}
					: undefined;
			return {
				onTabSelect: req(props.onTabSelect),
				onNewTab: req(props.onNewTab),
				onNewFileTab: opt(props.onNewFileTab),
				onNewBrowserTab: opt(props.onNewBrowserTab),
				onNewTerminalTab: opt(props.onNewTerminalTab),
				onFileTabSelect: opt(props.onFileTabSelect),
				onBrowserTabSelect: opt(props.onBrowserTabSelect),
				onTerminalTabSelect: opt(props.onTerminalTabSelect),
			};
		}, [
			setPianolaView,
			props.onTabSelect,
			props.onNewTab,
			props.onNewFileTab,
			props.onNewBrowserTab,
			props.onNewTerminalTab,
			props.onFileTabSelect,
			props.onBrowserTabSelect,
			props.onTerminalTabSelect,
		]);

		const filePreviewContainerRef = useRef<HTMLDivElement>(null);
		const filePreviewRef = useRef<FilePreviewHandle>(null);
		// Imperative handle for the currently-mounted BrowserTabView. Only the active browser
		// tab is rendered, so this points to that one (or null if no browser tab is active).
		const browserViewRef = useRef<BrowserTabViewHandle | null>(null);
		// Per-tab BrowserTabView handle map for the active agent's mounted browser
		// tabs (visible + kept-alive hidden). Lifted here so the coworking browser
		// responder can reach a mounted tab's handle without stealing focus.
		const browserViewRefs = useRef<Map<string, BrowserTabViewHandle>>(new Map());
		// Terminal session mounting lifecycle (refs, state, effects)
		const {
			terminalViewRefs,
			mountedTerminalSessionIds,
			mountedTerminalSessionsRef,
			terminalSearchOpen,
			setTerminalSearchOpen,
		} = useTerminalMounting(activeSession);

		// Coworking - mirror active session's terminal tabs into the main-process registry
		// so the MCP `list_terminals` tool is accurate, and answer buffer-fetch requests
		// from main via the per-session TerminalView ref map. Both hooks no-op when the
		// `coworking` Encore flag is off.
		useCoworkingRegistrySync();
		useCoworkingBufferResponder(terminalViewRefs);

		// Extract tab handlers from props
		const {
			onTabSelect,
			onTabClose,
			onNewTab,
			onRequestTabRename,
			onTabReorder,
			onUnifiedTabReorder,
			onTabStar,
			onTabMarkUnread,
			onToggleUnreadFilter,
			onOpenTabSearch,
			onOpenOutputSearch,
			onCloseAllTabs,
			onCloseOtherTabs,
			onCloseTabsLeft,
			onCloseTabsRight,
			// Unified tab system: paint state is derived below from self-sourced session
			onFileTabSelect,
			onFileTabClose,
			onFileTabRename,
			onNewFileTab,
			onNewBrowserTab,
			onBrowserTabSelect,
			onBrowserTabClose,
			onBrowserTabRename,
			onBrowserTabResetName,
			onBrowserTabUpdate,
			onFileTabEditModeChange,
			onFileTabEditContentChange,
			// Terminal tab callbacks (Phase 8)
			onNewTerminalTab,
			onTerminalTabSelect,
			onTerminalTabClose,
			onTerminalTabRename,
			onTerminalTabConfigureStartupCommand,
		} = props;

		// PERF: Tab strip / file-nav paint derived here from the full session this
		// panel already subscribes to - not from App chrome equality (which would
		// wake MaestroConsoleInner on every busy/tab-state flip).
		const {
			activeTab: derivedActiveTab,
			unifiedTabs,
			activeFileTab,
			fileTabBackHistory,
			fileTabForwardHistory,
			fileTabCanGoBack,
			fileTabCanGoForward,
			activeFileTabNavIndex,
		} = useMemo(() => getTabDerivedState(activeSession), [activeSession]);
		const activeFileTabId = activeSession?.activeFileTabId ?? null;
		const activeBrowserTabId = activeSession?.activeBrowserTabId ?? null;
		const fileGistUrls = useTabStore((s) => s.fileGistUrls);
		const hasGist = activeFileTab ? !!fileGistUrls[activeFileTab.path] : false;

		// Coworking browser responder - answers browser-op requests by resolving
		// the target tab's live (or kept-alive hidden) webview handle. It never
		// switches the user's visible tab. No-ops when the `coworking` Encore flag
		// is off.
		useCoworkingBrowserResponder(browserViewRefs);

		// Get the active tab for header display
		// Prefer local derivation from the full session (includes live usage/cost).
		const activeTab = useMemo(() => derivedActiveTab ?? null, [derivedActiveTab]);
		const activeTabError = activeTab?.agentError;

		// SSH remote name for header display
		const sshRemoteName = useSshRemoteName(
			activeSession?.sessionSshRemoteConfig?.enabled,
			activeSession?.sessionSshRemoteConfig?.remoteId
		);

		// Context window metrics (loading + calculation)
		const { activeTabContextWindow, activeTabContextTokens, activeTabContextUsage } =
			useContextWindow(activeSession, activeTab);

		// Git info (branch, status, ahead/behind)
		const { gitInfo, refreshGitStatus } = useGitInfo(activeSession);

		// Get agent capabilities for conditional feature rendering
		const { hasCapability } = useAgentCapabilities(activeSession?.toolType);

		// Model/Effort pills: available options, current values, and agent-level defaults
		const [pillModels, setPillModels] = useState<string[]>([]);
		const [pillEfforts, setPillEfforts] = useState<string[]>([]);
		const [agentDefaultModel, setAgentDefaultModel] = useState('');
		const [agentDefaultEffort, setAgentDefaultEffort] = useState('');
		const setSessions = useSessionStore((s) => s.setSessions);

		// Navigate to agent/tab when clicking an agent pill in the log viewer
		const handleLogSessionClick = useCallback(
			(sessionId: string, tabId?: string) => {
				setLogViewerOpen(false);
				setActiveSessionId(sessionId);
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;
						const targetTabId = tabId && s.aiTabs?.some((t) => t.id === tabId) ? tabId : undefined;
						return { ...s, ...aiTabFocusFields(targetTabId) };
					})
				);
			},
			[setLogViewerOpen, setActiveSessionId, setSessions]
		);

		// Activate a tiled tab group: set activeGroupId (so MainPanelContent renders
		// the group's layout) and clear the standalone active-tab ids/inputMode so no
		// single-view content competes with the group for the panel.
		const handleGroupSelect = useCallback(
			(groupId: string) => {
				if (!activeSession) return;
				setSessions((prev) =>
					prev.map((s) =>
						s.id === activeSession.id
							? {
									...s,
									activeGroupId: groupId,
									activeFileTabId: null,
									activeBrowserTabId: null,
									activeTerminalTabId: null,
									inputMode: 'ai',
								}
							: s
					)
				);
			},
			[activeSession, setSessions]
		);

		// Rename a group chip. Delegates to the tab-store rename action, resolving the
		// auto-name fallback (used when the user clears the field) from the group's
		// first pane title via the shared resolver so it matches the drop-time name.
		const renameGroupAction = useTabStore((s) => s.renameGroup);
		const handleGroupRename = useCallback(
			(groupId: string, name: string) => {
				if (!activeSession) return;
				const group = activeSession.tabGroups?.find((g) => g.id === groupId);
				const firstRef = group ? collectLeafTabRefs(group.layout)[0] : undefined;
				const fallback = firstRef
					? generateGroupName(resolveTabRefTitle(activeSession, firstRef))
					: (group?.name ?? 'Group');
				renameGroupAction(groupId, name, fallback);
			},
			[activeSession, renameGroupAction]
		);

		// Break a group apart into standalone tabs (the confirm dialog lives in the
		// group chip). Promotes every pane back to the tab bar in left-to-right order,
		// drops the group, and lands focus on the first promoted tab.
		const handleGroupBreakApart = useCallback(
			(groupId: string) => {
				if (!activeSession) return;
				updateSessionWith(activeSession.id, (s) => breakApartGroup(s, groupId));
			},
			[activeSession]
		);

		// Fetch available models, effort levels, and agent defaults when agent type changes.
		// Uses a stale flag to prevent race conditions when switching between agents -
		// without this, a slow response (e.g., `opencode models` subprocess) from the
		// previous agent can overwrite the current agent's model list.
		useEffect(() => {
			if (!activeSession?.toolType) return;
			let stale = false;
			const agentId = activeSession.toolType;
			// Fetch models
			window.maestro.agents
				.getModels(agentId)
				.then((models) => {
					if (!stale) setPillModels(models);
				})
				.catch(() => {
					if (!stale) setPillModels([]);
				});
			// Fetch effort options. Agents use either `effort` (Claude Code) or
			// `reasoningEffort` (Codex, Copilot-CLI, Factory Droid) - probe both
			// and use whichever the agent defines, so this stays correct as new
			// agents are added without touching this file.
			Promise.all([
				window.maestro.agents.getConfigOptions(agentId, 'effort').catch(() => [] as string[]),
				window.maestro.agents
					.getConfigOptions(agentId, 'reasoningEffort')
					.catch(() => [] as string[]),
			])
				.then(([effortOpts, reasoningOpts]) => {
					if (stale) return;
					setPillEfforts(effortOpts.length > 0 ? effortOpts : reasoningOpts);
				})
				.catch(() => {
					if (!stale) setPillEfforts([]);
				});
			// Fetch agent-level config for default model/effort
			window.maestro.agents
				.getConfig(agentId)
				.then((config) => {
					if (stale) return;
					setAgentDefaultModel(config?.model || '');
					setAgentDefaultEffort(readEffortFromConfig(config) ?? '');
				})
				.catch(() => {
					if (stale) return;
					setAgentDefaultModel('');
					setAgentDefaultEffort('');
				});
			return () => {
				stale = true;
			};
		}, [activeSession?.toolType]);

		// Resolved current model/effort: tab override > session override > agent config > empty
		const resolvedModel = activeTab?.customModel || activeSession?.customModel || agentDefaultModel;
		const resolvedEffort =
			activeTab?.customEffort || activeSession?.customEffort || agentDefaultEffort;

		const setTabModel = useTabStore((s) => s.setTabModel);
		const setTabEffort = useTabStore((s) => s.setTabEffort);

		const handleModelChange = useCallback(
			(model: string) => {
				if (!activeTab) return;
				setTabModel(activeTab.id, model || undefined);
			},
			[activeTab, setTabModel]
		);

		const handleEffortChange = useCallback(
			(effort: string) => {
				if (!activeTab) return;
				setTabEffort(activeTab.id, effort || undefined);
			},
			[activeTab, setTabEffort]
		);

		// Expose methods to parent via ref
		// Holds the latest terminal/browser buffer-action handlers. The imperative
		// handle only rebuilds on session-id change, so it reads these through a ref
		// (populated every render below) to avoid calling a stale closure after tabs
		// change within the same session.
		const tabBufferActionsRef = useRef<{
			copyTerminalBuffer: (tabId: string) => void;
			sendTerminalBufferToAgent: (tabId: string) => void;
			publishTerminalBufferGist: (tabId: string) => void;
			copyBrowserContent: (tabId: string) => void | Promise<void>;
			sendBrowserContentToAgent: (tabId: string) => void | Promise<void>;
		} | null>(null);

		useImperativeHandle(
			ref,
			() => ({
				refreshGitInfo: refreshGitStatus,
				focusFilePreview: () => {
					// Use the FilePreview's focus method if available, otherwise fallback to container
					if (filePreviewRef.current) {
						filePreviewRef.current.focus();
					} else {
						filePreviewContainerRef.current?.focus();
					}
				},
				clearActiveTerminal: () => {
					if (activeSession) {
						terminalViewRefs.current.get(activeSession.id)?.clearActiveTerminal();
					}
				},
				focusActiveTerminal: () => {
					if (activeSession) {
						terminalViewRefs.current.get(activeSession.id)?.focusActiveTerminal();
					}
				},
				focusBrowserAddressBar: () => {
					// Read fresh from the store: `useImperativeHandle` only rebuilds when
					// session ID changes, so opening a browser tab inside an existing
					// session leaves `activeBrowserTabId` stale in the captured closure.
					const session = selectActiveSession(useSessionStore.getState());
					if (!session?.activeBrowserTabId) return;
					const input = document.getElementById(
						`browser-tab-address-${session.activeBrowserTabId}`
					) as HTMLInputElement | null;
					input?.focus();
					input?.select();
				},
				openBrowserFind: () => {
					// Same fresh-from-store reasoning as `focusBrowserAddressBar`.
					const session = selectActiveSession(useSessionStore.getState());
					if (!session?.activeBrowserTabId) return;
					browserViewRef.current?.openFind();
				},
				browserBack: () => {
					const session = selectActiveSession(useSessionStore.getState());
					if (!session?.activeBrowserTabId) return;
					browserViewRef.current?.goBack();
				},
				browserForward: () => {
					const session = selectActiveSession(useSessionStore.getState());
					if (!session?.activeBrowserTabId) return;
					browserViewRef.current?.goForward();
				},
				focusActiveTab: () => {
					// Read fresh from the store: useImperativeHandle only rebuilds when
					// deps change, so the captured `activeSession` prop is stale if the
					// user switches tabs within the same session.
					const session = selectActiveSession(useSessionStore.getState());
					if (!session) return;
					// Mirrors TabBar's targetTabId resolution so AI/terminal/file/browser
					// tabs all map to the right header element.
					const targetTabId =
						session.inputMode === 'terminal'
							? session.activeTerminalTabId || session.activeTabId
							: session.activeFileTabId || session.activeBrowserTabId || session.activeTabId;
					if (!targetTabId) return;
					const container = document.querySelector(`[data-tour="tab-bar"]`) as HTMLElement | null;
					const tabElement = container?.querySelector(
						`[data-tab-id="${targetTabId}"]`
					) as HTMLElement | null;
					if (!container || !tabElement) return;
					// Center the tab in the scrollable strip. We compute scrollLeft
					// directly because scrollIntoView({ inline: 'center' }) ignores the
					// sticky-left search/filter button and the sticky-right "+" button,
					// which leaves the tab partly hidden behind them.
					const STICKY_RIGHT_WIDTH = 48;
					const stickyLeft = container.querySelector(':scope > .sticky') as HTMLElement | null;
					const stickyLeftWidth = stickyLeft?.offsetWidth ?? 0;
					const containerRect = container.getBoundingClientRect();
					const tabRect = tabElement.getBoundingClientRect();
					const tabLeftInContent = tabRect.left - containerRect.left + container.scrollLeft;
					const visibleWidth = container.clientWidth - stickyLeftWidth - STICKY_RIGHT_WIDTH;
					const target =
						tabLeftInContent - stickyLeftWidth - Math.max(0, (visibleWidth - tabRect.width) / 2);
					container.scrollTo({ left: Math.max(0, target), behavior: 'smooth' });
					tabElement.focus({ preventScroll: true });
				},
				reloadBrowserTab: () => {
					// Same stale-closure caveat as `focusBrowserAddressBar` - read fresh.
					const session = selectActiveSession(useSessionStore.getState());
					if (!session?.activeBrowserTabId) return;
					const host = document.querySelector('[data-testid="browser-tab-host"]');
					const webview = host?.querySelector('webview') as
						| (HTMLElement & { reload: () => void; stop: () => void; isLoading: () => boolean })
						| null;
					if (!webview) return;
					try {
						if (webview.isLoading()) {
							webview.stop();
						} else {
							webview.reload();
						}
					} catch {
						// webview not ready
					}
				},
				openTerminalSearch: () => {
					setTerminalSearchOpen(true);
				},
				copyActiveTerminalBuffer: () => {
					const session = selectActiveSession(useSessionStore.getState());
					if (session?.activeTerminalTabId)
						tabBufferActionsRef.current?.copyTerminalBuffer(session.activeTerminalTabId);
				},
				sendActiveTerminalBufferToAgent: () => {
					const session = selectActiveSession(useSessionStore.getState());
					if (session?.activeTerminalTabId)
						tabBufferActionsRef.current?.sendTerminalBufferToAgent(session.activeTerminalTabId);
				},
				publishActiveTerminalBufferGist: () => {
					const session = selectActiveSession(useSessionStore.getState());
					if (session?.activeTerminalTabId)
						tabBufferActionsRef.current?.publishTerminalBufferGist(session.activeTerminalTabId);
				},
				copyActiveBrowserContent: () => {
					const session = selectActiveSession(useSessionStore.getState());
					if (session?.activeBrowserTabId)
						void tabBufferActionsRef.current?.copyBrowserContent(session.activeBrowserTabId);
				},
				sendActiveBrowserContentToAgent: () => {
					const session = selectActiveSession(useSessionStore.getState());
					if (session?.activeBrowserTabId)
						void tabBufferActionsRef.current?.sendBrowserContentToAgent(session.activeBrowserTabId);
				},
			}),
			[refreshGitStatus, activeSession?.id]
		);

		// Terminal buffer action wrappers - resolve the terminal tab's scrollback to text,
		// then delegate to the App-level text handlers (copy / gist / send to agent).
		const resolveBuffer = useCallback(
			(tabId: string): { content: string; displayName: string } | null => {
				if (!activeSession) return null;
				const terminalTab = activeSession.terminalTabs?.find((t) => t.id === tabId);
				if (!terminalTab) return null;
				const handle = terminalViewRefs.current.get(activeSession.id);
				const content = handle?.getTerminalBuffer(tabId) ?? '';
				const terminalIndex = (activeSession.terminalTabs ?? []).findIndex((t) => t.id === tabId);
				const displayName = getTerminalTabDisplayName(
					terminalTab,
					terminalIndex >= 0 ? terminalIndex : 0
				);
				return { content, displayName };
			},
			[activeSession, terminalViewRefs]
		);

		const handleCopyTerminalBuffer = useCallback(
			(tabId: string) => {
				const resolved = resolveBuffer(tabId);
				if (!resolved) return;
				props.onCopyText?.(resolved.content, 'Terminal Buffer');
			},
			[resolveBuffer, props.onCopyText]
		);

		const handlePublishTerminalBufferGist = useCallback(
			(tabId: string) => {
				const resolved = resolveBuffer(tabId);
				if (!resolved) return;
				props.onPublishTextAsGist?.(resolved.content, resolved.displayName);
			},
			[resolveBuffer, props.onPublishTextAsGist]
		);

		const handleSendTerminalBufferToAgent = useCallback(
			(tabId: string) => {
				const resolved = resolveBuffer(tabId);
				if (!resolved) return;
				props.onSendTextToAgent?.(resolved.content, resolved.displayName);
			},
			[resolveBuffer, props.onSendTextToAgent]
		);

		// Right-click "Copy to Clipboard" on highlighted text in XTerminal.
		const handleCopyTerminalSelection = useCallback(
			(text: string) => {
				props.onCopyText?.(text, 'Terminal Selection');
			},
			[props.onCopyText]
		);

		// Right-click "Send to Agent" on highlighted text - resolve the tab's display name
		// so the Send-to-Agent modal shows e.g. "Terminal 2 Selection" as the source.
		const handleSendTerminalSelectionToAgent = useCallback(
			(tabId: string, text: string) => {
				if (!activeSession) return;
				const tabIndex = (activeSession.terminalTabs ?? []).findIndex((t) => t.id === tabId);
				const tab = activeSession.terminalTabs?.[tabIndex];
				const baseName = tab
					? getTerminalTabDisplayName(tab, tabIndex >= 0 ? tabIndex : 0)
					: 'Terminal';
				props.onSendTextToAgent?.(text, `${baseName} Selection`);
			},
			[activeSession, props.onSendTextToAgent]
		);

		// Browser content action wrappers - extract the rendered text of a browser tab
		// (activating it first if necessary) and delegate to the App-level text handlers.
		const resolveBrowserContent = useCallback(
			async (
				tabId: string
			): Promise<{ content: string; displayName: string; url: string } | null> => {
				if (!activeSession) return null;
				const browserTab = activeSession.browserTabs?.find((t) => t.id === tabId);
				if (!browserTab) return null;
				const isAlreadyActive =
					activeSession.activeBrowserTabId === tabId &&
					activeSession.inputMode === 'ai' &&
					!activeSession.activeFileTabId;
				if (!isAlreadyActive) {
					// Switch to the requested browser tab so it gets mounted, then wait briefly
					// for the BrowserTabView to register its imperative handle on the next tick.
					onBrowserTabSelect?.(tabId);
					for (let i = 0; i < 20; i++) {
						await new Promise((r) => setTimeout(r, 50));
						if (browserViewRef.current?.getTabId() === tabId) break;
					}
				}
				const handle = browserViewRef.current;
				if (!handle || handle.getTabId() !== tabId) return null;
				const content = await handle.getContent();
				const displayName =
					(browserTab.customTitle && browserTab.customTitle.trim()) ||
					(browserTab.title && browserTab.title.trim()) ||
					(() => {
						try {
							return new URL(browserTab.url).host || browserTab.url;
						} catch {
							return browserTab.url || 'Browser Tab';
						}
					})();
				return { content, displayName, url: browserTab.url };
			},
			[activeSession, onBrowserTabSelect]
		);

		const handleCopyBrowserContent = useCallback(
			async (tabId: string) => {
				const resolved = await resolveBrowserContent(tabId);
				if (!resolved) return;
				props.onCopyText?.(resolved.content, 'Page Content');
			},
			[resolveBrowserContent, props.onCopyText]
		);

		const handleSendBrowserContentToAgent = useCallback(
			async (tabId: string) => {
				const resolved = await resolveBrowserContent(tabId);
				if (!resolved) return;
				props.onSendTextToAgent?.(resolved.content, resolved.displayName);
			},
			[resolveBrowserContent, props.onSendTextToAgent]
		);

		// Keep the imperative handle's buffer/content actions pointed at the latest
		// closures so Command K runs them against the current session's tabs.
		tabBufferActionsRef.current = {
			copyTerminalBuffer: handleCopyTerminalBuffer,
			sendTerminalBufferToAgent: handleSendTerminalBufferToAgent,
			publishTerminalBufferGist: handlePublishTerminalBufferGist,
			copyBrowserContent: handleCopyBrowserContent,
			sendBrowserContentToAgent: handleSendBrowserContentToAgent,
		};

		// Bundle the per-kind pane dropdown actions once so a single stable object
		// threads down to TiledLayout (instead of ~15 separate props). Mirrors the exact
		// handlers + availability gates the TabBar chips use, so a tiled tab's chevron
		// menu offers the same actions its strip chip would. Close dispatches per kind.
		const paneTabActions = useMemo<PaneTabActions>(
			() => ({
				onStar: onTabStar,
				onMarkUnread: onTabMarkUnread,
				onCopyContext,
				onExportHtml,
				onPublishGist: props.onPublishTabGist,
				onMergeWith,
				onSendToAgent,
				onSummarizeAndContinue,
				onCopyTerminalBuffer: props.onCopyText ? handleCopyTerminalBuffer : undefined,
				onSendTerminalBufferToAgent: props.onSendTextToAgent
					? handleSendTerminalBufferToAgent
					: undefined,
				onPublishTerminalBufferGist: props.onPublishTextAsGist
					? handlePublishTerminalBufferGist
					: undefined,
				onConfigureTerminalStartup: onTerminalTabConfigureStartupCommand,
				onCopyBrowserContent: props.onCopyText ? handleCopyBrowserContent : undefined,
				onSendBrowserContentToAgent: props.onSendTextToAgent
					? handleSendBrowserContentToAgent
					: undefined,
				onCloseTab: (ref: UnifiedTabRef) => {
					if (ref.type === 'ai') onTabClose?.(ref.id);
					else if (ref.type === 'file') onFileTabClose?.(ref.id);
					else if (ref.type === 'terminal') onTerminalTabClose?.(ref.id);
					else if (ref.type === 'browser') onBrowserTabClose?.(ref.id);
				},
			}),
			[
				onTabStar,
				onTabMarkUnread,
				onCopyContext,
				onExportHtml,
				props.onPublishTabGist,
				onMergeWith,
				onSendToAgent,
				onSummarizeAndContinue,
				props.onCopyText,
				props.onSendTextToAgent,
				props.onPublishTextAsGist,
				handleCopyTerminalBuffer,
				handleSendTerminalBufferToAgent,
				handlePublishTerminalBufferGist,
				onTerminalTabConfigureStartupCommand,
				handleCopyBrowserContent,
				handleSendBrowserContentToAgent,
				onTabClose,
				onFileTabClose,
				onTerminalTabClose,
				onBrowserTabClose,
			]
		);

		// Group ids that survive the unread filter (any collapsed member is unread), so
		// the TabBar can gate group chips the same way it gates AI tabs. Only computed
		// while the filter is active (undefined otherwise -> all groups shown).
		const unreadGroupIds = useMemo(
			() => (showUnreadOnly && activeSession ? computeUnreadGroupIds(activeSession) : undefined),
			[showUnreadOnly, activeSession]
		);

		// Ids of AI tabs with queued execution items, so the TabBar keeps them visible under
		// the unread filter (pending queued work needs attention). Undefined outside the filter.
		// Depend on the executionQueue array (not the full session) so streaming/token updates
		// that leave the queue untouched preserve the Set identity and TabBar's memoization.
		const executionQueue = activeSession?.executionQueue;
		const queuedTabIds = useMemo(
			() => (showUnreadOnly && executionQueue ? computeQueuedTabIds(executionQueue) : undefined),
			[showUnreadOnly, executionQueue]
		);

		// Handler for input focus - select session in sidebar
		// Memoized to avoid recreating on every render
		const handleInputFocus = useCallback(() => {
			props.onComposerFocus?.();
			if (activeSession) {
				setActiveSessionId(activeSession.id);
				useUIStore.getState().setActiveFocus('main');
			}
		}, [activeSession, setActiveSessionId, props.onComposerFocus]);

		// Memoized session click handler for InputArea's ThinkingStatusPill.
		// Targets the clicked session by ID rather than routing through onTabSelect
		// (which resolves whichever agent is active at event time) - the pill lists
		// thinking tabs across ALL agents, so a cross-agent jump must not depend on
		// the active-session switch having landed first.
		const handleSessionClick = useCallback(
			(sessionId: string, tabId?: string) => {
				setActiveSessionId(sessionId);
				updateSessionWith(sessionId, (s) => focusAiTabInSession(s, tabId));
			},
			[setActiveSessionId]
		);

		// File preview handlers (memos + callbacks)
		const {
			memoizedFilePreviewFile,
			filePreviewCwd,
			filePreviewSshRemoteId,
			handleFilePreviewClose,
			handleFilePreviewEditModeChange,
			handleFilePreviewSave,
			handleFilePreviewEditContentChange,
			handleFilePreviewScrollPositionChange,
			handleFilePreviewSearchQueryChange,
			handleFilePreviewReload,
		} = useFilePreviewHandlers({
			activeSession,
			activeFileTabId,
			activeFileTab,
			onFileTabClose,
			onFileTabEditModeChange,
			onFileTabEditContentChange,
			onFileTabScrollPositionChange: props.onFileTabScrollPositionChange,
			onFileTabSearchQueryChange: props.onFileTabSearchQueryChange,
			onReloadFileTab: props.onReloadFileTab,
		});

		// Handler to view git diff
		const handleViewGitDiff = useCallback(async () => {
			if (!activeSession || !activeSession.isGitRepo) return;

			const cwd =
				activeSession.inputMode === 'terminal'
					? activeSession.shellCwd || activeSession.cwd
					: activeSession.cwd;
			const diff = await gitService.getDiff(cwd, undefined, filePreviewSshRemoteId);

			if (diff.diff) {
				setGitDiffPreview(diff.diff);
			} else {
				notifyCenterFlash({ message: 'No diff to examine', color: 'theme' });
				// Polling cache said there were changes but `git diff` is empty -
				// repo state changed since the last poll. Re-sync so the widget
				// stops advertising stale stats.
				void refreshGitStatus();
			}
		}, [
			activeSession?.isGitRepo,
			activeSession?.inputMode,
			activeSession?.shellCwd,
			activeSession?.cwd,
			filePreviewSshRemoteId,
			setGitDiffPreview,
			refreshGitStatus,
		]);

		// Chat-attach drop zone, scoped to the main panel. Dropping an OS file (or
		// a Files-panel row) anywhere over the main panel attaches it to the chat;
		// other regions (left bar, Files/History/Auto Run) stay inert because they
		// don't mount this zone.
		const chatDropZone = useChatFileDropZone(theme, handleDrop);

		// Multi-window scoping: this window only renders an agent it owns. If the
		// store's active agent lives in (or has moved to) another window, fall back
		// to the clean empty state instead of showing a stale view (or that agent's
		// own session/memory overlays). Outside a WindowProvider (single-window /
		// isolation tests) this is always true, so behaviour is unchanged.
		const ownsActiveSession = useWindowOwnsSession(activeSession?.id);
		if (activeSession && !ownsActiveSession) {
			return <EmptyMainPanel theme={theme} />;
		}

		// Coworking hosts (approval dialog + background browser webviews) mount
		// OUTSIDE the branch switch below so an approval requested while the log,
		// sessions, or memory viewer (or the empty state) is showing still has a
		// mount point and the agent's browser tool call never hangs.
		const renderBranch = () => {
			// Show log viewer
			if (logViewerOpen) {
				return (
					<div
						className="flex-1 flex flex-col min-w-0 relative"
						style={{ backgroundColor: theme.colors.bgMain }}
					>
						<LogViewer
							theme={theme}
							onClose={() => setLogViewerOpen(false)}
							logLevel={logLevel}
							savedSelectedLevels={logViewerSelectedLevels}
							onSelectedLevelsChange={useSettingsStore.getState().setLogViewerSelectedLevels}
							onShortcutUsed={props.onShortcutUsed}
							onSessionClick={handleLogSessionClick}
						/>
					</div>
				);
			}

			// Show agent sessions browser (only if agent supports session storage)
			if (agentSessionsOpen && hasCapability('supportsSessionStorage')) {
				return (
					<div
						className="flex-1 flex flex-col min-w-0 relative"
						style={{ backgroundColor: theme.colors.bgMain }}
					>
						<AgentSessionsBrowser
							theme={theme}
							activeSession={activeSession || undefined}
							activeAgentSessionId={activeAgentSessionId}
							onClose={() => setAgentSessionsOpen(false)}
							onResumeSession={onResumeAgentSession}
							onNewSession={onNewAgentSession}
							onUpdateTab={props.onUpdateTabByClaudeSessionId}
						/>
					</div>
				);
			}

			// Show memory viewer (only if agent supports per-project memory)
			if (memoryViewerOpen && hasCapability('supportsProjectMemory')) {
				return (
					<div
						className="flex-1 flex flex-col min-w-0 relative"
						style={{ backgroundColor: theme.colors.bgMain }}
					>
						<MemoryViewer
							theme={theme}
							activeSession={activeSession || undefined}
							onClose={() => setMemoryViewerOpen(false)}
						/>
					</div>
				);
			}

			// Show empty state when no active session
			if (!activeSession) {
				return <EmptyMainPanel theme={theme} />;
			}

			// File preview eligibility checked inline below

			// Show normal session view
			return (
				<ErrorBoundary>
					<div
						className="flex-1 h-full min-h-0 max-h-full flex flex-col relative isolate overflow-hidden"
						style={{
							minWidth: '400px',
							backgroundColor: theme.colors.bgMain,
						}}
						onClick={() => useUIStore.getState().setActiveFocus('main')}
						{...chatDropZone.dragHandlers}
					>
						{chatDropZone.overlay}
						{/* Top Bar (hidden in mobile landscape for focused reading) */}
						{!isMobileLandscape && (
							<MainPanelHeader
								activeSession={activeSession}
								activeTab={activeTab}
								theme={theme}
								gitInfo={gitInfo}
								sshRemoteName={sshRemoteName}
								activeTabContextWindow={activeTabContextWindow}
								activeTabContextTokens={activeTabContextTokens}
								activeTabContextUsage={activeTabContextUsage}
								isCurrentSessionAutoMode={isCurrentSessionAutoMode}
								isCurrentSessionStopping={isCurrentSessionStopping}
								currentSessionBatchState={currentSessionBatchState}
								isWorktreeChild={isWorktreeChild}
								activeFileTabId={activeFileTabId}
								refreshGitStatus={refreshGitStatus}
								handleViewGitDiff={handleViewGitDiff}
								getContextColor={getContextColor}
								setGitLogOpen={setGitLogOpen}
								setAgentSessionsOpen={setAgentSessionsOpen}
								setMemoryViewerOpen={setMemoryViewerOpen}
								setActiveAgentSessionId={setActiveAgentSessionId}
								onStopBatchRun={onStopBatchRun}
								onOpenWorktreeConfig={onOpenWorktreeConfig}
								onOpenCreatePR={onOpenCreatePR}
								hasCapability={hasCapability}
							/>
						)}

						{/* Pianola is a manager surface: it uses the standard multi-type TabBar
						    (chat/file/terminal/browser tabs, same "+" menu) with a pinned
						    Dashboard view button + a Clear-chat action slotted in. */}
						{activeSession.isPianola ? (
							onTabSelect && onTabClose && onNewTab ? (
								<TabBar
									tabs={activeSession.aiTabs}
									activeTabId={pianolaView === 'dashboard' ? '' : activeSession.activeTabId}
									theme={theme}
									sessionId={activeSession.id}
									sessionAgentSessionId={activeSession.agentSessionId}
									onTabSelect={pianolaTabHandlers.onTabSelect}
									onTabClose={onTabClose}
									onNewTab={pianolaTabHandlers.onNewTab}
									onRequestRename={onRequestTabRename}
									onTabReorder={onTabReorder}
									onUnifiedTabReorder={onUnifiedTabReorder}
									onTabStar={onTabStar}
									onTabMarkUnread={onTabMarkUnread}
									onMergeWith={onMergeWith}
									onSendToAgent={onSendToAgent}
									onSummarizeAndContinue={onSummarizeAndContinue}
									onCopyContext={onCopyContext}
									onExportHtml={onExportHtml}
									onPublishGist={props.onPublishTabGist}
									ghCliAvailable={props.ghCliAvailable}
									showUnreadOnly={showUnreadOnly}
									queuedTabIds={queuedTabIds}
									onToggleUnreadFilter={onToggleUnreadFilter}
									onOpenTabSearch={onOpenTabSearch}
									onOpenOutputSearch={onOpenOutputSearch}
									onCloseAllTabs={onCloseAllTabs}
									onCloseOtherTabs={onCloseOtherTabs}
									onCloseTabsLeft={onCloseTabsLeft}
									onCloseTabsRight={onCloseTabsRight}
									unifiedTabs={unifiedTabs}
									activeFileTabId={pianolaView === 'dashboard' ? null : activeFileTabId}
									activeBrowserTabId={pianolaView === 'dashboard' ? null : activeBrowserTabId}
									onFileTabSelect={pianolaTabHandlers.onFileTabSelect}
									onFileTabClose={onFileTabClose}
									onFileTabRename={onFileTabRename}
									onNewFileTab={pianolaTabHandlers.onNewFileTab}
									onNewBrowserTab={pianolaTabHandlers.onNewBrowserTab}
									onBrowserTabSelect={pianolaTabHandlers.onBrowserTabSelect}
									onBrowserTabClose={onBrowserTabClose}
									onBrowserTabRename={onBrowserTabRename}
									onBrowserTabResetName={onBrowserTabResetName}
									onNewTerminalTab={pianolaTabHandlers.onNewTerminalTab}
									activeTerminalTabId={
										pianolaView === 'dashboard' ? null : activeSession.activeTerminalTabId
									}
									inputMode={pianolaView === 'dashboard' ? 'ai' : activeSession.inputMode}
									onTerminalTabSelect={pianolaTabHandlers.onTerminalTabSelect}
									onTerminalTabClose={onTerminalTabClose}
									onTerminalTabRename={onTerminalTabRename}
									onTerminalTabConfigureStartupCommand={onTerminalTabConfigureStartupCommand}
									onCopyTerminalBuffer={props.onCopyText ? handleCopyTerminalBuffer : undefined}
									onPublishTerminalBufferGist={
										props.onPublishTextAsGist ? handlePublishTerminalBufferGist : undefined
									}
									onSendTerminalBufferToAgent={
										props.onSendTextToAgent ? handleSendTerminalBufferToAgent : undefined
									}
									onCopyBrowserContent={props.onCopyText ? handleCopyBrowserContent : undefined}
									onSendBrowserContentToAgent={
										props.onSendTextToAgent ? handleSendBrowserContentToAgent : undefined
									}
									colorBlindMode={colorBlindMode}
									sshRemote={Boolean(filePreviewSshRemoteId)}
									leadingSlot={
										<PianolaDashboardTab
											theme={theme}
											active={pianolaView === 'dashboard'}
											needsInputCount={pianolaNeedsInputCount}
											onClick={() => setPianolaView('dashboard')}
										/>
									}
								/>
							) : null
						) : (
							/* Tab Bar - shown in AI and terminal modes when we have tabs (AI + file + terminal) */
							activeSession.aiTabs &&
							activeSession.aiTabs.length > 0 &&
							onTabSelect &&
							onTabClose &&
							onNewTab && (
								<TabBar
									tabs={activeSession.aiTabs}
									activeTabId={activeSession.activeTabId}
									theme={theme}
									sessionId={activeSession.id}
									sessionAgentSessionId={activeSession.agentSessionId}
									onTabSelect={onTabSelect}
									onTabClose={onTabClose}
									onNewTab={onNewTab}
									onRequestRename={onRequestTabRename}
									onTabReorder={onTabReorder}
									onUnifiedTabReorder={onUnifiedTabReorder}
									onTabStar={onTabStar}
									onTabMarkUnread={onTabMarkUnread}
									onMergeWith={onMergeWith}
									onSendToAgent={onSendToAgent}
									onSummarizeAndContinue={onSummarizeAndContinue}
									onCopyContext={onCopyContext}
									onExportHtml={onExportHtml}
									onPublishGist={props.onPublishTabGist}
									ghCliAvailable={props.ghCliAvailable}
									showUnreadOnly={showUnreadOnly}
									queuedTabIds={queuedTabIds}
									onToggleUnreadFilter={onToggleUnreadFilter}
									onOpenTabSearch={onOpenTabSearch}
									onOpenOutputSearch={onOpenOutputSearch}
									onCloseAllTabs={onCloseAllTabs}
									onCloseOtherTabs={onCloseOtherTabs}
									onCloseTabsLeft={onCloseTabsLeft}
									onCloseTabsRight={onCloseTabsRight}
									// Unified tab system props (Phase 4)
									unifiedTabs={unifiedTabs}
									activeFileTabId={activeFileTabId}
									activeBrowserTabId={activeBrowserTabId}
									onFileTabSelect={onFileTabSelect}
									onFileTabClose={onFileTabClose}
									onFileTabRename={onFileTabRename}
									onNewFileTab={onNewFileTab}
									onNewBrowserTab={onNewBrowserTab}
									onBrowserTabSelect={onBrowserTabSelect}
									onBrowserTabClose={onBrowserTabClose}
									onBrowserTabRename={onBrowserTabRename}
									onBrowserTabResetName={onBrowserTabResetName}
									// Terminal tab props (Phase 8)
									onNewTerminalTab={onNewTerminalTab}
									activeTerminalTabId={activeSession.activeTerminalTabId}
									inputMode={activeSession.inputMode}
									onTerminalTabSelect={onTerminalTabSelect}
									onTerminalTabClose={onTerminalTabClose}
									onTerminalTabRename={onTerminalTabRename}
									onTerminalTabConfigureStartupCommand={onTerminalTabConfigureStartupCommand}
									onCopyTerminalBuffer={props.onCopyText ? handleCopyTerminalBuffer : undefined}
									onPublishTerminalBufferGist={
										props.onPublishTextAsGist ? handlePublishTerminalBufferGist : undefined
									}
									onSendTerminalBufferToAgent={
										props.onSendTextToAgent ? handleSendTerminalBufferToAgent : undefined
									}
									onCopyBrowserContent={props.onCopyText ? handleCopyBrowserContent : undefined}
									onSendBrowserContentToAgent={
										props.onSendTextToAgent ? handleSendBrowserContentToAgent : undefined
									}
									// Tab tiling (split panes)
									tabGroups={activeSession.tabGroups}
									unreadGroupIds={unreadGroupIds}
									activeGroupId={activeSession.activeGroupId}
									onGroupSelect={handleGroupSelect}
									onGroupRename={handleGroupRename}
									onGroupBreakApart={handleGroupBreakApart}
									// Accessibility
									colorBlindMode={colorBlindMode}
									// Hide local-only OS actions (Reveal in Finder) when the agent runs over SSH
									sshRemote={Boolean(filePreviewSshRemoteId)}
								/>
							)
						)}

						{/* Pianola's Dashboard view replaces the chat content while selected; the
						    Chat view (and every non-Pianola agent) renders the normal content. */}
						{activeSession.isPianola && pianolaView === 'dashboard' ? (
							<ErrorBoundary>
								<PianolaDashboard theme={theme} onJumpToAgent={setActiveSessionId} />
							</ErrorBoundary>
						) : (
							<>
								{/* Agent Error Banner */}
								{activeTabError && (
									<AgentErrorBanner
										error={activeTabError}
										theme={theme}
										onShowDetails={
											props.onShowAgentErrorModal
												? () => props.onShowAgentErrorModal?.()
												: undefined
										}
										onClear={props.onClearAgentError}
									/>
								)}

								{/* Content area */}
								<MainPanelContent
									activeSession={activeSession}
									activeTab={activeTab}
									theme={theme}
									activeFileTabId={activeFileTabId}
									activeFileTab={activeFileTab}
									activeBrowserTabId={activeBrowserTabId}
									memoizedFilePreviewFile={memoizedFilePreviewFile}
									filePreviewCwd={filePreviewCwd}
									filePreviewSshRemoteId={filePreviewSshRemoteId}
									filePreviewContainerRef={filePreviewContainerRef}
									filePreviewRef={filePreviewRef}
									handleFilePreviewClose={handleFilePreviewClose}
									handleFilePreviewEditModeChange={handleFilePreviewEditModeChange}
									handleFilePreviewSave={handleFilePreviewSave}
									handleFilePreviewEditContentChange={handleFilePreviewEditContentChange}
									handleFilePreviewScrollPositionChange={handleFilePreviewScrollPositionChange}
									handleFilePreviewSearchQueryChange={handleFilePreviewSearchQueryChange}
									handleFilePreviewReload={handleFilePreviewReload}
									handleBrowserTabUpdate={onBrowserTabUpdate}
									browserViewRef={browserViewRef}
									browserViewRefs={browserViewRefs}
									terminalViewRefs={terminalViewRefs}
									mountedTerminalSessionIds={mountedTerminalSessionIds}
									mountedTerminalSessionsRef={mountedTerminalSessionsRef}
									terminalSearchOpen={terminalSearchOpen}
									setTerminalSearchOpen={setTerminalSearchOpen}
									onTerminalCopySelection={
										props.onCopyText ? handleCopyTerminalSelection : undefined
									}
									onTerminalSendSelectionToAgent={
										props.onSendTextToAgent ? handleSendTerminalSelectionToAgent : undefined
									}
									isMobileLandscape={isMobileLandscape}
									activeTabContextUsage={activeTabContextUsage}
									contextWarningsEnabled={contextWarningsEnabled}
									contextWarningYellowThreshold={contextWarningYellowThreshold}
									contextWarningRedThreshold={contextWarningRedThreshold}
									handleInputFocus={handleInputFocus}
									handleSessionClick={handleSessionClick}
									isCurrentSessionAutoMode={isCurrentSessionAutoMode}
									currentSessionBatchState={currentSessionBatchState}
									hasCapability={hasCapability}
									setInputValue={setInputValue}
									stagedImages={stagedImages}
									setStagedImages={setStagedImages}
									setLightboxImage={setLightboxImage}
									commandHistoryOpen={commandHistoryOpen}
									setCommandHistoryOpen={setCommandHistoryOpen}
									commandHistoryFilter={commandHistoryFilter}
									setCommandHistoryFilter={setCommandHistoryFilter}
									commandHistorySelectedIndex={commandHistorySelectedIndex}
									setCommandHistorySelectedIndex={setCommandHistorySelectedIndex}
									slashCommandOpen={slashCommandOpen}
									setSlashCommandOpen={setSlashCommandOpen}
									slashCommands={slashCommands}
									selectedSlashCommandIndex={selectedSlashCommandIndex}
									setSelectedSlashCommandIndex={setSelectedSlashCommandIndex}
									tabCompletionOpen={tabCompletionOpen}
									setTabCompletionOpen={setTabCompletionOpen}
									tabCompletionSuggestions={tabCompletionSuggestions}
									selectedTabCompletionIndex={selectedTabCompletionIndex}
									setSelectedTabCompletionIndex={setSelectedTabCompletionIndex}
									tabCompletionFilter={tabCompletionFilter}
									setTabCompletionFilter={setTabCompletionFilter}
									atMentionOpen={atMentionOpen}
									setAtMentionOpen={setAtMentionOpen}
									atMentionFilter={atMentionFilter}
									setAtMentionFilter={setAtMentionFilter}
									atMentionStartIndex={atMentionStartIndex}
									setAtMentionStartIndex={setAtMentionStartIndex}
									atMentionItems={atMentionItems}
									atMentionCounts={atMentionCounts}
									atMentionCategory={atMentionCategory}
									setAtMentionCategory={setAtMentionCategory}
									selectedAtMentionIndex={selectedAtMentionIndex}
									setSelectedAtMentionIndex={setSelectedAtMentionIndex}
									inputRef={inputRef}
									logsEndRef={logsEndRef}
									terminalOutputRef={terminalOutputRef}
									toggleInputMode={toggleInputMode}
									processInput={processInput}
									handleInterrupt={handleInterrupt}
									handleInputKeyDown={handleInputKeyDown}
									handlePaste={handlePaste}
									handleDrop={handleDrop}
									onStopBatchRun={onStopBatchRun}
									onRemoveQueuedItem={onRemoveQueuedItem}
									onTogglePauseQueuedItem={onTogglePauseQueuedItem}
									onEditQueuedItem={onEditQueuedItem}
									onReorderQueuedItem={onReorderQueuedItem}
									onForceSendQueuedItem={onForceSendQueuedItem}
									forcedParallelEnabled={forcedParallelEnabled}
									getForceSendContext={getForceSendContext}
									onOpenQueueBrowser={onOpenQueueBrowser}
									showFlashNotification={showFlashNotification}
									summarizeProgress={summarizeProgress}
									summarizeResult={summarizeResult}
									summarizeStartTime={summarizeStartTime}
									isSummarizing={isSummarizing}
									onCancelSummarize={onCancelSummarize}
									onSummarizeAndContinue={onSummarizeAndContinue}
									mergeProgress={mergeProgress}
									mergeResult={mergeResult}
									mergeStartTime={mergeStartTime}
									isMerging={isMerging}
									mergeSourceName={mergeSourceName}
									mergeTargetName={mergeTargetName}
									onCancelMerge={onCancelMerge}
									onExitWizard={onExitWizard}
									paneTabActions={paneTabActions}
									onDeleteLog={props.onDeleteLog}
									onScrollPositionChange={props.onScrollPositionChange}
									onAtBottomChange={props.onAtBottomChange}
									onInputBlur={props.onInputBlur}
									onOpenPromptComposer={props.onOpenPromptComposer}
									onReplayMessage={props.onReplayMessage}
									onForkConversation={props.onForkConversation}
									onSessionRecover={props.onSessionRecover}
									isRecoveringSession={props.isRecoveringSession}
									sessionRecoveryError={props.sessionRecoveryError}
									fileTree={props.fileTree}
									onFileClick={props.onFileClick}
									refreshFileTree={props.refreshFileTree}
									onOpenSavedFileInTab={props.onOpenSavedFileInTab}
									onShowAgentErrorModal={props.onShowAgentErrorModal}
									canGoBack={fileTabCanGoBack}
									canGoForward={fileTabCanGoForward}
									onNavigateBack={props.onNavigateBack}
									onNavigateForward={props.onNavigateForward}
									backHistory={fileTabBackHistory}
									forwardHistory={fileTabForwardHistory}
									currentHistoryIndex={activeFileTabNavIndex}
									onNavigateToIndex={props.onNavigateToIndex}
									onOpenFuzzySearch={props.onOpenFuzzySearch}
									onShortcutUsed={props.onShortcutUsed}
									ghCliAvailable={props.ghCliAvailable}
									onPublishGist={props.onPublishGist}
									hasGist={hasGist}
									onOpenInGraph={props.onOpenInGraph}
									onOpenInBrowser={props.onOpenInBrowser}
									onPublishMessageGist={props.onPublishMessageGist}
									onToggleTabReadOnlyMode={props.onToggleTabReadOnlyMode}
									onToggleTabSaveToHistory={props.onToggleTabSaveToHistory}
									onToggleTabShowThinking={props.onToggleTabShowThinking}
									onToggleTabEnterToSend={props.onToggleTabEnterToSend}
									onWizardComplete={props.onWizardComplete}
									onWizardCompleteAndStartAutoRun={props.onWizardCompleteAndStartAutoRun}
									onWizardDocumentSelect={props.onWizardDocumentSelect}
									onWizardContentChange={props.onWizardContentChange}
									onWizardLetsGo={props.onWizardLetsGo}
									onWizardRetry={props.onWizardRetry}
									onWizardClearError={props.onWizardClearError}
									onToggleWizardShowThinking={props.onToggleWizardShowThinking}
									onWizardCancelGeneration={props.onWizardCancelGeneration}
									// Model/Effort quick-change pills
									currentModel={resolvedModel}
									currentEffort={resolvedEffort}
									availableModels={pillModels}
									availableEfforts={pillEfforts}
									onModelChange={handleModelChange}
									onEffortChange={handleEffortChange}
								/>
							</>
						)}
					</div>
				</ErrorBoundary>
			);
		};

		return (
			<>
				{renderBranch()}
				<CoworkingApprovalHost theme={theme} />
				<CoworkingBackgroundBrowsers theme={theme} />
			</>
		);
	})
);
