/**
 * Pianola dashboard data.
 *
 * Combines the two live signals Pianola has about the other agents - the desktop
 * session states (busy / waiting_input / idle) and Pianola's own decision audit
 * log (escalations, handoffs, auto-answers) - into the four buckets the dashboard
 * renders: agents that need the user, agents working now, agents recently done,
 * and a feed of Pianola's recent decisions.
 *
 * Pure derivation lives in `deriveDashboard`; the hook adds the store
 * subscription and the polled decision fetch. The decision channel rejects with
 * 'PianolaDisabled' when the Encore flag is off, which we treat as "no
 * decisions" so the dashboard still shows live session state.
 */

import { useEffect, useMemo, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import type { Session } from '../../types';
import type { PianolaDecisionRecord } from '../../../shared/pianola/storage';

/** A row in one of the agent-status sections. */
export interface DashboardAgentRow {
	key: string;
	/** Owning agent id, for click-to-jump (omitted for a closed/unknown agent). */
	sessionId?: string;
	agentName: string;
	/** What the agent is doing / waiting on / last did. */
	description: string;
	/** Epoch ms of the relevant moment, when known. */
	timestamp?: number;
}

/** A row in the recent-activity feed. */
export interface DashboardActivityRow {
	id: string;
	sessionId?: string;
	agentName: string;
	/** Display action; 'handoff' is split out from the underlying escalate record. */
	action: 'auto_answer' | 'escalate' | 'ignore' | 'handoff';
	topic: string;
	timestamp: number;
	dispatched: boolean;
}

export interface DashboardData {
	needsInput: DashboardAgentRow[];
	working: DashboardAgentRow[];
	recentlyDone: DashboardAgentRow[];
	activity: DashboardActivityRow[];
}

/** Resolve an agent's display name, falling back to a short id for closed agents. */
function agentNameFor(sessionId: string, nameById: Map<string, string>): string {
	return nameById.get(sessionId) ?? `Agent ${sessionId.slice(0, 6)}`;
}

/** The agent's current task label: its active tab name, else a generic verb. */
function activeTaskLabel(session: Session, fallback: string): string {
	const tab = session.aiTabs?.find((t) => t.id === session.activeTabId) ?? session.aiTabs?.[0];
	const name = tab?.name?.trim();
	return name && name.length > 0 ? name : fallback;
}

/** ISO timestamp -> epoch ms (NaN-safe: unparseable strings sort last). */
function ms(iso: string): number {
	const t = new Date(iso).getTime();
	return Number.isFinite(t) ? t : 0;
}

/** Whether an escalate record is actually a handoff to Pianola (vs. to the user). */
function isHandoff(record: PianolaDecisionRecord): boolean {
	return record.decision.action === 'escalate' && /handed off/i.test(record.decision.reason);
}

/**
 * Pure derivation of the four dashboard buckets from sessions + decisions. Kept
 * separate from the hook so it is trivially testable.
 */
export function deriveDashboard(
	sessions: readonly Session[],
	decisions: readonly PianolaDecisionRecord[]
): DashboardData {
	// Real agents only: never the Pianola agent itself, never worktree children
	// (they show under their parent in the Left Bar; listing them here is noise).
	const agents = sessions.filter((s) => !s.isPianola && !s.parentSessionId);
	const nameById = new Map(sessions.map((s) => [s.id, s.name] as const));

	// Newest first. The audit log is stored oldest-last, so reverse a shallow copy.
	const newestFirst = [...decisions].sort((a, b) => ms(b.timestamp) - ms(a.timestamp));

	// Latest decision topic per agent, for enriching the agent rows.
	const latestTopicByAgent = new Map<string, { topic: string; timestamp: number }>();
	for (const d of newestFirst) {
		if (!latestTopicByAgent.has(d.agentId)) {
			latestTopicByAgent.set(d.agentId, {
				topic: d.classification.topic,
				timestamp: ms(d.timestamp),
			});
		}
	}

	const needsInput: DashboardAgentRow[] = agents
		.filter((s) => s.state === 'waiting_input')
		.map((s) => {
			const latest = latestTopicByAgent.get(s.id);
			return {
				key: s.id,
				sessionId: s.id,
				agentName: s.name,
				description: latest?.topic ?? 'Waiting for your input',
				timestamp: latest?.timestamp,
			};
		});

	const working: DashboardAgentRow[] = agents
		.filter((s) => s.state === 'busy')
		.map((s) => ({
			key: s.id,
			sessionId: s.id,
			agentName: s.name,
			description: activeTaskLabel(s, 'Working...'),
		}));

	// Recently done: idle agents Pianola has actually worked with (they appear in
	// the decision log), so we do not list every dormant agent as "done". Sorted
	// by their most recent decision.
	const busyOrWaiting = new Set([...needsInput, ...working].map((r) => r.sessionId));
	const recentlyDone: DashboardAgentRow[] = agents
		.filter((s) => s.state === 'idle' && latestTopicByAgent.has(s.id) && !busyOrWaiting.has(s.id))
		.map((s) => {
			const latest = latestTopicByAgent.get(s.id)!;
			return {
				key: s.id,
				sessionId: s.id,
				agentName: s.name,
				description: latest.topic,
				timestamp: latest.timestamp,
			};
		})
		.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));

	const activity: DashboardActivityRow[] = newestFirst.map((d) => ({
		id: d.id + (d.dispatched ? ':done' : ':intent'),
		sessionId: nameById.has(d.agentId) ? d.agentId : undefined,
		agentName: agentNameFor(d.agentId, nameById),
		action: isHandoff(d) ? 'handoff' : d.decision.action,
		topic: d.classification.topic,
		timestamp: ms(d.timestamp),
		dispatched: d.dispatched,
	}));

	return { needsInput, working, recentlyDone, activity };
}

const POLL_MS = 4000;
const DECISION_LIMIT = 50;

/**
 * Live dashboard data. Subscribes to the session store and polls the Pianola
 * decision log. `refresh` forces an immediate refetch.
 */
export function usePianolaDashboardData(): { data: DashboardData; refresh: () => void } {
	const sessions = useSessionStore((s) => s.sessions);
	const [decisions, setDecisions] = useState<PianolaDecisionRecord[]>([]);
	const [nonce, setNonce] = useState(0);

	useEffect(() => {
		let cancelled = false;
		const load = async (): Promise<void> => {
			try {
				const records = await window.maestro.pianola.getDecisions(DECISION_LIMIT);
				if (!cancelled) setDecisions(records);
			} catch {
				// 'PianolaDisabled' or transient IPC error: keep showing live session
				// state with no decision history rather than surfacing an error.
				if (!cancelled) setDecisions([]);
			}
		};
		void load();
		const timer = setInterval(load, POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [nonce]);

	const data = useMemo(() => deriveDashboard(sessions, decisions), [sessions, decisions]);
	return { data, refresh: () => setNonce((n) => n + 1) };
}
