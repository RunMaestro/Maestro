/**
 * GroupPill - the small badge that names an agent's group.
 *
 * Used in two places:
 *   1. The Left Bar's bookmarked agents (`SessionItem.tsx`), gated by
 *      `showGroupLabelInBookmarks`.
 *   2. Group Settings, where it previews the pill label as the user types it.
 *
 * One component, so the preview cannot drift from the badge it previews. The
 * text comes from `groupBadgeLabel()`: the group's own `shortLabel` when one
 * is set, the automatic abbreviation otherwise. `full` draws the real group
 * name instead, which is the `showFullGroupLabelInBookmarks` contract, and a
 * `shortLabel` does not override it.
 *
 * The title is always the full group name, so the pill is decodable on hover
 * whatever the user typed into it.
 */

import type { Group, Theme } from '../../types';
import { groupBadgeLabel } from '../../../shared/formatters';

export interface GroupPillProps {
	theme: Theme;
	group: Pick<Group, 'name' | 'shortLabel'>;
	/** Draw the full group name, truncated, instead of the short badge. */
	full?: boolean;
	testId?: string;
}

export function GroupPill({ theme, group, full = false, testId }: GroupPillProps) {
	return (
		<span
			className={`row-group-chip text-3xs px-1 py-0.5 rounded${
				full ? ' max-w-[140px] truncate' : ''
			}`}
			style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
			title={group.name}
			data-testid={testId}
		>
			{full ? group.name : groupBadgeLabel(group)}
		</span>
	);
}
