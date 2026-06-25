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
	validatePianolaRules,
	validatePianolaDecisionRecord,
	type PianolaDecisionRecord,
} from '../../shared/pianola/storage';
import type { PianolaRule } from '../../shared/pianola/types';

/** Result of loading rules, distinguishing "no rules" from "file is malformed". */
export interface RulesLoadResult {
	rules: PianolaRule[];
	/** True when the rules file exists but could not be parsed as JSON. */
	malformed: boolean;
}

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
