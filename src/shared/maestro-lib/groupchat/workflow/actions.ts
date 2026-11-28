/**
 * @file groupchat/workflow/actions.ts
 * @description The workflow actions a person takes (show, approve, cancel), as one function every
 * host calls: the desktop's Stage Strip and its bridge, and a headless host. Only how the approval
 * reaches the moderator differs, so the host passes that in.
 */

import type {
	GroupChatWorkflowAction,
	GroupChatWorkflowActionResult,
	GroupChatWorkflowRun,
} from '../../../group-chat-workflow-types';

/** The message an approval sends: what a person types to start a plan. */
export const WORKFLOW_APPROVAL_MESSAGE = 'go';

export interface GroupChatWorkflowActionDeps {
	getRun(chatId: string): Promise<GroupChatWorkflowRun | null>;
	cancel(chatId: string): Promise<GroupChatWorkflowRun | null>;
	/** Send the approval to the moderator the way the host sends a typed message. Throws a refusal. */
	sendApproval(chatId: string, message: string): Promise<void>;
}

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

export async function runGroupChatWorkflowAction(
	deps: GroupChatWorkflowActionDeps,
	chatId: string,
	action: GroupChatWorkflowAction
): Promise<GroupChatWorkflowActionResult> {
	const run = await deps.getRun(chatId);
	if (action === 'show') return { ok: true, run };
	if (action === 'cancel') {
		const ended = await deps.cancel(chatId);
		return ended
			? { ok: true, run: ended }
			: { ok: false, error: 'This chat has no workflow running or waiting for approval.', run };
	}
	if (run?.status !== 'awaiting-approval') {
		return { ok: false, error: 'This chat has no workflow plan waiting for approval.', run };
	}
	try {
		await deps.sendApproval(chatId, WORKFLOW_APPROVAL_MESSAGE);
	} catch (error) {
		return { ok: false, error: errorText(error), run };
	}
	return { ok: true, run: await deps.getRun(chatId) };
}
