/**
 * presentation.ts — pure view-model helpers for the OMP Native runtime panel.
 *
 * The main-process adapter projects raw runtime state (tree labels, stats
 * key/values) without opinions about presentation. Everything here shapes that
 * projection into designed Maestro UI:
 *
 * - `presentSessionActivity` hides raw markup payloads (`<system-notice>` and
 *   friends), device-inventory dumps, and duplicate messages from the session
 *   activity list WITHOUT mutating stored history — filtering is display-only.
 * - `presentStats` turns the flat stat record into labelled overview cards, a
 *   context-usage gauge, and humanized leftover rows so no raw `key: value`
 *   text ever reaches the panel.
 * - `truncateMiddle` keeps long paths readable at 320–420px panel widths while
 *   the full value stays available for copy.
 *
 * Pure functions only — no React, no window access — so they are directly
 * unit-testable.
 */

import type {
	AgentRuntimeFeatureState,
	AgentTodoPhase,
	AgentTreeNode,
} from '../../../shared/agent-runtime-features';
import { formatTokenCount } from '../../utils/tokenCounter';

export interface SessionActivityEntry {
	id: string;
	label: string;
}

/** Raw markup payloads start with a tag opener (`<system-notice>`, `<?xml`, `<!--`). */
const MARKUP_START = /^<[!?/a-zA-Z]/;

/**
 * Device-inventory lines look like `OS: win32` / `CPU: …` blocks. A single
 * incidental "OS:" inside prose is fine; two or more inventory keys means the
 * message is a hardware/environment dump, not conversation.
 */
const DEVICE_INVENTORY_KEY =
	/(^|[\s•|-])(os|distro|kernel|arch|cpu|gpu|ram|terminal|hostname|workstation|device)\s*:/gi;

export function isDeviceInventoryLabel(label: string): boolean {
	DEVICE_INVENTORY_KEY.lastIndex = 0;
	let count = 0;
	while (DEVICE_INVENTORY_KEY.exec(label) !== null) {
		count += 1;
		if (count >= 2) return true;
	}
	return false;
}

/**
 * Display-only projection of the session tree: collapses whitespace, drops raw
 * markup / device-inventory payloads, and de-duplicates repeated labels while
 * preserving order and entry ids (ids drive branch/messages actions).
 */
export function presentSessionActivity(tree: AgentTreeNode[] | null): SessionActivityEntry[] {
	if (!tree?.length) return [];
	const seen = new Set<string>();
	const entries: SessionActivityEntry[] = [];
	for (const node of tree) {
		const label = node.label.replace(/\s+/g, ' ').trim();
		if (!label) continue;
		if (MARKUP_START.test(label)) continue;
		if (isDeviceInventoryLabel(label)) continue;
		const key = label.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		entries.push({ id: node.id, label });
	}
	return entries;
}

export interface StatCard {
	id: string;
	label: string;
	value: string;
}

export interface ContextUsagePresentation {
	usedLabel: string;
	windowLabel: string;
	/** 0–100, already clamped. */
	percent: number;
}

export interface StatRow {
	label: string;
	value: string;
}

export interface StatsPresentation {
	cards: StatCard[];
	context: ContextUsagePresentation | null;
	rows: StatRow[];
}

export function formatCostUsd(value: number): string {
	if (value === 0) return '$0.00';
	return value < 0.01 ? `$${value.toFixed(4)}` : `$${value.toFixed(2)}`;
}

/** `cacheReadInputTokens` → `Cache read input tokens`. */
export function humanizeStatKey(key: string): string {
	const spaced = key
		.replace(/([a-z0-9])([A-Z])/g, '$1 $2')
		.replace(/[_-]+/g, ' ')
		.toLowerCase()
		.trim();
	return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const CARD_KEYS: ReadonlyArray<{
	key: string;
	label: string;
	format: (value: number) => string;
}> = [
	{ key: 'inputTokens', label: 'Input', format: formatTokenCount },
	{ key: 'outputTokens', label: 'Output', format: formatTokenCount },
	{ key: 'reasoningTokens', label: 'Reasoning', format: formatTokenCount },
	{ key: 'cacheReadInputTokens', label: 'Cache read', format: formatTokenCount },
	{ key: 'cacheCreationInputTokens', label: 'Cache write', format: formatTokenCount },
	{ key: 'totalCostUsd', label: 'Cost', format: formatCostUsd },
];

const CONTEXT_KEYS = ['totalTokens', 'contextWindow'];

/**
 * Splits the projected stat record into overview cards (known token/cost
 * keys), a context-usage gauge (total vs window), and humanized rows for
 * anything else the runtime reports.
 */
export function presentStats(stats: Record<string, number | string> | null): StatsPresentation {
	if (!stats) return { cards: [], context: null, rows: [] };

	const cards: StatCard[] = [];
	for (const { key, label, format } of CARD_KEYS) {
		const value = stats[key];
		if (typeof value === 'number') cards.push({ id: key, label, value: format(value) });
	}

	let context: ContextUsagePresentation | null = null;
	const total = stats.totalTokens;
	const window = stats.contextWindow;
	if (typeof total === 'number' && typeof window === 'number' && window > 0) {
		context = {
			usedLabel: formatTokenCount(total),
			windowLabel: formatTokenCount(window),
			percent: Math.min(100, Math.max(0, Math.round((total / window) * 100))),
		};
	}

	const consumed = new Set<string>([...CARD_KEYS.map((entry) => entry.key), ...CONTEXT_KEYS]);
	const rows: StatRow[] = [];
	for (const [key, value] of Object.entries(stats)) {
		if (consumed.has(key)) continue;
		rows.push({
			label: humanizeStatKey(key),
			value: typeof value === 'number' ? formatTokenCount(value) : String(value),
		});
	}

	return { cards, context, rows };
}

/** Middle-ellipsis for long values (paths, session files) in narrow layouts. */
export function truncateMiddle(text: string, max = 48): string {
	if (text.length <= max) return text;
	const keep = Math.max(4, Math.floor((max - 1) / 2));
	return `${text.slice(0, keep)}…${text.slice(text.length - keep)}`;
}

export interface TodoSummary {
	done: number;
	total: number;
}

export function summarizeTodos(todos: AgentTodoPhase[] | null): TodoSummary {
	let done = 0;
	let total = 0;
	for (const phase of todos ?? []) {
		for (const item of phase.items) {
			total += 1;
			if (item.state === 'done') done += 1;
		}
	}
	return { done, total };
}

/** Current model selection, when the runtime projects a model control. */
export function currentModelLabel(features: AgentRuntimeFeatureState): string | null {
	const control = features.controls.find((entry) => entry.id === 'model');
	if (!control || typeof control.value !== 'string' || !control.value) return null;
	const option = control.options?.find((candidate) => candidate.id === control.value);
	return option?.label ?? control.value;
}
