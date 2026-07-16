/**
 * Settings Store Migrations
 *
 * Versioned startup migrations run after the settings store is initialized.
 * Each owns a persisted marker, so `runSettingsMigrations()` is safe on every
 * boot and never re-applies a completed migration.
 */

import type Store from 'electron-store';

import { logger } from '../../utils/logger';
import type { MaestroSettings } from '../types';
import { migrateLegacyAdaptiveModeDefaultV1 } from './adaptive-mode-default';
import { migrateApiModeDefaultV2 } from './api-mode-default';
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
		migrateLegacyAdaptiveModeDefaultV1(store);
	} catch (error) {
		logger.error('Legacy Adaptive Mode migration v1 failed', 'Migration', error);
	}

	try {
		migrateApiModeDefaultV2(store);
	} catch (error) {
		logger.error('API Mode default migration v2 failed', 'Migration', error);
	}

	try {
		migratePlaybooksFolder(store);
	} catch (error) {
		logger.error('Playbooks folder migration failed', 'Migration', error);
	}
}
