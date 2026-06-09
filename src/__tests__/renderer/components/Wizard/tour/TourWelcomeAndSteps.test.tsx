import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TourStep } from '../../../../../renderer/components/Wizard/tour/TourStep';
import { TourWelcome } from '../../../../../renderer/components/Wizard/tour/TourWelcome';
import {
	replaceShortcutPlaceholders,
	tourSteps,
} from '../../../../../renderer/components/Wizard/tour/tourSteps';
import type { Theme, Shortcut } from '../../../../../renderer/types';

const theme = {
	name: 'test',
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
	goToAutoRun: { id: 'goToAutoRun', label: 'Go to Auto Run', keys: ['Meta', 'Shift', 'w'] },
	focusInput: { id: 'focusInput', label: 'Focus Input', keys: ['Meta', 'i'] },
	help: { id: 'help', label: 'Help', keys: ['Meta', '/'] },
	newTab: { id: 'newTab', label: 'New Tab', keys: ['Meta', 't'] },
	closeTab: { id: 'closeTab', label: 'Close Tab', keys: ['Meta', 'w'] },
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

function renderTourStep(
	props: Partial<React.ComponentProps<typeof TourStep>> = {},
	step = tourSteps[0]
) {
	return render(
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
			{...props}
		/>
	);
}

afterEach(() => {
	setViewport(originalViewport.width, originalViewport.height);
});

describe('TourWelcome', () => {
	it('renders the shared welcome content and routes start or skip actions', () => {
		const onStartTour = vi.fn();
		const onSkip = vi.fn();

		render(<TourWelcome theme={theme} onStartTour={onStartTour} onSkip={onSkip} />);

		expect(screen.getByRole('img', { name: /maestro/i })).toBeInTheDocument();
		expect(screen.getByRole('heading', { name: /welcome to maestro/i })).toBeInTheDocument();
		expect(screen.getByText(/manage multiple ai agents in parallel/i)).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /let's take a tour/i }));
		fireEvent.click(screen.getByRole('button', { name: /skip tour/i }));

		expect(onStartTour).toHaveBeenCalledTimes(1);
		expect(onSkip).toHaveBeenCalledTimes(1);
	});
});

describe('tourSteps', () => {
	it('defines the tour order and UI actions for the main interface surfaces', () => {
		expect(tourSteps.map((step) => step.id)).toEqual([
			'autorun-panel',
			'autorun-documents',
			'files-tab',
			'history-tab',
			'hamburger-menu',
			'remote-control',
			'session-list',
			'main-terminal',
			'agent-sessions',
			'input-area',
			'terminal-mode',
			'keyboard-shortcuts',
		]);

		expect(tourSteps[0]).toMatchObject({
			title: 'Auto Run Panel',
			selector: '[data-tour="autorun-tab"]',
			position: 'left',
			uiActions: [{ type: 'setRightTab', value: 'autorun' }, { type: 'openRightPanel' }],
		});
		expect(tourSteps[4].uiActions).toEqual([{ type: 'openHamburgerMenu' }]);
		expect(tourSteps[5].uiActions).toEqual([{ type: 'closeHamburgerMenu' }]);
		expect(tourSteps.at(-1)).toMatchObject({
			id: 'keyboard-shortcuts',
			selector: null,
			position: 'center',
			uiActions: [],
		});
	});

	it('replaces known shortcut placeholders and preserves unknown placeholders', () => {
		const text = 'Press {{goToAutoRun}}, {{focusInput}}, and {{unknownShortcut}}.';

		expect(replaceShortcutPlaceholders(text, shortcuts)).toBe(
			'Press Ctrl+Shift+W, Ctrl+I, and {{unknownShortcut}}.'
		);
	});

	it('renders generic tour copy with inline icons for tab search and input controls', () => {
		const onNext = vi.fn();
		const onGoToStep = vi.fn();
		const onSkip = vi.fn();
		const terminalStep = tourSteps.find((step) => step.id === 'main-terminal');
		const inputStep = tourSteps.find((step) => step.id === 'input-area');

		expect(terminalStep).toBeDefined();
		expect(inputStep).toBeDefined();

		const { rerender } = render(
			<TourStep
				theme={theme}
				step={terminalStep!}
				stepNumber={8}
				totalSteps={tourSteps.length}
				spotlight={null}
				onNext={onNext}
				onGoToStep={onGoToStep}
				onSkip={onSkip}
				isLastStep={false}
				isTransitioning={false}
				isPositionReady
				shortcuts={shortcuts}
			/>
		);

		expect(screen.getByRole('heading', { name: /ai terminal & tabs/i })).toBeInTheDocument();
		expect(screen.getByText(/searchable tab overview/i)).toBeInTheDocument();
		expect(screen.getByText(/fresh context/i)).toBeInTheDocument();
		expect(screen.getByText(/ctrl\+shift\+t/i)).toBeInTheDocument();

		rerender(
			<TourStep
				theme={theme}
				step={inputStep!}
				stepNumber={10}
				totalSteps={tourSteps.length}
				spotlight={null}
				onNext={onNext}
				onGoToStep={onGoToStep}
				onSkip={onSkip}
				isLastStep={false}
				isTransitioning={false}
				isPositionReady
				fromWizard
				shortcuts={shortcuts}
			/>
		);

		expect(screen.getByText(/during auto run/i)).toBeInTheDocument();
		expect(screen.getByText(/read-only/i)).toBeInTheDocument();
		expect(screen.getAllByText(/thinking/i).length).toBeGreaterThan(0);
		expect(screen.getAllByText(/enter/i).length).toBeGreaterThan(0);
		expect(screen.getByText(/ctrl\+i/i)).toBeInTheDocument();
	});

	it('renders last-step navigation and lets users jump only to past steps', () => {
		const onNext = vi.fn();
		const onGoToStep = vi.fn();
		const onSkip = vi.fn();

		render(
			<TourStep
				theme={theme}
				step={tourSteps.at(-1)!}
				stepNumber={12}
				totalSteps={tourSteps.length}
				spotlight={null}
				onNext={onNext}
				onGoToStep={onGoToStep}
				onSkip={onSkip}
				isLastStep
				isTransitioning={false}
				isPositionReady
				shortcuts={shortcuts}
			/>
		);

		fireEvent.click(screen.getByRole('button', { name: /finish tour/i }));
		fireEvent.click(screen.getByRole('button', { name: /skip tour/i }));
		fireEvent.click(screen.getByTitle('Go back to step 1'));

		const progressDots = screen.getAllByRole('button', { name: '' });
		const disabledCurrentDot = progressDots.at(-1);

		expect(onNext).toHaveBeenCalledTimes(1);
		expect(onSkip).toHaveBeenCalledTimes(1);
		expect(onGoToStep).toHaveBeenCalledWith(0);
		expect(disabledCurrentDot).toBeDisabled();
		expect(screen.getByText('Esc')).toBeInTheDocument();
	});

	it('positions tooltips around a spotlight according to the preferred side', () => {
		setViewport(1000, 800);
		const { container, rerender } = renderTourStep({
			step: { ...tourSteps[0], position: 'top' },
			spotlight: {
				rect: { x: 420, y: 500, width: 80, height: 40 },
				padding: 8,
				borderRadius: 8,
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
					rect: { x: 420, y: 100, width: 80, height: 40 },
					padding: 8,
					borderRadius: 8,
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
				step={{ ...tourSteps[0], position: 'left' }}
				stepNumber={1}
				totalSteps={tourSteps.length}
				spotlight={{
					rect: { x: 700, y: 300, width: 80, height: 40 },
					padding: 8,
					borderRadius: 8,
				}}
				onNext={vi.fn()}
				onGoToStep={vi.fn()}
				onSkip={vi.fn()}
				isLastStep={false}
				isTransitioning={false}
				isPositionReady
			/>
		);
		expect(tooltip().style.right).toBe('324px');

		rerender(
			<TourStep
				theme={theme}
				step={{ ...tourSteps[0], position: 'right' }}
				stepNumber={1}
				totalSteps={tourSteps.length}
				spotlight={{
					rect: { x: 100, y: 300, width: 80, height: 40 },
					padding: 8,
					borderRadius: 8,
				}}
				onNext={vi.fn()}
				onGoToStep={vi.fn()}
				onSkip={vi.fn()}
				isLastStep={false}
				isTransitioning={false}
				isPositionReady
			/>
		);
		expect(tooltip().style.left).toBe('204px');
	});

	it('falls back to available space and supports center-overlay positioning', () => {
		setViewport(1000, 800);
		const { container, rerender } = renderTourStep({
			step: { ...tourSteps[0], position: 'top' },
			spotlight: {
				rect: { x: 420, y: 12, width: 80, height: 40 },
				padding: 8,
				borderRadius: 8,
			},
		});
		const tooltip = () => container.firstElementChild as HTMLElement;

		expect(tooltip().style.top).toBe('76px');

		rerender(
			<TourStep
				theme={theme}
				step={{ ...tourSteps[0], position: 'center-overlay' }}
				stepNumber={1}
				totalSteps={tourSteps.length}
				spotlight={{
					rect: { x: 100, y: 150, width: 50, height: 70 },
					padding: 8,
					borderRadius: 8,
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

	it('falls back from bottom, left, and right when the preferred side is cramped', () => {
		setViewport(1000, 800);
		const { container, rerender } = renderTourStep({
			step: { ...tourSteps[0], position: 'bottom' },
			spotlight: {
				rect: { x: 420, y: 740, width: 80, height: 40 },
				padding: 8,
				borderRadius: 8,
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
					rect: { x: 8, y: 300, width: 80, height: 40 },
					padding: 8,
					borderRadius: 8,
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
					rect: { x: 920, y: 300, width: 70, height: 40 },
					padding: 8,
					borderRadius: 8,
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

	it('keeps unknown placeholders, supports plain copy, and hides until positioning is ready', () => {
		const plainStep = {
			...tourSteps[0],
			description: 'Plain {{missingShortcut}} description',
			descriptionGeneric: undefined,
		};
		const { container, rerender } = renderTourStep(
			{
				step: plainStep,
				shortcuts: {},
				isPositionReady: false,
				isTransitioning: true,
			},
			plainStep
		);
		const tooltip = () => container.firstElementChild as HTMLElement;

		expect(screen.getByText(/plain/i)).toHaveTextContent('Plain {{missingShortcut}} description');
		expect(tooltip().style.opacity).toBe('0');
		expect(tooltip().style.visibility).toBe('hidden');

		rerender(
			<TourStep
				theme={theme}
				step={plainStep}
				stepNumber={1}
				totalSteps={tourSteps.length}
				spotlight={null}
				onNext={vi.fn()}
				onGoToStep={vi.fn()}
				onSkip={vi.fn()}
				isLastStep={false}
				isTransitioning={false}
				isPositionReady
			/>
		);

		expect(screen.getByText('Plain {{missingShortcut}} description')).toBeInTheDocument();
		expect(tooltip().style.opacity).toBe('1');
		expect(tooltip().style.visibility).toBe('visible');
	});

	it('renders text around shortcut badges and line breaks inside descriptions', () => {
		const step = {
			...tourSteps[0],
			description: 'Press {{focusInput}} now\nThen continue',
			descriptionGeneric: undefined,
		};
		const { container } = renderTourStep({ step, shortcuts }, step);

		expect(container.textContent).toContain('Press');
		expect(container.textContent).toContain('Ctrl+I');
		expect(container.textContent).toContain('now');
		expect(container.textContent).toContain('Then continue');
		expect(container.querySelector('br')).toBeInTheDocument();
	});

	it('renders a shortcut badge when the description is only a placeholder', () => {
		const step = {
			...tourSteps[0],
			description: '{{focusInput}}',
			descriptionGeneric: undefined,
		};
		const { container } = renderTourStep({ step, shortcuts }, step);

		expect(container.textContent).toContain('Ctrl+I');
	});

	it('uses the default bottom position and default spotlight padding', () => {
		setViewport(1000, 800);
		const step = { ...tourSteps[0], position: undefined };
		const { container } = renderTourStep({
			step,
			spotlight: {
				rect: { x: 420, y: 100, width: 80, height: 40 },
				padding: 0,
				borderRadius: 8,
			},
		});

		expect((container.firstElementChild as HTMLElement).style.top).toBe('164px');
	});

	it.each([
		{
			name: 'top to right when top and bottom are cramped',
			position: 'top' as const,
			viewport: [1000, 300] as const,
			rect: { x: 100, y: 12, width: 80, height: 40 },
			styleName: 'left',
			expected: '204px',
		},
		{
			name: 'top to left when top, bottom, and right are cramped',
			position: 'top' as const,
			viewport: [1000, 300] as const,
			rect: { x: 900, y: 12, width: 80, height: 40 },
			styleName: 'right',
			expected: '124px',
		},
		{
			name: 'bottom to right when bottom and top are cramped',
			position: 'bottom' as const,
			viewport: [1000, 300] as const,
			rect: { x: 100, y: 240, width: 80, height: 40 },
			styleName: 'left',
			expected: '204px',
		},
		{
			name: 'bottom to left when bottom, top, and right are cramped',
			position: 'bottom' as const,
			viewport: [1000, 300] as const,
			rect: { x: 900, y: 240, width: 80, height: 40 },
			styleName: 'right',
			expected: '124px',
		},
		{
			name: 'left to bottom when left and right are cramped',
			position: 'left' as const,
			viewport: [450, 800] as const,
			rect: { x: 8, y: 100, width: 80, height: 40 },
			styleName: 'top',
			expected: '164px',
		},
		{
			name: 'left to top when left, right, and bottom are cramped',
			position: 'left' as const,
			viewport: [450, 600] as const,
			rect: { x: 8, y: 500, width: 80, height: 40 },
			styleName: 'bottom',
			expected: '124px',
		},
		{
			name: 'right to bottom when right and left are cramped',
			position: 'right' as const,
			viewport: [450, 800] as const,
			rect: { x: 370, y: 100, width: 70, height: 40 },
			styleName: 'top',
			expected: '164px',
		},
		{
			name: 'right to top when right, left, and bottom are cramped',
			position: 'right' as const,
			viewport: [450, 600] as const,
			rect: { x: 370, y: 500, width: 70, height: 40 },
			styleName: 'bottom',
			expected: '124px',
		},
	])('falls back from $name', ({ position, viewport, rect, styleName, expected }) => {
		setViewport(viewport[0], viewport[1]);
		const { container } = renderTourStep({
			step: { ...tourSteps[0], position },
			spotlight: {
				rect,
				padding: 8,
				borderRadius: 8,
			},
		});

		expect((container.firstElementChild as HTMLElement).style[styleName]).toBe(expected);
	});
});
