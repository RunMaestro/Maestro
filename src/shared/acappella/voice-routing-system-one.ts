/**
 * Voice routing on System One: the typed questions that decide which agent and
 * tab a spoken request is for, and the reading of their answers as a
 * `RouteDecision`.
 *
 * A Brain model reads the roster and WRITES a decision. A System One engine
 * writes nothing: it is handed the utterance as the state and picks from named
 * options, so the roster becomes the options themselves.
 *
 *   - `target` - a choice over the conductor and every running agent, keyed by
 *                the agent's own id.
 *   - `tab`    - a choice over `current`, `new`, and every tab that can be
 *                returned to, keyed by the tab's own id.
 *   - `clear`  - a yes or no: does the request make clear which agent it is for.
 *                It is the confidence when the engine reports no distribution
 *                for `target` (the local judge names one option and no more).
 *
 * **Every option is keyed by a real id, never by its place in the roster.** An
 * answer is one of the keys it was offered, so an id that is not running cannot
 * come back, and a miscounted index cannot send a request to the neighbor of
 * the agent that was meant.
 *
 * What an engine cannot do is write. So the prompt the agent receives is the
 * user's own words, a new tab gets no suggested name, and the decision never
 * carries a `clarify` or a `reply`: the Conductor router still asks out loud
 * when the confidence is low, from the decision alone. A turn in which the
 * Conductor may TALK back is not asked here at all (see `system-one-brain.ts`).
 *
 * Pure, so the registry, the main process and a test build the same request
 * from the same context.
 */

import { voiceScopeAgentId } from './document-scope';
import {
	SYSTEM_ONE_MAX_CHOICE_OPTIONS,
	choice,
	noul,
	type SystemOneAnswers,
	type SystemOneJson,
	type SystemOneQuestions,
	type SystemOneTaskRequest,
	type SystemOneText,
} from '../local-models/system-one';
import type { RosterAgent, RosterTab } from './protocol';
import type { VoiceRouteContext } from './providers';
import type { RouteDecision } from './route-decision';

/** Cap on the roster handed to whatever routes. A hundred agents is a prompt, not context. */
export const VOICE_ROUTE_MAX_AGENTS = 40;
export const VOICE_ROUTE_MAX_TABS_PER_AGENT = 12;

/** How many earlier utterances a routing turn is shown. */
export const VOICE_ROUTE_RECENT_UTTERANCES = 5;

export const VOICE_ROUTE_TARGET_QUESTION_ID = 'target';
export const VOICE_ROUTE_TAB_QUESTION_ID = 'tab';
export const VOICE_ROUTE_CLEAR_QUESTION_ID = 'clear';

/** The `target` option that is not an agent. The spelling `RouteTarget` uses. */
export const VOICE_ROUTE_CONDUCTOR_OPTION = 'conductor';

/** The two `tab` options that are not a tab. The spellings `RouteTabAction` uses. */
export const VOICE_ROUTE_CURRENT_TAB_OPTION = 'current';
export const VOICE_ROUTE_NEW_TAB_OPTION = 'new';

/** The most tabs a `tab` question can offer beside `current` and `new`. */
const MAX_TAB_OPTIONS = SYSTEM_ONE_MAX_CHOICE_OPTIONS - 2;

/** What a routing turn hands the question builder: what was said, and the context it was said in. */
export interface VoiceRoutingSystemOneInput {
	utterance: string;
	context: VoiceRouteContext;
}

/**
 * One tab, as a line of the roster and as an option an engine reads.
 *
 * The topic is what makes recall possible at all: a tab called "Tab 3" tells a
 * model nothing, and "auth middleware rewrite" is the phrase the user will say
 * six hours later. The state is what stops a recall from being a lie - a snoozed
 * or closed tab is a legitimate target, but only if whoever picks it knows it has
 * to be woken first.
 */
export function describeRosterTab(tab: RosterTab): string {
	const label = tab.name ?? 'untitled';
	const parts = [label];
	if (tab.topic && tab.topic !== label) parts.push(`- ${tab.topic}`);
	if (tab.state && tab.state !== 'open') parts.push(`(${tab.state})`);
	return parts.join(' ');
}

/** What the questions offer: the one reading the builder and the answer reader share. */
interface VoiceRoutingOptions {
	/**
	 * The agent the session is bound to, when it is running. The session service
	 * pins the target to it whatever is answered, so no engine is asked.
	 */
	bound: RosterAgent | null;
	/** The agents `target` offers. Empty when {@link bound} is set. */
	agents: RosterAgent[];
	/** Every tab `tab` offers, by id, with the agent it belongs to. */
	tabs: Map<string, { tab: RosterTab; agent: RosterAgent }>;
}

/** Ids an agent or a tab cannot have, because an option already means something else. */
function isReservedOption(id: string): boolean {
	return (
		id === VOICE_ROUTE_CONDUCTOR_OPTION ||
		id === VOICE_ROUTE_CURRENT_TAB_OPTION ||
		id === VOICE_ROUTE_NEW_TAB_OPTION
	);
}

function voiceRoutingOptions(context: VoiceRouteContext): VoiceRoutingOptions {
	const roster = context.roster
		.filter((agent) => agent.sessionId !== '' && !isReservedOption(agent.sessionId))
		.slice(0, VOICE_ROUTE_MAX_AGENTS);
	const boundId = voiceScopeAgentId(context.scope);
	const bound = (boundId && roster.find((agent) => agent.sessionId === boundId)) || null;

	// The agent in front of the user leads, so its tabs are the last to be cut
	// when a large fleet has more tabs than one question can offer.
	const lead = bound ?? roster.find((agent) => agent.sessionId === context.activeAgentSessionId);
	const tabOwners = bound ? [bound] : lead ? [lead, ...roster.filter((a) => a !== lead)] : roster;

	const tabs: VoiceRoutingOptions['tabs'] = new Map();
	for (const agent of tabOwners) {
		for (const tab of agent.tabs.slice(0, VOICE_ROUTE_MAX_TABS_PER_AGENT)) {
			if (tabs.size >= MAX_TAB_OPTIONS) break;
			if (tab.id === '' || isReservedOption(tab.id) || tabs.has(tab.id)) continue;
			tabs.set(tab.id, { tab, agent });
		}
	}
	return { bound, agents: bound ? [] : roster, tabs };
}

/** One agent as a `target` option: who it is, where it works, and what it has open. */
function describeAgentOption(agent: RosterAgent, context: VoiceRouteContext): string {
	const status = agent.status ? ` ${agent.status}` : '';
	const parts = [`${agent.name} (${agent.agentType}${status}) in ${agent.cwd}.`];
	if (agent.sessionId === context.activeAgentSessionId) {
		parts.push('The user is looking at this agent.');
	}
	if (agent.recentWork) parts.push(`Recently: ${agent.recentWork}`);
	const tabs = agent.tabs.slice(0, VOICE_ROUTE_MAX_TABS_PER_AGENT).map(describeRosterTab);
	if (tabs.length > 0) parts.push(`Tabs: ${tabs.join('; ')}.`);
	return parts.join(' ');
}

/**
 * Voice routing as a System One request. The state is what was said and what
 * was said around it; the roster is the options.
 */
export function voiceRoutingSystemOneRequest(
	input: VoiceRoutingSystemOneInput
): SystemOneTaskRequest {
	const { context } = input;
	const options = voiceRoutingOptions(context);

	const state: { [key: string]: SystemOneJson } = { utterance: input.utterance.trim() };
	if (context.clarification) {
		// The answer alone is a fragment ("the API one"). The request it answers is
		// what gets routed, so both are named.
		state.answering = {
			request: context.clarification.utterance,
			question_asked: context.clarification.question,
		};
	}
	if (options.bound) state.bound_agent = options.bound.name;
	if (context.document) {
		state.document = { name: context.document.name, path: context.document.path };
	}
	const earlier = (context.recentUtterances ?? []).slice(-VOICE_ROUTE_RECENT_UTTERANCES);
	if (earlier.length > 0) state.earlier_utterances = earlier;

	const request = context.clarification
		? 'the request in `answering.request`, which `utterance` answers a question about,'
		: 'the request in `utterance`';

	const questions: SystemOneQuestions = {};
	if (!options.bound) {
		const targets: Record<string, SystemOneText | null> = {
			[VOICE_ROUTE_CONDUCTOR_OPTION]:
				'Maestro itself: the request is about the app, or no agent is clearly meant.',
		};
		for (const agent of options.agents) {
			targets[agent.sessionId] = describeAgentOption(agent, context);
		}
		// A choice needs two options, and a fleet of none still has a request to
		// place: with no agent running, the conductor is the only answer there is.
		if (options.agents.length > 0) {
			questions[VOICE_ROUTE_TARGET_QUESTION_ID] = choice(`Which agent is ${request} for?`, targets);
			questions[VOICE_ROUTE_CLEAR_QUESTION_ID] = noul(
				`Does ${request} make clear which agent it is for?`,
				{
					true: "It names an agent, or what it asks for fits exactly one agent's work.",
					false: 'It could be for more than one agent, or for none of them.',
				}
			);
		}
	}

	const tabs: Record<string, SystemOneText | null> = {
		[VOICE_ROUTE_CURRENT_TAB_OPTION]:
			'The tab that is already active on the agent. Choose this unless the user asks for a new tab or names an earlier conversation.',
		[VOICE_ROUTE_NEW_TAB_OPTION]:
			'A new tab: the user asks to start a new tab or a fresh conversation.',
	};
	for (const [tabId, { tab, agent }] of options.tabs) {
		tabs[tabId] = `Go back to the tab "${describeRosterTab(tab)}" on ${agent.name}.`;
	}
	questions[VOICE_ROUTE_TAB_QUESTION_ID] = choice(`Which tab should ${request} go to?`, tabs);

	return { state, questions };
}

/** A probability as a decision carries it: 0 to 1, two decimals. */
function asConfidence(value: number | undefined): number | null {
	if (typeof value !== 'number' || !Number.isFinite(value)) return null;
	return Math.min(1, Math.max(0, Math.round(value * 100) / 100));
}

/**
 * Read System One answers as a route decision, against the same options the
 * request offered. Returns `null` when an asked question has no usable answer:
 * the caller refuses the turn by name, and never guesses a target.
 *
 * The same rules `parseRouteDecision` holds a model to apply here: a target
 * that is not a running agent is the conductor, and a recall of a tab the
 * chosen agent does not own is the current tab.
 */
export function routeDecisionFromSystemOne(
	answers: SystemOneAnswers,
	input: VoiceRoutingSystemOneInput
): RouteDecision | null {
	const { context } = input;
	const options = voiceRoutingOptions(context);

	const tab = answers[VOICE_ROUTE_TAB_QUESTION_ID];
	if (tab?.type !== 'choice') return null;

	let agent = options.bound;
	let confidence: number | null;
	if (options.bound) {
		// The agent is not in question, so the tab is all there is to be unsure of.
		confidence = asConfidence(tab.probabilities?.[tab.choice]) ?? 1;
	} else if (options.agents.length === 0) {
		confidence = 1;
	} else {
		const target = answers[VOICE_ROUTE_TARGET_QUESTION_ID];
		if (target?.type !== 'choice') return null;
		agent = options.agents.find((candidate) => candidate.sessionId === target.choice) ?? null;
		const clear = answers[VOICE_ROUTE_CLEAR_QUESTION_ID];
		confidence =
			asConfidence(target.probabilities?.[target.choice]) ??
			(clear?.type === 'noul' ? asConfidence(clear.probability) : null);
		if (confidence === null) return null;
	}

	const recalled = options.tabs.get(tab.choice);
	const recall = !!agent && recalled?.agent.sessionId === agent.sessionId;
	const prompt = (context.clarification?.utterance ?? input.utterance).trim();

	return {
		target: agent ? { sessionId: agent.sessionId } : VOICE_ROUTE_CONDUCTOR_OPTION,
		tabAction: tab.choice === VOICE_ROUTE_NEW_TAB_OPTION ? 'new' : recall ? 'recall' : 'current',
		...(recall ? { tabId: tab.choice } : {}),
		prompt,
		confidence,
	};
}
