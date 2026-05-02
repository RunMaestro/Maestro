/**
 * Tests for the Cue GitHub poller provider.
 *
 * Tests cover:
 * - gh CLI availability check
 * - Repo auto-detection
 * - PR and issue polling with event emission
 * - Seen-item tracking and first-run seeding
 * - CueEvent payload shapes
 * - Body truncation
 * - Cleanup and timer management
 * - Error handling
 *
 * Note: The poller uses execFile (not exec) to avoid shell injection.
 * The mock here simulates execFile's callback-based API via promisify.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted mock references (vi.hoisted runs before vi.mock hoisting)
const {
	mockExecFile,
	mockIsGitHubItemSeen,
	mockMarkGitHubItemSeen,
	mockHasAnyGitHubSeen,
	mockPruneGitHubSeen,
	mockCaptureException,
} = vi.hoisted(() => ({
	mockExecFile: vi.fn(),
	mockIsGitHubItemSeen: vi.fn<(subId: string, key: string) => boolean>().mockReturnValue(false),
	mockMarkGitHubItemSeen: vi.fn<(subId: string, key: string) => void>(),
	mockHasAnyGitHubSeen: vi.fn<(subId: string) => boolean>().mockReturnValue(true),
	mockPruneGitHubSeen: vi.fn<(olderThanMs: number) => void>(),
	mockCaptureException: vi.fn(),
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: (err: unknown, extra?: unknown) => {
		mockCaptureException(err, extra);
		return Promise.resolve();
	},
}));

// Mock crypto.randomUUID
let uuidCounter = 0;
vi.mock('crypto', () => ({
	randomUUID: vi.fn(() => `test-uuid-${++uuidCounter}`),
}));

// Mock child_process.execFile (safe — no shell injection via execFile)
vi.mock('child_process', () => ({
	default: { execFile: mockExecFile },
	execFile: mockExecFile,
}));

// Mock cliDetection — resolveGhPath returns 'gh', getExpandedEnv returns process.env
vi.mock('../../../main/utils/cliDetection', () => ({
	resolveGhPath: vi.fn().mockResolvedValue('gh'),
	getExpandedEnv: vi.fn().mockReturnValue(process.env),
}));

// Mock cue-db functions
vi.mock('../../../main/cue/cue-db', () => ({
	isGitHubItemSeen: (subId: string, key: string) => mockIsGitHubItemSeen(subId, key),
	markGitHubItemSeen: (subId: string, key: string) => mockMarkGitHubItemSeen(subId, key),
	hasAnyGitHubSeen: (subId: string) => mockHasAnyGitHubSeen(subId),
	pruneGitHubSeen: (olderThanMs: number) => mockPruneGitHubSeen(olderThanMs),
}));

import {
	createCueGitHubPoller,
	isGitHubRateLimitError,
	GITHUB_RATE_LIMIT_MAX_BACKOFF_MS,
	type CueGitHubPollerConfig,
} from '../../../main/cue/cue-github-poller';

// Helper: make mockExecFile (callback-style) resolve/reject
function setupExecFile(responses: Record<string, string>) {
	mockExecFile.mockImplementation(
		(
			cmd: string,
			args: string[],
			_opts: unknown,
			cb: (err: Error | null, stdout: string, stderr: string) => void
		) => {
			const key = `${cmd} ${args.join(' ')}`;
			for (const [pattern, stdout] of Object.entries(responses)) {
				if (key.includes(pattern)) {
					cb(null, stdout, '');
					return;
				}
			}
			cb(new Error(`Command not found: ${key}`), '', '');
		}
	);
}

function setupExecFileReject(pattern: string, errorMsg: string) {
	mockExecFile.mockImplementation(
		(
			cmd: string,
			args: string[],
			_opts: unknown,
			cb: (err: Error | null, stdout: string, stderr: string) => void
		) => {
			const key = `${cmd} ${args.join(' ')}`;
			if (key.includes(pattern)) {
				cb(new Error(errorMsg), '', '');
				return;
			}
			cb(null, '', '');
		}
	);
}

const samplePRs = [
	{
		number: 1,
		title: 'Add feature',
		author: { login: 'alice' },
		url: 'https://github.com/owner/repo/pull/1',
		body: 'Feature description',
		state: 'OPEN',
		isDraft: false,
		labels: [{ name: 'enhancement' }],
		headRefName: 'feature-branch',
		baseRefName: 'main',
		createdAt: '2026-03-01T00:00:00Z',
		updatedAt: '2026-03-02T00:00:00Z',
	},
	{
		number: 2,
		title: 'Fix bug',
		author: { login: 'bob' },
		url: 'https://github.com/owner/repo/pull/2',
		body: 'Bug fix',
		state: 'OPEN',
		isDraft: true,
		labels: [{ name: 'bug' }, { name: 'urgent' }],
		headRefName: 'fix-branch',
		baseRefName: 'main',
		createdAt: '2026-03-01T12:00:00Z',
		updatedAt: '2026-03-02T12:00:00Z',
	},
	{
		number: 3,
		title: 'Docs update',
		author: { login: 'charlie' },
		url: 'https://github.com/owner/repo/pull/3',
		body: null,
		state: 'OPEN',
		isDraft: false,
		labels: [],
		headRefName: 'docs',
		baseRefName: 'main',
		createdAt: '2026-03-02T00:00:00Z',
		updatedAt: '2026-03-03T00:00:00Z',
	},
];

const sampleIssues = [
	{
		number: 10,
		title: 'Bug report',
		author: { login: 'dave' },
		url: 'https://github.com/owner/repo/issues/10',
		body: 'Something is broken',
		state: 'OPEN',
		labels: [{ name: 'bug' }],
		assignees: [{ login: 'alice' }, { login: 'bob' }],
		createdAt: '2026-03-01T00:00:00Z',
		updatedAt: '2026-03-02T00:00:00Z',
	},
	{
		number: 11,
		title: 'Feature request',
		author: { login: 'eve' },
		url: 'https://github.com/owner/repo/issues/11',
		body: 'Please add this',
		state: 'OPEN',
		labels: [],
		assignees: [],
		createdAt: '2026-03-02T00:00:00Z',
		updatedAt: '2026-03-03T00:00:00Z',
	},
];

function makeConfig(overrides: Partial<CueGitHubPollerConfig> = {}): CueGitHubPollerConfig {
	return {
		eventType: 'github.pull_request',
		repo: 'owner/repo',
		pollMinutes: 5,
		projectRoot: '/projects/test',
		onEvent: vi.fn(),
		onLog: vi.fn(),
		triggerName: 'test-trigger',
		subscriptionId: 'session-1:test-sub',
		...overrides,
	};
}

describe('cue-github-poller', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		uuidCounter = 0;
		mockIsGitHubItemSeen.mockReturnValue(false);
		mockHasAnyGitHubSeen.mockReturnValue(true); // not first run by default
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('gh CLI not available — warning logged, no events fired, no crash', async () => {
		const config = makeConfig();
		setupExecFileReject('--version', 'gh not found');

		const cleanup = createCueGitHubPoller(config);

		// Advance past initial 2s delay
		await vi.advanceTimersByTimeAsync(2000);

		expect(config.onLog).toHaveBeenCalledWith(
			'warn',
			expect.stringContaining('GitHub CLI (gh) not found')
		);
		expect(config.onEvent).not.toHaveBeenCalled();

		cleanup();
	});

	it('repo auto-detection — resolves from gh repo view', async () => {
		const config = makeConfig({ repo: undefined });
		setupExecFile({
			'--version': '2.0.0',
			'repo view': 'auto-owner/auto-repo\n',
			'pr list': JSON.stringify(samplePRs),
		});

		const cleanup = createCueGitHubPoller(config);
		await vi.advanceTimersByTimeAsync(2000);

		// Should have auto-detected repo and used it in pr list
		expect(mockExecFile).toHaveBeenCalledWith(
			'gh',
			expect.arrayContaining(['repo', 'view']),
			expect.anything(),
			expect.any(Function)
		);

		cleanup();
	});

	it('repo auto-detection failure — warning logged, poll skipped', async () => {
		const config = makeConfig({ repo: undefined });
		setupExecFile({ '--version': '2.0.0' });
		// repo view will hit the default reject

		const cleanup = createCueGitHubPoller(config);
		await vi.advanceTimersByTimeAsync(2000);

		expect(config.onLog).toHaveBeenCalledWith(
			'warn',
			expect.stringContaining('Could not auto-detect repo')
		);
		expect(config.onEvent).not.toHaveBeenCalled();

		cleanup();
	});

	it('PR polling — new items fire events', async () => {
		const config = makeConfig();
		setupExecFile({
			'--version': '2.0.0',
			'pr list': JSON.stringify(samplePRs),
		});

		const cleanup = createCueGitHubPoller(config);
		await vi.advanceTimersByTimeAsync(2000);

		expect(config.onEvent).toHaveBeenCalledTimes(3);

		cleanup();
	});

	it('PR polling — seen items are skipped', async () => {
		mockIsGitHubItemSeen.mockImplementation(((_subId: string, itemKey: string) => {
			return itemKey === 'pr:owner/repo:2'; // PR #2 already seen
		}) as (subId: string, key: string) => boolean);

		const config = makeConfig();
		setupExecFile({
			'--version': '2.0.0',
			'pr list': JSON.stringify(samplePRs),
		});

		const cleanup = createCueGitHubPoller(config);
		await vi.advanceTimersByTimeAsync(2000);

		expect(config.onEvent).toHaveBeenCalledTimes(2);

		cleanup();
	});

	it('PR polling — marks items as seen with correct keys', async () => {
		const config = makeConfig();
		setupExecFile({
			'--version': '2.0.0',
			'pr list': JSON.stringify(samplePRs),
		});

		const cleanup = createCueGitHubPoller(config);
		await vi.advanceTimersByTimeAsync(2000);

		expect(mockMarkGitHubItemSeen).toHaveBeenCalledWith('session-1:test-sub', 'pr:owner/repo:1');
		expect(mockMarkGitHubItemSeen).toHaveBeenCalledWith('session-1:test-sub', 'pr:owner/repo:2');
		expect(mockMarkGitHubItemSeen).toHaveBeenCalledWith('session-1:test-sub', 'pr:owner/repo:3');

		cleanup();
	});

	it('issue polling — new items fire events with assignees', async () => {
		const config = makeConfig({ eventType: 'github.issue' });
		setupExecFile({
			'--version': '2.0.0',
			'issue list': JSON.stringify(sampleIssues),
		});

		const cleanup = createCueGitHubPoller(config);
		await vi.advanceTimersByTimeAsync(2000);

		expect(config.onEvent).toHaveBeenCalledTimes(2);
		const event = (config.onEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(event.payload.assignees).toBe('alice,bob');

		cleanup();
	});

	it('CueEvent payload shape for PRs', async () => {
		const config = makeConfig();
		setupExecFile({
			'--version': '2.0.0',
			'pr list': JSON.stringify([samplePRs[0]]),
		});

		const cleanup = createCueGitHubPoller(config);
		await vi.advanceTimersByTimeAsync(2000);

		const event = (config.onEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(event.type).toBe('github.pull_request');
		expect(event.triggerName).toBe('test-trigger');
		expect(event.payload).toEqual({
			type: 'pull_request',
			number: 1,
			title: 'Add feature',
			author: 'alice',
			url: 'https://github.com/owner/repo/pull/1',
			body: 'Feature description',
			state: 'open',
			draft: false,
			labels: 'enhancement',
			head_branch: 'feature-branch',
			base_branch: 'main',
			repo: 'owner/repo',
			created_at: '2026-03-01T00:00:00Z',
			updated_at: '2026-03-02T00:00:00Z',
			merged_at: '',
		});

		cleanup();
	});

	it('CueEvent payload shape for issues', async () => {
		const config = makeConfig({ eventType: 'github.issue' });
		setupExecFile({
			'--version': '2.0.0',
			'issue list': JSON.stringify([sampleIssues[0]]),
		});

		const cleanup = createCueGitHubPoller(config);
		await vi.advanceTimersByTimeAsync(2000);

		const event = (config.onEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(event.type).toBe('github.issue');
		expect(event.payload).toEqual({
			type: 'issue',
			number: 10,
			title: 'Bug report',
			author: 'dave',
			url: 'https://github.com/owner/repo/issues/10',
			body: 'Something is broken',
			state: 'open',
			labels: 'bug',
			assignees: 'alice,bob',
			repo: 'owner/repo',
			created_at: '2026-03-01T00:00:00Z',
			updated_at: '2026-03-02T00:00:00Z',
		});

		cleanup();
	});

	it('body truncation — body exceeding 5000 chars is truncated', async () => {
		const longBody = 'x'.repeat(6000);
		const config = makeConfig();
		setupExecFile({
			'--version': '2.0.0',
			'pr list': JSON.stringify([{ ...samplePRs[0], body: longBody }]),
		});

		const cleanup = createCueGitHubPoller(config);
		await vi.advanceTimersByTimeAsync(2000);

		const event = (config.onEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(event.payload.body).toHaveLength(5000);

		cleanup();
	});

	it('first-run seeding — no events on first poll', async () => {
		mockHasAnyGitHubSeen.mockReturnValue(false); // first run

		const config = makeConfig();
		setupExecFile({
			'--version': '2.0.0',
			'pr list': JSON.stringify(samplePRs),
		});

		const cleanup = createCueGitHubPoller(config);
		await vi.advanceTimersByTimeAsync(2000);

		expect(config.onEvent).not.toHaveBeenCalled();
		expect(mockMarkGitHubItemSeen).toHaveBeenCalledTimes(3);
		expect(config.onLog).toHaveBeenCalledWith(
			'info',
			expect.stringContaining('seeded 3 existing pull_request(s)')
		);

		cleanup();
	});

	it('second poll fires events after seeding', async () => {
		// First poll: seeding (no seen records)
		mockHasAnyGitHubSeen.mockReturnValueOnce(false);
		// Second poll: has seen records now
		mockHasAnyGitHubSeen.mockReturnValue(true);

		const newPR = {
			...samplePRs[0],
			number: 99,
			title: 'New PR',
		};

		const config = makeConfig({ pollMinutes: 1 });

		let callCount = 0;
		mockExecFile.mockImplementation(
			(
				cmd: string,
				args: string[],
				_opts: unknown,
				cb: (err: Error | null, stdout: string, stderr: string) => void
			) => {
				const key = `${cmd} ${args.join(' ')}`;
				if (key.includes('--version')) {
					cb(null, '2.0.0', '');
				} else if (key.includes('pr list')) {
					callCount++;
					if (callCount === 1) {
						cb(null, JSON.stringify(samplePRs), '');
					} else {
						cb(null, JSON.stringify([newPR]), '');
					}
				} else {
					cb(new Error('not found'), '', '');
				}
			}
		);

		const cleanup = createCueGitHubPoller(config);

		// First poll at 2s
		await vi.advanceTimersByTimeAsync(2000);
		expect(config.onEvent).not.toHaveBeenCalled(); // seeded

		// Second poll at 2s + 1min
		await vi.advanceTimersByTimeAsync(60000);
		expect(config.onEvent).toHaveBeenCalledTimes(1);

		cleanup();
	});

	it('cleanup stops polling', async () => {
		const config = makeConfig({ pollMinutes: 1 });
		setupExecFile({
			'--version': '2.0.0',
			'pr list': JSON.stringify(samplePRs),
		});

		const cleanup = createCueGitHubPoller(config);

		// First poll
		await vi.advanceTimersByTimeAsync(2000);
		const callCountAfterFirst = (config.onEvent as ReturnType<typeof vi.fn>).mock.calls.length;

		cleanup();

		// Advance past poll interval — no new polls should occur
		await vi.advanceTimersByTimeAsync(600000);
		expect((config.onEvent as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
			callCountAfterFirst
		);
	});

	it('initial poll delay — first poll at 2s, not immediately', async () => {
		const config = makeConfig();
		setupExecFile({
			'--version': '2.0.0',
			'pr list': JSON.stringify(samplePRs),
		});

		createCueGitHubPoller(config);

		// At 0ms, nothing should have happened
		expect(mockExecFile).not.toHaveBeenCalled();

		// At 1999ms, still nothing
		await vi.advanceTimersByTimeAsync(1999);
		expect(mockExecFile).not.toHaveBeenCalled();

		// At 2000ms, poll starts
		await vi.advanceTimersByTimeAsync(1);
		expect(mockExecFile).toHaveBeenCalled();
	});

	it('poll interval — subsequent polls at configured interval', async () => {
		const config = makeConfig({ pollMinutes: 2 });
		let pollCount = 0;
		mockExecFile.mockImplementation(
			(
				cmd: string,
				args: string[],
				_opts: unknown,
				cb: (err: Error | null, stdout: string, stderr: string) => void
			) => {
				const key = `${cmd} ${args.join(' ')}`;
				if (key.includes('--version')) {
					cb(null, '2.0.0', '');
				} else if (key.includes('pr list')) {
					pollCount++;
					cb(null, JSON.stringify([]), '');
				} else {
					cb(new Error('not found'), '', '');
				}
			}
		);

		const cleanup = createCueGitHubPoller(config);

		// Initial poll at 2s
		await vi.advanceTimersByTimeAsync(2000);
		expect(pollCount).toBe(1);

		// Second poll at 2s + 2min
		await vi.advanceTimersByTimeAsync(120000);
		expect(pollCount).toBe(2);

		// Third poll at 2s + 4min
		await vi.advanceTimersByTimeAsync(120000);
		expect(pollCount).toBe(3);

		cleanup();
	});

	it('gh parse error — invalid JSON from gh, error logged, no crash', async () => {
		const config = makeConfig();
		setupExecFile({
			'--version': '2.0.0',
			'pr list': 'not valid json{{{',
		});

		const cleanup = createCueGitHubPoller(config);
		await vi.advanceTimersByTimeAsync(2000);

		expect(config.onLog).toHaveBeenCalledWith('warn', expect.stringContaining('malformed JSON'));
		expect(config.onEvent).not.toHaveBeenCalled();

		cleanup();
	});

	it('stopped during iteration — remaining items skipped', async () => {
		const config = makeConfig();

		// Track onEvent calls to call cleanup mid-iteration
		let cleanupFn: (() => void) | null = null;
		let eventCallCount = 0;
		const originalOnEvent = vi.fn(() => {
			eventCallCount++;
			if (eventCallCount === 1 && cleanupFn) {
				cleanupFn(); // Stop after first event
			}
		});
		config.onEvent = originalOnEvent;

		setupExecFile({
			'--version': '2.0.0',
			'pr list': JSON.stringify(samplePRs),
		});

		cleanupFn = createCueGitHubPoller(config);
		await vi.advanceTimersByTimeAsync(2000);

		// Should have fired 1 event then stopped (remaining 2 skipped)
		expect(eventCallCount).toBe(1);
	});

	describe('first poll error resilience (Fix 3)', () => {
		it('places seed marker when first poll fails', async () => {
			const config = makeConfig();

			// First call (--version) succeeds, but pr list fails
			let callCount = 0;
			mockExecFile.mockImplementation(
				(
					cmd: string,
					args: string[],
					_opts: unknown,
					cb: (err: Error | null, stdout: string, stderr: string) => void
				) => {
					const key = `${cmd} ${args.join(' ')}`;
					if (key.includes('--version')) {
						cb(null, '2.0.0', '');
					} else if (key.includes('pr list')) {
						callCount++;
						cb(new Error('Network timeout'), '', '');
					} else {
						cb(new Error('not found'), '', '');
					}
				}
			);

			const cleanup = createCueGitHubPoller(config);
			await vi.advanceTimersByTimeAsync(2000);

			expect(mockMarkGitHubItemSeen).toHaveBeenCalledWith('session-1:test-sub', '__seed_marker__');
			expect(config.onLog).toHaveBeenCalledWith('info', expect.stringContaining('seed marker set'));

			cleanup();
		});

		it('second poll after first-poll error fires events for new items', async () => {
			const config = makeConfig({ pollMinutes: 1 });

			// First poll: pr list fails
			// Second poll: pr list succeeds
			let prListCallCount = 0;
			mockExecFile.mockImplementation(
				(
					cmd: string,
					args: string[],
					_opts: unknown,
					cb: (err: Error | null, stdout: string, stderr: string) => void
				) => {
					const key = `${cmd} ${args.join(' ')}`;
					if (key.includes('--version')) {
						cb(null, '2.0.0', '');
					} else if (key.includes('pr list')) {
						prListCallCount++;
						if (prListCallCount === 1) {
							cb(new Error('Network timeout'), '', '');
						} else {
							cb(null, JSON.stringify([samplePRs[0]]), '');
						}
					} else {
						cb(new Error('not found'), '', '');
					}
				}
			);

			// After first poll error, seed marker is placed, so hasAnyGitHubSeen returns true
			// This means second poll treats items as NOT first-run and fires events
			mockHasAnyGitHubSeen.mockReturnValue(true);

			const cleanup = createCueGitHubPoller(config);

			// First poll at 2s — fails, seed marker placed
			await vi.advanceTimersByTimeAsync(2000);
			expect(config.onEvent).not.toHaveBeenCalled();

			// Second poll at 2s + 1min — succeeds, fires events
			await vi.advanceTimersByTimeAsync(60000);
			expect(config.onEvent).toHaveBeenCalledTimes(1);
			const event = (config.onEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(event.payload.number).toBe(1);

			cleanup();
		});
	});

	describe('ghState parameter', () => {
		it('passes "closed" state to gh pr list when ghState is "closed"', async () => {
			const config = makeConfig({ ghState: 'closed' });
			setupExecFile({
				'--version': '2.0.0',
				'pr list': JSON.stringify([]),
			});

			const cleanup = createCueGitHubPoller(config);
			await vi.advanceTimersByTimeAsync(2000);

			// Verify the gh command was called with --state closed
			const prListCall = mockExecFile.mock.calls.find((call: unknown[]) =>
				(call[1] as string[]).includes('pr')
			);
			expect(prListCall).toBeDefined();
			const args = prListCall![1] as string[];
			const stateIdx = args.indexOf('--state');
			expect(args[stateIdx + 1]).toBe('closed');

			cleanup();
		});

		it('queries closed PRs and filters by mergedAt when ghState is "merged"', async () => {
			const mergedPRs = [
				{
					number: 10,
					title: 'Merged PR',
					author: { login: 'alice' },
					url: 'https://github.com/owner/repo/pull/10',
					body: 'Already merged',
					state: 'CLOSED',
					isDraft: false,
					labels: [],
					headRefName: 'feature',
					baseRefName: 'main',
					createdAt: '2026-03-01T00:00:00Z',
					updatedAt: '2026-03-02T00:00:00Z',
					mergedAt: '2026-03-02T10:00:00Z',
				},
				{
					number: 11,
					title: 'Closed but not merged',
					author: { login: 'bob' },
					url: 'https://github.com/owner/repo/pull/11',
					body: 'Rejected',
					state: 'CLOSED',
					isDraft: false,
					labels: [],
					headRefName: 'bad-branch',
					baseRefName: 'main',
					createdAt: '2026-03-01T00:00:00Z',
					updatedAt: '2026-03-02T00:00:00Z',
					mergedAt: null,
				},
			];

			const config = makeConfig({ ghState: 'merged' });
			setupExecFile({
				'--version': '2.0.0',
				'pr list': JSON.stringify(mergedPRs),
			});

			const cleanup = createCueGitHubPoller(config);
			await vi.advanceTimersByTimeAsync(2000);

			// Should only fire for the merged PR (number 10), not the closed one (number 11)
			expect(config.onEvent).toHaveBeenCalledTimes(1);
			const firedEvent = (config.onEvent as ReturnType<typeof vi.fn>).mock.calls[0][0];
			expect(firedEvent.payload.number).toBe(10);
			expect(firedEvent.payload.state).toBe('merged');
			expect(firedEvent.payload.merged_at).toBe('2026-03-02T10:00:00Z');

			cleanup();
		});

		it('passes "all" state to gh issue list when ghState is "all"', async () => {
			const config = makeConfig({ eventType: 'github.issue', ghState: 'all' });
			setupExecFile({
				'--version': '2.0.0',
				'issue list': JSON.stringify([]),
			});

			const cleanup = createCueGitHubPoller(config);
			await vi.advanceTimersByTimeAsync(2000);

			const issueListCall = mockExecFile.mock.calls.find((call: unknown[]) =>
				(call[1] as string[]).includes('issue')
			);
			expect(issueListCall).toBeDefined();
			const args = issueListCall![1] as string[];
			const stateIdx = args.indexOf('--state');
			expect(args[stateIdx + 1]).toBe('all');

			cleanup();
		});

		it('defaults to "open" state when ghState is not specified', async () => {
			const config = makeConfig(); // no ghState
			setupExecFile({
				'--version': '2.0.0',
				'pr list': JSON.stringify([]),
			});

			const cleanup = createCueGitHubPoller(config);
			await vi.advanceTimersByTimeAsync(2000);

			const prListCall = mockExecFile.mock.calls.find((call: unknown[]) =>
				(call[1] as string[]).includes('pr')
			);
			expect(prListCall).toBeDefined();
			const args = prListCall![1] as string[];
			const stateIdx = args.indexOf('--state');
			expect(args[stateIdx + 1]).toBe('open');

			cleanup();
		});
	});

	// ─── Phase 12C: rate-limit detection + backoff ─────────────────────────
	describe('rate limit detection (isGitHubRateLimitError)', () => {
		it('matches primary rate limit', () => {
			expect(isGitHubRateLimitError(new Error('API rate limit exceeded'))).toBe(true);
		});
		it('matches secondary rate limit', () => {
			expect(isGitHubRateLimitError(new Error('You have exceeded a secondary rate limit'))).toBe(
				true
			);
		});
		it('matches HTTP 403', () => {
			const err = Object.assign(new Error('fail'), {
				stderr: 'gh: HTTP 403: Forbidden (rate limited)',
			});
			expect(isGitHubRateLimitError(err)).toBe(true);
		});
		it('matches HTTP 429', () => {
			const err = Object.assign(new Error('fail'), { stderr: 'HTTP 429: Too Many Requests' });
			expect(isGitHubRateLimitError(err)).toBe(true);
		});
		it('is case insensitive', () => {
			expect(isGitHubRateLimitError(new Error('API RATE LIMIT EXCEEDED'))).toBe(true);
		});
		it('does NOT match generic network errors', () => {
			expect(isGitHubRateLimitError(new Error('ENOTFOUND api.github.com'))).toBe(false);
		});
		it('handles null/undefined safely', () => {
			expect(isGitHubRateLimitError(null)).toBe(false);
			expect(isGitHubRateLimitError(undefined)).toBe(false);
		});
	});

	// ─── Phase 12C + 13A: backoff + Sentry behavior ────────────────────────
	describe('rate-limit backoff and Sentry reporting', () => {
		it('emits rateLimitBackoff payload on rate-limit error without Sentry', async () => {
			const config = makeConfig();
			setupExecFileReject('pr list', 'API rate limit exceeded');
			mockExecFile.mockImplementationOnce((_c, _a, _o, cb) => cb(null, '2.0.0', ''));
			// (chain) first execFile is --version (ok) but subsequent calls (pr list)
			// match the reject pattern. Fall through to setupExecFileReject.

			const cleanup = createCueGitHubPoller(config);
			await vi.advanceTimersByTimeAsync(2100);

			const backoffLog = (config.onLog as ReturnType<typeof vi.fn>).mock.calls.find(
				(c) => c[2] && (c[2] as { type?: string }).type === 'rateLimitBackoff'
			);
			expect(backoffLog).toBeDefined();
			expect((backoffLog?.[2] as { backoffMs: number }).backoffMs).toBeGreaterThan(5 * 60 * 1000);
			// Rate limits are NOT reported to Sentry
			expect(mockCaptureException).not.toHaveBeenCalled();

			cleanup();
		});

		it('reports non-rate-limit errors to Sentry with cue:github:doPoll tag', async () => {
			const config = makeConfig();
			setupExecFileReject('pr list', 'ENOTFOUND api.github.com');
			mockExecFile.mockImplementationOnce((_c, _a, _o, cb) => cb(null, '2.0.0', ''));

			const cleanup = createCueGitHubPoller(config);
			await vi.advanceTimersByTimeAsync(2100);

			const sentryCalls = mockCaptureException.mock.calls.filter(
				(c) => (c[1] as { operation: string }).operation === 'cue:github:doPoll'
			);
			expect(sentryCalls.length).toBeGreaterThan(0);

			cleanup();
		});

		it('caps the backoff at GITHUB_RATE_LIMIT_MAX_BACKOFF_MS across many rate-limit hits', async () => {
			// Sanity check: constant is 1 hour.
			expect(GITHUB_RATE_LIMIT_MAX_BACKOFF_MS).toBe(60 * 60 * 1000);
			const config = makeConfig();
			let call = 0;
			mockExecFile.mockImplementation((_c, args, _o, cb) => {
				call++;
				if ((args as string[]).includes('--version')) return cb(null, '2.0.0', '');
				if ((args as string[]).includes('repo') && (args as string[]).includes('view'))
					return cb(null, 'owner/repo', '');
				return cb(new Error('secondary rate limit'), '', '');
			});

			const cleanup = createCueGitHubPoller(config);
			// Many successive rate-limited cycles — advance by a huge amount each time.
			for (let i = 0; i < 25; i++) {
				await vi.advanceTimersByTimeAsync(GITHUB_RATE_LIMIT_MAX_BACKOFF_MS + 5000);
			}

			const backoffLogs = (config.onLog as ReturnType<typeof vi.fn>).mock.calls.filter(
				(c) => c[2] && (c[2] as { type?: string }).type === 'rateLimitBackoff'
			);
			const lastBackoff = backoffLogs.at(-1)?.[2] as { backoffMs: number } | undefined;
			expect(lastBackoff?.backoffMs).toBe(GITHUB_RATE_LIMIT_MAX_BACKOFF_MS);
			// Silences unused warning
			expect(call).toBeGreaterThan(0);
			cleanup();
		});

		it('Sentry-reports seed marker failure when markGitHubItemSeen throws during first-run poll failure', async () => {
			mockHasAnyGitHubSeen.mockReturnValue(false); // first-run path
			mockMarkGitHubItemSeen.mockImplementation(() => {
				throw new Error('db not ready');
			});
			const config = makeConfig();
			setupExecFileReject('pr list', 'ECONNRESET');
			mockExecFile.mockImplementationOnce((_c, _a, _o, cb) => cb(null, '2.0.0', ''));

			const cleanup = createCueGitHubPoller(config);
			await vi.advanceTimersByTimeAsync(2100);

			const seedSentry = mockCaptureException.mock.calls.find(
				(c) => (c[1] as { operation: string }).operation === 'cue:github:seedMarker'
			);
			expect(seedSentry).toBeDefined();

			cleanup();
		});
	});

	// PR-B 1.4: visibility-aware pause
	describe('isActive gate', () => {
		it('skips the gh fetch when isActive returns false', async () => {
			let active = false;
			const config = makeConfig({ isActive: () => active });
			setupExecFile({
				'--version': '2.0.0',
				'pr list': JSON.stringify(samplePRs),
			});

			const cleanup = createCueGitHubPoller(config);
			await vi.advanceTimersByTimeAsync(2000);

			// gh CLI was never invoked because doPoll short-circuited
			expect(mockExecFile).not.toHaveBeenCalled();
			expect(config.onEvent).not.toHaveBeenCalled();

			cleanup();
		});

		it('resumes polling on the next interval when isActive flips back to true', async () => {
			let active = false;
			const config = makeConfig({ isActive: () => active });
			setupExecFile({
				'--version': '2.0.0',
				'pr list': JSON.stringify(samplePRs),
			});

			const cleanup = createCueGitHubPoller(config);

			// Initial poll attempt while inactive — no gh call.
			await vi.advanceTimersByTimeAsync(2100);
			expect(mockExecFile).not.toHaveBeenCalled();

			// Activate, then advance past the configured poll interval.
			active = true;
			await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

			expect(mockExecFile).toHaveBeenCalled();

			cleanup();
		});

		it('defaults to always-active when isActive is omitted', async () => {
			const config = makeConfig();
			setupExecFile({
				'--version': '2.0.0',
				'pr list': JSON.stringify(samplePRs),
			});

			const cleanup = createCueGitHubPoller(config);
			await vi.advanceTimersByTimeAsync(2100);

			expect(mockExecFile).toHaveBeenCalled();

			cleanup();
		});
	});
});
