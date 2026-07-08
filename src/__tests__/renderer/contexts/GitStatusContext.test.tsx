import { fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	GitStatusProvider,
	useGitBranch,
	useGitDetail,
	useGitFileStatus,
	useGitStatus,
	type GitFileChange,
	type GitStatusData,
} from '../../../renderer/contexts/GitStatusContext';
import type { Session } from '../../../renderer/types';

const mocks = vi.hoisted(() => ({
	useGitStatusPolling: vi.fn(),
}));

vi.mock('../../../renderer/hooks', () => ({
	useGitStatusPolling: mocks.useGitStatusPolling,
}));

const sessions = [
	{ id: 'session-1', name: 'One', cwd: '/repo/one' },
	{ id: 'session-2', name: 'Two', cwd: '/repo/two' },
] as Session[];

function createStatus(overrides: Partial<GitStatusData> = {}): GitStatusData {
	return {
		fileCount: 2,
		branch: 'feature/context',
		remote: 'origin',
		behind: 1,
		ahead: 3,
		fileChanges: [
			{
				path: 'src/example.ts',
				status: 'M',
				additions: 8,
				deletions: 2,
				modified: true,
			},
		],
		totalAdditions: 8,
		totalDeletions: 2,
		modifiedCount: 1,
		lastUpdated: 123,
		...overrides,
	};
}

function Consumer({ sessionId }: { sessionId: string }) {
	const branch = useGitBranch();
	const fileStatus = useGitFileStatus();
	const detail = useGitDetail();
	const legacy = useGitStatus();

	const branchInfo = branch.getBranchInfo(sessionId);
	const details = detail.getFileDetails(sessionId);
	const status = legacy.getStatus(sessionId);

	return (
		<div>
			<div data-testid="branch">{branchInfo?.branch ?? 'missing'}</div>
			<div data-testid="remote">{branchInfo?.remote ?? 'missing'}</div>
			<div data-testid="ahead">{branchInfo?.ahead ?? 'missing'}</div>
			<div data-testid="behind">{branchInfo?.behind ?? 'missing'}</div>
			<div data-testid="file-count">{fileStatus.getFileCount(sessionId)}</div>
			<div data-testid="has-changes">{String(fileStatus.hasChanges(sessionId))}</div>
			<div data-testid="additions">{details?.totalAdditions ?? 'missing'}</div>
			<div data-testid="deletions">{details?.totalDeletions ?? 'missing'}</div>
			<div data-testid="modified-count">{details?.modifiedCount ?? 'missing'}</div>
			<div data-testid="file-change-count">{details?.fileChanges?.length ?? 'missing'}</div>
			<div data-testid="legacy-loading">{String(legacy.isLoading)}</div>
			<div data-testid="legacy-map-size">{legacy.gitStatusMap.size}</div>
			<div data-testid="legacy-file-count">{legacy.getFileCount(sessionId)}</div>
			<div data-testid="legacy-missing-file-count">{legacy.getFileCount('missing-session')}</div>
			<div data-testid="legacy-status">{status?.branch ?? 'missing'}</div>
			<div data-testid="missing-file-count">{fileStatus.getFileCount('missing-session')}</div>
			<div data-testid="missing-has-changes">
				{String(fileStatus.hasChanges('missing-session'))}
			</div>
			<div data-testid="missing-branch">
				{branch.getBranchInfo('missing-session') ? 'present' : 'missing'}
			</div>
			<div data-testid="missing-details">
				{detail.getFileDetails('missing-session') ? 'present' : 'missing'}
			</div>
			<div data-testid="missing-status">
				{legacy.getStatus('missing-session') ? 'present' : 'missing'}
			</div>
			<button onClick={() => void detail.refreshGitStatus()}>Refresh detail</button>
			<button onClick={() => void legacy.refreshGitStatus()}>Refresh legacy</button>
		</div>
	);
}

function expectHookToRequireProvider(useHook: () => unknown, message: string) {
	const preventExpectedWindowError = (event: ErrorEvent) => {
		event.preventDefault();
	};
	window.addEventListener('error', preventExpectedWindowError);
	try {
		expect(() => renderHook(() => useHook())).toThrow(message);
	} finally {
		window.removeEventListener('error', preventExpectedWindowError);
	}
}

describe('GitStatusContext', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('provides branch, file, detail, and legacy status values from the polling hook', () => {
		const refreshGitStatus = vi.fn().mockResolvedValue(undefined);
		const fileChanges: GitFileChange[] = [
			{ path: 'src/changed.ts', status: 'A', additions: 12, deletions: 0, modified: true },
			{ path: 'README.md', status: 'M', additions: 1, deletions: 3, modified: true },
		];
		const gitStatusMap = new Map<string, GitStatusData>([
			[
				'session-1',
				createStatus({
					fileCount: 3,
					branch: 'feature/full-coverage',
					remote: 'git@github.com:RunMaestro/Maestro.git',
					ahead: 5,
					behind: 2,
					fileChanges,
					totalAdditions: 13,
					totalDeletions: 3,
					modifiedCount: 2,
				}),
			],
			['session-2', createStatus({ fileCount: 0, branch: 'main', ahead: 0, behind: 0 })],
		]);
		mocks.useGitStatusPolling.mockReturnValue({
			gitStatusMap,
			refreshGitStatus,
			isLoading: true,
		});

		render(
			<GitStatusProvider
				sessions={sessions}
				activeSessionId="session-1"
				options={{ pollInterval: 1234, pauseWhenHidden: false }}
			>
				<Consumer sessionId="session-1" />
			</GitStatusProvider>
		);

		expect(mocks.useGitStatusPolling).toHaveBeenCalledWith(sessions, {
			pollInterval: 1234,
			pauseWhenHidden: false,
			activeSessionId: 'session-1',
		});
		expect(screen.getByTestId('branch')).toHaveTextContent('feature/full-coverage');
		expect(screen.getByTestId('remote')).toHaveTextContent('git@github.com:RunMaestro/Maestro.git');
		expect(screen.getByTestId('ahead')).toHaveTextContent('5');
		expect(screen.getByTestId('behind')).toHaveTextContent('2');
		expect(screen.getByTestId('file-count')).toHaveTextContent('3');
		expect(screen.getByTestId('has-changes')).toHaveTextContent('true');
		expect(screen.getByTestId('additions')).toHaveTextContent('13');
		expect(screen.getByTestId('deletions')).toHaveTextContent('3');
		expect(screen.getByTestId('modified-count')).toHaveTextContent('2');
		expect(screen.getByTestId('file-change-count')).toHaveTextContent('2');
		expect(screen.getByTestId('legacy-loading')).toHaveTextContent('true');
		expect(screen.getByTestId('legacy-map-size')).toHaveTextContent('2');
		expect(screen.getByTestId('legacy-file-count')).toHaveTextContent('3');
		expect(screen.getByTestId('legacy-missing-file-count')).toHaveTextContent('0');
		expect(screen.getByTestId('legacy-status')).toHaveTextContent('feature/full-coverage');
		expect(screen.getByTestId('missing-file-count')).toHaveTextContent('0');
		expect(screen.getByTestId('missing-has-changes')).toHaveTextContent('false');
		expect(screen.getByTestId('missing-branch')).toHaveTextContent('missing');
		expect(screen.getByTestId('missing-details')).toHaveTextContent('missing');
		expect(screen.getByTestId('missing-status')).toHaveTextContent('missing');

		fireEvent.click(screen.getByRole('button', { name: /refresh detail/i }));
		fireEvent.click(screen.getByRole('button', { name: /refresh legacy/i }));

		expect(refreshGitStatus).toHaveBeenCalledTimes(2);
	});

	it('uses default provider options and returns fallbacks when no status data exists', () => {
		mocks.useGitStatusPolling.mockReturnValue({
			gitStatusMap: new Map(),
			refreshGitStatus: vi.fn().mockResolvedValue(undefined),
			isLoading: false,
		});

		render(
			<GitStatusProvider sessions={sessions}>
				<Consumer sessionId="session-1" />
			</GitStatusProvider>
		);

		expect(mocks.useGitStatusPolling).toHaveBeenCalledWith(sessions, {
			activeSessionId: undefined,
		});
		expect(screen.getByTestId('branch')).toHaveTextContent('missing');
		expect(screen.getByTestId('remote')).toHaveTextContent('missing');
		expect(screen.getByTestId('ahead')).toHaveTextContent('missing');
		expect(screen.getByTestId('behind')).toHaveTextContent('missing');
		expect(screen.getByTestId('file-count')).toHaveTextContent('0');
		expect(screen.getByTestId('has-changes')).toHaveTextContent('false');
		expect(screen.getByTestId('additions')).toHaveTextContent('missing');
		expect(screen.getByTestId('legacy-loading')).toHaveTextContent('false');
		expect(screen.getByTestId('legacy-map-size')).toHaveTextContent('0');
		expect(screen.getByTestId('legacy-file-count')).toHaveTextContent('0');
		expect(screen.getByTestId('legacy-missing-file-count')).toHaveTextContent('0');
		expect(screen.getByTestId('legacy-status')).toHaveTextContent('missing');
	});

	it('requires hooks to be used within GitStatusProvider', () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

		expectHookToRequireProvider(
			useGitBranch,
			'useGitBranch must be used within a GitStatusProvider'
		);
		expectHookToRequireProvider(
			useGitFileStatus,
			'useGitFileStatus must be used within a GitStatusProvider'
		);
		expectHookToRequireProvider(
			useGitDetail,
			'useGitDetail must be used within a GitStatusProvider'
		);
		expectHookToRequireProvider(
			useGitStatus,
			'useGitStatus must be used within a GitStatusProvider'
		);
		expect(consoleError).toHaveBeenCalled();
	});
});
