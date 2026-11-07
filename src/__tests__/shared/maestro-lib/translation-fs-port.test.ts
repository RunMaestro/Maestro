// @vitest-environment node
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { localTranslationFs } from '../../../shared/maestro-lib/translation/local-fs';
import type { TranslationFs } from '../../../shared/maestro-lib/translation/fs-port';
import { remapTranslationFs } from '../../helpers/translationFs';
import { discoverClaudeMemoryRoot } from '../../../shared/maestro-lib/translation/memory';
import { collectTranslationResources } from '../../../shared/maestro-lib/translation/resources';
import {
	assertTranslationTarget,
	planResourceProjections,
} from '../../../shared/maestro-lib/translation/resource-projections';
import { assertTranslationKnowledgeDirectory } from '../../../shared/maestro-lib/translation/knowledge-binding';
import { translationHash } from '../../../shared/maestro-lib/translation/identity';
import { generateUUID } from '../../../shared/uuid';
import {
	NativeTranslationService,
	type TranslationServiceSession,
} from '../../../shared/maestro-lib/translation/service';
import { TranslationArchive } from '../../../shared/maestro-lib/translation/archive';
import { codexTranslationAdapter } from '../../../shared/maestro-lib/translation/adapters';
import { extractNativeConversation } from '../../../shared/maestro-lib/translation/native-records';
import type { TranslationRpc } from '../../../shared/maestro-lib/translation/types';

afterEach(() => vi.restoreAllMocks());

describe('translation filesystem boundary', () => {
	it('uses native POSIX paths and does not treat literal backslashes as containment separators', async () => {
		const nativeFs: TranslationFs = {
			...localTranslationFs,
			paths: path.posix,
			lstat: vi.fn().mockResolvedValue({ isSymbolicLink: () => true }),
			realpath: vi.fn(async (file) =>
				file === '/remote/root/link' ? '/remote/root\\outside/file' : file
			),
		};
		await expect(
			assertTranslationTarget('/remote/root/link', '/remote/root', nativeFs)
		).rejects.toThrow('escapes');
		expect(nativeFs.lstat).toHaveBeenCalledWith('/remote/root/link');
	});
	it('keeps direct Node filesystem access inside the local port and local archive', async () => {
		const directory = path.resolve('src/shared/maestro-lib/translation');
		const violations: string[] = [];
		for (const name of await fs.readdir(directory, { recursive: true })) {
			if (!name.endsWith('.ts') || ['local-fs.ts', 'archive.ts'].includes(name)) continue;
			const source = ts.createSourceFile(
				name,
				await fs.readFile(path.join(directory, name), 'utf8'),
				ts.ScriptTarget.Latest,
				true
			);
			const visit = (node: ts.Node): void => {
				if (ts.isStringLiteral(node) && /^(?:node:)?fs(?:\/promises)?$/.test(node.text))
					violations.push(
						`${name}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`
					);
				ts.forEachChild(node, visit);
			};
			visit(source);
		}
		expect(violations).toEqual([]);
	});

	it('preserves bytes, modes, links and exclusive ownership with the local port', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-fs-'));
		try {
			const directory = path.join(root, 'nested');
			const file = path.join(directory, 'bytes');
			const link = path.join(directory, 'alias');
			const bytes = Buffer.from([0, 255, 13, 10, 128]);
			await localTranslationFs.mkdir(directory, { recursive: true, mode: 0o700 });
			const onCreated = vi.fn(async () => {
				expect(await fs.readFile(file)).toEqual(Buffer.alloc(0));
			});
			await localTranslationFs.createExclusive(file, bytes, {
				mode: 0o700,
				durable: true,
				onCreated,
			});
			expect(onCreated).toHaveBeenCalledOnce();
			expect(await localTranslationFs.readFile(file)).toEqual(bytes);
			await expect(
				localTranslationFs.createExclusive(file, 'collision', { onCreated })
			).rejects.toMatchObject({ code: 'EEXIST' });
			expect(onCreated).toHaveBeenCalledOnce();
			expect(await fs.readFile(file)).toEqual(bytes);
			await localTranslationFs.atomicWrite(file, Buffer.from('replacement\r\n'), {
				mode: 0o700,
				durable: true,
			});
			expect(await fs.readFile(file, 'utf8')).toBe('replacement\r\n');
			if (process.platform !== 'win32')
				expect((await localTranslationFs.stat(file)).mode & 0o777).toBe(0o700);
			await localTranslationFs.symlink('bytes', link);
			expect((await localTranslationFs.lstat(link)).isSymbolicLink()).toBe(true);
			expect(await localTranslationFs.readlink(link)).toBe('bytes');
			expect(await localTranslationFs.realpath(link)).toBe(await fs.realpath(file));
			expect(await localTranslationFs.readdir(root, { recursive: true })).toEqual(
				expect.arrayContaining([
					'nested',
					path.join('nested', 'bytes'),
					path.join('nested', 'alias'),
				])
			);
			expect(await localTranslationFs.exists(file)).toBe(true);
			await localTranslationFs.unlink(file);
			expect(await localTranslationFs.exists(file)).toBe(false);
			await expect(localTranslationFs.createExclusive(link, 'dangling link')).rejects.toMatchObject(
				{ code: 'EEXIST' }
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('closes the exclusive handle when ownership journaling fails without writing payload bytes', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-fs-failure-'));
		try {
			const file = path.join(root, 'bytes');
			await expect(
				localTranslationFs.createExclusive(file, 'payload', {
					onCreated: async () => {
						throw new Error('journal unavailable');
					},
				})
			).rejects.toThrow('journal unavailable');
			expect(await fs.readFile(file)).toEqual(Buffer.alloc(0));
			await localTranslationFs.unlink(file);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('reads memory, resources and projection conflicts exclusively through the selected port', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-fs-resources-'));
		try {
			const virtualRoot = path.join(root, 'virtual');
			const backingRoot = await fs.realpath(root);
			const { nativeFs, backingPath } = remapTranslationFs(
				virtualRoot,
				path.join(backingRoot, 'native')
			);
			const projectRoot = path.join(virtualRoot, 'project');
			const accountRoot = path.join(virtualRoot, 'account');
			await nativeFs.mkdir(accountRoot, { recursive: true });
			await nativeFs.mkdir(path.join(projectRoot, '.claude'), { recursive: true });
			await nativeFs.mkdir(path.join(projectRoot, 'memory'), { recursive: true });
			await nativeFs.createExclusive(
				path.join(projectRoot, '.claude/settings.json'),
				JSON.stringify({ autoMemoryDirectory: 'memory' })
			);
			await nativeFs.createExclusive(
				path.join(projectRoot, 'memory/MEMORY.md'),
				'Keep these bytes.\r\n'
			);
			await nativeFs.createExclusive(path.join(projectRoot, 'CLAUDE.md'), 'Source instructions');
			const identity = {
				provider: 'claude-code' as const,
				version: '2.1.296',
				projectRoot,
				accountRoot,
			};
			expect(
				await discoverClaudeMemoryRoot(projectRoot, accountRoot, projectRoot, nativeFs)
			).toEqual({ path: path.join(projectRoot, 'memory'), source: 'project' });
			const { artifacts } = await collectTranslationResources(
				identity,
				{ projectKnowledge: true, selectedUserResources: [] },
				undefined,
				nativeFs
			);
			expect(artifacts.find((a) => a.relativePath === 'memory/MEMORY.md')?.bytesBase64).toBe(
				Buffer.from('Keep these bytes.\r\n').toString('base64')
			);
			const destination = { ...identity, provider: 'codex' as const, version: '0.162.1' };
			const projected = await planResourceProjections(
				artifacts,
				destination,
				undefined,
				true,
				nativeFs
			);
			expect(projected.projections).toContainEqual(
				expect.objectContaining({
					path: path.join(projectRoot, 'AGENTS.md'),
					symlinkTarget: 'CLAUDE.md',
				})
			);
			await nativeFs.createExclusive(path.join(projectRoot, 'AGENTS.md'), 'Unrelated instructions');
			expect(
				(await planResourceProjections(artifacts, destination, undefined, true, nativeFs))
					.limitations
			).toContainEqual(expect.objectContaining({ code: 'instruction-conflict' }));
			const external = path.join(backingRoot, 'external');
			await fs.mkdir(external);
			await fs.symlink(
				external,
				backingPath(path.join(projectRoot, 'redirect')),
				process.platform === 'win32' ? 'junction' : 'dir'
			);
			await expect(
				assertTranslationTarget(path.join(projectRoot, 'redirect/new'), projectRoot, nativeFs)
			).rejects.toThrow('symlink');
			await expect(fs.stat(virtualRoot)).rejects.toMatchObject({ code: 'ENOENT' });
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it('uses native lstat for knowledge bindings and propagates transport errors', async () => {
		const root = path.resolve('virtual-provider-knowledge');
		const directory = path.join(root, translationHash('agent'), generateUUID());
		const nativeFs = { ...localTranslationFs, lstat: vi.fn<TranslationFs['lstat']>() };
		nativeFs.lstat.mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
		await expect(
			assertTranslationKnowledgeDirectory(directory, root, nativeFs)
		).resolves.toBeUndefined();
		expect(nativeFs.lstat).toHaveBeenCalledWith(path.dirname(directory));
		expect(nativeFs.lstat).toHaveBeenCalledWith(directory);
		nativeFs.lstat.mockRejectedValue(
			Object.assign(new Error('connection lost'), { code: 'ECONNRESET' })
		);
		await expect(assertTranslationKnowledgeDirectory(directory, root, nativeFs)).rejects.toThrow(
			'connection lost'
		);
	});

	it('threads the service port through source snapshots, planning, staging and source revalidation', async () => {
		const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-fs-service-'));
		try {
			const root = await fs.realpath(temporary);
			const virtualRoot = path.join(root, 'virtual');
			const { nativeFs } = remapTranslationFs(virtualRoot, path.join(root, 'native'));
			const projectRoot = path.join(virtualRoot, 'project');
			const codexRoot = path.join(virtualRoot, 'codex');
			const claudeRoot = path.join(virtualRoot, 'claude');
			const userDataDir = path.join(virtualRoot, 'data');
			await nativeFs.mkdir(projectRoot, { recursive: true });
			await nativeFs.mkdir(codexRoot, { recursive: true });
			await nativeFs.mkdir(claudeRoot, { recursive: true });
			const sourcePath = path.join(codexRoot, 'source.jsonl');
			const bytes = Buffer.from(
				JSON.stringify({
					type: 'response_item',
					payload: {
						type: 'message',
						id: 'message',
						role: 'user',
						content: [{ type: 'input_text', text: 'Exact source text.\r\n' }],
					},
				}) + '\n'
			);
			await nativeFs.createExclusive(sourcePath, bytes);
			let session: TranslationServiceSession = {
				id: 'agent',
				name: 'Synthetic',
				cwd: projectRoot,
				toolType: 'codex',
				aiTabs: [{ id: 'tab', agentSessionId: 'source' }],
			};
			const service = new NativeTranslationService({
				userDataDir,
				nativeFs,
				getSession: () => session,
				persist: async (_id, update) => {
					session = update(session);
				},
				getProvider: async (provider) => ({ path: provider }),
				providerConfig: () => ({
					customEnvVars: { CODEX_HOME: codexRoot, CLAUDE_CONFIG_DIR: claudeRoot },
				}),
				globalEnv: () => ({}),
				isBusy: () => false,
				findCodexSessionFile: async () => sourcePath,
				history: async () => [],
				execGit: async () => ({ exitCode: 128, stdout: '', stderr: 'not a git repository' }),
				execFile: async (binary) => ({
					exitCode: 0,
					stdout: binary === 'codex' ? '0.162.1' : '2.1.296',
					stderr: '',
				}),
				contextWindow: () => 200_000,
			});
			const result = await service.run({
				agentId: session.id,
				destination: 'claude-code',
				action: 'apply',
				acceptLimitations: true,
			});
			expect(result.result?.state).toBe('committed');
			expect(session.toolType).toBe('claude-code');
			const archive = new TranslationArchive(path.join(userDataDir, 'provider-translations'));
			const journal = await archive.read(session.id, result.plan!.id);
			expect(Buffer.from(journal.conversations[0].artifacts[0].bytesBase64, 'base64')).toEqual(
				bytes
			);
			expect(
				nativeFs.readFile.mock.calls.filter(([file]) => file === sourcePath).length
			).toBeGreaterThan(1);
			await expect(fs.readFile(sourcePath)).rejects.toMatchObject({ code: 'ENOENT' });
			await expect(
				nativeFs.readFile(journal.mappings[0].artifacts[0].path)
			).resolves.toBeInstanceOf(Buffer);
			expect(
				nativeFs.readFile.mock.calls.some(([file]) => file.includes('provider-translations'))
			).toBe(false);
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	});

	it('reads Codex RPC imports back through the native port', async () => {
		const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'translation-fs-codex-'));
		try {
			const root = await fs.realpath(temporary);
			const virtualRoot = path.join(root, 'virtual');
			const { nativeFs } = remapTranslationFs(virtualRoot, path.join(root, 'native'));
			const accountRoot = path.join(virtualRoot, 'codex');
			await nativeFs.mkdir(accountRoot, { recursive: true });
			const file = path.join(accountRoot, 'rollout.jsonl');
			const source = {
				provider: 'claude-code' as const,
				version: '2.1.296',
				accountRoot: path.join(virtualRoot, 'claude'),
				projectRoot: path.join(virtualRoot, 'project'),
			};
			const conversation = extractNativeConversation(
				source,
				'tab',
				'source',
				Buffer.from(
					JSON.stringify({
						type: 'user',
						uuid: 'message',
						message: { role: 'user', content: 'Carry this text.' },
					})
				)
			);
			const request: TranslationRpc['request'] = async <T>(
				method: string,
				params?: unknown
			): Promise<T> => {
				if (method === 'thread/start') return { thread: { id: 'destination', path: file } } as T;
				if (method === 'thread/inject_items') {
					const { items } = params as { items: unknown[] };
					await nativeFs.createExclusive(
						file,
						items.map((payload) => JSON.stringify({ type: 'response_item', payload })).join('\n') +
							'\n'
					);
					return {} as T;
				}
				throw new Error(`Unexpected RPC ${method}`);
			};
			const mapping = await codexTranslationAdapter.stage(conversation, {
				operationId: generateUUID(),
				destination: { ...source, provider: 'codex', version: '0.162.1', accountRoot },
				nativeFs,
				codex: { request, onNotification: () => () => {} },
				recordIntent: async () => {},
			});
			expect(mapping.artifacts[0].sha256).toBe(translationHash(await nativeFs.readFile(file)));
			await expect(fs.readFile(file)).rejects.toMatchObject({ code: 'ENOENT' });
		} finally {
			await fs.rm(temporary, { recursive: true, force: true });
		}
	});
});
