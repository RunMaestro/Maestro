import { describe, expect, it } from 'vitest';
import { WorktreeRetirementFreeze } from '../../../renderer/services/worktreeRetirementFreeze';

describe('WorktreeRetirementFreeze', () => {
	it('freezes before inspection and retains the token until its owner cancels', () => {
		const freeze = new WorktreeRetirementFreeze();
		const result = freeze.prepare('target', 'owner', () => {
			expect(freeze.isFrozen('target')).toBe(true);
			return undefined;
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(freeze.isCurrent('target', 'owner', result.revision)).toBe(true);
		expect(freeze.cancel('target', 'other')).toBe(false);
		expect(freeze.cancel('target', 'owner')).toBe(true);
		expect(freeze.isCurrent('target', 'owner', result.revision)).toBe(false);
	});

	it('unfreezes after blockers and exceptions, without replacing another owner', () => {
		const freeze = new WorktreeRetirementFreeze();
		expect(freeze.prepare('target', 'owner', () => 'queued work')).toEqual({
			ok: false,
			reason: 'queued work',
		});
		expect(freeze.isFrozen('target')).toBe(false);
		expect(() =>
			freeze.prepare('target', 'owner', () => {
				throw new Error('inspection');
			})
		).toThrow('inspection');
		expect(freeze.isFrozen('target')).toBe(false);
		freeze.prepare('target', 'owner', () => undefined);
		expect(freeze.prepare('target', 'other', () => undefined).ok).toBe(false);
		expect(freeze.isFrozen('target')).toBe(true);
	});

	it('never acknowledges an inspection cancelled and replaced reentrantly', () => {
		const freeze = new WorktreeRetirementFreeze();
		const result = freeze.prepare('target', 'old', () => {
			freeze.cancel('target', 'old');
			freeze.prepare('target', 'new', () => undefined);
			return undefined;
		});
		expect(result).toEqual({ ok: false, reason: 'preparation invalidated' });
		expect(freeze.isFrozen('target')).toBe(true);
		expect(freeze.cancel('target', 'new')).toBe(true);
	});
	it('does not release a reentrant replacement when inspection throws', () => {
		const freeze = new WorktreeRetirementFreeze();
		expect(() =>
			freeze.prepare('target', 'token', () => {
				freeze.cancel('target', 'token');
				freeze.prepare('target', 'token', () => undefined);
				throw new Error('inspection');
			})
		).toThrow('inspection');
		expect(freeze.isFrozen('target')).toBe(true);
	});
});
