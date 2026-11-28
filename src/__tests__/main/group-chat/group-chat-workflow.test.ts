/**
 * @file group-chat-workflow.test.ts
 * @description The desktop's workflow actions: an approval goes through the queue as a typed
 * message would, and show and cancel read the engine.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { approveRun, createRun } from '../../../shared/maestro-lib/groupchat/workflow/state';
import type { GroupChatWorkflowRun } from '../../../shared/group-chat-workflow-types';

let run: GroupChatWorkflowRun | null = null;

vi.mock('../../../main/group-chat/group-chat-router', () => ({
	getWorkflowRun: vi.fn(async () => run),
	cancelWorkflow: vi.fn(async () => run),
}));

vi.mock('../../../main/group-chat/group-chat-queue', () => ({
	submitMessage: vi.fn(async () => {
		if (run) run = approveRun(run);
	}),
}));

import { runDesktopGroupChatWorkflowAction } from '../../../main/group-chat/group-chat-workflow';
import { submitMessage } from '../../../main/group-chat/group-chat-queue';

const plan = {
	runId: 'run-1',
	title: 'Ship it',
	createdAt: 1,
	stages: [{ id: 'a', name: 'A', agents: ['Alice'], mode: 'serial' as const, instruction: 'Do A' }],
};

describe('runDesktopGroupChatWorkflowAction', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		run = createRun(plan);
	});

	it('approves by submitting "go" to the chat queue', async () => {
		const result = await runDesktopGroupChatWorkflowAction('chat-1', 'approve');
		expect(submitMessage).toHaveBeenCalledWith(
			'chat-1',
			expect.objectContaining({ text: 'go', id: expect.any(String), timestamp: expect.any(Number) })
		);
		expect(result).toMatchObject({ ok: true, run: { status: 'running' } });
	});

	it('refuses an approval when nothing waits, without submitting', async () => {
		run = null;
		const result = await runDesktopGroupChatWorkflowAction('chat-1', 'approve');
		expect(result.ok).toBe(false);
		expect(submitMessage).not.toHaveBeenCalled();
	});
});
