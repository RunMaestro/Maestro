/**
 * Tests for SequencePrefixIndicator and the store it reads.
 *
 * The chip is the only feedback a key sequence gives before it completes, so
 * what matters here is the four ways a prefix dies (match, abort, Escape,
 * blur - all of which reach the chip as an empty prefix) plus the fifth the
 * matcher cannot report: the lazy timeout, which the chip owns a timer for.
 *
 * The handler's side of the wiring (which keypress publishes what) is covered
 * in useMainKeyboardHandler.test.ts.
 */

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SequencePrefixIndicator } from '../../../renderer/components/SequencePrefixIndicator';
import {
	clearSequencePrefix,
	publishSequencePrefix,
	useSequencePrefixStore,
} from '../../../renderer/stores/sequencePrefixStore';
import { SEQUENCE_TIMEOUT_MS } from '../../../renderer/utils/shortcutSequence';
import { queryAllShortcutKeys } from '../../helpers/shortcutKeys';
import { mockTheme } from '../../helpers/mockTheme';

/** Publish a prefix the way the keyboard handler does, inside `act`. */
function publish(prefix: string[][]): void {
	act(() => {
		publishSequencePrefix(prefix);
	});
}

const indicator = () => screen.queryByTestId('sequence-prefix-indicator');

describe('SequencePrefixIndicator', () => {
	beforeEach(() => {
		clearSequencePrefix();
	});

	afterEach(() => {
		clearSequencePrefix();
	});

	it('renders nothing while no sequence is in progress', () => {
		const { container } = render(<SequencePrefixIndicator theme={mockTheme} />);
		expect(container).toBeEmptyDOMElement();
	});

	it('draws one key cap cluster per captured step', () => {
		render(<SequencePrefixIndicator theme={mockTheme} />);
		publish([['g'], ['t']]);

		const chip = indicator();
		expect(chip).toBeInTheDocument();
		// Two clusters, not one `['g','t']` chord and not "g or t": `g t` is a run
		// of two keypresses, which is what ShortcutKeys-per-step renders.
		expect(queryAllShortcutKeys(['g'], chip!)).toHaveLength(1);
		expect(queryAllShortcutKeys(['t'], chip!)).toHaveLength(1);
		expect(chip).not.toHaveTextContent('or');
	});

	it('draws a modified step as one cap cluster', () => {
		render(<SequencePrefixIndicator theme={mockTheme} />);
		publish([['Shift', 'g']]);

		expect(queryAllShortcutKeys(['Shift', 'g'], indicator()!)).toHaveLength(1);
	});

	it('grows as further steps are captured', () => {
		render(<SequencePrefixIndicator theme={mockTheme} />);

		publish([['g']]);
		expect(queryAllShortcutKeys(['g'], indicator()!)).toHaveLength(1);

		publish([['g'], ['g']]);
		expect(queryAllShortcutKeys(['g'], indicator()!)).toHaveLength(2);
	});

	// A match, an abort, Escape and a window blur all reach the chip the same
	// way: the handler publishes the matcher's now-empty prefix.
	it('disappears when the prefix is cleared', () => {
		render(<SequencePrefixIndicator theme={mockTheme} />);
		publish([['g']]);
		expect(indicator()).toBeInTheDocument();

		act(() => {
			clearSequencePrefix();
		});

		expect(indicator()).not.toBeInTheDocument();
	});

	it('announces the run to a screen reader', () => {
		render(<SequencePrefixIndicator theme={mockTheme} />);
		publish([['g'], ['t']]);

		const chip = indicator()!;
		expect(chip).toHaveAttribute('role', 'status');
		expect(chip).toHaveAttribute('aria-live', 'polite');
		expect(chip.getAttribute('aria-label')).toContain('g t');
	});

	// One CSS rule retires every element carrying this attribute on a phone. It
	// has to be on the ROOT: the caps inside carry it too, and hiding only those
	// would leave an empty bubble floating over the screen.
	it('marks the whole chip as a keyboard-only hint', () => {
		render(<SequencePrefixIndicator theme={mockTheme} />);
		publish([['g']]);

		expect(indicator()).toHaveAttribute('data-shortcut-hint');
	});

	it('does not swallow clicks aimed at what it floats over', () => {
		render(<SequencePrefixIndicator theme={mockTheme} />);
		publish([['g']]);

		expect(indicator()!.className).toContain('pointer-events-none');
	});

	describe('expiry timer', () => {
		beforeEach(() => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
		});

		afterEach(() => {
			vi.useRealTimers();
		});

		// The matcher expires a prefix lazily, when its buffer is next read, so a
		// user who presses `g` and walks away never triggers it. The chip is
		// painted, so it has to take itself down.
		it("hides itself once the matcher's timeout has passed", () => {
			render(<SequencePrefixIndicator theme={mockTheme} />);
			publish([['g']]);

			act(() => {
				vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS - 1);
			});
			expect(indicator()).toBeInTheDocument();

			act(() => {
				vi.advanceTimersByTime(2);
			});
			expect(indicator()).not.toBeInTheDocument();
		});

		it('restarts the clock on each captured step', () => {
			render(<SequencePrefixIndicator theme={mockTheme} />);
			publish([['g']]);

			act(() => {
				vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS - 100);
			});
			publish([['g'], ['g']]);

			// Would already be gone on the first step's clock.
			act(() => {
				vi.advanceTimersByTime(200);
			});
			expect(indicator()).toBeInTheDocument();

			act(() => {
				vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS);
			});
			expect(indicator()).not.toBeInTheDocument();
		});

		// The effect computes the time LEFT rather than scheduling a fresh second,
		// so a re-render partway through a run cannot extend it.
		it("expires on the capture's own clock, not the render's", () => {
			const { rerender } = render(<SequencePrefixIndicator theme={mockTheme} />);
			publish([['g']]);

			act(() => {
				vi.advanceTimersByTime(900);
			});
			rerender(<SequencePrefixIndicator theme={{ ...mockTheme, id: 'other' }} />);

			act(() => {
				vi.advanceTimersByTime(101);
			});
			expect(indicator()).not.toBeInTheDocument();
		});

		it('leaves no timer behind when it unmounts', () => {
			const { unmount } = render(<SequencePrefixIndicator theme={mockTheme} />);
			publish([['g']]);
			unmount();

			act(() => {
				vi.advanceTimersByTime(SEQUENCE_TIMEOUT_MS * 2);
			});

			// Nothing cleared the prefix, because nothing was listening - and
			// nothing threw trying to render into an unmounted tree.
			expect(useSequencePrefixStore.getState().prefix).toEqual([['g']]);
		});
	});
});

describe('sequencePrefixStore', () => {
	beforeEach(() => {
		clearSequencePrefix();
	});

	afterEach(() => {
		clearSequencePrefix();
	});

	it('starts with no prefix and a stopped clock', () => {
		expect(useSequencePrefixStore.getState().prefix).toEqual([]);
		expect(useSequencePrefixStore.getState().capturedAt).toBe(0);
	});

	it('stamps the capture time when a prefix goes live', () => {
		publishSequencePrefix([['g']]);
		expect(useSequencePrefixStore.getState().capturedAt).toBeGreaterThan(0);
	});

	it('stops the clock when the prefix is cleared', () => {
		publishSequencePrefix([['g']]);
		clearSequencePrefix();

		expect(useSequencePrefixStore.getState().prefix).toEqual([]);
		expect(useSequencePrefixStore.getState().capturedAt).toBe(0);
	});

	// The handler publishes on every keydown, so a write that changes nothing has
	// to be a genuine no-op: otherwise an unrelated keypress re-renders the chip
	// and hands a half-expired prefix a fresh second.
	it('skips a write for an unchanged prefix', () => {
		const prefix = [['g']];
		publishSequencePrefix(prefix);
		const after = useSequencePrefixStore.getState();

		publishSequencePrefix(prefix);

		expect(useSequencePrefixStore.getState().prefix).toBe(after.prefix);
		expect(useSequencePrefixStore.getState().capturedAt).toBe(after.capturedAt);
	});

	// The matcher's own empty array is not this module's, so the identity check
	// alone does not catch it - and the handler publishes a reset on EVERY
	// keystroke that lands in a text field, which is most of them.
	it('skips a write for an already-empty prefix, whichever empty array arrives', () => {
		const first = useSequencePrefixStore.getState().prefix;
		let notified = 0;
		const unsubscribe = useSequencePrefixStore.subscribe(() => notified++);

		publishSequencePrefix([]);

		unsubscribe();
		expect(notified).toBe(0);
		expect(useSequencePrefixStore.getState().prefix).toBe(first);
	});

	it('notifies a subscriber when the prefix actually changes', () => {
		const seen: number[] = [];
		const unsubscribe = useSequencePrefixStore.subscribe((s) => seen.push(s.prefix.length));

		publishSequencePrefix([['g']]);
		publishSequencePrefix([['g'], ['t']]);
		clearSequencePrefix();
		clearSequencePrefix();

		unsubscribe();
		// Four calls, one no-op: the second clear changes nothing.
		expect(seen).toEqual([1, 2, 0]);
	});
});
