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
import {
	validatePianolaProgram,
	validatePianolaAsk,
	type PianolaProgram,
	type PianolaAsk,
} from './pianola-programs';
import { learnableDecisionAction, matchHasNarrowingPredicate } from './pianola-policy';
import { canonicalJson } from '../canonicalJson';
import { isPianolaOwnerPrincipal, type PianolaOwnerPrincipal } from './owner-identity';
import {
	isPianolaScopeId,
	validatePianolaScopeSelection,
	type PianolaScopeSelection,
} from './pianola-scope';

/** Editable rules file (JSON array of PianolaRule), in the Maestro config dir. */
export const PIANOLA_RULES_FILENAME = 'maestro-pianola-rules.json';

/** Persisted orchestrator plans (JSON), in the Maestro config dir. */
export const PIANOLA_PLANS_FILENAME = 'maestro-pianola-plans.json';
export const PIANOLA_PROGRAMS_FILENAME = 'maestro-pianola-programs.json';
export const PIANOLA_ASKS_FILENAME = 'maestro-pianola-asks.json';
export const PIANOLA_PROGRAM_LOOP_FILENAME = 'maestro-pianola-program-loop.json';

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
	/** Native admission happened; until an outcome arrives delivery is uncertain. */
	deliveryStatus?: 'admitted';
	/** Scope decisions retain their recipient binding and attributable resolution. */
	lifecycle?: PianolaDecisionLifecycle;
	/** Immutable evidence of a transport-attributed owner decision; absent on legacy logs. */
	humanEvidence?: PianolaHumanDecisionEvidence;
	/** True if running in dry-run mode (never dispatches). */
	dryRun: boolean;
	/** Populated when a dispatch attempt failed. */
	error?: string;
}

/** Native owner resolution, never inferred from a transcript's user role or answer text. */
export interface PianolaHumanDecisionEvidence {
	version: 1;
	sourceKind: 'native-human-resolution';
	principal: PianolaOwnerPrincipal;
	actorId: string;
	agentId: string;
	/** Group membership at decision time; undefined metadata excludes the sample. */
	groupId: string | null;
	tabId: string;
	questionMessageId: string;
	/** ID of the native answer event, independent of the eventual transcript echo. */
	answerMessageId: string;
	askedAt: string;
	answeredAt: string;
	question: string;
	answer: string;
	/** Semantic interpretation is deliberately unknown until equivalence is established. */
	action: string | null;
	conditions: string[] | null;
}

export interface PianolaDecisionLifecycle {
	version: 1;
	guard: import('./pianola-scope-cycle').PianolaScopeDeliveryGuard;
	managerAgentId: string;
	managerTabId?: string;
	groupId: string | null;
	status: 'mira_processing' | 'waiting_human' | 'agent_running' | 'blocked' | 'paused' | 'done';
	nextActor: 'manager' | 'human' | 'recipient' | 'operator' | 'none';
	nextAction: string;
	phase: 'judgment' | 'answer' | 'none';
	delivery: 'not_sent' | 'intent' | 'accepted' | 'rejected' | 'unknown';
	updatedAt: string;
	deadlineAt?: number;
	acknowledgedAt?: string;
	/** Unknown transcript authors are never relabeled as human decisions. */
	source: {
		kind: 'rule' | 'manager' | 'human' | 'unknown';
		actorId?: string;
		tabId?: string;
		timestamp?: string;
	};
	answerMessageId?: string;
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
	if (raw.groupId !== undefined) {
		if (raw.groupId !== null && (typeof raw.groupId !== 'string' || !raw.groupId.trim()))
			return null;
		match.groupId = raw.groupId as string | null;
	}
	if (raw.exactQuestion !== undefined) {
		if (
			typeof raw.exactQuestion !== 'string' ||
			!raw.exactQuestion.trim() ||
			raw.exactQuestion.length > 16000
		)
			return null;
		match.exactQuestion = raw.exactQuestion;
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
	if (
		(raw.scope === 'agent' || raw.scope === 'group') &&
		(typeof raw.scopeId !== 'string' || !raw.scopeId.trim() || raw.scopeId.length > 200)
	)
		return null;
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

export function isValidClassification(raw: unknown): raw is PianolaClassification {
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
	if (raw.deliveryStatus !== undefined && raw.deliveryStatus !== 'admitted') return null;
	if (raw.lifecycle !== undefined && !isValidLifecycle(raw.lifecycle)) return null;
	if (!isValidClassification(raw.classification)) return null;
	if (!isValidDecision(raw.decision)) return null;
	if (raw.humanEvidence !== undefined && !isValidHumanDecisionEvidence(raw.humanEvidence))
		return null;
	if (raw.lifecycle !== undefined) {
		const life = raw.lifecycle as PianolaDecisionLifecycle;
		if (
			life.guard.decisionId !== raw.id ||
			life.guard.agentId !== raw.agentId ||
			life.guard.tabId !== raw.tabId ||
			life.guard.messageId !== raw.classification.evidence.messageId
		)
			return null;
	}
	if (raw.humanEvidence !== undefined) {
		const evidence = raw.humanEvidence as PianolaHumanDecisionEvidence;
		if (
			evidence.agentId !== raw.agentId ||
			evidence.tabId !== raw.tabId ||
			evidence.questionMessageId !==
				(raw.classification as PianolaClassification).evidence.messageId
		)
			return null;
	}
	return raw as unknown as PianolaDecisionRecord;
}

export function isValidHumanDecisionEvidence(raw: unknown): raw is PianolaHumanDecisionEvidence {
	if (!isRecord(raw)) return false;
	return (
		raw.version === 1 &&
		raw.sourceKind === 'native-human-resolution' &&
		isPianolaOwnerPrincipal(raw.principal) &&
		[
			'actorId',
			'agentId',
			'tabId',
			'questionMessageId',
			'answerMessageId',
			'question',
			'answer',
		].every((key) => typeof raw[key] === 'string' && !!(raw[key] as string).trim()) &&
		['askedAt', 'answeredAt'].every(
			(key) => typeof raw[key] === 'string' && Number.isFinite(Date.parse(raw[key] as string))
		) &&
		(raw.groupId === null || (typeof raw.groupId === 'string' && !!raw.groupId)) &&
		(raw.action === null || (typeof raw.action === 'string' && !!raw.action.trim())) &&
		(raw.conditions === null || isStringArray(raw.conditions))
	);
}

function isValidLifecycle(raw: unknown): raw is PianolaDecisionLifecycle {
	if (!isRecord(raw) || raw.version !== 1 || !isRecord(raw.guard) || !isRecord(raw.source))
		return false;
	const guard = raw.guard;
	return (
		[
			'scopeId',
			'configurationFingerprint',
			'bindingFingerprint',
			'agentId',
			'tabId',
			'messageId',
			'decisionId',
		].every((key) => typeof guard[key] === 'string' && guard[key].length > 0) &&
		isRecord(guard.cursor) &&
		typeof guard.cursor.id === 'string' &&
		Number.isSafeInteger(guard.cursor.count) &&
		(guard.cursor.count as number) > 0 &&
		Number.isSafeInteger(guard.cursor.textLength) &&
		(guard.cursor.textLength as number) >= 0 &&
		typeof raw.managerAgentId === 'string' &&
		!!raw.managerAgentId &&
		(raw.managerTabId === undefined || typeof raw.managerTabId === 'string') &&
		(raw.groupId === null || typeof raw.groupId === 'string') &&
		['mira_processing', 'waiting_human', 'agent_running', 'blocked', 'paused', 'done'].includes(
			raw.status as string
		) &&
		['manager', 'human', 'recipient', 'operator', 'none'].includes(raw.nextActor as string) &&
		typeof raw.nextAction === 'string' &&
		['judgment', 'answer', 'none'].includes(raw.phase as string) &&
		['not_sent', 'intent', 'accepted', 'rejected', 'unknown'].includes(raw.delivery as string) &&
		typeof raw.updatedAt === 'string' &&
		(raw.deadlineAt === undefined ||
			(typeof raw.deadlineAt === 'number' && Number.isFinite(raw.deadlineAt))) &&
		(raw.acknowledgedAt === undefined || typeof raw.acknowledgedAt === 'string') &&
		(raw.answerMessageId === undefined || typeof raw.answerMessageId === 'string') &&
		['rule', 'manager', 'human', 'unknown'].includes(raw.source.kind as string) &&
		(raw.source.actorId === undefined || typeof raw.source.actorId === 'string') &&
		(raw.source.timestamp === undefined || typeof raw.source.timestamp === 'string') &&
		(!['manager', 'human'].includes(raw.source.kind as string) ||
			(typeof raw.source.actorId === 'string' && !!raw.source.actorId)) &&
		(raw.source.tabId === undefined || typeof raw.source.tabId === 'string')
	);
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
export interface PianolaProgramsFile {
	programs: PianolaProgram[];
}
export interface PianolaAsksFile {
	asks: PianolaAsk[];
}
export function validatePianolaProgramsFile(raw: unknown): PianolaProgramsFile {
	const entries = raw && typeof raw === 'object' && 'programs' in raw ? raw.programs : undefined;
	return {
		programs: Array.isArray(entries)
			? entries.map(validatePianolaProgram).filter((p): p is PianolaProgram => p !== null)
			: [],
	};
}
export function validatePianolaAsksFile(raw: unknown): PianolaAsksFile {
	const entries = raw && typeof raw === 'object' && 'asks' in raw ? raw.asks : undefined;
	return {
		asks: Array.isArray(entries)
			? entries.map(validatePianolaAsk).filter((a): a is PianolaAsk => a !== null)
			: [],
	};
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

/** Background process kinds kept alive by the desktop supervisor. */
export type PianolaSupervisedKind = 'watch' | 'watch-scope' | 'orchestrate' | 'program';

/**
 * One persisted background target the desktop supervisor manages. A 'watch'
 * target babysits a tab and needs both tabId and agentId; an 'orchestrate'
 * target drives a saved plan to completion and needs planId; a 'program'
 * target drives a program lead loop and needs programId. The optional
 * intervalSeconds / concurrency / idleHours tune the spawned CLI command. A 'watch-scope'
 * target selects whole agents/groups and needs selection + managerAgentId.
 */
export interface PianolaSupervisedTarget {
	id: string;
	kind: PianolaSupervisedKind;
	enabled: boolean;
	createdAt: number;
	tabId?: string;
	agentId?: string;
	planId?: string;
	programId?: string;
	intervalSeconds?: number;
	concurrency?: number;
	/** Agent/group selection, or a readable legacy selection awaiting migration. */
	selection?: PianolaScopeSelection;
	managerAgentId?: string;
	/** Auto-watch targets are removed when their agent session is closed. */
	autoCreated?: boolean;
	/** Watch only: hours idle before the watcher retires itself (0 = never). */
	idleHours?: number;
}

/** Persisted supervisor registry file: a JSON object wrapping the target array. */
export interface PianolaSupervisorFile {
	targets: PianolaSupervisedTarget[];
}

/**
 * Validate one untrusted supervised-target object, or null when the shape is
 * invalid. Kind-specific required fields are enforced (watch needs tabId +
 * agentId, orchestrate needs planId, program needs programId) so a target
 * that cannot spawn a valid CLI command is dropped rather than persisted.
 */
export function validatePianolaSupervisedTarget(raw: unknown): PianolaSupervisedTarget | null {
	if (!isRecord(raw)) return null;
	if (typeof raw.id !== 'string' || raw.id.length === 0) return null;
	if (
		raw.kind !== 'watch' &&
		raw.kind !== 'watch-scope' &&
		raw.kind !== 'orchestrate' &&
		raw.kind !== 'program'
	)
		return null;
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
	if (raw.programId !== undefined) {
		if (typeof raw.programId !== 'string') return null;
		target.programId = raw.programId;
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
	if (raw.autoCreated !== undefined) {
		if (typeof raw.autoCreated !== 'boolean') return null;
		target.autoCreated = raw.autoCreated;
	}
	if (raw.idleHours !== undefined) {
		if (typeof raw.idleHours !== 'number' || !Number.isFinite(raw.idleHours) || raw.idleHours < 0) {
			return null;
		}
		target.idleHours = raw.idleHours;
	}
	if (target.kind === 'watch-scope') {
		// The discriminated selection validator retains old path-based records
		// without turning their roots into permission to monitor whole agents.
		const selection = validatePianolaScopeSelection(raw.selection);
		if (
			!isPianolaScopeId(target.id) ||
			!selection ||
			typeof raw.managerAgentId !== 'string' ||
			!raw.managerAgentId.trim() ||
			raw.managerAgentId.length > 200
		)
			return null;
		if (target.tabId || target.agentId || target.planId || target.autoCreated) return null;
		target.selection = selection;
		target.managerAgentId = raw.managerAgentId;
	}

	// Drop targets that lack the fields their kind needs to spawn a valid command.
	if (target.kind === 'watch' && (!target.tabId || !target.agentId)) return null;
	if (target.kind === 'orchestrate' && !target.planId) return null;

	if (target.kind === 'program' && !target.programId) return null;
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
export interface PianolaSuggestionCandidate {
	id: string;
	/** Exact disabled draft; timestamps are not part of the evidence identity. */
	rule: PianolaRule;
	action: string;
	conditions: string[];
	/** Explicit descriptions of the draft's enforced boundaries, not new policy. */
	exclusions: string[];
	evidence: PianolaHumanDecisionEvidence[];
	sampleCount: number;
	evidenceFingerprint: string;
}

export interface PianolaSuggestionRejection {
	sourceKind: 'native-human-review';
	principal: PianolaOwnerPrincipal;
	candidateId: string;
	evidenceFingerprint: string;
	/** Retain the rejected proposal and its source links for audit/review. */
	candidate: PianolaSuggestionCandidate;
	rejectedAt: number;
	actorId: string;
	reason?: string;
}

/** Human approval receipt. Live activation is determined from the rules file. */
export interface PianolaSuggestionApproval {
	sourceKind: 'native-human-review';
	principal: PianolaOwnerPrincipal;
	candidate: PianolaSuggestionCandidate;
	rule: PianolaRule;
	approvedAt: number;
	actorId: string;
	edited: boolean;
}

/** Durable review request; neither its creation nor replay changes live policy. */
export interface PianolaLearnedRuleConflict {
	ruleId: string;
	/** Bind to the exact accepted source version, including an intentional edit. */
	evidenceFingerprint: string;
	approvedAt: number;
	detectedAt: number;
	reason: 'source_corrected' | 'contradictory_decision';
	status: 'needs_review';
	nextActor: 'human';
	nextAction: string;
	/** Attributable new/corrected sources; the approval retains the original examples. */
	evidence: PianolaHumanDecisionEvidence[];
}

export type PianolaSuggestionReview = {
	candidateId: string;
	evidenceFingerprint: string;
} & (
	| { operation: 'accept' }
	| { operation: 'edit'; rule: PianolaRule }
	| { operation: 'reject'; reason?: string }
);

/** Stable across generation time and corpus ordering; every source change matters. */
export function pianolaCandidateEvidenceFingerprint(
	candidate: Omit<PianolaSuggestionCandidate, 'evidenceFingerprint'>
): string {
	const { rule } = candidate;
	return canonicalJson({
		id: candidate.id,
		scope: rule.scope,
		scopeId: rule.scopeId,
		match: rule.match,
		action: candidate.action,
		conditions: candidate.conditions,
		exclusions: candidate.exclusions,
		answer: rule.answer,
		evidence: candidate.evidence.map((source) => canonicalJson(source)).sort(),
	});
}

function validateSuggestionCandidate(raw: unknown): PianolaSuggestionCandidate | null {
	if (!isRecord(raw)) return null;
	const rule = validatePianolaRule(raw.rule);
	if (
		!rule ||
		rule.enabled ||
		rule.id !== raw.id ||
		!['agent', 'group'].includes(rule.scope) ||
		rule.action !== 'auto_answer' ||
		rule.match.maxRisk !== 'low' ||
		rule.match.kinds?.length !== 1 ||
		rule.match.kinds[0] !== 'question' ||
		rule.match.groupId === undefined ||
		typeof raw.action !== 'string' ||
		learnableDecisionAction(rule.match.exactQuestion ?? '') !== raw.action ||
		!isStringArray(raw.conditions) ||
		canonicalJson(raw.conditions) !== canonicalJson([rule.match.exactQuestion]) ||
		!isStringArray(raw.exclusions) ||
		!Array.isArray(raw.evidence) ||
		raw.evidence.length === 0 ||
		raw.sampleCount !== raw.evidence.length ||
		typeof raw.evidenceFingerprint !== 'string'
	)
		return null;
	const asks = new Set<string>();
	const answers = new Set<string>();
	for (const source of raw.evidence) {
		if (
			!isValidHumanDecisionEvidence(source) ||
			source.question !== rule.match.exactQuestion ||
			source.answer !== rule.answer ||
			source.groupId !== rule.match.groupId ||
			(rule.scope === 'agent' ? source.agentId : source.groupId) !== rule.scopeId ||
			(source.action !== null && source.action !== raw.action) ||
			(source.conditions !== null &&
				canonicalJson(source.conditions) !== canonicalJson(raw.conditions))
		)
			return null;
		const ask = canonicalJson([source.agentId, source.tabId, source.questionMessageId]);
		const answer = canonicalJson([source.actorId, source.answerMessageId]);
		if (asks.has(ask) || answers.has(answer)) return null;
		asks.add(ask);
		answers.add(answer);
	}
	const candidate: PianolaSuggestionCandidate = {
		id: rule.id,
		rule,
		action: raw.action,
		conditions: raw.conditions,
		exclusions: raw.exclusions,
		evidence: raw.evidence as PianolaHumanDecisionEvidence[],
		sampleCount: raw.evidence.length,
		evidenceFingerprint: raw.evidenceFingerprint,
	};
	return pianolaCandidateEvidenceFingerprint(candidate) === candidate.evidenceFingerprint
		? candidate
		: null;
}

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
	/** Optional only for legacy files; new synthesis always supplies source-linked candidates. */
	candidates?: PianolaSuggestionCandidate[];
	/** Review records survive regeneration, empty corpora and process restarts. */
	rejections?: PianolaSuggestionRejection[];
	approvals?: PianolaSuggestionApproval[];
	conflicts?: PianolaLearnedRuleConflict[];
}

/**
 * Validate an untrusted suggestions payload, dropping malformed proposals.
 * Legacy proposals degrade gracefully; invalid review evidence throws so a
 * subsequent staging write cannot silently discard durable human decisions.
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
	// Review metadata must fail closed: silently dropping it could revive a rejected
	// proposal or lose the human authorization for an edited rule.
	if (raw.candidates !== undefined) {
		if (!Array.isArray(raw.candidates)) throw new Error('InvalidSuggestionCandidates');
		result.candidates = raw.candidates.map((item) => {
			const candidate = validateSuggestionCandidate(item);
			if (!candidate) throw new Error('InvalidSuggestionCandidate');
			return candidate;
		});
		result.proposals = result.candidates.map((candidate) => candidate.rule);
	}
	if (raw.rejections !== undefined) {
		if (!Array.isArray(raw.rejections)) throw new Error('InvalidSuggestionRejections');
		result.rejections = raw.rejections.map((item) => {
			if (
				!isRecord(item) ||
				item.sourceKind !== 'native-human-review' ||
				!isPianolaOwnerPrincipal(item.principal) ||
				typeof item.candidateId !== 'string' ||
				!item.candidateId ||
				typeof item.evidenceFingerprint !== 'string' ||
				!item.evidenceFingerprint ||
				typeof item.rejectedAt !== 'number' ||
				!Number.isFinite(item.rejectedAt) ||
				typeof item.actorId !== 'string' ||
				!item.actorId.trim() ||
				(item.reason !== undefined && typeof item.reason !== 'string')
			)
				throw new Error('InvalidSuggestionRejection');
			const candidate = validateSuggestionCandidate(item.candidate);
			if (
				!candidate ||
				candidate.id !== item.candidateId ||
				candidate.evidenceFingerprint !== item.evidenceFingerprint
			)
				throw new Error('InvalidSuggestionRejection');
			return {
				sourceKind: 'native-human-review',
				principal: item.principal,
				candidateId: item.candidateId,
				evidenceFingerprint: item.evidenceFingerprint,
				candidate,
				rejectedAt: item.rejectedAt,
				actorId: item.actorId,
				...(typeof item.reason === 'string' ? { reason: item.reason } : {}),
			};
		});
	}
	if (raw.approvals !== undefined) {
		if (!Array.isArray(raw.approvals)) throw new Error('InvalidSuggestionApprovals');
		result.approvals = raw.approvals.map((item) => {
			if (
				!isRecord(item) ||
				item.sourceKind !== 'native-human-review' ||
				!isPianolaOwnerPrincipal(item.principal)
			)
				throw new Error('InvalidSuggestionApproval');
			const candidate = validateSuggestionCandidate(item.candidate);
			const rule = validatePianolaRule(item.rule);
			if (
				!candidate ||
				!rule ||
				rule.id !== candidate.id ||
				!rule.enabled ||
				typeof item.approvedAt !== 'number' ||
				!Number.isFinite(item.approvedAt) ||
				typeof item.actorId !== 'string' ||
				!item.actorId.trim() ||
				typeof item.edited !== 'boolean'
			)
				throw new Error('InvalidSuggestionApproval');
			if (
				canonicalJson([rule.scope, rule.scopeId, rule.match, rule.action]) !==
					canonicalJson([
						candidate.rule.scope,
						candidate.rule.scopeId,
						candidate.rule.match,
						candidate.rule.action,
					]) ||
				(!item.edited && rule.answer !== candidate.rule.answer)
			)
				throw new Error('InvalidSuggestionApproval');
			return {
				sourceKind: 'native-human-review',
				principal: item.principal,
				candidate,
				rule,
				approvedAt: item.approvedAt,
				actorId: item.actorId,
				edited: item.edited,
			};
		});
	}
	if (raw.conflicts !== undefined) {
		if (!Array.isArray(raw.conflicts)) throw new Error('InvalidLearnedRuleConflicts');
		result.conflicts = raw.conflicts.map((item) => {
			if (
				!isRecord(item) ||
				!result.approvals?.some(
					(approval) =>
						approval.rule.id === item.ruleId &&
						approval.candidate.evidenceFingerprint === item.evidenceFingerprint &&
						approval.approvedAt === item.approvedAt
				) ||
				typeof item.detectedAt !== 'number' ||
				!Number.isFinite(item.detectedAt) ||
				!['source_corrected', 'contradictory_decision'].includes(String(item.reason)) ||
				item.status !== 'needs_review' ||
				item.nextActor !== 'human' ||
				typeof item.nextAction !== 'string' ||
				!item.nextAction.trim() ||
				!Array.isArray(item.evidence) ||
				!item.evidence.length ||
				!item.evidence.every(isValidHumanDecisionEvidence)
			)
				throw new Error('InvalidLearnedRuleConflict');
			return {
				ruleId: item.ruleId as string,
				evidenceFingerprint: item.evidenceFingerprint as string,
				approvedAt: item.approvedAt as number,
				detectedAt: item.detectedAt,
				reason: item.reason as PianolaLearnedRuleConflict['reason'],
				status: 'needs_review',
				nextActor: 'human',
				nextAction: item.nextAction,
				evidence: item.evidence as PianolaHumanDecisionEvidence[],
			};
		});
	}
	return result;
}

// Re-exported so storage consumers get the decision/classification types from
// one import site.
export type { PianolaClassification, PianolaDecision, PianolaRule };
export type { PianolaPlan, PianolaTask };
