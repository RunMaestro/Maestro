import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FeedbackChatView } from '../../../renderer/components/FeedbackChatView';
import {
	useFeedbackDraftStore,
	type FeedbackDraft,
} from '../../../renderer/stores/feedbackDraftStore';
import type { Theme, Session } from '../../../renderer/types';
import { FeedbackConversationManager } from '../../../renderer/services/feedbackConversation';
import type { FeedbackAccount } from '../../../shared/feedbackAccounts';

// The real login dialog spawns a PTY; here it is a stub that signs in on click.
vi.mock('../../../renderer/components/GitHubLoginModal', () => ({
	GitHubLoginModal: (props: { reason?: string; onSignedIn: () => void }) => (
		<div data-testid="gh-login-modal-stub" data-reason={props.reason ?? ''}>
			<button type="button" onClick={props.onSignedIn}>
				stub-signed-in
			</button>
		</div>
	),
}));

function account(overrides: Partial<FeedbackAccount> & { key: string }): FeedbackAccount {
	return {
		toolType: 'claude-code',
		label: overrides.key,
		env: {},
		sshRemoteId: null,
		agentNames: [],
		source: 'agent',
		status: 'ready',
		...overrides,
	};
}

const WORK = account({
	key: 'claude-code::/home/me/.claude-work',
	label: 'Claude Code - work',
	env: { CLAUDE_CONFIG_DIR: '/home/me/.claude-work' },
	agentNames: ['Agent 1'],
});
const DEFAULT = account({
	key: 'claude-code::/home/me/.claude',
	label: 'Claude Code (default)',
	source: 'provider-default',
	status: 'not-logged-in',
});

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

	it('auto-starts chat as the first usable account when gh is authenticated', async () => {
		window.maestro.feedback.checkGhAuth.mockResolvedValue({ authenticated: true });
		window.maestro.feedback.listAccounts.mockResolvedValue({
			accounts: [WORK, DEFAULT],
			lastWorkingKey: null,
		});
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

		// The picker names the account it chose, so the user can override it.
		const picker = screen.getByTestId('feedback-account-picker') as HTMLSelectElement;
		expect(picker.value).toBe(WORK.key);
	});

	it('falls through to the next account when the first turn fails, and remembers the one that worked', async () => {
		const OTHER = account({
			key: 'claude-code::/home/me/.claude-home',
			label: 'Claude Code - home',
			env: { CLAUDE_CONFIG_DIR: '/home/me/.claude-home' },
		});
		window.maestro.feedback.checkGhAuth.mockResolvedValue({ authenticated: true });
		window.maestro.feedback.listAccounts.mockResolvedValue({
			accounts: [WORK, OTHER],
			lastWorkingKey: null,
		});
		window.maestro.agents.get.mockResolvedValue({
			id: 'claude-code',
			available: true,
			command: 'claude',
			args: [],
		});

		let onExit: ((sid: string, code: number) => void) | undefined;
		let onData: ((sid: string, data: string) => void) | undefined;
		window.maestro.process.onExit.mockImplementation((cb: typeof onExit) => {
			onExit = cb;
			return () => {};
		});
		// The shared setup mock has no onData; give this test its own.
		(window.maestro.process as unknown as { onData: unknown }).onData = vi.fn(
			(cb: typeof onData) => {
				onData = cb;
				return () => {};
			}
		);
		const spawned: Array<{ sessionId: string; sessionCustomEnvVars?: Record<string, string> }> = [];
		window.maestro.process.spawn.mockImplementation(
			(config: { sessionId: string; sessionCustomEnvVars?: Record<string, string> }) => {
				spawned.push(config);
				const attempt = spawned.length;
				queueMicrotask(() => {
					if (attempt === 1) {
						onExit?.(config.sessionId, 1);
					} else {
						onData?.(config.sessionId, JSON.stringify({ confidence: 50, message: 'Tell me more' }));
						onExit?.(config.sessionId, 0);
					}
				});
				return Promise.resolve({ pid: 1, success: true });
			}
		);

		render(
			<FeedbackChatView
				theme={theme}
				sessions={sessions}
				onCancel={vi.fn()}
				onSubmitSuccess={vi.fn()}
			/>
		);

		const input = await screen.findByPlaceholderText('Describe your issue or idea...');
		fireEvent.change(input, { target: { value: 'The player gets stuck' } });
		await act(async () => {
			fireEvent.keyDown(input, { key: 'Enter' });
		});

		await screen.findByText('Tell me more');
		expect(spawned.map((c) => c.sessionCustomEnvVars)).toEqual([WORK.env, OTHER.env]);
		expect(window.maestro.feedback.rememberAccount).toHaveBeenCalledWith(OTHER.key);
		expect((screen.getByTestId('feedback-account-picker') as HTMLSelectElement).value).toBe(
			OTHER.key
		);
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
		window.maestro.feedback.listAccounts.mockResolvedValue({
			accounts: [account({ key: 'codex::/home/me/.codex', status: 'not-installed' })],
			lastWorkingKey: null,
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
			expect(screen.getByText('No supported AI providers detected')).toBeTruthy();
		});

		// The chat should not have been started.
		expect(window.maestro.feedback.getConversationPrompt).not.toHaveBeenCalled();
	});

	it('offers an embedded GitHub login when gh is not signed in, then continues into the chat', async () => {
		window.maestro.feedback.checkGhAuth.mockResolvedValue({
			authenticated: false,
			reason: 'not-authenticated',
			message: 'GitHub CLI (gh) is not signed in to GitHub, so feedback cannot be filed.',
		});
		window.maestro.feedback.listAccounts.mockResolvedValue({
			accounts: [WORK],
			lastWorkingKey: null,
		});

		render(
			<FeedbackChatView
				theme={theme}
				sessions={sessions}
				onCancel={vi.fn()}
				onSubmitSuccess={vi.fn()}
			/>
		);

		fireEvent.click(await screen.findByTestId('feedback-gh-login'));
		fireEvent.click(await screen.findByText('stub-signed-in'));

		expect(await screen.findByPlaceholderText('Describe your issue or idea...')).toBeTruthy();
		expect(screen.queryByTestId('gh-login-modal-stub')).toBeNull();
	});

	it('links to the install page instead of a login when gh is not installed', async () => {
		window.maestro.feedback.checkGhAuth.mockResolvedValue({
			authenticated: false,
			reason: 'not-installed',
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

		expect(await screen.findByTestId('feedback-gh-install')).toBeTruthy();
		expect(screen.queryByTestId('feedback-gh-login')).toBeNull();
	});

	// gh is signed in, but GitHub refused this account an issue on the repo. The
	// screen says so up front and names the account, instead of letting the user
	// write a report that fails at submit.
	it('names a refused account and offers the login only when it can fix the refusal', async () => {
		window.maestro.feedback.checkGhAuth.mockResolvedValue({
			authenticated: false,
			reason: 'no-repo-access',
			needsGhLogin: true,
			message: 'GitHub refused the request because an organization restricts third-party apps.',
			account: { host: 'github.com', login: 'octocat' },
		});

		const { unmount } = render(
			<FeedbackChatView
				theme={theme}
				sessions={sessions}
				onCancel={vi.fn()}
				onSubmitSuccess={vi.fn()}
			/>
		);

		expect(await screen.findByText('GitHub Refused This Account')).toBeTruthy();
		expect(screen.getByTestId('feedback-gh-account').textContent).toContain('octocat @ github.com');
		expect(screen.getByTestId('feedback-gh-login')).toBeTruthy();
		unmount();

		window.maestro.feedback.checkGhAuth.mockResolvedValue({
			authenticated: false,
			reason: 'no-repo-access',
			needsGhLogin: false,
			message: 'GitHub refused this account an issue on RunMaestro/Maestro.',
		});
		render(
			<FeedbackChatView
				theme={theme}
				sessions={sessions}
				onCancel={vi.fn()}
				onSubmitSuccess={vi.fn()}
			/>
		);

		expect(await screen.findByText('GitHub Refused This Account')).toBeTruthy();
		expect(screen.queryByTestId('feedback-gh-login')).toBeNull();
		expect(screen.getByTestId('feedback-gh-recheck')).toBeTruthy();
	});

	it('Check Again re-asks gh past the cache', async () => {
		window.maestro.feedback.checkGhAuth
			.mockResolvedValueOnce({ authenticated: false, reason: 'not-authenticated' })
			.mockResolvedValueOnce({ authenticated: true });
		window.maestro.feedback.listAccounts.mockResolvedValue({
			accounts: [WORK],
			lastWorkingKey: null,
		});

		render(
			<FeedbackChatView
				theme={theme}
				sessions={sessions}
				onCancel={vi.fn()}
				onSubmitSuccess={vi.fn()}
			/>
		);

		fireEvent.click(await screen.findByTestId('feedback-gh-recheck'));
		expect(await screen.findByPlaceholderText('Describe your issue or idea...')).toBeTruthy();
		expect(window.maestro.feedback.checkGhAuth).toHaveBeenLastCalledWith({ fresh: true });
	});

	it('offers the GitHub login when gh refuses the submit, then files again once signed in', async () => {
		window.maestro.feedback.checkGhAuth.mockResolvedValue({ authenticated: true });
		window.maestro.feedback.listAccounts.mockResolvedValue({
			accounts: [WORK],
			lastWorkingKey: null,
		});
		window.maestro.feedback.searchIssues.mockResolvedValue({ issues: [] });
		window.maestro.feedback.submitConversation
			.mockResolvedValueOnce({
				success: false,
				error: 'Your GitHub CLI login has expired or was revoked.',
				needsGhLogin: true,
			})
			.mockResolvedValueOnce({ success: true, issueUrl: 'https://github.com/x/y/issues/7' });
		window.maestro.agents.get.mockResolvedValue({
			id: 'claude-code',
			available: true,
			command: 'claude',
			args: [],
		});
		let onExit: ((sid: string, code: number) => void) | undefined;
		let onData: ((sid: string, data: string) => void) | undefined;
		window.maestro.process.onExit.mockImplementation((cb: typeof onExit) => {
			onExit = cb;
			return () => {};
		});
		(window.maestro.process as unknown as { onData: unknown }).onData = vi.fn(
			(cb: typeof onData) => {
				onData = cb;
				return () => {};
			}
		);
		window.maestro.process.spawn.mockImplementation((config: { sessionId: string }) => {
			queueMicrotask(() => {
				onData?.(
					config.sessionId,
					JSON.stringify({
						confidence: 95,
						ready: true,
						message: 'Got it',
						category: 'bug_report',
						summary: 'Player stuck under title bar',
						structured: { expectedBehavior: 'moves', actualBehavior: 'stuck' },
					})
				);
				onExit?.(config.sessionId, 0);
			});
			return Promise.resolve({ pid: 1, success: true });
		});

		render(
			<FeedbackChatView
				theme={theme}
				sessions={sessions}
				onCancel={vi.fn()}
				onSubmitSuccess={vi.fn()}
			/>
		);
		const input = await screen.findByPlaceholderText('Describe your issue or idea...');
		fireEvent.change(input, { target: { value: 'The player gets stuck' } });
		await act(async () => {
			fireEvent.keyDown(input, { key: 'Enter' });
		});
		fireEvent.click(await screen.findByText('Submit Feedback'));

		fireEvent.click(await screen.findByTestId('feedback-gh-login-retry'));
		expect(screen.getByTestId('gh-login-modal-stub').getAttribute('data-reason')).toContain(
			'expired'
		);
		fireEvent.click(screen.getByText('stub-signed-in'));

		expect(await screen.findByText('Feedback Submitted')).toBeTruthy();
		expect(window.maestro.feedback.submitConversation).toHaveBeenCalledTimes(2);
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

	it('shows a distinct error screen when account discovery itself throws', async () => {
		window.maestro.feedback.checkGhAuth.mockResolvedValue({ authenticated: true });
		window.maestro.feedback.listAccounts.mockRejectedValue(new Error('IPC channel closed'));

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
		window.maestro.feedback.listAccounts.mockResolvedValue({
			accounts: [WORK, DEFAULT],
			lastWorkingKey: null,
		});
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

	it('hydrates the chat from a resumed draft (messages + attachments)', async () => {
		const draft: FeedbackDraft = {
			id: 'draft-1',
			suggestedName: 'Crash on save',
			category: 'bug_report',
			summary: 'Crash on save',
			confidence: 60,
			agentType: 'claude-code',
			messages: [{ role: 'user', content: 'Steps to reproduce the crash', timestamp: 1000 }],
			attachments: [
				{ id: 'a1', name: 'crash.png', dataUrl: 'data:image/png;base64,abc123', sizeBytes: 10 },
			],
			inputDraft: 'one more thing',
			includeDebugPackage: false,
			createdAt: 1000,
			updatedAt: 1000,
		};
		useFeedbackDraftStore.setState({ drafts: [draft], activeDraftId: null, resumeDraftId: null });

		window.maestro.feedback.checkGhAuth.mockResolvedValue({ authenticated: true });
		window.maestro.feedback.listAccounts.mockResolvedValue({
			accounts: [WORK, DEFAULT],
			lastWorkingKey: null,
		});
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
				resumeDraftId="draft-1"
			/>
		);

		await waitFor(() => {
			expect(screen.getByText('Steps to reproduce the crash')).toBeTruthy();
		});
		expect(screen.getByAltText('crash.png')).toBeTruthy();
	});

	it('saves the current conversation as a draft when Save draft is clicked', async () => {
		const draft: FeedbackDraft = {
			id: 'draft-1',
			suggestedName: 'Crash on save',
			category: 'bug_report',
			summary: 'Crash on save',
			confidence: 60,
			agentType: 'claude-code',
			messages: [{ role: 'user', content: 'Steps to reproduce the crash', timestamp: 1000 }],
			attachments: [
				{ id: 'a1', name: 'crash.png', dataUrl: 'data:image/png;base64,abc123', sizeBytes: 10 },
			],
			inputDraft: '',
			includeDebugPackage: false,
			createdAt: 1000,
			updatedAt: 1000,
		};
		useFeedbackDraftStore.setState({ drafts: [draft], activeDraftId: null, resumeDraftId: null });

		window.maestro.feedback.checkGhAuth.mockResolvedValue({ authenticated: true });
		window.maestro.feedback.listAccounts.mockResolvedValue({
			accounts: [WORK, DEFAULT],
			lastWorkingKey: null,
		});
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
				resumeDraftId="draft-1"
			/>
		);

		const saveButton = await screen.findByText('Save draft');
		saveButton.click();

		await waitFor(() => {
			expect(window.maestro.feedback.drafts.save).toHaveBeenCalled();
		});
		const payload = window.maestro.feedback.drafts.save.mock.calls[0][0];
		expect(payload.messages[0].content).toBe('Steps to reproduce the crash');
		expect(payload.attachments[0].name).toBe('crash.png');
	});

	it('falls back to an available provider when the resumed draft provider is gone', async () => {
		const draft: FeedbackDraft = {
			id: 'draft-codex',
			suggestedName: 'Codex draft',
			category: 'bug_report',
			summary: '',
			confidence: 0,
			agentType: 'codex',
			messages: [],
			attachments: [],
			inputDraft: 'half-written report',
			includeDebugPackage: false,
			createdAt: 1000,
			updatedAt: 1000,
		};
		useFeedbackDraftStore.setState({ drafts: [draft], activeDraftId: null, resumeDraftId: null });

		window.maestro.feedback.checkGhAuth.mockResolvedValue({ authenticated: true });
		// The only codex account cannot run, so the saved provider is gone.
		window.maestro.feedback.listAccounts.mockResolvedValue({
			accounts: [
				WORK,
				account({ key: 'codex::/home/me/.codex', toolType: 'codex', status: 'not-installed' }),
			],
			lastWorkingKey: null,
		});
		window.maestro.feedback.getConversationPrompt.mockResolvedValue({
			prompt: 'system prompt',
			environment: '- Maestro version: 1.0.0',
		});

		const startSpy = vi.spyOn(FeedbackConversationManager.prototype, 'start');

		render(
			<FeedbackChatView
				theme={theme}
				sessions={sessions}
				onCancel={vi.fn()}
				onSubmitSuccess={vi.fn()}
				resumeDraftId="draft-codex"
			/>
		);

		await waitFor(() => {
			expect(startSpy).toHaveBeenCalled();
		});
		// The saved provider ('codex') is no longer available, so the editor must
		// start the conversation with the detected fallback instead of throwing.
		expect(startSpy.mock.calls[0][0].agentType).toBe('claude-code');
		startSpy.mockRestore();
	});

	it('resumes a draft on an account for its saved provider when one can run', async () => {
		const draft: FeedbackDraft = {
			id: 'draft-codex-ok',
			suggestedName: 'Codex draft',
			category: 'bug_report',
			summary: '',
			confidence: 0,
			agentType: 'codex',
			messages: [],
			attachments: [],
			inputDraft: 'half-written report',
			includeDebugPackage: false,
			createdAt: 1000,
			updatedAt: 1000,
		};
		useFeedbackDraftStore.setState({ drafts: [draft], activeDraftId: null, resumeDraftId: null });

		window.maestro.feedback.checkGhAuth.mockResolvedValue({ authenticated: true });
		const codex = account({ key: 'codex::/home/me/.codex', toolType: 'codex' });
		window.maestro.feedback.listAccounts.mockResolvedValue({
			accounts: [WORK, codex],
			lastWorkingKey: null,
		});
		window.maestro.feedback.getConversationPrompt.mockResolvedValue({
			prompt: 'system prompt',
			environment: '- Maestro version: 1.0.0',
		});

		const startSpy = vi.spyOn(FeedbackConversationManager.prototype, 'start');

		render(
			<FeedbackChatView
				theme={theme}
				sessions={sessions}
				onCancel={vi.fn()}
				onSubmitSuccess={vi.fn()}
				resumeDraftId="draft-codex-ok"
			/>
		);

		await waitFor(() => {
			expect(startSpy).toHaveBeenCalled();
		});
		// The first usable account is a Claude one, but the draft was a Codex chat.
		expect(startSpy.mock.calls[0][0].agentType).toBe('codex');
		expect(startSpy.mock.calls[0][0].account).toMatchObject({ key: codex.key });
		startSpy.mockRestore();
	});

	it('keeps a resumed submit-ready draft submittable by rehydrating lastResponse', async () => {
		const draft: FeedbackDraft = {
			id: 'ready-1',
			suggestedName: 'Ready report',
			category: 'bug_report',
			summary: 'Crash on save',
			confidence: 90,
			agentType: 'claude-code',
			messages: [
				{ role: 'user', content: 'It crashes', timestamp: 1000 },
				{ role: 'assistant', content: 'Got it', timestamp: 1001 },
			],
			attachments: [],
			inputDraft: '',
			includeDebugPackage: false,
			createdAt: 1000,
			updatedAt: 1000,
			lastResponse: {
				confidence: 90,
				ready: true,
				message: 'Got it',
				category: 'bug_report',
				summary: 'Crash on save',
				structured: {
					expectedBehavior: 'no crash',
					actualBehavior: 'crash',
					reproductionSteps: 'save',
					additionalContext: '',
				},
			},
		};
		useFeedbackDraftStore.setState({ drafts: [draft], activeDraftId: null, resumeDraftId: null });

		window.maestro.feedback.checkGhAuth.mockResolvedValue({ authenticated: true });
		window.maestro.feedback.listAccounts.mockResolvedValue({
			accounts: [WORK, DEFAULT],
			lastWorkingKey: null,
		});
		window.maestro.feedback.getConversationPrompt.mockResolvedValue({
			prompt: 'system prompt',
			environment: '- Maestro version: 1.0.0',
		});
		window.maestro.feedback.searchIssues.mockResolvedValue({ issues: [] });

		render(
			<FeedbackChatView
				theme={theme}
				sessions={sessions}
				onCancel={vi.fn()}
				onSubmitSuccess={vi.fn()}
				resumeDraftId="ready-1"
			/>
		);

		// Submit button is gated on isReady, which must be restored from the
		// persisted ready response without sending another message.
		expect(await screen.findByText('Submit Feedback')).toBeTruthy();
	});
});
