import type { Group } from './types';

/**
 * Returns whether a group can become a direct child of another group.
 *
 * Group nesting is intentionally limited to one parent-child edge. A child
 * cannot have children, and a parent must be a root group.
 */
export function canSetGroupParent(
	groups: readonly Group[],
	groupId: string,
	parentGroupId: string | undefined
): boolean {
	const group = groups.find((candidate) => candidate.id === groupId);
	if (!group) return false;
	if (parentGroupId === undefined) return true;

	const parent = groups.find((candidate) => candidate.id === parentGroupId);
	if (!parent || parent.id === group.id || parent.parentGroupId) return false;
	if (groups.some((candidate) => candidate.parentGroupId === group.id)) return false;

	const visited = new Set<string>();
	let ancestor: Group | undefined = parent;
	while (ancestor) {
		if (ancestor.id === group.id || visited.has(ancestor.id)) return false;
		visited.add(ancestor.id);
		ancestor = ancestor.parentGroupId
			? groups.find((candidate) => candidate.id === ancestor?.parentGroupId)
			: undefined;
	}

	return true;
}

/** Returns whether a new group can be created as a direct child of a root group. */
export function canCreateGroupInside(
	groups: readonly Group[],
	parentGroupId: string | undefined
): boolean {
	if (!parentGroupId) return true;
	return groups.some((group) => group.id === parentGroupId && !group.parentGroupId);
}

/**
 * Returns a new group list with one group moved to a root group or a direct
 * parent. Invalid moves deliberately leave the persisted list unchanged.
 */
export function setGroupParent(
	groups: Group[],
	groupId: string,
	parentGroupId: string | undefined
): Group[] {
	if (!canSetGroupParent(groups, groupId, parentGroupId)) return groups;

	const group = groups.find((candidate) => candidate.id === groupId);
	if (!group || group.parentGroupId === parentGroupId) return groups;

	return groups.map((candidate) =>
		candidate.id === groupId
			? {
					...candidate,
					...(parentGroupId ? { parentGroupId } : { parentGroupId: undefined }),
				}
			: candidate
	);
}

/**
 * Park a group out of the Left Bar, or bring it back.
 *
 * The one write behind both the Left Bar's Hide/Show Group action and
 * `maestro-cli update-group --hide/--show`. A visible group stores NO `hidden`
 * key rather than `false`, matching every group written before the field
 * existed. Returns the input unchanged when the group already reads that way,
 * so a caller can tell a no-op from a write by identity.
 */
export function setGroupHidden(groups: Group[], groupId: string, hidden: boolean): Group[] {
	const target = groups.find((group) => group.id === groupId);
	if (!target || !!target.hidden === hidden) return groups;
	return groups.map((group) => {
		if (group.id !== groupId) return group;
		const next: Group = { ...group };
		if (hidden) next.hidden = true;
		else delete next.hidden;
		return next;
	});
}

/**
 * Which groups are parked out of the Left Bar right now.
 *
 * `hidden` is authored on ONE group, but suppression is inherited: the
 * hierarchy allows a single parent -> child edge and a child renders as its own
 * row indented under its parent, so hiding a parent without its children leaves
 * the children indented under nothing.
 *
 * Deliberately a set of group ids rather than a per-group predicate, because
 * the Left Bar's consumers - the render path and the Cmd+[ / Cmd+] cycle - ask
 * the question once per SESSION, and re-walking the parent chain for each agent
 * turns a one-off O(groups) pass into O(sessions x depth) on every keystroke.
 * `maestro-cli list agents` / `show agent` read it too, so the CLI's
 * `groupHidden` agrees with what the Left Bar parks.
 */
export function collectHiddenGroupIds(
	groups: readonly GroupVisibilityFields[]
): ReadonlySet<string> {
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

/** The group fields the hidden rule and the agent group label read. */
export type GroupVisibilityFields = Pick<Group, 'id' | 'name' | 'hidden' | 'parentGroupId'>;

/** The group an agent sits in, as `list agents` / `show agent` report it. */
export interface AgentGroupInfo {
	/** Null when the agent has no group or its group no longer exists. */
	groupName: string | null;
	/** True when the group (or its parent) is parked out of the Left Bar. */
	groupHidden: boolean;
}

/**
 * Build a lookup from an agent's `groupId` to its group name and hidden state.
 * The hidden set is computed once, so a caller labelling a whole list pays
 * O(groups + agents), not O(groups x agents).
 */
export function agentGroupLookup(
	groups: readonly GroupVisibilityFields[]
): (groupId: string | undefined) => AgentGroupInfo {
	const hidden = collectHiddenGroupIds(groups);
	const names = new Map(groups.map((group) => [group.id, group.name]));
	return (groupId) => ({
		groupName: (groupId && names.get(groupId)) || null,
		groupHidden: !!groupId && hidden.has(groupId),
	});
}

/**
 * Fold a group in the Left Bar, or unfold it.
 *
 * The one write behind the group header's chevron (`toggleGroup` in
 * `useGroupManagement`), the store's `setGroupCollapsed` /
 * `toggleGroupCollapsed`, and
 * `maestro-cli update-group --collapse/--expand`. Nested groups use the same
 * `collapsed` flag, so this covers them too. Returns the input unchanged when
 * the group is missing or already reads that way, so a caller can tell a no-op
 * from a write by identity.
 */
export function setGroupCollapsed(groups: Group[], groupId: string, collapsed: boolean): Group[] {
	const target = groups.find((group) => group.id === groupId);
	if (!target || !!target.collapsed === collapsed) return groups;
	return groups.map((group) => (group.id === groupId ? { ...group, collapsed } : group));
}

/**
 * Repairs persisted hierarchy data that predates nesting validation or was
 * written by an external client. Invalid relationships are promoted to root
 * rather than discarded so no group is lost.
 */
export function normalizeGroupHierarchy(groups: Group[]): Group[] {
	const groupsById = new Map(groups.map((group) => [group.id, group]));
	let changed = false;

	const normalizedGroups = groups.map((group) => {
		if (group.parentGroupId === undefined) return group;

		const parent = groupsById.get(group.parentGroupId);
		if (parent && parent.id !== group.id && parent.parentGroupId === undefined) {
			return group;
		}

		changed = true;
		const { parentGroupId: _parentGroupId, ...rootGroup } = group;
		return rootGroup;
	});

	return changed ? normalizedGroups : groups;
}

/**
 * Removes a group without deleting its agents. Direct child groups are promoted
 * to the top level so deleting a parent never cascades through the hierarchy.
 */
export function removeGroupAndPromoteChildren(groups: readonly Group[], groupId: string): Group[] {
	return groups
		.filter((group) => group.id !== groupId)
		.map((group) =>
			group.parentGroupId === groupId ? { ...group, parentGroupId: undefined } : group
		);
}

/** Apply only changes made since this writer read the registry. Unseen peers survive. */
export function mergeGroupPersistenceChanges(
	current: Group[],
	incoming: Group[],
	baseline: Group[]
): Group[] {
	const before = new Map(baseline.map((group) => [group.id, group]));
	const updates = new Map(incoming.map((group) => [group.id, group]));
	const merged = current.flatMap((group) => {
		const previous = before.get(group.id);
		const update = updates.get(group.id);
		if (!previous) return [group];
		if (!update) return [];
		const next = { ...group };
		for (const key of Object.keys({ ...previous, ...update }) as (keyof Group)[]) {
			if (key !== 'id' && update[key] !== previous[key]) {
				Object.assign(next, { [key]: update[key] });
			}
		}
		return [next];
	});
	const present = new Set(current.map((group) => group.id));
	for (const group of incoming) {
		// A missing observed id was deleted by a peer, not created by this writer.
		if (!before.has(group.id) && !present.has(group.id)) {
			merged.push(group);
			present.add(group.id);
		}
	}
	return normalizeGroupHierarchy(merged);
}
