import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WizardResumeModal } from '../../renderer/components/Wizard/WizardResumeModal';
import {
	type SerializableWizardState,
	type WizardStep,
} from '../../renderer/components/Wizard/WizardContext';
import { MODAL_PRIORITIES } from '../../renderer/constants/modalPriorities';
import type { AgentConfig, Theme } from '../../renderer/types';

const layerMocks = vi.hoisted(() => ({
	registerLayer: vi.fn(() => 'wizard-resume-layer'),
	unregisterLayer: vi.fn(),
	updateLayerHandler: vi.fn(),
}));

vi.mock('../../renderer/contexts/LayerStackContext', () => ({
	useLayerStack: () => ({
		registerLayer: layerMocks.registerLayer,
		unregisterLayer: layerMocks.unregisterLayer,
		updateLayerHandler: layerMocks.updateLayerHandler,
	}),
}));

const theme: Theme = {
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgSidebar: '#252525',
		bgActivity: '#2a2a2a',
		border: '#333333',
		textMain: '#ffffff',
		textDim: '#888888',
		textFaint: '#555555',
		accent: '#4a9eff',
		accentDim: '#3a8eef',
		accentText: '#ffffff',
		accentForeground: '#ffffff',
		buttonBg: '#333333',
		buttonHover: '#444444',
		headerBg: '#202020',
		scrollbarTrack: '#1a1a1a',
		scrollbarThumb: '#444444',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const availableAgents: AgentConfig[] = [
	{
		id: 'claude-code',
		name: 'Claude Code',
		command: 'claude',
		args: [],
		available: true,
		path: '/usr/local/bin/claude',
		hidden: false,
	},
	{
		id: 'terminal',
		name: 'Terminal',
		command: 'bash',
		args: [],
		available: true,
		path: '/bin/bash',
		hidden: true,
	},
];

const mockMaestro = {
	git: {
		isRepo: vi.fn(),
	},
	agents: {
		detect: vi.fn(),
	},
};

function createResumeState(
	overrides: Partial<SerializableWizardState> = {}
): SerializableWizardState {
	return {
		currentStep: 'conversation',
		selectedAgent: 'claude-code',
		agentName: 'Saved Project',
		directoryPath: '/workspace/maestro',
		isGitRepo: true,
		conversationHistory: [
			{ id: 'message-1', role: 'user', content: 'Build this', timestamp: 1 },
			{ id: 'message-2', role: 'assistant', content: 'Understood', timestamp: 2 },
		],
		confidenceLevel: 72,
		isReadyToProceed: false,
		generatedDocuments: [],
		editedPhase1Content: null,
		wantsTour: true,
		...overrides,
	};
}

function createProps(
	overrides: Partial<ComponentProps<typeof WizardResumeModal>> = {}
): ComponentProps<typeof WizardResumeModal> {
	return {
		theme,
		resumeState: createResumeState(),
		onResume: vi.fn(),
		onStartFresh: vi.fn(),
		onClose: vi.fn(),
		...overrides,
	};
}

function renderModal(overrides: Partial<ComponentProps<typeof WizardResumeModal>> = {}) {
	const props = createProps(overrides);
	const view = render(<WizardResumeModal {...props} />);
	return { ...view, props };
}

describe('WizardResumeModal', () => {
	let originalMaestro: unknown;

	beforeEach(() => {
		originalMaestro = (window as typeof window & { maestro?: unknown }).maestro;
		(window as typeof window & { maestro: typeof mockMaestro }).maestro = mockMaestro;
		layerMocks.registerLayer.mockReturnValue('wizard-resume-layer');
		mockMaestro.git.isRepo.mockResolvedValue(true);
		mockMaestro.agents.detect.mockResolvedValue(availableAgents);
	});

	afterEach(() => {
		(window as typeof window & { maestro?: unknown }).maestro = originalMaestro;
		vi.clearAllMocks();
	});

	it('validates a saved SSH directory and resumes with valid-state flags', async () => {
		const onResume = vi.fn();
		renderModal({
			resumeState: createResumeState({
				sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
			}),
			onResume,
		});

		expect(screen.getByRole('button', { name: /checking/i })).toBeDisabled();

		await waitFor(() => {
			expect(screen.getByRole('button', { name: /resume where i left off/i })).not.toBeDisabled();
		});

		expect(mockMaestro.git.isRepo).toHaveBeenCalledWith(
			'/workspace/maestro',
			'remote-1',
			'/workspace/maestro'
		);
		expect(mockMaestro.agents.detect).toHaveBeenCalledTimes(1);
		expect(screen.getByText('Saved Project')).toBeInTheDocument();
		expect(screen.getByText('Claude Code')).toBeInTheDocument();
		expect(screen.getByText('2 messages exchanged (72% confidence)')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /resume where i left off/i }));

		expect(onResume).toHaveBeenCalledWith({ directoryInvalid: false, agentInvalid: false });
	});

	it('validates local directories and enabled SSH state without a remote id', async () => {
		renderModal({
			resumeState: createResumeState({
				sessionSshRemoteConfig: { enabled: true, remoteId: null },
			}),
		});

		await waitFor(() => {
			expect(screen.getByRole('button', { name: /resume where i left off/i })).not.toBeDisabled();
		});

		expect(mockMaestro.git.isRepo).toHaveBeenCalledWith('/workspace/maestro', undefined, undefined);
	});

	it('reports invalid saved state when directory and agent validation fail', async () => {
		mockMaestro.git.isRepo.mockRejectedValue(new Error('missing directory'));
		mockMaestro.agents.detect.mockRejectedValue(new Error('agent scan failed'));
		const onResume = vi.fn();

		renderModal({ onResume });

		await waitFor(() => {
			expect(screen.getByText(/directory no longer exists/i)).toBeInTheDocument();
			expect(screen.getByText(/agent no longer available/i)).toBeInTheDocument();
		});

		fireEvent.click(screen.getByRole('button', { name: /resume where i left off/i }));

		expect(onResume).toHaveBeenCalledWith({ directoryInvalid: true, agentInvalid: true });
	});

	it('registers, updates, and unregisters a strict modal layer', () => {
		const firstClose = vi.fn();
		const nextClose = vi.fn();
		const resumeState = createResumeState({ directoryPath: '', selectedAgent: null });
		const { rerender, unmount } = renderModal({ resumeState, onClose: firstClose });

		expect(layerMocks.registerLayer).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'modal',
				priority: MODAL_PRIORITIES.WIZARD_RESUME,
				blocksLowerLayers: true,
				capturesFocus: true,
				focusTrap: 'strict',
				ariaLabel: 'Resume Setup Wizard',
			})
		);

		layerMocks.registerLayer.mock.calls[0][0].onEscape();
		expect(firstClose).toHaveBeenCalledTimes(1);

		rerender(<WizardResumeModal {...createProps({ resumeState, onClose: nextClose })} />);
		const latestHandler = layerMocks.updateLayerHandler.mock.calls.at(-1)?.[1];
		expect(latestHandler).toEqual(expect.any(Function));
		latestHandler();
		expect(nextClose).toHaveBeenCalledTimes(1);

		unmount();
		expect(layerMocks.unregisterLayer).toHaveBeenCalledWith('wizard-resume-layer');
	});

	it('skips layer updates and unregister when registration returns no id', () => {
		layerMocks.registerLayer.mockReturnValueOnce(undefined as unknown as string);

		const { unmount } = renderModal({
			resumeState: createResumeState({ directoryPath: '', selectedAgent: null }),
		});

		expect(layerMocks.updateLayerHandler).not.toHaveBeenCalled();

		unmount();

		expect(layerMocks.unregisterLayer).not.toHaveBeenCalled();
	});

	it('does not update validation state after unmount', async () => {
		let resolveGitCheck: (value: boolean) => void = () => {};
		const gitCheck = new Promise<boolean>((resolve) => {
			resolveGitCheck = resolve;
		});
		mockMaestro.git.isRepo.mockReturnValue(gitCheck);

		const { unmount } = renderModal();

		unmount();
		resolveGitCheck(true);

		await waitFor(() => {
			expect(mockMaestro.agents.detect).toHaveBeenCalledTimes(1);
		});
	});

	it('supports keyboard navigation between resume and fresh actions', async () => {
		const onResume = vi.fn();
		const onStartFresh = vi.fn();
		renderModal({
			resumeState: createResumeState({ directoryPath: '', selectedAgent: null }),
			onResume,
			onStartFresh,
		});

		await waitFor(() => {
			expect(screen.getByRole('button', { name: /resume where i left off/i })).not.toBeDisabled();
		});

		const dialog = screen.getByRole('dialog');
		const freshButton = screen.getByRole('button', { name: /start fresh/i });

		fireEvent.focus(freshButton);
		fireEvent.keyDown(dialog, { key: 'Enter' });
		expect(onStartFresh).toHaveBeenCalledTimes(1);

		fireEvent.keyDown(dialog, { key: 'ArrowDown' });
		fireEvent.keyDown(dialog, { key: 'Enter' });
		expect(onResume).toHaveBeenCalledWith({ directoryInvalid: false, agentInvalid: false });

		fireEvent.keyDown(dialog, { key: 'Tab' });
		fireEvent.keyDown(dialog, { key: 'Enter' });
		expect(onStartFresh).toHaveBeenCalledTimes(2);

		fireEvent.keyDown(dialog, { key: 'Tab' });
		fireEvent.keyDown(dialog, { key: 'ArrowDown' });
		fireEvent.keyDown(dialog, { key: 'Escape' });
	});

	it.each([
		['agent-selection', 'Agent Selection', 'Step 1 of 5'],
		['directory-selection', 'Directory Selection', 'Step 2 of 5'],
		['preparing-plan', 'Preparing Playbooks', 'Step 4 of 5'],
		['phase-review', 'Phase Review', 'Step 5 of 5'],
	] satisfies Array<[WizardStep, string, string]>)(
		'renders the %s resume progress summary',
		(currentStep, label, stepText) => {
			renderModal({
				resumeState: createResumeState({
					currentStep,
					directoryPath: '',
					selectedAgent: null,
					agentName: '',
					conversationHistory: [],
					confidenceLevel: 0,
				}),
			});

			expect(screen.getByText(label)).toBeInTheDocument();
			expect(screen.getByText(stepText)).toBeInTheDocument();
			expect(screen.queryByText(/messages exchanged/i)).not.toBeInTheDocument();
		}
	);

	it('falls back to setup copy for malformed persisted wizard steps', () => {
		renderModal({
			resumeState: createResumeState({
				currentStep: 'unknown-step' as WizardStep,
				directoryPath: '',
				selectedAgent: null,
				agentName: '',
			}),
		});

		expect(screen.getByText('Setup')).toBeInTheDocument();
	});

	it('shows raw ids for non-Claude saved agents that are still available', async () => {
		mockMaestro.agents.detect.mockResolvedValue([
			...availableAgents,
			{
				id: 'openai-codex',
				name: 'OpenAI Codex',
				command: 'codex',
				args: [],
				available: true,
				path: '/usr/local/bin/codex',
				hidden: false,
			},
		] satisfies AgentConfig[]);

		renderModal({
			resumeState: createResumeState({ selectedAgent: 'openai-codex' as never }),
		});

		await waitFor(() => {
			expect(screen.getByText('openai-codex')).toBeInTheDocument();
		});
	});
});
