/**
 * Payload shapes for the Usage Dashboard reads `maestro-cli` reaches over the
 * WebSocket bridge (`stats-delegation`, `stats-activity`, `stats-agents`,
 * `stats-plan-usage`), plus the pure builders behind them.
 *
 * The main process fills these from the same stores and queries the dashboard
 * panels read (`src/main/stats/usage-dashboard-reads.ts`). They live here,
 * electron-free, because the CLI bundle types its responses against them and
 * cannot import main-process modules.
 */

import type {
	AutoRunSession,
	AutoRunTurnsByHour,
	ResilienceEvent,
	ShortcutUsageByShortcut,
	ShortcutUsageDay,
	StatsTimeRange,
	WizardRun,
} from './stats-types';
import type { DelegationDay, DelegationTotals } from './delegation';
import type { AgentCountTimeline } from './agentCountTimeline';
import { fillDaySeries } from './daySeries';
import { computeAutoRunMetrics, isDocumentAutoRun, isFinishedAutoRun } from './autoRunMetrics';
import { toLocalYmd } from './localDay';

import { usageReadWindow, type UsageReadWindow } from './statsTimeRange';

export { usageReadWindow, type UsageReadWindow };

// ============================================================================
// Delegation (Overview delegation score, Activity delegation trend)
// ============================================================================

export interface DelegationStats {
	range: StatsTimeRange;
	window: UsageReadWindow;
	/** Interactive turns vs Auto Run tasks vs Cue runs for the whole range. */
	totals: DelegationTotals;
	/** Delegated share of tracked time, 0-100 (`delegationPercent`). */
	percent: number;
	/** The same split per local day, GAP-FILLED over `window`. */
	byDay: DelegationDay[];
}

function emptyDelegationDay(date: string): DelegationDay {
	return {
		date,
		interactive: { count: 0, durationMs: 0 },
		autoRun: { count: 0, durationMs: 0 },
		cue: { count: 0, durationMs: 0 },
	};
}

/** Gap-fill the sparse by-day rows main returns over the range's window. */
export function fillDelegationDays(
	days: readonly DelegationDay[],
	range: StatsTimeRange,
	now: number = Date.now()
): { window: UsageReadWindow; byDay: DelegationDay[] } {
	const window = usageReadWindow(range, days[0]?.date ?? null, now);
	return {
		window,
		byDay: fillDaySeries(days, window.startYmd, window.endYmd, emptyDelegationDay),
	};
}

// ============================================================================
// Activity: Auto Run, wizard, resilience, shortcut usage
// ============================================================================

export interface UsageActivityDay {
	date: string;
	/** Auto Run sessions started this day. */
	autoRuns: number;
	/** Tasks those runs completed. */
	autoRunTasksCompleted: number;
	/** Auto Run wizard conversations started this day. */
	wizardRuns: number;
	/** Provider outages Agent Resilience carried (resolved this day). */
	resilienceEvents: number;
	/** Keyboard shortcut firings. */
	shortcutPresses: number;
}

export interface UsageActivityTotals {
	/** Every Auto Run in range, of any kind or state. */
	autoRuns: number;
	/** Goal-driven runs (no checkboxes), counted apart from task math. */
	autoRunGoalRuns: number;
	/** Runs still going, or that never recorded an end. */
	autoRunUnfinished: number;
	/** Wall time of finished runs. */
	autoRunDurationMs: number;
	/** Checkboxes in finished document runs. */
	autoRunTasksTotal: number;
	/** Checkboxes those runs ticked. */
	autoRunTasksCompleted: number;
	/** Ticked over attempted, 0-100 (the Auto Run tab's Success Rate). */
	autoRunSuccessRate: number;
	wizardRuns: number;
	/** Wizard runs that wrote documents. */
	wizardRunsGenerated: number;
	wizardDocuments: number;
	wizardTasks: number;
	/** Time actually spent in the wizard (rows that measured it). */
	wizardActiveMs: number;
	resilienceEvents: number;
	/** Outages whose auto-resend went through. */
	resilienceRecovered: number;
	resilienceRetries: number;
	shortcutPresses: number;
}

export interface UsageActivityStats {
	range: StatsTimeRange;
	window: UsageReadWindow;
	totals: UsageActivityTotals;
	/** GAP-FILLED over `window`. */
	byDay: UsageActivityDay[];
	/** Shortcut presses per shortcut id, most used first (rows recorded since schema v14). */
	byShortcut: ShortcutUsageByShortcut[];
	/** Auto Run agent turns per hour of day, zero-filled 0-23. */
	autoRunTurnsByHour: AutoRunTurnsByHour[];
}

export interface UsageActivityInput {
	range: StatsTimeRange;
	autoRunSessions: readonly AutoRunSession[];
	wizardRuns: readonly WizardRun[];
	resilienceEvents: readonly ResilienceEvent[];
	shortcutUsageByDay: readonly ShortcutUsageDay[];
	/** The Shortcuts tab's summary figure (`getShortcutUsageTotal`). */
	shortcutTotal: number;
	shortcutUsageByShortcut?: readonly ShortcutUsageByShortcut[];
	autoRunTurnsByHour?: readonly AutoRunTurnsByHour[];
	now?: number;
}

function emptyActivityDay(date: string): UsageActivityDay {
	return {
		date,
		autoRuns: 0,
		autoRunTasksCompleted: 0,
		wizardRuns: 0,
		resilienceEvents: 0,
		shortcutPresses: 0,
	};
}

/**
 * Daily counts and range totals for the Auto Run, wizard, resilience and
 * shortcut panels, from the rows those panels read. Each row lands on the local
 * day of its own timestamp: an Auto Run or wizard run on the day it started, an
 * outage on the day it resolved (the moment it was recorded).
 */
export function buildUsageActivityStats(input: UsageActivityInput): UsageActivityStats {
	const now = input.now ?? Date.now();
	const days = new Map<string, UsageActivityDay>();
	const dayFor = (ms: number): UsageActivityDay => {
		const date = toLocalYmd(ms);
		let day = days.get(date);
		if (!day) {
			day = emptyActivityDay(date);
			days.set(date, day);
		}
		return day;
	};

	// Run and task totals come from the Auto Run tab's own rules (goal runs and
	// unfinished runs stay out of task math), so the CLI cannot disagree with it.
	const autoRun = computeAutoRunMetrics([...input.autoRunSessions]);
	const totals: UsageActivityTotals = {
		autoRuns: autoRun.totalRuns,
		autoRunGoalRuns: autoRun.goalRuns,
		autoRunUnfinished: autoRun.unfinishedRuns,
		autoRunDurationMs: autoRun.avgRunDuration * autoRun.finishedRuns,
		autoRunTasksTotal: autoRun.totalTasksAttempted,
		autoRunTasksCompleted: autoRun.totalTasksCompleted,
		autoRunSuccessRate: autoRun.successRate,
		wizardRuns: 0,
		wizardRunsGenerated: 0,
		wizardDocuments: 0,
		wizardTasks: 0,
		wizardActiveMs: 0,
		resilienceEvents: 0,
		resilienceRecovered: 0,
		resilienceRetries: 0,
		shortcutPresses: input.shortcutTotal,
	};

	for (const run of input.autoRunSessions) {
		const day = dayFor(run.startTime);
		day.autoRuns++;
		if (isFinishedAutoRun(run) && isDocumentAutoRun(run)) {
			day.autoRunTasksCompleted += run.tasksCompleted ?? 0;
		}
	}
	for (const run of input.wizardRuns) {
		dayFor(run.startedAt).wizardRuns++;
		totals.wizardRuns++;
		if (run.outcome === 'generated') totals.wizardRunsGenerated++;
		totals.wizardDocuments += run.documents;
		totals.wizardTasks += run.tasks;
		totals.wizardActiveMs += run.activeMs ?? 0;
	}
	for (const event of input.resilienceEvents) {
		dayFor(event.resolvedAt).resilienceEvents++;
		totals.resilienceEvents++;
		if (event.outcome === 'recovered') totals.resilienceRecovered++;
		totals.resilienceRetries += event.retries;
	}
	for (const row of input.shortcutUsageByDay) {
		let day = days.get(row.date);
		if (!day) {
			day = emptyActivityDay(row.date);
			days.set(row.date, day);
		}
		day.shortcutPresses += row.count;
	}

	const sorted = Array.from(days.values()).sort((a, b) => a.date.localeCompare(b.date));
	const window = usageReadWindow(input.range, sorted[0]?.date ?? null, now);
	return {
		range: input.range,
		window,
		totals,
		byDay: fillDaySeries(sorted, window.startYmd, window.endYmd, emptyActivityDay),
		byShortcut: [...(input.shortcutUsageByShortcut ?? [])].sort((a, b) => b.count - a.count),
		autoRunTurnsByHour: [...(input.autoRunTurnsByHour ?? [])],
	};
}

// ============================================================================
// Agents Over Time
// ============================================================================

export interface AgentCountStats extends AgentCountTimeline {
	range: StatsTimeRange;
	/** Agents in the Left Bar right now (terminals excluded), today's point. */
	liveAgents: number;
}

// ============================================================================
// Plan usage (Anthropic Usage / OpenAI Usage tabs)
// ============================================================================

export type PlanUsageProvider = 'claude-code' | 'codex';

export interface PlanUsageWindow {
	/** The row label the quota tab draws ("Week (all models)", "Weekly"...). */
	name: string;
	/** 0-100. */
	percent: number;
	resetsAt?: string;
}

export interface PlanUsageAccount {
	provider: PlanUsageProvider;
	/** Canonical `CLAUDE_CONFIG_DIR` / `CODEX_HOME`. */
	accountKey: string;
	email?: string;
	organization?: string;
	plan?: string;
	authState?: string;
	/** ISO time of the last sample. */
	sampledAt: string;
	/** True once the sample is older than the provider store's TTL (the tab badges it stale). */
	stale: boolean;
	windows: PlanUsageWindow[];
	/** Codex reset credits available, when the payload carried the count. */
	resetCreditsAvailable?: number;
	error?: string;
}

export interface PlanUsageReport {
	claude: PlanUsageAccount[];
	codex: PlanUsageAccount[];
}
