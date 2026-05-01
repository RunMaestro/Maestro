/**
 * Conversational PRD Planner — in-memory session store
 */

import crypto from 'crypto';

import type {
	ConversationalPrdDraft,
	ConversationalPrdMessage,
	ConversationalPrdSession,
	ConversationalPrdSessionMetadata,
	ConversationalPrdSessionStatus,
} from '../../shared/conversational-prd-types';

export interface IConversationalPrdStore {
	create(input: {
		projectPath: string;
		gitPath: string;
		actor?: ConversationalPrdSessionMetadata['actor'];
	}): ConversationalPrdSession;

	appendMessage(
		sessionId: string,
		message: Omit<ConversationalPrdMessage, 'id' | 'createdAt'>
	): ConversationalPrdSession;

	mergeDraft(sessionId: string, delta: Partial<ConversationalPrdDraft>): ConversationalPrdSession;

	updateStatus(sessionId: string, status: ConversationalPrdSessionStatus): ConversationalPrdSession;

	finalize(sessionId: string, prdWorkItemId: string, finalizedAt: string): ConversationalPrdSession;

	get(sessionId: string): ConversationalPrdSession | undefined;

	list(filters?: { projectPath?: string; includeArchived?: boolean }): ConversationalPrdSession[];

	delete(sessionId: string): boolean;
}

export class InMemoryConversationalPrdStore implements IConversationalPrdStore {
	private readonly sessions = new Map<string, ConversationalPrdSession>();

	create(input: {
		projectPath: string;
		gitPath: string;
		actor?: ConversationalPrdSessionMetadata['actor'];
	}): ConversationalPrdSession {
		const now = new Date().toISOString();
		const session: ConversationalPrdSession = {
			conversationId: crypto.randomUUID(),
			status: 'active',
			messages: [],
			draft: {},
			metadata: {
				projectPath: input.projectPath,
				gitPath: input.gitPath,
				startedAt: now,
				updatedAt: now,
				actor: input.actor,
			},
		};
		this.sessions.set(session.conversationId, session);
		return session;
	}

	appendMessage(
		sessionId: string,
		message: Omit<ConversationalPrdMessage, 'id' | 'createdAt'>
	): ConversationalPrdSession {
		const session = this.requireSession(sessionId);
		const newMessage: ConversationalPrdMessage = {
			...message,
			id: crypto.randomUUID(),
			createdAt: new Date().toISOString(),
		};
		const updated: ConversationalPrdSession = {
			...session,
			messages: [...session.messages, newMessage],
			metadata: { ...session.metadata, updatedAt: new Date().toISOString() },
		};
		this.sessions.set(sessionId, updated);
		return updated;
	}

	mergeDraft(sessionId: string, delta: Partial<ConversationalPrdDraft>): ConversationalPrdSession {
		const session = this.requireSession(sessionId);
		const filteredDelta = Object.fromEntries(
			Object.entries(delta).filter(([, v]) => v !== undefined)
		) as Partial<ConversationalPrdDraft>;
		const updated: ConversationalPrdSession = {
			...session,
			draft: { ...session.draft, ...filteredDelta },
			metadata: { ...session.metadata, updatedAt: new Date().toISOString() },
		};
		this.sessions.set(sessionId, updated);
		return updated;
	}

	updateStatus(
		sessionId: string,
		status: ConversationalPrdSessionStatus
	): ConversationalPrdSession {
		const session = this.requireSession(sessionId);
		const updated: ConversationalPrdSession = {
			...session,
			status,
			metadata: { ...session.metadata, updatedAt: new Date().toISOString() },
		};
		this.sessions.set(sessionId, updated);
		return updated;
	}

	finalize(
		sessionId: string,
		prdWorkItemId: string,
		finalizedAt: string
	): ConversationalPrdSession {
		const session = this.requireSession(sessionId);
		const updated: ConversationalPrdSession = {
			...session,
			status: 'finalized',
			finalized: true,
			finalizedAt,
			prdWorkItemId,
			metadata: { ...session.metadata, updatedAt: finalizedAt },
		};
		this.sessions.set(sessionId, updated);
		return updated;
	}

	get(sessionId: string): ConversationalPrdSession | undefined {
		return this.sessions.get(sessionId);
	}

	list(filters?: { projectPath?: string; includeArchived?: boolean }): ConversationalPrdSession[] {
		const all = [...this.sessions.values()];
		if (!filters?.projectPath) {
			return all;
		}
		return all.filter((s) => s.metadata.projectPath === filters.projectPath);
	}

	delete(sessionId: string): boolean {
		return this.sessions.delete(sessionId);
	}

	private requireSession(sessionId: string): ConversationalPrdSession {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`ConversationalPrdSession not found: ${sessionId}`);
		}
		return session;
	}
}
