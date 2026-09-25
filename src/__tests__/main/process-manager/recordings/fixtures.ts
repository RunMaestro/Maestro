/**
 * Turn recordings - maestro-lib Part Two.
 *
 * Synthetic (hand-authored, not captured) Claude Code stream-json JSONL
 * transcripts for the 9 turn-completion scenarios named in the maestro-lib
 * Part Two workplan: normal, resumed, interrupted, chunked, interleaved,
 * cut-stream, bad-exit-with-answer, silent-resume, and stop-vs-crash.
 *
 * There is no existing recorded-transcript fixture convention in this
 * codebase to build on (checked: no CLAUDE-SESSION.md wire-format reference,
 * no stdout-capture-to-disk tooling, StdoutHandler.test.ts and
 * ExitHandler.test.ts both hand-construct individual JSON events inline
 * rather than loading transcript files). Event shapes here are taken from
 * the real Claude Code output parser's own test fixtures
 * (src/__tests__/main/parsers/claude-output-parser.test.ts) as the plausible
 * source of truth, not fabricated from scratch.
 *
 * Each fixture is a sequence of raw `chunks` - strings fed to
 * `StdoutHandler.handleData()` one at a time, in order, exactly as they
 * would arrive from a child process's stdout. For most scenarios each chunk
 * is one complete JSON line; the `chunked`, `interleaved`, and `cut-stream`
 * fixtures deliberately split lines across chunk boundaries to exercise the
 * buffering behavior described in Plans/maestro-lib-turn-contract.md
 * section 4.
 */

export interface TurnRecording {
	name: string;
	description: string;
	toolType: 'claude-code';
	/** Raw stdout chunks, in arrival order. */
	chunks: string[];
	exitCode: number;
	interrupted?: boolean;
	/** Pre-existing state as if this process was spawned with --resume <id>. */
	agentSessionIdBeforeStart?: string;
	stderrBuffer?: string;
}

function line(obj: unknown): string {
	return JSON.stringify(obj) + '\n';
}

const SYSTEM_INIT = (sessionId: string) => ({
	type: 'system',
	subtype: 'init',
	session_id: sessionId,
});

const ASSISTANT_TEXT = (text: string) => ({
	type: 'assistant',
	message: { role: 'assistant', content: [{ type: 'text', text }] },
});

const ASSISTANT_TOOL_USE = (id: string, toolName: string) => ({
	type: 'assistant',
	message: {
		role: 'assistant',
		content: [{ type: 'tool_use', id, name: toolName, input: {} }],
	},
});

const RESULT = (sessionId: string, resultText: string, costUsd = 0.01) => ({
	type: 'result',
	result: resultText,
	session_id: sessionId,
	modelUsage: {
		'claude-opus-5': {
			inputTokens: 500,
			outputTokens: 100,
			cacheReadInputTokens: 50,
			cacheCreationInputTokens: 10,
			contextWindow: 200000,
		},
	},
	total_cost_usd: costUsd,
});

export const RECORDINGS: Record<string, TurnRecording> = {
	normal: {
		name: 'normal',
		description: 'A clean single turn: init, one assistant message, a result. Exit 0.',
		toolType: 'claude-code',
		chunks: [
			line(SYSTEM_INIT('sess-normal-1')),
			line(ASSISTANT_TEXT('Here is the answer.')),
			line(RESULT('sess-normal-1', 'Here is the answer.')),
		],
		exitCode: 0,
	},

	resumed: {
		name: 'resumed',
		description:
			'A turn on a process spawned with --resume <id> (agentSessionId pre-set before any output arrives). The provider confirms the SAME session id, proving continuity is correctly signaled even though this is a fresh ManagedProcess/fresh usage accumulator instance.',
		toolType: 'claude-code',
		agentSessionIdBeforeStart: 'sess-continuing-conversation',
		chunks: [
			line(SYSTEM_INIT('sess-continuing-conversation')),
			line(ASSISTANT_TEXT('Continuing where we left off.')),
			line(RESULT('sess-continuing-conversation', 'Continuing where we left off.')),
		],
		exitCode: 0,
	},

	interrupted: {
		name: 'interrupted',
		description:
			'The user pressed Stop mid-turn: partial assistant text streamed, no result event ever arrives, process exits non-zero. No agent-error should fire (interrupted suppresses the whole classification cascade), but the partial text still flushes as the answer (Factory-Droid-style no-result fallback, which is NOT gated on interrupted).',
		toolType: 'claude-code',
		chunks: [
			line(SYSTEM_INIT('sess-interrupted-1')),
			line(ASSISTANT_TEXT('Working on it when stopped')),
		],
		exitCode: 1,
		interrupted: true,
	},

	chunked: {
		name: 'chunked',
		description:
			'Identical to `normal` in content, but every line is split across two handleData() calls at an arbitrary mid-line byte offset, proving the buffering reassembles fragmented chunks into the same result as an unfragmented stream.',
		toolType: 'claude-code',
		chunks: (() => {
			const fullLines = [
				line(SYSTEM_INIT('sess-chunked-1')),
				line(ASSISTANT_TEXT('Here is the chunked answer.')),
				line(RESULT('sess-chunked-1', 'Here is the chunked answer.')),
			];
			const fragments: string[] = [];
			for (const full of fullLines) {
				const splitAt = Math.floor(full.length / 2);
				fragments.push(full.slice(0, splitAt), full.slice(splitAt));
			}
			return fragments;
		})(),
		exitCode: 0,
	},

	interleaved: {
		name: 'interleaved',
		description:
			'Text and tool_use events interleaved within one turn (text, tool_use, more text, a second tool_use, then the result), proving tool-execution events are emitted and deduped correctly alongside ordinary text without cross-contaminating the final captured answer.',
		toolType: 'claude-code',
		chunks: [
			line(SYSTEM_INIT('sess-interleaved-1')),
			line(ASSISTANT_TEXT('Let me check the file first.')),
			line(ASSISTANT_TOOL_USE('tool-1', 'Read')),
			line(ASSISTANT_TEXT('Now let me edit it.')),
			line(ASSISTANT_TOOL_USE('tool-2', 'Edit')),
			line(ASSISTANT_TEXT('Done - final answer.')),
			line(RESULT('sess-interleaved-1', 'Done - final answer.')),
		],
		exitCode: 0,
	},

	'cut-stream': {
		name: 'cut-stream',
		description:
			"The stream ends abruptly: the result envelope is the very last thing the process ever writes, with NO trailing newline, then the process exits. Exercises ExitHandler's exit-time jsonBuffer remainder flush (a short-lived run whose whole result arrives as an unterminated final line).",
		toolType: 'claude-code',
		chunks: [
			line(SYSTEM_INIT('sess-cutstream-1')),
			// Deliberately no trailing '\n' on the last line - JSON.stringify's
			// output, sliced to drop the newline `line()` would otherwise add.
			JSON.stringify(RESULT('sess-cutstream-1', 'Answer that arrived with no trailing newline.')),
		],
		exitCode: 0,
	},

	'bad-exit-with-answer': {
		name: 'bad-exit-with-answer',
		description:
			"A real answer was captured, but the process exits non-zero with stderr that doesn't match any specific Claude error pattern (an unrelated deprecation warning). Every provider's detectErrorFromExit has an unconditional 'no specific match -> generic agent_crashed' fallback for any non-zero exit (verified across all 9 providers with the check, not just Claude) - so UNLIKE the CLI (agent-spawner.ts's `!errorText && (code === 0 || hasAnswer)`), desktop chat has no 'a captured answer overrides a non-zero exit' path today. This recording documents that real, pre-existing CLI-vs-desktop divergence rather than asserting a behavior neither this migration nor ExitHandler has ever had.",
		toolType: 'claude-code',
		chunks: [
			line(SYSTEM_INIT('sess-badexit-1')),
			line(ASSISTANT_TEXT('The answer, despite what happens next.')),
			line(RESULT('sess-badexit-1', 'The answer, despite what happens next.')),
		],
		exitCode: 1,
		stderrBuffer: 'npm warn deprecated some-package@1.0.0: this package is no longer maintained',
	},

	'classified-exit-with-answer': {
		name: 'classified-exit-with-answer',
		description:
			"A real answer was captured AND the non-zero exit matches a SPECIFIC provider error pattern (auth), not the generic fallback. This pins the precedence the resolver chose: the provider's exit classification is consulted before any captured answer, so the turn is a crash carrying the specific auth message rather than a completed-with-warning. The sibling 'bad-exit-with-answer' covers the UNMATCHED exit; this one covers the matched exit, which takes a different branch and is the pair a reader would otherwise assume was an oversight.",
		toolType: 'claude-code',
		chunks: [
			line(SYSTEM_INIT('sess-classified-1')),
			line(ASSISTANT_TEXT('A complete answer, produced before the credential expired.')),
			line(
				RESULT('sess-classified-1', 'A complete answer, produced before the credential expired.')
			),
		],
		exitCode: 1,
		stderrBuffer: 'OAuth token has expired',
	},

	'silent-resume': {
		name: 'silent-resume',
		description:
			"Spawned with --resume against an old session id, but the provider silently reports a DIFFERENT session id in its init event (a session fork/rotation). The pipeline must follow the provider's authoritative report - update agentSessionId and emit the NEW id - rather than trusting the pre-spawn assumption, and the turn still completes normally.",
		toolType: 'claude-code',
		agentSessionIdBeforeStart: 'sess-old-before-rotation',
		chunks: [
			line(SYSTEM_INIT('sess-new-after-rotation')),
			line(ASSISTANT_TEXT('Answer under the rotated session.')),
			line(RESULT('sess-new-after-rotation', 'Answer under the rotated session.')),
		],
		exitCode: 0,
	},

	'stop-vs-crash-stopped': {
		name: 'stop-vs-crash-stopped',
		description:
			'Paired with stop-vs-crash-crashed: IDENTICAL stderr/exit shape that would otherwise match the rate_limited error pattern, but this run was interrupted by the user. No agent-error should fire.',
		toolType: 'claude-code',
		chunks: [
			line(SYSTEM_INIT('sess-stopvscrash-a')),
			line(ASSISTANT_TEXT('Partial work before stop.')),
		],
		exitCode: 1,
		interrupted: true,
		stderrBuffer: 'Error: rate limit exceeded, please try again later',
	},

	'stop-vs-crash-crashed': {
		name: 'stop-vs-crash-crashed',
		description:
			'Paired with stop-vs-crash-stopped: the SAME stderr/exit shape, but this run was NOT interrupted. An agent-error (rate_limited) should fire, proving the distinction is real, not accidental.',
		toolType: 'claude-code',
		chunks: [
			line(SYSTEM_INIT('sess-stopvscrash-b')),
			line(ASSISTANT_TEXT('Partial work before crash.')),
		],
		exitCode: 1,
		interrupted: false,
		stderrBuffer: 'Error: rate limit exceeded, please try again later',
	},
};
