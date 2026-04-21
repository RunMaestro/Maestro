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
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTerminalMounting } from '../../hooks/terminal/useTerminalMounting';
import { getTerminalTabDisplayName } from '../../utils/terminalTabHelpers';
import { useSshRemoteName } from '../../hooks/mainPanel/useSshRemoteName';
import { useContextWindow } from '../../hooks/mainPanel/useContextWindow';
import { useFilePreviewHandlers } from '../../hooks/mainPanel/useFilePreviewHandlers';
import { useGitInfo } from '../../hooks/mainPanel/useGitInfo';
import { useCopyToClipboard } from '../../hooks/mainPanel/useCopyToClipboard';
import { MainPanelHeader } from './MainPanelHeader';
import { MainPanelContent } from './MainPanelContent';
import { AgentErrorBanner } from './AgentErrorBanner';
import { CopyNotificationToast } from './CopyNotificationToast';
import type { MainPanelHandle, MainPanelProps } from './types';

// PERFORMANCE: Wrap with React.memo to prevent re-renders when parent (App.tsx) re-renders
// due to input value changes. The component will only re-render when its props actually change.
export const MainPanel = React.memo(
	forwardRef<MainPanelHandle, MainPanelProps>(function MainPanel(props, ref) {
		const {
			logViewerOpen,
			agentSessionsOpen,
			memoryViewerOpen,
			activeAgentSessionId,
			activeSession,
			thinkingItems,
			theme,
			inputValue,
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
			atMentionSuggestions,
			selectedAtMentionIndex,
			setAtMentionOpen,
			setAtMentionFilter,
			setAtMentionStartIndex,
			setSelectedAtMentionIndex,
			filePreviewLoading,
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

		// isCurrentSessionAutoMode: THIS session has active batch run (for all UI indicators)
		const isCurrentSessionAutoMode = currentSessionBatchState?.isRunning || false;
		const isCurrentSessionStopping = currentSessionBatchState?.isStopping || false;

		const filePreviewContainerRef = useRef<HTMLDivElement>(null);
		const filePreviewRef = useRef<FilePreviewHandle>(null);
		// Imperative handle for the currently-mounted BrowserTabView. Only the active browser
		// tab is rendered, so this points to that one (or null if no browser tab is active).
		const browserViewRef = useRef<BrowserTabViewHandle | null>(null);
		// Terminal session mounting lifecycle (refs, state, effects)
		const {
			terminalViewRefs,
			mountedTerminalSessionIds,
			mountedTerminalSessionsRef,
			terminalSearchOpen,
			setTerminalSearchOpen,
		} = useTerminalMounting(activeSession);

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
			// Unified tab system props (Phase 4)
			unifiedTabs,
			activeFileTabId,
			activeFileTab,
			activeBrowserTabId,
			activeBrowserTab,
			onFileTabSelect,
			onFileTabClose,
			onNewFileTab,
			onNewBrowserTab,
			onBrowserTabSelect,
			onBrowserTabClose,
			onBrowserTabUpdate,
			onFileTabEditModeChange,
			onFileTabEditContentChange,
			// Terminal tab callbacks (Phase 8)
			onNewTerminalTab,
			onTerminalTabSelect,
			onTerminalTabClose,
			onTerminalTabRename,
		} = props;

		// Get the active tab for header display
		// The header should show the active tab's data (UUID, name, cost, context), not session-level data
		// PERF: Memoize the lookup to avoid O(n) search on every render - will still update when
		// aiTabs array or activeTabId changes (which happens when tabs change, not on every keystroke)
		const activeTab = useMemo(
			() =>
				activeSession?.aiTabs?.find((tab) => tab.id === activeSession.activeTabId) ??
				activeSession?.aiTabs?.[0] ??
				null,
			[activeSession?.aiTabs, activeSession?.activeTabId]
		);
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

		// Copy to clipboard with flash notification
		const { copyNotification, copyToClipboard } = useCopyToClipboard();

		// Get agent capabilities for conditional feature rendering
		const { hasCapability } = useAgentCapabilities(activeSession?.toolType);

		// Model/Effort pills: available options, current values, and agent-level defaults
		const [pillModels, setPillModels] = useState<string[]>([]);
		const [pillEfforts, setPillEfforts] = useState<string[]>([]);
		const [agentDefaultModel, setAgentDefaultModel] = useState('');
		const [agentDefaultEffort, setAgentDefaultEffort] = useState('');
		const updateSession = useSessionStore((s) => s.updateSession);
		const setSessions = useSessionStore((s) => s.setSessions);

		// Navigate to agent/tab when clicking an agent pill in the log viewer
		const handleLogSessionClick = useCallback(
			(sessionId: string, tabId?: string) => {
				setLogViewerOpen(false);
				setActiveSessionId(sessionId);
				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== sessionId) return s;
						if (tabId && !s.aiTabs?.some((t) => t.id === tabId)) {
							return { ...s, activeFileTabId: null, inputMode: 'ai' as const };
						}
						return {
							...s,
							...(tabId && { activeTabId: tabId }),
							activeFileTabId: null,
							inputMode: 'ai' as const,
						};
					})
				);
			},
			[setLogViewerOpen, setActiveSessionId, setSessions]
		);

		// Fetch available models, effort levels, and agent defaults when agent type changes.
		// Uses a stale flag to prevent race conditions when switching between agents —
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
			// Fetch effort options — use the effort-related config key for this agent
			const effortKey = agentId === 'codex' ? 'reasoningEffort' : 'effort';
			window.maestro.agents
				.getConfigOptions(agentId, effortKey)
				.then((efforts) => {
					if (!stale) setPillEfforts(efforts);
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
					setAgentDefaultEffort(config?.effort || config?.reasoningEffort || '');
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

		// Resolved current model/effort: session override > agent config > empty
		const resolvedModel = activeSession?.customModel || agentDefaultModel;
		const resolvedEffort = activeSession?.customEffort || agentDefaultEffort;

		const handleModelChange = useCallback(
			(model: string) => {
				if (!activeSession) return;
				updateSession(activeSession.id, { customModel: model || undefined });
			},
			[activeSession, updateSession]
		);

		const handleEffortChange = useCallback(
			(effort: string) => {
				if (!activeSession) return;
				updateSession(activeSession.id, { customEffort: effort || undefined });
			},
			[activeSession, updateSession]
		);

		// Expose methods to parent via ref
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
					if (activeSession?.activeBrowserTabId) {
						const input = document.getElementById(
							`browser-tab-address-${activeSession.activeBrowserTabId}`
						) as HTMLInputElement | null;
						if (input) {
							input.focus();
							input.select();
						}
					}
				},
				reloadBrowserTab: () => {
					if (activeSession?.activeBrowserTabId) {
						const host = document.querySelector('[data-testid="browser-tab-host"]');
						const webview = host?.querySelector('webview') as
							| (HTMLElement & { reload: () => void; stop: () => void; isLoading: () => boolean })
							| null;
						if (webview) {
							try {
								if (webview.isLoading()) {
									webview.stop();
								} else {
									webview.reload();
								}
							} catch {
								// webview not ready
							}
						}
					}
				},
				openTerminalSearch: () => {
					setTerminalSearchOpen(true);
				},
			}),
			[refreshGitStatus, activeSession?.id]
		);

		// Terminal buffer action wrappers — resolve the terminal tab's scrollback to text,
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

		// Right-click "Send to Agent" on highlighted text — resolve the tab's display name
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

		// Browser content action wrappers — extract the rendered text of a browser tab
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

		// Handler for input focus - select session in sidebar
		// Memoized to avoid recreating on every render
		const handleInputFocus = useCallback(() => {
			if (activeSession) {
				setActiveSessionId(activeSession.id);
				useUIStore.getState().setActiveFocus('main');
			}
		}, [activeSession, setActiveSessionId]);

		// Memoized session click handler for InputArea's ThinkingStatusPill
		// Avoids creating new function reference on every render
		const handleSessionClick = useCallback(
			(sessionId: string, tabId?: string) => {
				setActiveSessionId(sessionId);
				if (tabId && onTabSelect) {
					onTabSelect(tabId);
				}
			},
			[setActiveSessionId, onTabSelect]
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
			}
		}, [
			activeSession?.isGitRepo,
			activeSession?.inputMode,
			activeSession?.shellCwd,
			activeSession?.cwd,
			filePreviewSshRemoteId,
			setGitDiffPreview,
		]);

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

		// File preview eligibility checked inline below

		// Show normal session view
		return (
			<>
				<ErrorBoundary>
					<div
						className="flex-1 flex flex-col relative isolate"
						style={{
							minWidth: '400px',
							backgroundColor: theme.colors.bgMain,
						}}
						onClick={() => useUIStore.getState().setActiveFocus('main')}
					>
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
								copyToClipboard={copyToClipboard}
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

						{/* Tab Bar - shown in AI and terminal modes when we have tabs (AI + file + terminal) */}
						{activeSession.aiTabs &&
							activeSession.aiTabs.length > 0 &&
							onTabSelect &&
							onTabClose &&
							onNewTab && (
								<TabBar
									tabs={activeSession.aiTabs}
									activeTabId={activeSession.activeTabId}
									theme={theme}
									sessionId={activeSession.id}
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
									onNewFileTab={onNewFileTab}
									onNewBrowserTab={onNewBrowserTab}
									onBrowserTabSelect={onBrowserTabSelect}
									onBrowserTabClose={onBrowserTabClose}
									// Terminal tab props (Phase 8)
									onNewTerminalTab={onNewTerminalTab}
									activeTerminalTabId={activeSession.activeTerminalTabId}
									inputMode={activeSession.inputMode}
									onTerminalTabSelect={onTerminalTabSelect}
									onTerminalTabClose={onTerminalTabClose}
									onTerminalTabRename={onTerminalTabRename}
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
									// Accessibility
									colorBlindMode={colorBlindMode}
								/>
							)}

						{/* Agent Error Banner */}
						{activeTabError && (
							<AgentErrorBanner
								error={activeTabError}
								theme={theme}
								onShowDetails={
									props.onShowAgentErrorModal ? () => props.onShowAgentErrorModal?.() : undefined
								}
								onClear={props.onClearAgentError}
							/>
						)}

						{/* Content area */}
						<MainPanelContent
							activeSession={activeSession}
							activeTab={activeTab}
							theme={theme}
							filePreviewLoading={filePreviewLoading}
							activeFileTabId={activeFileTabId}
							activeFileTab={activeFileTab}
							activeBrowserTabId={activeBrowserTabId}
							activeBrowserTab={activeBrowserTab}
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
							terminalViewRefs={terminalViewRefs}
							mountedTerminalSessionIds={mountedTerminalSessionIds}
							mountedTerminalSessionsRef={mountedTerminalSessionsRef}
							terminalSearchOpen={terminalSearchOpen}
							setTerminalSearchOpen={setTerminalSearchOpen}
							onTerminalCopySelection={props.onCopyText ? handleCopyTerminalSelection : undefined}
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
							inputValue={inputValue}
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
							atMentionSuggestions={atMentionSuggestions}
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
							thinkingItems={thinkingItems}
							onStopBatchRun={onStopBatchRun}
							onRemoveQueuedItem={onRemoveQueuedItem}
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
							onDeleteLog={props.onDeleteLog}
							onScrollPositionChange={props.onScrollPositionChange}
							onAtBottomChange={props.onAtBottomChange}
							onInputBlur={props.onInputBlur}
							onOpenPromptComposer={props.onOpenPromptComposer}
							onReplayMessage={props.onReplayMessage}
							onForkConversation={props.onForkConversation}
							fileTree={props.fileTree}
							onFileClick={props.onFileClick}
							refreshFileTree={props.refreshFileTree}
							onOpenSavedFileInTab={props.onOpenSavedFileInTab}
							onShowAgentErrorModal={props.onShowAgentErrorModal}
							canGoBack={props.canGoBack}
							canGoForward={props.canGoForward}
							onNavigateBack={props.onNavigateBack}
							onNavigateForward={props.onNavigateForward}
							backHistory={props.backHistory}
							forwardHistory={props.forwardHistory}
							currentHistoryIndex={props.currentHistoryIndex}
							onNavigateToIndex={props.onNavigateToIndex}
							onOpenFuzzySearch={props.onOpenFuzzySearch}
							onShortcutUsed={props.onShortcutUsed}
							ghCliAvailable={props.ghCliAvailable}
							onPublishGist={props.onPublishGist}
							hasGist={props.hasGist}
							onOpenInGraph={props.onOpenInGraph}
							onPublishMessageGist={props.onPublishMessageGist}
							onToggleTabReadOnlyMode={props.onToggleTabReadOnlyMode}
							onToggleTabSaveToHistory={props.onToggleTabSaveToHistory}
							onToggleTabShowThinking={props.onToggleTabShowThinking}
							onWizardComplete={props.onWizardComplete}
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
					</div>
				</ErrorBoundary>

				{/* Copy Notification Toast */}
				<CopyNotificationToast message={copyNotification} theme={theme} />
			</>
		);
	})
);
