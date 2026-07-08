import React from 'react';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	WizardProvider,
	useWizard,
	type SerializableWizardState,
} from '../../renderer/components/Wizard/WizardContext';

function wrapper({ children }: { children: React.ReactNode }) {
	return <WizardProvider>{children}</WizardProvider>;
}

function resumeState(overrides: Partial<SerializableWizardState> = {}): SerializableWizardState {
	return {
		currentStep: 'conversation',
		selectedAgent: 'claude-code',
		agentName: 'Coverage Agent',
		directoryPath: '/repo/app',
		isGitRepo: true,
		conversationHistory: [],
		confidenceLevel: 90,
		isReadyToProceed: true,
		generatedDocuments: [],
		editedPhase1Content: null,
		wantsTour: false,
		...overrides,
	};
}

describe('WizardContext integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.settings.get).mockResolvedValue(undefined);
		vi.mocked(window.maestro.settings.set).mockResolvedValue(undefined);
	});

	afterEach(() => {
		cleanup();
		vi.restoreAllMocks();
	});

	it('drives reducer setters, phase gating, completion, and completed-wizard reopen reset', async () => {
		const { result } = renderHook(() => useWizard(), { wrapper });

		act(() => {
			result.current.openWizard();
			result.current.setSelectedAgent('claude-code');
			result.current.setAgentName('Coverage Agent');
			result.current.setAvailableAgents([
				{ id: 'claude-code', name: 'Claude Code', available: true },
			] as any);
			result.current.setCustomPath('/opt/claude');
			result.current.setCustomArgs('--debug');
			result.current.setCustomEnvVars({ TOKEN: '1' });
			result.current.setSessionSshRemoteConfig({ enabled: true, remoteId: 'remote-1' });
			result.current.setDirectoryPath('/repo/app');
			result.current.setIsGitRepo(true);
			result.current.setDetectedAgentPath('/opt/claude');
			result.current.setHasExistingAutoRunDocs(true, 3);
			result.current.setExistingDocsChoice('continue');
			result.current.setConversationHistory([
				{ id: 'msg-1', role: 'assistant', content: 'ready', timestamp: 1 },
			]);
		});

		expect(result.current.canProceedToNext()).toBe(true);

		act(() => {
			result.current.goToStep('phase-review');
		});
		expect(result.current.canProceedToNext()).toBe(false);

		act(() => {
			result.current.setGeneratedDocuments([
				{ filename: 'phase-1.md', content: 'original', taskCount: 2 },
			]);
		});
		expect(result.current.canProceedToNext()).toBe(true);
		expect(result.current.getPhase1Content()).toBe('original');

		act(() => {
			result.current.setEditedPhase1Content('edited');
		});
		expect(result.current.getPhase1Content()).toBe('edited');

		act(() => {
			result.current.goToStep('preparing-plan');
		});
		expect(result.current.canProceedToNext()).toBe(false);
		await waitFor(() =>
			expect(window.maestro.settings.set).toHaveBeenCalledWith(
				'wizardResumeState',
				expect.objectContaining({ currentStep: 'preparing-plan' })
			)
		);

		await act(async () => {
			await result.current.completeWizard('session-1');
		});
		expect(window.maestro.settings.set).toHaveBeenCalledWith('wizardResumeState', null);
		expect(result.current.state).toMatchObject({ isComplete: true, isOpen: false });

		act(() => {
			result.current.openWizard();
		});
		expect(result.current.state).toMatchObject({
			currentStep: 'agent-selection',
			isComplete: false,
			isOpen: true,
		});
	});

	it('loads, rejects, and fails closed for persisted resume state', async () => {
		const { result } = renderHook(() => useWizard(), { wrapper });
		const saved = resumeState();

		vi.mocked(window.maestro.settings.get).mockResolvedValueOnce(saved);
		await expect(result.current.hasResumeState()).resolves.toBe(true);

		vi.mocked(window.maestro.settings.get).mockResolvedValueOnce(saved);
		await expect(result.current.loadResumeState()).resolves.toEqual(saved);

		vi.mocked(window.maestro.settings.get).mockResolvedValueOnce(
			resumeState({ currentStep: 'agent-selection' })
		);
		await expect(result.current.loadResumeState()).resolves.toBeNull();

		vi.mocked(window.maestro.settings.get).mockRejectedValueOnce(new Error('settings unavailable'));
		await expect(result.current.hasResumeState()).rejects.toThrow('settings unavailable');

		vi.mocked(window.maestro.settings.get).mockRejectedValueOnce(new Error('settings unavailable'));
		await expect(result.current.loadResumeState()).rejects.toThrow('settings unavailable');
	});

	it('throws when useWizard is rendered without WizardProvider', () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const preventExpectedError = (event: ErrorEvent) => {
			if (event.error?.message === 'useWizard must be used within a WizardProvider') {
				event.preventDefault();
			}
		};
		window.addEventListener('error', preventExpectedError);
		try {
			expect(() => renderHook(() => useWizard())).toThrow(
				'useWizard must be used within a WizardProvider'
			);
		} finally {
			window.removeEventListener('error', preventExpectedError);
			consoleError.mockRestore();
		}
	});
});
