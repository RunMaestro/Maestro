/**
 * Conversational PRD Planner — service layer
 */

import { PROMPT_IDS } from '../../shared/promptDefinitions';
import type {
	ConversationalPrdDraft,
	ConversationalPrdFinalizeRequest,
	ConversationalPrdFinalizeResponse,
	ConversationalPrdSession,
	ConversationalPrdStartRequest,
	ConversationalPrdStartResponse,
	ConversationalPrdTurnRequest,
	ConversationalPrdTurnResponse,
} from '../../shared/conversational-prd-types';
import type { WorkGraphActor } from '../../shared/work-graph-types';
import { getPrompt } from '../prompt-manager';
import type { CreatePrdInput, DeliveryPlannerService } from '../delivery-planner/planner-service';
import type { ConversationalPrdGateway } from './gateway';
import type { IConversationalPrdStore } from './session-store';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ConversationalPrdNotReadyError extends Error {
	constructor(conversationId: string, currentStatus: string) {
		super(
			`ConversationalPrdSession ${conversationId} cannot be finalized: status is "${currentStatus}" (expected "ready-to-finalize")`
		);
		this.name = 'ConversationalPrdNotReadyError';
	}
}

export class ConversationalPrdAlreadyFinalizedError extends Error {
	constructor(conversationId: string) {
		super(`ConversationalPrdSession ${conversationId} is already finalized`);
		this.name = 'ConversationalPrdAlreadyFinalizedError';
	}
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class ConversationalPrdService {
	constructor(
		private readonly store: IConversationalPrdStore,
		private readonly gateway: ConversationalPrdGateway,
		private readonly plannerService?: DeliveryPlannerService
	) {}

	async createSession(
		input: ConversationalPrdStartRequest
	): Promise<ConversationalPrdStartResponse> {
		const session = this.store.create({
			projectPath: input.projectPath,
			gitPath: input.gitPath,
			actor: input.actor,
		});

		let greeting = input.greeting;
		if (!greeting) {
			const systemPrompt = this.buildSystemPrompt(input.projectPath, input.gitPath);
			const response = await this.gateway.respond({
				systemPrompt,
				history: [],
				userMessage:
					'Hello \u2014 please start the PRD planning conversation with your opening question.',
			});
			greeting = response.messageToUser;
		}

		this.store.appendMessage(session.conversationId, {
			role: 'assistant',
			content: greeting,
		});

		return {
			conversationId: session.conversationId,
			greeting,
		};
	}

	async sendMessage(input: ConversationalPrdTurnRequest): Promise<ConversationalPrdTurnResponse> {
		const existing = this.store.get(input.conversationId);
		if (!existing) {
			throw new Error(`ConversationalPrdSession not found: ${input.conversationId}`);
		}

		if (existing.status !== 'active' && existing.status !== 'ready-to-finalize') {
			throw new Error(
				`ConversationalPrdSession ${input.conversationId} is not active (status: ${existing.status})`
			);
		}

		const afterUser = this.store.appendMessage(input.conversationId, {
			role: 'user',
			content: input.message,
		});

		const systemPrompt = this.buildSystemPrompt(
			existing.metadata.projectPath,
			existing.metadata.gitPath
		);

		const gatewayResponse = await this.gateway.respond({
			systemPrompt,
			history: afterUser.messages.slice(0, -1),
			userMessage: input.message,
		});

		const afterDelta = this.store.mergeDraft(input.conversationId, gatewayResponse.prdDraftDelta);

		this.store.appendMessage(input.conversationId, {
			role: 'assistant',
			content: gatewayResponse.messageToUser,
		});

		const suggestCommit = gatewayResponse.status === 'ready-to-finalize';
		if (suggestCommit && existing.status === 'active') {
			this.store.updateStatus(input.conversationId, 'ready-to-finalize');
		}

		return {
			conversationId: input.conversationId,
			assistantMessage: gatewayResponse.messageToUser,
			delta: gatewayResponse.prdDraftDelta,
			suggestCommit,
			draft: afterDelta.draft,
		};
	}

	async finalizeSession(
		input: ConversationalPrdFinalizeRequest
	): Promise<ConversationalPrdFinalizeResponse> {
		if (!this.plannerService) {
			throw new Error('ConversationalPrdService: plannerService is required for finalizeSession()');
		}

		const session = this.store.get(input.conversationId);
		if (!session) {
			throw new Error(`ConversationalPrdSession not found: ${input.conversationId}`);
		}

		if (session.finalized) {
			throw new ConversationalPrdAlreadyFinalizedError(input.conversationId);
		}

		if (session.status !== 'ready-to-finalize') {
			throw new ConversationalPrdNotReadyError(input.conversationId, session.status);
		}

		const { draft, metadata } = session;

		const createInput: CreatePrdInput = {
			title: draft.title ?? 'Untitled PRD',
			description: this.buildPrdDescription(draft),
			projectPath: metadata.projectPath,
			gitPath: metadata.gitPath,
			tags: ['conversational-prd'],
			metadata: { origin: 'conversational-prd', conversationId: input.conversationId },
			actor: input.actor ?? metadata.actor,
		};

		const prdItem = await this.plannerService.createPrd(createInput);
		const now = new Date().toISOString();

		const updated = this.store.finalize(input.conversationId, prdItem.id, now);

		return {
			conversationId: input.conversationId,
			prdWorkItemId: prdItem.id,
			session: updated,
		};
	}

	getSession(conversationId: string): ConversationalPrdSession | undefined {
		return this.store.get(conversationId);
	}

	listSessions(filters?: {
		projectPath?: string;
		includeArchived?: boolean;
	}): ConversationalPrdSession[] {
		return this.store.list(filters);
	}

	archiveSession(input: { sessionId: string; actor?: WorkGraphActor }): ConversationalPrdSession {
		const store = this.store as {
			archive?: (sessionId: string) => ConversationalPrdSession;
		};
		if (typeof store.archive !== 'function') {
			// InMemoryConversationalPrdStore fallback: just update status to aborted
			return this.store.updateStatus(input.sessionId, 'aborted');
		}
		return store.archive(input.sessionId);
	}

	private buildSystemPrompt(projectPath: string, gitPath: string): string {
		let content: string;
		try {
			content = getPrompt(PROMPT_IDS.CONVERSATIONAL_PRD_PLANNER);
		} catch {
			content =
				'You are the Maestro PRD Planning Copilot. ' +
				'Output JSON: { "messageToUser": string, "prdDraftDelta": {}, "status": "gathering" }';
		}

		return content.replace(/{{PROJECT_PATH}}/g, projectPath).replace(/{{GIT_PATH}}/g, gitPath);
	}

	/** Render the accumulated draft fields into a Markdown description for the PRD work item. */
	private buildPrdDescription(draft: ConversationalPrdDraft): string {
		const sections: string[] = [];

		if (draft.problem) {
			sections.push(`## Problem\n\n${draft.problem}`);
		}
		if (draft.users) {
			sections.push(`## Target Users\n\n${draft.users}`);
		}
		if (draft.successCriteria) {
			sections.push(`## Success Criteria\n\n${draft.successCriteria}`);
		}
		if (draft.scope) {
			sections.push(`## Scope\n\n${draft.scope}`);
		}
		if (draft.constraints) {
			sections.push(`## Constraints\n\n${draft.constraints}`);
		}
		if (draft.dependencies) {
			sections.push(`## Dependencies\n\n${draft.dependencies}`);
		}
		if (draft.outOfScope) {
			sections.push(`## Out of Scope\n\n${draft.outOfScope}`);
		}
		if (draft.notes) {
			sections.push(`## Notes\n\n${draft.notes}`);
		}

		return sections.join('\n\n');
	}
}
