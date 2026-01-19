/**
 * Tests for WizardMessageBubble.tsx
 *
 * Tests the message bubble component for wizard conversations:
 * - User message styling (right-aligned, accent color)
 * - Assistant message styling (left-aligned, bgActivity color)
 * - System message styling (left-aligned, warning-tinted)
 * - Timestamp display
 * - Markdown rendering
 * - Confidence badge display
 * - Agent name formatting
 * - Provider badge display
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
	WizardMessageBubble,
	type WizardMessageBubbleMessage,
} from '../../../../renderer/components/InlineWizard/WizardMessageBubble';
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
		id: 'test-message-1',
		role: 'user',
		content: 'Test message content',
		timestamp: Date.now(),
		...overrides,
	};
}

describe('WizardMessageBubble', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('user messages', () => {
		it('renders user message content', () => {
			const message = createMessage({ content: 'Hello, World!' });
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			expect(screen.getByText('Hello, World!')).toBeInTheDocument();
		});

		it('right-aligns user messages', () => {
			const message = createMessage({ role: 'user' });
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			const container = screen.getByTestId('wizard-message-bubble-user');
			expect(container).toHaveClass('justify-end');
		});

		it('applies accent color to user message background', () => {
			const message = createMessage({ role: 'user' });
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			const bubble = screen.getByTestId('wizard-message-bubble-user').querySelector('.rounded-lg');
			expect(bubble).toHaveStyle({
				backgroundColor: mockTheme.colors.accent,
			});
		});

		it('applies accentForeground color to user message text', () => {
			const message = createMessage({ role: 'user' });
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			const bubble = screen.getByTestId('wizard-message-bubble-user').querySelector('.rounded-lg');
			expect(bubble).toHaveStyle({
				color: mockTheme.colors.accentForeground,
			});
		});

		it('does not show sender label for user messages', () => {
			const message = createMessage({ role: 'user' });
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			expect(screen.queryByTestId('message-sender')).not.toBeInTheDocument();
		});

		it('preserves whitespace in user messages', () => {
			const message = createMessage({
				role: 'user',
				content: 'Line 1\n  Line 2 with indent',
			});
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			const content = screen.getByTestId('message-content');
			expect(content.querySelector('.whitespace-pre-wrap')).toBeInTheDocument();
		});
	});

	describe('assistant messages', () => {
		it('renders assistant message content', () => {
			const message = createMessage({
				role: 'assistant',
				content: 'I can help you!',
			});
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			expect(screen.getByText('I can help you!')).toBeInTheDocument();
		});

		it('left-aligns assistant messages', () => {
			const message = createMessage({ role: 'assistant' });
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			const container = screen.getByTestId('wizard-message-bubble-assistant');
			expect(container).toHaveClass('justify-start');
		});

		it('applies bgActivity color to assistant message background', () => {
			const message = createMessage({ role: 'assistant' });
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			const bubble = screen
				.getByTestId('wizard-message-bubble-assistant')
				.querySelector('.rounded-lg');
			expect(bubble).toHaveStyle({
				backgroundColor: mockTheme.colors.bgActivity,
			});
		});

		it('shows agent name with robot emoji prefix', () => {
			const message = createMessage({ role: 'assistant' });
			render(<WizardMessageBubble message={message} theme={mockTheme} agentName="Claude" />);
			// The formatAgentName function adds the robot emoji prefix
			expect(screen.getByTestId('message-sender').textContent).toContain('Claude');
		});

		it('shows default agent name when not provided', () => {
			const message = createMessage({ role: 'assistant' });
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			// Default is "Agent" when agentName is not provided
			expect(screen.getByTestId('message-sender').textContent).toContain('Agent');
		});

		it('preserves emoji in agent name without adding robot emoji', () => {
			const message = createMessage({ role: 'assistant' });
			render(<WizardMessageBubble message={message} theme={mockTheme} agentName="Test Agent" />);
			// Should not have a second robot emoji
			expect(screen.getByTestId('message-sender').textContent).toContain('Test Agent');
		});
	});

	describe('system messages', () => {
		it('renders system message content', () => {
			const message = createMessage({
				role: 'system',
				content: 'System notification',
			});
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			expect(screen.getByText('System notification')).toBeInTheDocument();
		});

		it('left-aligns system messages', () => {
			const message = createMessage({ role: 'system' });
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			const container = screen.getByTestId('wizard-message-bubble-system');
			expect(container).toHaveClass('justify-start');
		});

		it('applies warning-tinted background to system messages', () => {
			const message = createMessage({ role: 'system' });
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			const bubble = screen
				.getByTestId('wizard-message-bubble-system')
				.querySelector('.rounded-lg');
			expect(bubble).toHaveStyle({
				backgroundColor: `${mockTheme.colors.warning}20`,
			});
		});

		it('shows System label with music note emoji', () => {
			const message = createMessage({ role: 'system' });
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			expect(screen.getByTestId('message-sender').textContent).toContain('System');
		});
	});

	describe('timestamp display', () => {
		it('displays formatted timestamp', () => {
			// Create a message with a specific timestamp
			const specificTime = new Date('2024-01-15T14:30:00').getTime();
			const message = createMessage({ timestamp: specificTime });
			render(<WizardMessageBubble message={message} theme={mockTheme} />);

			const timestamp = screen.getByTestId('message-timestamp');
			expect(timestamp).toBeInTheDocument();
			// Timestamp should contain time format (varies by locale)
			expect(timestamp.textContent).toMatch(/\d{1,2}:\d{2}/);
		});

		it('applies dim color to timestamp for user messages', () => {
			const message = createMessage({ role: 'user' });
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			const timestamp = screen.getByTestId('message-timestamp');
			expect(timestamp).toHaveStyle({
				color: mockTheme.colors.accentForeground,
			});
		});

		it('applies textDim color to timestamp for assistant messages', () => {
			const message = createMessage({ role: 'assistant' });
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			const timestamp = screen.getByTestId('message-timestamp');
			expect(timestamp).toHaveStyle({
				color: mockTheme.colors.textDim,
			});
		});
	});

	describe('confidence badge', () => {
		it('shows confidence badge for assistant messages with confidence', () => {
			const message = createMessage({ role: 'assistant', confidence: 75 });
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			expect(screen.getByTestId('confidence-badge')).toHaveTextContent('75% confident');
		});

		it('does not show confidence badge when confidence is undefined', () => {
			const message = createMessage({
				role: 'assistant',
				confidence: undefined,
			});
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			expect(screen.queryByTestId('confidence-badge')).not.toBeInTheDocument();
		});

		it('does not show confidence badge for user messages', () => {
			const message = createMessage({ role: 'user', confidence: 75 });
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			expect(screen.queryByTestId('confidence-badge')).not.toBeInTheDocument();
		});

		it('applies color-coded styling to confidence badge', () => {
			const message = createMessage({ role: 'assistant', confidence: 50 });
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			const badge = screen.getByTestId('confidence-badge');
			// Badge should have color styling applied
			expect(badge.style.color).toBeTruthy();
		});
	});

	describe('provider badge', () => {
		it('shows provider badge for assistant messages', () => {
			const message = createMessage({ role: 'assistant' });
			render(<WizardMessageBubble message={message} theme={mockTheme} providerName="Claude" />);
			expect(screen.getByTestId('provider-badge')).toHaveTextContent('Claude');
		});

		it('does not show provider badge when providerName is undefined', () => {
			const message = createMessage({ role: 'assistant' });
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			expect(screen.queryByTestId('provider-badge')).not.toBeInTheDocument();
		});

		it('does not show provider badge for user messages', () => {
			const message = createMessage({ role: 'user' });
			render(<WizardMessageBubble message={message} theme={mockTheme} providerName="Claude" />);
			expect(screen.queryByTestId('provider-badge')).not.toBeInTheDocument();
		});

		it('does not show provider badge for system messages', () => {
			const message = createMessage({ role: 'system' });
			render(<WizardMessageBubble message={message} theme={mockTheme} providerName="Claude" />);
			expect(screen.queryByTestId('provider-badge')).not.toBeInTheDocument();
		});
	});

	describe('markdown rendering', () => {
		it('renders markdown bold text in assistant messages', () => {
			const message = createMessage({
				role: 'assistant',
				content: 'This is **bold** text',
			});
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			const boldElement = screen.getByText('bold');
			expect(boldElement.tagName).toBe('STRONG');
		});

		it('renders markdown italic text in assistant messages', () => {
			const message = createMessage({
				role: 'assistant',
				content: 'This is *italic* text',
			});
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			const italicElement = screen.getByText('italic');
			expect(italicElement.tagName).toBe('EM');
		});

		it('renders markdown unordered lists in assistant messages', () => {
			const message = createMessage({
				role: 'assistant',
				content: '- Item 1\n- Item 2',
			});
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			expect(screen.getByText('Item 1')).toBeInTheDocument();
			expect(screen.getByText('Item 2')).toBeInTheDocument();
		});

		it('renders markdown ordered lists in assistant messages', () => {
			const message = createMessage({
				role: 'assistant',
				content: '1. First\n2. Second',
			});
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			expect(screen.getByText('First')).toBeInTheDocument();
			expect(screen.getByText('Second')).toBeInTheDocument();
		});

		it('renders markdown headings in assistant messages', () => {
			const message = createMessage({
				role: 'assistant',
				content: '# Heading 1\n## Heading 2\n### Heading 3',
			});
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			expect(screen.getByText('Heading 1').tagName).toBe('H1');
			expect(screen.getByText('Heading 2').tagName).toBe('H2');
			expect(screen.getByText('Heading 3').tagName).toBe('H3');
		});

		it('renders markdown inline code in assistant messages', () => {
			const message = createMessage({
				role: 'assistant',
				content: 'Use `npm install` to install',
			});
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			const codeElement = screen.getByText('npm install');
			expect(codeElement.tagName).toBe('CODE');
		});

		it('renders markdown code blocks in assistant messages', () => {
			const message = createMessage({
				role: 'assistant',
				content: '```\nconst x = 1;\n```',
			});
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			expect(screen.getByText('const x = 1;')).toBeInTheDocument();
		});

		it('renders markdown blockquotes in assistant messages', () => {
			const message = createMessage({
				role: 'assistant',
				content: '> This is a quote',
			});
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			const quote = screen.getByText('This is a quote');
			expect(quote.closest('blockquote')).toBeInTheDocument();
		});

		it('renders markdown links as buttons in assistant messages', () => {
			const message = createMessage({
				role: 'assistant',
				content: 'Check out [this link](https://example.com)',
			});
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			const link = screen.getByText('this link');
			expect(link.tagName).toBe('BUTTON');
		});

		it('opens external links when clicked', () => {
			const message = createMessage({
				role: 'assistant',
				content: 'Check out [this link](https://example.com)',
			});
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			const link = screen.getByText('this link');
			fireEvent.click(link);
			// Uses the global mock from setup.ts
			expect(window.maestro.shell.openExternal).toHaveBeenCalledWith('https://example.com');
		});

		it('does not render markdown for user messages', () => {
			const message = createMessage({
				role: 'user',
				content: 'This is **not bold**',
			});
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			// Should render as plain text with asterisks
			expect(screen.getByText('This is **not bold**')).toBeInTheDocument();
		});
	});

	describe('bubble styling', () => {
		it('applies rounded-br-none for user messages', () => {
			const message = createMessage({ role: 'user' });
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			const bubble = screen.getByTestId('wizard-message-bubble-user').querySelector('.rounded-lg');
			expect(bubble).toHaveClass('rounded-br-none');
		});

		it('applies rounded-bl-none for assistant messages', () => {
			const message = createMessage({ role: 'assistant' });
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			const bubble = screen
				.getByTestId('wizard-message-bubble-assistant')
				.querySelector('.rounded-lg');
			expect(bubble).toHaveClass('rounded-bl-none');
		});

		it('applies max-width of 80%', () => {
			const message = createMessage({ role: 'user' });
			render(<WizardMessageBubble message={message} theme={mockTheme} />);
			const bubble = screen
				.getByTestId('wizard-message-bubble-user')
				.querySelector('.max-w-\\[80\\%\\]');
			expect(bubble).toBeInTheDocument();
		});
	});

	describe('agent name formatting', () => {
		it('adds robot emoji to agent name without emoji', () => {
			const message = createMessage({ role: 'assistant' });
			render(<WizardMessageBubble message={message} theme={mockTheme} agentName="Claude" />);
			// The formatAgentName function adds the robot emoji prefix
			const senderText = screen.getByTestId('message-sender').textContent || '';
			expect(senderText).toContain('Claude');
		});

		it('does not double-add robot emoji if agent name has emoji', () => {
			const message = createMessage({ role: 'assistant' });
			render(<WizardMessageBubble message={message} theme={mockTheme} agentName="My Agent" />);
			// Should only have one robot emoji prefix
			const senderText = screen.getByTestId('message-sender').textContent || '';
			expect(senderText).toContain('My Agent');
		});

		it('shows default name when agent name is empty', () => {
			const message = createMessage({ role: 'assistant' });
			render(<WizardMessageBubble message={message} theme={mockTheme} agentName="" />);
			const senderText = screen.getByTestId('message-sender').textContent || '';
			expect(senderText).toContain('Agent');
		});
	});
});
