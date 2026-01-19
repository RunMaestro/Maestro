/**
 * Tests for WizardConversationView.tsx
 *
 * Tests the scrollable conversation area for the inline wizard:
 * - Rendering conversation history messages
 * - Empty state display
 * - Typing indicator display when loading
 * - Streaming response display
 * - Auto-scroll to bottom behavior
 * - Filler phrase rotation
 * - Component styling and layout
 * - ThinkingDisplay when showThinking is enabled
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { WizardConversationView } from '../../../../renderer/components/InlineWizard/WizardConversationView';
import type { WizardMessageBubbleMessage } from '../../../../renderer/components/InlineWizard/WizardMessageBubble';
import type { Theme } from '../../../../renderer/types';

// Mock theme for testing
const mockTheme: Theme = {
	id: 'test-theme',
	name: 'Test Theme',
	mode: 'dark',
	colors: {
		background: '#1a1a1a',
		backgroundDim: '#0d0d0d',
		backgroundBright: '#2a2a2a',
		bgMain: '#1a1a1a',
		bgSidebar: '#141414',
		bgActivity: '#333333',
		textMain: '#ffffff',
		textDim: '#888888',
		textMuted: '#666666',
		textBright: '#ffffff',
		border: '#333333',
		borderBright: '#444444',
		success: '#00ff00',
		warning: '#ffff00',
		error: '#ff0000',
		accent: '#007bff',
		accentForeground: '#ffffff',
		accentText: '#66b2ff',
	},
};

// Helper to create test messages
function createMessage(
	overrides: Partial<WizardMessageBubbleMessage> = {}
): WizardMessageBubbleMessage {
	return {
		id: `test-message-${Math.random()}`,
		role: 'user',
		content: 'Test message content',
		timestamp: Date.now(),
		...overrides,
	};
}

// Mock scrollIntoView
const mockScrollIntoView = vi.fn();
Element.prototype.scrollIntoView = mockScrollIntoView;

// Mock filler phrases
vi.mock('../../../../renderer/components/Wizard/services/fillerPhrases', () => ({
	getNextFillerPhrase: vi.fn().mockReturnValue('Thinking...'),
}));

describe('WizardConversationView', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		// Mock requestAnimationFrame for typewriter effect tests
		let rafId = 0;
		vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
			rafId++;
			// Schedule callback to run on next timer tick, simulating frame timing
			setTimeout(() => callback(performance.now()), 16);
			return rafId;
		});
		vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	describe('rendering', () => {
		it('renders the conversation view container', () => {
			render(<WizardConversationView theme={mockTheme} conversationHistory={[]} />);
			expect(screen.getByTestId('wizard-conversation-view')).toBeInTheDocument();
		});

		it('applies theme background color to container', () => {
			render(<WizardConversationView theme={mockTheme} conversationHistory={[]} />);
			const container = screen.getByTestId('wizard-conversation-view');
			expect(container).toHaveStyle({
				backgroundColor: mockTheme.colors.bgMain,
			});
		});

		it('applies custom className when provided', () => {
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[]}
					className="custom-class"
				/>
			);
			const container = screen.getByTestId('wizard-conversation-view');
			expect(container).toHaveClass('custom-class');
		});

		it('has flex-1 and overflow-y-auto classes for scrollability', () => {
			render(<WizardConversationView theme={mockTheme} conversationHistory={[]} />);
			const container = screen.getByTestId('wizard-conversation-view');
			expect(container).toHaveClass('flex-1');
			expect(container).toHaveClass('overflow-y-auto');
		});
	});

	describe('empty state', () => {
		it('shows empty state with wizard badge when no messages and not loading', () => {
			render(
				<WizardConversationView theme={mockTheme} conversationHistory={[]} isLoading={false} />
			);
			expect(screen.getByTestId('wizard-conversation-empty')).toBeInTheDocument();
			expect(screen.getByText('🧙 Project Wizard')).toBeInTheDocument();
		});

		it('shows description about Auto Run Playbook', () => {
			render(
				<WizardConversationView theme={mockTheme} conversationHistory={[]} isLoading={false} />
			);
			expect(screen.getByText(/Auto Run Playbook/)).toBeInTheDocument();
		});

		it("shows What You'll Get section with benefits", () => {
			render(
				<WizardConversationView theme={mockTheme} conversationHistory={[]} isLoading={false} />
			);
			expect(screen.getByText("What You'll Get")).toBeInTheDocument();
			expect(
				screen.getByText('Phased markdown documents with actionable tasks')
			).toBeInTheDocument();
			expect(screen.getByText('Auto Run-ready checkboxes the AI can execute')).toBeInTheDocument();
			expect(screen.getByText('A clear roadmap tailored to your project')).toBeInTheDocument();
		});

		it('shows Escape hint for exiting wizard', () => {
			render(
				<WizardConversationView theme={mockTheme} conversationHistory={[]} isLoading={false} />
			);
			expect(screen.getByText(/Escape/)).toBeInTheDocument();
			expect(screen.getByText(/at any time to exit the wizard/)).toBeInTheDocument();
		});

		it('does not show empty state when loading', () => {
			render(
				<WizardConversationView theme={mockTheme} conversationHistory={[]} isLoading={true} />
			);
			expect(screen.queryByTestId('wizard-conversation-empty')).not.toBeInTheDocument();
		});

		it('does not show empty state when messages exist', () => {
			render(<WizardConversationView theme={mockTheme} conversationHistory={[createMessage()]} />);
			expect(screen.queryByTestId('wizard-conversation-empty')).not.toBeInTheDocument();
		});
	});

	describe('message rendering', () => {
		it('renders all messages in conversation history', () => {
			const messages = [
				createMessage({ id: 'msg-1', content: 'First message', role: 'user' }),
				createMessage({
					id: 'msg-2',
					content: 'Second message',
					role: 'assistant',
				}),
				createMessage({ id: 'msg-3', content: 'Third message', role: 'user' }),
			];

			render(<WizardConversationView theme={mockTheme} conversationHistory={messages} />);

			expect(screen.getByText('First message')).toBeInTheDocument();
			expect(screen.getByText('Second message')).toBeInTheDocument();
			expect(screen.getByText('Third message')).toBeInTheDocument();
		});

		it('passes agentName to message bubbles', () => {
			const messages = [
				createMessage({
					id: 'msg-1',
					content: 'Hello',
					role: 'assistant',
				}),
			];

			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={messages}
					agentName="MyAgent"
				/>
			);

			// Agent name should be formatted with robot emoji
			expect(screen.getByText('🤖 MyAgent')).toBeInTheDocument();
		});

		it('passes providerName to message bubbles', () => {
			const messages = [
				createMessage({
					id: 'msg-1',
					content: 'Hello',
					role: 'assistant',
				}),
			];

			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={messages}
					providerName="Claude"
				/>
			);

			expect(screen.getByTestId('provider-badge')).toHaveTextContent('Claude');
		});
	});

	describe('typing indicator', () => {
		it('shows typing indicator when loading and no streaming text', () => {
			render(
				<WizardConversationView theme={mockTheme} conversationHistory={[]} isLoading={true} />
			);
			expect(screen.getByTestId('wizard-typing-indicator')).toBeInTheDocument();
		});

		it('does not show typing indicator when not loading', () => {
			render(
				<WizardConversationView theme={mockTheme} conversationHistory={[]} isLoading={false} />
			);
			expect(screen.queryByTestId('wizard-typing-indicator')).not.toBeInTheDocument();
		});

		it('displays filler phrase with typewriter effect', () => {
			render(
				<WizardConversationView theme={mockTheme} conversationHistory={[]} isLoading={true} />
			);

			const textElement = screen.getByTestId('typing-indicator-text');

			// Initially empty or partial
			expect(textElement.textContent?.length).toBeLessThan('Thinking...'.length);

			// Advance time to complete typewriter effect
			// RAF-based animation: 16ms per frame, 30ms char delay = ~2 frames per char
			// 11 chars * 30ms = 330ms, plus RAF overhead
			act(() => {
				vi.advanceTimersByTime(600);
			});

			// Should show full text after animation
			expect(textElement).toHaveTextContent('Thinking...');
		});

		it('shows bouncing dots', () => {
			render(
				<WizardConversationView theme={mockTheme} conversationHistory={[]} isLoading={true} />
			);
			const dotsContainer = screen.getByTestId('typing-indicator-dots');
			const dots = dotsContainer.querySelectorAll('span');
			expect(dots.length).toBe(3);
		});

		it('uses agentName in typing indicator', () => {
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[]}
					isLoading={true}
					agentName="TestBot"
				/>
			);
			expect(screen.getByText('🤖 TestBot')).toBeInTheDocument();
		});

		it('uses default agent name when not provided', () => {
			render(
				<WizardConversationView theme={mockTheme} conversationHistory={[]} isLoading={true} />
			);
			expect(screen.getByText('🤖 Agent')).toBeInTheDocument();
		});
	});

	describe('streaming response', () => {
		it('shows streaming response when loading with streamingText', () => {
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[]}
					isLoading={true}
					streamingText="This is streaming..."
				/>
			);
			expect(screen.getByTestId('wizard-streaming-response')).toBeInTheDocument();
			expect(screen.queryByTestId('wizard-typing-indicator')).not.toBeInTheDocument();
		});

		it('displays streaming text content', () => {
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[]}
					isLoading={true}
					streamingText="Generating response..."
				/>
			);
			const textElement = screen.getByTestId('streaming-response-text');
			expect(textElement).toHaveTextContent('Generating response...');
		});

		it('shows pulsing cursor at end of streaming text', () => {
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[]}
					isLoading={true}
					streamingText="In progress"
				/>
			);
			expect(screen.getByTestId('streaming-cursor')).toBeInTheDocument();
			expect(screen.getByTestId('streaming-cursor')).toHaveClass('animate-pulse');
		});

		it('does not show streaming response when not loading', () => {
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[]}
					isLoading={false}
					streamingText="Leftover text"
				/>
			);
			expect(screen.queryByTestId('wizard-streaming-response')).not.toBeInTheDocument();
		});
	});

	describe('auto-scroll', () => {
		it('calls scrollIntoView on initial render with messages', () => {
			render(<WizardConversationView theme={mockTheme} conversationHistory={[createMessage()]} />);
			expect(mockScrollIntoView).toHaveBeenCalled();
		});

		it('has scroll anchor element', () => {
			render(<WizardConversationView theme={mockTheme} conversationHistory={[]} />);
			expect(screen.getByTestId('wizard-scroll-anchor')).toBeInTheDocument();
		});

		it('scrolls when conversation history changes', () => {
			const { rerender } = render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[createMessage({ id: 'msg-1' })]}
				/>
			);

			const initialCallCount = mockScrollIntoView.mock.calls.length;

			rerender(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[createMessage({ id: 'msg-1' }), createMessage({ id: 'msg-2' })]}
				/>
			);

			expect(mockScrollIntoView.mock.calls.length).toBeGreaterThan(initialCallCount);
		});

		it('scrolls when loading state changes', () => {
			const { rerender } = render(
				<WizardConversationView theme={mockTheme} conversationHistory={[]} isLoading={false} />
			);

			const initialCallCount = mockScrollIntoView.mock.calls.length;

			rerender(
				<WizardConversationView theme={mockTheme} conversationHistory={[]} isLoading={true} />
			);

			expect(mockScrollIntoView.mock.calls.length).toBeGreaterThan(initialCallCount);
		});
	});

	describe('styling', () => {
		it('applies correct padding classes', () => {
			render(<WizardConversationView theme={mockTheme} conversationHistory={[]} />);
			const container = screen.getByTestId('wizard-conversation-view');
			expect(container).toHaveClass('px-6');
			expect(container).toHaveClass('py-4');
		});

		it('applies min-h-0 class for proper flex behavior', () => {
			render(<WizardConversationView theme={mockTheme} conversationHistory={[]} />);
			const container = screen.getByTestId('wizard-conversation-view');
			expect(container).toHaveClass('min-h-0');
		});

		it('includes style tag with bounce animation keyframes', () => {
			const { container } = render(
				<WizardConversationView theme={mockTheme} conversationHistory={[]} isLoading={true} />
			);
			const style = container.querySelector('style');
			expect(style).toBeInTheDocument();
			expect(style?.textContent).toContain('wizard-typing-bounce');
			expect(style?.textContent).toContain('translateY(-4px)');
		});
	});

	describe('filler phrase rotation', () => {
		it('requests new phrase after 5 seconds when typing is complete', async () => {
			const { getNextFillerPhrase } =
				await import('../../../../renderer/components/Wizard/services/fillerPhrases');

			render(
				<WizardConversationView theme={mockTheme} conversationHistory={[]} isLoading={true} />
			);

			// Complete the typewriter effect
			await act(async () => {
				vi.advanceTimersByTime(500);
			});

			// Wait for the 5 second rotation timer
			await act(async () => {
				vi.advanceTimersByTime(5000);
			});

			// Should have called getNextFillerPhrase again for rotation
			expect(getNextFillerPhrase).toHaveBeenCalledTimes(3); // Initial + loading effect + rotation
		});
	});

	describe('mixed content', () => {
		it('renders messages alongside typing indicator when loading', () => {
			const messages = [createMessage({ id: 'msg-1', content: 'User question', role: 'user' })];

			render(
				<WizardConversationView theme={mockTheme} conversationHistory={messages} isLoading={true} />
			);

			expect(screen.getByText('User question')).toBeInTheDocument();
			expect(screen.getByTestId('wizard-typing-indicator')).toBeInTheDocument();
		});

		it('renders messages alongside streaming response', () => {
			const messages = [createMessage({ id: 'msg-1', content: 'User question', role: 'user' })];

			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={messages}
					isLoading={true}
					streamingText="AI is responding..."
				/>
			);

			expect(screen.getByText('User question')).toBeInTheDocument();
			expect(screen.getByText('AI is responding...')).toBeInTheDocument();
		});
	});

	describe('Lets Go button', () => {
		it('shows Lets Go button when ready=true, confidence>=80, not loading, and onLetsGo provided', () => {
			const handleLetsGo = vi.fn();
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[createMessage()]}
					isLoading={false}
					ready={true}
					confidence={80}
					onLetsGo={handleLetsGo}
				/>
			);
			expect(screen.getByTestId('wizard-lets-go-container')).toBeInTheDocument();
			expect(screen.getByTestId('wizard-lets-go-button')).toBeInTheDocument();
			expect(screen.getByText("Let's create your Playbook! 🚀")).toBeInTheDocument();
		});

		it('does not show Lets Go button when ready=false', () => {
			const handleLetsGo = vi.fn();
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[createMessage()]}
					isLoading={false}
					ready={false}
					confidence={80}
					onLetsGo={handleLetsGo}
				/>
			);
			expect(screen.queryByTestId('wizard-lets-go-container')).not.toBeInTheDocument();
		});

		it('does not show Lets Go button when confidence < 80', () => {
			const handleLetsGo = vi.fn();
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[createMessage()]}
					isLoading={false}
					ready={true}
					confidence={79}
					onLetsGo={handleLetsGo}
				/>
			);
			expect(screen.queryByTestId('wizard-lets-go-container')).not.toBeInTheDocument();
		});

		it('does not show Lets Go button when isLoading=true', () => {
			const handleLetsGo = vi.fn();
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[createMessage()]}
					isLoading={true}
					ready={true}
					confidence={80}
					onLetsGo={handleLetsGo}
				/>
			);
			expect(screen.queryByTestId('wizard-lets-go-container')).not.toBeInTheDocument();
		});

		it('does not show Lets Go button when onLetsGo is not provided', () => {
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[createMessage()]}
					isLoading={false}
					ready={true}
					confidence={80}
					// onLetsGo not provided
				/>
			);
			expect(screen.queryByTestId('wizard-lets-go-container')).not.toBeInTheDocument();
		});

		it('calls onLetsGo when button is clicked', () => {
			const handleLetsGo = vi.fn();

			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[createMessage()]}
					isLoading={false}
					ready={true}
					confidence={85}
					onLetsGo={handleLetsGo}
				/>
			);

			const button = screen.getByTestId('wizard-lets-go-button');
			button.click();
			expect(handleLetsGo).toHaveBeenCalledTimes(1);
		});

		it('shows Lets Go button with confidence exactly at threshold (80)', () => {
			const handleLetsGo = vi.fn();
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[createMessage()]}
					isLoading={false}
					ready={true}
					confidence={80}
					onLetsGo={handleLetsGo}
				/>
			);
			expect(screen.getByTestId('wizard-lets-go-button')).toBeInTheDocument();
		});

		it('shows Lets Go button with confidence above threshold', () => {
			const handleLetsGo = vi.fn();
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[createMessage()]}
					isLoading={false}
					ready={true}
					confidence={100}
					onLetsGo={handleLetsGo}
				/>
			);
			expect(screen.getByTestId('wizard-lets-go-button')).toBeInTheDocument();
		});

		it('displays helpful hint text below the button', () => {
			const handleLetsGo = vi.fn();
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[createMessage()]}
					isLoading={false}
					ready={true}
					confidence={80}
					onLetsGo={handleLetsGo}
				/>
			);
			expect(
				screen.getByText('Or continue chatting below to add more details')
			).toBeInTheDocument();
		});

		it('does not show Lets Go button when hasStartedGenerating=true', () => {
			const handleLetsGo = vi.fn();
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[createMessage()]}
					isLoading={false}
					ready={true}
					confidence={85}
					onLetsGo={handleLetsGo}
					hasStartedGenerating={true}
				/>
			);
			expect(screen.queryByTestId('wizard-lets-go-container')).not.toBeInTheDocument();
		});

		it('shows Lets Go button when hasStartedGenerating=false', () => {
			const handleLetsGo = vi.fn();
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[createMessage()]}
					isLoading={false}
					ready={true}
					confidence={85}
					onLetsGo={handleLetsGo}
					hasStartedGenerating={false}
				/>
			);
			expect(screen.getByTestId('wizard-lets-go-container')).toBeInTheDocument();
		});
	});

	describe('edge cases', () => {
		it('handles empty streamingText string correctly', () => {
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[]}
					isLoading={true}
					streamingText=""
				/>
			);

			// Empty string should show typing indicator, not streaming response
			expect(screen.getByTestId('wizard-typing-indicator')).toBeInTheDocument();
			expect(screen.queryByTestId('wizard-streaming-response')).not.toBeInTheDocument();
		});

		it('handles agent name with emoji correctly', () => {
			const messages = [createMessage({ role: 'assistant', content: 'Hello' })];

			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={messages}
					agentName="🦊 Firefox Agent"
				/>
			);

			// Should not add another emoji prefix
			expect(screen.getByText('🦊 Firefox Agent')).toBeInTheDocument();
			expect(screen.queryByText('🤖 🦊 Firefox Agent')).not.toBeInTheDocument();
		});

		it('handles undefined optional props gracefully', () => {
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[createMessage({ role: 'assistant' })]}
					// All optional props undefined
				/>
			);

			expect(screen.getByTestId('wizard-conversation-view')).toBeInTheDocument();
		});
	});

	describe('thinking display', () => {
		it('shows thinking display instead of typing indicator when showThinking=true and thinkingContent provided', () => {
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[]}
					isLoading={true}
					showThinking={true}
					thinkingContent="Analyzing the codebase structure..."
				/>
			);

			expect(screen.getByTestId('wizard-thinking-display')).toBeInTheDocument();
			expect(screen.queryByTestId('wizard-typing-indicator')).not.toBeInTheDocument();
		});

		it('displays the thinking content text', () => {
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[]}
					isLoading={true}
					showThinking={true}
					thinkingContent="Processing files and dependencies..."
				/>
			);

			expect(screen.getByText(/Processing files and dependencies/)).toBeInTheDocument();
		});

		it('shows "thinking" badge in thinking display', () => {
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[]}
					isLoading={true}
					showThinking={true}
					thinkingContent="Some thinking content"
				/>
			);

			expect(screen.getByText('thinking')).toBeInTheDocument();
		});

		it('shows agent name in thinking display', () => {
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[]}
					isLoading={true}
					showThinking={true}
					thinkingContent="Some thinking content"
					agentName="TestAgent"
				/>
			);

			expect(screen.getByText('🤖 TestAgent')).toBeInTheDocument();
		});

		it('shows pulsing cursor in thinking display', () => {
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[]}
					isLoading={true}
					showThinking={true}
					thinkingContent="Thinking..."
				/>
			);

			// The thinking display should have a pulsing cursor (▊)
			const thinkingDisplay = screen.getByTestId('wizard-thinking-display');
			expect(thinkingDisplay.textContent).toContain('▊');
		});

		it('shows "Reasoning..." fallback when thinkingContent is empty', () => {
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[]}
					isLoading={true}
					showThinking={true}
					thinkingContent=""
				/>
			);

			expect(screen.getByText(/Reasoning/)).toBeInTheDocument();
		});

		it('falls back to typing indicator when showThinking=true but not loading', () => {
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[]}
					isLoading={false}
					showThinking={true}
					thinkingContent="Some content"
				/>
			);

			expect(screen.queryByTestId('wizard-thinking-display')).not.toBeInTheDocument();
			expect(screen.queryByTestId('wizard-typing-indicator')).not.toBeInTheDocument();
		});

		it('shows typing indicator when showThinking=false even with thinkingContent', () => {
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[]}
					isLoading={true}
					showThinking={false}
					thinkingContent="This should not appear"
				/>
			);

			expect(screen.queryByTestId('wizard-thinking-display')).not.toBeInTheDocument();
			expect(screen.getByTestId('wizard-typing-indicator')).toBeInTheDocument();
		});

		it('renders thinking display alongside messages', () => {
			const messages = [createMessage({ id: 'msg-1', content: 'User question', role: 'user' })];

			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={messages}
					isLoading={true}
					showThinking={true}
					thinkingContent="Working on it..."
				/>
			);

			expect(screen.getByText('User question')).toBeInTheDocument();
			expect(screen.getByTestId('wizard-thinking-display')).toBeInTheDocument();
		});

		it('prefers streaming response over thinking display when streamingText provided', () => {
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[]}
					isLoading={true}
					showThinking={true}
					thinkingContent="Some thinking"
					streamingText="Actual response text..."
				/>
			);

			expect(screen.getByTestId('wizard-streaming-response')).toBeInTheDocument();
			expect(screen.queryByTestId('wizard-thinking-display')).not.toBeInTheDocument();
		});

		it('renders tool executions with string details', () => {
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[]}
					isLoading={true}
					showThinking={true}
					thinkingContent="Working..."
					toolExecutions={[
						{
							toolName: 'Glob',
							state: { status: 'complete', input: { pattern: '**/*.ts' } },
							timestamp: Date.now(),
						},
					]}
				/>
			);

			expect(screen.getByText('Glob')).toBeInTheDocument();
			expect(screen.getByText('**/*.ts')).toBeInTheDocument();
		});

		it('safely handles tool executions where input properties are objects (not strings)', () => {
			// This test verifies the fix for React error #31 where objects like
			// {type: "glob", enable_fuzzy_matching: true} were being rendered as React children
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[]}
					isLoading={true}
					showThinking={true}
					thinkingContent="Working..."
					toolExecutions={[
						{
							toolName: 'Glob',
							state: {
								status: 'running',
								input: {
									// All properties are objects, not strings - this should not crash
									pattern: { type: 'glob', enable_fuzzy_matching: true },
									command: { nested: 'object' },
									file_path: 123, // number, not string
									query: null,
									path: undefined,
								},
							},
							timestamp: Date.now(),
						},
					]}
				/>
			);

			// Should render without crashing, tool name should appear
			expect(screen.getByText('Glob')).toBeInTheDocument();
			// The detail text should NOT be rendered since none of the properties are strings
			expect(screen.queryByText(/enable_fuzzy_matching/)).not.toBeInTheDocument();
		});

		it('renders tool execution with no input at all', () => {
			render(
				<WizardConversationView
					theme={mockTheme}
					conversationHistory={[]}
					isLoading={true}
					showThinking={true}
					thinkingContent="Working..."
					toolExecutions={[
						{
							toolName: 'Read',
							state: { status: 'complete' }, // no input property
							timestamp: Date.now(),
						},
					]}
				/>
			);

			expect(screen.getByText('Read')).toBeInTheDocument();
		});
	});
});
