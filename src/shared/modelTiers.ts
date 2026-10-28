/**
 * Provider-normalized model tiers and effort levels.
 *
 * Maestro speaks one vocabulary for "how much horsepower does this turn need":
 * `low | medium | high`, for both the model TIER and the EFFORT level. Every
 * provider spells those differently (or not at all), so this module is the one
 * place that translates. An Auto Run document says `tier="high"`; what actually
 * reaches the command line depends on which agent is running it.
 *
 * Two separate axes, deliberately:
 *
 * - **Tier** picks WHICH model. Only meaningful where we can name a model with
 *   confidence, which is fewer providers than you would hope (see below).
 * - **Effort** picks how hard that model thinks. Orthogonal: a low-tier model
 *   at high effort is a perfectly sensible request.
 *
 * The ladder rule for effort: `low` is the FLOOR of the provider's ladder,
 * `high` is the CEILING, `medium` is the middle rung. That is why the mapping
 * is not the identity even where the provider happens to use the same three
 * words. Claude's ladder runs `low, medium, high, xhigh, max`, so Maestro's
 * `high` means `max` (the actual ceiling) and Maestro's `medium` means `high`
 * (the actual middle). Codex's ceiling is `xhigh`, the top rung every one of
 * its models accepts. The tables below
 * are written out per provider rather than computed from an index so the
 * resolution is auditable by reading it - a surprising row should be obvious
 * here rather than discovered at runtime.
 *
 * Unmapped is a first-class answer. `undefined` means "we have no opinion for
 * this provider, use the agent's own configured default", and callers surface
 * that as a visible warning rather than a silent substitution. Quietly running
 * a deep-planning task on whatever the default model is - when the document
 * asked for the top tier - is the failure this module exists to prevent.
 */

import type { ToolType } from './types';
import { FALLBACK_CONTEXT_WINDOW, getModelContextWindowOverride } from './agentConstants';
import { isValidAgentId, type AgentId } from './agentIds';
import { getAgentDisplayName, PICKABLE_AGENT_IDS } from './agentMetadata';
import type { LocalModelEndpoint } from './local-models/endpoints';
import {
	agentRunOnSupport,
	formatRunOnSpec,
	parseRunOnEdit,
	parseRunOnSpec,
	parseRunOnTarget,
	RUN_ON_PROVIDER_SPEC,
	runOnPillLabel,
	runOnTargetLabel,
	storedRunOnNamesSource,
	type RunOnSourceTarget,
	type RunOnTarget,
} from './local-models/run-on';
import { runOnModelFacts, type RunOnPickerSource } from './local-models/run-on-picker';
import { getAgentCapabilities } from './maestro-lib/providers/capabilities';
import { asTierLevel, TIER_LEVELS, type EffortLevel, type ModelTier } from './tierLevels';
import { getEffortRejection, type EffortRejection } from './effortRejection';

// The vocabulary itself (`low | medium | high`) lives in `tierLevels.ts`, a leaf
// with no imports, and is re-exported here so every caller keeps one import.
// It is apart because this module reaches the Local Models task registry
// (through `run-on.ts`), and the registry needs the three words too: importing
// them from here would close a cycle.
export { TIER_LEVELS, asTierLevel, type EffortLevel, type ModelTier } from './tierLevels';

/**
 * Effort ladders, per provider, floor to ceiling.
 *
 * Mirrors the `effort` / `reasoningEffort` option in `src/main/agents/definitions.ts`
 * minus the leading empty string (which means "provider default", not a rung).
 * OpenCode is absent on purpose: it exposes no effort knob at all, so an effort
 * hint on an OpenCode agent has nothing to write and resolves to `undefined`.
 *
 * These are static rather than read from runtime discovery because a document
 * must resolve identically on every machine. Discovery can ADD rungs a given
 * install supports; it cannot be allowed to silently change what `high` means
 * for a playbook someone else wrote.
 *
 * The one runtime input is a REFUSAL. A static table goes stale the day a
 * provider retires a rung, and the provider then fails the turn outright rather
 * than clamping. A value the provider has refused in this process resolves to
 * `undefined` from then on (see `effortRejection.ts`): never a different value,
 * only "inherit the agent's own", and always reported.
 */
const EFFORT_LADDERS: Partial<Record<ToolType, Record<EffortLevel, string>>> = {
	// Ladder: low, medium, high, xhigh, max
	'claude-code': { low: 'low', medium: 'high', high: 'max' },
	// Ladder: low, medium, high, xhigh (then max / ultra on some models).
	// The floor is `low`, NOT `minimal`: no model in Codex's catalogue accepts
	// `minimal` any more, and the API answers it with a 400 rather than
	// clamping, so every cheap turn (tab naming, synopsis) died with no output.
	// `xhigh` stays the ceiling because it is the highest rung EVERY model
	// lists; `max` and `ultra` are per-model.
	codex: { low: 'low', medium: 'medium', high: 'xhigh' },
	// Ladder: low, medium, high - the one provider where the mapping IS the identity.
	'factory-droid': { low: 'low', medium: 'medium', high: 'high' },
	// Ladder: low, medium, high, xhigh. Even-length, so "middle" is a judgment
	// call: medium takes the lower of the two central rungs, matching the name.
	'copilot-cli': { low: 'low', medium: 'medium', high: 'xhigh' },
};

/**
 * Model tiers, per provider.
 *
 * Deliberately sparse. A tier map is only shipped where the identifiers are
 * stable enough that a playbook written today still resolves correctly in six
 * months:
 *
 * - `claude-code` uses the permanent aliases, which always resolve to the
 *   current model in each tier. Safe indefinitely.
 * - `factory-droid` takes one model family so the three tiers are genuinely
 *   comparable. The IDs are versioned and will need revising, but they are
 *   already hard-coded in the agent definition, so this is no new exposure.
 * - `codex` maps by FAMILY. Its catalogue names three lines that keep their
 *   role across generations: Luna ("fast and affordable"), Sol ("workhorse for
 *   coding") and Astra ("frontier intelligence"); gpt-5.6-luna became
 *   gpt-6-luna. The table names the newest listed member of each family. The
 *   slugs DO churn, so they must be bumped when a generation lands; two things
 *   keep that from going wrong quietly: a stale slug is refused by Codex with a
 *   400 rather than run on some other model, and the agent detector logs a
 *   warning naming the replacement when a slug here is not in the user's
 *   catalogue (`staleTierModels`). All three were checked with a real
 *   turn on Codex CLI 0.162.1 with a ChatGPT login (2026-10-11).
 *
 * Absent on purpose: `copilot-cli` discovers its catalogue at runtime
 * (models.dev) with no stable family names; `opencode` runs whatever the user
 * configured, which may be a local Ollama model with no knowable tier.
 * Guessing for those would produce a table that silently rots into naming
 * models the user cannot run. They resolve to the agent default, and the
 * caller says so out loud.
 */
const TIER_MODELS: Partial<Record<ToolType, Record<ModelTier, string>>> = {
	'claude-code': { low: 'haiku', medium: 'sonnet', high: 'opus' },
	'factory-droid': {
		low: 'claude-haiku-4-5-20251001',
		medium: 'claude-sonnet-4-5-20250929',
		high: 'claude-opus-4-5-20251101',
	},
	codex: { low: 'gpt-6-luna', medium: 'gpt-6.1-sol', high: 'gpt-6-astra' },
};

/** The Codex model family behind each tier (see the `codex` row above). */
export const CODEX_TIER_FAMILIES: Readonly<Record<ModelTier, string>> = Object.freeze({
	low: 'luna',
	medium: 'sol',
	high: 'astra',
});

/** One entry of Codex's `models_cache.json`, as much of it as Maestro reads. */
export interface CodexCatalogModel {
	slug?: string;
	description?: string;
	visibility?: string;
	priority?: number;
}

/**
 * One model in a harness's own catalogue, with what the catalogue states about
 * it. Most catalogues state only the id. Codex also states a sentence and an
 * order, and those are the only facts Suggest ranks a provider's models by.
 */
export interface HarnessCatalogModel {
	/** What the harness takes as its model argument. */
	id: string;
	/** The catalogue's own sentence about the model. */
	description?: string;
	/** The catalogue's own order, lowest first. */
	priority?: number;
}

/**
 * Codex's `models_cache.json` entries as a catalogue: the listed models only (a
 * hidden one cannot be picked), in the file's order, each with the description
 * and priority Codex states.
 */
export function codexCatalogModels(raw: readonly CodexCatalogModel[]): HarnessCatalogModel[] {
	const catalog: HarnessCatalogModel[] = [];
	for (const entry of raw) {
		if (typeof entry?.slug !== 'string' || entry.slug === '' || entry.visibility === 'hide') {
			continue;
		}
		catalog.push({
			id: entry.slug,
			...(typeof entry.description === 'string' && entry.description.trim() !== ''
				? { description: entry.description.trim() }
				: {}),
			...(typeof entry.priority === 'number' && Number.isFinite(entry.priority)
				? { priority: entry.priority }
				: {}),
		});
	}
	return catalog;
}

/**
 * The BUILT-IN model for a tier on this provider, or `undefined` when Maestro
 * has no opinion. `undefined` means "fall back to the agent's configured
 * model" - the caller is expected to report that it did, so the author learns
 * their hint had no effect rather than silently getting the wrong model.
 *
 * This is the table alone. A launch that acts on a tier goes through
 * {@link resolveTierTarget}, which reads the agent's own targets and the
 * harness defaults first. Call this only where the provider's own model for a
 * tier is the question (the cheap synopsis turn, a label, the Suggest rules).
 */
export function resolveTierModel(toolType: ToolType, tier: ModelTier): string | undefined {
	return TIER_MODELS[toolType]?.[tier];
}

/**
 * Where one tier launches: a model on the harness's own provider, or a Run on
 * target (`shared/local-models/run-on.ts`).
 *
 *   - `provider-model` with a `model`: the provider, on that model.
 *   - `provider-model` with no `model`, or `provider`: the provider, on the
 *     agent's own configured model. The tier names where, not which.
 *   - `source`: the same harness pointed at a model on a Local Models source.
 */
export type TierTarget = { type: 'provider-model'; model?: string } | RunOnTarget;

/** One layer's targets. Sparse: an absent tier falls through to the next layer. */
export type TierTargets = Partial<Record<ModelTier, TierTarget>>;

/** The persisted `harnessTierDefaults` setting: only what the user changed. */
export type HarnessTierDefaults = Partial<Record<AgentId, TierTargets>>;

/** The layer a tier's target came from. Shown wherever a tier is shown. */
export type TierTargetSource = 'agent' | 'harness-default' | 'built-in';

/** A layer's name for a person: beside a picker, in a note, in a refusal. */
export const TIER_TARGET_SOURCE_LABELS: Readonly<Record<TierTargetSource, string>> = Object.freeze({
	agent: 'Agent',
	'harness-default': 'Harness default',
	'built-in': 'Built-in',
});

export type TierTargetParse = { ok: true; target: TierTarget } | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read one stored target and put it in the form that is stored: trimmed, with
 * no unknown keys. A source goes through `parseRunOnTarget`, so a tier cannot
 * hold a source a Run on launch would refuse as malformed.
 */
export function parseTierTarget(value: unknown): TierTargetParse {
	if (!isPlainObject(value)) {
		return { ok: false, error: 'A tier target is an object with a type.' };
	}
	if (value.type === 'provider-model') {
		if (value.model === undefined || value.model === null) {
			return { ok: true, target: { type: 'provider-model' } };
		}
		if (typeof value.model !== 'string') {
			return { ok: false, error: "A tier target's model is text." };
		}
		const model = value.model.trim();
		return {
			ok: true,
			target: model === '' ? { type: 'provider-model' } : { type: 'provider-model', model },
		};
	}
	if (value.type !== 'provider' && value.type !== 'source') {
		return {
			ok: false,
			error: 'A tier target is a provider model, "provider", or a source and a model.',
		};
	}
	return parseRunOnTarget(value);
}

/**
 * One layer's entries as stored, with the keys that are not tiers dropped. An
 * entry is NOT checked here: {@link resolveTierTarget} reads it at launch and
 * refuses a malformed one by name. Dropping it instead would let that tier fall
 * through to the next layer, which is a silent substitution.
 */
function readTierTargets(value: unknown): TierTargets {
	if (!isPlainObject(value)) return {};
	const targets: TierTargets = {};
	for (const tier of TIER_LEVELS) {
		const entry = value[tier];
		if (entry !== undefined && entry !== null) targets[tier] = entry as TierTarget;
	}
	return targets;
}

/**
 * Read the persisted `harnessTierDefaults` setting. Every reader (the settings
 * store, the main process, the CLI) goes through it, so the desktop and CLI
 * Auto Run engines see the same table. Anything that is not a plain object
 * reads as empty (the built-in table), a key that is not a harness is dropped,
 * and a harness with no tier set is dropped so the record stays sparse. The
 * targets themselves are kept as stored (see {@link readTierTargets}).
 */
export function parseHarnessTierDefaults(value: unknown): HarnessTierDefaults {
	if (!isPlainObject(value)) return {};
	const defaults: HarnessTierDefaults = {};
	for (const [harness, row] of Object.entries(value)) {
		if (!isValidAgentId(harness)) continue;
		const targets = readTierTargets(row);
		if (Object.keys(targets).length > 0) defaults[harness] = targets;
	}
	return defaults;
}

/**
 * The layers a tier is resolved against, beside the harness: what a caller
 * that resolves a tier before a launch hands over. Absent means the built-in
 * table alone.
 */
export interface TierRouting {
	/** The agent's own targets (`tierTargets` on its record). */
	tierTargets?: TierTargets | null;
	/** The agent's own Run on target (`runOn` on its record), as stored. */
	runOn?: unknown;
	/** The `harnessTierDefaults` setting. */
	harnessDefaults?: HarnessTierDefaults | null;
}

/** The parts of an agent a tier is resolved against. Read as data, not trusted. */
export interface TierTargetAgent extends Pick<TierRouting, 'tierTargets' | 'runOn'> {
	/** The agent's harness, e.g. `claude-code`. */
	toolType: ToolType;
}

/**
 * Why a tier named no usable target.
 *
 *   - `tier-unmapped`: no layer names a target for this tier.
 *   - `tier-agent-runs-on-source`: only the built-in table names one, and the
 *     agent runs on a Local Models source. The table names the provider's cloud
 *     models; applying it would send the turn where the user chose not to.
 *   - `tier-invalid-target`: the layer's stored target is malformed.
 *   - `tier-unsupported-source`: the target is a source, and this harness has
 *     no Run on recipe.
 */
export type TierTargetRefusalCode =
	| 'tier-unmapped'
	| 'tier-agent-runs-on-source'
	| 'tier-invalid-target'
	| 'tier-unsupported-source';

export interface TierTargetRefusal {
	kind: 'refused';
	code: TierTargetRefusalCode;
	message: string;
	/**
	 * `false`: the tier simply does not apply, so the turn runs on the agent's
	 * own model and target and `message` is the warning to show. `true`: a layer
	 * named a target that cannot be used, so the turn must not launch at all.
	 */
	blocksLaunch: boolean;
}

export interface ResolvedTierTarget {
	kind: 'resolved';
	target: TierTarget;
	source: TierTargetSource;
}

export type TierTargetResolution = ResolvedTierTarget | TierTargetRefusal;

/**
 * The target a tier launches on for this agent, and the layer it came from.
 *
 * Layer order, first one that sets the tier wins: the agent's own
 * `tierTargets`, the `harnessTierDefaults` setting for its harness, then the
 * built-in table ({@link resolveTierModel}). A group is not a layer: its
 * targets are stamped into the agent's own when the agent is created.
 *
 * A layer that sets the tier to something unusable REFUSES. It does not fall
 * through: the next layer's target is a different model than the one the user
 * picked. The built-in table is the one layer the user did not write, so it is
 * the one layer that does not apply to an agent whose Run on target is a
 * source.
 *
 * Only the target's shape and the harness's Run on recipe are checked here.
 * Whether the source exists, is enabled and serves the model needs the saved
 * sources and the network, which `resolveRunOnLaunch` and the main process
 * decide at launch.
 */
export function resolveTierTarget(
	agent: TierTargetAgent,
	tier: ModelTier,
	harnessDefaults?: HarnessTierDefaults | null
): TierTargetResolution {
	const { toolType } = agent;
	const layers: Array<[TierTargetSource, unknown]> = [
		['agent', readTierTargets(agent.tierTargets)[tier]],
		[
			'harness-default',
			readTierTargets(
				isPlainObject(harnessDefaults)
					? (harnessDefaults as Record<string, unknown>)[toolType]
					: undefined
			)[tier],
		],
	];

	for (const [source, stored] of layers) {
		if (stored === undefined) continue;
		const where =
			source === 'agent'
				? `This agent's "${tier}" tier target`
				: `The ${getAgentDisplayName(toolType)} harness default for the "${tier}" tier`;
		const parsed = parseTierTarget(stored);
		if (!parsed.ok) {
			return {
				kind: 'refused',
				code: 'tier-invalid-target',
				message: `${where} cannot be used: ${parsed.error} Pick a target again, or clear it.`,
				blocksLaunch: true,
			};
		}
		if (parsed.target.type === 'source') {
			const support = agentRunOnSupport(toolType);
			if (!support.supported) {
				return {
					kind: 'refused',
					code: 'tier-unsupported-source',
					message: `${where} is ${runOnTargetLabel(parsed.target, [])}, which this harness cannot run on. ${support.reason} Set the tier to a provider model, or clear it.`,
					blocksLaunch: true,
				};
			}
		}
		return { kind: 'resolved', target: parsed.target, source };
	}

	const builtIn = resolveTierModel(toolType, tier);
	if (!builtIn) {
		return {
			kind: 'refused',
			code: 'tier-unmapped',
			message: supportsTierSelection(toolType)
				? `No "${tier}" tier model is mapped for ${toolType}; using the agent's configured model.`
				: `${toolType} has no model tier mapping, so tier="${tier}" was ignored; using the agent's configured model.`,
			blocksLaunch: false,
		};
	}
	if (storedRunOnNamesSource(agent.runOn)) {
		return {
			kind: 'refused',
			code: 'tier-agent-runs-on-source',
			message: `tier="${tier}" is ${builtIn} on ${getAgentDisplayName(toolType)}'s own models (${TIER_TARGET_SOURCE_LABELS['built-in']}), and this agent runs on a Local Models source, so the tier was ignored; using the agent's Run on target. Set the tier on the agent or in the harness default to send it elsewhere.`,
			blocksLaunch: false,
		};
	}
	return {
		kind: 'resolved',
		target: { type: 'provider-model', model: builtIn },
		source: 'built-in',
	};
}

/**
 * What a resolved target does to one launch: the model it runs, and where,
 * when the target decides where. `runOn` absent means the agent's own Run on
 * target stands, which is the built-in table's case (it only applies to an
 * agent that is on its provider already). Shared by the join that launches a
 * task (`resolveTurnSettings`) and the one that splits a document where the
 * settings change (`countTasksUnderActiveHint`), so the two cannot disagree.
 */
export function tierTargetLaunch(
	resolved: ResolvedTierTarget,
	agentModel?: string
): { model: string | undefined; runOn?: RunOnTarget } {
	const { target, source } = resolved;
	if (target.type === 'source') return { model: target.model, runOn: target };
	const model = target.type === 'provider-model' ? (target.model ?? agentModel) : agentModel;
	return source === 'built-in' ? { model } : { model, runOn: { type: 'provider' } };
}

/**
 * One launch's model and place as a comparable string: two tasks with the same
 * key run under the same settings. `tier` is the tier the task asked for, or
 * `undefined` for none (the agent's own model and target). A tier that does not
 * apply reads as none, which is what its launch does; a tier that is refused
 * gets a key of its own, so its tasks are not folded into a dispatch that runs.
 */
export function tierLaunchKey(
	toolType: ToolType,
	tier: ModelTier | undefined,
	agentModel?: string,
	routing?: TierRouting
): string {
	let launch: { model: string | undefined; runOn?: RunOnTarget } = { model: agentModel };
	if (tier) {
		const resolved = resolveTierTarget(
			{ toolType, tierTargets: routing?.tierTargets, runOn: routing?.runOn },
			tier,
			routing?.harnessDefaults
		);
		if (resolved.kind === 'resolved') launch = tierTargetLaunch(resolved, agentModel);
		else if (resolved.blocksLaunch) return `refused:${tier}:${resolved.code}`;
	}
	// The place a launch runs is the tier's, else the agent's own, so a tier
	// that names the place the agent is already on does not read as a change.
	const own = parseRunOnTarget(routing?.runOn);
	const place = launch.runOn ?? (own.ok ? own.target : undefined);
	const where =
		place === undefined
			? 'invalid'
			: place.type === 'source'
				? `${place.endpointId}\u0000${place.model}\u0000${place.contextTokens ?? ''}`
				: '';
	return `${launch.model ?? ''}\u0000${where}`;
}

/**
 * A tier as a pill names it for this agent: the tier, the model it launches,
 * and the source when it launches on one (`low · qwen3.5-4b · Maestro`,
 * `high · opus`). It reads the same resolution a launch does, so a pill cannot
 * name a target the task will not run on. `undefined` when the tier names no
 * target here (no layer maps it, or the target cannot be used): the caller
 * keeps its own wording, and the launch says why.
 */
export function tierPillLabel(
	toolType: ToolType,
	tier: ModelTier,
	agentModel?: string,
	routing?: TierRouting,
	endpoints: readonly Pick<LocalModelEndpoint, 'id' | 'name'>[] = []
): string | undefined {
	const resolved = resolveTierTarget(
		{ toolType, tierTargets: routing?.tierTargets, runOn: routing?.runOn },
		tier,
		routing?.harnessDefaults
	);
	if (resolved.kind !== 'resolved') return undefined;
	const launch = tierTargetLaunch(resolved, agentModel);
	const target =
		launch.runOn?.type === 'source' ? runOnPillLabel(launch.runOn, endpoints) : launch.model;
	return target ? `${tier} · ${target}` : undefined;
}

/**
 * The provider's effort string for a level, or `undefined` when the provider
 * has no effort knob (OpenCode) or is not mapped. Same contract as
 * {@link resolveTierModel}: `undefined` is inherit-and-say-so.
 */
export function resolveEffortLevel(toolType: ToolType, level: EffortLevel): string | undefined {
	return rejectedEffortForLevel(toolType, level) ? undefined : EFFORT_LADDERS[toolType]?.[level];
}

/**
 * The provider's refusal of the value this level maps to, when it has refused
 * it in this process (see `effortRejection.ts`).
 *
 * The ladders above are a snapshot of each provider's catalogue, and a provider
 * can retire a rung without notice. Once it has said no, the level resolves to
 * `undefined` - inherit the agent's own effort - instead of sending a value
 * that is known to fail the turn. Callers that explain an unmapped level to the
 * user read the refusal from here so they can say what actually happened.
 */
export function rejectedEffortForLevel(
	toolType: ToolType,
	level: EffortLevel
): EffortRejection | undefined {
	const value = EFFORT_LADDERS[toolType]?.[level];
	return value === undefined ? undefined : getEffortRejection(toolType, value);
}

/**
 * True when `value` is one a ladder above hands out for this provider.
 *
 * Tells a refusal of something MAESTRO chose (the shipped table has drifted
 * from the provider's catalogue, fixable only in a release) apart from a
 * refusal of something the user picked on a tab, which is theirs to change.
 */
export function isLadderEffortValue(toolType: string, value: string): boolean {
	const ladder = EFFORT_LADDERS[toolType as ToolType];
	return ladder !== undefined && Object.values(ladder).includes(value);
}

/** True when this provider can act on a tier hint at all. */
export function supportsTierSelection(toolType: ToolType): boolean {
	return TIER_MODELS[toolType] !== undefined;
}

/** True when this provider can act on an effort hint at all. */
export function supportsEffortSelection(toolType: ToolType): boolean {
	return EFFORT_LADDERS[toolType] !== undefined;
}

/**
 * Model and effort for a throwaway summarization turn.
 *
 * A synopsis reads a conversation that already happened and writes a few
 * sentences about it. It is the cheapest useful thing an agent does, and
 * running it on the same model that just did the engineering is pure waste -
 * on a long Auto Run that is one premium turn per task, forever, for prose
 * nobody reads twice. So every synopsis is pinned to the bottom of both
 * ladders regardless of what the agent or the task was configured with.
 *
 * Safe because a synopsis is a LEAF: it resumes the finished session, and every
 * caller discards the `agentSessionId` it returns rather than adopting it. The
 * downgrade therefore cannot follow the conversation forward into the next real
 * turn. If a future caller ever DOES adopt that id, this pin has to be revisited
 * first, or the tab silently continues on the cheap model.
 */
export function cheapTurnSettings(toolType: ToolType): {
	model: string | undefined;
	effort: string | undefined;
} {
	return {
		model: resolveTierModel(toolType, 'low'),
		effort: resolveEffortLevel(toolType, 'low'),
	};
}

/**
 * `cheapTurnSettings` for a turn that RESUMES the session it summarizes, with
 * the fallbacks already applied. This is what a synopsis spawn should pass.
 *
 * The cheap tier is a MODEL swap, and a model carries a context window with
 * it. Resuming replays the whole transcript, so downgrading a session running
 * Anthropic's 1M beta (`opus[1m]`) onto a 200k model makes the synopsis of a
 * long conversation fail with "Prompt is too long": the transcript fit the
 * session's model and cannot fit the cheap one. So the session's model is kept
 * whenever the downgrade would shrink the window. Effort still drops to the
 * bottom rung, since that costs nothing to read.
 *
 * `current` is what the summarized turn ran at. It is also what the turn
 * inherits on a provider with no tier mapping (codex, opencode), where there
 * is nothing to downgrade TO.
 */
export function cheapResumeTurnSettings(
	toolType: ToolType,
	current: { model?: string; effort?: string } = {}
): {
	model: string | undefined;
	effort: string | undefined;
} {
	const cheap = cheapTurnSettings(toolType);
	const shrinksWindow =
		(getModelContextWindowOverride(current.model) ?? FALLBACK_CONTEXT_WINDOW) >
		(getModelContextWindowOverride(cheap.model) ?? FALLBACK_CONTEXT_WINDOW);
	return {
		model: shrinksWindow ? current.model : (cheap.model ?? current.model),
		effort: cheap.effort ?? current.effort,
	};
}

// ---------------------------------------------------------------------------
// Harness tier defaults: the rows, how a target is spelled and checked, Suggest,
// and the check for a value the harness no longer lists.
// ---------------------------------------------------------------------------

/** Every harness that has a tier row, in picker order: the ones that take a model. */
export function tierHarnessIds(): AgentId[] {
	return PICKABLE_AGENT_IDS.filter((id) => getAgentCapabilities(id).supportsModelSelection);
}

/**
 * Why a harness has no tier row, or null when it has one. A tier picks a model,
 * so only a harness that can be told which model to run has tiers.
 */
export function tierHarnessProblem(harness: string): string | null {
	if (!isValidAgentId(harness) || !PICKABLE_AGENT_IDS.includes(harness)) {
		return `Unknown harness "${harness}". Harnesses with tiers: ${tierHarnessIds().join(', ')}.`;
	}
	if (!getAgentCapabilities(harness).supportsModelSelection) {
		return `${getAgentDisplayName(harness)} cannot be told which model to run, so it has no tiers.`;
	}
	return null;
}

/** What a layer badge reads for a tier no layer maps. */
export const TIER_NOT_MAPPED_LABEL = 'Not mapped';

/** One tier of an agent, as a launch would resolve it. */
export interface AgentTierRow {
	tier: ModelTier;
	/** Where the tier launches. Null when no layer maps it, or the target cannot be used. */
	target: TierTarget | null;
	/** The layer that answered, or null when none did. */
	source: TierTargetSource | null;
	/** The built-in table's model for the tier: what Reset goes back to. */
	builtIn: string | null;
	/** Why the layer's target cannot be used. A launch on this tier is refused with it. */
	problem?: string;
	/** Why the tier does not apply here. The launch runs on the agent's own model and says so. */
	note?: string;
}

/**
 * Each tier of an agent with its value and the layer it came from, for the
 * agent's Tiers block and `maestro-cli show agent`. It is
 * {@link resolveTierTarget} per tier, so no surface can show a value a launch
 * would not use.
 */
export function agentTierRows(
	agent: TierTargetAgent,
	harnessDefaults?: HarnessTierDefaults | null
): AgentTierRow[] {
	const ownTargets = readTierTargets(agent.tierTargets);
	return TIER_LEVELS.map((tier): AgentTierRow => {
		const builtIn = resolveTierModel(agent.toolType, tier) ?? null;
		const resolved = resolveTierTarget(agent, tier, harnessDefaults);
		if (resolved.kind === 'resolved') {
			return { tier, target: resolved.target, source: resolved.source, builtIn };
		}
		if (!resolved.blocksLaunch) {
			return { tier, target: null, source: null, builtIn, note: resolved.message };
		}
		// A refusal that blocks comes from the first layer that sets the tier.
		const source: TierTargetSource = ownTargets[tier] !== undefined ? 'agent' : 'harness-default';
		return { tier, target: null, source, builtIn, problem: resolved.message };
	});
}

/** One tier of a harness, as the layers below the agent give it. */
export interface HarnessTierRow extends Omit<AgentTierRow, 'source' | 'note'> {
	/** The layer that answered, or null when none did. */
	source: Exclude<TierTargetSource, 'agent'> | null;
}

/**
 * Each tier of a harness with its value and the layer it came from, for the
 * Tier defaults table and `maestro-cli models tiers list`. It is
 * {@link agentTierRows} for an agent that sets no tier of its own, so the
 * table cannot show a value a launch would not use.
 */
export function harnessTierRows(
	harness: ToolType,
	harnessDefaults?: HarnessTierDefaults | null
): HarnessTierRow[] {
	return agentTierRows({ toolType: harness }, harnessDefaults).map(
		({ note: _note, source, ...row }): HarnessTierRow => ({
			...row,
			// No agent layer was passed, so none can have answered.
			source: source === 'agent' ? null : source,
		})
	);
}

/** How a tier on the provider with no model of its own reads. */
export const TIER_AGENT_MODEL_LABEL = "The agent's own model";

/** A target for a person: the provider's model, or the model and its source. */
export function tierTargetLabel(
	target: TierTarget,
	endpoints: readonly Pick<LocalModelEndpoint, 'id' | 'name'>[] = []
): string {
	if (target.type === 'source') return runOnTargetLabel(target, endpoints);
	return (target.type === 'provider-model' ? target.model : undefined) ?? TIER_AGENT_MODEL_LABEL;
}

/** One tier as a command prints it and as `--json` carries it. */
export interface TierRowRecord {
	tier: ModelTier;
	target: TierTarget | null;
	/** The target in the spelling a tier writer takes, so a read can be written back. */
	spec: string | null;
	/** The target for a person. */
	label: string | null;
	source: TierTargetSource | null;
	builtIn: string | null;
	problem?: string;
	note?: string;
}

/**
 * A tier row ({@link agentTierRows}, {@link harnessTierRows}) with its target
 * spelled and named, for `maestro-cli show agent` and `models tiers list`.
 */
export function tierRowRecord(
	row: AgentTierRow | HarnessTierRow,
	endpoints: readonly Pick<LocalModelEndpoint, 'id' | 'name'>[] = []
): TierRowRecord {
	const note = 'note' in row ? row.note : undefined;
	return {
		tier: row.tier,
		target: row.target,
		spec: row.target ? formatTierTargetSpec(row.target) : null,
		label: row.target ? tierTargetLabel(row.target, endpoints) : null,
		source: row.source,
		builtIn: row.builtIn,
		...(row.problem ? { problem: row.problem } : {}),
		...(note ? { note } : {}),
	};
}

/** The spelling that clears a tier: it falls through to the next layer. */
export const TIER_TARGET_DEFAULT_SPEC = 'default';

const TIER_PROVIDER_MODEL_PREFIX = `${RUN_ON_PROVIDER_SPEC}:`;

/** The spellings a tier target takes, for a usage line. */
export const TIER_TARGET_SPEC_FORMS = `${TIER_TARGET_DEFAULT_SPEC}, ${RUN_ON_PROVIDER_SPEC}, ${RUN_ON_PROVIDER_SPEC}:<model>, or <source id>:<model>`;

/**
 * A tier's target as one word, on a command line and as a picker option's
 * value: `default` for none (the next layer answers), `provider` for the
 * provider on the agent's own model, `provider:<model>` for a provider model,
 * and the Run on spelling `<source id>:<model>` for a source.
 */
export function formatTierTargetSpec(target: TierTarget | null | undefined): string {
	if (!target) return TIER_TARGET_DEFAULT_SPEC;
	if (target.type === 'source') return formatRunOnSpec(target);
	const model = target.type === 'provider-model' ? target.model : undefined;
	return model ? `${TIER_PROVIDER_MODEL_PREFIX}${model}` : RUN_ON_PROVIDER_SPEC;
}

/** What a writer stores for one tier: a target, or `undefined` to clear it. */
export type TierTargetEdit =
	| { ok: true; target: TierTarget | undefined }
	| { ok: false; error: string };

/**
 * Read a spelling written by {@link formatTierTargetSpec}. `provider:` is the
 * provider-model prefix here, so a source is never read out of it. Source ids
 * are generated, and the Run on spelling keeps the word `provider` already.
 */
export function parseTierTargetSpec(spec: string): TierTargetEdit {
	const trimmed = spec.trim();
	const lower = trimmed.toLowerCase();
	if (lower === TIER_TARGET_DEFAULT_SPEC) return { ok: true, target: undefined };
	if (lower === RUN_ON_PROVIDER_SPEC) return { ok: true, target: { type: 'provider-model' } };
	if (lower.startsWith(TIER_PROVIDER_MODEL_PREFIX)) {
		const model = trimmed.slice(TIER_PROVIDER_MODEL_PREFIX.length).trim();
		return {
			ok: true,
			target: model === '' ? { type: 'provider-model' } : { type: 'provider-model', model },
		};
	}
	if (!trimmed.includes(':')) {
		return { ok: false, error: `A tier target is ${TIER_TARGET_SPEC_FORMS}.` };
	}
	return parseRunOnSpec(trimmed);
}

/**
 * Check a target someone is about to store for a tier, on an agent or in the
 * harness defaults: the Tier defaults table, `maestro-cli models tiers set`,
 * and the agent's own tier writers. On top of {@link parseTierTarget} a source
 * goes through `parseRunOnEdit`, so a tier cannot hold a source the harness has
 * no Run on recipe for, or (when `endpoints` is passed) a source id that names
 * nothing. `undefined` clears the tier.
 */
export function parseTierTargetEdit(
	toolType: string,
	value: unknown,
	endpoints?: readonly Pick<LocalModelEndpoint, 'id' | 'name'>[]
): TierTargetEdit {
	if (value === undefined || value === null) return { ok: true, target: undefined };
	const parsed = parseTierTarget(value);
	if (!parsed.ok) return parsed;
	if (parsed.target.type !== 'source') {
		// `provider` and a provider model with no model say the same thing. One is stored.
		return {
			ok: true,
			target: parsed.target.type === 'provider' ? { type: 'provider-model' } : parsed.target,
		};
	}
	return parseRunOnEdit(toolType, parsed.target, endpoints);
}

/** What a writer stores for an agent's tiers: the record, or `undefined` for none set. */
export type TierTargetsEdit =
	| { ok: true; tierTargets: TierTargets | undefined }
	| { ok: false; error: string };

/**
 * Check the tiers someone is about to store on an agent or a harness row: the
 * Edit Agent dialog, the Tier defaults table, `update-agent --tier`, and the
 * bridge that applies it. `value` holds a target per tier; `null` clears one.
 * Each target goes through {@link parseTierTargetEdit}, and a refusal names the
 * tier.
 *
 * With `base`, `value` is a PATCH: a tier it does not name keeps what `base`
 * holds (kept as stored, the way hydration keeps it). Without, `value` is the
 * whole record. `null` for `value` clears every tier. The result is
 * `undefined` when no tier is set, which is the absence of the field.
 */
export function parseTierTargetsEdit(
	toolType: string,
	value: unknown,
	options: {
		base?: TierTargets | null;
		endpoints?: readonly Pick<LocalModelEndpoint, 'id' | 'name'>[];
	} = {}
): TierTargetsEdit {
	if (value === undefined || value === null) return { ok: true, tierTargets: undefined };
	if (!isPlainObject(value)) {
		return { ok: false, error: 'Tier targets are an object with a target per tier.' };
	}
	const next: TierTargets = { ...readTierTargets(options.base) };
	const unknown = Object.keys(value).find((key) => !asTierLevel(key));
	if (unknown !== undefined) {
		return { ok: false, error: `"${unknown}" is not a tier. Tiers: ${TIER_LEVELS.join(', ')}.` };
	}
	// In tier order, so the first refusal reported does not depend on key order.
	for (const tier of TIER_LEVELS) {
		if (!(tier in value)) continue;
		const edit = parseTierTargetEdit(toolType, value[tier], options.endpoints);
		if (!edit.ok) return { ok: false, error: `${tier}: ${edit.error}` };
		if (edit.target) next[tier] = edit.target;
		else delete next[tier];
	}
	return { ok: true, tierTargets: Object.keys(next).length > 0 ? next : undefined };
}

/** How one tier's target is typed on a command line: `--tier <this>`. */
export const TIER_ASSIGNMENT_FORM = `<${TIER_LEVELS.join('|')}>=<target>`;

/**
 * Read one `<tier>=<target>` assignment (`low=maestro-server:qwen3.5-4b`,
 * `high=provider:opus`, `low=default`). The tier ends at the FIRST `=`, and
 * the target is read by {@link parseTierTargetSpec}. `target` is `undefined`
 * for `default`, which clears the tier.
 */
export function parseTierAssignment(
	entry: string
): { ok: true; tier: ModelTier; target: TierTarget | undefined } | { ok: false; error: string } {
	const separator = entry.indexOf('=');
	const tier =
		separator > 0 ? asTierLevel(entry.slice(0, separator).trim().toLowerCase()) : undefined;
	if (!tier) {
		return {
			ok: false,
			error: `"${entry}" is not ${TIER_ASSIGNMENT_FORM}, where the target is ${TIER_TARGET_SPEC_FORMS}.`,
		};
	}
	const spec = parseTierTargetSpec(entry.slice(separator + 1));
	if (!spec.ok) return { ok: false, error: `${tier}: ${spec.error}` };
	return { ok: true, tier, target: spec.target };
}

/**
 * The harness defaults with one harness's row replaced. A row with no tier set
 * removes the harness, so the stored record stays sparse and "absent" keeps
 * meaning the built-in table. Shared by the table's Save and the CLI.
 */
export function withHarnessTierTargets(
	defaults: HarnessTierDefaults | null | undefined,
	harness: AgentId,
	targets: TierTargets
): HarnessTierDefaults {
	const next: HarnessTierDefaults = { ...parseHarnessTierDefaults(defaults) };
	const row = readTierTargets(targets);
	if (Object.keys(row).length > 0) next[harness] = row;
	else delete next[harness];
	return next;
}

/** The harness defaults with one tier of one harness set, or cleared by `undefined`. */
export function withHarnessTierDefault(
	defaults: HarnessTierDefaults | null | undefined,
	harness: AgentId,
	tier: ModelTier,
	target: TierTarget | undefined
): HarnessTierDefaults {
	const row: TierTargets = { ...parseHarnessTierDefaults(defaults)[harness] };
	if (target) row[tier] = target;
	else delete row[tier];
	return withHarnessTierTargets(defaults, harness, row);
}

/** What Suggest proposes for one tier, and why; or why it proposes nothing. */
export interface TierSuggestion {
	/** Null when nothing the catalogue states picks a model for this tier. */
	target: TierTarget | null;
	reason: string;
}

export type HarnessTierSuggestions = Record<ModelTier, TierSuggestion>;

/**
 * The model families Maestro knows by name, per harness. A family keeps its
 * role across generations, which is what makes it safe to suggest from: Claude
 * Code's aliases always name the current model, and Codex's Luna, Sol and Astra
 * lines are the ones the built-in table follows. A family is NOT read out of
 * another harness's catalogue (`anthropic/claude-opus-4-8` on OpenCode): which
 * of several listed members is the one to run is a guess there.
 */
const TIER_FAMILIES: Partial<Record<ToolType, Readonly<Record<ModelTier, string>>>> = {
	'claude-code': { low: 'haiku', medium: 'sonnet', high: 'opus' },
	codex: CODEX_TIER_FAMILIES,
};

/**
 * Whether a model id, as a provider's CLI puts it on the wire, is that
 * provider's model for `tier`: the built-in table's own id, or a member of the
 * family Maestro knows for the tier (`claude-haiku-4-5-20251001` and
 * `claude-3-5-haiku-latest` are both Claude Code's `low`). The family must be
 * one whole word of the id, so a name that only contains the letters does not
 * match. False for a harness with no built-in row and no known family: nothing
 * is known about its ids.
 *
 * The token proxy reads it to tell a background request (the small model) from
 * the agent's own turn (`proxy/background-route.ts`).
 */
export function modelIdInTierFamily(harness: string, tier: ModelTier, modelId: string): boolean {
	const id = modelId.trim().toLowerCase();
	if (id === '') return false;
	const toolType = harness as ToolType;
	if (id === resolveTierModel(toolType, tier)?.toLowerCase()) return true;
	const family = TIER_FAMILIES[toolType]?.[tier];
	return family !== undefined && id.split(/[^a-z0-9]+/).includes(family);
}

/** The word in a catalogue's own description that places a model in a tier. */
const TIER_DESCRIPTION_WORDS: Partial<Record<ModelTier, RegExp>> = {
	low: /\bfast\b/i,
	high: /\bfrontier\b/i,
};

function capitalize(word: string): string {
	return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * The one model a list of candidates names: the only candidate, or the first by
 * the order the catalogue itself states. Several candidates with no stated
 * order between them name nothing, because choosing one would be a guess.
 */
function pickByStatedOrder(
	candidates: readonly HarnessCatalogModel[]
): { model: HarnessCatalogModel; ranked: boolean } | null {
	if (candidates.length === 0) return null;
	if (candidates.length === 1) return { model: candidates[0], ranked: false };
	const ranked = candidates
		.filter((model) => model.priority !== undefined)
		.sort((a, b) => (a.priority as number) - (b.priority as number));
	if (ranked.length === 0) return null;
	if (ranked.length > 1 && ranked[0].priority === ranked[1].priority) return null;
	return { model: ranked[0], ranked: true };
}

/** A provider model for one tier from what the catalogue states, or null. */
function suggestProviderModel(
	harness: ToolType,
	tier: ModelTier,
	catalog: readonly HarnessCatalogModel[]
): { model: string; reason: string } | null {
	const family = TIER_FAMILIES[harness]?.[tier];
	if (family) {
		const alias = catalog.find((model) => model.id === family);
		if (alias) {
			return {
				model: alias.id,
				reason: `the ${family} alias, which always names the current ${capitalize(family)}`,
			};
		}
		const member = pickByStatedOrder(
			catalog.filter((model) => model.id.split('-').pop() === family)
		);
		if (member) {
			return {
				model: member.model.id,
				reason: member.ranked
					? `newest ${capitalize(family)}`
					: `the only ${capitalize(family)} listed`,
			};
		}
	}

	const builtIn = resolveTierModel(harness, tier);
	if (builtIn && catalog.some((model) => model.id === builtIn)) {
		return { model: builtIn, reason: 'the built-in mapping, which this catalogue lists' };
	}

	const word = TIER_DESCRIPTION_WORDS[tier];
	if (word) {
		const described = pickByStatedOrder(
			catalog.filter((model) => model.description !== undefined && word.test(model.description))
		);
		if (described) {
			return {
				model: described.model.id,
				reason: `described as "${described.model.description}"`,
			};
		}
	}
	return null;
}

/** The local models that can be ranked for a harness, smallest first. */
function rankedLocalTargets(
	harness: ToolType,
	runOnTargets: readonly RunOnPickerSource[]
): Array<{ target: RunOnSourceTarget; parametersB: number }> {
	const ranked: Array<{ target: RunOnSourceTarget; parametersB: number }> = [];
	for (const source of runOnTargets) {
		for (const model of source.models) {
			const facts = runOnModelFacts(harness, { endpointId: source.endpointId, model });
			// A model that has not passed the agent qualification with this harness
			// can still be picked by hand, with its warning. It is not suggested.
			if (!facts.qualified || facts.parametersB === undefined) continue;
			ranked.push({
				target: { type: 'source', endpointId: source.endpointId, model },
				parametersB: facts.parametersB,
			});
		}
	}
	return ranked.sort((a, b) => a.parametersB - b.parametersB);
}

/**
 * A suggestion for each tier of a harness, from what it can run on this
 * machine: its own catalogue, and the Run on targets the sources list.
 *
 * Rules, first one that names a model wins, per tier:
 *
 *   1. A family Maestro knows for this harness ({@link TIER_FAMILIES}): the
 *      alias when the catalogue lists it, else the newest listed member by the
 *      catalogue's own order.
 *   2. The built-in table's model, when the catalogue lists it.
 *   3. A description that says "fast" (low) or "frontier" (high), by the
 *      catalogue's own order when several say so.
 *   4. Medium only: the model the catalogue lists first, when it states an
 *      order and that model is not the low or high pick.
 *
 * When the provider's catalogue names NO tier and the harness has a Run on
 * recipe, the local models that passed the agent qualification with this
 * harness are ranked by parameter count: smallest is low, largest is high, and
 * the lower central one is medium when at least three sizes are listed. A local
 * model is only ever ranked against other local models, never against a cloud
 * one.
 *
 * A tier nothing names is left blank with the reason. Nothing here writes a
 * setting: a discovered list must not change how a document resolves until the
 * user saves it.
 */
export function suggestHarnessTierDefaults(
	harness: ToolType,
	catalog: readonly HarnessCatalogModel[],
	runOnTargets: readonly RunOnPickerSource[] = []
): HarnessTierSuggestions {
	const name = getAgentDisplayName(harness);
	const blank = (reason: string): TierSuggestion => ({ target: null, reason });
	const unranked =
		catalog.length > 0
			? `${name}'s catalogue states nothing that ranks a model for this tier. Pick one by hand.`
			: `No model catalogue was found for ${name}. Pick one by hand.`;

	const provider: Partial<Record<ModelTier, { model: string; reason: string }>> = {};
	for (const tier of TIER_LEVELS) {
		const pick = suggestProviderModel(harness, tier, catalog);
		if (pick) provider[tier] = pick;
	}
	if (!provider.medium) {
		const first = pickByStatedOrder(catalog.filter((model) => model.priority !== undefined));
		if (
			first &&
			first.model.id !== provider.low?.model &&
			first.model.id !== provider.high?.model
		) {
			provider.medium = {
				model: first.model.id,
				reason: `catalogue priority ${first.model.priority}`,
			};
		}
	}

	if (Object.keys(provider).length > 0) {
		const suggest = (tier: ModelTier): TierSuggestion => {
			const pick = provider[tier];
			return pick
				? { target: { type: 'provider-model', model: pick.model }, reason: pick.reason }
				: blank(unranked);
		};
		return { low: suggest('low'), medium: suggest('medium'), high: suggest('high') };
	}

	const local = agentRunOnSupport(harness).supported
		? rankedLocalTargets(harness, runOnTargets)
		: [];
	const smallest = local[0];
	const largest = local[local.length - 1];
	if (!smallest || smallest.parametersB >= largest.parametersB) {
		return { low: blank(unranked), medium: blank(unranked), high: blank(unranked) };
	}
	const size = (entry: { parametersB: number }) => `${entry.parametersB}B parameters`;
	const middle = local[Math.floor((local.length - 1) / 2)];
	const hasMiddle =
		middle.parametersB > smallest.parametersB && middle.parametersB < largest.parametersB;
	return {
		low: {
			target: smallest.target,
			reason: `smallest local model that runs agents on ${name} (${size(smallest)})`,
		},
		medium: hasMiddle
			? {
					target: middle.target,
					reason: `middle local model that runs agents on ${name}, by size (${size(middle)})`,
				}
			: blank('Fewer than three local model sizes are listed, so none is the middle one.'),
		high: {
			target: largest.target,
			reason: `largest local model that runs agents on ${name} (${size(largest)})`,
		},
	};
}

/** A tier whose provider model the harness's catalogue does not list. */
export interface StaleTierModel {
	tier: ModelTier;
	/** The model that is not listed. */
	model: string;
	/** The layer that names it. */
	source: Exclude<TierTargetSource, 'agent'>;
	/** What Suggest would put in its place, or `null` when it names nothing. */
	replacement: string | null;
}

/**
 * The tiers of a harness whose provider model is not in its catalogue, each
 * with the model Suggest would replace it with. It reads the value a launch
 * would use ({@link harnessTierRows}), so it covers a harness default the user
 * saved and the built-in table alike. Empty when every tier's model is listed,
 * and when the catalogue lists nothing (nothing is known, so nothing is stale).
 *
 * For a warning only. Nothing is rewritten: a document must resolve to the same
 * model until someone changes the mapping.
 */
export function staleTierModels(
	harness: ToolType,
	catalog: readonly HarnessCatalogModel[],
	harnessDefaults?: HarnessTierDefaults | null
): StaleTierModel[] {
	if (catalog.length === 0) return [];
	const listed = new Set(catalog.map((model) => model.id));
	let suggestions: HarnessTierSuggestions | undefined;
	const stale: StaleTierModel[] = [];
	for (const row of harnessTierRows(harness, harnessDefaults)) {
		const model = row.target?.type === 'provider-model' ? row.target.model : undefined;
		if (!model || !row.source || listed.has(model)) continue;
		suggestions ??= suggestHarnessTierDefaults(harness, catalog);
		const suggested = suggestions[row.tier].target;
		stale.push({
			tier: row.tier,
			model,
			source: row.source,
			replacement: suggested?.type === 'provider-model' ? (suggested.model ?? null) : null,
		});
	}
	return stale;
}
