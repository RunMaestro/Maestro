/**
 * Pianola storage contract - shared constants, the audit record type, and a
 * pure validator. The fs/electron specifics live in the CLI store
 * (src/cli/services/pianola-store.ts) and, later, a desktop store; both import
 * these so the filenames, record shape, and validation stay in one place.
 */

import type {
	PianolaClassification,
	PianolaDecision,
	PianolaRule,
	PianolaRuleScope,
	PianolaSignalKind,
	PianolaActionKind,
	PianolaRisk,
} from './types';
import { validatePlan, type PianolaPlan, type PianolaTask } from './pianola-tasks';

/** Editable rules file (JSON array of PianolaRule), in the Maestro config dir. */
export const PIANOLA_RULES_FILENAME = 'maestro-pianola-rules.json';

/** Persisted orchestrator plans (JSON), in the Maestro config dir. */
export const PIANOLA_PLANS_FILENAME = 'maestro-pianola-plans.json';

/** Append-only decision audit log (JSON Lines), in the Maestro config dir. */
export const PIANOLA_DECISIONS_FILENAME = 'pianola-decisions.jsonl';

/** Learned decision profiles (JSON), in the Maestro config dir. */
export const PIANOLA_PROFILES_FILENAME = 'maestro-pianola-profiles.json';

/** Max characters stored for a single profile (guards against runaway writes). */
export const PIANOLA_PROFILE_MAX_CHARS = 100_000;

/** One learned decision profile: narrative guidance Pianola reasons against. */
export interface PianolaProfileEntry {
	/** Human-readable markdown describing how the user decides. */
	profile: string;
	/** Epoch ms of the last write. */
	updatedAt: number;
	/** How many decision pairs this profile was synthesized from, if known. */
	pairCount?: number;
}

/**
 * Per-project decision profiles plus an optional global fallback. Keyed by the
 * session's project path (the cwd from `list agents`). Projects without their own
 * profile fall back to `global` at read time.
 */
export interface PianolaProfiles {
	global?: PianolaProfileEntry;
	projects: Record<string, PianolaProfileEntry>;
}

/** Where a resolved profile came from. */
export type PianolaProfileSource = 'project' | 'global' | 'none';

/** Result of loading rules, distinguishing "no rules" from "file is malformed". */
export interface RulesLoadResult {
	rules: PianolaRule[];
	/** True when the rules file exists but could not be parsed as JSON. */
	malformed: boolean;
}

/** One recorded decision in the audit log. */
export interface PianolaDecisionRecord {
	id: string;
	/** ISO-8601 timestamp of when the decision was made. */
	timestamp: string;
	tabId: string;
	agentId: string;
	projectPath?: string;
	classification: PianolaClassification;
	decision: PianolaDecision;
	/** True if Pianola actually sent a message (auto-answer that was dispatched). */
	dispatched: boolean;
	/** True if running in dry-run mode (never dispatches). */
	dryRun: boolean;
	/** Populated when a dispatch attempt failed. */
	error?: string;
}

const RULE_SCOPES: readonly PianolaRuleScope[] = ['global', 'project', 'tab'];
const ACTION_KINDS: readonly PianolaActionKind[] = ['auto_answer', 'escalate', 'ignore'];
const RISKS: readonly PianolaRisk[] = ['low', 'medium', 'high'];
const SIGNAL_KINDS: readonly PianolaSignalKind[] = ['question', 'blocked', 'none'];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function validateMatch(raw: unknown): PianolaRule['match'] | null {
	if (raw === undefined) return {};
	if (!isRecord(raw)) return null;
	const match: PianolaRule['match'] = {};

	if (raw.maxRisk !== undefined) {
		if (!RISKS.includes(raw.maxRisk as PianolaRisk)) return null;
		match.maxRisk = raw.maxRisk as PianolaRisk;
	}
	if (raw.kinds !== undefined) {
		if (
			!isStringArray(raw.kinds) ||
			!raw.kinds.every((k) => SIGNAL_KINDS.includes(k as PianolaSignalKind))
		)
			return null;
		match.kinds = raw.kinds as PianolaSignalKind[];
	}
	if (raw.topicIncludes !== undefined) {
		if (!isStringArray(raw.topicIncludes)) return null;
		match.topicIncludes = raw.topicIncludes;
	}

	return match;
}

/**
 * Validate one untrusted rule object. Returns a typed PianolaRule, or null if
 * the shape is invalid (callers drop invalid rules rather than throwing, so one
 * bad hand-edited rule cannot break the whole engine).
 */
export function validatePianolaRule(raw: unknown): PianolaRule | null {
	if (!isRecord(raw)) return null;

	if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
	if (typeof raw.enabled !== 'boolean') return null;
	if (!RULE_SCOPES.includes(raw.scope as PianolaRuleScope)) return null;
	if (!ACTION_KINDS.includes(raw.action as PianolaActionKind)) return null;
	if (typeof raw.priority !== 'number' || !Number.isFinite(raw.priority)) return null;
	if (typeof raw.createdAt !== 'number' || typeof raw.updatedAt !== 'number') return null;

	const match = validateMatch(raw.match);
	if (match === null) return null;

	if (raw.scopeId !== undefined && typeof raw.scopeId !== 'string') return null;
	if (raw.answer !== undefined && typeof raw.answer !== 'string') return null;
	if (raw.description !== undefined && typeof raw.description !== 'string') return null;

	const rule: PianolaRule = {
		id: raw.id,
		enabled: raw.enabled,
		scope: raw.scope as PianolaRuleScope,
		match,
		action: raw.action as PianolaActionKind,
		priority: raw.priority,
		createdAt: raw.createdAt,
		updatedAt: raw.updatedAt,
	};
	if (typeof raw.scopeId === 'string') rule.scopeId = raw.scopeId;
	if (typeof raw.answer === 'string') rule.answer = raw.answer;
	if (typeof raw.description === 'string') rule.description = raw.description;

	return rule;
}

const CONFIDENCES = ['low', 'medium', 'high'] as const;

function isValidClassification(raw: unknown): raw is PianolaClassification {
	if (!isRecord(raw)) return false;
	if (!SIGNAL_KINDS.includes(raw.kind as PianolaSignalKind)) return false;
	if (!RISKS.includes(raw.risk as PianolaRisk)) return false;
	if (typeof raw.topic !== 'string') return false;
	if (!CONFIDENCES.includes(raw.confidence as (typeof CONFIDENCES)[number])) return false;
	if (!isRecord(raw.evidence)) return false;
	return true;
}

function isValidDecision(raw: unknown): raw is PianolaDecision {
	if (!isRecord(raw)) return false;
	if (!ACTION_KINDS.includes(raw.action as PianolaActionKind)) return false;
	if (raw.matchedRuleId !== null && typeof raw.matchedRuleId !== 'string') return false;
	if (typeof raw.reason !== 'string') return false;
	if (raw.action === 'auto_answer' && typeof raw.answer !== 'string') return false;
	return true;
}

/**
 * Validate one untrusted decision-audit record. Returns the typed record or null
 * so a malformed JSONL line (hand-edited or from an older schema) is skipped
 * rather than crashing a reader that dereferences nested fields.
 */
export function validatePianolaDecisionRecord(raw: unknown): PianolaDecisionRecord | null {
	if (!isRecord(raw)) return null;
	if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
	if (typeof raw.timestamp !== 'string') return null;
	if (typeof raw.tabId !== 'string' || typeof raw.agentId !== 'string') return null;
	if (typeof raw.dispatched !== 'boolean' || typeof raw.dryRun !== 'boolean') return null;
	if (raw.projectPath !== undefined && typeof raw.projectPath !== 'string') return null;
	if (raw.error !== undefined && typeof raw.error !== 'string') return null;
	if (!isValidClassification(raw.classification)) return null;
	if (!isValidDecision(raw.decision)) return null;
	return raw as unknown as PianolaDecisionRecord;
}

/** Validate an untrusted rules payload, dropping any malformed entries. */
export function validatePianolaRules(raw: unknown): PianolaRule[] {
	if (!Array.isArray(raw)) return [];
	const rules: PianolaRule[] = [];
	for (const item of raw) {
		const rule = validatePianolaRule(item);
		if (rule) rules.push(rule);
	}
	return rules;
}

/** Validate one untrusted profile entry, or null if the shape is invalid. */
export function validatePianolaProfileEntry(raw: unknown): PianolaProfileEntry | null {
	if (!isRecord(raw)) return null;
	if (typeof raw.profile !== 'string') return null;
	if (typeof raw.updatedAt !== 'number' || !Number.isFinite(raw.updatedAt)) return null;
	const entry: PianolaProfileEntry = {
		profile: raw.profile.slice(0, PIANOLA_PROFILE_MAX_CHARS),
		updatedAt: raw.updatedAt,
	};
	if (typeof raw.pairCount === 'number' && Number.isFinite(raw.pairCount)) {
		entry.pairCount = raw.pairCount;
	}
	return entry;
}

/**
 * Validate an untrusted profiles payload, dropping any malformed entries. Always
 * returns a well-formed object so callers never have to null-check the shape.
 */
export function validatePianolaProfiles(raw: unknown): PianolaProfiles {
	const result: PianolaProfiles = { projects: {} };
	if (!isRecord(raw)) return result;
	const globalEntry = validatePianolaProfileEntry(raw.global);
	if (globalEntry) result.global = globalEntry;
	if (isRecord(raw.projects)) {
		for (const [key, value] of Object.entries(raw.projects)) {
			const entry = validatePianolaProfileEntry(value);
			if (entry) result.projects[key] = entry;
		}
	}
	return result;
}

/**
 * Resolve the profile for a project path: the project's own profile if present,
 * else the global fallback, else none. Pure so the CLI store and watcher agree.
 */
export function resolveProfile(
	profiles: PianolaProfiles,
	projectPath?: string
): { source: PianolaProfileSource; entry: PianolaProfileEntry | null } {
	if (projectPath && profiles.projects[projectPath]) {
		return { source: 'project', entry: profiles.projects[projectPath] };
	}
	if (profiles.global) {
		return { source: 'global', entry: profiles.global };
	}
	return { source: 'none', entry: null };
}

/** Persisted plans file: a JSON object wrapping the plan array. */
export interface PianolaPlansFile {
	plans: PianolaPlan[];
}

/**
 * Validate an untrusted plans payload, dropping any malformed plans (reusing
 * validatePlan and keeping only plans that validate cleanly). Always returns a
 * well-formed object so callers never have to null-check the shape - a bad
 * hand-edit degrades to "no plans", not a crash.
 */
export function validatePianolaPlansFile(raw: unknown): PianolaPlansFile {
	const result: PianolaPlansFile = { plans: [] };
	if (!isRecord(raw)) return result;
	if (!Array.isArray(raw.plans)) return result;
	for (const item of raw.plans) {
		const { plan } = validatePlan(item);
		if (plan) result.plans.push(plan);
	}
	return result;
}

/** Filename for the persisted supervised-target registry, in the Maestro config dir. */
export const PIANOLA_SUPERVISOR_FILENAME = 'maestro-pianola-supervisor.json';

/** The two kinds of background process the desktop supervisor keeps alive. */
export type PianolaSupervisedKind = 'watch' | 'orchestrate';

/**
 * One persisted background target the desktop supervisor manages. A 'watch'
 * target babysits a tab and needs both tabId and agentId; an 'orchestrate'
 * target drives a saved plan to completion and needs planId. The optional
 * intervalSeconds / concurrency tune the spawned CLI command.
 */
export interface PianolaSupervisedTarget {
	id: string;
	kind: PianolaSupervisedKind;
	enabled: boolean;
	createdAt: number;
	tabId?: string;
	agentId?: string;
	planId?: string;
	intervalSeconds?: number;
	concurrency?: number;
}

/** Persisted supervisor registry file: a JSON object wrapping the target array. */
export interface PianolaSupervisorFile {
	targets: PianolaSupervisedTarget[];
}

/**
 * Validate one untrusted supervised-target object, or null when the shape is
 * invalid. Kind-specific required fields are enforced (watch needs tabId +
 * agentId, orchestrate needs planId) so a target that could never spawn a valid
 * CLI command is dropped rather than persisted.
 */
export function validatePianolaSupervisedTarget(raw: unknown): PianolaSupervisedTarget | null {
	if (!isRecord(raw)) return null;
	if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
	if (raw.kind !== 'watch' && raw.kind !== 'orchestrate') return null;
	if (typeof raw.enabled !== 'boolean') return null;
	if (typeof raw.createdAt !== 'number' || !Number.isFinite(raw.createdAt)) return null;

	const target: PianolaSupervisedTarget = {
		id: raw.id,
		kind: raw.kind,
		enabled: raw.enabled,
		createdAt: raw.createdAt,
	};

	if (raw.tabId !== undefined) {
		if (typeof raw.tabId !== 'string') return null;
		target.tabId = raw.tabId;
	}
	if (raw.agentId !== undefined) {
		if (typeof raw.agentId !== 'string') return null;
		target.agentId = raw.agentId;
	}
	if (raw.planId !== undefined) {
		if (typeof raw.planId !== 'string') return null;
		target.planId = raw.planId;
	}
	if (raw.intervalSeconds !== undefined) {
		if (typeof raw.intervalSeconds !== 'number' || !Number.isFinite(raw.intervalSeconds)) {
			return null;
		}
		target.intervalSeconds = raw.intervalSeconds;
	}
	if (raw.concurrency !== undefined) {
		if (typeof raw.concurrency !== 'number' || !Number.isFinite(raw.concurrency)) return null;
		target.concurrency = raw.concurrency;
	}

	// Drop targets that lack the fields their kind needs to spawn a valid command.
	if (target.kind === 'watch' && (!target.tabId || !target.agentId)) return null;
	if (target.kind === 'orchestrate' && !target.planId) return null;

	return target;
}

/**
 * Validate an untrusted supervisor payload, dropping any malformed targets.
 * Always returns a well-formed object so callers never have to null-check the
 * shape - a bad hand-edit degrades to "no targets", not a crash.
 */
export function validatePianolaSupervisorFile(raw: unknown): PianolaSupervisorFile {
	const result: PianolaSupervisorFile = { targets: [] };
	if (!isRecord(raw)) return result;
	if (!Array.isArray(raw.targets)) return result;
	for (const item of raw.targets) {
		const target = validatePianolaSupervisedTarget(item);
		if (target) result.targets.push(target);
	}
	return result;
}

// Re-exported so storage consumers get the decision/classification types from
// one import site.
export type { PianolaClassification, PianolaDecision, PianolaRule };
export type { PianolaPlan, PianolaTask };
