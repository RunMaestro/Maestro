/**
 * Tests for useVoiceInput.ts (renderer port)
 *
 * Covers:
 * - Speech recognition support detection (+ vendor-prefix fallback)
 * - Start/stop/toggle listening flow
 * - Interim + final transcription updates appended to the current value
 * - disabled guard
 * - onend focus + onerror logging
 * - Cleanup (abort) on unmount
 *
 * Drives a mock SpeechRecognition (see docs/agent-guides/TEST-PATTERNS.md).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useVoiceInput,
	isSpeechRecognitionSupported,
	getSpeechRecognition,
	type SpeechRecognitionEvent,
	type SpeechRecognitionResultList,
	type SpeechRecognitionErrorEvent,
} from '../../../renderer/hooks/utils/useVoiceInput';

// Mock the renderer logger so onerror/onstart-failure warnings don't hit the IPC bridge.
const mockLoggerWarn = vi.fn();
vi.mock('../../../renderer/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: (...args: unknown[]) => mockLoggerWarn(...args),
		error: vi.fn(),
	},
}));

let lastRecognitionInstance: MockSpeechRecognition | null = null;

class MockSpeechRecognition {
	continuous = false;
	interimResults = false;
	lang = '';
	maxAlternatives = 1;
	onaudioend = null;
	onaudiostart = null;
	onend: ((this: MockSpeechRecognition, ev: Event) => void) | null = null;
	onerror: ((this: MockSpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null = null;
	onnomatch = null;
	onresult: ((this: MockSpeechRecognition, ev: SpeechRecognitionEvent) => void) | null = null;
	onsoundend = null;
	onsoundstart = null;
	onspeechend = null;
	onspeechstart = null;
	onstart: ((this: MockSpeechRecognition, ev: Event) => void) | null = null;

	start = vi.fn(() => {
		this.onstart?.call(this, new Event('start'));
	});

	stop = vi.fn(() => {
		this.onend?.call(this, new Event('end'));
	});

	abort = vi.fn();

	constructor() {
		lastRecognitionInstance = this;
	}
}

/** Build a SpeechRecognitionResultList holding a single result. */
function makeResults(transcript: string, isFinal: boolean): SpeechRecognitionResultList {
	const alt = { transcript, confidence: 0.9 };
	const result = { isFinal, length: 1, 0: alt, item: () => alt };
	const results = [result] as unknown as SpeechRecognitionResultList;
	(results as { item?: (index: number) => unknown }).item = (index: number) => results[index];
	return results;
}

function setSpeechRecognitionAvailable() {
	Object.defineProperty(window, 'SpeechRecognition', {
		value: MockSpeechRecognition,
		configurable: true,
		writable: true,
	});
}

function clearSpeechRecognition() {
	Object.defineProperty(window, 'SpeechRecognition', {
		value: undefined,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(window, 'webkitSpeechRecognition', {
		value: undefined,
		configurable: true,
		writable: true,
	});
	lastRecognitionInstance = null;
}

describe('useVoiceInput (renderer)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setSpeechRecognitionAvailable();
	});

	afterEach(() => {
		clearSpeechRecognition();
	});

	it('detects speech recognition support', () => {
		expect(isSpeechRecognitionSupported()).toBe(true);
		clearSpeechRecognition();
		expect(isSpeechRecognitionSupported()).toBe(false);
	});

	it('falls back to the webkit-prefixed constructor', () => {
		clearSpeechRecognition();
		Object.defineProperty(window, 'webkitSpeechRecognition', {
			value: MockSpeechRecognition,
			configurable: true,
			writable: true,
		});
		expect(isSpeechRecognitionSupported()).toBe(true);
		expect(getSpeechRecognition()).toBe(MockSpeechRecognition);
	});

	it('starts listening and appends the final transcript to the current value', () => {
		const onTranscriptionChange = vi.fn();

		const { result } = renderHook(() =>
			useVoiceInput({ currentValue: 'hello', onTranscriptionChange })
		);

		act(() => {
			result.current.startVoiceInput();
		});

		expect(result.current.isListening).toBe(true);
		expect(lastRecognitionInstance?.start).toHaveBeenCalled();
		// interimResults must be on so the draft updates live.
		expect(lastRecognitionInstance?.interimResults).toBe(true);

		act(() => {
			lastRecognitionInstance?.onresult?.call(lastRecognitionInstance, {
				resultIndex: 0,
				results: makeResults('world', true),
			} as SpeechRecognitionEvent);
		});

		expect(onTranscriptionChange).toHaveBeenCalledWith('hello world');
	});

	it('live-updates the draft with interim (non-final) results', () => {
		const onTranscriptionChange = vi.fn();

		const { result } = renderHook(() => useVoiceInput({ currentValue: '', onTranscriptionChange }));

		act(() => {
			result.current.startVoiceInput();
		});

		act(() => {
			lastRecognitionInstance?.onresult?.call(lastRecognitionInstance, {
				resultIndex: 0,
				results: makeResults('typing', false),
			} as SpeechRecognitionEvent);
		});

		// Empty current value -> no leading space.
		expect(onTranscriptionChange).toHaveBeenCalledWith('typing');
	});

	it('toggles listening on and off', () => {
		const onTranscriptionChange = vi.fn();

		const { result } = renderHook(() => useVoiceInput({ currentValue: '', onTranscriptionChange }));

		act(() => {
			result.current.toggleVoiceInput();
		});
		expect(result.current.isListening).toBe(true);

		act(() => {
			result.current.toggleVoiceInput();
		});
		expect(lastRecognitionInstance?.stop).toHaveBeenCalled();
		expect(result.current.isListening).toBe(false);
	});

	it('does not start when disabled', () => {
		const onTranscriptionChange = vi.fn();

		const { result } = renderHook(() =>
			useVoiceInput({ currentValue: '', onTranscriptionChange, disabled: true })
		);

		act(() => {
			result.current.startVoiceInput();
		});

		expect(result.current.isListening).toBe(false);
		expect(lastRecognitionInstance).toBeNull();
	});

	it('focuses the input and stops listening on recognition end', () => {
		const onTranscriptionChange = vi.fn();
		const focus = vi.fn();
		const focusRef = { current: { focus } as unknown as HTMLTextAreaElement };

		const { result } = renderHook(() =>
			useVoiceInput({ currentValue: '', onTranscriptionChange, focusRef })
		);

		act(() => {
			result.current.startVoiceInput();
		});
		act(() => {
			lastRecognitionInstance?.onend?.call(lastRecognitionInstance, new Event('end'));
		});

		expect(result.current.isListening).toBe(false);
		expect(focus).toHaveBeenCalled();
	});

	it('logs and stops listening on recognition error', () => {
		const onTranscriptionChange = vi.fn();

		const { result } = renderHook(() => useVoiceInput({ currentValue: '', onTranscriptionChange }));

		act(() => {
			result.current.startVoiceInput();
		});
		act(() => {
			lastRecognitionInstance?.onerror?.call(lastRecognitionInstance, {
				error: 'network',
				message: '',
			} as SpeechRecognitionErrorEvent);
		});

		expect(result.current.isListening).toBe(false);
		expect(mockLoggerWarn).toHaveBeenCalledWith(
			'Speech recognition error',
			'VoiceInput',
			'network'
		);
	});

	it('reports voiceSupported=false and never starts when the API is missing', () => {
		clearSpeechRecognition();
		const onTranscriptionChange = vi.fn();

		const { result } = renderHook(() => useVoiceInput({ currentValue: '', onTranscriptionChange }));

		expect(result.current.voiceSupported).toBe(false);

		act(() => {
			result.current.startVoiceInput();
		});
		expect(result.current.isListening).toBe(false);
		expect(lastRecognitionInstance).toBeNull();
	});

	it('aborts recognition on unmount', () => {
		const onTranscriptionChange = vi.fn();

		const { result, unmount } = renderHook(() =>
			useVoiceInput({ currentValue: '', onTranscriptionChange })
		);

		act(() => {
			result.current.startVoiceInput();
		});

		unmount();

		expect(lastRecognitionInstance?.abort).toHaveBeenCalled();
	});
});
