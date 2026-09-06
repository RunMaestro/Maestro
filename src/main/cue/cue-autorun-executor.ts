/**
 * Cue Auto Run Executor - runs an `action: autorun` subscription.
 *
 * Paired with a `time.once` trigger this is what backs "schedule this Auto Run
 * for 6am": the Cue engine already owns fire timing, persistence across
 * restarts, the missed-fire grace window, and the activity log, so scheduling
 * an Auto Run needs none of its own.
 *
 * The executor hands the captured document list to the renderer via
 * {@link launchCueAutoRun} and synthesizes a {@link CueRunResult} so the usual
 * terminal-status pipeline runs (history entry, `time.once` self-destruct).
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

import { BrowserWindow } from 'electron';
import type { CueAutoRunConfig, CueEvent, CueRunResult, CueSubscription } from './cue-types';
import type { SessionInfo } from '../../shared/types';
import { launchCueAutoRun } from './cue-autorun-bridge';

export interface CueAutoRunExecutionConfig {
	runId: string;
	session: SessionInfo;
	subscription: CueSubscription;
	event: CueEvent;
	/** Captured Auto Run payload - documents, prompt, loop settings. */
	autoRun: CueAutoRunConfig;
	mainWindow: BrowserWindow | null;
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
			`(${documents.length} document${documents.length === 1 ? '' : 's'}, ${event.type})`
	);

	const result = await launchCueAutoRun(config.mainWindow, {
		sessionId: session.id,
		documents,
		prompt: autoRun.prompt,
		loopEnabled: autoRun.loop_enabled,
		maxLoops: autoRun.max_loops,
		model: autoRun.model,
		effort: autoRun.effort,
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
