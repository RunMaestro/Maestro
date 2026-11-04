import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useResizableTextarea } from '../../../renderer/hooks/ui/useResizableTextarea';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';

// The shared setup's ResizeObserver mock only fires once on observe. These
// tests need to fire it on demand, standing in for the user dragging the grip.
const observers: Array<{ target: Element; fire: () => void }> = [];

class ControllableResizeObserver {
	constructor(private callback: ResizeObserverCallback) {}
	observe(target: Element) {
		observers.push({
			target,
			fire: () => this.callback([], this as unknown as ResizeObserver),
		});
	}
	unobserve() {}
	disconnect() {
		for (let i = observers.length - 1; i >= 0; i--) {
			observers.splice(i, 1);
		}
	}
}

function dragTo(element: HTMLElement, height: number) {
	// This is what the native grip does: it writes the dragged height straight
	// onto the element's inline style.
	element.style.height = `${height}px`;
	act(() => {
		for (const observer of observers) {
			if (observer.target === element) observer.fire();
		}
	});
}

function Harness({
	sizeKey = 'test-textarea',
	defaultHeight,
	minHeight = 100,
	maxHeight,
}: {
	sizeKey?: string;
	defaultHeight?: number;
	minHeight?: number;
	maxHeight?: number;
}) {
	const resize = useResizableTextarea({ sizeKey, defaultHeight, minHeight, maxHeight });
	return <textarea ref={resize.textareaRef} data-testid="textarea" style={resize.style} />;
}

describe('useResizableTextarea', () => {
	beforeEach(() => {
		Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
		observers.length = 0;
		vi.stubGlobal('ResizeObserver', ControllableResizeObserver);
		useSettingsStore.setState({ textareaHeights: {} });
		vi.mocked(window.maestro.settings.set).mockClear();
	});

	afterEach(() => {
		cleanup();
		vi.unstubAllGlobals();
		vi.useRealTimers();
	});

	it('leaves the textarea at its natural size when nothing is remembered', () => {
		render(<Harness />);
		expect(screen.getByTestId('textarea').style.height).toBe('');
	});

	it('applies a declared default height when nothing is remembered', () => {
		render(<Harness defaultHeight={160} />);
		expect(screen.getByTestId('textarea').style.height).toBe('160px');
	});

	it('restores the remembered height', () => {
		useSettingsStore.setState({ textareaHeights: { 'test-textarea': 320 } });
		render(<Harness defaultHeight={160} />);
		expect(screen.getByTestId('textarea').style.height).toBe('320px');
	});

	it('restores a height that arrives after settings finish loading', () => {
		render(<Harness />);
		const textarea = screen.getByTestId('textarea');
		expect(textarea.style.height).toBe('');

		act(() => {
			useSettingsStore.setState({ textareaHeights: { 'test-textarea': 260 } });
		});

		expect(textarea.style.height).toBe('260px');
	});

	it('persists the height the user drags to', () => {
		vi.useFakeTimers();
		render(<Harness />);

		dragTo(screen.getByTestId('textarea'), 275);

		// Persistence is debounced, so nothing is written mid-drag.
		expect(window.maestro.settings.set).not.toHaveBeenCalled();
		act(() => {
			vi.advanceTimersByTime(300);
		});

		expect(useSettingsStore.getState().textareaHeights['test-textarea']).toBe(275);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('textareaHeights', {
			'test-textarea': 275,
		});
	});

	it('clamps a dragged height to the declared bounds', () => {
		vi.useFakeTimers();
		render(<Harness maxHeight={400} />);

		const textarea = screen.getByTestId('textarea');
		dragTo(textarea, 5000);
		act(() => {
			vi.advanceTimersByTime(300);
		});

		expect(textarea.style.height).toBe('400px');
		expect(useSettingsStore.getState().textareaHeights['test-textarea']).toBe(400);
	});

	it('ignores observer fires that are not a user resize', () => {
		vi.useFakeTimers();
		useSettingsStore.setState({ textareaHeights: { 'test-textarea': 220 } });
		render(<Harness />);
		vi.mocked(window.maestro.settings.set).mockClear();

		// A width change (e.g. the window resizing) fires the observer without
		// touching the explicit height.
		act(() => {
			for (const observer of observers) observer.fire();
			vi.advanceTimersByTime(300);
		});

		expect(window.maestro.settings.set).not.toHaveBeenCalled();
	});

	it('keeps each key independent', () => {
		vi.useFakeTimers();
		useSettingsStore.setState({ textareaHeights: { other: 500 } });
		render(<Harness />);

		dragTo(screen.getByTestId('textarea'), 180);
		act(() => {
			vi.advanceTimersByTime(300);
		});

		expect(useSettingsStore.getState().textareaHeights).toEqual({
			other: 500,
			'test-textarea': 180,
		});
	});
});
