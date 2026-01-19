/**
 * WizardContext.test.tsx
 *
 * Unit tests for WizardContext state management.
 * Tests all reducer actions, context API methods, navigation logic,
 * validation rules, and state persistence functionality.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
	WizardProvider,
	useWizard,
	WIZARD_TOTAL_STEPS,
	STEP_INDEX,
	INDEX_TO_STEP,
	type WizardStep,
	type WizardState,
	type WizardMessage,
	type GeneratedDocument,
	type SerializableWizardState,
} from '../../../../renderer/components/Wizard/WizardContext';
import type { AgentConfig, ToolType } from '../../../../renderer/types';

beforeEach(() => {
	// Reset all mocks
	vi.clearAllMocks();

	// Reset window.maestro.settings mocks to default behavior
	vi.mocked(window.maestro.settings.get).mockResolvedValue(undefined);
	vi.mocked(window.maestro.settings.set).mockResolvedValue(undefined);
});

afterEach(() => {
	vi.restoreAllMocks();
});

// Wrapper component for testing hooks
const wrapper = ({ children }: { children: React.ReactNode }) => (
	<WizardProvider>{children}</WizardProvider>
);

// Helper to create a mock agent config
function createMockAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		id: 'claude-code',
		name: 'Claude Code',
		command: 'claude',
		args: [],
		available: true,
		path: '/usr/local/bin/claude',
		hidden: false,
		...overrides,
	};
}

// Helper to create a mock wizard message
function createMockMessage(
	overrides: Partial<WizardMessage> = {}
): Omit<WizardMessage, 'id' | 'timestamp'> {
	return {
		role: 'user',
		content: 'Test message',
		...overrides,
	};
}

// Helper to create a mock generated document
function createMockDocument(overrides: Partial<GeneratedDocument> = {}): GeneratedDocument {
	return {
		filename: 'Phase-01-Setup.md',
		content: '# Phase 1\n\n- [ ] Task 1\n- [ ] Task 2',
		taskCount: 2,
		...overrides,
	};
}

describe('WizardContext', () => {
	describe('Constants', () => {
		it('has correct total steps', () => {
			expect(WIZARD_TOTAL_STEPS).toBe(5);
		});

		it('has correct step index mapping', () => {
			expect(STEP_INDEX).toEqual({
				'agent-selection': 1,
				'directory-selection': 2,
				conversation: 3,
				'preparing-plan': 4,
				'phase-review': 5,
			});
		});

		it('has correct index to step mapping', () => {
			expect(INDEX_TO_STEP).toEqual({
				1: 'agent-selection',
				2: 'directory-selection',
				3: 'conversation',
				4: 'preparing-plan',
				5: 'phase-review',
			});
		});

		it('step mappings are inverses of each other', () => {
			Object.entries(STEP_INDEX).forEach(([step, index]) => {
				expect(INDEX_TO_STEP[index]).toBe(step);
			});
		});
	});

	describe('Initial State', () => {
		it('starts with correct initial state', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			const { state } = result.current;

			// Wizard lifecycle
			expect(state.currentStep).toBe('agent-selection');
			expect(state.isOpen).toBe(false);

			// Agent Selection
			expect(state.selectedAgent).toBeNull();
			expect(state.availableAgents).toEqual([]);
			expect(state.agentName).toBe('');

			// Directory Selection
			expect(state.directoryPath).toBe('');
			expect(state.isGitRepo).toBe(false);
			expect(state.detectedAgentPath).toBeNull();
			expect(state.directoryError).toBeNull();

			// Conversation
			expect(state.conversationHistory).toEqual([]);
			expect(state.confidenceLevel).toBe(0);
			expect(state.isReadyToProceed).toBe(false);
			expect(state.isConversationLoading).toBe(false);
			expect(state.conversationError).toBeNull();

			// Phase Review
			expect(state.generatedDocuments).toEqual([]);
			expect(state.currentDocumentIndex).toBe(0);
			expect(state.isGeneratingDocuments).toBe(false);
			expect(state.generationError).toBeNull();
			expect(state.editedPhase1Content).toBeNull();

			// Tour
			expect(state.wantsTour).toBe(true);

			// Completion
			expect(state.isComplete).toBe(false);
			expect(state.createdSessionId).toBeNull();
		});

		it('provides all required API methods', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			// Lifecycle
			expect(typeof result.current.openWizard).toBe('function');
			expect(typeof result.current.closeWizard).toBe('function');
			expect(typeof result.current.resetWizard).toBe('function');

			// Navigation
			expect(typeof result.current.goToStep).toBe('function');
			expect(typeof result.current.nextStep).toBe('function');
			expect(typeof result.current.previousStep).toBe('function');
			expect(typeof result.current.canProceedToNext).toBe('function');
			expect(typeof result.current.getCurrentStepNumber).toBe('function');

			// Agent Selection
			expect(typeof result.current.setSelectedAgent).toBe('function');
			expect(typeof result.current.setAvailableAgents).toBe('function');
			expect(typeof result.current.setAgentName).toBe('function');

			// Directory Selection
			expect(typeof result.current.setDirectoryPath).toBe('function');
			expect(typeof result.current.setIsGitRepo).toBe('function');
			expect(typeof result.current.setDetectedAgentPath).toBe('function');
			expect(typeof result.current.setDirectoryError).toBe('function');

			// Conversation
			expect(typeof result.current.addMessage).toBe('function');
			expect(typeof result.current.setConversationHistory).toBe('function');
			expect(typeof result.current.setConfidenceLevel).toBe('function');
			expect(typeof result.current.setIsReadyToProceed).toBe('function');
			expect(typeof result.current.setConversationLoading).toBe('function');
			expect(typeof result.current.setConversationError).toBe('function');

			// Phase Review
			expect(typeof result.current.setGeneratedDocuments).toBe('function');
			expect(typeof result.current.setCurrentDocumentIndex).toBe('function');
			expect(typeof result.current.setGeneratingDocuments).toBe('function');
			expect(typeof result.current.setGenerationError).toBe('function');
			expect(typeof result.current.setEditedPhase1Content).toBe('function');
			expect(typeof result.current.getPhase1Content).toBe('function');

			// Tour
			expect(typeof result.current.setWantsTour).toBe('function');

			// Completion
			expect(typeof result.current.completeWizard).toBe('function');

			// State persistence
			expect(typeof result.current.saveStateForResume).toBe('function');
			expect(typeof result.current.restoreState).toBe('function');
			expect(typeof result.current.getSerializableState).toBe('function');
			expect(typeof result.current.hasResumeState).toBe('function');
			expect(typeof result.current.loadResumeState).toBe('function');
			expect(typeof result.current.clearResumeState).toBe('function');
		});
	});

	describe('Wizard Lifecycle', () => {
		it('opens wizard', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			expect(result.current.state.isOpen).toBe(false);

			act(() => {
				result.current.openWizard();
			});

			expect(result.current.state.isOpen).toBe(true);
		});

		it('closes wizard', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.openWizard();
			});
			expect(result.current.state.isOpen).toBe(true);

			act(() => {
				result.current.closeWizard();
			});
			expect(result.current.state.isOpen).toBe(false);
		});

		it('resets wizard to initial state', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			// Modify state
			act(() => {
				result.current.openWizard();
				result.current.setSelectedAgent('claude-code');
				result.current.setAgentName('My Project');
				result.current.setDirectoryPath('/path/to/project');
				result.current.goToStep('conversation');
			});

			// Verify state was modified
			expect(result.current.state.isOpen).toBe(true);
			expect(result.current.state.selectedAgent).toBe('claude-code');
			expect(result.current.state.agentName).toBe('My Project');
			expect(result.current.state.directoryPath).toBe('/path/to/project');
			expect(result.current.state.currentStep).toBe('conversation');

			// Reset
			act(() => {
				result.current.resetWizard();
			});

			// Verify reset to initial state
			expect(result.current.state.isOpen).toBe(false);
			expect(result.current.state.selectedAgent).toBeNull();
			expect(result.current.state.agentName).toBe('');
			expect(result.current.state.directoryPath).toBe('');
			expect(result.current.state.currentStep).toBe('agent-selection');
		});

		it('resets state when opening wizard after completion (Issue #89 fix)', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			// Complete a full wizard flow
			act(() => {
				result.current.openWizard();
				result.current.setSelectedAgent('claude-code');
				result.current.setAgentName('First Project');
				result.current.goToStep('phase-review');
				result.current.setGeneratedDocuments([createMockDocument()]);
				result.current.completeWizard('session-123');
			});

			// Verify wizard is completed and closed
			expect(result.current.state.isComplete).toBe(true);
			expect(result.current.state.isOpen).toBe(false);
			expect(result.current.state.currentStep).toBe('phase-review');
			expect(result.current.state.selectedAgent).toBe('claude-code');
			expect(result.current.state.agentName).toBe('First Project');

			// Open wizard again (simulating second wizard run in same session)
			act(() => {
				result.current.openWizard();
			});

			// Verify wizard opens at first step with clean state (not phase-review)
			expect(result.current.state.isOpen).toBe(true);
			expect(result.current.state.currentStep).toBe('agent-selection');
			expect(result.current.state.selectedAgent).toBeNull();
			expect(result.current.state.agentName).toBe('');
			expect(result.current.state.isComplete).toBe(false);
			expect(result.current.state.createdSessionId).toBeNull();
		});

		it('does not reset state when opening wizard after abandonment (preserves resume)', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			// Start wizard but abandon mid-flow (don't complete)
			act(() => {
				result.current.openWizard();
				result.current.setSelectedAgent('claude-code');
				result.current.setAgentName('Abandoned Project');
				result.current.goToStep('conversation');
				result.current.closeWizard();
			});

			// Verify wizard is NOT completed (abandoned)
			expect(result.current.state.isComplete).toBe(false);
			expect(result.current.state.isOpen).toBe(false);
			expect(result.current.state.currentStep).toBe('conversation');

			// Open wizard again (simulating resume)
			act(() => {
				result.current.openWizard();
			});

			// Verify state is preserved (not reset) because wizard was abandoned, not completed
			expect(result.current.state.isOpen).toBe(true);
			expect(result.current.state.currentStep).toBe('conversation'); // Still at conversation step
			expect(result.current.state.selectedAgent).toBe('claude-code');
			expect(result.current.state.agentName).toBe('Abandoned Project');
			expect(result.current.state.isComplete).toBe(false);
		});
	});

	describe('Navigation', () => {
		describe('goToStep', () => {
			it('navigates to specified step', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				act(() => {
					result.current.goToStep('conversation');
				});

				expect(result.current.state.currentStep).toBe('conversation');
			});

			it('can navigate to any step', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				const steps: WizardStep[] = [
					'agent-selection',
					'directory-selection',
					'conversation',
					'phase-review',
				];

				steps.forEach((step) => {
					act(() => {
						result.current.goToStep(step);
					});
					expect(result.current.state.currentStep).toBe(step);
				});
			});
		});

		describe('nextStep', () => {
			it('advances to next step', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				expect(result.current.state.currentStep).toBe('agent-selection');

				act(() => {
					result.current.nextStep();
				});

				expect(result.current.state.currentStep).toBe('directory-selection');
			});

			it('advances through all steps', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				act(() => {
					result.current.nextStep();
				});
				expect(result.current.state.currentStep).toBe('directory-selection');

				act(() => {
					result.current.nextStep();
				});
				expect(result.current.state.currentStep).toBe('conversation');

				act(() => {
					result.current.nextStep();
				});
				expect(result.current.state.currentStep).toBe('preparing-plan');

				act(() => {
					result.current.nextStep();
				});
				expect(result.current.state.currentStep).toBe('phase-review');
			});

			it('does not advance past the last step', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				act(() => {
					result.current.goToStep('phase-review');
				});

				act(() => {
					result.current.nextStep();
				});

				expect(result.current.state.currentStep).toBe('phase-review');
			});
		});

		describe('previousStep', () => {
			it('goes to previous step', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				act(() => {
					result.current.goToStep('conversation');
				});

				act(() => {
					result.current.previousStep();
				});

				expect(result.current.state.currentStep).toBe('directory-selection');
			});

			it('goes back through all steps', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				act(() => {
					result.current.goToStep('phase-review');
				});

				act(() => {
					result.current.previousStep();
				});
				expect(result.current.state.currentStep).toBe('preparing-plan');

				act(() => {
					result.current.previousStep();
				});
				expect(result.current.state.currentStep).toBe('conversation');

				act(() => {
					result.current.previousStep();
				});
				expect(result.current.state.currentStep).toBe('directory-selection');

				act(() => {
					result.current.previousStep();
				});
				expect(result.current.state.currentStep).toBe('agent-selection');
			});

			it('does not go before the first step', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				expect(result.current.state.currentStep).toBe('agent-selection');

				act(() => {
					result.current.previousStep();
				});

				expect(result.current.state.currentStep).toBe('agent-selection');
			});
		});

		describe('getCurrentStepNumber', () => {
			it('returns correct step number for each step', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				expect(result.current.getCurrentStepNumber()).toBe(1);

				act(() => {
					result.current.goToStep('directory-selection');
				});
				expect(result.current.getCurrentStepNumber()).toBe(2);

				act(() => {
					result.current.goToStep('conversation');
				});
				expect(result.current.getCurrentStepNumber()).toBe(3);

				act(() => {
					result.current.goToStep('preparing-plan');
				});
				expect(result.current.getCurrentStepNumber()).toBe(4);

				act(() => {
					result.current.goToStep('phase-review');
				});
				expect(result.current.getCurrentStepNumber()).toBe(5);
			});
		});
	});

	describe('canProceedToNext Validation', () => {
		describe('agent-selection step', () => {
			it('returns false when no agent selected', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				expect(result.current.state.currentStep).toBe('agent-selection');
				expect(result.current.canProceedToNext()).toBe(false);
			});

			it('returns true when agent is selected and name is provided', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				act(() => {
					result.current.setSelectedAgent('claude-code');
					result.current.setAgentName('My Agent');
				});

				expect(result.current.canProceedToNext()).toBe(true);
			});
		});

		describe('directory-selection step', () => {
			it('returns false when directory path is empty', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				act(() => {
					result.current.goToStep('directory-selection');
				});

				expect(result.current.canProceedToNext()).toBe(false);
			});

			it('returns false when directory path is whitespace only', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				act(() => {
					result.current.goToStep('directory-selection');
					result.current.setDirectoryPath('   ');
				});

				expect(result.current.canProceedToNext()).toBe(false);
			});

			it('returns false when there is a directory error', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				act(() => {
					result.current.goToStep('directory-selection');
					result.current.setDirectoryPath('/valid/path');
					result.current.setDirectoryError('Directory does not exist');
				});

				expect(result.current.canProceedToNext()).toBe(false);
			});

			it('returns true when valid path and no error', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				act(() => {
					result.current.goToStep('directory-selection');
					result.current.setDirectoryPath('/valid/path');
				});

				expect(result.current.canProceedToNext()).toBe(true);
			});
		});

		describe('conversation step', () => {
			it('returns false when not ready to proceed', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				act(() => {
					result.current.goToStep('conversation');
				});

				expect(result.current.canProceedToNext()).toBe(false);
			});

			it('returns true when ready to proceed', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				act(() => {
					result.current.goToStep('conversation');
					result.current.setIsReadyToProceed(true);
				});

				expect(result.current.canProceedToNext()).toBe(true);
			});
		});

		describe('phase-review step', () => {
			it('returns false when no documents generated', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				act(() => {
					result.current.goToStep('phase-review');
				});

				expect(result.current.canProceedToNext()).toBe(false);
			});

			it('returns true when documents are generated', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				act(() => {
					result.current.goToStep('phase-review');
					result.current.setGeneratedDocuments([createMockDocument()]);
				});

				expect(result.current.canProceedToNext()).toBe(true);
			});
		});
	});

	describe('Agent Selection State', () => {
		it('sets selected agent', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setSelectedAgent('claude-code');
			});

			expect(result.current.state.selectedAgent).toBe('claude-code');
		});

		it('clears selected agent with null', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setSelectedAgent('claude-code');
			});
			expect(result.current.state.selectedAgent).toBe('claude-code');

			act(() => {
				result.current.setSelectedAgent(null);
			});
			expect(result.current.state.selectedAgent).toBeNull();
		});

		it('sets available agents', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			const agents: AgentConfig[] = [
				createMockAgent({ id: 'claude-code', name: 'Claude Code' }),
				createMockAgent({ id: 'openai-codex', name: 'OpenAI Codex', available: false }),
			];

			act(() => {
				result.current.setAvailableAgents(agents);
			});

			expect(result.current.state.availableAgents).toEqual(agents);
			expect(result.current.state.availableAgents).toHaveLength(2);
		});

		it('sets agent name', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setAgentName('My Awesome Project');
			});

			expect(result.current.state.agentName).toBe('My Awesome Project');
		});

		it('allows empty agent name', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setAgentName('My Project');
			});
			expect(result.current.state.agentName).toBe('My Project');

			act(() => {
				result.current.setAgentName('');
			});
			expect(result.current.state.agentName).toBe('');
		});
	});

	describe('Directory Selection State', () => {
		it('sets directory path', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setDirectoryPath('/Users/test/projects');
			});

			expect(result.current.state.directoryPath).toBe('/Users/test/projects');
		});

		it('clears directory error when setting new path', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setDirectoryError('Invalid path');
			});
			expect(result.current.state.directoryError).toBe('Invalid path');

			act(() => {
				result.current.setDirectoryPath('/new/path');
			});
			expect(result.current.state.directoryError).toBeNull();
		});

		it('sets git repo status', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			expect(result.current.state.isGitRepo).toBe(false);

			act(() => {
				result.current.setIsGitRepo(true);
			});

			expect(result.current.state.isGitRepo).toBe(true);
		});

		it('sets detected agent path', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setDetectedAgentPath('/auto/detected/path');
			});

			expect(result.current.state.detectedAgentPath).toBe('/auto/detected/path');
		});

		it('clears detected agent path with null', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setDetectedAgentPath('/some/path');
			});
			expect(result.current.state.detectedAgentPath).toBe('/some/path');

			act(() => {
				result.current.setDetectedAgentPath(null);
			});
			expect(result.current.state.detectedAgentPath).toBeNull();
		});

		it('sets directory error', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setDirectoryError('Directory not accessible');
			});

			expect(result.current.state.directoryError).toBe('Directory not accessible');
		});

		it('clears directory error with null', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setDirectoryError('Some error');
			});
			expect(result.current.state.directoryError).toBe('Some error');

			act(() => {
				result.current.setDirectoryError(null);
			});
			expect(result.current.state.directoryError).toBeNull();
		});
	});

	describe('Conversation State', () => {
		it('adds message with auto-generated id and timestamp', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.addMessage({ role: 'user', content: 'Hello!' });
			});

			expect(result.current.state.conversationHistory).toHaveLength(1);

			const message = result.current.state.conversationHistory[0];
			expect(message.role).toBe('user');
			expect(message.content).toBe('Hello!');
			expect(message.id).toBeDefined();
			expect(message.id).toMatch(/^msg-\d+-[a-z0-9]+$/);
			expect(message.timestamp).toBeDefined();
			expect(typeof message.timestamp).toBe('number');
		});

		it('adds multiple messages in order', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.addMessage({ role: 'user', content: 'First message' });
			});

			act(() => {
				result.current.addMessage({ role: 'assistant', content: 'Response' });
			});

			act(() => {
				result.current.addMessage({ role: 'user', content: 'Second message' });
			});

			expect(result.current.state.conversationHistory).toHaveLength(3);
			expect(result.current.state.conversationHistory[0].content).toBe('First message');
			expect(result.current.state.conversationHistory[1].content).toBe('Response');
			expect(result.current.state.conversationHistory[2].content).toBe('Second message');
		});

		it('adds message with confidence and ready flags', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.addMessage({
					role: 'assistant',
					content: 'I understand your project',
					confidence: 85,
					ready: true,
				});
			});

			const message = result.current.state.conversationHistory[0];
			expect(message.confidence).toBe(85);
			expect(message.ready).toBe(true);
		});

		it('sets conversation history', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			const history: WizardMessage[] = [
				{ id: 'msg-1', role: 'user', content: 'Hello', timestamp: Date.now() },
				{ id: 'msg-2', role: 'assistant', content: 'Hi there', timestamp: Date.now() },
			];

			act(() => {
				result.current.setConversationHistory(history);
			});

			expect(result.current.state.conversationHistory).toEqual(history);
		});

		it('replaces existing history when setting new history', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.addMessage({ role: 'user', content: 'Old message' });
			});
			expect(result.current.state.conversationHistory).toHaveLength(1);

			const newHistory: WizardMessage[] = [
				{ id: 'new-1', role: 'user', content: 'New message', timestamp: Date.now() },
			];

			act(() => {
				result.current.setConversationHistory(newHistory);
			});

			expect(result.current.state.conversationHistory).toHaveLength(1);
			expect(result.current.state.conversationHistory[0].content).toBe('New message');
		});

		it('sets confidence level', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setConfidenceLevel(75);
			});

			expect(result.current.state.confidenceLevel).toBe(75);
		});

		it('sets ready to proceed flag', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			expect(result.current.state.isReadyToProceed).toBe(false);

			act(() => {
				result.current.setIsReadyToProceed(true);
			});

			expect(result.current.state.isReadyToProceed).toBe(true);
		});

		it('sets conversation loading state', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			expect(result.current.state.isConversationLoading).toBe(false);

			act(() => {
				result.current.setConversationLoading(true);
			});

			expect(result.current.state.isConversationLoading).toBe(true);

			act(() => {
				result.current.setConversationLoading(false);
			});

			expect(result.current.state.isConversationLoading).toBe(false);
		});

		it('sets conversation error', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setConversationError('Failed to connect to agent');
			});

			expect(result.current.state.conversationError).toBe('Failed to connect to agent');
		});

		it('clears conversation error with null', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setConversationError('Some error');
			});
			expect(result.current.state.conversationError).toBe('Some error');

			act(() => {
				result.current.setConversationError(null);
			});
			expect(result.current.state.conversationError).toBeNull();
		});
	});

	describe('Phase Review State', () => {
		it('sets generated documents', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			const docs: GeneratedDocument[] = [
				createMockDocument({ filename: 'Phase-01-Setup.md', taskCount: 5 }),
				createMockDocument({ filename: 'Phase-02-Features.md', taskCount: 8 }),
			];

			act(() => {
				result.current.setGeneratedDocuments(docs);
			});

			expect(result.current.state.generatedDocuments).toEqual(docs);
			expect(result.current.state.generatedDocuments).toHaveLength(2);
		});

		it('sets current document index', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setCurrentDocumentIndex(2);
			});

			expect(result.current.state.currentDocumentIndex).toBe(2);
		});

		it('sets generating documents flag', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			expect(result.current.state.isGeneratingDocuments).toBe(false);

			act(() => {
				result.current.setGeneratingDocuments(true);
			});

			expect(result.current.state.isGeneratingDocuments).toBe(true);
		});

		it('sets generation error', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setGenerationError('Generation timed out');
			});

			expect(result.current.state.generationError).toBe('Generation timed out');
		});

		it('clears generation error with null', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setGenerationError('Error');
			});

			act(() => {
				result.current.setGenerationError(null);
			});

			expect(result.current.state.generationError).toBeNull();
		});

		it('sets edited Phase 1 content', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setEditedPhase1Content('# Modified Phase 1\n\n- [ ] New task');
			});

			expect(result.current.state.editedPhase1Content).toBe('# Modified Phase 1\n\n- [ ] New task');
		});

		it('clears edited Phase 1 content with null', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setEditedPhase1Content('Some content');
			});

			act(() => {
				result.current.setEditedPhase1Content(null);
			});

			expect(result.current.state.editedPhase1Content).toBeNull();
		});

		describe('getPhase1Content', () => {
			it('returns edited content when available', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				act(() => {
					result.current.setGeneratedDocuments([
						createMockDocument({ content: 'Original content' }),
					]);
					result.current.setEditedPhase1Content('Edited content');
				});

				expect(result.current.getPhase1Content()).toBe('Edited content');
			});

			it('returns original document content when no edits', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				act(() => {
					result.current.setGeneratedDocuments([
						createMockDocument({ content: 'Original content' }),
					]);
				});

				expect(result.current.getPhase1Content()).toBe('Original content');
			});

			it('returns empty string when no documents', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				expect(result.current.getPhase1Content()).toBe('');
			});
		});
	});

	describe('Tour Preference', () => {
		it('defaults to wanting tour', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			expect(result.current.state.wantsTour).toBe(true);
		});

		it('sets tour preference to false', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setWantsTour(false);
			});

			expect(result.current.state.wantsTour).toBe(false);
		});

		it('sets tour preference to true', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setWantsTour(false);
			});

			act(() => {
				result.current.setWantsTour(true);
			});

			expect(result.current.state.wantsTour).toBe(true);
		});
	});

	describe('Wizard Completion', () => {
		it('marks wizard as complete with session ID', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.openWizard();
			});
			expect(result.current.state.isOpen).toBe(true);

			act(() => {
				result.current.completeWizard('session-123');
			});

			expect(result.current.state.isComplete).toBe(true);
			expect(result.current.state.createdSessionId).toBe('session-123');
			expect(result.current.state.isOpen).toBe(false);
		});

		it('marks wizard as complete with null session ID', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.completeWizard(null);
			});

			expect(result.current.state.isComplete).toBe(true);
			expect(result.current.state.createdSessionId).toBeNull();
		});

		it('clears resume state when completing wizard', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.completeWizard('session-123');
			});

			expect(window.maestro.settings.set).toHaveBeenCalledWith('wizardResumeState', null);
		});
	});

	describe('State Persistence', () => {
		describe('getSerializableState', () => {
			it('returns serializable subset of state', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				act(() => {
					result.current.setSelectedAgent('claude-code');
					result.current.setAgentName('Test Project');
					result.current.setDirectoryPath('/test/path');
					result.current.setIsGitRepo(true);
					result.current.setConfidenceLevel(50);
					result.current.goToStep('conversation');
				});

				const serializable = result.current.getSerializableState();

				expect(serializable).toEqual({
					currentStep: 'conversation',
					selectedAgent: 'claude-code',
					agentName: 'Test Project',
					directoryPath: '/test/path',
					isGitRepo: true,
					conversationHistory: [],
					confidenceLevel: 50,
					isReadyToProceed: false,
					generatedDocuments: [],
					editedPhase1Content: null,
					wantsTour: true,
				});
			});

			it('excludes non-serializable state properties', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				act(() => {
					result.current.openWizard();
					result.current.setConversationLoading(true);
					result.current.setGeneratingDocuments(true);
					result.current.setConversationError('Error');
				});

				const serializable = result.current.getSerializableState();

				// These should not be in serializable state
				expect(serializable).not.toHaveProperty('isOpen');
				expect(serializable).not.toHaveProperty('isConversationLoading');
				expect(serializable).not.toHaveProperty('isGeneratingDocuments');
				expect(serializable).not.toHaveProperty('conversationError');
				expect(serializable).not.toHaveProperty('generationError');
				expect(serializable).not.toHaveProperty('isComplete');
				expect(serializable).not.toHaveProperty('createdSessionId');
			});
		});

		describe('saveStateForResume', () => {
			it('saves serializable state to settings', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				// First, update the state
				act(() => {
					result.current.setSelectedAgent('claude-code');
					result.current.setDirectoryPath('/test');
				});

				// Clear previous calls so we can verify saveStateForResume specifically
				vi.mocked(window.maestro.settings.set).mockClear();

				// Then call saveStateForResume in a separate act block
				// to ensure state is updated before serialization
				act(() => {
					result.current.saveStateForResume();
				});

				expect(window.maestro.settings.set).toHaveBeenCalledWith(
					'wizardResumeState',
					expect.objectContaining({
						selectedAgent: 'claude-code',
						directoryPath: '/test',
					})
				);
			});
		});

		describe('restoreState', () => {
			it('restores partial state', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				act(() => {
					result.current.restoreState({
						currentStep: 'conversation',
						selectedAgent: 'claude-code',
						agentName: 'Restored Project',
						directoryPath: '/restored/path',
					});
				});

				expect(result.current.state.currentStep).toBe('conversation');
				expect(result.current.state.selectedAgent).toBe('claude-code');
				expect(result.current.state.agentName).toBe('Restored Project');
				expect(result.current.state.directoryPath).toBe('/restored/path');
			});

			it('preserves unrestored properties', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				// Set some initial state
				act(() => {
					result.current.openWizard();
					result.current.setWantsTour(false);
				});

				// Restore partial state (doesn't include wantsTour)
				act(() => {
					result.current.restoreState({
						selectedAgent: 'claude-code',
					});
				});

				// wantsTour should retain its value
				expect(result.current.state.wantsTour).toBe(false);
				expect(result.current.state.selectedAgent).toBe('claude-code');
			});

			it('restores conversation history', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				const history: WizardMessage[] = [
					{ id: 'msg-1', role: 'user', content: 'Hello', timestamp: 1000 },
					{ id: 'msg-2', role: 'assistant', content: 'Hi', timestamp: 2000 },
				];

				act(() => {
					result.current.restoreState({ conversationHistory: history });
				});

				expect(result.current.state.conversationHistory).toEqual(history);
			});

			it('restores generated documents', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				const docs: GeneratedDocument[] = [
					createMockDocument({ filename: 'Phase-01.md' }),
					createMockDocument({ filename: 'Phase-02.md' }),
				];

				act(() => {
					result.current.restoreState({ generatedDocuments: docs });
				});

				expect(result.current.state.generatedDocuments).toEqual(docs);
			});
		});

		describe('hasResumeState', () => {
			it('returns true when resume state exists', async () => {
				vi.mocked(window.maestro.settings.get).mockResolvedValue({
					currentStep: 'conversation',
					selectedAgent: 'claude-code',
				});

				const { result } = renderHook(() => useWizard(), { wrapper });

				let hasState: boolean;
				await act(async () => {
					hasState = await result.current.hasResumeState();
				});

				expect(hasState!).toBe(true);
				expect(window.maestro.settings.get).toHaveBeenCalledWith('wizardResumeState');
			});

			it('returns false when no resume state exists', async () => {
				vi.mocked(window.maestro.settings.get).mockResolvedValue(null);

				const { result } = renderHook(() => useWizard(), { wrapper });

				let hasState: boolean;
				await act(async () => {
					hasState = await result.current.hasResumeState();
				});

				expect(hasState!).toBe(false);
			});

			it('returns false when resume state is undefined', async () => {
				vi.mocked(window.maestro.settings.get).mockResolvedValue(undefined);

				const { result } = renderHook(() => useWizard(), { wrapper });

				let hasState: boolean;
				await act(async () => {
					hasState = await result.current.hasResumeState();
				});

				expect(hasState!).toBe(false);
			});

			it('returns false on error', async () => {
				vi.mocked(window.maestro.settings.get).mockRejectedValue(new Error('Storage error'));

				const { result } = renderHook(() => useWizard(), { wrapper });

				let hasState: boolean;
				await act(async () => {
					hasState = await result.current.hasResumeState();
				});

				expect(hasState!).toBe(false);
			});
		});

		describe('loadResumeState', () => {
			it('loads saved state when past first step', async () => {
				const savedState: SerializableWizardState = {
					currentStep: 'conversation',
					selectedAgent: 'claude-code',
					agentName: 'Test',
					directoryPath: '/test',
					isGitRepo: true,
					conversationHistory: [],
					confidenceLevel: 60,
					isReadyToProceed: false,
					generatedDocuments: [],
					editedPhase1Content: null,
					wantsTour: true,
				};

				vi.mocked(window.maestro.settings.get).mockResolvedValue(savedState);

				const { result } = renderHook(() => useWizard(), { wrapper });

				let loaded: SerializableWizardState | null;
				await act(async () => {
					loaded = await result.current.loadResumeState();
				});

				expect(loaded).toEqual(savedState);
			});

			it('returns null when on first step', async () => {
				vi.mocked(window.maestro.settings.get).mockResolvedValue({
					currentStep: 'agent-selection',
					selectedAgent: null,
				});

				const { result } = renderHook(() => useWizard(), { wrapper });

				let loaded: SerializableWizardState | null;
				await act(async () => {
					loaded = await result.current.loadResumeState();
				});

				expect(loaded).toBeNull();
			});

			it('returns null when no saved state', async () => {
				vi.mocked(window.maestro.settings.get).mockResolvedValue(null);

				const { result } = renderHook(() => useWizard(), { wrapper });

				let loaded: SerializableWizardState | null;
				await act(async () => {
					loaded = await result.current.loadResumeState();
				});

				expect(loaded).toBeNull();
			});

			it('returns null on error', async () => {
				vi.mocked(window.maestro.settings.get).mockRejectedValue(new Error('Storage error'));

				const { result } = renderHook(() => useWizard(), { wrapper });

				let loaded: SerializableWizardState | null;
				await act(async () => {
					loaded = await result.current.loadResumeState();
				});

				expect(loaded).toBeNull();
			});
		});

		describe('clearResumeState', () => {
			it('clears saved resume state', () => {
				const { result } = renderHook(() => useWizard(), { wrapper });

				act(() => {
					result.current.clearResumeState();
				});

				expect(window.maestro.settings.set).toHaveBeenCalledWith('wizardResumeState', null);
			});
		});
	});

	describe('useWizard Hook', () => {
		it('throws error when used outside WizardProvider', () => {
			// Suppress console.error for this test
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			expect(() => {
				renderHook(() => useWizard());
			}).toThrow('useWizard must be used within a WizardProvider');

			consoleSpy.mockRestore();
		});
	});

	describe('Edge Cases', () => {
		it('handles rapid state changes', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				// Rapid-fire state changes
				result.current.setSelectedAgent('claude-code');
				result.current.setAgentName('Project 1');
				result.current.setAgentName('Project 2');
				result.current.setAgentName('Project 3');
				result.current.nextStep();
				result.current.setDirectoryPath('/path1');
				result.current.setDirectoryPath('/path2');
				result.current.previousStep();
				result.current.setSelectedAgent(null);
				result.current.setSelectedAgent('claude-code');
			});

			// Final state should reflect last values
			expect(result.current.state.selectedAgent).toBe('claude-code');
			expect(result.current.state.agentName).toBe('Project 3');
			expect(result.current.state.directoryPath).toBe('/path2');
			expect(result.current.state.currentStep).toBe('agent-selection');
		});

		it('handles confidence level boundary values', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setConfidenceLevel(0);
			});
			expect(result.current.state.confidenceLevel).toBe(0);

			act(() => {
				result.current.setConfidenceLevel(100);
			});
			expect(result.current.state.confidenceLevel).toBe(100);

			act(() => {
				result.current.setConfidenceLevel(50);
			});
			expect(result.current.state.confidenceLevel).toBe(50);
		});

		it('handles empty conversation history', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setConversationHistory([]);
			});

			expect(result.current.state.conversationHistory).toEqual([]);
		});

		it('handles empty generated documents array', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.setGeneratedDocuments([]);
			});

			expect(result.current.state.generatedDocuments).toEqual([]);
			expect(result.current.getPhase1Content()).toBe('');
		});

		it('handles special characters in paths', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			const specialPath = '/Users/test/My Projects (2024)/project-name';

			act(() => {
				result.current.setDirectoryPath(specialPath);
			});

			expect(result.current.state.directoryPath).toBe(specialPath);
		});

		it('handles unicode in agent name', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			const unicodeName = '🎼 Maestro Project 日本語';

			act(() => {
				result.current.setAgentName(unicodeName);
			});

			expect(result.current.state.agentName).toBe(unicodeName);
		});

		it('handles large conversation history', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			// Add many messages
			act(() => {
				for (let i = 0; i < 100; i++) {
					result.current.addMessage({
						role: i % 2 === 0 ? 'user' : 'assistant',
						content: `Message ${i}`,
					});
				}
			});

			expect(result.current.state.conversationHistory).toHaveLength(100);
			expect(result.current.state.conversationHistory[0].content).toBe('Message 0');
			expect(result.current.state.conversationHistory[99].content).toBe('Message 99');
		});

		it('maintains unique message IDs', () => {
			const { result } = renderHook(() => useWizard(), { wrapper });

			act(() => {
				result.current.addMessage({ role: 'user', content: 'First' });
				result.current.addMessage({ role: 'user', content: 'Second' });
				result.current.addMessage({ role: 'user', content: 'Third' });
			});

			const ids = result.current.state.conversationHistory.map((m) => m.id);
			const uniqueIds = new Set(ids);

			expect(uniqueIds.size).toBe(ids.length);
		});
	});
});
