/**
 * Pianola dashboard data.
 *
 * Combines the live signals Pianola has about the other agents - the desktop
 * session states (busy / waiting_input / idle), Pianola's own decision audit
 * log (escalations, handoffs, auto-answers), and the portfolio brief (programs,
 * founder asks, in-flight and verified plan tasks) - into what the dashboard
 * renders: what needs the user, what is working, what recently finished, what
 * is verified, and a feed of Pianola's recent decisions.
 *
 * Pure derivation lives in `deriveDashboard` (sessions + decisions) and
 * `derivePortfolio` / `deriveResults` (brief + asks + programs); the hook adds
 * the store subscription and the polled fetches. Every Pianola channel rejects
 * with 'PianolaDisabled' when the Encore flag is off, which we treat as "no
 * data" so the dashboard still shows live session state.
 */

import { useEffect, useMemo, useState } from 'react';
import { useSessionStore } from '../../stores/sessionStore';
import type { Session } from '../../types';
import type { PianolaDecisionRecord } from '../../../shared/pianola/storage';
import { compareNamesIgnoringEmojis } from '../../../shared/emojiUtils';
import type {
	PianolaAsk,
	PianolaAskSeverity,
	PianolaBrief,
	PianolaBriefItem,
	PianolaBriefProgram,
	PianolaBriefVerified,
	PianolaProgram,
} from '../../../shared/pianola/pianola-programs';

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
	/** Busy worktree children grouped under this parent, mirroring the Left Bar.
	 * Set on the parent's row in whichever bucket its own state places it. */
	worktreeChildren?: DashboardAgentRow[];
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
	// Top-level agents only (never the Pianola agent itself). Worktree children get
	// no row of their own here; busy ones are nested under their parent in the
	// Working bucket below, mirroring the Left Bar.
	const agents = sessions.filter((s) => !s.isPianola && !s.parentSessionId);
	const nameById = new Map(sessions.map((s) => [s.id, s.name] as const));
	const pianolaIds = new Set(sessions.filter((s) => s.isPianola).map((s) => s.id));

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

	// Busy worktree children grouped under their parent id (sorted by name so the
	// Dashboard mirrors the Left Bar's ordering). A parent is listed in whichever
	// bucket its own state places it, with these children nested beneath it.
	const busyChildrenByParent = new Map<string, Session[]>();
	for (const s of sessions) {
		if (!s.isPianola && s.parentSessionId && s.state === 'busy') {
			const siblings = busyChildrenByParent.get(s.parentSessionId);
			if (siblings) siblings.push(s);
			else busyChildrenByParent.set(s.parentSessionId, [s]);
		}
	}
	const childRowsFor = (parentId: string): DashboardAgentRow[] | undefined => {
		const kids = busyChildrenByParent.get(parentId);
		if (!kids || kids.length === 0) return undefined;
		return kids
			.slice()
			.sort((a, b) => compareNamesIgnoringEmojis(a.name, b.name))
			.map((c) => ({
				key: c.id,
				sessionId: c.id,
				agentName: c.name,
				description: activeTaskLabel(c, 'Working...'),
			}));
	};

	const needsInput: DashboardAgentRow[] = agents
		.filter((s) => s.state === 'waiting_input')
		.map((s) => {
			const latest = latestTopicByAgent.get(s.id);
			const worktreeChildren = childRowsFor(s.id);
			return {
				key: s.id,
				sessionId: s.id,
				agentName: s.name,
				description: latest?.topic ?? 'Waiting for your input',
				timestamp: latest?.timestamp,
				...(worktreeChildren ? { worktreeChildren } : {}),
			};
		});

	// Working now: busy top-level agents, plus any parent with busy worktree
	// children that is not itself waiting on the user. A waiting parent stays in
	// "Needs your input" (with its busy children nested there), so no agent is
	// listed in two buckets. Mirrors the Left Bar.
	const working: DashboardAgentRow[] = agents
		.filter(
			(s) => s.state === 'busy' || (s.state !== 'waiting_input' && busyChildrenByParent.has(s.id))
		)
		.map((s) => {
			const worktreeChildren = childRowsFor(s.id);
			const childCount = worktreeChildren?.length ?? 0;
			return {
				key: s.id,
				sessionId: s.id,
				agentName: s.name,
				description:
					s.state === 'busy'
						? activeTaskLabel(s, 'Working...')
						: `${childCount} worktree${childCount === 1 ? '' : 's'} working`,
				...(worktreeChildren ? { worktreeChildren } : {}),
			};
		});

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

	const activity: DashboardActivityRow[] = newestFirst
		.filter((d) => !pianolaIds.has(d.agentId))
		.map((d) => ({
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

/** An open founder ask, with what Pianola needs the user to decide. */
export interface DashboardAskRow {
	id: string;
	title: string;
	detail: string;
	severity: PianolaAskSeverity;
	requestedAction?: string;
	programTitle?: string;
	/** Agent that raised it, for click-to-jump. */
	agentId?: string;
	/** Epoch ms the ask was opened. */
	since: number;
}

/** A non-ask item from the brief's needsMe list (escalation, review, failure). */
export interface DashboardNeedsRow {
	key: string;
	kind: Exclude<PianolaBriefItem['kind'], 'ask'>;
	title: string;
	detail?: string;
	programTitle?: string;
	since: number;
}

/** A verified plan task: done, with a passed independent-validation check. */
export interface DashboardResultRow {
	key: string;
	taskTitle: string;
	planTitle: string;
	checkName: string;
	/** Epoch ms the proving check completed. */
	completedAt: number;
}

/** Rows of one program. `programTitle` is absent for rows outside any program. */
export interface DashboardProgramGroup<T> {
	key: string;
	programTitle?: string;
	rows: T[];
}

export interface PortfolioData {
	/** The program strip, straight from the brief. */
	programs: PianolaBriefProgram[];
	/** Open founder asks, most severe first, then oldest first. */
	asks: DashboardAskRow[];
	escalations: DashboardNeedsRow[];
	needsReview: DashboardNeedsRow[];
	failed: DashboardNeedsRow[];
	working: DashboardProgramGroup<DashboardAgentRow>[];
	finished: DashboardProgramGroup<DashboardAgentRow>[];
	results: DashboardProgramGroup<DashboardResultRow>[];
}

export interface PortfolioSnapshot {
	brief: PianolaBrief | null;
	asks: readonly PianolaAsk[];
	programs: readonly PianolaProgram[];
}

const SEVERITY_RANK: Record<PianolaAskSeverity, number> = {
	critical: 0,
	high: 1,
	medium: 2,
	low: 3,
};

/** A row tagged with the program it belongs to, ready for `groupByProgram`. */
interface ProgramTagged<T> {
	row: T;
	programId?: string;
	/** Title carried by the source item, used when no program record names it. */
	programTitle?: string;
}

/**
 * Bucket rows by program: one group per program (ordered by title, ignoring
 * leading emojis), then rows outside any program last, untitled. Input order is
 * kept within each group.
 */
function groupByProgram<T>(
	items: readonly ProgramTagged<T>[],
	titleById: ReadonlyMap<string, string>
): DashboardProgramGroup<T>[] {
	const byProgram = new Map<string, DashboardProgramGroup<T>>();
	const loose: T[] = [];
	for (const { row, programId, programTitle } of items) {
		if (programId === undefined) {
			loose.push(row);
			continue;
		}
		const group = byProgram.get(programId);
		if (group) group.rows.push(row);
		else
			byProgram.set(programId, {
				key: programId,
				programTitle: titleById.get(programId) ?? programTitle ?? programId,
				rows: [row],
			});
	}
	const groups = [...byProgram.values()].sort((a, b) =>
		compareNamesIgnoringEmojis(a.programTitle ?? '', b.programTitle ?? '')
	);
	if (loose.length > 0) groups.push({ key: 'no-program', rows: loose });
	return groups;
}

/** Program titles by id, from the program records (brief strip, then full list). */
function programTitles(snapshot: PortfolioSnapshot): Map<string, string> {
	const titles = new Map<string, string>();
	for (const p of snapshot.brief?.programs ?? []) titles.set(p.id, p.title);
	for (const p of snapshot.programs) titles.set(p.id, p.title);
	return titles;
}

/**
 * Verified tasks grouped by program, newest first within each program. Reads
 * only the brief's `verified` list: a task counts as verified when the backend
 * says so (done + passed independent-validation check), never from plan status.
 */
export function deriveResults(
	verified: readonly PianolaBriefVerified[],
	titleById: ReadonlyMap<string, string> = new Map()
): DashboardProgramGroup<DashboardResultRow>[] {
	const rows = verified.map((v) => ({
		row: {
			key: `${v.planId}:${v.taskId}`,
			taskTitle: v.taskTitle,
			planTitle: v.planTitle,
			checkName: v.checkName,
			completedAt: ms(v.completedAt),
		},
		programId: v.programId,
		programTitle: v.programTitle,
	}));
	rows.sort((a, b) => b.row.completedAt - a.row.completedAt);
	return groupByProgram(rows, titleById);
}

/**
 * Pure derivation of the portfolio view from the brief, the open asks, and the
 * programs, layered over the session-based buckets from `deriveDashboard`.
 * Plan tasks in flight replace their agent's plain session row in Working, and
 * session rows join the program their agent is the lead or a role of.
 */
export function derivePortfolio(
	dashboard: DashboardData,
	snapshot: PortfolioSnapshot,
	sessions: readonly Session[]
): PortfolioData {
	const brief = snapshot.brief;
	const titleById = programTitles(snapshot);
	const nameById = new Map(sessions.map((s) => [s.id, s.name] as const));

	// Which program each agent works for, from the lead and the role assignments.
	const programByAgent = new Map<string, string>();
	for (const p of snapshot.programs) {
		if (p.leadAgentId) programByAgent.set(p.leadAgentId, p.id);
		for (const role of Object.values(p.roles)) {
			if (role.agentId) programByAgent.set(role.agentId, p.id);
		}
	}

	const asks: DashboardAskRow[] = snapshot.asks
		.filter((a) => a.status === 'open')
		.map((a) => ({
			id: a.id,
			title: a.title,
			detail: a.detail,
			severity: a.severity,
			requestedAction: a.requestedAction,
			programTitle: a.programId ? (titleById.get(a.programId) ?? a.programId) : undefined,
			agentId: a.agentId,
			since: ms(a.createdAt),
		}))
		.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.since - b.since);

	const needsOf = (kind: DashboardNeedsRow['kind']): DashboardNeedsRow[] =>
		(brief?.needsMe ?? [])
			.filter((item) => item.kind === kind)
			.map((item) => ({
				key: `${item.kind}:${item.id}`,
				kind,
				title: item.title,
				detail: item.detail,
				programTitle: item.programId
					? (titleById.get(item.programId) ?? (item.programTitle || item.programId))
					: undefined,
				since: ms(item.since),
			}))
			.sort((a, b) => a.since - b.since);

	// Working: each in-flight plan task becomes a row on its agent (carrying the
	// agent's busy worktree children), replacing that agent's plain session row.
	const inFlight = brief?.inFlight ?? [];
	const sessionRowById = new Map(dashboard.working.map((r) => [r.sessionId, r] as const));
	const taskAgents = new Set(inFlight.flatMap((t) => (t.agentId ? [t.agentId] : [])));
	const taskRows: ProgramTagged<DashboardAgentRow>[] = inFlight.map((t) => {
		const agentName = t.agentId ? nameById.get(t.agentId) : undefined;
		const fixing = t.status === 'fixing' ? ' · fixing' : '';
		const worktreeChildren = t.agentId
			? sessionRowById.get(t.agentId)?.worktreeChildren
			: undefined;
		return {
			row: {
				key: `task:${t.planId}:${t.taskId}`,
				sessionId: agentName ? t.agentId : undefined,
				agentName: agentName ?? t.taskTitle,
				description: `${agentName ? `${t.taskTitle} · ` : ''}${t.planTitle}${fixing}`,
				timestamp: t.since ? ms(t.since) : undefined,
				...(worktreeChildren ? { worktreeChildren } : {}),
			},
			programId: t.programId ?? (t.agentId ? programByAgent.get(t.agentId) : undefined),
			programTitle: t.programTitle,
		};
	});
	const sessionRows = (rows: readonly DashboardAgentRow[]): ProgramTagged<DashboardAgentRow>[] =>
		rows.map((row) => ({
			row,
			programId: row.sessionId ? programByAgent.get(row.sessionId) : undefined,
		}));

	const looseWorking = dashboard.working.filter(
		(r) => !(r.sessionId && taskAgents.has(r.sessionId))
	);
	const working = groupByProgram([...taskRows, ...sessionRows(looseWorking)], titleById);
	const finished = groupByProgram(sessionRows(dashboard.recentlyDone), titleById);

	return {
		programs: brief?.programs ?? [],
		asks,
		escalations: needsOf('escalation'),
		needsReview: needsOf('needs_review'),
		failed: needsOf('failed'),
		working,
		finished,
		results: deriveResults(brief?.verified ?? [], titleById),
	};
}

const POLL_MS = 4000;
const DECISION_LIMIT = 50;
const EMPTY_SNAPSHOT: PortfolioSnapshot = { brief: null, asks: [], programs: [] };

/**
 * Live dashboard data. Subscribes to the session store and polls the Pianola
 * decision log plus the portfolio (brief, open asks, programs). `refresh`
 * forces an immediate refetch.
 */
export function usePianolaDashboardData(): {
	data: DashboardData;
	portfolio: PortfolioData;
	refresh: () => void;
} {
	const sessions = useSessionStore((s) => s.sessions);
	const [decisions, setDecisions] = useState<PianolaDecisionRecord[]>([]);
	const [snapshot, setSnapshot] = useState<PortfolioSnapshot>(EMPTY_SNAPSHOT);
	const [nonce, setNonce] = useState(0);

	useEffect(() => {
		let cancelled = false;
		const { pianola } = window.maestro;
		const load = async (): Promise<void> => {
			// Settled independently: 'PianolaDisabled' or a transient IPC error on one
			// channel empties only that slice, so live session state always shows.
			const [records, brief, asks, programs] = await Promise.allSettled([
				pianola.getDecisions(DECISION_LIMIT),
				pianola.getBrief(),
				pianola.getAsks('open'),
				pianola.getPrograms(),
			]);
			if (cancelled) return;
			setDecisions(records.status === 'fulfilled' ? records.value : []);
			setSnapshot({
				brief: brief.status === 'fulfilled' ? brief.value : null,
				asks: asks.status === 'fulfilled' ? asks.value : [],
				programs: programs.status === 'fulfilled' ? programs.value : [],
			});
		};
		void load();
		const timer = setInterval(load, POLL_MS);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, [nonce]);

	const data = useMemo(() => deriveDashboard(sessions, decisions), [sessions, decisions]);
	const portfolio = useMemo(
		() => derivePortfolio(data, snapshot, sessions),
		[data, snapshot, sessions]
	);
	return { data, portfolio, refresh: () => setNonce((n) => n + 1) };
}
