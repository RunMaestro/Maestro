/**
 * MessageHistory component for Maestro mobile web interface
 *
 * Displays the conversation history (AI logs and shell logs) for the active session.
 * Shows messages in a scrollable container with user/AI differentiation.
 */

import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { ArrowDown } from 'lucide-react';
import { useThemeColors } from '../components/ThemeProvider';
import { stripAnsiCodes } from '../../shared/stringUtils';
import { formatTimestamp } from '../../shared/formatters';
import { WebReadingContent } from './WebReadingContent';

/** Threshold for character-based truncation */
const CHAR_TRUNCATE_THRESHOLD = 500;
/** Threshold for line-based truncation */
const LINE_TRUNCATE_THRESHOLD = 8;

export interface LogEntry {
	id?: string;
	timestamp: number;
	text?: string;
	content?: string;
	source?: 'user' | 'stdout' | 'stderr' | 'system' | 'thinking' | 'tool';
	type?: string;
	metadata?: {
		toolState?: {
			name?: string;
			status?: 'running' | 'completed' | 'error';
			input?: unknown;
			output?: unknown;
		};
	};
}

export interface MessageHistoryProps {
	/** Log entries to display */
	logs: LogEntry[];
	/** Input mode to determine which logs to show */
	inputMode: 'ai' | 'terminal';
	/** Whether to auto-scroll to bottom on new messages */
	autoScroll?: boolean;
	/** Max height of the container */
	maxHeight?: string;
	/** Callback when user taps a message */
	onMessageTap?: (entry: LogEntry) => void;
	/** Current thinking display mode */
	thinkingMode?: 'off' | 'on' | 'sticky';
	/** Session state (e.g. 'busy', 'idle') — needed for 'on' mode */
	sessionState?: string;
	/** Whether to apply Bionify reading mode to long-form AI output */
	enableBionifyReadingMode?: boolean;
	/**
	 * Max output lines per message before collapsing — mirrors the desktop
	 * "Max Output Lines per Response" setting. Pass `Infinity` (or omit) to
	 * fall back to the local line/char defaults and never force-truncate.
	 */
	maxOutputLines?: number;
}

const formatTime = (timestamp: number) => formatTimestamp(timestamp, 'smart');

/**
 * Summarize tool input for display (simplified from desktop TerminalOutput)
 */
function summarizeToolInput(input: unknown): string {
	// Some agents (notably Copilot/Codex apply_patch) deliver the argument as a
	// raw string instead of an object \u2014 surface it as-is rather than walking it
	// with Object.keys (which would expose character indices).
	if (typeof input === 'string') {
		return input.length > 80 ? input.substring(0, 80) + '\u2026' : input;
	}
	if (!input || typeof input !== 'object' || Array.isArray(input)) {
		return '';
	}
	const inputRecord = input as Record<string, unknown>;
	// File operations
	if (typeof inputRecord.file_path === 'string') return inputRecord.file_path;
	if (typeof inputRecord.path === 'string') return inputRecord.path;
	// Bash commands
	if (typeof inputRecord.command === 'string') {
		const cmd = inputRecord.command;
		return cmd.length > 80 ? cmd.substring(0, 80) + '\u2026' : cmd;
	}
	// Search operations
	if (typeof inputRecord.pattern === 'string') return `/${inputRecord.pattern}/`;
	// Fallback
	const keys = Object.keys(inputRecord);
	if (keys.length === 0) return '';
	return keys.slice(0, 2).join(', ');
}

/**
 * MessageHistory component
 */
export function MessageHistory({
	logs,
	inputMode,
	autoScroll = true,
	maxHeight = '300px',
	onMessageTap,
	thinkingMode,
	sessionState,
	enableBionifyReadingMode = false,
	maxOutputLines = Infinity,
}: MessageHistoryProps) {
	const colors = useThemeColors();
	const containerRef = useRef<HTMLDivElement>(null);
	const bottomRef = useRef<HTMLDivElement>(null);
	const [hasInitiallyScrolled, setHasInitiallyScrolled] = useState(false);
	const prevLogsLengthRef = useRef(0);
	// Track which messages are expanded (by id or index)
	const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());

	// New message indicator state
	const [isAtBottom, setIsAtBottom] = useState(true);
	const [hasNewMessages, setHasNewMessages] = useState(false);
	const [newMessageCount, setNewMessageCount] = useState(0);

	// When the user-configured line cap is finite ("15" / "25" / …) it takes
	// precedence over the local mobile default; "All" (Infinity) disables
	// line-based collapse entirely, matching desktop behavior.
	const hasLineCap = Number.isFinite(maxOutputLines);
	const effectiveLineCap = hasLineCap ? maxOutputLines : LINE_TRUNCATE_THRESHOLD;

	/**
	 * Check if a message should be truncated
	 */
	const shouldTruncate = useCallback(
		(text: string): boolean => {
			if (text.length > CHAR_TRUNCATE_THRESHOLD) return true;
			if (!hasLineCap) return false;
			const lineCount = text.split('\n').length;
			return lineCount > effectiveLineCap;
		},
		[effectiveLineCap, hasLineCap]
	);

	/**
	 * Get truncated text for display
	 */
	const getTruncatedText = useCallback(
		(text: string): string => {
			const lines = text.split('\n');
			if (hasLineCap && lines.length > effectiveLineCap) {
				return lines.slice(0, effectiveLineCap).join('\n');
			}
			if (text.length > CHAR_TRUNCATE_THRESHOLD) {
				return text.slice(0, CHAR_TRUNCATE_THRESHOLD);
			}
			return text;
		},
		[effectiveLineCap, hasLineCap]
	);

	/**
	 * Toggle expansion state for a message
	 */
	const toggleExpanded = useCallback((messageKey: string) => {
		setExpandedMessages((prev) => {
			const next = new Set(prev);
			if (next.has(messageKey)) {
				next.delete(messageKey);
			} else {
				next.add(messageKey);
			}
			return next;
		});
	}, []);

	// Initial scroll - jump to bottom immediately without animation
	useEffect(() => {
		if (!hasInitiallyScrolled && logs.length > 0 && bottomRef.current) {
			// Use instant scroll for initial load
			bottomRef.current.scrollIntoView({ behavior: 'instant' });
			setHasInitiallyScrolled(true);
			prevLogsLengthRef.current = logs.length;
		}
	}, [logs, hasInitiallyScrolled]);

	// Auto-scroll to bottom when new messages arrive (after initial load)
	useEffect(() => {
		if (
			hasInitiallyScrolled &&
			autoScroll &&
			bottomRef.current &&
			logs.length > prevLogsLengthRef.current
		) {
			bottomRef.current.scrollIntoView({ behavior: 'smooth' });
			prevLogsLengthRef.current = logs.length;
		}
	}, [logs, autoScroll, hasInitiallyScrolled]);

	// Reset scroll state when logs are cleared (e.g., session change)
	useEffect(() => {
		if (logs.length === 0) {
			setHasInitiallyScrolled(false);
			prevLogsLengthRef.current = 0;
			setHasNewMessages(false);
			setNewMessageCount(0);
			setIsAtBottom(true);
		}
	}, [logs.length]);

	// Track scroll position to detect when user scrolls away from bottom
	const handleScroll = useCallback(() => {
		const container = containerRef.current;
		if (!container) return;

		const { scrollTop, scrollHeight, clientHeight } = container;
		const atBottom = scrollHeight - scrollTop - clientHeight < 50;
		setIsAtBottom(atBottom);

		if (atBottom) {
			setHasNewMessages(false);
			setNewMessageCount(0);
		}
	}, []);

	// Detect new messages when user is not at bottom
	useEffect(() => {
		const currentCount = logs.length;
		if (currentCount > prevLogsLengthRef.current && hasInitiallyScrolled) {
			// Check actual scroll position
			const container = containerRef.current;
			let actuallyAtBottom = isAtBottom;
			if (container) {
				const { scrollTop, scrollHeight, clientHeight } = container;
				actuallyAtBottom = scrollHeight - scrollTop - clientHeight < 50;
			}

			if (!actuallyAtBottom) {
				const newCount = currentCount - prevLogsLengthRef.current;
				setHasNewMessages(true);
				setNewMessageCount((prev) => prev + newCount);
				setIsAtBottom(false);
			}
		}
		prevLogsLengthRef.current = currentCount;
	}, [logs.length, isAtBottom, hasInitiallyScrolled]);

	// Scroll to bottom function
	const scrollToBottom = useCallback(() => {
		if (bottomRef.current) {
			bottomRef.current.scrollIntoView({ behavior: 'smooth' });
			setHasNewMessages(false);
			setNewMessageCount(0);
		}
	}, []);

	// Filter logs based on thinking mode (tool entries follow same visibility as thinking)
	const displayLogs = useMemo(() => {
		if (!logs) return [];
		const mode = thinkingMode ?? 'off';
		if (mode === 'sticky') return logs; // Show everything
		if (mode === 'off')
			return logs.filter((log) => log.source !== 'thinking' && log.source !== 'tool');
		// 'on' mode: show thinking/tool only while busy, hide after completion
		if (sessionState === 'busy') return logs;
		return logs.filter((log) => log.source !== 'thinking' && log.source !== 'tool');
	}, [logs, thinkingMode, sessionState]);

	if (!displayLogs || displayLogs.length === 0) {
		return (
			<div
				style={{
					padding: '16px',
					textAlign: 'center',
					color: colors.textDim,
					fontSize: '13px',
				}}
			>
				No messages yet
			</div>
		);
	}

	return (
		<div
			style={{
				position: 'relative',
				...(maxHeight === 'none'
					? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }
					: {}),
			}}
		>
			<div
				ref={containerRef}
				onScroll={handleScroll}
				style={{
					display: 'flex',
					flexDirection: 'column',
					gap: '8px',
					padding: '12px',
					// Use flex: 1 when maxHeight is "none" to fill available space
					...(maxHeight === 'none' ? { flex: 1, minHeight: 0 } : { maxHeight }),
					overflowY: 'auto',
					overflowX: 'hidden',
					backgroundColor: colors.bgMain,
					borderRadius: '8px',
					border: `1px solid ${colors.border}`,
				}}
			>
				{displayLogs.map((entry, index) => {
					const rawText = entry.text || entry.content || '';
					const text = stripAnsiCodes(rawText);
					const source = entry.source || (entry.type === 'user' ? 'user' : 'stdout');
					const messageKey = entry.id || `${entry.timestamp}-${index}`;

					// Tool entries render as compact inline cards
					if (source === 'tool') {
						const toolInput = entry.metadata?.toolState?.input;
						const toolDetail =
							toolInput !== undefined && toolInput !== null ? summarizeToolInput(toolInput) : null;

						return (
							<div
								key={messageKey}
								style={{
									padding: '4px 16px',
									fontSize: '12px',
									fontFamily: 'ui-monospace, monospace',
									borderLeft: `2px solid ${colors.accent}`,
									marginLeft: '12px',
									color: colors.textMain,
								}}
							>
								<div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
									<span
										style={{
											color: colors.accent,
											fontSize: '11px',
											fontWeight: 500,
											flexShrink: 0,
										}}
									>
										{text}
									</span>
									{entry.metadata?.toolState?.status === 'running' && (
										<span
											style={{
												color: colors.warning ?? '#f59e0b',
												animation: 'pulse 1.5s ease-in-out infinite',
											}}
										>
											&#9679;
										</span>
									)}
									{entry.metadata?.toolState?.status === 'completed' && (
										<span style={{ color: colors.success ?? '#22c55e' }}>&#10003;</span>
									)}
									{entry.metadata?.toolState?.status === 'error' && (
										<span style={{ color: colors.error ?? '#ef4444' }}>&#10007;</span>
									)}
									{toolDetail && (
										<span style={{ opacity: 0.7, wordBreak: 'break-word' }}>{toolDetail}</span>
									)}
								</div>
							</div>
						);
					}

					const isUser = source === 'user';
					const isError = source === 'stderr';
					const isSystem = source === 'system';
					const isThinking = source === 'thinking';
					const isExpanded = expandedMessages.has(messageKey);
					const isTruncatable = shouldTruncate(text);
					const displayText = isExpanded || !isTruncatable ? text : getTruncatedText(text);
					const isStdoutBionify = enableBionifyReadingMode && source === 'stdout';

					return (
						<div
							key={messageKey}
							onClick={() => {
								if (isTruncatable) {
									toggleExpanded(messageKey);
								}
								onMessageTap?.(entry);
							}}
							style={{
								display: 'flex',
								flexDirection: 'column',
								gap: '4px',
								padding: '10px 12px',
								borderRadius: '8px',
								backgroundColor: isUser
									? `${colors.accent}15`
									: isError
										? `${colors.error}10`
										: isSystem
											? `${colors.textDim}10`
											: isThinking
												? `${colors.accent}08`
												: colors.bgSidebar,
								borderLeft: isThinking ? `2px solid ${colors.accent}` : undefined,
								border: isThinking
									? undefined
									: `1px solid ${
											isUser ? `${colors.accent}30` : isError ? `${colors.error}30` : colors.border
										}`,
								cursor: isTruncatable ? 'pointer' : 'default',
								// Align user messages to the right
								alignSelf: isUser ? 'flex-end' : 'flex-start',
								maxWidth: '90%',
							}}
						>
							{/* Header: source and time */}
							<div
								style={{
									display: 'flex',
									alignItems: 'center',
									gap: '8px',
									fontSize: '10px',
									color: colors.textDim,
								}}
							>
								<span
									style={{
										fontWeight: 600,
										textTransform: 'uppercase',
										letterSpacing: '0.5px',
										color: isUser
											? colors.accent
											: isError
												? colors.error
												: isThinking
													? colors.accent
													: colors.textDim,
									}}
								>
									{isUser
										? 'You'
										: isError
											? 'Error'
											: isThinking
												? 'Thinking'
												: isSystem
													? 'System'
													: inputMode === 'ai'
														? 'AI'
														: 'Output'}
								</span>
								<span style={{ opacity: 0.7 }}>{formatTime(entry.timestamp)}</span>
								{/* Show expand/collapse indicator for truncatable messages */}
								{isTruncatable && (
									<span
										style={{
											marginLeft: 'auto',
											color: colors.accent,
											fontSize: '10px',
										}}
									>
										{isExpanded ? '▼ collapse' : '▶ expand'}
									</span>
								)}
							</div>

							{/* Message content */}
							<div
								style={{
									color: isError ? colors.error : colors.textMain,
									textAlign: 'left',
								}}
							>
								{inputMode === 'terminal' || isUser ? (
									// Terminal output and user input: render as plain monospace text
									<div
										style={{
											fontSize: '13px',
											lineHeight: 1.5,
											fontFamily: 'ui-monospace, monospace',
											whiteSpace: 'pre-wrap',
											wordBreak: 'break-word',
										}}
									>
										{displayText}
									</div>
								) : (
									// There is no dedicated browser-tab reader in the web client yet.
									// Message history is one of the nearest real browser-adjacent readers,
									// so route mixed AI output through the shared adapter used by the
									// full response viewer to avoid double-transforming raw text.
									<WebReadingContent
										content={displayText}
										enableBionifyReadingMode={isStdoutBionify}
										fontSize={13}
										gap="8px"
									/>
								)}
								{/* Show truncation indicator at end of text */}
								{isTruncatable && !isExpanded && (
									<span style={{ color: colors.textDim, fontStyle: 'italic', fontSize: '13px' }}>
										{'\n'}... (tap to expand)
									</span>
								)}
							</div>
						</div>
					);
				})}
				{/* Bottom ref with padding to ensure last message is fully visible */}
				<div ref={bottomRef} style={{ minHeight: '8px' }} />
			</div>

			{/* New Message Indicator - floating arrow button */}
			{hasNewMessages && !isAtBottom && (
				<button
					onClick={scrollToBottom}
					style={{
						position: 'absolute',
						bottom: '16px',
						right: '24px',
						display: 'flex',
						alignItems: 'center',
						gap: '8px',
						padding: '8px 12px',
						borderRadius: '9999px',
						backgroundColor: colors.accent,
						color: colors.accentForeground || '#fff',
						border: 'none',
						boxShadow: '0 4px 12px rgba(0, 0, 0, 0.3)',
						cursor: 'pointer',
						zIndex: 20,
						animation: 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
					}}
					title="Scroll to new messages"
				>
					<ArrowDown style={{ width: '16px', height: '16px' }} />
					{newMessageCount > 0 && (
						<span style={{ fontSize: '12px', fontWeight: 'bold' }}>
							{newMessageCount > 99 ? '99+' : newMessageCount}
						</span>
					)}
				</button>
			)}
		</div>
	);
}

function getToolDetail(input: unknown): string | null {
	if (!input || typeof input !== 'object') return null;
	const value = input as Record<string, unknown>;
	const candidates = [
		value.command,
		value.pattern,
		value.file_path,
		value.filePath,
		value.query,
		value.description,
		value.prompt,
		value.task_id,
		value.path,
		value.cmd,
		value.code,
	];
	for (const candidate of candidates) {
		if (typeof candidate === 'string' && candidate.trim()) {
			return candidate.length > 160 ? `${candidate.slice(0, 157)}...` : candidate;
		}
	}
	return null;
}

function ToolCard({ entry }: { entry: LogEntry }) {
	const colors = useThemeColors();
	const state = entry.metadata?.toolState;
	const detail = getToolDetail(state?.input);
	const status = state?.status;
	const statusColor =
		status === 'completed' ? colors.success : status === 'error' ? colors.error : colors.warning;

	return (
		<div
			style={{
				display: 'flex',
				flexDirection: 'column',
				gap: '6px',
				fontFamily: 'ui-monospace, monospace',
				fontSize: '12px',
				lineHeight: 1.4,
			}}
		>
			<div style={{ display: 'flex', alignItems: 'center', gap: '8px', minWidth: 0 }}>
				<span style={{ color: statusColor, flexShrink: 0 }}>
					{status === 'completed' ? '✓' : status === 'error' ? '!' : '●'}
				</span>
				<span
					style={{
						color: colors.textMain,
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						whiteSpace: 'nowrap',
					}}
				>
					{entry.text || entry.content || 'Tool'}
				</span>
			</div>
			{detail && (
				<div
					style={{
						color: colors.textDim,
						whiteSpace: 'pre-wrap',
						wordBreak: 'break-word',
					}}
				>
					{detail}
				</div>
			)}
		</div>
	);
}

export default MessageHistory;
