import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocked = vi.hoisted(() => ({
	tourSteps: [
		{
			id: 'first',
			title: 'First',
			description: 'First step',
			selector: '[data-tour="first"]',
			uiActions: [{ type: 'setRightTab', value: 'autorun' }],
		},
		{
			id: 'second',
			title: 'Second',
			description: 'Second step',
			selector: '[data-tour="second"]',
			uiActions: [{ type: 'openRightPanel' }],
		},
		{
			id: 'combined',
			title: 'Combined',
			description: 'Combined step',
			selector: '[data-tour="combined-a"], [data-tour="combined-b"]',
			uiActions: [{ type: 'openHamburgerMenu' }],
		},
		{
			id: 'missing',
			title: 'Missing',
			description: 'Missing target step',
			selector: '[data-tour="missing"]',
			uiActions: [],
		},
		{
			id: 'center',
			title: 'Center',
			description: 'Center step',
			selector: null,
			uiActions: [],
		},
	],
}));

vi.mock('../../../../../renderer/components/Wizard/tour/tourSteps', () => ({
	tourSteps: mocked.tourSteps,
}));

vi.mock('../../../../../renderer/utils/logger', () => ({
	logger: {
		warn: vi.fn(),
	},
}));

import { useTour } from '../../../../../renderer/components/Wizard/tour/useTour';
import { logger } from '../../../../../renderer/utils/logger';

const originalTourSteps = [...mocked.tourSteps];

function makeRect(x: number, y: number, width: number, height: number): DOMRect {
	return {
		x,
		y,
		width,
		height,
		top: y,
		left: x,
		right: x + width,
		bottom: y + height,
		toJSON: () => ({ x, y, width, height }),
	} as DOMRect;
}

function addTourElement(name: string, rect: DOMRect) {
	const element = document.createElement('div');
	element.dataset.tour = name;
	element.getBoundingClientRect = vi.fn(() => rect);
	document.body.appendChild(element);
	return element;
}

async function advanceTimers(ms: number) {
	await act(async () => {
		vi.advanceTimersByTime(ms);
		await Promise.resolve();
	});
}

describe('useTour', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		mocked.tourSteps.splice(0, mocked.tourSteps.length, ...originalTourSteps);
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
		vi.restoreAllMocks();
		document.body.innerHTML = '';
	});

	it('initializes an open tour, executes initial UI actions, and positions a single spotlight', async () => {
		let currentRect = makeRect(10, 20, 30, 40);
		const target = addTourElement('first', currentRect);
		target.getBoundingClientRect = vi.fn(() => currentRect);
		const onComplete = vi.fn();
		const onUIAction = vi.fn();

		const { result } = renderHook(() =>
			useTour({
				isOpen: true,
				onComplete,
				onUIAction,
			})
		);

		expect(result.current.currentStep?.id).toBe('first');
		expect(result.current.currentStepIndex).toBe(0);
		expect(result.current.totalSteps).toBe(5);
		expect(result.current.isPositionReady).toBe(false);
		expect(onUIAction).toHaveBeenCalledWith({ type: 'setRightTab', value: 'autorun' });

		await advanceTimers(100);

		expect(result.current.spotlight).toEqual({
			rect: { x: 10, y: 20, width: 30, height: 40 },
			padding: 8,
			borderRadius: 8,
		});
		expect(result.current.isPositionReady).toBe(true);

		currentRect = makeRect(15, 25, 35, 45);
		act(() => {
			window.dispatchEvent(new Event('resize'));
		});

		expect(result.current.spotlight?.rect).toEqual({ x: 15, y: 25, width: 35, height: 45 });
	});

	it('combines multiple selector matches and dispatches tour actions when no callback is supplied', async () => {
		addTourElement('combined-a', makeRect(30, 10, 20, 15));
		addTourElement('combined-b', makeRect(5, 40, 10, 25));
		const dispatched: unknown[] = [];
		const listener = vi.fn((event: Event) => {
			dispatched.push((event as CustomEvent).detail);
		});
		window.addEventListener('tour:action', listener);

		const { result } = renderHook(() =>
			useTour({
				isOpen: true,
				startStep: 2,
				onComplete: vi.fn(),
			})
		);

		expect(dispatched).toEqual([{ type: 'openHamburgerMenu' }]);

		await advanceTimers(100);

		expect(result.current.currentStep?.id).toBe('combined');
		expect(result.current.spotlight?.rect).toEqual({
			x: 5,
			y: 10,
			width: 45,
			height: 55,
		});

		window.removeEventListener('tour:action', listener);
	});

	it('leaves a closed tour idle without executing actions or scheduling spotlight work', async () => {
		addTourElement('first', makeRect(10, 20, 30, 40));
		const onUIAction = vi.fn();

		const { result } = renderHook(() =>
			useTour({
				isOpen: false,
				onComplete: vi.fn(),
				onUIAction,
			})
		);

		await advanceTimers(500);

		expect(result.current.currentStep?.id).toBe('first');
		expect(result.current.spotlight).toBeNull();
		expect(result.current.isPositionReady).toBe(false);
		expect(onUIAction).not.toHaveBeenCalled();
	});

	it('reports readiness without a spotlight for missing, null, or invalid steps', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		const onUIAction = vi.fn();
		const { result, rerender } = renderHook(
			({ startStep }) =>
				useTour({
					isOpen: true,
					startStep,
					onComplete: vi.fn(),
					onUIAction,
				}),
			{ initialProps: { startStep: 3 } }
		);

		await advanceTimers(100);

		expect(result.current.currentStep?.id).toBe('missing');
		expect(result.current.spotlight).toBeNull();
		expect(result.current.isPositionReady).toBe(true);
		expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
			'[Tour] No elements found for selector(s): [data-tour="missing"]'
		);

		rerender({ startStep: 4 });
		await advanceTimers(100);

		expect(result.current.currentStep?.id).toBe('center');
		expect(result.current.spotlight).toBeNull();
		expect(result.current.isPositionReady).toBe(true);

		rerender({ startStep: 99 });
		await advanceTimers(100);

		expect(result.current.currentStep).toBeNull();
		expect(result.current.spotlight).toBeNull();
		expect(result.current.isPositionReady).toBe(true);
		expect(onUIAction).not.toHaveBeenCalled();
	});

	it('navigates with transition timers, ignores invalid targets, and clears pending transitions', async () => {
		addTourElement('first', makeRect(0, 0, 10, 10));
		addTourElement('second', makeRect(10, 10, 20, 20));
		addTourElement('combined-a', makeRect(30, 30, 10, 10));
		addTourElement('combined-b', makeRect(45, 45, 10, 10));
		const onUIAction = vi.fn();
		const { result } = renderHook(() =>
			useTour({
				isOpen: true,
				onComplete: vi.fn(),
				onUIAction,
			})
		);
		await advanceTimers(100);

		act(() => {
			result.current.goToStep(-1);
			result.current.goToStep(99);
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

		expect(result.current.currentStepIndex).toBe(1);
		expect(onUIAction).toHaveBeenCalledWith({ type: 'openRightPanel' });

		act(() => {
			result.current.goToStep(2);
		});
		await advanceTimers(150);

		expect(result.current.currentStepIndex).toBe(2);
		expect(onUIAction).toHaveBeenCalledWith({ type: 'openHamburgerMenu' });

		await advanceTimers(200);
		await advanceTimers(100);

		expect(result.current.isTransitioning).toBe(false);
		expect(result.current.spotlight?.rect).toEqual({ x: 30, y: 30, width: 25, height: 25 });

		act(() => {
			result.current.previousStep();
		});
		await advanceTimers(450);

		expect(result.current.currentStepIndex).toBe(1);
	});

	it('skips UI actions if a scheduled step is unavailable when its transition fires', async () => {
		addTourElement('first', makeRect(0, 0, 10, 10));
		const onUIAction = vi.fn();
		const { result } = renderHook(() =>
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
		mocked.tourSteps[1] = undefined as (typeof mocked.tourSteps)[number];

		await advanceTimers(150);

		expect(result.current.currentStepIndex).toBe(1);
		expect(result.current.currentStep).toBeNull();
		expect(onUIAction).not.toHaveBeenCalled();
	});

	it('completes on the last step, skips on request, and removes pending timers on unmount', async () => {
		addTourElement('first', makeRect(0, 0, 10, 10));
		addTourElement('second', makeRect(10, 10, 20, 20));
		const onComplete = vi.fn();
		const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
		const { result, unmount, rerender } = renderHook(
			({ startStep }) =>
				useTour({
					isOpen: true,
					startStep,
					onComplete,
					onUIAction: vi.fn(),
				}),
			{ initialProps: { startStep: 4 } }
		);

		expect(result.current.isLastStep).toBe(true);

		act(() => {
			result.current.nextStep();
			result.current.skipTour();
		});

		expect(onComplete).toHaveBeenCalledTimes(2);

		rerender({ startStep: 0 });
		await advanceTimers(100);
		act(() => {
			result.current.nextStep();
		});
		await advanceTimers(150);

		unmount();

		expect(clearTimeoutSpy).toHaveBeenCalled();
	});
});
