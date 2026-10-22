/**
 * Which agent an Auto Run executes in.
 *
 * A run launched "in a worktree" does not run in the agent that launched it:
 * it runs in a worktree agent that is either already open, already on disk but
 * closed, or not created yet. Working that out is the same job wherever the
 * launch comes from - the Auto Run window's Go button, `maestro-cli auto-run
 * --worktree`, or a Cue subscription firing a scheduled run - so it lives here
 * once. Before this module the Go button handled all three modes while the
 * remote launch path handled `create-new` only, which is why a scheduled run
 * could not target a worktree at all.
 *
 * A module function rather than a hook: the remote launch path is an event
 * listener and the scheduled one has no component behind it.
 */

import type { BatchRunConfig, Session } from '../types';
import { notifyToast } from '../stores/notificationStore';
import { selectSessionById, useSessionStore } from '../stores/sessionStore';
import { captureException } from '../utils/sentry';
import { getBasename } from '../../shared/formatters';
import { spawnWorktreeAgentAndDispatch } from '../utils/worktreeSpawn';

export type AutoRunDispatchTarget =
	| { ok: true; sessionId: string }
	| {
			ok: false;
			/**
			 * `target-missing` and `target-busy` are about an `existing-open`
			 * target and are NOT announced here: the Go button falls back or asks
			 * the user to retry, while a scheduled run fails and is kept, so the
			 * wording is the caller's. `spawn-failed` has already raised its toast.
			 */
			reason: 'target-missing' | 'target-busy' | 'spawn-failed';
			message: string;
	  };

function isInFlight(session: Session): boolean {
	return session.state === 'busy' || session.state === 'connecting';
}

/**
 * Resolve `config.worktreeTarget` to the agent the run should execute in,
 * creating the worktree and its agent when the target asks for that.
 *
 * `launchingSession` is the agent the run was launched FROM - the one whose
 * Auto Run folder holds the documents. With no worktree target it is also
 * where the run executes.
 *
 * Mutates `config.worktree` when the target asks for a pull request, because
 * the path and branch a PR needs are only known once the worktree is resolved
 * (a sanitized branch name, or the path `git worktree add` reported for a
 * branch that was already attached somewhere else).
 */
export async function resolveAutoRunDispatchTarget(
	launchingSession: Session,
	config: BatchRunConfig
): Promise<AutoRunDispatchTarget> {
	const target = config.worktreeTarget;
	if (!target) return { ok: true, sessionId: launchingSession.id };

	if (target.mode === 'existing-open') {
		const targetSession = target.sessionId
			? selectSessionById(target.sessionId)(useSessionStore.getState())
			: undefined;
		if (!targetSession) {
			return {
				ok: false,
				reason: 'target-missing',
				message: `worktree agent ${target.sessionId ?? '(none)'} no longer exists`,
			};
		}
		if (isInFlight(targetSession)) {
			return {
				ok: false,
				reason: 'target-busy',
				message: `worktree agent "${targetSession.name}" is busy`,
			};
		}
		// `spawnWorktreeAgentAndDispatch` fills this in for the other two modes;
		// an open worktree never goes through it.
		if (target.createPROnCompletion) {
			config.worktree = {
				enabled: true,
				path: targetSession.cwd,
				branchName: targetSession.worktreeBranch || getBasename(targetSession.cwd) || 'worktree',
				createPROnCompletion: true,
				prTargetBranch: target.baseBranch || 'main',
			};
		}
		return { ok: true, sessionId: targetSession.id };
	}

	// create-new / existing-closed. When the launching agent is itself a
	// worktree child, the worktree is created from its PARENT, so the base path
	// and cwd come from the main repository rather than from the child.
	let parentForSpawn = launchingSession;
	if (launchingSession.parentSessionId) {
		const parent = selectSessionById(launchingSession.parentSessionId)(useSessionStore.getState());
		if (parent) parentForSpawn = parent;
	}

	try {
		const sessionId = await spawnWorktreeAgentAndDispatch(parentForSpawn, config);
		// A null return has already explained itself in a toast.
		if (!sessionId) {
			return { ok: false, reason: 'spawn-failed', message: 'Failed to spawn worktree agent' };
		}
		return { ok: true, sessionId };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		captureException(err, {
			extra: {
				operation: 'resolveAutoRunDispatchTarget',
				launchingSessionId: launchingSession.id,
				parentSessionId: parentForSpawn.id,
				worktreeTarget: target,
			},
		});
		notifyToast({ type: 'error', title: 'Worktree Error', message });
		return { ok: false, reason: 'spawn-failed', message };
	}
}
