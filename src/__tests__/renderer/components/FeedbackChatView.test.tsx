import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { FeedbackChatView } from '../../../renderer/components/FeedbackChatView';
import type { Theme, Session } from '../../../renderer/types';

const theme: Theme = {
	id: 'test-dark',
	name: 'Test Dark',
	mode: 'dark',
	colors: {
		bgMain: '#101322',
		bgSidebar: '#14192d',
		bgActivity: '#1b2140',
		textMain: '#f5f7ff',
		textDim: '#8d96b8',
		accent: '#8b5cf6',
		accentForeground: '#ffffff',
		border: '#2a3154',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
} as Theme;

const sessions = [
	{
		id: 'session-1',
		name: 'Agent 1',
		toolType: 'claude-code',
		state: 'idle',
		cwd: '/tmp',
	} as Session,
];

describe('FeedbackChatView', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('shows GH CLI error when gh is not available', async () => {
		window.maestro.feedback.checkGhAuth.mockResolvedValue({
			authenticated: false,
			message: 'GitHub CLI (gh) is not installed.',
		});

		render(
			<FeedbackChatView
				theme={theme}
				sessions={sessions}
				onCancel={vi.fn()}
				onSubmitSuccess={vi.fn()}
			/>
		);

		await waitFor(() => {
			expect(screen.getByText('GitHub CLI Required')).toBeTruthy();
		});
	});

	it('auto-starts chat when gh is authenticated and a supported agent is detected', async () => {
		window.maestro.feedback.checkGhAuth.mockResolvedValue({ authenticated: true });
		window.maestro.agents.detect.mockResolvedValue([
			{ id: 'claude-code', name: 'Claude Code', available: true },
		]);
		window.maestro.feedback.getConversationPrompt.mockResolvedValue({
			prompt: 'system prompt',
			environment: '- Maestro version: 1.0.0',
		});

		render(
			<FeedbackChatView
				theme={theme}
				sessions={sessions}
				onCancel={vi.fn()}
				onSubmitSuccess={vi.fn()}
			/>
		);

		// Skips the old provider-select screen and lands directly in chat.
		await waitFor(() => {
			expect(screen.getByPlaceholderText('Describe your issue or idea...')).toBeTruthy();
		});

		// The provider-select dropdown / Start button should be gone for good.
		expect(screen.queryByText('Start')).toBeNull();
		expect(screen.queryByText('AI Provider')).toBeNull();

		// The conversation prompt was fetched (chat actually started).
		expect(window.maestro.feedback.getConversationPrompt).toHaveBeenCalled();
	});

	it('shows loading spinner during GH auth check', () => {
		window.maestro.feedback.checkGhAuth.mockReturnValue(new Promise(() => {})); // Never resolves

		render(
			<FeedbackChatView
				theme={theme}
				sessions={sessions}
				onCancel={vi.fn()}
				onSubmitSuccess={vi.fn()}
			/>
		);

		expect(screen.getByText('Checking GitHub CLI...')).toBeTruthy();
	});

	it('shows the no-providers screen when gh is authenticated but no supported agents are detected', async () => {
		window.maestro.feedback.checkGhAuth.mockResolvedValue({ authenticated: true });
		window.maestro.agents.detect.mockResolvedValue([]);

		render(
			<FeedbackChatView
				theme={theme}
				sessions={sessions}
				onCancel={vi.fn()}
				onSubmitSuccess={vi.fn()}
			/>
		);

		await waitFor(() => {
			expect(screen.getByText('No supported AI providers detected')).toBeTruthy();
		});

		// The chat should not have been started.
		expect(window.maestro.feedback.getConversationPrompt).not.toHaveBeenCalled();
	});

	it('calls onCancel when Close button is clicked on GH error', async () => {
		const onCancel = vi.fn();
		window.maestro.feedback.checkGhAuth.mockResolvedValue({
			authenticated: false,
			message: 'Not installed.',
		});

		render(
			<FeedbackChatView
				theme={theme}
				sessions={sessions}
				onCancel={onCancel}
				onSubmitSuccess={vi.fn()}
			/>
		);

		await waitFor(() => {
			screen.getByText('Close').click();
		});

		expect(onCancel).toHaveBeenCalledOnce();
	});
});
