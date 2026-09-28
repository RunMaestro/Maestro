/**
 * @file feedback.test.ts
 * @description Tests for `maestro-cli feedback auth|search|submit|subscribe`:
 * wire messages, the duplicate gate before filing, category and attachment
 * validation, and exit codes.
 */

import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import {
	feedbackAuth,
	feedbackSearch,
	feedbackSubmit,
	feedbackSubscribe,
	readAttachments,
} from '../../../cli/commands/feedback';
import { UnsupportedCommandError, withMaestroClient } from '../../../cli/services/maestro-client';
import { ExitCode } from '../../../cli/exit-codes';
import { MAX_FEEDBACK_ATTACHMENTS } from '../../../shared/feedback';

type Sent = { payload: Record<string, unknown>; responseType: string; timeout?: number };

/** Answer each sendCommand by message type; record every call. */
function mockBridge(responses: Record<string, Record<string, unknown>>): Sent[] {
	const sent: Sent[] = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi
				.fn()
				.mockImplementation((payload: Record<string, unknown>, rt: string, timeout?: number) => {
					sent.push({ payload, responseType: rt, timeout });
					return Promise.resolve(responses[payload.type as string] ?? { success: true });
				}),
		} as never)
	);
	return sent;
}

const baseSubmit = {
	category: 'bug',
	summary: 'Tabs vanish on restart',
	expected: 'Tabs survive',
	actual: 'Tabs are gone',
};

describe('feedback commands', () => {
	let exitSpy: MockInstance;
	let logSpy: MockInstance;
	let tmpDir: string;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-feedback-cli-'));
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	describe('auth', () => {
		it('succeeds when gh is authenticated', async () => {
			const sent = mockBridge({ feedback_check_auth: { success: true, authenticated: true } });
			await feedbackAuth({});
			expect(sent[0].payload.type).toBe('feedback_check_auth');
			expect(sent[0].responseType).toBe('feedback_check_auth_result');
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('exits non-zero when gh is not ready, so a script can gate on it', async () => {
			mockBridge({
				feedback_check_auth: { success: true, authenticated: false, message: 'not logged in' },
			});
			await expect(feedbackAuth({})).rejects.toThrow('__exit__');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		});

		it('maps an old app build to the Unsupported exit code', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(
				new UnsupportedCommandError('feedback_check_auth')
			);
			await expect(feedbackAuth({})).rejects.toThrow('__exit__');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.Unsupported);
		});
	});

	describe('search', () => {
		it('sends the query and prints matches as JSON', async () => {
			const issues = [{ number: 7, title: 'x', url: 'u', state: 'OPEN', labels: [] }];
			const sent = mockBridge({ feedback_search: { success: true, issues } });
			await feedbackSearch('tabs vanish', { json: true });
			expect(sent[0].payload).toMatchObject({ type: 'feedback_search', query: 'tabs vanish' });
			expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual({ success: true, issues });
		});

		it('rejects an empty query before connecting', async () => {
			const sent = mockBridge({});
			await expect(feedbackSearch('  ', {})).rejects.toThrow('__exit__');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
			expect(sent).toHaveLength(0);
		});
	});

	describe('submit', () => {
		it('searches first and files nothing when duplicates exist', async () => {
			const sent = mockBridge({
				feedback_search: {
					success: true,
					issues: [{ number: 3, title: 'dup', url: 'u', state: 'OPEN', labels: [] }],
				},
			});
			await expect(feedbackSubmit({ ...baseSubmit, json: true })).rejects.toThrow('__exit__');
			expect(sent.map((s) => s.payload.type)).toEqual(['feedback_search']);
			expect(JSON.parse(logSpy.mock.calls[0][0])).toMatchObject({
				success: false,
				error: 'possible_duplicates',
			});
		});

		it('files the structured payload when no duplicates are found', async () => {
			const sent = mockBridge({
				feedback_search: { success: true, issues: [] },
				feedback_submit: { success: true, issueUrl: 'https://github.com/x/1' },
			});
			await feedbackSubmit({ ...baseSubmit, steps: '1. restart', supportPackage: true });
			const submit = sent.find((s) => s.payload.type === 'feedback_submit')!;
			expect(submit.responseType).toBe('feedback_submit_result');
			expect(submit.payload.payload).toMatchObject({
				category: 'bug_report',
				summary: baseSubmit.summary,
				expectedBehavior: baseSubmit.expected,
				actualBehavior: baseSubmit.actual,
				reproductionSteps: '1. restart',
				includeDebugPackage: true,
				attachments: [],
			});
		});

		it('--force skips the duplicate search', async () => {
			const sent = mockBridge({ feedback_submit: { success: true, issueUrl: 'u' } });
			await feedbackSubmit({ ...baseSubmit, force: true });
			expect(sent.map((s) => s.payload.type)).toEqual(['feedback_submit']);
		});

		it('rejects an unknown category before connecting', async () => {
			const sent = mockBridge({});
			await expect(feedbackSubmit({ ...baseSubmit, category: 'rant' })).rejects.toThrow('__exit__');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
			expect(sent).toHaveLength(0);
		});

		it('reports the app-side failure and exits non-zero', async () => {
			mockBridge({ feedback_submit: { success: false, error: 'gh exploded' } });
			await expect(feedbackSubmit({ ...baseSubmit, force: true })).rejects.toThrow('__exit__');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		});
	});

	describe('subscribe', () => {
		it('accepts #123 and sends the number and comment', async () => {
			const sent = mockBridge({ feedback_subscribe: { success: true } });
			await feedbackSubscribe('#123', { comment: 'me too' });
			expect(sent[0].payload).toMatchObject({
				type: 'feedback_subscribe',
				issueNumber: 123,
				comment: 'me too',
			});
		});

		it('rejects a non-number', async () => {
			mockBridge({});
			await expect(feedbackSubscribe('abc', {})).rejects.toThrow('__exit__');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		});
	});

	describe('readAttachments', () => {
		it('encodes a screenshot as a data URL with the exact MIME type', () => {
			const file = path.join(tmpDir, 'shot.jpg');
			fs.writeFileSync(file, Buffer.from([1, 2, 3]));
			const [attachment] = readAttachments([file]);
			expect(attachment.name).toBe('shot.jpg');
			expect(attachment.dataUrl).toBe('data:image/jpeg;base64,AQID');
		});

		it('refuses non-image extensions, missing files, and too many files', () => {
			const txt = path.join(tmpDir, 'notes.txt');
			fs.writeFileSync(txt, 'x');
			expect(() => readAttachments([txt])).toThrow(/PNG, JPG, GIF, or WebP/);
			expect(() => readAttachments([path.join(tmpDir, 'gone.png')])).toThrow(/not found/);
			const many = Array.from({ length: MAX_FEEDBACK_ATTACHMENTS + 1 }, (_, i) => `${i}.png`);
			expect(() => readAttachments(many)).toThrow(/At most/);
		});
	});
});
