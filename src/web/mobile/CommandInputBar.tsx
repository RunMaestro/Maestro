/**
 * CommandInputBar - Sticky bottom input bar for mobile web interface
 *
 * A touch-friendly command input component that stays fixed at the bottom
 * of the viewport and properly handles mobile keyboard appearance.
 *
 * Features:
 * - Always visible at bottom of screen
 * - Adjusts position when mobile keyboard appears (using visualViewport API)
 * - Supports safe area insets for notched devices
 * - Disabled state when disconnected or offline
 * - Large touch-friendly textarea for easy mobile input
 * - Auto-expanding textarea for multi-line commands (up to 4 lines)
 * - Minimum 44px touch targets per Apple HIG guidelines
 * - Mode toggle button (AI / Terminal) with visual indicator
 * - Voice input button for speech-to-text (uses Web Speech API)
 * - Interrupt button (red X) REPLACES send button when session is busy
 *   (saves horizontal space - only one action button visible at a time)
 * - Recent command chips for quick access to recently sent commands
 * - Slash command autocomplete popup when typing `/`
 * - Haptic feedback on send (if device supports vibration)
 * - Quick actions menu on long-press of send button
 * - Flex layout with minWidth: 0 ensures text input shrinks to fit screen
 */

import React, { useRef, useEffect, useState, useCallback } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { webLogger } from '../utils/logger';
import { useSwipeUp } from '../hooks/useSwipeUp';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { useKeyboardVisibility } from '../hooks/useKeyboardVisibility';
import { useSlashCommandAutocomplete } from '../hooks/useSlashCommandAutocomplete';
import { useLongPressMenu } from '../hooks/useLongPressMenu';
import { RecentCommandChips } from './RecentCommandChips';
import {
	SlashCommandAutocomplete,
	type SlashCommand,
	DEFAULT_SLASH_COMMANDS,
} from './SlashCommandAutocomplete';
import { triggerHaptic } from './constants';
import {
	VoiceInputButton,
	SlashCommandButton,
	SendInterruptButton,
	ExpandedModeSendInterruptButton,
	ThinkingToggleButton,
} from './CommandInputButtons';
import type { ThinkingMode } from '../../shared/types';
import type { CommandHistoryEntry } from '../hooks/useCommandHistory';

/** Default minimum height for the text input area */
const MIN_INPUT_HEIGHT = 48;

/** Line height for text calculations */
const LINE_HEIGHT = 22;

/** Maximum number of lines before scrolling */
const MAX_LINES = 4;

/** Vertical padding inside textarea (top + bottom) */
const TEXTAREA_VERTICAL_PADDING = 28; // 14px top + 14px bottom

/** Maximum height for textarea based on max lines */
const MAX_TEXTAREA_HEIGHT = LINE_HEIGHT * MAX_LINES + TEXTAREA_VERTICAL_PADDING;

/** Maximum collapsed height for phone AI drafts before the full editor is needed */
const MOBILE_COLLAPSED_MAX_HEIGHT = LINE_HEIGHT * 3 + TEXTAREA_VERTICAL_PADDING;

/** Mobile breakpoint - phones only, not tablets */
const MOBILE_MAX_WIDTH = 480;

/** Height of expanded input on mobile (50% of viewport) */
const MOBILE_EXPANDED_HEIGHT_VH = 50;

/** Maximum number of staged images per message. Prevents pathological pastes
 *  from producing multi-megabyte WebSocket frames or stalling the renderer. */
const MAX_STAGED_IMAGES = 5;

/** Maximum decoded byte size accepted per pasted image. Base64 inflates
 *  payloads ~33%, so a 2 MB raw image becomes ~2.7 MB on the wire — high
 *  enough to cover screenshots, low enough to keep a single message well
 *  under typical WebSocket frame budgets. */
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/**
 * Detect if the device is a mobile phone (not tablet/desktop)
 * Based on screen width so narrow remote/mobile layouts get the phone treatment
 * even when touch capability is not exposed to the browser.
 */
function useIsMobilePhone(): boolean {
	const [isMobile, setIsMobile] = useState(false);

	useEffect(() => {
		const checkMobile = () => {
			setIsMobile(window.innerWidth <= MOBILE_MAX_WIDTH);
		};

		checkMobile();
		window.addEventListener('resize', checkMobile);
		return () => window.removeEventListener('resize', checkMobile);
	}, []);

	return isMobile;
}

/** Input mode type - AI assistant or terminal */
export type InputMode = 'ai' | 'terminal';

export interface CommandInputBarProps {
	/** Whether the device is offline */
	isOffline: boolean;
	/** Whether connected to the server */
	isConnected: boolean;
	/** Placeholder text for the input */
	placeholder?: string;
	/**
	 * Callback when command is submitted.
	 * `images` is an optional array of base64 data URLs from the staged-image
	 * tray (populated via clipboard paste). Mirrors the desktop `stagedImages`
	 * shape so the renderer's remote-command path can spawn the agent with
	 * the same payload.
	 */
	onSubmit?: (command: string, images?: string[]) => void;
	/** Callback when input value changes */
	onChange?: (value: string) => void;
	/** Current input value (controlled) */
	value?: string;
	/** Whether the input is disabled */
	disabled?: boolean;
	/** Current input mode (AI or terminal) */
	inputMode?: InputMode;
	/** Whether the active session is busy (AI thinking) */
	isSessionBusy?: boolean;
	/** Callback when interrupt button is pressed */
	onInterrupt?: () => void;
	/** Callback when history drawer should open (swipe up) */
	onHistoryOpen?: () => void;
	/** Recent unique commands for quick-tap chips */
	recentCommands?: CommandHistoryEntry[];
	/** Callback when a recent command chip is tapped */
	onSelectRecentCommand?: (command: string) => void;
	/** Available slash commands (uses defaults if not provided) */
	slashCommands?: SlashCommand[];
	/** Current working directory (shown in terminal mode) */
	cwd?: string;
	/** Callback when input receives focus */
	onInputFocus?: () => void;
	/** Callback when input loses focus */
	onInputBlur?: () => void;
	/** Whether to show recent command chips (defaults to true) */
	showRecentCommands?: boolean;
	/** Callback when command palette should open (long-press of send button) */
	onOpenCommandPalette?: () => void;
	/** Current thinking mode: 'off' | 'on' | 'sticky' */
	thinkingMode?: ThinkingMode;
	/** Callback to cycle thinking mode */
	onToggleThinking?: () => void;
	/** Whether the active agent supports thinking display */
	supportsThinking?: boolean;
	/** Reports the rendered outer height of the input bar whenever it changes. */
	onHeightChange?: (height: number) => void;
}

/**
 * CommandInputBar component
 *
 * Provides a sticky bottom input bar optimized for mobile devices.
 * Uses the Visual Viewport API to stay above the keyboard.
 */
export function CommandInputBar({
	isOffline,
	isConnected,
	placeholder,
	onSubmit,
	onChange,
	value: controlledValue,
	disabled: externalDisabled,
	inputMode = 'ai',
	isSessionBusy = false,
	onInterrupt,
	onHistoryOpen,
	recentCommands,
	onSelectRecentCommand,
	slashCommands = DEFAULT_SLASH_COMMANDS,
	cwd,
	onInputFocus,
	onInputBlur,
	showRecentCommands = true,
	onOpenCommandPalette,
	thinkingMode = 'off',
	onToggleThinking,
	supportsThinking = false,
	onHeightChange,
}: CommandInputBarProps) {
	const colors = useThemeColors();
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	// Mobile phone detection
	const isMobilePhone = useIsMobilePhone();

	// Mobile expanded input state (AI mode only)
	const [isExpanded, setIsExpanded] = useState(false);

	// Swipe up gesture detection for opening history drawer
	const { handlers: swipeUpHandlers } = useSwipeUp({
		onSwipeUp: () => onHistoryOpen?.(),
		enabled: !!onHistoryOpen,
	});

	// Track keyboard visibility for positioning (using Visual Viewport API)
	const { keyboardOffset, isKeyboardVisible } = useKeyboardVisibility();

	// Track textarea height for auto-expansion
	const [textareaHeight, setTextareaHeight] = useState(MIN_INPUT_HEIGHT);

	// Internal state for uncontrolled mode
	const [internalValue, setInternalValue] = useState('');
	const value = controlledValue !== undefined ? controlledValue : internalValue;

	// Staged images pasted into AI mode. Each entry pairs the base64 data URL
	// with a short stable id so React reconciliation doesn't have to compare
	// the full data URL on every render (which can be hundreds of KB) and so
	// duplicate-image rejection can't produce duplicate keys. Mirrors
	// desktop's `stagedImages` semantics: local-only state, cleared on send.
	const [stagedImages, setStagedImages] = useState<{ id: string; dataUrl: string }[]>([]);
	const stagedImageIdSeq = useRef(0);

	// Determine if input should be disabled (must be before hooks that use it)
	// In AI mode: NEVER disable the input - user can always prep next message
	// The send button will show X (interrupt) when AI is busy
	// For terminal mode: do NOT disable when session is busy - terminal commands use a different pathway
	const isDisabled = externalDisabled || isOffline || !isConnected;

	// Slash command autocomplete hook
	const {
		isOpen: slashCommandOpen,
		selectedIndex: selectedSlashCommandIndex,
		setSelectedIndex: setSelectedSlashCommandIndex,
		openAutocomplete: openSlashCommandAutocomplete,
		handleInputChange: handleSlashCommandInputChange,
		handleSelectCommand: handleSelectSlashCommand,
		handleClose: handleCloseSlashCommand,
	} = useSlashCommandAutocomplete({
		inputValue: value,
		isControlled: controlledValue !== undefined,
		onChange: (newValue: string) => {
			if (controlledValue === undefined) {
				setInternalValue(newValue);
			}
			onChange?.(newValue);
		},
		onSubmit,
		inputRef: textareaRef as React.RefObject<HTMLTextAreaElement | HTMLInputElement | null>,
	});

	// Voice input hook - handles speech recognition
	const handleVoiceTranscription = useCallback(
		(newText: string) => {
			if (controlledValue === undefined) {
				setInternalValue(newText);
			}
			onChange?.(newText);
		},
		[controlledValue, onChange]
	);

	const {
		isListening,
		voiceSupported,
		toggleVoiceInput: handleVoiceToggle,
	} = useVoiceInput({
		currentValue: value,
		disabled: isDisabled,
		onTranscriptionChange: handleVoiceTranscription,
		focusRef: textareaRef as React.RefObject<HTMLTextAreaElement>,
	});

	// Long-press menu hook - opens the command palette on long-press of send button
	const {
		sendButtonRef,
		handleTouchStart: handleSendButtonTouchStart,
		handleTouchEnd: handleSendButtonTouchEnd,
		handleTouchMove: handleSendButtonTouchMove,
	} = useLongPressMenu({
		inputMode,
		disabled: isDisabled,
		value,
		onOpenCommandPalette,
	});

	// Separate flag for whether send is blocked (AI thinking)
	// When true, shows X button instead of send button
	const isSendBlocked = inputMode === 'ai' && isSessionBusy;

	// Disable send when there's no text AND no AI-mode image attachments.
	// Image-only sends are explicitly AI-mode only — terminal mode never
	// considers staged images as a reason to enable the send button.
	const isSendDisabledForCurrentInput =
		isDisabled || (!value.trim() && (inputMode !== 'ai' || stagedImages.length === 0));

	// Get placeholder text based on state
	const getPlaceholder = () => {
		if (isOffline) return 'Offline...';
		if (!isConnected) return 'Connecting...';
		// In AI mode when busy, show helpful hint that user can still type
		if (inputMode === 'ai' && isSessionBusy) return 'AI thinking... (type your next message)';
		// In terminal mode, show shortened cwd as placeholder hint
		if (inputMode === 'terminal' && cwd) {
			const shortCwd = cwd.replace(/^\/Users\/[^/]+/, '~');
			return shortCwd;
		}
		return placeholder || 'Enter command...';
	};

	/**
	 * Report container height changes to parent so it can reserve matching space
	 * in the scroll area above (keeps last chat line visible when bar expands).
	 * Report the *border-box* height — the container's own padding (including
	 * safe-area inset on notched devices) must be part of the reserved space,
	 * and `contentRect` excludes it, which would cause the reserved gap to
	 * shrink after the first observer tick.
	 */
	useEffect(() => {
		const container = containerRef.current;
		if (!container || !onHeightChange) return;
		const observer = new ResizeObserver((entries) => {
			const entry = entries[0];
			if (!entry) return;
			const borderBoxBlockSize = entry.borderBoxSize?.[0]?.blockSize;
			onHeightChange(borderBoxBlockSize ?? container.getBoundingClientRect().height);
		});
		observer.observe(container);
		onHeightChange(container.getBoundingClientRect().height);
		return () => observer.disconnect();
	}, [onHeightChange]);

	/**
	 * Auto-resize textarea based on content
	 * Expands up to MAX_LINES (4 lines) then enables scrolling
	 */
	useEffect(() => {
		const textarea = textareaRef.current;
		if (!textarea) return;

		// If value is empty, reset to minimum height immediately
		if (!value) {
			setTextareaHeight(MIN_INPUT_HEIGHT);
			textarea.style.height = `${MIN_INPUT_HEIGHT}px`;
			return;
		}

		// Reset height to minimum to get accurate scrollHeight measurement
		textarea.style.height = `${MIN_INPUT_HEIGHT}px`;

		// Calculate the new height based on content
		const scrollHeight = textarea.scrollHeight;

		// Clamp height between minimum and maximum
		const newHeight = Math.min(Math.max(scrollHeight, MIN_INPUT_HEIGHT), MAX_TEXTAREA_HEIGHT);

		setTextareaHeight(newHeight);
		textarea.style.height = `${newHeight}px`;
	}, [value]);

	/**
	 * Handle clipboard paste — extract any image items, base64-encode them, and
	 * push them onto `stagedImages`. Only active in AI mode (terminal mode
	 * doesn't have a meaningful image-attach concept). Text paste is left to
	 * the browser default so existing autocomplete/expansion logic stays put.
	 *
	 * Enforces both a count cap (MAX_STAGED_IMAGES) and a per-image byte cap
	 * (MAX_IMAGE_BYTES) so a runaway paste can't produce multi-megabyte
	 * WebSocket frames. Failures (oversize image, FileReader error) are
	 * logged via webLogger so they're visible in production — silent drops
	 * would mislead users into thinking the attachment was sent.
	 */
	const handlePaste = useCallback(
		(e: React.ClipboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
			if (inputMode !== 'ai') return;
			const items = e.clipboardData?.items;
			if (!items) return;
			let consumed = false;
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (!item.type.startsWith('image/')) continue;
				const blob = item.getAsFile();
				if (!blob) continue;
				if (!consumed) {
					e.preventDefault();
					consumed = true;
				}
				if (blob.size > MAX_IMAGE_BYTES) {
					webLogger.warn(
						`Pasted image exceeds ${MAX_IMAGE_BYTES} byte cap (got ${blob.size}); dropping`,
						'CommandInputBar'
					);
					continue;
				}
				const reader = new FileReader();
				reader.onload = (event) => {
					const result = event.target?.result;
					if (typeof result !== 'string') return;
					setStagedImages((prev) => {
						if (prev.length >= MAX_STAGED_IMAGES) {
							webLogger.warn(
								`Staged image cap reached (${MAX_STAGED_IMAGES}); dropping additional paste`,
								'CommandInputBar'
							);
							return prev;
						}
						if (prev.some((entry) => entry.dataUrl === result)) return prev;
						stagedImageIdSeq.current += 1;
						return [...prev, { id: `img-${stagedImageIdSeq.current}`, dataUrl: result }];
					});
				};
				reader.onerror = () => {
					// Surface the failure rather than silently swallowing it —
					// without this the user would see the paste 'work' (event
					// fired, no error in console) but no thumbnail would appear.
					webLogger.error(
						`FileReader failed to decode pasted image (${item.type})`,
						'CommandInputBar',
						reader.error ?? undefined
					);
				};
				reader.readAsDataURL(blob);
			}
		},
		[inputMode]
	);

	/**
	 * Handle textarea change
	 * Also detects slash commands and shows autocomplete via hook
	 */
	const handleChange = useCallback(
		(e: React.ChangeEvent<HTMLTextAreaElement>) => {
			const newValue = e.target.value;
			if (controlledValue === undefined) {
				setInternalValue(newValue);
			}
			onChange?.(newValue);

			// Delegate slash command detection to the hook
			handleSlashCommandInputChange(newValue);
		},
		[controlledValue, onChange, handleSlashCommandInputChange]
	);

	/**
	 * Handle form submission. Image attachments are AI-mode only — terminal
	 * sends ignore any staged images entirely so a user who pasted images and
	 * then switched to terminal can't accidentally ship them as a payload.
	 */
	const handleSubmit = useCallback(
		(e: React.FormEvent) => {
			e.preventDefault();
			const hasImages = inputMode === 'ai' && stagedImages.length > 0;
			if (isDisabled) return;
			if (!value.trim() && !hasImages) return;

			// Trigger haptic feedback on successful send
			triggerHaptic(25);

			onSubmit?.(value.trim(), hasImages ? stagedImages.map((entry) => entry.dataUrl) : undefined);

			// Clear input after submit (for uncontrolled mode)
			if (controlledValue === undefined) {
				setInternalValue('');
			}
			setStagedImages([]);

			// Keep focus on textarea after submit
			textareaRef.current?.focus();
		},
		[value, isDisabled, onSubmit, controlledValue, stagedImages, inputMode]
	);

	/**
	 * Handle key press events
	 * AI mode: Enter adds newline, Cmd/Ctrl+Enter submits
	 * Terminal mode: Enter submits (Shift+Enter adds newline)
	 */
	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
			if (inputMode === 'ai') {
				// AI mode: Cmd+Enter (Mac) or Ctrl+Enter (Windows/Linux) submits
				if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
					e.preventDefault();
					if (!isSendBlocked) {
						handleSubmit(e);
					}
				}
				// Plain Enter adds newline (default behavior)
				return;
			}
			// Terminal mode: Submit on Enter (Shift+Enter adds newline)
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				handleSubmit(e);
			}
		},
		[handleSubmit, inputMode, isSendBlocked]
	);

	/**
	 * Focus input when mode changes
	 * This allows users to immediately start typing after switching modes
	 */
	useEffect(() => {
		// Small delay to ensure the DOM has updated after mode switch
		const timer = setTimeout(() => {
			textareaRef.current?.focus();
		}, 50);
		return () => clearTimeout(timer);
	}, [inputMode]);

	/**
	 * Handle interrupt button press
	 */
	const handleInterrupt = useCallback(() => {
		onInterrupt?.();
	}, [onInterrupt]);

	/**
	 * Handle click outside to collapse expanded input on mobile
	 */
	useEffect(() => {
		if (!isExpanded || !isMobilePhone || inputMode !== 'ai') return;

		const handleClickOutside = (e: MouseEvent | TouchEvent) => {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setIsExpanded(false);
				textareaRef.current?.blur();
			}
		};

		// Use touchstart for immediate response on mobile
		document.addEventListener('touchstart', handleClickOutside);
		document.addEventListener('mousedown', handleClickOutside);

		return () => {
			document.removeEventListener('touchstart', handleClickOutside);
			document.removeEventListener('mousedown', handleClickOutside);
		};
	}, [isExpanded, isMobilePhone, inputMode]);

	/**
	 * Handle focus to expand input on mobile in AI mode
	 */
	const handleMobileAIFocus = useCallback(() => {
		if (isMobilePhone && inputMode === 'ai') {
			setIsExpanded(true);
		}
		onInputFocus?.();
	}, [isMobilePhone, inputMode, onInputFocus]);

	/**
	 * Auto-focus the textarea when expanded mode is activated
	 */
	useEffect(() => {
		if (isExpanded && isMobilePhone && inputMode === 'ai' && textareaRef.current) {
			// Small delay to ensure DOM has updated
			const timer = setTimeout(() => {
				textareaRef.current?.focus();
			}, 50);
			return () => clearTimeout(timer);
		}
	}, [isExpanded, isMobilePhone, inputMode]);

	/**
	 * Collapse input when submitting on mobile. Same AI-mode image gating as
	 * `handleSubmit` so terminal sends never carry image payloads.
	 */
	const handleMobileSubmit = useCallback(
		(e: React.FormEvent) => {
			e.preventDefault();
			const hasImages = inputMode === 'ai' && stagedImages.length > 0;
			if (isDisabled || isSendBlocked) return;
			if (!value.trim() && !hasImages) return;

			// Trigger haptic feedback on successful send
			triggerHaptic(25);

			onSubmit?.(value.trim(), hasImages ? stagedImages.map((entry) => entry.dataUrl) : undefined);

			// Clear input after submit (for uncontrolled mode)
			if (controlledValue === undefined) {
				setInternalValue('');
			}
			setStagedImages([]);

			// Collapse on mobile after submit
			if (isMobilePhone && inputMode === 'ai') {
				setIsExpanded(false);
			}

			// Keep focus on textarea after submit (unless mobile where we collapse)
			if (!isMobilePhone) {
				textareaRef.current?.focus();
			}
		},
		[
			value,
			isDisabled,
			isSendBlocked,
			onSubmit,
			controlledValue,
			isMobilePhone,
			inputMode,
			stagedImages,
		]
	);

	// Calculate textarea height for mobile expanded mode
	const shouldCompressPhoneActions = isMobilePhone && inputMode === 'ai' && value.trim().length > 0;
	const collapsedMobileTextareaHeight = Math.min(textareaHeight, MOBILE_COLLAPSED_MAX_HEIGHT);
	const shouldStackPhoneComposer =
		isMobilePhone &&
		inputMode === 'ai' &&
		collapsedMobileTextareaHeight >= MOBILE_COLLAPSED_MAX_HEIGHT;
	const mobileExpandedHeight =
		isMobilePhone && inputMode === 'ai' && isExpanded
			? `${MOBILE_EXPANDED_HEIGHT_VH}vh`
			: undefined;

	return (
		<div
			ref={containerRef}
			{...swipeUpHandlers}
			style={{
				position: 'fixed',
				left: 0,
				right: 0,
				bottom: keyboardOffset,
				zIndex: 100,
				// Safe area padding for notched devices
				paddingBottom: isKeyboardVisible ? '0' : 'max(12px, env(safe-area-inset-bottom))',
				paddingLeft: 'env(safe-area-inset-left)',
				paddingRight: 'env(safe-area-inset-right)',
				paddingTop: onHistoryOpen ? '4px' : '12px', // Reduced top padding when swipe handle is shown
				backgroundColor: colors.bgSidebar,
				borderTop: `1px solid ${colors.border}`,
				// Smooth transition when keyboard appears/disappears
				transition: isKeyboardVisible ? 'none' : 'bottom 0.15s ease-out, height 200ms ease-out',
				// On mobile when expanded, use flexbox for proper layout
				...(mobileExpandedHeight && {
					display: 'flex',
					flexDirection: 'column',
					height: `calc(${MOBILE_EXPANDED_HEIGHT_VH}vh + 60px)`, // Textarea height + buttons/padding
				}),
			}}
		>
			{/* Swipe up handle indicator - visual hint for opening history */}
			{onHistoryOpen && (
				<div
					style={{
						display: 'flex',
						justifyContent: 'center',
						paddingBottom: '8px',
						cursor: 'pointer',
					}}
					onClick={onHistoryOpen}
					aria-label="Open command history"
				>
					<div
						style={{
							width: '36px',
							height: '4px',
							backgroundColor: colors.border,
							borderRadius: '2px',
							opacity: 0.6,
						}}
					/>
				</div>
			)}

			{/* Recent command chips - quick-tap to reuse commands */}
			{/* On mobile, can be hidden when input is not focused to save space */}
			{showRecentCommands &&
				recentCommands &&
				recentCommands.length > 0 &&
				onSelectRecentCommand && (
					<RecentCommandChips
						commands={recentCommands}
						onSelectCommand={onSelectRecentCommand}
						disabled={isDisabled}
					/>
				)}

			{/* Staged images preview — base64 thumbnails of pasted images, with
			    a remove button per item. AI mode only; matches desktop layout.
			    Stable ids are used as React keys so reconciliation doesn't
			    have to compare full data URLs across renders. */}
			{inputMode === 'ai' && stagedImages.length > 0 && (
				<div
					style={{
						display: 'flex',
						gap: '8px',
						overflowX: 'auto',
						overflowY: 'visible',
						padding: '0 16px 8px 16px',
					}}
				>
					{stagedImages.map((entry, idx) => (
						<div
							key={entry.id}
							style={{
								position: 'relative',
								flexShrink: 0,
							}}
						>
							<img
								src={entry.dataUrl}
								alt={`Staged image ${idx + 1}`}
								style={{
									height: '64px',
									maxWidth: '160px',
									objectFit: 'contain',
									borderRadius: '8px',
									border: `1px solid ${colors.border}`,
									display: 'block',
								}}
							/>
							<button
								type="button"
								onClick={() =>
									setStagedImages((prev) => prev.filter((existing) => existing.id !== entry.id))
								}
								aria-label={`Remove staged image ${idx + 1}`}
								style={{
									position: 'absolute',
									top: '-6px',
									right: '-6px',
									width: '22px',
									height: '22px',
									borderRadius: '50%',
									backgroundColor: 'rgba(239, 68, 68, 0.95)',
									color: 'white',
									border: 'none',
									cursor: 'pointer',
									fontSize: '14px',
									lineHeight: '22px',
									padding: 0,
									boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
								}}
							>
								×
							</button>
						</div>
					))}
				</div>
			)}

			{/* Slash command autocomplete popup */}
			<SlashCommandAutocomplete
				isOpen={slashCommandOpen}
				inputValue={value}
				inputMode={inputMode}
				commands={slashCommands}
				onSelectCommand={handleSelectSlashCommand}
				onClose={handleCloseSlashCommand}
				selectedIndex={selectedSlashCommandIndex}
				onSelectedIndexChange={setSelectedSlashCommandIndex}
				isInputExpanded={isExpanded}
			/>

			{/* EXPANDED MOBILE AI MODE - Full width textarea with send button below */}
			{mobileExpandedHeight ? (
				<form
					onSubmit={handleMobileSubmit}
					style={{
						display: 'flex',
						flexDirection: 'column',
						gap: '8px',
						paddingLeft: '16px',
						paddingRight: '16px',
						flex: 1,
						maxWidth: '100%',
						overflow: 'hidden',
					}}
				>
					{/* Full-width textarea */}
					<textarea
						ref={textareaRef}
						value={value}
						onChange={handleChange}
						onKeyDown={handleKeyDown}
						onPaste={handlePaste}
						placeholder={getPlaceholder()}
						disabled={isDisabled}
						autoComplete="off"
						autoCorrect="off"
						autoCapitalize="off"
						spellCheck={false}
						enterKeyHint="enter"
						rows={1}
						style={{
							flex: 1,
							width: '100%',
							padding: '14px 18px',
							borderRadius: '12px',
							backgroundColor: colors.bgMain,
							border: `2px solid ${colors.accent}`,
							boxShadow: `0 0 0 3px ${colors.accent}33`,
							color: colors.textMain,
							fontSize: '17px',
							fontFamily: 'inherit',
							lineHeight: `${LINE_HEIGHT}px`,
							outline: 'none',
							minHeight: '150px',
							WebkitAppearance: 'none',
							appearance: 'none',
							resize: 'none',
							WebkitFontSmoothing: 'antialiased',
							MozOsxFontSmoothing: 'grayscale',
							overflowY: 'auto',
							overflowX: 'hidden',
							wordWrap: 'break-word',
						}}
						onBlur={(_e) => {
							// Delay collapse to allow click on send button
							setTimeout(() => {
								if (!containerRef.current?.contains(document.activeElement)) {
									setIsExpanded(false);
								}
							}, 150);
							onInputBlur?.();
						}}
						aria-label="AI message input. Press the send button to submit."
						aria-multiline="true"
					/>

					{/* Full-width send button below textarea */}
					<ExpandedModeSendInterruptButton
						isInterruptMode={inputMode === 'ai' && isSessionBusy}
						isSendDisabled={isSendDisabledForCurrentInput}
						onInterrupt={handleInterrupt}
					/>
				</form>
			) : (
				/* NORMAL MODE - Original layout with side buttons */
				<form
					onSubmit={handleMobileSubmit}
					style={{
						display: 'flex',
						flexDirection: shouldStackPhoneComposer ? 'column' : 'row',
						gap: '8px',
						alignItems: shouldStackPhoneComposer ? 'stretch' : 'flex-end',
						paddingLeft: '16px',
						paddingRight: '16px',
						// Ensure form doesn't overflow screen width
						maxWidth: '100%',
						overflow: 'hidden',
					}}
				>
					{/* Terminal mode: $ prefix + input in a container - single line, tight height */}
					{inputMode === 'terminal' ? (
						<>
							<div
								style={{
									flex: 1,
									// minWidth: 0 is critical for flex items to shrink below content size
									minWidth: 0,
									display: 'flex',
									alignItems: 'center',
									borderRadius: '12px',
									backgroundColor: colors.bgMain,
									border: `2px solid ${colors.border}`,
									// Tight padding to match button height (48px total with border)
									padding: '0 14px',
									height: `${MIN_INPUT_HEIGHT}px`,
									gap: '6px',
									opacity: isDisabled ? 0.5 : 1,
								}}
							>
								{/* $ prompt */}
								<span
									style={{
										color: colors.accent,
										fontSize: '17px',
										fontFamily: 'ui-monospace, monospace',
										fontWeight: 600,
										flexShrink: 0,
									}}
								>
									$
								</span>
								<input
									ref={textareaRef as unknown as React.RefObject<HTMLInputElement>}
									type="text"
									value={value}
									onChange={(e) =>
										handleChange(e as unknown as React.ChangeEvent<HTMLTextAreaElement>)
									}
									onKeyDown={(e) => {
										if (e.key === 'Enter') {
											e.preventDefault();
											handleSubmit(e as unknown as React.FormEvent);
										}
									}}
									placeholder={getPlaceholder()}
									disabled={isDisabled}
									autoComplete="off"
									autoCorrect="off"
									autoCapitalize="off"
									spellCheck={false}
									enterKeyHint="send"
									style={{
										flex: 1,
										padding: 0,
										border: 'none',
										backgroundColor: 'transparent',
										color: isDisabled ? colors.textDim : colors.textMain,
										fontSize: '17px',
										fontFamily: 'ui-monospace, monospace',
										outline: 'none',
										width: '100%',
									}}
									onFocus={(e) => {
										const container = e.currentTarget.parentElement;
										if (container) container.style.borderColor = colors.accent;
										onInputFocus?.();
									}}
									onBlur={(e) => {
										const container = e.currentTarget.parentElement;
										if (container) container.style.borderColor = colors.border;
										onInputBlur?.();
									}}
									aria-label="Shell command input"
								/>
							</div>
							<SendInterruptButton
								isInterruptMode={false}
								isSendDisabled={isSendDisabledForCurrentInput}
								onInterrupt={handleInterrupt}
								sendButtonRef={sendButtonRef}
								onTouchStart={handleSendButtonTouchStart}
								onTouchEnd={handleSendButtonTouchEnd}
								onTouchMove={handleSendButtonTouchMove}
							/>
						</>
					) : (
						<>
							{!shouldStackPhoneComposer && (
								<>
									{/* Voice input button - only shown if speech recognition is supported */}
									{voiceSupported && !shouldCompressPhoneActions && (
										<VoiceInputButton
											isListening={isListening}
											onToggle={handleVoiceToggle}
											disabled={isDisabled}
										/>
									)}

									{/* Slash command button - only shown in AI mode */}
									{!shouldCompressPhoneActions && (
										<SlashCommandButton
											isOpen={slashCommandOpen}
											onOpen={openSlashCommandAutocomplete}
											disabled={isDisabled}
										/>
									)}

									{/* Thinking toggle button - only shown in AI mode for agents that support it */}
									{inputMode === 'ai' && supportsThinking && onToggleThinking && (
										<ThinkingToggleButton
											thinkingMode={thinkingMode}
											onToggle={onToggleThinking}
											disabled={isDisabled}
										/>
									)}
								</>
							)}

							{/* AI mode: regular textarea - on mobile phone, focus triggers expanded mode */}
							{/* On mobile, collapsed state shows single-line height matching buttons */}
							<textarea
								ref={textareaRef}
								value={value}
								onChange={handleChange}
								onKeyDown={handleKeyDown}
								onPaste={handlePaste}
								placeholder={getPlaceholder()}
								disabled={isDisabled}
								autoComplete="off"
								autoCorrect="off"
								autoCapitalize="off"
								spellCheck={false}
								enterKeyHint="enter"
								rows={1}
								style={{
									flex: shouldStackPhoneComposer ? 'none' : 1,
									width: shouldStackPhoneComposer ? '100%' : undefined,
									alignSelf: shouldStackPhoneComposer ? 'stretch' : undefined,
									// minWidth: 0 is critical for flex items to shrink below content size
									minWidth: 0,
									// On mobile collapsed state: tighter padding to match button height (48px)
									// height = padding-top + line-height + padding-bottom + border = 11 + 22 + 11 + 4 = 48
									// On desktop/tablet: use original larger padding for comfort
									padding: isMobilePhone ? '11px 14px' : '14px 18px',
									borderRadius: '12px',
									backgroundColor: colors.bgMain,
									border: `2px solid ${colors.border}`,
									// Never ghost out the input - user can always type
									color: colors.textMain,
									// 16px minimum prevents iOS zoom on focus, 17px for better readability
									fontSize: '17px',
									fontFamily: 'inherit',
									lineHeight: `${LINE_HEIGHT}px`,
									outline: 'none',
									// Phones stay compact when empty, but expand enough to keep drafts readable.
									height: isMobilePhone
										? `${value.trim() ? collapsedMobileTextareaHeight : MIN_INPUT_HEIGHT}px`
										: `${textareaHeight}px`,
									// Large minimum height for easy touch targeting
									minHeight: `${MIN_INPUT_HEIGHT}px`,
									maxHeight: isMobilePhone
										? `${MOBILE_COLLAPSED_MAX_HEIGHT}px`
										: `${MAX_TEXTAREA_HEIGHT}px`,
									// Reset appearance for consistent styling
									WebkitAppearance: 'none',
									appearance: 'none',
									// Remove default textarea resize handle
									resize: 'none',
									// Smooth height transitions for auto-expansion
									transition:
										'height 100ms ease-out, border-color 150ms ease, box-shadow 150ms ease',
									// Better text rendering on mobile
									WebkitFontSmoothing: 'antialiased',
									MozOsxFontSmoothing: 'grayscale',
									// On mobile collapsed: hide overflow (single line)
									// On desktop: enable scrolling when content exceeds max height
									overflowY: isMobilePhone
										? collapsedMobileTextareaHeight >= MOBILE_COLLAPSED_MAX_HEIGHT
											? 'auto'
											: 'hidden'
										: textareaHeight >= MAX_TEXTAREA_HEIGHT
											? 'auto'
											: 'hidden',
									overflowX: 'hidden',
									wordWrap: 'break-word',
								}}
								onFocus={(e) => {
									// Add focus ring for accessibility
									e.currentTarget.style.borderColor = colors.accent;
									e.currentTarget.style.boxShadow = `0 0 0 3px ${colors.accent}33`;
									handleMobileAIFocus();
								}}
								onBlur={(e) => {
									// Remove focus ring
									e.currentTarget.style.borderColor = colors.border;
									e.currentTarget.style.boxShadow = 'none';
									onInputBlur?.();
								}}
								aria-label="AI message input. Press the send button to submit."
								aria-multiline="true"
							/>

							{shouldStackPhoneComposer ? (
								<div
									style={{
										display: 'flex',
										alignItems: 'center',
										gap: '8px',
										width: '100%',
									}}
								>
									{/* Action buttons stacked on the left so the bottom row stays balanced
									    when the textarea grows — otherwise the lone send button floats far
									    from the composer and the gap looks awkward. */}
									{voiceSupported && (
										<VoiceInputButton
											isListening={isListening}
											onToggle={handleVoiceToggle}
											disabled={isDisabled}
										/>
									)}
									<SlashCommandButton
										isOpen={slashCommandOpen}
										onOpen={openSlashCommandAutocomplete}
										disabled={isDisabled}
									/>
									{supportsThinking && onToggleThinking && (
										<ThinkingToggleButton
											thinkingMode={thinkingMode}
											onToggle={onToggleThinking}
											disabled={isDisabled}
										/>
									)}
									<div style={{ marginLeft: 'auto' }}>
										<SendInterruptButton
											isInterruptMode={inputMode === 'ai' && isSessionBusy}
											isSendDisabled={isSendDisabledForCurrentInput}
											onInterrupt={handleInterrupt}
											sendButtonRef={sendButtonRef}
											onTouchStart={handleSendButtonTouchStart}
											onTouchEnd={handleSendButtonTouchEnd}
											onTouchMove={handleSendButtonTouchMove}
										/>
									</div>
								</div>
							) : (
								<SendInterruptButton
									isInterruptMode={inputMode === 'ai' && isSessionBusy}
									isSendDisabled={isSendDisabledForCurrentInput}
									onInterrupt={handleInterrupt}
									sendButtonRef={sendButtonRef}
									onTouchStart={handleSendButtonTouchStart}
									onTouchEnd={handleSendButtonTouchEnd}
									onTouchMove={handleSendButtonTouchMove}
								/>
							)}
						</>
					)}
				</form>
			)}

			{/* Inline CSS for animations */}
			<style>
				{`
          @keyframes pulse {
            0%, 100% {
              box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.4);
            }
            50% {
              box-shadow: 0 0 0 8px rgba(239, 68, 68, 0);
            }
          }
        `}
			</style>
		</div>
	);
}

export default CommandInputBar;
