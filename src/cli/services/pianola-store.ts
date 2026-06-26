/**
 * Pianola CLI storage.
 *
 * Reads the editable rules file and appends to the decision audit log, both in
 * the Maestro config dir (the same directory the CLI reads settings from, so the
 * desktop app and CLI share them). Rules are read-only from the CLI; the desktop
 * UI owns editing. The audit log is JSON Lines: append-only, human-readable, and
 * writable from a plain Node process with no native dependencies.
 */

import * as fs from 'fs';
import * as path from 'path';
import { getConfigDirectory } from './storage';
import {
	PIANOLA_RULES_FILENAME,
	PIANOLA_DECISIONS_FILENAME,
	PIANOLA_PROFILES_FILENAME,
	PIANOLA_PLANS_FILENAME,
	PIANOLA_SUPERVISOR_FILENAME,
	validatePianolaRules,
	validatePianolaDecisionRecord,
	validatePianolaProfiles,
	validatePianolaPlansFile,
	validatePianolaSupervisorFile,
	resolveProfile,
	type PianolaDecisionRecord,
	type RulesLoadResult,
	type PianolaProfiles,
	type PianolaProfileEntry,
	type PianolaProfileSource,
	type PianolaPlan,
	type PianolaSupervisedTarget,
} from '../../shared/pianola/storage';
import type { PianolaRule } from '../../shared/pianola/types';

export type { RulesLoadResult, PianolaProfiles, PianolaProfileEntry, PianolaPlan };
export type { PianolaSupervisedTarget };

function rulesPath(): string {
	return path.join(getConfigDirectory(), PIANOLA_RULES_FILENAME);
}

function decisionsPath(): string {
	return path.join(getConfigDirectory(), PIANOLA_DECISIONS_FILENAME);
}

/**
 * Read and validate the rules file, reporting whether the file was present but
 * unparseable. Individual invalid rules are dropped, so a bad hand-edit cannot
 * break the watcher; callers can surface `malformed` as a warning.
 */
export function readPianolaRulesResult(): RulesLoadResult {
	let content: string;
	try {
		content = fs.readFileSync(rulesPath(), 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { rules: [], malformed: false };
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return { rules: [], malformed: true };
	}
	// Accept either a bare array or an electron-store style { rules: [...] }.
	const raw = Array.isArray(parsed)
		? parsed
		: ((parsed as { rules?: unknown } | null)?.rules ?? []);
	return { rules: validatePianolaRules(raw), malformed: false };
}

/** Read and validate the rules file. Returns [] when missing or malformed. */
export function readPianolaRules(): PianolaRule[] {
	return readPianolaRulesResult().rules;
}

/**
 * Validate and persist the rules array. Mirrors the desktop store's writeRules:
 * invalid entries are dropped at the boundary, and the file is written
 * atomically (temp file + rename) so a crash mid-write cannot leave a truncated
 * rules file that the watcher would then treat as malformed. Returns the
 * validated rules that were actually written.
 */
export function writePianolaRules(rules: unknown): PianolaRule[] {
	const validated = validatePianolaRules(rules);
	const dir = getConfigDirectory();
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	const target = rulesPath();
	const tmp = `${target}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, 'utf-8');
	fs.renameSync(tmp, target);
	return validated;
}

/** Append one decision record to the audit log as a JSON line. */
export function appendPianolaDecision(record: PianolaDecisionRecord): void {
	const dir = getConfigDirectory();
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	fs.appendFileSync(decisionsPath(), `${JSON.stringify(record)}\n`, 'utf-8');
}

/**
 * Read recent decision records (most recent last). Malformed and schema-invalid
 * lines are skipped. Records sharing an id (an auto-answer's intent line and its
 * dispatch-outcome line) are folded so the latest wins, keeping the original
 * position. When `limit` is given, only the last `limit` records are returned.
 */
export function readPianolaDecisions(limit?: number): PianolaDecisionRecord[] {
	let content: string;
	try {
		content = fs.readFileSync(decisionsPath(), 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	const byId = new Map<string, PianolaDecisionRecord>();
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue; // skip a corrupt line rather than failing the whole read
		}
		const record = validatePianolaDecisionRecord(parsed);
		if (record) byId.set(record.id, record); // last write for an id wins, position kept
	}
	const records = [...byId.values()];
	if (limit !== undefined && limit >= 0 && records.length > limit) {
		return records.slice(records.length - limit);
	}
	return records;
}

function profilesPath(): string {
	return path.join(getConfigDirectory(), PIANOLA_PROFILES_FILENAME);
}

/**
 * Read and validate the per-project decision profiles. Returns an empty,
 * well-formed object when the file is missing or malformed so callers never have
 * to null-check (a bad hand-edit degrades to "no learned profiles", not a crash).
 */
export function readPianolaProfiles(): PianolaProfiles {
	let content: string;
	try {
		content = fs.readFileSync(profilesPath(), 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { projects: {} };
		throw error;
	}
	try {
		return validatePianolaProfiles(JSON.parse(content));
	} catch {
		return { projects: {} };
	}
}

/** Validate and atomically persist the profiles object. */
export function writePianolaProfiles(profiles: PianolaProfiles): PianolaProfiles {
	const validated = validatePianolaProfiles(profiles);
	const dir = getConfigDirectory();
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	const target = profilesPath();
	const tmp = `${target}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify(validated, null, 2)}\n`, 'utf-8');
	fs.renameSync(tmp, target);
	return validated;
}

/** Resolve the profile for a project path (project profile, else global, else none). */
export function getPianolaProfile(projectPath?: string): {
	source: PianolaProfileSource;
	entry: PianolaProfileEntry | null;
} {
	return resolveProfile(readPianolaProfiles(), projectPath);
}

/**
 * Write one profile: per-project when `projectPath` is given, otherwise the
 * global fallback. Returns the persisted profiles. Immutable: builds a new object
 * rather than mutating the read result.
 */
export function setPianolaProfile(
	entry: PianolaProfileEntry,
	projectPath?: string
): PianolaProfiles {
	const current = readPianolaProfiles();
	const next: PianolaProfiles = {
		global: current.global,
		projects: { ...current.projects },
	};
	if (projectPath) {
		next.projects[projectPath] = entry;
	} else {
		next.global = entry;
	}
	return writePianolaProfiles(next);
}

function plansPath(): string {
	return path.join(getConfigDirectory(), PIANOLA_PLANS_FILENAME);
}

/**
 * Read and validate the persisted plans. Returns [] when the file is missing or
 * malformed; individual invalid plans are dropped, so one bad plan cannot break
 * the orchestrator's view of the rest.
 */
export function readPianolaPlans(): PianolaPlan[] {
	let content: string;
	try {
		content = fs.readFileSync(plansPath(), 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	try {
		return validatePianolaPlansFile(JSON.parse(content)).plans;
	} catch {
		return [];
	}
}

/**
 * Validate and atomically persist the plans array (temp file + rename so a crash
 * mid-write cannot leave a truncated file). Invalid plans are dropped at this
 * boundary. Returns the plans that were actually written.
 */
export function writePianolaPlans(plans: PianolaPlan[]): PianolaPlan[] {
	const validated = validatePianolaPlansFile({ plans }).plans;
	const dir = getConfigDirectory();
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	const target = plansPath();
	const tmp = `${target}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify({ plans: validated }, null, 2)}\n`, 'utf-8');
	fs.renameSync(tmp, target);
	return validated;
}

/** Read one plan by id, or null if no plan with that id is persisted. */
export function getPianolaPlan(planId: string): PianolaPlan | null {
	return readPianolaPlans().find((p) => p.id === planId) ?? null;
}

/**
 * Insert or replace a plan by id and persist. Immutable: builds a new array
 * rather than mutating the read result. Returns the persisted plans.
 */
export function upsertPianolaPlan(plan: PianolaPlan): PianolaPlan[] {
	const current = readPianolaPlans();
	const index = current.findIndex((p) => p.id === plan.id);
	const next = index >= 0 ? current.map((p, i) => (i === index ? plan : p)) : [...current, plan];
	return writePianolaPlans(next);
}

function supervisorPath(): string {
	return path.join(getConfigDirectory(), PIANOLA_SUPERVISOR_FILENAME);
}

/**
 * Read and validate the supervised targets the desktop daemon keeps alive.
 * Returns [] when the file is missing or malformed; individual invalid targets
 * are dropped, so one bad hand-edit cannot hide the rest of the registry.
 */
export function readPianolaSupervisorTargets(): PianolaSupervisedTarget[] {
	let content: string;
	try {
		content = fs.readFileSync(supervisorPath(), 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	try {
		return validatePianolaSupervisorFile(JSON.parse(content)).targets;
	} catch {
		return [];
	}
}

/**
 * Validate and atomically persist the supervised targets (temp file + rename so
 * a crash mid-write cannot leave a truncated file the desktop watcher would read
 * as empty). Invalid targets are dropped at this boundary. Returns what was
 * written. Both the CLI and the desktop watcher read this same file, so a write
 * here triggers the desktop supervisor's file-watch reconcile within ~1s.
 */
export function writePianolaSupervisorTargets(
	targets: PianolaSupervisedTarget[]
): PianolaSupervisedTarget[] {
	const validated = validatePianolaSupervisorFile({ targets }).targets;
	const dir = getConfigDirectory();
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	const target = supervisorPath();
	const tmp = `${target}.tmp`;
	fs.writeFileSync(tmp, `${JSON.stringify({ targets: validated }, null, 2)}\n`, 'utf-8');
	fs.renameSync(tmp, target);
	return validated;
}

/**
 * Insert or replace a target by id and persist. Immutable: builds a new array
 * rather than mutating the read result. Returns the persisted targets.
 */
export function upsertPianolaSupervisorTarget(
	target: PianolaSupervisedTarget
): PianolaSupervisedTarget[] {
	const current = readPianolaSupervisorTargets();
	const index = current.findIndex((t) => t.id === target.id);
	const next =
		index >= 0 ? current.map((t, i) => (i === index ? target : t)) : [...current, target];
	return writePianolaSupervisorTargets(next);
}

/** Remove a target by id and persist. Returns the persisted targets. */
export function removePianolaSupervisorTarget(id: string): PianolaSupervisedTarget[] {
	const current = readPianolaSupervisorTargets();
	const next = current.filter((t) => t.id !== id);
	return writePianolaSupervisorTargets(next);
}
