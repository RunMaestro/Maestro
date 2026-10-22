/**
 * The worktree target of a scheduled Auto Run, in its two spellings.
 *
 * cue.yaml stores it as `auto_run.worktree` (snake_case, `CueAutoRunWorktree`);
 * the launch path the Auto Run window already uses speaks `WorktreeRunTarget`.
 * This module is the only place that converts between them and the only place
 * that decides whether a stored block is usable, so the validator, the
 * normalizer, `maestro-cli cue schedule` and the Auto Run window cannot
 * disagree about what a worktree block means.
 *
 * Pure and import-free beyond types, so the CLI bundle can use it.
 */

import type { WorktreeRunTarget } from '../types';
import {
	CUE_AUTORUN_WORKTREE_MODES,
	type CueAutoRunWorktree,
	type CueAutoRunWorktreeMode,
} from './contracts';

export type CueAutoRunWorktreeParse =
	| { ok: true; value: CueAutoRunWorktree }
	| { ok: false; error: string };

/** The one field each mode cannot work without. */
const REQUIRED_FIELD: Record<CueAutoRunWorktreeMode, 'agent_id' | 'path' | 'branch'> = {
	'existing-open': 'agent_id',
	'existing-closed': 'path',
	'create-new': 'branch',
};

function isMode(value: unknown): value is CueAutoRunWorktreeMode {
	return (
		typeof value === 'string' && (CUE_AUTORUN_WORKTREE_MODES as readonly string[]).includes(value)
	);
}

/**
 * Validate a raw `auto_run.worktree` block and return its canonical form.
 *
 * A block that cannot be resolved is an ERROR, never "no worktree": dropping
 * it would run the documents against the owning agent's own checkout, which
 * is the one place the user asked to keep them out of.
 */
export function parseCueAutoRunWorktree(raw: unknown): CueAutoRunWorktreeParse {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
		return { ok: false, error: 'must be an object' };
	}
	const block = raw as Record<string, unknown>;
	if (!isMode(block.mode)) {
		return {
			ok: false,
			error: `"mode" must be one of ${CUE_AUTORUN_WORKTREE_MODES.map((m) => `"${m}"`).join(', ')}`,
		};
	}

	const required = REQUIRED_FIELD[block.mode];
	const requiredValue = block[required];
	if (typeof requiredValue !== 'string' || requiredValue.trim().length === 0) {
		return {
			ok: false,
			error: `"${required}" is required and must be a non-empty string when mode is "${block.mode}"`,
		};
	}
	if (block.base_branch !== undefined && typeof block.base_branch !== 'string') {
		return { ok: false, error: '"base_branch" must be a string when provided' };
	}
	if (block.create_pr !== undefined && typeof block.create_pr !== 'boolean') {
		return { ok: false, error: '"create_pr" must be a boolean when provided' };
	}

	const value: CueAutoRunWorktree = { mode: block.mode, [required]: requiredValue.trim() };
	const baseBranch = block.base_branch?.trim();
	if (baseBranch) value.base_branch = baseBranch;
	if (block.create_pr === true) value.create_pr = true;
	return { ok: true, value };
}

/** cue.yaml -> the target the launch path resolves. */
export function runTargetFromCueWorktree(worktree: CueAutoRunWorktree): WorktreeRunTarget {
	return {
		mode: worktree.mode,
		...(worktree.agent_id ? { sessionId: worktree.agent_id } : {}),
		...(worktree.path ? { worktreePath: worktree.path } : {}),
		...(worktree.branch ? { newBranchName: worktree.branch } : {}),
		...(worktree.base_branch ? { baseBranch: worktree.base_branch } : {}),
		createPROnCompletion: worktree.create_pr === true,
	};
}

/**
 * The Auto Run window's choice -> cue.yaml. Only the field its mode resolves by
 * is carried: an `existing-open` target also knows its path, but the agent id
 * is what is looked up when the run fires, and writing both invites them to
 * disagree.
 */
export function cueWorktreeFromRunTarget(target: WorktreeRunTarget): CueAutoRunWorktree {
	const worktree: CueAutoRunWorktree = { mode: target.mode };
	if (target.mode === 'existing-open' && target.sessionId) worktree.agent_id = target.sessionId;
	if (target.mode === 'existing-closed' && target.worktreePath) worktree.path = target.worktreePath;
	if (target.mode === 'create-new' && target.newBranchName) worktree.branch = target.newBranchName;
	if (target.baseBranch) worktree.base_branch = target.baseBranch;
	if (target.createPROnCompletion) worktree.create_pr = true;
	return worktree;
}

/** One-line description for a Scheduled Tasks row or a CLI listing. */
export function describeCueAutoRunWorktree(worktree: CueAutoRunWorktree): string {
	if (worktree.mode === 'create-new') return `new worktree on ${worktree.branch}`;
	if (worktree.mode === 'existing-closed') return `worktree at ${worktree.path}`;
	return `worktree agent ${worktree.agent_id}`;
}
