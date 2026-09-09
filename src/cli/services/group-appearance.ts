// Shared plumbing for the CLI verbs that write group appearance
// (`create-group`, `update-group`).
//
// The important piece here is `verifyPersistedGroup`. The desktop answers
// `{ success: true }` as soon as the renderer accepted the message, and an
// older desktop that does not know the `icon` / `color` fields accepts the
// message and drops them - reporting success for a change that never happened.
// So after every write we read `maestro-groups.json` back and compare the
// stored values against what was asked for. That catches a version mismatch, a
// silently ignored field, and a clear that did not take, all with one check,
// and it does not rely on the desktop echoing anything back to us.

import { readGroups } from './storage';
import type { Group } from '../../shared/types';

/** What the persisted group is expected to look like after a write. */
export interface ExpectedGroupState {
	name?: string;
	emoji?: string;
	icon?: string;
	color?: string;
	parentGroupId?: string;
	/** Fields that must be absent (or, for emoji, back at the default) afterwards. */
	cleared?: readonly ('emoji' | 'icon' | 'color' | 'parent')[];
}

/** The default emoji the desktop assigns a group with no explicit one. */
export const DEFAULT_GROUP_EMOJI = '\u{1F4C2}';

const VERSION_MISMATCH_HINT =
	'The running Maestro desktop app accepted the command but did not store it. This usually means the desktop app is older than this CLI and silently ignored the new fields - update the desktop app and retry.';

/**
 * Read the group back from disk and confirm it matches what was requested.
 * Returns `null` when everything matches, or the error text to fail with.
 */
export function verifyPersistedGroup(groupId: string, expected: ExpectedGroupState): string | null {
	let stored: Group | undefined;
	try {
		stored = readGroups().find((group) => group.id === groupId);
	} catch (error) {
		return `Could not verify the group after writing it: ${
			error instanceof Error ? error.message : String(error)
		}`;
	}

	if (!stored) {
		return `Group ${groupId} was not found after the write. ${VERSION_MISMATCH_HINT}`;
	}

	const mismatches: string[] = [];
	const cleared = new Set(expected.cleared ?? []);

	// The desktop upper-cases group names, so compare case-insensitively -
	// otherwise every rename would look like a mismatch.
	if (expected.name && stored.name.toUpperCase() !== expected.name.toUpperCase()) {
		mismatches.push(`name is "${stored.name}", expected "${expected.name.toUpperCase()}"`);
	}
	if (expected.emoji && stored.emoji !== expected.emoji) {
		mismatches.push(`emoji is ${stored.emoji || '(none)'}, expected ${expected.emoji}`);
	}
	if (expected.icon && stored.icon !== expected.icon) {
		mismatches.push(`icon is ${stored.icon || '(none)'}, expected ${expected.icon}`);
	}
	if (expected.color && stored.color !== expected.color) {
		mismatches.push(`color is ${stored.color || '(none)'}, expected ${expected.color}`);
	}
	if (expected.parentGroupId && stored.parentGroupId !== expected.parentGroupId) {
		mismatches.push(
			`parent is ${stored.parentGroupId || '(top level)'}, expected ${expected.parentGroupId}`
		);
	}

	if (cleared.has('emoji') && stored.emoji && stored.emoji !== DEFAULT_GROUP_EMOJI) {
		mismatches.push(`emoji is still ${stored.emoji}`);
	}
	if (cleared.has('icon') && stored.icon) mismatches.push(`icon is still ${stored.icon}`);
	if (cleared.has('color') && stored.color) mismatches.push(`color is still ${stored.color}`);
	if (cleared.has('parent') && stored.parentGroupId) {
		mismatches.push(`parent is still ${stored.parentGroupId}`);
	}

	if (mismatches.length === 0) return null;
	return `Group ${groupId} was not stored as requested (${mismatches.join('; ')}). ${VERSION_MISMATCH_HINT}`;
}

/** The appearance/hierarchy fields of a stored group, for JSON output. */
export function describePersistedGroup(groupId: string): Partial<Group> {
	const stored = readGroups().find((group) => group.id === groupId);
	if (!stored) return {};
	return {
		id: stored.id,
		name: stored.name,
		emoji: stored.emoji,
		...(stored.icon ? { icon: stored.icon } : {}),
		...(stored.color ? { color: stored.color } : {}),
		...(stored.parentGroupId ? { parentGroupId: stored.parentGroupId } : {}),
	};
}
