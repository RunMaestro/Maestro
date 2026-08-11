/**
 * Settings Store Migrations
 *
 * One-shot startup migrations that run after the settings store is
 * initialized. Each migration is responsible for its own idempotency marker -
 * `runSettingsMigrations()` is invoked unconditionally on every boot.
 *
 * Register new migrations by importing and calling them here. Order matters
 * when one migration's output is the next migration's input: the API-mode reset
 * runs AFTER the adaptive-mode backfill so it has the final say on Claude Code
 * token sources.
 */

import type Store from 'electron-store';

import { logger } from '../../utils/logger';
import type { MaestroSettings } from '../types';
import { migrateAdaptiveModeDefault } from './adaptive-mode-default';
import { migrateApiModeDefault } from './api-mode-default';
import { migratePlaybooksFolder } from './playbooks-folder';

/**
 * Run all registered settings-store migrations once. Safe to call on every
 * boot - individual migrations short-circuit when their marker is set.
 *
 * Any migration that throws is logged at error and swallowed so a buggy
 * migration cannot block startup.
 */
export function runSettingsMigrations(store: Store<MaestroSettings>): void {
	try {
		migrateAdaptiveModeDefault(store);
	} catch (error) {
		logger.error('Adaptive Mode default migration failed', 'Migration', error);
	}

	// Runs AFTER the adaptive-mode backfill so it overrides it: Anthropic's
	// billing change means we no longer default anyone onto maestro-p. This
	// resets all Claude Code agents back to the API token source.
	try {
		migrateApiModeDefault(store);
	} catch (error) {
		logger.error('API Mode default migration failed', 'Migration', error);
	}

	try {
		migratePlaybooksFolder(store);
	} catch (error) {
		logger.error('Playbooks folder migration failed', 'Migration', error);
	}
}
