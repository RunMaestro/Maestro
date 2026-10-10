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

const spawnState = vi.hoisted(() => ({ exitCode: 0, calls: [] as unknown[][] }));
// Never run the real gh: it would start a live device-code login.
vi.mock('../../../cli/services/gh-login', () => ({
	runGhLogin: vi.fn(async (...args: unknown[]) => {
		spawnState.calls.push(args);
		return spawnState.exitCode;
	}),
}));

vi.mock('../../../cli/services/maestro-client', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../cli/services/maestro-client')>()),
	withMaestroClient: vi.fn(),
}));

import {
	feedbackAccounts,
	feedbackAuth,
	feedbackLogin,
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

		it('prints the exact login command when gh is not signed in', async () => {
			mockBridge({
				feedback_check_auth: {
					success: true,
					authenticated: false,
					reason: 'not-authenticated',
					message: 'GitHub CLI (gh) is not signed in to GitHub, so feedback cannot be filed.',
					login: { command: 'gh', args: [], display: 'gh auth login --web' },
				},
			});
			await expect(feedbackAuth({})).rejects.toThrow('__exit__');
			const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
			expect(out).toContain('not signed in');
			expect(out).toContain('gh auth login --web');
			expect(out).toContain('maestro-cli feedback login');
		});

		it('names the refused account and the login that can fix the refusal', async () => {
			mockBridge({
				feedback_check_auth: {
					success: true,
					authenticated: false,
					reason: 'no-repo-access',
					needsGhLogin: true,
					message: 'GitHub refused the request because an organization restricts third-party apps.',
					login: { command: 'gh', args: [], display: 'gh auth login --web' },
					account: { host: 'github.com', login: 'octocat' },
				},
			});
			await expect(feedbackAuth({})).rejects.toThrow('__exit__');
			const out = logSpy.mock.calls.map((c) => String(c[0])).join('\n');
			expect(out).toContain('signed in as octocat @ github.com');
			expect(out).toContain('restricts third-party apps');
			expect(out).toContain('gh auth login --web');
		});

		it('reports the account and login need in --json', async () => {
			mockBridge({
				feedback_check_auth: {
					success: true,
					authenticated: false,
					reason: 'no-repo-access',
					needsGhLogin: false,
					message: 'refused',
					account: { host: 'github.com', login: 'octocat' },
				},
			});
			await expect(feedbackAuth({ json: true })).rejects.toThrow('__exit__');
			const json = JSON.parse(String(logSpy.mock.calls.at(-1)?.[0]));
			expect(json).toMatchObject({
				reason: 'no-repo-access',
				needsGhLogin: false,
				account: { host: 'github.com', login: 'octocat' },
			});
		});

		it('passes --fresh through to skip the cached verdict', async () => {
			const sent = mockBridge({ feedback_check_auth: { success: true, authenticated: true } });
			await feedbackAuth({ fresh: true });
			expect(sent[0].payload).toEqual({ type: 'feedback_check_auth', fresh: true });
		});

		it('maps an old app build to the Unsupported exit code', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(
				new UnsupportedCommandError('feedback_check_auth')
			);
			await expect(feedbackAuth({})).rejects.toThrow('__exit__');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.Unsupported);
		});
	});

	describe('accounts', () => {
		const ready = {
			key: 'claude-code::/home/me/.claude-work',
			toolType: 'claude-code',
			label: 'Claude Code - work',
			env: {},
			sshRemoteId: null,
			agentNames: ['Work'],
			source: 'agent',
			status: 'ready',
		};
		const missing = { ...ready, key: 'codex::/home/me/.codex', status: 'not-installed' };

		it('lists the accounts and marks the one the chat will use', async () => {
			const sent = mockBridge({
				feedback_accounts: { success: true, accounts: [missing, ready], lastWorkingKey: null },
			});
			await feedbackAccounts({ json: true });
			expect(sent[0].payload).toEqual({ type: 'feedback_accounts' });
			expect(sent[0].responseType).toBe('feedback_accounts_result');
			const out = JSON.parse(logSpy.mock.calls[0][0] as string);
			expect(out.pickKey).toBe(ready.key);
		});

		it('sends --use as the remembered account, and --clear as null', async () => {
			const sent = mockBridge({
				feedback_accounts: { success: true, accounts: [ready], lastWorkingKey: ready.key },
			});
			await feedbackAccounts({ use: ready.key });
			await feedbackAccounts({ clear: true });
			expect(sent.map((s) => s.payload.use)).toEqual([ready.key, null]);
		});

		it('exits non-zero when no account can run the chat', async () => {
			mockBridge({
				feedback_accounts: { success: true, accounts: [missing], lastWorkingKey: null },
			});
			await expect(feedbackAccounts({})).rejects.toThrow('__exit__');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		});

		it('rejects --use together with --clear', async () => {
			await expect(feedbackAccounts({ use: 'x', clear: true })).rejects.toThrow('__exit__');
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.InvalidUsage);
		});
	});

	describe('login', () => {
		const login = {
			command: '/opt/homebrew/bin/gh',
			args: ['auth', 'login', '--web'],
			display: '/opt/homebrew/bin/gh auth login --web',
		};

		beforeEach(() => {
			spawnState.calls = [];
			spawnState.exitCode = 0;
		});

		it('runs the app-resolved gh login attached to this terminal, then re-checks fresh', async () => {
			let checks = 0;
			const sent: Sent[] = [];
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({
					sendCommand: vi.fn((payload: Record<string, unknown>, rt: string) => {
						sent.push({ payload, responseType: rt });
						if (payload.type === 'feedback_gh_login_command') {
							return Promise.resolve({ success: true, ...login });
						}
						checks += 1;
						return Promise.resolve({
							success: true,
							authenticated: checks > 1,
							reason: checks > 1 ? undefined : 'not-authenticated',
						});
					}),
				} as never)
			);

			await feedbackLogin({});

			expect(spawnState.calls[0]).toEqual([
				{ command: login.command, args: login.args, display: login.display },
				false,
			]);
			expect(
				sent.filter((s) => s.payload.type === 'feedback_check_auth').every((s) => s.payload.fresh)
			).toBe(true);
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('keeps --json stdout clean by sending gh output to stderr, and fails when still signed out', async () => {
			mockBridge({
				feedback_gh_login_command: { success: true, ...login },
				feedback_check_auth: { success: true, authenticated: false, reason: 'not-authenticated' },
			});
			spawnState.exitCode = 1;

			await expect(feedbackLogin({ json: true })).rejects.toThrow('__exit__');

			expect(spawnState.calls[0][1]).toBe(true);
			const out = JSON.parse(String(logSpy.mock.calls[0][0]));
			expect(out).toMatchObject({ success: false, exitCode: 1, authenticated: false });
			expect(exitSpy).toHaveBeenCalledWith(ExitCode.GeneralError);
		});

		it('refuses when gh is not installed', async () => {
			mockBridge({
				feedback_check_auth: {
					success: true,
					authenticated: false,
					reason: 'not-installed',
					message: 'GitHub CLI (gh) is not installed.',
				},
			});
			await expect(feedbackLogin({})).rejects.toThrow('__exit__');
			expect(spawnState.calls).toHaveLength(0);
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
