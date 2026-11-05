/** Native admission and receipt handling shared by the CLI and explicit human answers. */
import { getSettingsStore } from '../stores';
import { requireEncoreFeature } from '../../shared/encoreFeatureDefaults';
import { nativeCurrentTurns } from './current-turn';
import { pianolaNewTabSpawns } from './pianola-new-tab-dispatch';
import { decide } from '../../shared/pianola/pianola-policy';
import * as defaultStore from './pianola-store-main';
import type { MessageHandlerCallbacks } from '../web-server/handlers/messageHandlers/types';
import {
	admitPianolaScopeReply,
	validatePianolaScopeDelivery,
	pianolaScopeSnapshotFromDesktop,
	type PianolaScopeDeliveryResult,
} from '../../shared/pianola/pianola-scope-cycle';
import {
	updatePianolaDecision,
	type PianolaDecisionActor,
} from '../../shared/pianola/pianola-decision-lifecycle';
import { classifyMessages } from '../../shared/pianola/pianola-classifier';
import { enrichWithAwaitingInput } from '../../shared/pianola/pianola-awaiting-detector';
import { rateRisk } from '../../shared/pianola/pianola-risk';
import {
	PIANOLA_DECISION_RECORD_MAX_BYTES,
	type PianolaDecisionRecord,
} from '../../shared/pianola/storage';
import { generateUUID } from '../../shared/uuid';
import {
	composeCurrentTurn,
	currentTurnMessages,
	sameCurrentTurnCursor,
} from '../../shared/currentTurn';
import { canonicalJson } from '../../shared/canonicalJson';

type NativeCallbacks = Partial<
	Pick<
		MessageHandlerCallbacks,
		'listDesktopSessions' | 'getSessionHistory' | 'executeCommand' | 'notifyToast'
	>
>;
type DecisionStore = Parameters<typeof validatePianolaScopeDelivery>[2] &
	Partial<Pick<typeof defaultStore, 'appendDecisionAsync'>>;

function currentAsk(callbacks: NativeCallbacks, record: PianolaDecisionRecord) {
	const cursor = record.lifecycle!.guard.cursor;
	const history = callbacks.getSessionHistory?.(
		record.tabId,
		cursor.native
			? { currentTurn: true, currentTurnInterest: 'pianola', expectedCursor: cursor.native }
			: undefined
	);
	if (cursor.native) {
		if (!history?.currentTurn || !sameCurrentTurnCursor(history.currentTurn.cursor, cursor.native))
			throw new Error('Requesting native turn changed');
		history.messages = currentTurnMessages(composeCurrentTurn(history.currentTurn));
	}
	if (
		!history ||
		history.agentId !== record.agentId ||
		history.tabId !== record.tabId ||
		history.messages.length !== cursor.count ||
		history.messages.at(-1)?.id !== cursor.id ||
		(!cursor.native && history.messages.at(-1)?.content.length !== cursor.textLength)
	)
		throw new Error('Requesting transcript no longer matches the pending ask');
	const classification = classifyMessages(enrichWithAwaitingInput(history.messages));
	if (
		classification.kind === 'none' ||
		classification.evidence.messageId !== record.classification.evidence.messageId ||
		classification.risk !== record.classification.risk
	)
		throw new Error('The requesting agent is no longer awaiting this answer');
	return classification;
}

async function sendClaimedDecision(
	callbacks: NativeCallbacks,
	record: PianolaDecisionRecord,
	command: string,
	destination: { agentId: string; tabId: string },
	store: DecisionStore
): Promise<PianolaScopeDeliveryResult> {
	const phase = record.lifecycle!.phase;
	let result: PianolaScopeDeliveryResult;
	try {
		if (!callbacks.executeCommand) throw new Error('Native send callback unavailable');
		const guard = record.lifecycle!.guard;
		const native = guard.cursor.native;
		if (native) {
			if (pianolaNewTabSpawns.isHeld(destination.agentId, destination.tabId))
				throw new Error('Decision destination already held');
			pianolaNewTabSpawns.hold(destination.agentId, destination.tabId);
			pianolaNewTabSpawns.arm(
				destination.agentId,
				destination.tabId,
				(boundaryId) => {
					requireEncoreFeature(getSettingsStore(), 'pianola', 'PianolaDisabled');
					if (!boundaryId) throw new Error('Native decision reply boundary required');
					const snapshot = pianolaScopeSnapshotFromDesktop({
						success: true,
						...callbacks.listDesktopSessions?.(),
					});
					const recipient = snapshot.tabs.find(
						(tab) => tab.agentId === destination.agentId && tab.tabId === destination.tabId
					);
					if (
						!recipient ||
						recipient.paused ||
						recipient.busy ||
						recipient.consult ||
						recipient.ephemeral
					)
						throw new Error('Decision destination unavailable');
					const current = store.readDecisions().find((row) => row.id === record.id);
					if (
						!current?.lifecycle ||
						current.lifecycle.status === 'done' ||
						current.lifecycle.status === 'paused' ||
						current.lifecycle.phase !== phase ||
						(current.lifecycle.delivery !== 'intent' &&
							current.lifecycle.delivery !== 'accepted') ||
						current.deliveryStatus !== 'admitted' ||
						canonicalJson(current.lifecycle.source) !== canonicalJson(record.lifecycle!.source)
					)
						throw new Error('Decision authority changed during delivery');
					const appended = nativeCurrentTurns.assertDelivery(
						native,
						guard.cursor.count,
						destination.agentId === record.agentId && destination.tabId === record.tabId
							? boundaryId
							: undefined,
						command,
						guard.cursor.questionSignatures
					);
					if (appended) {
						const tab = snapshot.tabs.find(
							(tab) => tab.agentId === record.agentId && tab.tabId === record.tabId
						);
						if (!tab) throw new Error('Decision tab closed');
						tab.cursor = guard.cursor;
						tab.cursorAvailable = true;
					}
					validatePianolaScopeDelivery(guard, snapshot, store, false);
					if (phase === 'answer' && record.decision.matchedRuleId) {
						const owner = snapshot.owners.find((owner) => owner.id === record.agentId)!;
						const allowed = decide(record.classification, store.readRules(), {
							agentId: record.agentId,
							tabId: record.tabId,
							projectPath: owner.cwd,
							groupId: owner.groupId,
						});
						if (
							allowed.action !== 'auto_answer' ||
							allowed.answer !== command ||
							allowed.matchedRuleId !== record.decision.matchedRuleId
						)
							throw new Error('Answer rule revoked during delivery');
					}
				},
				() => {},
				record.id
			);
		}
		const accepted = await callbacks.executeCommand(
			destination.agentId,
			command,
			'ai',
			destination.tabId,
			false,
			undefined,
			true,
			undefined,
			true,
			...(native ? [record.id] : [])
		);
		if (!accepted && native) pianolaNewTabSpawns.cancelHold(destination.agentId, destination.tabId);
		result = accepted
			? { status: 'accepted' }
			: { status: 'rejected', error: 'Renderer refused the decision message' };
	} catch {
		result = {
			status: 'unknown',
			error: 'Native delivery receipt unavailable; reconcile before retrying',
		};
	}
	// A manager may already have answered while its handoff receipt was in flight.
	const current = store.readDecisions().find((candidate) => candidate.id === record.id);
	if (
		current?.lifecycle?.phase === phase &&
		current.lifecycle.status !== 'done' &&
		current.lifecycle.status !== 'paused' &&
		(current.lifecycle.delivery === 'intent' || current.lifecycle.delivery === 'unknown') &&
		canonicalJson(current.lifecycle.source) === canonicalJson(record.lifecycle!.source)
	) {
		const judgment = phase === 'judgment';
		const humanRetry = phase === 'answer' && current.lifecycle.source.kind === 'human';
		const next = updatePianolaDecision(
			current,
			{
				delivery: result.status,
				status:
					result.status === 'accepted' && judgment
						? 'mira_processing'
						: result.status === 'rejected' && (judgment || humanRetry)
							? 'waiting_human'
							: 'blocked',
				nextActor:
					result.status === 'accepted'
						? judgment
							? 'manager'
							: 'recipient'
						: result.status === 'rejected' && (judgment || humanRetry)
							? 'human'
							: 'operator',
				nextAction:
					result.status === 'accepted'
						? judgment
							? 'The manager resolves this decision or escalates it to the human'
							: 'Wait for recipient activity; an accepted send is not execution evidence'
						: result.status === 'rejected' && judgment
							? 'The manager could not receive the ask; decide the original question'
							: result.status === 'rejected'
								? 'The renderer refused the answer; inspect the recipient before retrying'
								: 'Reconcile the native receipt or recipient transcript; do not resend',
				...(judgment && result.status === 'accepted' ? { deadlineAt: Date.now() + 60_000 } : {}),
			},
			new Date().toISOString()
		);
		await (store.appendDecisionAsync ?? store.appendDecision)({
			...next,
			dispatched: phase === 'answer' && result.status === 'accepted',
			...(result.status === 'accepted' ? {} : { error: result.error }),
		});
	}
	return result;
}

/** An initial rule reply or manager handoff is admitted against its durable worker intent. */
export async function deliverPianolaScopeDecision(
	callbacks: NativeCallbacks,
	rawGuard: unknown,
	command: string,
	judgment: boolean,
	store: DecisionStore = defaultStore
): Promise<PianolaScopeDeliveryResult> {
	const snapshot = pianolaScopeSnapshotFromDesktop({
		success: true,
		...callbacks.listDesktopSessions?.(),
	});
	const checked = validatePianolaScopeDelivery(rawGuard, snapshot, store);
	let record = checked.record;
	if (!record.lifecycle || !callbacks.executeCommand)
		throw new Error('Native decision lifecycle unavailable');
	const classification = currentAsk(callbacks, record);
	if (classification.risk === 'high')
		throw new Error('High-risk decisions require an explicit human answer');
	let destination = { agentId: record.agentId, tabId: record.tabId };
	if (judgment) {
		const manager = snapshot.owners.find((owner) => owner.id === checked.scope.managerAgentId);
		const managerTab = snapshot.tabs.find(
			(tab) =>
				tab.agentId === manager?.id && !tab.paused && !tab.busy && !tab.consult && !tab.ephemeral
		);
		if (!manager || manager.remote || !managerTab || manager.id === record.agentId)
			throw new Error('Configured manager has no eligible native tab');
		destination = { agentId: manager.id, tabId: managerTab.tabId };
		record = updatePianolaDecision(
			record,
			{ managerTabId: managerTab.tabId },
			new Date().toISOString()
		);
		await (store.appendDecisionAsync ?? store.appendDecision)(record);
	}
	// Metadata persistence may yield under contention. Admission must re-read
	// native membership and the asking turn after that wait.
	const admissionSnapshot = pianolaScopeSnapshotFromDesktop({
		success: true,
		...callbacks.listDesktopSessions?.(),
	});
	currentAsk(callbacks, record);
	admitPianolaScopeReply(rawGuard, command, admissionSnapshot, store, judgment);
	return sendClaimedDecision(callbacks, record, command, destination, store);
}

/** The actor is supplied by the native transport, never by an answer's text. */
export async function resolvePianolaDecision(
	callbacks: NativeCallbacks,
	raw: unknown,
	actor: PianolaDecisionActor,
	store: DecisionStore = defaultStore
): Promise<PianolaScopeDeliveryResult> {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw))
		throw new Error('Invalid decision resolution');
	const request = raw as Record<string, unknown>;
	if (
		typeof request.decisionId !== 'string' ||
		(typeof request.answer === 'string') === (typeof request.escalation === 'string')
	)
		throw new Error('Specify exactly one answer or concrete human escalation');
	const text = (request.answer ?? request.escalation) as string;
	if (!text.trim() || text.length > 8000)
		throw new Error('Decision text must contain 1-8000 characters');
	const record = store.readDecisions().find((candidate) => candidate.id === request.decisionId);
	const life = record?.lifecycle;
	if (!record || !life || record.dryRun || life.status === 'done' || life.acknowledgedAt)
		throw new Error('Decision is no longer pending');
	if (
		store
			.readDecisions()
			.some(
				(candidate) =>
					candidate.id !== record.id &&
					candidate.agentId === record.agentId &&
					candidate.tabId === record.tabId &&
					candidate.classification.evidence.messageId === life.guard.messageId &&
					!candidate.dryRun &&
					candidate.lifecycle?.delivery !== 'rejected' &&
					(candidate.dispatched || candidate.deliveryStatus === 'admitted')
			)
	)
		throw new Error('Another decision already claimed this ask');
	// An uncertain ANSWER can already be on the recipient. A judgment handoff
	// may be reconciled by a reply from the exact manager/tab it was sent to.
	if (
		life.phase === 'answer' &&
		life.delivery !== 'rejected' &&
		(record.deliveryStatus === 'admitted' || life.delivery !== 'not_sent')
	)
		throw new Error('Answer already claimed; reconcile delivery instead of resending');
	if (
		actor.kind === 'manager' &&
		(actor.agentId !== life.managerAgentId ||
			actor.tabId !== life.managerTabId ||
			life.phase !== 'judgment' ||
			life.status === 'waiting_human')
	)
		throw new Error('Only the assigned manager tab may resolve its pending handoff');
	const snapshot = pianolaScopeSnapshotFromDesktop({
		success: true,
		...callbacks.listDesktopSessions?.(),
	});
	const { checkpoint, saved, scope } = validatePianolaScopeDelivery(
		life.guard,
		snapshot,
		store,
		false
	);
	if (scope.managerAgentId !== life.managerAgentId) throw new Error('Decision manager changed');
	if (actor.kind === 'manager') {
		const managerTab = snapshot.tabs.find(
			(tab) => tab.agentId === actor.agentId && tab.tabId === actor.tabId
		);
		if (
			!managerTab ||
			managerTab.paused ||
			managerTab.consult ||
			managerTab.ephemeral ||
			snapshot.owners.find((owner) => owner.id === actor.agentId)?.remote !== false
		)
			throw new Error('Assigned manager tab is no longer eligible');
	}
	const classification = currentAsk(callbacks, record);
	if (
		actor.kind === 'manager' &&
		(classification.risk === 'high' || rateRisk(text) === 'high') &&
		request.answer !== undefined
	)
		throw new Error('Sensitive answers require the human');
	const now = new Date().toISOString();
	const source =
		actor.kind === 'manager'
			? { kind: 'manager' as const, actorId: actor.agentId, tabId: actor.tabId, timestamp: now }
			: { kind: 'human' as const, actorId: actor.actorId, timestamp: now };
	const groupId = snapshot.owners.find((owner) => owner.id === record.agentId)?.groupId ?? null;
	if (request.escalation !== undefined) {
		await (store.appendDecisionAsync ?? store.appendDecision)(
			updatePianolaDecision(
				{ ...record, decision: { action: 'escalate', matchedRuleId: null, reason: text } },
				{
					status: 'waiting_human',
					nextActor: 'human',
					nextAction: text,
					source,
					groupId,
				},
				now
			)
		);
		await callbacks.notifyToast?.({
			title: 'Pianola',
			message: text,
			color: classification.risk === 'high' ? 'red' : 'orange',
			dismissible: classification.risk === 'high',
			sessionId: record.agentId,
			tabId: record.tabId,
			sourceAgent: 'Pianola',
			clickAction: { kind: 'jump-session', sessionId: record.agentId, tabId: record.tabId },
		});
		return { status: 'accepted' };
	}
	if (!callbacks.executeCommand) throw new Error('Native send callback unavailable');
	const history = callbacks.getSessionHistory?.(record.tabId);
	const question = history?.messages.find((message) => message.id === life.guard.messageId);
	const owner = snapshot.owners.find((candidate) => candidate.id === record.agentId);
	const humanEvidence =
		actor.kind === 'human' &&
		actor.principal === 'owner' &&
		question &&
		question.content.trim() &&
		question.content.length <= 8000 &&
		Number.isFinite(Date.parse(question.timestamp)) &&
		owner?.groupId !== undefined
			? {
					version: 1 as const,
					sourceKind: 'native-human-resolution' as const,
					principal: 'owner' as const,
					actorId: actor.actorId,
					agentId: record.agentId,
					groupId: owner.groupId,
					tabId: record.tabId,
					questionMessageId: question.id,
					answerMessageId: generateUUID(),
					askedAt: question.timestamp,
					answeredAt: now,
					question: question.content,
					answer: text,
					action: null,
					conditions: null,
				}
			: undefined;
	const intent = updatePianolaDecision(
		{
			...record,
			classification,
			humanEvidence,
			decision: {
				action: 'auto_answer',
				answer: text,
				matchedRuleId: null,
				reason: actor.kind === 'manager' ? 'Controlled manager answer' : 'Explicit human answer',
			},
			dispatched: false,
			deliveryStatus: 'admitted',
		},
		{
			phase: 'answer',
			delivery: 'intent',
			status: 'blocked',
			nextActor: 'operator',
			nextAction: 'Await the native answer receipt',
			source,
			groupId,
		},
		now
	);
	// Evidence must never make an otherwise valid answer exceed the audit budget.
	if (Buffer.byteLength(JSON.stringify(intent), 'utf-8') > PIANOLA_DECISION_RECORD_MAX_BYTES)
		delete intent.humanEvidence;
	// No await between revalidation and the durable claim. Duplicate callbacks
	// see this claim before they can reach the renderer.
	store.appendDecision(intent);
	saved.unresolvedIntent = {
		decisionId: record.id,
		messageId: life.guard.messageId,
		admitted: true,
	};
	store.writeScopeCheckpoint(checkpoint);
	return sendClaimedDecision(
		callbacks,
		intent,
		text,
		{ agentId: record.agentId, tabId: record.tabId },
		store
	);
}
