/**
 * @file group-chat-workflow.ts
 * @description The desktop's workflow actions (show, approve, cancel). The Stage Strip's IPC
 * handler and the bridge's `group_chat_workflow` message both call this, so a button and
 * `maestro-cli group-chat workflow` reach the same code.
 */

import { randomUUID } from 'crypto';
import type {
	GroupChatWorkflowAction,
	GroupChatWorkflowActionResult,
} from '../../shared/group-chat-workflow-types';
import { runGroupChatWorkflowAction } from '../../shared/maestro-lib/groupchat/workflow/actions';
import { cancelWorkflow, getWorkflowRun } from './group-chat-router';
import { submitMessage } from './group-chat-queue';

export function runDesktopGroupChatWorkflowAction(
	chatId: string,
	action: GroupChatWorkflowAction
): Promise<GroupChatWorkflowActionResult> {
	return runGroupChatWorkflowAction(
		{
			getRun: getWorkflowRun,
			cancel: (id) => cancelWorkflow(id),
			// Through the queue, as a typed message goes: sent now when the room is idle,
			// queued behind anything already waiting otherwise.
			sendApproval: async (id, message) => {
				await submitMessage(id, { id: randomUUID(), timestamp: Date.now(), text: message });
			},
		},
		chatId,
		action
	);
}
