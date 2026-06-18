/**
 * Tests for KeyboardMasteryCelebration — the confetti modal that appears when
 * the user reaches a new keyboard mastery level.
 *
 * Characterization tests for Tier 2 listener-hygiene refactor: pin down the
 * keydown handling and listener cleanup before swapping to useEventListener.
 */

import { render, fireEvent, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { KeyboardMasteryCelebration } from '../../../renderer/components/KeyboardMasteryCelebration';
import { mockTheme } from '../../helpers/mockTheme';
import { spyOnListeners, expectAllListenersRemoved } from '../../helpers/listenerLeakAssertions';

// Confetti is a side-effect-only canvas library; render it as a no-op in tests.
vi.mock('canvas-confetti', () => ({
	default: vi.fn(),
}));

// useModalLayer registers with the layer stack — we don't care about that here.
vi.mock('../../../renderer/hooks/ui/useModalLayer', () => ({
	useModalLayer: vi.fn(),
}));

describe('KeyboardMasteryCelebration', () => {
	let onClose: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		onClose = vi.fn();
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it('renders the level title', () => {
		const { getByText } = render(
			<KeyboardMasteryCelebration theme={mockTheme} level={1} onClose={onClose} disableConfetti />
		);
		expect(getByText('Level Up!')).toBeInTheDocument();
	});

	it('shows Maestro title at level 4', () => {
		const { getByText } = render(
			<KeyboardMasteryCelebration theme={mockTheme} level={4} onClose={onClose} disableConfetti />
		);
		expect(getByText('Keyboard Maestro!')).toBeInTheDocument();
	});

	it('closes on Enter keydown', () => {
		vi.useFakeTimers();
		render(
			<KeyboardMasteryCelebration theme={mockTheme} level={1} onClose={onClose} disableConfetti />
		);
		fireEvent.keyDown(window, { key: 'Enter' });
		// handleClose schedules an 800ms close via setTimeout; advance timers.
		act(() => {
			vi.advanceTimersByTime(800);
		});
		expect(onClose).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});

	it('closes on Escape keydown', () => {
		vi.useFakeTimers();
		render(
			<KeyboardMasteryCelebration theme={mockTheme} level={1} onClose={onClose} disableConfetti />
		);
		fireEvent.keyDown(window, { key: 'Escape' });
		act(() => {
			vi.advanceTimersByTime(800);
		});
		expect(onClose).toHaveBeenCalledTimes(1);
		vi.useRealTimers();
	});

	it('ignores other keydowns', () => {
		vi.useFakeTimers();
		render(
			<KeyboardMasteryCelebration theme={mockTheme} level={1} onClose={onClose} disableConfetti />
		);
		fireEvent.keyDown(window, { key: 'a' });
		fireEvent.keyDown(window, { key: 'ArrowDown' });
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(onClose).not.toHaveBeenCalled();
		vi.useRealTimers();
	});

	it('does not call onClose after unmount', () => {
		vi.useFakeTimers();
		const { unmount } = render(
			<KeyboardMasteryCelebration theme={mockTheme} level={1} onClose={onClose} disableConfetti />
		);
		unmount();
		fireEvent.keyDown(window, { key: 'Enter' });
		fireEvent.keyDown(window, { key: 'Escape' });
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		expect(onClose).not.toHaveBeenCalled();
		vi.useRealTimers();
	});

	it('removes its keydown listener on unmount (no leak)', () => {
		const spies = spyOnListeners(window);
		const { unmount } = render(
			<KeyboardMasteryCelebration theme={mockTheme} level={1} onClose={onClose} disableConfetti />
		);
		unmount();
		expectAllListenersRemoved(spies.addSpy, spies.removeSpy);
		spies.restore();
	});
});
