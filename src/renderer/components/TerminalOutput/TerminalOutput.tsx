import React, {
	useRef,
	useMemo,
	useEffect,
	useLayoutEffect,
	forwardRef,
	useCallback,
	memo,
} from 'react';
import { Loader2 } from 'lucide-react';
import type { LogEntry } from '../../types';
import type { TerminalOutputProps } from './types';
import { useAnsiConverter } from '../../hooks/ui/useAnsiConverter';
import { getActiveTab } from '../../utils/tabHelpers';
import { useTranscriptBackfill } from '../../hooks/agent/useTranscriptBackfill';
import { useDebouncedValue, useProgressiveRenderWindow } from '../../hooks';
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
import { groupSubagentToolLogs } from './utils/groupSubagentToolLogs';
import { buildRenderedIdMap } from './utils/renderedLogIds';
import { useUIStore } from '../../stores/uiStore';
import { jumpToElement } from '../../utils/jumpHighlight';
import { LogItem } from './components/LogItem';
import { OutputSearchBar } from './components/OutputSearchBar';
import { ScrollToBottomButton } from './components/ScrollToBottomButton';
import { useLogItemUiState } from './hooks/useLogItemUiState';
import { useTerminalOutputSearch } from './hooks/useTerminalOutputSearch';
import { useTerminalOutputScroll } from './hooks/useTerminalOutputScroll';

/**
 * Frames a cross-tab search jump keeps re-asserting its scroll position.
 * Rows carry `content-visibility: auto`, so ones that have never been near the
 * viewport are laid out at their `contain-intrinsic-size` estimate; the target
 * shifts as real heights replace those estimates on the way there.
 */
const JUMP_STABILIZE_FRAMES = 10;

/** How long the jump keeps auto-scroll suppressed after landing (~2x the stabilize window). */
const JUMP_SETTLE_MS = 400;

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
			forceSendShortcutEnabled = true,
			onInterrupt: _onInterrupt,
			onScrollPositionChange,
			onAtBottomChange,
			initialScrollTop,
			initialIsAtBottom,
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
		// Single inner wrapper whose border-box height equals the scrollable content
		// height. The scroll container itself only resizes with the viewport, so a
		// ResizeObserver needs this element to see content growth (image decode,
		// async font load, markdown/tool-badge layout settling) that arrives without
		// a DOM mutation.
		const contentRef = useRef<HTMLDivElement>(null);

		const activeTabId = session.activeTabId;

		const copyToClipboard = useCallback(async (text: string) => {
			const ok = await safeClipboardWrite(text);
			if (ok) {
				flashCopiedToClipboard(text);
			}
		}, []);

		// Theme-aware ANSI palette, shared with every other raw-output surface.
		const ansiConverter = useAnsiConverter(theme);

		const activeTab = useMemo(() => getActiveTab(session), [session.aiTabs, session.activeTabId]);
		const activeLogs = useMemo((): LogEntry[] => activeTab?.logs ?? [], [activeTab?.logs]);
		// Collapse FIRST so tool logs still act as response boundaries
		// (collapseAiResponseLogs treats source:'tool' as a boundary between
		// assistant segments); only THEN hide them. Tool visibility is a pure render
		// concern: tool events are always recorded (useAgentToolExecutionListener),
		// so hiding here keeps toggling from mutating log storage (the flicker bug)
		// and preserves running->completed correlation.
		const collapsedAll = useMemo(() => collapseAiResponseLogs(activeLogs), [activeLogs]);
		// Tool visibility is independent of the Thinking toggle. Reading the
		// reasoning chain and watching tool activity are separate appetites: a tab
		// can show thinking with a clean, tool-free transcript, or show tools with
		// no reasoning at all. One switch, one meaning.
		const toolsVisible = useSettingsStore((s) => s.showToolCalls);
		const showProviderModePill = useSettingsStore((s) => s.showProviderModePill);
		const collapsedLogs = useMemo(
			() => (toolsVisible ? collapsedAll : collapsedAll.filter((l) => l.source !== 'tool')),
			[collapsedAll, toolsVisible]
		);
		// Nest subagent tool badges (claude-code Task) under the tool entry that
		// spawned them; orphans and non-claude agents pass through untouched.
		const { logs: filteredLogs, childrenByParentId } = useMemo(
			() => groupSubagentToolLogs(collapsedLogs),
			[collapsedLogs]
		);
		const debouncedSearchQuery = useDebouncedValue(outputSearchQuery, 150);

		// ============================================================================
		// Progressive transcript rendering (issue #1342)
		// ============================================================================
		// Mounting every entry of a long transcript in one commit blocked the main
		// thread for seconds on agent switch (each entry runs the full remark/rehype
		// pipeline). Render the newest slice first, then backfill older history on
		// idle ticks. Prepending entries above the viewport would shift what the user
		// is reading, so snapshot distance-from-bottom before each expansion and
		// restore it in a layout effect, before the browser paints.
		const backfillBottomDistanceRef = useRef<number | null>(null);

		const handleBeforeBackfill = useCallback(() => {
			const container = scrollContainerRef.current;
			if (container) {
				backfillBottomDistanceRef.current = container.scrollHeight - container.scrollTop;
			}
		}, []);

		const {
			startIndex: logStartIndex,
			revealTo: revealLogIndex,
			absorbPrepend: absorbLogPrepend,
		} = useProgressiveRenderWindow(filteredLogs.length, `${session.id}-${activeTabId ?? ''}`, {
			onBeforeExpand: handleBeforeBackfill,
		});

		// ============================================================================
		// Scroll-to-top history backfill (issue #1407)
		// ============================================================================
		// The tab only holds the newest slice of its conversation (500 messages on
		// resume, 100 after a restart), so scrolling up used to hit a hard stop
		// mid-conversation. Reaching the top now pages older history back in from
		// the provider transcript on disk. Entries arrive at the HEAD, so hand the
		// count to the render window: it shifts by exactly that many, keeping the
		// visible slice stable and letting the idle loop mount the new history a
		// chunk at a time instead of one page-sized commit.
		const historyBackfill = useTranscriptBackfill(session, activeTab, {
			onPrepend: useCallback(
				(count: number) => {
					handleBeforeBackfill();
					absorbLogPrepend(count);
				},
				[handleBeforeBackfill, absorbLogPrepend]
			),
		});

		useLayoutEffect(() => {
			const container = scrollContainerRef.current;
			const bottomDistance = backfillBottomDistanceRef.current;
			backfillBottomDistanceRef.current = null;
			if (!container || bottomDistance === null) return;
			// Anchor to the bottom rather than the top: content was prepended, so the
			// distance from the bottom is what stayed constant for the user.
			container.scrollTop = container.scrollHeight - bottomDistance;
		}, [logStartIndex]);

		const visibleLogs = useMemo(
			() => (logStartIndex > 0 ? filteredLogs.slice(logStartIndex) : filteredLogs),
			[filteredLogs, logStartIndex]
		);

		// ============================================================================
		// Cross-tab search jump (Opt+Cmd+F -> pick a hit in another tab)
		// ============================================================================
		// The modal switches the active tab, seeds this tab's Find bar with the same
		// query, and leaves a pendingLogJump behind. Here we scroll that entry into
		// view, flash it, and hand the match index to the Find bar so next/prev
		// continues from the hit the user actually clicked.
		//
		// Raw log ids have to be resolved to the row that survived collapsing (see
		// buildRenderedIdMap) - the transcript renders far fewer rows than tab.logs.
		const renderedIdByLogId = useMemo(
			() => buildRenderedIdMap(filteredLogs, activeLogs),
			[filteredLogs, activeLogs]
		);
		const pendingLogJump = useUIStore((s) => s.pendingLogJump);
		const pendingJumpMatchIdRef = useRef<string | null>(null);
		const cancelJumpRef = useRef<(() => void) | null>(null);
		// Only cancel an in-flight jump when the transcript goes away; clearing the
		// store entry inside the effect must NOT tear down the flash we just started.
		useEffect(() => () => cancelJumpRef.current?.(), []);

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

		const {
			currentMatchIndex,
			totalMatches,
			regexError,
			goToNextMatch,
			goToPrevMatch,
			closeSearch,
		} = useTerminalOutputSearch({
			scrollContainerRef,
			terminalOutputRef,
			outputSearchOpen,
			outputSearchRegex,
			debouncedSearchQuery,
			filteredLogsLength: filteredLogs.length,
			logStartIndex,
			setOutputSearchOpen,
			setOutputSearchQuery,
			pendingJumpMatchIdRef,
		});

		const {
			isAtBottom,
			hasNewMessages,
			newMessageCount,
			autoScrollPaused,
			isAutoScrollActive,
			handleScroll,
			noteUserScrollInput,
			scrollToBottomAndResume,
			jumpInFlightRef,
			pauseForJump,
		} = useTerminalOutputScroll({
			scrollContainerRef,
			contentRef,
			initialScrollTop,
			initialIsAtBottom,
			sessionId: session.id,
			activeTabId,
			filteredLogsLength: filteredLogs.length,
			onScrollPositionChange,
			onAtBottomChange,
			onNearTop: historyBackfill.loadEarlier,
		});

		useEffect(() => {
			if (!pendingLogJump) return;
			if (pendingLogJump.sessionId !== session.id) return;
			// Wait for the tab switch to land before hunting for the entry.
			if (!activeTab || pendingLogJump.tabId !== activeTab.id) return;

			const { logId } = pendingLogJump;
			const renderedId = renderedIdByLogId.get(logId) ?? logId;
			pendingJumpMatchIdRef.current = renderedId;
			cancelJumpRef.current?.();

			// The target may still be behind the progressive render window (#1342).
			// jumpToElement gives up after ~30 frames, which idle backfill can outlast
			// on a long transcript, so pull the entry in now instead of racing it.
			const targetIndex = filteredLogs.findIndex((l) => l.id === renderedId);
			if (targetIndex >= 0) revealLogIndex(targetIndex);

			jumpInFlightRef.current = true;
			const releaseJump = () => {
				jumpInFlightRef.current = false;
			};
			const cancel = jumpToElement(
				() =>
					Array.from(
						scrollContainerRef.current?.querySelectorAll<HTMLElement>('[data-log-id]') ?? []
					).find((el) => el.getAttribute('data-log-id') === renderedId),
				{
					color: theme.colors.accent,
					// Instant rather than smooth: an animated scroll is still running
					// when the next batch of rows renders, and whoever scrolls during
					// that window wins. Landing in one frame removes the race.
					behavior: 'auto',
					stabilizeFrames: JUMP_STABILIZE_FRAMES,
					onFound: () => {
						pauseForJump();
						setTimeout(releaseJump, JUMP_SETTLE_MS);
					},
					onTimeout: releaseJump,
				}
			);
			// Releasing on cancel matters: a jump abandoned before it landed would
			// otherwise leave auto-scroll suppressed for the rest of the session.
			cancelJumpRef.current = () => {
				releaseJump();
				cancel();
			};
			// Consume it: the jump is a one-shot request, not persistent state.
			useUIStore.getState().clearPendingLogJump(logId);
		}, [
			pendingLogJump,
			session.id,
			activeTab,
			renderedIdByLogId,
			theme.colors.accent,
			jumpInFlightRef,
			pauseForJump,
			filteredLogs,
			revealLogIndex,
		]);

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
						onClose={closeSearch}
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
						// The AI Chat surface's own size. Set here and inherited by every
						// log row rather than threaded as a prop: the transcript is DOM,
						// so the CSS variable reaches the whole subtree - including the
						// markdown, tool cards, and code fences nested several
						// components deep - without touching any of them. The family
						// still arrives as a prop because individual rows override it.
						fontSize: 'var(--maestro-size-chat, inherit)',
					}}
					onScroll={handleScroll}
					// The input events that prove a scroll is the user's. `scroll` itself
					// cannot: this component writes `scrollTop` on every frame of a restore
					// and on every mutation while following the tail, and each of those
					// writes fires an indistinguishable `scroll` event.
					onWheel={noteUserScrollInput}
					onTouchMove={noteUserScrollInput}
					onPointerDown={noteUserScrollInput}
					onKeyDown={noteUserScrollInput}
				>
					{/* Content wrapper: unstyled block so its height tracks the scrollable
					    content exactly, giving the scroll hook's ResizeObserver something
					    that grows when late content settles. */}
					<div ref={contentRef}>
						{/* Older-history status row (issue #1407). Only meaningful once the
						    idle render window has reached the head of the list - above that
						    point there is still local history left to mount, so "beginning of
						    conversation" would be a lie. Nothing renders until the user has
						    actually scrolled up far enough to trigger a read. */}
						{logStartIndex === 0 && filteredLogs.length > 0 && (
							<>
								{historyBackfill.isLoading && (
									<div
										className="flex items-center justify-center gap-2 py-3 text-xs"
										style={{ color: theme.colors.textDim }}
									>
										<Loader2 className="w-3.5 h-3.5 animate-spin" />
										Loading earlier messages...
									</div>
								)}
								{!historyBackfill.isLoading && historyBackfill.error && (
									<div
										className="flex items-center justify-center gap-2 py-3 text-xs"
										style={{ color: theme.colors.textDim }}
									>
										{historyBackfill.error}
										<button
											onClick={historyBackfill.loadEarlier}
											className="underline hover:opacity-80 transition-opacity"
											style={{ color: theme.colors.textMain }}
										>
											Retry
										</button>
									</div>
								)}
								{!historyBackfill.isLoading &&
									!historyBackfill.error &&
									historyBackfill.reachedStart && (
										<div
											className="flex items-center justify-center py-3 text-xs"
											style={{ color: theme.colors.textDim }}
										>
											Beginning of conversation
										</div>
									)}
							</>
						)}
						{/* Log entries */}
						{visibleLogs.map((log, visibleIndex) => {
							// Absolute index into filteredLogs - sibling lookups (echo stripping)
							// and jump-to-message targeting must not see the window offset.
							const index = logStartIndex + visibleIndex;
							return (
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
									showProviderModePill={showProviderModePill}
								/>
							);
						})}

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
								shortcutEnabled={forceSendShortcutEnabled}
								activeTabId={activeTabId || undefined}
								onOpenLightbox={setLightboxImage}
							/>
						)}
					</div>

					{/* End ref for scrolling - always rendered so the jump works even when busy.
					    LOAD-BEARING: this marker MUST stay a direct child of the scroll container
					    (the overflow-y-auto element above), NOT nested inside the contentRef wrapper.
					    useMainKeyboardHandler's Cmd+Shift+J "Jump to Bottom" resolves the scroll target
					    via logsEndRef.current.parentElement, so if you wrap this marker in another
					    subtree parentElement lands on an unscrollable element and it silently no-ops. */}
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
