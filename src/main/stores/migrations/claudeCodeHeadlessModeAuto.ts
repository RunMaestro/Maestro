/**
 * Migration: `claudeCode.headlessMode` default flip from `'api'` → `'auto'`
 *
 * Phase 3 flipped `SETTINGS_DEFAULTS.claudeCode.headlessMode` from `'api'` to
 * `'auto'`. The intent: users who never visited the setting pick up the new,
 * cheaper default; users who explicitly chose `'api'` or `'interactive'` keep
 * their choice.
 *
 * **Why this migration is a marker + observability hook, not a disk-mutating
 * fix:** `electron-store.get()` and `.has()` both fall through to the
 * in-memory defaults block, so neither can distinguish "user wrote 'api'" from
 * "user never touched the setting and got 'api' from defaults". The only way
 * to tell is to read the raw JSON file directly via `store.path`. In
 * practice, because electron-store does NOT write defaults back to disk,
 * users who never visited the setting won't have a `claudeCode.headlessMode`
 * key on disk at all — so once `SETTINGS_DEFAULTS` flips to `'auto'`, those
 * users automatically pick up the new default with no disk mutation needed.
 * The migration therefore:
 *   - Reads the raw JSON to detect any *explicit* prior choice, logs it, and
 *     leaves it untouched (preserving the user's intent).
 *   - Records `claudeCodeHeadlessModeAutoMigrationApplied = true` so
 *     subsequent boots short-circuit.
 *
 * The next time we flip a default we'll have a precedent for the "read raw
 * JSON to distinguish explicit vs implicit" pattern.
 *
 * Decoupled from electron / Electron's app object for testability — the
 * migration takes a plain `Store`-shaped object and uses `fs.readFileSync`
 * directly.
 */

import * as fs from 'fs';
import type Store from 'electron-store';

import type { MaestroSettings } from '../types';
import { logger } from '../../utils/logger';

const LOG_CONTEXT = '[Migration:claudeCodeHeadlessModeAuto]';
const MIGRATION_MARKER_KEY = 'claudeCodeHeadlessModeAutoMigrationApplied';

/** Allowed `claudeCode.headlessMode` values; anything else is treated as no explicit value. */
const VALID_HEADLESS_MODES = new Set(['interactive', 'api', 'auto']);

/**
 * Read the explicit on-disk value of `claudeCode.headlessMode`, or `null` if
 * the user never set it.
 *
 * Returns `null` on any read or parse error — the migration treats that as
 * "no explicit value" and leaves the store alone. We never want this
 * migration to throw and block startup.
 */
function readExplicitHeadlessMode(storePath: string): string | null {
	let raw: string;
	try {
		raw = fs.readFileSync(storePath, 'utf-8');
	} catch {
		// File doesn't exist yet (fresh install) or unreadable — treat as no explicit value.
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Corrupt JSON — treat as no explicit value rather than throwing.
		return null;
	}

	if (!parsed || typeof parsed !== 'object') {
		return null;
	}

	const claudeCode = (parsed as Record<string, unknown>).claudeCode;
	if (!claudeCode || typeof claudeCode !== 'object') {
		return null;
	}

	const headlessMode = (claudeCode as Record<string, unknown>).headlessMode;
	if (typeof headlessMode !== 'string' || !VALID_HEADLESS_MODES.has(headlessMode)) {
		return null;
	}

	return headlessMode;
}

/**
 * Run the headless-mode default-flip migration once.
 *
 * Idempotent: marks `claudeCodeHeadlessModeAutoMigrationApplied = true` after
 * the first successful run and short-circuits on every subsequent boot.
 */
export function runClaudeCodeHeadlessModeAutoMigration(store: Store<MaestroSettings>): void {
	if (store.get(MIGRATION_MARKER_KEY) === true) {
		return;
	}

	const explicit = readExplicitHeadlessMode(store.path);
	if (explicit) {
		logger.info(
			`Preserving explicit claudeCode.headlessMode='${explicit}' across default flip`,
			LOG_CONTEXT
		);
	} else {
		logger.info(
			"No explicit claudeCode.headlessMode found; picking up new 'auto' default",
			LOG_CONTEXT
		);
	}

	store.set(MIGRATION_MARKER_KEY, true);
}
