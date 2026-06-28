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
// Runtime enum arrays are single-sourced from types.ts; the union types derive from them.
import { RULE_SCOPES, ACTION_KINDS, RISKS, SIGNAL_KINDS } from './types';
import { validatePlan, type PianolaPlan, type PianolaTask } from './pianola-tasks';
import { matchHasNarrowingPredicate } from './pianola-policy';

/** Editable rules file (JSON array of PianolaRule), in the Maestro config dir. */
export const PIANOLA_RULES_FILENAME = 'maestro-pianola-rules.json';

/** Persisted orchestrator plans (JSON), in the Maestro config dir. */
export const PIANOLA_PLANS_FILENAME = 'maestro-pianola-plans.json';

/** Append-only decision audit log (JSON Lines), in the Maestro config dir. */
export const PIANOLA_DECISIONS_FILENAME = 'pianola-decisions.jsonl';

/** Learned decision profiles (JSON), in the Maestro config dir. */
export const PIANOLA_PROFILES_FILENAME = 'maestro-pianola-profiles.json';

/** Staged learning suggestions (JSON), in the Maestro config dir. */
export const PIANOLA_SUGGESTIONS_FILENAME = 'maestro-pianola-suggestions.json';

/** Max characters stored for a single profile (guards against runaway writes). */
export const PIANOLA_PROFILE_MAX_CHARS = 100_000;

/**
 * Cap on retained decision-audit records. The log is append-only and read in
 * full on every watcher restart, so it is compacted to the most recent records
 * once it grows past the byte gate below.
 */
export const PIANOLA_DECISIONS_MAX_RECORDS = 5000;

/** Compact the decisions log only after it grows past this size (cheap stat gate). */
export const PIANOLA_DECISIONS_COMPACT_BYTES = 4_000_000;

/**
 * Per-record serialized byte cap. Most decision-record fields are bounded
 * upstream (the classifier caps `topic` at 140 chars; evidence/decision reasons
 * are fixed strings), but `decision.answer` is copied verbatim from a rule and a
 * dispatch `error` string is unbounded, so a single hostile/huge record could
 * serialize past the whole file budget on its own. appendDecisionLine drops any
 * line over this cap, keeping one record well under PIANOLA_DECISIONS_COMPACT_BYTES.
 */
export const PIANOLA_DECISION_RECORD_MAX_BYTES = 64_000;

/**
 * Keep only the most recent `max` non-empty JSONL lines. Pure: returns the
 * trimmed content (trailing newline preserved) so a store can write it back
 * atomically. Returns the input unchanged when already within the cap or when
 * `max` is not a positive integer.
 */
export function trimJsonlToLastRecords(content: string, max: number): string {
	if (!Number.isInteger(max) || max <= 0) return content;
	const lines = content.split('\n').filter((line) => line.trim().length > 0);
	if (lines.length <= max) return content;
	return `${lines.slice(lines.length - max).join('\n')}\n`;
}

/**
 * Keep only the most recent lines that fit BOTH a record cap and a byte budget:
 * at most `maxRecords` non-empty lines AND total length <= `maxBytes` (trailing
 * newline included). Pure. Drops oldest first. Returns the input unchanged when
 * already within both caps. Fixes the cap/byte-gate mismatch where trimming by
 * record count alone could leave the file still over the byte gate and thrash.
 */
export function trimJsonlToFit(content: string, maxRecords: number, maxBytes: number): string {
	const lines = content.split('\n').filter((line) => line.trim().length > 0);
	let kept = lines;
	if (Number.isInteger(maxRecords) && maxRecords > 0 && kept.length > maxRecords) {
		kept = kept.slice(kept.length - maxRecords);
	}
	if (Number.isInteger(maxBytes) && maxBytes > 0) {
		let total = kept.reduce((sum, line) => sum + line.length + 1, 0);
		let start = 0;
		while (start < kept.length && total > maxBytes) {
			total -= kept[start].length + 1;
			start += 1;
		}
		if (start > 0) kept = kept.slice(start);
	}
	if (kept.length === lines.length) return content;
	return kept.length > 0 ? `${kept.join('\n')}\n` : '';
}

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

	// Mirror the CLI/UI/policy safety contract at the storage boundary: an
	// auto_answer rule MUST narrow what it matches and carry reply text, or it
	// could blanket-answer prompts the user never anticipated. Drop such a rule
	// here so a hand-edited rules file cannot smuggle one past the editor checks.
	if (raw.action === 'auto_answer') {
		if (!matchHasNarrowingPredicate(match)) return null;
		if (typeof raw.answer !== 'string' || raw.answer.trim().length === 0) return null;
	}

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
	// Validate the evidence fields the readers depend on. In particular the watcher's
	// restart-rehydrate keys its dedup cursor off evidence.messageId, so a line with a
	// missing/mistyped messageId must be dropped, not accepted (else the cursor is lost
	// and a still-awaiting prompt could be re-acted on).
	const ev = raw.evidence;
	if (ev.messageId !== null && typeof ev.messageId !== 'string') return false;
	if (typeof ev.reason !== 'string') return false;
	if (typeof ev.structured !== 'boolean') return false;
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

/**
 * Staged learning suggestions: hard-rule proposals plus a proposed profile draft,
 * written by the scheduled re-learn job and read by the in-app suggestions UI.
 * Nothing here is live; the user approves individual items to persist them.
 */
export interface PianolaSuggestionsFile {
	/** Epoch ms the suggestions were generated. */
	generatedAt: number;
	/** How many mined decision pairs they were synthesized from. */
	pairCount: number;
	/** Approvable auto_answer rule proposals (each valid per validatePianolaRule). */
	proposals: PianolaRule[];
	/** Proposed decision-profile markdown draft. */
	proposedProfile: string;
	/** The profile that was current when this draft was generated. */
	previousProfile: string;
}

/**
 * Validate an untrusted suggestions payload, dropping malformed proposals.
 * Always returns a well-formed object so callers never null-check the shape.
 */
export function validatePianolaSuggestionsFile(raw: unknown): PianolaSuggestionsFile {
	const result: PianolaSuggestionsFile = {
		generatedAt: 0,
		pairCount: 0,
		proposals: [],
		proposedProfile: '',
		previousProfile: '',
	};
	if (!isRecord(raw)) return result;
	if (typeof raw.generatedAt === 'number' && Number.isFinite(raw.generatedAt)) {
		result.generatedAt = raw.generatedAt;
	}
	if (typeof raw.pairCount === 'number' && Number.isFinite(raw.pairCount)) {
		result.pairCount = raw.pairCount;
	}
	if (Array.isArray(raw.proposals)) {
		result.proposals = validatePianolaRules(raw.proposals);
	}
	if (typeof raw.proposedProfile === 'string') {
		result.proposedProfile = raw.proposedProfile.slice(0, PIANOLA_PROFILE_MAX_CHARS);
	}
	if (typeof raw.previousProfile === 'string') {
		result.previousProfile = raw.previousProfile.slice(0, PIANOLA_PROFILE_MAX_CHARS);
	}
	return result;
}

// Re-exported so storage consumers get the decision/classification types from
// one import site.
export type { PianolaClassification, PianolaDecision, PianolaRule };
export type { PianolaPlan, PianolaTask };
