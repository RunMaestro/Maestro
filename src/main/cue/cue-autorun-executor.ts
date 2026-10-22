/**
 * Cue Auto Run Executor - runs an `action: autorun` subscription.
 *
 * Paired with a `time.once` trigger this is what backs "schedule this Auto Run
 * for 6am": the Cue engine already owns fire timing, persistence across
 * restarts, the missed-fire grace window, and the activity log, so scheduling
 * an Auto Run needs none of its own.
 *
 * The executor hands the captured document list to an injected
 * {@link CueAutoRunLauncher} and synthesizes a {@link CueRunResult} so the usual
 * terminal-status pipeline runs (history entry, `time.once` self-destruct).
 *
 * The launcher is injected rather than imported because launching an Auto Run
 * is renderer-owned, and reaching the renderer takes Electron. The Cue engine
 * has to stay runnable without the desktop app, so the desktop supplies the
 * launcher (`src/main/cue-autorun-launcher.ts`) and this module names only the
 * shape it needs.
 *
 * Status semantics matter more here than in the other executors, because a
 * `time.once` subscription is CONSUMED on a terminal status:
 *
 *   - `completed` means the renderer accepted the launch. The Auto Run itself
 *     outlives this run record by design - Cue's job was to start it.
 *   - `failed` means it did not start. Scheduled Auto Run tasks are written
 *     with `self_destruct_on_failure: false`, so the subscription survives on
 *     disk for the user to inspect or re-trigger instead of silently
 *     evaporating. That is the difference between "my 6am run failed" and "my
 *     6am run never existed".
 */

import type { CueAutoRunConfig, CueEvent, CueRunResult, CueSubscription } from './cue-types';
import type { SessionInfo, TaskSelectionMode, WorktreeRunTarget } from '../../shared/types';
import {
	describeCueAutoRunWorktree,
	runTargetFromCueWorktree,
} from '../../shared/cue/autorun-worktree';

/** One document to run, in the shape `remote:configureAutoRun` expects. */
export interface CueAutoRunDocument {
	/** Absolute path, captured when the run was scheduled. */
	filename: string;
	resetOnCompletion?: boolean;
}

export interface CueAutoRunLaunchParams {
	sessionId: string;
	documents: CueAutoRunDocument[];
	prompt?: string;
	loopEnabled?: boolean;
	maxLoops?: number;
	model?: string;
	effort?: string;
	taskSelectionMode?: TaskSelectionMode;
	ignoreModelHints?: boolean;
	autoResumeOnError?: boolean;
	autoResumeAfterMin?: number;
	maxAutoResumes?: number;
	/** Where the run executes when it is not the owning agent's own checkout. */
	worktreeTarget?: WorktreeRunTarget;
}

export interface CueAutoRunLaunchResult {
	success: boolean;
	error?: string;
}

/**
 * Starts an Auto Run and reports whether it was ACCEPTED. Must never reject: a
 * launch that could not happen resolves `{ success: false, error }`, because
 * the executor turns the result into a run status and an exception would
 * bypass that.
 */
export type CueAutoRunLauncher = (
	params: CueAutoRunLaunchParams
) => Promise<CueAutoRunLaunchResult>;

export interface CueAutoRunExecutionConfig {
	runId: string;
	session: SessionInfo;
	subscription: CueSubscription;
	event: CueEvent;
	/** Captured Auto Run payload - documents, prompt, loop settings. */
	autoRun: CueAutoRunConfig;
	/** How the run is actually started. Supplied by whoever hosts the engine. */
	launch: CueAutoRunLauncher;
	onLog: (level: string, message: string) => void;
}

/**
 * Execute a Cue-triggered Auto Run launch.
 *
 * Never throws - a launch failure is reported as a `failed` `CueRunResult` so
 * the completion pipeline still records it in the activity log. An exception
 * escaping here would skip that record entirely, which is the one outcome a
 * scheduled run cannot afford: no run, and no trace of why.
 */
export async function executeCueAutoRun(config: CueAutoRunExecutionConfig): Promise<CueRunResult> {
	const { runId, session, subscription, event, autoRun } = config;
	const startedAt = new Date().toISOString();

	const documents = autoRun.documents.map((filename, index) => ({
		filename,
		resetOnCompletion: autoRun.reset_on_completion?.[index] ?? false,
	}));

	config.onLog(
		'cue',
		`[CUE] Auto Run ${runId}: "${subscription.name}" -> agent ${session.id} ` +
			`(${documents.length} document${documents.length === 1 ? '' : 's'}, ${event.type}` +
			`${autoRun.worktree ? `, ${describeCueAutoRunWorktree(autoRun.worktree)}` : ''})`
	);

	const result = await config.launch({
		sessionId: session.id,
		documents,
		prompt: autoRun.prompt,
		loopEnabled: autoRun.loop_enabled,
		maxLoops: autoRun.max_loops,
		model: autoRun.model,
		effort: autoRun.effort,
		taskSelectionMode: autoRun.task_selection_mode,
		ignoreModelHints: autoRun.ignore_model_hints,
		autoResumeOnError: autoRun.auto_resume_on_error,
		autoResumeAfterMin: autoRun.auto_resume_after_min,
		maxAutoResumes: autoRun.max_auto_resumes,
		worktreeTarget: autoRun.worktree ? runTargetFromCueWorktree(autoRun.worktree) : undefined,
	});

	const endedAt = new Date().toISOString();
	const durationMs = Date.parse(endedAt) - Date.parse(startedAt);
	const documentList = autoRun.documents.join(', ');

	if (!result.success) {
		const reason = result.error ?? 'unknown error';
		config.onLog(
			'error',
			`[CUE] Auto Run "${subscription.name}" did not start: ${reason}. ` +
				`The subscription is kept so it can be inspected or re-triggered.`
		);
		return {
			runId,
			sessionId: session.id,
			sessionName: session.name,
			subscriptionName: subscription.name,
			pipelineName: subscription.pipeline_name,
			event,
			status: 'failed',
			stdout: '',
			stderr: `Auto Run launch failed: ${reason}`,
			exitCode: 1,
			durationMs,
			startedAt,
			endedAt,
		};
	}

	return {
		runId,
		sessionId: session.id,
		sessionName: session.name,
		subscriptionName: subscription.name,
		pipelineName: subscription.pipeline_name,
		event,
		// The launch was accepted. The Auto Run continues in the renderer and
		// reports its own progress there - this record only ever describes the
		// handoff, which is why the duration is milliseconds and not hours.
		status: 'completed',
		stdout: `Auto Run launched: ${documentList}`,
		stderr: '',
		exitCode: 0,
		durationMs,
		startedAt,
		endedAt,
	};
}
