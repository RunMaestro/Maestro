/**
 * @file action-guard.test.ts
 * @description ActionGuard bounds an ALREADY-permitted verb: rate, concurrency,
 * and audit-before-action for high-risk capabilities.
 */

import { describe, it, expect, vi } from 'vitest';
import { ActionGuard } from '../../../main/plugins/action-guard';

describe('ActionGuard', () => {
	it('allows up to the rate limit, denies within the window, recovers after it', () => {
		let t = 0;
		const guard = new ActionGuard({
			now: () => t,
			limits: { high: { windowMs: 1000, maxPerWindow: 2, maxConcurrent: 10 } },
		});
		const a = guard.begin('p', 'fs:write');
		expect(a.ok).toBe(true);
		if (a.ok) a.release();
		const b = guard.begin('p', 'fs:write');
		expect(b.ok).toBe(true);
		if (b.ok) b.release();
		expect(guard.begin('p', 'fs:write').ok).toBe(false); // 3rd within window
		t = 1001;
		expect(guard.begin('p', 'fs:write').ok).toBe(true); // window elapsed
	});

	it('enforces max concurrency and frees the slot on release', () => {
		const guard = new ActionGuard({
			limits: { high: { windowMs: 1000, maxPerWindow: 100, maxConcurrent: 1 } },
		});
		const a = guard.begin('p', 'fs:write');
		expect(a.ok).toBe(true);
		expect(guard.begin('p', 'fs:write').ok).toBe(false); // slot busy
		if (a.ok) a.release();
		expect(guard.begin('p', 'fs:write').ok).toBe(true); // slot freed
	});

	it('audits high-risk BEFORE action, but not low-risk', () => {
		const audit = vi.fn();
		const guard = new ActionGuard({ now: () => 5, audit });
		guard.begin('p', 'fs:write', '/tmp/x'); // high
		guard.begin('p', 'storage:read'); // low
		expect(audit).toHaveBeenCalledTimes(1);
		expect(audit).toHaveBeenCalledWith({
			pluginId: 'p',
			capability: 'fs:write',
			at: 5,
			target: '/tmp/x',
		});
	});

	it('keys limits independently per plugin and per capability', () => {
		const guard = new ActionGuard({
			limits: { high: { windowMs: 1000, maxPerWindow: 1, maxConcurrent: 10 } },
		});
		expect(guard.begin('p1', 'fs:write').ok).toBe(true);
		expect(guard.begin('p1', 'fs:write').ok).toBe(false); // p1+fs:write exhausted
		expect(guard.begin('p2', 'fs:write').ok).toBe(true); // different plugin
		expect(guard.begin('p1', 'process:spawn').ok).toBe(true); // different capability
	});
});
