/**
 * @file group-chat-workflow-types.ts
 * @description Shared type definitions for Group Chat workflow plans and runs.
 * Used by both main process and renderer.
 */

export const WORKFLOW_PLAN_FENCE_LANG = 'maestro-plan';
export const MAX_WORKFLOW_STAGES = 12;

export interface GroupChatWorkflowStage {
	id: string;
	name: string;
	agents: string[];
	mode: 'serial' | 'parallel';
	instruction: string;
	expects?: string;
	autoRun?: {
		participantName: string;
		filename?: string;
	};
}

export interface GroupChatWorkflowPlan {
	runId: string;
	title: string;
	createdAt: number;
	stages: GroupChatWorkflowStage[];
	notes?: string;
}

export type GroupChatWorkflowStageStatus =
	| 'pending'
	| 'running'
	| 'complete'
	| 'failed'
	| 'skipped';

export type GroupChatWorkflowRunStatus = 'awaiting-approval' | 'running' | 'complete' | 'aborted';

export type GroupChatWorkflowParticipantHandoff =
	| {
			participantName: string;
			mode: 'inline';
			content: string;
	  }
	| {
			participantName: string;
			mode: 'artifact';
			digest: string;
			artifactPath: string;
	  };

export interface GroupChatWorkflowHandoff {
	stageId: string;
	stageName: string;
	summary: string;
	artifactPaths?: string[];
	participantHandoffs?: GroupChatWorkflowParticipantHandoff[];
}

export interface GroupChatWorkflowRun {
	plan: GroupChatWorkflowPlan;
	status: GroupChatWorkflowRunStatus;
	currentStageIndex: number;
	stageStatuses: Record<string, GroupChatWorkflowStageStatus>;
	handoffs: GroupChatWorkflowHandoff[];
	startedAt?: number;
	endedAt?: number;
	abortReason?: string;
	/**
	 * The plan was made in read-only mode. Its stages run read-only too, so an approval
	 * that names no mode (the Start button, `maestro-cli group-chat workflow --approve`)
	 * cannot turn a read-only plan into a read-write run.
	 */
	readOnly?: boolean;
}

/** What a caller can do to a chat's workflow run: the Stage Strip's buttons, and the CLI's flags. */
export const GROUP_CHAT_WORKFLOW_ACTIONS = ['show', 'approve', 'cancel'] as const;
export type GroupChatWorkflowAction = (typeof GROUP_CHAT_WORKFLOW_ACTIONS)[number];

export function isGroupChatWorkflowAction(value: unknown): value is GroupChatWorkflowAction {
	return (GROUP_CHAT_WORKFLOW_ACTIONS as readonly unknown[]).includes(value);
}

/**
 * The answer to a workflow action, on every surface (IPC, the bridge, a headless host). `run` is
 * the chat's run after the action, or null when it holds none; a refusal says why in `error`.
 */
export type GroupChatWorkflowActionResult =
	| { ok: true; run: GroupChatWorkflowRun | null }
	| { ok: false; error: string; run: GroupChatWorkflowRun | null };
