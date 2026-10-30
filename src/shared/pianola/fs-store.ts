/**
 * Shared Pianola filesystem store - NODE ONLY (imports `fs`).
 *
 * Intentionally NOT imported by the renderer: only the main-process store
 * (`main/pianola/pianola-store-main.ts`) and the CLI store
 * (`cli/services/pianola-store.ts`) use it, so it never enters the renderer
 * bundle (same convention as `decision-log.ts`).
 *
 * The two stores were ~95% duplicated and had already drifted (tab vs 2-space
 * indent, trailing-newline). This single source keeps their read / validate /
 * atomic-write / compaction behavior identical; the only per-store differences -
 * the data directory and the JSON formatting - are injected.
 */

import * as fs from 'fs';
import * as path from 'path';
import { reconcileSuggestionEvidence } from './pianola-synthesis';
import { settledDecisionPairs } from './transcript-mining';
import {
	PIANOLA_RULES_FILENAME,
	PIANOLA_DECISIONS_FILENAME,
	PIANOLA_PLANS_FILENAME,
	PIANOLA_SUPERVISOR_FILENAME,
	PIANOLA_PROFILES_FILENAME,
	PIANOLA_SUGGESTIONS_FILENAME,
	PIANOLA_DECISIONS_MAX_RECORDS,
	PIANOLA_DECISIONS_COMPACT_BYTES,
	PIANOLA_DECISION_RECORD_MAX_BYTES,
	validatePianolaRules,
	validatePianolaDecisionRecord,
	validatePianolaPlansFile,
	validatePianolaSupervisorFile,
	validatePianolaSuggestionsFile,
	validatePianolaProfiles,
	resolveProfile,
	type PianolaSuggestionsFile,
	type PianolaProfiles,
	type PianolaProfileEntry,
	type PianolaProfileSource,
	type PianolaDecisionRecord,
	type RulesLoadResult,
	type PianolaPlan,
	type PianolaSupervisedTarget,
} from './storage';
import { appendDecisionLine, compactDecisionLog } from './decision-log';
import type { PianolaRule } from './types';
import {
	validatePianolaScopeCheckpoint,
	type PianolaScopeCheckpoint,
} from './pianola-scope-checkpoint';
import { isPianolaScopeId } from './pianola-scope';
import { canonicalJson } from '../canonicalJson';

export interface PianolaFsStoreConfig {
	/** Resolve the data dir (Electron userData for main, config dir for CLI). Re-read per op. */
	resolveDir: () => string;
	/** JSON.stringify indent for the object files (`'\t'` for main, `2` for CLI). */
	indent: string | number;
	/** Append a trailing newline to object files (CLI does; main does not). */
	trailingNewline: boolean;
}

/** The store surface shared by the desktop and CLI Pianola stores. */
export interface PianolaFsStore {
	readRulesResult(): RulesLoadResult;
	readRules(): PianolaRule[];
	writeRules(rules: unknown): PianolaRule[];
	appendDecision(record: PianolaDecisionRecord): void;
	readDecisions(limit?: number): PianolaDecisionRecord[];
	readPlans(): PianolaPlan[];
	writePlans(plans: PianolaPlan[]): PianolaPlan[];
	getPlan(planId: string): PianolaPlan | null;
	upsertPlan(plan: PianolaPlan): PianolaPlan[];
	readSuggestions(): PianolaSuggestionsFile;
	writeSuggestions(file: PianolaSuggestionsFile): PianolaSuggestionsFile;
	readProfiles(): PianolaProfiles;
	writeProfiles(profiles: PianolaProfiles): PianolaProfiles;
	getProfile(projectPath?: string): {
		source: PianolaProfileSource;
		entry: PianolaProfileEntry | null;
	};
	setProfile(entry: PianolaProfileEntry, projectPath?: string): PianolaProfiles;
	readSupervisorTargets(): PianolaSupervisedTarget[];
	writeSupervisorTargets(targets: PianolaSupervisedTarget[]): PianolaSupervisedTarget[];
	upsertSupervisorTarget(target: PianolaSupervisedTarget): PianolaSupervisedTarget[];
	removeSupervisorTarget(id: string): PianolaSupervisedTarget[];
	/** A missing checkpoint is a first enrollment; a corrupt one throws. */
	readScopeCheckpoint(scopeId: string): PianolaScopeCheckpoint | null;
	writeScopeCheckpoint(checkpoint: PianolaScopeCheckpoint): void;
	/** Absolute path to the supervised-target registry the desktop supervisor watches. */
	supervisorFilePath(): string;
}

export function createPianolaFsStore(config: PianolaFsStoreConfig): PianolaFsStore {
	const { resolveDir, indent, trailingNewline } = config;

	const filePath = (name: string): string => path.join(resolveDir(), name);

	/** Atomically persist a JSON value (temp file + rename) so a reader never sees a partial file. */
	function writeJsonAtomic(name: string, value: unknown): void {
		const dir = resolveDir();
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		const target = path.join(dir, name);
		const tmp = `${target}.tmp`;
		const body = JSON.stringify(value, null, indent);
		fs.writeFileSync(tmp, trailingNewline ? `${body}\n` : body, 'utf-8');
		fs.renameSync(tmp, target);
	}

	/** Read + JSON.parse a file; `fallback()` covers a missing file AND unparseable JSON. */
	function readFileOr<T>(name: string, fallback: () => T, parse: (parsed: unknown) => T): T {
		let content: string;
		try {
			content = fs.readFileSync(filePath(name), 'utf-8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback();
			throw error;
		}
		try {
			return parse(JSON.parse(content));
		} catch {
			return fallback();
		}
	}

	function readRulesResult(): RulesLoadResult {
		let content: string;
		try {
			content = fs.readFileSync(filePath(PIANOLA_RULES_FILENAME), 'utf-8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return { rules: [], malformed: false };
			}
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch {
			return { rules: [], malformed: true };
		}
		const raw = Array.isArray(parsed)
			? parsed
			: ((parsed as { rules?: unknown } | null)?.rules ?? []);
		return { rules: validatePianolaRules(raw), malformed: false };
	}

	function readDecisions(limit?: number): PianolaDecisionRecord[] {
		let content: string;
		try {
			content = fs.readFileSync(filePath(PIANOLA_DECISIONS_FILENAME), 'utf-8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw error;
		}
		// Records sharing an id (intent + outcome) are folded, latest winning.
		const byId = new Map<string, PianolaDecisionRecord>();
		for (const line of content.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				continue;
			}
			const record = validatePianolaDecisionRecord(parsed);
			if (record) byId.set(record.id, record);
		}
		const records = [...byId.values()];
		if (limit !== undefined && limit >= 0 && records.length > limit) {
			return records.slice(records.length - limit);
		}
		return records;
	}

	function appendDecision(record: PianolaDecisionRecord): void {
		const line = `${JSON.stringify(record)}\n`;
		// Scope audit-before-send must fail closed rather than silently dropping
		// an oversized or unreadable lifecycle and then losing its durable claim.
		if (
			record.lifecycle &&
			(!validatePianolaDecisionRecord(record) ||
				Buffer.byteLength(line, 'utf-8') > PIANOLA_DECISION_RECORD_MAX_BYTES)
		)
			throw new Error('Invalid or oversized Pianola decision lifecycle');
		const dir = resolveDir();
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, PIANOLA_DECISIONS_FILENAME);
		appendDecisionLine(file, line);
		compactDecisionLog(file, PIANOLA_DECISIONS_MAX_RECORDS, PIANOLA_DECISIONS_COMPACT_BYTES);
	}

	function readPlans(): PianolaPlan[] {
		return readFileOr(
			PIANOLA_PLANS_FILENAME,
			() => [],
			(parsed) => validatePianolaPlansFile(parsed).plans
		);
	}

	function writePlans(plans: PianolaPlan[]): PianolaPlan[] {
		const validated = validatePianolaPlansFile({ plans }).plans;
		writeJsonAtomic(PIANOLA_PLANS_FILENAME, { plans: validated });
		return validated;
	}

	function getPlan(planId: string): PianolaPlan | null {
		return readPlans().find((p) => p.id === planId) ?? null;
	}

	function upsertPlan(plan: PianolaPlan): PianolaPlan[] {
		const current = readPlans();
		const index = current.findIndex((p) => p.id === plan.id);
		const next = index >= 0 ? current.map((p, i) => (i === index ? plan : p)) : [...current, plan];
		return writePlans(next);
	}

	function readSuggestions(): PianolaSuggestionsFile {
		let content: string;
		try {
			content = fs.readFileSync(filePath(PIANOLA_SUGGESTIONS_FILENAME), 'utf-8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT')
				return validatePianolaSuggestionsFile(undefined);
			throw error;
		}
		// Corruption must not erase persistent rejection/approval evidence.
		const raw: unknown = JSON.parse(content);
		if (!raw || typeof raw !== 'object' || Array.isArray(raw))
			throw new Error('InvalidSuggestionFile');
		return validatePianolaSuggestionsFile(raw);
	}

	function writeSuggestions(file: PianolaSuggestionsFile): PianolaSuggestionsFile {
		let validated = validatePianolaSuggestionsFile(file);
		const current = readSuggestions();
		// Re-read at the atomic write boundary: asynchronous mining must never
		// overwrite a review that was committed while it was in flight.
		if (current.rejections || validated.rejections) {
			const rejections = new Map<
				string,
				NonNullable<PianolaSuggestionsFile['rejections']>[number]
			>();
			for (const item of [...(current.rejections ?? []), ...(validated.rejections ?? [])]) {
				const key = canonicalJson([item.candidateId, item.evidenceFingerprint]);
				const previous = rejections.get(key);
				if (
					previous &&
					(previous.principal !== item.principal || previous.actorId !== item.actorId)
				)
					throw new Error('ConflictingSuggestionReview');
				rejections.set(key, item);
			}
			validated.rejections = [...rejections.values()];
		}
		if (current.approvals || validated.approvals) {
			const approvals = new Map<string, NonNullable<PianolaSuggestionsFile['approvals']>[number]>();
			for (const item of [...(current.approvals ?? []), ...(validated.approvals ?? [])]) {
				const key = canonicalJson([
					item.candidate.id,
					item.candidate.evidenceFingerprint,
					item.approvedAt,
				]);
				const previous = approvals.get(key);
				if (
					previous &&
					(previous.principal !== item.principal || previous.actorId !== item.actorId)
				)
					throw new Error('ConflictingSuggestionReview');
				approvals.set(key, item);
			}
			validated.approvals = [...approvals.values()];
		}
		// Conflicts are durable review requests. Empty/legacy/stale writers cannot
		// erase one or its source examples, including after log compaction.
		if (current.conflicts || validated.conflicts) {
			const conflicts = new Map<string, NonNullable<PianolaSuggestionsFile['conflicts']>[number]>();
			for (const item of [...(current.conflicts ?? []), ...(validated.conflicts ?? [])]) {
				const key = canonicalJson([item.ruleId, item.evidenceFingerprint, item.approvedAt]);
				const previous = conflicts.get(key);
				const evidence = new Map(
					[...(previous?.evidence ?? []), ...item.evidence].map((source) => [
						canonicalJson(source),
						source,
					])
				);
				conflicts.set(key, {
					...item,
					detectedAt: Math.min(previous?.detectedAt ?? item.detectedAt, item.detectedAt),
					reason: previous?.reason === 'source_corrected' ? previous.reason : item.reason,
					evidence: [...evidence.values()],
				});
			}
			validated.conflicts = [...conflicts.values()];
		}
		if (validated.candidates) {
			validated.candidates = validated.candidates.filter(
				(candidate) =>
					!validated.rejections?.some(
						(item) =>
							item.candidateId === candidate.id &&
							item.evidenceFingerprint === candidate.evidenceFingerprint
					)
			);
			validated.proposals = validated.candidates.map((candidate) => candidate.rule);
		} else {
			// Legacy writers cannot resurrect a rejected source-linked candidate.
			validated.proposals = validated.proposals.filter(
				(proposal) => !validated.rejections?.some((item) => item.candidateId === proposal.id)
			);
		}
		// Re-read native evidence at the final write boundary. A correction or
		// approval committed during asynchronous mining must win over old staging.
		validated = reconcileSuggestionEvidence(
			validated,
			settledDecisionPairs(readDecisions(), { snapshots: true }),
			readRulesResult().rules,
			Date.now()
		);
		if (canonicalJson(validated) !== canonicalJson(current))
			writeJsonAtomic(PIANOLA_SUGGESTIONS_FILENAME, validated);
		return validated;
	}

	function readProfiles(): PianolaProfiles {
		return readFileOr(
			PIANOLA_PROFILES_FILENAME,
			() => ({ projects: {} }),
			(parsed) => validatePianolaProfiles(parsed)
		);
	}

	function writeProfiles(profiles: PianolaProfiles): PianolaProfiles {
		const validated = validatePianolaProfiles(profiles);
		writeJsonAtomic(PIANOLA_PROFILES_FILENAME, validated);
		return validated;
	}

	function getProfile(projectPath?: string): {
		source: PianolaProfileSource;
		entry: PianolaProfileEntry | null;
	} {
		return resolveProfile(readProfiles(), projectPath);
	}

	function setProfile(entry: PianolaProfileEntry, projectPath?: string): PianolaProfiles {
		const current = readProfiles();
		const next: PianolaProfiles = { global: current.global, projects: { ...current.projects } };
		if (projectPath) next.projects[projectPath] = entry;
		else next.global = entry;
		return writeProfiles(next);
	}

	function supervisorFilePath(): string {
		return filePath(PIANOLA_SUPERVISOR_FILENAME);
	}

	function readSupervisorTargets(): PianolaSupervisedTarget[] {
		return readFileOr(
			PIANOLA_SUPERVISOR_FILENAME,
			() => [],
			(parsed) => validatePianolaSupervisorFile(parsed).targets
		);
	}

	function writeSupervisorTargets(targets: PianolaSupervisedTarget[]): PianolaSupervisedTarget[] {
		const validated = validatePianolaSupervisorFile({ targets }).targets;
		writeJsonAtomic(PIANOLA_SUPERVISOR_FILENAME, { targets: validated });
		return validated;
	}

	function upsertSupervisorTarget(target: PianolaSupervisedTarget): PianolaSupervisedTarget[] {
		const current = readSupervisorTargets();
		const index = current.findIndex((t) => t.id === target.id);
		const next =
			index >= 0 ? current.map((t, i) => (i === index ? target : t)) : [...current, target];
		return writeSupervisorTargets(next);
	}

	function removeSupervisorTarget(id: string): PianolaSupervisedTarget[] {
		const current = readSupervisorTargets();
		const next = current.filter((t) => t.id !== id);
		return writeSupervisorTargets(next);
	}

	function checkpointName(scopeId: string): string {
		if (!isPianolaScopeId(scopeId)) throw new Error('Invalid Pianola scope ID');
		return `maestro-pianola-scope-${scopeId}.json`;
	}

	function readScopeCheckpoint(scopeId: string): PianolaScopeCheckpoint | null {
		const file = filePath(checkpointName(scopeId));
		let content: string;
		try {
			if (fs.statSync(file).size > 20 * 1024 * 1024)
				throw new Error('Pianola checkpoint too large');
			content = fs.readFileSync(file, 'utf-8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw error;
		}
		let raw: unknown;
		try {
			raw = JSON.parse(content);
		} catch {
			throw new Error('Invalid Pianola scope checkpoint JSON');
		}
		const checkpoint = validatePianolaScopeCheckpoint(raw, scopeId);
		if (!checkpoint) throw new Error('Invalid Pianola scope checkpoint');
		return checkpoint;
	}

	function writeScopeCheckpoint(checkpoint: PianolaScopeCheckpoint): void {
		const name = checkpointName(checkpoint.scopeId);
		if (!validatePianolaScopeCheckpoint(checkpoint, checkpoint.scopeId)) {
			throw new Error('Invalid Pianola scope checkpoint');
		}
		if (
			Buffer.byteLength(JSON.stringify(checkpoint, null, indent), 'utf-8') + 1 >
			20 * 1024 * 1024
		) {
			throw new Error('Pianola checkpoint too large');
		}
		writeJsonAtomic(name, checkpoint);
	}

	return {
		readRulesResult,
		readRules: () => readRulesResult().rules,
		writeRules(rules: unknown): PianolaRule[] {
			const validated = validatePianolaRules(rules);
			writeJsonAtomic(PIANOLA_RULES_FILENAME, validated);
			return validated;
		},
		appendDecision,
		readDecisions,
		readPlans,
		writePlans,
		getPlan,
		upsertPlan,
		readSuggestions,
		writeSuggestions,
		readProfiles,
		writeProfiles,
		getProfile,
		setProfile,
		readSupervisorTargets,
		writeSupervisorTargets,
		upsertSupervisorTarget,
		removeSupervisorTarget,
		readScopeCheckpoint,
		writeScopeCheckpoint,
		supervisorFilePath,
	};
}
