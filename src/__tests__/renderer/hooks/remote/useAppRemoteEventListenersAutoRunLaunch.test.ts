/**
 * Covers the launch half of the `maestro:configureAutoRun` listener - the
 * renderer end of `maestro-cli auto-run --launch` and of a scheduled Auto Run
 * fired by Cue.
 *
 * Nobody is at the keyboard for either, so the invariant under test is that a
 * worktree target which cannot be resolved FAILS the launch. Quietly running
 * the documents in the launching agent's own checkout is the one outcome a
 * worktree target exists to prevent.
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { createMockSession } from '../../../helpers/mockSession';
import type { Session } from '../../../../renderer/types';

vi.mock('../../../../renderer/stores/sessionStore', () => ({
	useSessionStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
	selectSessionById: vi.fn(() => () => undefined),
}));
vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
}));
vi.mock('../../../../renderer/hooks/batch/batchUtils', () => ({
	DEFAULT_BATCH_PROMPT: 'default prompt',
}));
vi.mock('../../../../renderer/services/git', () => ({ gitService: {} }));
vi.mock('../../../../renderer/utils/worktreeSpawn', () => ({
	spawnWorktreeAgentAndDispatch: vi.fn(),
}));
vi.mock('../../../../renderer/services/autoRunDispatchTarget', () => ({
	resolveAutoRunDispatchTarget: vi.fn(),
}));
vi.mock('../../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
vi.mock('../../../../renderer/utils/browserTabPersistence', () => ({
	getBrowserTabPartition: () => 'persist:test',
}));
vi.mock('../../../../renderer/utils/ids', () => ({ generateId: () => 'doc-id' }));
vi.mock('../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

import { resolveAutoRunDispatchTarget } from '../../../../renderer/services/autoRunDispatchTarget';

const ack = vi.fn();
const SESSION_ID = 'agent-1';
const FOLDER = '/repo/.maestro/playbooks';

function makeSession(): Session {
	return createMockSession({
		id: SESSION_ID,
		name: 'Worker',
		autoRunFolderPath: FOLDER,
	}) as Session;
}

function setup(startBatchRun: ReturnType<typeof vi.fn>, sessions: Session[] = [makeSession()]) {
	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef: { current: sessions },
			setActiveSessionId: vi.fn(),
			setSessions: vi.fn(),
			setGroups: vi.fn(),
			handleOpenFileTab: vi.fn(),
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh: vi.fn(),
			startBatchRun,
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		} as any)
	);
}

function launch(config: Record<string, unknown> = {}) {
	window.dispatchEvent(
		new CustomEvent('maestro:configureAutoRun', {
			detail: {
				sessionId: SESSION_ID,
				config: {
					documents: [{ filename: `${FOLDER}/ship-it.md` }],
					launch: true,
					...config,
				},
				responseChannel: 'ch',
			},
		})
	);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(resolveAutoRunDispatchTarget).mockResolvedValue({ ok: true, sessionId: SESSION_ID });
	(window as any).maestro = {
		process: { sendRemoteConfigureAutoRunResponse: ack },
		logger: { log: vi.fn() },
	};
});

describe('maestro:configureAutoRun launch', () => {
	it('starts the run in the launching agent when no worktree is named', async () => {
		const startBatchRun = vi.fn(() => Promise.resolve());
		setup(startBatchRun);

		launch();
		await flush();

		expect(ack).toHaveBeenCalledWith('ch', { success: true });
		const [targetId, config, folder] = startBatchRun.mock.calls[0] as unknown as [
			string,
			Record<string, unknown>,
			string,
		];
		expect(targetId).toBe(SESSION_ID);
		expect(folder).toBe(FOLDER);
		expect(config.documents).toEqual([
			{ id: 'doc-id', filename: 'ship-it', resetOnCompletion: false, isDuplicate: false },
		]);
		expect(config.worktreeTarget).toBeUndefined();
	});

	// A scheduled run names its target the way the Auto Run window does, in any
	// of the three modes, and it is handed to the resolver as it arrived.
	it('runs in the agent the worktree target resolves to', async () => {
		vi.mocked(resolveAutoRunDispatchTarget).mockResolvedValue({ ok: true, sessionId: 'wt-child' });
		const startBatchRun = vi.fn(() => Promise.resolve());
		setup(startBatchRun);
		const worktreeTarget = {
			mode: 'existing-open',
			sessionId: 'wt-child',
			createPROnCompletion: false,
		};

		launch({ worktreeTarget });
		await flush();

		const resolved = vi.mocked(resolveAutoRunDispatchTarget).mock.calls[0];
		expect(resolved[0]).toMatchObject({ id: SESSION_ID });
		expect(resolved[1].worktreeTarget).toEqual(worktreeTarget);
		// The documents still come from the launching agent's folder.
		expect(startBatchRun.mock.calls[0]).toEqual([
			'wt-child',
			expect.objectContaining({ worktreeTarget }),
			FOLDER,
		]);
		expect(ack).toHaveBeenCalledWith('ch', { success: true });
	});

	it('fails the launch, and starts nothing, when the worktree target cannot be resolved', async () => {
		vi.mocked(resolveAutoRunDispatchTarget).mockResolvedValue({
			ok: false,
			reason: 'target-missing',
			message: 'worktree agent wt-child no longer exists',
		});
		const startBatchRun = vi.fn(() => Promise.resolve());
		setup(startBatchRun);

		launch({
			worktreeTarget: { mode: 'existing-open', sessionId: 'wt-child', createPROnCompletion: false },
		});
		await flush();

		expect(startBatchRun).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledWith('ch', {
			success: false,
			error: 'worktree agent wt-child no longer exists',
		});
	});

	// The CLI and the web client send the older `worktree` block, which only
	// ever meant "create a new one".
	it('reads the older worktree block as a new worktree', async () => {
		setup(vi.fn(() => Promise.resolve()));

		launch({
			worktree: {
				enabled: true,
				branchName: 'nightly',
				baseBranch: 'rc',
				prTargetBranch: 'main',
				createPROnCompletion: true,
			},
		});
		await flush();

		expect(vi.mocked(resolveAutoRunDispatchTarget).mock.calls[0][1].worktreeTarget).toEqual({
			mode: 'create-new',
			newBranchName: 'nightly',
			baseBranch: 'rc',
			createPROnCompletion: true,
		});
	});

	it('falls back to the PR target, then to main, for the older block base branch', async () => {
		setup(vi.fn(() => Promise.resolve()));

		launch({ worktree: { enabled: true, branchName: 'a', prTargetBranch: 'release' } });
		launch({ worktree: { enabled: true, branchName: 'b' } });
		await flush();

		const bases = vi
			.mocked(resolveAutoRunDispatchTarget)
			.mock.calls.map((call) => call[1].worktreeTarget?.baseBranch);
		expect(bases).toEqual(['release', 'main']);
	});

	it('carries the run options a scheduled run was configured with', async () => {
		const startBatchRun = vi.fn(() => Promise.resolve());
		setup(startBatchRun);

		launch({
			prompt: 'Work the list',
			loopEnabled: true,
			maxLoops: 3,
			model: 'opus',
			effort: 'high',
			taskSelectionMode: 'document',
			ignoreModelHints: true,
			autoResumeOnError: false,
			autoResumeAfterMin: 12,
			maxAutoResumes: 2,
		});
		await flush();

		expect((startBatchRun.mock.calls[0] as unknown[])[1]).toMatchObject({
			prompt: 'Work the list',
			loopEnabled: true,
			maxLoops: 3,
			model: 'opus',
			effort: 'high',
			taskSelectionMode: 'document',
			ignoreModelHints: true,
			autoResumeOnError: false,
			autoResumeAfterMin: 12,
			maxAutoResumes: 2,
		});
	});

	// Absent means the documented default everywhere else, so nothing is
	// written for an option the caller did not choose.
	it('leaves unset options off the run config', async () => {
		const startBatchRun = vi.fn(() => Promise.resolve());
		setup(startBatchRun);

		launch();
		await flush();

		const config = (startBatchRun.mock.calls[0] as unknown[])[1] as Record<string, unknown>;
		expect(config.prompt).toBe('default prompt');
		for (const key of [
			'model',
			'effort',
			'taskSelectionMode',
			'ignoreModelHints',
			'autoResumeOnError',
			'autoResumeAfterMin',
			'maxAutoResumes',
		]) {
			expect(config).not.toHaveProperty(key);
		}
	});
});

// The CLI's `auto-run` and a Cue `autorun` subscription send absolute `.md`
// paths. Every runner reads `${folder}/${filename}.md`, so a saved playbook
// that kept the absolute paths could never run.
describe('maestro:configureAutoRun document names', () => {
	const create = vi.fn();

	beforeEach(() => {
		create.mockResolvedValue({ success: true, playbook: { id: 'pb-1' } });
		(window as any).maestro.playbooks = { create };
	});

	it('saves a playbook with folder-relative names without .md', async () => {
		setup(vi.fn(() => Promise.resolve()));

		launch({
			launch: undefined,
			saveAsPlaybook: 'Nightly',
			documents: [
				{ filename: `${FOLDER}/batch/DOC-01.md` },
				{ filename: `${FOLDER}/batch/DOC-02.md`, resetOnCompletion: true },
			],
		});
		await flush();

		expect(create).toHaveBeenCalledWith(SESSION_ID, {
			name: 'Nightly',
			documents: [
				{ filename: 'batch/DOC-01', resetOnCompletion: false },
				{ filename: 'batch/DOC-02', resetOnCompletion: true },
			],
			loopEnabled: false,
			maxLoops: undefined,
			prompt: '',
		});
		expect(ack).toHaveBeenCalledWith('ch', { success: true, playbookId: 'pb-1', error: undefined });
	});

	it('refuses to save a playbook naming a document outside the Auto Run folder', async () => {
		setup(vi.fn(() => Promise.resolve()));

		launch({
			launch: undefined,
			saveAsPlaybook: 'Nightly',
			documents: [{ filename: `${FOLDER}/ok.md` }, { filename: '/elsewhere/stray.md' }],
		});
		await flush();

		expect(create).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledWith('ch', {
			success: false,
			error: `Document is outside the Auto Run folder (${FOLDER}): /elsewhere/stray.md`,
		});
	});

	it('refuses to launch a document outside the Auto Run folder instead of running its basename', async () => {
		const startBatchRun = vi.fn(() => Promise.resolve());
		setup(startBatchRun);

		launch({ documents: [{ filename: '/elsewhere/ship-it.md' }] });
		await flush();

		expect(startBatchRun).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledWith('ch', {
			success: false,
			error: `Document is outside the Auto Run folder (${FOLDER}): /elsewhere/ship-it.md`,
		});
	});

	it('keeps subfolders when launching', async () => {
		const startBatchRun = vi.fn(() => Promise.resolve());
		setup(startBatchRun);

		launch({ documents: [{ filename: `${FOLDER}/phase/one.md` }] });
		await flush();

		expect(((startBatchRun.mock.calls[0] as unknown[])[1] as any).documents[0].filename).toBe(
			'phase/one'
		);
	});
});
