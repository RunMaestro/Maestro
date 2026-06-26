/**
 * Pianola main-process storage.
 *
 * Reads/writes the rules file and the decision audit log in the Maestro user
 * data directory - the same files the CLI watcher uses (see
 * src/cli/services/pianola-store.ts), so desktop and CLI stay in sync. The fs
 * logic is intentionally duplicated rather than shared from src/shared, because
 * src/shared is also bundled into the renderer where `fs` is unavailable; the
 * validation and contracts ARE shared (src/shared/pianola/storage.ts).
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import {
	PIANOLA_RULES_FILENAME,
	PIANOLA_DECISIONS_FILENAME,
	PIANOLA_PLANS_FILENAME,
	PIANOLA_SUPERVISOR_FILENAME,
	validatePianolaRules,
	validatePianolaDecisionRecord,
	validatePianolaPlansFile,
	validatePianolaSupervisorFile,
	type PianolaDecisionRecord,
	type RulesLoadResult,
	type PianolaPlan,
	type PianolaSupervisedTarget,
} from '../../shared/pianola/storage';
import type { PianolaRule } from '../../shared/pianola/types';

export type { RulesLoadResult, PianolaPlan, PianolaSupervisedTarget };

/** Resolve the Maestro data dir, matching the CLI's getConfigDir semantics. */
function pianolaDir(): string {
	if (process.env.MAESTRO_USER_DATA) return path.resolve(process.env.MAESTRO_USER_DATA);
	return app.getPath('userData');
}

function rulesPath(): string {
	return path.join(pianolaDir(), PIANOLA_RULES_FILENAME);
}

function decisionsPath(): string {
	return path.join(pianolaDir(), PIANOLA_DECISIONS_FILENAME);
}

/**
 * Read and validate the rules, reporting whether the file was present but
 * unparseable. Mirrors the CLI's readPianolaRulesResult so the desktop can warn
 * (and avoid silently overwriting) a corrupt hand-edited file. Individual invalid
 * rules are still dropped.
 */
export function readRulesResult(): RulesLoadResult {
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
	const raw = Array.isArray(parsed)
		? parsed
		: ((parsed as { rules?: unknown } | null)?.rules ?? []);
	return { rules: validatePianolaRules(raw), malformed: false };
}

/** Read and validate the rules, dropping malformed entries. */
export function readRules(): PianolaRule[] {
	return readRulesResult().rules;
}

/**
 * Persist the full rules list. Accepts untrusted input (the renderer sends it
 * over IPC): it is validated here, the persistence boundary, so invalid entries
 * are dropped and one bad rule cannot corrupt the file. Written atomically via a
 * temp file + rename so a concurrent reader never sees a partial file.
 */
export function writeRules(rules: unknown): PianolaRule[] {
	const validated = validatePianolaRules(rules);
	const dir = pianolaDir();
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const target = rulesPath();
	const tmp = `${target}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(validated, null, '\t'), 'utf-8');
	fs.renameSync(tmp, target);
	return validated;
}

/** Append one decision record to the audit log as a JSON line. */
export function appendDecision(record: PianolaDecisionRecord): void {
	const dir = pianolaDir();
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.appendFileSync(decisionsPath(), `${JSON.stringify(record)}\n`, 'utf-8');
}

/**
 * Read recent decision records (most recent last). Malformed/invalid lines are
 * skipped; records sharing an id (intent + outcome) are folded, latest winning.
 */
export function readDecisions(limit?: number): PianolaDecisionRecord[] {
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

function plansPath(): string {
	return path.join(pianolaDir(), PIANOLA_PLANS_FILENAME);
}

/**
 * Read and validate the persisted plans. Returns [] when missing or malformed;
 * individual invalid plans are dropped. Mirrors the CLI's readPianolaPlans so
 * desktop and CLI agree on the on-disk shape.
 */
export function readPlans(): PianolaPlan[] {
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
 * Persist the plans list. Accepts untrusted input: it is validated here, the
 * persistence boundary, so invalid plans are dropped. Written atomically via a
 * temp file + rename so a concurrent reader never sees a partial file.
 */
export function writePlans(plans: PianolaPlan[]): PianolaPlan[] {
	const validated = validatePianolaPlansFile({ plans }).plans;
	const dir = pianolaDir();
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const target = plansPath();
	const tmp = `${target}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify({ plans: validated }, null, '\t'), 'utf-8');
	fs.renameSync(tmp, target);
	return validated;
}

/** Read one plan by id, or null if no plan with that id is persisted. */
export function getPlan(planId: string): PianolaPlan | null {
	return readPlans().find((p) => p.id === planId) ?? null;
}

/**
 * Insert or replace a plan by id and persist. Immutable: builds a new array
 * rather than mutating the read result. Returns the persisted plans.
 */
export function upsertPlan(plan: PianolaPlan): PianolaPlan[] {
	const current = readPlans();
	const index = current.findIndex((p) => p.id === plan.id);
	const next = index >= 0 ? current.map((p, i) => (i === index ? plan : p)) : [...current, plan];
	return writePlans(next);
}

/** Absolute path to the supervised-target registry the desktop supervisor watches. */
export function supervisorFilePath(): string {
	return path.join(pianolaDir(), PIANOLA_SUPERVISOR_FILENAME);
}

/**
 * Read and validate the supervised targets. Returns [] when missing or
 * malformed; individual invalid targets are dropped. Mirrors the CLI's
 * readPianolaSupervisorTargets so desktop and CLI agree on the on-disk shape.
 */
export function readSupervisorTargets(): PianolaSupervisedTarget[] {
	let content: string;
	try {
		content = fs.readFileSync(supervisorFilePath(), 'utf-8');
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
 * Persist the supervised targets. Accepts untrusted input (the renderer sends it
 * over IPC): it is validated here, the persistence boundary, so invalid targets
 * are dropped. Written atomically via a temp file + rename so a concurrent reader
 * never sees a partial file.
 */
export function writeSupervisorTargets(
	targets: PianolaSupervisedTarget[]
): PianolaSupervisedTarget[] {
	const validated = validatePianolaSupervisorFile({ targets }).targets;
	const dir = pianolaDir();
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const target = supervisorFilePath();
	const tmp = `${target}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify({ targets: validated }, null, '\t'), 'utf-8');
	fs.renameSync(tmp, target);
	return validated;
}

/**
 * Insert or replace a target by id and persist. Immutable: builds a new array
 * rather than mutating the read result. Returns the persisted targets.
 */
export function upsertSupervisorTarget(target: PianolaSupervisedTarget): PianolaSupervisedTarget[] {
	const current = readSupervisorTargets();
	const index = current.findIndex((t) => t.id === target.id);
	const next =
		index >= 0 ? current.map((t, i) => (i === index ? target : t)) : [...current, target];
	return writeSupervisorTargets(next);
}

/** Remove a target by id and persist. Returns the persisted targets. */
export function removeSupervisorTarget(id: string): PianolaSupervisedTarget[] {
	const current = readSupervisorTargets();
	const next = current.filter((t) => t.id !== id);
	return writeSupervisorTargets(next);
}
