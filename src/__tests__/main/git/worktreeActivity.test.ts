import fs from 'fs/promises';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', () => ({ default: { realpath: vi.fn() } }));

const root = path.resolve('activity-fixture');
const child = path.join(root, 'child');
const sibling = `${root}-sibling`;
let gate: typeof import('../../../main/git/worktreeActivity');

beforeEach(async () => {
	vi.resetModules();
	vi.mocked(fs.realpath)
		.mockReset()
		.mockImplementation(async (p) => String(p));
	gate = await import('../../../main/git/worktreeActivity');
});

async function reserve(target = root) {
	const result = await gate.reserveWorktreeCleanup(target);
	expect(result.status).toBe('reserved-partially');
	if (result.status !== 'reserved-partially') throw new Error('Reservation failed');
	return result;
}

describe('cooperating worktree activity', () => {
	it('retains native and OS/external coverage blockers even with no participants', async () => {
		const result = await reserve();
		expect(result.blockers).toEqual([
			expect.objectContaining({ code: 'unknown', message: expect.stringContaining('native Git') }),
			expect.objectContaining({ code: 'unknown', message: expect.stringContaining('OS users') }),
		]);
		expect(result).not.toHaveProperty('snapshot');
		result.release();
	});

	it.each([root, child, path.dirname(root)])('refuses overlapping activity at %s', async (cwd) => {
		const release = await gate.beginWorktreeActivity([cwd]);
		expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
		release();
		(await reserve()).release();
	});

	it('allows unrelated paths and multiple activity paths without prefix confusion', async () => {
		const hold = await reserve();
		const release = await gate.beginWorktreeActivity([sibling]);
		await expect(gate.beginWorktreeActivity([sibling, child])).rejects.toThrow('reserved');
		expect(await gate.reserveWorktreeCleanup(sibling)).toMatchObject({ status: 'blocked' });
		release();
		(await reserve(sibling)).release();
		hold.release();
	});

	it('blocks new consumer admission until release and removes refused admissions', async () => {
		const hold = await reserve();
		await expect(gate.beginWorktreeActivity([child])).rejects.toThrow('reserved');
		hold.release();
		const release = await gate.beginWorktreeActivity([child]);
		release();
		(await reserve()).release();
	});

	it('blocks cleanup while an earlier activity is still resolving its path', async () => {
		let finish!: (value: string) => void;
		vi.mocked(fs.realpath).mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					finish = resolve;
				})
		);
		const pending = gate.beginWorktreeActivity([sibling]);
		expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
		finish(sibling);
		const release = await pending;
		(await reserve()).release();
		release();
	});

	it('loses reservation acquisition to activity admitted during its path lookup', async () => {
		let finish!: (value: string) => void;
		vi.mocked(fs.realpath).mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					finish = resolve;
				})
		);
		const pending = gate.reserveWorktreeCleanup(root);
		const release = await gate.beginWorktreeActivity([child]);
		finish(root);
		expect(await pending).toMatchObject({ status: 'blocked' });
		release();
		(await reserve()).release();
	});

	it('tracks unresolved paths as unknown and refuses unknown new consumers under a hold', async () => {
		vi.mocked(fs.realpath).mockRejectedValueOnce(new Error('unavailable'));
		const release = await gate.beginWorktreeActivity([sibling]);
		expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
		release();
		const hold = await reserve();
		await expect(gate.beginWorktreeActivity([])).rejects.toThrow('reserved');
		vi.mocked(fs.realpath).mockRejectedValueOnce(new Error('denied'));
		await expect(gate.beginWorktreeActivity([sibling])).rejects.toThrow('reserved');
		hold.release();
		(await reserve()).release();
	});

	it('resolves activity aliases but refuses alias cleanup targets and relative targets', async () => {
		const alias = path.resolve('activity-alias');
		vi.mocked(fs.realpath).mockImplementation(async (p) => (p === alias ? root : String(p)));
		const release = await gate.beginWorktreeActivity([alias]);
		expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
		release();
		for (const invalid of [alias, 'relative', ''])
			expect(await gate.reserveWorktreeCleanup(invalid)).toMatchObject({
				status: 'blocked',
				blockers: [{ code: 'path' }],
			});
		const hold = await reserve();
		await expect(gate.beginWorktreeActivity([alias])).rejects.toThrow('reserved');
		hold.release();
	});

	it('reserves atomically against another overlapping reservation', async () => {
		const results = await Promise.all([
			gate.reserveWorktreeCleanup(root),
			gate.reserveWorktreeCleanup(child),
		]);
		expect(results.map((r) => r.status).sort()).toEqual(['blocked', 'reserved-partially']);
		for (const result of results) if (result.status === 'reserved-partially') result.release();
	});

	it('keeps other activities and newer reservations held after duplicate release', async () => {
		const a = await gate.beginWorktreeActivity([root]);
		const b = await gate.beginWorktreeActivity([root]);
		a();
		a();
		expect(await gate.reserveWorktreeCleanup(root)).toMatchObject({ status: 'blocked' });
		b();
		const old = await reserve();
		old.release();
		const current = await reserve();
		old.release();
		await expect(gate.beginWorktreeActivity([root])).rejects.toThrow('reserved');
		current.release();
	});
});
