/**
 * GroupChatMessages.tsx
 *
 * Displays the message history for a Group Chat. Styled to match AI Terminal
 * chat layout with timestamps outside bubbles, consistent colors, and markdown support.
 */

import {
	useRef,
	useEffect,
	useCallback,
	useMemo,
	useState,
	memo,
	forwardRef,
	useImperativeHandle,
} from 'react';
import type { RefObject } from 'react';
import { Eye, FileText, Copy, ChevronDown, ChevronUp, Play, Share2 } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { GroupChatMessage, GroupChatParticipant, GroupChatState, Theme } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { stripMarkdown } from '../utils/textProcessing';
import { generateParticipantColor, buildParticipantColorMap } from '../utils/participantColors';
import { generateTerminalProseStyles } from '../utils/markdownConfig';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { safeClipboardWrite } from '../utils/clipboard';
import { formatTimestamp as formatTimestampShared } from '../../shared/formatters';
import { useMessageGistStore } from '../stores/messageGistStore';
import { jumpToMessageEdge, isTextInputTarget } from '../utils/messageScrollNavigation';
import { JumpToMessageTopButton } from './JumpToMessageTopButton';

const ESTIMATED_MESSAGE_HEIGHT = 180;
const ESTIMATED_TYPING_INDICATOR_HEIGHT = 88;
const BOTTOM_SCROLL_THRESHOLD_PX = 120;

interface GroupChatMessagesProps {
	theme: Theme;
	messages: GroupChatMessage[];
	participants: GroupChatParticipant[];
	state: GroupChatState;
	markdownEditMode?: boolean;
	onToggleMarkdownEditMode?: () => void;
	maxOutputLines?: number;
	/** Pre-computed participant colors (if provided, overrides internal color generation) */
	participantColors?: Record<string, string>;
	/** Lightbox handler for viewing images full-size */
	onOpenLightbox?: (image: string, contextImages?: string[], source?: 'staged' | 'history') => void;
	/** Whether gh CLI is available for gist publishing */
	ghCliAvailable?: boolean;
	/** Callback to publish a message as a GitHub Gist */
	onPublishGist?: (text: string, messageId?: string) => void;
}

/** Handle exposed via ref for scrolling to messages */
export interface GroupChatMessagesHandle {
	scrollToMessage: (timestamp: number) => void;
}

// ---------------------------------------------------------------------------
// Format timestamp like AI Terminal (outside bubble)
// Accepts both ISO string and Unix timestamp
// ---------------------------------------------------------------------------
function formatTimestamp(timestamp: string | number): React.ReactNode {
	const date = new Date(timestamp);
	const today = new Date();
	const isToday = date.toDateString() === today.toDateString();
	const time = formatTimestampShared(timestamp, 'time');
	if (isToday) {
		return time;
	}
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return (
		<>
			<div>
				{year}-{month}-{day}
			</div>
			<div>{time}</div>
		</>
	);
}

function getMessageKey(msg: GroupChatMessage, index: number): string {
	return `${msg.timestamp}-${index}`;
}

function getMessageTimestampMs(timestamp: string | number): number {
	return typeof timestamp === 'number' ? timestamp : new Date(timestamp).getTime();
}

function isRenderableMessage(value: unknown): value is GroupChatMessage {
	if (!value || typeof value !== 'object') return false;
	const candidate = value as Partial<GroupChatMessage>;
	return (
		(typeof candidate.timestamp === 'string' || typeof candidate.timestamp === 'number') &&
		typeof candidate.from === 'string' &&
		typeof candidate.content === 'string'
	);
}

// ---------------------------------------------------------------------------
// Individual message bubble — memoized to avoid re-renders when siblings change
// ---------------------------------------------------------------------------
interface MessageBubbleProps {
	msg: GroupChatMessage;
	msgKey: string;
	isExpanded: boolean;
	onToggleExpanded: (key: string) => void;
	onCopy: (text: string) => Promise<void>;
	theme: Theme;
	senderColor: string;
	markdownEditMode?: boolean;
	onToggleMarkdownEditMode?: () => void;
	maxOutputLines: number;
	isHighlighted?: boolean;
	onOpenLightbox?: (image: string, contextImages?: string[], source?: 'staged' | 'history') => void;
	ghCliAvailable?: boolean;
	onPublishGist?: (text: string, messageId?: string) => void;
	publishedGistUrl?: string;
	scrollContainerRef: RefObject<HTMLDivElement>;
}

const MessageBubble = memo(function MessageBubble({
	msg,
	msgKey,
	isExpanded,
	onToggleExpanded,
	onCopy,
	theme,
	senderColor,
	markdownEditMode,
	onToggleMarkdownEditMode,
	maxOutputLines,
	isHighlighted,
	onOpenLightbox,
	ghCliAvailable,
	onPublishGist,
	publishedGistUrl,
	scrollContainerRef,
}: MessageBubbleProps) {
	const isUser = msg.from === 'user';
	const isSystem = msg.from === 'system';

	const lineCount = msg.content.split('\n').length;
	const shouldCollapse =
		!isUser && !isSystem && lineCount > maxOutputLines && maxOutputLines !== Infinity;
	const displayContent =
		shouldCollapse && !isExpanded
			? msg.content.split('\n').slice(0, maxOutputLines).join('\n')
			: msg.content;

	return (
		<div
			data-message-timestamp={msg.timestamp}
			className={`flex gap-4 group ${isUser ? 'flex-row-reverse' : ''} px-6 py-2`}
			style={{
				backgroundColor: isHighlighted ? 'rgba(255, 255, 255, 0.1)' : 'transparent',
				transition: 'background-color 0.3s ease',
			}}
		>
			{/* Timestamp - outside bubble, like AI Terminal */}
			<div
				className={`w-20 shrink-0 text-[10px] pt-2 ${isUser ? 'text-right' : 'text-left'}`}
				style={{ color: theme.colors.textDim, opacity: 0.6 }}
			>
				{formatTimestamp(msg.timestamp)}
			</div>

			{/* Message bubble */}
			<div
				className={`flex-1 min-w-0 p-4 pb-10 rounded-xl border ${isUser ? 'rounded-tr-none' : 'rounded-tl-none'} relative overflow-hidden`}
				style={{
					backgroundColor: isUser
						? `color-mix(in srgb, ${theme.colors.accent} 20%, ${theme.colors.bgSidebar})`
						: theme.colors.bgActivity,
					borderColor: isUser ? theme.colors.accent + '40' : theme.colors.border,
					borderLeftWidth: !isUser ? '3px' : undefined,
					borderLeftColor: !isUser ? senderColor : undefined,
					color: theme.colors.textMain,
				}}
			>
				{/* Sender label for non-user messages */}
				{!isUser && (
					<div className="text-xs font-medium mb-2" style={{ color: senderColor }}>
						{msg.from === 'moderator' ? 'Moderator' : msg.from === 'system' ? 'System' : msg.from}
					</div>
				)}

				{/* Attached images */}
				{msg.images && msg.images.length > 0 && (
					<div
						className="flex gap-2 mb-2 overflow-x-auto scrollbar-thin"
						style={{ overscrollBehavior: 'contain' }}
					>
						{msg.images.map((img, imgIdx) => (
							<button
								key={`${msgKey}-img-${imgIdx}`}
								type="button"
								className="shrink-0 p-0 bg-transparent outline-none focus:ring-2 focus:ring-accent rounded"
								onClick={() => onOpenLightbox?.(img, msg.images, 'history')}
							>
								<img
									src={img}
									alt={`Attached image ${imgIdx + 1}`}
									className="h-20 rounded border cursor-zoom-in block"
									style={{
										objectFit: 'contain',
										maxWidth: '200px',
										borderColor: theme.colors.border,
									}}
								/>
							</button>
						))}
					</div>
				)}

				{/* Message content */}
				{shouldCollapse && !isExpanded ? (
					// Collapsed view
					<div>
						<div
							className="text-sm overflow-hidden"
							style={{ maxHeight: `${maxOutputLines * 1.5}em` }}
						>
							{!markdownEditMode ? (
								<MarkdownRenderer
									content={displayContent}
									theme={theme}
									onCopy={onCopy}
									chatLineBreaks
									chatMath
								/>
							) : (
								<div className="whitespace-pre-wrap">
									{isUser ? displayContent : stripMarkdown(displayContent)}
								</div>
							)}
						</div>
						<button
							onClick={() => onToggleExpanded(msgKey)}
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
					// Expanded view (was collapsed)
					<div>
						<div
							className="text-sm overflow-auto scrollbar-thin"
							style={{ maxHeight: '600px', overscrollBehavior: 'contain' }}
							onWheel={(e) => {
								const el = e.currentTarget;
								const { scrollTop, scrollHeight, clientHeight } = el;
								const atTop = scrollTop <= 0;
								const atBottom = scrollTop + clientHeight >= scrollHeight - 1;
								if ((e.deltaY < 0 && !atTop) || (e.deltaY > 0 && !atBottom)) {
									e.stopPropagation();
								}
							}}
						>
							{!markdownEditMode ? (
								<MarkdownRenderer
									content={msg.content}
									theme={theme}
									onCopy={onCopy}
									chatLineBreaks
									chatMath
								/>
							) : (
								<div className="whitespace-pre-wrap">
									{isUser ? msg.content : stripMarkdown(msg.content)}
								</div>
							)}
						</div>
						<button
							onClick={() => onToggleExpanded(msgKey)}
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
				) : !markdownEditMode ? (
					// Normal non-collapsed markdown view (#622: user messages get the
					// same markdown treatment as assistant messages by default).
					<div className="text-sm">
						<MarkdownRenderer
							content={msg.content}
							theme={theme}
							onCopy={onCopy}
							chatLineBreaks
							chatMath
						/>
					</div>
				) : (
					// Raw mode: user sees literal input; assistant content is plain text.
					<div className="text-sm whitespace-pre-wrap">
						{isUser ? msg.content : stripMarkdown(msg.content)}
					</div>
				)}

				{!isUser && msg.autoRunRefs && msg.autoRunRefs.length > 0 && (
					<div className="mt-3 flex flex-wrap gap-2" style={{ color: theme.colors.textDim }}>
						{msg.autoRunRefs.map((ref) => (
							<button
								key={`${ref.participantName}:${ref.relativePath}`}
								onClick={() => onCopy(ref.triggerCommand)}
								className="inline-flex items-center gap-2 text-xs px-3 py-1.5 rounded-lg border hover:opacity-80 transition-opacity"
								style={{
									borderColor: theme.colors.border,
									backgroundColor: theme.colors.bgSidebar,
									color: theme.colors.accent,
								}}
								title={`Copy ${ref.triggerCommand}`}
							>
								<Play className="w-3 h-3" />
								<span>{ref.relativePath}</span>
							</button>
						))}
					</div>
				)}

				{/* Jump to top of this message - bottom left corner */}
				<JumpToMessageTopButton
					scrollContainerRef={scrollContainerRef}
					messageAncestorSelector="[data-message-timestamp]"
					theme={theme}
				/>

				{/* Action buttons - bottom right corner. Available on user messages too. */}
				<div
					className="absolute bottom-2 right-2 flex items-center gap-1"
					style={{ transition: 'opacity 0.15s ease-in-out' }}
				>
					{/* Markdown toggle button */}
					{onToggleMarkdownEditMode && (
						<button
							onClick={onToggleMarkdownEditMode}
							className="p-1.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100"
							style={{
								color: markdownEditMode ? theme.colors.accent : theme.colors.textDim,
							}}
							title={
								markdownEditMode
									? `Show formatted (${formatShortcutKeys(['Meta', 'e'])})`
									: `Show plain text (${formatShortcutKeys(['Meta', 'e'])})`
							}
						>
							{markdownEditMode ? <Eye className="w-4 h-4" /> : <FileText className="w-4 h-4" />}
						</button>
					)}
					{/* Copy to Clipboard Button */}
					<button
						onClick={() => onCopy(msg.content)}
						className="p-1.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100"
						style={{ color: theme.colors.textDim }}
						title="Copy to clipboard"
					>
						<Copy className="w-3.5 h-3.5" />
					</button>
					{/* Publish to GitHub Gist (non-user messages only) */}
					{!isUser && ghCliAvailable && onPublishGist && (
						<button
							onClick={() => onPublishGist(msg.content, msgKey)}
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
				</div>
			</div>
		</div>
	);
});

interface TypingIndicatorProps {
	state: GroupChatState;
	theme: Theme;
}

const TypingIndicator = memo(function TypingIndicator({ state, theme }: TypingIndicatorProps) {
	return (
		<div className="flex gap-4 px-6 py-2">
			<div className="w-20 shrink-0" />
			<div
				className="flex-1 min-w-0 p-4 rounded-xl border rounded-tl-none"
				style={{ backgroundColor: theme.colors.bgActivity, borderColor: theme.colors.border }}
			>
				<div className="flex items-center gap-2">
					<div
						className="w-2 h-2 rounded-full animate-pulse"
						style={{ backgroundColor: theme.colors.warning }}
					/>
					<span className="text-sm" style={{ color: theme.colors.textDim }}>
						{state === 'moderator-thinking' ? 'Moderator is thinking...' : 'Agent is working...'}
					</span>
				</div>
			</div>
		</div>
	);
});

// ---------------------------------------------------------------------------
// Main component — memoized to skip re-renders when props are unchanged
// ---------------------------------------------------------------------------
export const GroupChatMessages = memo(
	forwardRef<GroupChatMessagesHandle, GroupChatMessagesProps>(function GroupChatMessages(
		{
			theme,
			messages,
			participants,
			state,
			markdownEditMode,
			onToggleMarkdownEditMode,
			maxOutputLines = 30,
			participantColors: externalColors,
			onOpenLightbox,
			ghCliAvailable,
			onPublishGist,
		},
		ref
	) {
		const containerRef = useRef<HTMLDivElement>(null);
		const [expandedMessages, setExpandedMessages] = useState<Set<string>>(new Set());
		const [highlightedMessageKey, setHighlightedMessageKey] = useState<string | null>(null);
		const isNearBottomRef = useRef(true);
		const previousMessageCountRef = useRef(0);
		const previousFirstMessageKeyRef = useRef<string | null>(null);
		const highlightTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

		const renderMessages = useMemo(() => messages.filter(isRenderableMessage), [messages]);
		const itemCount = renderMessages.length + (state !== 'idle' ? 1 : 0);
		const estimateSize = useCallback(
			(index: number) =>
				index < renderMessages.length
					? ESTIMATED_MESSAGE_HEIGHT
					: ESTIMATED_TYPING_INDICATOR_HEIGHT,
			[renderMessages.length]
		);
		const getVirtualizerItemKey = useCallback(
			(index: number) => {
				if (index < renderMessages.length) {
					return getMessageKey(renderMessages[index], index);
				}
				return `typing-indicator-${state}`;
			},
			[renderMessages, state]
		);
		const virtualizer = useVirtualizer({
			count: itemCount,
			getScrollElement: () => containerRef.current,
			estimateSize,
			overscan: 8,
			getItemKey: getVirtualizerItemKey,
		});

		// Expose scrollToMessage method via ref
		useImperativeHandle(
			ref,
			() => ({
				scrollToMessage: (timestamp: number) => {
					let targetIndex = renderMessages.findIndex(
						(msg) => getMessageTimestampMs(msg.timestamp) === timestamp
					);

					if (targetIndex < 0) {
						let closestIndex = -1;
						let closestDiff = Infinity;

						renderMessages.forEach((msg, index) => {
							const diff = Math.abs(getMessageTimestampMs(msg.timestamp) - timestamp);
							if (diff < closestDiff) {
								closestDiff = diff;
								closestIndex = index;
							}
						});

						if (closestDiff < 5000) {
							targetIndex = closestIndex;
						}
					}

					if (targetIndex >= 0) {
						const msgKey = getMessageKey(renderMessages[targetIndex], targetIndex);
						virtualizer.scrollToIndex(targetIndex, { align: 'center', behavior: 'smooth' });
						setHighlightedMessageKey(msgKey);

						if (highlightTimeoutRef.current) {
							clearTimeout(highlightTimeoutRef.current);
						}
						highlightTimeoutRef.current = setTimeout(() => {
							setHighlightedMessageKey((current) => (current === msgKey ? null : current));
						}, 1200);
					}
				},
			}),
			[renderMessages, virtualizer]
		);

		useEffect(() => {
			return () => {
				if (highlightTimeoutRef.current) {
					clearTimeout(highlightTimeoutRef.current);
				}
			};
		}, []);

		const copyToClipboard = useCallback(async (text: string) => {
			await safeClipboardWrite(text);
		}, []);
		const publishedGists = useMessageGistStore((s) => s.published);

		const toggleExpanded = useCallback(
			(msgKey: string) => {
				setExpandedMessages((prev) => {
					const next = new Set(prev);
					if (next.has(msgKey)) {
						next.delete(msgKey);
					} else {
						next.add(msgKey);
					}
					return next;
				});
				requestAnimationFrame(() => virtualizer.measure());
			},
			[virtualizer]
		);

		// Memoized prose styles for markdown rendering - uses shared generator for consistency with TerminalOutput
		const proseStyles = useMemo(
			() => generateTerminalProseStyles(theme, '.group-chat-messages'),
			[theme]
		);

		const updateNearBottom = useCallback(() => {
			const container = containerRef.current;
			if (!container) {
				isNearBottomRef.current = true;
				return;
			}
			const distanceFromBottom =
				container.scrollHeight - container.scrollTop - container.clientHeight;
			isNearBottomRef.current = distanceFromBottom <= BOTTOM_SCROLL_THRESHOLD_PX;
		}, []);

		// Auto-scroll on new messages only when the user is already following the bottom,
		// when they send a message, or when the chat is first loaded.
		const messageCount = renderMessages.length;
		useEffect(() => {
			if (itemCount === 0) return;

			const previousMessageCount = previousMessageCountRef.current;
			const firstMessageKey = messageCount > 0 ? getMessageKey(renderMessages[0], 0) : null;
			const messageListWasReplaced =
				previousFirstMessageKeyRef.current !== null &&
				firstMessageKey !== null &&
				previousFirstMessageKeyRef.current !== firstMessageKey;
			const addedMessage = messageCount > previousMessageCount;
			const lastMessage = renderMessages[messageCount - 1];
			const shouldScrollToBottom =
				previousMessageCount === 0 ||
				messageListWasReplaced ||
				isNearBottomRef.current ||
				(addedMessage && lastMessage?.from === 'user');

			previousMessageCountRef.current = messageCount;
			previousFirstMessageKeyRef.current = firstMessageKey;

			if (shouldScrollToBottom) {
				requestAnimationFrame(() => {
					virtualizer.scrollToIndex(itemCount - 1, { align: 'end' });
					requestAnimationFrame(updateNearBottom);
				});
			}
		}, [itemCount, messageCount, renderMessages, updateNearBottom, virtualizer]);

		// Use external colors if provided, otherwise generate locally
		// Include 'Moderator' at index 0 to match the participant panel's color assignment
		const participantColors = useMemo(() => {
			if (externalColors) return externalColors;
			return buildParticipantColorMap(['Moderator', ...participants.map((p) => p.name)], theme);
		}, [participants, theme, externalColors]);

		const getParticipantColor = useCallback(
			(name: string): string => {
				return participantColors[name] || generateParticipantColor(0, theme);
			},
			[participantColors, theme]
		);

		return (
			<div
				ref={containerRef}
				tabIndex={0}
				role="region"
				aria-label="Group chat messages"
				className="group-chat-messages flex-1 overflow-y-auto scrollbar-thin py-2 outline-none"
				onScroll={updateNearBottom}
				onKeyDown={(e) => {
					if (
						(e.key !== 'ArrowUp' && e.key !== 'ArrowDown') ||
						e.metaKey ||
						e.ctrlKey ||
						e.altKey ||
						isTextInputTarget(e.target)
					) {
						return;
					}
					const container = containerRef.current;
					if (!container) return;
					if (e.shiftKey) {
						e.preventDefault();
						jumpToMessageEdge(
							container,
							'[data-message-timestamp]',
							e.key === 'ArrowUp' ? 'up' : 'down'
						);
						return;
					}
					e.preventDefault();
					container.scrollBy({ top: e.key === 'ArrowUp' ? -100 : 100 });
				}}
			>
				{/* Prose styles for markdown rendering */}
				<style>{proseStyles}</style>
				{renderMessages.length === 0 && state === 'idle' ? (
					<div className="flex items-center justify-center h-full px-6">
						<div className="text-center max-w-md space-y-3">
							<div className="flex justify-center mb-4">
								<span
									className="text-[10px] font-semibold tracking-wide uppercase px-2 py-0.5 rounded"
									style={{
										backgroundColor: `${theme.colors.accent}20`,
										color: theme.colors.accent,
										border: `1px solid ${theme.colors.accent}40`,
									}}
								>
									Beta
								</span>
							</div>
							<p className="text-sm" style={{ color: theme.colors.textDim }}>
								Messages you send go directly to the{' '}
								<span style={{ color: theme.colors.warning }}>moderator</span>, who orchestrates the
								conversation and decides when to involve other agents.
							</p>
							<p className="text-sm" style={{ color: theme.colors.textDim }}>
								Use <span style={{ color: theme.colors.accent }}>@agent</span> to message a specific
								agent directly at any time.
							</p>
						</div>
					</div>
				) : (
					<div
						style={{
							height: `${virtualizer.getTotalSize()}px`,
							width: '100%',
							position: 'relative',
						}}
					>
						{virtualizer.getVirtualItems().map((virtualItem) => {
							const index = virtualItem.index;
							const isTypingIndicator = index >= renderMessages.length;

							return (
								<div
									key={virtualItem.key}
									data-index={index}
									ref={virtualizer.measureElement}
									style={{
										position: 'absolute',
										top: 0,
										left: 0,
										width: '100%',
										transform: `translateY(${virtualItem.start}px)`,
									}}
								>
									{isTypingIndicator ? (
										<TypingIndicator state={state} theme={theme} />
									) : (
										(() => {
											const msg = renderMessages[index];
											const isSystem = msg.from === 'system';
											const msgKey = getMessageKey(msg, index);
											const senderColor = isSystem
												? theme.colors.error
												: msg.from === 'moderator'
													? getParticipantColor('Moderator')
													: getParticipantColor(msg.from);

											return (
												<MessageBubble
													msg={msg}
													msgKey={msgKey}
													isExpanded={expandedMessages.has(msgKey)}
													onToggleExpanded={toggleExpanded}
													onCopy={copyToClipboard}
													theme={theme}
													senderColor={senderColor}
													markdownEditMode={markdownEditMode}
													onToggleMarkdownEditMode={onToggleMarkdownEditMode}
													maxOutputLines={maxOutputLines}
													isHighlighted={highlightedMessageKey === msgKey}
													onOpenLightbox={onOpenLightbox}
													ghCliAvailable={ghCliAvailable}
													onPublishGist={onPublishGist}
													publishedGistUrl={publishedGists[msgKey]?.gistUrl}
													scrollContainerRef={containerRef}
												/>
											);
										})()
									)}
								</div>
							);
						})}
					</div>
				)}
			</div>
		);
	})
);
