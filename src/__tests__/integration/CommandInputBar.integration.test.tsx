import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ThemeProvider } from '../../web/components/ThemeProvider';
import { CommandInputBar, type CommandInputBarProps } from '../../web/mobile/CommandInputBar';
import type { CommandHistoryEntry } from '../../web/hooks/useCommandHistory';
import type {
	SpeechRecognition,
	SpeechRecognitionErrorEvent,
	SpeechRecognitionEvent,
} from '../../web/hooks/useVoiceInput';

vi.mock('../../web/utils/logger', () => ({
	webLogger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

type MutableViewport = VisualViewport & {
	emit: (type: 'resize' | 'scroll') => void;
	setGeometry: (geometry: Partial<Pick<VisualViewport, 'height' | 'offsetTop'>>) => void;
};

class FakeSpeechRecognition implements SpeechRecognition {
	static latest: FakeSpeechRecognition | null = null;

	continuous = false;
	interimResults = false;
	lang = 'en-US';
	maxAlternatives = 1;
	onaudioend: ((this: SpeechRecognition, ev: Event) => void) | null = null;
	onaudiostart: ((this: SpeechRecognition, ev: Event) => void) | null = null;
	onend: ((this: SpeechRecognition, ev: Event) => void) | null = null;
	onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null = null;
	onnomatch: ((this: SpeechRecognition, ev: Event) => void) | null = null;
	onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null = null;
	onsoundend: ((this: SpeechRecognition, ev: Event) => void) | null = null;
	onsoundstart: ((this: SpeechRecognition, ev: Event) => void) | null = null;
	onspeechend: ((this: SpeechRecognition, ev: Event) => void) | null = null;
	onspeechstart: ((this: SpeechRecognition, ev: Event) => void) | null = null;
	onstart: ((this: SpeechRecognition, ev: Event) => void) | null = null;

	private readonly eventTarget = new EventTarget();

	constructor() {
		FakeSpeechRecognition.latest = this;
	}

	addEventListener: EventTarget['addEventListener'] = (...args) =>
		this.eventTarget.addEventListener(...args);
	removeEventListener: EventTarget['removeEventListener'] = (...args) =>
		this.eventTarget.removeEventListener(...args);
	dispatchEvent: EventTarget['dispatchEvent'] = (...args) =>
		this.eventTarget.dispatchEvent(...args);

	abort = vi.fn();
	start = vi.fn();
	stop = vi.fn();
}

const defaultProps: CommandInputBarProps = {
	isOffline: false,
	isConnected: true,
};

function renderBar(overrides: Partial<CommandInputBarProps> = {}) {
	return render(
		<ThemeProvider>
			<CommandInputBar {...defaultProps} {...overrides} />
		</ThemeProvider>
	);
}

function historyEntry(id: string, command: string, mode: 'ai' | 'terminal' = 'ai') {
	return {
		id,
		command,
		mode,
		timestamp: Date.UTC(2026, 0, 1, 12, Number(id.replace(/\D/g, '')) || 0),
	} satisfies CommandHistoryEntry;
}

function setWindowSize(width: number, height = 800) {
	Object.defineProperty(window, 'innerWidth', {
		configurable: true,
		writable: true,
		value: width,
	});
	Object.defineProperty(window, 'innerHeight', {
		configurable: true,
		writable: true,
		value: height,
	});
}

function installVisualViewport(height = 800, offsetTop = 0): MutableViewport {
	const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
	let currentHeight = height;
	let currentOffsetTop = offsetTop;

	const viewport = {
		get height() {
			return currentHeight;
		},
		width: window.innerWidth,
		get offsetTop() {
			return currentOffsetTop;
		},
		offsetLeft: 0,
		pageTop: 0,
		pageLeft: 0,
		scale: 1,
		onresize: null,
		onscroll: null,
		addEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
			const registered = listeners.get(type) ?? new Set();
			registered.add(listener);
			listeners.set(type, registered);
		}),
		removeEventListener: vi.fn((type: string, listener: EventListenerOrEventListenerObject) => {
			listeners.get(type)?.delete(listener);
		}),
		dispatchEvent: vi.fn((event: Event) => {
			listeners.get(event.type)?.forEach((listener) => {
				if (typeof listener === 'function') {
					listener(event);
				} else {
					listener.handleEvent(event);
				}
			});
			return true;
		}),
		emit(type: 'resize' | 'scroll') {
			this.dispatchEvent(new Event(type));
		},
		setGeometry(geometry: Partial<Pick<VisualViewport, 'height' | 'offsetTop'>>) {
			if (geometry.height !== undefined) currentHeight = geometry.height;
			if (geometry.offsetTop !== undefined) currentOffsetTop = geometry.offsetTop;
		},
	} as MutableViewport;

	Object.defineProperty(window, 'visualViewport', {
		configurable: true,
		writable: true,
		value: viewport,
	});

	return viewport;
}

function speechResult(transcript: string, isFinal = false): SpeechRecognitionEvent {
	const alternative = { transcript, confidence: 1 };
	const result = {
		0: alternative,
		length: 1,
		isFinal,
		item: () => alternative,
	};
	const results = {
		0: result,
		length: 1,
		item: () => result,
	};

	return {
		resultIndex: 0,
		results,
	} as unknown as SpeechRecognitionEvent;
}

function speechError(error: string): SpeechRecognitionErrorEvent {
	return { error, message: error } as SpeechRecognitionErrorEvent;
}

describe('CommandInputBar integration', () => {
	let originalVibrate: PropertyDescriptor | undefined;
	let originalVisualViewport: PropertyDescriptor | undefined;
	let originalSpeechRecognition: typeof window.SpeechRecognition;
	let originalWebkitSpeechRecognition: typeof window.webkitSpeechRecognition;
	let vibrateSpy: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.useRealTimers();
		FakeSpeechRecognition.latest = null;
		originalVibrate = Object.getOwnPropertyDescriptor(navigator, 'vibrate');
		originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
		originalSpeechRecognition = window.SpeechRecognition;
		originalWebkitSpeechRecognition = window.webkitSpeechRecognition;
		vibrateSpy = vi.fn();
		Object.defineProperty(navigator, 'vibrate', {
			configurable: true,
			value: vibrateSpy,
		});
		setWindowSize(390);
		installVisualViewport();
		delete window.SpeechRecognition;
		delete window.webkitSpeechRecognition;
	});

	afterEach(() => {
		vi.useRealTimers();
		if (originalVibrate) {
			Object.defineProperty(navigator, 'vibrate', originalVibrate);
		} else {
			delete (navigator as Partial<Navigator>).vibrate;
		}
		if (originalVisualViewport) {
			Object.defineProperty(window, 'visualViewport', originalVisualViewport);
		} else {
			delete window.visualViewport;
		}
		window.SpeechRecognition = originalSpeechRecognition;
		window.webkitSpeechRecognition = originalWebkitSpeechRecognition;
	});

	it('submits AI drafts while handling recent commands, swipe history, and keyboard viewport changes', async () => {
		const viewport = installVisualViewport();
		const onSubmit = vi.fn();
		const onChange = vi.fn();
		const onHistoryOpen = vi.fn();
		const onSelectRecentCommand = vi.fn();

		renderBar({
			onSubmit,
			onChange,
			onHistoryOpen,
			onSelectRecentCommand,
			recentCommands: [
				historyEntry('cmd-1', 'git status'),
				historyEntry('cmd-2', 'npm run test:integration'),
			],
		});

		const historyHandle = screen.getByLabelText('Open command history');
		const root = historyHandle.parentElement as HTMLElement;
		fireEvent.click(historyHandle);
		expect(onHistoryOpen).toHaveBeenCalledTimes(1);

		fireEvent.touchStart(root, { touches: [{ clientX: 20, clientY: 220 }] });
		fireEvent.touchMove(root, { touches: [{ clientX: 22, clientY: 120 }] });
		fireEvent.touchEnd(root, { changedTouches: [{ clientX: 22, clientY: 80 }] });
		expect(onHistoryOpen).toHaveBeenCalledTimes(2);

		fireEvent.click(screen.getByRole('button', { name: /Reuse command: git status/i }));
		expect(onSelectRecentCommand).toHaveBeenCalledWith('git status');

		const input = screen.getByRole('textbox');
		fireEvent.change(input, { target: { value: '  summarize the logs  ' } });
		expect(onChange).toHaveBeenCalledWith('  summarize the logs  ');
		fireEvent.click(screen.getByRole('button', { name: /Send command/i }));
		expect(onSubmit).toHaveBeenCalledWith('summarize the logs', undefined);
		expect(vibrateSpy).toHaveBeenCalledWith(25);

		viewport.setGeometry({ height: 520 });
		act(() => viewport.emit('resize'));
		await waitFor(() => expect(root).toHaveStyle({ bottom: '280px' }));

		viewport.setGeometry({ height: 800 });
		act(() => viewport.emit('scroll'));
		expect(root).toHaveStyle({ bottom: '0px' });
	});

	it('uses the real slash command popup for filtering, Escape cleanup, and auto-submit selection', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const onSubmit = vi.fn();
		const onChange = vi.fn();
		renderBar({
			onSubmit,
			onChange,
			slashCommands: [
				{ command: '/history', description: 'Summarize history', aiOnly: true },
				{ command: '/jump', description: 'Jump in file tree', terminalOnly: true },
				{ command: '/clear', description: 'Clear output' },
			],
		});

		fireEvent.click(screen.getByRole('button', { name: 'Open slash commands' }));
		expect(screen.getByText('/history')).toBeInTheDocument();
		expect(screen.getByText('/clear')).toBeInTheDocument();
		expect(screen.queryByText('/jump')).not.toBeInTheDocument();

		fireEvent.change(screen.getByRole('textbox'), { target: { value: '/hist' } });
		expect(screen.getByText('Summarize history')).toBeInTheDocument();
		fireEvent.keyDown(document, { key: 'Escape' });
		expect(onChange).toHaveBeenLastCalledWith('');
		expect(screen.queryByText('/history')).not.toBeInTheDocument();

		fireEvent.change(screen.getByRole('textbox'), { target: { value: '/cl' } });
		fireEvent.click(screen.getByText('Clear output'));

		expect(onChange).toHaveBeenCalledWith('/clear');
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60);
		});
		expect(onSubmit).toHaveBeenCalledWith('/clear');
		expect(onChange).toHaveBeenLastCalledWith('');
	});

	it('runs terminal mode through the real prompt layout and busy AI interrupt path', () => {
		const onSubmit = vi.fn();
		const onInterrupt = vi.fn();
		const onInputBlur = vi.fn();
		const { rerender } = renderBar({
			inputMode: 'terminal',
			cwd: '/Users/tester/projects/maestro',
			onSubmit,
			onInterrupt,
			onInputBlur,
		});

		const terminalInput = screen.getByLabelText('Shell command input');
		expect(terminalInput).toHaveAttribute('placeholder', '~/projects/maestro');
		fireEvent.focus(terminalInput);
		fireEvent.blur(terminalInput);
		expect(onInputBlur).toHaveBeenCalledTimes(1);
		fireEvent.change(terminalInput, { target: { value: 'pwd' } });
		fireEvent.keyDown(terminalInput, { key: 'Enter' });
		expect(onSubmit).toHaveBeenCalledWith('pwd', undefined);

		rerender(
			<ThemeProvider>
				<CommandInputBar
					{...defaultProps}
					inputMode="ai"
					isSessionBusy
					value="next prompt"
					onSubmit={onSubmit}
					onInterrupt={onInterrupt}
				/>
			</ThemeProvider>
		);
		fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', ctrlKey: true });
		expect(onSubmit).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole('button', { name: /Cancel running command/i }));
		expect(onInterrupt).toHaveBeenCalledTimes(1);
		expect(vibrateSpy).toHaveBeenCalledWith(50);
	});

	it('shows disconnected disabled placeholders, guards disabled terminal submits, and desktop AI keyboard submit', () => {
		setWindowSize(768);
		const onSubmit = vi.fn();
		const onInputBlur = vi.fn();
		const { rerender } = renderBar({
			isOffline: true,
			value: 'blocked',
			onSubmit,
		});

		expect(screen.getByPlaceholderText('Offline...')).toBeDisabled();
		fireEvent.submit(screen.getByRole('textbox').closest('form')!);
		expect(onSubmit).not.toHaveBeenCalled();
		onSubmit.mockClear();

		rerender(
			<ThemeProvider>
				<CommandInputBar
					{...defaultProps}
					isConnected={false}
					value="blocked"
					onSubmit={onSubmit}
				/>
			</ThemeProvider>
		);
		expect(screen.getByPlaceholderText('Connecting...')).toBeDisabled();

		rerender(
			<ThemeProvider>
				<CommandInputBar
					{...defaultProps}
					inputMode="terminal"
					value=""
					disabled
					onSubmit={onSubmit}
				/>
			</ThemeProvider>
		);
		fireEvent.keyDown(screen.getByLabelText('Shell command input'), { key: 'Enter' });
		expect(onSubmit).not.toHaveBeenCalled();

		rerender(
			<ThemeProvider>
				<CommandInputBar
					{...defaultProps}
					inputMode="ai"
					value="desktop prompt"
					onSubmit={onSubmit}
					onInputBlur={onInputBlur}
				/>
			</ThemeProvider>
		);
		const aiInput = screen.getByRole('textbox');
		fireEvent.keyDown(aiInput, { key: 'Enter', metaKey: true });
		expect(onSubmit).toHaveBeenCalledWith('desktop prompt', undefined);
		fireEvent.submit(aiInput.closest('form')!);
		expect(onSubmit).toHaveBeenCalledTimes(2);
		fireEvent.blur(aiInput);
		expect(onInputBlur).toHaveBeenCalled();
	});

	it('expands the phone AI composer on focus, submits with the full-width action, and collapses on outside touch', async () => {
		const onSubmit = vi.fn();
		const { rerender } = renderBar({
			value: 'draft message',
			onSubmit,
		});

		fireEvent.focus(screen.getByRole('textbox'));
		const expandedSend = await screen.findByRole('button', { name: 'Send message' });
		fireEvent.click(expandedSend);
		expect(onSubmit).toHaveBeenCalledWith('draft message', undefined);
		await waitFor(() =>
			expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument()
		);

		rerender(
			<ThemeProvider>
				<CommandInputBar {...defaultProps} value="still editing" onSubmit={onSubmit} />
			</ThemeProvider>
		);
		fireEvent.focus(screen.getByRole('textbox'));
		expect(await screen.findByRole('button', { name: 'Send message' })).toBeInTheDocument();
		fireEvent.touchStart(document.body);
		await waitFor(() =>
			expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument()
		);
	});

	it('covers expanded blur collapse and stacked phone composer layout', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const onInputBlur = vi.fn();
		const outsideButton = document.createElement('button');
		document.body.appendChild(outsideButton);
		renderBar({
			value: 'expanded draft',
			onInputBlur,
		});

		fireEvent.focus(screen.getByRole('textbox'));
		const expandedInput = await screen.findByRole('textbox');
		expect(screen.getByRole('button', { name: 'Send message' })).toBeInTheDocument();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(60);
		});
		fireEvent.blur(expandedInput);
		outsideButton.focus();
		expect(onInputBlur).toHaveBeenCalled();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(180);
		});
		expect(screen.queryByRole('button', { name: 'Send message' })).not.toBeInTheDocument();
		outsideButton.remove();

		const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			'scrollHeight'
		);
		Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', {
			configurable: true,
			get: () => 120,
		});
		try {
			renderBar({
				value: 'line one\nline two\nline three\nline four',
			});
			await waitFor(() =>
				expect(screen.getAllByRole('textbox').at(-1)?.closest('form')).toHaveStyle({
					flexDirection: 'column',
				})
			);
		} finally {
			if (scrollHeightDescriptor) {
				Object.defineProperty(
					HTMLTextAreaElement.prototype,
					'scrollHeight',
					scrollHeightDescriptor
				);
			} else {
				delete (HTMLTextAreaElement.prototype as Partial<HTMLTextAreaElement>).scrollHeight;
			}
		}
	});

	it('drives real Web Speech transcription state and cleanup through the voice button', () => {
		setWindowSize(768);
		window.SpeechRecognition = FakeSpeechRecognition;
		const onChange = vi.fn();
		renderBar({ onChange });

		fireEvent.click(screen.getByRole('button', { name: 'Start voice input' }));
		const recognition = FakeSpeechRecognition.latest;
		expect(recognition?.start).toHaveBeenCalledTimes(1);

		act(() => {
			recognition?.onstart?.(new Event('start'));
		});
		expect(screen.getByRole('button', { name: 'Stop voice input' })).toBeInTheDocument();
		expect(vibrateSpy).toHaveBeenCalledWith(25);

		act(() => {
			recognition?.onresult?.(speechResult('build the app'));
		});
		expect(onChange).toHaveBeenCalledWith('build the app');

		act(() => {
			recognition?.onerror?.(speechError('network'));
		});
		expect(vibrateSpy).toHaveBeenCalledWith(50);

		act(() => {
			recognition?.onend?.(new Event('end'));
		});
		expect(screen.getByRole('button', { name: 'Start voice input' })).toBeInTheDocument();
		expect(vibrateSpy).toHaveBeenCalledWith(10);
	});

	it('opens the command palette callback on long press and cancels moved gestures', async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const onOpenCommandPalette = vi.fn();
		renderBar({
			value: 'queued prompt',
			hasActiveSession: true,
			onOpenCommandPalette,
		});

		const sendButton = screen.getByRole('button', { name: /Send command/i });
		fireEvent.touchStart(sendButton, { touches: [{ clientX: 260, clientY: 700 }] });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(520);
		});

		expect(onOpenCommandPalette).toHaveBeenCalledTimes(1);
		expect(vibrateSpy).toHaveBeenCalledWith(25);
		onOpenCommandPalette.mockClear();

		fireEvent.touchStart(sendButton, { touches: [{ clientX: 260, clientY: 700 }] });
		fireEvent.touchMove(sendButton, { touches: [{ clientX: 280, clientY: 705 }] });
		await act(async () => {
			await vi.advanceTimersByTimeAsync(520);
		});
		expect(onOpenCommandPalette).not.toHaveBeenCalled();
	});
});
