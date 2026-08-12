/**
 * Settings Metadata
 *
 * Centralized metadata for all Maestro settings, used by both
 * the CLI (settings commands) and the main process (defaults).
 *
 * Each entry provides:
 *  - description: human-readable explanation for LLM context and CLI --verbose output
 *  - type: the expected JS type or union (for display/validation)
 *  - default: the default value (or a function returning one for platform-dependent defaults)
 *  - sensitive: true for keys that should be masked in list output
 *  - category: logical grouping for organized display
 */

import { APPEARANCE_SETTINGS_METADATA } from './settingsMetadataAppearance';
import { EDITOR_SETTINGS_METADATA } from './settingsMetadataEditor';
import { CORE_SETTINGS_METADATA } from './settingsMetadataCore';
import { CONNECTIVITY_SETTINGS_METADATA } from './settingsMetadataConnectivity';
import { AUTOMATION_SETTINGS_METADATA } from './settingsMetadataAutomation';
import { EXPERIENCE_SETTINGS_METADATA } from './settingsMetadataExperience';
import { FEATURES_SETTINGS_METADATA } from './settingsMetadataFeatures';
// ============================================================================
// Types
// ============================================================================

export type SettingType = 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null';

export interface SettingMetadata {
	description: string;
	type: SettingType;
	default: unknown;
	sensitive?: boolean;
	category: SettingCategory;
}

export type SettingCategory =
	| 'appearance'
	| 'editor'
	| 'shell'
	| 'notifications'
	| 'updates'
	| 'logging'
	| 'web'
	| 'ssh'
	| 'stats'
	| 'accessibility'
	| 'document-graph'
	| 'context'
	| 'file-indexing'
	| 'integrations'
	| 'onboarding'
	| 'advanced'
	| 'internal';

// ============================================================================
// Settings Registry
// ============================================================================

export const SETTINGS_METADATA: Record<string, SettingMetadata> = {
	...APPEARANCE_SETTINGS_METADATA,
	...EDITOR_SETTINGS_METADATA,
	...CORE_SETTINGS_METADATA,
	...CONNECTIVITY_SETTINGS_METADATA,
	...AUTOMATION_SETTINGS_METADATA,
	...EXPERIENCE_SETTINGS_METADATA,
	...FEATURES_SETTINGS_METADATA,
};

// ============================================================================
// Helpers
// ============================================================================

/** All known sensitive setting keys */
export const SENSITIVE_KEYS = new Set(
	Object.entries(SETTINGS_METADATA)
		.filter(([, meta]) => meta.sensitive)
		.map(([key]) => key)
);

/** All setting categories in display order */
export const CATEGORY_LABELS: Record<SettingCategory, string> = {
	appearance: 'Appearance',
	editor: 'Editor & UI',
	shell: 'Shell & Terminal',
	notifications: 'Notifications',
	updates: 'Updates & Reporting',
	logging: 'Logging',
	web: 'Web Interface',
	ssh: 'SSH Remote',
	stats: 'Stats & Tracking',
	accessibility: 'Accessibility & Performance',
	'document-graph': 'Document Graph',
	context: 'Context Management',
	'file-indexing': 'File Indexing',
	integrations: 'Integrations',
	onboarding: 'Onboarding',
	advanced: 'Advanced',
	internal: 'Internal (auto-managed)',
};

/** Category display order */
export const CATEGORY_ORDER: SettingCategory[] = [
	'appearance',
	'editor',
	'shell',
	'notifications',
	'updates',
	'logging',
	'web',
	'ssh',
	'file-indexing',
	'context',
	'document-graph',
	'stats',
	'accessibility',
	'integrations',
	'onboarding',
	'advanced',
	'internal',
];

/**
 * Get the default value for a setting key.
 * Returns undefined for unknown keys.
 */
export function getSettingDefault(key: string): unknown {
	return SETTINGS_METADATA[key]?.default;
}

/**
 * Get metadata for a setting key.
 * Returns undefined for unknown keys.
 */
export function getSettingMetadata(key: string): SettingMetadata | undefined {
	return SETTINGS_METADATA[key];
}

/**
 * Build a complete defaults object from the metadata registry.
 */
export function getAllDefaults(): Record<string, unknown> {
	const defaults: Record<string, unknown> = {};
	for (const [key, meta] of Object.entries(SETTINGS_METADATA)) {
		defaults[key] = meta.default;
	}
	return defaults;
}
