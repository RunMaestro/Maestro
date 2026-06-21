import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TourStep } from '../../renderer/components/Wizard/tour/TourStep';
import { tourSteps } from '../../renderer/components/Wizard/tour/tourSteps';
import type { Shortcut, Theme } from '../../renderer/types';

const theme = {
	name: 'Integration Tour',
	colors: {
		accent: '#22c55e',
		accentForeground: '#ffffff',
		bgActivity: '#111827',
		bgMain: '#020617',
		bgSidebar: '#0f172a',
		border: '#334155',
		textDim: '#94a3b8',
		textMain: '#f8fafc',
	},
} as Theme;

const originalViewport = {
	width: window.innerWidth,
	height: window.innerHeight,
};

const shortcuts = {
	closeTab: { id: 'closeTab', label: 'Close Tab', keys: ['Meta', 'w'] },
	focusInput: { id: 'focusInput', label: 'Focus Input', keys: ['Meta', 'i'] },
	goToAutoRun: { id: 'goToAutoRun', label: 'Go to Auto Run', keys: ['Meta', 'Shift', 'w'] },
	help: { id: 'help', label: 'Help', keys: ['Meta', '/'] },
	newTab: { id: 'newTab', label: 'New Tab', keys: ['Meta', 't'] },
	reopenClosedTab: {
		id: 'reopenClosedTab',
		label: 'Reopen Closed Tab',
		keys: ['Meta', 'Shift', 't'],
	},
} satisfies Record<string, Shortcut>;

function setViewport(width: number, height: number) {
	Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
	Object.defineProperty(window, 'innerHeight', {
		configurable: true,
		writable: true,
		value: height,
	});
}

function renderTourStep(props: Partial<React.ComponentProps<typeof TourStep>> = {}) {
	const onNext = vi.fn();
	const onGoToStep = vi.fn();
	const onSkip = vi.fn();

	const result = render(
		<TourStep
			theme={theme}
			step={tourSteps[0]}
			stepNumber={1}
			totalSteps={tourSteps.length}
			spotlight={null}
			onNext={onNext}
			onGoToStep={onGoToStep}
			onSkip={onSkip}
			isLastStep={false}
			isTransitioning={false}
			isPositionReady
			shortcuts={shortcuts}
			{...props}
		/>
	);

	return { ...result, onGoToStep, onNext, onSkip };
}

afterEach(() => {
	cleanup();
	setViewport(originalViewport.width, originalViewport.height);
});

describe('TourStep integration', () => {
	it('renders copy, shortcut badges, progress controls, and navigation callbacks', () => {
		const finalStep = tourSteps.at(-1)!;
		const { container, onGoToStep, onNext, onSkip } = renderTourStep({
			isLastStep: true,
			step: finalStep,
			stepNumber: tourSteps.length,
		});

		expect(screen.getByRole('heading', { name: finalStep.title })).toBeInTheDocument();
		expect(screen.getByText(`Step ${tourSteps.length} of ${tourSteps.length}`)).toBeInTheDocument();
		expect(container.textContent).toMatch(/(Cmd|Ctrl)\+\//);

		fireEvent.click(screen.getByRole('button', { name: /finish tour/i }));
		fireEvent.click(screen.getByRole('button', { name: /skip tour/i }));
		fireEvent.click(screen.getByTitle('Go back to step 1'));

		expect(onNext).toHaveBeenCalledTimes(1);
		expect(onSkip).toHaveBeenCalledTimes(1);
		expect(onGoToStep).toHaveBeenCalledWith(0);
		expect(screen.getAllByRole('button', { name: '' }).at(-1)).toBeDisabled();
	});

	it('switches between generic and wizard-specific rich descriptions', () => {
		const terminalStep = tourSteps.find((step) => step.id === 'main-terminal')!;
		const inputStep = tourSteps.find((step) => step.id === 'input-area')!;
		const { rerender } = renderTourStep({
			step: terminalStep,
			stepNumber: 8,
		});

		expect(screen.getByRole('heading', { name: /ai terminal & tabs/i })).toBeInTheDocument();
		expect(screen.getByText(/searchable tab overview/i)).toBeInTheDocument();
		expect(screen.getByText(/(Cmd|Ctrl)\+Shift\+T/i)).toBeInTheDocument();

		rerender(
			<TourStep
				theme={theme}
				step={inputStep}
				stepNumber={10}
				totalSteps={tourSteps.length}
				spotlight={null}
				onNext={vi.fn()}
				onGoToStep={vi.fn()}
				onSkip={vi.fn()}
				isLastStep={false}
				isTransitioning={false}
				isPositionReady
				fromWizard
				shortcuts={shortcuts}
			/>
		);

		expect(screen.getByText(/type your messages here/i)).toBeInTheDocument();
		expect(screen.getByText(/slash commands and @ mentions/i)).toBeInTheDocument();
		expect(screen.getByText(/expanded prompt editor/i)).toBeInTheDocument();
		expect(screen.getByText(/(Cmd|Ctrl)\+I/i)).toBeInTheDocument();
	});

	it('positions the tooltip around spotlight targets and over center-overlay targets', () => {
		setViewport(1000, 800);
		const { container, rerender } = renderTourStep({
			step: { ...tourSteps[0], position: 'top' },
			spotlight: {
				borderRadius: 8,
				padding: 8,
				rect: { height: 40, width: 80, x: 420, y: 500 },
			},
		});
		const tooltip = () => container.firstElementChild as HTMLElement;

		expect(tooltip().style.bottom).toBe('324px');

		rerender(
			<TourStep
				theme={theme}
				step={{ ...tourSteps[0], position: 'bottom' }}
				stepNumber={1}
				totalSteps={tourSteps.length}
				spotlight={{
					borderRadius: 8,
					padding: 8,
					rect: { height: 40, width: 80, x: 420, y: 100 },
				}}
				onNext={vi.fn()}
				onGoToStep={vi.fn()}
				onSkip={vi.fn()}
				isLastStep={false}
				isTransitioning={false}
				isPositionReady
			/>
		);
		expect(tooltip().style.top).toBe('164px');

		rerender(
			<TourStep
				theme={theme}
				step={{ ...tourSteps[0], position: 'center-overlay' }}
				stepNumber={1}
				totalSteps={tourSteps.length}
				spotlight={{
					borderRadius: 8,
					padding: 8,
					rect: { height: 70, width: 50, x: 100, y: 150 },
				}}
				onNext={vi.fn()}
				onGoToStep={vi.fn()}
				onSkip={vi.fn()}
				isLastStep={false}
				isTransitioning={false}
				isPositionReady
			/>
		);

		expect(tooltip().style.top).toBe('185px');
		expect(tooltip().style.left).toBe('125px');
		expect(tooltip().style.transform).toBe('translate(-50%, -50%)');
	});

	it('falls back to available space when preferred sides are cramped', () => {
		setViewport(1000, 800);
		const { container, rerender } = renderTourStep({
			step: { ...tourSteps[0], position: 'bottom' },
			spotlight: {
				borderRadius: 8,
				padding: 8,
				rect: { height: 40, width: 80, x: 420, y: 740 },
			},
		});
		const tooltip = () => container.firstElementChild as HTMLElement;

		expect(tooltip().style.bottom).toBe('84px');

		rerender(
			<TourStep
				theme={theme}
				step={{ ...tourSteps[0], position: 'left' }}
				stepNumber={1}
				totalSteps={tourSteps.length}
				spotlight={{
					borderRadius: 8,
					padding: 8,
					rect: { height: 40, width: 80, x: 8, y: 300 },
				}}
				onNext={vi.fn()}
				onGoToStep={vi.fn()}
				onSkip={vi.fn()}
				isLastStep={false}
				isTransitioning={false}
				isPositionReady
			/>
		);
		expect(tooltip().style.left).toBe('112px');

		rerender(
			<TourStep
				theme={theme}
				step={{ ...tourSteps[0], position: 'right' }}
				stepNumber={1}
				totalSteps={tourSteps.length}
				spotlight={{
					borderRadius: 8,
					padding: 8,
					rect: { height: 40, width: 70, x: 920, y: 300 },
				}}
				onNext={vi.fn()}
				onGoToStep={vi.fn()}
				onSkip={vi.fn()}
				isLastStep={false}
				isTransitioning={false}
				isPositionReady
			/>
		);
		expect(tooltip().style.right).toBe('104px');
	});

	it('handles hidden positioning state, unknown placeholders, paragraphs, and line breaks', () => {
		const step = {
			...tourSteps[0],
			description:
				'First {{missingShortcut}} paragraph\nwith a break.\n\nPress {{focusInput}} next.',
			descriptionGeneric: undefined,
			position: undefined,
		};
		const { container, rerender } = renderTourStep({
			isPositionReady: false,
			isTransitioning: true,
			shortcuts: {},
			step,
		});
		const tooltip = () => container.firstElementChild as HTMLElement;

		expect(container.textContent).toContain('First {{missingShortcut}} paragraph');
		expect(container.querySelector('br')).toBeInTheDocument();
		expect(tooltip().style.opacity).toBe('0');
		expect(tooltip().style.visibility).toBe('hidden');

		rerender(
			<TourStep
				theme={theme}
				step={step}
				stepNumber={1}
				totalSteps={tourSteps.length}
				spotlight={null}
				onNext={vi.fn()}
				onGoToStep={vi.fn()}
				onSkip={vi.fn()}
				isLastStep={false}
				isTransitioning={false}
				isPositionReady
				shortcuts={shortcuts}
			/>
		);

		expect(container.textContent).toMatch(/(Cmd|Ctrl)\+I/);
		expect(tooltip().style.opacity).toBe('1');
		expect(tooltip().style.visibility).toBe('visible');
		expect(tooltip().style.transform).toBe('translate(-50%, -50%)');
	});
});
