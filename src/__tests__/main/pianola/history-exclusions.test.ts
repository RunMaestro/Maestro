// @vitest-environment node
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import {
	HistoryExclusions,
	discoverHistoricalSources,
	historicalProjectIdentity,
	readHistoricalWindow,
} from '../../../main/storage/historical-inventory';
import type { MemorySource } from '../../../shared/pianola/memory';

const temporary: string[] = [];
afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(temporary.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});
async function fixture() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pianola-exclusion-'));
	temporary.push(dir);
	return dir;
}
async function put(file: string, text: string) {
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, text);
}

it('excludes descendants, encoded provider directories, and linked Git worktrees without conflating sibling names', async () => {
	const dir = await fixture();
	const protectedProject = path.join(dir, 'Software', 'atg');
	const alias = path.join(dir, 'separate-worktree');
	const common = path.join(protectedProject, '.git');
	const worktreeGit = path.join(common, 'worktrees', 'linked');
	await fs.mkdir(alias, { recursive: true });
	await put(path.join(worktreeGit, 'commondir'), '../..');
	await put(path.join(worktreeGit, 'gitdir'), path.join(alias, '.git'));
	await put(path.join(alias, '.git'), 'gitdir: ' + worktreeGit);
	const policy = await HistoryExclusions.create([protectedProject]);
	expect(
		policy.excludesPath(path.join(protectedProject.toUpperCase(), 'child', 'session.jsonl'))
	).toBe(true);
	const encoded = path.resolve(protectedProject).replace(/[^a-zA-Z0-9]+/g, '-');
	expect(policy.excludesPath(path.join(dir, 'native', 'projects', encoded, 'session.jsonl'))).toBe(
		true
	);
	expect(await policy.excludesProject(alias)).toBe(true);
	expect(await historicalProjectIdentity(alias)).toBe(
		await historicalProjectIdentity(protectedProject)
	);
	expect(policy.excludesPath(path.join(dir, 'Software', 'atg-sibling', 'session.jsonl'))).toBe(
		false
	);
});

it('excludes a project discovered after title and conversation fields', async () => {
	const dir = await fixture();
	const protectedProject = path.join(dir, 'Software', 'atg');
	const root = path.join(dir, 'codex');
	const file = path.join(root, 'sessions', 'old', 'rollout-protected.jsonl');
	await put(
		file,
		[
			{ type: 'title', title: 'Earlier title' },
			{ type: 'queue-operation', content: { cwd: path.join(dir, 'allowed-decoy') } },
			{
				type: 'session_meta',
				payload: { id: 'protected', cwd: protectedProject, base_instructions: 'PROTECTED CONTENT' },
			},
		]
			.map((record) => JSON.stringify(record))
			.join('\n') + '\n'
	);
	const policy = await HistoryExclusions.create([protectedProject]);
	const sources = [];
	for await (const source of discoverHistoricalSources(
		{ provider: 'codex', path: root, userId: 'owner', authorship: 'human', enabled: true },
		policy
	))
		sources.push(source);
	expect(sources).toEqual([]);
});

it('discovers OMP sessions whose title precedes the session header', async () => {
	const dir = await fixture();
	const root = path.join(dir, 'omp');
	const project = path.join(dir, 'project');
	const file = path.join(root, 'agent/sessions/project/session.jsonl');
	await put(
		file,
		[
			{ type: 'title', title: 'A title with Unicode 東京' },
			{ type: 'session', id: 'actual-session', cwd: project },
		]
			.map((record) => JSON.stringify(record))
			.join('\n') + '\n'
	);
	const policy = await HistoryExclusions.create([]);
	const sources = [];
	for await (const source of discoverHistoricalSources(
		{ provider: 'omp', path: root, userId: 'owner', authorship: 'human', enabled: true },
		policy
	))
		sources.push(source);
	expect(sources).toEqual([
		expect.objectContaining({
			sessionId: 'actual-session',
			projectPath: project,
			state: 'pending',
		}),
	]);
});

it('discovers Grok sessions from nested summary cwd', async () => {
	const dir = await fixture();
	const root = path.join(dir, 'grok');
	const project = path.join(dir, 'project');
	const file = path.join(root, 'sessions', 'session-id', 'chat_history.jsonl');
	await put(file, JSON.stringify({ role: 'user', content: 'Prefer SQLite' }) + '\n');
	await put(
		path.join(root, 'sessions', 'session-id', 'summary.json'),
		JSON.stringify({ info: { cwd: project } })
	);
	const policy = await HistoryExclusions.create([]);
	const sources = [];
	for await (const source of discoverHistoricalSources(
		{ provider: 'grok', path: root, userId: 'owner', authorship: 'human', enabled: true },
		policy
	))
		sources.push(source);
	expect(sources).toEqual([
		expect.objectContaining({ sessionId: 'session-id', projectPath: project, state: 'pending' }),
	]);
});

it('never opens a protected transcript when reading a previously inventoried source', async () => {
	const dir = await fixture();
	const protectedProject = path.join(dir, 'Software', 'rca');
	const file = path.join(dir, 'native', 'opaque.jsonl');
	await put(file, 'PROTECTED CONTENT');
	const source = {
		projectPath: path.join(protectedProject, 'child'),
		projectId: 'old-identity',
		filePath: file,
	} as MemorySource;
	const policy = await HistoryExclusions.create([protectedProject]);
	const open = vi.spyOn(fs, 'open');
	await expect(readHistoricalWindow(source, 0, policy)).rejects.toThrow(/excluded/);
	expect(open).not.toHaveBeenCalled();
});

it('does not trust an old source identity after a transcript rewrite', async () => {
	const dir = await fixture();
	const protectedProject = path.join(dir, 'Software', 'jb');
	const root = path.join(dir, 'codex');
	const file = path.join(root, 'sessions', 'rollout-rewritten.jsonl');
	const oldProject = path.join(dir, 'allowed');
	const policy = await HistoryExclusions.create(
		[protectedProject],
		[
			{
				projectPath: oldProject,
				projectId: 'old',
				filePath: file,
				provider: 'codex',
				revision: 'outdated',
			},
		]
	);
	const prefix = '{"type":"session_meta","payload":{"cwd":' + JSON.stringify(protectedProject);
	await put(file, prefix + ',"base_instructions":"PROTECTED CONTENT"}}\n');
	const sources = [];
	for await (const source of discoverHistoricalSources(
		{ provider: 'codex', path: root, userId: 'owner', authorship: 'human', enabled: true },
		policy
	))
		sources.push(source);
	expect(sources).toEqual([]);
});
