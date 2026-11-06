// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { ipcMain } from 'electron';
import { registerMemoryHandlers } from '../../../../main/ipc/handlers/memory';
import { logger } from '../../../../main/utils/logger';
import { execGitReadOnly } from '../../../../main/utils/remote-git';
import { runProviderProbe } from '../../../../main/agents/grok-probe';
import { resolveClaudeMemoryPath } from '../../../../shared/maestro-lib/translation/memory';
import { createMockSession } from '../../../helpers/mockSession';

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }));
vi.mock('fs/promises', async (importOriginal) => ({
	...(await importOriginal<typeof import('fs/promises')>()),
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../../main/utils/remote-git', () => ({ execGitReadOnly: vi.fn() }));
vi.mock('../../../../main/agents/grok-probe', () => ({ runProviderProbe: vi.fn() }));
// The handlers resolve the agent from the sessions store (upstream MemoryTarget API).
const { sessionsStore, agentConfigsStore, settingsStore } = vi.hoisted(() => ({
	sessionsStore: { get: vi.fn(), set: vi.fn() },
	agentConfigsStore: { get: vi.fn(), set: vi.fn() },
	settingsStore: { get: vi.fn(), set: vi.fn() },
}));
vi.mock('../../../../main/stores/instances', () => ({ isInitialized: () => true }));
vi.mock('../../../../main/stores/getters', () => ({
	getSessionsStore: () => sessionsStore,
	getAgentConfigsStore: () => agentConfigsStore,
	getSettingsStore: () => settingsStore,
}));

describe('memory IPC selected provider scope', () => {
	const operations: [string, string[]][] = [
		['list', []],
		['read', ['note.md']],
		['write', ['note.md', 'replacement']],
		['create', ['new.md', 'new memory']],
		['delete', ['note.md']],
		['search', ['marker']],
		['orphans', []],
		['getPath', []],
	];
	let root: string;
	let project: string;
	let sessions: ReturnType<typeof createMockSession>[];
	let handlers: Map<string, (...args: never[]) => unknown>;
	const call = (operation: string, args: string[], id: string, cwd = project) =>
		handlers.get(`memory:${operation}`)!(
			{} as never,
			{
				projectPath: cwd,
				toolType: sessions.find((session) => session.id === id)?.toolType ?? id,
				agentId: id,
			} as never,
			...(args as never[])
		) as Promise<Record<string, unknown>>;

	beforeEach(async () => {
		vi.clearAllMocks();
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'maestro-memory-ipc-'));
		project = path.join(root, 'project');
		await fs.mkdir(project);
		sessions = ['a', 'b'].map((account) =>
			createMockSession({
				id: `selected-${account}`,
				toolType: 'grok',
				cwd: project,
				projectRoot: project,
				customEnvVars: { GROK_HOME: path.join(root, `account-${account}`) },
			})
		);
		sessionsStore.get.mockImplementation(() => sessions);
		agentConfigsStore.get.mockImplementation(() => ({}));
		settingsStore.get.mockImplementation((_key: string, fallback?: unknown) => fallback);
		handlers = new Map();
		vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => {
			handlers.set(channel, handler as never);
		});
		registerMemoryHandlers();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await fs.rm(root, { recursive: true, force: true });
	});

	it.each(operations)(
		'refuses native %s for both selected accounts before filesystem/config/probe effects',
		async (operation, args) => {
			const effects = (
				[
					'readdir',
					'readFile',
					'writeFile',
					'mkdir',
					'open',
					'unlink',
					'stat',
					'lstat',
					'realpath',
				] as const
			).map((method) => vi.spyOn(fs, method));
			for (const id of ['selected-a', 'selected-b', 'grok']) {
				await expect(call(operation, args, id)).resolves.toEqual({
					success: false,
					error: expect.stringContaining('Grok native project memory is not supported'),
				});
			}
			await expect(call(operation, args, 'missing-agent')).resolves.toEqual({
				success: false,
				error: expect.stringContaining('not supported for agent "missing-agent"'),
			});
			for (const effect of effects) expect(effect).not.toHaveBeenCalled();
			expect(sessionsStore.set).not.toHaveBeenCalled();
			expect(agentConfigsStore.set).not.toHaveBeenCalled();
			expect(settingsStore.set).not.toHaveBeenCalled();
			expect(runProviderProbe).not.toHaveBeenCalled();
			expect(execGitReadOnly).not.toHaveBeenCalled();
		}
	);

	it.each(['wrong project', 'configured SSH', 'observed SSH'])(
		'rejects %s even with bound knowledge',
		async (scope) => {
			sessions[0].providerTranslationKnowledgeDirectory = path.join(project, 'knowledge-a');
			if (scope === 'configured SSH')
				sessions[0].sessionSshRemoteConfig = { enabled: true, remoteId: 'remote-a' };
			if (scope === 'observed SSH') sessions[0].sshRemoteId = 'remote-a';
			const read = vi.spyOn(fs, 'readFile');
			const write = vi.spyOn(fs, 'writeFile');
			for (const [operation, args] of operations) {
				await expect(
					call(operation, args, sessions[0].id, scope === 'wrong project' ? root : project)
				).resolves.toEqual({
					success: false,
					error:
						scope === 'wrong project'
							? 'Error: Memory scope does not match the selected local agent'
							: 'Error: This agent runs on an SSH remote, and its memory lives on that host',
				});
			}
			expect(read).not.toHaveBeenCalled();
			expect(write).not.toHaveBeenCalled();
		}
	);

	it.each(operations)('redacts returned and logged %s errors', async (operation, args) => {
		sessionsStore.get.mockImplementation(() => {
			throw new Error('password=fixture-private-value');
		});
		const result = await call(operation, args, sessions[0].id);
		expect(result).toEqual({ success: false, error: 'Error: password=[REDACTED_SECRET]' });
		expect(logger.error).toHaveBeenCalledWith(
			expect.stringContaining('[REDACTED_SECRET]'),
			'[IPC:Memory]'
		);
		expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(
			'fixture-private-value'
		);
	});

	it.each(['read', 'write', 'create', 'delete'])(
		'does not echo a secret-bearing %s filename in errors or logs',
		async (operation) => {
			sessions[0].providerTranslationKnowledgeDirectory = path.join(project, 'knowledge-a');
			const filename = 'password=fixture-private-value.txt';
			const result = await call(
				operation,
				[filename, ...(operation === 'write' || operation === 'create' ? ['body'] : [])],
				sessions[0].id
			);
			expect(result).toEqual({
				success: false,
				error: 'Error: Memory filenames must end with .md: password=[REDACTED_SECRET]',
			});
			expect(logger.error).toHaveBeenCalledWith(
				expect.stringContaining('[REDACTED_SECRET]'),
				'[IPC:Memory]'
			);
			expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain(
				'fixture-private-value'
			);
		}
	);

	it('keeps explicitly bound Grok knowledge local to each selected account and rejects an outside-project binding', async () => {
		for (const [index, session] of sessions.entries()) {
			session.providerTranslationKnowledgeDirectory = path.join(project, `knowledge-${index}`);
			const directory = path.join(session.providerTranslationKnowledgeDirectory, 'memory');
			await fs.mkdir(directory, { recursive: true });
			await fs.writeFile(path.join(directory, 'note.md'), `account-${index} marker`);
			await expect(call('getPath', [], session.id)).resolves.toEqual({
				success: true,
				path: directory,
			});
			await expect(call('read', ['note.md'], session.id)).resolves.toEqual({
				success: true,
				content: `account-${index} marker`,
			});
		}
		await expect(call('write', ['note.md', 'updated-a'], sessions[0].id)).resolves.toEqual({
			success: true,
		});
		await expect(call('read', ['note.md'], sessions[1].id)).resolves.toEqual({
			success: true,
			content: 'account-1 marker',
		});
		sessions[0].providerTranslationKnowledgeDirectory = path.join(root, 'outside');
		await expect(call('write', ['note.md', 'escaped'], sessions[0].id)).resolves.toEqual({
			success: false,
			error: 'Error: Unsafe translation target',
		});
	});

	it('resolves Claude native memory from each selected account and preserves unsupported reference providers', async () => {
		vi.mocked(execGitReadOnly).mockResolvedValue({ exitCode: 1, stdout: '', stderr: '' });
		for (const [index, session] of sessions.entries()) {
			session.toolType = 'claude-code';
			const account = path.join(root, `claude-${index}`);
			session.customEnvVars = { CLAUDE_CONFIG_DIR: account };
			const directory = resolveClaudeMemoryPath(project, account);
			await fs.mkdir(directory, { recursive: true });
			await fs.writeFile(path.join(directory, 'note.md'), `claude-${index}`);
			await expect(call('read', ['note.md'], session.id)).resolves.toEqual({
				success: true,
				content: `claude-${index}`,
			});
		}
		for (const provider of ['antigravity'] as const) {
			sessions[0].toolType = provider;
			await expect(call('getPath', [], sessions[0].id)).resolves.toEqual({
				success: false,
				error: `Error: Memory viewer is not supported for agent "${provider}"`,
			});
		}
	});
});
