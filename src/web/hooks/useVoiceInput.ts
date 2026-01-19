/**
 * useVoiceInput - Voice input hook using Web Speech API
 *
 * Provides speech-to-text functionality for mobile web input.
 * Uses the Web Speech API (SpeechRecognition) with vendor prefix fallback.
 *
 * Features:
 * - Browser support detection
 * - Real-time interim results for live transcription
 * - Automatic language detection
 * - Haptic feedback integration
 * - Proper cleanup on unmount
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import { webLogger } from '../utils/logger';

/**
 * Web Speech API type declarations
 * These are needed because TypeScript doesn't include these by default
 */
export interface SpeechRecognitionEvent extends Event {
	readonly resultIndex: number;
	readonly results: SpeechRecognitionResultList;
}

export interface SpeechRecognitionResultList {
	readonly length: number;
	item(index: number): SpeechRecognitionResult;
	[index: number]: SpeechRecognitionResult;
}

export interface SpeechRecognitionResult {
	readonly isFinal: boolean;
	readonly length: number;
	item(index: number): SpeechRecognitionAlternative;
	[index: number]: SpeechRecognitionAlternative;
}

export interface SpeechRecognitionAlternative {
	readonly transcript: string;
	readonly confidence: number;
}

export interface SpeechRecognitionErrorEvent extends Event {
	readonly error: string;
	readonly message: string;
}

export interface SpeechRecognition extends EventTarget {
	continuous: boolean;
	interimResults: boolean;
	lang: string;
	maxAlternatives: number;
	onaudioend: ((this: SpeechRecognition, ev: Event) => void) | null;
	onaudiostart: ((this: SpeechRecognition, ev: Event) => void) | null;
	onend: ((this: SpeechRecognition, ev: Event) => void) | null;
	onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null;
	onnomatch: ((this: SpeechRecognition, ev: Event) => void) | null;
	onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null;
	onsoundend: ((this: SpeechRecognition, ev: Event) => void) | null;
	onsoundstart: ((this: SpeechRecognition, ev: Event) => void) | null;
	onspeechend: ((this: SpeechRecognition, ev: Event) => void) | null;
	onspeechstart: ((this: SpeechRecognition, ev: Event) => void) | null;
	onstart: ((this: SpeechRecognition, ev: Event) => void) | null;
	abort(): void;
	start(): void;
	stop(): void;
}

export interface SpeechRecognitionConstructor {
	new (): SpeechRecognition;
}

declare global {
	interface Window {
		SpeechRecognition?: SpeechRecognitionConstructor;
		webkitSpeechRecognition?: SpeechRecognitionConstructor;
	}
}

/**
 * Check if speech recognition is supported in the current browser
 */
export function isSpeechRecognitionSupported(): boolean {
	return (
		typeof window !== 'undefined' &&
		(!!window.SpeechRecognition || !!window.webkitSpeechRecognition)
	);
}

/**
 * Get the SpeechRecognition constructor (with vendor prefix fallback)
 */
export function getSpeechRecognition(): SpeechRecognitionConstructor | null {
	if (typeof window === 'undefined') return null;
	return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

/**
 * Trigger haptic feedback using the Vibration API
 * Uses short vibrations for tactile confirmation on mobile devices
 *
 * @param pattern - Vibration pattern in milliseconds or single duration
 *   - 'light' (10ms) - subtle tap for button presses
 *   - 'medium' (25ms) - standard confirmation feedback
 *   - 'strong' (50ms) - important action confirmation
 *   - number - custom duration in milliseconds
 */
function triggerHapticFeedback(pattern: 'light' | 'medium' | 'strong' | number = 'medium'): void {
	if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
		const duration =
			pattern === 'light' ? 10 : pattern === 'medium' ? 25 : pattern === 'strong' ? 50 : pattern;

		try {
			navigator.vibrate(duration);
		} catch {
			// Silently fail if vibration is not allowed (e.g., permissions, battery saver)
		}
	}
}

/** Options for configuring voice input behavior */
export interface UseVoiceInputOptions {
	/** Current text input value to append transcription to */
	currentValue: string;
	/** Whether voice input should be disabled */
	disabled?: boolean;
	/** Callback when transcription text changes */
	onTranscriptionChange: (newValue: string) => void;
	/** Ref to focus after voice input ends */
	focusRef?: React.RefObject<HTMLTextAreaElement | HTMLInputElement>;
}

/** Return value from useVoiceInput hook */
export interface UseVoiceInputReturn {
	/** Whether currently listening for voice input */
	isListening: boolean;
	/** Whether voice input is supported in the current browser */
	voiceSupported: boolean;
	/** Start voice input */
	startVoiceInput: () => void;
	/** Stop voice input */
	stopVoiceInput: () => void;
	/** Toggle voice input on/off */
	toggleVoiceInput: () => void;
}

/**
 * Hook for voice input using Web Speech API
 *
 * @param options - Configuration options
 * @returns Voice input state and handlers
 *
 * @example
 * ```tsx
 * const { isListening, voiceSupported, toggleVoiceInput } = useVoiceInput({
 *   currentValue: inputValue,
 *   onTranscriptionChange: setInputValue,
 *   focusRef: textareaRef,
 * });
 *
 * if (voiceSupported) {
 *   return (
 *     <button onClick={toggleVoiceInput}>
 *       {isListening ? 'Stop' : 'Start'} Voice Input
 *     </button>
 *   );
 * }
 * ```
 */
export function useVoiceInput({
	currentValue,
	disabled = false,
	onTranscriptionChange,
	focusRef,
}: UseVoiceInputOptions): UseVoiceInputReturn {
	// Voice input state
	const [isListening, setIsListening] = useState(false);
	const [voiceSupported] = useState(() => isSpeechRecognitionSupported());
	const recognitionRef = useRef<SpeechRecognition | null>(null);

	/**
	 * Initialize speech recognition when voice input starts
	 */
	const startVoiceInput = useCallback(() => {
		if (!voiceSupported || disabled) return;

		const SpeechRecognitionClass = getSpeechRecognition();
		if (!SpeechRecognitionClass) return;

		// Create new recognition instance
		const recognition = new SpeechRecognitionClass();
		recognition.continuous = false;
		recognition.interimResults = true;
		recognition.lang = navigator.language || 'en-US';
		recognition.maxAlternatives = 1;

		// Store reference for cleanup
		recognitionRef.current = recognition;

		// Track interim results to update input in real-time
		let finalTranscript = '';

		recognition.onstart = () => {
			setIsListening(true);
			triggerHapticFeedback('medium');
		};

		recognition.onresult = (event: SpeechRecognitionEvent) => {
			let interimTranscript = '';

			for (let i = event.resultIndex; i < event.results.length; i++) {
				const result = event.results[i];
				if (result.isFinal) {
					finalTranscript += result[0].transcript;
				} else {
					interimTranscript += result[0].transcript;
				}
			}

			// Update input with current transcription (append to existing value)
			const currentText = currentValue.trim();
			const separator = currentText ? ' ' : '';
			const newText = currentText + separator + (finalTranscript || interimTranscript);

			onTranscriptionChange(newText);
		};

		recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
			webLogger.warn('Speech recognition error', 'VoiceInput', event.error);
			setIsListening(false);
			recognitionRef.current = null;

			// Haptic feedback on error
			if (event.error !== 'aborted' && event.error !== 'no-speech') {
				triggerHapticFeedback('strong');
			}
		};

		recognition.onend = () => {
			setIsListening(false);
			recognitionRef.current = null;
			triggerHapticFeedback('light');

			// Focus input after voice input ends
			focusRef?.current?.focus();
		};

		try {
			recognition.start();
		} catch (err) {
			webLogger.warn('Failed to start speech recognition', 'VoiceInput', err);
			setIsListening(false);
			recognitionRef.current = null;
		}
	}, [voiceSupported, disabled, currentValue, onTranscriptionChange, focusRef]);

	/**
	 * Stop voice input
	 */
	const stopVoiceInput = useCallback(() => {
		if (recognitionRef.current) {
			try {
				recognitionRef.current.stop();
			} catch {
				// Ignore errors when stopping
			}
			recognitionRef.current = null;
		}
		setIsListening(false);
	}, []);

	/**
	 * Toggle voice input on/off
	 */
	const toggleVoiceInput = useCallback(() => {
		if (isListening) {
			stopVoiceInput();
		} else {
			startVoiceInput();
		}
	}, [isListening, startVoiceInput, stopVoiceInput]);

	/**
	 * Cleanup recognition on unmount
	 */
	useEffect(() => {
		return () => {
			if (recognitionRef.current) {
				try {
					recognitionRef.current.abort();
				} catch {
					// Ignore errors during cleanup
				}
			}
		};
	}, []);

	return {
		isListening,
		voiceSupported,
		startVoiceInput,
		stopVoiceInput,
		toggleVoiceInput,
	};
}

export default useVoiceInput;
