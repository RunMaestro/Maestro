/**
 * Turn attribution - which account STARTED the turn running on a tab.
 *
 * The account is known at spawn time (the bridge wraps the spawn in
 * {@link getActingUser}) but the History entry and the stats row for that
 * turn are written later, by the DESKTOP renderer's exit listener - it is the
 * single owner of one-shot turn effects (see useOwnedSideEffectGate) - and by
 * then no acting user is in scope. So the spawn path notes the actor here,
 * keyed by agent + tab, and the History and stats handlers look it up.
 *
 * One entry per tab, overwritten by the next spawn: a tab runs one turn at a
 * time, and an entry left behind by a finished turn is harmless because the
 * next spawn on that tab replaces it before anything is recorded for it. A
 * desktop-started turn CLEARS the entry, so a phone's earlier turn is never
 * credited to a later one typed at the keyboard.
 */

import type { WebActingUser } from '../../../shared/webLogin';

const actors = new Map<string, WebActingUser>();

function key(agentId: string, tabId: string | null | undefined): string {
	return `${agentId}:${tabId ?? ''}`;
}

/** Record (or clear, when `user` is undefined) who started the turn on this tab. */
export function noteTurnActor(
	agentId: string,
	tabId: string | null | undefined,
	user: WebActingUser | undefined
): void {
	const k = key(agentId, tabId);
	if (user) actors.set(k, user);
	else actors.delete(k);
}

/** Who started the most recent turn on this tab, or `undefined` for the desktop. */
export function resolveTurnActor(
	agentId: string,
	tabId: string | null | undefined
): WebActingUser | undefined {
	return actors.get(key(agentId, tabId));
}

/** Forget every actor for an agent (agent closed). */
export function forgetAgentActors(agentId: string): void {
	for (const k of actors.keys()) {
		if (k.startsWith(`${agentId}:`)) actors.delete(k);
	}
}

/** Test seam. */
export function resetTurnActors(): void {
	actors.clear();
}
