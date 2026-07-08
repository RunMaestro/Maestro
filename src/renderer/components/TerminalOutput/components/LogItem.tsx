import React, { useRef, useCallback, memo } from 'react';
import {
	ChevronDown,
	ChevronUp,
	Trash2,
	Copy,
	Check,
	Eye,
	FileText,
	RotateCcw,
	AlertCircle,
	Save,
	Share2,
	Hammer,
	GitFork,
} from 'lucide-react';
import type Convert from 'ansi-to-html';
import type { LogItemProps } from '../types';
import {
	processLogTextHelper,
	filterTextByLinesHelper,
	getCachedAnsiHtml,
} from '../../../utils/textProcessing';
import { JumpToMessageTopButton } from '../../JumpToMessageTopButton';
import { formatShortcutKeys } from '../../../utils/shortcutFormatter';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import { LogFilterControls } from '../../LogFilterControls';
import { linkifyNode } from '../../../utils/linkify';
import { RetryStatusCard } from '../../RetryStatusCard';
import { getTokenSourcePill } from '../../../../shared/claudeTokenModeLabel';
import { CrossAgentResponseHeader } from '../../CrossAgentResponseHeader';
import { summarizeToolInput, summarizeToolOutput } from '../utils/toolSummaries';
import { isHiddenProgressEntry } from '../utils/logEntryHelpers';
import { SessionRecoveryCardConnector } from './SessionRecoveryCardConnector';

export const LogItem = memo(
	({
		log,
		index,
		isTerminal,
		isAIMode,
		theme,
		fontFamily,
		maxOutputLines,
		lastUserCommand,
		isExpanded,
		onToggleExpanded,
		localFilterQuery,
		filterMode,
		activeLocalFilter,
		onToggleLocalFilter,
		onSetLocalFilterQuery,
		onSetFilterMode,
		onClearLocalFilter,
		deleteConfirmLogId,
		onDeleteLog,
		onSetDeleteConfirmLogId,
		scrollContainerRef,
		setLightboxImage,
		copyToClipboard,
		ansiConverter,
		markdownEditMode,
		onToggleMarkdownEditMode,
		onReplayMessage,
		fileTree,
		cwd,
		projectRoot,
		onFileClick,
		sshRemoteId,
		onShowErrorDetails,
		onSaveToFile,
		ghCliAvailable,
		onPublishGist,
		publishedGistUrl,
		onForkConversation,
		bionifyReadingMode,
		bionifyIntensity,
		bionifyAlgorithm,
		userMessageAlignment,
		isClaudeCode,
		isAdaptiveMode,
		sessionId,
		onSessionRecover,
		isRecoveringSession,
		sessionRecoveryError,
	}: LogItemProps) => {
		// Ref for the log item container - used for scroll-into-view on expand
		const logItemRef = useRef<HTMLDivElement>(null);

		// Handle expand toggle with scroll adjustment
		const handleExpandToggle = useCallback(() => {
			const wasExpanded = isExpanded;
			onToggleExpanded(log.id);

			// After expanding, scroll to ensure the bottom of the item is visible
			if (!wasExpanded) {
				// Use setTimeout to wait for the DOM to update after expansion
				setTimeout(() => {
					const logItem = logItemRef.current;
					const container = scrollContainerRef.current;
					if (logItem && container) {
						const itemRect = logItem.getBoundingClientRect();
						const containerRect = container.getBoundingClientRect();

						// Check if the bottom of the item is below the visible area
						const itemBottom = itemRect.bottom;
						const containerBottom = containerRect.bottom;

						if (itemBottom > containerBottom) {
							// Scroll to show the bottom of the item with some padding
							const scrollAmount = itemBottom - containerBottom + 20; // 20px padding
							container.scrollBy({ top: scrollAmount, behavior: 'smooth' });
						}
					}
				}, 50); // Small delay to allow React to re-render
			}
		}, [isExpanded, log.id, onToggleExpanded, scrollContainerRef]);

		// Strip command echo from terminal output
		let textToProcess = log.text;
		if (isTerminal && log.source !== 'user' && lastUserCommand) {
			if (textToProcess.startsWith(lastUserCommand)) {
				textToProcess = textToProcess.slice(lastUserCommand.length);
				if (textToProcess.startsWith('\r\n')) {
					textToProcess = textToProcess.slice(2);
				} else if (textToProcess.startsWith('\n') || textToProcess.startsWith('\r')) {
					textToProcess = textToProcess.slice(1);
				}
			}
		}

		const processedText = processLogTextHelper(textToProcess, isTerminal && log.source !== 'user');

		// Skip rendering stderr entries that have no actual content
		if (log.source === 'stderr' && !processedText.trim()) {
			return null;
		}

		// Separate stdout and stderr for terminal output
		const separated =
			log.source === 'stderr'
				? { stdout: '', stderr: processedText }
				: { stdout: processedText, stderr: '' };

		// Apply local filter if active for this log entry
		const filteredStdout =
			localFilterQuery && log.source !== 'user'
				? filterTextByLinesHelper(
						separated.stdout,
						localFilterQuery,
						filterMode.mode,
						filterMode.regex
					)
				: separated.stdout;
		const filteredStderr =
			localFilterQuery && log.source !== 'user'
				? filterTextByLinesHelper(
						separated.stderr,
						localFilterQuery,
						filterMode.mode,
						filterMode.regex
					)
				: separated.stderr;

		// Check if filter returned no results
		const hasNoMatches =
			localFilterQuery && !filteredStdout.trim() && !filteredStderr.trim() && log.source !== 'user';

		// For stderr entries, use stderr content; for all others, use stdout content
		const contentToDisplay = log.source === 'stderr' ? filteredStderr : filteredStdout;

		// PERF: Convert ANSI codes to HTML using cache.
		// Search highlighting is now applied at the scroll-container level via CSS Custom
		// Highlight API in TerminalOutput, so per-log markers are no longer needed.
		const htmlContent =
			isTerminal && log.source !== 'user'
				? getCachedAnsiHtml(contentToDisplay, theme.id, ansiConverter)
				: contentToDisplay;

		const filteredText = contentToDisplay;

		// Count lines in the filtered text
		const lineCount = filteredText.split('\n').length;
		const shouldCollapse = lineCount > maxOutputLines && maxOutputLines !== Infinity;

		// Truncate text if collapsed
		const displayText =
			shouldCollapse && !isExpanded
				? filteredText.split('\n').slice(0, maxOutputLines).join('\n')
				: filteredText;

		// PERF: Sanitize with DOMPurify, using cache for ANSI conversion.
		// Search highlighting is handled at the scroll-container level.
		const displayHtmlContent =
			shouldCollapse && !isExpanded && isTerminal && log.source !== 'user'
				? getCachedAnsiHtml(displayText, theme.id, ansiConverter)
				: htmlContent;

		const isUserMessage = log.source === 'user';
		const isReversed = isUserMessage
			? userMessageAlignment === 'left'
			: userMessageAlignment === 'right';

		// Agent Resilience: an outage marker renders as a live status card in a
		// clean row (no error-tinted bubble chrome), left gutter kept for alignment.
		if (log.retryOutageId) {
			return (
				<div
					ref={logItemRef}
					className="flex gap-4 px-3 sm:px-6 py-2"
					data-log-index={index}
					style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 120px' }}
				>
					<div className="hidden sm:block w-20 shrink-0" />
					<div className="flex-1 min-w-0">
						<RetryStatusCard outageId={log.retryOutageId} theme={theme} fallbackText={log.text} />
					</div>
				</div>
			);
		}

		// Cross-agent (@@mention) reply provenance. When set, this AI entry was
		// produced by a DIFFERENT agent the user consulted; it gets a tinted
		// bubble + attribution pill (Phase 04). Themes may override the tint via
		// the crossAgentBubbleBg / crossAgentBubbleBorder tokens; otherwise we
		// derive a subtle accent wash with the same color-mix idiom the user
		// bubble uses below, so every theme reads correctly for free.
		const crossAgent = log.metadata?.crossAgent;
		const isCrossAgentStreaming = !!crossAgent?.streaming;
		// Phase 05: a failed consult surfaces inline as a red-tinted variant of the
		// cross-agent bubble (never throws). Otherwise the normal accent wash.
		const isCrossAgentError = !!crossAgent?.error;
		const crossAgentBubbleBg = isCrossAgentError
			? `color-mix(in srgb, ${theme.colors.error} 12%, ${theme.colors.bgActivity})`
			: (theme.colors.crossAgentBubbleBg ??
				`color-mix(in srgb, ${theme.colors.accent} 14%, ${theme.colors.bgActivity})`);
		const crossAgentBubbleBorder = isCrossAgentError
			? theme.colors.error + '66'
			: (theme.colors.crossAgentBubbleBorder ?? theme.colors.accent + '55');

		return (
			<div
				ref={logItemRef}
				// Narrow screens (phones / web-desktop mobile): the fixed side gutter
				// for the timestamp costs ~96px of bubble width, so the row stacks -
				// timestamp above, bubble full-width. From `sm` up it's the classic
				// side-by-side layout with the w-20 timestamp column.
				className={`flex flex-col gap-1 sm:gap-4 group ${isReversed ? 'sm:flex-row-reverse' : 'sm:flex-row'} px-3 sm:px-6 py-2`}
				data-log-index={index}
				// PERF: the transcript is not virtualized, so every message stays in the
				// DOM. content-visibility:auto lets the browser skip style/layout/paint for
				// off-screen rows (the dominant scroll cost - a huge static layer tree the
				// compositor re-walked every frame). contain-intrinsic-size: 'auto <fallback>'
				// reserves height so the scrollbar stays stable; `auto` makes the browser
				// remember each row's real rendered size after it's been shown once. No DOM,
				// React, or behavior change - purely a rendering hint.
				style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 120px' }}
			>
				<div
					className={`shrink-0 text-[10px] sm:w-20 sm:pt-2 flex gap-1 sm:block ${isReversed ? 'text-right justify-end' : 'text-left'}`}
					style={{ fontFamily, color: theme.colors.textDim, opacity: 0.6 }}
				>
					{(() => {
						const logDate = new Date(log.timestamp);
						const today = new Date();
						const isToday = logDate.toDateString() === today.toDateString();
						const time = logDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
						if (isToday) {
							return time;
						}
						// Format: YYYY-MM-DD on first line, time on second
						const year = logDate.getFullYear();
						const month = String(logDate.getMonth() + 1).padStart(2, '0');
						const day = String(logDate.getDate()).padStart(2, '0');
						return (
							<>
								<div>
									{year}-{month}-{day}
								</div>
								<div>{time}</div>
							</>
						);
					})()}
				</div>
				<div
					className={`flex-1 min-w-0 p-4 pb-10 rounded-xl border ${isReversed ? 'rounded-tr-none' : 'rounded-tl-none'} relative overflow-hidden ${isCrossAgentStreaming ? 'animate-status-glow' : ''}`}
					style={{
						backgroundColor: crossAgent
							? crossAgentBubbleBg
							: isUserMessage
								? isAIMode
									? `color-mix(in srgb, ${theme.colors.accent} 20%, ${theme.colors.bgSidebar})`
									: `color-mix(in srgb, ${theme.colors.accent} 15%, ${theme.colors.bgActivity})`
								: log.source === 'stderr' || log.source === 'error'
									? `color-mix(in srgb, ${theme.colors.error} 8%, ${theme.colors.bgActivity})`
									: isAIMode
										? theme.colors.bgActivity
										: 'transparent',
						borderColor: crossAgent
							? crossAgentBubbleBorder
							: isUserMessage && isAIMode
								? theme.colors.accent + '40'
								: log.source === 'stderr' || log.source === 'error'
									? theme.colors.error
									: theme.colors.border,
						// Drives the accent hue of the streaming pulse (.animate-status-glow).
						...(isCrossAgentStreaming
							? ({ '--status-glow-color': theme.colors.accent } as React.CSSProperties)
							: {}),
					}}
				>
					{/* Cross-agent attribution header - this AI reply was routed back from a
					    DIFFERENT agent the user consulted via @mention. Names the agent,
					    provider, and session id, and offers two ways to jump into that
					    agent to continue the dialogue. Streaming shows a spinner; a failed
					    consult tints it red. In a group fan-out it's what tells each
					    response apart. */}
					{crossAgent && <CrossAgentResponseHeader crossAgent={crossAgent} theme={theme} />}
					{/* Local filter icon for system output only */}
					{log.source !== 'user' && isTerminal && (
						<div className="absolute top-2 right-2 flex items-center gap-2">
							<LogFilterControls
								logId={log.id}
								fontFamily={fontFamily}
								theme={theme}
								filterQuery={localFilterQuery}
								filterMode={filterMode}
								isActive={activeLocalFilter === log.id}
								onToggleFilter={onToggleLocalFilter}
								onSetFilterQuery={onSetLocalFilterQuery}
								onSetFilterMode={onSetFilterMode}
								onClearFilter={onClearLocalFilter}
							/>
						</div>
					)}
					{log.images && log.images.length > 0 && (
						<div
							className="flex gap-2 mb-2 overflow-x-auto scrollbar-thin"
							style={{ overscrollBehavior: 'contain' }}
						>
							{log.images.map((img, imgIdx) => (
								<button
									key={`${img}-${imgIdx}`}
									type="button"
									className="shrink-0 p-0 bg-transparent outline-none focus:ring-2 focus:ring-accent rounded"
									onClick={() => setLightboxImage(img, log.images, 'history')}
								>
									<img
										src={img}
										alt={`Terminal output image ${imgIdx + 1}`}
										className="h-20 rounded border cursor-zoom-in block"
										style={{ objectFit: 'contain', maxWidth: '200px' }}
									/>
								</button>
							))}
						</div>
					)}
					{log.source === 'stderr' && (
						<div className="mb-2">
							<span
								className="px-2 py-1 rounded text-xs font-bold uppercase tracking-wide"
								style={{
									backgroundColor: theme.colors.error,
									color: '#fff',
								}}
							>
								STDERR
							</span>
						</div>
					)}
					{/* Special rendering for error log entries */}
					{log.source === 'error' && (
						<div className="flex flex-col gap-3">
							<div className="flex items-center gap-2">
								<AlertCircle className="w-5 h-5" style={{ color: theme.colors.error }} />
								<span className="text-sm font-medium" style={{ color: theme.colors.error }}>
									Error
								</span>
							</div>
							<div className="text-sm" style={{ color: theme.colors.textMain }}>
								<MarkdownRenderer
									content={log.text}
									theme={theme}
									onCopy={copyToClipboard}
									fileTree={fileTree}
									cwd={cwd}
									projectRoot={projectRoot}
									onFileClick={onFileClick}
									sshRemoteId={sshRemoteId}
									chatLineBreaks
									chatMath
								/>
							</div>
							{!!log.agentError?.parsedJson && onShowErrorDetails && (
								<button
									onClick={() => onShowErrorDetails(log.agentError!)}
									className="self-start flex items-center gap-2 px-3 py-1.5 text-xs rounded border hover:opacity-80 transition-opacity"
									style={{
										backgroundColor: theme.colors.error + '15',
										borderColor: theme.colors.error + '40',
										color: theme.colors.error,
									}}
								>
									<Eye className="w-3 h-3" />
									View Details
								</button>
							)}
						</div>
					)}
					{/* Special rendering for thinking/streaming content (AI reasoning in real-time) */}
					{log.source === 'thinking' && (
						<div
							className="px-4 py-2 text-sm font-mono border-l-2"
							style={{
								color: theme.colors.textMain,
								borderColor: theme.colors.accent,
							}}
						>
							<div className="flex items-center gap-2 mb-1">
								<span
									className="text-[10px] px-1.5 py-0.5 rounded"
									style={{
										backgroundColor: `${theme.colors.accent}30`,
										color: theme.colors.accent,
									}}
								>
									thinking
								</span>
							</div>
							<div className="whitespace-pre-wrap text-sm break-words">
								{isAIMode && !markdownEditMode ? (
									<MarkdownRenderer
										content={log.text}
										theme={theme}
										onCopy={copyToClipboard}
										enableBionifyReadingMode={bionifyReadingMode}
										bionifyIntensity={bionifyIntensity}
										bionifyAlgorithm={bionifyAlgorithm}
										fileTree={fileTree}
										cwd={cwd}
										projectRoot={projectRoot}
										onFileClick={onFileClick}
										sshRemoteId={sshRemoteId}
										chatLineBreaks
										chatMath
									/>
								) : (
									log.text
								)}
							</div>
						</div>
					)}
					{isHiddenProgressEntry(log) && (
						<div
							className="px-4 py-1.5 text-xs border-l-2"
							style={{
								color: theme.colors.textMain,
								borderColor: theme.colors.accent,
							}}
						>
							<div className="flex items-start gap-2">
								<span
									className="px-1.5 py-0.5 rounded shrink-0"
									style={{
										backgroundColor: `${theme.colors.accent}30`,
										color: theme.colors.accent,
									}}
								>
									{log.metadata?.hiddenProgress?.kind === 'tool'
										? log.metadata.hiddenProgress.toolName || 'working'
										: 'thinking'}
								</span>
								{log.metadata?.toolState?.status === 'completed' ? (
									<span className="shrink-0 pt-0.5" style={{ color: theme.colors.success }}>
										✓
									</span>
								) : log.metadata?.toolState?.status === 'failed' ||
								  log.metadata?.toolState?.status === 'error' ? (
									<span className="shrink-0 pt-0.5" style={{ color: theme.colors.error }}>
										!
									</span>
								) : (
									<span
										className="animate-pulse shrink-0 pt-0.5"
										style={{ color: theme.colors.warning }}
									>
										●
									</span>
								)}
								<span
									className="break-words whitespace-pre-wrap opacity-80"
									style={{ color: theme.colors.textMain }}
								>
									{log.text}
								</span>
							</div>
						</div>
					)}
					{/* Special rendering for tool execution events (shown alongside thinking) */}
					{log.source === 'tool' &&
						(() => {
							// Extract tool input details for display
							const toolInput = log.metadata?.toolState?.input;
							const toolSummary =
								toolInput !== undefined && toolInput !== null
									? summarizeToolInput(toolInput)
									: null;
							// Show the tool result once it has finished. Without this the
							// compact tool log drops the output entirely (e.g. MCP calls
							// like squash_repos that take no args render as a bare name).
							const toolStatus = log.metadata?.toolState?.status;
							const outputSummary =
								toolStatus === 'completed' || toolStatus === 'failed' || toolStatus === 'error'
									? summarizeToolOutput(log.metadata?.toolState?.output)
									: null;

							return (
								<div
									className="px-4 py-1.5 text-xs font-mono border-l-2"
									style={{
										color: theme.colors.textMain,
										borderColor: theme.colors.accent,
									}}
								>
									<div className="flex items-start gap-2">
										<span
											className="px-1.5 py-0.5 rounded shrink-0"
											style={{
												backgroundColor: `${theme.colors.accent}30`,
												color: theme.colors.accent,
											}}
										>
											{log.text}
										</span>
										{log.metadata?.toolState?.status === 'running' && (
											<span
												className="animate-pulse shrink-0 pt-0.5"
												style={{ color: theme.colors.warning }}
											>
												●
											</span>
										)}
										{log.metadata?.toolState?.status === 'completed' && (
											<span className="shrink-0 pt-0.5" style={{ color: theme.colors.success }}>
												✓
											</span>
										)}
										{log.metadata?.toolState?.status === 'failed' && (
											<span className="shrink-0 pt-0.5" style={{ color: theme.colors.error }}>
												!
											</span>
										)}
										{toolSummary?.description && (
											<span
												className="opacity-50 break-words"
												style={{ color: theme.colors.textMain }}
											>
												{toolSummary.description}
											</span>
										)}
									</div>
									{toolSummary?.detail && (
										<div
											className="mt-1 ml-1 pl-2 opacity-70 break-words whitespace-pre-wrap border-l"
											style={{
												color: theme.colors.textMain,
												borderColor: `${theme.colors.accent}40`,
											}}
										>
											{toolSummary.detail}
										</div>
									)}
									{outputSummary && (
										<div
											className="mt-1 ml-1 pl-2 opacity-60 break-words whitespace-pre-wrap border-l"
											style={{
												color: theme.colors.textMain,
												borderColor: `${theme.colors.success}40`,
											}}
										>
											{outputSummary}
										</div>
									)}
								</div>
							);
						})()}
					{!isHiddenProgressEntry(log) &&
						log.source !== 'error' &&
						log.source !== 'thinking' &&
						log.source !== 'tool' &&
						(hasNoMatches ? (
							<div
								className="flex items-center justify-center py-8 text-sm"
								style={{ color: theme.colors.textDim }}
							>
								<span>No matches found for filter</span>
							</div>
						) : shouldCollapse && !isExpanded ? (
							<div>
								<div
									className={`${isTerminal && log.source !== 'user' ? 'whitespace-pre text-sm' : 'whitespace-pre-wrap text-sm break-words'}`}
									style={{
										maxHeight: `${maxOutputLines * 1.5}em`,
										overflow: isTerminal && log.source !== 'user' ? 'hidden' : 'hidden',
										color: theme.colors.textMain,
										fontFamily,
										overflowWrap: isTerminal && log.source !== 'user' ? undefined : 'break-word',
									}}
								>
									{isTerminal && log.source !== 'user' ? (
										// Content sanitized with DOMPurify above
										// Horizontal scroll for terminal output to preserve column alignment
										<div
											className="overflow-x-auto scrollbar-thin"
											dangerouslySetInnerHTML={{ __html: displayHtmlContent }}
										/>
									) : isAIMode && !markdownEditMode ? (
										// Collapsed markdown preview with rendered markdown
										<MarkdownRenderer
											content={displayText}
											theme={theme}
											onCopy={copyToClipboard}
											enableBionifyReadingMode={bionifyReadingMode}
											bionifyIntensity={bionifyIntensity}
											bionifyAlgorithm={bionifyAlgorithm}
											fileTree={fileTree}
											cwd={cwd}
											projectRoot={projectRoot}
											onFileClick={onFileClick}
											sshRemoteId={sshRemoteId}
											chatLineBreaks
											chatMath
										/>
									) : (
										displayText
									)}
								</div>
								<button
									onClick={handleExpandToggle}
									className="flex items-center gap-2 mt-2 text-xs px-3 py-1.5 rounded border hover:opacity-70 transition-opacity"
									style={{
										borderColor: theme.colors.border,
										backgroundColor: theme.colors.bgActivity,
										color: theme.colors.accent,
									}}
								>
									<ChevronDown className="w-3 h-3" />
									Show all {lineCount} lines
								</button>
							</div>
						) : shouldCollapse && isExpanded ? (
							<div>
								<div
									className={`${isTerminal && log.source !== 'user' ? 'whitespace-pre text-sm scrollbar-thin' : 'whitespace-pre-wrap text-sm break-words'}`}
									style={{
										maxHeight: '600px',
										overflow: 'auto',
										overscrollBehavior: 'contain',
										color: theme.colors.textMain,
										fontFamily,
										overflowWrap: isTerminal && log.source !== 'user' ? undefined : 'break-word',
									}}
									onWheel={(e) => {
										// Prevent scroll from propagating to parent when this container can scroll
										const el = e.currentTarget;
										const { scrollTop, scrollHeight, clientHeight } = el;
										const atTop = scrollTop <= 0;
										const atBottom = scrollTop + clientHeight >= scrollHeight - 1;

										// Only stop propagation if we're not at the boundary we're scrolling towards
										if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) {
											e.stopPropagation();
										}
									}}
								>
									{isTerminal && log.source !== 'user' ? (
										// Content sanitized with DOMPurify above
										// Horizontal scroll for terminal output to preserve column alignment
										<div dangerouslySetInnerHTML={{ __html: displayHtmlContent }} />
									) : log.source === 'user' && isTerminal ? (
										<div style={{ fontFamily }}>
											<span style={{ color: theme.colors.accent }}>$ </span>
											{filteredText}
										</div>
									) : log.aiCommand ? (
										<div className="space-y-3">
											<div
												className="flex items-center gap-2 px-3 py-2 rounded-lg border"
												style={{
													backgroundColor: theme.colors.accent + '15',
													borderColor: theme.colors.accent + '30',
												}}
											>
												<span
													className="font-mono font-bold text-sm"
													style={{ color: theme.colors.accent }}
												>
													{log.aiCommand.command}:
												</span>
												<span className="text-sm" style={{ color: theme.colors.textMain }}>
													{log.aiCommand.description}
												</span>
											</div>
											<div>{linkifyNode(filteredText, theme)}</div>
										</div>
									) : isAIMode && !markdownEditMode ? (
										// Expanded markdown rendering
										<MarkdownRenderer
											content={filteredText}
											theme={theme}
											onCopy={copyToClipboard}
											enableBionifyReadingMode={bionifyReadingMode}
											bionifyIntensity={bionifyIntensity}
											bionifyAlgorithm={bionifyAlgorithm}
											fileTree={fileTree}
											cwd={cwd}
											projectRoot={projectRoot}
											onFileClick={onFileClick}
											sshRemoteId={sshRemoteId}
											chatLineBreaks
											chatMath
										/>
									) : (
										<div>{filteredText}</div>
									)}
								</div>
								<button
									onClick={handleExpandToggle}
									className="flex items-center gap-2 mt-2 text-xs px-3 py-1.5 rounded border hover:opacity-70 transition-opacity"
									style={{
										borderColor: theme.colors.border,
										backgroundColor: theme.colors.bgActivity,
										color: theme.colors.accent,
									}}
								>
									<ChevronUp className="w-3 h-3" />
									Show less
								</button>
							</div>
						) : (
							<>
								{isTerminal && log.source !== 'user' ? (
									// Content sanitized with DOMPurify above
									<div
										className="whitespace-pre text-sm overflow-x-auto scrollbar-thin"
										style={{
											color: theme.colors.textMain,
											fontFamily,
											overscrollBehavior: 'contain',
										}}
										dangerouslySetInnerHTML={{ __html: displayHtmlContent }}
									/>
								) : log.source === 'user' && isTerminal ? (
									<div
										className="whitespace-pre-wrap text-sm break-words"
										style={{ color: theme.colors.textMain, fontFamily }}
									>
										<span style={{ color: theme.colors.accent }}>$ </span>
										{filteredText}
									</div>
								) : log.aiCommand ? (
									<div className="space-y-3">
										<div
											className="flex items-center gap-2 px-3 py-2 rounded-lg border"
											style={{
												backgroundColor: theme.colors.accent + '15',
												borderColor: theme.colors.accent + '30',
											}}
										>
											<span
												className="font-mono font-bold text-sm"
												style={{ color: theme.colors.accent }}
											>
												{log.aiCommand.command}:
											</span>
											<span className="text-sm" style={{ color: theme.colors.textMain }}>
												{log.aiCommand.description}
											</span>
										</div>
										<div
											className="whitespace-pre-wrap text-sm break-words"
											style={{ color: theme.colors.textMain }}
										>
											{linkifyNode(filteredText, theme)}
										</div>
									</div>
								) : isAIMode && !markdownEditMode ? (
									// Rendered markdown for AI responses
									<MarkdownRenderer
										content={filteredText}
										theme={theme}
										onCopy={copyToClipboard}
										enableBionifyReadingMode={bionifyReadingMode}
										bionifyIntensity={bionifyIntensity}
										bionifyAlgorithm={bionifyAlgorithm}
										fileTree={fileTree}
										cwd={cwd}
										projectRoot={projectRoot}
										onFileClick={onFileClick}
										sshRemoteId={sshRemoteId}
										chatLineBreaks
										chatMath
									/>
								) : (
									// Raw markdown source mode (show original text with markdown syntax visible)
									<div
										className="whitespace-pre-wrap text-sm break-words"
										style={{ color: theme.colors.textMain }}
									>
										{filteredText}
									</div>
								)}
							</>
						))}
					{/* Session-not-found recovery card. Rendered inline directly
					    under the system message that announced the dead session. The
					    card reads the tab from the store so we don't have to pass the
					    full Session through LogItem (would defeat memoization). */}
					{log.recoveryAction && (
						<SessionRecoveryCardConnector
							theme={theme}
							sessionId={sessionId}
							recoveryAction={log.recoveryAction}
							isRecovering={!!isRecoveringSession}
							recoveryError={sessionRecoveryError ?? null}
							onRecover={(opts) => onSessionRecover?.(opts)}
						/>
					)}
					{/* Cross-agent attribution now lives in the header at the TOP of the
					    bubble (CrossAgentResponseHeader); no bottom pill is rendered here. */}
					{/* Mode pill — shows which CLI captured this Claude turn (TUI Wrapper =
					    maestro-p, claude -p = claude --print). "Dynamic " prefix indicates the
					    session has Dynamic Mode enabled (auto-switching between the two).
					    Suppressed on cross-agent entries so the attribution pill above
					    replaces it. */}
					{!crossAgent &&
						isClaudeCode &&
						log.source !== 'user' &&
						(() => {
							const { label, title } = getTokenSourcePill({
								mode: log.renderStyle === 'text-stream' ? 'interactive' : 'api',
								adaptive: isAdaptiveMode,
							});
							return (
								<span
									className="absolute bottom-2 left-1/2 -translate-x-1/2 text-[10px] px-1.5 py-0.5 rounded pointer-events-none select-none"
									style={{
										backgroundColor: `${theme.colors.accent}20`,
										color: theme.colors.accent,
										opacity: 0.7,
									}}
									title={title}
								>
									{label}
								</span>
							);
						})()}
					{/* Jump to top of this message - bottom left corner */}
					<JumpToMessageTopButton
						scrollContainerRef={scrollContainerRef}
						messageRef={logItemRef}
						theme={theme}
					/>
					{/* Action buttons - bottom right corner */}
					<div
						className="absolute bottom-2 right-2 flex items-center gap-1"
						style={{ transition: 'opacity 0.15s ease-in-out' }}
					>
						{/* Markdown toggle button — available on both user and assistant
						    messages in AI mode for consistent UX (#622). */}
						{isAIMode && (
							<button
								onClick={onToggleMarkdownEditMode}
								className="p-1.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100"
								style={{ color: markdownEditMode ? theme.colors.accent : theme.colors.textDim }}
								title={
									markdownEditMode
										? `Show formatted (${formatShortcutKeys(['Meta', 'e'])})`
										: `Show plain text (${formatShortcutKeys(['Meta', 'e'])})`
								}
							>
								{markdownEditMode ? <Eye className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
							</button>
						)}
						{/* Replay button for user messages in AI mode */}
						{isUserMessage && isAIMode && onReplayMessage && (
							<button
								onClick={() => onReplayMessage(log.text, log.images)}
								className="p-1.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100"
								style={{ color: theme.colors.textDim }}
								title="Replay message"
							>
								<RotateCcw className="w-3.5 h-3.5" />
							</button>
						)}
						{/* Copy to Clipboard Button */}
						<button
							onClick={() => copyToClipboard(log.text)}
							className="p-1.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100"
							style={{ color: theme.colors.textDim }}
							title="Copy to clipboard"
						>
							<Copy className="w-3.5 h-3.5" />
						</button>
						{/* Save to File Button - only for AI responses */}
						{log.source !== 'user' && isAIMode && onSaveToFile && (
							<button
								onClick={() => onSaveToFile(log.text)}
								className="p-1.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100"
								style={{ color: theme.colors.textDim }}
								title="Save to file"
							>
								<Save className="w-3.5 h-3.5" />
							</button>
						)}
						{/* Fork conversation — user messages and AI responses (source='stdout' in AI mode, or 'ai' if ever set) */}
						{(log.source === 'user' || log.source === 'ai' || log.source === 'stdout') &&
							isAIMode &&
							onForkConversation && (
								<button
									onClick={() => onForkConversation(log.id)}
									className="p-1.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100"
									style={{ color: theme.colors.textDim }}
									title="Fork conversation from here"
								>
									<GitFork className="w-3.5 h-3.5" />
								</button>
							)}
						{/* Publish to GitHub Gist - only for AI responses when gh CLI available */}
						{log.source !== 'user' && isAIMode && ghCliAvailable && onPublishGist && (
							<button
								onClick={() => onPublishGist(log.text, log.id)}
								className={`p-1.5 rounded hover:!opacity-100 ${
									publishedGistUrl ? 'opacity-100' : 'opacity-0 group-hover:opacity-50'
								}`}
								style={{
									color: publishedGistUrl ? theme.colors.accent : theme.colors.textDim,
								}}
								title={
									publishedGistUrl
										? `Published as Gist: ${publishedGistUrl}`
										: 'Publish as GitHub Gist'
								}
							>
								<Share2 className="w-3.5 h-3.5" />
							</button>
						)}
						{/* Delete button for user messages (both AI and terminal modes) */}
						{log.source === 'user' &&
							onDeleteLog &&
							(deleteConfirmLogId === log.id ? (
								<div
									className="flex items-center gap-1 p-1 rounded border"
									style={{
										backgroundColor: theme.colors.bgSidebar,
										borderColor: theme.colors.error,
									}}
								>
									<span className="text-xs px-1" style={{ color: theme.colors.error }}>
										Delete?
									</span>
									<button
										onClick={() => {
											const nextIndex = onDeleteLog(log.id);
											onSetDeleteConfirmLogId(null);
											if (nextIndex !== null && nextIndex >= 0) {
												setTimeout(() => {
													const container = scrollContainerRef.current;
													const items = container?.querySelectorAll('[data-log-index]');
													const targetItem = items?.[nextIndex] as HTMLElement;
													if (targetItem && container) {
														container.scrollTop = targetItem.offsetTop;
													}
												}, 50);
											}
										}}
										className="px-2 py-0.5 rounded text-xs font-medium hover:opacity-80"
										style={{ backgroundColor: theme.colors.error, color: '#fff' }}
									>
										Yes
									</button>
									<button
										onClick={() => onSetDeleteConfirmLogId(null)}
										className="px-2 py-0.5 rounded text-xs hover:opacity-80"
										style={{ color: theme.colors.textDim }}
									>
										No
									</button>
								</div>
							) : (
								<button
									onClick={() => onSetDeleteConfirmLogId(log.id)}
									className="p-1.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100 transition-opacity"
									style={{ color: theme.colors.textDim }}
									title={isAIMode ? 'Delete message and response' : 'Delete command and output'}
								>
									<Trash2 className="w-3.5 h-3.5" />
								</button>
							))}
						{/* Read-only mode indicator for messages sent in read-only/plan mode */}
						{isUserMessage && isAIMode && log.readOnly && (
							<span title="Sent in read-only mode" className="flex items-center">
								<Eye
									className="w-3.5 h-3.5"
									style={{ color: theme.colors.warning, opacity: 0.7 }}
								/>
							</span>
						)}
						{/* Force parallel indicator for messages sent via Cmd+Shift+Enter */}
						{isUserMessage && isAIMode && log.forceParallel && (
							<span
								title="Sent via forced parallel execution (bypassed queue)"
								className="flex items-center"
							>
								<Hammer
									className="w-3.5 h-3.5"
									style={{ color: theme.colors.warning, opacity: 0.7 }}
								/>
							</span>
						)}
						{/* Delivery checkmark for user messages in AI mode - positioned at the end */}
						{isUserMessage && isAIMode && log.delivered && (
							<span title="Message delivered" className="flex items-center">
								<Check
									className="w-3.5 h-3.5"
									style={{ color: theme.colors.success, opacity: 0.6 }}
								/>
							</span>
						)}
					</div>
				</div>
			</div>
		);
	},
	(prevProps, nextProps) => {
		// Custom comparison - only re-render if these specific props change
		// IMPORTANT: Include ALL props that affect visual rendering
		return (
			prevProps.log.id === nextProps.log.id &&
			prevProps.log.text === nextProps.log.text &&
			prevProps.log.delivered === nextProps.log.delivered &&
			prevProps.log.readOnly === nextProps.log.readOnly &&
			prevProps.log.forceParallel === nextProps.log.forceParallel &&
			prevProps.log.renderStyle === nextProps.log.renderStyle &&
			prevProps.log.metadata?.hiddenProgress === nextProps.log.metadata?.hiddenProgress &&
			prevProps.log.metadata?.toolState?.status === nextProps.log.metadata?.toolState?.status &&
			// Cross-agent streaming flips true->false on the final chunk (which may
			// carry no new text), so the pill/glow needs this to settle.
			prevProps.log.metadata?.crossAgent?.streaming ===
				nextProps.log.metadata?.crossAgent?.streaming &&
			// A terminal error chunk may add `error` without changing text; the
			// red-tinted bubble variant depends on it.
			prevProps.log.metadata?.crossAgent?.error === nextProps.log.metadata?.crossAgent?.error &&
			prevProps.isExpanded === nextProps.isExpanded &&
			prevProps.localFilterQuery === nextProps.localFilterQuery &&
			prevProps.filterMode.mode === nextProps.filterMode.mode &&
			prevProps.filterMode.regex === nextProps.filterMode.regex &&
			prevProps.activeLocalFilter === nextProps.activeLocalFilter &&
			prevProps.deleteConfirmLogId === nextProps.deleteConfirmLogId &&
			prevProps.theme === nextProps.theme &&
			prevProps.maxOutputLines === nextProps.maxOutputLines &&
			prevProps.markdownEditMode === nextProps.markdownEditMode &&
			prevProps.bionifyReadingMode === nextProps.bionifyReadingMode &&
			prevProps.bionifyIntensity === nextProps.bionifyIntensity &&
			prevProps.bionifyAlgorithm === nextProps.bionifyAlgorithm &&
			prevProps.fontFamily === nextProps.fontFamily &&
			prevProps.userMessageAlignment === nextProps.userMessageAlignment &&
			prevProps.ghCliAvailable === nextProps.ghCliAvailable &&
			prevProps.onForkConversation === nextProps.onForkConversation &&
			prevProps.publishedGistUrl === nextProps.publishedGistUrl
		);
	}
);

LogItem.displayName = 'LogItem';
