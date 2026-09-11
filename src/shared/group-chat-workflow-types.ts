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

export interface GroupChatWorkflowHandoff {
	stageId: string;
	stageName: string;
	summary: string;
	artifactPaths?: string[];
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
}
