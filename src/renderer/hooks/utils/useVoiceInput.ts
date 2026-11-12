/**
 * useVoiceInput - voice-to-text via the Web Speech API
 *
 * Provides speech-to-text for the AI input on touch devices. Uses
 * `SpeechRecognition` (with the `webkitSpeechRecognition` vendor fallback),
 * streams interim results so the draft updates live, and appends the final
 * transcript to the current input value.
 *
 * Ported from the legacy mobile app at `src/web/hooks/useVoiceInput.ts`. Two
 * adaptations for the renderer: the `webLogger` import becomes the renderer
 * `logger`, and the private haptics helper is replaced by the canonical
 * `triggerHaptic` / `HAPTIC_PATTERNS` in `src/renderer/utils/touch.ts`. The Web
 * Speech typings stay local (self-contained) but are read off `window` via a
 * cast instead of a global `Window` augmentation, so this coexists with the
 * legacy hook's own `declare global` in the same TypeScript program.
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import { logger } from '../../utils/logger';
import { triggerHaptic, HAPTIC_PATTERNS } from '../../utils/touch';

/**
 * Web Speech API type declarations. TypeScript's lib.dom does not ship these,
 * so the hook carries its own.
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

/** Shape of the two optional constructors the browser may expose on `window`. */
interface SpeechRecognitionWindow {
	SpeechRecognition?: SpeechRecognitionConstructor;
	webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

/**
 * Check if speech recognition is supported in the current browser.
 */
export function isSpeechRecognitionSupported(): boolean {
	if (typeof window === 'undefined') return false;
	const w = window as unknown as SpeechRecognitionWindow;
	return !!w.SpeechRecognition || !!w.webkitSpeechRecognition;
}

/**
 * Get the SpeechRecognition constructor (with vendor prefix fallback).
 */
export function getSpeechRecognition(): SpeechRecognitionConstructor | null {
	if (typeof window === 'undefined') return null;
	const w = window as unknown as SpeechRecognitionWindow;
	return w.SpeechRecognition || w.webkitSpeechRecognition || null;
}

/** Options for configuring voice input behavior. */
export interface UseVoiceInputOptions {
	/** Current text input value to append transcription to. */
	currentValue: string;
	/** Whether voice input should be disabled. */
	disabled?: boolean;
	/** Callback when transcription text changes. */
	onTranscriptionChange: (newValue: string) => void;
	/** Ref to focus after voice input ends. */
	focusRef?: React.RefObject<HTMLTextAreaElement | HTMLInputElement>;
}

/** Return value from useVoiceInput. */
export interface UseVoiceInputReturn {
	/** Whether currently listening for voice input. */
	isListening: boolean;
	/** Whether voice input is supported in the current browser. */
	voiceSupported: boolean;
	/** Start voice input. */
	startVoiceInput: () => void;
	/** Stop voice input. */
	stopVoiceInput: () => void;
	/** Toggle voice input on/off. */
	toggleVoiceInput: () => void;
}

/**
 * Hook for voice input using the Web Speech API.
 *
 * @param options - Configuration options.
 * @returns Voice input state and handlers.
 *
 * @example
 * ```tsx
 * const { isListening, voiceSupported, toggleVoiceInput } = useVoiceInput({
 *   currentValue: inputValue,
 *   onTranscriptionChange: setInputValue,
 *   focusRef: textareaRef,
 * });
 * ```
 */
export function useVoiceInput({
	currentValue,
	disabled = false,
	onTranscriptionChange,
	focusRef,
}: UseVoiceInputOptions): UseVoiceInputReturn {
	const [isListening, setIsListening] = useState(false);
	const [voiceSupported] = useState(() => isSpeechRecognitionSupported());
	const recognitionRef = useRef<SpeechRecognition | null>(null);

	/** Initialize speech recognition when voice input starts. */
	const startVoiceInput = useCallback(() => {
		if (!voiceSupported || disabled) return;

		const SpeechRecognitionClass = getSpeechRecognition();
		if (!SpeechRecognitionClass) return;

		const recognition = new SpeechRecognitionClass();
		recognition.continuous = false;
		recognition.interimResults = true;
		recognition.lang = navigator.language || 'en-US';
		recognition.maxAlternatives = 1;

		recognitionRef.current = recognition;

		// Track final results across onresult calls so interim text can be
		// re-rendered on top of the settled transcript.
		let finalTranscript = '';

		recognition.onstart = () => {
			setIsListening(true);
			triggerHaptic(HAPTIC_PATTERNS.send);
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

			// Append the live transcription to the value captured when listening
			// started (currentValue is fixed in this closure), separated by a space.
			const currentText = currentValue.trim();
			const separator = currentText ? ' ' : '';
			const newText = currentText + separator + (finalTranscript || interimTranscript);

			onTranscriptionChange(newText);
		};

		recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
			logger.warn('Speech recognition error', 'VoiceInput', event.error);
			setIsListening(false);
			recognitionRef.current = null;

			// Haptic feedback on a genuine error (not a benign abort / silence).
			if (event.error !== 'aborted' && event.error !== 'no-speech') {
				triggerHaptic(HAPTIC_PATTERNS.error);
			}
		};

		recognition.onend = () => {
			setIsListening(false);
			recognitionRef.current = null;
			triggerHaptic(HAPTIC_PATTERNS.tap);

			// Return focus to the input after dictation ends.
			focusRef?.current?.focus();
		};

		try {
			recognition.start();
		} catch (err) {
			logger.warn('Failed to start speech recognition', 'VoiceInput', err);
			setIsListening(false);
			recognitionRef.current = null;
		}
	}, [voiceSupported, disabled, currentValue, onTranscriptionChange, focusRef]);

	/** Stop voice input. */
	const stopVoiceInput = useCallback(() => {
		if (recognitionRef.current) {
			try {
				recognitionRef.current.stop();
			} catch {
				// Ignore errors when stopping.
			}
			recognitionRef.current = null;
		}
		setIsListening(false);
	}, []);

	/** Toggle voice input on/off. */
	const toggleVoiceInput = useCallback(() => {
		if (isListening) {
			stopVoiceInput();
		} else {
			startVoiceInput();
		}
	}, [isListening, startVoiceInput, stopVoiceInput]);

	/** Cleanup recognition on unmount. */
	useEffect(() => {
		return () => {
			if (recognitionRef.current) {
				try {
					recognitionRef.current.abort();
				} catch {
					// Ignore errors during cleanup.
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
