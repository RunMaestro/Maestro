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
import {
	PIANOLA_RULES_FILENAME,
	PIANOLA_DECISIONS_FILENAME,
	PIANOLA_PLANS_FILENAME,
	PIANOLA_SUPERVISOR_FILENAME,
	PIANOLA_PROFILES_FILENAME,
	PIANOLA_SUGGESTIONS_FILENAME,
	PIANOLA_DECISIONS_MAX_RECORDS,
	PIANOLA_DECISIONS_COMPACT_BYTES,
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
		const dir = resolveDir();
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, PIANOLA_DECISIONS_FILENAME);
		appendDecisionLine(file, `${JSON.stringify(record)}\n`);
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
		return readFileOr(
			PIANOLA_SUGGESTIONS_FILENAME,
			() => validatePianolaSuggestionsFile(undefined),
			(parsed) => validatePianolaSuggestionsFile(parsed)
		);
	}

	function writeSuggestions(file: PianolaSuggestionsFile): PianolaSuggestionsFile {
		const validated = validatePianolaSuggestionsFile(file);
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
		supervisorFilePath,
	};
}
