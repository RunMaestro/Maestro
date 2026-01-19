/**
 * @file InlineWizardFlow.test.tsx
 * @description Integration tests for the Inline Wizard end-to-end flow
 *
 * Tests the complete inline wizard flow including:
 * - `/wizard` shows mode prompt when docs exist
 * - `/wizard add user authentication` goes straight to iterate mode with goal
 * - Conversation updates confidence
 * - "Let's Go" button appears at threshold (80%)
 * - Document generation shows progress
 * - Completion triggers correct state
 * - Previous UI state (toggles) restored when wizard ends
 */

import { describe, it, expect, vi, beforeEach, afterEach, Mock } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';

// Import hook and components under test
import { useInlineWizard, type InlineWizardMode } from '../../renderer/hooks/useInlineWizard';
import {
	InlineWizardProvider,
	useInlineWizardContext,
} from '../../renderer/contexts/InlineWizardContext';
import { WizardConversationView } from '../../renderer/components/InlineWizard/WizardConversationView';
import { parseWizardIntent } from '../../renderer/services/wizardIntentParser';
import type { Theme } from '../../renderer/types';

// Mock the maestro API
const mockMaestro = {
	autorun: {
		listDocs: vi.fn(),
		readDoc: vi.fn(),
		writeDoc: vi.fn(),
	},
	agents: {
		get: vi.fn(),
	},
	process: {
		spawn: vi.fn(),
		kill: vi.fn(),
		onData: vi.fn(),
		onExit: vi.fn(),
	},
};

// Setup window.maestro mock before each test
beforeEach(() => {
	(window as any).maestro = mockMaestro;
	vi.clearAllMocks();
});

afterEach(() => {
	vi.useRealTimers();
});

// Create a mock theme
const createMockTheme = (): Theme => ({
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		bgMain: '#1a1a1a',
		bgPanel: '#252525',
		bgActivity: '#2d2d2d',
		bgSidebar: '#1e1e1e',
		textMain: '#ffffff',
		textDim: '#888888',
		accent: '#0066ff',
		accentForeground: '#ffffff',
		border: '#333333',
		highlight: '#0066ff33',
		success: '#00aa00',
		warning: '#ffaa00',
		error: '#ff0000',
	},
});

/**
 * Helper to create a wrapper component with InlineWizardProvider
 */
function createWrapper() {
	return function Wrapper({ children }: { children: React.ReactNode }) {
		return <InlineWizardProvider>{children}</InlineWizardProvider>;
	};
}

describe('Inline Wizard Integration Flow', () => {
	describe('Intent Parsing and Mode Detection', () => {
		describe('/wizard command with existing docs', () => {
			it('shows "ask" mode when /wizard is invoked without arguments and docs exist', () => {
				const result = parseWizardIntent('', true);
				expect(result.mode).toBe('ask');
			});

			it('shows "new" mode when /wizard is invoked without arguments and no docs exist', () => {
				const result = parseWizardIntent('', false);
				expect(result.mode).toBe('new');
			});

			it('goes to iterate mode with goal when /wizard add user authentication', () => {
				const result = parseWizardIntent('add user authentication', true);
				expect(result.mode).toBe('iterate');
				expect(result.goal).toBe('user authentication');
			});

			it('goes to iterate mode when /wizard continue from where we left off', () => {
				const result = parseWizardIntent('continue from where we left off', true);
				expect(result.mode).toBe('iterate');
				expect(result.goal).toBe('from where we left off');
			});

			it('goes to new mode when /wizard start fresh', () => {
				const result = parseWizardIntent('start fresh', true);
				expect(result.mode).toBe('new');
			});

			it('goes to new mode when /wizard from scratch', () => {
				const result = parseWizardIntent('from scratch', true);
				expect(result.mode).toBe('new');
			});

			it('detects iterate intent for various keyword patterns', () => {
				const iteratePatterns = [
					'update the authentication flow',
					'modify the user model',
					'extend the API endpoints',
					'expand the test coverage',
					'change the database schema',
					'enhance the error handling',
					'next phase',
				];

				for (const pattern of iteratePatterns) {
					const result = parseWizardIntent(pattern, true);
					expect(result.mode).toBe('iterate');
				}
			});

			it('shows "ask" mode for ambiguous input when docs exist', () => {
				const result = parseWizardIntent('something about the project', true);
				expect(result.mode).toBe('ask');
			});

			it('defaults to "new" mode for ambiguous input when no docs exist', () => {
				const result = parseWizardIntent('something about the project', false);
				expect(result.mode).toBe('new');
			});
		});
	});

	describe('useInlineWizard Hook - Start Flow', () => {
		beforeEach(() => {
			// Mock no existing docs by default
			mockMaestro.autorun.listDocs.mockResolvedValue({ success: true, files: [] });
		});

		it('initializes in inactive state', () => {
			const { result } = renderHook(() => useInlineWizard());

			expect(result.current.isWizardActive).toBe(false);
			expect(result.current.wizardMode).toBeNull();
			expect(result.current.confidence).toBe(0);
			expect(result.current.ready).toBe(false);
		});

		it('becomes active when startWizard is called', async () => {
			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					undefined,
					{ readOnlyMode: false, saveToHistory: true, showThinking: true },
					'/test/project',
					'claude-code',
					'TestProject'
				);
			});

			expect(result.current.isWizardActive).toBe(true);
			expect(result.current.wizardMode).toBe('new');
		});

		it('sets mode to "ask" when docs exist and no input provided', async () => {
			// Mock existing docs
			mockMaestro.autorun.listDocs.mockResolvedValue({
				success: true,
				files: ['Phase-01-Setup'],
			});

			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					undefined, // No input
					{ readOnlyMode: false, saveToHistory: true, showThinking: true },
					'/test/project',
					'claude-code',
					'TestProject'
				);
			});

			expect(result.current.wizardMode).toBe('ask');
		});

		it('sets mode to "iterate" with goal when iterate input provided', async () => {
			// Mock existing docs
			mockMaestro.autorun.listDocs.mockResolvedValue({
				success: true,
				files: ['Phase-01-Setup'],
			});
			mockMaestro.autorun.readDoc.mockResolvedValue({
				success: true,
				content: '# Phase 1\n- [ ] Task 1',
			});

			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					'add user authentication',
					{ readOnlyMode: false, saveToHistory: true, showThinking: true },
					'/test/project',
					'claude-code',
					'TestProject'
				);
			});

			expect(result.current.wizardMode).toBe('iterate');
			expect(result.current.wizardGoal).toBe('user authentication');
		});

		it('stores previous UI state for later restoration', async () => {
			const { result } = renderHook(() => useInlineWizard());
			const previousUIState = { readOnlyMode: true, saveToHistory: false, showThinking: true };

			await act(async () => {
				await result.current.startWizard(
					undefined,
					previousUIState,
					'/test/project',
					'claude-code',
					'TestProject'
				);
			});

			expect(result.current.state.previousUIState).toEqual(previousUIState);
		});
	});

	describe('Conversation and Confidence Updates', () => {
		it('updates confidence from parsed AI response', async () => {
			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				// Directly set confidence to simulate AI response
				result.current.setConfidence(50);
			});

			expect(result.current.confidence).toBe(50);
		});

		it('clamps confidence between 0 and 100', async () => {
			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				result.current.setConfidence(150);
			});
			expect(result.current.confidence).toBe(100);

			await act(async () => {
				result.current.setConfidence(-10);
			});
			expect(result.current.confidence).toBe(0);
		});

		it('adds assistant messages with confidence and ready flags', async () => {
			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				result.current.addAssistantMessage('Test message', 75, false);
			});

			expect(result.current.conversationHistory).toHaveLength(1);
			expect(result.current.conversationHistory[0].content).toBe('Test message');
			expect(result.current.conversationHistory[0].confidence).toBe(75);
			expect(result.current.conversationHistory[0].ready).toBe(false);
			expect(result.current.confidence).toBe(75);
			expect(result.current.ready).toBe(false);
		});

		it('updates readyToGenerate when ready=true and confidence >= 80', async () => {
			const { result } = renderHook(() => useInlineWizard());

			// Start the wizard
			mockMaestro.autorun.listDocs.mockResolvedValue({ success: true, files: [] });
			await act(async () => {
				await result.current.startWizard(
					undefined,
					{ readOnlyMode: false, saveToHistory: true, showThinking: true },
					'/test/project',
					'claude-code',
					'TestProject'
				);
			});

			// Initially not ready
			expect(result.current.readyToGenerate).toBe(false);

			// Add response with confidence 80 and ready = true
			await act(async () => {
				result.current.addAssistantMessage('Ready!', 80, true);
			});

			expect(result.current.readyToGenerate).toBe(true);
		});

		it('does not set readyToGenerate when confidence < 80 even if ready=true', async () => {
			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				result.current.addAssistantMessage('Almost ready', 79, true);
			});

			expect(result.current.readyToGenerate).toBe(false);
		});

		it('does not set readyToGenerate when ready=false even if confidence >= 80', async () => {
			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				result.current.addAssistantMessage('High confidence but not ready', 90, false);
			});

			expect(result.current.readyToGenerate).toBe(false);
		});
	});

	describe('"Let\'s Go" Button Rendering', () => {
		const theme = createMockTheme();

		it('does not show "Let\'s Go" button when confidence < 80', () => {
			render(
				<WizardConversationView
					theme={theme}
					conversationHistory={[]}
					confidence={79}
					ready={true}
					onLetsGo={() => {}}
				/>
			);

			expect(screen.queryByTestId('wizard-lets-go-container')).not.toBeInTheDocument();
		});

		it('does not show "Let\'s Go" button when ready=false', () => {
			render(
				<WizardConversationView
					theme={theme}
					conversationHistory={[]}
					confidence={90}
					ready={false}
					onLetsGo={() => {}}
				/>
			);

			expect(screen.queryByTestId('wizard-lets-go-container')).not.toBeInTheDocument();
		});

		it('does not show "Let\'s Go" button when isLoading', () => {
			render(
				<WizardConversationView
					theme={theme}
					conversationHistory={[]}
					confidence={90}
					ready={true}
					isLoading={true}
					onLetsGo={() => {}}
				/>
			);

			expect(screen.queryByTestId('wizard-lets-go-container')).not.toBeInTheDocument();
		});

		it('shows "Let\'s Go" button when ready=true and confidence >= 80', () => {
			render(
				<WizardConversationView
					theme={theme}
					conversationHistory={[]}
					confidence={80}
					ready={true}
					onLetsGo={() => {}}
				/>
			);

			expect(screen.getByTestId('wizard-lets-go-container')).toBeInTheDocument();
			expect(screen.getByTestId('wizard-lets-go-button')).toBeInTheDocument();
		});

		it('calls onLetsGo when button is clicked', () => {
			const onLetsGo = vi.fn();
			render(
				<WizardConversationView
					theme={theme}
					conversationHistory={[]}
					confidence={85}
					ready={true}
					onLetsGo={onLetsGo}
				/>
			);

			fireEvent.click(screen.getByTestId('wizard-lets-go-button'));
			expect(onLetsGo).toHaveBeenCalledTimes(1);
		});

		it('does not render button when onLetsGo is not provided', () => {
			render(
				<WizardConversationView
					theme={theme}
					conversationHistory={[]}
					confidence={90}
					ready={true}
				/>
			);

			expect(screen.queryByTestId('wizard-lets-go-container')).not.toBeInTheDocument();
		});
	});

	describe('Error Handling and Retry', () => {
		const theme = createMockTheme();

		it('shows error display when error prop is provided', () => {
			render(
				<WizardConversationView
					theme={theme}
					conversationHistory={[]}
					error="Connection timeout"
					onRetry={() => {}}
					onClearError={() => {}}
				/>
			);

			expect(screen.getByTestId('wizard-error-display')).toBeInTheDocument();
			expect(screen.getByTestId('error-title')).toBeInTheDocument();
		});

		it('calls onRetry when retry button is clicked', () => {
			const onRetry = vi.fn();
			render(
				<WizardConversationView
					theme={theme}
					conversationHistory={[]}
					error="Failed to get response"
					onRetry={onRetry}
					onClearError={() => {}}
				/>
			);

			fireEvent.click(screen.getByTestId('error-retry-button'));
			expect(onRetry).toHaveBeenCalledTimes(1);
		});

		it('calls onClearError when dismiss button is clicked', () => {
			const onClearError = vi.fn();
			render(
				<WizardConversationView
					theme={theme}
					conversationHistory={[]}
					error="Some error"
					onRetry={() => {}}
					onClearError={onClearError}
				/>
			);

			fireEvent.click(screen.getByTestId('error-dismiss-button'));
			expect(onClearError).toHaveBeenCalledTimes(1);
		});

		it('displays user-friendly error message for timeout', () => {
			render(
				<WizardConversationView
					theme={theme}
					conversationHistory={[]}
					error="Response timeout - agent did not complete in time"
					onRetry={() => {}}
					onClearError={() => {}}
				/>
			);

			expect(screen.getByTestId('error-title')).toHaveTextContent('Response Timeout');
		});

		it('displays user-friendly error message for agent not available', () => {
			render(
				<WizardConversationView
					theme={theme}
					conversationHistory={[]}
					error="Agent claude-code is not available"
					onRetry={() => {}}
					onClearError={() => {}}
				/>
			);

			expect(screen.getByTestId('error-title')).toHaveTextContent('Agent Not Available');
		});
	});

	describe('Document Generation Flow', () => {
		it('tracks generated documents', async () => {
			const { result } = renderHook(() => useInlineWizard());

			// Initially no documents
			expect(result.current.generatedDocuments).toHaveLength(0);
			expect(result.current.isGeneratingDocs).toBe(false);

			// Set generating docs
			await act(async () => {
				result.current.setGeneratingDocs(true);
			});
			expect(result.current.isGeneratingDocs).toBe(true);

			// Set generated documents
			await act(async () => {
				result.current.setGeneratedDocuments([
					{ filename: 'Phase-01-Setup.md', content: '# Phase 1', taskCount: 3 },
					{ filename: 'Phase-02-Auth.md', content: '# Phase 2', taskCount: 5 },
				]);
			});

			expect(result.current.generatedDocuments).toHaveLength(2);
			expect(result.current.isGeneratingDocs).toBe(false);
		});

		it('tracks streaming content during generation', async () => {
			const { result } = renderHook(() => useInlineWizard());

			expect(result.current.streamingContent).toBe('');

			// Streaming content updates happen during generateDocuments
			// We can test the state structure is correct
			expect(result.current.state).toHaveProperty('streamingContent');
			expect(result.current.state).toHaveProperty('generationProgress');
		});

		it('tracks generation progress', async () => {
			const { result } = renderHook(() => useInlineWizard());

			expect(result.current.generationProgress).toBeNull();

			// Progress tracking structure is available
			expect(result.current.state).toHaveProperty('generationProgress');
		});
	});

	describe('UI State Restoration', () => {
		it('returns previous UI state when wizard ends', async () => {
			const { result } = renderHook(() => useInlineWizard());
			const previousUIState = { readOnlyMode: true, saveToHistory: false, showThinking: true };

			// Mock no docs
			mockMaestro.autorun.listDocs.mockResolvedValue({ success: true, files: [] });

			// Start wizard with previous state
			await act(async () => {
				await result.current.startWizard(
					undefined,
					previousUIState,
					'/test/project',
					'claude-code',
					'TestProject'
				);
			});

			expect(result.current.isWizardActive).toBe(true);

			// End wizard and get previous state
			let restoredState: any;
			await act(async () => {
				restoredState = await result.current.endWizard();
			});

			expect(result.current.isWizardActive).toBe(false);
			expect(restoredState).toEqual(previousUIState);
		});

		it('resets all state when wizard ends', async () => {
			const { result } = renderHook(() => useInlineWizard());

			// Mock no docs
			mockMaestro.autorun.listDocs.mockResolvedValue({ success: true, files: [] });

			// Start wizard
			await act(async () => {
				await result.current.startWizard(
					undefined,
					{ readOnlyMode: false, saveToHistory: true, showThinking: true },
					'/test/project',
					'claude-code',
					'TestProject'
				);
			});

			// Add some state
			await act(async () => {
				result.current.addAssistantMessage('Test', 50, false);
				result.current.setConfidence(75);
			});

			expect(result.current.conversationHistory).toHaveLength(1);
			expect(result.current.confidence).toBe(75);

			// End wizard
			await act(async () => {
				await result.current.endWizard();
			});

			// All state should be reset
			expect(result.current.isWizardActive).toBe(false);
			expect(result.current.conversationHistory).toHaveLength(0);
			expect(result.current.confidence).toBe(0);
			expect(result.current.wizardMode).toBeNull();
			expect(result.current.wizardGoal).toBeNull();
			expect(result.current.error).toBeNull();
		});

		it('reset() clears all wizard state', async () => {
			const { result } = renderHook(() => useInlineWizard());

			// Mock no docs
			mockMaestro.autorun.listDocs.mockResolvedValue({ success: true, files: [] });

			// Start wizard and add state
			await act(async () => {
				await result.current.startWizard(
					undefined,
					{ readOnlyMode: false, saveToHistory: true, showThinking: true },
					'/test/project',
					'claude-code',
					'TestProject'
				);
				result.current.addAssistantMessage('Test', 60, false);
				result.current.setError('Some error');
			});

			expect(result.current.isWizardActive).toBe(true);
			expect(result.current.conversationHistory).toHaveLength(1);
			expect(result.current.error).toBe('Some error');

			// Reset
			await act(async () => {
				result.current.reset();
			});

			// All state should be cleared
			expect(result.current.isWizardActive).toBe(false);
			expect(result.current.conversationHistory).toHaveLength(0);
			expect(result.current.error).toBeNull();
			expect(result.current.state.previousUIState).toBeNull();
		});
	});

	describe('Clear Error and Retry', () => {
		it('clearError() clears the current error', async () => {
			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				result.current.setError('Test error');
			});
			expect(result.current.error).toBe('Test error');

			await act(async () => {
				result.current.clearError();
			});
			expect(result.current.error).toBeNull();
		});

		it('setError() sets the error message', async () => {
			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				result.current.setError('Connection failed');
			});

			expect(result.current.error).toBe('Connection failed');
		});
	});

	describe('Context Provider', () => {
		it('provides wizard state through context', async () => {
			const TestComponent = () => {
				const wizard = useInlineWizardContext();
				return (
					<div data-testid="context-test">
						<span data-testid="is-active">{wizard.isWizardActive.toString()}</span>
						<span data-testid="confidence">{wizard.confidence}</span>
					</div>
				);
			};

			render(
				<InlineWizardProvider>
					<TestComponent />
				</InlineWizardProvider>
			);

			expect(screen.getByTestId('is-active')).toHaveTextContent('false');
			expect(screen.getByTestId('confidence')).toHaveTextContent('0');
		});

		it('throws error when used outside provider', () => {
			const TestComponent = () => {
				useInlineWizardContext();
				return null;
			};

			// Suppress console.error for this test
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

			expect(() => render(<TestComponent />)).toThrow(
				'useInlineWizardContext must be used within an InlineWizardProvider'
			);

			consoleError.mockRestore();
		});
	});

	describe('Streaming and Loading States', () => {
		const theme = createMockTheme();

		it('shows typing indicator when loading and no streaming text', () => {
			render(<WizardConversationView theme={theme} conversationHistory={[]} isLoading={true} />);

			expect(screen.getByTestId('wizard-typing-indicator')).toBeInTheDocument();
		});

		it('shows streaming response when loading with streaming text', () => {
			render(
				<WizardConversationView
					theme={theme}
					conversationHistory={[]}
					isLoading={true}
					streamingText="I am analyzing your..."
				/>
			);

			expect(screen.getByTestId('wizard-streaming-response')).toBeInTheDocument();
			expect(screen.getByTestId('streaming-response-text')).toHaveTextContent(
				'I am analyzing your...'
			);
		});

		it('shows empty state when no messages and not loading', () => {
			render(<WizardConversationView theme={theme} conversationHistory={[]} isLoading={false} />);

			expect(screen.getByTestId('wizard-conversation-empty')).toBeInTheDocument();
		});

		it('does not show empty state when there are messages', () => {
			render(
				<WizardConversationView
					theme={theme}
					conversationHistory={[{ id: '1', role: 'user', content: 'Hello', timestamp: Date.now() }]}
					isLoading={false}
				/>
			);

			expect(screen.queryByTestId('wizard-conversation-empty')).not.toBeInTheDocument();
		});

		it('does not show typing indicator when there is an error', () => {
			render(
				<WizardConversationView
					theme={theme}
					conversationHistory={[]}
					isLoading={true}
					error="Some error"
				/>
			);

			expect(screen.queryByTestId('wizard-typing-indicator')).not.toBeInTheDocument();
		});
	});

	describe('Mode Setting', () => {
		it('setMode updates the wizard mode', async () => {
			const { result } = renderHook(() => useInlineWizard());

			// Mock no docs
			mockMaestro.autorun.listDocs.mockResolvedValue({ success: true, files: [] });

			// Start wizard
			await act(async () => {
				await result.current.startWizard(
					undefined,
					{ readOnlyMode: false, saveToHistory: true, showThinking: true },
					'/test/project',
					'claude-code',
					'TestProject'
				);
			});

			expect(result.current.wizardMode).toBe('new');

			// Change mode
			await act(async () => {
				result.current.setMode('iterate');
			});

			expect(result.current.wizardMode).toBe('iterate');
		});

		it('setGoal updates the iterate mode goal', async () => {
			const { result } = renderHook(() => useInlineWizard());

			expect(result.current.wizardGoal).toBeNull();

			await act(async () => {
				result.current.setGoal('add new feature');
			});

			expect(result.current.wizardGoal).toBe('add new feature');
		});
	});

	describe('Existing Documents Handling', () => {
		it('setExistingDocuments updates the existing documents list', async () => {
			const { result } = renderHook(() => useInlineWizard());

			expect(result.current.existingDocuments).toHaveLength(0);

			await act(async () => {
				result.current.setExistingDocuments([
					{ name: 'Phase-01', filename: 'Phase-01.md', path: '/test/Phase-01.md' },
					{ name: 'Phase-02', filename: 'Phase-02.md', path: '/test/Phase-02.md' },
				]);
			});

			expect(result.current.existingDocuments).toHaveLength(2);
		});

		it('loads existing documents in iterate mode', async () => {
			// Mock existing docs
			mockMaestro.autorun.listDocs.mockResolvedValue({
				success: true,
				files: ['Phase-01-Setup', 'Phase-02-Development'],
			});
			mockMaestro.autorun.readDoc.mockResolvedValue({
				success: true,
				content: '# Phase 1\n- [ ] Task 1',
			});

			const { result } = renderHook(() => useInlineWizard());

			await act(async () => {
				await result.current.startWizard(
					'add authentication',
					{ readOnlyMode: false, saveToHistory: true, showThinking: true },
					'/test/project',
					'claude-code',
					'TestProject'
				);
			});

			expect(result.current.wizardMode).toBe('iterate');
			expect(result.current.existingDocuments).toHaveLength(2);
		});
	});

	describe('Conversation History Management', () => {
		it('clearConversation removes all messages', async () => {
			const { result } = renderHook(() => useInlineWizard());

			// Add messages
			await act(async () => {
				result.current.addAssistantMessage('Message 1', 30, false);
				result.current.addAssistantMessage('Message 2', 50, false);
			});

			expect(result.current.conversationHistory).toHaveLength(2);

			// Clear conversation
			await act(async () => {
				result.current.clearConversation();
			});

			expect(result.current.conversationHistory).toHaveLength(0);
		});
	});

	describe('Full Integration Scenarios', () => {
		it('simulates complete new wizard flow from start to document generation ready', async () => {
			// Mock no existing docs
			mockMaestro.autorun.listDocs.mockResolvedValue({ success: true, files: [] });

			const { result } = renderHook(() => useInlineWizard());
			const previousUIState = { readOnlyMode: true, saveToHistory: false, showThinking: true };

			// Step 1: Start wizard
			await act(async () => {
				await result.current.startWizard(
					undefined,
					previousUIState,
					'/test/project',
					'claude-code',
					'TestProject'
				);
			});

			expect(result.current.isWizardActive).toBe(true);
			expect(result.current.wizardMode).toBe('new');
			expect(result.current.state.previousUIState).toEqual(previousUIState);

			// Step 2: Simulate AI responses with increasing confidence
			await act(async () => {
				result.current.addAssistantMessage('What kind of project is this?', 30, false);
			});

			expect(result.current.confidence).toBe(30);
			expect(result.current.ready).toBe(false);
			expect(result.current.readyToGenerate).toBe(false);

			await act(async () => {
				result.current.addAssistantMessage(
					"I see, it's a web app. Tell me more about the features.",
					55,
					false
				);
			});

			expect(result.current.confidence).toBe(55);
			expect(result.current.readyToGenerate).toBe(false);

			await act(async () => {
				result.current.addAssistantMessage('Great! I have a good understanding now.', 85, true);
			});

			// Step 3: Verify ready state
			expect(result.current.confidence).toBe(85);
			expect(result.current.ready).toBe(true);
			expect(result.current.readyToGenerate).toBe(true);
			expect(result.current.conversationHistory).toHaveLength(3);
		});

		it('simulates iterate flow with existing documents', async () => {
			// Mock existing docs
			mockMaestro.autorun.listDocs.mockResolvedValue({
				success: true,
				files: ['Phase-01-Setup'],
			});
			mockMaestro.autorun.readDoc.mockResolvedValue({
				success: true,
				content: '# Phase 1\n- [x] Task 1\n- [x] Task 2',
			});

			const { result } = renderHook(() => useInlineWizard());

			// Start with iterate intent
			await act(async () => {
				await result.current.startWizard(
					'add user authentication and API endpoints',
					{ readOnlyMode: false, saveToHistory: true, showThinking: true },
					'/test/project',
					'claude-code',
					'TestProject'
				);
			});

			// Verify iterate mode
			expect(result.current.wizardMode).toBe('iterate');
			expect(result.current.wizardGoal).toBe('user authentication and API endpoints');
			expect(result.current.existingDocuments).toHaveLength(1);
		});
	});
});
