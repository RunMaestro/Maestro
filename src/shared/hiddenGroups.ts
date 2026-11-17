/**
 * Which groups are parked out of the Left Bar.
 *
 * Shared so every surface that reports a group as hidden (the Left Bar, the
 * Cmd+O switcher, `maestro-cli list agents`) reads the flag the same way.
 */

import type { Group } from './types';

/** The fields of a group the hidden walk reads. */
export type HiddenGroupInput = Pick<Group, 'id' | 'hidden' | 'parentGroupId'>;

/**
 * Which groups are parked out of the Left Bar right now.
 *
 * `hidden` is authored on ONE group, but suppression is inherited: the
 * hierarchy allows a single parent -> child edge and a child renders as its own
 * row indented under its parent, so hiding a parent without its children leaves
 * the children indented under nothing.
 *
 * Deliberately a set of group ids rather than a per-group predicate, because
 * the consumers ask the question once per AGENT, and re-walking the parent
 * chain for each agent turns a one-off O(groups) pass into O(agents x depth).
 *
 * Hiding never restricts access. A caller uses this to sort, mark or skip an
 * agent, never to refuse one.
 */
export function collectHiddenGroupIds(groups: readonly HiddenGroupInput[]): ReadonlySet<string> {
	const hidden = new Set<string>();
	for (const group of groups) {
		if (group.hidden) hidden.add(group.id);
	}
	if (hidden.size === 0) return hidden;
	for (const group of groups) {
		if (group.parentGroupId && hidden.has(group.parentGroupId)) hidden.add(group.id);
	}
	return hidden;
}
