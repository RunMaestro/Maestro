import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

	describe('provider choice and recovery', () => {
		type ExitCb = (sid: string, code: number) => void;
		type DataCb = (sid: string, data: string) => void;
		type ErrorCb = (sid: string, error: { type: string; message: string }) => void;
		let exitCb: ExitCb | undefined;
		let dataCb: DataCb | undefined;
		let errorCb: ErrorCb | undefined;

		const agentFor = (id: string) => ({
			id,
			command: id,
			available: true,
			args: [],
			capabilities: {},
		});

		beforeEach(() => {
			exitCb = dataCb = errorCb = undefined;
			window.maestro.feedback.checkGhAuth.mockResolvedValue({ authenticated: true });
			window.maestro.agents.detect.mockResolvedValue([
				{ id: 'claude-code', name: 'Claude Code', available: true },
				{ id: 'codex', name: 'Codex', available: true },
			]);
			window.maestro.agents.get.mockImplementation(async (id: string) => agentFor(id));
			// Earlier tests leave rejecting implementations behind.
			window.maestro.feedback.getConversationPrompt.mockResolvedValue({
				prompt: 'system prompt',
				environment: '- Maestro version: test',
				cwd: '/home/test',
			});
			window.maestro.feedback.searchIssues.mockResolvedValue({ issues: [] });
			Object.assign(window.maestro.process, {
				onData: vi.fn((cb: DataCb) => {
					dataCb = cb;
					return () => {};
				}),
				onExit: vi.fn((cb: ExitCb) => {
					exitCb = cb;
					return () => {};
				}),
				onAgentError: vi.fn((cb: ErrorCb) => {
					errorCb = cb;
					return () => {};
				}),
				onToolExecution: vi.fn(() => () => {}),
				onThinkingChunk: vi.fn(() => () => {}),
			});
		});

		const sendText = async (text: string) => {
			const input = await screen.findByPlaceholderText('Describe your issue or idea...');
			fireEvent.change(input, { target: { value: text } });
			fireEvent.keyDown(input, { key: 'Enter' });
		};
		const lastSpawn = () => {
			const calls = vi.mocked(window.maestro.process.spawn).mock.calls;
			return calls[calls.length - 1][0] as { sessionId: string; toolType: string };
		};

		it('runs the interview on the provider the user agents run', async () => {
			const codexSessions = [
				{ ...sessions[0], id: 'a', toolType: 'codex' },
				{ ...sessions[0], id: 'b', toolType: 'codex' },
			] as Session[];
			render(
				<FeedbackChatView
					theme={theme}
					sessions={codexSessions}
					onCancel={vi.fn()}
					onSubmitSuccess={vi.fn()}
				/>
			);

			await sendText('it broke');
			await waitFor(() => expect(window.maestro.process.spawn).toHaveBeenCalled());
			expect(lastSpawn().toolType).toBe('codex');
		});

		it('names the provider on an auth failure and retries the turn on another one', async () => {
			render(
				<FeedbackChatView
					theme={theme}
					sessions={sessions}
					onCancel={vi.fn()}
					onSubmitSuccess={vi.fn()}
				/>
			);

			await sendText('it broke');
			await waitFor(() => expect(window.maestro.process.spawn).toHaveBeenCalled());
			const first = lastSpawn();
			expect(first.toolType).toBe('claude-code');

			errorCb?.(first.sessionId, { type: 'auth_expired', message: 'OAuth token expired' });
			exitCb?.(first.sessionId, 1);

			expect(await screen.findByText(/Claude Code is not signed in/)).toBeTruthy();
			const switchButton = await screen.findByRole('button', { name: /Switch to Codex/ });
			fireEvent.click(switchButton);

			await waitFor(() => expect(window.maestro.process.spawn).toHaveBeenCalledTimes(2));
			const retry = lastSpawn();
			expect(retry.toolType).toBe('codex');
			expect((retry as { prompt?: string }).prompt).toContain('it broke');
			expect(screen.queryByText(/Claude Code is not signed in/)).toBeNull();
		});

		it('offers a prefilled GitHub issue when filing fails', async () => {
			window.maestro.feedback.submitConversation.mockResolvedValue({
				success: false,
				error: 'Your GitHub CLI login has expired or was revoked.',
				fallbackIssueUrl: 'https://github.com/RunMaestro/Maestro/issues/new?title=x',
			});
			render(
				<FeedbackChatView
					theme={theme}
					sessions={sessions}
					onCancel={vi.fn()}
					onSubmitSuccess={vi.fn()}
				/>
			);

			await sendText('it broke');
			await waitFor(() => expect(window.maestro.process.spawn).toHaveBeenCalled());
			const { sessionId } = lastSpawn();
			dataCb?.(
				sessionId,
				JSON.stringify({
					confidence: 90,
					ready: true,
					message: 'Got it.',
					category: 'bug_report',
					summary: 'Something broke',
					structured: {
						expectedBehavior: 'works',
						actualBehavior: 'broken',
						reproductionSteps: '',
						additionalContext: '',
					},
				})
			);
			exitCb?.(sessionId, 0);

			const [submit] = await screen.findAllByRole('button', { name: /Submit/ });
			fireEvent.click(submit);

			expect(await screen.findByText(/login has expired or was revoked/)).toBeTruthy();
			expect(
				await screen.findByRole('button', { name: /Open prefilled issue on GitHub/ })
			).toBeTruthy();
		});
	});
});
