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
import type { PluginCapability } from './permissions';

/**
 * Maximum UTF-8 size of one host view's serialized BlockView data. This pure
 * contract is shared by declaration parsing and runtime host-view updates so
 * plugin input cannot bypass the sandbox RPC message limit.
 */
export const MAX_HOST_VIEW_BLOCKS_BYTES = 1_000_000;

/**
 * Size of JSON data as it crosses a UTF-8 message boundary. Returns null when
 * the value is not serializable, rather than throwing from an input validator.
 */
export function serializedJsonByteLength(value: unknown): number | null {
	let serialized: string | undefined;
	try {
		serialized = JSON.stringify(value);
	} catch {
		return null;
	}
	if (typeof serialized !== 'string') return null;

	let bytes = 0;
	for (let index = 0; index < serialized.length; index += 1) {
		const codePoint = serialized.codePointAt(index);
		if (codePoint === undefined) continue;
		if (codePoint <= 0x7f) {
			bytes += 1;
		} else if (codePoint <= 0x7ff) {
			bytes += 2;
		} else if (codePoint <= 0xffff) {
			bytes += 3;
		} else {
			bytes += 4;
			index += 1;
		}
	}
	return bytes;
}

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

/**
 * A scheduled trigger a plugin declares (Cue-style, but plugin-scoped and run by
 * the supervised plugin scheduler rather than the per-project Cue engine).
 *
 * Tier 0 supports only the safe `notify` action (raise a toast). The `dispatch`
 * action (send a prompt to an agent) is part of the shape but requires the
 * agents:dispatch capability and is not executed until that capability is wired.
 */
export interface CueTriggerContribution {
	id: string;
	localId: string;
	pluginId: string;
	title: string;
	/** Recurring every N minutes, or at fixed local clock times (HH:MM). */
	schedule: { kind: 'interval'; everyMinutes: number } | { kind: 'dailyTimes'; times: string[] };
	action: 'notify' | 'dispatch';
	/** notify: the toast message. dispatch: the prompt (requires capability). */
	payload: string;
	/** dispatch only: the target agent id. */
	agentId?: string;
}

/**
 * A command a (tier-1) plugin exposes to the command palette. Invoking it sends
 * an `invokeCommand` RPC to the plugin's sandbox, where the plugin registered a
 * handler via `maestro.commands.register(localId, fn)`. Distinct from a
 * commandMacro (tier-0, just dispatches a prompt - no code).
 */
export interface CommandContribution {
	id: string;
	localId: string;
	pluginId: string;
	title: string;
	description?: string;
}

/** Where a contributed panel docks. `modal` (default) preserves today's
 * Settings-launched behavior; the others dock the same sandboxed iframe into a
 * UI slot via the contribution registry. */
export type PanelPlacement = 'modal' | 'left' | 'right' | 'main' | 'settings';

/**
 * A UI panel a (tier-1) plugin contributes. Rendered in a locked-down sandboxed
 * iframe (no same-origin, no top navigation) in the reserved plugin modal band,
 * or docked into a UI slot when `placement` is set.
 * `entry` is a plugin-relative HTML file (traversal-checked like manifest entry).
 */
export interface PanelContribution {
	id: string;
	localId: string;
	pluginId: string;
	title: string;
	/** Plugin-relative path to the panel's HTML entry. */
	entry: string;
	/** Where the panel docks. Defaults to `modal`. */
	placement: PanelPlacement;
}

/**
 * A runtime agent a (tier-1) plugin registers - a new entry in the Left Bar
 * backed by a plugin-declared CLI. This is the additive runtime counterpart to
 * the compile-time AGENT_IDS tuple: built-in agents keep their static union (and
 * exhaustiveness), runtime agents are looked up by id at runtime.
 *
 * `binaryName` + `baseArgs` describe how to launch the CLI. `capabilities` is a
 * boolean feature map (unknown keys dropped); the host fills sane defaults for
 * any it does not recognize. NOTE: actually SPAWNING a runtime agent is a
 * separate, security-reviewed wiring step (arbitrary binary execution) and is
 * intentionally not enabled by registration alone.
 */
export interface AgentContribution {
	id: string;
	localId: string;
	pluginId: string;
	displayName: string;
	binaryName: string;
	baseArgs: string[];
	capabilities: Record<string, boolean>;
}

/** A tool a (tier-1) plugin exposes for an agent to call: a named, described,
 * optionally schema-typed operation. The plugin registers a handler (like a
 * command) that the brokered request/response invoke runs, returning a result.
 * Surfacing a tool to a specific agent's model is a separate wiring step. */
export interface AgentToolContribution {
	id: string;
	localId: string;
	pluginId: string;
	name: string;
	description: string;
	/** Optional JSON-schema-ish description of the tool's input (stored loosely). */
	inputSchema?: Record<string, unknown>;
}

/** A keyboard shortcut a (tier-1) plugin binds to one of its commands. Parsed and
 * aggregated here so the host can register it; like agent contributions, the
 * registration is the additive foundation and actually binding the chord is a
 * separate consumption step. */
export interface KeybindingContribution {
	id: string;
	localId: string;
	pluginId: string;
	/** The shortcut chord, e.g. "Ctrl+Shift+P" (validated as a non-empty string). */
	key: string;
	/** The plugin-local command id to invoke when the chord fires. */
	command: string;
	description?: string;
}

/** Where a `ui:contribute` item renders. The renderer maps each surface to a
 * concrete region (status bar, menus, sidebar/activity bar, toolbar). */
export type UiSurface = 'status-bar' | 'menu' | 'sidebar' | 'activity-bar' | 'toolbar';

export const UI_SURFACES: readonly UiSurface[] = [
	'status-bar',
	'menu',
	'sidebar',
	'activity-bar',
	'toolbar',
];

/** Type guard: is `value` one of the known UI surfaces? */
export function isUiSurface(value: unknown): value is UiSurface {
	return typeof value === 'string' && (UI_SURFACES as readonly string[]).includes(value);
}

/**
 * A declarative UI item a (tier-1) plugin renders into a host surface. The item
 * is pure data (label / icon / placement) the host renders; activating it invokes
 * one of the plugin's OWN commands through the broker. Gated by the
 * `ui:contribute` capability (see `gateContributions`), so an enabled plugin
 * WITHOUT that grant contributes none.
 */
export interface UiItemContribution {
	id: string;
	localId: string;
	pluginId: string;
	surface: UiSurface;
	label: string;
	/** Plugin-local command id invoked on activation. */
	command: string;
	/** Optional icon keyword the renderer maps to its icon set. */
	icon?: string;
	/** Optional grouping / ordering hints within the surface. */
	group?: string;
	priority?: number;
}

/** The host-owned view surfaces that render only BlockView data. */
export type HostViewSurface = 'movement' | 'cadenza';

export const HOST_VIEW_SURFACES: readonly HostViewSurface[] = ['movement', 'cadenza'];

/** Type guard for the two host-rendered view surfaces. */
export function isHostViewSurface(value: unknown): value is HostViewSurface {
	return typeof value === 'string' && (HOST_VIEW_SURFACES as readonly string[]).includes(value);
}

/**
 * The only data accepted for a host view: the same BlockView top-level shapes
 * rendered by Maestro, never a cadenza command/prompt payload or plugin UI.
 */
export type HostViewBlocks = unknown[] | { blocks: unknown[] };

/**
 * A host-rendered view declared by a tier-1 plugin. The host owns its renderer;
 * the plugin supplies only static BlockView data and may later update/remove
 * that declared view through the brokered `ui:hostView` RPC methods.
 */
export interface HostViewContribution {
	id: string;
	localId: string;
	pluginId: string;
	surface: HostViewSurface;
	title: string;
	description?: string;
	blocks?: HostViewBlocks;
}

/** All contributions a single plugin declared, plus any per-item errors. */
export interface PluginContributions {
	themes: ThemeContribution[];
	prompts: PromptContribution[];
	settings: SettingContribution[];
	commandMacros: CommandMacroContribution[];
	cueTriggers: CueTriggerContribution[];
	commands: CommandContribution[];
	panels: PanelContribution[];
	agents: AgentContribution[];
	tools: AgentToolContribution[];
	keybindings: KeybindingContribution[];
	uiItems: UiItemContribution[];
	hostViews: HostViewContribution[];
	/** Human-readable reasons individual contributions were dropped. */
	errors: string[];
}

/** Contributions aggregated across every active plugin. */
export interface AggregatedContributions {
	themes: ThemeContribution[];
	prompts: PromptContribution[];
	settings: SettingContribution[];
	commandMacros: CommandMacroContribution[];
	cueTriggers: CueTriggerContribution[];
	commands: CommandContribution[];
	panels: PanelContribution[];
	agents: AgentContribution[];
	tools: AgentToolContribution[];
	keybindings: KeybindingContribution[];
	uiItems: UiItemContribution[];
	hostViews: HostViewContribution[];
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
		cueTriggers: [],
		commands: [],
		panels: [],
		agents: [],
		tools: [],
		keybindings: [],
		uiItems: [],
		hostViews: [],
		errors: [],
	};
	const contributes = manifest.contributes;
	if (!contributes) return out;
	const pluginId = manifest.id;
	// commands and panels run plugin code; only tier >= 1 may declare them.
	const isCodeTier = manifest.tier >= 1;

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
	for (const raw of asArray(contributes.cueTriggers)) {
		const t = parseCueTrigger(pluginId, raw, out.errors);
		if (t) out.cueTriggers.push(t);
	}
	if (contributes.commands !== undefined) {
		if (!isCodeTier) {
			out.errors.push(`[${pluginId}] commands require tier >= 1 (they run plugin code)`);
		} else {
			for (const raw of asArray(contributes.commands)) {
				const cmd = parseCommand(pluginId, raw, out.errors);
				if (cmd) out.commands.push(cmd);
			}
		}
	}
	if (contributes.panels !== undefined) {
		if (!isCodeTier) {
			out.errors.push(`[${pluginId}] panels require tier >= 1 (they run plugin UI)`);
		} else {
			for (const raw of asArray(contributes.panels)) {
				const panel = parsePanel(pluginId, raw, out.errors);
				if (panel) out.panels.push(panel);
			}
		}
	}
	if (contributes.agents !== undefined) {
		if (!isCodeTier) {
			out.errors.push(`[${pluginId}] agents require tier >= 1 (they launch a CLI)`);
		} else {
			for (const raw of asArray(contributes.agents)) {
				const agent = parseAgent(pluginId, raw, out.errors);
				if (agent) out.agents.push(agent);
			}
		}
	}
	if (contributes.tools !== undefined) {
		if (!isCodeTier) {
			out.errors.push(`[${pluginId}] tools require tier >= 1 (they run plugin code)`);
		} else {
			for (const raw of asArray(contributes.tools)) {
				const tool = parseTool(pluginId, raw, out.errors);
				if (tool) out.tools.push(tool);
			}
		}
	}
	if (contributes.keybindings !== undefined) {
		if (!isCodeTier) {
			out.errors.push(`[${pluginId}] keybindings require tier >= 1 (they invoke plugin commands)`);
		} else {
			for (const raw of asArray(contributes.keybindings)) {
				const kb = parseKeybinding(pluginId, raw, out.errors);
				if (kb) out.keybindings.push(kb);
			}
		}
	}
	if (contributes.uiItems !== undefined) {
		if (!isCodeTier) {
			out.errors.push(`[${pluginId}] uiItems require tier >= 1 (they invoke plugin commands)`);
		} else {
			for (const raw of asArray(contributes.uiItems)) {
				const item = parseUiItem(pluginId, raw, out.errors);
				if (item) out.uiItems.push(item);
			}
		}
	}
	if (contributes.hostViews !== undefined) {
		if (!isCodeTier) {
			out.errors.push(`[${pluginId}] hostViews require tier >= 1 (they are capability-gated)`);
		} else {
			for (const raw of asArray(contributes.hostViews)) {
				const hostView = parseHostView(pluginId, raw, out.errors);
				if (hostView) out.hostViews.push(hostView);
			}
		}
	}
	return out;
}

/**
 * Aggregate contributions across active plugins. On a namespaced-id collision
 * (should be impossible since ids are plugin-scoped, but defended anyway) the
 * first wins and the duplicate is recorded as an error. Pass `hasCapabilityFor`
 * (the verified per-plugin grants) to gate capability-scoped contributions
 * (`ui:contribute` items, `ui:panel` panels) DURING aggregation — the secure
 * default for the production path, so a render host can't forget to filter.
 */
export function aggregateContributions(
	manifests: PluginManifest[],
	hasCapabilityFor?: (pluginId: string, capability: PluginCapability) => boolean
): AggregatedContributions {
	const agg: AggregatedContributions = {
		themes: [],
		prompts: [],
		settings: [],
		commandMacros: [],
		cueTriggers: [],
		commands: [],
		panels: [],
		agents: [],
		tools: [],
		keybindings: [],
		uiItems: [],
		hostViews: [],
		errorsByPlugin: {},
	};
	const seen = new Set<string>();
	const pushUnique = <T extends { id: string; pluginId: string }>(
		bucket: string,
		list: T[],
		item: T
	): void => {
		// Uniqueness is per contribution TYPE: one plugin may legitimately reuse a
		// localId across types (a keybinding bound to its own command, or a tool
		// sharing a command's name), so key the dedup by bucket, not id alone.
		const key = `${bucket}:${item.id}`;
		if (seen.has(key)) {
			(agg.errorsByPlugin[item.pluginId] ??= []).push(
				`duplicate ${bucket} contribution id "${item.id}"`
			);
			return;
		}
		seen.add(key);
		list.push(item);
	};

	for (const manifest of manifests) {
		const collected = collectContributions(manifest);
		const c = hasCapabilityFor
			? gateContributions(collected, (cap) => hasCapabilityFor(manifest.id, cap))
			: collected;
		if (c.errors.length > 0) {
			(agg.errorsByPlugin[manifest.id] ??= []).push(...c.errors);
		}
		c.themes.forEach((t) => pushUnique('themes', agg.themes, t));
		c.prompts.forEach((p) => pushUnique('prompts', agg.prompts, p));
		c.settings.forEach((s) => pushUnique('settings', agg.settings, s));
		c.commandMacros.forEach((m) => pushUnique('commandMacros', agg.commandMacros, m));
		c.cueTriggers.forEach((t) => pushUnique('cueTriggers', agg.cueTriggers, t));
		c.commands.forEach((cmd) => pushUnique('commands', agg.commands, cmd));
		c.panels.forEach((panel) => pushUnique('panels', agg.panels, panel));
		c.agents.forEach((agent) => pushUnique('agents', agg.agents, agent));
		c.tools.forEach((t) => pushUnique('tools', agg.tools, t));
		c.keybindings.forEach((k) => pushUnique('keybindings', agg.keybindings, k));
		c.uiItems.forEach((u) => pushUnique('uiItems', agg.uiItems, u));
		c.hostViews.forEach((view) => pushUnique('hostViews', agg.hostViews, view));
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
	const settingKey = raw.key.trim();
	// The declarative path must mirror the runtime settings.set guards: a contributed
	// key is namespaced by the consumer, so reject anything that could escape that
	// namespace or hit a sensitive target - prototype-polluting segments, the feature
	// gate, secret-looking names, or path-style separators/traversal.
	if (/(^|\.)(__proto__|prototype|constructor)(\.|$)/.test(settingKey)) {
		errors.push(`[${pluginId}] setting "${localId}" key uses a reserved prototype segment`);
		return null;
	}
	if (/encorefeatures/i.test(settingKey)) {
		errors.push(`[${pluginId}] setting "${localId}" key may not target the feature gate`);
		return null;
	}
	if (
		/key|token|secret|password|credential|apikey|auth|bearer|oauth|jwt|private|cert|signing/i.test(
			settingKey
		)
	) {
		errors.push(`[${pluginId}] setting "${localId}" key looks secret-bearing and is not allowed`);
		return null;
	}
	if (/[\\/]|\.\./.test(settingKey)) {
		errors.push(`[${pluginId}] setting "${localId}" key may not contain path separators`);
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

/** HH:MM 24-hour clock time. */
const DAILY_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function parseCueTrigger(
	pluginId: string,
	raw: unknown,
	errors: string[]
): CueTriggerContribution | null {
	if (!isPlainObject(raw)) {
		errors.push(`[${pluginId}] a cueTrigger contribution is not an object`);
		return null;
	}
	const localId = parseLocalId(pluginId, raw, errors);
	if (!localId) return null;
	if (!isNonEmptyString(raw.title)) {
		errors.push(`[${pluginId}] cueTrigger "${localId}" is missing a title`);
		return null;
	}

	const sched = isPlainObject(raw.schedule) ? raw.schedule : undefined;
	if (!sched) {
		errors.push(`[${pluginId}] cueTrigger "${localId}" is missing a schedule`);
		return null;
	}
	let schedule: CueTriggerContribution['schedule'];
	if (sched.kind === 'interval') {
		const every = sched.everyMinutes;
		if (typeof every !== 'number' || !Number.isFinite(every) || every < 1) {
			errors.push(`[${pluginId}] cueTrigger "${localId}" everyMinutes must be a number >= 1`);
			return null;
		}
		schedule = { kind: 'interval', everyMinutes: Math.floor(every) };
	} else if (sched.kind === 'dailyTimes') {
		const times = Array.isArray(sched.times)
			? sched.times.filter((t): t is string => typeof t === 'string' && DAILY_TIME_PATTERN.test(t))
			: [];
		if (times.length === 0) {
			errors.push(`[${pluginId}] cueTrigger "${localId}" needs at least one HH:MM time`);
			return null;
		}
		schedule = { kind: 'dailyTimes', times };
	} else {
		errors.push(
			`[${pluginId}] cueTrigger "${localId}" schedule.kind must be interval or dailyTimes`
		);
		return null;
	}

	const action = raw.action === 'dispatch' ? 'dispatch' : raw.action === 'notify' ? 'notify' : null;
	if (!action) {
		errors.push(`[${pluginId}] cueTrigger "${localId}" action must be notify or dispatch`);
		return null;
	}
	if (!isNonEmptyString(raw.payload)) {
		errors.push(`[${pluginId}] cueTrigger "${localId}" is missing a payload`);
		return null;
	}
	if (action === 'dispatch' && !isNonEmptyString(raw.agentId)) {
		errors.push(`[${pluginId}] cueTrigger "${localId}" dispatch action requires an agentId`);
		return null;
	}

	return {
		id: namespaced(pluginId, localId),
		localId,
		pluginId,
		title: raw.title.trim(),
		schedule,
		action,
		payload: raw.payload,
		...(action === 'dispatch' && isNonEmptyString(raw.agentId)
			? { agentId: raw.agentId.trim() }
			: {}),
	};
}

function parseCommand(
	pluginId: string,
	raw: unknown,
	errors: string[]
): CommandContribution | null {
	if (!isPlainObject(raw)) {
		errors.push(`[${pluginId}] a command contribution is not an object`);
		return null;
	}
	const localId = parseLocalId(pluginId, raw, errors);
	if (!localId) return null;
	if (!isNonEmptyString(raw.title)) {
		errors.push(`[${pluginId}] command "${localId}" is missing a title`);
		return null;
	}
	return {
		id: namespaced(pluginId, localId),
		localId,
		pluginId,
		title: raw.title.trim(),
		...(isNonEmptyString(raw.description) ? { description: raw.description.trim() } : {}),
	};
}

function parseTool(pluginId: string, raw: unknown, errors: string[]): AgentToolContribution | null {
	if (!isPlainObject(raw)) {
		errors.push(`[${pluginId}] a tool contribution is not an object`);
		return null;
	}
	const localId = parseLocalId(pluginId, raw, errors);
	if (!localId) return null;
	if (!isNonEmptyString(raw.name)) {
		errors.push(`[${pluginId}] tool "${localId}" is missing a name`);
		return null;
	}
	if (!isNonEmptyString(raw.description)) {
		errors.push(`[${pluginId}] tool "${localId}" is missing a description`);
		return null;
	}
	return {
		id: namespaced(pluginId, localId),
		localId,
		pluginId,
		name: raw.name.trim(),
		description: raw.description.trim(),
		...(isPlainObject(raw.inputSchema) ? { inputSchema: raw.inputSchema } : {}),
	};
}

function parseKeybinding(
	pluginId: string,
	raw: unknown,
	errors: string[]
): KeybindingContribution | null {
	if (!isPlainObject(raw)) {
		errors.push(`[${pluginId}] a keybinding contribution is not an object`);
		return null;
	}
	const localId = parseLocalId(pluginId, raw, errors);
	if (!localId) return null;
	if (!isNonEmptyString(raw.key)) {
		errors.push(`[${pluginId}] keybinding "${localId}" is missing a key chord`);
		return null;
	}
	if (!isNonEmptyString(raw.command) || !LOCAL_ID_PATTERN.test(raw.command.trim())) {
		errors.push(`[${pluginId}] keybinding "${localId}" command must be a plugin-local command id`);
		return null;
	}
	return {
		id: namespaced(pluginId, localId),
		localId,
		pluginId,
		key: raw.key.trim(),
		command: raw.command.trim(),
		...(isNonEmptyString(raw.description) ? { description: raw.description.trim() } : {}),
	};
}

function parseUiItem(pluginId: string, raw: unknown, errors: string[]): UiItemContribution | null {
	if (!isPlainObject(raw)) {
		errors.push(`[${pluginId}] a uiItem contribution is not an object`);
		return null;
	}
	const localId = parseLocalId(pluginId, raw, errors);
	if (!localId) return null;
	if (!isUiSurface(raw.surface)) {
		errors.push(`[${pluginId}] uiItem "${localId}" has an invalid or missing surface`);
		return null;
	}
	if (!isNonEmptyString(raw.label)) {
		errors.push(`[${pluginId}] uiItem "${localId}" is missing a label`);
		return null;
	}
	if (!isNonEmptyString(raw.command) || !LOCAL_ID_PATTERN.test(raw.command.trim())) {
		errors.push(`[${pluginId}] uiItem "${localId}" command must be a plugin-local command id`);
		return null;
	}
	const priority =
		typeof raw.priority === 'number' && Number.isFinite(raw.priority) ? raw.priority : undefined;
	return {
		id: namespaced(pluginId, localId),
		localId,
		pluginId,
		surface: raw.surface,
		label: raw.label.trim(),
		command: raw.command.trim(),
		...(isNonEmptyString(raw.icon) ? { icon: raw.icon.trim() } : {}),
		...(isNonEmptyString(raw.group) ? { group: raw.group.trim() } : {}),
		...(priority !== undefined ? { priority } : {}),
	};
}

function isHostViewBlocks(value: unknown): value is HostViewBlocks {
	return (
		Array.isArray(value) ||
		(isPlainObject(value) && Object.keys(value).length === 1 && Array.isArray(value.blocks))
	);
}

function parseHostView(
	pluginId: string,
	raw: unknown,
	errors: string[]
): HostViewContribution | null {
	if (!isPlainObject(raw)) {
		errors.push(`[${pluginId}] a hostView contribution is not an object`);
		return null;
	}
	const localId = parseLocalId(pluginId, raw, errors);
	if (!localId) return null;
	if (!isHostViewSurface(raw.surface)) {
		errors.push(`[${pluginId}] hostView "${localId}" has an invalid or missing surface`);
		return null;
	}
	if (!isNonEmptyString(raw.title)) {
		errors.push(`[${pluginId}] hostView "${localId}" is missing a title`);
		return null;
	}
	if (raw.blocks !== undefined) {
		if (!isHostViewBlocks(raw.blocks)) {
			errors.push(`[${pluginId}] hostView "${localId}" blocks must be BlockView data`);
			return null;
		}
		const blockBytes = serializedJsonByteLength(raw.blocks);
		if (blockBytes === null) {
			errors.push(`[${pluginId}] hostView "${localId}" blocks must be JSON-serializable`);
			return null;
		}
		if (blockBytes > MAX_HOST_VIEW_BLOCKS_BYTES) {
			errors.push(
				`[${pluginId}] hostView "${localId}" blocks exceed the ${MAX_HOST_VIEW_BLOCKS_BYTES}-byte size limit`
			);
			return null;
		}
	}
	return {
		id: namespaced(pluginId, localId),
		localId,
		pluginId,
		surface: raw.surface,
		title: raw.title.trim(),
		...(isNonEmptyString(raw.description) ? { description: raw.description.trim() } : {}),
		...(raw.blocks !== undefined ? { blocks: raw.blocks } : {}),
	};
}

/**
 * Drop capability-gated contributions a plugin does NOT hold the grant for. The
 * render host calls this with the plugin's VERIFIED grants so customization is
 * gated per-capability, not merely by the plugin being enabled: UI items need
 * `ui:contribute`, panels need `ui:panel`, and host views need `ui:hostView`.
 */
export function gateContributions(
	plugin: PluginContributions,
	hasCapability: (capability: PluginCapability) => boolean
): PluginContributions {
	return {
		...plugin,
		uiItems: hasCapability('ui:contribute') ? plugin.uiItems : [],
		panels: hasCapability('ui:panel') ? plugin.panels : [],
		hostViews: hasCapability('ui:hostView') ? plugin.hostViews : [],
	};
}

/** A panel entry must be a relative path inside the plugin (no traversal). */
function isSafeRelativeEntry(entry: string): boolean {
	if (entry.startsWith('~') || entry.startsWith('/') || entry.startsWith('\\')) return false;
	if (/^[a-zA-Z]:[\\/]/.test(entry)) return false;
	return !entry.split(/[\\/]+/).includes('..');
}

const PANEL_PLACEMENTS: readonly PanelPlacement[] = ['modal', 'left', 'right', 'main', 'settings'];

/** Parse an optional panel placement, defaulting to `modal`; an invalid value is
 * an error but never drops the panel (it docks in the safe default slot). */
function parsePanelPlacement(
	pluginId: string,
	localId: string,
	raw: unknown,
	errors: string[]
): PanelPlacement {
	if (raw === undefined) return 'modal';
	if (typeof raw === 'string' && (PANEL_PLACEMENTS as readonly string[]).includes(raw)) {
		return raw as PanelPlacement;
	}
	errors.push(`[${pluginId}] panel "${localId}" has an invalid placement; defaulting to modal`);
	return 'modal';
}

function parsePanel(pluginId: string, raw: unknown, errors: string[]): PanelContribution | null {
	if (!isPlainObject(raw)) {
		errors.push(`[${pluginId}] a panel contribution is not an object`);
		return null;
	}
	const localId = parseLocalId(pluginId, raw, errors);
	if (!localId) return null;
	if (!isNonEmptyString(raw.title)) {
		errors.push(`[${pluginId}] panel "${localId}" is missing a title`);
		return null;
	}
	if (!isNonEmptyString(raw.entry) || !isSafeRelativeEntry(raw.entry.trim())) {
		errors.push(`[${pluginId}] panel "${localId}" entry must be a relative path inside the plugin`);
		return null;
	}
	const placement = parsePanelPlacement(pluginId, localId, raw.placement, errors);
	return {
		id: namespaced(pluginId, localId),
		localId,
		pluginId,
		title: raw.title.trim(),
		entry: raw.entry.trim(),
		placement,
	};
}

/** A binary name must be a bare command - no path separators, no traversal,
 * no shell metacharacters. The host resolves it on PATH; absolute paths and
 * relative climbs are rejected so a plugin cannot point at an arbitrary file. */
function isSafeBinaryName(name: string): boolean {
	if (name.includes('/') || name.includes('\\')) return false;
	if (name.includes('..') || name.startsWith('~')) return false;
	return /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name);
}

function parseAgent(pluginId: string, raw: unknown, errors: string[]): AgentContribution | null {
	if (!isPlainObject(raw)) {
		errors.push(`[${pluginId}] an agent contribution is not an object`);
		return null;
	}
	const localId = parseLocalId(pluginId, raw, errors);
	if (!localId) return null;
	if (!isNonEmptyString(raw.displayName)) {
		errors.push(`[${pluginId}] agent "${localId}" is missing a displayName`);
		return null;
	}
	if (!isNonEmptyString(raw.binaryName) || !isSafeBinaryName(raw.binaryName.trim())) {
		errors.push(`[${pluginId}] agent "${localId}" binaryName must be a bare command name`);
		return null;
	}
	// baseArgs: keep only string entries; a non-array or stray non-strings are dropped silently.
	const baseArgs = Array.isArray(raw.baseArgs)
		? raw.baseArgs.filter((a): a is string => typeof a === 'string')
		: [];
	// capabilities: keep only boolean-valued keys; unknown shapes collapse to {}.
	const capabilities: Record<string, boolean> = {};
	if (isPlainObject(raw.capabilities)) {
		for (const [k, v] of Object.entries(raw.capabilities)) {
			if (typeof v === 'boolean') capabilities[k] = v;
		}
	}
	return {
		id: namespaced(pluginId, localId),
		localId,
		pluginId,
		displayName: raw.displayName.trim(),
		binaryName: raw.binaryName.trim(),
		baseArgs,
		capabilities,
	};
}
