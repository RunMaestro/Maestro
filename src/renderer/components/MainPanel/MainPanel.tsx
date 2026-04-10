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
import { TabBar } from '../TabBar';
import { gitService } from '../../services/git';
import { useAgentCapabilities } from '../../hooks';
import { useUIStore } from '../../stores/uiStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useTerminalMounting } from '../../hooks/terminal/useTerminalMounting';
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

		// Fetch available models, effort levels, and agent defaults when agent type changes
		useEffect(() => {
			if (!activeSession?.toolType) return;
			const agentId = activeSession.toolType;
			// Fetch models
			window.maestro.agents
				.getModels(agentId)
				.then(setPillModels)
				.catch(() => setPillModels([]));
			// Fetch effort options — use the effort-related config key for this agent
			const effortKey = agentId === 'codex' ? 'reasoningEffort' : 'effort';
			window.maestro.agents
				.getConfigOptions(agentId, effortKey)
				.then(setPillEfforts)
				.catch(() => setPillEfforts([]));
			// Fetch agent-level config for default model/effort
			window.maestro.agents
				.getConfig(agentId)
				.then((config) => {
					setAgentDefaultModel(config?.model || '');
					setAgentDefaultEffort(config?.effort || config?.reasoningEffort || '');
				})
				.catch(() => {
					setAgentDefaultModel('');
					setAgentDefaultEffort('');
				});
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
				openTerminalSearch: () => {
					setTerminalSearchOpen(true);
				},
			}),
			[refreshGitStatus, activeSession?.id]
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
						className="flex-1 flex flex-col relative"
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
							terminalViewRefs={terminalViewRefs}
							mountedTerminalSessionIds={mountedTerminalSessionIds}
							mountedTerminalSessionsRef={mountedTerminalSessionsRef}
							terminalSearchOpen={terminalSearchOpen}
							setTerminalSearchOpen={setTerminalSearchOpen}
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
