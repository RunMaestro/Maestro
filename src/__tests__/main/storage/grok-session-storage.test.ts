import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Mocks (must be declared before imports)
// ============================================================================

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

vi.mock('../../../main/utils/remote-fs', () => ({
	readFileRemote: vi.fn(),
	readDirRemote: vi.fn(),
	statRemote: vi.fn(),
	observePathRemote: vi.fn(),
}));

// The command-boundary cases use real remote-fs with an inert SSH transport.
vi.mock('../../../main/ssh-remote-manager', () => ({
	holdRemoteAccess: vi.fn().mockResolvedValue(null),
	remoteAccessRefusal: vi.fn(),
	sshRemoteManager: { buildSshArgs: vi.fn() },
}));
vi.mock('../../../main/utils/cliDetection', () => ({
	resolveSshPath: vi.fn().mockResolvedValue('ssh-fixture'),
}));
vi.mock('../../../main/utils/execFile', () => ({ execFileNoThrow: vi.fn() }));

vi.mock('fs/promises', async () => ({
	default: {
		constants: (await vi.importActual<typeof import('fs/promises')>('fs/promises')).constants,
		open: vi.fn(),
		readFile: vi.fn(),
		readdir: vi.fn(),
		stat: vi.fn(),
		lstat: vi.fn(),
		realpath: vi.fn(),
		writeFile: vi.fn(),
		appendFile: vi.fn(),
		rename: vi.fn(),
		unlink: vi.fn(),
		rm: vi.fn(),
		mkdir: vi.fn(),
	},
}));

// ============================================================================
// Imports (after mocks)
// ============================================================================

import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import {
	GrokSessionStorage,
	parseGrokPromptContext,
	parseGrokUsageFile,
} from '../../../main/storage/grok-session-storage';
import * as remoteFs from '../../../main/utils/remote-fs';
import { captureException } from '../../../main/utils/sentry';
import { logger } from '../../../main/utils/logger';
import { execFileNoThrow } from '../../../main/utils/execFile';
import { REMOTE_SESSION_READ_CONCURRENCY } from '../../../main/utils/concurrency';
import type { SshRemoteConfig } from '../../../shared/types';
import { isolateAgentEnv } from '../../helpers/agentEnvIsolation';
import { nativeAccountRef } from '../../../shared/agentAccountDir';
import type { SessionReadOptions } from '../../../main/agents/session-storage';

isolateAgentEnv(['GROK_HOME']);

// ============================================================================
// Fixtures
//
// Record shapes are derived from real captured Grok CLI sessions (see the
// Phase 02 research notes); paths and content are synthesized so nothing
// private lands in the repo.
// ============================================================================

const SESSIONS_DIR = path.join(os.homedir(), '.grok', 'sessions');
const PROJECT = '/Users/test/my-project';
const OTHER_PROJECT = '/Users/test/other-project';
const SESSION_ID = '019f0000-aaaa-7000-8000-000000000001';

const sshConfig: SshRemoteConfig = {
	id: 'r1',
	name: 'r1',
	host: 'h',
	port: 22,
	username: 'u',
	privateKeyPath: '~/.ssh/id_ed25519',
	enabled: true,
};

/** summary.json content matching Grok's on-disk shape. */
function summaryJson(id: string, cwd: string, overrides: Record<string, unknown> = {}): string {
	return JSON.stringify({
		info: { id, cwd },
		session_summary: 'Create hello.txt File and Read Contents Back',
		generated_title: 'Create hello.txt File and Read Contents Back',
		created_at: '2026-07-09T17:44:28.000Z',
		updated_at: '2026-07-09T17:45:14.000Z',
		num_messages: 8,
		current_model_id: 'grok-4.5',
		...overrides,
	});
}

/**
 * A realistic chat_history.jsonl: system prompt, `<user_info>` environment
 * block, synthetic context injection, a real `<user_query>`-wrapped prompt,
 * reasoning, a tool call with its tool_result, and a final assistant reply.
 * Parses to 3 display messages (user, assistant+tool, assistant).
 */
function chatHistoryJsonl(): string {
	return [
		{ type: 'system', content: 'You are Grok 4.5 released by xAI.' },
		{
			type: 'user',
			content: [
				{ type: 'text', text: '<user_info>\nOS Version: macos\nShell: /bin/zsh\n</user_info>' },
			],
		},
		{
			type: 'user',
			synthetic_reason: 'project_instructions',
			content: [
				{ type: 'text', text: '<system-reminder>\nProject instructions here.\n</system-reminder>' },
			],
		},
		{
			type: 'user',
			content: [
				{
					type: 'text',
					text: '<user_query>\nCreate a file named hello.txt containing the word hello, then read it back\n</user_query>',
				},
			],
		},
		{ type: 'reasoning', id: 'r1', status: 'completed', encrypted_content: 'opaque' },
		{
			type: 'assistant',
			content: '',
			tool_calls: [
				{ id: 'call-1', name: 'write', arguments: '{"file_path":"hello.txt","contents":"hello"}' },
			],
		},
		{
			type: 'tool_result',
			tool_call_id: 'call-1',
			content: 'The file hello.txt has been created.',
		},
		{ type: 'assistant', content: 'Created `hello.txt` and read it back.' },
	]
		.map((record) => JSON.stringify(record))
		.join('\n');
}

/** A never-prompted session: only system/environment/synthetic records. */
function neverPromptedJsonl(): string {
	return [
		{ type: 'system', content: 'You are Grok 4.5 released by xAI.' },
		{
			type: 'user',
			content: [{ type: 'text', text: '<user_info>\nOS Version: macos\n</user_info>' }],
		},
		{
			type: 'user',
			synthetic_reason: 'system_reminder',
			content: [{ type: 'text', text: '<system-reminder>\nSkills available.\n</system-reminder>' }],
		},
	]
		.map((record) => JSON.stringify(record))
		.join('\n');
}

/** Build the two on-disk files for one session under its percent-encoded cwd folder. */
function sessionFiles(
	cwd: string,
	sessionId: string,
	summary: string,
	chatHistory: string,
	sessionsDir = SESSIONS_DIR,
	join = path.join
): Record<string, string> {
	const dir = join(sessionsDir, encodeURIComponent(cwd), sessionId);
	return {
		[join(dir, 'summary.json')]: summary,
		[join(dir, 'chat_history.jsonl')]: chatHistory,
	};
}

/**
 * Wire the fs/promises mocks to serve a virtual file tree. Directories are
 * derived from file paths; anything else throws ENOENT like the real fs.
 */
function mockLocalFs(
	files: Record<string, string>,
	options: {
		sizeOverrides?: Record<string, number>;
		bytesOverrides?: Record<string, Buffer>;
		onOpen?: (handle: Awaited<ReturnType<typeof fs.open>>, filePath: string) => void;
		directories?: string[];
	} = {}
) {
	// dir path -> child name -> isFile
	const children = new Map<string, Map<string, boolean>>();
	for (const filePath of Object.keys(files)) {
		let childPath = filePath;
		let isFile = true;
		for (;;) {
			const parent = path.dirname(childPath);
			if (parent === childPath) break;
			let entries = children.get(parent);
			if (!entries) {
				entries = new Map();
				children.set(parent, entries);
			}
			if (!entries.has(path.basename(childPath))) {
				entries.set(path.basename(childPath), isFile);
			}
			childPath = parent;
			isFile = false;
		}
	}

	const aliases = new Map<string, string>();
	const identities = new Map(
		[...children.keys(), ...Object.keys(files), ...(options.directories ?? [])].map((p) => [
			p,
			{ dev: 1, ino: 1, directory: !(p in files) },
		])
	);
	vi.mocked(fs.realpath).mockImplementation(async (p) => {
		const physical = aliases.get(String(p)) ?? String(p);
		if (!identities.has(physical)) throw enoent(physical);
		return physical;
	});
	vi.mocked(fs.lstat).mockImplementation(async (p) => {
		if (aliases.has(String(p))) return { isSymbolicLink: () => true } as never;
		return fs.stat(p);
	});

	const enoent = (p: string) =>
		Object.assign(new Error(`ENOENT: no such file or directory, ${p}`), { code: 'ENOENT' });

	vi.mocked(fs.readdir).mockImplementation(async (dirPath) => {
		const entries = children.get(String(dirPath));
		if (!entries) throw enoent(String(dirPath));
		return [...entries.entries()].map(([name, isFile]) => ({
			name,
			isDirectory: () => !isFile,
			isFile: () => isFile,
			isSymbolicLink: () => aliases.has(path.join(String(dirPath), name)),
		})) as never;
	});

	vi.mocked(fs.stat).mockImplementation(async (filePath) => {
		const p = String(filePath);
		const identity = identities.get(p);
		if (!identity) throw enoent(p);
		return {
			size:
				options.sizeOverrides?.[p] ??
				Buffer.byteLength(options.bytesOverrides?.[p] ?? files[p] ?? ''),
			mtimeMs: 1_752_082_000_000,
			ctimeMs: 1_752_082_000_000,
			dev: identity.dev,
			ino: identity.ino,
			isFile: () => !identity.directory,
			isDirectory: () => identity.directory,
		} as never;
	});

	vi.mocked(fs.open).mockImplementation(async (filePath) => {
		const p = String(filePath);
		if (!(p in files)) throw enoent(p);
		const bytes = options.bytesOverrides?.[p] ?? Buffer.from(files[p]);
		const handle = {
			stat: vi.fn(() => fs.stat(p)),
			read: vi.fn(async (buffer: Buffer, offset: number, length: number, position: number) => ({
				bytesRead: bytes.copy(buffer, offset, position, Math.min(position + length, bytes.length)),
				buffer,
			})),
			close: vi.fn().mockResolvedValue(undefined),
		};
		options.onOpen?.(handle as never, p);
		return handle as never;
	});

	vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
		const p = String(filePath);
		if (!(p in files)) throw enoent(p);
		return files[p] as never;
	});
	return { children, aliases, identities };
}

// ============================================================================
// Tests
// ============================================================================

describe('GrokSessionStorage - selected account scope', () => {
	const accounts = {
		default: path.dirname(SESSIONS_DIR),
		alpha: path.resolve('src', '__tests__', 'fixtures', 'grok-accounts', 'alpha'),
		beta: path.resolve('src', '__tests__', 'fixtures', 'grok-accounts', 'beta'),
	};

	beforeEach(() => {
		vi.clearAllMocks();
		const files: Record<string, string> = {};
		for (const [label, root] of Object.entries(accounts)) {
			// Same cwd and native ID in every account. The unique search text is
			// after the initial exchange, so metadata alone cannot satisfy it.
			const history = [
				chatHistoryJsonl(),
				JSON.stringify({ type: 'user', content: `${label} follow-up request` }),
				JSON.stringify({ type: 'assistant', content: `${label} transcript-only answer` }),
			].join('\n');
			Object.assign(
				files,
				sessionFiles(
					PROJECT,
					SESSION_ID,
					summaryJson(SESSION_ID, PROJECT, {
						session_summary: `${label} account title`,
						generated_title: `${label} account title`,
					}),
					history,
					path.join(root, 'sessions')
				)
			);
		}
		mockLocalFs(files);
	});

	it.each([
		['provider default', undefined, undefined, undefined, 'default'],
		['empty ambient account', '', undefined, undefined, 'default'],
		['whitespace ambient account', ' \t ', undefined, undefined, 'default'],
		['ambient account', accounts.beta, undefined, undefined, 'beta'],
		['explicit alpha account', accounts.beta, undefined, accounts.alpha, 'alpha'],
		['explicit beta account', accounts.alpha, undefined, accounts.beta, 'beta'],
		['constructor account', accounts.beta, accounts.alpha, undefined, 'alpha'],
		['empty constructor account', accounts.beta, '', undefined, 'default'],
		['whitespace constructor account', accounts.beta, ' \t ', undefined, 'default'],
		['explicit override of constructor', accounts.alpha, accounts.alpha, accounts.beta, 'beta'],
		['explicit default account', accounts.beta, accounts.alpha, accounts.default, 'default'],
		['empty selection', accounts.beta, accounts.alpha, '', 'default'],
		['whitespace selection', accounts.beta, accounts.alpha, ' \t\n ', 'default'],
	] as const)(
		'keeps list, read, search and path consistent for %s',
		async (_name, hostRoot, boundRoot, selectedRoot, label) => {
			if (hostRoot !== undefined) process.env.GROK_HOME = hostRoot;
			const storage = new GrokSessionStorage(boundRoot);
			const sessionsDir = path.join(accounts[label], 'sessions');
			const transcriptPath = path.join(
				sessionsDir,
				encodeURIComponent(PROJECT),
				SESSION_ID,
				'chat_history.jsonl'
			);

			const sessions = await storage.listSessions(PROJECT, undefined, selectedRoot);
			expect(sessions).toEqual([
				expect.objectContaining({
					sessionId: SESSION_ID,
					sessionName: `${label} account title`,
					messageCount: 5,
				}),
			]);
			expect(
				await storage.listSessionsPaginated(PROJECT, { configDir: selectedRoot, limit: 1 })
			).toEqual({ sessions, totalCount: 1, hasMore: false, nextCursor: null });
			expect(
				await storage.readSessionMessages(PROJECT, SESSION_ID, {
					configDir: selectedRoot,
					limit: 2,
				})
			).toMatchObject({
				messages: [
					{ role: 'user', content: `${label} follow-up request` },
					{ role: 'assistant', content: `${label} transcript-only answer` },
				],
				total: 5,
				hasMore: true,
			});
			expect(storage.getSessionPath(PROJECT, SESSION_ID, undefined, selectedRoot)).toBe(
				transcriptPath
			);

			for (const [mode, text] of [
				['title', 'account title'],
				['user', 'follow-up request'],
				['assistant', 'transcript-only answer'],
				['all', 'transcript-only answer'],
			] as const) {
				const results = await storage.searchSessions(
					PROJECT,
					`${label} ${text}`,
					mode,
					undefined,
					selectedRoot
				);
				expect(results).toEqual([
					expect.objectContaining({ sessionId: SESSION_ID, matchPreview: `${label} ${text}` }),
				]);
			}
			for (const other of Object.keys(accounts).filter((name) => name !== label)) {
				expect(
					await storage.searchSessions(PROJECT, `${other} `, 'all', undefined, selectedRoot)
				).toEqual([]);
			}

			expect(vi.mocked(fs.open).mock.calls.map(([file]) => String(file))).toContain(transcriptPath);
			for (const [file] of [
				...vi.mocked(fs.readdir).mock.calls,
				...vi.mocked(fs.stat).mock.calls,
				...vi.mocked(fs.open).mock.calls,
			]) {
				expect(
					String(file) === sessionsDir || String(file).startsWith(sessionsDir + path.sep)
				).toBe(true);
			}
			expect(remoteFs.readDirRemote).not.toHaveBeenCalled();
			expect(remoteFs.readFileRemote).not.toHaveBeenCalled();
			expect(remoteFs.statRemote).not.toHaveBeenCalled();
		}
	);

	it('isolates concurrent same-ID searches without changing the instance account', async () => {
		process.env.GROK_HOME = accounts.beta;
		const storage = new GrokSessionStorage(accounts.default);
		const results = await Promise.all(
			[accounts.alpha, accounts.beta, undefined].map((root) =>
				storage.searchSessions(PROJECT, 'transcript-only', 'assistant', undefined, root)
			)
		);
		expect(results).toEqual(
			['alpha', 'beta', 'default'].map((label) => [
				{
					sessionId: SESSION_ID,
					matchType: 'assistant',
					matchPreview: `${label} transcript-only answer`,
					matchCount: 1,
				},
			])
		);
		expect((await storage.listSessions(PROJECT))[0].sessionName).toBe('default account title');
	});

	it.each(['per-call', 'constructor'] as const)(
		'returns empty results for a missing %s account without reading available accounts',
		async (scope) => {
			process.env.GROK_HOME = accounts.beta;
			const missingRoot = path.join(path.dirname(accounts.alpha), 'missing');
			const storage = new GrokSessionStorage(
				scope === 'constructor' ? missingRoot : accounts.alpha
			);
			const selectedRoot = scope === 'per-call' ? missingRoot : undefined;

			expect(await storage.listSessions(PROJECT, undefined, selectedRoot)).toEqual([]);
			expect(await storage.listSessionsPaginated(PROJECT, { configDir: selectedRoot })).toEqual({
				sessions: [],
				totalCount: 0,
				hasMore: false,
				nextCursor: null,
			});
			expect(
				await storage.readSessionMessages(PROJECT, SESSION_ID, { configDir: selectedRoot })
			).toMatchObject({
				messages: [],
				total: 0,
				hasMore: false,
				source: { provider: 'grok', status: 'unavailable', reason: 'session-not-found' },
			});
			expect(
				await storage.searchSessions(PROJECT, 'account title', 'title', undefined, selectedRoot)
			).toEqual([]);
			expect(
				await storage.searchSessions(PROJECT, 'transcript-only', 'all', undefined, selectedRoot)
			).toEqual([]);
			// Path lookup is a synchronous guess, not proof that this account exists.
			expect(storage.getSessionPath(PROJECT, SESSION_ID, undefined, selectedRoot)).toBe(
				path.join(
					missingRoot,
					'sessions',
					encodeURIComponent(PROJECT),
					SESSION_ID,
					'chat_history.jsonl'
				)
			);
			expect(fs.readdir).toHaveBeenCalled();
			for (const [dir] of vi.mocked(fs.readdir).mock.calls) {
				expect(dir).toBe(path.join(missingRoot, 'sessions'));
			}
			expect(fs.open).not.toHaveBeenCalled();
			expect(fs.readFile).not.toHaveBeenCalled();
			expect(fs.stat).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
		}
	);
});

describe('GrokSessionStorage - native local source ownership', () => {
	const root = path.resolve('src', '__tests__', 'fixtures', 'grok-ownership');
	const account = path.join(root, 'alpha');
	const otherAccount = path.join(root, 'beta');
	const cwd = path.join(root, 'project');
	const child = path.join(cwd, 'child');
	const binding = {
		version: 1,
		state: 'bound',
		provider: 'grok',
		nativeSessionId: SESSION_ID,
		accountRef: nativeAccountRef('grok', account),
		cwd,
		host: { kind: 'local', identity: 'fixture-local-installation' },
	} as const;

	function scopedLocal(pool = path.join(account, 'sessions')) {
		const files = {
			...sessionFiles(cwd, SESSION_ID, summaryJson(SESSION_ID, cwd), chatHistoryJsonl(), pool),
			...sessionFiles(child, SESSION_ID, '{}', '{"type":"user","content":"child only"}', pool),
			...sessionFiles(
				cwd,
				SESSION_ID,
				'{}',
				'{"type":"user","content":"beta only"}',
				path.join(otherAccount, 'sessions')
			),
		};
		const handles: Awaited<ReturnType<typeof fs.open>>[] = [];
		const fixture = mockLocalFs(files, {
			directories: [account, cwd, child],
			onOpen: (handle) => handles.push(handle),
		});
		let ino = 1;
		for (const identity of fixture.identities.values()) identity.ino = ino++;
		fixture.aliases.set(path.join(account, 'sessions'), pool);
		const folder = path.join(pool, encodeURIComponent(cwd));
		const session = path.join(folder, SESSION_ID);
		const file = path.join(session, 'chat_history.jsonl');
		return {
			...fixture,
			files,
			handles,
			pool,
			folder,
			session,
			file,
			read: (options: SessionReadOptions = {}, project = cwd) =>
				new GrokSessionStorage(account).readSessionMessages(project, SESSION_ID, {
					nativeSessionBinding: binding,
					...options,
				}),
		};
	}

	beforeEach(() => vi.clearAllMocks());
	afterEach(() => {
		for (const mutation of [fs.writeFile, fs.appendFile, fs.rename, fs.unlink, fs.mkdir]) {
			expect(mutation).not.toHaveBeenCalled();
		}
		expect(execFileNoThrow).not.toHaveBeenCalled();
		expect(remoteFs.readFileRemote).not.toHaveBeenCalled();
		expect(remoteFs.observePathRemote).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});

	it.each([false, true])(
		'returns the pinned canonical source through aliases, shared pool=%s',
		async (shared) => {
			const f = scopedLocal(shared ? path.join(root, 'shared', 'sessions') : undefined);
			const selected = path.join(root, "selected space's α");
			const project = path.join(root, 'project alias');
			const target = path.join(f.session, 'transcript-target');
			f.aliases.set(selected, account);
			f.aliases.set(project, cwd);
			f.aliases.set(f.file, target);
			f.identities.set(target, { ...f.identities.get(f.file)! });
			f.files[target] = f.files[f.file];
			const before = { ...f.files };
			const result = await f.read({ configDir: selected }, project);
			expect(result.nativeSessionBinding).toEqual(binding);
			expect(result.nativeSessionBinding).not.toBe(binding);
			expect(
				result.nativeSessionBinding?.state === 'bound' && result.nativeSessionBinding.host
			).not.toBe(binding.host);
			expect(result.source?.status).toBe('available');
			expect(result.messages).toHaveLength(3);
			expect(result.messages.some((message) => message.toolUse)).toBe(true);
			expect(fs.open).toHaveBeenCalledExactlyOnceWith(
				target,
				fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOFOLLOW
			);
			expect(f.handles[0].close).toHaveBeenCalledOnce();
			expect(fs.readFile).not.toHaveBeenCalled();
			expect(f.files).toEqual(before);
			expect(captureException).not.toHaveBeenCalled();
		}
	);

	it('keeps colliding IDs bound to the selected account and exact cwd', async () => {
		const f = scopedLocal();
		const betaBinding = {
			...binding,
			accountRef: nativeAccountRef('grok', otherAccount),
		};
		const [alpha, beta] = await Promise.all([
			f.read(),
			f.read({ configDir: otherAccount, nativeSessionBinding: betaBinding }),
		]);
		expect(alpha.nativeSessionBinding).toEqual(binding);
		expect(alpha.messages).toHaveLength(3);
		expect(beta.nativeSessionBinding).toEqual(betaBinding);
		expect(beta.messages.map((m) => m.content)).toEqual(['beta only']);
		expect(fs.open).toHaveBeenCalledTimes(2);
		expect(vi.mocked(fs.open).mock.calls.map(([p]) => p)).not.toContain(
			path.join(f.pool, encodeURIComponent(child), SESSION_ID, 'chat_history.jsonl')
		);
	});

	it('never substitutes a descendant when the exact native session is absent', async () => {
		const f = scopedLocal();
		f.identities.delete(f.session);
		const result = await f.read();
		expect(result.source?.reason).toBe('session-not-found');
		expect(result.nativeSessionBinding).toBeUndefined();
		expect(result.messages).toEqual([]);
		expect(fs.open).not.toHaveBeenCalled();
	});

	it.each([
		{ version: 2 },
		{ state: 'unknown' },
		{ provider: 'codex' },
		{ nativeSessionId: '../escape' },
		{ nativeSessionId: 'other-native-id' },
		{ accountRef: '' },
		{ accountRef: 'bad\0ref' },
		{ cwd: 'relative' },
		{ cwd: '' },
		{ host: null },
		{ host: { kind: 'ssh', identity: 'remote' } },
		{ host: { kind: 'local', identity: ' \t ' } },
	])('refuses malformed or unknown binding %j before source I/O', async (patch) => {
		const f = scopedLocal();
		const result = await f.read({
			nativeSessionBinding: { ...binding, ...patch } as SessionReadOptions['nativeSessionBinding'],
		});
		expect(result.source?.reason).toBe('native-source-binding-invalid');
		expect(result.nativeSessionBinding).toBeUndefined();
		expect(result.messages).toEqual([]);
		expect(fs.realpath).not.toHaveBeenCalled();
		expect(fs.open).not.toHaveBeenCalled();
		expect(fs.readFile).not.toHaveBeenCalled();
	});

	it.each(['account', 'cwd', 'implicit-account'] as const)(
		'refuses %s mismatch before transcript content I/O',
		async (mismatch) => {
			const f = scopedLocal();
			const result =
				mismatch === 'implicit-account'
					? await new GrokSessionStorage().readSessionMessages(cwd, SESSION_ID, {
							nativeSessionBinding: binding,
						})
					: await f.read(
							mismatch === 'account' ? { configDir: otherAccount } : {},
							mismatch === 'cwd' ? child : cwd
						);
			expect(result.source?.reason).toBe(
				mismatch === 'implicit-account'
					? 'native-source-binding-invalid'
					: 'native-source-scope-mismatch'
			);
			expect(result.nativeSessionBinding).toBeUndefined();
			expect(result.messages).toEqual([]);
			expect(fs.open).not.toHaveBeenCalled();
			expect(fs.readFile).not.toHaveBeenCalled();
		}
	);

	it.each(['account', 'folder', 'session', 'session-name', 'transcript'] as const)(
		'refuses a %s alias to a foreign source before content I/O',
		async (part) => {
			const f = scopedLocal();
			const requested = {
				account,
				folder: f.folder,
				session: f.session,
				'session-name': f.session,
				transcript: f.file,
			}[part];
			const physical =
				part === 'account'
					? otherAccount
					: part === 'session-name'
						? path.join(f.folder, 'different-native-id')
						: path.join(root, 'outside', path.basename(requested));
			f.aliases.set(requested, physical);
			f.identities.set(physical, { ...f.identities.get(requested)! });
			const result = await f.read();
			expect(result.source?.reason).toBe('native-source-scope-mismatch');
			expect(result.nativeSessionBinding).toBeUndefined();
			expect(result.messages).toEqual([]);
			expect(fs.open).not.toHaveBeenCalled();
			expect(fs.readFile).not.toHaveBeenCalled();
		}
	);

	it.each(['directory', 'dangling', 'file'] as const)(
		'refuses an ambiguous cwd alias with a %s duplicate',
		async (kind) => {
			const f = scopedLocal();
			const projectAlias = path.join(root, 'alias');
			const folder = path.join(f.pool, encodeURIComponent(projectAlias));
			const duplicate = path.join(folder, SESSION_ID);
			f.aliases.set(projectAlias, cwd);
			f.children.get(f.pool)!.set(path.basename(folder), false);
			if (kind === 'dangling') f.aliases.set(duplicate, path.join(root, 'missing'));
			else f.identities.set(duplicate, { dev: 1, ino: 900, directory: kind === 'directory' });
			const result = await f.read();
			expect(result.source?.reason).toBe('native-source-ambiguous');
			expect(result.nativeSessionBinding).toBeUndefined();
			expect(result.messages).toEqual([]);
			expect(fs.open).not.toHaveBeenCalled();
		}
	);

	it.each(['account', 'cwd', 'pool', 'session', 'file'] as const)(
		'rejects missing and non-directory/non-file %s paths',
		async (part) => {
			for (const missing of [true, false]) {
				const f = scopedLocal();
				const p = { account, cwd, pool: f.pool, session: f.session, file: f.file }[part];
				if (missing) f.identities.delete(p);
				else f.identities.get(p)!.directory = part === 'file';
				const result = await f.read();
				expect(result.source?.status).toBe('unavailable');
				expect(result.nativeSessionBinding).toBeUndefined();
				expect(result.messages).toEqual([]);
				expect(fs.open).not.toHaveBeenCalled();
				expect(captureException).not.toHaveBeenCalled();
			}
		}
	);

	it.each(['EACCES', 'ELOOP', 'ENOTDIR'])(
		'refuses failed path observation %s without fallback',
		async (code) => {
			const f = scopedLocal();
			vi.mocked(fs.realpath).mockRejectedValueOnce(Object.assign(new Error(code), { code }));
			const result = await f.read();
			expect(result.source?.reason).toBe('native-source-unobserved');
			expect(result.nativeSessionBinding).toBeUndefined();
			expect(fs.open).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
		}
	);

	it.each(['dev', 'ino'] as const)('rejects an unrepresentable observed %s', async (field) => {
		const f = scopedLocal();
		f.identities.get(account)![field] = Number.MAX_SAFE_INTEGER + 1;
		const result = await f.read();
		expect(result.source?.status).toBe('unavailable');
		expect(result.nativeSessionBinding).toBeUndefined();
		expect(fs.open).not.toHaveBeenCalled();
	});

	it('refuses when an unrelated cwd cannot be observed to establish uniqueness', async () => {
		const f = scopedLocal();
		const realpath = vi.mocked(fs.realpath).getMockImplementation()!;
		vi.mocked(fs.realpath).mockImplementation(async (...args) => {
			if (args[0] === child) throw Object.assign(new Error('denied'), { code: 'EACCES' });
			return realpath(...args);
		});
		const result = await f.read();
		expect(result.source?.reason).toBe('native-source-unobserved');
		expect(result.nativeSessionBinding).toBeUndefined();
		expect(result.messages).toEqual([]);
		expect(fs.open).not.toHaveBeenCalled();
		expect(captureException).not.toHaveBeenCalled();
	});

	it.each(['account', 'cwd', 'pool', 'folder', 'session', 'file'] as const)(
		'discards a replaced %s at open and after content read',
		async (part) => {
			for (const stage of ['open', 'read'] as const) {
				vi.clearAllMocks();
				const f = scopedLocal();
				const p = {
					account,
					cwd,
					pool: f.pool,
					folder: f.folder,
					session: f.session,
					file: f.file,
				}[part];
				const open = vi.mocked(fs.open).getMockImplementation()!;
				vi.mocked(fs.open).mockImplementation(async (...args) => {
					const handle = await open(...args);
					if (stage === 'open') f.identities.get(p)!.ino++;
					else {
						const read = vi.mocked(handle.read).getMockImplementation()!;
						vi.mocked(handle.read).mockImplementation(async (...readArgs) => {
							f.identities.get(p)!.ino++;
							return read(...readArgs);
						});
					}
					return handle;
				});
				const result = await f.read();
				expect(result.source?.reason).toBe('native-source-changed');
				expect(result.nativeSessionBinding).toBeUndefined();
				expect(result.messages).toEqual([]);
				expect(fs.open).toHaveBeenCalledOnce();
				if (stage === 'open') expect(f.handles[0].read).not.toHaveBeenCalled();
				else expect(f.handles[0].read).toHaveBeenCalled();
				expect(f.handles[0].close).toHaveBeenCalledOnce();
			}
		}
	);

	it.each(['before-open', 'after-close'] as const)(
		'rejects a renamed physical path %s even with unchanged device/inode',
		async (stage) => {
			const f = scopedLocal();
			const renamed = path.join(root, 'renamed-account');
			f.identities.set(renamed, { ...f.identities.get(account)! });
			if (stage === 'before-open') {
				const realpath = vi.mocked(fs.realpath).getMockImplementation()!;
				let observations = 0;
				vi.mocked(fs.realpath).mockImplementation(async (...args) => {
					if (args[0] === account && ++observations === 2) f.aliases.set(account, renamed);
					return realpath(...args);
				});
			} else {
				const open = vi.mocked(fs.open).getMockImplementation()!;
				vi.mocked(fs.open).mockImplementation(async (...args) => {
					const handle = await open(...args);
					vi.mocked(handle.close).mockImplementation(async () => {
						f.aliases.set(account, renamed);
					});
					return handle;
				});
			}
			const result = await f.read();
			expect(result.source?.reason).toBe('native-source-changed');
			expect(result.nativeSessionBinding).toBeUndefined();
			expect(result.messages).toEqual([]);
			expect(fs.open).toHaveBeenCalledTimes(stage === 'before-open' ? 0 : 1);
			if (stage === 'after-close') expect(f.handles[0].close).toHaveBeenCalledOnce();
		}
	);

	it.each(['dev', 'ino'] as const)(
		'checks opened descriptor %s before reading bytes',
		async (field) => {
			const f = scopedLocal();
			const open = vi.mocked(fs.open).getMockImplementation()!;
			vi.mocked(fs.open).mockImplementation(async (...args) => {
				const handle = await open(...args);
				vi.mocked(handle.stat).mockResolvedValue({ ...(await fs.stat(f.file)), [field]: 9999 });
				return handle;
			});
			const result = await f.read();
			expect(result.source?.reason).toBe('native-source-changed');
			expect(result.nativeSessionBinding).toBeUndefined();
			expect(result.messages).toEqual([]);
			expect(f.handles[0].read).not.toHaveBeenCalled();
			expect(f.handles[0].close).toHaveBeenCalledOnce();
		}
	);

	it.each(['malformed', 'oversized', 'unreadable', 'append'] as const)(
		'keeps ownership separate from %s content provenance',
		async (kind) => {
			const f = scopedLocal();
			if (kind === 'malformed') f.files[f.file] += '\n{"type":';
			if (kind === 'unreadable')
				vi.mocked(fs.open).mockRejectedValueOnce(
					Object.assign(new Error('denied'), { code: 'EACCES' })
				);
			if (kind === 'oversized') {
				const stat = vi.mocked(fs.stat).getMockImplementation()!;
				vi.mocked(fs.stat).mockImplementation(async (...args) => {
					const result = await stat(...args);
					if (args[0] === f.file) result.size = 64 * 1024 * 1024 + 1;
					return result;
				});
			}
			if (kind === 'append') {
				const open = vi.mocked(fs.open).getMockImplementation()!;
				vi.mocked(fs.open).mockImplementation(async (...args) => {
					const handle = await open(...args);
					const initial = await fs.stat(f.file);
					vi.mocked(handle.stat)
						.mockResolvedValueOnce(initial)
						.mockResolvedValue({ ...initial, size: initial.size + 1 });
					return handle;
				});
			}
			const result = await f.read();
			expect(result.nativeSessionBinding).toEqual(binding);
			expect(result.source?.status).toBe(
				kind === 'malformed' || kind === 'append' ? 'partial' : 'unavailable'
			);
			expect(result.source?.reason).toBe(
				{
					malformed: 'malformed-records',
					oversized: 'too-large',
					unreadable: 'unreadable',
					append: 'changed-during-read',
				}[kind]
			);
			expect(result.messages).toHaveLength(kind === 'malformed' ? 4 : kind === 'append' ? 3 : 0);
			if (kind === 'malformed') {
				expect(result.messages.map((message) => message.native?.line)).toEqual([4, 6, 8, 9]);
				expect(result.messages[3]).toMatchObject({
					type: 'unknown',
					role: 'unknown',
					content: '[Unreadable Grok transcript record retained for export]',
					uuid: 'grok-line-9',
					native: { provider: 'grok', line: 9, issues: ['malformed-record'] },
				});
			}
			if (kind === 'oversized') expect(fs.open).not.toHaveBeenCalled();
			for (const handle of f.handles) expect(handle.close).toHaveBeenCalledOnce();
			expect(captureException).not.toHaveBeenCalled();
		}
	);

	it('keeps a successful legacy read unbound without physical ownership observations', async () => {
		const f = scopedLocal();
		const result = await f.read({ nativeSessionBinding: undefined });
		expect(result.messages).toHaveLength(3);
		expect(result.nativeSessionBinding).toBeUndefined();
		expect(fs.realpath).not.toHaveBeenCalled();
		expect(fs.lstat).not.toHaveBeenCalled();
	});
});

describe('GrokSessionStorage - local listing', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('lists sessions for the project and excludes other projects without opening their files', async () => {
		const otherId = '019f0000-aaaa-7000-8000-000000000002';
		mockLocalFs({
			...sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), chatHistoryJsonl()),
			...sessionFiles(
				OTHER_PROJECT,
				otherId,
				summaryJson(otherId, OTHER_PROJECT),
				chatHistoryJsonl()
			),
		});

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe(SESSION_ID);
		expect(sessions[0].projectPath).toBe(PROJECT);
		// Project filtering happens on folder names - the foreign session's
		// files must never be opened.
		const readPaths = vi.mocked(fs.open).mock.calls.map((c) => String(c[0]));
		expect(readPaths.some((p) => p.includes(encodeURIComponent(OTHER_PROJECT)))).toBe(false);
	});

	it('exposes summary.json metadata: title, timestamps, preview, message count, zero tokens', async () => {
		mockLocalFs(
			sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), chatHistoryJsonl())
		);

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions).toHaveLength(1);
		const session = sessions[0];
		expect(session.sessionName).toBe('Create hello.txt File and Read Contents Back');
		expect(session.timestamp).toBe('2026-07-09T17:44:28.000Z');
		expect(session.modifiedAt).toBe('2026-07-09T17:45:14.000Z');
		expect(session.durationSeconds).toBe(46);
		// Preview is the real prompt with the <user_query> wrapper stripped.
		expect(session.firstMessage).toBe(
			'Create a file named hello.txt containing the word hello, then read it back'
		);
		expect(session.messageCount).toBe(3);
		// No usage.json (a 0.x session): zeros, not fabricated values.
		expect(session.inputTokens).toBe(0);
		expect(session.outputTokens).toBe(0);
		expect(session.costUsd).toBeUndefined();
	});

	it('reads session tokens and cost from usage.json (grok 1.x)', async () => {
		const dir = path.join(SESSIONS_DIR, encodeURIComponent(PROJECT), SESSION_ID);
		// Trimmed from a real 1.0.41 session after two turns. On disk inputTokens
		// INCLUDES cached reads (93742 = 19374 uncached + 74368 cached).
		const usageJson = JSON.stringify({
			sessionId: SESSION_ID,
			session: {
				inputTokens: 93742,
				outputTokens: 193,
				cachedReadTokens: 74368,
				cacheCreationTokens: 0,
				reasoningTokens: 107,
				costUsdTicks: 262106000,
				modelUsage: {
					'grok-4.7-build': {
						inputTokens: 93742,
						outputTokens: 193,
						cachedReadTokens: 74368,
						cacheCreationTokens: 0,
						costUsdTicks: 262106000,
					},
				},
			},
		});
		mockLocalFs({
			...sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), chatHistoryJsonl()),
			[path.join(dir, 'usage.json')]: usageJson,
		});

		const [session] = await new GrokSessionStorage().listSessions(PROJECT);

		// Stream convention: input EXCLUDES cache reads, so the dashboard's
		// input + cacheRead does not count the cached tokens twice.
		expect(session).toMatchObject({
			inputTokens: 19374,
			outputTokens: 193,
			cacheReadTokens: 74368,
			cacheCreationTokens: 0,
		});
		expect(session.costUsd).toBeCloseTo(0.0262106, 10);
		expect(session.byModel).toBeUndefined();
		expect(session.accounting?.models).toEqual([
			expect.objectContaining({
				model: 'grok-4.7-build',
				inputTokens: 19374,
				outputTokens: 193,
				cacheReadInputTokens: 74368,
				cacheCreationInputTokens: 0,
				completeness: 'partial',
				cost: {
					status: 'partial',
					costUsdTicks: '262106000',
					reason: 'cross-file-generation-unverified',
				},
			}),
		]);
	});

	it('reads a cost-less usage.json (custom grok-compatible binary) as tokens with an unknown cost', async () => {
		const dir = path.join(SESSIONS_DIR, encodeURIComponent(PROJECT), SESSION_ID);
		// A grok-compatible custom binary that reports tokens but no cost writes this.
		const usageJson = JSON.stringify({
			sessionId: SESSION_ID,
			session: {
				inputTokens: 15364,
				outputTokens: 32,
				cachedReadTokens: 3200,
				cacheCreationTokens: 0,
				turnCount: 1,
			},
		});
		mockLocalFs({
			...sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), chatHistoryJsonl()),
			[path.join(dir, 'usage.json')]: usageJson,
		});

		const [session] = await new GrokSessionStorage().listSessions(PROJECT);

		expect(session).toMatchObject({ inputTokens: 12164, outputTokens: 32, cacheReadTokens: 3200 });
		// Unknown, not $0: the dashboard then estimates it and flags it estimated.
		expect(session.costUsd).toBeUndefined();
		expect(session.byModel).toBeUndefined();
	});

	it.each([
		['/private/var/grok-test', '/var/grok-test'],
		['/private/tmp/grok-test', '/tmp/grok-test'],
		['/private/etc/grok-test', '/etc/grok-test'],
		['/var/grok-test', '/private/var/grok-test'],
		['/tmp/grok-test', '/private/tmp/grok-test'],
		['/etc/grok-test', '/private/etc/grok-test'],
	])('matches local recorded cwd %s through alias %s', async (recordedCwd, projectPath) => {
		mockLocalFs(
			sessionFiles(
				recordedCwd,
				SESSION_ID,
				summaryJson(SESSION_ID, recordedCwd),
				chatHistoryJsonl()
			)
		);

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(projectPath);

		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe(SESSION_ID);
	});

	it('includes sessions whose recorded cwd is a subdirectory of the project path', async () => {
		const subdirCwd = `${PROJECT}/packages/app`;
		mockLocalFs(
			sessionFiles(subdirCwd, SESSION_ID, summaryJson(SESSION_ID, subdirCwd), chatHistoryJsonl())
		);

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions).toHaveLength(1);
		// A sibling project sharing the prefix must NOT match.
		expect(await storage.listSessions('/Users/test/my-proj')).toEqual([]);
	});

	it('returns an empty list when the sessions directory does not exist', async () => {
		mockLocalFs({}); // no files: readdir on the base dir throws ENOENT

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions).toEqual([]);
		expect(vi.mocked(captureException)).not.toHaveBeenCalled();
	});

	it('excludes never-prompted sessions that contain only system/synthetic records', async () => {
		mockLocalFs(
			sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), neverPromptedJsonl())
		);

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions).toEqual([]);
	});

	it('keeps usable transcripts with malformed summaries after dated sessions', async () => {
		const goodId = '019f0000-aaaa-7000-8000-000000000003';
		mockLocalFs({
			...sessionFiles(PROJECT, SESSION_ID, 'not valid json {', chatHistoryJsonl()),
			...sessionFiles(PROJECT, goodId, summaryJson(goodId, PROJECT), chatHistoryJsonl()),
		});

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions.map((s) => s.sessionId)).toEqual([goodId, SESSION_ID]);
		expect(sessions[1].nativeMetadata).toMatchObject({ summaryStatus: 'invalid' });
	});

	it('tolerates malformed transcript lines (live-write partial line) without throwing', async () => {
		// Grok appends while running, so a live session can end mid-record.
		const truncated = `${chatHistoryJsonl()}\n{"type":"assistant","content":"cut off mid-wri`;
		mockLocalFs(sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), truncated));

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions).toHaveLength(1);
		expect(sessions[0].messageCount).toBe(4);
		expect(sessions[0].nativeMetadata?.sources?.['chat_history.jsonl']).toMatchObject({
			status: 'partial',
			reason: 'malformed-records',
		});
	});

	it('sorts sessions newest-first by modifiedAt', async () => {
		const olderId = '019f0000-aaaa-7000-8000-00000000000a';
		const newerId = '019f0000-aaaa-7000-8000-00000000000b';
		mockLocalFs({
			...sessionFiles(
				PROJECT,
				olderId,
				summaryJson(olderId, PROJECT, { updated_at: '2026-07-08T00:00:00.000Z' }),
				chatHistoryJsonl()
			),
			...sessionFiles(
				PROJECT,
				newerId,
				summaryJson(newerId, PROJECT, { updated_at: '2026-07-09T00:00:00.000Z' }),
				chatHistoryJsonl()
			),
		});

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions.map((s) => s.sessionId)).toEqual([newerId, olderId]);
	});

	it('skips sessions whose transcript exceeds the 64 MiB read budget without reading it', async () => {
		const files = sessionFiles(
			PROJECT,
			SESSION_ID,
			summaryJson(SESSION_ID, PROJECT),
			chatHistoryJsonl()
		);
		const transcriptPath = Object.keys(files).find((p) => p.endsWith('chat_history.jsonl'))!;
		mockLocalFs(files, { sizeOverrides: { [transcriptPath]: 200 * 1024 * 1024 } });

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT);

		expect(sessions).toEqual([]);
		const readPaths = vi.mocked(fs.open).mock.calls.map((c) => String(c[0]));
		expect(readPaths).not.toContain(transcriptPath);
	});
});

describe('GrokSessionStorage - reading messages', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('maps transcript records to display messages, merging tool_result into the tool call', async () => {
		mockLocalFs(
			sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), chatHistoryJsonl())
		);

		const storage = new GrokSessionStorage();
		const result = await storage.readSessionMessages(PROJECT, SESSION_ID);

		expect(result.total).toBe(3);
		expect(result.hasMore).toBe(false);
		const [user, toolTurn, reply] = result.messages;

		// The <user_query> wrapper is stripped; synthetic/system/reasoning
		// records never surface.
		expect(user.role).toBe('user');
		expect(user.content).toBe(
			'Create a file named hello.txt containing the word hello, then read it back'
		);

		expect(toolTurn.role).toBe('assistant');
		const toolUse = toolTurn.toolUse as Array<{
			tool?: string;
			state: { status: string; input?: unknown; output?: string };
		}>;
		expect(toolUse).toHaveLength(1);
		expect(toolUse[0].tool).toBe('write');
		expect(toolUse[0].state.status).toBe('completed');
		expect(toolUse[0].state.input).toEqual({ file_path: 'hello.txt', contents: 'hello' });
		expect(toolUse[0].state.output).toBe('The file hello.txt has been created.');

		expect(reply.role).toBe('assistant');
		expect(reply.content).toBe('Created `hello.txt` and read it back.');
	});

	it('joins multiple <user_query> wrappers in a single user turn', async () => {
		const multiWrapperHistory = [
			{
				type: 'user',
				content: [
					{
						type: 'text',
						text: '<user_query>\nFirst block\n</user_query>\n\n<preamble>\nignored\n</preamble>\n\n<user_query>\nSecond block\n</user_query>',
					},
				],
			},
			{ type: 'assistant', content: 'ok' },
		]
			.map((record) => JSON.stringify(record))
			.join('\n');

		mockLocalFs(
			sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), multiWrapperHistory)
		);

		const storage = new GrokSessionStorage();
		const result = await storage.readSessionMessages(PROJECT, SESSION_ID);

		expect(result.messages[0].content).toBe('First block\n\nSecond block');
	});

	it('returns an empty result for a session owned by a different project (ownership guard)', async () => {
		mockLocalFs(
			sessionFiles(
				OTHER_PROJECT,
				SESSION_ID,
				summaryJson(SESSION_ID, OTHER_PROJECT),
				chatHistoryJsonl()
			)
		);

		const storage = new GrokSessionStorage();
		const result = await storage.readSessionMessages(PROJECT, SESSION_ID);

		expect(result).toMatchObject({
			messages: [],
			total: 0,
			hasMore: false,
			source: { provider: 'grok', status: 'unavailable', reason: 'session-not-found' },
		});
	});

	it('paginates from the end of the transcript', async () => {
		mockLocalFs(
			sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), chatHistoryJsonl())
		);

		const storage = new GrokSessionStorage();
		const result = await storage.readSessionMessages(PROJECT, SESSION_ID, { limit: 2 });

		expect(result.total).toBe(3);
		expect(result.hasMore).toBe(true);
		expect(result.messages).toHaveLength(2);
		// Most recent messages come back: the tool turn and the final reply.
		expect(result.messages[1].content).toBe('Created `hello.txt` and read it back.');
	});
});

describe('GrokSessionStorage - SSH remote', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(remoteFs.readDirRemote).mockReset();
		vi.mocked(remoteFs.readFileRemote).mockReset();
		vi.mocked(remoteFs.statRemote).mockReset();
		vi.mocked(remoteFs.observePathRemote).mockReset();
	});

	afterEach(() => {
		vi.useRealTimers();
		expect(fs.readdir).not.toHaveBeenCalled();
		expect(fs.open).not.toHaveBeenCalled();
		expect(fs.readFile).not.toHaveBeenCalled();
		expect(fs.stat).not.toHaveBeenCalled();
		for (const mutation of [fs.writeFile, fs.appendFile, fs.rename, fs.unlink, fs.mkdir])
			expect(mutation).not.toHaveBeenCalled();
		expect(execFileNoThrow).not.toHaveBeenCalled();
	});

	const encodedProject = encodeURIComponent(PROJECT);

	/** Exact fake remote paths: unknown accounts/files cannot borrow fixture content. */
	function mockRemoteSession({ accountDir = '~/.grok', cwd = PROJECT, ids = [SESSION_ID] } = {}) {
		const sessionsDir = path.posix.join(accountDir, 'sessions');
		const cwdDir = path.posix.join(sessionsDir, encodeURIComponent(cwd));
		const directories = new Map<string, remoteFs.RemoteDirEntry[]>([
			[sessionsDir, [{ name: encodeURIComponent(cwd), isDirectory: true, isSymlink: false }]],
			[cwdDir, ids.map((name) => ({ name, isDirectory: true, isSymlink: false }))],
		]);
		const files: Record<string, string> = Object.assign(
			{},
			...ids.map((id) =>
				sessionFiles(
					cwd,
					id,
					summaryJson(id, cwd),
					chatHistoryJsonl(),
					sessionsDir,
					path.posix.join
				)
			)
		);
		vi.mocked(remoteFs.readDirRemote).mockImplementation(async (dirPath: string) => {
			if (directories.has(dirPath)) return { success: true, data: directories.get(dirPath) };
			return { success: false, error: 'Directory not found or not accessible' };
		});
		vi.mocked(remoteFs.statRemote).mockImplementation(async (filePath) => {
			if (!(filePath in files)) return { success: false, error: 'No such file' };
			return {
				success: true,
				data: {
					size: Buffer.byteLength(files[filePath]),
					isDirectory: false,
					mtime: 1_752_082_000_000,
				},
			};
		});
		vi.mocked(remoteFs.readFileRemote).mockImplementation(async (filePath: string) => {
			if (filePath in files) return { success: true, data: files[filePath] };
			return { success: false, error: 'No such file' };
		});
		return { sessionsDir, cwdDir, directories, files };
	}

	describe('native remote source ownership', () => {
		const account = '/remote/selected';
		const binding = {
			version: 1,
			state: 'bound',
			provider: 'grok',
			nativeSessionId: SESSION_ID,
			accountRef: nativeAccountRef('grok', account),
			cwd: PROJECT,
			host: { kind: 'ssh', identity: 'fixture-endpoint-installation' },
		} as const;
		function scopedRemote(selected = account, pool = `${account}/sessions`) {
			const fixture = mockRemoteSession({ accountDir: path.posix.dirname(pool) });
			const session = path.posix.join(fixture.cwdDir, SESSION_ID);
			const file = path.posix.join(session, 'chat_history.jsonl');
			const identities = new Map<string, remoteFs.RemotePathIdentity>();
			for (const [i, p] of [account, PROJECT, pool, fixture.cwdDir, session, file].entries()) {
				identities.set(p, {
					canonicalPath: p,
					device: '1',
					inode: String(i + 1),
					kind: p === file ? 'file' : 'directory',
				});
			}
			identities.set(selected, identities.get(account)!);
			identities.set(`${account}/sessions`, identities.get(pool)!);
			// Select the ordinary path overload; this fixture does not observe a Grok launch.
			vi.mocked<
				(
					filePath: string,
					sshRemote: SshRemoteConfig,
					deps?: remoteFs.RemoteFsDeps
				) => Promise<remoteFs.RemoteFsResult<remoteFs.RemotePathIdentity>>
			>(remoteFs.observePathRemote).mockImplementation(async (p) =>
				identities.has(p)
					? { success: true, data: { ...identities.get(p)! } }
					: { success: false, errorCode: 'identity-unavailable', error: 'Path not found' }
			);
			const read = vi.mocked(remoteFs.readFileRemote).getMockImplementation()!;
			vi.mocked(remoteFs.readFileRemote).mockImplementation(async (...args) => ({
				...(await read(...args)),
				observedIdentity: identities.get(args[0]),
			}));
			return {
				...fixture,
				identities,
				session,
				file,
				read: () =>
					new GrokSessionStorage().readSessionMessages(
						PROJECT,
						SESSION_ID,
						{ configDir: selected, nativeSessionBinding: binding, includeNativeRecords: true },
						sshConfig
					),
			};
		}

		it.each([account, '~/selected alias'])(
			'pins selected account %s and a shared sessions alias to the actual descriptor',
			async (selected) => {
				const f = scopedRemote(selected, '/remote/shared/sessions');
				const target = path.posix.join(f.session, 'transcript-target');
				f.identities.set(f.file, { ...f.identities.get(f.file)!, canonicalPath: target });
				f.identities.set(target, f.identities.get(f.file)!);
				f.files[target] = f.files[f.file];
				const result = await f.read();
				expect(result.messages).toHaveLength(8);
				expect(result.messages).toMatchObject(
					chatHistoryJsonl()
						.split('\n')
						.map((raw, index) => ({
							uuid: `grok-line-${index + 1}`,
							native: { provider: 'grok', line: index + 1, raw },
						}))
				);
				expect(result.nativeSessionBinding).toEqual(binding);
				expect(result.source?.status).toBe('available');
				expect(remoteFs.readFileRemote).toHaveBeenCalledWith(
					target,
					sshConfig,
					undefined,
					expect.objectContaining({
						maxBytes: 64 * 1024 * 1024,
						expectedIdentity: f.identities.get(target),
						expectedPaths: expect.arrayContaining([
							{ path: selected, identity: f.identities.get(account) },
							{
								path: `${account}/sessions`,
								identity: f.identities.get('/remote/shared/sessions'),
							},
							{ path: f.file, identity: f.identities.get(target) },
						]),
					})
				);
				expect(remoteFs.readFileRemote).toHaveBeenCalledTimes(1);
				expect(captureException).not.toHaveBeenCalled();
			}
		);

		it.each([false, true])(
			'selects exact cwd with descendant collision, exact absent=%s',
			async (absent) => {
				const f = scopedRemote();
				const child = `${PROJECT}/child`;
				const childFolder = path.posix.join(f.sessionsDir, encodeURIComponent(child));
				f.identities.set(child, {
					...f.identities.get(PROJECT)!,
					canonicalPath: child,
					inode: '99',
				});
				f.directories
					.get(f.sessionsDir)!
					.push({ name: encodeURIComponent(child), isDirectory: true, isSymlink: false });
				f.directories.set(childFolder, [{ name: SESSION_ID, isDirectory: true, isSymlink: false }]);
				if (absent) f.directories.set(f.cwdDir, []);
				const result = await f.read();
				expect(result.nativeSessionBinding).toEqual(absent ? undefined : binding);
				expect(remoteFs.readFileRemote).toHaveBeenCalledTimes(absent ? 0 : 1);
				expect(remoteFs.readDirRemote).not.toHaveBeenCalledWith(childFolder, sshConfig);
				if (absent) expect(result.source?.reason).toBe('session-not-found');
			}
		);

		it.each(['directory', 'dangling', 'file'])(
			'refuses ambiguous cwd aliases even when the duplicate is a %s',
			async (kind) => {
				const f = scopedRemote();
				const alias = '/remote/project-alias';
				f.identities.set(alias, f.identities.get(PROJECT)!);
				f.directories
					.get(f.sessionsDir)!
					.push({ name: encodeURIComponent(alias), isDirectory: false, isSymlink: true });
				f.directories.set(path.posix.join(f.sessionsDir, encodeURIComponent(alias)), [
					{ name: SESSION_ID, isDirectory: kind === 'directory', isSymlink: kind === 'dangling' },
				]);
				expect(await f.read()).toMatchObject({
					messages: [],
					source: { reason: 'native-source-ambiguous' },
				});
				expect(remoteFs.readFileRemote).not.toHaveBeenCalled();
			}
		);

		it.each([
			'account',
			'cwd',
			'folder',
			'session',
			'transcript',
			'missing-root',
			'file-root',
			'missing-pool',
		])('refuses %s mismatch before content I/O', async (scenario) => {
			const f = scopedRemote();
			const key = {
				account,
				cwd: PROJECT,
				folder: f.cwdDir,
				session: f.session,
				transcript: f.file,
				'missing-root': account,
				'file-root': account,
				'missing-pool': f.sessionsDir,
			}[scenario]!;
			if (scenario.startsWith('missing')) f.identities.delete(key);
			else
				f.identities.set(key, {
					...f.identities.get(key)!,
					...(scenario === 'file-root'
						? { kind: 'file' as const }
						: { canonicalPath: '/remote/other' }),
				});
			const result = await f.read();
			expect(result).toMatchObject({ messages: [], source: { status: 'unavailable' } });
			expect(result.nativeSessionBinding).toBeUndefined();
			expect(remoteFs.readFileRemote).not.toHaveBeenCalled();
			expect(captureException).not.toHaveBeenCalled();
		});

		it('keeps colliding native IDs bound to their selected remote accounts', async () => {
			const f = scopedRemote();
			const second = '/remote/second';
			for (const [key, identity] of [...f.identities]) {
				if (key.startsWith(account))
					f.identities.set(key.replace(account, second), {
						...identity,
						canonicalPath: identity.canonicalPath.replace(account, second),
						inode: `${identity.inode}0`,
					});
			}
			for (const [key, entries] of [...f.directories])
				f.directories.set(
					key.replace(account, second),
					entries.map((entry) => ({ ...entry }))
				);
			for (const [key, content] of Object.entries(f.files))
				f.files[key.replace(account, second)] = content.replaceAll('hello.txt', 'second.txt');
			for (const selected of [account, second]) {
				vi.mocked(remoteFs.readFileRemote).mockClear();
				const nativeSessionBinding = {
					...binding,
					accountRef: nativeAccountRef('grok', selected),
				};
				const result = await new GrokSessionStorage().readSessionMessages(
					PROJECT,
					SESSION_ID,
					{ configDir: selected, nativeSessionBinding },
					sshConfig
				);
				expect(result.nativeSessionBinding).toEqual(nativeSessionBinding);
				expect(result.messages.at(-1)?.content).toContain(
					selected === account ? 'hello.txt' : 'second.txt'
				);
				expect(remoteFs.readFileRemote).toHaveBeenCalledTimes(1);
				expect(vi.mocked(remoteFs.readFileRemote).mock.calls[0][0]).toBe(
					f.file.replace(account, selected)
				);
			}
			vi.mocked(remoteFs.readFileRemote).mockClear();
			expect(
				await new GrokSessionStorage().readSessionMessages(
					PROJECT,
					SESSION_ID,
					{ configDir: second, nativeSessionBinding: binding },
					sshConfig
				)
			).toMatchObject({
				messages: [],
				source: { reason: 'native-source-scope-mismatch' },
			});
			expect(remoteFs.readFileRemote).not.toHaveBeenCalled();
		});

		it.each(['pool-failed', 'pool-missing', 'pool-over-1000', 'cwd-failed', 'cwd-missing'])(
			'refuses incomplete candidate enumeration: %s',
			async (scenario) => {
				const f = scopedRemote();
				const readDir = vi.mocked(remoteFs.readDirRemote).getMockImplementation()!;
				const target = scenario.startsWith('pool') ? f.sessionsDir : f.cwdDir;
				vi.mocked(remoteFs.readDirRemote).mockImplementation(async (...args) => {
					if (args[0] !== target) return readDir(...args);
					if (scenario.endsWith('failed'))
						return { success: false, error: 'Connection reset by peer' };
					if (scenario.endsWith('missing')) return { success: true };
					return {
						success: true,
						data: Array.from({ length: 1001 }, () => f.directories.get(target)![0]),
					};
				});
				const result = await f.read();
				expect(result).toMatchObject({
					messages: [],
					source: { reason: 'native-source-unobserved' },
				});
				expect(result.nativeSessionBinding).toBeUndefined();
				expect(remoteFs.readFileRemote).not.toHaveBeenCalled();
				expect(captureException).toHaveBeenCalledTimes(
					scenario.endsWith('failed') || scenario === 'cwd-missing' ? 1 : 0
				);
			}
		);

		it.each(['coded', 'expected', 'unexpected'])(
			'refuses an unobserved candidate cwd and classifies %s failure',
			async (scenario) => {
				const f = scopedRemote();
				f.directories.get(f.sessionsDir)!.push({
					name: encodeURIComponent(OTHER_PROJECT),
					isDirectory: true,
					isSymlink: false,
				});
				const observe = vi.mocked(remoteFs.observePathRemote).getMockImplementation()!;
				vi.mocked(remoteFs.observePathRemote).mockImplementation(async (...args) =>
					args[0] === OTHER_PROJECT
						? {
								success: false,
								error:
									scenario === 'unexpected' ? 'fixture observation defect' : 'Permission denied',
								...(scenario === 'coded' ? { errorCode: 'identity-unavailable' as const } : {}),
							}
						: observe(...args)
				);
				const result = await f.read();
				expect(result).toMatchObject({
					messages: [],
					source: { reason: 'native-source-unobserved' },
				});
				expect(result.nativeSessionBinding).toBeUndefined();
				expect(remoteFs.readFileRemote).not.toHaveBeenCalled();
				expect(captureException).toHaveBeenCalledTimes(scenario === 'unexpected' ? 1 : 0);
				if (scenario === 'unexpected')
					expect(captureException).toHaveBeenCalledWith(
						expect.objectContaining({ message: 'fixture observation defect' }),
						{ operation: 'grokStorage:observeNativeSource' }
					);
			}
		);

		it.each(['account', 'pool', 'file', 'duplicate', 'target'])(
			'rechecks changed %s before and after reading',
			async (scenario) => {
				for (const duringRead of [false, true]) {
					vi.clearAllMocks();
					const f = scopedRemote();
					const mutate = () => {
						if (scenario === 'duplicate') {
							f.directories.get(f.sessionsDir)!.push(...f.directories.get(f.sessionsDir)!);
						} else {
							const key =
								scenario === 'account' ? account : scenario === 'pool' ? f.sessionsDir : f.file;
							f.identities.set(key, {
								...f.identities.get(key)!,
								...(scenario === 'target' ? { canonicalPath: `${key}-changed` } : { inode: '777' }),
							});
						}
					};
					if (duringRead) {
						const read = vi.mocked(remoteFs.readFileRemote).getMockImplementation()!;
						vi.mocked(remoteFs.readFileRemote).mockImplementation(async (...args) => {
							const result = await read(...args);
							mutate();
							return result;
						});
					} else {
						const stat = vi.mocked(remoteFs.statRemote).getMockImplementation()!;
						vi.mocked(remoteFs.statRemote).mockImplementation(async (...args) => {
							const result = await stat(...args);
							mutate();
							return result;
						});
					}
					const result = await f.read();
					expect(result).toMatchObject({
						messages: [],
						source: { reason: 'native-source-changed' },
					});
					expect(result.nativeSessionBinding).toBeUndefined();
					expect(remoteFs.readFileRemote).toHaveBeenCalledTimes(duringRead ? 1 : 0);
				}
			}
		);

		it.each([
			'missing',
			'wrong-inode',
			'identity-mismatch',
			'too-large',
			'invalid-encoding',
			'partial',
		])('keeps receipt separate from %s content availability', async (scenario) => {
			const f = scopedRemote();
			const observedIdentity = { ...f.identities.get(f.file)! };
			if (scenario === 'wrong-inode') observedIdentity.inode = '999';
			const proven = ['too-large', 'invalid-encoding', 'partial'].includes(scenario);
			vi.mocked(remoteFs.readFileRemote).mockResolvedValue({
				success: ['missing', 'wrong-inode', 'partial'].includes(scenario),
				data: f.files[f.file],
				observedIdentity: scenario === 'missing' ? undefined : observedIdentity,
				...(scenario === 'identity-mismatch'
					? { observedIdentity: undefined, errorCode: 'identity-mismatch' as const }
					: scenario === 'too-large' || scenario === 'invalid-encoding'
						? { errorCode: scenario }
						: { contentChanged: scenario === 'partial' }),
			});
			const result = await f.read();
			expect(result.nativeSessionBinding).toEqual(proven ? binding : undefined);
			expect(result.source?.status).toBe(scenario === 'partial' ? 'partial' : 'unavailable');
			expect(result.messages).toHaveLength(scenario === 'partial' ? 8 : 0);
			if (scenario === 'partial') {
				expect(result.messages).toMatchObject(
					chatHistoryJsonl()
						.split('\n')
						.map((raw, index) => ({
							uuid: `grok-line-${index + 1}`,
							native: { provider: 'grok', line: index + 1, raw },
						}))
				);
			}
		});
	});

	it.each(['summary.json', 'chat_history.jsonl', 'usage.json'])(
		'discloses remote %s changes or lost comparison reads with fixed stats',
		async (name) => {
			for (const disconnect of [false, true]) {
				vi.clearAllMocks();
				const { cwdDir, files } = mockRemoteSession({ accountDir: '~/selected account' });
				const file = path.posix.join(cwdDir, SESSION_ID, name);
				files[path.posix.join(cwdDir, SESSION_ID, 'usage.json')] =
					'{"session":{"inputTokens":100,"costUsdTicks":9007199254740993}}';
				const read = vi.mocked(remoteFs.readFileRemote).getMockImplementation()!;
				let samples = 0;
				vi.mocked(remoteFs.readFileRemote).mockImplementation(async (...args) => {
					if (args[0] === file && ++samples === 2) {
						if (disconnect) return { success: false, error: 'Connection reset by peer' };
						// Same length and mtime cannot hide a rewrite from the content comparison.
						files[file] = files[file]
							.replaceAll('Create', 'Update')
							.replace('9007199254740993', '9007199254740994');
					}
					return read(...args);
				});
				const [session] = await new GrokSessionStorage('~/selected account').listSessions(
					PROJECT,
					sshConfig
				);
				for (const source of Object.values(session.nativeMetadata!.sources!))
					expect(source).toMatchObject({
						status: 'partial',
						reason: 'changed-or-unavailable-during-snapshot',
					});
				expect(session).toMatchObject({
					messageCount: 3,
					firstMessage: expect.stringContaining('Create'),
					accounting: { cost: { status: 'partial', costUsdTicks: '9007199254740993' } },
				});
				expect(remoteFs.readFileRemote).toHaveBeenCalledTimes(6);
				expect(samples).toBe(2);
				// One more stat per listed session: the absent prompt_context.json.
				expect(remoteFs.statRemote).toHaveBeenCalledTimes(disconnect ? 12 : 13);
				if (disconnect)
					expect(captureException).toHaveBeenCalledExactlyOnceWith(
						expect.objectContaining({ message: 'Connection reset by peer' }),
						expect.objectContaining({ operation: 'grokStorage:readSessionFile' })
					);
				else expect(captureException).not.toHaveBeenCalled();
			}
		}
	);

	it.each(['rewrite', 'disconnect'])(
		'keeps the first transcript partial after %s and reads fresh content on reconnect',
		async (failure) => {
			const { cwdDir, files } = mockRemoteSession();
			const file = path.posix.join(cwdDir, SESSION_ID, 'chat_history.jsonl');
			const read = vi.mocked(remoteFs.readFileRemote).getMockImplementation()!;
			let samples = 0;
			vi.mocked(remoteFs.readFileRemote).mockImplementation(async (...args) => {
				if (++samples === 2) {
					files[file] = files[file].replaceAll('Create', 'Update');
					if (failure === 'disconnect')
						return { success: false, error: 'Connection reset by peer' };
				}
				return read(...args);
			});
			const storage = new GrokSessionStorage();
			const first = await storage.readSessionMessages(PROJECT, SESSION_ID, undefined, sshConfig);
			expect(first.source).toMatchObject({
				status: 'partial',
				reason: 'changed-or-unavailable-during-read',
			});
			expect(first.messages[0].content).toContain('Create');
			expect(samples).toBe(2);
			const reconnected = await storage.readSessionMessages(
				PROJECT,
				SESSION_ID,
				undefined,
				sshConfig
			);
			expect(reconnected.source?.status).toBe('available');
			expect(reconnected.messages[0].content).toContain('Update');
			expect(reconnected.messages.map((m) => m.uuid)).toEqual(first.messages.map((m) => m.uuid));
			expect(samples).toBe(4);
			if (failure === 'disconnect')
				expect(captureException).toHaveBeenCalledExactlyOnceWith(
					expect.objectContaining({ message: 'Connection reset by peer' }),
					expect.objectContaining({ operation: 'grokStorage:readSessionFile' })
				);
			else expect(captureException).not.toHaveBeenCalled();
		}
	);

	it('keeps the same native ID and path separate across host endpoints and generations', async () => {
		const { files } = mockRemoteSession({ accountDir: '~/shared' });
		const read = vi.mocked(remoteFs.readFileRemote).getMockImplementation()!;
		const otherHost = { ...sshConfig, host: 'other-host' }; // The saved remote ID alone is not identity.
		vi.mocked(remoteFs.readFileRemote).mockImplementation(async (...args) => {
			const result = await read(...args);
			return args[1].host === otherHost.host && result.data
				? { ...result, data: result.data.replaceAll('Create', 'Update') }
				: result;
		});
		const storage = new GrokSessionStorage('~/shared');
		const [first] = await storage.listSessions(PROJECT, sshConfig);
		const [other] = await storage.listSessions(PROJECT, otherHost);
		for (const file of Object.keys(files)) files[file] = files[file].replaceAll('Create', 'Review');
		const [later] = await storage.listSessions(PROJECT, sshConfig);
		expect([first, other, later].map((s) => [s.sessionId, s.firstMessage.slice(0, 6)])).toEqual([
			[SESSION_ID, 'Create'],
			[SESSION_ID, 'Update'],
			[SESSION_ID, 'Review'],
		]);
		expect(remoteFs.readFileRemote).toHaveBeenCalledTimes(12);
		expect(
			vi.mocked(remoteFs.readFileRemote).mock.calls.filter(([, host]) => host === otherHost)
		).toHaveLength(4);
		expect(captureException).not.toHaveBeenCalled();
	});

	it.each([
		['summary.json', 0],
		['summary.json', 1],
		['usage.json', 0],
		['usage.json', 1],
	] as const)('bounds remote %s at the metadata byte cap plus %s', async (name, overflow) => {
		const { cwdDir, files } = mockRemoteSession();
		const file = path.posix.join(cwdDir, SESSION_ID, name);
		const maxBytes = 1024 * 1024;
		const content = name === 'summary.json' ? files[file] : '{"session":{"inputTokens":1}}';
		files[file] = content.padEnd(maxBytes + overflow, ' ');
		const [session] = await new GrokSessionStorage().listSessions(PROJECT, sshConfig);
		expect(session.nativeMetadata?.sources?.[name]).toMatchObject({
			status: overflow ? 'unavailable' : 'partial',
			sizeBytes: maxBytes + overflow,
			maxBytes,
		});
		if (overflow) {
			expect(session.nativeMetadata?.sources?.[name]?.reason).toBe('too-large');
			expect(vi.mocked(remoteFs.readFileRemote).mock.calls.map(([p]) => p)).not.toContain(file);
			if (name === 'usage.json') expect(session.accounting?.cost.status).toBe('unknown');
		} else {
			expect(remoteFs.readFileRemote).toHaveBeenCalledWith(file, sshConfig, undefined, {
				maxBytes,
			});
		}
		expect(captureException).not.toHaveBeenCalled();
	});

	it('accepts a remote transcript exactly at the byte cap', async () => {
		const { cwdDir, files } = mockRemoteSession();
		const file = path.posix.join(cwdDir, SESSION_ID, 'chat_history.jsonl');
		const maxBytes = 64 * 1024 * 1024;
		files[file] = '{"type":"user","content":"at cap"}'.padEnd(maxBytes, ' ');
		const result = await new GrokSessionStorage().readSessionMessages(
			PROJECT,
			SESSION_ID,
			undefined,
			sshConfig
		);
		expect(result).toMatchObject({
			total: 1,
			messages: [{ content: 'at cap' }],
			source: { status: 'available', sizeBytes: maxBytes, maxBytes },
		});
		expect(remoteFs.readFileRemote).toHaveBeenCalledWith(file, sshConfig, undefined, { maxBytes });
		expect(captureException).not.toHaveBeenCalled();
	});

	it.each([
		['empty', 'available', undefined, 0],
		['unreadable', 'unavailable', 'unreadable', 0],
		['missing-post-stat', 'partial', 'post-read-stat-unavailable', 3],
		['disconnect-post-stat', 'partial', 'post-read-stat-unavailable', 3],
		['helper-overflow', 'unavailable', 'too-large', 0],
		['output-overflow', 'unavailable', 'too-large', 0],
		['post-stat-overflow', 'unavailable', 'too-large', 0],
	] as const)('preserves remote source provenance for %s', async (mode, status, reason, total) => {
		const { cwdDir, files } = mockRemoteSession();
		const file = path.posix.join(cwdDir, SESSION_ID, 'chat_history.jsonl');
		const maxBytes = 64 * 1024 * 1024;
		if (mode === 'empty') files[file] = '';
		const stat = vi.mocked(remoteFs.statRemote).getMockImplementation()!;
		let stats = 0;
		vi.mocked(remoteFs.statRemote).mockImplementation(async (...args) => {
			const result = await stat(...args);
			if (args[0] === file && ++stats === 2) {
				if (mode === 'missing-post-stat' || mode === 'disconnect-post-stat') {
					return {
						success: false,
						error: mode === 'missing-post-stat' ? 'No such file' : 'ssh connection reset',
					};
				}
				if (mode === 'post-stat-overflow') result.data!.size = maxBytes + 20;
			}
			return result;
		});
		const read = vi.mocked(remoteFs.readFileRemote).getMockImplementation()!;
		vi.mocked(remoteFs.readFileRemote).mockImplementation(async (...args) => {
			if (args[0] === file) {
				if (mode === 'unreadable') return { success: false, error: 'Permission denied' };
				if (mode === 'helper-overflow')
					return { success: false, errorCode: 'too-large' as const, error: 'read limit' };
				if (mode === 'output-overflow') return { success: true, data: ' '.repeat(maxBytes + 20) };
			}
			return read(...args);
		});
		const result = await new GrokSessionStorage().readSessionMessages(
			PROJECT,
			SESSION_ID,
			undefined,
			sshConfig
		);
		expect(result).toMatchObject({ total, source: { status, maxBytes } });
		expect(result.source?.reason).toBe(reason);
		if (total === 0) expect(result).toMatchObject({ messages: [], hasMore: false });
		expect(remoteFs.readFileRemote).toHaveBeenCalledWith(file, sshConfig, undefined, { maxBytes });
		if (mode === 'disconnect-post-stat') {
			expect(captureException).toHaveBeenCalledWith(
				expect.objectContaining({ message: 'ssh connection reset' }),
				{ operation: 'grokStorage:statSessionFile', filePath: file }
			);
		} else expect(captureException).not.toHaveBeenCalled();
	});

	it.each(['chat_history.jsonl', 'summary.json', 'usage.json'] as const)(
		'keeps remote %s unavailable when the byte transport rejects its encoding',
		async (name) => {
			const accountDir = "~/Grok accounts/O'Brien/研究";
			const { cwdDir, files } = mockRemoteSession({ accountDir });
			const file = path.posix.join(cwdDir, SESSION_ID, name);
			// Phase 03's first-turn ledger would supply exact accounting if accepted.
			const totals = {
				inputTokens: 100,
				outputTokens: 20,
				cachedReadTokens: 30,
				cacheCreationTokens: 10,
				reasoningTokens: 5,
				costUsdTicks: '9007199254740993',
			};
			files[path.posix.join(cwdDir, SESSION_ID, 'usage.json')] = JSON.stringify({
				session: { ...totals, modelUsage: { 'grok-fixture': totals } },
			}).replace(/"costUsdTicks":"(\d+)"/g, '"costUsdTicks":$1');
			const read = vi.mocked(remoteFs.readFileRemote).getMockImplementation()!;
			vi.mocked(remoteFs.readFileRemote).mockImplementation(async (...args) =>
				args[0] === file
					? {
							success: false,
							errorCode: 'invalid-encoding',
							error: `File is not valid UTF-8: ${file}`,
						}
					: read(...args)
			);
			const storage = new GrokSessionStorage(accountDir);
			const sessions = await storage.listSessions(PROJECT, sshConfig);
			const messages = await storage.readSessionMessages(PROJECT, SESSION_ID, undefined, sshConfig);
			const provenance = {
				provider: 'grok',
				status: 'unavailable',
				reason: 'invalid-encoding',
				sizeBytes: Buffer.byteLength(files[file]),
				maxBytes: (name === 'chat_history.jsonl' ? 64 : 1) * 1024 * 1024,
			};
			if (name === 'chat_history.jsonl') {
				expect(sessions).toEqual([]);
				expect(messages).toEqual({ messages: [], total: 0, hasMore: false, source: provenance });
				const native = await storage.readSessionMessages(
					PROJECT,
					SESSION_ID,
					{ includeNativeRecords: true },
					sshConfig
				);
				expect(native).toEqual(messages);
			} else {
				expect(sessions).toHaveLength(1);
				const [session] = sessions;
				expect(session).toMatchObject({
					sessionId: SESSION_ID,
					projectPath: PROJECT,
					messageCount: 3,
				});
				expect(session.nativeMetadata?.sources?.[name]).toEqual(provenance);
				expect(messages).toMatchObject({ total: 3, source: { status: 'available' } });
				if (name === 'summary.json') {
					expect(session.nativeMetadata?.summaryStatus).toBe('unavailable');
					expect(session.nativeMetadata?.summary).toBeUndefined();
					expect(session.sessionName).toBeUndefined();
					expect(session).toMatchObject({ timestamp: '', modifiedAt: '', durationSeconds: 0 });
					// Only the failed source is discarded; the independent valid ledger survives.
					expect(session.accounting?.cost).toEqual({
						status: 'partial',
						costUsdTicks: '9007199254740993',
						reason: 'changed-or-unavailable-during-snapshot',
					});
				} else {
					expect(session.nativeMetadata?.summaryStatus).toBe('available');
					expect(session.accounting).toMatchObject({
						source: 'none',
						completeness: 'unknown',
						cost: { status: 'unknown' },
						providerSessionId: SESSION_ID,
					});
					expect(session.costUsd).toBeUndefined();
					expect(session.byModel).toBeUndefined();
					expect(session.accounting?.models).toBeUndefined();
					expect(session.reasoningTokens).toBeUndefined();
				}
			}
			expect(remoteFs.readFileRemote).toHaveBeenCalledWith(file, sshConfig, undefined, {
				maxBytes: provenance.maxBytes,
			});
			expect(captureException).not.toHaveBeenCalled();
		}
	);

	it.each([undefined, '', ' \t ', '/srv/Grok accounts/研究', "~/O'Brien/研究", '~'])(
		'keeps all remote operations scoped to account %j, ignoring the local environment',
		async (accountDir) => {
			process.env.GROK_HOME = path.resolve('src/__tests__/fixtures/grok-accounts/local-decoy');
			const cwd = "/remote/研究/O'Brien project";
			const root = accountDir?.trim() || '~/.grok';
			const { sessionsDir, cwdDir } = mockRemoteSession({ accountDir: root, cwd });
			const storage = new GrokSessionStorage();
			const sessions = await storage.listSessions(cwd, sshConfig, accountDir);
			expect(sessions).toEqual([
				expect.objectContaining({ sessionId: SESSION_ID, projectPath: cwd }),
			]);
			expect(
				await storage.listSessionsPaginated(cwd, { configDir: accountDir }, sshConfig)
			).toMatchObject({ sessions, totalCount: 1 });
			expect(
				await storage.readSessionMessages(cwd, SESSION_ID, { configDir: accountDir }, sshConfig)
			).toMatchObject({ total: 3 });
			expect(
				await storage.searchSessions(cwd, 'Created', 'assistant', sshConfig, accountDir)
			).toEqual([expect.objectContaining({ sessionId: SESSION_ID, matchType: 'assistant' })]);
			expect(storage.getSessionPath(cwd, SESSION_ID, sshConfig, accountDir)).toBe(
				path.posix.join(cwdDir, SESSION_ID, 'chat_history.jsonl')
			);
			for (const [file, config] of [
				...vi.mocked(remoteFs.readDirRemote).mock.calls,
				...vi.mocked(remoteFs.readFileRemote).mock.calls,
				...vi.mocked(remoteFs.statRemote).mock.calls,
			]) {
				expect(file === sessionsDir || file.startsWith(sessionsDir + '/')).toBe(true);
				expect(config).toBe(sshConfig);
			}
		}
	);

	it('does not fall back to available default history when the chosen remote account is absent', async () => {
		mockRemoteSession();
		const storage = new GrokSessionStorage('~/missing account');
		expect(await storage.listSessions(PROJECT, sshConfig)).toEqual([]);
		expect(await storage.readSessionMessages(PROJECT, SESSION_ID, undefined, sshConfig)).toEqual({
			messages: [],
			total: 0,
			hasMore: false,
			source: { provider: 'grok', status: 'unavailable', reason: 'session-not-found' },
		});
		expect(await storage.searchSessions(PROJECT, 'Created', 'all', sshConfig)).toEqual([]);
		expect(remoteFs.readFileRemote).not.toHaveBeenCalled();
		expect(remoteFs.statRemote).not.toHaveBeenCalled();
		for (const [dir] of vi.mocked(remoteFs.readDirRemote).mock.calls) {
			expect(dir).toBe('~/missing account/sessions');
		}
		expect(captureException).not.toHaveBeenCalled();
	});

	it('rejects malformed cwd folders before joins, retaining lowercase encoded slashes and descendants', async () => {
		const cwd = '/remote/project/sub';
		const fixture = mockRemoteSession({ cwd });
		const valid = encodeURIComponent(cwd).replace(/%2F/g, '%2f');
		fixture.directories.set(
			path.posix.join(fixture.sessionsDir, valid),
			fixture.directories.get(fixture.cwdDir)!
		);
		for (const [file, content] of Object.entries(fixture.files)) {
			fixture.files[file.replace(encodeURIComponent(cwd), valid)] = content;
		}
		const rejected = [
			'',
			'.',
			'..',
			'raw/slash',
			'raw\\slash',
			'\0',
			'%',
			'%2',
			'%GG',
			'%C0%AF',
			'%ED%A0%80',
			'%2Fremote%2Fproject%2F..%2Foutside',
			'%2Fremote%2Fproject%2F.%2Fsub',
			'%2Fremote%2Fproject%5C..%5Coutside',
			'%2Fremote%2Fproject%00',
			encodeURIComponent('/remote/project-sibling'),
		];
		fixture.directories.set(
			fixture.sessionsDir,
			[...rejected, valid].map((name) => ({
				name,
				isDirectory: true,
				isSymlink: false,
			}))
		);
		const storage = new GrokSessionStorage();
		expect(await storage.listSessions('/remote/project/', sshConfig)).toEqual([
			expect.objectContaining({ sessionId: SESSION_ID, projectPath: cwd }),
		]);
		expect(
			await storage.readSessionMessages('/remote/project', SESSION_ID, undefined, sshConfig)
		).toMatchObject({ total: 3 });
		for (const [dir] of vi.mocked(remoteFs.readDirRemote).mock.calls) {
			expect([fixture.sessionsDir, path.posix.join(fixture.sessionsDir, valid)]).toContain(dir);
		}
		for (const [file] of [
			...vi.mocked(remoteFs.readFileRemote).mock.calls,
			...vi.mocked(remoteFs.statRemote).mock.calls,
		]) {
			expect(file.startsWith(path.posix.join(fixture.sessionsDir, valid, SESSION_ID) + '/')).toBe(
				true
			);
		}
		expect(captureException).not.toHaveBeenCalled();
	});

	it('filters traversal entries but retains opaque IDs and directory identity when summaries disagree', async () => {
		const ids = ['not-a-uuid', 'native..id', '%2F..%2Fopaque'];
		const fixture = mockRemoteSession({ ids });
		fixture.directories.get(fixture.cwdDir)!.push(
			...['', '.', '..', '../outside', 'nested/id', 'nested\\id', 'bad\0id'].map((name) => ({
				name,
				isDirectory: true,
				isSymlink: false,
			}))
		);
		for (const id of ids)
			fixture.files[path.posix.join(fixture.cwdDir, id, 'summary.json')] = summaryJson(
				'../redirected',
				OTHER_PROJECT
			);
		const storage = new GrokSessionStorage();
		expect(await storage.listSessions(PROJECT, sshConfig)).toEqual(
			ids.map((sessionId) => expect.objectContaining({ sessionId, projectPath: PROJECT }))
		);
		expect(
			(await storage.searchSessions(PROJECT, 'Created', 'assistant', sshConfig)).map(
				(s) => s.sessionId
			)
		).toEqual(ids);
		for (const id of ids) {
			expect(await storage.readSessionMessages(PROJECT, id, undefined, sshConfig)).toMatchObject({
				total: 3,
			});
			expect(storage.getSessionPath(PROJECT, id, sshConfig)).toBe(
				path.posix.join(fixture.cwdDir, id, 'chat_history.jsonl')
			);
		}
		for (const [file] of [
			...vi.mocked(remoteFs.readFileRemote).mock.calls,
			...vi.mocked(remoteFs.statRemote).mock.calls,
		]) {
			expect(
				Object.keys(fixture.files).includes(file) ||
					ids.some((id) =>
						['usage.json', 'prompt_context.json'].some(
							(name) => file === path.posix.join(fixture.cwdDir, id, name)
						)
					)
			).toBe(true);
		}
	});

	it.each(['/var/project', '/tmp/project', '/etc/project'])(
		'keeps remote %s distinct from /private while accepting POSIX root descendants',
		async (cwd) => {
			mockRemoteSession({ cwd: `/private${cwd}` });
			const storage = new GrokSessionStorage();
			expect(await storage.listSessions(cwd, sshConfig)).toEqual([]);
			expect(remoteFs.readFileRemote).not.toHaveBeenCalled();
			expect(await storage.listSessions(`/private${cwd}/`, sshConfig)).toHaveLength(1);
			expect(await storage.listSessions('/', sshConfig)).toHaveLength(1);
		}
	);

	it('follows remote directory symlinks but ignores file and unresolved symlinks', async () => {
		const { directories } = mockRemoteSession();
		for (const entries of directories.values()) {
			entries[0].isSymlink = true;
			entries.push({ name: 'unresolved-link', isDirectory: false, isSymlink: true });
		}
		const storage = new GrokSessionStorage();
		expect(await storage.listSessions(PROJECT, sshConfig)).toHaveLength(1);
		expect(
			await storage.readSessionMessages(PROJECT, SESSION_ID, undefined, sshConfig)
		).toMatchObject({ total: 3 });
		for (const [file] of vi.mocked(remoteFs.readDirRemote).mock.calls)
			expect(file).not.toContain('unresolved-link');
	});

	it.each(['readDirRemote', 'statRemote', 'readFileRemote'] as const)(
		'classifies expected misses and disconnects at %s without local fallback',
		async (method) => {
			for (const error of ['No such file', 'Permission denied', 'ssh connection reset by peer']) {
				vi.clearAllMocks();
				mockRemoteSession();
				vi.mocked(remoteFs[method]).mockResolvedValue({ success: false, error });
				expect(await new GrokSessionStorage().listSessions(PROJECT, sshConfig)).toEqual([]);
				if (error.includes('connection reset')) {
					const operation = {
						readDirRemote: 'listCwdFolders',
						statRemote: 'statSessionFile',
						readFileRemote: 'readSessionFile',
					}[method];
					expect(captureException).toHaveBeenCalledWith(
						expect.objectContaining({ message: error }),
						expect.objectContaining({ operation: `grokStorage:${operation}` })
					);
					if (method === 'readDirRemote') {
						expect(logger.warn).toHaveBeenCalledWith(
							expect.stringContaining(error),
							'[GrokSessionStorage]'
						);
					}
				} else expect(captureException).not.toHaveBeenCalled();
				expect(fs.readdir).not.toHaveBeenCalled();
				expect(fs.open).not.toHaveBeenCalled();
				expect(fs.readFile).not.toHaveBeenCalled();
				expect(fs.stat).not.toHaveBeenCalled();
				expect(execFileNoThrow).not.toHaveBeenCalled();
			}
		}
	);

	it('bounds concurrent remote reads and drains every session without dropping results', async () => {
		vi.useFakeTimers();
		const ids = Array.from(
			{ length: REMOTE_SESSION_READ_CONCURRENCY * 3 + 1 },
			(_, i) => `native-${i}`
		);
		mockRemoteSession({ ids });
		const read = vi.mocked(remoteFs.readFileRemote).getMockImplementation()!;
		let active = 0;
		let peak = 0;
		vi.mocked(remoteFs.readFileRemote).mockImplementation(async (...args) => {
			active++;
			peak = Math.max(peak, active);
			try {
				await new Promise((resolve) => setTimeout(resolve, 1));
				return await read(...args);
			} finally {
				active--;
			}
		});
		const result = new GrokSessionStorage().listSessions(PROJECT, sshConfig);
		await vi.runAllTimersAsync();
		expect((await result).map((s) => s.sessionId)).toEqual(ids);
		expect(peak).toBeGreaterThan(1);
		expect(peak).toBeLessThanOrEqual(REMOTE_SESSION_READ_CONCURRENCY);
		expect(active).toBe(0);
		expect(remoteFs.statRemote).toHaveBeenCalledTimes(ids.length * 11);
		expect(remoteFs.readFileRemote).toHaveBeenCalledTimes(ids.length * 4);
	});

	it.each([
		[
			"/srv/O'Brien/研究 $cash;$(probe)",
			"'/srv/O'\\''Brien/研究 $cash;$(probe)'",
			'native $(probe);id',
		],
		[
			"~/O'Brien/研究 $cash;$(probe)",
			'"$HOME/O\'Brien/研究 \\$cash;\\$(probe)"',
			'native \\$(probe);id',
		],
	])(
		'quotes every path passed to the real remote-fs transport for %s',
		async (accountDir, escapedRoot, escapedId) => {
			const actual = await vi.importActual<typeof remoteFs>('../../../main/utils/remote-fs');
			const id = 'native $(probe);id';
			const cwd = '/remote/研究 project';
			const encoded = encodeURIComponent(cwd);
			// These shell tokens are independently specified, never produced by the escaper under test.
			const commands = new Map<string, string | undefined>();
			for (const [suffix, stdout] of [
				['sessions', `${encoded}/\n__SYMDIR__\n`],
				[`sessions/${encoded}`, `${id}@\n__SYMDIR__\n${id}\n`],
				[`sessions/${encoded}/${escapedId}/summary.json`, summaryJson(id, cwd)],
				[`sessions/${encoded}/${escapedId}/chat_history.jsonl`, chatHistoryJsonl()],
				[`sessions/${encoded}/${escapedId}/usage.json`, undefined],
				[`sessions/${encoded}/${escapedId}/prompt_context.json`, undefined],
			] as const) {
				const token = `${escapedRoot.slice(0, -1)}/${suffix}${escapedRoot.slice(-1)}`;
				if (!suffix.includes(escapedId)) {
					commands.set(
						`ls -1AF --color=never ${token} 2>/dev/null || echo "__LS_ERROR__"; echo "__SYMDIR__"; find ${token} -mindepth 1 -maxdepth 1 -type l -exec test -d {} \\; -exec basename {} \\; 2>/dev/null`,
						stdout
					);
				} else {
					const maxBytes = suffix.endsWith('chat_history.jsonl') ? 64 * 1024 * 1024 : 1024 * 1024;
					commands.set(
						`if test -f ${token}; then { head -c ${maxBytes + 1} < ${token}; ` +
							`printf '\\n%s' "$?"; } | base64; ` +
							`else echo 'File not found or not a regular file' >&2; exit 1; fi`,
						stdout === undefined
							? undefined
							: Buffer.from(`${stdout}\n0`, 'utf8').toString('base64')
					);
					commands.set(
						`stat --printf='%s\\n%F\\n%Y' ${token} 2>/dev/null || stat -f $'%z\\n%HT\\n%m' ${token}`,
						stdout === undefined
							? undefined
							: `${Buffer.byteLength(stdout)}\nregular file\n1752082000`
					);
				}
			}
			const deps: remoteFs.RemoteFsDeps = {
				buildSshArgs: () => ['fixture@host'],
				execSsh: vi.fn(async (binary, args) => {
					expect(binary).toBe('ssh-fixture');
					expect(args).toHaveLength(2);
					expect(args[0]).toBe('fixture@host');
					expect(commands.has(args[1])).toBe(true);
					const stdout = commands.get(args[1]);
					return {
						stdout: stdout ?? '',
						stderr: stdout === undefined ? 'No such file' : '',
						exitCode: stdout === undefined ? 1 : 0,
					};
				}),
			};
			vi.mocked(remoteFs.readDirRemote).mockImplementation((file, config) =>
				actual.readDirRemote(file, config, deps)
			);
			vi.mocked(remoteFs.readFileRemote).mockImplementation((file, config, _deps, options) =>
				actual.readFileRemote(file, config, deps, options)
			);
			vi.mocked(remoteFs.statRemote).mockImplementation((file, config) =>
				actual.statRemote(file, config, deps)
			);
			expect(await new GrokSessionStorage(accountDir).listSessions(cwd, sshConfig)).toEqual([
				expect.objectContaining({ sessionId: id, projectPath: cwd, messageCount: 3 }),
			]);
			expect(deps.execSsh).toHaveBeenCalledTimes(17);
			expect(captureException).not.toHaveBeenCalled();
		}
	);

	it('lists and reads sessions on a remote host via remote-fs', async () => {
		mockRemoteSession();

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT, sshConfig);

		expect(sessions).toHaveLength(1);
		expect(sessions[0].sessionId).toBe(SESSION_ID);
		// No local fs access on the remote path.
		expect(vi.mocked(fs.readdir)).not.toHaveBeenCalled();
		expect(vi.mocked(fs.readFile)).not.toHaveBeenCalled();

		const result = await storage.readSessionMessages(PROJECT, SESSION_ID, undefined, sshConfig);
		expect(result.total).toBe(3);
		expect(result.messages[0].content).toBe(
			'Create a file named hello.txt containing the word hello, then read it back'
		);
	});

	it('returns an empty list when the remote sessions directory does not exist, without reporting', async () => {
		vi.mocked(remoteFs.readDirRemote).mockResolvedValue({
			success: false,
			error: 'Directory not found or not accessible',
		});

		const storage = new GrokSessionStorage();
		const sessions = await storage.listSessions(PROJECT, sshConfig);

		expect(sessions).toEqual([]);
		expect(vi.mocked(remoteFs.readFileRemote)).not.toHaveBeenCalled();
		expect(vi.mocked(captureException)).not.toHaveBeenCalled();
	});

	it('reports unexpected remote stat failures to Sentry when reading messages', async () => {
		vi.mocked(remoteFs.readDirRemote).mockImplementation(async (dirPath: string) => {
			if (dirPath === '~/.grok/sessions') {
				return {
					success: true,
					data: [{ name: encodedProject, isDirectory: true, isSymlink: false }],
				};
			}
			if (dirPath === `~/.grok/sessions/${encodedProject}`) {
				return {
					success: true,
					data: [{ name: SESSION_ID, isDirectory: true, isSymlink: false }],
				};
			}
			return { success: false, error: 'Directory not found or not accessible' };
		});
		vi.mocked(remoteFs.readFileRemote).mockImplementation(async (filePath: string) => {
			if (filePath.endsWith('/summary.json')) {
				return { success: true, data: summaryJson(SESSION_ID, PROJECT) };
			}
			return { success: false, error: 'No such file' };
		});
		vi.mocked(remoteFs.statRemote).mockResolvedValue({
			success: false,
			error: 'ssh connection reset by peer',
		});

		const storage = new GrokSessionStorage();
		const result = await storage.readSessionMessages(PROJECT, SESSION_ID, undefined, sshConfig);

		expect(result).toMatchObject({
			messages: [],
			total: 0,
			hasMore: false,
			source: { provider: 'grok', status: 'unavailable', reason: 'unreadable' },
		});
		expect(vi.mocked(captureException)).toHaveBeenCalledWith(
			expect.objectContaining({ message: expect.stringContaining('connection reset') }),
			expect.objectContaining({ operation: 'grokStorage:statSessionFile' })
		);
	});
});

describe('GrokSessionStorage - misc contract', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('native history mutation refusal', () => {
		afterEach(() => {
			for (const mutation of [fs.writeFile, fs.appendFile, fs.rename, fs.unlink, fs.rm, fs.mkdir])
				expect(mutation).not.toHaveBeenCalled();
			for (const operation of Object.values(remoteFs)) expect(operation).not.toHaveBeenCalled();
			expect(execFileNoThrow).not.toHaveBeenCalled();
			vi.restoreAllMocks();
		});

		it.each([undefined, sshConfig, { ...sshConfig, host: 'replacement-host', port: 2222 }])(
			'refuses colliding account IDs before any file or host access: %j',
			async (remote) => {
				for (const account of ['alpha', 'beta']) {
					const root = remote
						? `~/fixture accounts/${account}`
						: path.resolve('src/__tests__/fixtures/grok-accounts', account);
					const storage = new GrokSessionStorage(root);
					const result = await storage.deleteMessagePair(
						PROJECT,
						SESSION_ID,
						'grok-line-3',
						'same fallback text in both accounts',
						remote
					);
					expect(result).toEqual({
						success: false,
						error: expect.stringContaining('not supported'),
					});
					expect(result.error).toContain('verified native transaction');
					expect(result.error).toContain('History is unchanged');
				}
				for (const operation of Object.values(fs))
					if (vi.isMockFunction(operation)) expect(operation).not.toHaveBeenCalled();
			}
		);

		it.each(['', '..', '../other-account', 'nested/id', 'nested\\id', '%2F..%2F', '\0'])(
			'refuses malformed identifiers without parsing fallback content: %j',
			async (id) => {
				const storage = new GrokSessionStorage();
				const result = await storage.deleteMessagePair(
					PROJECT,
					id,
					id,
					'{"type":"user","content":"delete matching text"}',
					sshConfig
				);
				expect(result).toEqual({ success: false, error: expect.stringContaining('not supported') });
				for (const operation of Object.values(fs))
					if (vi.isMockFunction(operation)) expect(operation).not.toHaveBeenCalled();
			}
		);

		it('preserves a concurrent writer generation and both accounts when reloaded after refusal', async () => {
			const roots = ['alpha', 'beta'].map((name) =>
				path.resolve('src/__tests__/fixtures/grok-accounts', name)
			);
			const files: Record<string, string> = {};
			for (const root of roots) {
				const dir = path.join(root, 'sessions', encodeURIComponent(PROJECT), SESSION_ID);
				Object.assign(
					files,
					sessionFiles(
						PROJECT,
						SESSION_ID,
						summaryJson(SESSION_ID, PROJECT),
						chatHistoryJsonl(),
						path.join(root, 'sessions')
					)
				);
				files[path.join(dir, 'usage.json')] = '{"session":{"inputTokens":8,"outputTokens":3}}';
				files[path.join(dir, 'events.jsonl')] = '{"event":"native-writer-owned"}\n';
				files[path.join(root, 'session_search.sqlite')] = 'opaque native index fixture';
			}
			const fixture = mockLocalFs(files);
			const storage = new GrokSessionStorage(roots[0]);
			const before = await storage.readSessionMessages(PROJECT, SESSION_ID);
			vi.clearAllMocks();
			const pending = storage.deleteMessagePair(PROJECT, SESSION_ID, before.messages[0].uuid!);
			// The native writer replaces its transcript before the caller observes refusal.
			const transcript = path.join(
				roots[0],
				'sessions',
				encodeURIComponent(PROJECT),
				SESSION_ID,
				'chat_history.jsonl'
			);
			files[transcript] += '\n{"type":"user","content":"writer successor"}';
			fixture.identities.get(transcript)!.ino++;
			const successor = { ...files };
			expect(await pending).toMatchObject({
				success: false,
				error: expect.stringContaining('unchanged'),
			});
			for (const operation of Object.values(fs))
				if (vi.isMockFunction(operation)) expect(operation).not.toHaveBeenCalled();
			const reloaded = new GrokSessionStorage(roots[0]);
			const after = await reloaded.readSessionMessages(PROJECT, SESSION_ID);
			expect(after.messages.slice(0, -1)).toEqual(before.messages);
			expect(after.messages.at(-1)?.content).toBe('writer successor');
			expect(
				(await new GrokSessionStorage(roots[1]).readSessionMessages(PROJECT, SESSION_ID)).messages
			).toEqual(before.messages);
			expect(files).toEqual(successor);
		});
	});

	it('getSessionPath returns the encoded-cwd transcript path guess', async () => {
		const storage = new GrokSessionStorage();
		const sessionPath = storage.getSessionPath(PROJECT, SESSION_ID);

		expect(sessionPath).toBe(
			path.join(SESSIONS_DIR, encodeURIComponent(PROJECT), SESSION_ID, 'chat_history.jsonl')
		);
	});

	describe('getSessionPath symlink-prefix handling', () => {
		const originalPlatform = process.platform;

		function setPlatform(value: string) {
			Object.defineProperty(process, 'platform', { value, configurable: true });
		}

		afterEach(() => {
			setPlatform(originalPlatform);
		});

		it('expands macOS /var|/tmp|/etc to the /private realpath form Grok records', () => {
			setPlatform('darwin');
			const storage = new GrokSessionStorage();

			expect(storage.getSessionPath('/tmp/grok-test', SESSION_ID)).toBe(
				path.join(
					SESSIONS_DIR,
					encodeURIComponent('/private/tmp/grok-test'),
					SESSION_ID,
					'chat_history.jsonl'
				)
			);
			expect(storage.getSessionPath('/var/folders/x/T', SESSION_ID)).toBe(
				path.join(
					SESSIONS_DIR,
					encodeURIComponent('/private/var/folders/x/T'),
					SESSION_ID,
					'chat_history.jsonl'
				)
			);
			// Already-realpath'd input passes through unchanged.
			expect(storage.getSessionPath('/private/tmp/grok-test', SESSION_ID)).toBe(
				path.join(
					SESSIONS_DIR,
					encodeURIComponent('/private/tmp/grok-test'),
					SESSION_ID,
					'chat_history.jsonl'
				)
			);
			// Trailing slashes are stripped before encoding.
			expect(storage.getSessionPath('/tmp/grok-test/', SESSION_ID)).toBe(
				path.join(
					SESSIONS_DIR,
					encodeURIComponent('/private/tmp/grok-test'),
					SESSION_ID,
					'chat_history.jsonl'
				)
			);
		});

		it('leaves /var paths untouched on Linux, where /var is a real directory', () => {
			setPlatform('linux');
			const storage = new GrokSessionStorage();

			expect(storage.getSessionPath('/var/www/app', SESSION_ID)).toBe(
				path.join(
					SESSIONS_DIR,
					encodeURIComponent('/var/www/app'),
					SESSION_ID,
					'chat_history.jsonl'
				)
			);
		});

		it('leaves remote paths untouched regardless of the local platform', () => {
			setPlatform('darwin');
			const storage = new GrokSessionStorage();

			expect(storage.getSessionPath('/tmp/remote-proj', SESSION_ID, sshConfig)).toBe(
				path.posix.join(
					'~/.grok/sessions',
					encodeURIComponent('/tmp/remote-proj'),
					SESSION_ID,
					'chat_history.jsonl'
				)
			);
		});
	});

	it.each(['', '.', '..', '../other-project', 'foo/bar', 'foo\\bar', 'bad\0id'])(
		'rejects unsafe session ID %j before any local or remote filesystem access',
		async (id) => {
			const storage = new GrokSessionStorage();
			for (const config of [undefined, sshConfig]) {
				expect(storage.getSessionPath(PROJECT, id, config)).toBeNull();
				expect(await storage.readSessionMessages(PROJECT, id, undefined, config)).toEqual({
					messages: [],
					total: 0,
					hasMore: false,
					source: { provider: 'grok', status: 'unavailable', reason: 'session-not-found' },
				});
			}
			for (const operation of [
				fs.readdir,
				fs.readFile,
				fs.open,
				fs.stat,
				remoteFs.readDirRemote,
				remoteFs.readFileRemote,
				remoteFs.statRemote,
			])
				expect(operation).not.toHaveBeenCalled();
		}
	);

	it.each(['/project/../other', '/project/./child', '/project\0', '/project/\ud800'])(
		'refuses malformed project path guesses: %j',
		(cwd) => {
			for (const config of [undefined, sshConfig]) {
				expect(new GrokSessionStorage().getSessionPath(cwd, SESSION_ID, config)).toBeNull();
			}
		}
	);

	it('getSessionPath honors GROK_HOME for the local sessions root', () => {
		const accountDir = path.resolve('src', '__tests__', 'fixtures', 'grok-accounts', 'custom');
		process.env.GROK_HOME = accountDir;
		const storage = new GrokSessionStorage();
		expect(storage.getSessionPath(PROJECT, SESSION_ID)).toBe(
			path.join(
				accountDir,
				'sessions',
				encodeURIComponent(PROJECT),
				SESSION_ID,
				'chat_history.jsonl'
			)
		);
	});
});

describe('GrokSessionStorage - bounded local reads', () => {
	const account = path.resolve('src/__tests__/fixtures/grok-accounts/bounded');
	const sessionsDir = path.join(account, 'sessions');
	const sessionDir = path.join(sessionsDir, encodeURIComponent(PROJECT), SESSION_ID);
	const transcript = path.join(sessionDir, 'chat_history.jsonl');
	const transcriptCap = 64 * 1024 * 1024;
	const metadataCap = 1024 * 1024;
	let files: Record<string, string>;
	let storage: GrokSessionStorage;

	beforeEach(() => {
		vi.clearAllMocks();
		files = sessionFiles(PROJECT, SESSION_ID, '{}', chatHistoryJsonl(), sessionsDir);
		files[path.join(sessionDir, 'usage.json')] = '{"session":{}}';
		mockLocalFs(files);
		storage = new GrokSessionStorage(account);
	});
	afterEach(async () => {
		for (const [file] of [
			...vi.mocked(fs.readdir).mock.calls,
			...vi.mocked(fs.stat).mock.calls,
			...vi.mocked(fs.open).mock.calls,
		])
			expect(String(file).startsWith(sessionsDir + path.sep) || file === sessionsDir).toBe(true);
		const opened = await Promise.allSettled(vi.mocked(fs.open).mock.results.map((r) => r.value));
		for (const result of opened)
			if (result.status === 'fulfilled')
				expect(result.value.close).toHaveBeenCalledExactlyOnceWith();
		expect(fs.readFile).not.toHaveBeenCalled();
		expect(remoteFs.readFileRemote).not.toHaveBeenCalled();
		expect(execFileNoThrow).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});

	it.each(['chat_history.jsonl', 'summary.json', 'usage.json'])(
		'accepts exactly the byte cap for %s, including multibyte text',
		async (name) => {
			const cap = name === 'chat_history.jsonl' ? transcriptCap : metadataCap;
			const file = path.join(sessionDir, name);
			const text =
				name === 'chat_history.jsonl'
					? '{"type":"user","content":"é"}'
					: name === 'summary.json'
						? '{"generated_title":"é"}'
						: '{"session":{},"note":"é"}';
			files[file] = text + ' '.repeat(cap - Buffer.byteLength(text));
			const [session] = await storage.listSessions(PROJECT);
			expect(session.nativeMetadata?.sources?.[name]).toEqual({
				provider: 'grok',
				status: 'partial',
				reason: 'cross-file-generation-unverified',
				sizeBytes: cap,
				maxBytes: cap,
			});
			expect(session.messageCount).toBe(name === 'chat_history.jsonl' ? 1 : 3);
			if (name === 'summary.json') expect(session.sessionName).toBe('é');
			expect(captureException).not.toHaveBeenCalled();
		}
	);

	it.each(['summary.json', 'usage.json'])(
		'rejects oversized %s before opening it',
		async (name) => {
			const file = path.join(sessionDir, name);
			mockLocalFs(files, { sizeOverrides: { [file]: metadataCap + 1 } });
			const [session] = await storage.listSessions(PROJECT);
			expect(session.messageCount).toBe(3);
			expect(session.nativeMetadata?.sources?.[name]).toMatchObject({
				status: 'unavailable',
				reason: 'too-large',
				maxBytes: metadataCap,
			});
			expect(vi.mocked(fs.open).mock.calls.map(([opened]) => opened)).not.toContain(file);
			if (name === 'usage.json') {
				expect(session.accounting).toMatchObject({ source: 'none', cost: { status: 'unknown' } });
				expect(session.costUsd).toBeUndefined();
			}
			expect(captureException).not.toHaveBeenCalled();
		}
	);

	it.each(['before-open', 'opened'] as const)('rejects a special file at %s', async (stage) => {
		const stat = { size: 0, isFile: () => false };
		mockLocalFs(files, {
			onOpen: (handle) => vi.mocked(handle.stat).mockResolvedValueOnce(stat as never),
		});
		if (stage === 'before-open') vi.mocked(fs.stat).mockResolvedValueOnce(stat as never);
		expect(await storage.readSessionMessages(PROJECT, SESSION_ID)).toMatchObject({
			messages: [],
			total: 0,
			hasMore: false,
			source: { status: 'unavailable', reason: 'not-a-file' },
		});
		expect(fs.open).toHaveBeenCalledTimes(stage === 'before-open' ? 0 : 1);
		if (stage === 'opened') {
			const handle = await vi.mocked(fs.open).mock.results[0].value;
			expect(handle.read).not.toHaveBeenCalled();
			expect(fs.open).toHaveBeenCalledWith(
				transcript,
				fs.constants.O_RDONLY | fs.constants.O_NONBLOCK
			);
		}
		expect(captureException).not.toHaveBeenCalled();
	});

	it.each([
		'opened-over-cap',
		'sentinel',
		'after-read-over-cap',
		'changed-at-open',
		'changed-after-read',
	] as const)('discloses growth at %s and closes its descriptor', async (stage) => {
		const initial = await fs.stat(transcript);
		let readBytes = 0;
		mockLocalFs(files, {
			onOpen: (handle) => {
				const changed = {
					...initial,
					size: stage.includes('over-cap') ? transcriptCap + 1 : initial.size + 1,
				};
				vi.mocked(handle.stat)
					.mockResolvedValueOnce(
						(stage === 'opened-over-cap' || stage === 'changed-at-open'
							? changed
							: initial) as never
					)
					.mockResolvedValueOnce(
						(stage === 'after-read-over-cap' || stage === 'changed-after-read'
							? changed
							: initial) as never
					);
				if (stage === 'sentinel')
					vi.mocked(handle.read).mockImplementation(async (...args: unknown[]) => {
						const [buffer, , length] = args as [Buffer, number, number];
						readBytes += length;
						return { bytesRead: length, buffer };
					});
			},
		});
		const result = await storage.readSessionMessages(PROJECT, SESSION_ID, {
			includeNativeRecords: true,
		});
		const rejected = stage.includes('over-cap') || stage === 'sentinel';
		expect(result.source).toMatchObject({
			status: rejected ? 'unavailable' : 'partial',
			reason: rejected ? 'too-large' : 'changed-during-read',
		});
		expect(result.messages).toHaveLength(rejected ? 0 : 8);
		const handle = await vi.mocked(fs.open).mock.results[0].value;
		if (stage === 'opened-over-cap') expect(handle.read).not.toHaveBeenCalled();
		if (stage === 'sentinel') {
			expect(readBytes).toBe(transcriptCap + 1);
			expect(handle.read).toHaveBeenLastCalledWith(expect.any(Buffer), 0, 1, transcriptCap);
			expect(handle.stat).toHaveBeenCalledTimes(1);
		}
		expect(captureException).not.toHaveBeenCalled();
	});

	it.each(['stat', 'open', 'descriptor-stat', 'read', 'close'] as const)(
		'classifies RangeError, expected filesystem errors and EMFILE at %s',
		async (stage) => {
			for (const code of [
				'RangeError',
				'ENOENT',
				'EACCES',
				'EPERM',
				'ENOTDIR',
				'EISDIR',
				'EBUSY',
				'EMFILE',
			]) {
				vi.clearAllMocks();
				const error =
					code === 'RangeError'
						? new RangeError('bounded fixture')
						: Object.assign(new Error(code), { code });
				mockLocalFs(files, {
					onOpen: (handle) => {
						if (stage === 'descriptor-stat') vi.mocked(handle.stat).mockRejectedValueOnce(error);
						if (stage === 'read') vi.mocked(handle.read).mockRejectedValueOnce(error);
						if (stage === 'close') vi.mocked(handle.close).mockRejectedValueOnce(error);
					},
				});
				if (stage === 'stat') vi.mocked(fs.stat).mockRejectedValueOnce(error);
				if (stage === 'open') vi.mocked(fs.open).mockRejectedValueOnce(error);
				expect(await storage.readSessionMessages(PROJECT, SESSION_ID)).toMatchObject({
					messages: [],
					total: 0,
					hasMore: false,
					source: {
						status: 'unavailable',
						reason: code === 'RangeError' ? 'too-large' : 'unreadable',
					},
				});
				expect(captureException).toHaveBeenCalledTimes(code === 'EMFILE' ? 1 : 0);
				if (code === 'EMFILE')
					expect(captureException).toHaveBeenCalledWith(error, {
						operation: 'grokStorage:readSessionFile',
						filePath: transcript,
					});
				if (stage !== 'stat' && stage !== 'open') {
					const handle = await vi.mocked(fs.open).mock.results[0].value;
					expect(handle.close).toHaveBeenCalledExactlyOnceWith();
				}
			}
		}
	);

	it.each([{ invalid: [0xff] }, { invalid: [0xf0, 0x90, 0x80] }])(
		'marks invalid UTF-8 $invalid as partial while preserving the readable record',
		async ({ invalid }) => {
			const bytes = Buffer.concat([
				Buffer.from('{"type":"user","content":"'),
				Buffer.from(invalid),
				Buffer.from('"}'),
			]);
			mockLocalFs(files, { bytesOverrides: { [transcript]: bytes } });
			const result = await storage.readSessionMessages(PROJECT, SESSION_ID, {
				includeNativeRecords: true,
			});
			expect(result).toMatchObject({
				total: 1,
				messages: [
					{ uuid: 'grok-line-1', content: '\ufffd', native: { raw: bytes.toString('utf8') } },
				],
				source: { status: 'partial', reason: 'changed-during-read', sizeBytes: bytes.length },
			});
			expect(captureException).not.toHaveBeenCalled();
		}
	);

	it.each(['replacement-character', 'split-multibyte'])('accepts valid UTF-8 %s', async (mode) => {
		const prefix = '{"type":"user","content":"';
		const text =
			mode === 'replacement-character'
				? '\ufffd'
				: 'x'.repeat(64 * 1024 - Buffer.byteLength(prefix) - 1) + 'é';
		files[transcript] = prefix + text + '"}';
		const result = await storage.readSessionMessages(PROJECT, SESSION_ID);
		expect(result.source?.status).toBe('available');
		expect(result.source?.reason).toBeUndefined();
		expect(result.messages).toHaveLength(1);
		expect(result.messages[0].content).toBe(text);
		expect(captureException).not.toHaveBeenCalled();
	});

	it.each([false, true])(
		'distinguishes empty from unreadable transcripts (unreadable=%s)',
		async (unreadable) => {
			files[transcript] = '';
			if (unreadable)
				vi.mocked(fs.open).mockRejectedValueOnce(
					Object.assign(new Error('denied'), { code: 'EACCES' })
				);
			expect(
				await storage.readSessionMessages(PROJECT, SESSION_ID, { includeNativeRecords: true })
			).toEqual({
				messages: [],
				total: 0,
				hasMore: false,
				source: {
					provider: 'grok',
					status: unreadable ? 'unavailable' : 'available',
					...(unreadable ? { reason: 'unreadable' } : {}),
					sizeBytes: 0,
					maxBytes: transcriptCap,
				},
			});
			expect(captureException).not.toHaveBeenCalled();
		}
	);

	it.each([
		['raw_output', 99_999, 1, true],
		['raw_output', 100_000, 1, false],
		['tool_calls', 100_000, 1, false],
		['raw_output', 50_000, 2, false],
	] as const)(
		'bounds %s projection count %s across %s rows',
		async (field, count, rows, accepted) => {
			files[transcript] = Array.from({ length: rows }, () =>
				JSON.stringify({
					type: 'assistant',
					content: 'retained',
					[field]: Array(count).fill(null),
				})
			).join('\n');
			const result = await storage.readSessionMessages(PROJECT, SESSION_ID, {
				includeNativeRecords: true,
			});
			expect(result.messages).toHaveLength(accepted ? 1 : 0);
			expect(result.source).toMatchObject(
				accepted ? { status: 'available' } : { status: 'unavailable', reason: 'too-large' }
			);
			if (accepted)
				expect(result.messages[0]).toMatchObject({
					uuid: 'grok-line-1',
					native: { raw: files[transcript] },
				});
			expect(captureException).not.toHaveBeenCalled();
		}
	);

	it.each([
		[undefined, 100, 20],
		[NaN, 100, 20],
		[Infinity, 100, 20],
		[-Infinity, 100, 20],
		[-2, 1, 1],
		[0, 1, 1],
		[2.9, 2, 2],
		[1000, 1000, 1000],
		[5000, 1000, 1000],
	] as const)(
		'clamps list/message limit %s with more than 1000 results',
		async (limit, listCount, messageCount) => {
			const rows = Array.from({ length: 1001 }, (_, i) =>
				JSON.stringify({ type: 'user', content: 'row ' + i })
			);
			files[transcript] = rows.join('\n');
			const [session] = await storage.listSessions(PROJECT);
			// Pagination owns slicing; listing/root discovery already has dedicated fixtures.
			vi.spyOn(storage, 'listSessions').mockResolvedValue(
				Array.from({ length: 1001 }, (_, i) => ({ ...session, sessionId: 'page-' + i }))
			);
			const page = await storage.listSessionsPaginated(PROJECT, { limit });
			expect(page).toMatchObject({ totalCount: 1001, hasMore: true });
			expect(page.sessions).toHaveLength(listCount);
			expect(page.nextCursor).toBe(page.sessions.at(-1)?.sessionId);
			const next = await storage.listSessionsPaginated(PROJECT, {
				limit,
				cursor: page.nextCursor!,
			});
			expect(next.sessions[0].sessionId).not.toBe(page.nextCursor);
			expect(new Set([...page.sessions, ...next.sessions].map((s) => s.sessionId)).size).toBe(
				page.sessions.length + next.sessions.length
			);
			const messages = await storage.readSessionMessages(PROJECT, SESSION_ID, { limit });
			expect(messages).toMatchObject({
				total: 1001,
				hasMore: true,
				source: { status: 'available' },
			});
			expect(messages.messages).toHaveLength(messageCount);
			expect(messages.messages[0].uuid).toBe('grok-line-' + (1002 - messageCount));
			expect(messages.messages.at(-1)?.uuid).toBe('grok-line-1001');
			const rest = await storage.readSessionMessages(PROJECT, SESSION_ID, {
				limit: 5000,
				offset: messageCount,
			});
			expect(rest).toMatchObject({ hasMore: false, total: 1001 });
			expect(rest.messages.at(-1)?.uuid).toBe('grok-line-' + (1001 - messageCount));
		}
	);
});

describe('GrokSessionStorage - concurrent native writers', () => {
	const account = path.resolve('src/__tests__/fixtures/grok-accounts/concurrent');
	const sessionsDir = path.join(account, 'sessions');
	const dir = path.join(sessionsDir, encodeURIComponent(PROJECT), SESSION_ID);
	const transcript = path.join(dir, 'chat_history.jsonl');
	let files: Record<string, string>;
	let storage: GrokSessionStorage;

	beforeEach(() => {
		vi.clearAllMocks();
		files = sessionFiles(
			PROJECT,
			SESSION_ID,
			'{"generated_title":"old"}',
			'{"type":"user","content":"old"}',
			sessionsDir
		);
		files[path.join(dir, 'usage.json')] =
			'{"session":{"inputTokens":100,"outputTokens":20,"cachedReadTokens":30,"cacheCreationTokens":10,"costUsdTicks":9007199254740993}}';
		mockLocalFs(files);
		storage = new GrokSessionStorage(account);
	});
	afterEach(async () => {
		for (const [file, flags] of vi.mocked(fs.open).mock.calls) {
			expect(String(file) in files).toBe(true);
			expect(flags).toBe(fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
		}
		for (const result of await Promise.allSettled(
			vi.mocked(fs.open).mock.results.map((r) => r.value)
		))
			if (result.status === 'fulfilled')
				expect(result.value.close).toHaveBeenCalledExactlyOnceWith();
		for (const mutation of [fs.writeFile, fs.appendFile, fs.rename, fs.unlink, fs.mkdir])
			expect(mutation).not.toHaveBeenCalled();
		expect(fs.readFile).not.toHaveBeenCalled();
		expect(remoteFs.readFileRemote).not.toHaveBeenCalled();
		expect(execFileNoThrow).not.toHaveBeenCalled();
		vi.restoreAllMocks();
	});

	it.each(['unchanged', 'summary.json', 'chat_history.jsonl', 'usage.json'])(
		'discloses %s across two samples without waiting for a writer to settle',
		async (changed) => {
			mockLocalFs(files, {
				onOpen: (handle, file) => {
					if (path.basename(file) === changed)
						vi.mocked(handle.close).mockImplementation(async () => {
							// Equal-size writes after every sample, including the comparison sample.
							if (changed === 'usage.json') {
								files[file] = files[file].includes('9007199254740993')
									? files[file].replace('9007199254740993', '9007199254740994')
									: files[file].replace('9007199254740994', '9007199254740993');
							} else
								files[file] = files[file].includes('old')
									? files[file].replace('old', 'new')
									: files[file].replace('new', 'old');
						});
				},
			});
			const [session] = await storage.listSessions(PROJECT);
			const reason =
				changed === 'unchanged'
					? 'cross-file-generation-unverified'
					: 'changed-or-unavailable-during-snapshot';
			expect(session).toMatchObject({
				sessionName: 'old',
				firstMessage: 'old',
				messageCount: 1,
				inputTokens: 60,
				accounting: {
					completeness: 'partial',
					cost: { status: 'partial', costUsdTicks: '9007199254740993', reason },
				},
			});
			for (const source of Object.values(session.nativeMetadata!.sources!))
				expect(source).toMatchObject({ status: 'partial', reason });
			expect(session.byModel).toBeUndefined();
			expect(fs.open).toHaveBeenCalledTimes(6);
			for (const file of Object.keys(files))
				expect(vi.mocked(fs.open).mock.calls.filter(([p]) => p === file)).toHaveLength(2);
			expect(captureException).not.toHaveBeenCalled();
		}
	);

	it.each(['summary.json', 'chat_history.jsonl', 'usage.json'])(
		'keeps %s comparison failure partial without retrying indefinitely',
		async (name) => {
			let samples = 0;
			mockLocalFs(files, {
				onOpen: (handle, file) => {
					if (path.basename(file) === name && ++samples === 2)
						vi.mocked(handle.read).mockRejectedValueOnce(
							Object.assign(new Error('writer moved file'), { code: 'ENOENT' })
						);
				},
			});
			const [session] = await storage.listSessions(PROJECT);
			expect(session).toMatchObject({
				firstMessage: 'old',
				inputTokens: 60,
				accounting: { cost: { status: 'partial', costUsdTicks: '9007199254740993' } },
			});
			for (const source of Object.values(session.nativeMetadata!.sources!))
				expect(source).toMatchObject({
					status: 'partial',
					reason: 'changed-or-unavailable-during-snapshot',
				});
			expect(samples).toBe(2);
			expect(fs.open).toHaveBeenCalledTimes(6);
			expect(captureException).not.toHaveBeenCalled();
		}
	);

	it('withholds a changing usage ledger even when the sampled JSON parses', async () => {
		const usageFile = path.join(dir, 'usage.json');
		const initial = await fs.stat(usageFile);
		mockLocalFs(files, {
			onOpen: (handle, file) => {
				if (file === usageFile)
					vi.mocked(handle.stat)
						.mockResolvedValueOnce(initial)
						.mockResolvedValueOnce({ ...initial, ctimeMs: initial.ctimeMs + 1 });
			},
		});
		const [session] = await storage.listSessions(PROJECT);
		expect(session.nativeMetadata?.sources?.['usage.json']).toMatchObject({
			status: 'partial',
			reason: 'changed-during-read',
		});
		expect(session.accounting).toMatchObject({
			source: 'none',
			completeness: 'unknown',
			cost: { status: 'unknown' },
		});
		expect(session.costUsd).toBeUndefined();
		expect(session.byModel).toBeUndefined();
		expect(fs.open).toHaveBeenCalledTimes(6);
		expect(captureException).not.toHaveBeenCalled();
	});

	it.each(['dev', 'ino', 'ctimeMs', 'mtimeMs', 'isFile'] as const)(
		'detects pathname replacement by %s while the open descriptor stays unchanged',
		async (field) => {
			const initial = await fs.stat(transcript);
			mockLocalFs(files, { onOpen: (handle) => vi.mocked(handle.stat).mockResolvedValue(initial) });
			vi.mocked(fs.stat)
				.mockResolvedValueOnce(initial)
				.mockResolvedValueOnce({
					...initial,
					[field]: field === 'isFile' ? () => false : Number(initial[field]) + 1,
				} as never);
			const result = await storage.readSessionMessages(PROJECT, SESSION_ID);
			expect(result).toMatchObject({
				total: 1,
				messages: [{ content: 'old' }],
				source: { status: 'partial', reason: 'changed-during-read' },
			});
			expect(fs.open).toHaveBeenCalledTimes(1);
			expect(captureException).not.toHaveBeenCalled();
		}
	);

	it.each(['ENOENT', 'EACCES', 'EMFILE', 'RangeError', 'oversized'])(
		'classifies final pathname %s after a successful descriptor read',
		async (code) => {
			const initial = await fs.stat(transcript);
			mockLocalFs(files, { onOpen: (handle) => vi.mocked(handle.stat).mockResolvedValue(initial) });
			const stat = vi.mocked(fs.stat).mockResolvedValueOnce(initial);
			const error =
				code === 'RangeError'
					? new RangeError('fixture')
					: Object.assign(new Error(code), { code });
			if (code === 'oversized')
				stat.mockResolvedValueOnce({ ...initial, size: 64 * 1024 * 1024 + 1 });
			else stat.mockRejectedValueOnce(error);
			const result = await storage.readSessionMessages(PROJECT, SESSION_ID);
			const rejected = code === 'oversized' || code === 'RangeError';
			expect(result).toMatchObject({
				total: rejected ? 0 : 1,
				source: {
					status: rejected ? 'unavailable' : 'partial',
					reason: rejected ? 'too-large' : 'post-read-stat-unavailable',
				},
			});
			expect(fs.open).toHaveBeenCalledTimes(1);
			if (code === 'EMFILE')
				expect(captureException).toHaveBeenCalledExactlyOnceWith(
					error,
					expect.objectContaining({ operation: 'grokStorage:statSessionFile' })
				);
			else expect(captureException).not.toHaveBeenCalled();
		}
	);

	it('preserves an interrupted append tail and rereads its completed generation', async () => {
		const tail = '{"type":"assistant","content":"new';
		files[transcript] += '\n' + tail;
		const interrupted = await storage.readSessionMessages(PROJECT, SESSION_ID, {
			includeNativeRecords: true,
		});
		expect(interrupted.source).toMatchObject({ status: 'partial', reason: 'malformed-records' });
		expect(interrupted.messages[0]).toMatchObject({ content: 'old', native: { line: 1 } });
		expect(interrupted.messages[1]).toMatchObject({
			native: { line: 2, raw: tail, issues: ['malformed-record'] },
		});
		const [listed] = await storage.listSessions(PROJECT);
		expect(listed.nativeMetadata?.sources?.['chat_history.jsonl']).toMatchObject({
			status: 'partial',
			reason: 'malformed-records',
		});
		files[transcript] += '"}';
		const complete = await storage.readSessionMessages(PROJECT, SESSION_ID, {
			includeNativeRecords: true,
		});
		expect(complete.source?.status).toBe('available');
		expect(complete.messages.map((m) => [m.uuid, m.content])).toEqual([
			[interrupted.messages[0].uuid, 'old'],
			[interrupted.messages[1].uuid, 'new'],
		]);
		expect(fs.open).toHaveBeenCalledTimes(8);
		expect(captureException).not.toHaveBeenCalled();
	});

	it('does not borrow same-ID account totals when completed child usage arrives later', async () => {
		const otherAccount = path.join(account, 'other-account');
		const otherDir = path.join(otherAccount, 'sessions', encodeURIComponent(PROJECT), SESSION_ID);
		Object.assign(
			files,
			sessionFiles(
				PROJECT,
				SESSION_ID,
				'{}',
				'{"type":"user","content":"other"}',
				path.join(otherAccount, 'sessions')
			)
		);
		files[path.join(otherDir, 'usage.json')] =
			'{"session":{"inputTokens":7,"outputTokens":0,"cachedReadTokens":0,"cacheCreationTokens":0,"costUsdTicks":7}}';
		mockLocalFs(files);
		const [before] = await storage.listSessions(PROJECT);
		// Native totals include completed children once; the active child inventory is unknown.
		files[path.join(dir, 'usage.json')] = JSON.stringify({
			sessionId: 'inherited-parent',
			session: {
				inputTokens: 160,
				outputTokens: 50,
				cachedReadTokens: 40,
				cacheCreationTokens: 15,
				costUsdTicks: '9007199254741006',
			},
			turns: [{ usage: { inputTokens: 60, costUsdTicks: 13 } }],
		}).replace('"9007199254741006"', '9007199254741006');
		const [other] = await storage.listSessions(PROJECT, undefined, otherAccount);
		const [after] = await storage.listSessions(PROJECT);
		expect(before.inputTokens).toBe(60);
		expect(other).toMatchObject({
			firstMessage: 'other',
			inputTokens: 7,
			accounting: { providerSessionId: SESSION_ID, cost: { costUsdTicks: '7' } },
		});
		expect(after).toMatchObject({
			firstMessage: 'old',
			messageCount: 1,
			inputTokens: 105,
			outputTokens: 50,
			cacheReadTokens: 40,
			cacheCreationTokens: 15,
			accounting: {
				providerSessionId: SESSION_ID,
				completeness: 'partial',
				childInclusion: 'completed',
				childCompleteness: 'unknown',
				cost: {
					status: 'partial',
					costUsdTicks: '9007199254741006',
					reason: 'cross-file-generation-unverified',
				},
			},
		});
		expect(before.accounting?.cost).toMatchObject({ costUsdTicks: '9007199254740993' });
		expect(fs.open).toHaveBeenCalledTimes(18);
		expect(captureException).not.toHaveBeenCalled();
	});
});

describe('GrokSessionStorage - native normalization regressions', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Unexpected historical fetch')));
	});
	afterEach(() => {
		expect(fetch).not.toHaveBeenCalled();
		vi.unstubAllGlobals();
	});

	it.each([undefined, '', '  ', '{broken', 'null', '[]'])(
		'reads a usable transcript with summary %j and keeps dates unknown',
		async (summary) => {
			const files = sessionFiles(PROJECT, SESSION_ID, summary ?? '', chatHistoryJsonl());
			if (summary === undefined)
				delete files[
					path.join(SESSIONS_DIR, encodeURIComponent(PROJECT), SESSION_ID, 'summary.json')
				];
			mockLocalFs(files);
			const [session] = await new GrokSessionStorage().listSessions(PROJECT);
			expect(session).toMatchObject({
				sessionId: SESSION_ID,
				messageCount: 3,
				timestamp: '',
				modifiedAt: '',
				durationSeconds: 0,
			});
			expect(session.nativeMetadata?.summaryStatus).toBe(
				summary?.trim() ? 'invalid' : 'unavailable'
			);
			expect(session.accounting).toMatchObject({
				completeness: 'unknown',
				cost: { status: 'unknown' },
			});
			expect(session.costUsd).toBeUndefined();
			expect(captureException).not.toHaveBeenCalled();
		}
	);

	it.each([
		['  Native title  ', 'Native title'],
		[' \t ', 'Fallback title'],
	])('preserves native metadata and title precedence for %j', async (generated_title, title) => {
		const metadata = {
			generated_title,
			session_summary: 'Fallback title',
			created_at: 'invalid',
			updated_at: null,
			parent_session_id: 'parent',
			chat_format_version: 1,
			fork_parent_prompt_id: 'branch-point',
		};
		mockLocalFs(
			sessionFiles(
				PROJECT,
				SESSION_ID,
				summaryJson(SESSION_ID, PROJECT, metadata),
				chatHistoryJsonl()
			)
		);
		const [session] = await new GrokSessionStorage().listSessions(PROJECT);
		expect(session).toMatchObject({
			sessionName: title,
			timestamp: '',
			modifiedAt: '',
			nativeMetadata: { summary: metadata, summaryStatus: 'available' },
		});
	});

	it.each(['current', 'legacy'] as const)(
		'preserves ordered %s records, tool linkage and inert image references',
		async (layout) => {
			const image = 'data:image/png;base64,aGVsbG8=';
			const reference = 'https://example.invalid/fixture.png';
			const call =
				layout === 'current'
					? { id: 'call', name: 'read', arguments: '{"path":"fixture.png"}' }
					: { id: 'call', function: { name: 'read', arguments: '{"path":"fixture.png"}' } };
			const discriminator = layout === 'current' ? 'type' : 'role';
			const rows = [
				{ type: 'system', content: 'system evidence' },
				{
					type: 'user',
					synthetic_reason: 'project_instructions',
					content: [{ type: 'text', text: 'hidden context' }],
				},
				...['human', 'interjection', 'parent_human_message', 'direct_bash'].map(
					(synthetic_reason) => ({
						[discriminator]: 'user',
						synthetic_reason,
						content: [{ type: 'text', text: `<user_query>${synthetic_reason}</user_query>` }],
					})
				),
				{
					type: 'reasoning',
					summary: [{ text: 'summary one' }, { text: 'summary two' }],
					content: [{ text: 'detail one' }, { text: 'detail two' }],
					encrypted_content: 'opaque-fixture',
				},
				{ [discriminator]: 'assistant', content: '', tool_calls: [call] },
				{
					[discriminator]: layout === 'current' ? 'tool_result' : 'tool',
					tool_call_id: 'call',
					content:
						layout === 'current'
							? 'image result'
							: [
									{ type: 'text', text: 'image result' },
									{ type: 'image_url', image_url: { url: reference } },
								],
					images: [
						...(layout === 'current' ? [{ type: 'image', url: reference }] : []),
						{ type: 'image', url: image },
						{ type: 'image', url: '/fixture/not-to-read.png' },
					],
				},
				{ [discriminator]: 'assistant', content: 'final answer' },
				{ type: 'future-record', payload: { retained: true } },
				{ [discriminator]: 'assistant', content: '' },
			].map((row) => JSON.stringify(row));
			rows.push('{"type":"assistant","content":"interrupted');
			mockLocalFs(sessionFiles(PROJECT, SESSION_ID, '{}', rows.join('\n')));
			const storage = new GrokSessionStorage();
			const native = await storage.readSessionMessages(PROJECT, SESSION_ID, {
				includeNativeRecords: true,
				limit: 100,
			});
			const display = await storage.readSessionMessages(PROJECT, SESSION_ID, { limit: 100 });
			expect(native.messages.map((message) => message.native?.raw)).toEqual(rows);
			expect(native.messages.map((message) => message.uuid)).toEqual(
				rows.map((_, i) => `grok-line-${i + 1}`)
			);
			expect(native.messages.every((message) => message.timestamp === '')).toBe(true);
			expect(native.source).toMatchObject({ status: 'partial', reason: 'malformed-records' });
			expect(native.messages[6]).toMatchObject({
				type: 'reasoning',
				role: 'assistant',
				content: 'summary one\nsummary two\ndetail one\ndetail two',
			});
			expect(native.messages[7].toolUse).toEqual([
				expect.objectContaining({
					id: 'call',
					args: '{"path":"fixture.png"}',
					resultSource: { provider: 'grok', line: 9 },
					state: { status: 'completed', input: { path: 'fixture.png' } },
				}),
			]);
			expect(native.messages[7].images).toBeUndefined();
			expect(native.messages[8]).toMatchObject({
				role: 'tool',
				toolCallId: 'call',
				images: [image],
				imageReferences: [reference, image, '/fixture/not-to-read.png'],
			});
			expect(native.messages[10].native?.issues).toEqual(['unknown-record']);
			expect(native.messages[12].native?.issues).toEqual(['malformed-record']);
			expect(display.messages.map((message) => message.uuid)).toEqual(
				[3, 4, 5, 6, 8, 10, 11, 13].map((line) => `grok-line-${line}`)
			);
			expect(display.messages.every((message) => message.native?.raw === undefined)).toBe(true);
			expect(display.messages[4]).toMatchObject({
				images: [image],
				toolUse: [{ state: { status: 'completed', output: 'image result' } }],
			});
			expect(await storage.searchSessions(PROJECT, 'hidden context', 'all')).toEqual([]);
			expect(await storage.searchSessions(PROJECT, 'summary one', 'all')).toEqual([]);
			expect(await storage.searchSessions(PROJECT, 'final answer', 'assistant')).toEqual([
				expect.objectContaining({ sessionId: SESSION_ID, matchCount: 1 }),
			]);
			expect(fs.open).not.toHaveBeenCalledWith('/fixture/not-to-read.png', expect.anything());
			expect(fs.readFile).not.toHaveBeenCalled();
			expect(execFileNoThrow).not.toHaveBeenCalled();
		}
	);

	it.each([
		[
			['call', 'call', 'result'],
			['duplicate-tool-call-id', 'duplicate-tool-call-id', 'ambiguous-or-missing-tool-call'],
		],
		[
			['call', 'result', 'result'],
			[undefined, 'ambiguous-or-missing-tool-call', 'ambiguous-or-missing-tool-call'],
		],
		[
			['result', 'call'],
			['ambiguous-or-missing-tool-call', undefined],
		],
		[['result'], ['ambiguous-or-missing-tool-call']],
		[['call'], [undefined]],
		[
			['missingCall', 'result'],
			['missing-tool-call-id', 'ambiguous-or-missing-tool-call'],
		],
		[
			['call', 'missingResult'],
			[undefined, 'missing-tool-call-id'],
		],
	] as const)('retains unresolved tool linkage for %j', async (order, issues) => {
		const call = { id: 'call', name: 'shell', arguments: '{"command":"do-not-run"}' };
		const records = {
			call: { type: 'assistant', tool_calls: [call] },
			missingCall: { type: 'assistant', tool_calls: [{ ...call, id: '' }] },
			result: { type: 'tool_result', tool_call_id: 'call', content: 'historical output' },
			missingResult: { type: 'tool_result', content: 'unlinked output' },
		};
		const rows = order.map((kind) => JSON.stringify(records[kind]));
		mockLocalFs(sessionFiles(PROJECT, SESSION_ID, '{}', rows.join('\n')));
		const storage = new GrokSessionStorage();
		for (const includeNativeRecords of [false, true]) {
			const { messages } = await storage.readSessionMessages(PROJECT, SESSION_ID, {
				includeNativeRecords,
			});
			expect(messages).toHaveLength(rows.length);
			messages.forEach((message, i) => {
				expect(message.uuid).toBe(`grok-line-${i + 1}`);
				expect(message.native?.issues).toEqual(issues[i] ? [issues[i]] : undefined);
				expect(message.native?.raw).toBe(includeNativeRecords ? rows[i] : undefined);
				if (order[i] === 'call' || order[i] === 'missingCall') {
					expect(Array.isArray(message.toolUse)).toBe(true);
					expect(message.toolUse).toHaveLength(1);
				}
				for (const tool of Array.isArray(message.toolUse) ? message.toolUse : []) {
					expect(tool).toMatchObject({ state: { status: 'unknown' } });
					expect(tool).not.toHaveProperty('resultSource');
					expect(tool).not.toHaveProperty('state.output');
				}
			});
		}
		expect(execFileNoThrow).not.toHaveBeenCalled();
	});

	it('pairs parallel calls by ID when identical tool names finish in reverse order', async () => {
		const rows = [
			{
				type: 'assistant',
				tool_calls: ['a', 'b'].map((id) => ({ id, name: 'shell', arguments: '{}' })),
			},
			{ type: 'tool_result', tool_call_id: 'b', content: 'second call output' },
			{ type: 'tool_result', tool_call_id: 'a', content: 'first call output' },
		].map((row) => JSON.stringify(row));
		mockLocalFs(sessionFiles(PROJECT, SESSION_ID, '{}', rows.join('\n')));
		const storage = new GrokSessionStorage();
		const display = await storage.readSessionMessages(PROJECT, SESSION_ID);
		expect(display.messages).toHaveLength(1);
		expect(display.messages[0].toolUse).toEqual([
			expect.objectContaining({
				id: 'a',
				resultSource: { provider: 'grok', line: 3 },
				state: { status: 'completed', input: {}, output: 'first call output' },
			}),
			expect.objectContaining({
				id: 'b',
				resultSource: { provider: 'grok', line: 2 },
				state: { status: 'completed', input: {}, output: 'second call output' },
			}),
		]);
		const native = await storage.readSessionMessages(PROJECT, SESSION_ID, {
			includeNativeRecords: true,
		});
		expect(native.messages.map((message) => message.native?.raw)).toEqual(rows);
		const tools = native.messages[0].toolUse;
		expect(Array.isArray(tools)).toBe(true);
		expect(tools).toHaveLength(2);
		for (const tool of Array.isArray(tools) ? tools : [])
			expect(tool).not.toHaveProperty('state.output');
		expect(execFileNoThrow).not.toHaveBeenCalled();
	});

	it.each([
		[{ reasoning_content: 'fallback' }, ['fallback']],
		[{ reasoning: { text: 'preferred' }, reasoning_content: 'fallback' }, ['preferred']],
		[{ reasoning: { text: '' }, reasoning_content: 'fallback' }, ['']],
		[{ reasoning: {}, reasoning_content: 'fallback' }, ['fallback']],
		[{ raw_output: [], reasoning: { text: 'ignored' }, reasoning_content: 'ignored' }, []],
		[
			{
				raw_output: [{ type: 'future', content: 'retained only in raw' }],
				reasoning_content: 'ignored',
			},
			[],
		],
		[
			{
				raw_output: [
					{ type: 'reasoning', summary: [{ text: 'summary' }], content: [{ text: 'detail' }] },
				],
				reasoning: { text: 'ignored' },
				reasoning_content: 'ignored',
			},
			['summary\ndetail'],
		],
	] as const)('honors native legacy reasoning precedence for %j', async (fields, contents) => {
		const raw = JSON.stringify({ role: 'assistant', content: 'answer', ...fields });
		mockLocalFs(sessionFiles(PROJECT, SESSION_ID, '{}', raw));
		const storage = new GrokSessionStorage();
		const native = await storage.readSessionMessages(PROJECT, SESSION_ID, {
			includeNativeRecords: true,
		});
		expect(native.messages.map((message) => message.content)).toEqual([...contents, 'answer']);
		for (const [i, projection] of native.messages.slice(0, -1).entries()) {
			expect(projection).toMatchObject({
				type: 'reasoning',
				role: 'assistant',
				uuid: `grok-line-1-legacy-${i}`,
				native: { provider: 'grok', line: 1 },
			});
			expect(projection.native?.raw).toBeUndefined();
		}
		expect(
			native.messages
				.filter((message) => message.native?.raw !== undefined)
				.map((message) => message.native?.raw)
		).toEqual([raw]);
		const display = await storage.readSessionMessages(PROJECT, SESSION_ID);
		expect(display.messages).toHaveLength(1);
		expect(display.messages[0]).toMatchObject({ content: 'answer', uuid: 'grok-line-1' });
		expect(display.messages[0].native?.raw).toBeUndefined();
	});

	it('deduplicates legacy backend IDs against later native rows without losing raw evidence', async () => {
		const rawOutput = [
			{ type: 'web_search_call', id: 'native-id', status: 'completed' },
			{ type: 'custom_tool_call', id: 'legacy-id', status: 'completed' },
			{ type: 'custom_tool_call', id: 'legacy-id', status: 'completed' },
			{ type: 'code_interpreter_call', id: 'code-id', status: 'completed' },
		];
		const rows = [
			{ role: 'assistant', content: 'first', raw_output: rawOutput },
			{ type: 'backend_tool_call', kind: rawOutput[0] },
			{ role: 'assistant', content: 'second', raw_output: [rawOutput[1]] },
		].map((row) => JSON.stringify(row));
		mockLocalFs(sessionFiles(PROJECT, SESSION_ID, '{}', rows.join('\n')));
		const native = await new GrokSessionStorage().readSessionMessages(PROJECT, SESSION_ID, {
			includeNativeRecords: true,
		});
		expect(native.messages.map((message) => message.uuid)).toEqual([
			'grok-line-1-legacy-1',
			'grok-line-1-legacy-3',
			'grok-line-1',
			'grok-line-2',
			'grok-line-3',
		]);
		expect(native.messages.filter((message) => message.type === 'backend_tool_call')).toHaveLength(
			3
		);
		expect(
			native.messages
				.filter((message) => message.native?.raw !== undefined)
				.map((message) => message.native?.raw)
		).toEqual(rows);
		expect(native.messages.slice(0, 2).map((message) => message.native)).toEqual([
			{ provider: 'grok', line: 1 },
			{ provider: 'grok', line: 1 },
		]);
		expect(execFileNoThrow).not.toHaveBeenCalled();
	});

	it.each(['current', 'legacy'] as const)(
		'keeps image-only %s user attachments visible and inert',
		async (layout) => {
			const references = [
				'data:image/png;base64,aGVsbG8=',
				'https://example.invalid/image.png',
				path.join(PROJECT, 'unopened.png'),
			];
			const raw = JSON.stringify({
				[layout === 'current' ? 'type' : 'role']: 'user',
				content: references.map((url) =>
					layout === 'current' ? { type: 'image', url } : { type: 'image_url', image_url: { url } }
				),
			});
			const files = sessionFiles(PROJECT, SESSION_ID, '{}', raw);
			mockLocalFs(files);
			for (const includeNativeRecords of [false, true]) {
				const { messages } = await new GrokSessionStorage().readSessionMessages(
					PROJECT,
					SESSION_ID,
					{ includeNativeRecords }
				);
				expect(messages).toHaveLength(1);
				expect(messages[0]).toMatchObject({
					type: 'user',
					content: '',
					images: [references[0]],
					imageReferences: references,
				});
				expect(messages[0].native?.raw).toBe(includeNativeRecords ? raw : undefined);
			}
			expect(vi.mocked(fs.open).mock.calls.every(([file]) => String(file) in files)).toBe(true);
			expect(fs.readFile).not.toHaveBeenCalled();
			expect(execFileNoThrow).not.toHaveBeenCalled();
		}
	);

	it.each([
		['null', 'malformed-record', true],
		['42', 'malformed-record', true],
		['false', 'malformed-record', true],
		['"scalar"', 'malformed-record', true],
		['[]', 'malformed-record', true],
		['{}', 'unknown-record', true],
		['{"type":"future","payload":{"keep":true}}', 'unknown-record', true],
		['{"type":"user","content":[]}', undefined, false],
		['{"type":"assistant","content":""}', undefined, false],
		['{"type":"reasoning","encrypted_content":"opaque-fixture"}', undefined, false],
	] as const)(
		'retains non-displayable or unknown source %s exactly once',
		async (raw, issue, visible) => {
			mockLocalFs(sessionFiles(PROJECT, SESSION_ID, '{}', `\n  ${raw}  \n\n`));
			const storage = new GrokSessionStorage();
			const native = await storage.readSessionMessages(PROJECT, SESSION_ID, {
				includeNativeRecords: true,
			});
			expect(native.messages).toHaveLength(1);
			expect(native.messages[0]).toMatchObject({
				uuid: 'grok-line-2',
				timestamp: '',
				native: { line: 2, raw: `  ${raw}  ` },
			});
			expect(native.messages[0].native?.issues).toEqual(issue ? [issue] : undefined);
			expect(native.source?.status).toBe(issue === 'malformed-record' ? 'partial' : 'available');
			if (!visible) expect(native.messages[0].content).toBe('');
			const display = await storage.readSessionMessages(PROJECT, SESSION_ID);
			expect(display.messages).toHaveLength(visible ? 1 : 0);
			expect(display.messages.every((message) => message.native?.raw === undefined)).toBe(true);
			expect(captureException).not.toHaveBeenCalled();
		}
	);

	it('reconciles phase 03 first/resumed turn totals without adding turn or child detail again', async () => {
		// Same ledger and expected turn delta as acp-turn.test.ts, qualified process accounting.
		const baseline = {
			inputTokens: 100,
			outputTokens: 20,
			cachedReadTokens: 30,
			cacheCreationTokens: 10,
			reasoningTokens: 5,
			costUsdTicks: '9007199254740993',
		};
		const resumed = {
			inputTokens: 60,
			outputTokens: 30,
			cachedReadTokens: 10,
			cacheCreationTokens: 5,
			reasoningTokens: 5,
			costUsdTicks: '13',
		};
		const session = {
			inputTokens: 160,
			outputTokens: 50,
			cachedReadTokens: 40,
			cacheCreationTokens: 15,
			reasoningTokens: 10,
			costUsdTicks: '9007199254741006',
			modelUsage: { 'grok-fixture': baseline, 'unknown-model-raw': resumed },
		};
		const usage = JSON.stringify({
			sessionId: 'inherited-parent',
			session,
			turns: [
				{ turnNumber: 1, endedAt: '2026-10-30T12:00:00Z', usage: baseline },
				{ turnNumber: 2, endedAt: '2026-10-30T12:01:00Z', usage: resumed },
			],
		}).replace(/"costUsdTicks":"(\d+)"/g, '"costUsdTicks":$1');
		const files = sessionFiles(PROJECT, SESSION_ID, '{}', chatHistoryJsonl());
		files[path.join(SESSIONS_DIR, encodeURIComponent(PROJECT), SESSION_ID, 'usage.json')] = usage;
		mockLocalFs(files);
		const [actual] = await new GrokSessionStorage().listSessions(PROJECT);
		expect(actual).toMatchObject({
			inputTokens: 60 + 45,
			outputTokens: 20 + 30,
			cacheReadTokens: 30 + 10,
			cacheCreationTokens: 10 + 5,
			reasoningTokens: 5 + 5,
			accounting: {
				scope: 'native-session',
				reporting: 'snapshot',
				providerSessionId: SESSION_ID,
				completeness: 'partial',
				childInclusion: 'completed',
				childCompleteness: 'unknown',
				cost: {
					status: 'partial',
					costUsdTicks: '9007199254741006',
					reason: 'cross-file-generation-unverified',
				},
			},
		});
		expect(actual.accounting?.models).toEqual([
			expect.objectContaining({
				model: 'grok-fixture',
				inputTokens: 60,
				reasoningTokens: 5,
				cost: {
					status: 'partial',
					costUsdTicks: '9007199254740993',
					reason: 'cross-file-generation-unverified',
				},
			}),
			expect.objectContaining({
				model: 'unknown-model-raw',
				inputTokens: 45,
				reasoningTokens: 5,
				cost: { status: 'partial', costUsdTicks: '13', reason: 'cross-file-generation-unverified' },
			}),
		]);
		expect(actual.byModel).toBeUndefined();
		expect(actual.costUsd).toBeCloseTo(Number(9007199254741006n) / 1e10, 8);
	});

	it.each([
		'0',
		'9007199254740993',
		'9223372036854775807',
		'-1',
		'1.5',
		'1e3',
		'9223372036854775808',
		'null',
	])('preserves valid i64 ticks and rejects unsupported cost lexeme %s', (ticks) => {
		const usage = parseGrokUsageFile(
			`{"session":{"inputTokens":10,"outputTokens":2,"cachedReadTokens":3,"cacheCreationTokens":1,"costUsdTicks":${ticks}}}`
		)!;
		const known = ['0', '9007199254740993', '9223372036854775807'].includes(ticks);
		expect(usage.accounting.cost).toEqual(
			known ? { status: 'exact', costUsdTicks: ticks } : { status: 'unknown' }
		);
		if (known) expect(usage.costUsd).toBe(Number(ticks) / 1e10);
		else expect(usage.costUsd).toBeUndefined();
	});

	it.each(['missing-cost', 'partial-cost', 'incomplete', 'bad-model'])(
		'keeps %s model detail without fabricating a complete numeric split',
		(kind) => {
			const model = {
				inputTokens: 10,
				outputTokens: 2,
				cachedReadTokens: 3,
				cacheCreationTokens: 1,
				costUsdTicks: 5,
			};
			const session = {
				...model,
				...(kind === 'partial-cost' ? { costIsPartial: true } : {}),
				...(kind === 'incomplete' ? { usageIsIncomplete: true } : {}),
				modelUsage: {
					'raw-unknown-model':
						kind === 'bad-model'
							? null
							: { ...model, ...(kind === 'missing-cost' ? { costUsdTicks: undefined } : {}) },
				},
			};
			const usage = parseGrokUsageFile(JSON.stringify({ session }))!;
			expect(usage.byModel).toEqual([]);
			expect(usage.accounting.models?.[0]).toMatchObject({
				model: 'raw-unknown-model',
				cost: { status: kind === 'partial-cost' || kind === 'incomplete' ? 'partial' : 'unknown' },
			});
			if (kind === 'bad-model') expect(usage.accounting.models?.[0].inputTokens).toBeUndefined();
		}
	);

	it.each([
		undefined,
		'',
		' ',
		'{broken',
		'null',
		'[]',
		'{}',
		'{"session":null}',
		'{"session":[]}',
		'{"session":42}',
	])('keeps absent or malformed usage %j unknown without hiding history', async (content) => {
		expect(parseGrokUsageFile(content ?? null)).toBeNull();
		const files = sessionFiles(PROJECT, SESSION_ID, '{}', chatHistoryJsonl());
		if (content !== undefined)
			files[path.join(SESSIONS_DIR, encodeURIComponent(PROJECT), SESSION_ID, 'usage.json')] =
				content;
		mockLocalFs(files);
		const [session] = await new GrokSessionStorage().listSessions(PROJECT);
		expect(session).toMatchObject({
			messageCount: 3,
			accounting: {
				source: 'none',
				completeness: 'unknown',
				cost: { status: 'unknown' },
				providerSessionId: SESSION_ID,
			},
		});
		expect(session.costUsd).toBeUndefined();
		expect(session.byModel).toBeUndefined();
		expect(session.nativeMetadata?.sources?.['usage.json']).toMatchObject(
			content === undefined
				? { status: 'unavailable' }
				: { status: 'partial', reason: 'invalid-usage' }
		);
		expect(captureException).not.toHaveBeenCalled();
	});

	it('distinguishes an empty runtime ledger from measured zero usage', () => {
		const empty = parseGrokUsageFile('{"session":{}}')!;
		expect(empty.accounting).toMatchObject({
			source: 'runtime-stream',
			completeness: 'unknown',
			cost: { status: 'unknown' },
		});
		expect(empty.costUsd).toBeUndefined();
		expect(empty.byModel).toEqual([]);
		expect(empty.accounting.models).toBeUndefined();
		const zero = parseGrokUsageFile(
			'{"session":{"inputTokens":0,"outputTokens":0,"cachedReadTokens":0,"cacheCreationTokens":0,"costUsdTicks":0}}'
		)!;
		expect(zero.accounting).toMatchObject({
			completeness: 'complete',
			cost: { status: 'exact', costUsdTicks: '0' },
		});
		expect(zero.costUsd).toBe(0);
	});

	it.each([
		['inputTokens', -1, 'inputTokens', undefined],
		['inputTokens', Number.MAX_SAFE_INTEGER + 1, 'inputTokens', undefined],
		['outputTokens', 1.5, 'outputTokens', undefined],
		['outputTokens', '20', 'outputTokens', undefined],
		['cachedReadTokens', null, 'cacheReadInputTokens', undefined],
		['cacheCreationTokens', -1, 'cacheCreationInputTokens', undefined],
		['cachedReadTokens', 101, 'inputTokens', undefined],
		['reasoningTokens', Number.MAX_SAFE_INTEGER + 1, 'reasoningTokens', undefined],
		['reasoningTokens', 21, 'reasoningTokens', 21],
		['totalTokens', 119, 'inputTokens', 60],
		['totalTokens', '120', 'inputTokens', 60],
	] as const)(
		'does not certify invalid %s=%j as complete usage',
		(field, value, countKey, expected) => {
			// Phase 03 qualified-process baseline, with one deliberately invalid observation.
			const ledger = {
				inputTokens: 100,
				outputTokens: 20,
				cachedReadTokens: 30,
				cacheCreationTokens: 10,
				reasoningTokens: 5,
				costUsdTicks: '9007199254740993',
				[field]: value,
			};
			const usage = parseGrokUsageFile(
				JSON.stringify({ session: { ...ledger, modelUsage: { 'raw-model': ledger } } })
			)!;
			expect(usage.accounting).toMatchObject({
				completeness: 'partial',
				cost: { status: 'partial', costUsdTicks: '9007199254740993' },
			});
			expect(usage.accounting.models?.[0]).toMatchObject({
				model: 'raw-model',
				completeness: 'partial',
				cost: { status: 'partial', costUsdTicks: '9007199254740993' },
			});
			expect(usage.accounting.models?.[0]?.[countKey]).toBe(expected);
			expect(usage.byModel).toEqual([]);
		}
	);

	it.each(['unknown', 'incomplete', 'partial', 'complete'] as const)(
		'publishes a model split only when every model is complete with known cost: %s',
		(kind) => {
			const model = {
				inputTokens: 60,
				outputTokens: 30,
				cachedReadTokens: 10,
				cacheCreationTokens: 5,
				reasoningTokens: 5,
				costUsdTicks: 13,
			};
			const second = {
				...model,
				...(kind === 'unknown' ? { costUsdTicks: undefined } : {}),
				...(kind === 'incomplete' ? { usageIsIncomplete: true } : {}),
				...(kind === 'partial' ? { costIsPartial: true } : {}),
			};
			const usage = parseGrokUsageFile(
				JSON.stringify({
					session: {
						...model,
						inputTokens: 120,
						outputTokens: 60,
						cachedReadTokens: 20,
						cacheCreationTokens: 10,
						reasoningTokens: 10,
						modelUsage: {
							'raw-zero-model': { ...model, costUsdTicks: 0 },
							'raw-second-model': second,
						},
					},
				})
			)!;
			expect(usage.accounting.cost).toEqual({ status: 'exact', costUsdTicks: '13' });
			expect(usage.accounting.models).toEqual([
				expect.objectContaining({
					model: 'raw-zero-model',
					inputTokens: 45,
					completeness: 'complete',
					cost: { status: 'exact', costUsdTicks: '0' },
				}),
				expect.objectContaining({
					model: 'raw-second-model',
					inputTokens: 45,
					completeness: kind === 'incomplete' ? 'partial' : 'complete',
					cost:
						kind === 'unknown'
							? { status: 'unknown' }
							: { status: kind === 'complete' ? 'exact' : 'partial', costUsdTicks: '13' },
				}),
			]);
			if (kind === 'complete')
				expect(usage.byModel.map((row) => row.costUsd)).toEqual([0, 13 / 1e10]);
			else expect(usage.byModel).toEqual([]);
		}
	);

	it('keeps missing model counts unknown and rejects unsafe call counts', () => {
		const model = {
			inputTokens: 100,
			outputTokens: 20,
			cachedReadTokens: 30,
			cacheCreationTokens: 10,
			modelCalls: Number.MAX_SAFE_INTEGER + 1,
			costUsdTicks: 0,
		};
		const usage = parseGrokUsageFile(
			JSON.stringify({
				session: { ...model, modelUsage: { known: model, 'missing-counts': { costUsdTicks: 0 } } },
			})
		)!;
		expect(usage.accounting.callCount).toBeUndefined();
		expect(usage.accounting.models?.[0]?.callCount).toBeUndefined();
		expect(usage.accounting.models?.[1]).toMatchObject({
			completeness: 'unknown',
			cost: { status: 'partial', costUsdTicks: '0' },
		});
		for (const key of [
			'inputTokens',
			'outputTokens',
			'cacheReadInputTokens',
			'cacheCreationInputTokens',
		] as const)
			expect(usage.accounting.models?.[1]?.[key]).toBeUndefined();
		expect(usage.byModel).toEqual([]);
	});

	it('keeps source IDs stable through pagination, blank lines and appended turns', async () => {
		const rows = [
			'{"type":"user","content":"first"}',
			'',
			'{"type":"assistant","content":"second"}',
			'{"type":"user","content":"third"}',
		];
		const files = sessionFiles(PROJECT, SESSION_ID, '{}', rows.join('\n'));
		mockLocalFs(files);
		const storage = new GrokSessionStorage();
		const last = await storage.readSessionMessages(PROJECT, SESSION_ID, { limit: 2 });
		expect(last).toMatchObject({
			total: 3,
			hasMore: true,
			messages: [{ uuid: 'grok-line-3' }, { uuid: 'grok-line-4' }],
		});
		expect(
			await storage.readSessionMessages(PROJECT, SESSION_ID, { limit: 2, offset: 2 })
		).toMatchObject({ hasMore: false, messages: [{ uuid: 'grok-line-1' }] });
		files[path.join(SESSIONS_DIR, encodeURIComponent(PROJECT), SESSION_ID, 'chat_history.jsonl')] +=
			'\n{"type":"assistant","content":"fourth"}';
		expect(
			await storage.readSessionMessages(PROJECT, SESSION_ID, { limit: 2, offset: 1 })
		).toMatchObject({ total: 4, messages: last.messages });
		expect(await storage.searchSessions(PROJECT, 'fourth', 'assistant')).toEqual([
			expect.objectContaining({ sessionId: SESSION_ID, matchCount: 1 }),
		]);
	});

	it.each([
		[-3, -2, 1],
		[NaN, NaN, 3],
		[Infinity, -Infinity, 3],
		[2.9, 1.9, 2],
		[5000, 0, 3],
		[1, 9999, 0],
	])('bounds pagination limit %s and offset %s', async (limit, offset, count) => {
		mockLocalFs(sessionFiles(PROJECT, SESSION_ID, '{}', chatHistoryJsonl()));
		const result = await new GrokSessionStorage().readSessionMessages(PROJECT, SESSION_ID, {
			limit,
			offset,
		});
		expect(result.total).toBe(3);
		expect(result.messages).toHaveLength(count);
		expect(result.source?.status).toBe('available');
	});

	it.each([
		['too-large', 'small fixture', 64 * 1024 * 1024 + 1],
		['too-many-lines', '\n'.repeat(100_000), undefined],
	] as const)(
		'reports rejected %s transcripts explicitly instead of complete empty history',
		async (reason, content, size) => {
			const files = sessionFiles(PROJECT, SESSION_ID, '{}', content);
			const transcript = path.join(
				SESSIONS_DIR,
				encodeURIComponent(PROJECT),
				SESSION_ID,
				'chat_history.jsonl'
			);
			mockLocalFs(files, {
				sizeOverrides: size === undefined ? undefined : { [transcript]: size },
			});
			expect(
				await new GrokSessionStorage().readSessionMessages(PROJECT, SESSION_ID, {
					includeNativeRecords: true,
				})
			).toMatchObject({
				messages: [],
				total: 0,
				hasMore: false,
				source: { status: 'unavailable', reason },
			});
			if (size)
				expect(vi.mocked(fs.open).mock.calls.map(([file]) => file)).not.toContain(transcript);
			expect(captureException).not.toHaveBeenCalled();
		}
	);
});

// Pins prompt_context.json as native memory facts. The
// fixture is a sanitized grok 1.0.70 file: {{GROK_HOME}} is the account root
// the session lives under, {{PROJECT}} the recorded working directory.
describe('GrokSessionStorage - prompt_context.json native memory', () => {
	const GROK_HOME = path.dirname(SESSIONS_DIR);
	const SECOND_ID = '019f0000-aaaa-7000-8000-000000000002';
	let fixture = '';

	const promptContextPath = (sessionId: string) =>
		path.join(SESSIONS_DIR, encodeURIComponent(PROJECT), sessionId, 'prompt_context.json');
	// The placeholders sit inside JSON strings, so splice the JSON-escaped
	// path: a raw Windows path (backslashes) is not valid JSON string text.
	const jsonStringText = (value: string) => JSON.stringify(value).slice(1, -1);
	const fixtureRecord = (overrides: Record<string, unknown> = {}) => ({
		...JSON.parse(
			fixture
				.split('{{GROK_HOME}}')
				.join(jsonStringText(GROK_HOME))
				.split('{{PROJECT}}')
				.join(jsonStringText(PROJECT))
		),
		...overrides,
	});
	const listOne = async (promptContext: string | undefined) => {
		const files = sessionFiles(
			PROJECT,
			SESSION_ID,
			summaryJson(SESSION_ID, PROJECT),
			chatHistoryJsonl()
		);
		if (promptContext !== undefined) files[promptContextPath(SESSION_ID)] = promptContext;
		mockLocalFs(files);
		const sessions = await new GrokSessionStorage().listSessions(PROJECT);
		expect(sessions).toHaveLength(1);
		return sessions[0];
	};

	beforeAll(async () => {
		const realFs = await vi.importActual<typeof import('fs')>('fs');
		fixture = realFs.readFileSync(
			path.join(__dirname, '../../fixtures/grok/prompt_context-1.0.70.json'),
			'utf8'
		);
	});

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('exposes the memory facts of a well-formed 1.0.70 prompt_context.json', async () => {
		const session = await listOne(JSON.stringify(fixtureRecord()));

		expect(session.nativeMetadata?.nativeMemory).toEqual({
			memoryEnabled: true,
			globalMemoryPath: path.join(GROK_HOME, 'memory-v2', 'global'),
			workspaceMemoryPath: path.join(GROK_HOME, 'memory-v2', 'workspaces', 'my-project-0a1b2c3d'),
			agentsMdFiles: [],
			promptMode: 'extend',
			nonInteractive: false,
			droppedPaths: 0,
		});
		// Parsed, so never invalid-prompt-context; it carries the same snapshot
		// reason as every other member, none of which binds to the transcript.
		expect(session.nativeMetadata?.sources?.['prompt_context.json']).toMatchObject({
			provider: 'grok',
			status: 'partial',
			reason: session.nativeMetadata?.sources?.['summary.json']?.reason,
		});
		expect(session.nativeMetadata?.sources?.['prompt_context.json']?.reason).not.toBe(
			'invalid-prompt-context'
		);
		// Facts only: none of the paths the file names is ever opened.
		const opened = vi.mocked(fs.open).mock.calls.map(([file]) => String(file));
		expect(opened.some((file) => file.includes('memory-v2'))).toBe(false);
		expect(captureException).not.toHaveBeenCalled();
	});

	it('keeps AGENTS.md entries under the project or account root, relative ones against the project', async () => {
		const session = await listOne(
			JSON.stringify(
				fixtureRecord({
					agents_md_files: [
						'AGENTS.md',
						{ path: path.join(PROJECT, 'packages', 'core', 'AGENTS.md') },
						path.join(GROK_HOME, 'AGENTS.md'),
						'AGENTS.md',
					],
				})
			)
		);

		expect(session.nativeMetadata?.nativeMemory).toMatchObject({
			// Production resolves every kept path (a comparable absolute path), so a
			// POSIX-literal PROJECT gains the drive on Windows: expect resolve, not join.
			agentsMdFiles: [
				path.resolve(PROJECT, 'AGENTS.md'),
				path.resolve(PROJECT, 'packages', 'core', 'AGENTS.md'),
				path.join(GROK_HOME, 'AGENTS.md'),
			],
			droppedPaths: 0,
		});
	});

	it('lists a session with no prompt_context.json exactly as before, beside one that has it', async () => {
		mockLocalFs({
			...sessionFiles(PROJECT, SESSION_ID, summaryJson(SESSION_ID, PROJECT), chatHistoryJsonl()),
			...sessionFiles(PROJECT, SECOND_ID, summaryJson(SECOND_ID, PROJECT), chatHistoryJsonl()),
			[promptContextPath(SECOND_ID)]: JSON.stringify(fixtureRecord()),
		});

		const sessions = await new GrokSessionStorage().listSessions(PROJECT);
		const absent = sessions.find((s) => s.sessionId === SESSION_ID);
		const present = sessions.find((s) => s.sessionId === SECOND_ID);

		expect(absent).toMatchObject({ messageCount: 3, projectPath: PROJECT });
		expect(absent?.nativeMetadata?.nativeMemory).toBeUndefined();
		expect(absent?.nativeMetadata?.sources).not.toHaveProperty(['prompt_context.json']);
		expect(present?.nativeMetadata?.nativeMemory?.memoryEnabled).toBe(true);
		expect(logger.debug).not.toHaveBeenCalledWith(
			expect.stringContaining('prompt_context.json'),
			expect.anything()
		);
		expect(captureException).not.toHaveBeenCalled();
	});

	it.each([
		['truncated JSON', '{"version": 1, "memory_v2'],
		['an array', '[]'],
		['a number', '42'],
		['null', 'null'],
		['blank', '   '],
	])(
		'logs and marks %s prompt_context.json without throwing or hiding the session',
		async (_label, content) => {
			const session = await listOne(content);

			expect(session).toMatchObject({ sessionId: SESSION_ID, messageCount: 3 });
			expect(session.nativeMetadata?.nativeMemory).toBeUndefined();
			expect(session.nativeMetadata?.sources?.['prompt_context.json']).toMatchObject({
				status: 'partial',
				reason: 'invalid-prompt-context',
			});
			expect(logger.debug).toHaveBeenCalledWith(
				`Grok session ${SESSION_ID} has malformed prompt_context.json`,
				expect.anything()
			);
			expect(captureException).not.toHaveBeenCalled();
		}
	);

	it('drops and counts every path that escapes the account or project root', async () => {
		const session = await listOne(
			JSON.stringify(
				fixtureRecord({
					memory_global_path: '/etc/grok/memory-v2/global',
					memory_workspace_path: path.join(GROK_HOME, '..', 'elsewhere', 'memory'),
					agents_md_files: [
						path.join('..', '..', 'escape', 'AGENTS.md'),
						'/etc/AGENTS.md',
						{ path: `${PROJECT}-sibling/AGENTS.md` },
						'AGENTS.md',
					],
				})
			)
		);

		expect(session.nativeMetadata?.nativeMemory).toEqual({
			memoryEnabled: true,
			agentsMdFiles: [path.resolve(PROJECT, 'AGENTS.md')],
			promptMode: 'extend',
			nonInteractive: false,
			droppedPaths: 5,
		});
		// Parsed, so never invalid-prompt-context; it carries the same snapshot
		// reason as every other member, none of which binds to the transcript.
		expect(session.nativeMetadata?.sources?.['prompt_context.json']).toMatchObject({
			provider: 'grok',
			status: 'partial',
			reason: session.nativeMetadata?.sources?.['summary.json']?.reason,
		});
		expect(session.nativeMetadata?.sources?.['prompt_context.json']?.reason).not.toBe(
			'invalid-prompt-context'
		);
	});

	it('drops memory paths under a remote ~ account root rather than guessing them', () => {
		const content = JSON.stringify({
			memory_v2_enabled: true,
			memory_global_path: '/home/u/.grok/memory-v2/global',
			memory_workspace_path: '~/.grok/memory-v2/workspaces/x',
			agents_md_files: ['AGENTS.md'],
		});

		expect(
			parseGrokPromptContext(content, {
				accountRoot: '~/.grok',
				projectRoot: '/home/u/project',
				isRemote: true,
			})
		).toEqual({
			memoryEnabled: true,
			agentsMdFiles: ['/home/u/project/AGENTS.md'],
			droppedPaths: 2,
		});
	});
});
