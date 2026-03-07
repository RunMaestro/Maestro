import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { TypingIndicator } from '../../../../../renderer/components/Wizard/shared/TypingIndicator';

const mockTheme = {
	colors: {
		bgActivity: '#1a1a2e',
		accent: '#00d4ff',
		textMain: '#ffffff',
		textDim: '#888888',
	},
} as any;

describe('TypingIndicator', () => {
	let rafCallbacks: ((timestamp: number) => void)[];
	let originalRaf: typeof requestAnimationFrame;
	let originalCaf: typeof cancelAnimationFrame;

	beforeEach(() => {
		vi.useFakeTimers();
		rafCallbacks = [];
		originalRaf = globalThis.requestAnimationFrame;
		originalCaf = globalThis.cancelAnimationFrame;
		globalThis.requestAnimationFrame = vi.fn((cb) => {
			rafCallbacks.push(cb);
			return rafCallbacks.length;
		}) as any;
		globalThis.cancelAnimationFrame = vi.fn();
	});

	afterEach(() => {
		vi.useRealTimers();
		globalThis.requestAnimationFrame = originalRaf;
		globalThis.cancelAnimationFrame = originalCaf;
	});

	function flushRaf(timestamp: number) {
		const cbs = [...rafCallbacks];
		rafCallbacks = [];
		for (const cb of cbs) {
			cb(timestamp);
		}
	}

	it('renders with data-testid attributes', () => {
		render(
			<TypingIndicator
				theme={mockTheme}
				agentName="Claude"
				fillerPhrase="Analyzing code..."
				onRequestNewPhrase={vi.fn()}
			/>
		);

		expect(screen.getByTestId('wizard-typing-indicator')).toBeDefined();
		expect(screen.getByTestId('typing-indicator-text')).toBeDefined();
		expect(screen.getByTestId('typing-indicator-dots')).toBeDefined();
	});

	it('displays formatted agent name with emoji prefix', () => {
		render(
			<TypingIndicator
				theme={mockTheme}
				agentName="Claude"
				fillerPhrase="Thinking..."
				onRequestNewPhrase={vi.fn()}
			/>
		);

		expect(screen.getByText('🤖 Claude')).toBeDefined();
	});

	it('preserves agent name that already has emoji', () => {
		render(
			<TypingIndicator
				theme={mockTheme}
				agentName="🚀 Rocket"
				fillerPhrase="Thinking..."
				onRequestNewPhrase={vi.fn()}
			/>
		);

		expect(screen.getByText('🚀 Rocket')).toBeDefined();
	});

	it('types out the filler phrase character by character', () => {
		render(
			<TypingIndicator
				theme={mockTheme}
				agentName="Claude"
				fillerPhrase="Hi"
				onRequestNewPhrase={vi.fn()}
			/>
		);

		const textEl = screen.getByTestId('typing-indicator-text');
		expect(textEl.textContent).toBe('');

		// First tick initializes lastTime; second tick at +30ms types first char
		act(() => flushRaf(100));
		act(() => flushRaf(130));
		expect(textEl.textContent).toBe('H');

		act(() => flushRaf(160));
		expect(textEl.textContent).toBe('Hi');
	});

	it('calls onRequestNewPhrase after typing completes + 5s delay', () => {
		const onRequestNewPhrase = vi.fn();
		render(
			<TypingIndicator
				theme={mockTheme}
				agentName="Claude"
				fillerPhrase="AB"
				onRequestNewPhrase={onRequestNewPhrase}
			/>
		);

		// Type out "AB" — need enough ticks to complete
		act(() => flushRaf(100));
		act(() => flushRaf(130)); // 'A'
		act(() => flushRaf(160)); // 'B' — typing complete, sets isTypingComplete

		// Flush any pending rAF from the completion render
		act(() => flushRaf(190));

		expect(onRequestNewPhrase).not.toHaveBeenCalled();

		// Advance 5 seconds for rotation timer
		act(() => vi.advanceTimersByTime(5000));

		expect(onRequestNewPhrase).toHaveBeenCalledOnce();
	});

	it('renders three animated dots', () => {
		render(
			<TypingIndicator
				theme={mockTheme}
				agentName="Claude"
				fillerPhrase="Test"
				onRequestNewPhrase={vi.fn()}
			/>
		);

		const dots = screen.getByTestId('typing-indicator-dots');
		const dotElements = dots.querySelectorAll('.rounded-full');
		expect(dotElements.length).toBe(3);
	});

	it('uses wizard-typing-bounce animation on dots', () => {
		const { container } = render(
			<TypingIndicator
				theme={mockTheme}
				agentName="Claude"
				fillerPhrase="Test"
				onRequestNewPhrase={vi.fn()}
			/>
		);

		const style = container.querySelector('style');
		expect(style?.textContent).toContain('wizard-typing-bounce');
	});

	it('falls back to "Thinking..." when fillerPhrase is empty', () => {
		render(
			<TypingIndicator
				theme={mockTheme}
				agentName="Claude"
				fillerPhrase=""
				onRequestNewPhrase={vi.fn()}
			/>
		);

		const textEl = screen.getByTestId('typing-indicator-text');

		// Type out enough characters to see "T" (Thinking...)
		act(() => flushRaf(100));
		act(() => flushRaf(130));
		expect(textEl.textContent).toBe('T');
	});
});
