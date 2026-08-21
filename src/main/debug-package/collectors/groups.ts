/**
 * Groups Collector
 *
 * Collects Left Bar group structure without the user's labels.
 * Group names are user-chosen and routinely name a project, a client, or an
 * employer, so only the shape of the grouping is reported.
 */

import Store from 'electron-store';

export interface GroupInfo {
	id: string;
	collapsed: boolean;
	/** Length only: enough to debug truncation and layout bugs, not the label. */
	nameLength: number;
	hasEmoji: boolean;
}

/**
 * Collect group metadata without group names.
 */
export function collectGroups(groupsStore: Store<any>): GroupInfo[] {
	const storedGroups = groupsStore.get('groups', []) as any[];
	if (!Array.isArray(storedGroups)) {
		return [];
	}

	return storedGroups.map((group) => ({
		id: typeof group?.id === 'string' ? group.id : 'unknown',
		collapsed: !!group?.collapsed,
		nameLength: typeof group?.name === 'string' ? group.name.length : 0,
		hasEmoji: !!group?.emoji,
	}));
}
