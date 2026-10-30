/**
 * Whether an agent is working on a sketch right now, for the canvas's working
 * pill and the tab chip's busy dot. Two sources, whichever way the work began:
 *
 * - A bot turn: an `@bot` request running for the sketch, from a guest on
 *   the web or from the conductor's own chat. Lit from the moment the relay
 *   starts it until the reply posts or fails; a held reply waits on the
 *   conductor, so it does not count.
 * - A sketch tool call (`sketch:agentActivity`): the owner agent read or
 *   changed the sketch through `maestro-sketch`, from any tab, an Auto Run or
 *   a Cue run. Lit while the turn that made the call is still running: a busy
 *   tab of the agent that started at or before the call, or the agent itself
 *   busy with no busy tab (a batch or Cue process).
 *
 * Only the owner can call a tool on a sketch (the bridge checks it), and only
 * the owner runs its bot turns, so the agent named is always the owner.
 */

import { useShallow } from 'zustand/react/shallow';
import type { Session } from '../../types';
import { useSessionStore } from '../../stores/sessionStore';
import {
	useSketchSessionStore,
	type SketchAgentActivityMark,
	type SketchBotRequest,
} from '../../stores/sketchSessionStore';

export interface SketchAgentWork {
	/** The agent's name, or null when it is not in this window. */
	agentName: string | null;
	/** The latest call of the running turn changed the canvas. */
	drawing: boolean;
}

/** The turn that made this call is still running. */
function activityIsLive(agent: Session | undefined, activity: SketchAgentActivityMark): boolean {
	if (!agent) return false;
	const busyTabs = agent.aiTabs.filter((tab) => tab.state === 'busy');
	if (busyTabs.length > 0) {
		return busyTabs.some((tab) => (tab.thinkingStartTime ?? 0) <= activity.at);
	}
	return agent.state === 'busy' && (agent.thinkingStartTime ?? 0) <= activity.at;
}

/** Whether an agent is working on the sketch, from the sketch's state and the agents. */
export function sketchAgentWork(input: {
	sketchId: string;
	botRequests: readonly SketchBotRequest[] | undefined;
	activity: SketchAgentActivityMark | undefined;
	agents: readonly Session[];
}): SketchAgentWork | null {
	const { sketchId, botRequests, activity, agents } = input;
	if (activity) {
		const agent = agents.find((session) => session.id === activity.agentId);
		if (activityIsLive(agent, activity)) {
			return { agentName: agent?.name ?? null, drawing: activity.writes };
		}
	}
	if (botRequests?.some((request) => request.status === 'running')) {
		const owner = agents.find((session) =>
			session.aiTabs.some((tab) => tab.sketchOrigin?.sketchId === sketchId)
		);
		return { agentName: owner?.name ?? null, drawing: false };
	}
	return null;
}

const IDLE = { working: false, agentName: null, drawing: false } as const;

/** {@link sketchAgentWork} for one sketch, re-rendering only when the answer changes. */
export function useSketchAgentWork(sketchId: string): SketchAgentWork | null {
	const botRequests = useSketchSessionStore((s) => s.sessions[sketchId]?.botRequests);
	const activity = useSketchSessionStore((s) => s.agentActivity[sketchId]);
	const work = useSessionStore(
		useShallow((s) => {
			const result = sketchAgentWork({ sketchId, botRequests, activity, agents: s.sessions });
			return result ? { working: true, ...result } : IDLE;
		})
	);
	return work.working ? { agentName: work.agentName, drawing: work.drawing } : null;
}

/** The pill's words: "Ada is drawing", "The agent is working". */
export function sketchAgentWorkLabel(work: SketchAgentWork): string {
	return `${work.agentName ?? 'The agent'} is ${work.drawing ? 'drawing' : 'working'}`;
}
