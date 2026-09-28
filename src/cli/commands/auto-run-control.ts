// Auto Run control commands - stop a running Auto Run and recover from an Auto
// Run error pause (resume / skip / abort), plus reset a document's tasks. These
// mirror the desktop Auto Run toolbar and error-pause actions, each via its own
// WS message. Pair with `auto-run` (which launches) for full lifecycle control.

import * as path from 'path';
import { withMaestroClient } from '../services/maestro-client';
import {
	runAgentCommand,
	failCommand,
	errorFrameMessage,
	resolveAgentOrFail,
} from '../services/session-command';
import { resolveCliPath } from '../utils/parse';

interface AutoRunControlOptions {
	json?: boolean;
}

export async function stopAutoRun(agentId: string, options: AutoRunControlOptions): Promise<void> {
	await runAgentCommand(agentId, options, (sessionId) => ({
		type: 'stop_auto_run',
		responseType: 'stop_auto_run_result',
		successMessage: `Stopped Auto Run for ${sessionId}`,
	}));
}

export async function resumeAutoRun(
	agentId: string,
	options: AutoRunControlOptions
): Promise<void> {
	await runAgentCommand(agentId, options, (sessionId) => ({
		type: 'resume_auto_run_error',
		responseType: 'resume_auto_run_error_result',
		successMessage: `Resumed Auto Run for ${sessionId}`,
	}));
}

export async function skipAutoRun(agentId: string, options: AutoRunControlOptions): Promise<void> {
	await runAgentCommand(agentId, options, (sessionId) => ({
		type: 'skip_auto_run_document',
		responseType: 'skip_auto_run_document_result',
		successMessage: `Skipped current Auto Run document for ${sessionId}`,
	}));
}

export async function abortAutoRun(agentId: string, options: AutoRunControlOptions): Promise<void> {
	await runAgentCommand(agentId, options, (sessionId) => ({
		type: 'abort_auto_run_error',
		responseType: 'abort_auto_run_error_result',
		successMessage: `Aborted Auto Run for ${sessionId}`,
	}));
}

export async function resetAutoRunTasks(
	agentId: string,
	filename: string,
	options: AutoRunControlOptions
): Promise<void> {
	const trimmed = (filename ?? '').trim();
	// Mirror the server-side validation so we fail before opening a connection:
	// no traversal, no backslashes, no absolute paths (POSIX or Windows).
	if (
		!trimmed ||
		trimmed.includes('..') ||
		trimmed.includes('\\') ||
		trimmed.startsWith('/') ||
		/^[A-Za-z]:[\\/]/.test(trimmed)
	) {
		failCommand(
			'Invalid filename (must be a relative path under the Auto Run folder)',
			options.json
		);
	}

	await runAgentCommand(agentId, options, (sessionId) => ({
		type: 'reset_auto_run_doc_tasks',
		responseType: 'reset_auto_run_doc_tasks_result',
		successMessage: `Reset tasks in "${trimmed}" for ${sessionId}`,
		extraPayload: { filename: trimmed },
	}));
}

interface AutoRunStatusState {
	isRunning: boolean;
	isStopping?: boolean;
	totalTasks: number;
	completedTasks: number;
	totalDocuments?: number;
	currentDocumentIndex?: number;
	totalTasksAcrossAllDocs?: number;
	completedTasksAcrossAllDocs?: number;
	errorPaused?: boolean;
	errorMessage?: string;
}

/**
 * `auto-run-status <agent>` - the progress the Auto Run panel shows: whether a
 * run is active, which document it is on, and how many tasks are done. The
 * read that pairs with `auto-run` and the stop/resume/skip/abort verbs.
 */
export async function autoRunStatus(
	agentId: string,
	options: AutoRunControlOptions
): Promise<void> {
	const sessionId = resolveAgentOrFail(agentId, options.json);
	let reply: { state?: AutoRunStatusState | null } & Record<string, unknown>;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand({ type: 'get_auto_run_state', sessionId }, 'auto_run_state')
		);
	} catch (error) {
		failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
	const frameError = errorFrameMessage(reply);
	if (frameError) failCommand(frameError, options.json);

	const state = reply.state ?? null;
	if (options.json) {
		console.log(JSON.stringify({ success: true, sessionId, running: !!state?.isRunning, state }));
		return;
	}
	if (!state || !state.isRunning) {
		console.log(`No Auto Run is active on ${sessionId}.`);
		return;
	}
	const total = state.totalTasksAcrossAllDocs ?? state.totalTasks;
	const done = state.completedTasksAcrossAllDocs ?? state.completedTasks;
	const doc =
		typeof state.currentDocumentIndex === 'number' && state.totalDocuments
			? `document ${state.currentDocumentIndex + 1}/${state.totalDocuments}, `
			: '';
	const phase = state.isStopping ? 'stopping' : state.errorPaused ? 'paused on error' : 'running';
	console.log(`Auto Run ${phase} on ${sessionId}: ${doc}${done}/${total} tasks done`);
	if (state.errorPaused && state.errorMessage) console.log(`  Error: ${state.errorMessage}`);
}

/**
 * `auto-run-folder <agent> <path>` - point an existing agent at a different
 * Auto Run folder, as the panel's "Change folder" does. The desktop lists the
 * folder (over SSH for a remote agent) before it commits, so a bad path fails
 * here instead of leaving the agent pointed at nothing.
 *
 * A relative path resolves against this shell's cwd. Absolute and `~` paths
 * are sent as typed: for an SSH agent they name a path on the remote host.
 */
export async function autoRunFolder(
	agentId: string,
	folder: string,
	options: AutoRunControlOptions
): Promise<void> {
	const raw = (folder ?? '').trim();
	if (!raw) failCommand('A folder path is required', options.json);
	const folderPath = path.isAbsolute(raw) || raw.startsWith('~') ? raw : resolveCliPath(raw);
	await runAgentCommand(agentId, options, (sessionId) => ({
		type: 'set_auto_run_folder',
		responseType: 'set_auto_run_folder_result',
		successMessage: `Auto Run folder for ${sessionId} is now ${folderPath}`,
		extraPayload: { folderPath },
	}));
}
