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
import {
	VOICE_SETTINGS_KEY,
	VOICE_SETTING_FIELDS,
	isVoiceSettingPath,
	redactVoiceSettings,
	unknownVoiceSettingMessage,
	voiceSettingDefault,
	voiceSettingProblem,
} from './acappella/voice-settings-schema';
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
 * A check a setting's own field table applies before a write, for a setting
 * that is one object with many fields. `path` is the path under the setting
 * (empty for the whole object).
 */
interface NestedSettingSchema {
	/** Why `value` cannot be written at `path`, or null when it can. */
	problem: (path: string, value: unknown) => string | null;
	/** The value an unset field reads as, or undefined when `path` is not one field. */
	defaultFor: (path: string) => unknown;
	/** Whether a path names one field (as opposed to a section, or nothing). */
	isField: (path: string) => boolean;
	/** Whether a field takes text, so a numeric-looking argument is kept as typed. */
	isText: (path: string) => boolean;
	/** `value` (read at `path`) with every secret in it masked. */
	redact: (path: string, value: unknown) => unknown;
	/** Why `path` names nothing stored, or null when it names a field or a section. */
	pathProblem: (path: string) => string | null;
}

/**
 * The settings that are one object with a field table of their own. A write
 * to any path under one of them is checked against its table, so the CLI
 * cannot store a value the setting's own panel would refuse.
 */
const NESTED_SETTING_SCHEMAS: Readonly<Record<string, NestedSettingSchema>> = {
	[VOICE_SETTINGS_KEY]: {
		problem: voiceSettingProblem,
		defaultFor: voiceSettingDefault,
		isField: (path) => path in VOICE_SETTING_FIELDS,
		isText: (path) => VOICE_SETTING_FIELDS[path]?.kind === 'string',
		redact: redactVoiceSettings,
		pathProblem: (path) => (isVoiceSettingPath(path) ? null : unknownVoiceSettingMessage(path)),
	},
};

/** A dotted key as its top-level setting and the path under it. */
function splitSettingKey(key: string): { topKey: string; path: string } {
	const dot = key.indexOf('.');
	return dot === -1
		? { topKey: key, path: '' }
		: { topKey: key.slice(0, dot), path: key.slice(dot + 1) };
}

/**
 * Why `value` cannot be written at `key`, or null when the write is allowed.
 * Only a setting with a field table is checked; every other key is free-form.
 */
export function nestedSettingProblem(key: string, value: unknown): string | null {
	const { topKey, path } = splitSettingKey(key);
	return NESTED_SETTING_SCHEMAS[topKey]?.problem(path, value) ?? null;
}

/**
 * Why `key` names nothing a reader would find, or null when it does. Only a
 * path under a setting with a field table can be wrong; every other key is
 * free-form.
 */
export function nestedSettingPathProblem(key: string): string | null {
	const { topKey, path } = splitSettingKey(key);
	return NESTED_SETTING_SCHEMAS[topKey]?.pathProblem(path) ?? null;
}

/** Whether `key` names a text field of a setting with a field table. */
export function isNestedTextSetting(key: string): boolean {
	const { topKey, path } = splitSettingKey(key);
	return NESTED_SETTING_SCHEMAS[topKey]?.isText(path) ?? false;
}

/**
 * The default of a key at any depth: the metadata default for a top-level key,
 * and the field's own default for a path under a setting with a field table.
 * Undefined for a nested path nothing describes.
 */
export function getSettingDefaultAtPath(key: string): unknown {
	const { topKey, path } = splitSettingKey(key);
	if (!path) return getSettingDefault(topKey);
	const schema = NESTED_SETTING_SCHEMAS[topKey];
	return schema?.isField(path) ? schema.defaultFor(path) : undefined;
}

/**
 * `value`, as read at `key`, with the secrets a field table marks masked. The
 * value comes back untouched for a key with no table, and for a read of the
 * secret field itself: naming a secret's own path is asking for it, as it is
 * for any other sensitive setting.
 */
export function redactNestedSettingSecrets(key: string, value: unknown): unknown {
	const { topKey, path } = splitSettingKey(key);
	return NESTED_SETTING_SCHEMAS[topKey]?.redact(path, value) ?? value;
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
