/**
 * GroupChatInput.tsx
 *
 * Input area for the Group Chat view. Supports:
 * - Text input with Enter to send
 * - @mention autocomplete for all agents (sessions)
 * - Read-only mode toggle (styled like direct agent chat)
 * - Attach image button
 * - Prompt composer button
 * - Enter/Cmd+Enter toggle
 * - Execution queue for messages when busy
 * - Disabled state when moderator/agent is working
 */

import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { ArrowUp, ImageIcon, Eye, Keyboard, PenLine, Users } from 'lucide-react';
import type {
	Theme,
	GroupChatParticipant,
	GroupChatState,
	Session,
	Group,
	QueuedItem,
	Shortcut,
} from '../types';
import {
	formatShortcutKeys,
	formatEnterToSend,
	formatEnterToSendTooltip,
} from '../utils/shortcutFormatter';
import { QueuedItemsList } from './QueuedItemsList';
import { normalizeMentionName } from '../utils/participantColors';
import { useSessionStore } from '../stores/sessionStore';

/** Maximum image file size in bytes (10MB) */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/** Allowed image MIME types */
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/** Union type for items shown in the @ mention dropdown */
type MentionItem =
	| { type: 'agent'; name: string; mentionName: string; agentId: string; sessionId: string }
	| {
			type: 'group';
			group: Group;
			mentionName: string;
			memberCount: number;
			memberMentions: string[];
	  };

interface GroupChatInputProps {
	theme: Theme;
	state: GroupChatState;
	onSend: (content: string, images?: string[], readOnly?: boolean) => void;
	participants: GroupChatParticipant[];
	sessions: Session[];
	groupChatId: string;
	draftMessage?: string;
	onDraftChange?: (draft: string) => void;
	onOpenPromptComposer?: () => void;
	// Lifted state for sync with PromptComposer
	stagedImages?: string[];
	setStagedImages?: React.Dispatch<React.SetStateAction<string[]>>;
	readOnlyMode?: boolean;
	setReadOnlyMode?: (value: boolean) => void;
	// External ref for focusing from keyboard handler
	inputRef?: React.RefObject<HTMLTextAreaElement>;
	// Image paste handler from App
	handlePaste?: (e: React.ClipboardEvent) => void;
	// Image drop handler from App
	handleDrop?: (e: React.DragEvent) => void;
	// Image lightbox handler
	onOpenLightbox?: (image: string, contextImages?: string[], source?: 'staged' | 'history') => void;
	// Execution queue props
	executionQueue?: QueuedItem[];
	onRemoveQueuedItem?: (itemId: string) => void;
	onReorderQueuedItems?: (fromIndex: number, toIndex: number) => void;
	// Input send behavior (synced with global settings)
	enterToSendAI?: boolean;
	setEnterToSendAI?: (value: boolean) => void;
	// Flash notification callback
	showFlashNotification?: (message: string) => void;
	// Shortcuts for displaying keyboard hints
	shortcuts?: Record<string, Shortcut>;
}

// PERF: Wrap in React.memo to prevent unnecessary re-renders when parent state changes
export const GroupChatInput = React.memo(function GroupChatInput({
	theme,
	state,
	onSend,
	participants: _participants,
	sessions,
	groupChatId,
	draftMessage,
	onDraftChange,
	onOpenPromptComposer,
	stagedImages: stagedImagesProp,
	setStagedImages: setStagedImagesProp,
	readOnlyMode: readOnlyModeProp,
	setReadOnlyMode: setReadOnlyModeProp,
	inputRef: inputRefProp,
	handlePaste,
	handleDrop,
	onOpenLightbox,
	executionQueue,
	onRemoveQueuedItem,
	onReorderQueuedItems,
	enterToSendAI: enterToSendAIProp,
	setEnterToSendAI: setEnterToSendAIProp,
	showFlashNotification,
	shortcuts,
}: GroupChatInputProps): JSX.Element {
	// Read groups directly from store (Phase 3 pattern — no prop drilling)
	const groups = useSessionStore((s) => s.groups);

	const [message, setMessage] = useState(draftMessage || '');
	const [showMentions, setShowMentions] = useState(false);
	const [mentionFilter, setMentionFilter] = useState('');
	const [selectedMentionIndex, setSelectedMentionIndex] = useState(0);
	// Use lifted state if provided, otherwise local state
	const [localReadOnlyMode, setLocalReadOnlyMode] = useState(false);
	const readOnlyMode = readOnlyModeProp ?? localReadOnlyMode;
	const setReadOnlyMode = setReadOnlyModeProp ?? setLocalReadOnlyMode;
	// Use global setting if provided, otherwise fall back to local state (default false = Cmd+Enter to send)
	const [localEnterToSend, setLocalEnterToSend] = useState(false);
	const enterToSend = enterToSendAIProp ?? localEnterToSend;
	const setEnterToSend = setEnterToSendAIProp ?? setLocalEnterToSend;
	const [localStagedImages, setLocalStagedImages] = useState<string[]>([]);
	const stagedImages = stagedImagesProp ?? localStagedImages;
	const setStagedImages = setStagedImagesProp ?? setLocalStagedImages;
	const localInputRef = useRef<HTMLTextAreaElement>(null);
	const inputRef = inputRefProp ?? localInputRef;
	const mentionListRef = useRef<HTMLDivElement>(null);
	const selectedMentionRef = useRef<HTMLButtonElement>(null);
	const prevGroupChatIdRef = useRef(groupChatId);

	// Build list of mentionable items: groups first, then individual agents
	// Groups expand into all their member @mentions when selected
	const mentionItems = useMemo(() => {
		const items: MentionItem[] = [];

		// Add groups (only those with at least 1 non-terminal member)
		if (groups) {
			for (const group of groups) {
				const members = sessions.filter((s) => s.groupId === group.id && s.toolType !== 'terminal');
				if (members.length > 0) {
					items.push({
						type: 'group',
						group,
						mentionName: normalizeMentionName(group.name),
						memberCount: members.length,
						memberMentions: members.map((m) => `@${normalizeMentionName(m.name)}`),
					});
				}
			}
		}

		// Add individual agents (excluding terminal-only)
		for (const s of sessions) {
			if (s.toolType !== 'terminal') {
				items.push({
					type: 'agent',
					name: s.name,
					mentionName: normalizeMentionName(s.name),
					agentId: s.toolType,
					sessionId: s.id,
				});
			}
		}

		return items;
	}, [sessions, groups]);

	// Filter mention items based on filter text
	const filteredMentions = useMemo(() => {
		if (!mentionFilter) return mentionItems;
		return mentionItems.filter((item) => {
			if (item.type === 'group') {
				return (
					item.group.name.toLowerCase().includes(mentionFilter) ||
					item.mentionName.toLowerCase().includes(mentionFilter)
				);
			}
			return (
				item.name.toLowerCase().includes(mentionFilter) ||
				item.mentionName.toLowerCase().includes(mentionFilter)
			);
		});
	}, [mentionItems, mentionFilter]);

	// Scroll selected mention into view when selection changes
	useEffect(() => {
		if (showMentions) {
			// Use requestAnimationFrame to ensure DOM has updated with new ref assignment
			requestAnimationFrame(() => {
				if (selectedMentionRef.current) {
					selectedMentionRef.current.scrollIntoView({
						block: 'nearest',
						behavior: 'smooth',
					});
				}
			});
		}
	}, [selectedMentionIndex, showMentions]);

	// Sync message state when switching to a different group chat
	useEffect(() => {
		if (groupChatId !== prevGroupChatIdRef.current) {
			setMessage(draftMessage || '');
			prevGroupChatIdRef.current = groupChatId;
		}
	}, [groupChatId, draftMessage]);

	// Sync message when draftMessage changes externally (e.g., from PromptComposer)
	useEffect(() => {
		// Only sync if the draft differs from current message (external change)
		if (draftMessage !== undefined && draftMessage !== message) {
			setMessage(draftMessage);
		}
	}, [draftMessage]);

	const handleSend = useCallback(() => {
		// Allow sending even when busy - messages will be queued in App.tsx
		if (message.trim()) {
			onSend(message.trim(), stagedImages.length > 0 ? stagedImages : undefined, readOnlyMode);
			setMessage('');
			setStagedImages([]);
			onDraftChange?.('');
		}
	}, [message, onSend, readOnlyMode, onDraftChange, stagedImages]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			// Handle hotkeys that should work even when input has focus
			if (e.metaKey || e.ctrlKey) {
				// Cmd+R: Toggle read-only mode
				if (e.key === 'r') {
					e.preventDefault();
					e.stopPropagation();
					setReadOnlyMode(!readOnlyMode);
					return;
				}
				// Cmd+Y: Open image carousel
				if (e.key === 'y' && stagedImages.length > 0 && onOpenLightbox) {
					e.preventDefault();
					e.stopPropagation();
					onOpenLightbox(stagedImages[0], stagedImages, 'staged');
					return;
				}
				// Cmd+Enter: Send message (when enterToSend is false) or ignore (when enterToSend is true)
				// Either way, we must stop propagation to prevent global handler from switching views
				if (e.key === 'Enter') {
					e.preventDefault();
					e.stopPropagation();
					if (!enterToSend) {
						handleSend();
					}
					// When enterToSend is true, Cmd+Enter does nothing (plain Enter sends)
					return;
				}
				// Let global shortcuts bubble up (Cmd+K, Cmd+,, Cmd+/, etc.)
				// Don't stop propagation for meta/ctrl key combinations not handled above
				return;
			}

			if (showMentions && filteredMentions.length > 0) {
				if (e.key === 'ArrowDown') {
					e.preventDefault();
					e.stopPropagation();
					setSelectedMentionIndex((prev) => (prev < filteredMentions.length - 1 ? prev + 1 : 0));
					return;
				}
				if (e.key === 'ArrowUp') {
					e.preventDefault();
					e.stopPropagation();
					setSelectedMentionIndex((prev) => (prev > 0 ? prev - 1 : filteredMentions.length - 1));
					return;
				}
				if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
					e.preventDefault();
					e.stopPropagation();
					insertMention(filteredMentions[selectedMentionIndex]);
					return;
				}
				if (e.key === 'Escape') {
					e.preventDefault();
					e.stopPropagation();
					setShowMentions(false);
					return;
				}
			}

			// Handle send based on enterToSend setting (plain Enter, no modifier)
			if (enterToSend) {
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					handleSend();
				}
			}
		},
		[
			handleSend,
			showMentions,
			filteredMentions,
			selectedMentionIndex,
			enterToSend,
			readOnlyMode,
			setReadOnlyMode,
			stagedImages,
			onOpenLightbox,
		]
	);

	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const value = e.target.value;
			setMessage(value);
			onDraftChange?.(value);

			// Check for @mention trigger
			const lastAtIndex = value.lastIndexOf('@');
			if (lastAtIndex !== -1 && lastAtIndex === value.length - 1) {
				setShowMentions(true);
				setMentionFilter('');
				setSelectedMentionIndex(0);
			} else if (lastAtIndex !== -1) {
				const afterAt = value.slice(lastAtIndex + 1);
				if (!/\s/.test(afterAt)) {
					setShowMentions(true);
					setMentionFilter(afterAt.toLowerCase());
					setSelectedMentionIndex(0);
				} else {
					setShowMentions(false);
				}
			} else {
				setShowMentions(false);
			}
		},
		[onDraftChange]
	);

	const insertMention = useCallback(
		(item: MentionItem) => {
			const lastAtIndex = message.lastIndexOf('@');
			const prefix = message.slice(0, lastAtIndex);
			let insertion: string;
			if (item.type === 'group') {
				// Expand group into all member @mentions
				insertion = item.memberMentions.join(' ') + ' ';
			} else {
				insertion = `@${item.mentionName} `;
			}
			const newMessage = prefix + insertion;
			setMessage(newMessage);
			onDraftChange?.(newMessage);
			setShowMentions(false);
			inputRef.current?.focus();
		},
		[message, onDraftChange]
	);

	// Wrapped paste handler that trims text and delegates images to prop handler
	const handlePasteWrapped = useCallback(
		(e: React.ClipboardEvent<HTMLTextAreaElement>) => {
			const items = e.clipboardData.items;
			const hasImage = Array.from(items).some((item) => item.type.startsWith('image/'));

			// Handle text paste with whitespace trimming (when no images)
			if (!hasImage) {
				const text = e.clipboardData.getData('text/plain');
				if (text) {
					const trimmedText = text.trim();
					// Only intercept if trimming actually changed the text
					if (trimmedText !== text) {
						e.preventDefault();
						const target = e.target as HTMLTextAreaElement;
						const start = target.selectionStart ?? 0;
						const end = target.selectionEnd ?? 0;
						const newValue = message.slice(0, start) + trimmedText + message.slice(end);
						setMessage(newValue);
						onDraftChange?.(newValue);
						// Set cursor position after the pasted text
						requestAnimationFrame(() => {
							target.selectionStart = target.selectionEnd = start + trimmedText.length;
						});
					}
				}
				return;
			}

			// Delegate image handling to prop handler
			handlePaste?.(e);
		},
		[message, onDraftChange, handlePaste]
	);

	const handleImageSelect = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const files = Array.from(e.target.files || []);
			files.forEach((file) => {
				// Validate file type
				if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
					console.warn(`[GroupChatInput] Invalid file type rejected: ${file.type}`);
					return;
				}
				// Validate file size
				if (file.size > MAX_IMAGE_SIZE) {
					console.warn(
						`[GroupChatInput] File too large rejected: ${(file.size / 1024 / 1024).toFixed(2)}MB (max: 10MB)`
					);
					return;
				}
				const reader = new FileReader();
				reader.onload = (event) => {
					if (event.target?.result) {
						const imageData = event.target!.result as string;
						setStagedImages((prev) => {
							if (prev.includes(imageData)) {
								showFlashNotification?.('Duplicate image ignored');
								return prev;
							}
							return [...prev, imageData];
						});
					}
				};
				reader.readAsDataURL(file);
			});
			e.target.value = '';
		},
		[showFlashNotification]
	);

	const removeImage = useCallback((img: string) => {
		setStagedImages((prev) => prev.filter((x) => x !== img));
	}, []);

	const isBusy = state !== 'idle';
	const hasQueuedItems = executionQueue && executionQueue.length > 0;

	return (
		<div
			className="relative p-4 border-t"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
		>
			{/* Queued messages display */}
			{hasQueuedItems && (
				<QueuedItemsList
					executionQueue={executionQueue}
					theme={theme}
					onRemoveQueuedItem={onRemoveQueuedItem}
					onReorderItems={onReorderQueuedItems}
				/>
			)}

			{/* Mention dropdown */}
			{showMentions && filteredMentions.length > 0 && (
				<div
					ref={mentionListRef}
					className="mb-2 rounded-lg border p-1 max-h-48 overflow-y-auto"
					style={{
						backgroundColor: theme.colors.bgSidebar,
						borderColor: theme.colors.border,
					}}
				>
					{filteredMentions.map((item, index) => (
						<button
							key={item.type === 'group' ? `group-${item.group.id}` : item.sessionId}
							ref={index === selectedMentionIndex ? selectedMentionRef : null}
							onClick={() => insertMention(item)}
							className="w-full text-left px-3 py-1.5 rounded text-sm transition-colors flex items-center gap-2"
							style={{
								color: theme.colors.textMain,
								backgroundColor:
									index === selectedMentionIndex ? `${theme.colors.accent}20` : 'transparent',
							}}
						>
							{item.type === 'group' ? (
								<>
									<Users className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.accent }} />
									<span>{item.group.emoji}</span>
									<span>@{item.mentionName}</span>
									<span
										className="ml-auto text-[10px] px-1.5 py-0.5 rounded-full"
										style={{
											backgroundColor: `${theme.colors.accent}20`,
											color: theme.colors.accent,
										}}
									>
										group · {item.memberCount}
									</span>
								</>
							) : (
								<>
									<span>@{item.mentionName}</span>
									{item.name !== item.mentionName && (
										<span className="text-xs" style={{ color: theme.colors.textDim }}>
											({item.name})
										</span>
									)}
									<span className="ml-auto text-xs" style={{ color: theme.colors.textDim }}>
										{item.agentId}
									</span>
								</>
							)}
						</button>
					))}
				</div>
			)}

			{/* Staged images preview */}
			{stagedImages.length > 0 && (
				<div className="flex gap-2 mb-2 flex-wrap">
					{stagedImages.map((img) => (
						<div key={img} className="relative group">
							<img
								src={img}
								alt="Staged image"
								className="w-16 h-16 object-cover rounded border cursor-pointer hover:opacity-80 transition-opacity"
								style={{ borderColor: theme.colors.border }}
								onClick={() => onOpenLightbox?.(img, stagedImages, 'staged')}
							/>
							<button
								onClick={() => removeImage(img)}
								className="absolute -top-1 -right-1 w-4 h-4 rounded-full flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
								style={{
									backgroundColor: theme.colors.error,
									color: '#ffffff',
								}}
							>
								×
							</button>
						</div>
					))}
				</div>
			)}

			<div className="flex gap-3">
				{/* Main input area */}
				<div
					className="flex-1 relative border rounded-lg bg-opacity-50 flex flex-col"
					style={{
						borderColor: readOnlyMode ? theme.colors.warning : theme.colors.border,
						backgroundColor: readOnlyMode ? `${theme.colors.warning}15` : theme.colors.bgMain,
					}}
				>
					<textarea
						ref={inputRef}
						value={message}
						onChange={handleChange}
						onKeyDown={handleKeyDown}
						onPaste={handlePasteWrapped}
						onDrop={(e) => {
							e.stopPropagation();
							handleDrop?.(e);
						}}
						onDragOver={(e) => e.preventDefault()}
						placeholder={
							isBusy ? 'Type to queue message...' : 'Type a message... (@ to mention agent)'
						}
						rows={2}
						className="flex-1 bg-transparent text-sm outline-none pl-3 pt-3 pr-3 resize-none min-h-[2.5rem] scrollbar-thin"
						style={{
							color: theme.colors.textMain,
							maxHeight: '7rem',
						}}
					/>

					{/* Bottom toolbar row */}
					<div className="flex justify-between items-center px-2 pb-2 pt-1">
						{/* Left side - action buttons */}
						<div className="flex gap-1 items-center">
							{onOpenPromptComposer && (
								<button
									onClick={onOpenPromptComposer}
									className="p-1 hover:bg-white/10 rounded opacity-50 hover:opacity-100"
									title={`Open Prompt Composer${shortcuts?.openPromptComposer ? ` (${formatShortcutKeys(shortcuts.openPromptComposer.keys)})` : ''}`}
								>
									<PenLine className="w-4 h-4" />
								</button>
							)}
							<button
								onClick={() => document.getElementById('group-chat-image-input')?.click()}
								className="p-1 hover:bg-white/10 rounded opacity-50 hover:opacity-100"
								title="Attach Image"
							>
								<ImageIcon className="w-4 h-4" />
							</button>
							<input
								id="group-chat-image-input"
								type="file"
								accept="image/*"
								multiple
								className="hidden"
								onChange={handleImageSelect}
							/>
						</div>

						{/* Right side - toggles */}
						<div className="flex items-center gap-2">
							{/* Read-only mode toggle */}
							<button
								onClick={() => setReadOnlyMode(!readOnlyMode)}
								className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full cursor-pointer transition-all ${
									readOnlyMode ? '' : 'opacity-40 hover:opacity-70'
								}`}
								style={{
									backgroundColor: readOnlyMode ? `${theme.colors.warning}25` : 'transparent',
									color: readOnlyMode ? theme.colors.warning : theme.colors.textDim,
									border: readOnlyMode
										? `1px solid ${theme.colors.warning}50`
										: '1px solid transparent',
								}}
								title="Toggle read-only mode (agents won't modify files)"
							>
								<Eye className="w-3 h-3" />
								<span>Read-only</span>
							</button>

							{/* Enter to send toggle */}
							<button
								onClick={() => setEnterToSend(!enterToSend)}
								className="flex items-center gap-1 text-[10px] opacity-50 hover:opacity-100 px-2 py-1 rounded hover:bg-white/5"
								title={formatEnterToSendTooltip(enterToSend)}
							>
								<Keyboard className="w-3 h-3" />
								{formatEnterToSend(enterToSend)}
							</button>
						</div>
					</div>
				</div>

				{/* Send button - always enabled when there's text (queues if busy) */}
				<button
					onClick={handleSend}
					disabled={!message.trim()}
					className="self-end p-2.5 rounded-lg transition-colors"
					style={{
						backgroundColor: message.trim()
							? isBusy
								? theme.colors.warning
								: theme.colors.accent
							: theme.colors.border,
						color: message.trim() ? '#ffffff' : theme.colors.textDim,
					}}
					title={isBusy ? 'Queue message' : 'Send message'}
				>
					<ArrowUp className="w-5 h-5" />
				</button>
			</div>
		</div>
	);
});
