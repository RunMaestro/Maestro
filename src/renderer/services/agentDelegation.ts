/**
 * agentDelegation - mark an agent's own hand-offs in its transcript.
 *
 * When an agent runs `maestro-cli dispatch` or `maestro-cli ask` from its shell,
 * the conversation that did it gets a pill naming the agent the work or question
 * went to - the same fact a typed `@mention` shows through its reply's
 * attribution header. How the caller and its tab are identified in the first
 * place is described in `src/shared/agentDelegation.ts`.
 *
 * The entry is a self-contained card (`isSelfContainedCard`), so streamed agent
 * output that arrives after it starts a new entry instead of being appended to
 * the pill. It raises no unread and moves no focus: it records what the agent
 * did, it does not ask for attention.
 */

import { updateAiTab, useSessionStore } from '../stores/sessionStore';
import { getActiveTab } from '../utils/tabHelpers';
import { generateId } from '../utils/ids';
import { truncateText } from '../../shared/formatters';
import type { AgentDelegationNotice } from '../../shared/agentDelegation';
import type { AITab, LogEntry, Session } from '../types';

type DelegationRecord = NonNullable<LogEntry['delegation']>;

/** Where a recorded pill lives, so an `ask` can settle it when the answer lands. */
export interface DelegationEntryRef {
	sessionId: string;
	tabId: string;
	entryId: string;
}

/** How a pending `ask` ended. */
export interface DelegationOutcome {
	status: 'done' | 'error' | 'canceled';
	error?: string;
	/** The consult tab that holds the exchange, learned only once it completes. */
	toTabId?: string;
}

/** One line is enough; the full prompt is already in the tool card that ran the command. */
const DELEGATION_SUBJECT_MAX_CHARS = 120;

/**
 * The tab whose turn ran the command.
 *
 * A named tab is authoritative: if it has since closed, the conversation that
 * delegated is gone and the pill has nowhere true to go, so nothing is returned
 * rather than guessing a different tab. Without a name (a shell spawned before
 * the identity was stamped, or an explicit `ask --from`), the command ran during
 * a turn, so a lone busy tab is the one that ran it; failing that, the active tab.
 */
export function resolveDelegationSourceTab(
	session: Session,
	fromTabId?: string
): AITab | undefined {
	if (fromTabId) return session.aiTabs.find((tab) => tab.id === fromTabId);
	const busy = session.aiTabs.filter((tab) => tab.state === 'busy');
	if (busy.length === 1) return busy[0];
	return getActiveTab(session) ?? undefined;
}

/** Pure: the transcript entry for one hand-off. Exported for unit testing. */
export function buildDelegationLogEntry(
	notice: AgentDelegationNotice,
	target: Pick<Session, 'id' | 'name' | 'toolType'>,
	status?: DelegationRecord['status']
): LogEntry {
	const subject = truncateText(
		notice.prompt.replace(/\s+/g, ' ').trim(),
		DELEGATION_SUBJECT_MAX_CHARS
	);
	const delegation: DelegationRecord = {
		kind: notice.kind,
		toSessionId: target.id,
		...(notice.targetTabId ? { toTabId: notice.targetTabId } : {}),
		toAgentName: target.name,
		toToolType: target.toolType,
		subject,
		...(notice.newTab ? { newTab: true } : {}),
		...(notice.queued ? { queued: true } : {}),
		...(status ? { status } : {}),
	};
	const verb = notice.kind === 'ask' ? 'Asked' : 'Delegated to';
	return {
		id: generateId(),
		timestamp: Date.now(),
		source: 'system',
		// Plain-text fallback, and what cross-tab search matches on.
		text: subject ? `${verb} ${target.name}: ${subject}` : `${verb} ${target.name}`,
		delegation,
	};
}

/**
 * Append a hand-off pill to the caller's transcript. Pass `pending` for an `ask`
 * that is still waiting on its answer. Returns where the pill landed, or null
 * when the caller, its tab, or the target no longer exists.
 */
export function recordAgentDelegation(
	notice: AgentDelegationNotice,
	options: { pending?: boolean } = {}
): DelegationEntryRef | null {
	const { sessions } = useSessionStore.getState();
	const caller = sessions.find((s) => s.id === notice.fromSessionId);
	const target = sessions.find((s) => s.id === notice.targetSessionId);
	if (!caller || !target) return null;
	const tab = resolveDelegationSourceTab(caller, notice.fromTabId);
	if (!tab) return null;

	const entry = buildDelegationLogEntry(notice, target, options.pending ? 'pending' : undefined);
	updateAiTab(caller.id, tab.id, (t) => ({ ...t, logs: [...t.logs, entry] }));
	return { sessionId: caller.id, tabId: tab.id, entryId: entry.id };
}

/** Settle a pending `ask` pill once its consult ends. No-op if the tab or entry is gone. */
export function settleAgentDelegation(ref: DelegationEntryRef, outcome: DelegationOutcome): void {
	updateAiTab(ref.sessionId, ref.tabId, (tab) => {
		const index = tab.logs.findIndex((log) => log.id === ref.entryId);
		const entry = index === -1 ? undefined : tab.logs[index];
		if (!entry?.delegation) return tab;
		const logs = tab.logs.slice();
		logs[index] = {
			...entry,
			delegation: {
				...entry.delegation,
				status: outcome.status,
				...(outcome.error ? { error: outcome.error } : {}),
				...(outcome.toTabId ? { toTabId: outcome.toTabId } : {}),
			},
		};
		return { ...tab, logs };
	});
}
