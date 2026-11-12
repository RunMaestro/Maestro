/**
 * Continuation routing: the routing a tab's next turn is CONFIGURED with, as the
 * settings stand now.
 *
 * This is not a router, and not a dry-run launch. It decides nothing, switches
 * nothing and probes nothing. Every fact is read through the owner that already
 * answers it, and the owner's capability gate is applied BEFORE a stored value
 * is believed, so a stale or hand-edited setting cannot make a provider look
 * able to do what it cannot:
 *
 *  - Run on: `agentRunOnSupport`, then `parseRunOnTarget` and `runOnTargetLabel`
 *    (`local-models/run-on`).
 *  - Tiers: `agentTierRows` and `tierTargetLabel` (`modelTiers`), which are
 *    `resolveTierTarget` per tier, harness gate included.
 *  - Background requests: `backgroundRequestsSupport`, then
 *    `parseBackgroundRequests` (`local-models/background-requests`).
 *
 * What a configured target does NOT establish is stated in `notChecked`: this
 * module is not handed the saved sources' enabled and capability state, the
 * token proxy's state for the agent, or a launch result, so "configured for X"
 * never means "a request WILL be sent to X". `basis` is always `configured-now`:
 * a setting is also not a record of where an earlier turn ran, because the model
 * may have been changed since and a turn sends its model when it is sent.
 *
 * Pure: no Electron, React, IPC, clock or file access.
 */

import type { LocalModelEndpoint } from './local-models/endpoints';
import {
	backgroundRequestsSupport,
	parseBackgroundRequests,
} from './local-models/background-requests';
import { agentRunOnSupport, parseRunOnTarget, runOnTargetLabel } from './local-models/run-on';
import {
	agentTierRows,
	TIER_NOT_MAPPED_LABEL,
	TIER_TARGET_SOURCE_LABELS,
	tierTargetLabel,
	type HarnessTierDefaults,
	type TierTargetSource,
	type TierTargets,
} from './modelTiers';
import type { ModelTier } from './tierLevels';
import type { ToolType } from './types';

/** The stored values of an agent and tab that decide where a turn goes. Read as data. */
export interface ContinuationRoutingInput {
	toolType: ToolType;
	/** The tab's own model and effort, then the agent's: the first one set wins. */
	tabModel?: string;
	agentModel?: string;
	tabEffort?: string;
	agentEffort?: string;
	/** The agent's stored Run on target. */
	runOn?: unknown;
	/** The agent's own tier targets. */
	tierTargets?: TierTargets | null;
	/** The agent's stored background-requests setting. */
	backgroundRequests?: unknown;
	/** The `harnessTierDefaults` setting. */
	harnessTierDefaults?: HarnessTierDefaults | null;
	/** The saved Local Models sources, to name a source for a person. */
	endpoints?: readonly Pick<LocalModelEndpoint, 'id' | 'name'>[];
}

export interface RoutingTierFact {
	tier: ModelTier;
	/** Where the tier launches, named for a person. Null when it maps nowhere usable. */
	target: string | null;
	/** The layer that answered, or null when none did. */
	source: TierTargetSource | null;
	/** Why the layer's target cannot be used, when it cannot. */
	problem?: string;
}

/**
 * What a configured routing does not establish. Said in every report, because
 * the facts below are settings, not a launch.
 */
export const ROUTING_NOT_CHECKED: readonly string[] = Object.freeze([
	'whether a source is enabled, reachable and serves the model',
	'whether the token proxy is on for this agent (background requests need it)',
	'where earlier turns of this tab ran',
]);

export interface ContinuationRouting {
	basis: 'configured-now';
	provider: string;
	/** Null: the provider's own default (nothing is set). */
	model: { value: string | null; setOn: 'tab' | 'agent' | 'provider-default' };
	effort: { value: string | null; setOn: 'tab' | 'agent' | 'provider-default' };
	/**
	 * `source` is a stored target on a harness that can run on one. `unsupported`
	 * is a stored source on a harness that cannot (`label` is the owner's reason),
	 * and `invalid` a stored value that does not parse (`label` is the owner's error).
	 */
	runOn: { kind: 'provider' | 'source' | 'unsupported' | 'invalid'; label: string };
	tiers: RoutingTierFact[];
	/**
	 * `configured` is a target stored on a provider that can route background
	 * requests: not a statement that one will be sent there (see `notChecked`).
	 */
	backgroundRequests:
		| { status: 'configured'; label: string }
		| { status: 'not-routed' }
		| { status: 'unsupported'; reason: string }
		| { status: 'invalid'; reason: string };
	/** What this reading does not establish. */
	notChecked: string[];
}

const nonBlank = (value: string | undefined): string | null =>
	value?.trim() ? value.trim() : null;

function pickSetting(tab: string | undefined, agent: string | undefined) {
	const fromTab = nonBlank(tab);
	if (fromTab) return { value: fromTab, setOn: 'tab' as const };
	const fromAgent = nonBlank(agent);
	if (fromAgent) return { value: fromAgent, setOn: 'agent' as const };
	return { value: null, setOn: 'provider-default' as const };
}

/**
 * Read the routing this agent's next turn is configured with, through the owners
 * of each setting. Each owner's capability gate runs before its stored value is
 * believed, and nothing here checks that a configured source is available.
 */
export function describeContinuationRouting(input: ContinuationRoutingInput): ContinuationRouting {
	const endpoints = input.endpoints ?? [];
	const runOn = parseRunOnTarget(input.runOn);
	const runOnSupport = agentRunOnSupport(input.toolType);
	const background = parseBackgroundRequests(input.backgroundRequests);
	const backgroundSupport = backgroundRequestsSupport(input.toolType);
	return {
		basis: 'configured-now',
		provider: input.toolType,
		model: pickSetting(input.tabModel, input.agentModel),
		effort: pickSetting(input.tabEffort, input.agentEffort),
		runOn: !runOn.ok
			? { kind: 'invalid', label: runOn.error }
			: runOn.target.type === 'provider'
				? { kind: 'provider', label: 'Provider' }
				: !runOnSupport.supported
					? { kind: 'unsupported', label: runOnSupport.reason }
					: { kind: 'source', label: runOnTargetLabel(runOn.target, endpoints) },
		tiers: agentTierRows(
			{ toolType: input.toolType, tierTargets: input.tierTargets, runOn: input.runOn },
			input.harnessTierDefaults
		).map(
			(row): RoutingTierFact => ({
				tier: row.tier,
				target: row.target ? tierTargetLabel(row.target, endpoints) : null,
				source: row.source,
				...(row.problem ? { problem: row.problem } : {}),
			})
		),
		// The provider gate comes first: a stored target, valid or not, is not
		// believed on a provider the proxy cannot route for.
		backgroundRequests: !backgroundSupport.supported
			? { status: 'unsupported', reason: backgroundSupport.reason }
			: !background.ok
				? { status: 'invalid', reason: background.error }
				: background.backgroundRequests
					? {
							status: 'configured',
							label: runOnTargetLabel(background.backgroundRequests.target, endpoints),
						}
					: { status: 'not-routed' },
		notChecked: [...ROUTING_NOT_CHECKED],
	};
}

/** One short line per fact, for a report. The values are the caller's settings, not text to trust. */
export function describeRoutingLines(routing: ContinuationRouting): string[] {
	const { model, effort, runOn, tiers, backgroundRequests } = routing;
	const where = (setOn: typeof model.setOn) =>
		setOn === 'provider-default' ? "the provider's default" : `set on the ${setOn}`;
	const tierText = tiers
		.map((row) =>
			row.target
				? `${row.tier} = ${row.target} (${TIER_TARGET_SOURCE_LABELS[row.source ?? 'built-in']})`
				: `${row.tier} = ${row.problem ? 'unusable' : TIER_NOT_MAPPED_LABEL}`
		)
		.join(', ');
	const runOnText = {
		provider: 'Provider',
		source: `configured for ${runOn.label}`,
		unsupported: `a source is stored, but this harness cannot run on one (${runOn.label})`,
		invalid: `the stored target is not usable (${runOn.label})`,
	}[runOn.kind];
	const backgroundText = {
		configured: () => `configured to go to ${(backgroundRequests as { label: string }).label}`,
		'not-routed': () => 'not routed (they go to the provider)',
		unsupported: () => 'not available for this provider',
		invalid: () => 'the stored setting is not usable',
	}[backgroundRequests.status]();
	return [
		`Provider ${routing.provider}; model ${model.value ?? 'default'} (${where(model.setOn)}); effort ${effort.value ?? 'default'} (${where(effort.setOn)}).`,
		`Run on: ${runOnText}.`,
		`Tier targets: ${tierText}.`,
		`Background requests: ${backgroundText}.`,
		`Not checked: ${routing.notChecked.join(', ')}.`,
	];
}
