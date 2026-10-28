/**
 * @file models-run.test.ts
 * @description Tests for `maestro-cli models run`: the task id and flags are
 * checked before the bridge is opened, the request crosses the WS bridge in the
 * shape the desktop handler expects, and only an `ok` verdict prints text and
 * exits 0. `git-drafts --cwd` takes a repository instead of a prompt and goes
 * to the pull request draft the Create Pull Request form uses.
 */

import path from 'path';
import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import { modelsRun } from '../../../cli/commands/models-run';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import { formatError } from '../../../cli/output/formatter';

function mockSend(reply: Record<string, unknown>) {
	const captured: { payload?: Record<string, unknown>; responseType?: string; timeout?: number } =
		{};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi
				.fn()
				.mockImplementation((payload: Record<string, unknown>, rt: string, timeout?: number) => {
					captured.payload = payload;
					captured.responseType = rt;
					captured.timeout = timeout;
					return Promise.resolve(reply);
				}),
		} as never)
	);
	return captured;
}

const OK = {
	status: 'ok',
	text: 'Fix login timeout',
	source: { type: 'local', modelId: 'qwen3-1.7b-instruct-q4km' },
	durationMs: 420,
};

describe('models run command', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('sends the task and input over the bridge and prints only the text', async () => {
		const captured = mockSend({ success: true, result: OK });

		await modelsRun('tab-naming', { input: 'hi', system: 'Name it.', maxTokens: '32' });

		expect(captured.payload).toEqual({
			type: 'local_models_run_task',
			taskId: 'tab-naming',
			input: { prompt: 'hi', system: 'Name it.', maxTokens: 32 },
		});
		expect(captured.responseType).toBe('local_models_run_task_result');
		expect(captured.timeout).toBeGreaterThan(120_000);
		expect(logSpy).toHaveBeenCalledWith('Fix login timeout');
		expect(exitSpy).not.toHaveBeenCalled();
	});

	it('prints the whole verdict as JSON', async () => {
		mockSend({ success: true, result: OK });

		await modelsRun('tab-naming', { input: 'hi', json: true });

		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
			success: true,
			taskId: 'tab-naming',
			...OK,
		});
	});

	it.each([
		[{ status: 'off' }, /Tab naming is off/, ExitCode.Refused],
		[{ status: 'use-utility-agent' }, /assigned to the Utility Agent/, ExitCode.Refused],
		[
			{
				status: 'unavailable',
				reason: 'Qwen3 1.7B is not downloaded.',
				code: 'model-not-installed',
				source: OK.source,
			},
			/Qwen3 1\.7B is not downloaded\. \[model-not-installed\]/,
			ExitCode.NoAnswer,
		],
		[{ status: 'cancelled', source: OK.source }, /was cancelled/, ExitCode.NoAnswer],
	])('exits non-zero with the reason for %j', async (result, message, code) => {
		mockSend({ success: true, result });

		await expect(modelsRun('tab-naming', { input: 'hi' })).rejects.toThrow('__exit__');

		expect(exitSpy).toHaveBeenCalledWith(code);
		expect(errorSpy.mock.calls[0][0]).toMatch(message);
		expect(logSpy).not.toHaveBeenCalled();
	});

	it('still prints JSON for a non-ok verdict, then exits non-zero', async () => {
		mockSend({ success: true, result: { status: 'off' } });

		await expect(modelsRun('git-drafts', { input: 'diff', json: true })).rejects.toThrow(
			'__exit__'
		);

		expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
			success: false,
			taskId: 'git-drafts',
			status: 'off',
		});
		expect(exitSpy).toHaveBeenCalledWith(ExitCode.Refused);
	});

	it('reports a refused request from the app', async () => {
		mockSend({ success: false, error: 'Task input needs a non-empty prompt.' });

		await expect(modelsRun('tab-naming', { input: 'hi' })).rejects.toThrow('__exit__');

		expect(errorSpy).toHaveBeenCalledWith(formatError('Task input needs a non-empty prompt.'));
	});

	it.each([
		['tab-nameing', { input: 'hi' }, /Unknown task "tab-nameing"/],
		['semantic-search', { input: 'hi' }, /embedding task/],
		['tab-naming', { input: '   ' }, /--input must not be empty/],
		['tab-naming', { input: 'hi', maxTokens: 'lots' }, /--max-tokens/],
	])('refuses %s %j before opening the bridge', async (taskId, options, message) => {
		await expect(modelsRun(taskId, options)).rejects.toThrow('__exit__');

		expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		expect(errorSpy.mock.calls[0][0]).toMatch(message);
		expect(withMaestroClient).not.toHaveBeenCalled();
	});

	describe('git-drafts --cwd', () => {
		const DRAFT = {
			success: true,
			title: 'Add retry with backoff',
			body: 'Retries failed requests.\n\n- Add backoff',
			baseBranch: 'main',
			commitCount: 2,
			truncated: false,
			producedBy: 'Qwen3 1.7B',
		};

		it('sends the resolved repository and target, then prints title, blank line, body', async () => {
			const captured = mockSend({ success: true, result: DRAFT });

			await modelsRun('git-drafts', { cwd: 'some/repo', base: ' main ' });

			expect(captured.payload).toEqual({
				type: 'local_models_git_draft',
				cwd: path.resolve(process.cwd(), 'some/repo'),
				baseBranch: 'main',
			});
			expect(captured.responseType).toBe('local_models_git_draft_result');
			expect(captured.timeout).toBeGreaterThan(120_000);
			expect(logSpy).toHaveBeenCalledWith(
				'Add retry with backoff\n\nRetries failed requests.\n\n- Add backoff'
			);
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('leaves the target to the app when --base is not given', async () => {
			const captured = mockSend({ success: true, result: { ...DRAFT, body: '' } });

			await modelsRun('git-drafts', { cwd: '/abs/repo' });

			expect(captured.payload).toEqual({
				type: 'local_models_git_draft',
				cwd: path.resolve('/abs/repo'),
			});
			expect(logSpy).toHaveBeenCalledWith('Add retry with backoff');
		});

		it('prints the whole result as JSON', async () => {
			mockSend({ success: true, result: DRAFT });

			await modelsRun('git-drafts', { cwd: '/abs/repo', json: true });

			expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
				taskId: 'git-drafts',
				...DRAFT,
			});
		});

		it.each([
			[
				{ success: false, status: 'off', error: 'Git drafts is off.' },
				/Git drafts is off/,
				ExitCode.Refused,
			],
			[
				{ success: false, status: 'unavailable', error: 'Ollama is not reachable.' },
				/Ollama is not reachable/,
				ExitCode.NoAnswer,
			],
			[
				{ success: false, status: 'no-changes', error: 'feat has no commits that main lacks.' },
				/no commits/,
				ExitCode.NoAnswer,
			],
		])('exits non-zero with the reason for %j', async (result, message, code) => {
			mockSend({ success: true, result });

			await expect(modelsRun('git-drafts', { cwd: '/abs/repo' })).rejects.toThrow('__exit__');

			expect(exitSpy).toHaveBeenCalledWith(code);
			expect(errorSpy.mock.calls[0][0]).toMatch(message);
			expect(logSpy).not.toHaveBeenCalled();
		});

		it('still prints JSON for a refusal, then exits non-zero', async () => {
			const refusal = { success: false, status: 'off', error: 'Git drafts is off.' };
			mockSend({ success: true, result: refusal });

			await expect(modelsRun('git-drafts', { cwd: '/abs/repo', json: true })).rejects.toThrow(
				'__exit__'
			);

			expect(JSON.parse(logSpy.mock.calls[0][0] as string)).toEqual({
				taskId: 'git-drafts',
				...refusal,
			});
		});

		it('reports a request the app refused', async () => {
			mockSend({ success: false, error: 'Not a valid branch name: -x' });

			await expect(modelsRun('git-drafts', { cwd: '/abs/repo', base: '-x' })).rejects.toThrow(
				'__exit__'
			);

			expect(errorSpy).toHaveBeenCalledWith(formatError('Not a valid branch name: -x'));
		});

		it.each([
			['tab-naming', { cwd: '/abs/repo' }, /only the git-drafts task/],
			['tab-naming', { input: 'hi', base: 'main' }, /only the git-drafts task/],
			['git-drafts', { base: 'main' }, /--base needs --cwd/],
			['git-drafts', { cwd: '/abs/repo', input: 'hi' }, /does not combine with --input/],
			['git-drafts', { cwd: '/abs/repo', maxTokens: '64' }, /does not combine with --input/],
			['git-drafts', {}, /Pass --cwd <path>/],
		])('refuses %s %j before opening the bridge', async (taskId, options, message) => {
			await expect(modelsRun(taskId, options)).rejects.toThrow('__exit__');

			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
			expect(errorSpy.mock.calls[0][0]).toMatch(message);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('still runs git-drafts as a plain prompt when --input is given', async () => {
			const captured = mockSend({ success: true, result: OK });

			await modelsRun('git-drafts', { input: 'diff' });

			expect(captured.payload).toMatchObject({ type: 'local_models_run_task' });
		});
	});

	describe('dictation --audio', () => {
		const TRANSCRIPT = {
			status: 'ok',
			text: 'ship the fix today',
			audioMs: 2100,
			source: { type: 'local', modelId: 'parakeet-tdt-0.6b-v2' },
			durationMs: 310,
		};

		it('sends the resolved file path over the bridge and prints only the transcript', async () => {
			const captured = mockSend({ success: true, result: TRANSCRIPT });

			await modelsRun('dictation', { audio: 'clips/note.wav' });

			expect(captured.payload).toEqual({
				type: 'local_models_transcribe',
				path: path.resolve('clips/note.wav'),
			});
			expect(captured.responseType).toBe('local_models_transcribe_result');
			expect(logSpy).toHaveBeenCalledWith('ship the fix today');
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('prints the whole result with --json', async () => {
			mockSend({ success: true, result: TRANSCRIPT });
			await modelsRun('dictation', { audio: '/abs/note.wav', json: true });
			expect(JSON.parse(logSpy.mock.calls[0][0])).toMatchObject({
				success: true,
				taskId: 'dictation',
				text: 'ship the fix today',
				audioMs: 2100,
			});
		});

		it('exits non-zero with the reason when the task is off', async () => {
			mockSend({ success: true, result: { status: 'off' } });
			await expect(modelsRun('dictation', { audio: '/abs/note.wav' })).rejects.toThrow('__exit__');
			expect(errorSpy.mock.calls[0][0]).toMatch(/Dictation is off/);
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.Refused);
		});

		it('reports a file the app could not read', async () => {
			mockSend({ success: false, error: 'No such file: /abs/note.wav' });
			await expect(modelsRun('dictation', { audio: '/abs/note.wav' })).rejects.toThrow('__exit__');
			expect(errorSpy.mock.calls[0][0]).toMatch(/No such file/);
		});

		it.each([
			['tab-naming', { audio: '/abs/note.wav' }, /only the dictation task/],
			['dictation', {}, /Pass --audio <file.wav>/],
			['dictation', { input: 'hi' }, /Pass --audio <file.wav>/],
			['dictation', { audio: '/abs/note.wav', input: 'hi' }, /does not combine with --input/],
			['dictation', { audio: '/abs/note.wav', cwd: '/repo' }, /does not combine with --input/],
		] as const)('refuses %s %j before opening the bridge', async (taskId, options, message) => {
			await expect(modelsRun(taskId, { ...options })).rejects.toThrow('__exit__');
			expect(errorSpy.mock.calls[0][0]).toMatch(message);
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});
	});
});
