import type { PlaybookLaunchRecord } from '../../shared/marketplace-types';

/**
 * Shared test factory for `PlaybookLaunchRecord`, the persisted record of one Playbook Launch.
 *
 * Produces a launch that is still running on `session-1` (the id `createMockSession` uses), with
 * an empty answer set and a launch block that has only the required outro text. Override only
 * what the test is about, for example `status: 'completed'` with a `completion`, or a `spec`
 * whose outro names files.
 */
export function createMockLaunchRecord(
	overrides: Partial<PlaybookLaunchRecord> = {}
): PlaybookLaunchRecord {
	return {
		launchId: 'launch-1',
		playbookId: 'research-market',
		playbookTitle: 'Market Research',
		sessionId: 'session-1',
		folderRelativePath: 'research-market-launch-20261111-090000',
		autoRunFolderPath: '/test/project/.maestro/playbooks',
		spec: {
			inputs: [],
			outro: { summary: 'Mapped the market.', nextSteps: [] },
		},
		savedPlaybookId: 'saved-1',
		keepSavedPlaybook: false,
		values: {},
		status: 'running',
		startedAt: 1_000,
		...overrides,
	};
}
