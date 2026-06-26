/**
 * Tier 0 (data-only) plugin contributions.
 *
 * A plugin declares what it adds to Maestro under `contributes` in its
 * plugin.json. Tier 0 contributions are pure data - no code executes - so they
 * are validated with the same hand-rolled, bundle-safe approach as the manifest
 * itself, then aggregated across all active plugins into typed buckets the host
 * registries can consume.
 *
 * Ids are namespaced by plugin id (`<pluginId>/<localId>`) so two plugins can
 * declare a theme called "midnight" without colliding, and so any contribution
 * can always be traced back to the plugin that supplied it.
 */

import type { PluginManifest } from './plugin-manifest';

/** A theme a plugin adds to the theme picker. Colors are validated loosely
 * (a string map) here; the renderer maps them onto its ThemeColors shape. */
export interface ThemeContribution {
	/** Namespaced id: `<pluginId>/<localId>`. */
	id: string;
	/** Id as authored in the manifest (before namespacing). */
	localId: string;
	/** Owning plugin id. */
	pluginId: string;
	name: string;
	mode: 'light' | 'dark';
	colors: Record<string, string>;
}

/** A reusable prompt a plugin adds to the prompt catalog. */
export interface PromptContribution {
	id: string;
	localId: string;
	pluginId: string;
	title: string;
	content: string;
	description?: string;
}

/** A declarative setting a plugin adds. Default is preserved verbatim. */
export interface SettingContribution {
	id: string;
	localId: string;
	pluginId: string;
	key: string;
	type: 'boolean' | 'string' | 'number';
	default: boolean | string | number;
	description?: string;
}

/** A command macro: a named, templated prompt the command palette can dispatch. */
export interface CommandMacroContribution {
	id: string;
	localId: string;
	pluginId: string;
	title: string;
	prompt: string;
	description?: string;
}

/** All contributions a single plugin declared, plus any per-item errors. */
export interface PluginContributions {
	themes: ThemeContribution[];
	prompts: PromptContribution[];
	settings: SettingContribution[];
	commandMacros: CommandMacroContribution[];
	/** Human-readable reasons individual contributions were dropped. */
	errors: string[];
}

/** Contributions aggregated across every active plugin. */
export interface AggregatedContributions {
	themes: ThemeContribution[];
	prompts: PromptContribution[];
	settings: SettingContribution[];
	commandMacros: CommandMacroContribution[];
	/** Per-plugin errors keyed by plugin id (only plugins with errors appear). */
	errorsByPlugin: Record<string, string[]>;
}

/** Local-id shape for a contribution: kebab/dotted, starts with a letter. */
const LOCAL_ID_PATTERN = /^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.trim() !== '';
}

function namespaced(pluginId: string, localId: string): string {
	return `${pluginId}/${localId}`;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/**
 * Validate and collect one plugin's Tier 0 contributions. Invalid individual
 * items are dropped with an error message rather than failing the whole plugin -
 * a typo in one theme should not hide a plugin's good prompts.
 */
export function collectContributions(manifest: PluginManifest): PluginContributions {
	const out: PluginContributions = {
		themes: [],
		prompts: [],
		settings: [],
		commandMacros: [],
		errors: [],
	};
	const contributes = manifest.contributes;
	if (!contributes) return out;
	const pluginId = manifest.id;

	for (const raw of asArray(contributes.themes)) {
		const t = parseTheme(pluginId, raw, out.errors);
		if (t) out.themes.push(t);
	}
	for (const raw of asArray(contributes.prompts)) {
		const p = parsePrompt(pluginId, raw, out.errors);
		if (p) out.prompts.push(p);
	}
	for (const raw of asArray(contributes.settings)) {
		const s = parseSetting(pluginId, raw, out.errors);
		if (s) out.settings.push(s);
	}
	for (const raw of asArray(contributes.commandMacros)) {
		const m = parseCommandMacro(pluginId, raw, out.errors);
		if (m) out.commandMacros.push(m);
	}
	return out;
}

/**
 * Aggregate contributions across active plugins. On a namespaced-id collision
 * (should be impossible since ids are plugin-scoped, but defended anyway) the
 * first wins and the duplicate is recorded as an error.
 */
export function aggregateContributions(manifests: PluginManifest[]): AggregatedContributions {
	const agg: AggregatedContributions = {
		themes: [],
		prompts: [],
		settings: [],
		commandMacros: [],
		errorsByPlugin: {},
	};
	const seen = new Set<string>();
	const pushUnique = <T extends { id: string; pluginId: string }>(list: T[], item: T): void => {
		if (seen.has(item.id)) {
			(agg.errorsByPlugin[item.pluginId] ??= []).push(`duplicate contribution id "${item.id}"`);
			return;
		}
		seen.add(item.id);
		list.push(item);
	};

	for (const manifest of manifests) {
		const c = collectContributions(manifest);
		if (c.errors.length > 0) {
			(agg.errorsByPlugin[manifest.id] ??= []).push(...c.errors);
		}
		c.themes.forEach((t) => pushUnique(agg.themes, t));
		c.prompts.forEach((p) => pushUnique(agg.prompts, p));
		c.settings.forEach((s) => pushUnique(agg.settings, s));
		c.commandMacros.forEach((m) => pushUnique(agg.commandMacros, m));
	}
	return agg;
}

function parseLocalId(
	pluginId: string,
	raw: Record<string, unknown>,
	errors: string[]
): string | null {
	const localId = raw.id;
	if (!isNonEmptyString(localId)) {
		errors.push(`[${pluginId}] contribution is missing a string id`);
		return null;
	}
	if (!LOCAL_ID_PATTERN.test(localId)) {
		errors.push(`[${pluginId}] contribution id "${localId}" is not a valid id`);
		return null;
	}
	return localId;
}

function parseTheme(pluginId: string, raw: unknown, errors: string[]): ThemeContribution | null {
	if (!isPlainObject(raw)) {
		errors.push(`[${pluginId}] a theme contribution is not an object`);
		return null;
	}
	const localId = parseLocalId(pluginId, raw, errors);
	if (!localId) return null;
	if (!isNonEmptyString(raw.name)) {
		errors.push(`[${pluginId}] theme "${localId}" is missing a name`);
		return null;
	}
	if (raw.mode !== 'light' && raw.mode !== 'dark') {
		errors.push(`[${pluginId}] theme "${localId}" mode must be "light" or "dark"`);
		return null;
	}
	if (!isPlainObject(raw.colors)) {
		errors.push(`[${pluginId}] theme "${localId}" is missing a colors object`);
		return null;
	}
	const colors: Record<string, string> = {};
	for (const [k, v] of Object.entries(raw.colors)) {
		if (typeof v === 'string') colors[k] = v;
	}
	if (Object.keys(colors).length === 0) {
		errors.push(`[${pluginId}] theme "${localId}" has no string colors`);
		return null;
	}
	return {
		id: namespaced(pluginId, localId),
		localId,
		pluginId,
		name: raw.name.trim(),
		mode: raw.mode,
		colors,
	};
}

function parsePrompt(pluginId: string, raw: unknown, errors: string[]): PromptContribution | null {
	if (!isPlainObject(raw)) {
		errors.push(`[${pluginId}] a prompt contribution is not an object`);
		return null;
	}
	const localId = parseLocalId(pluginId, raw, errors);
	if (!localId) return null;
	if (!isNonEmptyString(raw.title)) {
		errors.push(`[${pluginId}] prompt "${localId}" is missing a title`);
		return null;
	}
	if (!isNonEmptyString(raw.content)) {
		errors.push(`[${pluginId}] prompt "${localId}" is missing content`);
		return null;
	}
	return {
		id: namespaced(pluginId, localId),
		localId,
		pluginId,
		title: raw.title.trim(),
		content: raw.content,
		...(isNonEmptyString(raw.description) ? { description: raw.description.trim() } : {}),
	};
}

function parseSetting(
	pluginId: string,
	raw: unknown,
	errors: string[]
): SettingContribution | null {
	if (!isPlainObject(raw)) {
		errors.push(`[${pluginId}] a setting contribution is not an object`);
		return null;
	}
	const localId = parseLocalId(pluginId, raw, errors);
	if (!localId) return null;
	if (!isNonEmptyString(raw.key)) {
		errors.push(`[${pluginId}] setting "${localId}" is missing a key`);
		return null;
	}
	if (raw.type !== 'boolean' && raw.type !== 'string' && raw.type !== 'number') {
		errors.push(`[${pluginId}] setting "${localId}" type must be boolean, string, or number`);
		return null;
	}
	const def = raw.default;
	const defOk =
		(raw.type === 'boolean' && typeof def === 'boolean') ||
		(raw.type === 'string' && typeof def === 'string') ||
		(raw.type === 'number' && typeof def === 'number');
	if (!defOk) {
		errors.push(`[${pluginId}] setting "${localId}" default does not match its type`);
		return null;
	}
	return {
		id: namespaced(pluginId, localId),
		localId,
		pluginId,
		key: raw.key.trim(),
		type: raw.type,
		default: def as boolean | string | number,
		...(isNonEmptyString(raw.description) ? { description: raw.description.trim() } : {}),
	};
}

function parseCommandMacro(
	pluginId: string,
	raw: unknown,
	errors: string[]
): CommandMacroContribution | null {
	if (!isPlainObject(raw)) {
		errors.push(`[${pluginId}] a commandMacro contribution is not an object`);
		return null;
	}
	const localId = parseLocalId(pluginId, raw, errors);
	if (!localId) return null;
	if (!isNonEmptyString(raw.title)) {
		errors.push(`[${pluginId}] commandMacro "${localId}" is missing a title`);
		return null;
	}
	if (!isNonEmptyString(raw.prompt)) {
		errors.push(`[${pluginId}] commandMacro "${localId}" is missing a prompt`);
		return null;
	}
	return {
		id: namespaced(pluginId, localId),
		localId,
		pluginId,
		title: raw.title.trim(),
		prompt: raw.prompt,
		...(isNonEmptyString(raw.description) ? { description: raw.description.trim() } : {}),
	};
}
