import React, { memo, useState } from 'react';
import {
	Brain,
	Eye,
	History,
	ImageIcon,
	Keyboard,
	Mic,
	MoreHorizontal,
	PenLine,
	Pin,
	X,
} from 'lucide-react';
import type { Shortcut, Session, Theme, ThinkingMode } from '../../../types';
import {
	formatEnterToSend,
	formatEnterToSendTooltip,
	formatShortcutKeys,
} from '../../../utils/shortcutFormatter';
import { getReadOnlyModeLabel, getReadOnlyModeTooltip } from '../../../../shared/agentMetadata';
import { captureException } from '../../../utils/sentry';
import { isCoarsePointer } from '../../../utils/touch';
import { useViewportBreakpoint } from '../../../hooks/ui';
import { addStagedImageIfUnique } from '../utils/stagedImages';
import { formatTerminalCwd } from '../utils/terminalPath';
import { ModelEffortPills } from './ModelEffortPills';

interface ToolbarControlsProps {
	session: Session;
	theme: Theme;
	isTerminalMode: boolean;
	isReadOnlyMode: boolean;
	canAttachImages: boolean;
	hasReadOnlyCapability: boolean;
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
	tabSaveToHistory: boolean;
	onToggleTabSaveToHistory?: () => void;
	onToggleTabReadOnlyMode?: () => void;
	tabShowThinking: ThinkingMode;
	onToggleTabShowThinking?: () => void;
	supportsThinking: boolean;
	currentModel?: string;
	currentEffort?: string;
	availableModels: string[];
	availableEfforts: string[];
	onModelChange?: (model: string) => void;
	onEffortChange?: (effort: string) => void;
	modelMenuOpen: boolean;
	setModelMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
	modelMenuRef: React.RefObject<HTMLDivElement>;
	effortMenuOpen: boolean;
	setEffortMenuOpen: React.Dispatch<React.SetStateAction<boolean>>;
	effortMenuRef: React.RefObject<HTMLDivElement>;
}

export const ToolbarControls = memo(function ToolbarControls({
	session,
	theme,
	isTerminalMode,
	isReadOnlyMode,
	canAttachImages,
	hasReadOnlyCapability,
	enterToSend,
	setEnterToSend,
	setStagedImages,
	voiceSupported,
	isVoiceListening,
	onToggleVoiceInput,
	onOpenPromptComposer,
	shortcuts,
	showFlashNotification,
	tabSaveToHistory,
	onToggleTabSaveToHistory,
	onToggleTabReadOnlyMode,
	tabShowThinking,
	onToggleTabShowThinking,
	supportsThinking,
	currentModel,
	currentEffort,
	availableModels,
	availableEfforts,
	onModelChange,
	onEffortChange,
	modelMenuOpen,
	setModelMenuOpen,
	modelMenuRef,
	effortMenuOpen,
	setEffortMenuOpen,
	effortMenuRef,
}: ToolbarControlsProps) {
	const isAiMode = session.inputMode === 'ai';
	const { isNarrow: isNarrowViewport } = useViewportBreakpoint();
	const [toolbarExpanded, setToolbarExpanded] = useState(false);
	const showToggleGroup = !isNarrowViewport || toolbarExpanded;

	// Voice dictation is a primary touch affordance, so it stays in the always-
	// visible left action group (next to attach-image) rather than the collapsing
	// toggle group - burying it behind the "..." overflow on the exact phones it
	// targets would defeat the point. Shown only when the Web Speech API is
	// supported AND the primary pointer is coarse (touch), so mouse/keyboard
	// desktop users never see it.
	const showVoiceButton = isAiMode && !!voiceSupported && !!onToggleVoiceInput && isCoarsePointer();

	return (
		<div className="flex min-w-0 flex-wrap items-center gap-1 px-2 pb-2 pt-1">
			<div className="flex min-w-0 flex-1 gap-1 items-center">
				{isTerminalMode && (
					<div
						className="text-xs font-mono opacity-60 px-2 truncate"
						style={{ color: theme.colors.textDim }}
					>
						{formatTerminalCwd(session)}
					</div>
				)}
				{isAiMode && onOpenPromptComposer && (
					<button
						onClick={onOpenPromptComposer}
						className="p-1 hover:bg-white/10 rounded opacity-50 hover:opacity-100"
						title={`Open Prompt Composer${shortcuts?.openPromptComposer ? ` (${formatShortcutKeys(shortcuts.openPromptComposer.keys)})` : ''}`}
					>
						<PenLine className="w-4 h-4" />
					</button>
				)}
				{isAiMode && canAttachImages && (
					<button
						onClick={() => document.getElementById('image-file-input')?.click()}
						className="p-1 hover:bg-white/10 rounded opacity-50 hover:opacity-100"
						title="Attach Image"
					>
						<ImageIcon className="w-4 h-4" />
					</button>
				)}
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
						aria-pressed={isVoiceListening}
					>
						<Mic className="w-4 h-4" />
					</button>
				)}
				<input
					id="image-file-input"
					type="file"
					accept="image/*"
					multiple
					className="hidden"
					onChange={(e) => {
						const files = Array.from(e.target.files || []);
						files.forEach((file) => {
							const reader = new FileReader();
							reader.onload = (event) => {
								if (event.target?.result) {
									const imageData = event.target.result as string;
									setStagedImages((prev) =>
										addStagedImageIfUnique(prev, imageData, showFlashNotification)
									);
								}
							};
							reader.onerror = (event) => {
								captureException(reader.error ?? event, {
									extra: {
										component: 'InputArea.ToolbarControls',
										action: 'attachImage.readError',
										fileName: file.name,
										fileType: file.type,
										fileSize: file.size,
									},
								});
								showFlashNotification?.('Failed to attach image');
							};
							reader.onabort = (event) => {
								captureException(new Error('Image attachment read aborted'), {
									extra: {
										component: 'InputArea.ToolbarControls',
										action: 'attachImage.readAbort',
										fileName: file.name,
										fileType: file.type,
										fileSize: file.size,
										eventType: event.type,
									},
								});
								showFlashNotification?.('Image attachment canceled');
							};
							reader.readAsDataURL(file);
						});
						e.target.value = '';
					}}
				/>
				<ModelEffortPills
					isVisible={isAiMode}
					theme={theme}
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
				{isAiMode && onToggleTabSaveToHistory && (
					<button
						onClick={onToggleTabSaveToHistory}
						className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full cursor-pointer transition-all whitespace-nowrap ${
							tabSaveToHistory ? '' : 'opacity-40 hover:opacity-70'
						}`}
						style={{
							backgroundColor: tabSaveToHistory ? `${theme.colors.accent}25` : 'transparent',
							color: tabSaveToHistory ? theme.colors.accent : theme.colors.textDim,
							border: tabSaveToHistory
								? `1px solid ${theme.colors.accent}50`
								: '1px solid transparent',
						}}
						title={`Save to History (${formatShortcutKeys(['Meta', 's'])}) - Synopsis added after each completion`}
					>
						<History className="w-3 h-3" />
						<span>History</span>
					</button>
				)}
				{isAiMode && onToggleTabReadOnlyMode && hasReadOnlyCapability && (
					<button
						onClick={onToggleTabReadOnlyMode}
						className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full cursor-pointer transition-all whitespace-nowrap ${
							isReadOnlyMode ? '' : 'opacity-40 hover:opacity-70'
						}`}
						style={{
							backgroundColor: isReadOnlyMode ? `${theme.colors.warning}25` : 'transparent',
							color: isReadOnlyMode ? theme.colors.warning : theme.colors.textDim,
							border: isReadOnlyMode
								? `1px solid ${theme.colors.warning}50`
								: '1px solid transparent',
						}}
						title={getReadOnlyModeTooltip(session.toolType)}
					>
						<Eye className="w-3 h-3" />
						<span>{getReadOnlyModeLabel(session.toolType)}</span>
					</button>
				)}
				{isAiMode && supportsThinking && onToggleTabShowThinking && (
					<button
						onClick={onToggleTabShowThinking}
						className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-full cursor-pointer transition-all whitespace-nowrap ${
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
						title={
							tabShowThinking === 'off'
								? 'Show Thinking - Click to stream AI reasoning'
								: tabShowThinking === 'on'
									? 'Thinking (temporary) - Click for sticky mode'
									: 'Thinking (sticky) - Click to turn off'
						}
					>
						<Brain className="w-3 h-3" />
						<span>Thinking</span>
						{tabShowThinking === 'sticky' && <Pin className="w-2.5 h-2.5" />}
					</button>
				)}
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
	);
});
