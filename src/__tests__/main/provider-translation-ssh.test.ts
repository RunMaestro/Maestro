// @vitest-environment node
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockSession } from '../helpers/mockSession';
import { remapTranslationFs } from '../helpers/translationFs';
import { createSshTranslationFs } from '../../main/provider-translation-fs';
import { resolveSshTranslationHost } from '../../main/provider-translation-ssh';
import { execGitReadOnly, execShellRemote } from '../../main/utils/remote-git';
import { execFileNoThrow } from '../../main/utils/execFile';
import { wrapSpawnWithSsh } from '../../main/utils/ssh-spawn-wrapper';
import { collectTranslationResources } from '../../shared/maestro-lib/translation/resources';
import type { TranslationServiceHost } from '../../shared/maestro-lib/translation/service';
import type { SshRemoteConfig } from '../../shared/types';
import { openCodexTranslationConnection } from '../../shared/maestro-lib/codex/connection';
import { stopProcess } from '../../shared/maestro-lib/control/termination';
import { readCodexThreadItems } from '../../shared/maestro-lib/translation/codex-import';
import { createTranslationRegistry } from '../../shared/maestro-lib/translation/adapters';
import { extractNativeConversation } from '../../shared/maestro-lib/translation/native-records';
import { planTranslation } from '../../shared/maestro-lib/translation/registry';
import {
	TranslationArchive,
	type TranslationJournal,
} from '../../shared/maestro-lib/translation/archive';
import {
	applyTranslation,
	recoverTranslation,
} from '../../shared/maestro-lib/translation/transaction';

vi.mock('node:child_process', async (importOriginal) => ({
	...(await importOriginal<typeof import('node:child_process')>()),
	spawn: vi.fn(),
}));
vi.mock('../../shared/maestro-lib/control/termination', () => ({ stopProcess: vi.fn() }));

vi.mock('../../main/provider-translation-fs', () => ({ createSshTranslationFs: vi.fn() }));
vi.mock('../../main/utils/remote-git', () => ({
	execGitReadOnly: vi.fn(),
	execShellRemote: vi.fn(),
}));
vi.mock('../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));
vi.mock('../../main/utils/ssh-spawn-wrapper', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../main/utils/ssh-spawn-wrapper')>()),
	wrapSpawnWithSsh: vi.fn(),
}));

describe('remote translation identity', () => {
	const remote: SshRemoteConfig = {
		id: 'remote',
		name: 'Remote',
		host: 'example.invalid',
		port: 22,
		username: 'tester',
		privateKeyPath: '',
		enabled: true,
	};
	const store = { getSshRemotes: () => [remote] };
	const session = createMockSession({
		id: 'ssh-agent',
		toolType: 'claude-code',
		cwd: '/remote/worktree',
		projectRoot: '/remote/worktree',
		sessionSshRemoteConfig: { enabled: true, remoteId: remote.id },
		customPath: '~/bin/custom claude',
		customArgs: '--setting "with spaces"',
		customEnvVars: { CLAUDE_CONFIG_DIR: '~/account', USER_OVERRIDE: 'yes' },
	});
	let root: string;
	let port: ReturnType<typeof remapTranslationFs>;
	const providers: Pick<TranslationServiceHost, 'getProvider' | 'providerConfig' | 'globalEnv'> = {
		getProvider: vi.fn(async (provider) => ({
			path: '/local/never-run',
			binaryName: provider === 'codex' ? 'codex' : 'claude',
			defaultEnvVars: { DEFAULT_FLAG: '1' },
		})),
		providerConfig: () => ({
			customEnvVars: { PROVIDER_ONLY: 'yes' },
			customArgs: '--provider-flag',
		}),
		globalEnv: () => ({ GLOBAL_FLAG: 'yes' }),
	};
	beforeEach(async () => {
		vi.clearAllMocks();
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-ssh-identity-'));
		port = remapTranslationFs('/remote', root);
		port.nativeFs.paths = path.posix;
		for (const directory of [
			'worktree/.claude',
			'account',
			'repo/.git',
			'home',
			'codex',
			'home/memory',
		])
			await fs.mkdir(path.join(root, directory), { recursive: true });
		port.nativeFs.realpath.mockImplementation(async (file) => {
			if (file === '~') return '/remote/home';
			await fs.stat(port.backingPath(file));
			return file;
		});
		vi.mocked(createSshTranslationFs).mockReturnValue(port.nativeFs);
		vi.mocked(execShellRemote).mockResolvedValue({
			exitCode: 0,
			stdout: '/remote/home\0/remote/account\0/remote/codex\0',
			stderr: '',
		});
		vi.mocked(execFileNoThrow).mockResolvedValue({
			exitCode: 0,
			stdout: 'claude 2.1.296',
			stderr: '',
		});
		vi.mocked(execGitReadOnly).mockResolvedValue({
			exitCode: 0,
			stdout: '/remote/repo/.git\n',
			stderr: '',
		});
		vi.mocked(wrapSpawnWithSsh).mockResolvedValue({
			command: 'ssh',
			args: ['remote', 'probe'],
			cwd: '/local/home',
			sshRemoteUsed: remote,
		});
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it('uses remote account, worktree git identity, memory and custom invocation without local env inheritance', async () => {
		await fs.writeFile(
			path.join(root, 'account/settings.json'),
			JSON.stringify({ autoMemoryDirectory: '~/memory' })
		);
		const host = (await resolveSshTranslationHost(session, store, providers))!;
		const identity = await host.resolveIdentity!(session, 'claude-code', true);
		expect(identity).toMatchObject({
			accountRoot: '/remote/account',
			projectRoot: '/remote/worktree',
			memoryProjectRoot: '/remote/repo',
			remoteHome: '/remote/home',
		});
		expect(identity.userResourceRoots).toContainEqual({
			path: '/remote/home/memory',
			kind: 'memory',
		});
		expect(identity.remoteHost).toMatch(/^[0-9a-f]{64}$/);
		expect(execGitReadOnly).toHaveBeenCalledWith(
			['rev-parse', '--git-common-dir'],
			'',
			remote,
			'/remote/worktree'
		);
		expect(wrapSpawnWithSsh).toHaveBeenCalledWith(
			expect.objectContaining({
				command: '/remote/home/bin/custom claude',
				agentBinaryName: '/remote/home/bin/custom claude',
				args: ['--version', '--setting', 'with spaces'],
				customEnvVars: {
					GLOBAL_FLAG: 'yes',
					DEFAULT_FLAG: '1',
					CLAUDE_CONFIG_DIR: '~/account',
					USER_OVERRIDE: 'yes',
				},
			}),
			session.sessionSshRemoteConfig,
			expect.anything()
		);
		expect(execFileNoThrow).toHaveBeenCalledWith('ssh', ['remote', 'probe'], '/local/home', {
			timeout: 30_000,
		});
	});

	it('uses remote HOME for unset accounts and project memory tilde overrides', async () => {
		vi.mocked(execShellRemote).mockResolvedValue({
			exitCode: 0,
			stdout: '/remote/home\0\0\0',
			stderr: '',
		});
		await fs.writeFile(
			path.join(root, 'worktree/.claude/settings.json'),
			JSON.stringify({ autoMemoryDirectory: '~/memory' })
		);
		await fs.writeFile(path.join(root, 'home/memory/fact.md'), 'Remote fact');
		const host = (await resolveSshTranslationHost(session, store, providers))!;
		const identity = await host.resolveIdentity!(session, 'claude-code', true);
		expect(identity.accountRoot).toBe('/remote/home/.claude');
		const resources = await collectTranslationResources(
			identity,
			{ projectKnowledge: true, selectedUserResources: [] },
			undefined,
			port.nativeFs
		);
		expect(
			resources.artifacts
				.find((artifact) => artifact.relativePath === 'memory/fact.md')
				?.sourcePath.replaceAll('\\', '/')
		).toBe('/remote/home/memory/fact.md');
	});

	it('uses the destination binary name and account instead of source overrides', async () => {
		vi.mocked(execFileNoThrow).mockResolvedValue({
			exitCode: 0,
			stdout: 'codex 0.162.1',
			stderr: '',
		});
		const host = (await resolveSshTranslationHost(session, store, providers))!;
		const identity = await host.resolveIdentity!(session, 'codex', false);
		expect(identity.accountRoot).toBe('/remote/codex');
		expect(wrapSpawnWithSsh).toHaveBeenCalledWith(
			expect.objectContaining({
				command: 'codex',
				args: ['--version', '--provider-flag'],
				customEnvVars: { GLOBAL_FLAG: 'yes', DEFAULT_FLAG: '1', PROVIDER_ONLY: 'yes' },
			}),
			expect.anything(),
			expect.anything()
		);
		await expect(host.assertCanApply!(identity)).resolves.toBeUndefined();
		expect(port.nativeFs.createExclusive).not.toHaveBeenCalled();
	});

	it('refuses managed knowledge on another SSH host or home before mutation', async () => {
		const host = (await resolveSshTranslationHost(session, store, providers))!;
		const identity = await host.resolveIdentity!(session, 'codex', false);
		await expect(host.assertCanApply!({ ...identity, remoteHost: 'f'.repeat(64) })).rejects.toThrow(
			'different SSH host'
		);
		await expect(
			host.assertCanApply!({ ...identity, remoteHome: '/remote/account' })
		).rejects.toThrow('different SSH home');
		expect(port.nativeFs.mkdir).not.toHaveBeenCalled();
		expect(port.nativeFs.createExclusive).not.toHaveBeenCalled();
	});

	describe('Codex import over SSH stdio', () => {
		let child: ChildProcessWithoutNullStreams;
		let stdout: PassThrough;
		let connection: Awaited<ReturnType<typeof openCodexTranslationConnection>> | undefined;
		let frames: Array<{ id?: number; method: string; params?: any }>;
		let items: unknown[];
		let dropAfterInject: boolean;
		let codexHome: string;
		const rollout = '/remote/codex/sessions/import.jsonl';

		beforeEach(() => {
			connection = undefined;
			frames = [];
			items = [];
			dropAfterInject = false;
			codexHome = '/remote/codex';
			stdout = new PassThrough();
			child = Object.assign(new EventEmitter(), {
				stdin: new PassThrough(),
				stdout,
				stderr: new PassThrough(),
			}) as unknown as ChildProcessWithoutNullStreams;
			vi.mocked(spawn).mockReturnValue(child);
			vi.mocked(execFileNoThrow).mockResolvedValue({
				exitCode: 0,
				stdout: 'codex 0.162.1',
				stderr: '',
			});
			child.stdin.on('data', (chunk: Buffer) => {
				const frame = JSON.parse(chunk.toString('utf8'));
				frames.push(frame);
				if (frame.id === undefined) return;
				void (async () => {
					let result: unknown;
					switch (frame.method) {
						case 'initialize':
							result = { codexHome };
							break;
						case 'thread/start':
							await fs.mkdir(path.dirname(port.backingPath(rollout)), { recursive: true });
							await fs.writeFile(port.backingPath(rollout), '');
							result = { thread: { id: 'remote-thread', path: rollout } };
							break;
						case 'thread/inject_items':
							items = frame.params.items;
							await fs.writeFile(
								port.backingPath(rollout),
								items
									.map((payload) => JSON.stringify({ type: 'response_item', payload }))
									.join('\n') + '\n'
							);
							if (dropAfterInject) {
								child.stdout.emit('end');
								return;
							}
							result = {};
							break;
						case 'thread/items/list':
							result = { data: items, nextCursor: null };
							break;
						default:
							throw new Error(`Unexpected RPC: ${frame.method}`);
					}
					// Split inside a UTF-8 character when present, otherwise inside the JSON frame.
					const response = Buffer.from(JSON.stringify({ id: frame.id, result }) + '\n');
					const unicode = response.indexOf(Buffer.from('🦜'));
					const split = unicode < 0 ? 5 : unicode + 1;
					stdout.write(response.subarray(0, split));
					stdout.write(response.subarray(split));
				})().catch((error) => child.emit('error', error));
			});
		});

		afterEach(() => {
			connection?.close();
			vi.unstubAllEnvs();
		});

		it('keeps the default local connection invocation unchanged', async () => {
			connection = await openCodexTranslationConnection({
				binary: '/local/bin/codex',
				cwd: '/local/project',
				env: { CODEX_HOME: codexHome },
			});
			expect(spawn).toHaveBeenCalledExactlyOnceWith('/local/bin/codex', ['app-server'], {
				cwd: '/local/project',
				env: { CODEX_HOME: codexHome },
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true,
			});
		});

		it('pins the destination account and uses the remote custom invocation without local env leakage', async () => {
			vi.stubEnv('CODEX_HOME', '/local/wrong-account');
			vi.stubEnv('LOCAL_ONLY_SECRET', 'must-not-cross');
			vi.spyOn(providers, 'providerConfig').mockReturnValue({
				customPath: '~/bin/custom codex',
				customArgs: '-c "name=with spaces"',
				customEnvVars: { CODEX_HOME: '/ignored/unpinned', PROVIDER_ONLY: 'yes' },
			});
			const host = (await resolveSshTranslationHost(session, store, providers))!;
			const destination = await host.resolveIdentity!(session, 'codex', false);
			vi.mocked(wrapSpawnWithSsh).mockClear();
			connection = await host.openCodexConnection!(destination);
			expect(wrapSpawnWithSsh).toHaveBeenCalledWith(
				{
					command: '/remote/home/bin/custom codex',
					agentBinaryName: '/remote/home/bin/custom codex',
					args: ['app-server', '-c', 'name=with spaces'],
					cwd: '/remote/worktree',
					customEnvVars: {
						GLOBAL_FLAG: 'yes',
						DEFAULT_FLAG: '1',
						PROVIDER_ONLY: 'yes',
						CODEX_HOME: '/remote/codex',
					},
				},
				session.sessionSshRemoteConfig,
				expect.anything()
			);
			expect(spawn).toHaveBeenCalledExactlyOnceWith('ssh', ['remote', 'probe'], {
				cwd: '/local/home',
				stdio: ['pipe', 'pipe', 'pipe'],
				windowsHide: true,
			});
			expect(frames.map((frame) => frame.method)).toEqual(['initialize', 'initialized']);
		});

		it.each([false, true])(
			'imports and reads remote bytes, with dropped connection = %s',
			async (drop) => {
				const host = (await resolveSshTranslationHost(session, store, providers))!;
				const destination = await host.resolveIdentity!(session, 'codex', false);
				connection = await host.openCodexConnection!(destination);
				const source = {
					...destination,
					provider: 'claude-code' as const,
					version: '2.1.296',
					accountRoot: '/remote/account',
				};
				const conversation = extractNativeConversation(
					source,
					'tab',
					'source-id',
					Buffer.from(
						JSON.stringify({
							type: 'user',
							uuid: 'user-1',
							message: { role: 'user', content: 'Synthetic remote fact 🦜' },
						})
					)
				);
				const registry = createTranslationRegistry();
				const plan = planTranslation({
					agentId: session.id,
					source,
					destination,
					conversations: [conversation],
					registry,
					scope: { projectKnowledge: true, selectedUserResources: [] },
				});
				expect(plan.status).toBe('ready');
				const journal: TranslationJournal = {
					schemaVersion: 1,
					plan,
					state: 'planned',
					conversations: [conversation],
					resources: [],
					mappings: [],
					resourceWrites: [],
				};
				const archive = new TranslationArchive(path.join(root, 'local-archive'));
				const transactionHost = {
					nativeFs: host.nativeFs,
					knowledgeRoot: '/remote/knowledge',
					codex: connection,
					assertSourceUnchanged: vi.fn(async () => {}),
					setMigration: vi.fn(async () => {}),
					commit: vi.fn(async () => {}),
					isCommitted: vi.fn(async () => false),
				};
				dropAfterInject = drop;
				const result = await applyTranslation(archive, registry, journal, transactionHost, true);
				const durable = await archive.read(session.id, plan.id);
				expect(durable.mappings[0]).toMatchObject({
					destinationSessionId: 'remote-thread',
					artifacts: [{ path: rollout, cleanup: 'retain' }],
				});
				expect(await fs.readFile(port.backingPath(rollout), 'utf8')).toContain(
					'Synthetic remote fact'
				);
				expect(
					port.nativeFs.readFile.mock.calls.every(([file]) => file.startsWith('/remote/'))
				).toBe(true);
				if (drop) {
					expect(result.state).toBe('failed');
					expect(result.error).toContain('stdout ended');
					expect(transactionHost.commit).not.toHaveBeenCalled();
					await expect(recoverTranslation(archive, durable, transactionHost)).rejects.toThrow(
						'Incomplete native staging'
					);
					expect((await recoverTranslation(archive, durable, transactionHost, true)).state).toBe(
						'rolled-back'
					);
					// Codex owns its rollout/index pair. Rollback retains the uncertain native import.
					expect(port.nativeFs.lstat).toHaveBeenCalledWith(rollout);
					expect(port.nativeFs.unlink).not.toHaveBeenCalledWith(rollout);
					expect(await fs.readFile(port.backingPath(rollout), 'utf8')).toContain(
						'Synthetic remote fact'
					);
				} else {
					expect(result.state).toBe('committed');
					expect(port.nativeFs.readFile).toHaveBeenCalledWith(rollout);
					expect(await readCodexThreadItems(connection, 'remote-thread')).toEqual(items);
					expect(transactionHost.commit).toHaveBeenCalledOnce();
				}
				expect(frames.filter((frame) => frame.method === 'thread/start')).toHaveLength(1);
				expect(frames.filter((frame) => frame.method === 'thread/inject_items')).toHaveLength(1);
			}
		);

		it('rejects a different remote account and closes the child', async () => {
			const host = (await resolveSshTranslationHost(session, store, providers))!;
			const destination = await host.resolveIdentity!(session, 'codex', false);
			codexHome = '/remote/wrong-account';
			await expect(host.openCodexConnection!(destination)).rejects.toThrow(
				'different account root'
			);
			expect(stopProcess).toHaveBeenCalledWith({ child }, { from: 'terminate', graceMs: 1000 });
			expect(frames.map((frame) => frame.method)).toEqual(['initialize']);
		});

		it.each(['stdin', 'stdout', 'stderr', 'exit', 'close'] as const)(
			'refuses later RPCs after %s fails',
			async (event) => {
				const host = (await resolveSshTranslationHost(session, store, providers))!;
				const destination = await host.resolveIdentity!(session, 'codex', false);
				connection = await host.openCodexConnection!(destination);
				if (event === 'stdin' || event === 'stdout' || event === 'stderr')
					child[event].emit('error', new Error('synthetic failure'));
				else child.emit(event, 255);
				await expect(connection.request('thread/start')).rejects.toThrow('Codex app-server');
				expect(frames.map((frame) => frame.method)).toEqual(['initialize', 'initialized']);
			}
		);

		it('refuses unresolved wrapping, stdin scripts and a changed host without spawning locally', async () => {
			const host = (await resolveSshTranslationHost(session, store, providers))!;
			const destination = await host.resolveIdentity!(session, 'codex', false);
			await expect(
				host.openCodexConnection!({ ...destination, remoteHost: 'another-host' })
			).rejects.toThrow('does not match');
			vi.mocked(wrapSpawnWithSsh).mockResolvedValueOnce({
				command: 'codex',
				args: ['app-server'],
				cwd: '/remote/worktree',
				sshRemoteUsed: null,
			});
			await expect(host.openCodexConnection!(destination)).rejects.toThrow('could not be resolved');
			vi.mocked(wrapSpawnWithSsh).mockResolvedValueOnce({
				command: 'ssh',
				args: [],
				cwd: '/local/home',
				sshRemoteUsed: remote,
				sshStdinScript: 'bootstrap',
			});
			await expect(host.openCodexConnection!(destination)).rejects.toThrow('SSH stdio channel');
			expect(spawn).not.toHaveBeenCalled();
		});
	});

	it('finds Codex rollouts through the selected native port and propagates failed discovery', async () => {
		const directory = path.join(root, 'codex/sessions/2026/10/17');
		await fs.mkdir(directory, { recursive: true });
		await fs.writeFile(
			path.join(directory, 'rollout.jsonl'),
			JSON.stringify({ payload: { id: 'native-id' } }) + '\n'
		);
		const host = (await resolveSshTranslationHost(session, store, providers))!;
		expect(await host.findCodexSessionFile('native-id', '/remote/codex')).toBe(
			'/remote/codex/sessions/2026/10/17/rollout.jsonl'
		);
		port.nativeFs.readdir.mockRejectedValueOnce(new Error('SSH connection lost'));
		await expect(host.findCodexSessionFile('native-id', '/remote/codex')).rejects.toThrow(
			'SSH connection lost'
		);
	});

	it('resolves the pre-spawn SSH setting and the stored SSH identity, and leaves local agents local', async () => {
		expect(
			await resolveSshTranslationHost(
				{ ...session, sessionSshRemoteConfig: undefined, sshRemoteId: remote.id },
				store,
				providers
			)
		).toBeDefined();
		expect(
			await resolveSshTranslationHost(
				{ ...session, sessionSshRemoteConfig: undefined, sshRemoteId: undefined },
				store,
				providers
			)
		).toBeUndefined();
	});

	it.each(['base64', 'realpath or readlink -f'])(
		'names a missing remote prerequisite: %s',
		async (piece) => {
			vi.mocked(execShellRemote).mockResolvedValue({
				exitCode: 127,
				stdout: '',
				stderr: `SSH translation requires ${piece}`,
			});
			const host = (await resolveSshTranslationHost(session, store, providers))!;
			await expect(host.resolveIdentity!(session, 'codex', false)).rejects.toThrow(piece);
			expect(execFileNoThrow).not.toHaveBeenCalled();
			expect(port.nativeFs.realpath).not.toHaveBeenCalled();
		}
	);

	it('names a missing provider binary and rejects a wrapper that falls back locally', async () => {
		const host = (await resolveSshTranslationHost(session, store, providers))!;
		vi.mocked(execFileNoThrow).mockResolvedValueOnce({
			exitCode: 127,
			stdout: '',
			stderr: 'command not found',
		});
		await expect(host.resolveIdentity!(session, 'codex', false)).rejects.toThrow(
			'working codex binary'
		);
		vi.mocked(execFileNoThrow).mockClear();
		vi.mocked(wrapSpawnWithSsh).mockResolvedValueOnce({
			command: '/local/never-run',
			args: [],
			cwd: '/remote',
			sshRemoteUsed: null,
		});
		await expect(host.resolveIdentity!(session, 'codex', false)).rejects.toThrow(
			'could not be resolved'
		);
		expect(execFileNoThrow).not.toHaveBeenCalled();
	});

	it.each([{ remotes: [] }, { remotes: [{ ...remote, enabled: false }] }])(
		'rejects unresolved targets before probing providers or files',
		async ({ remotes }) => {
			await expect(
				resolveSshTranslationHost(session, { getSshRemotes: () => remotes }, providers)
			).rejects.toThrow('could not be resolved');
			expect(providers.getProvider).not.toHaveBeenCalled();
			expect(createSshTranslationFs).not.toHaveBeenCalled();
			expect(execShellRemote).not.toHaveBeenCalled();
		}
	);
});
