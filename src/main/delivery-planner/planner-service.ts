/**
 * Delivery Planner Service — minimal type stubs for Conversational PRD port.
 *
 * TODO: port - full DeliveryPlannerService implementation lives in humpf-dev
 * src/main/delivery-planner/planner-service.ts. This stub exposes only the
 * interface required by ConversationalPrdService so the port compiles cleanly
 * on this RC base without pulling in the entire delivery-planner subsystem.
 */

import type { WorkGraphActor, WorkItem } from '../../shared/work-graph-types';

export interface CreatePrdInput {
	title: string;
	description?: string;
	projectPath: string;
	gitPath: string;
	tags?: string[];
	metadata?: Record<string, unknown>;
	actor?: WorkGraphActor;
}

export interface DeliveryPlannerService {
	createPrd(input: CreatePrdInput): Promise<WorkItem>;
}
