/**
 * GroupChatInput.tsx
 *
 * Input area for the Group Chat view, adapted over ChatComposer. Supports:
 * - Text input with Enter/Cmd+Enter to send
 * - @mention autocomplete for all live agents and groups
 * - Room read-only mode toggle (desktop toolbar button and phone sheet switch)
 * - Attach image with 10MB cap and type allowlist
 * - Prompt composer integration
 * - Execution queue display and steer handling for busy rooms
 * - Local draft persistence debounced via useDraftPersistence
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
import { ChatComposer, GROUP_CHAT_COMPOSER_CAPABILITIES } from './ChatComposer';
import { PhoneSheetSwitchRow } from './ui/PhoneSheetRows';
import { shortcutSuffix } from './ui/ShortcutHint';
import { logger } from '../utils/logger';
import { useDraftPersistence } from '../hooks/input/useDraftPersistence';
import { groupChatOutputSearchKey } from '../utils/outputSearch';
import type { SteerEligibility } from '../utils/executionQueue';
import { groupChatSteerBlockedReason } from '../../shared/groupChatSteering';

/** localStorage key for the room's phone composer fold (separate from AI chat's). */
export const GROUP_CHAT_PHONE_COMPOSER_COLLAPSED_KEY = 'phone.groupChatComposer.collapsed';

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
	const [message, setMessage] = useState(draftMessage || '');
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
	const mentionRoster = useMemo(() => ({ sessions, groups }), [sessions, groups]);

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
	}, [
		message,
		onSend,
		readOnlyMode,
		cancelDraft,
		onDraftChange,
		groupChatId,
		stagedImages,
		setStagedImages,
	]);

	const handleChange = useCallback(
		(value: string) => {
			setMessage(value);
			persistDraft(value, groupChatId);
		},
		[persistDraft, groupChatId]
	);

	const handlePasteWrapped = useCallback(
		(e: React.ClipboardEvent<HTMLTextAreaElement>) => {
			handlePaste?.(e);
		},
		[handlePaste]
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

	const isBusy = state !== 'idle';

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

	const aboveComposer = useMemo(
		() => (
			<>
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
			</>
		),
		[
			queuePaused,
			failedItem,
			theme,
			onResumeQueue,
			sendingItem,
			hasQueuedItems,
			executionQueue,
			onRemoveQueuedItem,
			onReorderQueuedItems,
			onOpenLightbox,
			onSteerQueuedItem,
			getSteerContext,
		]
	);

	const resolveSearchKey = useCallback(() => groupChatOutputSearchKey(groupChatId), [groupChatId]);

	return (
		<ChatComposer
			theme={theme}
			value={message}
			onChange={handleChange}
			draftKey={groupChatId}
			inputRef={inputRef}
			capabilities={GROUP_CHAT_COMPOSER_CAPABILITIES}
			isBusy={isBusy}
			warningBorder={readOnlyMode}
			placeholder={isBusy ? 'Type to queue message...' : 'Type a message... (@ to mention agent)'}
			phoneFoldStorageKey={GROUP_CHAT_PHONE_COMPOSER_COLLAPSED_KEY}
			stagedImages={stagedImages}
			setStagedImages={setStagedImages}
			checkImageFile={checkGroupChatImageFile}
			imageInputId="group-chat-image-input"
			imageReportComponent="GroupChatInput"
			onOpenLightbox={onOpenLightbox}
			onPaste={handlePasteWrapped}
			onDrop={handleDropWrapped}
			onUploadFiles={onUploadFiles ? handleUploadFiles : undefined}
			onOpenPromptComposer={onOpenPromptComposer ? handleOpenPromptComposer : undefined}
			shortcuts={shortcuts}
			showFlashNotification={showFlashNotification}
			enterToSend={enterToSend}
			setEnterToSend={setEnterToSend}
			resolveSearchKey={resolveSearchKey}
			isolateFromWindowKeys={true}
			mentionRoster={mentionRoster}
			toolbarExtras={readOnlyToggle}
			sheetExtras={readOnlySheetRow}
			aboveComposer={aboveComposer}
			onSubmit={handleSend}
			onBlur={flushDraft}
		/>
	);
});
