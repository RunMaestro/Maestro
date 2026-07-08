import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GroupChatPanel } from '../../../web/mobile/GroupChatPanel';
import type { GroupChatMessage, GroupChatState } from '../../../web/hooks/useWebSocket';

const mockColors = {
	bgMain: '#0b0b0d',
	bgSidebar: '#111113',
	bgActivity: '#1c1c1f',
	border: '#27272a',
	textMain: '#e4e4e7',
	textDim: '#a1a1aa',
	accent: '#6366f1',
	accentDim: 'rgba(99, 102, 241, 0.2)',
	accentText: '#a5b4fc',
	success: '#22c55e',
	warning: '#eab308',
	error: '#ef4444',
};

vi.mock('../../../web/components/ThemeProvider', () => ({
	useThemeColors: () => mockColors,
}));

vi.mock('../../../web/mobile/MobileMarkdownRenderer', () => ({
	MobileMarkdownRenderer: ({ content }: { content: string }) => (
		<div data-testid="markdown-renderer">{content}</div>
	),
}));

vi.mock('lucide-react', () => ({
	ArrowLeft: () => <span data-testid="back-icon">ArrowLeft</span>,
	Square: () => <span data-testid="stop-icon">Square</span>,
	Send: () => <span data-testid="send-icon">Send</span>,
}));

function makeMessage(overrides: Partial<GroupChatMessage> = {}): GroupChatMessage {
	return {
		id: 'message-1',
		participantId: 'session-1',
		participantName: 'Alice',
		content: 'Hello from Alice',
		timestamp: Date.now(),
		role: 'user',
		...overrides,
	};
}

function makeChatState(overrides: Partial<GroupChatState> = {}): GroupChatState {
	return {
		id: 'chat-1',
		topic: 'Plan launch',
		participants: [
			{ sessionId: 'session-1', name: 'Alice', toolType: 'codex' },
			{ sessionId: 'session-2', name: 'Bob', toolType: 'claude-code' },
		],
		messages: [],
		isActive: true,
		currentTurn: undefined,
		...overrides,
	};
}

describe('GroupChatPanel', () => {
	beforeEach(() => {
		Element.prototype.scrollIntoView = vi.fn();
		vi.spyOn(Date, 'now').mockReturnValue(new Date('2026-06-18T16:00:00.000Z').getTime());
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.clearAllMocks();
	});

	it('renders active chat controls, messages, current turn, and sends trimmed input', () => {
		const onSendMessage = vi.fn();
		const onStop = vi.fn();
		const onBack = vi.fn();

		render(
			<GroupChatPanel
				chatState={makeChatState({
					currentTurn: 'session-2',
					messages: [
						makeMessage({ id: 'message-1', role: 'user', content: 'User note' }),
						makeMessage({
							id: 'message-2',
							participantId: 'session-2',
							participantName: 'Bob',
							role: 'assistant',
							content: '**Assistant** response',
						}),
					],
				})}
				onSendMessage={onSendMessage}
				onStop={onStop}
				onBack={onBack}
			/>
		);

		expect(screen.getByText('Plan launch')).toBeInTheDocument();
		expect(screen.getByText('2 participants')).toBeInTheDocument();
		expect(screen.getAllByText('Alice').length).toBeGreaterThan(0);
		expect(screen.getAllByText('Bob').length).toBeGreaterThan(0);
		expect(screen.getByText('Bob is thinking...')).toBeInTheDocument();
		expect(screen.getByText('User note')).toBeInTheDocument();
		expect(screen.getByText('**Assistant** response')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Back' }));
		expect(onBack).toHaveBeenCalledTimes(1);
		fireEvent.click(screen.getByRole('button', { name: 'Stop chat' }));
		expect(onStop).toHaveBeenCalledTimes(1);

		const input = screen.getByPlaceholderText('Send a message to the group...');
		const sendButton = screen.getByRole('button', { name: 'Send message' });
		expect(sendButton).toBeDisabled();

		fireEvent.change(input, { target: { value: '  hello group  ' } });
		expect(sendButton).not.toBeDisabled();
		fireEvent.keyDown(input, { key: 'Enter' });

		expect(onSendMessage).toHaveBeenCalledWith('hello group');
		expect(input).toHaveValue('');
	});

	it('keeps shift-enter and blank messages from sending', () => {
		const onSendMessage = vi.fn();

		render(
			<GroupChatPanel
				chatState={makeChatState()}
				onSendMessage={onSendMessage}
				onStop={vi.fn()}
				onBack={vi.fn()}
			/>
		);

		const input = screen.getByPlaceholderText('Send a message to the group...');
		fireEvent.change(input, { target: { value: 'draft' } });
		fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
		expect(onSendMessage).not.toHaveBeenCalled();

		fireEvent.change(input, { target: { value: '   ' } });
		fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
		expect(onSendMessage).not.toHaveBeenCalled();
	});

	it('renders empty and inactive chat states without sending', () => {
		const onSendMessage = vi.fn();

		render(
			<GroupChatPanel
				chatState={makeChatState({ isActive: false })}
				onSendMessage={onSendMessage}
				onStop={vi.fn()}
				onBack={vi.fn()}
			/>
		);

		expect(screen.getByText('Chat ended')).toBeInTheDocument();
		expect(screen.getByText('No messages yet. Start the conversation!')).toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Stop chat' })).not.toBeInTheDocument();

		const input = screen.getByPlaceholderText('Send a message to the group...');
		const sendButton = screen.getByRole('button', { name: 'Send message' });
		expect(input).toBeDisabled();
		expect(sendButton).toBeDisabled();

		fireEvent.click(sendButton);
		expect(onSendMessage).not.toHaveBeenCalled();
	});
});
