/**
 * Provider Tab Sessions
 *
 * Turn settings codified at send, plus the renderer's import site for the
 * provider swap.
 *
 * Parking and turn attribution come from `maestro-lib/agents/providerSwap.ts`.
 * A provider change parks native state unless conversion is selected.
 * Desktop and headless sends translate missing native context through the
 * same library gate before launching the captured provider.
 * Re-exports keep existing renderer import sites on the shared helpers.
 */

import type { AITab, QueuedItem, QueuedTurnSettings, Session } from '../types';
import { isAutoModel } from '../../shared/autoModel';
import {
	autoModelHold,
	pendingAutoTurnStamp,
	queuedAutoTurnStamp,
	resolveAutoTurn,
	type AutoModelHold,
	type AutoRouteStamp,
	type AutoSessionLaunch,
	type AutoTurn,
	type AutoTurnStamp,
} from '../../shared/autoTurn';
import type { LocalModelEndpoint } from '../../shared/local-models/endpoints';
import {
	isRunOnSourceTarget,
	parseRunOnTarget,
	runOnPillLabel,
	type RunOnSourceTarget,
	type RunOnTarget,
} from '../../shared/local-models/run-on';
import type { TierRouting } from '../../shared/modelTiers';
import { useSettingsStore } from '../stores/settingsStore';
import {
	projectTabProvider,
	resolveTabProvider,
} from '../../shared/maestro-lib/agents/providerSwap';

export {
	projectTabProvider,
	providerOverridesFor,
	resolveTabProvider,
	resolveTabNativeProvider,
	resolveTurnProvider,
	resolveErrorProvider,
	switchAgentProvider,
	switchTabProvider,
	switchTabProviderFor,
	updateProviderSlot,
} from '../../shared/maestro-lib/agents/providerSwap';

/** The tab fields a send freezes: who owns the turn and what it runs under. */
export type CodifiedTurn = Pick<
	AITab,
	| 'turnProvider'
	| 'turnModel'
	| 'turnEffort'
	| 'turnRunOn'
	| 'turnRunOnSource'
	| 'turnAuto'
	| 'turnRunOnTarget'
	| 'turnRouting'
	| 'turnSessionId'
>;

/**
 * The tab fields that codify a turn's configuration at send time.
 *
 * Spread this into the tab patch that marks the tab busy, so every send path
 * freezes the same values: the provider that owns the turn, and the model and
 * effort it runs under. Resolution order matches what the spawn call actually
 * passes to the agent (tab override, then agent override); a value left
 * undefined means the agent's own default applies, and consumers render
 * nothing rather than inventing a label.
 *
 * `turnRunOn` is where the turn ran when the agent's Run on target is a source
 * (`qwen3:latest · Ollama`). It is a label for the transcript, kept apart from
 * `turnModel` on purpose: `turnModel` is handed to the spawn as the agent's
 * model, and the launch replaces it with the target's own. `turnRunOnSource` is
 * the source that label names, frozen beside it for the turn's stats row
 * ({@link codifiedRunOn}).
 *
 * A turn on the Auto model is codified in two steps, because a send does not
 * wait for the router. Here, the moment the turn takes the tab, rule 1 is
 * decided from what the tab's session last ran ({@link tabSessionLaunch}) and
 * written into a `pending` `turnAuto` stamp, with the model the session keeps
 * (or none) as the provisional `turnModel`. `settleAutoTurnOnTab` finishes the
 * stamp when the router answers. With `route` (a queued item routed when it was
 * queued) both steps happen here and the stamp is final at once. `turnAuto` is
 * always returned, `undefined` for a named model, so a turn on a named model
 * clears the stamp the turn before it left.
 */
export function codifyTurnSettings(
	tab: AITab | undefined,
	session: Session,
	route?: AutoRouteStamp
): CodifiedTurn {
	({ agent: session, tab } = projectTabProvider(session, tab));
	const model = tab?.customModel ?? session.customModel;
	const effort = tab?.customEffort ?? session.customEffort;
	if (isAutoModel(model)) return codifyAutoTurn(tab, session, effort, route);
	return {
		turnProvider: session.toolType,
		turnSessionId: tab?.agentSessionId || undefined,
		turnModel: model,
		turnEffort: effort,
		...codifiedRunOn(session),
		turnRunOnTarget: session.runOn ?? { type: 'provider' },
		turnRouting: undefined,
		turnAuto: undefined,
	};
}

/**
 * What the provider session a tab would RESUME last ran on, for rule 1 of the
 * Auto model: its model, the place a tier sent it, and when it was last
 * active. `undefined` when the next turn starts a session (no resume id), and
 * when the last turn ran under another provider: nothing that provider ran on
 * says anything about this one's cache.
 *
 * Last activity is the newest transcript entry. A tab that is busy is active
 * now.
 */
export function tabSessionLaunch(
	tab: AITab | undefined,
	session: Pick<Session, 'toolType'>,
	now: number = Date.now()
): AutoSessionLaunch | undefined {
	if (!tab?.agentSessionId) return undefined;
	if (tab.turnSessionId && tab.turnSessionId !== tab.agentSessionId) return undefined;
	if (tab.turnProvider && tab.turnProvider !== resolveTabProvider(tab, session)) return undefined;
	const lastEntryAt = tab.logs[tab.logs.length - 1]?.timestamp;
	const lastActiveAt = tab.state === 'busy' ? now : lastEntryAt;
	return {
		...(tab.turnModel ? { model: tab.turnModel } : {}),
		...(tab.turnAuto?.runOn ? { runOn: tab.turnAuto.runOn } : {}),
		...(lastActiveAt !== undefined ? { lastActiveAt } : {}),
	};
}

/** Where a tier launches for this agent: its own targets, then the harness defaults. */
function tierRoutingOf(session: Pick<Session, 'tierTargets' | 'runOn'>): TierRouting {
	return {
		tierTargets: session.tierTargets,
		runOn: session.runOn,
		harnessDefaults: useSettingsStore.getState().harnessTierDefaults,
	};
}

/**
 * A resolved Auto turn as the tab fields it freezes. `runOn` is the place Auto
 * decided, read through the agent's own target when it decided none, so the
 * label names where the turn really runs.
 */
function codifiedAutoTurn(
	turn: Pick<AutoTurn, 'model' | 'effort' | 'runOn' | 'stamp'>,
	session: Session
): CodifiedTurn {
	return {
		turnProvider: session.toolType,
		turnModel: turn.model,
		turnEffort: turn.effort,
		...codifiedRunOn({ runOn: turn.runOn ?? session.runOn }),
		turnRunOnTarget: turn.runOn ?? session.runOn ?? { type: 'provider' },
		turnRouting: tierRoutingOf(session),
		turnAuto: turn.stamp,
	};
}

/**
 * Apply a route under a hold: the one call both steps of an Auto turn make, so
 * the provisional fields and the final ones cannot be resolved differently.
 */
function resolveTabAutoTurn(
	session: Session,
	hold: AutoModelHold | undefined,
	agentEffort: string | undefined,
	route: AutoRouteStamp | undefined,
	routing?: TierRouting
): AutoTurn {
	return resolveAutoTurn({
		toolType: session.toolType,
		...(route ? { route } : {}),
		...(hold ? { hold } : {}),
		agentEffort,
		routing: routing ?? tierRoutingOf(session),
	});
}

/** Codify a turn sent on Auto. `agentEffort` is the effort frozen with the send. */
function codifyAutoTurn(
	tab: AITab | undefined,
	session: Session,
	agentEffort: string | undefined,
	route: AutoRouteStamp | undefined,
	routing?: TierRouting
): CodifiedTurn {
	const hold = autoModelHold(session.toolType, tabSessionLaunch(tab, session), Date.now());
	const turn = resolveTabAutoTurn(session, hold, agentEffort, route, routing);
	// No answer yet: the fields are the no-decision resolution (what the session
	// keeps, the agent's own effort), and the stamp says the router is still out.
	return {
		...codifiedAutoTurn(route ? turn : { ...turn, stamp: pendingAutoTurnStamp(hold) }, session),
		turnSessionId: tab?.agentSessionId || undefined,
		turnRouting: routing ?? tierRoutingOf(session),
	};
}

/**
 * Finish a tab's pending Auto turn now that the router has answered: apply the
 * route under the hold the turn took the tab with, and with the effort frozen
 * then (the provisional `turnEffort`). Returns the tab unchanged when its turn
 * is not a pending Auto turn, so a late answer can never rewrite a turn that
 * has been settled or replaced.
 */
export function settleAutoTurnOnTab(tab: AITab, session: Session, route: AutoRouteStamp): AITab {
	if (tab.turnAuto?.status !== 'pending') return tab;
	session = projectTabProvider(
		session,
		tab,
		tab.turnProvider ?? resolveTabProvider(tab, session)
	).agent;
	session = { ...session, runOn: tab.turnRunOnTarget };
	const turn = resolveTabAutoTurn(
		session,
		tab.turnAuto.hold,
		tab.turnEffort,
		route,
		tab.turnRouting
	);
	return { ...tab, ...codifiedAutoTurn(turn, session), turnRouting: tab.turnRouting };
}

/** What a turn sent on Auto launches with. */
export interface AutoTurnLaunch {
	model?: string;
	effort?: string;
	/** The place Auto decided, for the spawn's `runOnOverride`. Absent: the agent's own target. */
	runOn?: RunOnTarget;
	/** The router's answer the turn was settled with, for a snapshot that may resend it. */
	route?: AutoRouteStamp;
}

/**
 * The launch a tab's codified Auto turn uses, read back from what was frozen.
 * `null` when the tab's turn was not sent on Auto, and while it is still
 * pending: a caller that gets `null` for an Auto turn has not settled it.
 */
export function autoTurnLaunch(tab: AITab | undefined): AutoTurnLaunch | null {
	const stamp = tab?.turnAuto;
	if (!tab || !stamp || stamp.status === 'pending') return null;
	return {
		...(tab.turnModel ? { model: tab.turnModel } : {}),
		...(tab.turnEffort ? { effort: tab.turnEffort } : {}),
		...(tab.turnRunOnTarget
			? { runOn: tab.turnRunOnTarget }
			: stamp.runOn
				? { runOn: stamp.runOn }
				: {}),
		...(stamp.route ? { route: stamp.route } : {}),
	};
}

/**
 * The source a turn of this agent runs on: undefined on the provider's own
 * model. A stored target that cannot be read names nothing, because its launch
 * is refused and no turn runs on it.
 */
export function turnRunOnSource(session: Pick<Session, 'runOn'>): RunOnSourceTarget | undefined {
	if (!session.runOn) return undefined;
	const parsed = parseRunOnTarget(session.runOn);
	return parsed.ok && isRunOnSourceTarget(parsed.target) ? parsed.target : undefined;
}

/**
 * Where a turn of this agent runs, for its pill: {@link turnRunOnSource} as a
 * label. `endpoints` defaults to the saved sources, which are read only for an
 * agent that has a target.
 */
export function turnRunOnLabel(
	session: Pick<Session, 'runOn'>,
	endpoints?: readonly Pick<LocalModelEndpoint, 'id' | 'name'>[]
): string | undefined {
	const source = turnRunOnSource(session);
	if (!source) return undefined;
	return runOnPillLabel(source, endpoints ?? useSettingsStore.getState().localModelEndpoints ?? []);
}

/**
 * The place a turn runs, as the two tab fields that freeze it: the label its
 * pill shows and the source its stats row names. One call for both, so they can
 * never name different places. Both are always returned, `undefined` on the
 * provider's own model, so a turn there clears what the turn before it left.
 */
function codifiedRunOn(
	session: Pick<Session, 'runOn'>
): Pick<CodifiedTurn, 'turnRunOn' | 'turnRunOnSource'> {
	return { turnRunOn: turnRunOnLabel(session), turnRunOnSource: turnRunOnSource(session) };
}

/**
 * Freeze the model and effort onto a {@link QueuedItem} at the moment it is
 * queued. Queuing IS the send from the user's point of view - they picked a
 * model, typed, and hit Enter - so the settings have to be captured here even
 * though the turn will not spawn until the queue drains, possibly several model
 * changes later.
 *
 * Every path that builds a QueuedItem should spread this in.
 */
export function captureQueuedTurnSettings(
	tab: AITab | undefined,
	session: Session,
	route?: AutoRouteStamp
): QueuedTurnSettings {
	({ agent: session, tab } = projectTabProvider(session, tab));
	// The SELECTION in force, not a resolution of it: an item queued on Auto
	// keeps the word, and what Auto comes to is decided when the turn takes the
	// tab. `route` is the router's answer when the caller already has it (a
	// snapshot of a turn that was just settled); it means nothing on a named model.
	const model = tab?.customModel ?? session.customModel;
	const effort = tab?.customEffort ?? session.customEffort;
	return {
		provider: session.toolType,
		runOn: structuredClone(session.runOn ?? { type: 'provider' }),
		routing: structuredClone(tierRoutingOf(session)),
		model,
		effort,
		...(route && isAutoModel(model) ? { route } : {}),
	};
}

/**
 * What a queued item's pills read (`<TurnSettingPills>`): its frozen model and
 * effort, or, for an item queued on Auto, the stamp of what the router
 * answered. A routed item's effort is the router's, resolved to the provider's
 * word when the turn launches, so the effort captured from the tab is not
 * shown for it: it is not what the turn will run at.
 */
export function queuedTurnPills(settings: QueuedTurnSettings | undefined): {
	provider?: QueuedTurnSettings['provider'];
	model?: string;
	effort?: string;
	runOn?: string;
	auto?: AutoTurnStamp;
} {
	// Use the captured harness and routing inputs, including a tier's explicit
	// provider target. Never borrow today's agent routing for a queued readout.
	const turn =
		settings?.provider && isAutoModel(settings.model) && settings.route
			? resolveAutoTurn({
					toolType: settings.provider,
					route: settings.route,
					agentEffort: settings.effort,
					routing: settings.routing,
				})
			: undefined;
	const runOn = turnRunOnLabel({ runOn: turn?.runOn ?? settings?.runOn });
	const captured = {
		...(settings?.provider ? { provider: settings.provider } : {}),
		...(runOn ? { runOn } : {}),
	};
	if (!settings || !isAutoModel(settings.model)) {
		return { ...captured, model: settings?.model, effort: settings?.effort };
	}
	const auto = queuedAutoTurnStamp(settings.route);
	return { ...captured, auto, ...(auto.status === 'routed' ? {} : { effort: settings.effort }) };
}

/**
 * The turn settings a dequeued item must run under: its own capture when it has
 * one, the live values otherwise.
 *
 * The fallback is for items queued before this was captured (a queue restored
 * from an older build), NOT a per-field default - an absent `model` inside a
 * present `turnSettings` means the agent's default was deliberately in force
 * when the user queued, and substituting the current selection there is exactly
 * the bug this exists to prevent.
 *
 * Provider-scoped captures project that provider's parked state for launch.
 * Legacy items follow the effective tab provider. New captures freeze Run on and
 * Auto routing inputs alongside the selection. Dispatch reads only that
 * snapshot; cache eligibility is checked against the resumed native slot.
 */
export function codifyQueuedTurnSettings(
	item: Pick<QueuedItem, 'turnSettings'> & Partial<Pick<QueuedItem, 'id'>>,
	tab: AITab | undefined,
	session: Session
): CodifiedTurn {
	({ agent: session, tab } = projectTabProvider(
		session,
		tab,
		item.turnSettings?.provider ?? resolveTabProvider(tab, session)
	));
	if (item.turnSettings?.runOn !== undefined)
		session = { ...session, runOn: item.turnSettings.runOn };
	const live = codifyTurnSettings(tab, session);
	if (
		!item.turnSettings ||
		(!item.turnSettings.provider &&
			item.id &&
			session.providerTranslationQueuedOrigins?.[item.id] &&
			session.providerTranslationQueuedOrigins[item.id] !== session.toolType)
	)
		return live;
	const { model, effort, route } = item.turnSettings;
	// Queued on Auto: the item's own answer from the router when it has one
	// (final at once), else a pending stamp the dispatch settles. Rule 1 is
	// decided now, from the tab as it stands when the turn takes it.
	if (isAutoModel(model))
		return codifyAutoTurn(tab, session, effort, route, item.turnSettings.routing);
	return {
		turnProvider: session.toolType,
		turnSessionId: tab?.agentSessionId || undefined,
		turnModel: model,
		turnEffort: effort,
		...codifiedRunOn(session),
		turnRunOnTarget: session.runOn ?? { type: 'provider' },
		turnRouting: undefined,
		turnAuto: undefined,
	};
}
