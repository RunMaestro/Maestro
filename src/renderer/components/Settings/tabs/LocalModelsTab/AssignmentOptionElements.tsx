/**
 * The `<option>` and `<optgroup>` elements for a list of assignment option
 * groups, so every picker built from `buildAssignmentOptionGroups` (the Local
 * Models Assignments rows, the Conductor Brain picker) draws them the same way.
 * Rendered inside the caller's own `<select>`.
 */

import type { AssignmentOptionGroup } from './assignmentOptions';

export function AssignmentOptionElements({ groups }: { groups: readonly AssignmentOptionGroup[] }) {
	return (
		<>
			{groups.map((group) =>
				group.label === null ? (
					group.options.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))
				) : (
					<optgroup key={group.label} label={group.label}>
						{group.options.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</optgroup>
				)
			)}
		</>
	);
}
