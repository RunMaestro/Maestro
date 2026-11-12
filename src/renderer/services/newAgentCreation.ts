/**
 * The one way to create the agent a New Agent draft describes from outside
 * App's hook tree.
 *
 * `createNewSession(draft)` (`hooks/session/useSessionCrud.ts`) is the create
 * path of the New Agent modal: it validates the draft, stores and selects the
 * agent, claims it for this window and records the stats. It lives inside a
 * React hook. A caller with no component behind it (Playbook Launch creates its
 * new agent in `services/playbookLaunch.ts`) is handed the callback here, the
 * same arrangement as `registerBatchResumer`. Do NOT build an agent from a
 * draft any other way: the agent must be the one the modal's settings describe.
 */

import type { NewAgentDraft } from '../components/NewInstanceModal/types';
import { selectSessionById, useSessionStore } from '../stores/sessionStore';
import type { Session } from '../types';

/** Creates the agent a draft describes. Resolves its id, or `null` when it created none. */
export type NewAgentCreator = (draft: NewAgentDraft) => Promise<string | null>;

/**
 * How long a created agent may take to reach the session store.
 * `createNewSession` writes the store before it resolves, so the wait normally
 * ends at once. The bound stops a creator that reports an agent it never
 * stored from holding its caller forever. It is a limit, not a sleep: the wait
 * ends on the store change that adds the agent.
 */
export const NEW_AGENT_STORE_TIMEOUT_MS = 10_000;

let creator: NewAgentCreator | null = null;

/** Wire App's `createNewSession`. Called with `null` on teardown. */
export function registerNewAgentCreator(fn: NewAgentCreator | null): void {
	creator = fn;
}

/**
 * Resolve the stored agent once the session store holds it: at once when it
 * already does, else on the store change that adds it.
 */
function waitForStoredAgent(sessionId: string): Promise<Session> {
	const stored = selectSessionById(sessionId)(useSessionStore.getState());
	if (stored) return Promise.resolve(stored);
	return new Promise((resolve, reject) => {
		// Neither callback can run before both constants exist: a timer fires on
		// a later task, and the store calls a listener only on a later change.
		const timer = setTimeout(() => {
			unsubscribe();
			reject(
				new Error(
					`Agent ${sessionId} was created but did not reach the agent list in ${NEW_AGENT_STORE_TIMEOUT_MS} ms`
				)
			);
		}, NEW_AGENT_STORE_TIMEOUT_MS);
		const unsubscribe = useSessionStore.subscribe((state) => {
			const session = selectSessionById(sessionId)(state);
			if (!session) return;
			clearTimeout(timer);
			unsubscribe();
			resolve(session);
		});
	});
}

/**
 * Create the agent a draft describes through the registered creator, and
 * resolve it once the session store holds it.
 *
 * Resolves `null` when no agent was created: an unknown provider, a permission
 * mode the provider cannot honor, or a draft that fails validation (the creator
 * reports each to the user or the log). Rejects when no creator is registered
 * (tests, or before App's effect runs), and when the agent does not reach the
 * store within {@link NEW_AGENT_STORE_TIMEOUT_MS}.
 */
export async function createAgentFromDraft(draft: NewAgentDraft): Promise<Session | null> {
	if (!creator) {
		throw new Error('No agent creator is registered: App has not wired createNewSession yet');
	}
	const sessionId = await creator(draft);
	if (!sessionId) return null;
	return waitForStoredAgent(sessionId);
}
