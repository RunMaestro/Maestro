/**
 * Captured turn recordings - real provider output, not hand-authored.
 *
 * Each JSON file in `captured/` is one real turn from a real binary: every
 * stdout chunk exactly as it arrived (same bytes, same boundaries), the stderr,
 * and the `close` event's code and signal. They sit beside the synthetic
 * recordings in fixtures.ts so the same two harnesses (desktop chat and the
 * CLI) replay both: the synthetic ones pin each edge case on purpose, these
 * prove the pipeline agrees with what providers actually write today.
 *
 * Three turns per provider, the three a user produces most: a normal turn, a
 * resumed turn (the second question in the same conversation), and a turn
 * stopped while a tool was running. Stopped turns are captured twice, once
 * per stop signal, because the two surfaces stop differently and the
 * providers answer each differently:
 *
 * - The desktop Stop button sends SIGINT (ProcessManager.interrupt). Claude
 *   Code answers it by writing an error result and exiting 0; OpenCode dies
 *   on the signal with no exit code.
 * - A CLI stop sends SIGTERM (linkAbortSignal in agent-spawner.ts). Claude
 *   Code exits 143 without a result; OpenCode again dies on the signal.
 *
 * Captured on macOS, 2026-09-28, Claude Code 2.1.282 and OpenCode 1.18.23,
 * with the args Maestro passes (see `command` in each file). To keep the
 * capturing machine out of the repo, the Claude init event is trimmed: `cwd`
 * reads `/project`, MCP servers, skills and plugins are emptied, MCP tools and
 * plugin slash commands are dropped, and the local memory, scratchpad and
 * socket paths are removed. The parser reads none of those except
 * `slash_commands`, which keeps Claude Code's own commands. Em and en dashes
 * in provider text are replaced with hyphens (repo rule). Nothing else was
 * edited.
 */

import type { TurnRecording } from './fixtures';

import claudeCodeNormal from './captured/claude-code-normal.json';
import claudeCodeResumed from './captured/claude-code-resumed.json';
import claudeCodeStoppedSigint from './captured/claude-code-stopped-sigint.json';
import claudeCodeStoppedSigterm from './captured/claude-code-stopped-sigterm.json';
import opencodeNormal from './captured/opencode-normal.json';
import opencodeResumed from './captured/opencode-resumed.json';
import opencodeStoppedSigint from './captured/opencode-stopped-sigint.json';
import opencodeStoppedSigterm from './captured/opencode-stopped-sigterm.json';

interface CapturedTurn {
	provider: string;
	chunks: string[];
	stderr: string;
	close: { code: number | null; signal: string | null };
}

/** The session id of each provider's normal turn, which its resumed turn continues. */
export const CAPTURED_CLAUDE_CODE_SESSION_ID = '45d40dd0-9d71-4dce-ac14-9e613684200b';
export const CAPTURED_OPENCODE_SESSION_ID = 'ses_f16769d8cffe7rc1MP406tiARM';

function fromCapture(
	name: string,
	description: string,
	capture: CapturedTurn,
	options: { interrupted?: boolean; agentSessionIdBeforeStart?: string } = {}
): TurnRecording {
	if (capture.provider !== 'claude-code' && capture.provider !== 'opencode') {
		throw new Error(`${name}: no replay support for provider ${capture.provider}`);
	}
	return {
		name,
		description,
		toolType: capture.provider,
		chunks: capture.chunks,
		exitCode: capture.close.code,
		exitSignal: capture.close.signal as NodeJS.Signals | null,
		stderrBuffer: capture.stderr || undefined,
		...options,
	};
}

export const CAPTURED_RECORDINGS: Record<string, TurnRecording> = {
	'captured-claude-code-normal': fromCapture(
		'captured-claude-code-normal',
		'Real Claude Code turn: SessionStart hooks, init, one assistant message, a rate-limit event, a post-turn summary, a success result. Exit 0.',
		claudeCodeNormal
	),
	'captured-claude-code-resumed': fromCapture(
		'captured-claude-code-resumed',
		'Real Claude Code turn spawned with --resume against the normal turn. The provider keeps the same session id, and the answer depends on the earlier turn.',
		claudeCodeResumed,
		{ agentSessionIdBeforeStart: CAPTURED_CLAUDE_CODE_SESSION_ID }
	),
	'captured-claude-code-stopped-sigint': fromCapture(
		'captured-claude-code-stopped-sigint',
		'Real Claude Code turn stopped with SIGINT (the desktop Stop button) while its Bash tool ran. Claude writes a rejected tool result, an interrupt notice and an error_during_execution result, then exits 0.',
		claudeCodeStoppedSigint,
		{ interrupted: true }
	),
	'captured-claude-code-stopped-sigterm': fromCapture(
		'captured-claude-code-stopped-sigterm',
		'Real Claude Code turn stopped with SIGTERM (a CLI stop) while its Bash tool ran. The tool is killed (exit 137), no result is written, and Claude exits 143.',
		claudeCodeStoppedSigterm,
		{ interrupted: true }
	),
	'captured-opencode-normal': fromCapture(
		'captured-opencode-normal',
		'Real OpenCode turn: step_start, one text part, step_finish with token counts. Exit 0.',
		opencodeNormal
	),
	'captured-opencode-resumed': fromCapture(
		'captured-opencode-resumed',
		'Real OpenCode turn spawned with --session against the normal turn. All three events arrive in one chunk, and the session id is unchanged.',
		opencodeResumed,
		{ agentSessionIdBeforeStart: CAPTURED_OPENCODE_SESSION_ID }
	),
	'captured-opencode-stopped-sigint': fromCapture(
		'captured-opencode-stopped-sigint',
		'Real OpenCode turn stopped with SIGINT (the desktop Stop button) while its bash tool ran. Only step_start was written; OpenCode dies on the signal (code null).',
		opencodeStoppedSigint,
		{ interrupted: true }
	),
	'captured-opencode-stopped-sigterm': fromCapture(
		'captured-opencode-stopped-sigterm',
		'Real OpenCode turn stopped with SIGTERM (a CLI stop) while its bash tool ran. A step_start and one text part were written; OpenCode dies on the signal (code null).',
		opencodeStoppedSigterm,
		{ interrupted: true }
	),

	// The same SIGTERM bytes with nobody pressing Stop: a shutdown, a container
	// stop, or anything else outside Maestro that kills the agent mid-turn. The
	// pair shows what the interrupted flag alone decides.
	'captured-claude-code-killed-sigterm': fromCapture(
		'captured-claude-code-killed-sigterm',
		'The captured Claude Code SIGTERM turn, but NOT stopped by the user. Exit 143 with no result must read as a crash.',
		claudeCodeStoppedSigterm
	),
	'captured-opencode-killed-sigterm': fromCapture(
		'captured-opencode-killed-sigterm',
		'The captured OpenCode SIGTERM turn, but NOT stopped by the user. OpenCode died on the signal (code null) after writing partial text.',
		opencodeStoppedSigterm
	),
};
