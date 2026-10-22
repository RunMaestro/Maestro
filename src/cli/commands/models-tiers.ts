// `maestro-cli models tiers list|options|suggest|set|reset` - the harness tier
// defaults: which model a `low`, `medium` or `high` task launches on, per
// harness. The Tier defaults table in Settings -> Models -> System Two, from
// the command line.
//
//   list      each tier with its value and the layer it came from (Harness
//             default or Built-in). Reads the settings file; works with Maestro
//             closed.
//   options   what one harness can launch a tier on: its own catalogue and the
//             Run on targets, each in the spelling `set` takes. Asks the
//             desktop, which owns the agent detector and the sources.
//   suggest   a suggestion per tier with its reason, from the same options and
//             the same rules as the table's Suggest button. `--apply` saves it.
//   set       one tier of one harness: default | provider | provider:<model> |
//             <source id>:<model>. `default` clears the tier.
//   reset     one harness back to the built-in table, or one tier with --tier.
//
// `set`, `reset` and `suggest --apply` edit the `harnessTierDefaults` setting in
// the settings file, as the assignment verbs do, so the settings watcher
// reloads every window. They check and store through the SAME shared helpers
// the table uses (`parseTierTargetSpec`, `parseTierTargetEdit`,
// `withHarnessTierDefault`, `suggestHarnessTierDefaults`), so the CLI cannot
// save a target the table would refuse, and the two cannot suggest differently.

import { withMaestroClient } from '../services/maestro-client';
import {
	readHarnessTierDefaults,
	readLocalModelEndpoints,
	writeHarnessTierDefaults,
} from '../services/storage';
import { ExitCode } from '../exit-codes';
import {
	formatHarnessTierOptions,
	formatHarnessTiers,
	formatSuccess,
	formatWarning,
	type HarnessTiersDisplay,
} from '../output/formatter';
import type { AgentId } from '../../shared/agentIds';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { findLocalModelEndpoint } from '../../shared/local-models/endpoints';
import { MODEL_SERVER_ENDPOINT_ID } from '../../shared/local-models/model-server';
import type { HarnessTierOptions } from '../../shared/local-models/tier-options';
import {
	asTierLevel,
	formatTierTargetSpec,
	harnessTierRows,
	parseTierTargetEdit,
	parseTierTargetSpec,
	staleTierModels,
	suggestHarnessTierDefaults,
	TIER_LEVELS,
	TIER_NOT_MAPPED_LABEL,
	TIER_TARGET_SOURCE_LABELS,
	tierHarnessIds,
	tierHarnessProblem,
	tierRowRecord,
	withHarnessTierDefault,
	withHarnessTierTargets,
	type HarnessTierDefaults,
	type ModelTier,
	type TierTarget,
	type TierTargets,
} from '../../shared/modelTiers';
import { failCommand, failFromError } from '../services/session-command';

/** A listing runs a harness's own `models` command and asks each saved source. */
const OPTIONS_TIMEOUT_MS = 60_000;

interface JsonOption {
	json?: boolean;
}

/** A harness id that has tiers, or a refusal that names the ones that do. */
function requireHarness(harness: string, json: boolean | undefined): AgentId {
	const problem = tierHarnessProblem(harness);
	if (problem) failCommand(problem, json, ExitCode.InvalidUsage);
	return harness as AgentId;
}

function requireTier(tier: string, json: boolean | undefined): ModelTier {
	const level = asTierLevel(tier);
	if (!level) {
		failCommand(
			`Unknown tier "${tier}". Tiers: ${TIER_LEVELS.join(', ')}.`,
			json,
			ExitCode.InvalidUsage
		);
	}
	return level;
}

/** Each tier of one harness as stored now: value, spelling, layer. */
function tierRecords(harness: AgentId, defaults: HarnessTierDefaults) {
	const endpoints = readLocalModelEndpoints();
	return harnessTierRows(harness, defaults).map((row) => tierRowRecord(row, endpoints));
}

export function modelsTiersList(options: JsonOption & { harness?: string }): void {
	const harnesses = options.harness
		? [requireHarness(options.harness, options.json)]
		: tierHarnessIds();
	const defaults = readHarnessTierDefaults();
	const rows = harnesses.map((harness) => ({
		harness,
		name: getAgentDisplayName(harness),
		tiers: tierRecords(harness, defaults),
	}));

	if (options.json) {
		console.log(JSON.stringify({ success: true, harnesses: rows }));
		return;
	}
	const display: HarnessTiersDisplay[] = rows.map((row) => ({
		harness: row.harness,
		name: row.name,
		tiers: row.tiers.map((tier) => ({
			tier: tier.tier,
			spec: tier.spec,
			note: tier.source ? TIER_TARGET_SOURCE_LABELS[tier.source] : TIER_NOT_MAPPED_LABEL,
			...(tier.problem ? { problem: tier.problem } : {}),
		})),
	}));
	console.log(formatHarnessTiers('TIER DEFAULTS', display));
}

/** Ask the desktop what one harness can launch a tier on. */
async function fetchOptions(
	harness: AgentId,
	json: boolean | undefined,
	refresh = false
): Promise<HarnessTierOptions> {
	type Reply = { success: boolean; error?: string; options?: HarnessTierOptions[] };
	let reply: Reply;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<Reply>(
				{ type: 'local_models_tier_options', harness, ...(refresh ? { refresh: true } : {}) },
				'local_models_tier_options_result',
				OPTIONS_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, json);
	}
	if (!reply.success) failCommand(reply.error || 'Request failed', json);
	const options = reply.options?.find((entry) => entry.harness === harness);
	if (!options) failCommand(`The desktop app sent no tier options for ${harness}.`, json);
	return options;
}

export async function modelsTiersOptions(
	harnessArg: string,
	options: JsonOption & { refresh?: boolean }
): Promise<void> {
	const harness = requireHarness(harnessArg, options.json);
	const listed = await fetchOptions(harness, options.json, options.refresh === true);
	const stale = staleTierModels(harness, listed.catalog, readHarnessTierDefaults());

	if (options.json) {
		console.log(JSON.stringify({ success: true, ...listed, stale }));
		return;
	}
	console.log(
		formatHarnessTierOptions({
			harness: listed.harness,
			name: listed.name,
			installed: listed.installed,
			catalog: listed.catalog.map((model) => ({
				spec: formatTierTargetSpec({ type: 'provider-model', model: model.id }),
				...(model.priority === undefined ? {} : { priority: model.priority }),
				...(model.description ? { description: model.description } : {}),
			})),
			...(listed.runOn.supported ? {} : { runOnReason: listed.runOn.reason }),
			sources: listed.sources.map((source) => ({
				name: source.name,
				specs: source.models.map((model) =>
					formatTierTargetSpec({ type: 'source', endpointId: source.endpointId, model })
				),
			})),
			problems: listed.problems,
		})
	);
	for (const entry of stale) {
		console.log(
			formatWarning(
				`The "${entry.tier}" tier is ${entry.model} (${TIER_TARGET_SOURCE_LABELS[entry.source]}), which this catalogue does not list.${
					entry.replacement ? ` Suggest would use ${entry.replacement}.` : ''
				}`
			)
		);
	}
}

export async function modelsTiersSuggest(
	harnessArg: string,
	options: JsonOption & { apply?: boolean }
): Promise<void> {
	const harness = requireHarness(harnessArg, options.json);
	const listed = await fetchOptions(harness, options.json);
	const suggestions = suggestHarnessTierDefaults(harness, listed.catalog, listed.sources);

	// A tier Suggest names nothing for keeps the value it has, as in the table.
	const applied: ModelTier[] = [];
	if (options.apply) {
		const defaults = readHarnessTierDefaults();
		const row: TierTargets = { ...defaults[harness] };
		for (const tier of TIER_LEVELS) {
			const target = suggestions[tier].target;
			if (!target) continue;
			row[tier] = target;
			applied.push(tier);
		}
		if (applied.length > 0)
			writeHarnessTierDefaults(withHarnessTierTargets(defaults, harness, row));
	}

	const tiers = TIER_LEVELS.map((tier) => ({
		tier,
		target: suggestions[tier].target,
		spec: suggestions[tier].target ? formatTierTargetSpec(suggestions[tier].target) : null,
		reason: suggestions[tier].reason,
	}));
	if (options.json) {
		console.log(
			JSON.stringify({
				success: true,
				harness,
				installed: listed.installed,
				tiers,
				...(options.apply ? { applied } : {}),
			})
		);
		return;
	}
	console.log(
		formatHarnessTiers('SUGGESTED TIERS', [
			{
				harness,
				name: listed.name,
				tiers: tiers.map((tier) => ({ tier: tier.tier, spec: tier.spec, note: tier.reason })),
			},
		])
	);
	if (!listed.installed) {
		console.log(formatWarning(`${listed.name} was not found on this machine.`));
	}
	if (options.apply) {
		console.log(
			applied.length > 0
				? formatSuccess(`Saved ${applied.join(', ')} for ${listed.name}.`)
				: formatWarning('Nothing to save: no tier has a suggestion.')
		);
	} else if (tiers.some((tier) => tier.target)) {
		console.log(`  Save it: maestro-cli models tiers suggest ${harness} --apply`);
	}
}

export function modelsTiersSet(
	harnessArg: string,
	tierArg: string,
	spec: string,
	options: JsonOption
): void {
	const harness = requireHarness(harnessArg, options.json);
	const tier = requireTier(tierArg, options.json);
	const parsed = parseTierTargetSpec(spec);
	if (!parsed.ok) {
		failCommand(`${parsed.error} Got "${spec}".`, options.json, ExitCode.InvalidUsage);
	}

	// A source is named the way the endpoint verbs name one (id, id prefix or
	// name) and stored by its full id, which is what a launch looks up.
	const endpoints = readLocalModelEndpoints();
	let target: TierTarget | undefined = parsed.target;
	let sourceDisabled = false;
	if (target?.type === 'source' && target.endpointId !== MODEL_SERVER_ENDPOINT_ID) {
		const lookup = findLocalModelEndpoint(endpoints, target.endpointId);
		if (!lookup.ok) failCommand(lookup.message, options.json, ExitCode.InvalidUsage);
		target = { ...target, endpointId: lookup.endpoint.id };
		sourceDisabled = !lookup.endpoint.enabled;
	}
	const edit = parseTierTargetEdit(harness, target, endpoints);
	if (!edit.ok) failCommand(edit.error, options.json, ExitCode.InvalidUsage);

	writeHarnessTierDefaults(
		withHarnessTierDefault(readHarnessTierDefaults(), harness, tier, edit.target)
	);
	report(harness, [tier], options.json);
	if (sourceDisabled && !options.json) {
		console.log(formatWarning('That source is disabled. Enable it before the tier can launch.'));
	}
}

export function modelsTiersReset(
	harnessArg: string,
	options: JsonOption & { tier?: string }
): void {
	const harness = requireHarness(harnessArg, options.json);
	const defaults = readHarnessTierDefaults();
	if (options.tier === undefined) {
		writeHarnessTierDefaults(withHarnessTierTargets(defaults, harness, {}));
		report(harness, [...TIER_LEVELS], options.json);
		return;
	}
	const tier = requireTier(options.tier, options.json);
	writeHarnessTierDefaults(withHarnessTierDefault(defaults, harness, tier, undefined));
	report(harness, [tier], options.json);
}

/** Say what the named tiers are NOW, read back from the settings file. */
function report(harness: AgentId, tiers: readonly ModelTier[], json: boolean | undefined): void {
	const records = tierRecords(harness, readHarnessTierDefaults()).filter((record) =>
		tiers.includes(record.tier)
	);
	if (json) {
		console.log(JSON.stringify({ success: true, harness, tiers: records }));
		return;
	}
	const name = getAgentDisplayName(harness);
	for (const record of records) {
		const layer = record.source ? TIER_TARGET_SOURCE_LABELS[record.source] : TIER_NOT_MAPPED_LABEL;
		console.log(formatSuccess(`${name} ${record.tier} -> ${record.spec ?? '-'} (${layer})`));
		if (record.problem) console.log(formatWarning(record.problem));
	}
	console.log(`  Check it is listed: maestro-cli models tiers options ${harness}`);
}
