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
