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
});
