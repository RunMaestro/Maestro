import { describe, expect, it } from 'vitest';
import type { QuickAction } from '../../../../../renderer/components/QuickActionsModal/types';
import {
	alphabetizeKey,
	filterAndSortQuickActions,
	shouldShowAgentBucketHeaders,
} from '../../../../../renderer/components/QuickActionsModal/utils/quickActionSorting';

const action = (
	overrides: Partial<QuickAction> & Pick<QuickAction, 'id' | 'label'>
): QuickAction => ({
	action: () => {},
	...overrides,
});

describe('quickActionSorting', () => {
	it('filters case-insensitively and hides debug commands until searching debug', () => {
		const actions = [
			action({ id: 'settings', label: 'Settings' }),
			action({ id: 'debugReset', label: 'Debug: Reset Busy State' }),
		];

		expect(filterAndSortQuickActions(actions, 'set', 'main').map((a) => a.id)).toEqual([
			'settings',
		]);
		expect(filterAndSortQuickActions(actions, 'debug', 'main').map((a) => a.id)).toEqual([
			'debugReset',
		]);
	});

	it('prefers bookmarked jump actions when two entries share the same agent sort key', () => {
		const sorted = filterAndSortQuickActions(
			[
				action({ id: 'child', label: 'Jump to Maestro subagent: rc', agentSortKey: 'rc' }),
				action({ id: 'root', label: 'Jump to: rc', agentSortKey: 'rc', bookmarked: true }),
			],
			'',
			'main'
		);

		expect(sorted[0].id).toBe('root');
	});

	it('sorts agents by live bucket, then alphabetically with leading emoji skipped', () => {
		const sorted = filterAndSortQuickActions(
			[
				action({ id: 'idle-z', label: 'Zulu', isRunningAgent: false }),
				action({ id: 'live-b', label: 'Bravo', isRunningAgent: true }),
				action({ id: 'live-a', label: '🚀 Atlas', isRunningAgent: true }),
			],
			'',
			'agents'
		);

		expect(sorted.map((a) => a.id)).toEqual(['live-a', 'live-b', 'idle-z']);
		expect(alphabetizeKey('🚀 Atlas')).toBe('atlas');
	});

	it('only shows agent bucket headers when both live and idle buckets exist', () => {
		expect(
			shouldShowAgentBucketHeaders(
				[
					action({ id: 'live', label: 'Live', isRunningAgent: true }),
					action({ id: 'idle', label: 'Idle', isRunningAgent: false }),
				],
				'agents'
			)
		).toBe(true);
		expect(shouldShowAgentBucketHeaders([action({ id: 'live', label: 'Live' })], 'main')).toBe(
			false
		);
	});

	it('hides headers when every row is in the same bucket', () => {
		expect(
			shouldShowAgentBucketHeaders(
				[
					action({ id: 'a', label: 'A', isRunningAgent: false }),
					action({ id: 'b', label: 'B', isRunningAgent: false }),
				],
				'agents'
			)
		).toBe(false);
	});
});

describe('quickActionSorting - hidden tier', () => {
	const live = action({ id: 'live', label: 'Zulu', isRunningAgent: true });
	const idle = action({ id: 'idle', label: 'Alpha' });
	const hidden = action({ id: 'hidden', label: 'Bravo', inHiddenGroup: true });

	it('sorts hidden-group agents into the last tier, after live and idle', () => {
		const sorted = filterAndSortQuickActions([hidden, idle, live], '', 'agents');
		expect(sorted.map((a) => a.id)).toEqual(['live', 'idle', 'hidden']);
	});

	// The tier is a property of where the agent was PARKED, not of what it
	// happens to be doing, so it does not move between tiers as a turn runs.
	it('keeps a running agent in the hidden tier when its group is hidden', () => {
		const busyHidden = action({
			id: 'busyHidden',
			label: 'Charlie',
			isRunningAgent: true,
			inHiddenGroup: true,
		});
		const sorted = filterAndSortQuickActions([busyHidden, live], '', 'agents');
		expect(sorted.map((a) => a.id)).toEqual(['live', 'busyHidden']);
	});

	// The sort key is the agent's name, which two agents can share. A bookmark
	// must not lift the parked one out of its tier and under the wrong header.
	it('keeps a bookmarked hidden agent below a same-named visible agent', () => {
		const visible = action({ id: 'visible', label: 'Jump to: rc', agentSortKey: 'rc' });
		const parked = action({
			id: 'parked',
			label: 'Jump to: rc',
			agentSortKey: 'rc',
			bookmarked: true,
			inHiddenGroup: true,
		});
		const sorted = filterAndSortQuickActions([parked, visible], '', 'agents');
		expect(sorted.map((a) => a.id)).toEqual(['visible', 'parked']);
	});

	it('still prefers the bookmarked entry inside one tier', () => {
		const plain = action({ id: 'plain', label: 'Jump to: rc', agentSortKey: 'rc' });
		const starred = action({
			id: 'starred',
			label: 'Jump to: rc',
			agentSortKey: 'rc',
			bookmarked: true,
		});
		const sorted = filterAndSortQuickActions([plain, starred], '', 'agents');
		expect(sorted.map((a) => a.id)).toEqual(['starred', 'plain']);
	});

	// Hiding suppresses a group from the LIST; it never restricts access.
	it('still returns a hidden agent that matches the search', () => {
		expect(filterAndSortQuickActions([hidden, idle], 'bravo', 'agents').map((a) => a.id)).toEqual([
			'hidden',
		]);
	});

	it('shows bucket headers once a hidden agent joins a single-bucket list', () => {
		expect(shouldShowAgentBucketHeaders([idle], 'agents')).toBe(false);
		expect(shouldShowAgentBucketHeaders([idle, hidden], 'agents')).toBe(true);
	});
});
