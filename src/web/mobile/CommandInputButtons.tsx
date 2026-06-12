/**
 * CommandInputButtons - Extracted button components for CommandInputBar
 *
 * These button components are specialized for the mobile input bar with:
 * - Large touch targets (48px minimum per Apple HIG)
 * - Touch feedback with scale animations
 * - Haptic feedback via Vibration API
 * - Theme-aware styling
 *
 * Components:
 * - InputModeToggleButton: Switches between AI and Terminal modes
 * - VoiceInputButton: Microphone button for speech-to-text
 * - SlashCommandButton: Opens slash command autocomplete
 * - SendInterruptButton: Send message or cancel running AI query
 */

import React from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import type { ThinkingMode } from '../../shared/types';
import type { InputMode } from './CommandInputBar';
import { triggerHaptic, MIN_TOUCH_TARGET } from './constants';

/** Default minimum height for the buttons */
const MIN_INPUT_HEIGHT = 48;

/**
 * Common base styles for all input bar buttons
 */
const buttonBaseStyles: React.CSSProperties = {
	padding: '10px',
	borderRadius: '12px',
	cursor: 'pointer',
	width: `${MIN_TOUCH_TARGET + 4}px`,
	height: `${MIN_INPUT_HEIGHT}px`,
	display: 'flex',
	alignItems: 'center',
	justifyContent: 'center',
	transition: 'all 150ms ease',
	flexShrink: 0,
	WebkitTapHighlightColor: 'transparent',
	border: 'none',
};

// ============================================================================
// InputModeToggleButton
// ============================================================================

export interface InputModeToggleButtonProps {
	/** Current input mode (AI or terminal) */
	inputMode: InputMode;
	/** Callback when mode is toggled */
	onModeToggle: () => void;
	/** Whether the button is disabled */
	disabled: boolean;
}

/**
 * InputModeToggleButton - Switches between AI and Terminal modes
 *
 * Displays an AI sparkle icon in AI mode, or a terminal prompt icon in terminal mode.
 * Shows mode label below the icon.
 */
export function InputModeToggleButton({
	inputMode,
	onModeToggle,
	disabled,
}: InputModeToggleButtonProps) {
	const colors = useThemeColors();
	const isAiMode = inputMode === 'ai';

	const handleClick = () => {
		triggerHaptic(10);
		onModeToggle();
	};

	return (
		<button
			type="button"
			onClick={handleClick}
			disabled={disabled}
			style={{
				...buttonBaseStyles,
				backgroundColor: isAiMode ? `${colors.accent}20` : `${colors.textDim}20`,
				border: `2px solid ${isAiMode ? colors.accent : colors.textDim}`,
				cursor: disabled ? 'default' : 'pointer',
				opacity: disabled ? 0.5 : 1,
				flexDirection: 'column',
				gap: '2px',
			}}
			onTouchStart={(e) => {
				if (!disabled) {
					e.currentTarget.style.transform = 'scale(0.95)';
				}
			}}
			onTouchEnd={(e) => {
				e.currentTarget.style.transform = 'scale(1)';
			}}
			aria-label={`Switch to ${isAiMode ? 'terminal' : 'AI'} mode. Currently in ${isAiMode ? 'AI' : 'terminal'} mode.`}
			aria-pressed={isAiMode}
		>
			{/* Mode icon - AI sparkle or Terminal prompt */}
			{isAiMode ? (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke={colors.accent}
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<path d="M12 3v2M12 19v2M5.64 5.64l1.42 1.42M16.95 16.95l1.41 1.41M3 12h2M19 12h2M5.64 18.36l1.42-1.42M16.95 7.05l1.41-1.41" />
					<circle cx="12" cy="12" r="4" />
				</svg>
			) : (
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke={colors.textDim}
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<polyline points="4 17 10 11 4 5" />
					<line x1="12" y1="19" x2="20" y2="19" />
				</svg>
			)}
			{/* Mode label */}
			<span
				style={{
					fontSize: '9px',
					fontWeight: 600,
					color: isAiMode ? colors.accent : colors.textDim,
					textTransform: 'uppercase',
					letterSpacing: '0.5px',
				}}
			>
				{isAiMode ? 'AI' : 'CLI'}
			</span>
		</button>
	);
}

// ============================================================================
// VoiceInputButton
// ============================================================================

export interface VoiceInputButtonProps {
	/** Whether currently listening for voice input */
	isListening: boolean;
	/** Callback to toggle voice input */
	onToggle: () => void;
	/** Whether the button is disabled */
	disabled: boolean;
}

/**
 * VoiceInputButton - Microphone button for speech-to-text
 *
 * Shows a microphone icon that pulses red when actively listening.
 * Uses the Web Speech API for transcription.
 */
export function VoiceInputButton({ isListening, onToggle, disabled }: VoiceInputButtonProps) {
	const colors = useThemeColors();

	return (
		<button
			type="button"
			onClick={onToggle}
			disabled={disabled}
			style={{
				...buttonBaseStyles,
				backgroundColor: isListening ? '#ef444420' : `${colors.textDim}15`,
				border: `2px solid ${isListening ? '#ef4444' : colors.border}`,
				cursor: disabled ? 'default' : 'pointer',
				opacity: disabled ? 0.5 : 1,
				animation: isListening ? 'pulse 1.5s ease-in-out infinite' : 'none',
			}}
			onTouchStart={(e) => {
				if (!disabled) {
					e.currentTarget.style.transform = 'scale(0.95)';
				}
			}}
			onTouchEnd={(e) => {
				e.currentTarget.style.transform = 'scale(1)';
			}}
			aria-label={isListening ? 'Stop voice input' : 'Start voice input'}
			aria-pressed={isListening}
		>
			{/* Microphone icon */}
			<svg
				width="20"
				height="20"
				viewBox="0 0 24 24"
				fill={isListening ? '#ef4444' : 'none'}
				stroke={isListening ? '#ef4444' : colors.textDim}
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
				<path d="M19 10v2a7 7 0 0 1-14 0v-2" />
				<line x1="12" x2="12" y1="19" y2="22" />
			</svg>
		</button>
	);
}

// ============================================================================
// SlashCommandButton
// ============================================================================

export interface SlashCommandButtonProps {
	/** Whether the slash command autocomplete is open */
	isOpen: boolean;
	/** Callback to open the autocomplete */
	onOpen: () => void;
	/** Whether the button is disabled */
	disabled: boolean;
}

/**
 * SlashCommandButton - Opens slash command autocomplete
 *
 * Shows a "/" character that becomes accented when the autocomplete is open.
 * Only visible in AI mode.
 */
export function SlashCommandButton({ isOpen, onOpen, disabled }: SlashCommandButtonProps) {
	const colors = useThemeColors();

	return (
		<button
			type="button"
			onClick={onOpen}
			disabled={disabled}
			style={{
				...buttonBaseStyles,
				backgroundColor: isOpen ? `${colors.accent}20` : `${colors.textDim}15`,
				border: `2px solid ${isOpen ? colors.accent : colors.border}`,
				cursor: disabled ? 'default' : 'pointer',
				opacity: disabled ? 0.5 : 1,
			}}
			onTouchStart={(e) => {
				if (!disabled) {
					e.currentTarget.style.transform = 'scale(0.95)';
				}
			}}
			onTouchEnd={(e) => {
				e.currentTarget.style.transform = 'scale(1)';
			}}
			aria-label="Open slash commands"
		>
			{/* Slash icon */}
			<span
				style={{
					fontSize: '20px',
					fontWeight: 600,
					color: isOpen ? colors.accent : colors.textDim,
					fontFamily: 'ui-monospace, monospace',
				}}
			>
				/
			</span>
		</button>
	);
}

// ============================================================================
// SendInterruptButton
// ============================================================================

export interface SendInterruptButtonProps {
	/** Whether to show the interrupt (cancel) button instead of send */
	isInterruptMode: boolean;
	/** Whether the send button is disabled */
	isSendDisabled: boolean;
	/** Callback when interrupt button is clicked */
	onInterrupt: () => void;
	/** Ref for the send button (used by long-press menu) */
	sendButtonRef?: React.RefObject<HTMLButtonElement>;
	/** Touch start handler for long-press detection */
	onTouchStart?: React.TouchEventHandler<HTMLButtonElement>;
	/** Touch end handler for long-press detection */
	onTouchEnd?: React.TouchEventHandler<HTMLButtonElement>;
	/** Touch move handler for long-press cancellation */
	onTouchMove?: React.TouchEventHandler<HTMLButtonElement>;
}

/**
 * SendInterruptButton - Send message or cancel running AI query
 *
 * Shows an up-arrow send button normally, or a red X when AI is busy.
 * The send button supports long-press for quick actions menu.
 */
export function SendInterruptButton({
	isInterruptMode,
	isSendDisabled,
	onInterrupt,
	sendButtonRef,
	onTouchStart,
	onTouchEnd,
	onTouchMove,
}: SendInterruptButtonProps) {
	const colors = useThemeColors();

	const handleInterrupt = () => {
		triggerHaptic(50);
		onInterrupt();
	};

	if (isInterruptMode) {
		return (
			<button
				type="button"
				onClick={handleInterrupt}
				style={{
					...buttonBaseStyles,
					padding: '14px',
					backgroundColor: '#ef4444',
					color: '#ffffff',
					fontSize: '14px',
					fontWeight: 500,
				}}
				onTouchStart={(e) => {
					e.currentTarget.style.transform = 'scale(0.95)';
					e.currentTarget.style.backgroundColor = '#dc2626';
				}}
				onTouchEnd={(e) => {
					e.currentTarget.style.transform = 'scale(1)';
					e.currentTarget.style.backgroundColor = '#ef4444';
				}}
				aria-label="Cancel running command or AI query"
			>
				{/* X icon for interrupt */}
				<svg
					width="24"
					height="24"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<line x1="18" y1="6" x2="6" y2="18" />
					<line x1="6" y1="6" x2="18" y2="18" />
				</svg>
			</button>
		);
	}

	return (
		<button
			ref={sendButtonRef}
			type="submit"
			disabled={isSendDisabled}
			style={{
				...buttonBaseStyles,
				padding: '14px',
				backgroundColor: colors.accent,
				color: '#ffffff',
				fontSize: '14px',
				fontWeight: 500,
				cursor: isSendDisabled ? 'default' : 'pointer',
				opacity: isSendDisabled ? 0.5 : 1,
			}}
			onTouchStart={onTouchStart}
			onTouchEnd={onTouchEnd}
			onTouchMove={onTouchMove}
			aria-label="Send command (long press for quick actions)"
		>
			{/* Arrow up icon for send */}
			<svg
				width="24"
				height="24"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<line x1="12" y1="19" x2="12" y2="5" />
				<polyline points="5 12 12 5 19 12" />
			</svg>
		</button>
	);
}

// ============================================================================
// ExpandedModeSendInterruptButton (for mobile expanded AI mode)
// ============================================================================

export interface ExpandedModeSendInterruptButtonProps {
	/** Whether to show the interrupt (cancel) button instead of send */
	isInterruptMode: boolean;
	/** Whether the send button is disabled */
	isSendDisabled: boolean;
	/** Callback when interrupt button is clicked */
	onInterrupt: () => void;
}

/**
 * ExpandedModeSendInterruptButton - Full-width button for mobile expanded mode
 *
 * Similar to SendInterruptButton but renders as a full-width button with text
 * labels ("Stop" or "Send") for the expanded mobile input mode.
 */
export function ExpandedModeSendInterruptButton({
	isInterruptMode,
	isSendDisabled,
	onInterrupt,
}: ExpandedModeSendInterruptButtonProps) {
	const colors = useThemeColors();

	const handleInterrupt = () => {
		triggerHaptic(50);
		onInterrupt();
	};

	const baseExpandedStyles: React.CSSProperties = {
		width: '100%',
		padding: '12px',
		borderRadius: '12px',
		fontSize: '15px',
		fontWeight: 600,
		border: 'none',
		cursor: 'pointer',
		display: 'flex',
		alignItems: 'center',
		justifyContent: 'center',
		gap: '8px',
		transition: 'opacity 150ms ease, background-color 150ms ease',
		WebkitTapHighlightColor: 'transparent',
	};

	if (isInterruptMode) {
		return (
			<button
				type="button"
				onClick={handleInterrupt}
				style={{
					...baseExpandedStyles,
					backgroundColor: '#ef4444',
					color: '#ffffff',
				}}
				onTouchStart={(e) => {
					e.currentTarget.style.backgroundColor = '#dc2626';
				}}
				onTouchEnd={(e) => {
					e.currentTarget.style.backgroundColor = '#ef4444';
				}}
				aria-label="Cancel running AI query"
			>
				<svg
					width="18"
					height="18"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2.5"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<line x1="18" y1="6" x2="6" y2="18" />
					<line x1="6" y1="6" x2="18" y2="18" />
				</svg>
				<span>Stop</span>
			</button>
		);
	}

	return (
		<button
			type="submit"
			disabled={isSendDisabled}
			style={{
				...baseExpandedStyles,
				backgroundColor: colors.accent,
				color: '#ffffff',
				cursor: isSendDisabled ? 'default' : 'pointer',
				opacity: isSendDisabled ? 0.5 : 1,
			}}
			aria-label="Send message"
		>
			<svg
				width="18"
				height="18"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<line x1="12" y1="19" x2="12" y2="5" />
				<polyline points="5 12 12 5 19 12" />
			</svg>
			<span>Send</span>
		</button>
	);
}

// ============================================================================
// ThinkingToggleButton
// ============================================================================

export interface ThinkingToggleButtonProps {
	/** Current thinking mode: 'off' | 'on' | 'sticky' */
	thinkingMode: ThinkingMode;
	/** Callback to cycle thinking mode */
	onToggle: () => void;
	/** Whether the button is disabled */
	disabled: boolean;
}

/**
 * ThinkingToggleButton - Brain icon pill to toggle AI thinking display
 *
 * Three visual states matching desktop InputArea.tsx:
 * - off: Dimmed, transparent background
 * - on: Accent-colored background with border (temporary)
 * - sticky: Warning-colored background with pin icon (persistent)
 */
export function ThinkingToggleButton({
	thinkingMode,
	onToggle,
	disabled,
}: ThinkingToggleButtonProps) {
	const colors = useThemeColors();

	const handleClick = () => {
		if (disabled) return;
		triggerHaptic(10);
		onToggle();
	};

	const isOff = thinkingMode === 'off';
	const isOn = thinkingMode === 'on';
	const isSticky = thinkingMode === 'sticky';

	const bgColor = isSticky ? `${colors.warning}30` : isOn ? `${colors.accent}25` : 'transparent';

	const fgColor = isSticky ? colors.warning : isOn ? colors.accent : colors.textDim;

	const borderColor = isSticky
		? `${colors.warning}50`
		: isOn
			? `${colors.accent}50`
			: 'transparent';

	const title = isOff
		? 'Show Thinking - Tap to stream AI reasoning'
		: isOn
			? 'Thinking (temporary) - Tap for sticky mode'
			: 'Thinking (sticky) - Tap to turn off';

	return (
		<button
			type="button"
			onClick={handleClick}
			disabled={disabled}
			style={{
				display: 'flex',
				alignItems: 'center',
				gap: '4px',
				padding: '6px 10px',
				borderRadius: '9999px',
				backgroundColor: bgColor,
				border: `1px solid ${borderColor}`,
				color: fgColor,
				fontSize: '11px',
				fontWeight: 500,
				cursor: disabled ? 'default' : 'pointer',
				opacity: disabled ? 0.5 : isOff ? 0.4 : 1,
				transition: 'all 150ms ease',
				flexShrink: 0,
				WebkitTapHighlightColor: 'transparent',
				height: `${MIN_TOUCH_TARGET}px`,
			}}
			onTouchStart={(e) => {
				if (!disabled) {
					e.currentTarget.style.transform = 'scale(0.95)';
					if (isOff) e.currentTarget.style.opacity = '0.7';
				}
			}}
			onTouchEnd={(e) => {
				e.currentTarget.style.transform = 'scale(1)';
				if (isOff && !disabled) e.currentTarget.style.opacity = '0.4';
			}}
			aria-label={title}
			aria-pressed={isSticky ? 'mixed' : !isOff}
			title={title}
		>
			{/* Brain icon (matching lucide Brain) */}
			<svg
				width="14"
				height="14"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				strokeWidth="2"
				strokeLinecap="round"
				strokeLinejoin="round"
			>
				<path d="M12 5a3 3 0 1 0-5.997.125 4 4 0 0 0-2.526 5.77 4 4 0 0 0 .556 6.588A4 4 0 1 0 12 18Z" />
				<path d="M12 5a3 3 0 1 1 5.997.125 4 4 0 0 1 2.526 5.77 4 4 0 0 1-.556 6.588A4 4 0 1 1 12 18Z" />
				<path d="M15 13a4.5 4.5 0 0 1-3-4 4.5 4.5 0 0 1-3 4" />
				<path d="M17.599 6.5a3 3 0 0 0 .399-1.375" />
				<path d="M6.003 5.125A3 3 0 0 0 6.401 6.5" />
				<path d="M3.477 10.896a4 4 0 0 1 .585-.396" />
				<path d="M19.938 10.5a4 4 0 0 1 .585.396" />
				<path d="M6 18a4 4 0 0 1-1.967-.516" />
				<path d="M19.967 17.484A4 4 0 0 1 18 18" />
			</svg>
			<span>Think</span>
			{/* Pin icon for sticky mode */}
			{isSticky && (
				<svg
					width="10"
					height="10"
					viewBox="0 0 24 24"
					fill="none"
					stroke="currentColor"
					strokeWidth="2"
					strokeLinecap="round"
					strokeLinejoin="round"
				>
					<line x1="12" x2="12" y1="17" y2="22" />
					<path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
				</svg>
			)}
		</button>
	);
}
