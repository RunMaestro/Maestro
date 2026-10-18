/**
 * Tests for the desktop launcher behind Cue's `action: autorun`.
 *
 * A scheduled Auto Run fires with nobody watching, so every way the launch can
 * fail to reach the renderer has to come back as `{ success: false }` rather
 * than as an exception or a silent success: the executor turns this result
 * into the run status that decides whether the schedule is kept.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';

const requestFromRendererMock = vi.fn();
const isWebContentsAvailableMock = vi.fn();

vi.mock('../../main/web-server/callbacks/remoteRequest', () => ({
	requestFromRenderer: (...args: unknown[]) => requestFromRendererMock(...args),
}));
vi.mock('../../main/utils/safe-send', () => ({
	isWebContentsAvailable: (...args: unknown[]) => isWebContentsAvailableMock(...args),
}));
vi.mock('../../main/utils/worktree-setup-script', () => ({
	WORKTREE_SETUP_TIMEOUT_MS: 10 * 60 * 1000,
}));
vi.mock('../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
	CUE_AUTORUN_LAUNCH_TIMEOUT_MS,
	CUE_AUTORUN_WORKTREE_LAUNCH_TIMEOUT_MS,
	launchCueAutoRun,
} from '../../main/cue-autorun-launcher';
import { logger } from '../../main/utils/logger';

const mainWindow = {} as BrowserWindow;
const params = {
	sessionId: 'session-1',
	documents: [{ filename: '/proj/Auto Run Docs/a.md', resetOnCompletion: true }],
	prompt: 'Work the tasks',
	loopEnabled: true,
	maxLoops: 2,
};

describe('launchCueAutoRun', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		isWebContentsAvailableMock.mockReturnValue(true);
		requestFromRendererMock.mockResolvedValue({ success: true });
	});

	it('fails without asking when there is no desktop window', async () => {
		const result = await launchCueAutoRun(null, params);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/desktop window not available/);
		expect(requestFromRendererMock).not.toHaveBeenCalled();
	});

	it('fails without asking when the renderer is gone', async () => {
		isWebContentsAvailableMock.mockReturnValue(false);

		const result = await launchCueAutoRun(mainWindow, params);

		expect(result).toEqual({ success: false, error: 'renderer webContents not available' });
		expect(requestFromRendererMock).not.toHaveBeenCalled();
	});

	it('asks the renderer to launch on the configure-auto-run channel', async () => {
		const result = await launchCueAutoRun(mainWindow, params);

		expect(result).toEqual({ success: true });
		const [win, channel, options] = requestFromRendererMock.mock.calls[0];
		expect(win).toBe(mainWindow);
		expect(channel).toBe('remote:configureAutoRun');
		expect(options.timeoutMs).toBe(CUE_AUTORUN_LAUNCH_TIMEOUT_MS);
		expect(options.args).toEqual([
			'session-1',
			{
				documents: params.documents,
				prompt: 'Work the tasks',
				loopEnabled: true,
				maxLoops: 2,
				launch: true,
			},
		]);
	});

	it('forwards the run options only when they are set', async () => {
		await launchCueAutoRun(mainWindow, {
			...params,
			model: 'opus',
			effort: 'high',
			taskSelectionMode: 'document',
			ignoreModelHints: true,
		});

		expect(requestFromRendererMock.mock.calls[0][2].args[1]).toMatchObject({
			model: 'opus',
			effort: 'high',
			taskSelectionMode: 'document',
			ignoreModelHints: true,
		});
	});

	// The whole request is forwarded, so a run option added to the launch
	// params reaches the renderer without a second list to forget it in.
	it('forwards the worktree target and the auto-resume settings', async () => {
		const worktreeTarget = {
			mode: 'existing-open' as const,
			sessionId: 'wt-child',
			createPROnCompletion: false,
		};

		await launchCueAutoRun(mainWindow, {
			...params,
			worktreeTarget,
			autoResumeOnError: false,
			autoResumeAfterMin: 10,
			maxAutoResumes: 3,
		});

		const [, , options] = requestFromRendererMock.mock.calls[0];
		expect(options.args[0]).toBe('session-1');
		expect(options.args[1]).toMatchObject({
			worktreeTarget,
			autoResumeOnError: false,
			autoResumeAfterMin: 10,
			maxAutoResumes: 3,
			launch: true,
		});
		expect(options.args[1]).not.toHaveProperty('sessionId');
		// An open worktree needs no setup, so the ordinary budget applies.
		expect(options.timeoutMs).toBe(CUE_AUTORUN_LAUNCH_TIMEOUT_MS);
	});

	// The renderer accepts only after `git worktree add` and the setup script
	// finish. Giving up sooner reports a failed launch for a run that then
	// starts anyway, and a failed schedule is kept to be re-triggered.
	it('waits out the setup script when the worktree has to be created', async () => {
		await launchCueAutoRun(mainWindow, {
			...params,
			worktreeTarget: {
				mode: 'create-new',
				newBranchName: 'nightly',
				createPROnCompletion: false,
			},
		});

		expect(requestFromRendererMock.mock.calls[0][2].timeoutMs).toBe(
			CUE_AUTORUN_WORKTREE_LAUNCH_TIMEOUT_MS
		);
		expect(CUE_AUTORUN_WORKTREE_LAUNCH_TIMEOUT_MS).toBeGreaterThan(10 * 60_000);
	});

	it("passes the renderer's own rejection through", async () => {
		requestFromRendererMock.mockResolvedValue({ success: false, error: 'No Auto Run folder' });

		expect(await launchCueAutoRun(mainWindow, params)).toEqual({
			success: false,
			error: 'No Auto Run folder',
		});
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it('treats an empty reply as a failure', async () => {
		await launchCueAutoRun(mainWindow, params);
		const { parse } = requestFromRendererMock.mock.calls[0][2];

		expect(parse(undefined)).toEqual({ success: false, error: 'renderer returned no result' });
		expect(parse({ success: true })).toEqual({ success: true });
	});

	// The fallback is what the round trip resolves with when the renderer never
	// answers, so resolving with it is how a timeout looks from here.
	it('reports a renderer that never answers as a failed launch', async () => {
		requestFromRendererMock.mockImplementation(
			async (_win: unknown, _channel: unknown, options: { fallback: unknown }) => options.fallback
		);

		const result = await launchCueAutoRun(mainWindow, params);

		expect(result.success).toBe(false);
		expect(result.error).toMatch(/did not accept the launch within 30s/);
		expect(logger.warn).toHaveBeenCalled();
	});
});
