/**
 * Computer History - `config.json` defaults and normalization (pure).
 *
 * The service is the only writer of `config.json`; the CLI and the UI read it
 * and ask the service to change it. Every read goes through
 * `normalizeConfig()` so a hand-edited or truncated file degrades to defaults
 * field by field instead of breaking the recorder.
 */

import type { CaptureRule, CaptureRuleMatch, ComputerHistoryConfig } from './types';

export const DEFAULT_RETENTION_DAYS = 90;
export const GIB = 1024 * 1024 * 1024;
export const DEFAULT_MAX_BYTES = 25 * GIB;

/** Bounds for user-set values (a 0-day retention would delete the open segment). */
export const MIN_RETENTION_DAYS = 1;
export const MAX_RETENTION_DAYS = 3650;
export const MIN_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
export const MAX_MAX_BYTES = 10 * 1024 * GIB; // 10 TB

/** Per-event caps the helper enforces (and the service re-checks). */
export const MAX_TEXT_BYTES = 8192;
export const MAX_SNAPSHOT_BYTES = 32768;

export function defaultComputerHistoryConfig(): ComputerHistoryConfig {
	return {
		version: 1,
		retentionDays: DEFAULT_RETENTION_DAYS,
		maxBytes: DEFAULT_MAX_BYTES,
		snapshots: true,
		rules: [],
		pausedUntil: null,
		digests: { enabled: false, agentId: null, rollup: true },
	};
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

const RULE_MATCHES: readonly CaptureRuleMatch[] = ['app', 'domain'];

/** Lowercase, and for domains strip a scheme, path, port, and leading `*.`/`.`. */
export function normalizeRuleValue(match: CaptureRuleMatch, value: string): string {
	let v = value.trim().toLowerCase();
	if (match === 'domain') {
		v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
		v = v.replace(/[/?#].*$/, '');
		v = v.replace(/:\d+$/, '');
		v = v.replace(/^\*?\./, '');
		v = v.replace(/\.$/, '');
	}
	return v;
}

function normalizeRule(raw: unknown): CaptureRule | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const match = r.match;
	if (typeof match !== 'string' || !RULE_MATCHES.includes(match as CaptureRuleMatch)) return null;
	if (typeof r.value !== 'string') return null;
	const value = normalizeRuleValue(match as CaptureRuleMatch, r.value);
	if (!value) return null;
	const id = typeof r.id === 'string' && r.id.trim() ? r.id.trim() : ruleIdFor(match, value);
	return { id, match: match as CaptureRuleMatch, value, action: 'ignore' };
}

/**
 * Deterministic id for a rule, so the same rule added twice (or written by
 * hand without an id) gets the same id and `rules remove <id>` is stable.
 */
export function ruleIdFor(match: string, value: string): string {
	let h = 0x811c9dc5;
	const s = `${match}:${value}`;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return `${match}-${h.toString(36)}`;
}

function normalizePausedUntil(value: unknown): string | null {
	if (value === 'forever') return 'forever';
	if (typeof value !== 'string') return null;
	const ms = Date.parse(value);
	return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Coerce anything (a parsed file, an IPC payload) to a valid config. */
export function normalizeConfig(raw: unknown): ComputerHistoryConfig {
	const d = defaultComputerHistoryConfig();
	if (!raw || typeof raw !== 'object') return d;
	const r = raw as Record<string, unknown>;
	const rules: CaptureRule[] = [];
	const seen = new Set<string>();
	if (Array.isArray(r.rules)) {
		for (const item of r.rules) {
			const rule = normalizeRule(item);
			if (!rule) continue;
			const key = `${rule.match}:${rule.value}`;
			if (seen.has(key)) continue;
			seen.add(key);
			rules.push(rule);
		}
	}
	const digestsRaw =
		r.digests && typeof r.digests === 'object' ? (r.digests as Record<string, unknown>) : {};
	const agentId =
		typeof digestsRaw.agentId === 'string' && digestsRaw.agentId.trim()
			? digestsRaw.agentId.trim()
			: null;
	return {
		version: 1,
		retentionDays: clampInt(
			r.retentionDays,
			MIN_RETENTION_DAYS,
			MAX_RETENTION_DAYS,
			d.retentionDays
		),
		maxBytes: clampInt(r.maxBytes, MIN_MAX_BYTES, MAX_MAX_BYTES, d.maxBytes),
		snapshots: typeof r.snapshots === 'boolean' ? r.snapshots : d.snapshots,
		rules,
		pausedUntil: normalizePausedUntil(r.pausedUntil),
		// The 6-hour roll-up rides along with digests unless explicitly off.
		digests: { enabled: digestsRaw.enabled === true, agentId, rollup: digestsRaw.rollup !== false },
	};
}

/** The fields `config set` may change. Rules and pause have their own verbs. */
export interface ComputerHistoryConfigPatch {
	retentionDays?: number;
	maxBytes?: number;
	snapshots?: boolean;
	digests?: { enabled?: boolean; agentId?: string | null; rollup?: boolean };
}

/** Apply a patch and re-normalize (out-of-range values clamp, junk is ignored). */
export function applyConfigPatch(
	config: ComputerHistoryConfig,
	patch: ComputerHistoryConfigPatch
): ComputerHistoryConfig {
	return normalizeConfig({
		...config,
		...(patch.retentionDays !== undefined ? { retentionDays: patch.retentionDays } : {}),
		...(patch.maxBytes !== undefined ? { maxBytes: patch.maxBytes } : {}),
		...(patch.snapshots !== undefined ? { snapshots: patch.snapshots } : {}),
		digests: {
			...config.digests,
			...(patch.digests?.enabled !== undefined ? { enabled: patch.digests.enabled } : {}),
			...(patch.digests?.agentId !== undefined ? { agentId: patch.digests.agentId } : {}),
			...(patch.digests?.rollup !== undefined ? { rollup: patch.digests.rollup } : {}),
		},
	});
}

/** Whether `pausedUntil` means "paused right now". Expired timestamps are not. */
export function isPausedAt(pausedUntil: string | null, nowMs: number): boolean {
	if (pausedUntil === null) return false;
	if (pausedUntil === 'forever') return true;
	const ms = Date.parse(pausedUntil);
	return !Number.isNaN(ms) && ms > nowMs;
}
