// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/cli/commands/feedback.test.ts
// Source: src/__tests__/cli/commands/agent-run.test.ts
import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	agentRunAppendEvent,
	agentRunList,
	agentRunRecord,
	agentRunShow,
	campaignList,
	campaignRecord,
	campaignShow,
} from '../../../cli/commands/agent-run';
import {
	appendAgentRunEvent,
	getAgentRun,
	getCampaign,
	listAgentRuns,
	listCampaigns,
	readAgentRunEvents,
	upsertAgentRun,
	upsertCampaign,
} from '../../../cli/services/agent-run-store';
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
vi.mock('../../../cli/services/agent-run-store', () => ({
	appendAgentRunEvent: vi.fn(),
	getAgentRun: vi.fn(),
	getCampaign: vi.fn(),
	listAgentRuns: vi.fn(),
	listCampaigns: vi.fn(),
	readAgentRunEvents: vi.fn(),
	upsertAgentRun: vi.fn(),
	upsertCampaign: vi.fn(),
}));
// Source: src/__tests__/cli/commands/feedback.test.ts
describe('', () => {
	type Sent = {
		payload: Record<string, unknown>;
		responseType: string;
		timeout?: number;
	};
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
						message:
							'GitHub refused the request because an organization restricts third-party apps.',
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
				await expect(feedbackSubmit({ ...baseSubmit, category: 'rant' })).rejects.toThrow(
					'__exit__'
				);
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
});
// Source: src/__tests__/cli/commands/agent-run.test.ts
describe('', () => {
	describe('agent-run command surface', () => {
		let consoleSpy: MockInstance;
		let processExitSpy: MockInstance;
		let tempDir: string;
		beforeEach(() => {
			vi.clearAllMocks();
			consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
			processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
			tempDir = mkdtempSync(join(tmpdir(), 'maestro-agent-run-cli-'));
		});
		afterEach(() => {
			consoleSpy.mockRestore();
			processExitSpy.mockRestore();
			rmSync(tempDir, { recursive: true, force: true });
		});
		function writeJsonFile(name: string, value: unknown): string {
			const filePath = join(tempDir, name);
			writeFileSync(filePath, JSON.stringify(value), 'utf8');
			return filePath;
		}
		it('records a valid agent run from --file and preserves future provider metadata', () => {
			const run = {
				id: 'run-1',
				createdAt: 1714268000000,
				updatedAt: 1714268000000,
				provider: 'future-provider',
				status: 'running',
				artifacts: [],
				touchedFiles: [],
				checks: [],
				reviews: [],
				metadata: { plugin: 'pianola-adapter' },
			};
			const filePath = writeJsonFile('run.json', run);
			vi.mocked(upsertAgentRun).mockReturnValue(run as never);
			agentRunRecord({ file: filePath, json: true });
			expect(upsertAgentRun).toHaveBeenCalledWith(run);
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output).toEqual({ success: true, run });
			expect(processExitSpy).not.toHaveBeenCalled();
		});
		it('returns scriptable JSON for malformed agent run JSON', () => {
			const filePath = join(tempDir, 'bad.json');
			writeFileSync(filePath, '{bad json', 'utf8');
			agentRunRecord({ file: filePath, json: true });
			expect(upsertAgentRun).not.toHaveBeenCalled();
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(false);
			expect(output.code).toBe('INVALID_JSON');
			expect(output.error).toContain('Invalid JSON');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
		it('returns scriptable JSON when the agent run file is missing', () => {
			agentRunRecord({ file: join(tempDir, 'missing.json'), json: true });
			expect(upsertAgentRun).not.toHaveBeenCalled();
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output).toMatchObject({
				success: false,
				code: 'FILE_NOT_FOUND',
			});
			expect(output.error).toContain('File not found');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
		it('rejects agent runs with malformed child evidence instead of dropping it', () => {
			const filePath = writeJsonFile('run-with-bad-check.json', {
				id: 'run-1',
				createdAt: 1714268000000,
				updatedAt: 1714268000000,
				provider: 'claude-code',
				status: 'running',
				artifacts: [],
				touchedFiles: [],
				checks: [{ status: 'passed' }],
				reviews: [],
			});
			agentRunRecord({ file: filePath, json: true });
			expect(upsertAgentRun).not.toHaveBeenCalled();
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output).toMatchObject({ success: false, code: 'INVALID_AGENT_RUN' });
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
		it('appends an event with a status update payload', () => {
			vi.mocked(appendAgentRunEvent).mockImplementation((event) => event as never);
			agentRunAppendEvent('run-1', {
				type: 'status_change',
				status: 'needs_review',
				message: 'Ready for review',
				json: true,
			});
			expect(appendAgentRunEvent).toHaveBeenCalledWith(
				expect.objectContaining({
					runId: 'run-1',
					type: 'status_change',
					status: 'needs_review',
					message: 'Ready for review',
				})
			);
			const event = vi.mocked(appendAgentRunEvent).mock.calls[0][0];
			expect(event.id).toMatch(/^evt_/);
			expect(Number.isFinite(event.timestamp)).toBe(true);
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output.success).toBe(true);
			expect(output.event.status).toBe('needs_review');
		});
		it('passes list filters through to the store', () => {
			vi.mocked(listAgentRuns).mockReturnValue([]);
			agentRunList({ status: 'running', campaign: 'camp-1', limit: '25', json: true });
			expect(listAgentRuns).toHaveBeenCalledWith({
				status: 'running',
				campaignId: 'camp-1',
				limit: 25,
			});
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output).toEqual({ success: true, runs: [] });
		});
		it('returns a missing-run error for show', () => {
			vi.mocked(getAgentRun).mockReturnValue(undefined);
			agentRunShow('missing-run', { json: true });
			expect(readAgentRunEvents).not.toHaveBeenCalled();
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output).toEqual({
				success: false,
				error: 'Agent run not found: missing-run',
				code: 'AGENT_RUN_NOT_FOUND',
			});
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
		it('renders a concise text list output', () => {
			vi.mocked(listAgentRuns).mockReturnValue([
				{
					id: 'run-1',
					createdAt: 1714268000000,
					updatedAt: 1714269000000,
					provider: 'claude-code',
					agentName: 'Reviewer',
					status: 'completed',
					artifacts: [],
					touchedFiles: [],
					checks: [],
					reviews: [],
				},
			] as never);
			agentRunList({});
			expect(consoleSpy.mock.calls[0][0]).toBe('run-1  completed  claude-code  Reviewer');
		});
		it('shows a run plus events as JSON', () => {
			const run = {
				id: 'run-1',
				createdAt: 1714268000000,
				updatedAt: 1714269000000,
				provider: 'codex',
				status: 'running',
				artifacts: [],
				touchedFiles: [],
				checks: [],
				reviews: [],
			};
			const events = [{ id: 'evt-1', runId: 'run-1', timestamp: 1714269000000, type: 'started' }];
			vi.mocked(getAgentRun).mockReturnValue(run as never);
			vi.mocked(readAgentRunEvents).mockReturnValue(events as never);
			agentRunShow('run-1', { json: true });
			expect(readAgentRunEvents).toHaveBeenCalledWith('run-1');
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output).toEqual({ success: true, run, events });
		});
	});
	describe('campaign command surface', () => {
		let consoleSpy: MockInstance;
		let processExitSpy: MockInstance;
		let tempDir: string;
		beforeEach(() => {
			vi.clearAllMocks();
			consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
			processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
			tempDir = mkdtempSync(join(tmpdir(), 'maestro-campaign-cli-'));
		});
		afterEach(() => {
			consoleSpy.mockRestore();
			processExitSpy.mockRestore();
			rmSync(tempDir, { recursive: true, force: true });
		});
		function writeJsonFile(name: string, value: unknown): string {
			const filePath = join(tempDir, name);
			writeFileSync(filePath, JSON.stringify(value), 'utf8');
			return filePath;
		}
		it('records a valid campaign from --file', () => {
			const campaign = {
				id: 'camp-1',
				title: 'Fix parser',
				createdAt: 1714268000000,
				updatedAt: 1714269000000,
				status: 'running',
				runIds: ['run-1'],
				tasks: [],
			};
			const filePath = writeJsonFile('campaign.json', campaign);
			vi.mocked(upsertCampaign).mockReturnValue(campaign as never);
			campaignRecord({ file: filePath, json: true });
			expect(upsertCampaign).toHaveBeenCalledWith(campaign);
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output).toEqual({ success: true, campaign });
		});
		it('rejects campaigns with malformed tasks instead of dropping them', () => {
			const filePath = writeJsonFile('campaign-with-bad-task.json', {
				id: 'camp-1',
				title: 'Fix parser',
				createdAt: 1714268000000,
				updatedAt: 1714269000000,
				status: 'running',
				runIds: ['run-1'],
				tasks: [{ id: 'task-1', title: 'Bad task', status: 'not-real', dependsOn: [] }],
			});
			campaignRecord({ file: filePath, json: true });
			expect(upsertCampaign).not.toHaveBeenCalled();
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output).toMatchObject({ success: false, code: 'INVALID_CAMPAIGN' });
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
		it('passes campaign list filters through to the store', () => {
			vi.mocked(listCampaigns).mockReturnValue([]);
			campaignList({ status: 'needs_review', limit: '5', json: true });
			expect(listCampaigns).toHaveBeenCalledWith({ status: 'needs_review', limit: 5 });
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output).toEqual({ success: true, campaigns: [] });
		});
		it('shows a campaign as JSON', () => {
			const campaign = {
				id: 'camp-1',
				title: 'Fix parser',
				createdAt: 1714268000000,
				updatedAt: 1714269000000,
				status: 'complete',
				runIds: ['run-1'],
				tasks: [],
			};
			vi.mocked(getCampaign).mockReturnValue(campaign as never);
			campaignShow('camp-1', { json: true });
			expect(getCampaign).toHaveBeenCalledWith('camp-1');
			const output = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(output).toEqual({ success: true, campaign });
		});
		it('renders a concise campaign text list output', () => {
			vi.mocked(listCampaigns).mockReturnValue([
				{
					id: 'camp-1',
					title: 'Fix parser',
					createdAt: 1714268000000,
					updatedAt: 1714269000000,
					status: 'running',
					runIds: [],
					tasks: [],
				},
			] as never);
			campaignList({});
			expect(consoleSpy.mock.calls[0][0]).toBe('camp-1  running  Fix parser');
		});
	});
});
