import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorktreeRetirement } from '../../../main/git/worktreeRetirement';
import type { StoredSession } from '../../../main/stores/types';
import { createKeyedWriteQueue } from '../../../shared/keyedWriteQueue';
import { execGitReadOnly } from '../../../main/utils/remote-git';
import { foldPathCase } from '../../../main/utils/real-path-containment';

vi.mock('../../../main/utils/remote-git', () => ({ execGitReadOnly: vi.fn() }));

describe('trusted retirement ownership', () => {
	const dirs: string[] = [];
	afterEach(() => {
		vi.mocked(execGitReadOnly).mockReset();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	function setup() {
		const dir = realpathSync(mkdtempSync(join(process.cwd(), '.retirement-ownership-')));
		dirs.push(dir);
		const root = join(dir, 'child');
		const parent = join(dir, 'parent');
		const common = join(parent, '.git');
		const childGit = join(common, 'worktrees', 'child');
		mkdirSync(root);
		mkdirSync(childGit, { recursive: true });
		const sha = 'a'.repeat(40);
		const child: StoredSession = {
			id: 'child',
			name: 'Child',
			toolType: 'codex',
			cwd: root,
			projectRoot: root,
			parentSessionId: 'parent',
			worktreeBranch: 'feature',
		};
		const parentSession: StoredSession = {
			id: 'parent',
			name: 'Parent',
			toolType: 'codex',
			cwd: parent,
			projectRoot: parent,
		};
		const sessions = [child, parentSession];
		let generation = 1;
		const queue = createKeyedWriteQueue();
		const fence = new WorktreeRetirement();
		fence.bindRegistrationSource({
			read: () => sessions,
			generation: () => generation,
			enqueue: (operation) => queue.enqueue('sessions', operation),
		});
		const renderer = {};
		const client = fence.admitClient('primary');
		if (!client.ok) throw new Error(client.reason);
		client.loaded(renderer);
		const answers = new Map<string, string>([
			[`${root}:--show-toplevel`, root],
			[`${root}:--absolute-git-dir`, childGit],
			[`${root}:--git-common-dir`, common],
			[`${parent}:--show-toplevel`, parent],
			[`${parent}:--absolute-git-dir`, common],
			[`${parent}:--git-common-dir`, common],
			[`${root}:--verify`, sha],
			[
				`${parent}:list`,
				`worktree ${parent}\0HEAD ${sha}\0branch refs/heads/rc\0\0worktree ${root}\0HEAD ${sha}\0branch refs/heads/feature\0\0`,
			],
		]);
		vi.mocked(execGitReadOnly).mockImplementation(async (args, cwd) => {
			const answer = answers.get(`${cwd}:${args[1]}`);
			return { stdout: answer ?? '', stderr: '', exitCode: answer === undefined ? 1 : 0 };
		});
		const prepare = () => fence.prepareRegisteredForRenderer('child', renderer);
		return {
			dir,
			root,
			parent,
			common,
			childGit,
			sha,
			child,
			parentSession,
			sessions,
			fence,
			renderer,
			client,
			answers,
			queue,
			prepare,
			advance: () => generation++,
		};
	}
	it('binds a Main store id to physical Git/parent ownership and exact local HEAD', async () => {
		const f = setup();
		const result = await f.prepare();
		expect(result).toMatchObject({
			ok: true,
			expected: {
				path: foldPathCase(f.root),
				head: f.sha,
				generation: 1,
				ownership: {
					sessionId: 'child',
					parentSessionId: 'parent',
					parentPath: foldPathCase(f.parent),
					commonDir: f.common,
					gitDir: f.childGit,
					branch: 'feature',
				},
			},
		});
		expect(f.fence.admit([f.root]).ok).toBe(false);
		expect(f.fence.admit([f.parent]).ok).toBe(false);
	});
	it('accepts physical aliases and NUL-delimited paths with spaces/newlines', async () => {
		const f = setup();
		// Windows forbids newline characters in directory entry names.
		const alias = join(
			f.dir,
			process.platform === 'win32' ? 'alias with space' : 'alias with space\nand newline'
		);
		symlinkSync(f.root, alias, 'junction');
		f.child.cwd = f.child.projectRoot = alias;
		f.answers.set(
			`${f.parent}:list`,
			`worktree ${f.parent}\0\0worktree ${alias}\0HEAD ${f.sha}\0branch refs/heads/feature\0\0`
		);
		expect(await f.prepare()).toMatchObject({ ok: true, expected: { path: foldPathCase(f.root) } });
	});
	it.each(['locked', 'locked because owner', 'prunable missing', 'detached', 'bare'])(
		'refuses Git registry flag %s',
		async (flag) => {
			const f = setup();
			f.answers.set(
				`${f.parent}:list`,
				`${f.answers.get(`${f.parent}:list`)!.slice(0, -1)}${flag}\0\0`
			);
			expect(await f.prepare()).toMatchObject({ ok: false });
		}
	);
	it('refuses a primary repo registered as a child', async () => {
		const f = setup();
		f.answers.set(`${f.root}:--absolute-git-dir`, f.common);
		expect(await f.prepare()).toMatchObject({
			ok: false,
			reason: expect.stringContaining('linked worktree'),
		});
	});
	it('refuses a linked parent and a child from another common directory', async () => {
		const f = setup();
		f.answers.set(`${f.parent}:--absolute-git-dir`, f.childGit);
		expect(await f.prepare()).toMatchObject({ ok: false });
		f.answers.set(`${f.parent}:--absolute-git-dir`, f.common);
		const unrelated = join(f.dir, 'unrelated.git');
		mkdirSync(unrelated);
		f.answers.set(`${f.root}:--git-common-dir`, unrelated);
		expect(await f.prepare()).toMatchObject({ ok: false });
	});
	it('refuses a subdirectory masquerading as a checkout root', async () => {
		const f = setup();
		f.answers.set(`${f.root}:--show-toplevel`, f.parent);
		expect(await f.prepare()).toMatchObject({ ok: false });
	});
	it('refuses changed HEAD and branch independently', async () => {
		const f = setup();
		f.answers.set(`${f.root}:--verify`, 'b'.repeat(40));
		expect(await f.prepare()).toMatchObject({
			ok: false,
			reason: expect.stringContaining('HEAD changed'),
		});
		f.answers.set(`${f.root}:--verify`, f.sha);
		f.child.worktreeBranch = 'different';
		expect(await f.prepare()).toMatchObject({ ok: false });
	});
	it.each(['child', 'parent'] as const)(
		'refuses a configured SSH %s before probing local Git',
		async (which) => {
			const f = setup();
			const session = which === 'child' ? f.child : f.parentSession;
			session.sessionSshRemoteConfig = { enabled: true, remoteId: 'remote' };
			expect(await f.prepare()).toMatchObject({
				ok: false,
				reason: expect.stringContaining('SSH'),
			});
			expect(execGitReadOnly).not.toHaveBeenCalled();
		}
	);
	it('refuses duplicate ids, duplicate physical ownership and unresolvable registrations', async () => {
		const f = setup();
		f.sessions.push({ ...f.child });
		expect(await f.prepare()).toMatchObject({ ok: false });
		f.sessions.pop();
		const alias = join(f.dir, 'alias');
		symlinkSync(f.root, alias, 'junction');
		f.sessions.push({ ...f.child, id: 'other', cwd: alias });
		expect(await f.prepare()).toMatchObject({
			ok: false,
			reason: expect.stringContaining('overlaps'),
		});
		f.sessions[f.sessions.length - 1].cwd = join(f.dir, 'missing');
		expect(await f.prepare()).toMatchObject({ ok: false });
	});
	it('holds admission synchronously while queued and verifies the latest lane generation', async () => {
		const f = setup();
		let finish!: () => void;
		const prior = f.queue.enqueue(
			'sessions',
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				})
		);
		const pending = f.prepare();
		f.fence.register({ path: f.root, head: f.sha, generation: 1 });
		expect(
			f.fence.prepareForRenderer({ path: f.root, head: f.sha, generation: 1 }, f.renderer).ok
		).toBe(false);
		await Promise.resolve();
		f.advance();
		finish();
		await prior;
		expect(await pending).toMatchObject({ ok: true, expected: { generation: 2 } });
	});
	it('does not reserve over another operation admitted during Git reads', async () => {
		const f = setup();
		const pending = f.prepare();
		const writer = f.fence.admit([f.root]);
		expect(await pending).toMatchObject({
			ok: false,
			reason: expect.stringContaining('admitted work'),
		});
		if (writer.ok) writer.release();
		expect((await f.prepare()).ok).toBe(true);
	});
	it('protects the surviving parent against pending mutations and keeps unrelated work available', async () => {
		const f = setup();
		const writer = f.fence.admit([f.parent]);
		expect(await f.prepare()).toMatchObject({
			ok: false,
			reason: expect.stringContaining('admitted work'),
		});
		if (writer.ok) writer.release();
		const result = await f.prepare();
		if (!result.ok) throw new Error(result.reason);
		expect(f.fence.admit([f.common]).ok).toBe(false);
		const unrelated = join(f.dir, 'unrelated');
		mkdirSync(unrelated);
		expect(f.fence.admit([unrelated]).ok).toBe(true);
		expect(f.fence.commit(result.token)).toBe(true);
		expect(f.fence.admit([f.parent]).ok).toBe(false);
		expect(f.fence.complete(result.token)).toBe(true);
		expect(f.fence.admit([f.parent]).ok).toBe(true);
	});
	it('rechecks the exact HEAD and generation while retaining preparation on failure', async () => {
		const f = setup();
		const prepared = await f.prepare();
		if (!prepared.ok) throw new Error(prepared.reason);
		expect(await f.fence.revalidateRegistered(prepared.token)).toEqual({ ok: true });
		const nextSha = 'b'.repeat(40);
		f.answers.set(`${f.root}:--verify`, nextSha);
		f.answers.set(
			`${f.parent}:list`,
			f.answers.get(`${f.parent}:list`)!.replaceAll(f.sha, nextSha)
		);
		expect(await f.fence.revalidateRegistered(prepared.token)).toMatchObject({ ok: false });
		expect(f.fence.state(f.root)).toBe('preparing');
		expect(f.fence.admit([f.root]).ok).toBe(false);
		f.advance();
		expect(await f.fence.revalidateRegistered(prepared.token)).toMatchObject({
			ok: false,
			reason: expect.stringContaining('generation'),
		});
		expect(f.fence.abort(prepared.token)).toBe(true);
	});
	it('refuses revalidation when the renderer is lost during the Git reads', async () => {
		const f = setup();
		const prepared = await f.prepare();
		if (!prepared.ok) throw new Error(prepared.reason);
		const original = vi.mocked(execGitReadOnly).getMockImplementation()!;
		vi.mocked(execGitReadOnly).mockImplementationOnce(async (...args) => {
			f.client.invalidate();
			return original(...args);
		});
		expect(await f.fence.revalidateRegistered(prepared.token)).toMatchObject({ ok: false });
		expect(f.fence.commit(prepared.token)).toBe(false);
	});
	it('rejects generation changes and replacement registration sources during Git reads', async () => {
		const f = setup();
		const original = vi.mocked(execGitReadOnly).getMockImplementation()!;
		vi.mocked(execGitReadOnly).mockImplementationOnce(async (...args) => {
			f.advance();
			return original(...args);
		});
		expect(await f.prepare()).toMatchObject({
			ok: false,
			reason: expect.stringContaining('registration changed'),
		});
		vi.mocked(execGitReadOnly).mockImplementationOnce(async (...args) => {
			f.fence.bindRegistrationSource({
				read: () => f.sessions,
				generation: () => 2,
				enqueue: async (op) => op(),
			});
			return original(...args);
		});
		expect(await f.prepare()).toMatchObject({
			ok: false,
			reason: expect.stringContaining('registration changed'),
		});
	});
	it('requires the actual loaded primary even after successful Git verification', async () => {
		const f = setup();
		expect(await f.fence.prepareRegisteredForRenderer('child', {})).toMatchObject({ ok: false });
		f.client.invalidate();
		expect(await f.prepare()).toMatchObject({ ok: false });
	});
	it('releases failed verification holds and invalidates prepared tokens when the source changes', async () => {
		const f = setup();
		f.answers.delete(`${f.root}:--verify`);
		expect(await f.prepare()).toMatchObject({ ok: false });
		f.answers.set(`${f.root}:--verify`, f.sha);
		const result = await f.prepare();
		if (!result.ok) throw new Error(result.reason);
		f.fence.bindRegistrationSource({
			read: () => f.sessions,
			generation: () => 1,
			enqueue: async (op) => op(),
		});
		expect(f.fence.commit(result.token)).toBe(false);
		expect(f.fence.state(f.root)).toBe('available');
	});
});
