/**
 * Documented-format turn recordings - NOT captured from a run.
 *
 * captured.ts holds real turns, byte for byte, for the two providers that were
 * installed and logged in on the capturing machine (Claude Code and OpenCode).
 * The providers below were not, so there is no real turn of theirs to replay.
 * Each recording here is one normal turn WRITTEN from that provider's wire
 * format as its output parser documents it and as that parser's own tests
 * exercise it. The file each shape comes from is named beside the recording.
 *
 * What these prove: for every provider the pickers offer, a well-formed turn
 * travels the whole pipeline (desktop chat, the CLI, and the library run
 * layer) and comes out as a session id, an answer and a completed outcome.
 * What they do NOT prove: that the provider's current release still writes
 * this format. Only a capture does. `scripts/record-provider-turn.mjs` makes
 * one on any machine where the provider runs; a capture replaces the recording
 * here and moves to captured.ts.
 *
 * Hermes has no recording: it has no output parser, so there is no pipeline to
 * replay its output through.
 */

import type { TurnRecording } from './fixtures';

const ANSWER = 'The capital of France is Paris.';

function line(obj: unknown): string {
	return JSON.stringify(obj) + '\n';
}

function documented(
	name: string,
	toolType: TurnRecording['toolType'],
	description: string,
	chunks: string[]
): TurnRecording {
	return { name, description, toolType, chunks, exitCode: 0 };
}

/** The session id each documented turn announces, by recording name. */
export const DOCUMENTED_SESSION_IDS: Record<string, string> = {
	'documented-codex-normal': '019b29f7-ff2c-78f1-8bcb-ffb434a8e802',
	'documented-copilot-cli-normal': '8654632e-5527-4b25-8994-66b1be2c6cc8',
	'documented-factory-droid-normal': 'droid-session-7f3a2c',
	'documented-grok-normal': '0197c3a2-5b7e-7d10-9a41-3f2c8e6b1d04',
	'documented-omp-normal': 'omp-session-2b91',
	'documented-pi-normal': 'pi-session-5c07',
	'documented-qwen3-coder-normal': 'qwen-session-a41e',
	'documented-antigravity-normal': 'agy-conversation-93d2',
};

/** The answer every documented turn gives. */
export const DOCUMENTED_ANSWER = ANSWER;

const id = (name: string): string => DOCUMENTED_SESSION_IDS[name];

export const DOCUMENTED_RECORDINGS: Record<string, TurnRecording> = {
	// Shapes: codex-output-parser.ts ("Legacy stdout format"), which is what
	// `codex exec --json` prints: thread.started, turn.started, item.completed,
	// turn.completed.
	'documented-codex-normal': documented(
		'documented-codex-normal',
		'codex',
		'Documented Codex `exec --json` turn: thread.started, a reasoning item, an agent_message item, turn.completed with usage. Exit 0.',
		[
			line({ type: 'thread.started', thread_id: id('documented-codex-normal') }),
			line({ type: 'turn.started' }),
			line({
				type: 'item.completed',
				item: { id: 'item_0', type: 'reasoning', text: 'A one-line factual answer.' },
			}),
			line({ type: 'item.completed', item: { id: 'item_1', type: 'agent_message', text: ANSWER } }),
			line({
				type: 'turn.completed',
				usage: { input_tokens: 7956, cached_input_tokens: 6528, output_tokens: 8 },
			}),
		]
	),

	// Shapes: copilot-output-parser.ts. The session id arrives on the terminal
	// `result`, and the output tokens on the assistant.message (CLI 1.0.39+).
	'documented-copilot-cli-normal': documented(
		'documented-copilot-cli-normal',
		'copilot-cli',
		'Documented Copilot CLI turn: turn_start, one assistant.message carrying the answer and its output tokens, turn_end, a result with the session id. Exit 0.',
		[
			line({ type: 'assistant.turn_start', data: {} }),
			line({
				type: 'assistant.message',
				data: { content: ANSWER, toolRequests: [], outputTokens: 8 },
			}),
			line({ type: 'assistant.turn_end', data: {} }),
			line({
				type: 'result',
				sessionId: id('documented-copilot-cli-normal'),
				exitCode: 0,
				usage: { premiumRequests: 1 },
			}),
		]
	),

	// Shapes: factory-droid-output-parser.ts, "Verified against Factory Droid
	// CLI output (2026-01-22)".
	'documented-factory-droid-normal': documented(
		'documented-factory-droid-normal',
		'factory-droid',
		'Documented Factory Droid `exec -o stream-json` turn: init, the user message, the assistant message, a completion event with usage. Exit 0.',
		[
			line({
				type: 'system',
				subtype: 'init',
				session_id: id('documented-factory-droid-normal'),
				model: 'claude-sonnet-4-5',
				cwd: '/project',
				tools: [],
			}),
			line({
				type: 'message',
				role: 'user',
				id: 'msg-user-1',
				text: 'What is the capital of France?',
				timestamp: 1790624499000,
				session_id: id('documented-factory-droid-normal'),
			}),
			line({
				type: 'message',
				role: 'assistant',
				id: 'msg-assistant-1',
				text: ANSWER,
				timestamp: 1790624500000,
				session_id: id('documented-factory-droid-normal'),
			}),
			line({
				type: 'completion',
				finalText: ANSWER,
				numTurns: 1,
				durationMs: 1200,
				session_id: id('documented-factory-droid-normal'),
				usage: { input_tokens: 7956, output_tokens: 8, cache_read_input_tokens: 6528 },
			}),
		]
	),

	// Shapes: grok-output-parser.ts, "verified against grok v0.2.93" and 1.0.5.
	// There is no init event: the session id arrives only on the final `end`.
	'documented-grok-normal': documented(
		'documented-grok-normal',
		'grok',
		'Documented Grok `--output-format streaming-json` turn: a thought delta, the answer as text deltas, an end event carrying the session id. Exit 0.',
		[
			line({ type: 'thought', data: 'A one-line factual answer.' }),
			line({ type: 'text', data: 'The capital of France ' }),
			line({ type: 'text', data: 'is Paris.' }),
			line({
				type: 'end',
				stopReason: 'end_turn',
				sessionId: id('documented-grok-normal'),
				requestId: '0197c3a2-5b7f-7a55-8c1d-91e4d2a7c3b0',
			}),
		]
	),

	// Shapes: omp-output-parser.ts (Oh My Pi's JSON event protocol).
	'documented-omp-normal': documented(
		'documented-omp-normal',
		'omp',
		'Documented Oh My Pi `-p --mode json` turn: session, streamed text deltas, a message_end with usage, agent_end with the transcript. Exit 0.',
		piStyleTurn(id('documented-omp-normal'))
	),

	// Shapes: pi-output-parser.ts (Pi's documented JSONL protocol).
	'documented-pi-normal': documented(
		'documented-pi-normal',
		'pi',
		'Documented Pi `--mode json -p` turn: session, streamed text deltas, a message_end with usage, agent_end with the transcript. Exit 0.',
		piStyleTurn(id('documented-pi-normal'))
	),

	// Shapes: qwen-output-parser.ts. Qwen Code writes Claude Code's stream-json
	// schema, with `session_start` as its init subtype.
	'documented-qwen3-coder-normal': documented(
		'documented-qwen3-coder-normal',
		'qwen3-coder',
		'Documented Qwen Code stream-json turn: session_start, one assistant message, a success result with usage. Exit 0.',
		[
			line({
				type: 'system',
				subtype: 'session_start',
				session_id: id('documented-qwen3-coder-normal'),
			}),
			line({
				type: 'assistant',
				session_id: id('documented-qwen3-coder-normal'),
				message: { role: 'assistant', content: [{ type: 'text', text: ANSWER }] },
			}),
			line({
				type: 'result',
				subtype: 'success',
				is_error: false,
				result: ANSWER,
				session_id: id('documented-qwen3-coder-normal'),
				usage: { input_tokens: 7956, output_tokens: 8 },
			}),
		]
	),

	// Shapes: antigravity-output-parser.ts, "Derived from the published
	// headless-mode contract, not from a captured live run".
	'documented-antigravity-normal': documented(
		'documented-antigravity-normal',
		'antigravity',
		'Documented Antigravity `--output-format stream-json` turn: init, the answer as step_update text deltas, a result envelope with usage. Exit 0.',
		[
			line({
				event: 'init',
				init: { cwd: '/project', tools: [], permission_mode: 'default', model: 'gemini-3-pro' },
			}),
			line({
				event: 'step_update',
				step_update: {
					conversation_id: id('documented-antigravity-normal'),
					step_index: 0,
					state: 'ACTIVE',
					step_type: 'agent_response',
					text_delta: 'The capital of France ',
				},
			}),
			line({
				event: 'step_update',
				step_update: {
					conversation_id: id('documented-antigravity-normal'),
					step_index: 0,
					state: 'DONE',
					step_type: 'agent_response',
					text_delta: 'is Paris.',
				},
			}),
			line({
				event: 'result',
				result: {
					conversation_id: id('documented-antigravity-normal'),
					status: 'success',
					response: ANSWER,
					duration_seconds: 1.2,
					num_turns: 1,
					usage: { input_tokens: 7956, output_tokens: 8, total_tokens: 7964 },
				},
			}),
		]
	),
};

/** Pi and Oh My Pi share one protocol; only the agent that parses it differs. */
function piStyleTurn(sessionId: string): string[] {
	const message = {
		role: 'assistant',
		content: [{ type: 'text', text: ANSWER }],
		usage: { input: 7956, output: 8, cacheRead: 6528, cacheWrite: 0, cost: { total: 0.004 } },
	};
	return [
		line({ type: 'session', id: sessionId }),
		line({ type: 'agent_start' }),
		line({ type: 'turn_start' }),
		line({ type: 'message_start', message: { role: 'assistant', content: [] } }),
		line({
			type: 'message_update',
			assistantMessageEvent: { type: 'text_delta', delta: 'The capital of France ' },
		}),
		line({
			type: 'message_update',
			assistantMessageEvent: { type: 'text_delta', delta: 'is Paris.' },
		}),
		line({ type: 'message_end', message }),
		line({ type: 'turn_end' }),
		line({ type: 'agent_end', messages: [message] }),
	];
}
