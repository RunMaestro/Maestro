import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaestroWizard } from '../../../../renderer/components/Wizard/MaestroWizard';
import type { Theme } from '../../../../renderer/types';

type WizardStep =
	| 'agent-selection'
	| 'directory-selection'
	| 'conversation'
	| 'preparing-plan'
	| 'phase-review';

const wizardMock = vi.hoisted(() => {
	const stepIndex: Record<string, number> = {
		'agent-selection': 1,
		'directory-selection': 2,
		conversation: 3,
		'preparing-plan': 4,
		'phase-review': 5,
	};
	const indexToStep: Record<number, WizardStep> = {
		1: 'agent-selection',
		2: 'directory-selection',
		3: 'conversation',
		4: 'preparing-plan',
		5: 'phase-review',
	};
	const state = {
		isOpen: true,
		currentStep: 'agent-selection' as string,
	};

	return {
		stepIndex,
		indexToStep,
		state,
		closeWizard: vi.fn(),
		saveStateForResume: vi.fn(),
		clearResumeState: vi.fn(),
		resetWizard: vi.fn(),
		goToStep: vi.fn(),
		getCurrentStepNumber: vi.fn(() => stepIndex[state.currentStep] ?? 0),
	};
});

const layerMock = vi.hoisted(() => ({
	registerLayer: vi.fn(() => 'wizard-layer'),
	unregisterLayer: vi.fn(),
}));

vi.mock('../../../../renderer/components/Wizard/WizardContext', () => ({
	useWizard: () => ({
		state: wizardMock.state,
		closeWizard: wizardMock.closeWizard,
		saveStateForResume: wizardMock.saveStateForResume,
		clearResumeState: wizardMock.clearResumeState,
		resetWizard: wizardMock.resetWizard,
		goToStep: wizardMock.goToStep,
		getCurrentStepNumber: wizardMock.getCurrentStepNumber,
	}),
	WIZARD_TOTAL_STEPS: 5,
	STEP_INDEX: wizardMock.stepIndex,
	INDEX_TO_STEP: wizardMock.indexToStep,
}));

vi.mock('../../../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => layerMock,
}));

vi.mock('../../../../renderer/components/Wizard/ScreenReaderAnnouncement', () => ({
	ScreenReaderAnnouncement: ({
		message,
		announceKey,
	}: {
		message: string;
		announceKey: number;
	}) => (
		<div role="status" data-announce-key={announceKey}>
			{message}
		</div>
	),
}));

vi.mock('../../../../renderer/components/Wizard/WizardExitConfirmModal', () => ({
	WizardExitConfirmModal: ({
		onConfirmExit,
		onCancel,
		onQuitWithoutSaving,
	}: {
		onConfirmExit: () => void;
		onCancel: () => void;
		onQuitWithoutSaving: () => void;
	}) => (
		<div role="alertdialog" aria-label="Exit confirmation">
			<button onClick={onCancel}>Stay in wizard</button>
			<button onClick={onConfirmExit}>Exit and save progress</button>
			<button onClick={onQuitWithoutSaving}>Quit without saving</button>
		</div>
	),
}));

vi.mock('../../../../renderer/components/Wizard/screens', () => ({
	AgentSelectionScreen: () => <button>Agent selection control</button>,
	DirectorySelectionScreen: () => <button>Directory selection control</button>,
	ConversationScreen: ({
		showThinking,
		setShowThinking,
	}: {
		showThinking: boolean;
		setShowThinking: React.Dispatch<React.SetStateAction<boolean>>;
	}) => (
		<div>
			<span data-testid="thinking-state">
				{showThinking ? 'thinking-visible' : 'thinking-hidden'}
			</span>
			<button onClick={() => setShowThinking((previous) => !previous)}>Toggle thinking</button>
		</div>
	),
	PreparingPlanScreen: () => <button>Preparing plan control</button>,
	PhaseReviewScreen: ({
		onLaunchSession,
		onWizardComplete,
	}: {
		onLaunchSession: (wantsTour: boolean) => Promise<void>;
		onWizardComplete?: (
			durationMs: number,
			conversationExchanges: number,
			phasesGenerated: number,
			tasksGenerated: number
		) => void;
	}) => (
		<div>
			<button onClick={() => void onLaunchSession(true)}>Launch with tour</button>
			<button onClick={() => onWizardComplete?.(1000, 2, 3, 4)}>Complete analytics</button>
		</div>
	),
}));

const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#222222',
		bgActivity: '#333333',
		textMain: '#ffffff',
		textDim: '#cccccc',
		accent: '#88ccff',
		accentForeground: '#000000',
		border: '#444444',
		success: '#00ff88',
		warning: '#ffaa00',
		error: '#ff3366',
		info: '#66ddff',
	},
};

describe('MaestroWizard orchestrator', () => {
	const originalRequestAnimationFrame = window.requestAnimationFrame;

	beforeEach(() => {
		vi.clearAllMocks();
		wizardMock.state.isOpen = true;
		wizardMock.state.currentStep = 'agent-selection';
		window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		}) as typeof window.requestAnimationFrame;
	});

	afterEach(() => {
		vi.useRealTimers();
		window.requestAnimationFrame = originalRequestAnimationFrame;
	});

	it('returns null when the wizard is closed', () => {
		wizardMock.state.isOpen = false;

		render(<MaestroWizard theme={mockTheme} />);

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});

	it('uses the fallback title and screen branch for an unknown step', () => {
		wizardMock.state.currentStep = 'unknown-step';

		render(<MaestroWizard theme={mockTheme} />);

		expect(screen.getByRole('heading', { name: 'Setup Wizard' })).toBeInTheDocument();
		expect(screen.queryByText('Agent selection control')).not.toBeInTheDocument();
	});

	it('renders the directory selection step title and screen', () => {
		wizardMock.state.currentStep = 'directory-selection';

		render(<MaestroWizard theme={mockTheme} />);

		expect(screen.getByRole('heading', { name: 'Choose Project Directory' })).toBeInTheDocument();
		expect(screen.getByText('Directory selection control')).toBeInTheDocument();
	});

	it('records fresh starts and resumed starts once per open session', () => {
		const onWizardStart = vi.fn();
		const { rerender } = render(<MaestroWizard theme={mockTheme} onWizardStart={onWizardStart} />);

		expect(onWizardStart).toHaveBeenCalledTimes(1);
		rerender(<MaestroWizard theme={mockTheme} onWizardStart={onWizardStart} />);
		expect(onWizardStart).toHaveBeenCalledTimes(1);

		const replacementStart = vi.fn();
		rerender(<MaestroWizard theme={mockTheme} onWizardStart={replacementStart} />);
		expect(replacementStart).not.toHaveBeenCalled();

		wizardMock.state.currentStep = 'conversation';
		const onWizardResume = vi.fn();
		render(<MaestroWizard theme={mockTheme} onWizardResume={onWizardResume} />);

		expect(onWizardResume).toHaveBeenCalledTimes(1);
	});

	it('closes directly from step one when the backdrop is clicked', () => {
		const { container } = render(<MaestroWizard theme={mockTheme} />);

		fireEvent.click(container.querySelector('.wizard-backdrop')!);

		expect(wizardMock.closeWizard).toHaveBeenCalled();
	});

	it('cancels, saves, and quits from the exit confirmation flow', () => {
		const onWizardAbandon = vi.fn();
		wizardMock.state.currentStep = 'conversation';
		render(<MaestroWizard theme={mockTheme} onWizardAbandon={onWizardAbandon} />);

		fireEvent.click(screen.getByRole('button', { name: 'Close wizard' }));
		fireEvent.click(screen.getByRole('button', { name: 'Stay in wizard' }));
		expect(
			screen.queryByRole('alertdialog', { name: 'Exit confirmation' })
		).not.toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Close wizard' }));
		fireEvent.click(screen.getByRole('button', { name: 'Exit and save progress' }));
		expect(wizardMock.saveStateForResume).toHaveBeenCalled();
		expect(onWizardAbandon).toHaveBeenCalledTimes(1);
		expect(wizardMock.closeWizard).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: 'Close wizard' }));
		fireEvent.click(screen.getByRole('button', { name: 'Quit without saving' }));
		expect(wizardMock.clearResumeState).toHaveBeenCalled();
		expect(wizardMock.resetWizard).toHaveBeenCalled();
		expect(onWizardAbandon).toHaveBeenCalledTimes(2);
		expect(wizardMock.closeWizard).toHaveBeenCalledTimes(2);
	});

	it('allows exit confirmation actions without abandonment analytics', () => {
		wizardMock.state.currentStep = 'conversation';
		render(<MaestroWizard theme={mockTheme} />);

		fireEvent.click(screen.getByRole('button', { name: 'Close wizard' }));
		fireEvent.click(screen.getByRole('button', { name: 'Exit and save progress' }));
		expect(wizardMock.saveStateForResume).toHaveBeenCalledTimes(1);
		expect(wizardMock.closeWizard).toHaveBeenCalledTimes(1);

		fireEvent.click(screen.getByRole('button', { name: 'Close wizard' }));
		fireEvent.click(screen.getByRole('button', { name: 'Quit without saving' }));
		expect(wizardMock.clearResumeState).toHaveBeenCalledTimes(1);
		expect(wizardMock.resetWizard).toHaveBeenCalledTimes(1);
		expect(wizardMock.closeWizard).toHaveBeenCalledTimes(2);
	});

	it('syncs restored step changes when the wizard opens and announces the displayed step', () => {
		wizardMock.state.isOpen = false;
		const { container, rerender } = render(<MaestroWizard theme={mockTheme} />);
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

		wizardMock.state.isOpen = true;
		wizardMock.state.currentStep = 'preparing-plan';
		act(() => {
			rerender(<MaestroWizard theme={mockTheme} />);
		});

		expect(screen.getByText('Preparing plan control')).toBeInTheDocument();
		expect(screen.getByRole('status')).toHaveTextContent('Step 4 of 5: Preparing Playbooks');
		expect(container.querySelector('.wizard-content-entering')).toBeInTheDocument();
	});

	it('runs fade timers when the displayed step transitions forward', async () => {
		const { container, rerender } = render(<MaestroWizard theme={mockTheme} />);

		wizardMock.state.currentStep = 'conversation';
		act(() => {
			rerender(<MaestroWizard theme={mockTheme} />);
		});

		expect(container.querySelector('.wizard-content-exiting')).toBeInTheDocument();

		expect(await screen.findByTestId('thinking-state')).toHaveTextContent('thinking-hidden');
		await waitFor(() => {
			expect(container.querySelector('.wizard-content-entering')).toBeInTheDocument();
		});
	});

	it('runs fade timers when the displayed step transitions backward', () => {
		wizardMock.state.currentStep = 'phase-review';
		const { container, rerender } = render(<MaestroWizard theme={mockTheme} />);

		wizardMock.state.currentStep = 'directory-selection';
		act(() => {
			rerender(<MaestroWizard theme={mockTheme} />);
		});

		expect(container.querySelector('.wizard-content-exiting')).toBeInTheDocument();
		expect(container.querySelector('.wizard-backward')).toBeInTheDocument();
	});

	it('cleans pending fade timers when a transition is interrupted by unmount', () => {
		vi.useFakeTimers();
		const { rerender, unmount } = render(<MaestroWizard theme={mockTheme} />);

		wizardMock.state.currentStep = 'conversation';
		act(() => {
			rerender(<MaestroWizard theme={mockTheme} />);
		});

		unmount();

		act(() => {
			vi.runOnlyPendingTimers();
		});

		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
	});

	it('keeps global keyboard behavior inside the modal', () => {
		wizardMock.state.currentStep = 'conversation';
		const documentKeydown = vi.fn();
		document.addEventListener('keydown', documentKeydown);
		render(<MaestroWizard theme={mockTheme} />);

		const dialog = screen.getByRole('dialog');
		expect(screen.getByTestId('thinking-state')).toHaveTextContent('thinking-hidden');

		fireEvent.keyDown(dialog, { key: 'K', metaKey: true, shiftKey: true });
		expect(screen.getByTestId('thinking-state')).toHaveTextContent('thinking-visible');

		fireEvent.keyDown(dialog, { key: 'K', ctrlKey: true, shiftKey: true });
		expect(screen.getByTestId('thinking-state')).toHaveTextContent('thinking-hidden');

		documentKeydown.mockClear();
		fireEvent.keyDown(dialog, { key: 'e', metaKey: true });
		expect(documentKeydown).not.toHaveBeenCalled();

		documentKeydown.mockClear();
		fireEvent.keyDown(dialog, { key: 'e', ctrlKey: true });
		expect(documentKeydown).not.toHaveBeenCalled();

		documentKeydown.mockClear();
		fireEvent.keyDown(dialog, { key: 'x', metaKey: true });
		expect(documentKeydown).toHaveBeenCalled();
		document.removeEventListener('keydown', documentKeydown);
	});

	it('lets global thinking shortcuts pass through outside the conversation step', () => {
		wizardMock.state.currentStep = 'directory-selection';
		const documentKeydown = vi.fn();
		document.addEventListener('keydown', documentKeydown);
		render(<MaestroWizard theme={mockTheme} />);

		fireEvent.keyDown(screen.getByRole('dialog'), { key: 'K', ctrlKey: true, shiftKey: true });

		expect(documentKeydown).toHaveBeenCalled();
		document.removeEventListener('keydown', documentKeydown);
	});

	it('traps Tab and Shift+Tab focus within the modal', () => {
		render(<MaestroWizard theme={mockTheme} />);

		const closeButton = screen.getByRole('button', { name: 'Close wizard' });
		const contentButton = screen.getByRole('button', { name: 'Agent selection control' });

		contentButton.focus();
		fireEvent.keyDown(document, { key: 'Tab' });
		expect(closeButton).toHaveFocus();

		fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
		expect(contentButton).toHaveFocus();

		document.body.focus();
		fireEvent.keyDown(document, { key: 'Tab' });
		expect(closeButton).toHaveFocus();
	});

	it('allows normal Tab navigation when focus is already inside modal bounds', () => {
		wizardMock.state.currentStep = 'preparing-plan';
		render(<MaestroWizard theme={mockTheme} />);

		const middleButton = screen.getByRole('button', {
			name: 'Step 2 (completed - click to go back)',
		});
		middleButton.focus();

		const forwardTab = new KeyboardEvent('keydown', {
			key: 'Tab',
			bubbles: true,
			cancelable: true,
		});
		document.dispatchEvent(forwardTab);
		expect(forwardTab.defaultPrevented).toBe(false);
		expect(middleButton).toHaveFocus();

		const backwardTab = new KeyboardEvent('keydown', {
			key: 'Tab',
			shiftKey: true,
			bubbles: true,
			cancelable: true,
		});
		document.dispatchEvent(backwardTab);
		expect(backwardTab.defaultPrevented).toBe(false);
		expect(middleButton).toHaveFocus();
	});

	it('routes completed progress dots and the back button to previous steps', () => {
		wizardMock.state.currentStep = 'preparing-plan';
		render(<MaestroWizard theme={mockTheme} />);

		fireEvent.click(screen.getByRole('button', { name: 'Step 2 (completed - click to go back)' }));
		expect(wizardMock.goToStep).toHaveBeenCalledWith('directory-selection');

		fireEvent.click(screen.getByRole('button', { name: 'Go back to previous step' }));
		expect(wizardMock.goToStep).toHaveBeenCalledWith('conversation');
	});

	it('provides a no-op launch fallback and forwards completion analytics in phase review', () => {
		const onWizardComplete = vi.fn();
		wizardMock.state.currentStep = 'phase-review';

		render(<MaestroWizard theme={mockTheme} onWizardComplete={onWizardComplete} />);

		expect(() =>
			fireEvent.click(screen.getByRole('button', { name: 'Launch with tour' }))
		).not.toThrow();
		fireEvent.click(screen.getByRole('button', { name: 'Complete analytics' }));
		expect(onWizardComplete).toHaveBeenCalledWith(1000, 2, 3, 4);
	});
});
