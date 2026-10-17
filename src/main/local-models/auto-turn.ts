/**
 * A turn on the Auto model that the main process launches itself, with no tab
 * behind it: a Cue run whose subscription opts in, and a headless send
 * (`maestro-cli send` through the desktop app, a plugin's `agents.send`).
 *
 * The renderer resolves a tab's Auto turn from the tab: what its session last
 * ran is on the tab (`tabSessionLaunch`). A headless turn has no tab, so this
 * module is its two halves of the same thing:
 *
 *   - {@link resolveAgentAutoTurn} asks the router (`routeTurn`, with the
 *     patient timeout of a turn nobody is typing at) and resolves the answer
 *     through the shared `resolveAutoTurn`, against the agent's tier targets and
 *     the harness defaults.
 *   - {@link noteAutoSessionLaunch} remembers what a headless provider session
 *     launched on, so a later send that RESUMES it keeps its model while the
 *     provider's cache is warm (rule 1). The memory is this process's and is
 *     gone at a restart, which reads as a cold session: the right answer for one
 *     nobody has touched since.
 *
 * A session this module has no record of is cold. So a first send that resumes
 * a session made elsewhere (a tab's, a CLI's own spawn) takes the router's
 * tier, and is on record from then on.
 */

import type { ModelHint } from '../../shared/autorunModelHints';
import {
	autoModelHold,
	autoRouteStamp,
	autoTurnNeedsRoute,
	promptCacheLifetimeMs,
	resolveAutoTurn,
	type AutoSessionLaunch,
	type AutoTurn,
} from '../../shared/autoTurn';
import { MODEL_ROUTING_UNATTENDED_TIMEOUT_MS } from '../../shared/local-models/model-routing-task';
import { parseHarnessTierDefaults, type TierTargets } from '../../shared/modelTiers';
import type { ToolType } from '../../shared/types';
import { getSettingsStore } from '../stores/getters';
import { routeTurn } from './route-turn';

/** The parts of a stored agent an Auto turn is resolved against. Read as data. */
export interface AutoTurnAgent {
	id: string;
	toolType: ToolType;
	customEffort?: string;
	tierTargets?: TierTargets | null;
	runOn?: unknown;
}

export interface AgentAutoTurnRequest {
	agent: AutoTurnAgent;
	/** What the turn was asked, as it is sent. The router judges this. */
	prompt: string;
	/** The provider session the turn resumes. Absent at a session start. */
	providerSessionId?: string;
	/**
	 * A setting someone wrote for this turn (a Cue subscription's `effort`). It
	 * wins on the axes it sets, and the router is not asked when it sets both.
	 */
	marker?: ModelHint | null;
	/** The caller stopped waiting. */
	signal?: AbortSignal;
}

/** What headless provider sessions launched on, by {@link sessionKey}. */
const sessionLaunches = new Map<string, { toolType: ToolType; launch: AutoSessionLaunch }>();

function sessionKey(toolType: ToolType, providerSessionId: string): string {
	return `${toolType}\u0000${providerSessionId}`;
}

/**
 * Decide and resolve one headless turn on the Auto model. Never rejects on a
 * routing: no decision resolves to the agent's default, like every Auto turn.
 * A tier target that cannot be used comes back as `refusal`, and the caller
 * must not launch.
 */
export async function resolveAgentAutoTurn(request: AgentAutoTurnRequest): Promise<AutoTurn> {
	const { agent, prompt, providerSessionId, marker, signal } = request;
	const route = autoTurnNeedsRoute(marker)
		? autoRouteStamp(
				await routeTurn(
					{ agent: { id: agent.id }, prompt },
					{ timeoutMs: MODEL_ROUTING_UNATTENDED_TIMEOUT_MS, ...(signal ? { signal } : {}) }
				)
			)
		: undefined;
	const hold = providerSessionId
		? autoModelHold(
				agent.toolType,
				sessionLaunches.get(sessionKey(agent.toolType, providerSessionId))?.launch,
				Date.now()
			)
		: undefined;
	return resolveAutoTurn({
		toolType: agent.toolType,
		...(route ? { route } : {}),
		...(hold ? { hold } : {}),
		agentEffort: agent.customEffort,
		routing: {
			tierTargets: agent.tierTargets,
			runOn: agent.runOn,
			harnessDefaults: parseHarnessTierDefaults(getSettingsStore().get('harnessTierDefaults')),
		},
		...(marker ? { marker } : {}),
	});
}

/**
 * Record what a headless provider session just ran on. Call it when the turn
 * ends, with the session id the provider reported: that moment is the session's
 * last activity, and the id of a session that started with this turn is not
 * known before it.
 *
 * Records older than the provider's cache lifetime are dropped on the way in.
 * A cold record gives no hold, so keeping it would only grow the map.
 */
export function noteAutoSessionLaunch(
	toolType: ToolType,
	providerSessionId: string,
	turn: Pick<AutoTurn, 'model' | 'runOn'>,
	now: number = Date.now()
): void {
	for (const [key, entry] of sessionLaunches) {
		const lastActiveAt = entry.launch.lastActiveAt ?? 0;
		if (now - lastActiveAt > promptCacheLifetimeMs(entry.toolType)) sessionLaunches.delete(key);
	}
	sessionLaunches.set(sessionKey(toolType, providerSessionId), {
		toolType,
		launch: {
			...(turn.model ? { model: turn.model } : {}),
			...(turn.runOn ? { runOn: turn.runOn } : {}),
			lastActiveAt: now,
		},
	});
}

/** Forget every session, so each test starts from a fresh process. */
export function resetAutoSessionLaunchesForTests(): void {
	sessionLaunches.clear();
}
