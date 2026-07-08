import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { FeedbackChatView } from '../../../renderer/components/FeedbackChatView';
import type { Theme, Session } from '../../../renderer/types';

const mockFeedbackManagerState = vi.hoisted(() => ({
	start: vi.fn(),
	sendMessage: vi.fn(),
	cleanup: vi.fn(),
}));

const mockOpenUrl = vi.hoisted(() => vi.fn());
const mockSafeClipboardWrite = vi.hoisted(() => vi.fn());
const mockCaptureException = vi.hoisted(() => vi.fn());

vi.mock('../../../renderer/services/feedbackConversation', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../../renderer/services/feedbackConversation')>();
	return {
		...actual,
		FeedbackConversationManager: vi.fn(function FeedbackConversationManager() {
			return mockFeedbackManagerState;
		}),
		getConfidenceColor: vi.fn((confidence: number) => `confidence-${confidence}`),
	};
});

vi.mock('../../../renderer/utils/openUrl', () => ({
	openUrl: mockOpenUrl,
}));

vi.mock('../../../renderer/utils/clipboard', () => ({
	safeClipboardWrite: mockSafeClipboardWrite,
}));

vi.mock('../../../renderer/utils/sentry', () => ({
	captureException: mockCaptureException,
}));

vi.mock('../../../renderer/components/MarkdownRenderer', () => ({
	MarkdownRenderer: ({ content, onCopy }: { content: string; onCopy?: (text: string) => void }) => (
		<div>
			<span>{content}</span>
			<button type="button" onClick={() => onCopy?.(content)}>
				Copy assistant
			</button>
		</div>
	),
}));

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

const readyResponse = {
	confidence: 87,
	ready: true,
	message: 'Thanks, I have enough detail.',
	category: 'bug_report' as const,
	summary: 'Terminal output freezes',
	structured: {
		expectedBehavior: 'Terminal output should continue streaming',
		actualBehavior: 'Terminal output freezes',
		reproductionSteps: 'Open terminal and run a long command',
		additionalContext: 'Started after the latest update',
	},
};

async function renderStartedChat(overrides: Partial<ComponentProps<typeof FeedbackChatView>> = {}) {
	window.maestro.feedback.checkGhAuth.mockResolvedValue({ authenticated: true });
	window.maestro.agents.detect.mockResolvedValue([
		{ id: 'claude-code', name: 'Claude Code', available: true },
	]);
	window.maestro.feedback.getConversationPrompt.mockResolvedValue({
		prompt: 'system prompt',
		environment: '- Maestro version: 1.0.0',
	});

	const view = render(
		<FeedbackChatView
			theme={theme}
			sessions={sessions}
			onCancel={vi.fn()}
			onSubmitSuccess={vi.fn()}
			{...overrides}
		/>
	);

	const textbox = await screen.findByPlaceholderText('Describe your issue or idea...');
	return { ...view, textbox };
}

async function sendReadyMessage(textbox: HTMLElement) {
	mockFeedbackManagerState.sendMessage.mockImplementation(async (_text, _history, callbacks) => {
		callbacks?.onComplete?.(readyResponse);
		return readyResponse;
	});

	fireEvent.change(textbox, { target: { value: 'Terminal freezes after a long command' } });
	fireEvent.click(screen.getByTitle('Send message'));

	await screen.findByText('Thanks, I have enough detail.');
}

describe('FeedbackChatView', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockFeedbackManagerState.start.mockReturnValue('feedback-session');
		mockFeedbackManagerState.sendMessage.mockResolvedValue(readyResponse);
		mockSafeClipboardWrite.mockResolvedValue(true);
		window.maestro.feedback.searchIssues.mockResolvedValue({ issues: [] });
		window.maestro.feedback.submitConversation.mockResolvedValue({
			success: true,
			issueUrl: 'https://github.com/RunMaestro/Maestro/issues/123',
		});
		window.maestro.feedback.subscribeIssue.mockResolvedValue({ success: true });
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
		window.maestro.agents.detect.mockReturnValue(new Promise(() => {}));

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

	it('shows a distinct error screen when agent detection itself throws', async () => {
		window.maestro.feedback.checkGhAuth.mockResolvedValue({ authenticated: true });
		window.maestro.agents.detect.mockRejectedValue(new Error('IPC channel closed'));

		render(
			<FeedbackChatView
				theme={theme}
				sessions={sessions}
				onCancel={vi.fn()}
				onSubmitSuccess={vi.fn()}
			/>
		);

		// Detection failure should NOT be misclassified as "no providers".
		await waitFor(() => {
			expect(screen.getByText('Could not detect AI providers')).toBeTruthy();
		});
		expect(screen.queryByText('No supported AI providers detected')).toBeNull();

		// The error message bubbles up to the screen so the user can see what broke.
		expect(screen.getByText('IPC channel closed')).toBeTruthy();

		// Chat must not have been started.
		expect(window.maestro.feedback.getConversationPrompt).not.toHaveBeenCalled();
	});

	it('lets the user dismiss the boot screen if conversation start fails', async () => {
		const onCancel = vi.fn();
		window.maestro.feedback.checkGhAuth.mockResolvedValue({ authenticated: true });
		window.maestro.agents.detect.mockResolvedValue([
			{ id: 'claude-code', name: 'Claude Code', available: true },
		]);
		window.maestro.feedback.getConversationPrompt.mockRejectedValue(
			new Error('Prompt fetch failed')
		);

		render(
			<FeedbackChatView
				theme={theme}
				sessions={sessions}
				onCancel={onCancel}
				onSubmitSuccess={vi.fn()}
			/>
		);

		// Error message + Close button should appear so the user isn't stuck.
		await waitFor(() => {
			expect(screen.getByText('Prompt fetch failed')).toBeTruthy();
		});
		const closeButton = screen.getByText('Close');
		expect(closeButton).toBeTruthy();
		closeButton.click();
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it('sends user messages, renders the assistant response, and supports markdown copy actions', async () => {
		window.maestro.feedback.searchIssues.mockResolvedValue({ issues: [] });
		const { textbox } = await renderStartedChat();

		await sendReadyMessage(textbox);

		expect(mockFeedbackManagerState.sendMessage).toHaveBeenCalledWith(
			'Terminal freezes after a long command',
			expect.arrayContaining([
				expect.objectContaining({
					role: 'user',
					content: 'Terminal freezes after a long command',
				}),
			]),
			expect.objectContaining({ onComplete: expect.any(Function) })
		);
		expect(screen.getByText('Terminal freezes after a long command')).toBeTruthy();

		fireEvent.click(screen.getByText('Copy assistant'));
		expect(mockSafeClipboardWrite).toHaveBeenCalledWith('Thanks, I have enough detail.');
	});

	it('shows similar issues and subscribes with structured context from the conversation', async () => {
		window.maestro.feedback.searchIssues.mockResolvedValue({
			issues: [
				{
					number: 42,
					title: 'Terminal output freezes',
					url: 'https://github.com/RunMaestro/Maestro/issues/42',
					state: 'OPEN',
					labels: ['bug'],
					createdAt: '2026-06-01T00:00:00Z',
					author: 'octocat',
					commentCount: 3,
				},
			],
		});
		const { textbox } = await renderStartedChat();

		await sendReadyMessage(textbox);
		await screen.findByText('Similar existing issues found — does any of these match?');

		fireEvent.click(screen.getByTitle('View on GitHub'));
		expect(mockOpenUrl).toHaveBeenCalledWith('https://github.com/RunMaestro/Maestro/issues/42');

		fireEvent.click(screen.getByTitle('Submit feedback as GitHub issue'));
		await screen.findByText('We found similar issues');
		fireEvent.click(screen.getByTitle('Subscribe and add your feedback as a comment'));

		await waitFor(() => {
			expect(window.maestro.feedback.subscribeIssue).toHaveBeenCalledWith(
				42,
				expect.stringContaining('Terminal output should continue streaming')
			);
		});
		await screen.findByText('Feedback Submitted');
		expect(screen.getByText('Your feedback has been recorded. Thank you!')).toBeTruthy();
	});

	it('submits a new issue with image attachments and support package opt-in when no match exists', async () => {
		window.maestro.feedback.searchIssues.mockResolvedValue({ issues: [] });
		const { container, textbox } = await renderStartedChat();

		const fileInput = container.querySelector('input[type="file"]') as HTMLInputElement;
		const screenshot = new File(['image-bytes'], 'freeze.png', { type: 'image/png' });
		fireEvent.change(fileInput, { target: { files: [screenshot] } });

		await waitFor(() => {
			expect(container.querySelector('img[alt="freeze.png"]')).toBeTruthy();
		});

		fireEvent.click(screen.getByLabelText('Include support package'));
		await sendReadyMessage(textbox);
		fireEvent.click(screen.getByTitle('Submit feedback as GitHub issue'));

		await waitFor(() => {
			expect(window.maestro.feedback.submitConversation).toHaveBeenCalledWith(
				expect.objectContaining({
					category: 'bug_report',
					summary: 'Terminal output freezes',
					expectedBehavior: 'Terminal output should continue streaming',
					actualBehavior: 'Terminal output freezes',
					reproductionSteps: 'Open terminal and run a long command',
					additionalContext: 'Started after the latest update',
					includeDebugPackage: true,
					attachments: [expect.objectContaining({ name: 'freeze.png' })],
				})
			);
		});

		await screen.findByText('Issue #123 has been created. Thank you!');
	});

	it('lets users copy or open the created issue URL from the done state', async () => {
		window.maestro.feedback.searchIssues.mockResolvedValue({ issues: [] });
		const onCancel = vi.fn();
		const { textbox } = await renderStartedChat({ onCancel });

		await sendReadyMessage(textbox);
		fireEvent.click(screen.getByTitle('Submit feedback as GitHub issue'));
		await screen.findByText('Issue #123 has been created. Thank you!');

		fireEvent.click(screen.getByTitle('Copy issue URL'));
		await waitFor(() => {
			expect(mockSafeClipboardWrite).toHaveBeenCalledWith(
				'https://github.com/RunMaestro/Maestro/issues/123'
			);
		});

		fireEvent.click(screen.getByTitle('Open in browser'));
		expect(mockOpenUrl).toHaveBeenCalledWith('https://github.com/RunMaestro/Maestro/issues/123');
		expect(onCancel).toHaveBeenCalledOnce();
	});

	it('surfaces failed issue creation and returns to chat for correction', async () => {
		window.maestro.feedback.searchIssues.mockResolvedValue({ issues: [] });
		window.maestro.feedback.submitConversation.mockResolvedValue({
			success: false,
			error: 'GitHub rejected the issue',
		});
		const { textbox } = await renderStartedChat();

		await sendReadyMessage(textbox);
		fireEvent.click(screen.getByTitle('Submit feedback as GitHub issue'));

		await screen.findByText('GitHub rejected the issue');
		expect(screen.getByPlaceholderText('Add more details, or click Submit...')).toBeTruthy();
	});
});
