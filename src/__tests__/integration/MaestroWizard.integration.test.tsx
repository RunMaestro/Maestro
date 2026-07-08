import React, { useEffect, useRef } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MaestroWizard } from '../../renderer/components/Wizard/MaestroWizard';
import {
	WizardProvider,
	useWizard,
	type WizardContextAPI,
	type WizardState,
} from '../../renderer/components/Wizard/WizardContext';
import { LayerStackProvider } from '../../renderer/contexts/LayerStackContext';
import type { Theme } from '../../renderer/types';

vi.mock('../../renderer/components/Wizard/screens', () => ({
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

const theme: Theme = {
	id: 'integration-theme',
	name: 'Integration Theme',
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

interface HarnessProps {
	initialState?: Partial<WizardState>;
	onWizard?: (wizard: WizardContextAPI) => void;
	wizardProps?: Partial<React.ComponentProps<typeof MaestroWizard>>;
}

function WizardHarness({ initialState, onWizard, wizardProps = {} }: HarnessProps) {
	const wizard = useWizard();
	const didOpenRef = useRef(false);

	useEffect(() => {
		onWizard?.(wizard);
	});

	useEffect(() => {
		if (didOpenRef.current) return;
		didOpenRef.current = true;
		if (initialState) {
			wizard.restoreState(initialState);
		}
		wizard.openWizard();
	}, [initialState, wizard]);

	return <MaestroWizard theme={theme} {...wizardProps} />;
}

function renderWizard({
	initialState,
	wizardProps,
}: {
	initialState?: Partial<WizardState>;
	wizardProps?: Partial<React.ComponentProps<typeof MaestroWizard>>;
} = {}) {
	let latestWizard: WizardContextAPI | undefined;
	const result = render(
		<LayerStackProvider>
			<WizardProvider>
				<WizardHarness
					initialState={initialState}
					wizardProps={wizardProps}
					onWizard={(wizard) => {
						latestWizard = wizard;
					}}
				/>
			</WizardProvider>
		</LayerStackProvider>
	);
	return { ...result, wizard: () => latestWizard! };
}

describe('MaestroWizard integration', () => {
	const originalRequestAnimationFrame = window.requestAnimationFrame;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.settings.set).mockResolvedValue(undefined);
		window.requestAnimationFrame = ((callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		}) as typeof window.requestAnimationFrame;
	});

	afterEach(() => {
		cleanup();
		window.requestAnimationFrame = originalRequestAnimationFrame;
		vi.restoreAllMocks();
	});

	it('renders closed until opened, announces step one, focuses the modal, and closes directly', async () => {
		render(
			<LayerStackProvider>
				<WizardProvider>
					<MaestroWizard theme={theme} />
				</WizardProvider>
			</LayerStackProvider>
		);
		expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		cleanup();

		const onWizardStart = vi.fn();
		const { container } = renderWizard({ wizardProps: { onWizardStart } });

		expect(await screen.findByRole('heading', { name: 'New Agent Wizard' })).toBeInTheDocument();
		expect(onWizardStart).toHaveBeenCalledOnce();
		expect(
			screen
				.getAllByRole('status')
				.find((node) => node.textContent === 'Step 1 of 5: New Agent Wizard')
		).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Close wizard' })).toHaveFocus();

		fireEvent.click(container.querySelector('.wizard-backdrop')!);
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
	});

	it('restores a conversation step, keeps shortcuts inside the modal, and saves or discards exits', async () => {
		const onWizardResume = vi.fn();
		const onWizardAbandon = vi.fn();
		const documentKeydown = vi.fn();
		document.addEventListener('keydown', documentKeydown);

		renderWizard({
			initialState: { currentStep: 'conversation', selectedAgent: 'claude' },
			wizardProps: { onWizardResume, onWizardAbandon },
		});

		expect(await screen.findByRole('heading', { name: 'Project Discovery' })).toBeInTheDocument();
		expect(onWizardResume).toHaveBeenCalledOnce();
		expect(screen.getByTestId('thinking-state')).toHaveTextContent('thinking-hidden');

		fireEvent.keyDown(screen.getByRole('dialog'), { key: 'K', metaKey: true, shiftKey: true });
		expect(screen.getByTestId('thinking-state')).toHaveTextContent('thinking-visible');
		documentKeydown.mockClear();
		fireEvent.keyDown(screen.getByRole('dialog'), { key: 'e', metaKey: true });
		expect(documentKeydown).not.toHaveBeenCalled();

		const contentButton = screen.getByRole('button', { name: 'Toggle thinking' });
		const closeButton = screen.getByRole('button', { name: 'Close wizard' });
		contentButton.focus();
		fireEvent.keyDown(document, { key: 'Tab' });
		expect(
			screen.getByRole('button', { name: 'Step 1 (completed - click to go back)' })
		).toHaveFocus();

		fireEvent.click(closeButton);
		expect(screen.getByRole('dialog', { name: /exit setup wizard/i })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
		expect(screen.queryByRole('dialog', { name: /exit setup wizard/i })).not.toBeInTheDocument();

		fireEvent.click(closeButton);
		fireEvent.click(screen.getByRole('button', { name: 'Exit & Save Progress' }));
		await waitFor(() =>
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'wizardResumeState',
				expect.objectContaining({ currentStep: 'conversation', selectedAgent: 'claude' })
			)
		);
		await waitFor(() => expect(onWizardAbandon).toHaveBeenCalledOnce());
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
		document.removeEventListener('keydown', documentKeydown);
	});

	it('routes progress dots, back navigation, phase review callbacks, and quit without saving', async () => {
		const onLaunchSession = vi.fn().mockResolvedValue(undefined);
		const onWizardComplete = vi.fn();
		const onWizardAbandon = vi.fn();
		const { wizard } = renderWizard({
			wizardProps: { onLaunchSession, onWizardComplete, onWizardAbandon },
		});

		await screen.findByRole('heading', { name: 'New Agent Wizard' });
		act(() => {
			wizard().goToStep('phase-review');
		});
		expect(
			await screen.findByRole('heading', { name: 'Review Your Playbooks' })
		).toBeInTheDocument();
		expect(await screen.findByRole('button', { name: 'Launch with tour' })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Launch with tour' }));
		expect(onLaunchSession).toHaveBeenCalledWith(true);
		fireEvent.click(screen.getByRole('button', { name: 'Complete analytics' }));
		expect(onWizardComplete).toHaveBeenCalledWith(1000, 2, 3, 4);

		fireEvent.click(screen.getByRole('button', { name: 'Step 2 (completed - click to go back)' }));
		expect(
			await screen.findByRole('heading', { name: 'Choose Project Directory' })
		).toBeInTheDocument();
		act(() => {
			wizard().goToStep('preparing-plan');
		});
		expect(await screen.findByRole('heading', { name: 'Preparing Playbooks' })).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Go back to previous step' }));
		expect(await screen.findByRole('heading', { name: 'Project Discovery' })).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Close wizard' }));
		fireEvent.click(screen.getByRole('button', { name: 'Just Quit' }));
		await waitFor(() =>
			expect(window.maestro.settings.set).toHaveBeenCalledWith('wizardResumeState', null)
		);
		await waitFor(() => expect(onWizardAbandon).toHaveBeenCalledOnce());
		await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
	});

	it('handles unknown restored steps and the phase-review launch fallback', async () => {
		const { wizard } = renderWizard({
			initialState: { currentStep: 'unknown-step' as WizardState['currentStep'] },
		});

		expect(await screen.findByRole('heading', { name: 'Setup Wizard' })).toBeInTheDocument();
		expect(screen.queryByText('Agent selection control')).not.toBeInTheDocument();

		act(() => {
			wizard().goToStep('phase-review');
		});
		expect(
			await screen.findByRole('heading', { name: 'Review Your Playbooks' })
		).toBeInTheDocument();
		fireEvent.click(await screen.findByRole('button', { name: 'Launch with tour' }));
	});
});
