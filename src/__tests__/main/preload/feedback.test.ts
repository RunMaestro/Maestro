import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
	},
}));

import { createFeedbackApi } from '../../../main/preload/feedback';

describe('Feedback Preload API', () => {
	let api: ReturnType<typeof createFeedbackApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createFeedbackApi();
	});

	it('invokes feedback:check-gh-auth', async () => {
		mockInvoke.mockResolvedValue({ authenticated: true });

		const result = await api.checkGhAuth();

		expect(mockInvoke).toHaveBeenCalledWith('feedback:check-gh-auth');
		expect(result.authenticated).toBe(true);
	});

	it('invokes feedback:submit with attachments payload', async () => {
		mockInvoke.mockResolvedValue({ success: true });
		const payload = {
			sessionId: 'session-123',
			category: 'bug_report' as const,
			summary: 'Feedback modal crashes',
			expectedBehavior: 'The issue should be created.',
			details: 'The modal closes without creating an issue.',
			reproductionSteps: '1. Open Feedback\n2. Click Send Feedback',
			agentProvider: 'codex',
			sshRemoteEnabled: false,
			attachments: [{ name: 'bug.png', dataUrl: 'data:image/png;base64,abc123' }],
		};

		const result = await api.submit(payload);

		expect(mockInvoke).toHaveBeenCalledWith('feedback:submit', {
			...payload,
			attachments: payload.attachments,
		});
		expect(result.success).toBe(true);
	});

	it('invokes feedback:compose-prompt with attachments payload', async () => {
		mockInvoke.mockResolvedValue({ prompt: 'rendered prompt' });
		const attachments = [{ name: 'bug.png', dataUrl: 'data:image/png;base64,abc123' }];

		const result = await api.composePrompt('Something broke', attachments);

		expect(mockInvoke).toHaveBeenCalledWith('feedback:compose-prompt', {
			feedbackText: 'Something broke',
			attachments,
		});
		expect(result.prompt).toBe('rendered prompt');
	});

	it('invokes feedback:drafts:list', async () => {
		mockInvoke.mockResolvedValue({ drafts: [] });

		const result = await api.drafts.list();

		expect(mockInvoke).toHaveBeenCalledWith('feedback:drafts:list');
		expect(result.drafts).toEqual([]);
	});

	it('invokes feedback:drafts:save with the draft payload', async () => {
		const draft = {
			id: 'draft-1',
			suggestedName: 'Crash on save',
			category: 'bug_report' as const,
			summary: 'Crash on save',
			confidence: 75,
			agentType: 'claude-code',
			messages: [{ role: 'user' as const, content: 'It crashes', timestamp: 1 }],
			attachments: [],
			inputDraft: '',
			includeDebugPackage: false,
			createdAt: 1,
			updatedAt: 1,
		};
		mockInvoke.mockResolvedValue({ draft });

		const result = await api.drafts.save(draft);

		expect(mockInvoke).toHaveBeenCalledWith('feedback:drafts:save', draft);
		expect(result.draft).toEqual(draft);
	});

	it('invokes feedback:drafts:delete with the id wrapped in an object', async () => {
		mockInvoke.mockResolvedValue({});

		await api.drafts.delete('draft-1');

		expect(mockInvoke).toHaveBeenCalledWith('feedback:drafts:delete', { id: 'draft-1' });
	});
});
