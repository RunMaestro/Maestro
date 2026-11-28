/**
 * @file workflow-actions.test.ts
 * @description The workflow actions every host shares: show, approve, cancel.
 */

import { describe, expect, it, vi } from 'vitest';
import { runGroupChatWorkflowAction, WORKFLOW_APPROVAL_MESSAGE } from '../workflow/actions';
import { approveRun, createRun } from '../workflow/state';
import type { GroupChatWorkflowRun } from '../../../group-chat-workflow-types';

const plan = {
	runId: 'run-1',
	title: 'Ship it',
	createdAt: 1,
	stages: [{ id: 'a', name: 'A', agents: ['Alice'], mode: 'serial' as const, instruction: 'Do A' }],
};

function deps(run: GroupChatWorkflowRun | null) {
	let current = run;
	return {
		getRun: vi.fn(async () => current),
		cancel: vi.fn(async () => current),
		sendApproval: vi.fn(async () => {
			if (current) current = approveRun(current);
		}),
	};
}

describe('runGroupChatWorkflowAction', () => {
	it('shows the run, or null', async () => {
		expect(await runGroupChatWorkflowAction(deps(null), 'chat', 'show')).toEqual({
			ok: true,
			run: null,
		});
		const run = createRun(plan);
		expect(await runGroupChatWorkflowAction(deps(run), 'chat', 'show')).toEqual({ ok: true, run });
	});

	it('approves a waiting plan by sending the approval message', async () => {
		const d = deps(createRun(plan));
		const result = await runGroupChatWorkflowAction(d, 'chat', 'approve');
		expect(d.sendApproval).toHaveBeenCalledWith('chat', WORKFLOW_APPROVAL_MESSAGE);
		expect(result.ok && result.run?.status).toBe('running');
	});

	it('refuses an approval with no plan waiting, and sends nothing', async () => {
		const d = deps(approveRun(createRun(plan)));
		const result = await runGroupChatWorkflowAction(d, 'chat', 'approve');
		expect(result.ok).toBe(false);
		expect(d.sendApproval).not.toHaveBeenCalled();
	});

	it('answers a refused send as a refusal', async () => {
		const d = deps(createRun(plan));
		d.sendApproval.mockRejectedValueOnce(new Error('The chat is still working.'));
		expect(await runGroupChatWorkflowAction(d, 'chat', 'approve')).toMatchObject({
			ok: false,
			error: 'The chat is still working.',
		});
	});

	it('refuses a cancel with nothing to cancel', async () => {
		const d = deps(null);
		expect(await runGroupChatWorkflowAction(d, 'chat', 'cancel')).toMatchObject({ ok: false });
	});
});
