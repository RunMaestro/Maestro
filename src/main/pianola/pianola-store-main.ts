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
	validatePianolaRules,
	validatePianolaDecisionRecord,
	type PianolaDecisionRecord,
} from '../../shared/pianola/storage';
import type { PianolaRule } from '../../shared/pianola/types';

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

/** Read and validate the rules, dropping malformed entries. */
export function readRules(): PianolaRule[] {
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
	const raw = Array.isArray(parsed)
		? parsed
		: ((parsed as { rules?: unknown } | null)?.rules ?? []);
	return validatePianolaRules(raw);
}

/**
 * Persist the full rules list (validated first; invalid entries are rejected).
 * Written atomically via a temp file + rename so a concurrent reader never sees
 * a partial file.
 */
export function writeRules(rules: PianolaRule[]): PianolaRule[] {
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
