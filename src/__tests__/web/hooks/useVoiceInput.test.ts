/**
 * Tests for useVoiceInput hook
 *
 * Covers:
 * - Speech recognition support detection
 * - Start/stop listening flow
 * - Transcription updates from recognition results
 * - Cleanup on unmount
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useVoiceInput,
	isSpeechRecognitionSupported,
	type SpeechRecognitionEvent,
	type SpeechRecognitionResultList,
} from '../../../web/hooks/useVoiceInput';

vi.mock('../../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
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
	onerror = null;
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
	lastRecognitionInstance = null;
}

describe('useVoiceInput', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setSpeechRecognitionAvailable();
	});

	afterEach(() => {
		clearSpeechRecognition();
	});

	it('detects speech recognition support', () => {
		expect(isSpeechRecognitionSupported()).toBe(true);
	});

	it('starts listening and updates transcription', () => {
		const onTranscriptionChange = vi.fn();

		const { result } = renderHook(() =>
			useVoiceInput({
				currentValue: 'hello',
				onTranscriptionChange,
			})
		);

		act(() => {
			result.current.startVoiceInput();
		});

		expect(result.current.isListening).toBe(true);
		expect(lastRecognitionInstance?.start).toHaveBeenCalled();

		const alt = { transcript: 'world', confidence: 0.9 };
		const mockResult = {
			isFinal: true,
			length: 1,
			0: alt,
			item: () => alt,
		};
		const mockResults = [mockResult] as unknown as SpeechRecognitionResultList;
		(mockResults as { item?: (index: number) => unknown }).item = (index: number) =>
			mockResults[index];

		act(() => {
			lastRecognitionInstance?.onresult?.call(lastRecognitionInstance, {
				resultIndex: 0,
				results: mockResults,
			} as SpeechRecognitionEvent);
		});

		expect(onTranscriptionChange).toHaveBeenCalledWith('hello world');
	});

	it('stops listening when toggled off', () => {
		const onTranscriptionChange = vi.fn();

		const { result } = renderHook(() =>
			useVoiceInput({
				currentValue: '',
				onTranscriptionChange,
			})
		);

		act(() => {
			result.current.startVoiceInput();
		});

		act(() => {
			result.current.stopVoiceInput();
		});

		expect(lastRecognitionInstance?.stop).toHaveBeenCalled();
		expect(result.current.isListening).toBe(false);
	});

	it('aborts recognition on unmount', () => {
		const onTranscriptionChange = vi.fn();

		const { result, unmount } = renderHook(() =>
			useVoiceInput({
				currentValue: '',
				onTranscriptionChange,
			})
		);

		act(() => {
			result.current.startVoiceInput();
		});

		unmount();

		expect(lastRecognitionInstance?.abort).toHaveBeenCalled();
	});
});
