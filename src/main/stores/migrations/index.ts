/**
 * Settings Store Migrations
 *
 * One-shot startup migrations that run after the settings store is
 * initialized. Each migration is responsible for its own idempotency marker —
 * `runSettingsMigrations()` is invoked unconditionally on every boot.
 *
 * Register new migrations by importing and calling them here. Order matters
 * only when one migration's output is the next migration's input; today there
 * is just one migration so no explicit ordering is needed.
 */

import type Store from 'electron-store';

import type { MaestroSettings } from '../types';
import { logger } from '../../utils/logger';
import { runClaudeCodeHeadlessModeAutoMigration } from './claudeCodeHeadlessModeAuto';

const LOG_CONTEXT = '[SettingsMigrations]';

/**
 * Run all registered settings-store migrations once. Safe to call on every
 * boot — individual migrations short-circuit when their marker is set.
 *
 * Any migration that throws is logged at error and swallowed so a buggy
 * migration cannot block startup.
 */
export function runSettingsMigrations(store: Store<MaestroSettings>): void {
	try {
		runClaudeCodeHeadlessModeAutoMigration(store);
	} catch (err) {
		logger.error('claudeCodeHeadlessModeAuto migration threw', LOG_CONTEXT, {
			error: err instanceof Error ? err.message : String(err),
		});
	}
}
