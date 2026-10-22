/**
 * @file autorun-worktree.test.ts
 * @description The worktree target of a scheduled Auto Run, between its
 * cue.yaml spelling and the `WorktreeRunTarget` the launch path resolves.
 *
 * The rule under test is that an unusable block is an ERROR, never "no
 * worktree": dropping it would run the documents in the owning agent's own
 * checkout, the one place a worktree target exists to keep them out of.
 */

import { describe, it, expect } from 'vitest';
import {
	cueWorktreeFromRunTarget,
	describeCueAutoRunWorktree,
	parseCueAutoRunWorktree,
	runTargetFromCueWorktree,
} from '../../../shared/cue/autorun-worktree';

describe('parseCueAutoRunWorktree', () => {
	it('accepts each mode with the one field it resolves by', () => {
		expect(parseCueAutoRunWorktree({ mode: 'create-new', branch: 'nightly' })).toEqual({
			ok: true,
			value: { mode: 'create-new', branch: 'nightly' },
		});
		expect(parseCueAutoRunWorktree({ mode: 'existing-open', agent_id: 'agent-9' })).toEqual({
			ok: true,
			value: { mode: 'existing-open', agent_id: 'agent-9' },
		});
		expect(parseCueAutoRunWorktree({ mode: 'existing-closed', path: '/wt/nightly' })).toEqual({
			ok: true,
			value: { mode: 'existing-closed', path: '/wt/nightly' },
		});
	});

	it('keeps the base branch and the pull-request opt-in', () => {
		expect(
			parseCueAutoRunWorktree({
				mode: 'create-new',
				branch: ' nightly ',
				base_branch: ' rc ',
				create_pr: true,
			})
		).toEqual({
			ok: true,
			value: { mode: 'create-new', branch: 'nightly', base_branch: 'rc', create_pr: true },
		});
	});

	// Only the field a mode resolves by is canonical; a stray one from another
	// mode would otherwise sit in cue.yaml disagreeing with it.
	it('drops fields that belong to another mode', () => {
		const parsed = parseCueAutoRunWorktree({
			mode: 'existing-open',
			agent_id: 'agent-9',
			path: '/wt/other',
			branch: 'other',
			create_pr: false,
		});
		expect(parsed).toEqual({ ok: true, value: { mode: 'existing-open', agent_id: 'agent-9' } });
	});

	it('rejects a block that is not an object', () => {
		for (const raw of [null, 'nightly', ['create-new'], 3]) {
			expect(parseCueAutoRunWorktree(raw)).toEqual({ ok: false, error: 'must be an object' });
		}
	});

	it('rejects an unknown mode', () => {
		const parsed = parseCueAutoRunWorktree({ mode: 'new', branch: 'nightly' });
		expect(parsed.ok).toBe(false);
		expect(parsed.ok ? '' : parsed.error).toMatch(/"mode" must be one of/);
	});

	it('rejects a mode whose required field is missing or blank', () => {
		const cases: Array<[Record<string, unknown>, RegExp]> = [
			[{ mode: 'create-new' }, /"branch" is required/],
			[{ mode: 'create-new', branch: '   ' }, /"branch" is required/],
			[{ mode: 'existing-open', branch: 'nightly' }, /"agent_id" is required/],
			[{ mode: 'existing-closed', path: 7 }, /"path" is required/],
		];
		for (const [raw, error] of cases) {
			const parsed = parseCueAutoRunWorktree(raw);
			expect(parsed.ok).toBe(false);
			expect(parsed.ok ? '' : parsed.error).toMatch(error);
		}
	});

	it('rejects wrongly typed optional fields', () => {
		expect(parseCueAutoRunWorktree({ mode: 'create-new', branch: 'n', base_branch: 3 }).ok).toBe(
			false
		);
		expect(parseCueAutoRunWorktree({ mode: 'create-new', branch: 'n', create_pr: 'yes' }).ok).toBe(
			false
		);
	});
});

describe('runTargetFromCueWorktree', () => {
	it('maps each mode onto the launch target', () => {
		expect(
			runTargetFromCueWorktree({
				mode: 'create-new',
				branch: 'nightly',
				base_branch: 'rc',
				create_pr: true,
			})
		).toEqual({
			mode: 'create-new',
			newBranchName: 'nightly',
			baseBranch: 'rc',
			createPROnCompletion: true,
		});
		expect(runTargetFromCueWorktree({ mode: 'existing-open', agent_id: 'agent-9' })).toEqual({
			mode: 'existing-open',
			sessionId: 'agent-9',
			createPROnCompletion: false,
		});
		expect(runTargetFromCueWorktree({ mode: 'existing-closed', path: '/wt/nightly' })).toEqual({
			mode: 'existing-closed',
			worktreePath: '/wt/nightly',
			createPROnCompletion: false,
		});
	});
});

describe('cueWorktreeFromRunTarget', () => {
	it('round-trips every mode through cue.yaml', () => {
		const targets = [
			{
				mode: 'create-new' as const,
				newBranchName: 'nightly',
				baseBranch: 'rc',
				createPROnCompletion: true,
			},
			{ mode: 'existing-open' as const, sessionId: 'agent-9', createPROnCompletion: false },
			{
				mode: 'existing-closed' as const,
				worktreePath: '/wt/nightly',
				createPROnCompletion: false,
			},
		];
		for (const target of targets) {
			const stored = cueWorktreeFromRunTarget(target);
			expect(parseCueAutoRunWorktree(stored)).toEqual({ ok: true, value: stored });
			expect(runTargetFromCueWorktree(stored)).toEqual(target);
		}
	});

	// The Auto Run window's target for an open worktree also knows its path, but
	// the agent id is what is looked up when the run fires.
	it('writes only the field the mode resolves by', () => {
		expect(
			cueWorktreeFromRunTarget({
				mode: 'existing-open',
				sessionId: 'agent-9',
				worktreePath: '/wt/nightly',
				newBranchName: 'ignored',
				createPROnCompletion: false,
			})
		).toEqual({ mode: 'existing-open', agent_id: 'agent-9' });
	});
});

describe('describeCueAutoRunWorktree', () => {
	it('names where the run lands', () => {
		expect(describeCueAutoRunWorktree({ mode: 'create-new', branch: 'nightly' })).toBe(
			'new worktree on nightly'
		);
		expect(describeCueAutoRunWorktree({ mode: 'existing-closed', path: '/wt/nightly' })).toBe(
			'worktree at /wt/nightly'
		);
		expect(describeCueAutoRunWorktree({ mode: 'existing-open', agent_id: 'agent-9' })).toBe(
			'worktree agent agent-9'
		);
	});
});
