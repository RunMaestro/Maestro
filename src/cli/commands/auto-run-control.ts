// Auto Run control commands - stop a running Auto Run and recover from an Auto
// Run error pause (resume / skip / abort), plus reset a document's tasks. These
// mirror the desktop Auto Run toolbar and error-pause actions, each via its own
// WS message. Pair with `auto-run` (which launches) for full lifecycle control.

import { runAgentCommand, failCommand } from '../services/session-command';

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
