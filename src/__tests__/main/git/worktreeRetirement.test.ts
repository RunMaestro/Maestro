import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorktreeRetirement } from '../../../main/git/worktreeRetirement';

describe('worktree retirement admission', () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});
	function setup() {
		const dir = mkdtempSync(join(process.cwd(), '.retirement-test-'));
		dirs.push(dir);
		const root = join(dir, 'checkout');
		mkdirSync(root);
		const checkout = { path: root, head: 'abc', generation: 1 };
		const fence = new WorktreeRetirement();
		expect(fence.register(checkout)).toBe(true);
		return { dir, root, checkout, fence };
	}
	it('retains admissions until released and rejects stale identity', () => {
		const { checkout, fence } = setup();
		const hold = fence.admit([checkout.path]);
		expect(hold.ok).toBe(true);
		expect(fence.prepare(checkout).ok).toBe(false);
		if (hold.ok) hold.release();
		expect(fence.prepare({ ...checkout, generation: 2 }).ok).toBe(false);
		expect(fence.prepare(checkout).ok).toBe(true);
	});
	it('fences aliases and unknown paths while allowing unrelated work', () => {
		const { dir, root, checkout, fence } = setup();
		const alias = join(dir, 'alias');
		symlinkSync(root, alias, 'dir');
		const prepared = fence.prepare(checkout);
		expect(prepared.ok).toBe(true);
		expect(fence.admit([alias]).ok).toBe(false);
		expect(fence.admit([join(dir, 'missing')]).ok).toBe(false);
		const other = join(dir, 'other');
		mkdirSync(other);
		expect(fence.admit([other]).ok).toBe(true);
	});
	it('keeps ownership through removal and never aborts an in-flight removal', () => {
		const { checkout, fence } = setup();
		const prepared = fence.prepare(checkout);
		if (!prepared.ok) throw new Error(prepared.reason);
		expect(fence.commit({})).toBe(false);
		expect(fence.commit(prepared.token)).toBe(true);
		expect(fence.abort(prepared.token)).toBe(false);
		expect(fence.register(checkout)).toBe(false);
		expect(fence.admit([checkout.path]).ok).toBe(false);
		expect(fence.complete(prepared.token)).toBe(true);
		expect(fence.state(checkout.path)).toBe('removed');
	});
	it('unknown pending work blocks preparation and abort releases only its owner', () => {
		const { checkout, fence } = setup();
		const hold = fence.admit(null);
		expect(fence.prepare(checkout).ok).toBe(false);
		if (hold.ok) hold.release();
		const prepared = fence.prepare(checkout);
		if (!prepared.ok) throw new Error(prepared.reason);
		expect(fence.abort({})).toBe(false);
		expect(fence.abort(prepared.token)).toBe(true);
		expect(fence.state(checkout.path)).toBe('available');
	});
	it('excludes unsupported execution across aliases, re-registration and CLI fallback', () => {
		const { dir, root, checkout, fence } = setup();
		const alias = join(dir, 'alias');
		symlinkSync(root, alias, 'dir');
		fence.excludeUnsupportedExecution(alias);
		expect(fence.register(checkout)).toBe(true);
		const cli = fence.admit([root]);
		expect(cli.ok).toBe(true);
		if (cli.ok) cli.release();
		expect(fence.prepare(checkout)).toEqual({
			ok: false,
			reason: 'unsupported native execution: CLI-only retirement unavailable',
		});
		const other = join(dir, 'other');
		mkdirSync(other);
		const unrelated = { ...checkout, path: other };
		expect(fence.register(unrelated)).toBe(true);
		expect(fence.prepare(unrelated).ok).toBe(true);
	});
	it('fails closed when an unsupported execution path cannot be resolved', () => {
		const { dir, checkout, fence } = setup();
		fence.excludeUnsupportedExecution(join(dir, 'missing'));
		expect(fence.prepare(checkout)).toMatchObject({
			ok: false,
			reason: expect.stringContaining('unsupported'),
		});
	});
});
