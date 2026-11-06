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
 * It owns no keyboard or text-entry behaviour. The surface brings the textarea,
 * its key and change handlers, its popovers, voice dictation and autosize,
 * because the two surfaces wire those differently: the AI composer's keys,
 * picker categories, slash commands and command mode live in useInputKeyDown
 * and InputContext, while a room uses the simpler wiring in ChatComposer. Its
 * one draft mutation is the strip's reorder, which rewrites Screenshot N
 * through the same permutation so both surfaces agree. What the surface draws
 * arrives through slots, in this order: `aboveComposer`, `overlays`, the staged
 * strip, then inside the box `inputHeader` and `textarea`, then `belowInput`.
 */

import React from 'react';
import { usePhoneLayout } from '../../hooks/ui/useViewportBreakpoint';
import { usePersistedToggle } from '../../hooks/ui/usePersistedToggle';
import { useToastAvoidZone } from '../../hooks/ui/useToastAvoidZone';
import { ComposerSendColumn, type ComposerSendMenu } from './ComposerSendColumn';
import { PhoneComposerHandle } from '../InputArea/components/PhoneComposerHandle';
import {
	ToolbarControls,
	type ToolbarControlsProps,
} from '../InputArea/components/ToolbarControls';
import { QuitWhenIdleIndicator } from '../QuitWhenIdleIndicator';
import { StagedImagesStrip } from '../InputArea/components/StagedImagesStrip';
import {
	buildSlotRemap,
	moveStagedImage,
	renumberScreenshotReferences,
} from '../../utils/stagedImageOrder';
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

/** Toolbar props the frame sets itself; the rest pass through `toolbarProps`. */
type FrameOwnedToolbarProp =
	| 'theme'
	| 'capabilities'
	| 'enterToSend'
	| 'setEnterToSend'
	| 'setStagedImages'
	| 'imageInputId'
	| 'imageReportComponent'
	| 'checkImageFile'
	| 'onUploadFiles'
	| 'voiceSupported'
	| 'isVoiceListening'
	| 'onToggleVoiceInput'
	| 'onOpenPromptComposer'
	| 'shortcuts'
	| 'showFlashNotification'
	| 'toolbarExtras'
	| 'sheetExtras'
	| 'processInput'
	| 'sendTitle'
	| 'sendDisabled'
	| 'sendTone';

export type ChatComposerToolbarProps = Partial<Omit<ToolbarControlsProps, FrameOwnedToolbarProp>>;

export interface ChatComposerFrameProps {
	theme: Theme;
	capabilities: ComposerCapabilities;
	fold: ChatComposerFold;
	/** Busy dot on the phone handle. */
	isBusy?: boolean;
	/** Pencil on the folded phone handle. */
	hasDraft?: boolean;
	warningBorder?: boolean;
	/**
	 * Register the composer as a toast avoid zone. Default true. The AI composer
	 * turns it off: MainPanelContent registers one around all of InputArea,
	 * including the overlays that replace the composer.
	 */
	avoidToasts?: boolean;
	/**
	 * The AI composer's box: the raised gloss (`chrome-raised`), free to shrink
	 * below its content width, in a column that also carries `belowInput`.
	 */
	raised?: boolean;

	// Slots
	aboveComposer?: React.ReactNode;
	overlays?: React.ReactNode;
	/** Inside the box, above the textarea. */
	inputHeader?: React.ReactNode;
	textarea: React.ReactNode;
	/** Under the box, in its column. Drawn only with `raised`. */
	belowInput?: React.ReactNode;
	toolbarExtras?: React.ReactNode;
	sheetExtras?: React.ReactNode;

	// Staged images
	stagedImages?: string[];
	/** False hides the strip without dropping what is staged. Default true. */
	stagedImagesVisible?: boolean;
	setStagedImages?: React.Dispatch<React.SetStateAction<string[]>>;
	/** The draft a reorder must renumber, and the setter that writes it back. */
	draftValue?: string;
	onDraftChange?: (value: string) => void;
	setLightboxImage?: (
		image: string | null,
		contextImages?: string[],
		source?: 'staged' | 'history'
	) => void;
	openAnnotator?: (image: string, onSave: (dataUrl: string) => void) => void;
	checkImageFile?: (file: File) => string | null;
	imageInputId?: string;
	imageReportComponent?: string;
	/** Optional visible warning badge beside the staged images strip. */
	stagedImagesWarning?: string;

	// Toolbar
	enterToSend?: boolean;
	setEnterToSend?: (value: boolean) => void;
	voice?: ChatComposerVoice;
	onUploadFiles?: (files: File[]) => void;
	onOpenPromptComposer?: () => void;
	shortcuts?: Record<string, Shortcut>;
	showFlashNotification?: (message: string) => void;
	/** Surface-specific toolbar values and callbacks (AI: permission, thinking, model, effort). */
	toolbarProps?: ChatComposerToolbarProps;

	// Send. `onSend` must be identity-stable: the toolbar and the column are
	// memoized, and a fresh callback per keystroke re-renders both.
	onSend: () => void;
	/** The phone toolbar's Send title, and the column's unless `columnSendTitle` is set. */
	sendTitle?: string;
	columnSendTitle?: string;
	sendMenu?: ComposerSendMenu;
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
	raised = false,
	aboveComposer,
	overlays,
	inputHeader,
	textarea,
	belowInput,
	toolbarExtras,
	sheetExtras,
	stagedImages,
	stagedImagesVisible = true,
	setStagedImages,
	draftValue,
	onDraftChange,
	setLightboxImage,
	openAnnotator,
	checkImageFile,
	imageInputId,
	imageReportComponent,
	stagedImagesWarning,
	enterToSend = false,
	setEnterToSend,
	voice,
	onUploadFiles,
	onOpenPromptComposer,
	shortcuts,
	showFlashNotification,
	toolbarProps,
	onSend,
	sendTitle,
	columnSendTitle,
	sendMenu,
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

	// The strip lives in the frame, so its reorder does too: move the images and
	// rewrite the draft's Screenshot N references through the same permutation.
	// The surface supplies the draft and its setter, since only it owns the text.
	const handleReorderStagedImages = React.useCallback(
		(from: number, to: number) => {
			const remap = buildSlotRemap(stagedImages?.length ?? 0, from, to);
			if (remap.size === 0) return;
			resolvedSetStagedImages((prev) => moveStagedImage(prev, from, to));
			if (draftValue === undefined || !onDraftChange) return;
			const renumbered = renumberScreenshotReferences(draftValue, remap);
			if (renumbered !== draftValue) onDraftChange(renumbered);
		},
		[stagedImages?.length, resolvedSetStagedImages, draftValue, onDraftChange]
	);

	const box = (
		<div
			className={
				raised
					? 'chrome-raised relative flex min-w-0 flex-1 flex-col rounded-lg border bg-opacity-50'
					: 'flex-1 relative border rounded-lg bg-opacity-50 flex flex-col'
			}
			style={{
				borderColor: warningBorder ? theme.colors.warning : theme.colors.border,
				backgroundColor: warningBorder ? `${theme.colors.warning}15` : theme.colors.bgMain,
			}}
		>
			{inputHeader}

			{textarea}

			<ToolbarControls
				isTerminalMode={false}
				{...toolbarProps}
				theme={theme}
				capabilities={capabilities}
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
	);

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
			{stagedImages && stagedImages.length > 0 && setLightboxImage && openAnnotator && (
				<StagedImagesStrip
					isVisible={stagedImagesVisible}
					stagedImages={stagedImages}
					theme={theme}
					setLightboxImage={setLightboxImage}
					setStagedImages={resolvedSetStagedImages}
					openAnnotator={openAnnotator}
					onReorder={handleReorderStagedImages}
					warning={stagedImagesWarning}
				/>
			)}

			<div className={raised ? 'flex min-w-0 gap-3' : 'flex gap-3'}>
				{raised ? (
					<div className="flex min-w-0 flex-1 flex-col">
						{box}
						{belowInput}
					</div>
				) : (
					box
				)}

				{/* Phone: this column is gone. The notification bell opens a settings
				    popover that has no business on a 390px composer, and Send lives in the
				    toolbar row (ToolbarControls' phone branch), so the composer gets the
				    full width it needs to show what is being typed. */}
				{!phone && (
					<ComposerSendColumn
						theme={theme}
						className={sendColumnClassName}
						onSend={onSend}
						sendTitle={columnSendTitle ?? sendTitle ?? 'Send message'}
						sendDisabled={sendDisabled}
						sendTone={sendTone}
						sendMenu={sendMenu}
					/>
				)}
			</div>
		</div>
	);
});
