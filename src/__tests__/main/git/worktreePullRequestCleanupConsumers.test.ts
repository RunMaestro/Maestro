import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as path from 'path';
import * as fs from 'fs/promises';
vi.mock('fs/promises', async (importOriginal) => ({
	...(await importOriginal<typeof import('fs/promises')>()),
	realpath: vi.fn(),
}));
vi.mock('../../../main/stores/getters', () => ({ getSessionsStore: vi.fn() }));
vi.mock('../../../main/utils/remote-git', () => ({ execGit: vi.fn() }));
vi.mock('../../../shared/cli-activity', () => ({ isSessionBusyWithCli: vi.fn() }));
import { getSessionsStore } from '../../../main/stores/getters';
import type { StoredSession } from '../../../main/stores/types';
import { execGit } from '../../../main/utils/remote-git';
import { isSessionBusyWithCli } from '../../../shared/cli-activity';
import { trackHeadlessAgentActivity } from '../../../main/utils/headless-agent-activity';
import {
	beginRemoteSync,
	__resetBranchSwitchGuardForTests,
	type WorkTreeProcess,
} from '../../../main/utils/branch-switch-guard';
import { inspectWorktreeCleanupConsumers } from '../../../main/git/worktreePullRequestCleanupConsumers';

const root = path.resolve('cleanup-fixture');
const elsewhere = path.resolve('other-fixture');
const repository = { host: 'github.com', owner: 'owner', name: 'repo' };
const request = {
	sessionId: 'child',
	worktreePath: root,
	target: {
		identity: { repository, number: 1 },
		headRepository: repository,
		headBranch: 'feature',
		headSha: 'a'.repeat(40),
		baseBranch: 'rc',
	},
};
let sessions: StoredSession[];
let processes: WorkTreeProcess[];
const source = { getAll: () => processes };
const deps = { getProcessManager: vi.fn(() => source as typeof source | null) };

beforeEach(() => {
	vi.resetAllMocks();
	__resetBranchSwitchGuardForTests();
	sessions = [
		{
			id: 'child',
			name: 'Child',
			toolType: 'codex',
			cwd: root,
			projectRoot: root,
			state: 'idle',
			aiTabs: [],
			executionQueue: [],
		},
	];
	processes = [];
	deps.getProcessManager.mockReturnValue(source);
	vi.mocked(getSessionsStore).mockReturnValue({ get: () => sessions } as never);
	vi.mocked(fs.realpath).mockImplementation(async (value) => String(value));
	vi.mocked(execGit).mockResolvedValue({ exitCode: 0, stdout: root, stderr: '' });
	vi.mocked(isSessionBusyWithCli).mockReturnValue(false);
});
afterEach(() => {
	__resetBranchSwitchGuardForTests();
	vi.restoreAllMocks();
});

describe('advisory native cleanup consumers', () => {
	it('never proves absence from persisted idle and an empty process table', async () => {
		expect(await inspectWorktreeCleanupConsumers(request, deps)).toEqual([
			{ code: 'unknown', message: expect.stringContaining('lack shared exclusion') },
		]);
	});
	it.each([undefined, null])('blocks an unavailable process manager %s', async (manager) => {
		const result = await inspectWorktreeCleanupConsumers(
			request,
			manager === undefined ? {} : { getProcessManager: () => manager }
		);
		expect(result).toMatchObject([{ code: 'active-consumer' }]);
	});
	it('blocks a throwing native inventory', async () => {
		deps.getProcessManager.mockImplementation(() => {
			throw new Error('offline');
		});
		expect(await inspectWorktreeCleanupConsumers(request, deps)).toMatchObject([
			{ code: 'active-consumer' },
		]);
	});
	it.each([
		'aiTabs',
		'filePreviewTabs',
		'browserTabs',
		'terminalTabs',
		'unifiedTabOrder',
		'executionQueue',
	])('refuses registered %s even while idle', async (key) => {
		sessions[0][key] =
			key === 'filePreviewTabs'
				? [{ id: 'tab', path: path.join(root, 'note.md') }]
				: [{ id: 'tab' }];
		expect(await inspectWorktreeCleanupConsumers(request, deps)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ code: 'active-consumer', message: expect.stringContaining(key) }),
			])
		);
	});
	it.each([true, false])('includes terminal=%s processes under the target', async (isTerminal) => {
		processes.push({
			sessionId: 'unregistered-shell',
			cwd: path.join(root, 'nested'),
			projectPath: elsewhere,
			isTerminal,
		});
		expect(await inspectWorktreeCleanupConsumers(request, deps)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: 'active-consumer',
					message: expect.stringContaining('native AI or terminal'),
				}),
			])
		);
	});
	it('uses projectPath as well as cwd and process ownership', async () => {
		processes.push(
			{ sessionId: 'other', cwd: elsewhere, projectPath: root, isTerminal: true },
			{ sessionId: 'child-terminal-tab', cwd: elsewhere, isTerminal: true }
		);
		const result = await inspectWorktreeCleanupConsumers(request, deps);
		expect(result.filter((b) => b.message.includes('native AI or terminal'))).toHaveLength(2);
	});
	it.each(['descendant', 'overlap'])(
		'refuses %s registration with no running process',
		async (kind) => {
			sessions.push({
				...sessions[0],
				id: 'other',
				cwd: kind === 'overlap' ? root : elsewhere,
				projectRoot: elsewhere,
				parentSessionId: kind === 'descendant' ? 'child' : undefined,
			});
			expect(await inspectWorktreeCleanupConsumers(request, deps)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: 'active-consumer',
						message: expect.stringContaining('Another registered agent'),
					}),
				])
			);
		}
	);
	it('detects a different agent file tab through a path alias', async () => {
		const alias = path.join(elsewhere, 'alias.md');
		sessions.push({
			...sessions[0],
			id: 'other',
			cwd: elsewhere,
			projectRoot: elsewhere,
			filePreviewTabs: [{ path: alias }],
		});
		vi.mocked(fs.realpath).mockImplementation(async (value) =>
			String(value) === alias ? path.join(root, 'note.md') : String(value)
		);
		expect(await inspectWorktreeCleanupConsumers(request, deps)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					code: 'active-consumer',
					message: expect.stringContaining('open file tab'),
				}),
			])
		);
	});
	it('does not confuse a sibling prefix or an unrelated SSH process with the checkout', async () => {
		processes.push(
			{ sessionId: 'other', cwd: `${root}-sibling`, isTerminal: true },
			{ sessionId: 'remote', cwd: root, isTerminal: true, sshRemoteId: 'ssh' }
		);
		expect((await inspectWorktreeCleanupConsumers(request, deps)).map((b) => b.code)).toEqual([
			'unknown',
		]);
	});
	it('reuses the native in-flight push/pull guard', async () => {
		const release = await beginRemoteSync('push', root);
		try {
			expect(await inspectWorktreeCleanupConsumers(request, deps)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: 'mutation-busy',
						message: expect.stringContaining('git push'),
					}),
				])
			);
		} finally {
			release();
		}
	});
	it.each(['headless', 'cli'])('includes known %s work', async (kind) => {
		const release = kind === 'headless' ? trackHeadlessAgentActivity('child') : () => {};
		vi.mocked(isSessionBusyWithCli).mockReturnValue(kind === 'cli');
		try {
			expect(await inspectWorktreeCleanupConsumers(request, deps)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: 'active-consumer',
						message: expect.stringContaining('Headless or CLI'),
					}),
				])
			);
		} finally {
			release();
		}
	});
	it.each(['process', 'moved-process', 'headless', 'tab', 'registration'])(
		'detects a new %s during asynchronous inspection',
		async (kind) => {
			if (kind === 'moved-process')
				processes.push({ sessionId: 'moving', cwd: elsewhere, isTerminal: true });
			vi.mocked(fs.realpath).mockImplementationOnce(async (value) => {
				if (kind === 'process') processes.push({ sessionId: 'late', cwd: root, isTerminal: true });
				else if (kind === 'moved-process') processes[0].cwd = root;
				else if (kind === 'headless') trackHeadlessAgentActivity('child')();
				else if (kind === 'tab') sessions[0].aiTabs.push({ id: 'late' });
				else sessions.push({ ...sessions[0], id: 'late' });
				return String(value);
			});
			expect(await inspectWorktreeCleanupConsumers(request, deps)).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						code: 'mutation-busy',
						message: expect.stringContaining('changed during inspection'),
					}),
				])
			);
		}
	);
	it('re-resolves the native manager after inspection', async () => {
		vi.mocked(execGit).mockImplementationOnce(async () => {
			deps.getProcessManager.mockReturnValue(null);
			return { exitCode: 0, stdout: root, stderr: '' };
		});
		expect(await inspectWorktreeCleanupConsumers(request, deps)).toMatchObject([
			{ code: 'active-consumer' },
		]);
	});
	it.each(['duplicate', 'tabs', 'path', 'processes'])(
		'blocks malformed %s evidence',
		async (kind) => {
			if (kind === 'duplicate') sessions.push({ ...sessions[0] });
			else if (kind === 'tabs') sessions[0].terminalTabs = {};
			else if (kind === 'path') vi.mocked(fs.realpath).mockRejectedValue(new Error('missing'));
			else processes = null as never;
			expect(await inspectWorktreeCleanupConsumers(request, deps)).toEqual(
				expect.arrayContaining([expect.objectContaining({ code: 'active-consumer' })])
			);
		}
	);
	it('rejects SSH before reading local native evidence', async () => {
		expect(
			await inspectWorktreeCleanupConsumers({ ...request, sshRemoteId: 'ssh' }, deps)
		).toMatchObject([{ code: 'ssh-unsupported' }]);
		expect(getSessionsStore).not.toHaveBeenCalled();
		expect(fs.realpath).not.toHaveBeenCalled();
	});
});
