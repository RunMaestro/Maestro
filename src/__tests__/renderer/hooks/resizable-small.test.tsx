// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/hooks/useResizablePanel.test.ts
// Source: src/__tests__/renderer/hooks/useResizableTextarea.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import S1_React from 'react';
import { renderHook, act as s1_act } from '@testing-library/react';
import { useResizablePanel } from '../../../renderer/hooks/ui/useResizablePanel';
import S2_React from 'react';
import { act as s2_act, cleanup, render, screen } from '@testing-library/react';
import { useResizableTextarea } from '../../../renderer/hooks/ui/useResizableTextarea';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
// Source: src/__tests__/renderer/hooks/useResizablePanel.test.ts
describe('', () => {
	// jsdom has no PointerEvent constructor; MouseEvent carries clientX and matches
	// the 'pointermove' / 'pointerup' listeners by their type string.
	function pointer(type: string, clientX: number): MouseEvent {
		return new MouseEvent(type, { clientX, bubbles: true });
	}
	describe('useResizablePanel', () => {
		let handle: HTMLDivElement;
		let panel: HTMLDivElement;
		beforeEach(() => {
			handle = document.createElement('div');
			panel = document.createElement('div');
			document.body.appendChild(handle);
			document.body.appendChild(panel);
			(window.maestro.settings.set as ReturnType<typeof vi.fn>).mockClear();
		});
		afterEach(() => {
			handle.remove();
			panel.remove();
			vi.restoreAllMocks();
		});
		function render(opts: {
			side: 'left' | 'right';
			width?: number;
			minWidth?: number;
			maxWidth?: number;
			settingsKey?: string;
			setWidth: (w: number) => void;
		}) {
			const externalRef = { current: panel } as S1_React.RefObject<HTMLDivElement>;
			return renderHook(() =>
				useResizablePanel({
					width: opts.width ?? 200,
					minWidth: opts.minWidth ?? 100,
					maxWidth: opts.maxWidth ?? 300,
					settingsKey: opts.settingsKey ?? 'panelWidth',
					setWidth: opts.setWidth,
					side: opts.side,
					externalRef,
				})
			);
		}
		function startDrag(
			result: {
				current: {
					onResizeStart: (e: S1_React.PointerEvent) => void;
				};
			},
			clientX = 100
		) {
			s1_act(() => {
				result.current.onResizeStart({
					preventDefault: () => {},
					clientX,
					pointerId: 1,
					currentTarget: handle,
				} as unknown as S1_React.PointerEvent);
			});
		}
		it('resizes a left panel by the drag delta and clamps to max', () => {
			const setWidth = vi.fn();
			const { result } = render({ side: 'left', setWidth });
			startDrag(result, 100);
			expect(result.current.isResizing).toBe(true);
			// Drag right by 50 -> 250 (within bounds).
			s1_act(() => {
				handle.dispatchEvent(pointer('pointermove', 150));
			});
			expect(panel.style.width).toBe('250px');
			// Drag far right -> clamps to maxWidth 300.
			s1_act(() => {
				handle.dispatchEvent(pointer('pointermove', 500));
			});
			expect(panel.style.width).toBe('300px');
			// Release: commit React state + persist the clamped width.
			s1_act(() => {
				handle.dispatchEvent(pointer('pointerup', 500));
			});
			expect(setWidth).toHaveBeenCalledWith(300);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('panelWidth', 300);
			expect(result.current.isResizing).toBe(false);
		});
		it('inverts the delta for a right panel and clamps to min', () => {
			const setWidth = vi.fn();
			const { result } = render({ side: 'right', minWidth: 150, maxWidth: 400, setWidth });
			startDrag(result, 100);
			// side 'right': delta = startX - clientX. Drag right (130) shrinks by 30 -> 170.
			s1_act(() => {
				handle.dispatchEvent(pointer('pointermove', 130));
			});
			expect(panel.style.width).toBe('170px');
			// Drag much further right -> clamps to min 150.
			s1_act(() => {
				handle.dispatchEvent(pointer('pointermove', 400));
			});
			expect(panel.style.width).toBe('150px');
			s1_act(() => {
				handle.dispatchEvent(pointer('pointerup', 400));
			});
			expect(setWidth).toHaveBeenCalledWith(150);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('panelWidth', 150);
		});
		it('stops tracking after pointer up (later moves have no effect)', () => {
			const setWidth = vi.fn();
			const { result } = render({ side: 'left', setWidth });
			startDrag(result, 100);
			s1_act(() => {
				handle.dispatchEvent(pointer('pointermove', 150));
			});
			s1_act(() => {
				handle.dispatchEvent(pointer('pointerup', 150));
			});
			panel.style.width = '999px'; // sentinel after the drag ends
			s1_act(() => {
				handle.dispatchEvent(pointer('pointermove', 250));
			});
			expect(panel.style.width).toBe('999px');
		});
		it('treats pointercancel like pointer up (commits and tears down)', () => {
			const setWidth = vi.fn();
			const { result } = render({ side: 'left', setWidth });
			startDrag(result, 100);
			s1_act(() => {
				handle.dispatchEvent(pointer('pointermove', 140));
			});
			s1_act(() => {
				handle.dispatchEvent(pointer('pointercancel', 140));
			});
			expect(setWidth).toHaveBeenCalledWith(240);
			expect(result.current.isResizing).toBe(false);
		});
	});
});
// Source: src/__tests__/renderer/hooks/useResizableTextarea.test.tsx
describe('', () => {
	// The shared setup's ResizeObserver mock only fires once on observe. These
	// tests need to fire it on demand, standing in for the user dragging the grip.
	const observers: Array<{
		target: Element;
		fire: () => void;
	}> = [];
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
		s2_act(() => {
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
			s2_act(() => {
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
			s2_act(() => {
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
			s2_act(() => {
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
			s2_act(() => {
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
			s2_act(() => {
				vi.advanceTimersByTime(300);
			});
			expect(useSettingsStore.getState().textareaHeights).toEqual({
				other: 500,
				'test-textarea': 180,
			});
		});
	});
});
