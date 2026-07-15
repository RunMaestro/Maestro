/**
 * Cue Notify Executor - runs an `action: notify` subscription.
 *
 * Notify subscriptions surface a toast through the owning agent instead of
 * spawning a process. The bridge ({@link emitCueNotifyToast}) reuses the same
 * `remote:notifyToast` channel the CLI's `notify_toast` already drives, so
 * renderer-side session enrichment (project name, click-to-jump) applies for
 * free.
 *
 * The executor synthesizes a `completed` {@link CueRunResult} so the same
 * terminal-status pipeline runs (history entry, chain propagation, `time.once`
 * self-destruct). The toast send is fire-and-forget at the IPC layer - a
 * dropped send logs a warning but never fails the run, mirroring the bridge's
 * advisory contract.
 */

import { BrowserWindow } from 'electron';
import type { CueEvent, CueRunResult, CueSubscription } from './cue-types';
import type { SessionInfo } from '../../shared/types';
import { emitCueNotifyToast, type CueNotifyClickAction } from './cue-notify-bridge';

export interface CueNotifyExecutionConfig {
	runId: string;
	session: SessionInfo;
	subscription: CueSubscription;
	event: CueEvent;
	/** Owning agent id - receives the toast and is the jump target on click. */
	agentId: string;
	/** Pre-resolved toast body (after the message fallback chain). */
	message: string;
	/** Sticky toast - disables auto-dismiss, requires explicit click-to-close. */
	sticky?: boolean;
	/** Override the default click intent (defaults to jump-session for the agent). */
	clickAction?: CueNotifyClickAction;
	/** Toast title - typically the agent display name. */
	title: string;
	mainWindow: BrowserWindow | null;
	onLog: (level: string, message: string) => void;
}

/**
 * Execute a Cue-triggered notify action. Emits a toast via the bridge and
 * returns a synthesized `completed` `CueRunResult`. Never throws - toast send
 * failures degrade to a warning log so the completion path still runs (and
 * `time.once` notify subs self-destruct on the first attempt regardless).
 */
export async function executeCueNotify(config: CueNotifyExecutionConfig): Promise<CueRunResult> {
	const { runId, session, subscription, event, agentId, message, sticky, clickAction, title } =
		config;
	const startedAt = new Date().toISOString();

	config.onLog(
		'cue',
		`[CUE] Notify run ${runId}: "${subscription.name}" → agent ${agentId} (${event.type})`
	);

	const sent = emitCueNotifyToast(config.mainWindow, {
		agentId,
		title,
		message,
		sticky,
		clickAction,
	});

	const endedAt = new Date().toISOString();

	return {
		runId,
		sessionId: session.id,
		sessionName: session.name,
		subscriptionName: subscription.name,
		pipelineName: subscription.pipeline_name,
		event,
		// Notify is advisory - even when the renderer is unavailable we report
		// `completed` so the terminal-status pipeline (history, self-destruct,
		// chain propagation) runs. The warn log from the bridge captures the
		// drop for triage.
		status: 'completed',
		stdout: message,
		stderr: sent ? '' : 'mainWindow unavailable - toast not delivered',
		exitCode: 0,
		durationMs: 0,
		startedAt,
		endedAt,
	};
}
