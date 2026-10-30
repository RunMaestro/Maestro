import React, { memo, useCallback, useRef, useState, type ReactNode } from 'react';
import {
	ArrowUp,
	Brain,
	Eye,
	History,
	ImageIcon,
	Keyboard,
	Mic,
	MoreHorizontal,
	PenLine,
	Pin,
	Upload,
	X,
} from 'lucide-react';
import type { Shortcut, Theme, ThinkingMode } from '../../../types';
import { formatEnterToSend, formatEnterToSendTooltip } from '../../../utils/shortcutFormatter';
import { getPermissionModeLabel, getPermissionModeTooltip } from '../../../../shared/agentMetadata';
import { useSettingsStore } from '../../../stores/settingsStore';
import { shortcutSuffix } from '../../ui/ShortcutHint';
import { isCoarsePointer } from '../../../utils/touch';
import { useViewportBreakpoint } from '../../../hooks/ui';
import { usePhoneLayout } from '../../../hooks/ui/useViewportBreakpoint';
import { nextPermissionMode } from '../../../utils/tabHelpers';
import { ImageAttachInput, type ComposerCapabilities } from '../../ChatComposer';
import { ComposerOptionsSheet, type PermissionMode } from './ComposerOptionsSheet';
import { ModelEffortPills } from './ModelEffortPills';
import { isWebDesktop } from '../../../utils/runtimeContext';

/**
 * The composer toolbar. It knows nothing about agents, tabs or rooms: which
 * optional controls it offers comes from `capabilities`, the values it shows
 * come in as props, and every change goes back out through a callback, so the
 * AI composer and the Group Chat composer can both render it.
 */
export interface ToolbarControlsProps {
	theme: Theme;
	/** Which optional controls this surface offers (see ComposerCapabilities). */
	capabilities: ComposerCapabilities;
	isTerminalMode: boolean;
	/** The shell's working directory, shown in place of the controls in terminal mode. */
	terminalCwd?: string;
	/** Provider id, so the permission pill reads as the agent's own word for it. */
	agentId?: string;
	onUploadFiles?: (files: File[]) => void;
	/**
	 * Surface-specific controls, drawn in the toggle group just before the
	 * Enter-to-send toggle. Not drawn on a phone; see `sheetExtras`.
	 */
	toolbarExtras?: ReactNode;
	/**
	 * Surface-specific rows for the phone options sheet, built with the
	 * PhoneSheetRows primitives. The phone counterpart of `toolbarExtras`.
	 */
	sheetExtras?: ReactNode;
	/** Element id for the hidden image input, a stable hook for tests. Defaults to the AI composer's. */
	imageInputId?: string;
	/** Names this surface in image read-error reports. Defaults to the AI composer's. */
	imageReportComponent?: string;
	/** Refuses a picked image before it is read (see ImageAttachInput). */
	checkImageFile?: (file: File) => string | null;
	/** Phone Send title and accessible name. Defaults to Send message / Run command. */
	sendTitle?: string;
	/** Phone Send drawn muted and refusing clicks. */
	sendDisabled?: boolean;
	/** Phone Send tint; `warning` marks a send that will queue. */
	sendTone?: 'accent' | 'warning';

	// The per-tab agent settings below are read only when the matching
	// capability is on (permission, thinking, saveToHistory, modelEffort), so a
	// surface that turns those off need not supply them.

	/** Whether `standard` mode is functional for this agent (has a working relay). */
	hasStandardCapability?: boolean;
	/** The permission mode in effect, shown by the pill and the phone sheet. */
	permissionMode?: PermissionMode;
	/** Set a permission mode (the pill steps to the next one; the sheet names one). */
	onPermissionModeChange?: (mode: PermissionMode) => void;
	/** Set a thinking mode by name (the phone sheet). */
	onThinkingModeChange?: (mode: ThinkingMode) => void;
	enterToSend: boolean;
	setEnterToSend: (value: boolean) => void;
	setStagedImages: React.Dispatch<React.SetStateAction<string[]>>;
	/** Whether the browser supports the Web Speech API (from useVoiceInput). */
	voiceSupported?: boolean;
	/** Whether voice dictation is currently listening. */
	isVoiceListening?: boolean;
	/** Toggle voice dictation on/off. Stable identity (see InputArea). */
	onToggleVoiceInput?: () => void;
	onOpenPromptComposer?: () => void;
	shortcuts?: Record<string, Shortcut>;
	showFlashNotification?: (message: string) => void;
	tabSaveToHistory?: boolean;
	onToggleTabSaveToHistory?: () => void;
	tabShowThinking?: ThinkingMode;
	onToggleTabShowThinking?: () => void;
	currentModel?: string;
	currentEffort?: string;
	availableModels?: string[];
	availableEfforts?: string[];
	onModelChange?: (model: string) => void;
	onEffortChange?: (effort: string) => void;
	modelMenuOpen?: boolean;
	setModelMenuOpen?: React.Dispatch<React.SetStateAction<boolean>>;
	modelMenuRef?: React.RefObject<HTMLDivElement>;
	effortMenuOpen?: boolean;
	setEffortMenuOpen?: React.Dispatch<React.SetStateAction<boolean>>;
	effortMenuRef?: React.RefObject<HTMLDivElement>;
	/**
	 * Send the composer's contents. Only used on a phone, where the send button
	 * moves into this row (see the phone branch below); the desktop keeps it in
	 * the column beside the composer.
	 */
	processInput?: () => void;
}

// Stable stand-ins for the per-tab settings a surface without them omits.
const NO_OPTIONS: string[] = [];
const UNUSED_MENU_REF: React.RefObject<HTMLDivElement> = { current: null };
function noop(): void {}

export const ToolbarControls = memo(function ToolbarControls({
	theme,
	capabilities,
	isTerminalMode,
	terminalCwd,
	agentId,
	onUploadFiles,
	hasStandardCapability = false,
	permissionMode: rawPermissionMode = 'full',
	onPermissionModeChange = noop,
	onThinkingModeChange = noop,
	toolbarExtras,
	sheetExtras,
	imageInputId = 'image-file-input',
	imageReportComponent = 'InputArea.ToolbarControls',
	checkImageFile,
	sendTitle,
	sendDisabled = false,
	sendTone = 'accent',
	enterToSend,
	setEnterToSend,
	setStagedImages,
	voiceSupported,
	isVoiceListening,
	onToggleVoiceInput,
	onOpenPromptComposer,
	shortcuts,
	showFlashNotification,
	tabSaveToHistory = false,
	onToggleTabSaveToHistory,
	tabShowThinking = 'off',
	onToggleTabShowThinking,
	currentModel,
	currentEffort,
	availableModels = NO_OPTIONS,
	availableEfforts = NO_OPTIONS,
	onModelChange,
	onEffortChange,
	modelMenuOpen = false,
	setModelMenuOpen = noop,
	modelMenuRef = UNUSED_MENU_REF,
	effortMenuOpen = false,
	setEffortMenuOpen = noop,
	effortMenuRef = UNUSED_MENU_REF,
	processInput,
}: ToolbarControlsProps) {
	const { isNarrow: isNarrowViewport } = useViewportBreakpoint();
	const phone = usePhoneLayout();
	const [toolbarExpanded, setToolbarExpanded] = useState(false);
	const [optionsSheetOpen, setOptionsSheetOpen] = useState(false);
	// On a phone every toggle moves into the options sheet, so the inline group
	// never renders there however the "..." was last left.
	const showToggleGroup = !phone && (!isNarrowViewport || toolbarExpanded);
	const fileUploadControl =
		capabilities.upload && isWebDesktop() && onUploadFiles ? (
			<label
				className="flex items-center justify-center p-1 rounded hover:bg-white/10 cursor-pointer"
				title="Upload local files to the host"
				aria-label="Upload local files to the host"
			>
				<Upload className="w-5 h-5" />
				<input
					type="file"
					multiple
					className="hidden"
					aria-label="Choose local files to upload to the host"
					onChange={(event) => {
						const files = Array.from(event.target.files ?? []);
						event.target.value = '';
						if (files.length > 0) onUploadFiles(files);
					}}
				/>
			</label>
		) : null;

	// Voice dictation is a primary touch affordance, so it stays in the always-
	// visible left action group (next to attach-image) rather than the collapsing
	// toggle group - burying it behind the "..." overflow on the exact phones it
	// targets would defeat the point. Shown only when the Web Speech API is
	// supported AND the primary pointer is coarse (touch), so mouse/keyboard
	// desktop users never see it.
	const showVoiceButton =
		capabilities.voice && !!voiceSupported && !!onToggleVoiceInput && isCoarsePointer();

	// Hide `standard` for agents without a working relay: if a stale tab is
	// somehow in `standard`, display it as `full` so we never surface a
	// non-functional mode.
	const currentPermissionMode: 'full' | 'standard' | 'readonly' =
		rawPermissionMode === 'standard' && !hasStandardCapability ? 'full' : rawPermissionMode;

	// Advertise the full-screen model/effort switcher from inside the dropdowns
	// the user already opened, which is where they are thinking about the
	// setting. Read from the shortcut map rather than hardcoding the chord: the
	// binding is rebindable, its display differs per platform, and on a build
	// that has no such shortcut this resolves to undefined so no hint renders
	// instead of pointing at a key combo that does nothing.
	// Handed to ModelEffortPills as raw keys rather than a formatted string:
	// a shortcut the user has cleared is present in the map with an EMPTY key
	// list, not absent from it - the store rebuilds the map from the bundled
	// defaults on every load, so the entry always exists here. ShortcutHint and
	// shortcutSuffix both render nothing for an empty list, which is what keeps
	// a cleared binding from drawing a bare "Try: ".
	const modelEffortKeys = shortcuts?.openModelEffort?.keys;

	// The three tab-scoped toggles below are all bindable chords. Read them live
	// from the tab shortcut map rather than spelling the default combo into the
	// tooltip: a user who rebinds one should see their own chord, not ours.
	const tabShortcuts = useSettingsStore((s) => s.tabShortcuts);

	// One hidden file input, rendered by whichever row (phone or desktop) is on
	// screen. The attach buttons reach it through this ref rather than an element
	// id, so the input stays unique however many buttons point at it.
	const imageInputRef = useRef<HTMLInputElement>(null);
	const openImagePicker = useCallback(() => imageInputRef.current?.click(), []);
	const imageFileInput = (
		<ImageAttachInput
			ref={imageInputRef}
			id={imageInputId}
			setStagedImages={setStagedImages}
			showFlashNotification={showFlashNotification}
			reportComponent={imageReportComponent}
			checkFile={checkImageFile}
		/>
	);

	// The phone sheet mounts only when it has something to show: a section, judged
	// by the same flags its sections read, or the surface's own rows.
	const sheetHasContent =
		capabilities.saveToHistory ||
		capabilities.permission ||
		capabilities.thinking ||
		capabilities.modelEffort ||
		!!sheetExtras;
	// The "..." is drawn only when it opens something. Terminal mode keeps the
	// button it has always drawn even though no sheet is behind it there: a
	// known gap, left as it is until it is fixed on its own.
	const showOptionsButton = sheetHasContent || isTerminalMode;
	const phoneSendTitle = sendTitle ?? (isTerminalMode ? 'Run command' : 'Send message');

	// Phone: the row holds only what a thumb reaches for mid-sentence - attach an
	// image, send, and the "..." that opens every other setting as a half-screen
	// sheet. The prompt composer and the notification bell are dropped outright
	// (both open surfaces of their own, neither belongs on a 390px composer),
	// the model and effort pills move into the sheet, and the send button moves
	// here from the column beside the composer so the three controls sit on one
	// reachable line.
	if (phone) {
		return (
			<>
				<div className="flex min-w-0 items-center gap-1 px-2 pb-2 pt-1">
					{isTerminalMode && (
						<div
							className="text-xs font-mono opacity-60 px-2 truncate min-w-0 flex-1"
							style={{ color: theme.colors.textDim }}
						>
							{terminalCwd}
						</div>
					)}
					{capabilities.imageAttach && (
						<button
							onClick={openImagePicker}
							className="flex h-9 w-9 items-center justify-center rounded opacity-70"
							title={isWebDesktop() ? 'Upload Image to Host' : 'Attach Image'}
							aria-label={isWebDesktop() ? 'Upload Image to Host' : 'Attach Image'}
						>
							<ImageIcon className="w-5 h-5" />
						</button>
					)}
					{fileUploadControl}
					{showVoiceButton && (
						<button
							type="button"
							onClick={onToggleVoiceInput}
							className={`flex h-9 w-9 items-center justify-center rounded transition-colors ${
								isVoiceListening ? 'animate-pulse' : 'opacity-70'
							}`}
							style={
								isVoiceListening
									? { color: theme.colors.accent, backgroundColor: `${theme.colors.accent}20` }
									: undefined
							}
							title={isVoiceListening ? 'Stop voice input' : 'Voice input'}
							aria-label={isVoiceListening ? 'Stop voice input' : 'Start voice input'}
							aria-pressed={!!isVoiceListening}
						>
							<Mic className="w-5 h-5" />
						</button>
					)}
					{imageFileInput}
					{/* Send sits in the MIDDLE, between the left actions and the "...", so
					    it is the one control at the centre of the thumb's arc. */}
					{processInput && (
						<button
							type="button"
							onClick={() => processInput()}
							disabled={sendDisabled}
							className="mx-auto flex h-9 w-14 items-center justify-center rounded-lg shadow-sm transition-all"
							style={{
								backgroundColor: sendDisabled
									? theme.colors.border
									: sendTone === 'warning'
										? theme.colors.warning
										: theme.colors.accent,
								color: sendDisabled ? theme.colors.textDim : theme.colors.accentForeground,
							}}
							title={phoneSendTitle}
							aria-label={phoneSendTitle}
						>
							<ArrowUp className="w-5 h-5" />
						</button>
					)}
					{showOptionsButton && (
						<button
							type="button"
							onClick={() => setOptionsSheetOpen(true)}
							className="flex h-9 w-9 items-center justify-center rounded-full transition-all opacity-70"
							style={{ color: theme.colors.textDim, border: `1px solid ${theme.colors.border}` }}
							title="More options"
							aria-label="More options"
							aria-haspopup="dialog"
							aria-expanded={optionsSheetOpen}
							data-testid="composer-options-button"
						>
							<MoreHorizontal className="w-5 h-5" />
						</button>
					)}
				</div>
				{sheetHasContent && (
					<ComposerOptionsSheet
						open={optionsSheetOpen}
						onClose={() => setOptionsSheetOpen(false)}
						theme={theme}
						agentId={agentId}
						tabSaveToHistory={tabSaveToHistory}
						onToggleTabSaveToHistory={
							capabilities.saveToHistory ? onToggleTabSaveToHistory : undefined
						}
						hasReadOnlyCapability={capabilities.permission}
						hasStandardCapability={hasStandardCapability}
						permissionMode={currentPermissionMode}
						onPermissionModeChange={onPermissionModeChange}
						supportsThinking={capabilities.thinking}
						tabShowThinking={tabShowThinking}
						onThinkingModeChange={onToggleTabShowThinking ? onThinkingModeChange : undefined}
						currentModel={currentModel}
						availableModels={availableModels}
						onModelChange={capabilities.modelEffort ? onModelChange : undefined}
						currentEffort={currentEffort}
						availableEfforts={availableEfforts}
						onEffortChange={capabilities.modelEffort ? onEffortChange : undefined}
						extraRows={sheetExtras}
					/>
				)}
			</>
		);
	}

	return (
		<div className="flex min-w-0 flex-wrap items-center gap-1 px-2 pb-2 pt-1">
			<div className="flex min-w-0 flex-1 gap-1 items-center">
				{isTerminalMode && (
					<div
						className="text-xs font-mono opacity-60 px-2 truncate"
						style={{ color: theme.colors.textDim }}
					>
						{terminalCwd}
					</div>
				)}
				{onOpenPromptComposer && (
					<button
						onClick={onOpenPromptComposer}
						className="p-1 hover:bg-white/10 rounded opacity-50 hover:opacity-100"
						title={`Open Prompt Composer${shortcutSuffix(shortcuts?.openPromptComposer?.keys)}`}
					>
						<PenLine className="w-4 h-4" />
					</button>
				)}
				{capabilities.imageAttach && (
					<button
						onClick={openImagePicker}
						className="p-1 hover:bg-white/10 rounded opacity-50 hover:opacity-100"
						title={isWebDesktop() ? 'Upload Image to Host' : 'Attach Image'}
					>
						<ImageIcon className="w-4 h-4" />
					</button>
				)}
				{fileUploadControl}
				{showVoiceButton && (
					<button
						type="button"
						onClick={onToggleVoiceInput}
						className={`p-1 rounded transition-colors ${
							isVoiceListening ? 'animate-pulse' : 'hover:bg-white/10 opacity-50 hover:opacity-100'
						}`}
						style={
							isVoiceListening
								? { color: theme.colors.accent, backgroundColor: `${theme.colors.accent}20` }
								: undefined
						}
						title={isVoiceListening ? 'Stop voice input' : 'Voice input'}
						aria-label={isVoiceListening ? 'Stop voice input' : 'Start voice input'}
						aria-pressed={!!isVoiceListening}
					>
						<Mic className="w-4 h-4" />
					</button>
				)}
				{imageFileInput}
				<ModelEffortPills
					isVisible={capabilities.modelEffort}
					theme={theme}
					shortcutKeys={modelEffortKeys}
					currentModel={currentModel}
					currentEffort={currentEffort}
					availableModels={availableModels}
					availableEfforts={availableEfforts}
					onModelChange={onModelChange}
					onEffortChange={onEffortChange}
					modelMenuOpen={modelMenuOpen}
					setModelMenuOpen={setModelMenuOpen}
					modelMenuRef={modelMenuRef}
					effortMenuOpen={effortMenuOpen}
					setEffortMenuOpen={setEffortMenuOpen}
					effortMenuRef={effortMenuRef}
				/>
			</div>

			{isNarrowViewport && (
				<button
					type="button"
					onClick={() => setToolbarExpanded((v) => !v)}
					className="ml-auto flex h-7 w-7 items-center justify-center rounded-full transition-all opacity-60 hover:opacity-100"
					style={{
						color: theme.colors.textDim,
						border: `1px solid ${theme.colors.border}`,
					}}
					title={toolbarExpanded ? 'Hide options' : 'Show options'}
					aria-label={toolbarExpanded ? 'Hide toolbar options' : 'Show toolbar options'}
				>
					{toolbarExpanded ? (
						<X className="w-3.5 h-3.5" />
					) : (
						<MoreHorizontal className="w-3.5 h-3.5" />
					)}
				</button>
			)}

			<div
				className={`flex items-center gap-2 ${isNarrowViewport ? '' : 'ml-auto'} ${showToggleGroup ? '' : 'hidden'}`}
				data-tour="toolbar-toggles"
			>
				{capabilities.saveToHistory && onToggleTabSaveToHistory && (
					<button
						onClick={onToggleTabSaveToHistory}
						className={`flex items-center gap-1.5 text-2xs px-2 py-1 rounded-full cursor-pointer transition-all whitespace-nowrap ${
							tabSaveToHistory ? '' : 'opacity-40 hover:opacity-70'
						}`}
						style={{
							backgroundColor: tabSaveToHistory ? `${theme.colors.accent}25` : 'transparent',
							color: tabSaveToHistory ? theme.colors.accent : theme.colors.textDim,
							border: tabSaveToHistory
								? `1px solid ${theme.colors.accent}50`
								: '1px solid transparent',
						}}
						title={`Save to History${shortcutSuffix(tabShortcuts.toggleSaveToHistory?.keys)} - Synopsis added after each completion`}
					>
						<History className="w-3 h-3" />
						<span>History</span>
					</button>
				)}
				{capabilities.permission && (
					<button
						onClick={() =>
							onPermissionModeChange(
								nextPermissionMode(currentPermissionMode, hasStandardCapability)
							)
						}
						className={`flex items-center gap-1.5 text-2xs px-2 py-1 rounded-full cursor-pointer transition-all whitespace-nowrap ${
							currentPermissionMode === 'standard' ? 'opacity-40 hover:opacity-70' : ''
						}`}
						style={{
							backgroundColor:
								currentPermissionMode === 'readonly'
									? `${theme.colors.warning}25`
									: currentPermissionMode === 'full'
										? `${theme.colors.accent}25`
										: 'transparent',
							color:
								currentPermissionMode === 'readonly'
									? theme.colors.warning
									: currentPermissionMode === 'full'
										? theme.colors.accent
										: theme.colors.textDim,
							border:
								currentPermissionMode === 'readonly'
									? `1px solid ${theme.colors.warning}50`
									: currentPermissionMode === 'full'
										? `1px solid ${theme.colors.accent}50`
										: '1px solid transparent',
						}}
						title={`${getPermissionModeTooltip(
							currentPermissionMode,
							agentId
						)}${shortcutSuffix(tabShortcuts.toggleReadOnlyMode?.keys)}`}
					>
						<Eye className="w-3 h-3" />
						<span>{getPermissionModeLabel(currentPermissionMode, agentId)}</span>
					</button>
				)}
				{capabilities.thinking && onToggleTabShowThinking && (
					<button
						onClick={onToggleTabShowThinking}
						className={`flex items-center gap-1.5 text-2xs px-2 py-1 rounded-full cursor-pointer transition-all whitespace-nowrap ${
							tabShowThinking !== 'off' ? '' : 'opacity-40 hover:opacity-70'
						}`}
						style={{
							backgroundColor:
								tabShowThinking === 'sticky'
									? `${theme.colors.warning}30`
									: tabShowThinking === 'on'
										? `${theme.colors.accentText}25`
										: 'transparent',
							color:
								tabShowThinking === 'sticky'
									? theme.colors.warning
									: tabShowThinking === 'on'
										? theme.colors.accentText
										: theme.colors.textDim,
							border:
								tabShowThinking === 'sticky'
									? `1px solid ${theme.colors.warning}50`
									: tabShowThinking === 'on'
										? `1px solid ${theme.colors.accentText}50`
										: '1px solid transparent',
						}}
						title={`${
							tabShowThinking === 'off'
								? 'Show Thinking - Click to stream AI reasoning'
								: tabShowThinking === 'on'
									? 'Thinking (temporary) - Click for sticky mode'
									: 'Thinking (sticky) - Click to turn off'
						}${shortcutSuffix(tabShortcuts.toggleShowThinking?.keys)}`}
					>
						<Brain className="w-3 h-3" />
						<span>Thinking</span>
						{tabShowThinking === 'sticky' && <Pin className="w-2.5 h-2.5" />}
					</button>
				)}
				{toolbarExtras}
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
	);
});
