/** Persisted scope decisions. Audit records are the authority across worker and desktop writers. */
import type { PianolaDecisionRecord, PianolaDecisionLifecycle } from './storage';
import type { PianolaMessage } from './types';
import type { PianolaOwnerPrincipal } from './owner-identity';
import type { PianolaScopeDeliveryGuard, PianolaScopeSnapshotTab } from './pianola-scope-cycle';
import { canonicalJson } from '../canonicalJson';

export type PianolaDecisionActor =
	| { kind: 'manager'; agentId: string; tabId: string }
	| { kind: 'human'; actorId: string; principal?: PianolaOwnerPrincipal };

export interface PianolaDecisionResolution {
	decisionId: string;
	answer?: string;
	/** A concrete recommendation/question for the human, rather than a second send. */
	escalation?: string;
}

export function startPianolaDecision(
	record: PianolaDecisionRecord,
	guard: PianolaScopeDeliveryGuard,
	managerAgentId: string,
	groupId: string | null
): PianolaDecisionRecord {
	const rule = record.decision.action === 'auto_answer';
	const judgment = /handed off to Pianola/.test(record.decision.reason);
	const ignored = record.decision.action === 'ignore' || record.dryRun;
	return {
		...record,
		lifecycle: {
			version: 1,
			guard,
			managerAgentId,
			groupId,
			status: ignored ? 'done' : judgment ? 'mira_processing' : rule ? 'blocked' : 'waiting_human',
			nextActor: ignored ? 'none' : judgment ? 'manager' : rule ? 'operator' : 'human',
			nextAction: ignored
				? 'No reply requested'
				: judgment
					? 'The manager judges the pending ask'
					: rule
						? 'Deliver the authorized rule answer'
						: record.decision.reason,
			phase: ignored ? 'none' : judgment ? 'judgment' : rule ? 'answer' : 'none',
			delivery: ignored || (!rule && !judgment) ? 'not_sent' : 'intent',
			updatedAt: record.timestamp,
			source: { kind: rule ? 'rule' : 'unknown', timestamp: record.timestamp },
		},
	};
}

export function updatePianolaDecision(
	record: PianolaDecisionRecord,
	change: Partial<PianolaDecisionLifecycle>,
	now: string
): PianolaDecisionRecord {
	if (!record.lifecycle) throw new Error('Missing Pianola decision lifecycle');
	if (canonicalJson({ ...record.lifecycle, ...change }) === canonicalJson(record.lifecycle))
		return record;
	return { ...record, lifecycle: { ...record.lifecycle, ...change, updatedAt: now } };
}

/** The supervisor uses the same durable pause transition as a standalone worker. */
export function pausePianolaScopeDecisions(
	scopeId: string,
	store: {
		readDecisions: () => PianolaDecisionRecord[];
		appendDecision: (record: PianolaDecisionRecord) => void;
	},
	now: string
): void {
	for (const record of store.readDecisions()) {
		if (
			record.lifecycle?.guard.scopeId === scopeId &&
			record.lifecycle.status !== 'done' &&
			record.lifecycle.status !== 'paused'
		)
			store.appendDecision(
				updatePianolaDecision(
					record,
					{
						status: 'paused',
						nextActor: 'none',
						nextAction: 'Enable the scope, then revalidate the original pending ask',
					},
					now
				)
			);
	}
}

/** Observation can reconcile delivery but can never invent the answer's author. */
export function reconcilePianolaDecision(
	record: PianolaDecisionRecord,
	tab: PianolaScopeSnapshotTab | undefined,
	messages: readonly PianolaMessage[],
	now: string
): PianolaDecisionRecord {
	const life = record.lifecycle;
	if (!life || life.status === 'done') return record;
	if (!tab)
		return updatePianolaDecision(
			record,
			{
				status: 'blocked',
				nextActor: 'operator',
				nextAction: 'Restore the requesting agent/tab; do not redirect its answer',
			},
			now
		);
	const askIndex = messages.findIndex((message) => message.id === life.guard.messageId);
	if (askIndex < 0) return record;
	const after = messages.slice(askIndex + 1);
	const reply = after.find((message) => message.role === 'user');
	const advanced = after.some((message) => message.role === 'assistant');
	if (reply || advanced) {
		const attributable =
			life.phase === 'answer' &&
			record.decision.action === 'auto_answer' &&
			reply?.content === record.decision.answer;
		const next = updatePianolaDecision(
			record,
			{
				status: advanced && !tab.busy ? 'done' : 'agent_running',
				nextActor: advanced && !tab.busy ? 'none' : 'recipient',
				nextAction:
					advanced && !tab.busy
						? 'Recipient produced its next response'
						: 'Wait for the recipient to finish its turn',
				delivery: life.phase === 'answer' && reply ? 'accepted' : life.delivery,
				acknowledgedAt: life.acknowledgedAt ?? now,
				answerMessageId: reply?.id,
				source: attributable ? life.source : { kind: 'unknown' },
			},
			now
		);
		const dispatched = attributable || record.dispatched;
		return next === record && dispatched === record.dispatched ? record : { ...next, dispatched };
	}
	if (tab.paused)
		return updatePianolaDecision(
			record,
			{
				status: 'paused',
				nextActor: 'none',
				nextAction: 'Resume the requesting agent and revalidate its pending ask',
			},
			now
		);
	if (life.delivery === 'intent')
		return updatePianolaDecision(
			record,
			{
				delivery: 'unknown',
				status: 'blocked',
				nextActor: 'operator',
				nextAction: 'Reconcile the interrupted native delivery before any retry',
			},
			now
		);
	if (life.phase === 'answer' && tab.busy && life.delivery === 'accepted')
		return updatePianolaDecision(
			record,
			{
				status: 'agent_running',
				nextActor: 'recipient',
				nextAction: 'Wait for the recipient to finish its turn',
				acknowledgedAt: life.acknowledgedAt ?? now,
			},
			now
		);
	if (
		life.status === 'mira_processing' &&
		life.phase === 'judgment' &&
		life.delivery === 'accepted' &&
		life.deadlineAt !== undefined &&
		Date.parse(now) >= life.deadlineAt
	)
		return updatePianolaDecision(
			record,
			{
				status: 'waiting_human',
				nextActor: 'human',
				nextAction:
					'The manager did not settle the ask before the deadline; decide the original question',
			},
			now
		);
	if (life.status === 'paused') {
		const uncertain = life.delivery === 'unknown';
		const humanRetry =
			life.phase === 'answer' && life.delivery === 'rejected' && life.source.kind === 'human';
		const awaitingManager =
			life.phase === 'judgment' &&
			life.delivery === 'accepted' &&
			life.source.kind === 'unknown' &&
			(life.deadlineAt === undefined || Date.parse(now) < life.deadlineAt);
		const awaitingRecipient = life.phase === 'answer' && life.delivery === 'accepted';
		return updatePianolaDecision(
			record,
			{
				status:
					uncertain || (life.phase === 'answer' && !humanRetry)
						? 'blocked'
						: awaitingManager
							? 'mira_processing'
							: 'waiting_human',
				nextActor: uncertain
					? 'operator'
					: awaitingRecipient
						? 'recipient'
						: life.phase === 'answer' && !humanRetry
							? 'operator'
							: awaitingManager
								? 'manager'
								: 'human',
				nextAction: awaitingRecipient
					? 'Wait for recipient activity; do not resend'
					: record.decision.reason,
			},
			now
		);
	}
	return record;
}
