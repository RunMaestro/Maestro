/**
 * Preload API for the PM slash-command suite (#428 + #436)
 *
 * Provides the window.maestro.pm namespace for all /PM verbs.
 *
 * Push listeners let the main process request the renderer to open modals:
 *   onOpenConvPrd           — open Conv-PRD modal (new or edit mode)
 *   onOpenDeliveryPlanner   — open Delivery Planner
 *   onOpenAgentDispatch     — open Agent Dispatch for a claim
 *   onOpenPlanningPipeline  — open Planning Pipeline
 *   onOpenPlanningPrompt    — legacy: seed active chat (used by /PM <idea>)
 */

import { ipcRenderer } from 'electron';

export interface PmCommandRequest {
	args?: string;
	projectPath?: string;
	gitPath?: string;
	actor?: { sessionId?: string; name?: string };
}

export interface PmCommandResponse {
	success: boolean;
	message?: string;
	data?: unknown;
	error?: string;
	code?: string;
}

export interface PmOpenConvPrdEvent {
	mode?: 'new' | 'edit';
	seed?: string;
	prdId?: string;
	projectPath?: string;
}

export interface PmOpenDeliveryPlannerEvent {
	mode: 'decompose-prd' | 'edit-epic' | 'sync-epic' | 'sync-issue';
	prdId?: string;
	epicId?: string;
	taskId?: string;
	projectPath?: string;
}

export interface PmOpenAgentDispatchEvent {
	mode: 'claim';
	taskId: string;
	sessionId?: string;
}

export interface PmOpenPlanningPipelineEvent {
	mode: 'start-epic';
	epicId: string;
	projectPath?: string;
}

export interface PmOpenPlanningPromptEvent {
	mode: 'orchestrate' | 'prd-new';
	idea?: string;
	name?: string;
	projectPath?: string;
	gitPath?: string;
}

function on<T>(channel: string, handler: (event: T) => void): () => void {
	const listener = (_e: unknown, payload: T) => handler(payload);
	ipcRenderer.on(channel, listener);
	return () => ipcRenderer.removeListener(channel, listener);
}

export function createPmApi() {
	return {
		// PRD verbs
		orchestrate: (req: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:orchestrate', req),
		prdNew: (req: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:prd-new', req),
		prdEdit: (req: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:prd-edit', req),
		prdStatus: (req: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:prd-status', req),
		prdParse: (req: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:prd-parse', req),
		prdList: (req?: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:prd-list', req ?? {}),

		// Epic verbs
		epicDecompose: (req: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:epic-decompose', req),
		epicEdit: (req: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:epic-edit', req),
		epicList: (req?: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:epic-list', req ?? {}),
		epicShow: (req: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:epic-show', req),
		epicSync: (req: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:epic-sync', req),
		epicStart: (req: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:epic-start', req),

		// Issue / task verbs
		issueStart: (req: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:issue-start', req),
		issueShow: (req: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:issue-show', req),
		issueStatus: (req: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:issue-status', req),
		issueSync: (req: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:issue-sync', req),

		// Board summary verbs
		next: (req?: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:next', req ?? {}),
		status: (req?: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:status', req ?? {}),
		standup: (req?: PmCommandRequest): Promise<PmCommandResponse> =>
			ipcRenderer.invoke('pm:standup', req ?? {}),

		// Push listeners: main → renderer
		onOpenConvPrd: (handler: (event: PmOpenConvPrdEvent) => void): (() => void) =>
			on('pm:openConvPrd', handler),
		onOpenDeliveryPlanner: (handler: (event: PmOpenDeliveryPlannerEvent) => void): (() => void) =>
			on('pm:openDeliveryPlanner', handler),
		onOpenAgentDispatch: (handler: (event: PmOpenAgentDispatchEvent) => void): (() => void) =>
			on('pm:openAgentDispatch', handler),
		onOpenPlanningPipeline: (handler: (event: PmOpenPlanningPipelineEvent) => void): (() => void) =>
			on('pm:openPlanningPipeline', handler),
		/** Legacy planning prompt seed event (used by /PM <idea>). */
		onOpenPlanningPrompt: (handler: (event: PmOpenPlanningPromptEvent) => void): (() => void) =>
			on('pm:openPlanningPrompt', handler),
	};
}

export type PmApi = ReturnType<typeof createPmApi>;
