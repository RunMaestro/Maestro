/**
 * Conversational PRD Planner — shared type definitions
 *
 * Architecture decision: Option A (in-process).
 * State is held in InMemoryConversationalPrdStore in the main process.
 * Conversations are keyed by conversationId (UUID).
 * Committing a draft calls DeliveryPlannerService.createPrd() unchanged.
 *
 * See: docs/architecture/conversational-prd-planner.md
 * Related: src/main/delivery-planner/planner-service.ts
 *          src/shared/delivery-planner-types.ts
 */

import type { WorkGraphActor, WorkItem } from './work-graph-types';

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export type ConversationalPrdSessionStatus =
	| 'active' // conversation in progress
	| 'ready-to-finalize' // assistant signalled sufficient draft; awaiting user action
	| 'finalized' // draft committed as a Delivery Planner PRD Work Graph item
	| 'committed' // legacy alias kept for backward compatibility
	| 'aborted'; // user discarded without committing

// ---------------------------------------------------------------------------
// Message model
// ---------------------------------------------------------------------------

export type ConversationalPrdMessageRole = 'user' | 'assistant' | 'system';

/** A single turn in the planning conversation. */
export interface ConversationalPrdMessage {
	id: string;
	role: ConversationalPrdMessageRole;
	content: string;
	/** ISO 8601 timestamp */
	createdAt: string;
}

// ---------------------------------------------------------------------------
// Draft accumulation
// ---------------------------------------------------------------------------

/**
 * Partial PRD fields accumulated across conversation turns.
 * All fields are optional — they are filled in progressively.
 * On commit, populated fields are rendered into a createPrd() description.
 */
export interface ConversationalPrdDraft {
	title?: string;
	problem?: string;
	users?: string;
	successCriteria?: string;
	scope?: string;
	constraints?: string;
	dependencies?: string;
	outOfScope?: string;
	/** Additional free-form notes captured during the conversation. */
	notes?: string;
}

/**
 * Field-level delta emitted by the assistant after each turn.
 * Only changed/newly populated fields are included; absent fields are unchanged.
 */
export type PrdDraftDelta = Partial<ConversationalPrdDraft>;

// ---------------------------------------------------------------------------
// Session record
// ---------------------------------------------------------------------------

/** Full session record held in InMemoryConversationalPrdStore. */
export interface ConversationalPrdSession {
	conversationId: string;
	status: ConversationalPrdSessionStatus;
	messages: ConversationalPrdMessage[];
	draft: ConversationalPrdDraft;
	metadata: ConversationalPrdSessionMetadata;
	/** Work Graph item ID set after successful commit (legacy). */
	committedPrdItemId?: WorkItem['id'];
	/** True once the draft has been committed as a Delivery Planner PRD item. */
	finalized?: boolean;
	/** ISO 8601 timestamp of when finalization completed. */
	finalizedAt?: string;
	/** Work Graph item ID created by finalizeSession(). */
	prdWorkItemId?: string;
}

export interface ConversationalPrdSessionMetadata {
	projectPath: string;
	gitPath: string;
	startedAt: string;
	updatedAt: string;
	actor?: WorkGraphActor;
}

// ---------------------------------------------------------------------------
// IPC request / response shapes
// ---------------------------------------------------------------------------

/** renderer → main: open a new planning conversation. */
export interface ConversationalPrdStartRequest {
	projectPath: string;
	gitPath: string;
	/** Optional seed message shown to the user as the assistant greeting. */
	greeting?: string;
	actor?: WorkGraphActor;
}

export interface ConversationalPrdStartResponse {
	conversationId: string;
	greeting: string;
}

// ---------------------------------------------------------------------------

/** renderer → main: submit a user turn and receive the assistant reply. */
export interface ConversationalPrdTurnRequest {
	conversationId: string;
	message: string;
}

export interface ConversationalPrdTurnResponse {
	conversationId: string;
	assistantMessage: string;
	/** Partial PRD fields updated by this turn. */
	delta: PrdDraftDelta;
	/** Whether the gateway suggests the draft is ready to commit. */
	suggestCommit: boolean;
	/** Full draft state after applying this turn's delta. */
	draft: ConversationalPrdDraft;
}

// ---------------------------------------------------------------------------

/** renderer → main: commit the accumulated draft as a Work Graph PRD item. */
export interface ConversationalPrdCommitRequest {
	conversationId: string;
	/** Override the draft title before committing. */
	titleOverride?: string;
	actor?: WorkGraphActor;
}

export interface ConversationalPrdCommitResponse {
	conversationId: string;
	prdItemId: WorkItem['id'];
}

// ---------------------------------------------------------------------------

/** renderer → main: finalize (commit) the accumulated draft as a Delivery Planner PRD item. */
export interface ConversationalPrdFinalizeRequest {
	conversationId: string;
	actor?: WorkGraphActor;
}

export interface ConversationalPrdFinalizeResponse {
	conversationId: string;
	prdWorkItemId: string;
	session: ConversationalPrdSession;
}

// ---------------------------------------------------------------------------

/** renderer → main: discard the conversation without committing. */
export interface ConversationalPrdAbortRequest {
	conversationId: string;
}

// ---------------------------------------------------------------------------

/** renderer → main: retrieve the current session state (reconnect / hot reload). */
export interface ConversationalPrdGetRequest {
	conversationId: string;
}

// ---------------------------------------------------------------------------
// Push event (main → renderer)
// ---------------------------------------------------------------------------

/**
 * Streaming token chunk pushed from main → renderer via
 * 'deliveryPlanner:conversationalPrd:chunk' IPC channel.
 * Only emitted when the gateway supports streaming.
 */
export interface ConversationalPrdChunkEvent {
	conversationId: string;
	chunk: string;
	/** True on the final chunk of a turn. */
	done: boolean;
}
