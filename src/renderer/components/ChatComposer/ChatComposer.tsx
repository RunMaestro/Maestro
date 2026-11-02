/**
 * ChatComposer.tsx
 *
 * Session-free chat composer shell composing the pieces extracted in steps 2-7:
 * - Textarea with MentionChipOverlay and autosize (ComposerTextarea)
 * - @ mention autocomplete popover and keys (AtMentionPopover, useMentionPicker)
 * - Staged images strip and reordering (StagedImagesStrip)
 * - Shared toolbar controls with voice dictation (ToolbarControls)
 * - Notification bell and Send button column (ComposerSendColumn)
 * - Phone fold handle (PhoneComposerHandle)
 * - Toast avoidance zone (useToastAvoidZone)
 * - Deferred quit indicator (QuitWhenIdleIndicator)
 *
 * Surface adapters (such as GroupChatInput) supply surface-specific state
 * (draft persistence, queue mirroring, provider capabilities) through props and slots.
 */

import React, { useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import { useUIStore } from '../../stores/uiStore';
import { useImageAnnotatorStore } from '../ImageAnnotator/imageAnnotatorStore';
import { usePhoneLayout } from '../../hooks/ui/useViewportBreakpoint';
import { usePersistedToggle } from '../../hooks/ui/usePersistedToggle';
import { useToastAvoidZone } from '../../hooks/ui/useToastAvoidZone';
import { useAutosizeTextarea } from '../../hooks/ui/useAutosizeTextarea';
import { useScrollIntoView } from '../../hooks/ui/useScrollIntoView';
import { useVoiceInput } from '../../hooks/utils/useVoiceInput';
import { useStableCallback } from '../../hooks/utils/useStableCallback';
import { ComposerSendColumn } from './ComposerSendColumn';
import { ComposerTextarea } from './ComposerTextarea';
import { PhoneComposerHandle } from '../InputArea/components/PhoneComposerHandle';
import { ToolbarControls } from '../InputArea/components/ToolbarControls';
import { QuitWhenIdleIndicator } from '../QuitWhenIdleIndicator';
import { StagedImagesStrip } from '../InputArea/components/StagedImagesStrip';
import { AtMentionPopover } from '../InputArea/overlays/AtMentionPopover';
import { moveStagedImage } from '../../utils/stagedImageOrder';
import { applyTrimmedTextPaste, clipboardHasImage } from './pasteTrim';
import { getAtMentionTrigger } from '../InputArea/utils/inputTriggers';
import {
	useMentionPicker,
	buildMentionAccept,
	type MentionPickerItem,
} from '../../hooks/input/useMentionPicker';
import type { AtMentionSuggestion } from '../../hooks/input/useAtMentionCompletion';
import { buildKnownMentionNameSet } from '../../hooks/input/useAgentMentionCompletion';
import {
	handleComposerFindKey,
	handleComposerPickerKey,
	handleComposerSendKey,
} from '../../hooks/input/composerKeyDown';
import { KEYSTROKE_TEXTAREA_MAX_HEIGHT } from '../../utils/textareaSizing';
import type { Theme, Session, Group, Shortcut } from '../../types';
import type { ComposerCapabilities } from './capabilities';

const NO_FILE_SUGGESTIONS: AtMentionSuggestion[] = [];
const EMPTY_SESSIONS: Session[] = [];
const NOOP_SET_ENTER_TO_SEND = () => {};
const NOOP_SET_STAGED_IMAGES = () => {};
const NOOP_DROP = (e: React.DragEvent<HTMLTextAreaElement>) => {
	e.stopPropagation();
};

export interface MentionRoster {
	sessions: Session[];
	groups?: Group[];
}

export interface ChatComposerProps {
	theme: Theme;
	value: string;
	onChange: (value: string) => void;
	draftKey?: string;
	placeholder?: string;
	capabilities: ComposerCapabilities;
	isBusy?: boolean;
	warningBorder?: boolean;
	phoneFoldStorageKey?: string;
	inputRef?: React.RefObject<HTMLTextAreaElement>;

	// Staged images
	stagedImages?: string[];
	setStagedImages?: React.Dispatch<React.SetStateAction<string[]>>;
	checkImageFile?: (file: File) => string | null;
	imageInputId?: string;
	imageReportComponent?: string;
	onOpenLightbox?: (image: string, contextImages?: string[], source?: 'staged' | 'history') => void;

	// Keyboard & focus
	enterToSend?: boolean;
	setEnterToSend?: (value: boolean) => void;
	resolveSearchKey?: () => string | null;
	isolateFromWindowKeys?: boolean;
	onFocus?: () => void;
	onBlur?: () => void;

	// Mentions
	mentionRoster?: MentionRoster;

	// Submit
	onSubmit?: () => void;
	sendTitle?: string;
	sendTone?: 'accent' | 'warning';
	sendDisabled?: boolean;

	// Slots
	aboveComposer?: React.ReactNode;
	toolbarExtras?: React.ReactNode;
	sheetExtras?: React.ReactNode;

	// Event bridges
	onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
	onDrop?: (e: React.DragEvent<HTMLTextAreaElement>) => void;
	onUploadFiles?: (files: File[]) => void;
	onOpenPromptComposer?: () => void;

	// Chrome & notifications
	shortcuts?: Record<string, Shortcut>;
	showFlashNotification?: (message: string) => void;
	className?: string;
	style?: React.CSSProperties;
}

export const ChatComposer = React.memo(function ChatComposer({
	theme,
	value,
	onChange,
	draftKey,
	placeholder = 'Type a message...',
	capabilities,
	isBusy = false,
	warningBorder = false,
	phoneFoldStorageKey,
	inputRef: inputRefProp,
	stagedImages,
	setStagedImages,
	checkImageFile,
	imageInputId,
	imageReportComponent,
	onOpenLightbox,
	enterToSend = false,
	setEnterToSend,
	resolveSearchKey,
	isolateFromWindowKeys = true,
	onFocus,
	onBlur,
	mentionRoster,
	onSubmit,
	sendTitle,
	sendTone,
	sendDisabled,
	aboveComposer,
	toolbarExtras,
	sheetExtras,
	onPaste,
	onDrop,
	onUploadFiles,
	onOpenPromptComposer,
	shortcuts,
	showFlashNotification,
	className,
	style,
}: ChatComposerProps): JSX.Element {
	const spellCheckEnabled = useSettingsStore((state) => state.spellCheck);
	const localInputRef = useRef<HTMLTextAreaElement>(null);
	const inputRef = inputRefProp ?? localInputRef;

	const toastAvoidRef = useToastAvoidZone();
	const phone = usePhoneLayout();
	const composerFold = usePersistedToggle(phoneFoldStorageKey ?? 'phone.composer.collapsed', true);

	// Mention state
	const [atMentionOpen, setAtMentionOpen] = useState(false);
	const [atMentionFilter, setAtMentionFilter] = useState('');
	const [atMentionStartIndex, setAtMentionStartIndex] = useState(-1);
	const [selectedAtMentionIndex, setSelectedAtMentionIndex] = useState(0);

	const sessions = mentionRoster?.sessions ?? EMPTY_SESSIONS;
	const groups = mentionRoster?.groups;

	const { items: atMentionItems } = useMentionPicker({
		filter: atMentionFilter,
		category: 'agents',
		sessions,
		groups,
		currentSessionId: undefined,
		fileSuggestions: NO_FILE_SUGGESTIONS,
	});

	const hasMentionCandidate = value.includes('@');
	const knownMentionNames = useMemo(
		() =>
			hasMentionCandidate && sessions.length > 0
				? buildKnownMentionNameSet(sessions, groups, undefined)
				: undefined,
		[hasMentionCandidate, sessions, groups]
	);

	const atMentionItemRefs = useScrollIntoView<HTMLButtonElement>(
		atMentionOpen,
		selectedAtMentionIndex,
		atMentionItems.length
	);

	const closeAtMention = useCallback(() => {
		setAtMentionOpen(false);
		setAtMentionFilter('');
		setAtMentionStartIndex(-1);
	}, []);

	const acceptAtMention = useCallback(
		(item: MentionPickerItem) => {
			const accept = buildMentionAccept(value, atMentionStartIndex, atMentionFilter, item);
			onChange(accept.value);
			closeAtMention();
			inputRef.current?.focus();
			requestAnimationFrame(() => {
				const el = inputRef.current;
				if (el) el.selectionStart = el.selectionEnd = accept.caretPos;
			});
		},
		[value, atMentionStartIndex, atMentionFilter, onChange, closeAtMention, inputRef]
	);

	// Voice dictation
	const voice = useVoiceInput({
		currentValue: value,
		onTranscriptionChange: onChange,
		focusRef: inputRef,
	});

	// Cancel voice input on draftKey change
	const prevDraftKeyRef = useRef(draftKey);
	useEffect(() => {
		if (prevDraftKeyRef.current !== draftKey) {
			voice.cancelVoiceInput();
			prevDraftKeyRef.current = draftKey;
		}
	}, [draftKey, voice]);

	// Auto-resize textarea
	useAutosizeTextarea({
		textareaRef: inputRef,
		value,
		maxHeight: KEYSTROKE_TEXTAREA_MAX_HEIGHT,
	});

	const handleSend = useCallback(() => {
		const isSendDisabled = sendDisabled ?? !value.trim();
		if (isSendDisabled) return;
		voice.cancelVoiceInput();
		onSubmit?.();
	}, [sendDisabled, value, voice, onSubmit]);

	const handleSendStable = useStableCallback(handleSend);
	const handleToggleVoiceInput = useStableCallback(voice.toggleVoiceInput);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (
				resolveSearchKey &&
				handleComposerFindKey(e, {
					resolveSearchKey,
					isolateFromWindowKeys,
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
					isolateFromWindowKeys,
				})
			) {
				return;
			}
			handleComposerSendKey(e, {
				enterToSend,
				send: handleSend,
				inputRef,
				isolateFromWindowKeys,
			});
		},
		[
			resolveSearchKey,
			isolateFromWindowKeys,
			atMentionOpen,
			atMentionItems,
			selectedAtMentionIndex,
			acceptAtMention,
			closeAtMention,
			inputRef,
			enterToSend,
			handleSend,
		]
	);

	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const nextValue = e.target.value;
			onChange(nextValue);

			const trigger = getAtMentionTrigger(nextValue, e.target.selectionStart ?? nextValue.length);
			if (trigger) {
				setAtMentionOpen(true);
				setAtMentionFilter(trigger.filter);
				setAtMentionStartIndex(trigger.startIndex);
				setSelectedAtMentionIndex(0);
			} else {
				setAtMentionOpen(false);
			}
		},
		[onChange]
	);

	const handlePasteWrapped = useCallback(
		(e: React.ClipboardEvent<HTMLTextAreaElement>) => {
			if (clipboardHasImage(e.clipboardData)) {
				onPaste?.(e);
				return;
			}
			applyTrimmedTextPaste(e, value, onChange);
		},
		[value, onChange, onPaste]
	);

	const handleFocus = useCallback(() => {
		useUIStore.getState().setActiveFocus('main');
		onFocus?.();
	}, [onFocus]);

	const handleReorderStagedImages = useCallback(
		(from: number, to: number) => setStagedImages?.((prev) => moveStagedImage(prev, from, to)),
		[setStagedImages]
	);

	const setLightboxImageCallback = useCallback(
		(img: string | null, contextImages?: string[], source?: 'staged' | 'history') => {
			if (img) onOpenLightbox?.(img, contextImages, source);
		},
		[onOpenLightbox]
	);

	const openAnnotatorCallback = useCallback((img: string, onSave: (dataUrl: string) => void) => {
		useImageAnnotatorStore.getState().openAnnotator(img, onSave);
	}, []);

	const phoneHandleHasDraft =
		value.trim().length > 0 || (stagedImages ? stagedImages.length > 0 : false);
	const resolvedSendTitle = sendTitle ?? (isBusy ? 'Queue message' : 'Send message');
	const resolvedSendTone = sendTone ?? (isBusy ? 'warning' : 'accent');
	const resolvedSendDisabled = sendDisabled ?? !value.trim();
	const resolvedSetEnterToSend = setEnterToSend ?? NOOP_SET_ENTER_TO_SEND;
	const resolvedSetStagedImages = setStagedImages ?? NOOP_SET_STAGED_IMAGES;

	// Folded: nothing but the handle.
	if (phone && composerFold.value) {
		return (
			<div ref={toastAvoidRef}>
				<PhoneComposerHandle
					theme={theme}
					collapsed
					onToggle={composerFold.toggle}
					busy={isBusy}
					hasDraft={phoneHandleHasDraft}
				/>
			</div>
		);
	}

	return (
		<div
			ref={toastAvoidRef}
			className={`relative border-t ${phone ? 'px-3 pb-3 pt-0' : 'p-4'} ${className ?? ''}`}
			style={{
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgSidebar,
				...style,
			}}
		>
			{phone && (
				<PhoneComposerHandle
					theme={theme}
					collapsed={false}
					onToggle={composerFold.toggle}
					busy={isBusy}
				/>
			)}

			<QuitWhenIdleIndicator theme={theme} />

			{aboveComposer}

			<AtMentionPopover
				isOpen={atMentionOpen}
				isTerminalMode={false}
				items={atMentionItems}
				category="agents"
				showCategoryBar={false}
				selectedIndex={selectedAtMentionIndex}
				filter={atMentionFilter}
				startIndex={atMentionStartIndex}
				inputValue={value}
				itemRefs={atMentionItemRefs}
				theme={theme}
				setInputValue={onChange}
				setOpen={setAtMentionOpen}
				setFilter={setAtMentionFilter}
				setStartIndex={setAtMentionStartIndex}
				setSelectedIndex={setSelectedAtMentionIndex}
				inputRef={inputRef}
			/>

			{stagedImages && stagedImages.length > 0 && (
				<StagedImagesStrip
					isVisible
					stagedImages={stagedImages}
					theme={theme}
					setLightboxImage={setLightboxImageCallback}
					setStagedImages={resolvedSetStagedImages}
					openAnnotator={openAnnotatorCallback}
					onReorder={handleReorderStagedImages}
				/>
			)}

			<div className="flex gap-3">
				<div
					className="flex-1 relative border rounded-lg bg-opacity-50 flex flex-col"
					style={{
						borderColor: warningBorder ? theme.colors.warning : theme.colors.border,
						backgroundColor: warningBorder ? `${theme.colors.warning}15` : theme.colors.bgMain,
					}}
				>
					<ComposerTextarea
						theme={theme}
						value={value}
						inputRef={inputRef}
						placeholder={placeholder}
						spellCheck={spellCheckEnabled}
						knownMentionNames={knownMentionNames}
						rows={1}
						onChange={handleChange}
						onKeyDown={handleKeyDown}
						onPaste={handlePasteWrapped}
						onDrop={onDrop ?? NOOP_DROP}
						onFocus={handleFocus}
						onBlur={onBlur}
					/>

					<ToolbarControls
						theme={theme}
						capabilities={capabilities}
						isTerminalMode={false}
						enterToSend={enterToSend}
						setEnterToSend={resolvedSetEnterToSend}
						setStagedImages={resolvedSetStagedImages}
						imageInputId={imageInputId}
						imageReportComponent={imageReportComponent}
						checkImageFile={checkImageFile}
						onUploadFiles={onUploadFiles}
						voiceSupported={voice.voiceSupported}
						isVoiceListening={voice.isListening}
						onToggleVoiceInput={handleToggleVoiceInput}
						onOpenPromptComposer={onOpenPromptComposer}
						shortcuts={shortcuts}
						showFlashNotification={showFlashNotification}
						toolbarExtras={toolbarExtras}
						sheetExtras={sheetExtras}
						processInput={handleSendStable}
						sendTitle={resolvedSendTitle}
						sendDisabled={resolvedSendDisabled}
						sendTone={resolvedSendTone}
					/>
				</div>

				{!phone && (
					<ComposerSendColumn
						theme={theme}
						className="self-end"
						onSend={handleSend}
						sendTitle={resolvedSendTitle}
						sendDisabled={resolvedSendDisabled}
						sendTone={resolvedSendTone}
					/>
				)}
			</div>
		</div>
	);
});
