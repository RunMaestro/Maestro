import React, { useRef, useMemo, forwardRef, useCallback, memo } from 'react';
import type { LogEntry } from '../../types';
import type { TerminalOutputProps } from './types';
import Convert from 'ansi-to-html';
import { getActiveTab } from '../../utils/tabHelpers';
import { useDebouncedValue } from '../../hooks';
import { jumpToMessageEdge, isTextInputTarget } from '../../utils/messageScrollNavigation';
import { QueuedItemsList } from '../QueuedItemsList';
import { SaveMarkdownModal } from '../SaveMarkdownModal';
import { generateTerminalProseStyles } from '../../utils/markdownConfig';
import { safeClipboardWrite } from '../../utils/clipboard';
import { flashCopiedToClipboard } from '../../utils/flashCopiedToClipboard';
import { useSettingsStore } from '../../stores/settingsStore';
import { useMessageGistStore } from '../../stores/messageGistStore';
import { getClaudeTokenMode } from '../../../shared/claudeTokenMode';
import { collapseAiResponseLogs } from './utils/collapseAiResponseLogs';
import { toolLogsRecorded } from '../../hooks/agent/internal/helpers/thinkingLogs';
import { groupSubagentToolLogs } from './utils/groupSubagentToolLogs';
import { LogItem } from './components/LogItem';
import { OutputSearchBar } from './components/OutputSearchBar';
import { ScrollToBottomButton } from './components/ScrollToBottomButton';
import { useLogItemUiState } from './hooks/useLogItemUiState';
import { useTerminalOutputSearch } from './hooks/useTerminalOutputSearch';
import { useTerminalOutputScroll } from './hooks/useTerminalOutputScroll';

// PERFORMANCE: Wrap in React.memo to prevent re-renders when parent re-renders
// but TerminalOutput's props haven't changed. This is critical because TerminalOutput
// can render many log entries and is expensive to re-render.
export const TerminalOutput = memo(
	forwardRef<HTMLDivElement, TerminalOutputProps>((props, ref) => {
		const {
			session,
			theme,
			fontFamily,
			activeFocus: _activeFocus,
			outputSearchOpen,
			outputSearchQuery,
			outputSearchRegex,
			setOutputSearchOpen,
			setOutputSearchQuery,
			setOutputSearchRegex,
			setActiveFocus,
			setLightboxImage,
			inputRef,
			logsEndRef,
			maxOutputLines,
			onDeleteLog,
			onRemoveQueuedItem,
			onTogglePauseQueuedItem,
			onEditQueuedItem,
			onReorderQueuedItem,
			onForceSendQueuedItem,
			forcedParallelEnabled,
			getForceSendContext,
			onInterrupt: _onInterrupt,
			onScrollPositionChange,
			onAtBottomChange,
			initialScrollTop,
			markdownEditMode,
			setMarkdownEditMode,
			onReplayMessage,
			onForkConversation,
			fileTree,
			cwd,
			projectRoot,
			onFileClick,
			onShowErrorDetails,
			onFileSaved,
			userMessageAlignment = 'right',
			onOpenInTab,
			ghCliAvailable,
			onPublishMessageGist,
			onSessionRecover,
			isRecoveringSession,
			sessionRecoveryError,
		} = props;
		const globalBionifyReadingMode = useSettingsStore((s) => s.bionifyReadingMode);
		const globalBionifyIntensity = useSettingsStore((s) => s.bionifyIntensity);
		const publishedGists = useMessageGistStore((s) => s.published);
		const globalBionifyAlgorithm = useSettingsStore((s) => s.bionifyAlgorithm);

		// Use the forwarded ref if provided, otherwise create a local one
		const localRef = useRef<HTMLDivElement>(null);
		const terminalOutputRef = (ref as React.RefObject<HTMLDivElement>) || localRef;

		// Scroll container ref for native scrolling
		const scrollContainerRef = useRef<HTMLDivElement>(null);

		const activeTabId = session.activeTabId;

		const copyToClipboard = useCallback(async (text: string) => {
			const ok = await safeClipboardWrite(text);
			if (ok) {
				flashCopiedToClipboard(text);
			}
		}, []);

		const ansiConverter = useMemo(() => {
			const c = theme.colors;
			return new Convert({
				fg: c.textMain,
				bg: c.bgMain,
				newline: false,
				escapeXML: true,
				stream: false,
				colors: {
					0: c.ansiBlack ?? c.textMain,
					1: c.ansiRed ?? c.error,
					2: c.ansiGreen ?? c.success,
					3: c.ansiYellow ?? c.warning,
					4: c.ansiBlue ?? c.accent,
					5: c.ansiMagenta ?? c.accentDim,
					6: c.ansiCyan ?? c.accent,
					7: c.ansiWhite ?? c.textDim,
					8: c.ansiBrightBlack ?? c.textDim,
					9: c.ansiBrightRed ?? c.error,
					10: c.ansiBrightGreen ?? c.success,
					11: c.ansiBrightYellow ?? c.warning,
					12: c.ansiBrightBlue ?? c.accent,
					13: c.ansiBrightMagenta ?? c.accentText,
					14: c.ansiBrightCyan ?? c.accentText,
					15: c.ansiBrightWhite ?? c.textMain,
				},
			});
		}, [theme]);

		const activeTab = useMemo(() => getActiveTab(session), [session.aiTabs, session.activeTabId]);
		const activeLogs = useMemo((): LogEntry[] => activeTab?.logs ?? [], [activeTab?.logs]);
		// Tool visibility is a pure render concern: tool events are always recorded
		// (useAgentToolExecutionListener), so hide them here when the tab's effective
		// tools setting is off. Keeps toggling from mutating log storage (the flicker
		// bug) and preserves running->completed correlation.
		const toolsVisible = activeTab
			? toolLogsRecorded(activeTab.showTools, activeTab.showThinking)
			: true;
		const visibleLogs = useMemo(
			() => (toolsVisible ? activeLogs : activeLogs.filter((l) => l.source !== 'tool')),
			[activeLogs, toolsVisible]
		);
		const collapsedLogs = useMemo(() => collapseAiResponseLogs(visibleLogs), [visibleLogs]);
		// Nest subagent tool badges (claude-code Task) under the tool entry that
		// spawned them; orphans and non-claude agents pass through untouched.
		const { logs: filteredLogs, childrenByParentId } = useMemo(
			() => groupSubagentToolLogs(collapsedLogs),
			[collapsedLogs]
		);
		const debouncedSearchQuery = useDebouncedValue(outputSearchQuery, 150);

		const {
			expandedLogs,
			toggleExpanded,
			localFilters,
			activeLocalFilter,
			filterModes,
			toggleLocalFilter,
			setLocalFilterQuery,
			setFilterModeForLog,
			clearLocalFilter,
			deleteConfirmLogId,
			setDeleteConfirmLogId,
			saveModalContent,
			setSaveModalContent,
			handleSaveToFile,
			toggleMarkdownEditMode,
		} = useLogItemUiState(markdownEditMode, setMarkdownEditMode);

		const { currentMatchIndex, totalMatches, regexError, goToNextMatch, goToPrevMatch } =
			useTerminalOutputSearch({
				scrollContainerRef,
				terminalOutputRef,
				outputSearchOpen,
				outputSearchRegex,
				debouncedSearchQuery,
				filteredLogsLength: filteredLogs.length,
				setOutputSearchOpen,
				setOutputSearchQuery,
			});

		const {
			isAtBottom,
			hasNewMessages,
			newMessageCount,
			autoScrollPaused,
			isAutoScrollActive,
			handleScroll,
			scrollToBottomAndResume,
		} = useTerminalOutputScroll({
			scrollContainerRef,
			initialScrollTop,
			sessionId: session.id,
			activeTabId,
			filteredLogsLength: filteredLogs.length,
			onScrollPositionChange,
			onAtBottomChange,
		});

		// Helper to find last user command for echo stripping in terminal mode
		const getLastUserCommand = useCallback(
			(index: number): string | undefined => {
				for (let i = index - 1; i >= 0; i--) {
					if (filteredLogs[i]?.source === 'user') {
						return filteredLogs[i].text;
					}
				}
				return undefined;
			},
			[filteredLogs]
		);

		// TerminalOutput only handles AI mode; terminal mode renders via TerminalView
		const isTerminal = false;
		const isAIMode = true;

		// Memoized prose styles - applied once at container level instead of per-log-item
		// IMPORTANT: Scoped to .terminal-output to avoid CSS conflicts with other prose containers (e.g., AutoRun panel)
		const proseStyles = useMemo(
			() => generateTerminalProseStyles(theme, '.terminal-output'),
			[theme]
		);

		return (
			<div
				ref={terminalOutputRef}
				tabIndex={0}
				role="region"
				aria-label="Terminal output"
				className="terminal-output flex-1 flex flex-col overflow-hidden transition-colors outline-none relative"
				style={{
					backgroundColor: theme.colors.bgMain,
				}}
				onKeyDown={(e) => {
					// Cmd+F to open search
					if (e.key === 'f' && (e.metaKey || e.ctrlKey) && !outputSearchOpen) {
						e.preventDefault();
						setOutputSearchOpen(true);
						return;
					}
					// Escape handling removed - delegated to layer stack for search
					// When search is not open, Escape should still focus back to input
					if (e.key === 'Escape' && !outputSearchOpen) {
						e.preventDefault();
						e.stopPropagation();
						// Focus back to text input
						inputRef.current?.focus();
						setActiveFocus('main');
						return;
					}
					// Shift+Arrow: jump message-by-message. Skip when the user is typing in
					// an input/textarea inside the region - those handle their own
					// arrow-key cursor movement.
					if (
						(e.key === 'ArrowUp' || e.key === 'ArrowDown') &&
						e.shiftKey &&
						!e.metaKey &&
						!e.ctrlKey &&
						!e.altKey &&
						!isTextInputTarget(e.target)
					) {
						const container = scrollContainerRef.current;
						if (container) {
							e.preventDefault();
							jumpToMessageEdge(container, '[data-log-index]', e.key === 'ArrowUp' ? 'up' : 'down');
						}
						return;
					}
					// Plain Arrow keys: nudge scroll by ~100px (instant, no smooth behavior).
					if (
						e.key === 'ArrowUp' &&
						!e.shiftKey &&
						!e.metaKey &&
						!e.ctrlKey &&
						!e.altKey &&
						!isTextInputTarget(e.target)
					) {
						e.preventDefault();
						scrollContainerRef.current?.scrollBy({ top: -100 });
						return;
					}
					if (
						e.key === 'ArrowDown' &&
						!e.shiftKey &&
						!e.metaKey &&
						!e.ctrlKey &&
						!e.altKey &&
						!isTextInputTarget(e.target)
					) {
						e.preventDefault();
						scrollContainerRef.current?.scrollBy({ top: 100 });
						return;
					}
					// Option/Alt+Up: page up
					if (e.key === 'ArrowUp' && e.altKey && !e.metaKey && !e.ctrlKey) {
						e.preventDefault();
						const height = terminalOutputRef.current?.clientHeight || 400;
						scrollContainerRef.current?.scrollBy({ top: -height });
						return;
					}
					// Option/Alt+Down: page down
					if (e.key === 'ArrowDown' && e.altKey && !e.metaKey && !e.ctrlKey) {
						e.preventDefault();
						const height = terminalOutputRef.current?.clientHeight || 400;
						scrollContainerRef.current?.scrollBy({ top: height });
						return;
					}
					// Cmd+Up to jump to top
					if (e.key === 'ArrowUp' && (e.metaKey || e.ctrlKey) && !e.altKey) {
						e.preventDefault();
						scrollContainerRef.current?.scrollTo({ top: 0 });
						return;
					}
					// Cmd+Down to jump to bottom
					if (e.key === 'ArrowDown' && (e.metaKey || e.ctrlKey) && !e.altKey) {
						e.preventDefault();
						const container = scrollContainerRef.current;
						if (container) {
							container.scrollTo({ top: container.scrollHeight });
						}
						return;
					}
				}}
			>
				{/* CSS for Custom Highlight API - paints matches without mutating DOM */}
				<style>{`
					::highlight(terminal-search-all) {
						background-color: ${theme.colors.warning};
						color: ${theme.mode === 'light' ? '#fff' : '#000'};
					}
					::highlight(terminal-search-current) {
						background-color: ${theme.colors.accent};
						color: #fff;
					}
				`}</style>
				{/* Output Search */}
				{outputSearchOpen && (
					<OutputSearchBar
						theme={theme}
						outputSearchQuery={outputSearchQuery}
						outputSearchRegex={outputSearchRegex}
						regexError={regexError}
						currentMatchIndex={currentMatchIndex}
						totalMatches={totalMatches}
						setOutputSearchQuery={setOutputSearchQuery}
						setOutputSearchRegex={setOutputSearchRegex}
						goToNextMatch={goToNextMatch}
						goToPrevMatch={goToPrevMatch}
					/>
				)}
				{/* Prose styles for markdown rendering - injected once at container level for performance */}
				<style>{proseStyles}</style>
				{/* Native scroll log list */}
				{/* overflow-anchor: disabled in AI mode when auto-scroll is off to prevent
				    browser from automatically keeping viewport pinned to bottom on new content */}
				<div
					ref={scrollContainerRef}
					className="flex-1 overflow-y-auto scrollbar-thin"
					style={{
						overflowAnchor: session.inputMode === 'ai' && autoScrollPaused ? 'none' : undefined,
					}}
					onScroll={handleScroll}
				>
					{/* Log entries */}
					{filteredLogs.map((log, index) => (
						<LogItem
							key={log.id}
							log={log}
							index={index}
							isTerminal={isTerminal}
							isAIMode={isAIMode}
							theme={theme}
							fontFamily={fontFamily}
							maxOutputLines={maxOutputLines}
							lastUserCommand={
								isTerminal && log.source !== 'user' ? getLastUserCommand(index) : undefined
							}
							isExpanded={expandedLogs.has(log.id)}
							onToggleExpanded={toggleExpanded}
							subagentLogs={childrenByParentId.get(log.id)}
							localFilterQuery={localFilters.get(log.id) || ''}
							filterMode={filterModes.get(log.id) || { mode: 'include', regex: false }}
							activeLocalFilter={activeLocalFilter}
							onToggleLocalFilter={toggleLocalFilter}
							onSetLocalFilterQuery={setLocalFilterQuery}
							onSetFilterMode={setFilterModeForLog}
							onClearLocalFilter={clearLocalFilter}
							deleteConfirmLogId={deleteConfirmLogId}
							onDeleteLog={onDeleteLog}
							onSetDeleteConfirmLogId={setDeleteConfirmLogId}
							scrollContainerRef={scrollContainerRef}
							setLightboxImage={setLightboxImage}
							copyToClipboard={copyToClipboard}
							ansiConverter={ansiConverter}
							markdownEditMode={markdownEditMode}
							onToggleMarkdownEditMode={toggleMarkdownEditMode}
							onReplayMessage={onReplayMessage}
							onForkConversation={onForkConversation}
							sessionId={session.id}
							onSessionRecover={onSessionRecover}
							isRecoveringSession={isRecoveringSession}
							sessionRecoveryError={sessionRecoveryError}
							fileTree={fileTree}
							cwd={cwd}
							projectRoot={projectRoot}
							onFileClick={onFileClick}
							sshRemoteId={
								session.sessionSshRemoteConfig?.enabled
									? (session.sessionSshRemoteConfig?.remoteId ?? undefined)
									: undefined
							}
							onShowErrorDetails={onShowErrorDetails}
							onSaveToFile={handleSaveToFile}
							ghCliAvailable={ghCliAvailable}
							onPublishGist={onPublishMessageGist}
							publishedGistUrl={publishedGists[log.id]?.gistUrl}
							bionifyReadingMode={globalBionifyReadingMode}
							bionifyIntensity={globalBionifyIntensity}
							bionifyAlgorithm={globalBionifyAlgorithm}
							userMessageAlignment={userMessageAlignment}
							isClaudeCode={session.toolType === 'claude-code'}
							isAdaptiveMode={getClaudeTokenMode(session) === 'dynamic'}
						/>
					))}

					{/* Queued items section - filtered to active tab */}
					{session.executionQueue && session.executionQueue.length > 0 && (
						<QueuedItemsList
							executionQueue={session.executionQueue}
							theme={theme}
							onRemoveQueuedItem={onRemoveQueuedItem}
							onTogglePauseQueuedItem={onTogglePauseQueuedItem}
							onEditQueuedItem={onEditQueuedItem}
							onReorderItems={
								onReorderQueuedItem
									? (fromIndex, toIndex) =>
											onReorderQueuedItem(fromIndex, toIndex, activeTabId || undefined)
									: undefined
							}
							onForceSendQueuedItem={onForceSendQueuedItem}
							forcedParallelEnabled={forcedParallelEnabled}
							getForceSendContext={getForceSendContext}
							activeTabId={activeTabId || undefined}
							onOpenLightbox={setLightboxImage}
						/>
					)}

					{/* End ref for scrolling - always rendered so Cmd+Shift+J works even when busy */}
					<div ref={logsEndRef} />
				</div>

				{/* Scroll-to-bottom / auto-scroll resume (AI mode only) */}
				{session.inputMode === 'ai' && filteredLogs.length > 0 && !isAtBottom && (
					<ScrollToBottomButton
						theme={theme}
						userMessageAlignment={userMessageAlignment}
						isAutoScrollActive={isAutoScrollActive}
						hasNewMessages={hasNewMessages}
						newMessageCount={newMessageCount}
						onClick={scrollToBottomAndResume}
					/>
				)}

				{/* Copy flash now rendered globally by <CenterFlash /> */}

				{/* Save Markdown Modal */}
				{saveModalContent !== null && (
					<SaveMarkdownModal
						theme={theme}
						content={saveModalContent}
						onClose={() => setSaveModalContent(null)}
						defaultFolder={cwd || session.cwd || ''}
						isRemoteSession={
							session.sessionSshRemoteConfig?.enabled && !!session.sessionSshRemoteConfig?.remoteId
						}
						sshRemoteId={
							session.sessionSshRemoteConfig?.enabled
								? (session.sessionSshRemoteConfig?.remoteId ?? undefined)
								: undefined
						}
						onFileSaved={onFileSaved}
						onOpenInTab={onOpenInTab}
					/>
				)}
			</div>
		);
	})
);

TerminalOutput.displayName = 'TerminalOutput';
