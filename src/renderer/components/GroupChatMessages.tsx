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
	forwardRef,
	useImperativeHandle,
	memo,
} from 'react';
import { Eye, FileText, Copy, ChevronDown, ChevronUp, Share2 } from 'lucide-react';
import type { GroupChatMessage, GroupChatParticipant, GroupChatState, Theme } from '../types';
import { MarkdownRenderer } from './MarkdownRenderer';
import { stripMarkdown } from '../utils/textProcessing';
import { generateParticipantColor, buildParticipantColorMap } from '../utils/participantColors';
import { generateTerminalProseStyles } from '../utils/markdownConfig';
import { formatShortcutKeys } from '../utils/shortcutFormatter';
import { safeClipboardWrite } from '../utils/clipboard';
import { formatTimestamp as formatTimestampShared } from '../../shared/formatters';
import { useMessageGistStore } from '../stores/messageGistStore';
import { useSettingsStore } from '../stores/settingsStore';
import { isTextInputTarget } from '../utils/messageScrollNavigation';
import { JumpToMessageTopButton } from './JumpToMessageTopButton';
import { useVirtualizer } from '@tanstack/react-virtual';

interface GroupChatMessagesProps {
	theme: Theme;
	messages: GroupChatMessage[];
	participants: GroupChatParticipant[];
	state: GroupChatState;
	/**
	 * Stable identifier for the active group chat. The component instance is
	 * reused (props swap, no remount) when the active chat changes, so this is
	 * used to reset the one-time initial scroll-to-bottom per conversation.
	 */
	chatId?: string;
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

export const GroupChatMessages = memo(
	forwardRef<GroupChatMessagesHandle, GroupChatMessagesProps>(function GroupChatMessages(
		{
			theme,
			messages,
			participants,
			state,
			chatId,
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
		const estimateMessageHeight = useCallback(
			(index: number) => {
				const message = messages[index];
				if (!message) return 140;
				const lineCount = message.content.split('\n').length;
				const visibleLines =
					maxOutputLines === Infinity ? lineCount : Math.min(lineCount, maxOutputLines);
				const imageHeight = message.images?.length ? 96 : 0;
				return Math.max(112, Math.min(visibleLines, 24) * 22 + 88 + imageHeight);
			},
			[messages, maxOutputLines]
		);
		const virtualizer = useVirtualizer({
			count: messages.length,
			getScrollElement: () => containerRef.current,
			estimateSize: estimateMessageHeight,
			getItemKey: (index) => `${messages[index]?.timestamp ?? 'message'}-${index}`,
			overscan: 5,
			initialRect: { width: 900, height: 700 },
		});
		const virtualMessages = virtualizer.getVirtualItems();

		// Expose scrollToMessage method via ref
		useImperativeHandle(
			ref,
			() => ({
				scrollToMessage: (timestamp: number) => {
					let targetIndex = -1;
					let closestDiff = Infinity;
					messages.forEach((message, index) => {
						const messageTime = new Date(message.timestamp).getTime();
						const diff = Math.abs(messageTime - timestamp);
						if (diff < closestDiff) {
							closestDiff = diff;
							targetIndex = index;
						}
					});
					if (targetIndex < 0 || closestDiff >= 5000) return;
					virtualizer.scrollToIndex(targetIndex, { align: 'center' });
					requestAnimationFrame(() => {
						requestAnimationFrame(() => {
							const element = containerRef.current?.querySelector(
								`[data-message-index="${targetIndex}"]`
							) as HTMLElement | null;
							if (!element) return;
							element.style.transition = 'background-color 0.3s ease';
							const originalBg = element.style.backgroundColor;
							element.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
							setTimeout(() => {
								element.style.backgroundColor = originalBg;
							}, 1000);
						});
					});
				},
			}),
			[messages, virtualizer]
		);

		const copyToClipboard = useCallback(async (text: string) => {
			await safeClipboardWrite(text);
		}, []);

		const publishedGists = useMessageGistStore((s) => s.published);
		const groupChatAutoScroll = useSettingsStore((s) => s.groupChatAutoScroll);

		const toggleExpanded = useCallback((msgKey: string) => {
			setExpandedMessages((prev) => {
				const next = new Set(prev);
				if (next.has(msgKey)) {
					next.delete(msgKey);
				} else {
					next.add(msgKey);
				}
				return next;
			});
		}, []);

		// Memoized prose styles for markdown rendering - uses shared generator for consistency with TerminalOutput
		const proseStyles = useMemo(
			() => generateTerminalProseStyles(theme, '.group-chat-messages'),
			[theme]
		);

		// Mirror the auto-scroll setting into a ref so toggling it does not re-run
		// the scroll effect below; only message changes drive a scroll, so turning
		// the setting on or off never yanks the reader away from their position.
		const groupChatAutoScrollRef = useRef(groupChatAutoScroll);
		groupChatAutoScrollRef.current = groupChatAutoScroll;
		// Whether the one-time scroll-to-bottom for the loaded conversation ran.
		const hasAutoScrolledRef = useRef(false);
		// The component instance is reused when the active chat changes (props
		// swap without a remount), so reset the one-time initial-scroll flag when
		// the chat identity changes. Done during render (before the scroll effect
		// runs) so each newly opened chat still lands at its newest message even
		// when auto-scroll is disabled.
		const prevChatIdRef = useRef(chatId);
		if (prevChatIdRef.current !== chatId) {
			prevChatIdRef.current = chatId;
			hasAutoScrolledRef.current = false;
		}

		// Auto-scroll to the newest message. The first scroll for a loaded chat
		// (initial mount / first messages load) always lands at the bottom so an
		// existing conversation opens at its latest message; later new-message
		// scrolls are gated by the global setting.
		useEffect(() => {
			if (messages.length === 0) return;
			const isInitialScroll = !hasAutoScrolledRef.current;
			if (!isInitialScroll && !groupChatAutoScrollRef.current) return;
			hasAutoScrolledRef.current = true;
			if (containerRef.current) {
				containerRef.current.scrollTop = containerRef.current.scrollHeight;
				virtualizer.scrollToIndex(messages.length - 1, { align: 'end' });
			}
		}, [messages, virtualizer]);

		// Use external colors if provided, otherwise generate locally
		// Include 'Moderator' at index 0 to match the participant panel's color assignment
		const participantColors = useMemo(() => {
			if (externalColors) return externalColors;
			return buildParticipantColorMap(['Moderator', ...participants.map((p) => p.name)], theme);
		}, [participants, theme, externalColors]);

		const getParticipantColor = (name: string): string => {
			return participantColors[name] || generateParticipantColor(0, theme);
		};

		// Format timestamp like AI Terminal (outside bubble)
		// Accepts both ISO string and Unix timestamp
		// Returns JSX for non-today dates (date on one line, time on another)
		const formatTimestamp = (timestamp: string | number) => {
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
		};

		return (
			<div
				ref={containerRef}
				tabIndex={0}
				role="region"
				aria-label="Group chat messages"
				className="group-chat-messages flex-1 overflow-y-auto scrollbar-thin py-2 outline-none"
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
					// Shift+Arrow: jump message-by-message.
					if (e.shiftKey) {
						e.preventDefault();
						const visible = virtualizer.getVirtualItems();
						const viewportStart = container.scrollTop;
						const viewportEnd = viewportStart + container.clientHeight;
						const firstVisible = visible.find((item) => item.end > viewportStart) ?? visible[0];
						const lastVisible =
							[...visible].reverse().find((item) => item.start < viewportEnd) ??
							visible[visible.length - 1];
						const edgeIndex =
							e.key === 'ArrowUp'
								? Math.max(0, (firstVisible?.index ?? 0) - 1)
								: Math.min(messages.length - 1, (lastVisible?.index ?? 0) + 1);
						virtualizer.scrollToIndex(edgeIndex, {
							align: e.key === 'ArrowUp' ? 'start' : 'end',
							behavior: 'smooth',
						});
						return;
					}
					// Plain Arrow: nudge scroll by ~100px.
					e.preventDefault();
					container.scrollBy({ top: e.key === 'ArrowUp' ? -100 : 100 });
				}}
			>
				{/* Prose styles for markdown rendering */}
				<style>{proseStyles}</style>
				{messages.length === 0 ? (
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
							position: 'relative',
							width: '100%',
						}}
					>
						{virtualMessages.map((virtualMessage) => {
							const index = virtualMessage.index;
							const msg = messages[index];
							const isUser = msg.from === 'user';
							const isSystem = msg.from === 'system';
							const msgKey = `${msg.timestamp}-${index}`;
							const isExpanded = expandedMessages.has(msgKey);

							// Calculate if content should be collapsed
							const lineCount = msg.content.split('\n').length;
							const shouldCollapse =
								!isUser && !isSystem && lineCount > maxOutputLines && maxOutputLines !== Infinity;
							const displayContent =
								shouldCollapse && !isExpanded
									? msg.content.split('\n').slice(0, maxOutputLines).join('\n')
									: msg.content;

							// Get sender color for non-user messages
							// Use 'Moderator' (capitalized) to match the color map key
							// System messages use error color
							const senderColor = isSystem
								? theme.colors.error
								: msg.from === 'moderator'
									? getParticipantColor('Moderator')
									: getParticipantColor(msg.from);

							return (
								<div
									key={msgKey}
									ref={virtualizer.measureElement}
									data-index={index}
									data-message-index={index}
									data-message-timestamp={msg.timestamp}
									className={`flex gap-4 group ${isUser ? 'flex-row-reverse' : ''} px-6 py-2`}
									style={{
										position: 'absolute',
										top: 0,
										left: 0,
										width: '100%',
										transform: `translateY(${virtualMessage.start}px)`,
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
												{msg.from === 'moderator'
													? 'Moderator'
													: msg.from === 'system'
														? 'System'
														: msg.from}
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
															onCopy={copyToClipboard}
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
													onClick={() => toggleExpanded(msgKey)}
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
															onCopy={copyToClipboard}
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
													onClick={() => toggleExpanded(msgKey)}
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
											// Normal non-collapsed markdown view (#622: user
											// messages get the same markdown treatment as
											// assistant messages by default - toggle exposes
											// the raw view consistently for both)
											<div className="text-sm">
												<MarkdownRenderer
													content={msg.content}
													theme={theme}
													onCopy={copyToClipboard}
													chatLineBreaks
													chatMath
												/>
											</div>
										) : (
											// Raw mode - user sees their literal input; for
											// assistant content we strip markdown so the raw
											// view is readable as plain text.
											<div className="text-sm whitespace-pre-wrap">
												{isUser ? msg.content : stripMarkdown(msg.content)}
											</div>
										)}

										{/* Jump to top of this message - bottom left corner */}
										<JumpToMessageTopButton
											scrollContainerRef={containerRef}
											messageAncestorSelector="[data-message-timestamp]"
											theme={theme}
										/>
										{/* Action buttons - bottom right corner. Available on
									    user messages too so the markdown/raw toggle and
									    copy behavior is consistent with assistant
									    messages (#622). */}
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
													{markdownEditMode ? (
														<Eye className="w-4 h-4" />
													) : (
														<FileText className="w-4 h-4" />
													)}
												</button>
											)}
											{/* Copy to Clipboard Button */}
											<button
												onClick={() => copyToClipboard(msg.content)}
												className="p-1.5 rounded opacity-0 group-hover:opacity-50 hover:!opacity-100"
												style={{ color: theme.colors.textDim }}
												title="Copy to clipboard"
											>
												<Copy className="w-3.5 h-3.5" />
											</button>
											{/* Publish to GitHub Gist (non-user messages only;
										    users would publish their own input via the
										    feedback flow instead) */}
											{!isUser &&
												ghCliAvailable &&
												onPublishGist &&
												(() => {
													const publishedUrl = publishedGists[msgKey]?.gistUrl;
													return (
														<button
															onClick={() => onPublishGist(msg.content, msgKey)}
															className={`p-1.5 rounded hover:!opacity-100 ${
																publishedUrl ? 'opacity-100' : 'opacity-0 group-hover:opacity-50'
															}`}
															style={{
																color: publishedUrl ? theme.colors.accent : theme.colors.textDim,
															}}
															title={
																publishedUrl
																	? `Published as Gist: ${publishedUrl}`
																	: 'Publish as GitHub Gist'
															}
														>
															<Share2 className="w-3.5 h-3.5" />
														</button>
													);
												})()}
										</div>
									</div>
								</div>
							);
						})}
					</div>
				)}

				{/* Typing indicator */}
				{state !== 'idle' && (
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
									{state === 'moderator-thinking'
										? 'Moderator is thinking...'
										: 'Agent is working...'}
								</span>
							</div>
						</div>
					</div>
				)}
			</div>
		);
	})
);
