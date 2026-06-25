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
	type PianolaDecisionRecord,
} from '../../shared/pianola/storage';
import type { PianolaRule } from '../../shared/pianola/types';

function rulesPath(): string {
	return path.join(getConfigDirectory(), PIANOLA_RULES_FILENAME);
}

function decisionsPath(): string {
	return path.join(getConfigDirectory(), PIANOLA_DECISIONS_FILENAME);
}

/**
 * Read and validate the rules file. Returns an empty list when the file is
 * missing or malformed, and drops any individual invalid rule, so a bad
 * hand-edit cannot break the watcher.
 */
export function readPianolaRules(): PianolaRule[] {
	let content: string;
	try {
		content = fs.readFileSync(rulesPath(), 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(content);
	} catch {
		return [];
	}
	// Accept either a bare array or an electron-store style { rules: [...] }.
	const raw = Array.isArray(parsed)
		? parsed
		: ((parsed as { rules?: unknown } | null)?.rules ?? []);
	return validatePianolaRules(raw);
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
 * Read recent decision records (most recent last). Malformed lines are skipped.
 * When `limit` is given, only the last `limit` records are returned.
 */
export function readPianolaDecisions(limit?: number): PianolaDecisionRecord[] {
	let content: string;
	try {
		content = fs.readFileSync(decisionsPath(), 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw error;
	}
	const records: PianolaDecisionRecord[] = [];
	for (const line of content.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			records.push(JSON.parse(trimmed) as PianolaDecisionRecord);
		} catch {
			// Skip a corrupt line rather than failing the whole read.
		}
	}
	if (limit !== undefined && limit >= 0 && records.length > limit) {
		return records.slice(records.length - limit);
	}
	return records;
}
