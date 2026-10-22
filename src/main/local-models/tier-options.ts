/**
 * What each harness can launch a tier on, on this machine.
 *
 * The Tier defaults table (Settings -> Models -> System Two) and
 * `maestro-cli models tiers options|suggest` both end here, so the pickers, the
 * CLI, Suggest and the stale warning read one list:
 *
 *   - the harness's own catalogue, from the agent detector (the same list its
 *     model picker offers, with the description and order Codex states);
 *   - the Run on targets, for a harness with a Run on recipe: the Maestro model
 *     server and each ENABLED saved source, with the models each lists now.
 *
 * Asking is a read. The model server answers from disk and is never started
 * for a listing, and a saved source is a server the user already chose to
 * call; a disabled one is not asked. Nothing is stored here: a discovered list
 * reaches the `harnessTierDefaults` setting only when the user saves a row.
 */

import type { AgentId } from '../../shared/agentIds';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import {
	MODEL_SERVER_ENDPOINT_ID,
	MODEL_SERVER_NAME,
} from '../../shared/local-models/model-server';
import { agentRunOnSupport } from '../../shared/local-models/run-on';
import type { RunOnPickerSource } from '../../shared/local-models/run-on-picker';
import type { HarnessTierOptions, TierSourceProblem } from '../../shared/local-models/tier-options';
import {
	tierHarnessIds,
	tierHarnessProblem,
	type HarnessCatalogModel,
} from '../../shared/modelTiers';
import { getConfiguredLocalModelEndpoints, listLocalModelEndpointModels } from './endpoint-service';

export interface HarnessTierOptionsDeps {
	/** Whether the agent detector found the harness on this machine. */
	installed: (harness: AgentId) => Promise<boolean>;
	/** The harness's own catalogue. Empty when it lists nothing. */
	catalog: (harness: AgentId, forceRefresh: boolean) => Promise<HarnessCatalogModel[]>;
}

let deps: HarnessTierOptionsDeps | null = null;

/** Point the service at this process's agent detector. Reads nothing. */
export function configureHarnessTierOptions(next: HarnessTierOptionsDeps): void {
	deps = next;
}

/** Forget the detector, so each test starts from a process that was never configured. */
export function resetHarnessTierOptionsForTests(): void {
	deps = null;
}

/** Every source a tier can run on, with what it lists now, and the ones that did not answer. */
async function listRunOnSources(): Promise<{
	sources: RunOnPickerSource[];
	problems: TierSourceProblem[];
}> {
	const asked = [
		{
			endpointId: MODEL_SERVER_ENDPOINT_ID,
			name: MODEL_SERVER_NAME,
			ref: MODEL_SERVER_ENDPOINT_ID,
		},
		...getConfiguredLocalModelEndpoints()
			.filter((endpoint) => endpoint.enabled)
			.map((endpoint) => ({ endpointId: endpoint.id, name: endpoint.name, ref: endpoint })),
	];
	const answers = await Promise.all(
		asked.map(async ({ endpointId, name, ref }) => ({
			endpointId,
			name,
			result: await listLocalModelEndpointModels(ref),
		}))
	);
	const sources: RunOnPickerSource[] = [];
	const problems: TierSourceProblem[] = [];
	for (const { endpointId, name, result } of answers) {
		if (!result.ok) {
			problems.push({ endpointId, name, message: result.error.message });
			continue;
		}
		const models = result.models.map((model) => model.id);
		if (models.length > 0) sources.push({ endpointId, name, models });
	}
	return { sources, problems };
}

export interface HarnessTierOptionsRequest {
	/** One harness by id. Absent: every installed harness that can select a model. */
	harness?: unknown;
	/** Ask each harness again instead of answering from the detector's cache. */
	refresh?: unknown;
}

/**
 * The tier options of one harness, or of every installed harness that can
 * select a model. A named harness is answered whether or not it is installed
 * (`installed` says which), so the CLI can tell "not installed" from "lists
 * nothing". An id that names no harness with tiers is refused by name.
 */
export async function listHarnessTierOptions(
	request: HarnessTierOptionsRequest = {}
): Promise<HarnessTierOptions[]> {
	if (!deps) throw new Error('Tier options are not available yet: the app is still starting.');
	const { installed, catalog } = deps;
	const refresh = request.refresh === true;

	let harnesses: AgentId[];
	let onlyInstalled = false;
	if (request.harness === undefined || request.harness === null) {
		harnesses = tierHarnessIds();
		onlyInstalled = true;
	} else {
		const named = typeof request.harness === 'string' ? request.harness.trim() : '';
		const problem = tierHarnessProblem(named);
		if (problem) throw new Error(problem);
		harnesses = [named as AgentId];
	}

	const found = await Promise.all(
		harnesses.map(async (harness) => ({ harness, installed: await installed(harness) }))
	);
	const rows = found.filter((row) => row.installed || !onlyInstalled);

	// One listing serves every row: the sources do not depend on the harness.
	const anyRunsOnSource = rows.some((row) => agentRunOnSupport(row.harness).supported);
	const [listed, catalogs] = await Promise.all([
		anyRunsOnSource ? listRunOnSources() : Promise.resolve({ sources: [], problems: [] }),
		Promise.all(rows.map((row) => (row.installed ? catalog(row.harness, refresh) : []))),
	]);

	return rows.map((row, index): HarnessTierOptions => {
		const support = agentRunOnSupport(row.harness);
		return {
			harness: row.harness,
			name: getAgentDisplayName(row.harness),
			installed: row.installed,
			catalog: catalogs[index],
			runOn: support.supported ? { supported: true } : { supported: false, reason: support.reason },
			sources: support.supported ? listed.sources : [],
			problems: support.supported ? listed.problems : [],
		};
	});
}

/** {@link listHarnessTierOptions} for a request off the wire (IPC, the bridge). */
export function listHarnessTierOptionsRequest(request: unknown): Promise<HarnessTierOptions[]> {
	const record =
		typeof request === 'object' && request !== null && !Array.isArray(request)
			? (request as Record<string, unknown>)
			: {};
	return listHarnessTierOptions({ harness: record.harness, refresh: record.refresh });
}
