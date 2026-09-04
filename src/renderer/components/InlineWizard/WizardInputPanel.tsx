/**
 * WizardInputPanel.tsx
 *
 * Modified input panel for wizard mode. Replaces the standard InputArea
 * when session.wizardState?.isActive is true.
 *
 * Layout:
 * - Wizard pill on left
 * - Confidence gauge in center-right area
 * - Image attachment button (if agent supports it)
 * - Prompt composer button
 * - Terminal/AI mode toggle (disabled during generation)
 *
 * Hidden during wizard mode:
 * - Read-only toggle
 * - History toggle
 * - Thinking toggle
 *
 * Keyboard shortcuts:
 * - Escape (mid-turn): Stops the running turn, staying in the wizard
 * - Escape (idle): Opens exit confirmation dialog
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
	Terminal,
	Wand2,
	ImageIcon,
	ArrowUp,
	PenLine,
	X,
	Keyboard,
	Brain,
	Square,
} from 'lucide-react';
import type { Session, Theme } from '../../types';
import { WizardPill } from './WizardPill';
import { WizardConfidenceGauge } from './WizardConfidenceGauge';
import { WizardExitConfirmDialog } from './WizardExitConfirmDialog';
import {
	formatShortcutKeys,
	formatEnterToSend,
	formatEnterToSendTooltip,
} from '../../utils/shortcutFormatter';
import { useSessionStore } from '../../stores/sessionStore';
import { closeTab } from '../../utils/tabHelpers';
import { useAutosizeTextarea } from '../../hooks/ui/useAutosizeTextarea';

/** Height cap for the wizard composer; past it the textarea scrolls. */
const WIZARD_TEXTAREA_MAX_HEIGHT = 112;

interface WizardInputPanelProps {
	/** Current session with wizard state */
	session: Session;
	/** Theme for styling */
	theme: Theme;
	/** Current input value */
	inputValue: string;
	/** Set input value */
	setInputValue: (value: string) => void;
	/** Reference to the input textarea */
	inputRef: React.RefObject<HTMLTextAreaElement>;
	/** Handle key down events in the input */
	handleInputKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
	/** Handle paste events in the input */
	handlePaste: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
	/** Process/send the current input */
	processInput: () => void;
	/** Staged images for attachment */
	stagedImages: string[];
	/** Set staged images */
	setStagedImages: React.Dispatch<React.SetStateAction<string[]>>;
	/** Open the prompt composer modal */
	onOpenPromptComposer?: () => void;
	/** Toggle between AI and terminal mode */
	toggleInputMode: () => void;
	/** Current confidence level from wizard state (0-100) */
	confidence: number;
	/** Whether the agent can attach images */
	canAttachImages: boolean;
	/** Whether the session is busy (disable mode toggle during generation) */
	isBusy: boolean;
	/** Whether the wizard is performing first-load initialization */
	isInitializing?: boolean;
	/** Handler for exiting wizard mode */
	onExitWizard: () => void;
	/** Stop the turn currently running on this tab, without leaving the wizard */
	onStopTurn?: (tabId?: string) => void;
	/** Enter to send setting */
	enterToSend: boolean;
	/** Set enter to send setting */
	setEnterToSend: (value: boolean) => void;
	/** Callback when input receives focus */
	onInputFocus?: () => void;
	/** Callback when input loses focus */
	onInputBlur?: () => void;
	/** Show flash notification */
	showFlashNotification?: (message: string) => void;
	/** Set lightbox image */
	setLightboxImage?: (
		image: string | null,
		contextImages?: string[],
		source?: 'staged' | 'history'
	) => void;
	/** Whether to show thinking content instead of filler phrases */
	showThinking?: boolean;
	/** Toggle show thinking mode */
	onToggleShowThinking?: () => void;
}

/**
 * WizardInputPanel - Modified input panel for wizard mode
 *
 * Features:
 * - Prominent Wizard pill on the left
 * - Confidence gauge showing AI's confidence level
 * - Image attachment support (if agent supports it)
 * - Prompt composer button
 * - Mode toggle (disabled during generation)
 * - Hidden: read-only, history, thinking toggles
 */
export const WizardInputPanel = React.memo(function WizardInputPanel({
	session,
	theme,
	inputValue,
	setInputValue,
	inputRef,
	handleInputKeyDown,
	handlePaste,
	processInput,
	stagedImages,
	setStagedImages,
	onOpenPromptComposer,
	toggleInputMode,
	confidence,
	canAttachImages,
	isBusy,
	isInitializing = false,
	onExitWizard,
	onStopTurn,
	enterToSend,
	setEnterToSend,
	onInputFocus,
	onInputBlur,
	showFlashNotification,
	setLightboxImage,
	showThinking = false,
	onToggleShowThinking,
}: WizardInputPanelProps) {
	// State for exit confirmation dialog
	const [showExitConfirm, setShowExitConfirm] = useState(false);

	// Auto-resize the textarea to fit its content, keeping the caret visible once
	// the composer is tall enough to scroll.
	useAutosizeTextarea({
		textareaRef: inputRef,
		value: inputValue,
		maxHeight: WIZARD_TEXTAREA_MAX_HEIGHT,
	});

	// Auto-focus input on mount (this component only renders when wizard is active)
	useEffect(() => {
		// Use requestAnimationFrame to ensure the DOM is painted before focusing
		const rafId = requestAnimationFrame(() => {
			inputRef.current?.focus();
		});
		return () => cancelAnimationFrame(rafId);
	}, [inputRef]);

	const handleStopTurn = useCallback(() => {
		onStopTurn?.(session.activeTabId);
		inputRef.current?.focus();
	}, [onStopTurn, session.activeTabId, inputRef]);

	// Escape is a LADDER, and no rung of it destroys anything without a confirmation:
	//   1. mid-turn  -> stop the running turn, stay in the wizard
	//   2. otherwise -> open the exit confirmation
	//   3. dialog open -> the dialog's own Escape cancels it
	// Leaving the wizard is only ever reachable through the dialog's red button (or
	// Enter, which it focuses). There is deliberately NO condition under which Escape
	// exits directly: the old "no interaction yet, just close the tab" shortcut read
	// the conversation to decide, so two Escapes during the very first turn - when
	// history still looks empty - silently threw the whole wizard away.
	const handleEscapeKey = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (e.key === 'Escape') {
				e.preventDefault();
				e.stopPropagation();
				if (isBusy && onStopTurn) {
					handleStopTurn();
					return;
				}
				setShowExitConfirm(true);
				return;
			}
			// Block Enter (any modifier combo) from triggering send while the wizard is
			// busy - otherwise the message gets eaten by processInput's clear and the
			// user's draft is lost. Shift+Enter is allowed so newlines still work.
			if (isBusy && e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				return;
			}
			// Forward other key events to the parent handler
			handleInputKeyDown(e);
		},
		[handleInputKeyDown, isBusy, onStopTurn, handleStopTurn]
	);

	// Handle exit confirmation. Reached ONLY from the dialog, never straight off a keypress.
	const handleConfirmExit = useCallback(() => {
		setShowExitConfirm(false);
		// A wizard that got its own fresh tab is disposable, so close the tab outright.
		// `/wizard` also runs IN PLACE though, and then the tab may hold a real
		// conversation that has nothing to do with the wizard - exit wizard mode and
		// hand that tab back instead. System logs don't count as a conversation: the
		// wizard writes its own "Starting wizard..." line.
		const { setSessions } = useSessionStore.getState();
		const activeTabId = session.activeTabId;
		const hostTab = session.aiTabs.find((t) => t.id === activeTabId);
		const hostTabHasConversation = (hostTab?.logs ?? []).some((log) => log.source !== 'system');
		if (activeTabId && session.aiTabs.length > 1 && !hostTabHasConversation) {
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id !== session.id) return s;
					const result = closeTab(s, activeTabId, false, { skipHistory: true });
					return result ? result.session : s;
				})
			);
			return;
		}
		onExitWizard();
	}, [onExitWizard, session]);

	// Handle cancel exit
	const handleCancelExit = useCallback(() => {
		setShowExitConfirm(false);
		// Re-focus the input after closing dialog
		inputRef.current?.focus();
	}, [inputRef]);

	const isTerminalMode = session.inputMode === 'terminal';

	return (
		<div
			className="relative p-4 border-t"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
		>
			{/* Staged images display */}
			{!isTerminalMode && stagedImages.length > 0 && (
				<div className="flex gap-2 mb-3 pb-2 overflow-x-auto overflow-y-visible scrollbar-thin">
					{stagedImages.map((img, idx) => (
						<div key={img} className="relative group shrink-0">
							<button
								type="button"
								className="p-0 bg-transparent outline-none focus-visible:ring-2 focus-visible:ring-accent rounded"
								onClick={() => setLightboxImage?.(img, stagedImages, 'staged')}
							>
								<img
									src={img}
									alt={`Staged wizard image ${idx + 1}`}
									className="h-16 rounded border cursor-pointer hover:opacity-80 transition-opacity block"
									style={{
										borderColor: theme.colors.border,
										objectFit: 'contain',
										maxWidth: '200px',
									}}
								/>
							</button>
							<button
								onClick={(e) => {
									e.stopPropagation();
									setStagedImages((p) => p.filter((x) => x !== img));
								}}
								className="absolute top-0.5 right-0.5 bg-red-500 text-white rounded-full p-1 shadow-md hover:bg-red-600 transition-colors opacity-90 hover:opacity-100"
							>
								<X className="w-3 h-3" />
							</button>
						</div>
					))}
				</div>
			)}

			<div className="flex gap-3">
				<div className="flex-1 flex flex-col">
					<div
						className="flex-1 relative border rounded-lg bg-opacity-50 flex flex-col"
						style={{
							borderColor: theme.colors.accent,
							backgroundColor: `${theme.colors.accent}10`,
						}}
					>
						{/* Wizard indicator row */}
						<div
							className="flex items-center justify-between px-3 py-2 border-b"
							style={{ borderColor: `${theme.colors.accent}30` }}
						>
							<WizardPill
								theme={theme}
								onClick={() => setShowExitConfirm(true)}
								isThinking={isBusy}
								isInitializing={isInitializing}
							/>
							<WizardConfidenceGauge confidence={confidence} theme={theme} />
						</div>

						<div className="flex items-start">
							<textarea
								ref={inputRef}
								className="flex-1 bg-transparent text-sm outline-none px-3 pt-3 pr-3 resize-none min-h-[2.5rem] scrollbar-thin"
								style={{
									color: theme.colors.textMain,
									maxHeight: `${WIZARD_TEXTAREA_MAX_HEIGHT}px`,
								}}
								placeholder="Tell the wizard about your project..."
								value={inputValue}
								onFocus={onInputFocus}
								onBlur={onInputBlur}
								onChange={(e) => {
									// Auto-grow is owned by useAutosizeTextarea above: it runs on the
									// committed value, so dictation and other programmatic edits resize
									// too, and it keeps the caret in view instead of scrolling back to
									// the top on every keystroke.
									setInputValue(e.target.value);
								}}
								onKeyDown={handleEscapeKey}
								onPaste={handlePaste}
								rows={1}
							/>
						</div>

						<div className="flex justify-between items-center px-2 pb-2 pt-1">
							<div className="flex gap-1 items-center">
								{/* Prompt composer button */}
								{!isTerminalMode && onOpenPromptComposer && (
									<button
										onClick={onOpenPromptComposer}
										className="p-1 hover:bg-white/10 rounded opacity-50 hover:opacity-100"
										title="Open Prompt Composer"
									>
										<PenLine className="w-4 h-4" />
									</button>
								)}
								{/* Image attachment button */}
								{!isTerminalMode && canAttachImages && (
									<button
										onClick={() => document.getElementById('wizard-image-file-input')?.click()}
										className="p-1 hover:bg-white/10 rounded opacity-50 hover:opacity-100"
										title="Attach Image"
									>
										<ImageIcon className="w-4 h-4" />
									</button>
								)}
								<input
									id="wizard-image-file-input"
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
									}}
								/>
							</div>

							<div className="flex items-center gap-2">
								{/* Show Thinking toggle - when on, shows raw AI thinking instead of filler phrases */}
								{!isTerminalMode && onToggleShowThinking && (
									<button
										onClick={onToggleShowThinking}
										className={`flex items-center gap-1 text-2xs px-2 py-1 rounded hover:bg-white/5 transition-opacity ${
											showThinking ? 'opacity-100' : 'opacity-50 hover:opacity-100'
										}`}
										title={
											showThinking ? 'Hide AI thinking (show filler messages)' : 'Show AI thinking'
										}
										style={showThinking ? { color: theme.colors.accent } : undefined}
									>
										<Brain className="w-3 h-3" />
										<span>{showThinking ? 'Thinking' : 'Thinking'}</span>
									</button>
								)}
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
				</div>

				{/* Mode Toggle & Send Button - Right Side */}
				<div className="flex flex-col gap-2">
					<button
						type="button"
						onClick={toggleInputMode}
						disabled={isBusy}
						className="p-2 rounded-lg border transition-all disabled:opacity-50 disabled:cursor-not-allowed"
						style={{
							backgroundColor: theme.colors.bgMain,
							borderColor: theme.colors.border,
							color: theme.colors.textDim,
						}}
						title={
							isBusy
								? 'Cannot switch mode while wizard is processing'
								: `Toggle Mode (${formatShortcutKeys(['Meta', 'j'])})`
						}
					>
						{/* Show Wand2 icon in wizard mode instead of Terminal/Cpu */}
						{isTerminalMode ? (
							<Terminal className="w-4 h-4" />
						) : (
							<Wand2 className="w-4 h-4" style={{ color: theme.colors.accent }} />
						)}
					</button>
					{/* Send button, or Stop while a turn is running - Escape does the same thing,
					    but a keyboard-only exit strands anyone on a tablet or remote desktop. */}
					{isBusy && onStopTurn ? (
						<button
							type="button"
							onClick={handleStopTurn}
							className="p-2 rounded-md shadow-sm transition-all hover:opacity-90 cursor-pointer"
							style={{ backgroundColor: theme.colors.error, color: 'white' }}
							title="Stop this turn (Esc)"
							aria-label="Stop this turn"
							data-testid="wizard-stop-turn-button"
						>
							<Square className="w-4 h-4" fill="currentColor" />
						</button>
					) : (
						<button
							type="button"
							onClick={() => processInput()}
							disabled={isBusy}
							className="p-2 rounded-md shadow-sm transition-all hover:opacity-90 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:opacity-50"
							style={{
								backgroundColor: theme.colors.accent,
								color: theme.colors.accentForeground,
							}}
							title={isBusy ? 'Wizard is thinking…' : 'Send message'}
						>
							<ArrowUp className="w-4 h-4" />
						</button>
					)}
				</div>
			</div>

			{/* Exit confirmation dialog */}
			{showExitConfirm && (
				<WizardExitConfirmDialog
					theme={theme}
					onConfirm={handleConfirmExit}
					onCancel={handleCancelExit}
				/>
			)}
		</div>
	);
});
