import fs from 'node:fs/promises';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { parseWorkspaceMetadata } from './copilot-session-storage';
import Database from 'better-sqlite3';
import { getSessionStorage } from '../agents/session-storage';
import { OpenCodeSessionStorage } from './opencode-session-storage';
import type { MemoryRoot, MemorySource } from '../../shared/pianola/memory';

export const HISTORY_PROVIDERS = [
	'claude-code',
	'codex',
	'opencode',
	'factory-droid',
	'copilot-cli',
	'omp',
	'grok',
] as const;
export const sourceHash = (value: string): string =>
	crypto.createHash('sha256').update(value).digest('hex');
export function defaultHistoryRoots(home = os.homedir()): MemoryRoot[] {
	const dirs = [
		'.claude',
		'.codex',
		'.local/share/opencode',
		'.factory',
		'.copilot',
		'.omp',
		'.grok',
	];
	return HISTORY_PROVIDERS.map((provider, i) => ({
		provider,
		path: path.resolve(home, dirs[i]),
		userId: null,
		authorship: 'unknown',
		enabled: false,
	}));
}
export function isHistoryExcluded(file: string, exclusions: readonly string[]): boolean {
	const normalized = path.resolve(file).replace(/\\/g, '/').toLowerCase();
	return exclusions.some((p) => {
		const n = path.resolve(p).replace(/\\/g, '/').toLowerCase();
		return normalized === n || normalized.startsWith(n + '/');
	});
}
async function* walk(dir: string, policy: HistoryExclusions): AsyncGenerator<string> {
	if (policy.excludesPath(dir)) return;
	let entries;
	try {
		entries = await fs.readdir(dir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
		throw error;
	}
	for (const entry of entries) {
		const file = path.join(dir, entry.name);
		if (policy.excludesPath(file) || entry.isSymbolicLink()) continue;
		if (entry.isDirectory()) yield* walk(file, policy);
		else if (entry.isFile()) yield file;
	}
}
async function gitCommonDirectory(cwd: string): Promise<string | null> {
	let current = path.resolve(cwd);
	while (true) {
		try {
			const git = path.join(current, '.git');
			const stat = await fs.stat(git);
			let directory = stat.isDirectory()
				? git
				: path.resolve(current, (await fs.readFile(git, 'utf8')).replace(/^gitdir:\s*/, '').trim());
			try {
				directory = path.resolve(
					directory,
					(await fs.readFile(path.join(directory, 'commondir'), 'utf8')).trim()
				);
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
			}
			return await fs.realpath(directory);
		} catch (e) {
			if (!['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) throw e;
		}
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}
/** Git-common-directory identity joins checkouts, not unrelated clones with the same remote. */
export async function historicalProjectIdentity(cwd: string): Promise<string> {
	const identity = (await gitCommonDirectory(cwd)) ?? path.resolve(cwd);
	return sourceHash(
		os.hostname() + ':' + (process.platform === 'win32' ? identity.toLowerCase() : identity)
	);
}
export interface HistoricalScope {
	projectPath: string;
	projectId: string;
	filePath?: string;
	provider?: string;
	revision?: string;
	sessionId?: string;
}
/** Paths, Git worktrees and known historical identities are checked before transcript content. */
export class HistoryExclusions {
	readonly paths: string[];
	readonly projectIds = new Set<string>();
	private readonly sources = new Map<string, HistoricalScope>();
	private readonly directories = new Map<string, string | null>();
	private constructor(paths: readonly string[], scopes: HistoricalScope[]) {
		this.paths = [...paths];
		for (const s of scopes) {
			if (s.filePath) {
				this.sources.set(path.resolve(s.filePath).toLowerCase(), s);
				if (['claude-code', 'omp', 'factory-droid', 'grok'].includes(s.provider ?? '')) {
					const key = path.dirname(s.filePath).toLowerCase();
					const prior = this.directories.get(key);
					this.directories.set(
						key,
						prior === undefined ? s.projectPath : prior === s.projectPath ? prior : null
					);
				}
			}
		}
	}
	static async create(
		paths: readonly string[],
		scopes: HistoricalScope[] = []
	): Promise<HistoryExclusions> {
		const policy = new HistoryExclusions(paths, scopes);
		for (const p of paths) {
			const real = await fs.realpath(p).catch((e) => {
				if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? ''))
					return path.resolve(p);
				throw e;
			});
			policy.paths.push(real);
			const stat = await fs.stat(real).catch((e) => {
				if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return null;
				throw e;
			});
			if (stat?.isFile()) continue;
			policy.projectIds.add(await historicalProjectIdentity(real));
			const common = await gitCommonDirectory(real);
			if (!common) continue;
			if (path.basename(common) === '.git') policy.paths.push(path.dirname(common));
			const worktrees = path.join(common, 'worktrees');
			let entries;
			try {
				entries = await fs.readdir(worktrees, { withFileTypes: true });
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue;
				throw e;
			}
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const gitdir = (
					await fs.readFile(path.join(worktrees, entry.name, 'gitdir'), 'utf8')
				).trim();
				policy.paths.push(path.dirname(gitdir));
			}
		}
		for (const scope of scopes)
			if (policy.excludesProjectMetadata(scope.projectPath, scope.projectId)) {
				policy.paths.push(scope.projectPath);
				if (scope.projectId) policy.projectIds.add(scope.projectId);
			}
		policy.paths.splice(
			0,
			policy.paths.length,
			...[...new Map(policy.paths.map((p) => [path.resolve(p).toLowerCase(), p])).values()]
		);
		return policy;
	}
	excludesProjectMetadata(cwd: string, id?: string): boolean {
		return isHistoryExcluded(cwd, this.paths) || (!!id && this.projectIds.has(id));
	}
	excludesPath(file: string): boolean {
		if (isHistoryExcluded(file, this.paths)) return true;
		const parts = path
			.resolve(file)
			.split(/[\\/]/)
			.map((p) => {
				try {
					return decodeURIComponent(p)
						.toLowerCase()
						.replace(/[^a-z0-9]+/g, '-')
						.replace(/^-|-$/g, '');
				} catch {
					return p.toLowerCase();
				}
			});
		return this.paths.some((p) => {
			const encoded = path
				.resolve(p)
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '');
			return parts.some((part) => part === encoded || part.startsWith(encoded + '-'));
		});
	}
	async excludesProject(cwd: string, id?: string): Promise<boolean> {
		if (this.excludesProjectMetadata(cwd, id)) return true;
		const real = await fs.realpath(cwd).catch((e) => {
			if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? ''))
				return path.resolve(cwd);
			throw e;
		});
		return (
			this.excludesProjectMetadata(real) ||
			(this.projectIds.size > 0 && this.projectIds.has(await historicalProjectIdentity(real)))
		);
	}
	projectForFile(file: string): string | null {
		return (
			this.sources.get(path.resolve(file).toLowerCase())?.projectPath ??
			this.directories.get(path.dirname(file).toLowerCase()) ??
			null
		);
	}
	verifiedProjectForFile(file: string, revision: string): string | null {
		const source = this.sources.get(path.resolve(file).toLowerCase());
		return source?.revision === revision ? source.projectPath : null;
	}
	async excludesSource(source: MemorySource): Promise<boolean> {
		if (
			this.excludesPath(source.filePath) ||
			(await this.excludesProject(source.projectPath, source.projectId))
		)
			return true;
		const real = await fs.realpath(source.filePath);
		return this.excludesPath(real);
	}
}
async function metadataFields(
	file: string,
	identity: 'cwd' | 'directory' | 'worktree' = 'cwd'
): Promise<Record<string, string>> {
	const handle = await fs.open(file, 'r');
	const buffer = Buffer.alloc(65536);
	const decoder = new StringDecoder('utf8');
	const limit = 1024 * 1024;
	let prefix = '';
	let pending = '';
	let consumed = 0;
	function fieldsFrom(text: string): Record<string, string> | null {
		let record: Record<string, unknown>;
		try {
			record = JSON.parse(text);
		} catch {
			return null;
		}
		if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
		const metadata = record.type === 'session_meta' ? record.payload : record;
		if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
		const fields: Record<string, string> = {};
		for (const key of ['cwd', 'directory', 'worktree', 'projectID', 'id']) {
			const value = (metadata as Record<string, unknown>)[key];
			if (typeof value === 'string') fields[key] = value;
		}
		return fields[identity] || (identity === 'directory' && fields.projectID) ? fields : null;
	}
	try {
		// Locally inspect only a bounded prefix. No conversation data leaves discovery;
		// callers apply project exclusions before parsing evidence or submitting it.
		while (consumed < limit) {
			const { bytesRead } = await handle.read(
				buffer,
				0,
				Math.min(buffer.length, limit - consumed),
				null
			);
			if (!bytesRead) break;
			consumed += bytesRead;
			const chunk = decoder.write(buffer.subarray(0, bytesRead));
			prefix += chunk;
			pending += chunk;
			let newline: number;
			while ((newline = pending.indexOf('\n')) !== -1) {
				const fields = fieldsFrom(pending.slice(0, newline));
				if (fields) return fields;
				pending = pending.slice(newline + 1);
			}
			// Metadata sidecars may be pretty-printed JSON, not JSONL.
			const fields = fieldsFrom(prefix);
			if (fields) return fields;
		}
		const fields = fieldsFrom(pending + decoder.end());
		if (fields) return fields;
		throw new Error('Historical project metadata is unavailable within the 1 MiB discovery prefix');
	} finally {
		await handle.close();
	}
}
async function header(file: string): Promise<Record<string, unknown>[]> {
	const handle = await fs.open(file, 'r');
	try {
		let data = Buffer.alloc(65536);
		let bytesRead = (await handle.read(data, 0, data.length, 0)).bytesRead;
		while (true) {
			const records = data
				.subarray(0, bytesRead)
				.toString('utf8')
				.split('\n')
				.slice(0, 64)
				.flatMap((line) => {
					try {
						return [JSON.parse(line) as Record<string, unknown>];
					} catch {
						return [];
					}
				});
			if (records.length || bytesRead < data.length || data.subarray(0, bytesRead).includes(10))
				return records;
			const next = Buffer.alloc(data.length * 2);
			data.copy(next, 0, 0, bytesRead);
			bytesRead += (await handle.read(next, bytesRead, next.length - bytesRead, bytesRead))
				.bytesRead;
			data = next;
		}
	} finally {
		await handle.close();
	}
}
function headerCwd(records: Record<string, unknown>[]): string | null {
	for (const record of records) {
		const payload = record.payload as Record<string, unknown> | undefined;
		if (typeof record.cwd === 'string') return record.cwd;
		if (typeof payload?.cwd === 'string') return payload.cwd;
	}
	return null;
}
/** Discovery reads provider metadata, not a second transcript-message parser. Content normalization remains canonical. */
export async function* discoverHistoricalSources(
	root: MemoryRoot,
	policy: HistoryExclusions
): AsyncGenerator<MemorySource> {
	if (!HISTORY_PROVIDERS.includes(root.provider as (typeof HISTORY_PROVIDERS)[number]))
		throw new Error('Unregistered historical provider');
	const account = await fs.realpath(root.path).catch((e) => {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(root.path);
		throw e;
	});
	async function ref(
		file: string,
		sessionId: string,
		cwd: string,
		revision?: string
	): Promise<MemorySource | null> {
		if (!cwd) throw new Error('Historical project metadata is missing: ' + file);
		if (policy.excludesPath(file) || (await policy.excludesProject(cwd))) return null;
		const stat = await fs.stat(file);
		return {
			id: sourceHash(`${root.provider}:${os.hostname()}:${account}:${sessionId}`),
			provider: root.provider,
			root: account,
			host: os.hostname(),
			sessionId,
			projectPath: cwd,
			projectId: await historicalProjectIdentity(cwd),
			filePath: file,
			revision: revision ?? `${stat.size}:${stat.mtimeMs}`,
			size: stat.size,
			modifiedAt: stat.mtimeMs,
			userId: root.userId,
			authorship: root.authorship,
			cursor: 0,
			state: 'pending',
		};
	}
	async function failure(file: string, error: unknown): Promise<MemorySource> {
		const stat = await fs.stat(file);
		return {
			id: sourceHash(root.provider + ':' + account + ':unattributed:' + file),
			provider: root.provider,
			root: account,
			host: os.hostname(),
			sessionId: path.basename(file),
			projectPath: '',
			projectId: sourceHash('unattributed:' + file),
			filePath: file,
			revision: stat.size + ':' + stat.mtimeMs,
			size: stat.size,
			modifiedAt: stat.mtimeMs,
			userId: root.userId,
			authorship: 'unknown',
			cursor: 0,
			state: 'failed',
			error: error instanceof Error ? error.message : String(error),
		};
	}
	if (root.provider === 'opencode') {
		const dbFile = path.join(account, 'opencode.db');
		if (!policy.excludesPath(dbFile))
			try {
				const db = new Database(dbFile, { readonly: true, fileMustExist: true });
				try {
					const rows = db
						.prepare('SELECT id,directory,time_updated FROM session ORDER BY time_updated DESC')
						.iterate() as Iterable<{ id: string; directory: string; time_updated: number }>;
					for (const row of rows) {
						try {
							const item = await ref(dbFile, row.id, row.directory, String(row.time_updated));
							if (item) {
								const messages = db
									.prepare(
										'SELECT MAX(time_updated) updated,COUNT(*) count FROM message WHERE session_id=?'
									)
									.get(row.id);
								item.revision = sourceHash(JSON.stringify([row.time_updated, messages]));
								yield item;
							}
						} catch (error) {
							yield await failure(dbFile, error);
						}
					}
				} finally {
					db.close();
				}
			} catch (e) {
				if (
					await fs.stat(dbFile).then(
						() => true,
						() => false
					)
				)
					throw e;
			}
		for await (const file of walk(path.join(account, 'storage', 'session'), policy)) {
			if (!file.endsWith('.json')) continue;
			const knownProject = policy.projectForFile(file);
			if (knownProject && (await policy.excludesProject(knownProject))) continue;
			try {
				const record = await metadataFields(file, 'directory');
				let cwd = record.directory;
				if (!cwd) {
					const projectFile = path.join(account, 'storage', 'project', record.projectID + '.json');
					if (policy.excludesPath(projectFile)) continue;
					if (path.relative(account, projectFile).startsWith('..'))
						throw new Error('Historical project metadata is outside its account');
					cwd = (await metadataFields(projectFile, 'worktree')).worktree;
				}
				const item = await ref(file, record.id ?? path.basename(file, '.json'), cwd ?? '');
				if (item) yield item;
			} catch (error) {
				yield await failure(file, error);
			}
		}
		return;
	}
	const subtree =
		root.provider === 'claude-code'
			? 'projects'
			: root.provider === 'copilot-cli'
				? 'session-state'
				: root.provider === 'omp'
					? 'agent/sessions'
					: 'sessions';
	for await (const file of walk(path.join(account, subtree), policy)) {
		if (!file.endsWith('.jsonl')) continue;
		if (root.provider === 'codex' && !path.basename(file).startsWith('rollout-')) continue;
		if (root.provider === 'copilot-cli' && path.basename(file) !== 'events.jsonl') continue;
		if (root.provider === 'grok' && path.basename(file) !== 'chat_history.jsonl') continue;
		const knownProject = policy.projectForFile(file);
		if (knownProject && (await policy.excludesProject(knownProject))) continue;
		try {
			let authorship = root.authorship;
			let cwd: string | null = null;
			let sessionId = path.basename(file, '.jsonl');
			if (root.provider === 'copilot-cli') {
				sessionId = path.basename(path.dirname(file));
				const workspace = parseWorkspaceMetadata(
					await fs.readFile(path.join(path.dirname(file), 'workspace.yaml'), 'utf8'),
					sessionId
				);
				cwd = workspace?.cwd ?? workspace?.git_root ?? null;
			} else if (root.provider === 'grok') {
				sessionId = path.basename(path.dirname(file));
				const summary = JSON.parse(
					await fs.readFile(path.join(path.dirname(file), 'summary.json'), 'utf8')
				) as { info?: { cwd?: unknown } };
				const folder = path.basename(path.dirname(path.dirname(file)));
				let decoded: string | null = null;
				try {
					decoded = decodeURIComponent(folder);
				} catch {
					decoded = null;
				}
				cwd = typeof summary.info?.cwd === 'string' ? summary.info.cwd : decoded;
				if (!cwd) throw new Error(`Cannot attribute historical project: ${file}`);
				if (await policy.excludesProject(cwd)) continue;
			} else {
				const stat = await fs.stat(file);
				const project =
					policy.verifiedProjectForFile(file, stat.size + ':' + stat.mtimeMs) ??
					(await metadataFields(file)).cwd;
				if (await policy.excludesProject(project)) continue;
				const records = await header(file);
				cwd = headerCwd(records) ?? project;
				const metadata = records.find((r) => r.type === 'session_meta' || r.type === 'session');
				const payload = metadata?.payload as { id?: string } | undefined;
				sessionId = payload?.id ?? (typeof metadata?.id === 'string' ? metadata.id : sessionId);
				if (
					root.provider === 'omp' &&
					typeof metadata?.parentSession === 'string' &&
					path.resolve(path.dirname(file)) ===
						path.resolve(metadata.parentSession.replace(/\.jsonl$/, ''))
				)
					authorship = 'automated';
				if (root.provider === 'claude-code' && records.some((r) => r.isSidechain === true))
					authorship = 'automated';
				const origin = payload && (metadata?.payload as Record<string, unknown>).source;
				if (
					root.provider === 'codex' &&
					origin &&
					typeof origin === 'object' &&
					'subagent' in origin
				)
					authorship = 'automated';
			}
			if (!cwd) throw new Error(`Cannot attribute historical project: ${file}`);
			const item = await ref(file, sessionId, cwd);
			if (item) yield { ...item, authorship };
		} catch (error) {
			yield await failure(file, error);
		}
	}
}
/** Complete JSONL records in bounded windows. A partial final record is deferred, not checkpointed. */
export async function readHistoricalWindow(
	source: MemorySource,
	cursor: number,
	policy: HistoryExclusions,
	maxBytes = 32000,
	authorize: () => boolean = () => true
) {
	if ((await policy.excludesSource(source)) || !authorize())
		throw new Error('Historical source is excluded');
	const storage =
		source.provider === 'opencode'
			? new OpenCodeSessionStorage(source.root)
			: getSessionStorage(source.provider);
	if (!storage) throw new Error('Historical reader unavailable: ' + source.provider);
	if (source.provider === 'opencode') {
		if (source.filePath.endsWith('.json')) {
			const stat = await fs.stat(source.filePath);
			if (source.revision !== stat.size + ':' + stat.mtimeMs)
				throw new Error('Historical source changed; rediscover before reading');
		} else {
			const db = new Database(source.filePath, { readonly: true, fileMustExist: true });
			let directory: string | undefined;
			try {
				directory = (
					db.prepare('SELECT directory FROM session WHERE id=?').get(source.sessionId) as
						| { directory: string }
						| undefined
				)?.directory;
			} finally {
				db.close();
			}
			if (!directory || (await policy.excludesProject(directory)))
				throw new Error('Historical source is excluded or no longer attributable');
		}
		if (!authorize()) throw new Error('Historical source is excluded');
		const result = await storage.readSessionMessages(source.projectPath, source.sessionId, {
			nativeWindow: true,
			offset: cursor,
			limit: 64,
		});
		return {
			messages: result.messages,
			cursor: result.nativeCursor ?? cursor + result.messages.length,
			complete: !result.hasMore,
		};
	}
	const handle = await fs.open(source.filePath, 'r');
	let buffer = Buffer.alloc(maxBytes);
	let consumed = 0;
	let bytesRead = 0;
	let size = 0;
	try {
		if (!authorize()) throw new Error('Historical source is excluded');
		const stat = await handle.stat();
		if (source.revision !== stat.size + ':' + stat.mtimeMs)
			throw new Error('Historical source changed; rediscover before reading');
		size = stat.size;
		if (!authorize()) throw new Error('Historical source is excluded');
		bytesRead = (await handle.read(buffer, 0, buffer.length, cursor)).bytesRead;
		consumed = buffer.subarray(0, bytesRead).lastIndexOf(10) + 1;
		while (!consumed && cursor + bytesRead < size) {
			const next = Buffer.alloc(buffer.length * 2);
			buffer.copy(next, 0, 0, bytesRead);
			if (!authorize()) throw new Error('Historical source is excluded');
			const read = await handle.read(next, bytesRead, next.length - bytesRead, cursor + bytesRead);
			bytesRead += read.bytesRead;
			buffer = next;
			consumed = buffer.subarray(0, bytesRead).lastIndexOf(10) + 1;
		}
		if (!consumed && cursor + bytesRead >= size && bytesRead) {
			// Complete final JSON without a newline is valid; an incomplete append remains pending.
			try {
				JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
				consumed = bytesRead;
			} catch {
				throw new Error(
					'Transcript has an incomplete final record; retry after the writer completes it'
				);
			}
		}
	} finally {
		await handle.close();
	}
	let content = buffer.subarray(0, consumed).toString('utf8');
	if (source.provider === 'omp' && cursor > 0)
		content =
			JSON.stringify({ type: 'session', id: source.sessionId, cwd: source.projectPath }) +
			'\n' +
			content;
	if (!authorize()) throw new Error('Historical source is excluded');
	const result = await storage.readSessionMessages(source.projectPath, source.sessionId, {
		filePath: source.filePath,
		accountDir: source.root,
		content,
	});
	return {
		messages: result.messages,
		cursor: cursor + consumed,
		complete: cursor + consumed >= size,
	};
}
