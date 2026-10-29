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
import { filterLiveAgents } from '../../shared/agentVisibility';
import { Eye } from 'lucide-react';
import type {
	Theme,
	GroupChatParticipant,
	GroupChatState,
	Group,
	QueuedItem,
	Shortcut,
} from '../types';
import { QueuedItemsList } from './QueuedItemsList';
import {
	ComposerSendColumn,
	ComposerTextarea,
	GROUP_CHAT_COMPOSER_CAPABILITIES,
	applyTrimmedTextPaste,
	clipboardHasImage,
} from './ChatComposer';
import { ToolbarControls } from './InputArea/components/ToolbarControls';
import { PhoneSheetSwitchRow } from './ui/PhoneSheetRows';
import { shortcutSuffix } from './ui/ShortcutHint';
import { usePhoneLayout } from '../hooks/ui/useViewportBreakpoint';
import { useStableCallback } from '../hooks/utils/useStableCallback';
import { useVoiceInput } from '../hooks/utils/useVoiceInput';
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
import {
	handleComposerFindKey,
	handleComposerPickerKey,
	handleComposerSendKey,
} from '../hooks/input/composerKeyDown';
import { StagedImagesStrip } from './InputArea/components/StagedImagesStrip';
import { moveStagedImage } from '../utils/stagedImageOrder';
import { useUIStore } from '../stores/uiStore';
import { groupChatOutputSearchKey } from '../utils/outputSearch';
import { useAutosizeTextarea } from '../hooks/ui/useAutosizeTextarea';
import { useToastAvoidZone } from '../hooks/ui/useToastAvoidZone';
import { KEYSTROKE_TEXTAREA_MAX_HEIGHT } from '../utils/textareaSizing';
import type { SteerEligibility } from '../utils/executionQueue';
import { groupChatSteerBlockedReason } from '../../shared/groupChatSteering';
import { buildKnownMentionNameSet } from '../hooks/input/useAgentMentionCompletion';

/** Maximum image file size in bytes (10MB) */
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/** Allowed image MIME types */
const ALLOWED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

/**
 * The room's attach checks: a type allowlist and a size cap. Returns the
 * message the user is shown, or null to accept the file. AI chat applies
 * neither, so these stay with the room rather than in the shared input.
 */
function checkGroupChatImageFile(file: File): string | null {
	if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
		logger.warn(`[GroupChatInput] Invalid file type rejected: ${file.type}`);
		return 'Unsupported image type (PNG, JPEG, GIF or WebP)';
	}
	if (file.size > MAX_IMAGE_SIZE) {
		logger.warn(
			`[GroupChatInput] File too large rejected: ${(file.size / 1024 / 1024).toFixed(2)}MB (max: 10MB)`
		);
		return 'Image too large (max 10MB)';
	}
	return null;
}

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
	/** Steer a queued message into the round that is running. */
	onSteerQueuedItem?: (itemId: string) => void;
	onRemoveQueuedItem?: (itemId: string) => void;
	onReorderQueuedItems?: (fromIndex: number, toIndex: number) => void;
	// Input send behavior (synced with global settings)
	enterToSendAI?: boolean;
	setEnterToSendAI?: (value: boolean) => void;
	// Flash notification callback
	showFlashNotification?: (message: string) => void;
	// Shortcuts for displaying keyboard hints
	shortcuts?: Record<string, Shortcut>;
	/** Upload local files to the host (web-desktop); mentions land in the draft. */
	onUploadFiles?: (files: File[]) => void;
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
	onSteerQueuedItem,
	onRemoveQueuedItem,
	onReorderQueuedItems,
	enterToSendAI: enterToSendAIProp,
	setEnterToSendAI: setEnterToSendAIProp,
	showFlashNotification,
	shortcuts,
	onUploadFiles,
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
	// Toasts lift above the composer instead of covering it (Right Bar closed).
	const toastAvoidRef = useToastAvoidZone();

	useEffect(() => {
		if (!draftFlushRef) return;
		draftFlushRef.current = flushDraft;
		return () => {
			if (draftFlushRef.current === flushDraft) draftFlushRef.current = null;
		};
	}, [draftFlushRef, flushDraft]);

	// Narrow mention-shaped sessions so streaming logs do not rebuild @mentions.
	const storedSessions = useStoreWithEqualityFn(
		useSessionStore,
		(s) => s.sessions,
		mentionSessionEquality
	);
	// Live agents only: a dormant Pianola (flag off) is never offered for @mention.
	const pianolaEnabled = useSettingsStore((s) => s.encoreFeatures.pianola);
	const sessions = useMemo(
		() => filterLiveAgents(storedSessions, { pianola: pianolaEnabled }),
		[storedSessions, pianolaEnabled]
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
	// Live `@mention` pills, the same decoration the AI composer draws. Built
	// from the same roster the picker offers, so a name chips exactly when the
	// picker could have inserted it.
	const hasMentionCandidate = message.includes('@');
	const knownMentionNames = useMemo(
		() => (hasMentionCandidate ? buildKnownMentionNameSet(sessions, groups, undefined) : undefined),
		[hasMentionCandidate, sessions, groups]
	);

	const atMentionItemRefs = useScrollIntoView<HTMLButtonElement>(
		atMentionOpen,
		selectedAtMentionIndex,
		atMentionItems.length
	);

	// Set the draft and persist it, as typing does. AtMentionPopover's own
	// click-to-accept path and voice dictation both write through this.
	const setDraftValue = useCallback(
		(value: string) => {
			setMessage(value);
			persistDraft(value, groupChatId);
		},
		[persistDraft, groupChatId]
	);

	// Voice dictation: interim results live-update the draft and persist it like
	// typing. The hook is a no-op where the Web Speech API is unavailable.
	// A dictation started in one room writes that room's text through that
	// room's id, so it is cancelled when the room changes or its draft is sent:
	// a late result would otherwise land in the next room's draft (saved under
	// the old id) or put the sent text back.
	const voice = useVoiceInput({
		currentValue: message,
		onTranscriptionChange: setDraftValue,
		focusRef: inputRef,
	});
	const { cancelVoiceInput } = voice;

	// Sync message state when switching to a different group chat
	useEffect(() => {
		if (groupChatId !== prevGroupChatIdRef.current) {
			cancelVoiceInput();
			flushDraft();
			setMessage(draftMessage || '');
			prevGroupChatIdRef.current = groupChatId;
		}
	}, [groupChatId, draftMessage, flushDraft, cancelVoiceInput]);

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
			cancelVoiceInput();
			cancelDraft();
			setMessage('');
			setStagedImages([]);
			onDraftChange?.('', groupChatId);
		}
	}, [
		message,
		onSend,
		readOnlyMode,
		cancelVoiceInput,
		cancelDraft,
		onDraftChange,
		groupChatId,
		stagedImages,
	]);

	const closeAtMention = useCallback(() => {
		setAtMentionOpen(false);
		setAtMentionFilter('');
		setAtMentionStartIndex(-1);
	}, []);

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
			closeAtMention();
			inputRef.current?.focus();
			// Land the caret right after the inserted token, deferred a frame so it
			// runs after the controlled value commits (matches AtMentionPopover's own
			// click-to-accept timing).
			requestAnimationFrame(() => {
				const el = inputRef.current;
				if (el) el.selectionStart = el.selectionEnd = accept.caretPos;
			});
		},
		[message, atMentionStartIndex, atMentionFilter, persistDraft, groupChatId, closeAtMention]
	);

	// The shared composer keys, in the AI composer's order: Find, the `@`
	// picker, then send. The window keyboard handlers only know the AI composer,
	// so every key handled here is isolated from them. Escape with the picker
	// closed is left to the window's handleEscapeInMain, which knows where the
	// room's transcript is. The read-only and image carousel chords are not
	// handled here and bubble to the window handler, which acts on the room.
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (
				handleComposerFindKey(e, {
					resolveSearchKey: () => groupChatOutputSearchKey(groupChatId),
					isolateFromWindowKeys: true,
				})
			) {
				return;
			}
			if (
				handleComposerPickerKey(e, {
					open: atMentionOpen,
					items: atMentionItems,
					selectedIndex: selectedAtMentionIndex,
					setSelectedIndex: setSelectedAtMentionIndex,
					accept: acceptAtMention,
					close: closeAtMention,
					inputRef,
					isolateFromWindowKeys: true,
				})
			) {
				return;
			}
			handleComposerSendKey(e, {
				enterToSend,
				send: handleSend,
				inputRef,
				isolateFromWindowKeys: true,
			});
		},
		[
			handleSend,
			atMentionOpen,
			atMentionItems,
			selectedAtMentionIndex,
			acceptAtMention,
			closeAtMention,
			enterToSend,
			groupChatId,
			inputRef,
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
			if (clipboardHasImage(e.clipboardData)) {
				handlePaste?.(e);
				return;
			}
			applyTrimmedTextPaste(e, message, (newValue) => {
				setMessage(newValue);
				persistDraft(newValue, groupChatId);
			});
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

	// An upload appends its @mentions to the STORED draft, so publish the local
	// text first, as a drop does.
	const handleUploadFiles = useCallback(
		(files: File[]) => {
			flushDraft();
			onUploadFiles?.(files);
		},
		[flushDraft, onUploadFiles]
	);

	// Both close over the live draft; stable identities keep the memoized
	// toolbar from re-rendering on every keystroke.
	const handleToggleVoiceInput = useStableCallback(voice.toggleVoiceInput);
	const handleSendStable = useStableCallback(handleSend);

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
	const phone = usePhoneLayout();

	// The room's Read-Only toggle (one flag for every room, sent per message to
	// main). The toolbar draws it in its toggle group on desktop and as a sheet
	// row on a phone, so the room keeps it in every layout.
	const readOnlyKeys = useSettingsStore((s) => s.tabShortcuts.toggleReadOnlyMode?.keys);
	const readOnlyToggle = useMemo(
		() => (
			<button
				onClick={() => setReadOnlyMode(!readOnlyMode)}
				className={`flex items-center gap-1.5 text-2xs px-2 py-1 rounded-full cursor-pointer transition-all ${
					readOnlyMode ? '' : 'opacity-40 hover:opacity-70'
				}`}
				style={{
					backgroundColor: readOnlyMode ? `${theme.colors.warning}25` : 'transparent',
					color: readOnlyMode ? theme.colors.warning : theme.colors.textDim,
					border: readOnlyMode ? `1px solid ${theme.colors.warning}50` : '1px solid transparent',
				}}
				title={`Toggle Read-Only mode (agents won't modify files)${shortcutSuffix(readOnlyKeys)}`}
			>
				<Eye className="w-3 h-3" />
				<span>Read-Only</span>
			</button>
		),
		[readOnlyMode, setReadOnlyMode, theme, readOnlyKeys]
	);
	const readOnlySheetRow = useMemo(
		() => (
			<PhoneSheetSwitchRow
				icon={Eye}
				label="Read-Only"
				checked={readOnlyMode}
				onToggle={() => setReadOnlyMode(!readOnlyMode)}
				accent={theme.colors.warning}
				theme={theme}
				testId="composer-options-read-only"
			/>
		),
		[readOnlyMode, setReadOnlyMode, theme]
	);

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

	// Steer is offered while the round runs, on anything a turn can type. Which
	// turn takes it (moderator, or the working participants it names) is main's
	// call, and a refusal comes back as a toast with the reason.
	const getSteerContext = useCallback(
		(item: QueuedItem): SteerEligibility => {
			const entry = queueState?.items.find((candidate) => candidate.id === item.id);
			const blocked = groupChatSteerBlockedReason({
				busy: isBusy,
				text: entry?.text,
				images: entry?.images,
				sending: entry?.sending,
				failed: entry?.failed,
			});
			return { canSteer: !!entry && blocked === null };
		},
		[queueState, isBusy]
	);

	return (
		<div
			ref={toastAvoidRef}
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
					getSteerContext={onSteerQueuedItem ? getSteerContext : undefined}
					onSteerQueuedItem={onSteerQueuedItem}
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
				setInputValue={setDraftValue}
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
					<ComposerTextarea
						theme={theme}
						value={message}
						inputRef={inputRef}
						placeholder={
							isBusy ? 'Type to queue message...' : 'Type a message... (@ to mention agent)'
						}
						spellCheck={spellCheckEnabled}
						knownMentionNames={knownMentionNames}
						rows={1}
						onChange={handleChange}
						onKeyDown={handleKeyDown}
						onPaste={handlePasteWrapped}
						onDrop={handleDropWrapped}
						// The window Escape handler only acts while focus is in the main
						// area, so claim it here the way the AI composer does. A click on
						// the Left Bar leaves it on 'sidebar' otherwise.
						onFocus={() => useUIStore.getState().setActiveFocus('main')}
						onBlur={flushDraft}
					/>

					<ToolbarControls
						theme={theme}
						capabilities={GROUP_CHAT_COMPOSER_CAPABILITIES}
						isTerminalMode={false}
						enterToSend={enterToSend}
						setEnterToSend={setEnterToSend}
						setStagedImages={setStagedImages}
						imageInputId="group-chat-image-input"
						imageReportComponent="GroupChatInput"
						checkImageFile={checkGroupChatImageFile}
						onUploadFiles={onUploadFiles ? handleUploadFiles : undefined}
						voiceSupported={voice.voiceSupported}
						isVoiceListening={voice.isListening}
						onToggleVoiceInput={handleToggleVoiceInput}
						onOpenPromptComposer={onOpenPromptComposer ? handleOpenPromptComposer : undefined}
						shortcuts={shortcuts}
						showFlashNotification={showFlashNotification}
						toolbarExtras={readOnlyToggle}
						sheetExtras={readOnlySheetRow}
						processInput={handleSendStable}
						sendTitle={isBusy ? 'Queue message' : 'Send message'}
						sendDisabled={!message.trim()}
						sendTone={isBusy ? 'warning' : 'accent'}
					/>
				</div>

				{/* Notifications & Send Button - Right Side. No Send menu: a busy
				    room queues through main. On a phone the column is gone and Send
				    sits in the toolbar row, as in AI chat. */}
				{!phone && (
					<ComposerSendColumn
						theme={theme}
						className="self-end"
						onSend={handleSend}
						sendTitle={isBusy ? 'Queue message' : 'Send message'}
						sendDisabled={!message.trim()}
						sendTone={isBusy ? 'warning' : 'accent'}
					/>
				)}
			</div>
		</div>
	);
});
