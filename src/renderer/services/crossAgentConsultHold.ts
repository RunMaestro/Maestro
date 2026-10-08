/**
 * crossAgentConsultHold - a turn that consults another agent does not finish
 * until the consult has answered.
 *
 * A message that `@mentions` another agent mid-sentence ("work with @Backend on
 * this") is answered by BOTH agents: the mentioned one through a consult, and
 * this one through its own turn. The two used to run blind to each other - the
 * local turn never learned a consult was running, wrote its final answer alone
 * (once concluding the mentioned agent did not exist and redoing its work by
 * hand), and the reply streamed into the transcript after the fact where the
 * local agent never saw it.
 *
 * The contract now has two halves, both enforced by Maestro rather than left to
 * the agent's good behaviour:
 *
 * 1. The local turn starts at once, in parallel with the consult, carrying an
 *    agent-only note (`cross-agent-consult-pending`): the consult is already
 *    running, do your share of the work, do NOT write the final answer yet.
 * 2. A HOLD item goes to the head of the execution queue, marked
 *    `awaitingConsult`. It is a barrier for its tab: not runnable itself, and no
 *    later item for that tab may overtake it, so nothing the user queues there
 *    can slip in between the turn and its conclusion. As each consult settles
 *    its reply is recorded on the hold; when the last one lands the hold becomes
 *    an ordinary message carrying every reply verbatim (`agentContext`, wrapped
 *    in `cross-agent-consult-reply`), and the queue drain delivers it as the
 *    continuation in which the agent writes its final answer.
 *
 * Settlement is keyed on (source agent, source tab, target agent) - fields every
 * response chunk carries - rather than a request id, so a hold still settles
 * after a web-desktop reload drops the renderer's request bookkeeping. A
 * consult the user STOPPED removes the hold: Stop means stop, and a
 * continuation that resumed the conversation anyway would ignore it.
 */

import type {
	AITab,
	ConsultHold,
	ConsultHoldReply,
	ConsultHoldTarget,
	QueuedItem,
	Session,
} from '../types';
import { useSessionStore, updateSessionWith } from '../stores/sessionStore';
import { getTabDisplayName } from '../utils/tabHelpers';
import { captureQueuedTurnSettings } from '../utils/providerTabSessions';
import { generateId } from '../utils/ids';

// ============================================================================
// Prompts
// ============================================================================

let pendingNoteTemplate = '';
let replyTemplate = '';
let consultPromptsLoaded = false;

/** Load both consult prompts (editable in Settings -> Maestro Prompts). */
export async function loadCrossAgentConsultPrompts(force = false): Promise<void> {
	if (consultPromptsLoaded && !force) return;
	const [pending, reply] = await Promise.all([
		window.maestro.prompts.get('cross-agent-consult-pending'),
		window.maestro.prompts.get('cross-agent-consult-reply'),
	]);
	if (!pending.success) {
		throw new Error(`Failed to load cross-agent-consult-pending prompt: ${pending.error}`);
	}
	if (!reply.success) {
		throw new Error(`Failed to load cross-agent-consult-reply prompt: ${reply.error}`);
	}
	pendingNoteTemplate = pending.content!;
	replyTemplate = reply.content!;
	consultPromptsLoaded = true;
}

// ============================================================================
// Pure helpers
// ============================================================================

/** "A", "A and B", "A, B and C". */
export function formatConsultedAgentNames(names: string[]): string {
	if (names.length <= 1) return names[0] ?? 'another agent';
	return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/** The agent-only note appended to the local turn's prompt. */
export function buildConsultPendingNote(template: string, names: string[]): string {
	return template.split('{{CONSULTED_AGENTS}}').join(formatConsultedAgentNames(names));
}

/**
 * Append the pending note to a prompt about to be spawned. A no-op when the
 * prompt has not loaded (a test harness, a bridge-less window) rather than
 * sending a note with its placeholders still in it.
 */
export function withConsultPendingNote(prompt: string, targets: ConsultHoldTarget[]): string {
	if (targets.length === 0 || !pendingNoteTemplate) return prompt;
	const note = buildConsultPendingNote(
		pendingNoteTemplate,
		targets.map((t) => t.targetAgentName)
	);
	return `${prompt}\n\n---\n\n${note}`;
}

/** Every reply, verbatim, under a heading naming who said it. */
export function formatConsultReplies(replies: ConsultHoldReply[]): string {
	return replies
		.map((reply) => {
			if (!reply.error) return `### Reply from ${reply.targetAgentName}\n\n${reply.text}`;
			const partial = reply.text ? `\n\nPartial reply before it stopped:\n\n${reply.text}` : '';
			return `### ${reply.targetAgentName} could not respond\n\n${reply.error}${partial}`;
		})
		.join('\n\n');
}

/** The agent-only context a released hold carries into its spawn. */
export function buildConsultReplyContext(template: string, replies: ConsultHoldReply[]): string {
	const body = formatConsultReplies(replies);
	if (!template) return body;
	return template.split('{{CONSULT_REPLIES}}').join(body);
}

/** What the hold reads as in the queue while it waits. */
export function consultHoldWaitingText(targets: ConsultHoldTarget[]): string {
	const names = formatConsultedAgentNames(targets.map((t) => t.targetAgentName));
	return `Waiting for ${names} to reply before finishing this answer.`;
}

/**
 * What the released hold reads as - in the queue, and as the user bubble once it
 * runs. The replies themselves are NOT repeated here: they already sit in the
 * transcript as the consult's own bubble, and ride to the agent in `agentContext`.
 */
export function consultHoldReleasedText(replies: ConsultHoldReply[]): string {
	const answered = replies.filter((r) => !r.error).map((r) => r.targetAgentName);
	const failed = replies.filter((r) => r.error).map((r) => r.targetAgentName);
	const parts: string[] = [];
	if (answered.length > 0) {
		parts.push(`${formatConsultedAgentNames(answered)} replied.`);
	}
	if (failed.length > 0) {
		parts.push(`${formatConsultedAgentNames(failed)} could not respond.`);
	}
	parts.push('Finish your answer with what came back.');
	return parts.join(' ');
}

/** Build the hold item for one source tab. */
export function buildConsultHoldItem(opts: {
	session: Session;
	tab: AITab;
	targets: ConsultHoldTarget[];
}): QueuedItem {
	const { session, tab, targets } = opts;
	return {
		id: generateId(),
		timestamp: Date.now(),
		tabId: tab.id,
		type: 'message',
		text: consultHoldWaitingText(targets),
		tabName: getTabDisplayName(tab, session.agentSessionId),
		readOnlyMode: tab.readOnlyMode === true || tab.permissionMode === 'readonly',
		turnSettings: captureQueuedTurnSettings(tab, session),
		awaitingConsult: { pending: [...targets], replies: [] },
	};
}

/** One consult reaching its end, as reported by a terminal response chunk. */
export interface ConsultSettlement {
	sourceSessionId: string;
	sourceTabId: string;
	targetSessionId: string;
	targetAgentName?: string;
	text: string;
	error?: string;
	canceled?: boolean;
}

/**
 * Record one settled consult on the matching hold in `queue`. Returns the queue
 * unchanged (same reference) when no hold is waiting on this target, which makes
 * settling idempotent - a consult that settles twice, or one that was never
 * held (a `maestro-cli ask`, a leading mention), changes nothing.
 *
 * - canceled: the hold is removed. The user pressed Stop.
 * - otherwise: the reply moves from `pending` to `replies`; once nothing is
 *   pending the hold is released into a runnable continuation.
 */
export function settleConsultInQueue(
	queue: QueuedItem[],
	settlement: ConsultSettlement,
	template: string
): QueuedItem[] {
	const index = queue.findIndex(
		(item) =>
			item.tabId === settlement.sourceTabId &&
			!!item.awaitingConsult?.pending.some((p) => p.targetSessionId === settlement.targetSessionId)
	);
	if (index < 0) return queue;

	if (settlement.canceled) {
		return [...queue.slice(0, index), ...queue.slice(index + 1)];
	}

	const item = queue[index];
	const hold = item.awaitingConsult as ConsultHold;
	const target = hold.pending.find((p) => p.targetSessionId === settlement.targetSessionId)!;
	const reply: ConsultHoldReply = {
		targetSessionId: target.targetSessionId,
		targetAgentName: target.targetAgentName || settlement.targetAgentName || 'another agent',
		text: settlement.text,
		...(settlement.error ? { error: settlement.error } : {}),
	};
	const pending = hold.pending.filter((p) => p.targetSessionId !== settlement.targetSessionId);
	const replies = [...hold.replies, reply];

	let next: QueuedItem;
	if (pending.length > 0) {
		next = { ...item, awaitingConsult: { pending, replies } };
	} else {
		const { awaitingConsult: _released, ...rest } = item;
		next = {
			...rest,
			text: consultHoldReleasedText(replies),
			agentContext: buildConsultReplyContext(template, replies),
		};
	}
	return queue.map((q, i) => (i === index ? next : q));
}

/** Why a consult that was still running at shutdown never answered. */
export const CONSULT_INTERRUPTED_BY_RESTART =
	'The consult was interrupted: Maestro restarted before this agent replied.';

/**
 * Settle every still-pending consult in `queue` as interrupted. For a cold
 * start of the desktop app, where no consult process survived: a hold left
 * waiting would block its tab forever. Releasing it instead hands the agent
 * whatever DID come back plus an honest note about what did not, so it can
 * still finish its answer. Returns the queue unchanged (same reference) when
 * nothing is held.
 */
export function interruptConsultHolds(
	queue: QueuedItem[],
	template: string = replyTemplate
): QueuedItem[] {
	let next = queue;
	for (const item of queue) {
		for (const target of item.awaitingConsult?.pending ?? []) {
			next = settleConsultInQueue(
				next,
				{
					sourceSessionId: '',
					sourceTabId: item.tabId,
					targetSessionId: target.targetSessionId,
					text: '',
					error: CONSULT_INTERRUPTED_BY_RESTART,
				},
				template
			);
		}
	}
	return next;
}

// ============================================================================
// Store-bound
// ============================================================================

/**
 * Resolve the consulted agents' display names from the live store. A target
 * that no longer exists keeps its id with a placeholder name: its consult will
 * still settle (as an error), and the hold must be waiting on it to release.
 */
export function resolveConsultTargets(targetSessionIds: string[]): ConsultHoldTarget[] {
	const sessions = useSessionStore.getState().sessions;
	return targetSessionIds.map((targetSessionId) => ({
		targetSessionId,
		targetAgentName: sessions.find((s) => s.id === targetSessionId)?.name ?? 'another agent',
	}));
}

/**
 * Put a hold for `tabId` at the head of the agent's queue. Called as the turn
 * dispatches, so everything already in the queue was queued AFTER this turn and
 * belongs behind its conclusion.
 */
export function holdTurnForConsults(
	sessionId: string,
	tabId: string,
	targets: ConsultHoldTarget[]
): void {
	if (targets.length === 0) return;
	updateSessionWith(sessionId, (session) => {
		const tab = session.aiTabs.find((t) => t.id === tabId);
		if (!tab) return session;
		const hold = buildConsultHoldItem({ session, tab, targets });
		return { ...session, executionQueue: [hold, ...(session.executionQueue ?? [])] };
	});
}

/** Record a settled consult on the source agent's queue (no-op when not held). */
export function settleConsultHold(settlement: ConsultSettlement): void {
	const session = useSessionStore
		.getState()
		.sessions.find((s) => s.id === settlement.sourceSessionId);
	if (!session) return;
	const queue = session.executionQueue ?? [];
	if (settleConsultInQueue(queue, settlement, replyTemplate) === queue) return;
	// Re-run inside the updater against the live queue, so a concurrent write
	// between the probe above and this update cannot be overwritten.
	updateSessionWith(settlement.sourceSessionId, (s) => {
		const executionQueue = settleConsultInQueue(s.executionQueue ?? [], settlement, replyTemplate);
		return executionQueue === s.executionQueue ? s : { ...s, executionQueue };
	});
}
