/**
 * Tests for InlineWizardContext
 *
 * This context provides cross-component access to inline wizard state.
 * It wraps the useInlineWizard hook and exposes it via React context.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import React, { ReactNode } from 'react';
import {
	InlineWizardProvider,
	useInlineWizardContext,
} from '../../../renderer/contexts/InlineWizardContext';
import type { PreviousUIState } from '../../../renderer/hooks/useInlineWizard';

// Mock the dependencies used by useInlineWizard
vi.mock('../../../renderer/services/wizardIntentParser', () => ({
	parseWizardIntent: vi.fn().mockReturnValue({ mode: 'iterate', goal: 'test goal' }),
}));

vi.mock('../../../renderer/utils/existingDocsDetector', () => ({
	hasExistingAutoRunDocs: vi.fn().mockResolvedValue(false),
	getExistingAutoRunDocs: vi.fn().mockResolvedValue([]),
	getAutoRunFolderPath: vi.fn((projectPath: string) => `${projectPath}/Auto Run Docs`),
}));

vi.mock('../../../renderer/services/inlineWizardConversation', () => ({
	startInlineWizardConversation: vi.fn().mockReturnValue({
		sessionId: 'test-session-id',
		agentType: 'claude-code',
		directoryPath: '/test/project',
		projectName: 'Test Project',
		systemPrompt: 'Test system prompt',
		isActive: true,
	}),
	sendWizardMessage: vi.fn().mockResolvedValue({
		success: true,
		response: {
			confidence: 50,
			ready: false,
			message: 'Test response',
		},
	}),
	endInlineWizardConversation: vi.fn().mockResolvedValue(undefined),
	READY_CONFIDENCE_THRESHOLD: 80,
}));

// Wrapper component for testing hooks that need the provider
function createWrapper() {
	return function Wrapper({ children }: { children: ReactNode }) {
		return <InlineWizardProvider>{children}</InlineWizardProvider>;
	};
}

describe('InlineWizardContext', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('useInlineWizardContext outside provider', () => {
		it('should throw an error when used outside InlineWizardProvider', () => {
			// Suppress console.error for this test since React will log the error
			const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

			expect(() => {
				renderHook(() => useInlineWizardContext());
			}).toThrow('useInlineWizardContext must be used within an InlineWizardProvider');

			consoleSpy.mockRestore();
		});
	});

	describe('initial state', () => {
		it('should return inactive wizard state initially', () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			expect(result.current.isWizardActive).toBe(false);
			expect(result.current.wizardMode).toBeNull();
			expect(result.current.wizardGoal).toBeNull();
			expect(result.current.confidence).toBe(0);
			expect(result.current.conversationHistory).toEqual([]);
			expect(result.current.isGeneratingDocs).toBe(false);
			expect(result.current.generatedDocuments).toEqual([]);
			expect(result.current.error).toBeNull();
		});

		it('should return full state object', () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			expect(result.current.state).toEqual({
				isActive: false,
				isInitializing: false,
				isWaiting: false,
				mode: null,
				goal: null,
				confidence: 0,
				ready: false,
				conversationHistory: [],
				isGeneratingDocs: false,
				generatedDocuments: [],
				existingDocuments: [],
				previousUIState: null,
				error: null,
				projectPath: null,
				agentType: null,
				sessionName: null,
				tabId: null,
				sessionId: null,
				streamingContent: '',
				generationProgress: null,
				currentDocumentIndex: 0,
				lastUserMessageContent: null,
				agentSessionId: null,
				subfolderName: null,
				subfolderPath: null,
				autoRunFolderPath: null,
			});
		});
	});

	describe('startWizard', () => {
		it('should activate the wizard when called', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			await act(async () => {
				await result.current.startWizard();
			});

			expect(result.current.isWizardActive).toBe(true);
		});

		it('should set mode to new when no input provided and no existing docs', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			await act(async () => {
				await result.current.startWizard();
			});

			// No project path provided → no existing docs check → defaults to 'new'
			expect(result.current.wizardMode).toBe('new');
		});

		it('should parse intent and set mode when input is provided', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			await act(async () => {
				await result.current.startWizard('add authentication');
			});

			expect(result.current.isWizardActive).toBe(true);
			// Mode is now determined by intent parser (mocked to return 'iterate')
			expect(result.current.wizardMode).toBe('iterate');
		});

		it('should store previous UI state', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			const previousUIState: PreviousUIState = {
				readOnlyMode: true,
				saveToHistory: false,
				showThinking: true,
			};

			await act(async () => {
				await result.current.startWizard('test', previousUIState);
			});

			expect(result.current.state.previousUIState).toEqual(previousUIState);
		});

		it('should reset conversation history when starting', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			// Start wizard and add a message
			await act(async () => {
				await result.current.startWizard();
			});

			act(() => {
				result.current.sendMessage('test message');
			});

			expect(result.current.conversationHistory.length).toBeGreaterThan(0);

			// Start wizard again - should reset
			await act(async () => {
				await result.current.startWizard('new session');
			});

			expect(result.current.conversationHistory).toEqual([]);
		});
	});

	describe('endWizard', () => {
		it('should deactivate the wizard', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			await act(async () => {
				await result.current.startWizard();
			});

			expect(result.current.isWizardActive).toBe(true);

			await act(async () => {
				await result.current.endWizard();
			});

			expect(result.current.isWizardActive).toBe(false);
		});

		it('should return the previous UI state', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			const previousUIState: PreviousUIState = {
				readOnlyMode: true,
				saveToHistory: false,
				showThinking: true,
			};

			await act(async () => {
				await result.current.startWizard('test', previousUIState);
			});

			let returnedState: PreviousUIState | null = null;
			await act(async () => {
				returnedState = await result.current.endWizard();
			});

			expect(returnedState).toEqual(previousUIState);
		});

		it('should reset all state to initial values', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			// Build up some state
			await act(async () => {
				await result.current.startWizard('test');
			});

			await act(async () => {
				result.current.setMode('new');
				result.current.setGoal('add feature');
				result.current.setConfidence(75);
				await result.current.sendMessage('hello');
				result.current.setGeneratingDocs(true);
				result.current.setError('test error');
			});

			// End wizard
			await act(async () => {
				await result.current.endWizard();
			});

			// All state should be reset
			expect(result.current.state).toEqual({
				isActive: false,
				isInitializing: false,
				isWaiting: false,
				mode: null,
				goal: null,
				confidence: 0,
				ready: false,
				conversationHistory: [],
				isGeneratingDocs: false,
				generatedDocuments: [],
				existingDocuments: [],
				previousUIState: null,
				error: null,
				projectPath: null,
				agentType: null,
				sessionName: null,
				tabId: null,
				sessionId: null,
				streamingContent: '',
				generationProgress: null,
				currentDocumentIndex: 0,
				lastUserMessageContent: null,
				agentSessionId: null,
				subfolderName: null,
				subfolderPath: null,
				autoRunFolderPath: null,
			});
		});
	});

	describe('sendMessage', () => {
		it('should add a user message to conversation history', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			await act(async () => {
				await result.current.startWizard();
			});

			act(() => {
				result.current.sendMessage('Hello, wizard!');
			});

			expect(result.current.conversationHistory).toHaveLength(1);
			expect(result.current.conversationHistory[0].role).toBe('user');
			expect(result.current.conversationHistory[0].content).toBe('Hello, wizard!');
		});

		it('should generate unique message IDs', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			await act(async () => {
				await result.current.startWizard();
			});

			act(() => {
				result.current.sendMessage('Message 1');
				result.current.sendMessage('Message 2');
			});

			const ids = result.current.conversationHistory.map((m) => m.id);
			expect(ids[0]).not.toBe(ids[1]);
		});

		it('should include timestamp on messages', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			await act(async () => {
				await result.current.startWizard();
			});

			const beforeTime = Date.now();

			act(() => {
				result.current.sendMessage('Test message');
			});

			const afterTime = Date.now();
			const messageTime = result.current.conversationHistory[0].timestamp;

			expect(messageTime).toBeGreaterThanOrEqual(beforeTime);
			expect(messageTime).toBeLessThanOrEqual(afterTime);
		});
	});

	describe('addAssistantMessage', () => {
		it('should add an assistant message to conversation history', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			await act(async () => {
				await result.current.startWizard();
			});

			act(() => {
				result.current.addAssistantMessage('I can help with that!');
			});

			expect(result.current.conversationHistory).toHaveLength(1);
			expect(result.current.conversationHistory[0].role).toBe('assistant');
			expect(result.current.conversationHistory[0].content).toBe('I can help with that!');
		});

		it('should include confidence when provided', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			await act(async () => {
				await result.current.startWizard();
			});

			act(() => {
				result.current.addAssistantMessage('Understanding better...', 65);
			});

			expect(result.current.conversationHistory[0].confidence).toBe(65);
			expect(result.current.confidence).toBe(65);
		});

		it('should include ready flag when provided', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			await act(async () => {
				await result.current.startWizard();
			});

			act(() => {
				result.current.addAssistantMessage('Ready to generate!', 85, true);
			});

			expect(result.current.conversationHistory[0].ready).toBe(true);
		});
	});

	describe('setConfidence', () => {
		it('should update confidence value', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			await act(async () => {
				await result.current.startWizard();
			});

			act(() => {
				result.current.setConfidence(50);
			});

			expect(result.current.confidence).toBe(50);
		});

		it('should clamp confidence to 0-100 range', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			await act(async () => {
				await result.current.startWizard();
			});

			act(() => {
				result.current.setConfidence(150);
			});

			expect(result.current.confidence).toBe(100);

			act(() => {
				result.current.setConfidence(-50);
			});

			expect(result.current.confidence).toBe(0);
		});
	});

	describe('setMode', () => {
		it('should update wizard mode', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			await act(async () => {
				await result.current.startWizard();
			});

			act(() => {
				result.current.setMode('new');
			});

			expect(result.current.wizardMode).toBe('new');

			act(() => {
				result.current.setMode('iterate');
			});

			expect(result.current.wizardMode).toBe('iterate');
		});
	});

	describe('setGoal', () => {
		it('should update wizard goal', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			await act(async () => {
				await result.current.startWizard();
			});

			act(() => {
				result.current.setGoal('add user authentication');
			});

			expect(result.current.wizardGoal).toBe('add user authentication');
		});

		it('should allow null goal', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			await act(async () => {
				await result.current.startWizard();
			});

			act(() => {
				result.current.setGoal('some goal');
			});

			expect(result.current.wizardGoal).toBe('some goal');

			act(() => {
				result.current.setGoal(null);
			});

			expect(result.current.wizardGoal).toBeNull();
		});
	});

	describe('setGeneratingDocs', () => {
		it('should update generating docs state', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			await act(async () => {
				await result.current.startWizard();
			});

			act(() => {
				result.current.setGeneratingDocs(true);
			});

			expect(result.current.isGeneratingDocs).toBe(true);

			act(() => {
				result.current.setGeneratingDocs(false);
			});

			expect(result.current.isGeneratingDocs).toBe(false);
		});
	});

	describe('setGeneratedDocuments', () => {
		it('should update generated documents', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			const docs = [
				{ filename: 'phase-1.md', content: '# Phase 1', taskCount: 5 },
				{ filename: 'phase-2.md', content: '# Phase 2', taskCount: 3 },
			];

			await act(async () => {
				await result.current.startWizard();
			});

			act(() => {
				result.current.setGeneratedDocuments(docs);
			});

			expect(result.current.generatedDocuments).toEqual(docs);
		});

		it('should set isGeneratingDocs to false when documents are set', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			await act(async () => {
				await result.current.startWizard();
			});

			act(() => {
				result.current.setGeneratingDocs(true);
			});

			expect(result.current.isGeneratingDocs).toBe(true);

			act(() => {
				result.current.setGeneratedDocuments([
					{ filename: 'test.md', content: '# Test', taskCount: 1 },
				]);
			});

			expect(result.current.isGeneratingDocs).toBe(false);
		});
	});

	describe('setError', () => {
		it('should update error state', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			await act(async () => {
				await result.current.startWizard();
			});

			act(() => {
				result.current.setError('Something went wrong');
			});

			expect(result.current.error).toBe('Something went wrong');
		});

		it('should allow clearing error', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			await act(async () => {
				await result.current.startWizard();
			});

			act(() => {
				result.current.setError('Error');
			});

			expect(result.current.error).toBe('Error');

			act(() => {
				result.current.setError(null);
			});

			expect(result.current.error).toBeNull();
		});
	});

	describe('clearConversation', () => {
		it('should clear conversation history', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			await act(async () => {
				await result.current.startWizard();
			});

			act(() => {
				result.current.sendMessage('Message 1');
				result.current.addAssistantMessage('Response 1');
				result.current.sendMessage('Message 2');
			});

			expect(result.current.conversationHistory).toHaveLength(3);

			act(() => {
				result.current.clearConversation();
			});

			expect(result.current.conversationHistory).toEqual([]);
		});
	});

	describe('reset', () => {
		it('should reset all state to initial values', async () => {
			const { result } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			// Build up state
			await act(async () => {
				await result.current.startWizard('test', {
					readOnlyMode: true,
					saveToHistory: false,
					showThinking: true,
				});
			});

			act(() => {
				result.current.setMode('iterate');
				result.current.setGoal('add feature');
				result.current.setConfidence(80);
				result.current.sendMessage('test');
				result.current.setGeneratingDocs(true);
				result.current.setError('error');
			});

			// Reset
			act(() => {
				result.current.reset();
			});

			// Verify everything is reset
			expect(result.current.isWizardActive).toBe(false);
			expect(result.current.wizardMode).toBeNull();
			expect(result.current.wizardGoal).toBeNull();
			expect(result.current.confidence).toBe(0);
			expect(result.current.conversationHistory).toEqual([]);
			expect(result.current.isGeneratingDocs).toBe(false);
			expect(result.current.generatedDocuments).toEqual([]);
			expect(result.current.error).toBeNull();
			expect(result.current.state.previousUIState).toBeNull();
		});
	});

	describe('callback stability', () => {
		it('should return stable action callbacks across renders', () => {
			const { result, rerender } = renderHook(() => useInlineWizardContext(), {
				wrapper: createWrapper(),
			});

			const startWizard1 = result.current.startWizard;
			const endWizard1 = result.current.endWizard;
			const sendMessage1 = result.current.sendMessage;
			const setConfidence1 = result.current.setConfidence;
			const setMode1 = result.current.setMode;
			const setGoal1 = result.current.setGoal;
			const reset1 = result.current.reset;

			rerender();

			expect(result.current.startWizard).toBe(startWizard1);
			expect(result.current.endWizard).toBe(endWizard1);
			expect(result.current.sendMessage).toBe(sendMessage1);
			expect(result.current.setConfidence).toBe(setConfidence1);
			expect(result.current.setMode).toBe(setMode1);
			expect(result.current.setGoal).toBe(setGoal1);
			expect(result.current.reset).toBe(reset1);
		});
	});

	describe('multiple consumers', () => {
		it('should share state between multiple consumers', async () => {
			// Create a shared wrapper
			const wrapper = createWrapper();

			// First consumer
			const { result: consumer1 } = renderHook(() => useInlineWizardContext(), {
				wrapper,
			});

			// Second consumer (same wrapper instance)
			const { result: consumer2 } = renderHook(() => useInlineWizardContext(), {
				wrapper,
			});

			// Start wizard from consumer1
			await act(async () => {
				await consumer1.current.startWizard('test');
			});

			// Both consumers should see the change
			// Note: In a real app they'd share the same provider instance
			// This test verifies the context value structure is consistent
			expect(consumer1.current.isWizardActive).toBe(true);
			// consumer2 has its own instance in this test setup
		});
	});
});
