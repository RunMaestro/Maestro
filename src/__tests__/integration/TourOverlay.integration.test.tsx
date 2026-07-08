import { fireEvent, render, screen } from '@testing-library/react';
import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MODAL_PRIORITIES } from '../../renderer/constants/modalPriorities';
import { TourOverlay } from '../../renderer/components/Wizard/tour/TourOverlay';
import type { Theme } from '../../renderer/types';

const mocks = vi.hoisted(() => ({
	registerLayer: vi.fn(() => 'tour-layer'),
	unregisterLayer: vi.fn(),
	updateLayerHandler: vi.fn(),
	useTour: vi.fn(),
	nextStep: vi.fn(),
	previousStep: vi.fn(),
	goToStep: vi.fn(),
	internalSkipTour: vi.fn(),
	latestOptions: undefined as any,
	completeOnNext: false,
	state: {} as any,
}));

vi.mock('../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: mocks.registerLayer,
		unregisterLayer: mocks.unregisterLayer,
		updateLayerHandler: mocks.updateLayerHandler,
	}),
}));

vi.mock('../../renderer/components/Wizard/tour/useTour', () => ({
	useTour: mocks.useTour,
}));

vi.mock('../../renderer/components/Wizard/tour/TourWelcome', () => ({
	TourWelcome: ({ onStartTour, onSkip }: { onStartTour: () => void; onSkip: () => void }) => (
		<div data-testid="tour-welcome">
			<button onClick={onStartTour}>Start mocked tour</button>
			<button onClick={onSkip}>Skip welcome tour</button>
		</div>
	),
}));

vi.mock('../../renderer/components/Wizard/tour/TourStep', () => ({
	TourStep: ({
		step,
		stepNumber,
		totalSteps,
		onNext,
		onGoToStep,
		onSkip,
		isLastStep,
		isTransitioning,
		isPositionReady,
		fromWizard,
		shortcuts,
	}: any) => (
		<div
			data-testid="tour-step"
			data-step-id={step.id}
			data-step-number={stepNumber}
			data-total-steps={totalSteps}
			data-last={String(isLastStep)}
			data-transitioning={String(isTransitioning)}
			data-ready={String(isPositionReady)}
			data-from-wizard={String(fromWizard)}
			data-has-shortcuts={String(Boolean(shortcuts))}
		>
			<button onClick={onNext}>Continue mocked tour</button>
			<button onClick={() => onGoToStep(0)}>Go to first mocked step</button>
			<button onClick={onSkip}>Skip mocked step</button>
		</div>
	),
}));

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

const step = {
	id: 'mock-step',
	title: 'Mock Step',
	description: 'Mock description',
	selector: null,
};

function setTourState(overrides: Record<string, unknown> = {}) {
	mocks.state = {
		currentStep: step,
		currentStepIndex: 0,
		totalSteps: 5,
		spotlight: null,
		isTransitioning: false,
		isPositionReady: true,
		isLastStep: false,
		...overrides,
	};
}

function renderOverlay(props: Partial<React.ComponentProps<typeof TourOverlay>> = {}) {
	return render(<TourOverlay theme={theme} isOpen onClose={vi.fn()} {...props} />);
}

describe('TourOverlay', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.completeOnNext = false;
		setTourState();
		mocks.nextStep.mockImplementation(() => {
			if (mocks.completeOnNext) {
				mocks.latestOptions?.onComplete();
			}
		});
		mocks.internalSkipTour.mockImplementation(() => {
			mocks.latestOptions?.onComplete();
		});
		mocks.useTour.mockImplementation((options: any) => {
			mocks.latestOptions = options;
			return {
				...mocks.state,
				nextStep: mocks.nextStep,
				previousStep: mocks.previousStep,
				goToStep: mocks.goToStep,
				skipTour: mocks.internalSkipTour,
			};
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('renders nothing and avoids layer registration when closed', () => {
		const onTourStart = vi.fn();

		renderOverlay({ isOpen: false, onTourStart });
		fireEvent.keyDown(window, { key: 'Enter' });

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		expect(onTourStart).not.toHaveBeenCalled();
		expect(mocks.registerLayer).not.toHaveBeenCalled();
		expect(mocks.nextStep).not.toHaveBeenCalled();
	});

	it('starts analytics once per open session and unregisters the layer when closed', () => {
		const onTourStart = vi.fn();
		const onClose = vi.fn();
		const { rerender, unmount } = renderOverlay({ onClose, onTourStart });

		expect(screen.getByRole('dialog', { name: /interface tour/i })).toBeInTheDocument();
		expect(screen.getByTestId('tour-welcome')).toBeInTheDocument();
		expect(onTourStart).toHaveBeenCalledTimes(1);
		expect(mocks.registerLayer).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'modal',
				priority: MODAL_PRIORITIES.TOUR,
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'lenient',
				onEscape: expect.any(Function),
			})
		);

		rerender(<TourOverlay theme={theme} isOpen onClose={onClose} onTourStart={onTourStart} />);
		expect(onTourStart).toHaveBeenCalledTimes(1);

		rerender(
			<TourOverlay theme={theme} isOpen={false} onClose={onClose} onTourStart={onTourStart} />
		);
		expect(mocks.unregisterLayer).toHaveBeenCalledWith('tour-layer');

		rerender(<TourOverlay theme={theme} isOpen onClose={onClose} onTourStart={onTourStart} />);
		expect(onTourStart).toHaveBeenCalledTimes(2);

		unmount();
	});

	it('does not double-count tour starts under StrictMode effect replay', () => {
		const onTourStart = vi.fn();

		render(
			<StrictMode>
				<TourOverlay theme={theme} isOpen onClose={vi.fn()} onTourStart={onTourStart} />
			</StrictMode>
		);

		expect(onTourStart).toHaveBeenCalledTimes(1);
	});

	it('starts from the welcome screen with click or Enter and routes step keyboard navigation', () => {
		renderOverlay();

		fireEvent.keyDown(window, { key: 'ArrowRight' });
		fireEvent.keyDown(window, { key: 'ArrowLeft' });
		expect(mocks.nextStep).not.toHaveBeenCalled();
		expect(mocks.previousStep).not.toHaveBeenCalled();

		fireEvent.keyDown(window, { key: 'Enter' });
		expect(screen.queryByTestId('tour-welcome')).not.toBeInTheDocument();
		expect(screen.getByTestId('tour-step')).toBeInTheDocument();

		fireEvent.keyDown(window, { key: 'ArrowRight' });
		fireEvent.keyDown(window, { key: 'ArrowDown' });
		fireEvent.keyDown(window, { key: ' ' });
		fireEvent.keyDown(window, { key: 'Unhandled' });
		fireEvent.keyDown(window, { key: 'ArrowLeft' });
		fireEvent.keyDown(window, { key: 'ArrowUp' });

		expect(mocks.nextStep).toHaveBeenCalledTimes(3);
		expect(mocks.previousStep).toHaveBeenCalledTimes(2);
	});

	it('skips without reporting completion from welcome controls or Escape', () => {
		const onClose = vi.fn();
		const onTourSkip = vi.fn();
		const onTourComplete = vi.fn();
		setTourState({ currentStepIndex: 2 });
		const { unmount } = renderOverlay({ onClose, onTourSkip, onTourComplete });

		fireEvent.click(screen.getByRole('button', { name: /skip welcome tour/i }));

		expect(onTourSkip).toHaveBeenCalledWith(3);
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onTourComplete).not.toHaveBeenCalled();
		expect(mocks.internalSkipTour).not.toHaveBeenCalled();

		unmount();
		vi.clearAllMocks();
		setTourState({ currentStepIndex: 1 });
		renderOverlay({ onClose, onTourSkip, onTourComplete });

		const escapeHandler = mocks.updateLayerHandler.mock.calls.at(-1)?.[1] as
			(() => void) | undefined;
		expect(escapeHandler).toBeDefined();
		escapeHandler?.();

		expect(onTourSkip).toHaveBeenCalledWith(2);
		expect(onClose).toHaveBeenCalledTimes(1);
		expect(onTourComplete).not.toHaveBeenCalled();
		expect(mocks.internalSkipTour).not.toHaveBeenCalled();
	});

	it('treats Enter on the last step as completion instead of skip', () => {
		const onClose = vi.fn();
		const onTourSkip = vi.fn();
		const onTourComplete = vi.fn();
		mocks.completeOnNext = true;
		setTourState({
			currentStep: { ...step, id: 'last-step' },
			currentStepIndex: 4,
			isLastStep: true,
		});
		renderOverlay({ onClose, onTourSkip, onTourComplete });

		fireEvent.click(screen.getByRole('button', { name: /start mocked tour/i }));
		fireEvent.keyDown(window, { key: 'Enter' });

		expect(mocks.nextStep).toHaveBeenCalledTimes(1);
		expect(onTourComplete).toHaveBeenCalledWith(5);
		expect(onTourSkip).not.toHaveBeenCalled();
		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('closes on completion even when no completion analytics callback is supplied', () => {
		const onClose = vi.fn();
		mocks.completeOnNext = true;
		setTourState({
			currentStep: { ...step, id: 'last-step' },
			currentStepIndex: 4,
			isLastStep: true,
		});
		renderOverlay({ onClose });

		fireEvent.click(screen.getByRole('button', { name: /start mocked tour/i }));
		fireEvent.keyDown(window, { key: 'Enter' });

		expect(onClose).toHaveBeenCalledTimes(1);
	});

	it('passes state to TourStep and renders spotlight styles when the step is active', () => {
		setTourState({
			currentStep: { ...step, id: 'spotlight-step' },
			currentStepIndex: 1,
			spotlight: {
				rect: { x: 20, y: 30, width: 40, height: 50 },
				padding: 4,
				borderRadius: 6,
			},
			isTransitioning: true,
			isPositionReady: false,
		});
		renderOverlay({
			fromWizard: true,
			shortcuts: {
				help: { id: 'help', label: 'Help', keys: ['Meta', '/'] },
			},
		});

		fireEvent.click(screen.getByRole('button', { name: /start mocked tour/i }));

		const dialog = screen.getByRole('dialog', { name: /interface tour/i });
		const backdrop = dialog.firstElementChild as HTMLElement;
		const stepElement = screen.getByTestId('tour-step');

		expect(backdrop.style.clipPath).toContain('polygon');
		expect(stepElement).toHaveAttribute('data-step-id', 'spotlight-step');
		expect(stepElement).toHaveAttribute('data-step-number', '2');
		expect(stepElement).toHaveAttribute('data-total-steps', '5');
		expect(stepElement).toHaveAttribute('data-transitioning', 'true');
		expect(stepElement).toHaveAttribute('data-ready', 'false');
		expect(stepElement).toHaveAttribute('data-from-wizard', 'true');
		expect(stepElement).toHaveAttribute('data-has-shortcuts', 'true');

		fireEvent.click(screen.getByRole('button', { name: /continue mocked tour/i }));
		fireEvent.click(screen.getByRole('button', { name: /go to first mocked step/i }));
		fireEvent.click(screen.getByRole('button', { name: /skip mocked step/i }));

		expect(mocks.nextStep).toHaveBeenCalledTimes(1);
		expect(mocks.goToStep).toHaveBeenCalledWith(0);
	});

	it('uses default spotlight padding and radius when the hook omits them', () => {
		setTourState({
			currentStep: { ...step, id: 'default-spotlight-step' },
			spotlight: {
				rect: { x: 20, y: 30, width: 40, height: 50 },
				padding: undefined,
				borderRadius: undefined,
			},
			isTransitioning: false,
			isPositionReady: true,
		});
		renderOverlay();

		fireEvent.click(screen.getByRole('button', { name: /start mocked tour/i }));

		const dialog = screen.getByRole('dialog', { name: /interface tour/i });
		const backdrop = dialog.firstElementChild as HTMLElement;
		const spotlightRing = dialog.querySelector('div[class*="pointer-events-none"]') as HTMLElement;

		expect(backdrop.style.clipPath).toContain('12px 30px');
		expect(spotlightRing?.style.left).toBe('10px');
		expect(spotlightRing?.style.top).toBe('20px');
		expect(spotlightRing?.style.width).toBe('60px');
		expect(spotlightRing?.style.height).toBe('70px');
		expect(spotlightRing?.style.borderRadius).toBe('10px');
		expect(spotlightRing?.style.opacity).toBe('1');
	});

	it('renders no step overlay after welcome when the current step is unavailable', () => {
		setTourState({ currentStep: null });
		renderOverlay();

		expect(screen.getByTestId('tour-welcome')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /start mocked tour/i }));

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});
});
