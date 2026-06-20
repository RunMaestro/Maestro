import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getElementRect, useTour } from '../../renderer/components/Wizard/tour/useTour';
import { tourSteps } from '../../renderer/components/Wizard/tour/tourSteps';
import { logger } from '../../renderer/utils/logger';

const originalTourSteps = [...tourSteps];

describe('useTour integration', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		tourSteps.splice(0, tourSteps.length, ...originalTourSteps);
		document.body.innerHTML = '';
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
		tourSteps.splice(0, tourSteps.length, ...originalTourSteps);
		document.body.innerHTML = '';
	});

	it('calculates single and combined spotlight rectangles through real DOM selectors', () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		addTourElement('autorun-tab', makeRect(10, 20, 30, 40));
		addTourElement('hamburger-menu', makeRect(50, 10, 20, 20));
		addTourElement('hamburger-menu-contents', makeRect(5, 60, 15, 25));

		expect(getElementRect(null)).toBeNull();
		expect(getElementRect('[data-tour="missing"]')).toBeNull();
		expect(warn).toHaveBeenCalledWith(
			'[Tour] No elements found for selector(s): [data-tour="missing"]'
		);
		expect(getElementRect('[data-tour="autorun-tab"]')?.toJSON()).toEqual({
			x: 10,
			y: 20,
			width: 30,
			height: 40,
		});
		expect(
			getElementRect(
				'[data-tour="hamburger-menu"], [data-tour="hamburger-menu-contents"]'
			)?.toJSON()
		).toEqual({
			x: 5,
			y: 10,
			width: 65,
			height: 75,
		});
	});

	it('opens on the real first step, executes UI actions, and repositions on resize', async () => {
		let autorunRect = makeRect(20, 30, 120, 42);
		const autorun = addTourElement('autorun-tab', autorunRect);
		autorun.getBoundingClientRect = vi.fn(() => autorunRect);
		const onUIAction = vi.fn();

		const { result } = renderHook(() =>
			useTour({
				isOpen: true,
				onComplete: vi.fn(),
				onUIAction,
			})
		);

		expect(result.current.currentStep?.id).toBe('autorun-panel');
		expect(result.current.currentStepIndex).toBe(0);
		expect(result.current.totalSteps).toBe(tourSteps.length);
		expect(result.current.isPositionReady).toBe(false);
		expect(onUIAction).toHaveBeenCalledWith({ type: 'setRightTab', value: 'autorun' });
		expect(onUIAction).toHaveBeenCalledWith({ type: 'openRightPanel' });

		await advanceTimers(100);
		expect(result.current.spotlight).toEqual({
			rect: { x: 20, y: 30, width: 120, height: 42 },
			padding: 8,
			borderRadius: 8,
		});
		expect(result.current.isPositionReady).toBe(true);

		autorunRect = makeRect(25, 40, 140, 50);
		act(() => {
			window.dispatchEvent(new Event('resize'));
		});
		expect(result.current.spotlight?.rect).toEqual({ x: 25, y: 40, width: 140, height: 50 });
	});

	it('dispatches tour events without a callback and handles empty-action steps', async () => {
		addTourElement('hamburger-menu', makeRect(50, 10, 20, 20));
		addTourElement('hamburger-menu-contents', makeRect(5, 60, 15, 25));
		addTourElement('tab-bar', makeRect(80, 80, 100, 20));
		addTourElement('main-terminal', makeRect(90, 110, 160, 100));
		const dispatched: unknown[] = [];
		const listener = vi.fn((event: Event) => {
			dispatched.push((event as CustomEvent).detail);
		});
		window.addEventListener('tour:action', listener);

		const { result } = renderHook(() =>
			useTour({
				isOpen: true,
				onComplete: vi.fn(),
				startStep: 4,
			})
		);

		expect(dispatched).toEqual([{ type: 'openHamburgerMenu' }]);
		await advanceTimers(100);
		expect(result.current.currentStep?.id).toBe('hamburger-menu');
		expect(result.current.spotlight?.rect).toEqual({ x: 5, y: 10, width: 65, height: 75 });

		act(() => {
			result.current.goToStep(7);
		});
		await advanceTimers(150);
		expect(result.current.currentStep?.id).toBe('main-terminal');
		expect(dispatched).toEqual([{ type: 'openHamburgerMenu' }]);

		await advanceTimers(200);
		await advanceTimers(100);
		expect(result.current.spotlight?.rect).toEqual({ x: 80, y: 80, width: 170, height: 130 });
		window.removeEventListener('tour:action', listener);
	});

	it('stays idle while closed and reports ready without a spotlight for missing or null steps', async () => {
		const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
		const onUIAction = vi.fn();
		const { result, rerender } = renderHook(
			({ isOpen, startStep }) =>
				useTour({
					isOpen,
					onComplete: vi.fn(),
					onUIAction,
					startStep,
				}),
			{ initialProps: { isOpen: false, startStep: 0 } }
		);

		await advanceTimers(500);
		expect(result.current.currentStep?.id).toBe('autorun-panel');
		expect(result.current.spotlight).toBeNull();
		expect(result.current.isPositionReady).toBe(false);
		expect(onUIAction).not.toHaveBeenCalled();

		rerender({ isOpen: true, startStep: 0 });
		await advanceTimers(100);
		expect(result.current.spotlight).toBeNull();
		expect(result.current.isPositionReady).toBe(true);
		expect(warn).toHaveBeenCalledWith(
			'[Tour] No elements found for selector(s): [data-tour="autorun-tab"]'
		);

		rerender({ isOpen: true, startStep: tourSteps.length - 1 });
		await advanceTimers(100);
		expect(result.current.currentStep?.id).toBe('keyboard-shortcuts');
		expect(result.current.spotlight).toBeNull();
		expect(result.current.isPositionReady).toBe(true);

		rerender({ isOpen: true, startStep: 999 });
		await advanceTimers(100);
		expect(result.current.currentStep).toBeNull();
		expect(result.current.spotlight).toBeNull();
		expect(result.current.isPositionReady).toBe(true);
	});

	it('navigates with transition timers, rejects invalid targets, and completes or skips the tour', async () => {
		addTourElement('autorun-tab', makeRect(0, 0, 30, 20));
		addTourElement('autorun-document-selector', makeRect(40, 0, 100, 32));
		addTourElement('files-tab', makeRect(0, 60, 80, 24));
		const onComplete = vi.fn();
		const onUIAction = vi.fn();
		const { result, rerender } = renderHook(
			({ startStep }) =>
				useTour({
					isOpen: true,
					onComplete,
					onUIAction,
					startStep,
				}),
			{ initialProps: { startStep: 0 } }
		);

		await advanceTimers(100);
		act(() => {
			result.current.goToStep(-1);
			result.current.goToStep(999);
			result.current.previousStep();
		});
		expect(result.current.currentStepIndex).toBe(0);
		expect(result.current.isTransitioning).toBe(false);

		act(() => {
			result.current.nextStep();
		});
		expect(result.current.isTransitioning).toBe(true);
		expect(result.current.isPositionReady).toBe(false);

		await advanceTimers(150);
		expect(result.current.currentStep?.id).toBe('autorun-documents');
		expect(onUIAction).toHaveBeenCalledWith({ type: 'setRightTab', value: 'autorun' });

		act(() => {
			result.current.goToStep(2);
		});
		await advanceTimers(150);
		await advanceTimers(200);
		await advanceTimers(100);
		expect(result.current.currentStep?.id).toBe('files-tab');
		expect(result.current.spotlight?.rect).toEqual({ x: 0, y: 60, width: 80, height: 24 });

		act(() => {
			result.current.previousStep();
		});
		await advanceTimers(150);
		await advanceTimers(200);
		await advanceTimers(100);
		expect(result.current.currentStep?.id).toBe('autorun-documents');

		rerender({ startStep: tourSteps.length - 1 });
		expect(result.current.isLastStep).toBe(true);
		act(() => {
			result.current.nextStep();
			result.current.skipTour();
		});
		expect(onComplete).toHaveBeenCalledTimes(2);
	});

	it('skips actions for an unavailable scheduled step and clears pending timers on unmount', async () => {
		addTourElement('autorun-tab', makeRect(0, 0, 30, 20));
		const onUIAction = vi.fn();
		const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
		const { result, unmount } = renderHook(() =>
			useTour({
				isOpen: true,
				onComplete: vi.fn(),
				onUIAction,
			})
		);
		await advanceTimers(100);
		onUIAction.mockClear();

		act(() => {
			result.current.goToStep(1);
		});
		tourSteps[1] = undefined as (typeof tourSteps)[number];
		await advanceTimers(150);
		expect(result.current.currentStep).toBeNull();
		expect(onUIAction).not.toHaveBeenCalled();

		tourSteps.splice(0, tourSteps.length, ...originalTourSteps);
		act(() => {
			result.current.goToStep(2);
		});
		unmount();
		expect(clearTimeoutSpy).toHaveBeenCalled();
	});
});

async function advanceTimers(ms: number) {
	await act(async () => {
		vi.advanceTimersByTime(ms);
	});
}

function addTourElement(name: string, rect: DOMRect): HTMLElement {
	const element = document.createElement('div');
	element.dataset.tour = name;
	element.getBoundingClientRect = vi.fn(() => rect);
	document.body.appendChild(element);
	return element;
}

function makeRect(x: number, y: number, width: number, height: number): DOMRect {
	return {
		bottom: y + height,
		height,
		left: x,
		right: x + width,
		top: y,
		width,
		x,
		y,
		toJSON: () => ({ x, y, width, height }),
	} as DOMRect;
}
