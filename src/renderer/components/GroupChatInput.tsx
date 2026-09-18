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
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { useSettingsStore } from '../stores/settingsStore';
import type { GroupChatQueueState } from '../../shared/group-chat-types';
import { useSessionStore } from '../stores/sessionStore';
import { mentionSessionEquality } from '../stores/sessionEquality';
import { ArrowUp, Bell, ImageIcon, Eye, Keyboard, PenLine } from 'lucide-react';
import type {
	Theme,
	GroupChatParticipant,
	GroupChatState,
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
import { NotificationPopover } from './NotificationPopover';
import { useImageAnnotatorStore } from './ImageAnnotator/imageAnnotatorStore';
import { logger } from '../utils/logger';
import { useDraftPersistence } from '../hooks/input/useDraftPersistence';
import {
	useMentionPicker,
	buildMentionAccept,
	type MentionPickerItem,
} from '../hooks/input/useMentionPicker';
import type { AtMentionSuggestion } from '../hooks/input/useAtMentionCompletion';
import { AtMentionPopover } from './InputArea/overlays/AtMentionPopover';
import { getAtMentionTrigger } from './InputArea/utils/inputTriggers';
import { useScrollIntoView } from '../hooks/ui/useScrollIntoView';
import { StagedImagesStrip } from './InputArea/components/StagedImagesStrip';
import { moveStagedImage } from '../utils/stagedImageOrder';
import { useUIStore } from '../stores/uiStore';
import { groupChatOutputSearchKey } from '../utils/outputSearch';
import { OUTPUT_SEARCH_INPUT_SELECTOR } from '../hooks/ui/useOutputSearchLayer';
import { useAutosizeTextarea } from '../hooks/ui/useAutosizeTextarea';
import { KEYSTROKE_TEXTAREA_MAX_HEIGHT } from '../utils/textareaSizing';

/** Maximum image file size in bytes (10MB) */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/** Allowed image MIME types */
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * Group Chat has no file/directory mentions, only agents and groups - the unified
 * `@` picker's `fileSuggestions` input is always this stable empty array.
 */
const NO_FILE_SUGGESTIONS: AtMentionSuggestion[] = [];

interface GroupChatInputProps {
	theme: Theme;
	state: GroupChatState;
	onSend: (content: string, images?: string[], readOnly?: boolean) => void;
	participants: GroupChatParticipant[];
	groups?: Group[];
	groupChatId: string;
	draftMessage?: string;
	onDraftChange?: (draft: string, groupChatId: string) => void;
	onOpenPromptComposer?: () => void;
	draftFlushRef?: React.MutableRefObject<(() => void) | null>;
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
	/** The chat's pending sends as MAIN reports them. Undefined until loaded. */
	queueState?: GroupChatQueueState;
	onResumeQueue?: () => void;
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
	groups,
	groupChatId,
	draftMessage,
	onDraftChange,
	onOpenPromptComposer,
	draftFlushRef,
	stagedImages: stagedImagesProp,
	setStagedImages: setStagedImagesProp,
	readOnlyMode: readOnlyModeProp,
	setReadOnlyMode: setReadOnlyModeProp,
	inputRef: inputRefProp,
	handlePaste,
	handleDrop,
	onOpenLightbox,
	queueState,
	onResumeQueue,
	onRemoveQueuedItem,
	onReorderQueuedItems,
	enterToSendAI: enterToSendAIProp,
	setEnterToSendAI: setEnterToSendAIProp,
	showFlashNotification,
	shortcuts,
}: GroupChatInputProps): JSX.Element {
	const spellCheckEnabled = useSettingsStore((state) => state.spellCheck);
	const [message, setMessage] = useState(draftMessage || '');
	// Unified `@` mention picker state (see useMentionPicker/AtMentionPopover).
	// Local rather than lifted through InputArea's useInputContext - that context
	// also orchestrates slash commands and tab completion, neither of which
	// Group Chat has.
	const [atMentionOpen, setAtMentionOpen] = useState(false);
	const [atMentionFilter, setAtMentionFilter] = useState('');
	const [atMentionStartIndex, setAtMentionStartIndex] = useState(-1);
	const [selectedAtMentionIndex, setSelectedAtMentionIndex] = useState(0);
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
	const prevGroupChatIdRef = useRef(groupChatId);
	const [notificationPopoverOpen, setNotificationPopoverOpen] = useState(false);
	const notificationBtnRef = useRef<HTMLButtonElement>(null);
	const lastPersistedDraftRef = useRef<{ groupChatId: string; draft: string } | null>(null);
	// Shared with AI Chat's own draft write-back (useInputSync) - see
	// useDraftPersistence's doc comment for why a key (here, groupChatId)
	// switch flushes the old key immediately rather than dropping it.
	const onPersistDraft = useCallback(
		(targetGroupChatId: string, draft: string) => {
			lastPersistedDraftRef.current = { groupChatId: targetGroupChatId, draft };
			onDraftChange?.(draft, targetGroupChatId);
		},
		[onDraftChange]
	);
	const {
		queueFlush: queueDraftFlush,
		flushPending: flushDraft,
		cancelPending: cancelDraft,
	} = useDraftPersistence<string>(onPersistDraft, 300);
	const persistDraft = useCallback(
		(draft: string, targetGroupChatId: string) => queueDraftFlush(targetGroupChatId, draft),
		[queueDraftFlush]
	);

	useEffect(() => {
		if (!draftFlushRef) return;
		draftFlushRef.current = flushDraft;
		return () => {
			if (draftFlushRef.current === flushDraft) draftFlushRef.current = null;
		};
	}, [draftFlushRef, flushDraft]);

	// Narrow mention-shaped sessions so streaming logs do not rebuild @mentions.
	const sessions = useStoreWithEqualityFn(
		useSessionStore,
		(s) => s.sessions,
		mentionSessionEquality
	);

	// Unified `@` mention picker, locked to the Agents category (Group Chat has
	// no file/directory mentions) and with no `currentSessionId` to exclude -
	// group chat isn't itself a mentioning agent, so every non-terminal session
	// stays eligible, same as the hand-rolled version this replaced.
	const { items: atMentionItems } = useMentionPicker({
		filter: atMentionFilter,
		category: 'agents',
		sessions,
		groups,
		currentSessionId: undefined,
		fileSuggestions: NO_FILE_SUGGESTIONS,
	});
	const atMentionItemRefs = useScrollIntoView<HTMLButtonElement>(
		atMentionOpen,
		selectedAtMentionIndex,
		atMentionItems.length
	);

	// Sync message state when switching to a different group chat
	useEffect(() => {
		if (groupChatId !== prevGroupChatIdRef.current) {
			flushDraft();
			setMessage(draftMessage || '');
			prevGroupChatIdRef.current = groupChatId;
		}
	}, [groupChatId, draftMessage, flushDraft]);

	// Sync message when draftMessage changes externally (e.g., from PromptComposer)
	useEffect(() => {
		if (draftMessage === undefined) return;
		const lastPersisted = lastPersistedDraftRef.current;
		if (lastPersisted?.groupChatId === groupChatId && lastPersisted.draft === draftMessage) {
			lastPersistedDraftRef.current = null;
			return;
		}
		cancelDraft();
		setMessage((current) => (current === draftMessage ? current : draftMessage));
	}, [draftMessage, groupChatId, cancelDraft]);

	const handleSend = useCallback(() => {
		// Allow sending even when busy - messages will be queued in App.tsx
		if (message.trim()) {
			onSend(message.trim(), stagedImages.length > 0 ? stagedImages : undefined, readOnlyMode);
			cancelDraft();
			setMessage('');
			setStagedImages([]);
			onDraftChange?.('', groupChatId);
		}
	}, [message, onSend, readOnlyMode, cancelDraft, onDraftChange, groupChatId, stagedImages]);

	// Keyboard-driven accept (Tab/Enter). A row clicked directly in the popover
	// is instead accepted by AtMentionPopover's own internal handler, wired
	// through the setInputValue/setOpen/... props passed to it below.
	const acceptAtMention = useCallback(
		(item: MentionPickerItem) => {
			// The category is locked to 'agents' here, so every row is an agent or a
			// group - never a directory - and `buildMentionAccept`'s drill-in
			// (`keepOpen`) branch, used by the unified file picker, never applies.
			const accept = buildMentionAccept(message, atMentionStartIndex, atMentionFilter, item);
			setMessage(accept.value);
			persistDraft(accept.value, groupChatId);
			setAtMentionOpen(false);
			setAtMentionFilter('');
			setAtMentionStartIndex(-1);
			inputRef.current?.focus();
			// Land the caret right after the inserted token, deferred a frame so it
			// runs after the controlled value commits (matches AtMentionPopover's own
			// click-to-accept timing).
			requestAnimationFrame(() => {
				const el = inputRef.current;
				if (el) el.selectionStart = el.selectionEnd = accept.caretPos;
			});
		},
		[message, atMentionStartIndex, atMentionFilter, persistDraft, groupChatId]
	);

	// AtMentionPopover's own click-to-accept path calls this instead of
	// acceptAtMention directly - it needs a draft-persisting setInputValue, not
	// just a state setter.
	const setAtMentionInputValue = useCallback(
		(value: string) => {
			setMessage(value);
			persistDraft(value, groupChatId);
		},
		[persistDraft, groupChatId]
	);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			// Handle hotkeys that should work even when input has focus
			if (e.metaKey || e.ctrlKey) {
				// Cmd+F: open transcript Find (group chat has no TerminalOutput to catch this).
				// Alt must be excluded: Opt+Cmd+F is cross-tab search and is not available here.
				// stopPropagation means the window handler never runs, so refocus here when
				// the bar is already open.
				if (e.key === 'f' && !e.shiftKey && !e.altKey) {
					e.preventDefault();
					e.stopPropagation();
					const key = groupChatOutputSearchKey(groupChatId);
					const ui = useUIStore.getState();
					if (ui.outputSearchByKey[key]?.open) {
						document.querySelector<HTMLInputElement>(OUTPUT_SEARCH_INPUT_SELECTOR)?.focus();
					} else {
						ui.setOutputSearchOpen(key, true);
					}
					return;
				}
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

			// Mirrors AI Chat's useInputKeyDown shape: gated on atMentionOpen alone
			// (not atMentionItems.length > 0), so Escape and Tab/Enter still fire
			// when the popover is showing an empty state - AtMentionPopover stays
			// mounted and renders "No agents available" rather than unmounting.
			if (atMentionOpen) {
				if (e.key === 'ArrowDown') {
					e.preventDefault();
					e.stopPropagation();
					if (atMentionItems.length > 0) {
						setSelectedAtMentionIndex((prev) => Math.min(prev + 1, atMentionItems.length - 1));
					}
					return;
				}
				if (e.key === 'ArrowUp') {
					e.preventDefault();
					e.stopPropagation();
					if (atMentionItems.length > 0) {
						setSelectedAtMentionIndex((prev) => Math.max(prev - 1, 0));
					}
					return;
				}
				if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
					e.preventDefault();
					e.stopPropagation();
					// atMentionItems can shrink for reasons other than an Arrow keypress
					// (the session/group list changing, or the filter narrowing results)
					// while the popover is open, so the index isn't guaranteed to still
					// be in range. Look the item up rather than assume it's there - a
					// stale, out-of-range index falls through to closing the popover
					// with nothing inserted, same as AI Chat, instead of either
					// crashing or silently auto-accepting an item the user never
					// highlighted.
					const selected = atMentionItems[selectedAtMentionIndex];
					if (selected) {
						acceptAtMention(selected);
					} else {
						setAtMentionOpen(false);
						setAtMentionFilter('');
						setAtMentionStartIndex(-1);
					}
					return;
				}
				if (e.key === 'Escape') {
					e.preventDefault();
					e.stopPropagation();
					setAtMentionOpen(false);
					setAtMentionFilter('');
					setAtMentionStartIndex(-1);
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
			atMentionOpen,
			atMentionItems,
			selectedAtMentionIndex,
			acceptAtMention,
			enterToSend,
			readOnlyMode,
			setReadOnlyMode,
			stagedImages,
			onOpenLightbox,
			groupChatId,
		]
	);

	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const value = e.target.value;
			setMessage(value);
			persistDraft(value, groupChatId);

			// Check for @mention trigger, using the same canonical detector InputArea
			// uses so a trigger fires on identical text/caret shapes on both surfaces.
			const trigger = getAtMentionTrigger(value, e.target.selectionStart ?? value.length);
			if (trigger) {
				setAtMentionOpen(true);
				setAtMentionFilter(trigger.filter);
				setAtMentionStartIndex(trigger.startIndex);
				setSelectedAtMentionIndex(0);
			} else {
				setAtMentionOpen(false);
			}
		},
		[persistDraft, groupChatId]
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
						persistDraft(newValue, groupChatId);
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
		[message, persistDraft, groupChatId, handlePaste]
	);

	const handleDropWrapped = useCallback(
		(e: React.DragEvent<HTMLTextAreaElement>) => {
			e.stopPropagation();
			flushDraft();
			handleDrop?.(e);
		},
		[flushDraft, handleDrop]
	);

	const handleOpenPromptComposer = useCallback(() => {
		flushDraft();
		onOpenPromptComposer?.();
	}, [flushDraft, onOpenPromptComposer]);

	const handleImageSelect = useCallback(
		(e: React.ChangeEvent<HTMLInputElement>) => {
			const files = Array.from(e.target.files || []);
			files.forEach((file) => {
				// Validate file type
				if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
					logger.warn(`[GroupChatInput] Invalid file type rejected: ${file.type}`);
					return;
				}
				// Validate file size
				if (file.size > MAX_IMAGE_SIZE) {
					logger.warn(
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

	// Reordering the strip reorders what the agent receives (every send path
	// walks stagedImages in order - see stagedImageOrder.ts). Group Chat has no
	// "Screenshot N" text-reference convention the way AI Chat's InputArea does
	// (nothing here ever writes that text into the draft), so unlike InputArea's
	// own handleReorderStagedImages there is no accompanying text to renumber.
	const handleReorderStagedImages = useCallback(
		(from: number, to: number) => setStagedImages((prev) => moveStagedImage(prev, from, to)),
		[setStagedImages]
	);

	// Auto-resize textarea as content changes (matches InputArea behavior), keeping
	// the caret visible once the composer is tall enough to scroll.
	useAutosizeTextarea({
		textareaRef: inputRef,
		value: message,
		maxHeight: KEYSTROKE_TEXTAREA_MAX_HEIGHT,
	});

	const isBusy = state !== 'idle';

	// The queue arrives from MAIN in its own shape. `QueuedItemsList` is the
	// existing renderer widget and speaks `QueuedItem`, so the adaptation happens
	// here rather than by teaching main about a renderer type.
	const executionQueue = useMemo(
		() =>
			(queueState?.items ?? []).map(
				(entry): QueuedItem => ({
					id: entry.id,
					timestamp: entry.timestamp,
					tabId: groupChatId,
					type: 'message',
					text: entry.text,
					images: entry.images,
					readOnlyMode: entry.readOnlyMode,
				})
			),
		[queueState, groupChatId]
	);
	const hasQueuedItems = executionQueue.length > 0;
	const queuePaused = queueState?.paused === true;
	const failedItem = queueState?.items.find((entry) => entry.failed);
	const sendingItem = queueState?.items.find((entry) => entry.sending);

	return (
		<div
			className="relative p-4 border-t"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
		>
			{/* Paused banner. A paused queue sends nothing, so it has to say so and
			    offer the way out - otherwise the user sees messages sitting there
			    with no clue why and no control to release them. */}
			{(queuePaused || failedItem) && (
				<div
					className="mb-2 flex items-center gap-2 rounded-lg border px-3 py-2 text-xs"
					style={{
						borderColor: theme.colors.warning,
						backgroundColor: `color-mix(in srgb, ${theme.colors.warning} 10%, transparent)`,
						color: theme.colors.textMain,
					}}
				>
					<span className="flex-1 min-w-0">
						{failedItem
							? `Queue paused: ${failedItem.failureReason ?? 'a message could not be sent'}`
							: 'Queue paused'}
					</span>
					{onResumeQueue && (
						<button
							type="button"
							onClick={onResumeQueue}
							className="shrink-0 px-2 py-0.5 rounded text-2xs font-bold"
							style={{ backgroundColor: theme.colors.accent, color: theme.colors.bgMain }}
						>
							Resume
						</button>
					)}
				</div>
			)}

			{/* One message is on its way to the moderator and cannot be removed. */}
			{sendingItem && (
				<div className="mb-2 px-1 text-2xs" style={{ color: theme.colors.textDim }}>
					Sending, cannot remove
				</div>
			)}

			{/* Queued messages display */}
			{hasQueuedItems && (
				<QueuedItemsList
					executionQueue={executionQueue}
					theme={theme}
					onRemoveQueuedItem={onRemoveQueuedItem}
					onReorderItems={onReorderQueuedItems}
					onOpenLightbox={onOpenLightbox}
				/>
			)}

			<AtMentionPopover
				isOpen={atMentionOpen}
				isTerminalMode={false}
				items={atMentionItems}
				category="agents"
				showCategoryBar={false}
				selectedIndex={selectedAtMentionIndex}
				filter={atMentionFilter}
				startIndex={atMentionStartIndex}
				inputValue={message}
				itemRefs={atMentionItemRefs}
				theme={theme}
				setInputValue={setAtMentionInputValue}
				setOpen={setAtMentionOpen}
				setFilter={setAtMentionFilter}
				setStartIndex={setAtMentionStartIndex}
				setSelectedIndex={setSelectedAtMentionIndex}
				inputRef={inputRef}
			/>

			<StagedImagesStrip
				isVisible
				stagedImages={stagedImages}
				theme={theme}
				setLightboxImage={(img, contextImages, source) => {
					if (img) onOpenLightbox?.(img, contextImages, source);
				}}
				setStagedImages={setStagedImages}
				openAnnotator={(img, onSave) =>
					useImageAnnotatorStore.getState().openAnnotator(img, onSave)
				}
				onReorder={handleReorderStagedImages}
			/>

			<div className="flex gap-3">
				{/* Main input area */}
				<div
					className="flex-1 relative border rounded-lg bg-opacity-50 flex flex-col"
					style={{
						borderColor: readOnlyMode ? theme.colors.warning : theme.colors.border,
						backgroundColor: readOnlyMode ? `${theme.colors.warning}15` : theme.colors.bgMain,
					}}
				>
					<div className="flex items-start">
						<textarea
							ref={inputRef}
							value={message}
							onChange={handleChange}
							onBlur={flushDraft}
							onKeyDown={handleKeyDown}
							onPaste={handlePasteWrapped}
							onDrop={handleDropWrapped}
							onDragOver={(e) => e.preventDefault()}
							placeholder={
								isBusy ? 'Type to queue message...' : 'Type a message... (@ to mention agent)'
							}
							spellCheck={spellCheckEnabled}
							rows={1}
							className="flex-1 bg-transparent text-sm outline-none pl-3 pt-3 pr-3 resize-none min-h-[2.5rem] scrollbar-thin"
							style={{
								color: theme.colors.textMain,
								maxHeight: '11rem',
							}}
						/>
					</div>

					{/* Bottom toolbar row */}
					<div className="flex justify-between items-center px-2 pb-2 pt-1">
						{/* Left side - action buttons */}
						<div className="flex gap-1 items-center">
							{onOpenPromptComposer && (
								<button
									onClick={handleOpenPromptComposer}
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
								className={`flex items-center gap-1.5 text-2xs px-2 py-1 rounded-full cursor-pointer transition-all ${
									readOnlyMode ? '' : 'opacity-40 hover:opacity-70'
								}`}
								style={{
									backgroundColor: readOnlyMode ? `${theme.colors.warning}25` : 'transparent',
									color: readOnlyMode ? theme.colors.warning : theme.colors.textDim,
									border: readOnlyMode
										? `1px solid ${theme.colors.warning}50`
										: '1px solid transparent',
								}}
								title="Toggle Read-Only mode (agents won't modify files)"
							>
								<Eye className="w-3 h-3" />
								<span>Read-Only</span>
							</button>

							{/* Enter to send toggle */}
							<button
								onClick={() => setEnterToSend(!enterToSend)}
								className="flex items-center gap-1 text-2xs opacity-50 hover:opacity-100 px-2 py-1 rounded hover:bg-white/5"
								title={formatEnterToSendTooltip(enterToSend)}
							>
								<Keyboard className="w-3 h-3" />
								{formatEnterToSend(enterToSend)}
							</button>
						</div>
					</div>
				</div>

				{/* Notifications & Send Button - Right Side */}
				<div className="self-end flex flex-col gap-2">
					<button
						ref={notificationBtnRef}
						type="button"
						onClick={() => setNotificationPopoverOpen((prev) => !prev)}
						className="p-2 rounded-lg border transition-all"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
							color: theme.colors.textDim,
						}}
						title="Notification Settings"
					>
						<Bell className="w-4 h-4" />
					</button>
					{notificationPopoverOpen && (
						<NotificationPopover
							theme={theme}
							anchorRef={notificationBtnRef}
							onClose={() => setNotificationPopoverOpen(false)}
						/>
					)}
					<button
						onClick={handleSend}
						disabled={!message.trim()}
						className="p-2 rounded-md shadow-sm transition-all hover:opacity-90 cursor-pointer"
						style={{
							backgroundColor: message.trim()
								? isBusy
									? theme.colors.warning
									: theme.colors.accent
								: theme.colors.border,
							color: message.trim() ? theme.colors.accentForeground : theme.colors.textDim,
						}}
						title={isBusy ? 'Queue message' : 'Send message'}
					>
						<ArrowUp className="w-4 h-4" />
					</button>
				</div>
			</div>
		</div>
	);
});
