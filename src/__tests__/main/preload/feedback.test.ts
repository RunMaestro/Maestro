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
});
