/**
 * The runtime's History: `list` reads an agent's own History with the shared History of its
 * project (`.maestro/history/`), and `share` copies a new entry there when the agent shares.
 * Real temp directories; the agent repository is a map.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setMaestroLibLogger } from '../../host';
import type { AgentRecord } from '../../store/records';
import { sharedHistoryDir, sharedHistoryFilename } from '../../store/shared-history';
import type { HistoryEntry } from '../../../types';
import { createRuntimeHistory, type RuntimeHistoryOptions } from '../history';

const entry = (id: string, timestamp: number, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
	id,
	type: 'USER',
	timestamp,
	summary: `summary ${id}`,
	projectPath: '/p',
	...extra,
});

const jsonl = (entries: unknown[]) => entries.map((e) => `${JSON.stringify(e)}\n`).join('');

const SHARED = { label: 'box.host', hostname: 'box' };

describe('createRuntimeHistory', () => {
	let root: string;
	let historyDir: string;
	let project: string;
	let agents: Map<string, AgentRecord>;

	const make = (options: Partial<RuntimeHistoryOptions> = {}) =>
		createRuntimeHistory({
			paths: { historyDir },
			repository: { getAgent: (id: string) => agents.get(id) } as never,
			shared: SHARED,
			...options,
		});

	const addAgent = (id: string, extra: Partial<AgentRecord> = {}) => {
		agents.set(id, { id, name: id, toolType: 'claude-code', cwd: project, ...extra });
	};
	const writeOwn = (agentId: string, entries: HistoryEntry[]) => {
		fs.mkdirSync(historyDir, { recursive: true });
		fs.writeFileSync(path.join(historyDir, `${agentId}.jsonl`), jsonl(entries));
	};
	const writeShared = (label: string, entries: HistoryEntry[], at = project) => {
		fs.mkdirSync(sharedHistoryDir(at), { recursive: true });
		fs.writeFileSync(path.join(sharedHistoryDir(at), sharedHistoryFilename(label)), jsonl(entries));
	};
	const readShared = (label: string, at = project): HistoryEntry[] => {
		const file = path.join(sharedHistoryDir(at), sharedHistoryFilename(label));
		if (!fs.existsSync(file)) return [];
		return fs
			.readFileSync(file, 'utf-8')
			.split('\n')
			.filter(Boolean)
			.map((line) => JSON.parse(line));
	};

	beforeEach(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-history-test-'));
		historyDir = path.join(root, 'data', 'history');
		project = path.join(root, 'project');
		fs.mkdirSync(project, { recursive: true });
		agents = new Map();
	});

	afterEach(() => {
		fs.rmSync(root, { recursive: true, force: true });
		const noop = () => undefined;
		setMaestroLibLogger({ debug: noop, info: noop, warn: noop, error: noop });
	});

	describe('list', () => {
		it('answers not-found for an agent the repository does not hold', async () => {
			const result = await make().api.list('ghost');
			expect(result).toEqual({
				ok: false,
				error: { code: 'not-found', message: 'No agent ghost.', method: 'history.list' },
			});
		});

		it('answers the agent own History, newest first, when there is no shared History', async () => {
			addAgent('a1');
			writeOwn('a1', [entry('e1', 1), entry('e2', 3), entry('e3', 2)]);
			const result = await make().api.list('a1');
			expect(result.ok && result.value.map((e) => e.id)).toEqual(['e2', 'e3', 'e1']);
		});

		it('answers an empty list for an agent with no History at all', async () => {
			addAgent('a1');
			expect(await make().api.list('a1')).toEqual({ ok: true, value: [] });
		});

		it('merges the other writers shared files, skipping its own label and duplicate ids', async () => {
			addAgent('a1');
			writeOwn('a1', [entry('own', 5)]);
			writeShared('laptop', [entry('l1', 4), entry('own', 9)]);
			writeShared('box.host', [entry('mine-shared', 10)]);
			const result = await make().api.list('a1');
			expect(result.ok && result.value.map((e) => e.id)).toEqual(['own', 'l1']);
			// The other writer's entry carries its file label.
			expect(result.ok && result.value[1].hostname).toBe('laptop');
		});

		it('reads every shared file, its own included, without a shared identity', async () => {
			addAgent('a1');
			writeShared('box.host', [entry('b1', 2)]);
			writeShared('laptop', [entry('l1', 1)]);
			const result = await make({ shared: undefined }).api.list('a1');
			expect(result.ok && result.value.map((e) => e.id)).toEqual(['b1', 'l1']);
		});

		it('reads the shared History of projectRoot before cwd', async () => {
			const other = path.join(root, 'root');
			addAgent('a1', { projectRoot: other });
			writeShared('laptop', [entry('in-root', 2)], other);
			writeShared('laptop', [entry('in-cwd', 1)]);
			const result = await make().api.list('a1');
			expect(result.ok && result.value.map((e) => e.id)).toEqual(['in-root']);
		});

		it('keeps the newest maxEntries of each shared file', async () => {
			addAgent('a1');
			writeShared('laptop', [entry('l1', 1), entry('l2', 2), entry('l3', 3)]);
			const result = await make({ maxEntries: 2 }).api.list('a1');
			expect(result.ok && result.value.map((e) => e.id)).toEqual(['l3', 'l2']);
		});

		it('answers only the newest limit entries', async () => {
			addAgent('a1');
			writeOwn('a1', [entry('e1', 1), entry('e2', 2)]);
			writeShared('laptop', [entry('l1', 3)]);
			const history = make();
			const limited = await history.api.list('a1', { limit: 2 });
			expect(limited.ok && limited.value.map((e) => e.id)).toEqual(['l1', 'e2']);
			const none = await history.api.list('a1', { limit: 0 });
			expect(none.ok && none.value).toEqual([]);
			// A negative limit is no limit.
			const all = await history.api.list('a1', { limit: -1 });
			expect(all.ok && all.value).toHaveLength(3);
		});

		it('fails when the agent own History cannot be read', async () => {
			addAgent('a1');
			fs.mkdirSync(historyDir, { recursive: true });
			fs.writeFileSync(path.join(historyDir, 'a1.json'), 'not json at all');
			const result = await make().api.list('a1');
			expect(result.ok).toBe(false);
			expect(!result.ok && result.error).toMatchObject({ code: 'failed', method: 'history.list' });
			expect(!result.ok && result.error.message).toMatch(/could not be read/);
		});

		it('logs a shared file it cannot read and still answers the rest', async () => {
			const warn = vi.fn();
			const noop = () => undefined;
			setMaestroLibLogger({ debug: noop, info: noop, warn, error: noop });
			addAgent('a1');
			writeOwn('a1', [entry('own', 1)]);
			fs.mkdirSync(path.join(sharedHistoryDir(project), sharedHistoryFilename('broken')), {
				recursive: true,
			});
			const result = await make().api.list('a1');
			expect(result.ok && result.value.map((e) => e.id)).toEqual(['own']);
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining('A shared History file was not read'),
				'[RuntimeHistory]'
			);
		});
	});

	describe('share', () => {
		it('appends to the label own file when the project already has a shared History directory', () => {
			addAgent('a1');
			fs.mkdirSync(sharedHistoryDir(project), { recursive: true });
			make().share('a1', entry('e1', 1));
			expect(readShared('box.host')).toEqual([entry('e1', 1, { hostname: 'box' })]);
		});

		it('keeps the hostname the entry carries (the machine the turn was sent from)', () => {
			addAgent('a1');
			fs.mkdirSync(sharedHistoryDir(project), { recursive: true });
			make().share('a1', entry('e1', 1, { hostname: 'laptop.local' }));
			expect(readShared('box.host')[0].hostname).toBe('laptop.local');
		});

		it('creates the directory for an agent that opted in on its SSH record', () => {
			addAgent('a1', {
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1', shareHistoryToProjectDir: true },
			} as Partial<AgentRecord>);
			make().share('a1', entry('e1', 1));
			expect(readShared('box.host').map((e) => e.id)).toEqual(['e1']);
		});

		it('never creates the directory for an agent that did not opt in', () => {
			addAgent('a1');
			addAgent('a2', {
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1', shareHistoryToProjectDir: 'yes' },
			} as Partial<AgentRecord>);
			const history = make();
			history.share('a1', entry('e1', 1));
			history.share('a2', entry('e2', 2));
			expect(fs.existsSync(sharedHistoryDir(project))).toBe(false);
		});

		it('writes to projectRoot over cwd', () => {
			const other = path.join(root, 'root');
			addAgent('a1', { projectRoot: other });
			fs.mkdirSync(sharedHistoryDir(other), { recursive: true });
			make().share('a1', entry('e1', 1));
			expect(readShared('box.host', other).map((e) => e.id)).toEqual(['e1']);
			expect(fs.existsSync(sharedHistoryDir(project))).toBe(false);
		});

		it('does nothing without a shared identity, for an unknown agent, or one with no directory', () => {
			addAgent('a1');
			addAgent('nowhere', { cwd: '  ' });
			fs.mkdirSync(sharedHistoryDir(project), { recursive: true });
			make({ shared: undefined }).share('a1', entry('e1', 1));
			make().share('ghost', entry('e2', 2));
			make().share('nowhere', entry('e3', 3));
			expect(fs.readdirSync(sharedHistoryDir(project))).toEqual([]);
		});

		it('rotates its file down to maxEntries', () => {
			addAgent('a1');
			fs.mkdirSync(sharedHistoryDir(project), { recursive: true });
			const history = make({ maxEntries: 2 });
			history.share('a1', entry('e1', 1));
			history.share('a1', entry('e2', 2));
			history.share('a1', entry('e3', 3));
			expect(readShared('box.host').map((e) => e.id)).toEqual(['e2', 'e3']);
		});

		it('logs a failed write and never throws', () => {
			const warn = vi.fn();
			const noop = () => undefined;
			setMaestroLibLogger({ debug: noop, info: noop, warn, error: noop });
			addAgent('a1');
			fs.mkdirSync(sharedHistoryDir(project), { recursive: true });
			// A directory where the file should be: the append fails.
			fs.mkdirSync(path.join(sharedHistoryDir(project), sharedHistoryFilename('box.host')));
			expect(() => make().share('a1', entry('e1', 1))).not.toThrow();
			expect(warn).toHaveBeenCalledWith(
				expect.stringContaining('The entry was not shared to the project'),
				'[RuntimeHistory]'
			);
		});

		it('is read back by another runtime under a different label', async () => {
			addAgent('a1');
			fs.mkdirSync(sharedHistoryDir(project), { recursive: true });
			make().share('a1', entry('from-host', 1));
			const desktop = make({ shared: { label: 'laptop', hostname: 'laptop' } });
			const result = await desktop.api.list('a1');
			expect(result.ok && result.value).toEqual([entry('from-host', 1, { hostname: 'box' })]);
		});
	});
});
