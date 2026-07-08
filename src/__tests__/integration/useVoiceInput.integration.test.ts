import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	getSpeechRecognition,
	isSpeechRecognitionSupported,
	triggerHapticFeedback,
	useVoiceInput,
	type SpeechRecognitionErrorEvent,
	type SpeechRecognitionEvent,
	type SpeechRecognitionResultList,
} from '../../web/hooks/useVoiceInput';
import { webLogger } from '../../web/utils/logger';

vi.mock('../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

let lastRecognitionInstance: MockSpeechRecognition | null = null;
const originalNavigatorLanguage = navigator.language;

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

class ThrowingStartSpeechRecognition extends MockSpeechRecognition {
	start = vi.fn(() => {
		throw new Error('microphone blocked');
	});
}

function setSpeechRecognitionAvailable(
	Ctor: typeof MockSpeechRecognition = MockSpeechRecognition,
	property: 'SpeechRecognition' | 'webkitSpeechRecognition' = 'SpeechRecognition'
) {
	clearSpeechRecognition();
	Object.defineProperty(window, 'SpeechRecognition', {
		value: property === 'SpeechRecognition' ? Ctor : undefined,
		configurable: true,
		writable: true,
	});
	Object.defineProperty(window, 'webkitSpeechRecognition', {
		value: property === 'webkitSpeechRecognition' ? Ctor : undefined,
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

function setVibrate(vibrate: ((pattern: number) => boolean) | undefined) {
	if (vibrate) {
		Object.defineProperty(navigator, 'vibrate', {
			value: vibrate,
			configurable: true,
			writable: true,
		});
		return;
	}

	Reflect.deleteProperty(navigator, 'vibrate');
}

function setNavigatorLanguage(language: string) {
	Object.defineProperty(navigator, 'language', {
		value: language,
		configurable: true,
	});
}

function createSpeechEvent(
	transcripts: Array<{ transcript: string; isFinal: boolean }>,
	resultIndex = 0
): SpeechRecognitionEvent {
	const results = transcripts.map(({ transcript, isFinal }) => {
		const alt = { transcript, confidence: 0.9 };
		return {
			isFinal,
			length: 1,
			0: alt,
			item: () => alt,
		};
	}) as unknown as SpeechRecognitionResultList;
	(results as { item?: (index: number) => unknown }).item = (index: number) => results[index];

	return {
		resultIndex,
		results,
	} as SpeechRecognitionEvent;
}

describe('useVoiceInput integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		setSpeechRecognitionAvailable();
		setNavigatorLanguage(originalNavigatorLanguage);
		setVibrate(undefined);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		clearSpeechRecognition();
		setNavigatorLanguage(originalNavigatorLanguage);
		setVibrate(undefined);
	});

	it('detects support, constructor fallbacks, and unavailable window state', () => {
		expect(isSpeechRecognitionSupported()).toBe(true);
		expect(getSpeechRecognition()).toBe(MockSpeechRecognition);

		setSpeechRecognitionAvailable(MockSpeechRecognition, 'webkitSpeechRecognition');
		expect(isSpeechRecognitionSupported()).toBe(true);
		expect(getSpeechRecognition()).toBe(MockSpeechRecognition);

		clearSpeechRecognition();
		expect(isSpeechRecognitionSupported()).toBe(false);
		expect(getSpeechRecognition()).toBeNull();

		vi.stubGlobal('window', undefined);
		expect(isSpeechRecognitionSupported()).toBe(false);
		expect(getSpeechRecognition()).toBeNull();
	});

	it('maps haptic feedback patterns and ignores blocked vibration', () => {
		const vibrate = vi.fn();
		setVibrate(vibrate);

		triggerHapticFeedback('light');
		triggerHapticFeedback('medium');
		triggerHapticFeedback('strong');
		triggerHapticFeedback(75);

		expect(vibrate.mock.calls).toEqual([[10], [25], [50], [75]]);

		vibrate.mockImplementationOnce(() => {
			throw new Error('blocked');
		});

		expect(() => triggerHapticFeedback('medium')).not.toThrow();

		setVibrate(undefined);
		expect(() => triggerHapticFeedback('light')).not.toThrow();
	});

	it('starts listening and updates final and interim transcription', () => {
		const onTranscriptionChange = vi.fn();
		setNavigatorLanguage('');

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
		expect(lastRecognitionInstance?.lang).toBe('en-US');

		act(() => {
			lastRecognitionInstance?.onresult?.call(
				lastRecognitionInstance,
				createSpeechEvent([{ transcript: 'draft', isFinal: false }])
			);
		});

		expect(onTranscriptionChange).toHaveBeenCalledWith('hello draft');

		act(() => {
			lastRecognitionInstance?.onresult?.call(
				lastRecognitionInstance,
				createSpeechEvent([{ transcript: 'world', isFinal: true }])
			);
		});

		expect(onTranscriptionChange).toHaveBeenLastCalledWith('hello world');

		const blankInputChange = vi.fn();
		const blankHook = renderHook(() =>
			useVoiceInput({
				currentValue: '  ',
				onTranscriptionChange: blankInputChange,
			})
		);

		act(() => blankHook.result.current.startVoiceInput());
		act(() => {
			lastRecognitionInstance?.onresult?.call(
				lastRecognitionInstance,
				createSpeechEvent([{ transcript: 'solo', isFinal: true }])
			);
		});

		expect(blankInputChange).toHaveBeenCalledWith('solo');
	});

	it('does not start when disabled, unsupported, or missing at start time', () => {
		const onTranscriptionChange = vi.fn();
		const disabledHook = renderHook(() =>
			useVoiceInput({ currentValue: '', disabled: true, onTranscriptionChange })
		);

		act(() => disabledHook.result.current.startVoiceInput());
		expect(lastRecognitionInstance).toBeNull();

		clearSpeechRecognition();
		const unsupportedHook = renderHook(() =>
			useVoiceInput({ currentValue: '', onTranscriptionChange })
		);

		expect(unsupportedHook.result.current.voiceSupported).toBe(false);
		act(() => unsupportedHook.result.current.startVoiceInput());
		expect(lastRecognitionInstance).toBeNull();

		setSpeechRecognitionAvailable();
		const missingAtStartHook = renderHook(() =>
			useVoiceInput({ currentValue: '', onTranscriptionChange })
		);
		clearSpeechRecognition();

		act(() => missingAtStartHook.result.current.startVoiceInput());
		expect(lastRecognitionInstance).toBeNull();
	});

	it('logs start failures and handles recognition errors with selective strong haptics', () => {
		const onTranscriptionChange = vi.fn();
		const vibrate = vi.fn();
		setVibrate(vibrate);
		setSpeechRecognitionAvailable(ThrowingStartSpeechRecognition);

		const failingHook = renderHook(() =>
			useVoiceInput({ currentValue: '', onTranscriptionChange })
		);

		act(() => failingHook.result.current.startVoiceInput());

		expect(failingHook.result.current.isListening).toBe(false);
		expect(webLogger.warn).toHaveBeenCalledWith(
			'Failed to start speech recognition',
			'VoiceInput',
			expect.any(Error)
		);

		setSpeechRecognitionAvailable();
		const { result } = renderHook(() => useVoiceInput({ currentValue: '', onTranscriptionChange }));

		act(() => result.current.startVoiceInput());
		act(() => {
			lastRecognitionInstance?.onerror?.call(lastRecognitionInstance, {
				error: 'aborted',
				message: 'aborted',
			} as SpeechRecognitionErrorEvent);
		});
		expect(vibrate).not.toHaveBeenCalledWith(50);

		act(() => result.current.startVoiceInput());
		act(() => {
			lastRecognitionInstance?.onerror?.call(lastRecognitionInstance, {
				error: 'network',
				message: 'offline',
			} as SpeechRecognitionErrorEvent);
		});

		expect(vibrate).toHaveBeenCalledWith(50);
		expect(webLogger.warn).toHaveBeenCalledWith(
			'Speech recognition error',
			'VoiceInput',
			'network'
		);
	});

	it('stops, toggles, and ignores stop failures', () => {
		const onTranscriptionChange = vi.fn();
		const { result } = renderHook(() => useVoiceInput({ currentValue: '', onTranscriptionChange }));

		act(() => result.current.stopVoiceInput());
		expect(result.current.isListening).toBe(false);

		act(() => result.current.toggleVoiceInput());
		const recognition = lastRecognitionInstance;
		expect(result.current.isListening).toBe(true);

		act(() => result.current.toggleVoiceInput());
		expect(recognition?.stop).toHaveBeenCalled();
		expect(result.current.isListening).toBe(false);

		act(() => result.current.startVoiceInput());
		const throwingRecognition = lastRecognitionInstance;
		throwingRecognition?.stop.mockImplementationOnce(() => {
			throw new Error('already stopped');
		});

		expect(() => {
			act(() => result.current.stopVoiceInput());
		}).not.toThrow();
	});

	it('focuses after end and aborts recognition on unmount while ignoring abort failures', () => {
		const onTranscriptionChange = vi.fn();
		const focus = vi.fn();
		const focusRef = { current: { focus } as unknown as HTMLTextAreaElement };
		const { result, unmount } = renderHook(() =>
			useVoiceInput({ currentValue: '', onTranscriptionChange, focusRef })
		);

		act(() => result.current.startVoiceInput());
		act(() => {
			lastRecognitionInstance?.onend?.call(lastRecognitionInstance, new Event('end'));
		});

		expect(focus).toHaveBeenCalledTimes(1);

		act(() => result.current.startVoiceInput());
		const recognition = lastRecognitionInstance;
		unmount();

		expect(recognition?.abort).toHaveBeenCalled();

		const secondHook = renderHook(() => useVoiceInput({ currentValue: '', onTranscriptionChange }));
		act(() => secondHook.result.current.startVoiceInput());
		lastRecognitionInstance?.abort.mockImplementationOnce(() => {
			throw new Error('already aborted');
		});

		expect(() => secondHook.unmount()).not.toThrow();
	});
});
