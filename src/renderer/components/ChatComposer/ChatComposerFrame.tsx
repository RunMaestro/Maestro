/**
 * ChatComposerFrame.tsx
 *
 * The chat composer shell both surfaces render: the AI composer (InputArea)
 * and the Group Chat composer (through ChatComposer). It owns the layout and
 * the shared chrome:
 * - Phone fold and handle (PhoneComposerHandle, with useChatComposerFold)
 * - Deferred quit indicator (QuitWhenIdleIndicator)
 * - Toast avoidance zone (useToastAvoidZone), unless the surface registers its own
 * - Staged images strip (StagedImagesStrip)
 * - The bordered composer box and its warning tint
 * - Shared toolbar controls (ToolbarControls)
 * - Notification bell and Send button column (ComposerSendColumn)
 *
 * It owns no input behaviour. The surface brings the textarea, its key and
 * change handlers, its popovers, voice dictation and autosize, because the two
 * surfaces wire those differently: the AI composer's keys, picker categories,
 * slash commands and command mode live in useInputKeyDown and InputContext,
 * while a room uses the simpler wiring in ChatComposer. What the surface draws
 * arrives through slots, in this order: `aboveComposer`, `overlays`, the staged
 * strip, then inside the box `inputHeader` and `textarea`, then `belowInput`.
 */

import React from 'react';
import { usePhoneLayout } from '../../hooks/ui/useViewportBreakpoint';
import { usePersistedToggle } from '../../hooks/ui/usePersistedToggle';
import { useToastAvoidZone } from '../../hooks/ui/useToastAvoidZone';
import { ComposerSendColumn } from './ComposerSendColumn';
import { PhoneComposerHandle } from '../InputArea/components/PhoneComposerHandle';
import { ToolbarControls } from '../InputArea/components/ToolbarControls';
import { QuitWhenIdleIndicator } from '../QuitWhenIdleIndicator';
import { StagedImagesStrip } from '../InputArea/components/StagedImagesStrip';
import type { Theme, Shortcut } from '../../types';
import type { ComposerCapabilities } from './capabilities';

const NOOP_SET_ENTER_TO_SEND = () => {};
const NOOP_SET_STAGED_IMAGES = () => {};

export interface ChatComposerFold {
	/** True on a phone while the composer is folded behind its handle. */
	isFolded: boolean;
	toggle: () => void;
}

/**
 * The phone fold for one surface, remembered under its own storage key. The
 * surface calls this rather than the frame, because its autosize has to know
 * when an unfold mounts a fresh textarea.
 */
export function useChatComposerFold(storageKey: string): ChatComposerFold {
	const phone = usePhoneLayout();
	const fold = usePersistedToggle(storageKey, true);
	return { isFolded: phone && fold.value, toggle: fold.toggle };
}

export interface ChatComposerVoice {
	supported: boolean;
	listening: boolean;
	/** Must be identity-stable, or the memoized toolbar re-renders per keystroke. */
	onToggle: () => void;
}

export interface ChatComposerFrameProps {
	theme: Theme;
	capabilities: ComposerCapabilities;
	fold: ChatComposerFold;
	/** Busy dot on the phone handle. */
	isBusy?: boolean;
	/** Pencil on the folded phone handle. */
	hasDraft?: boolean;
	warningBorder?: boolean;
	/** Register the composer as a toast avoid zone. Default true. */
	avoidToasts?: boolean;

	// Slots
	aboveComposer?: React.ReactNode;
	overlays?: React.ReactNode;
	textarea: React.ReactNode;
	toolbarExtras?: React.ReactNode;
	sheetExtras?: React.ReactNode;

	// Staged images
	stagedImages?: string[];
	setStagedImages?: React.Dispatch<React.SetStateAction<string[]>>;
	onReorderStagedImages?: (from: number, to: number) => void;
	setLightboxImage?: (
		image: string | null,
		contextImages?: string[],
		source?: 'staged' | 'history'
	) => void;
	openAnnotator?: (image: string, onSave: (dataUrl: string) => void) => void;
	checkImageFile?: (file: File) => string | null;
	imageInputId?: string;
	imageReportComponent?: string;

	// Toolbar
	enterToSend?: boolean;
	setEnterToSend?: (value: boolean) => void;
	voice?: ChatComposerVoice;
	onUploadFiles?: (files: File[]) => void;
	onOpenPromptComposer?: () => void;
	shortcuts?: Record<string, Shortcut>;
	showFlashNotification?: (message: string) => void;

	// Send. `onSend` must be identity-stable: the toolbar and the column are
	// memoized, and a fresh callback per keystroke re-renders both.
	onSend: () => void;
	sendTitle?: string;
	sendDisabled?: boolean;
	sendTone?: 'accent' | 'warning';
	sendColumnClassName?: string;

	className?: string;
	style?: React.CSSProperties;
}

export const ChatComposerFrame = React.memo(function ChatComposerFrame({
	theme,
	capabilities,
	fold,
	isBusy = false,
	hasDraft = false,
	warningBorder = false,
	avoidToasts = true,
	aboveComposer,
	overlays,
	textarea,
	toolbarExtras,
	sheetExtras,
	stagedImages,
	setStagedImages,
	onReorderStagedImages,
	setLightboxImage,
	openAnnotator,
	checkImageFile,
	imageInputId,
	imageReportComponent,
	enterToSend = false,
	setEnterToSend,
	voice,
	onUploadFiles,
	onOpenPromptComposer,
	shortcuts,
	showFlashNotification,
	onSend,
	sendTitle,
	sendDisabled,
	sendTone,
	sendColumnClassName,
	className,
	style,
}: ChatComposerFrameProps): JSX.Element {
	const toastAvoidRef = useToastAvoidZone();
	const zoneRef = avoidToasts ? toastAvoidRef : undefined;
	const phone = usePhoneLayout();
	const resolvedSetStagedImages = setStagedImages ?? NOOP_SET_STAGED_IMAGES;

	// Folded: nothing but the handle.
	if (fold.isFolded) {
		const handle = (
			<PhoneComposerHandle
				theme={theme}
				collapsed
				onToggle={fold.toggle}
				busy={isBusy}
				hasDraft={hasDraft}
			/>
		);
		return avoidToasts ? <div ref={zoneRef}>{handle}</div> : handle;
	}

	return (
		<div
			ref={zoneRef}
			className={`relative border-t ${phone ? 'px-3 pb-3 pt-0' : 'p-4'} ${className ?? ''}`}
			style={{
				borderColor: theme.colors.border,
				backgroundColor: theme.colors.bgSidebar,
				...style,
			}}
		>
			{phone && (
				<PhoneComposerHandle theme={theme} collapsed={false} onToggle={fold.toggle} busy={isBusy} />
			)}

			<QuitWhenIdleIndicator theme={theme} />

			{aboveComposer}

			{overlays}

			{/* The strip draws only once the surface wires every action a tile offers. */}
			{stagedImages &&
				stagedImages.length > 0 &&
				setLightboxImage &&
				openAnnotator &&
				onReorderStagedImages && (
					<StagedImagesStrip
						isVisible
						stagedImages={stagedImages}
						theme={theme}
						setLightboxImage={setLightboxImage}
						setStagedImages={resolvedSetStagedImages}
						openAnnotator={openAnnotator}
						onReorder={onReorderStagedImages}
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
					{textarea}

					<ToolbarControls
						theme={theme}
						capabilities={capabilities}
						isTerminalMode={false}
						enterToSend={enterToSend}
						setEnterToSend={setEnterToSend ?? NOOP_SET_ENTER_TO_SEND}
						setStagedImages={resolvedSetStagedImages}
						imageInputId={imageInputId}
						imageReportComponent={imageReportComponent}
						checkImageFile={checkImageFile}
						onUploadFiles={onUploadFiles}
						voiceSupported={voice?.supported}
						isVoiceListening={voice?.listening}
						onToggleVoiceInput={voice?.onToggle}
						onOpenPromptComposer={onOpenPromptComposer}
						shortcuts={shortcuts}
						showFlashNotification={showFlashNotification}
						toolbarExtras={toolbarExtras}
						sheetExtras={sheetExtras}
						processInput={onSend}
						sendTitle={sendTitle}
						sendDisabled={sendDisabled}
						sendTone={sendTone}
					/>
				</div>

				{!phone && (
					<ComposerSendColumn
						theme={theme}
						className={sendColumnClassName}
						onSend={onSend}
						sendTitle={sendTitle ?? 'Send message'}
						sendDisabled={sendDisabled}
						sendTone={sendTone}
					/>
				)}
			</div>
		</div>
	);
});
