/**
 * Quick Chat's input surface, with font controls on the left and microphone
 * beside Send. A Cappella speaks about this document when enabled; otherwise
 * Web Speech dictates into the draft. Both use the existing tap/hold gesture.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Mic, History, ImagePlus, PenSquare, Square } from 'lucide-react';
import type { Theme } from '../../types';
import { ChatComposerSurface, ChatSendButton, ChatIconButton } from '../ui/ChatSurface';
import { FontScaleControl } from '../ui/FontScaleControl';
import type { UseFontScaleReturn } from '../../hooks/ui/useFontScale';
import { useAutosizeTextarea } from '../../hooks/ui/useAutosizeTextarea';
import { usePressAndHold } from '../../hooks/utils/usePressAndHold';
import { useVoiceInput } from '../../hooks/utils/useVoiceInput';
import { readableTextOn } from '../../../shared/colorContrast';
import type { UseDocumentChatReturn } from '../../hooks/ui/useDocumentChat';
import { useChatImageDraft } from '../../hooks/input/useChatImageDraft';
import { StagedImageTile } from '../InputArea/components/StagedImageTile';
import { openZoomViewer } from '../ZoomViewer';

interface DocumentChatComposerProps {
	theme: Theme;
	fontScale: UseFontScaleReturn;
	draft: string;
	onDraftChange: (value: string) => void;
	onSend: (text?: string, images?: string[]) => boolean;
	chat: UseDocumentChatReturn;
	onHistory: () => void;
	/** Tap-vs-hold threshold, mirrored from the voice control settings. */
	holdThresholdMs: number;
	/** Whether A Cappella is on. Gates push-to-talk only. */
	voiceEnabled: boolean;
	/** True while the live voice session is about this document. */
	voiceActive: boolean;
	onStartVoice: (hold?: boolean) => void;
	onReleaseVoice: () => void;
	onStopVoice: () => void;
}

export const DocumentChatComposer = React.memo(function DocumentChatComposer({
	theme,
	fontScale,
	draft,
	onDraftChange,
	onSend,
	chat,
	onHistory,
	holdThresholdMs,
	voiceEnabled,
	voiceActive,
	onStartVoice,
	onReleaseVoice,
	onStopVoice,
}: DocumentChatComposerProps) {
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const fileInputRef = useRef<HTMLInputElement>(null);
	const [imageError, setImageError] = useState<string | null>(null);
	const { images, setImages, stageImageFiles, imageDnd, onPaste, onDragOver, onDrop } =
		useChatImageDraft(textareaRef, setImageError);
	const send = useCallback(() => {
		if (onSend(undefined, images)) {
			setImages([]);
			setImageError(null);
		}
	}, [onSend, images, setImages]);
	useAutosizeTextarea({ textareaRef, value: draft, maxHeight: 120 });

	// As in the main composer, only one voice stack owns the microphone.
	const dictation = useVoiceInput({
		currentValue: draft,
		onTranscriptionChange: onDraftChange,
		focusRef: textareaRef,
		disabled: voiceEnabled,
	});

	useEffect(() => {
		if (voiceEnabled) dictation.stopVoiceInput();
	}, [voiceEnabled, dictation.stopVoiceInput]);

	const isTalkMode = voiceEnabled;

	const onHoldStart = useCallback(() => {
		if (isTalkMode) {
			onStartVoice(true);
			return;
		}
		dictation.startVoiceInput();
	}, [isTalkMode, onStartVoice, dictation.startVoiceInput]);

	const onHoldEnd = useCallback(() => {
		if (isTalkMode) {
			onReleaseVoice();
			return;
		}
		dictation.stopVoiceInput();
	}, [isTalkMode, onReleaseVoice, dictation.stopVoiceInput]);

	// A tap toggles, which is what a tap has always meant on the voice hotkey and
	// on the HUD's talk button: someone having a conversation taps once and
	// forgets about it, and forcing them to hold for a whole spoken paragraph is
	// the fight this pairing exists to avoid.
	const onTap = useCallback(() => {
		if (isTalkMode) {
			if (voiceActive) onStopVoice();
			else onStartVoice();
			return;
		}
		if (dictation.isListening) dictation.stopVoiceInput();
		else dictation.startVoiceInput();
	}, [
		isTalkMode,
		voiceActive,
		onStartVoice,
		onStopVoice,
		dictation.isListening,
		dictation.startVoiceInput,
		dictation.stopVoiceInput,
	]);

	// Match Quick Chat: show a microphone when a voice stack is available.
	const pushUnavailable = !voiceEnabled && !dictation.voiceSupported;
	const listening = isTalkMode ? voiceActive : dictation.isListening;

	const { holding, beginPress, endPress } = usePressAndHold({
		holdThresholdMs,
		onHoldStart,
		onHoldEnd,
		onTap,
		disabled: pushUnavailable,
	});

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (event.key !== 'Enter' || event.shiftKey) return;
			event.preventDefault();
			send();
		},
		[send]
	);

	const pushLabel = pushUnavailable
		? 'This build has no speech recogniser'
		: holding
			? 'Release to stop'
			: listening
				? 'Stop'
				: isTalkMode
					? 'Hold to talk, or tap to start'
					: 'Hold to dictate, or tap to start';

	const onAccent = readableTextOn(theme.colors.accentForeground, [theme.colors.accent]);

	return (
		<ChatComposerSurface
			theme={theme}
			className="shrink-0 pt-3"
			data-testid="document-chat-composer"
			onDragOver={onDragOver}
			onDrop={onDrop}
		>
			{images.length > 0 && (
				<div className="flex gap-2 overflow-x-auto" {...imageDnd.containerHandlers}>
					{images.map((image, index) => (
						<StagedImageTile
							key={image}
							image={image}
							index={index}
							theme={theme}
							size="strip"
							showSlotNumber={images.length > 1 || imageDnd.isDragging}
							isDragging={imageDnd.dragIndex === index}
							isDimmed={imageDnd.isDragging && imageDnd.dragIndex !== index}
							dropBefore={imageDnd.dropGap === index}
							dropAfter={imageDnd.dropGap === index + 1 && index === images.length - 1}
							dragHandlers={imageDnd.tileHandlers(index)}
							onOpen={(img) => {
								if (img) openZoomViewer(img, `Image ${index + 1}`);
							}}
							onRemove={() => setImages((prev) => prev.filter((x) => x !== image))}
						/>
					))}
				</div>
			)}
			{imageError && (
				<span role="alert" className="text-xs" style={{ color: theme.colors.error }}>
					{imageError}
				</span>
			)}
			<textarea
				ref={textareaRef}
				autoFocus
				data-testid="document-chat-input"
				value={draft}
				onChange={(event) => onDraftChange(event.target.value)}
				onKeyDown={handleKeyDown}
				onPaste={onPaste}
				rows={1}
				placeholder="Ask about this document..."
				aria-label="Message about this document"
				className="w-full resize-none bg-transparent outline-none text-sm leading-6"
				style={{ color: theme.colors.textMain }}
			/>
			<div className="flex flex-wrap items-center justify-end gap-1">
				<FontScaleControl
					theme={theme}
					control={fontScale}
					variant="ghost"
					target="chat"
					testId="document-chat-font-scale"
				/>
				<div className="flex-1" />
				<ChatIconButton
					theme={theme}
					label="Attach images"
					hint="Or paste or drop them here."
					onClick={() => fileInputRef.current?.click()}
				>
					<ImagePlus className="w-4 h-4" />
				</ChatIconButton>
				<input
					ref={fileInputRef}
					type="file"
					accept="image/*"
					multiple
					className="hidden"
					data-testid="document-chat-image-input"
					onChange={(event) => {
						stageImageFiles(Array.from(event.target.files ?? []));
						event.target.value = '';
						textareaRef.current?.focus();
					}}
				/>
				<ChatIconButton
					theme={theme}
					label="Recent chats"
					hint="Resume an earlier conversation about this document."
					onClick={onHistory}
				>
					<History className="w-4 h-4" />
				</ChatIconButton>
				<ChatIconButton
					theme={theme}
					label="New chat"
					hint="Keep this thread in history and start a fresh conversation."
					onClick={() => {
						chat.reset();
						setImages([]);
						setImageError(null);
					}}
					disabled={!chat.tab}
				>
					<PenSquare className="w-4 h-4" />
				</ChatIconButton>
				{!pushUnavailable && (
					<button
						type="button"
						data-testid="document-chat-push"
						aria-label={pushLabel}
						aria-pressed={listening}
						title={pushLabel}
						onMouseDown={(event) => event.preventDefault()}
						onPointerDown={(event) => {
							if (event.button !== 0) return;
							beginPress();
						}}
						onPointerUp={endPress}
						// Keyboard users get the plain toggle. Holding a key needs a keyup
						// this button does not reliably receive once focus moves, and a
						// push-to-talk that sometimes fails to release is worse than a toggle.
						onKeyDown={(event) => {
							if (event.key !== 'Enter' && event.key !== ' ') return;
							event.preventDefault();
							onTap();
						}}
						className="shrink-0 p-1.5 rounded-md transition-opacity hover:opacity-100 focus:outline-none focus-visible:ring-2"
						style={{
							backgroundColor: listening ? theme.colors.accent : 'transparent',
							color: listening ? onAccent : theme.colors.textMain,
							opacity: listening ? 1 : 0.7,
						}}
					>
						<Mic className="w-4 h-4" />
					</button>
				)}

				{(chat.busy || chat.pending > 0) && (
					<button
						type="button"
						aria-label="Stop"
						title="Stop replies and withdraw queued messages"
						onClick={chat.stop}
						className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center"
						style={{ backgroundColor: theme.colors.textMain, color: theme.colors.bgMain }}
					>
						<Square className="w-3.5 h-3.5" fill="currentColor" />
					</button>
				)}
				<ChatSendButton
					theme={theme}
					data-testid="document-chat-send"
					aria-label="Send message"
					title="Send message (Enter)"
					disabled={draft.trim().length === 0 && images.length === 0}
					onClick={send}
				/>
			</div>
		</ChatComposerSurface>
	);
});

export default DocumentChatComposer;
