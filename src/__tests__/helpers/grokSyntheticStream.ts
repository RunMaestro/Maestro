/**
 * A bounded synthetic Grok `--output-format streaming-json` turn (grok 1.x shapes
 * from grok-output-parser.ts): many thought, text and tool deltas, a model-call
 * `usage` line per round, and an `end` with the native session id and turn totals.
 * No real prompt, path or credential. Shared by turn-recordings.test.ts and
 * ThinkingStreamPerformance.test.tsx; the workload is a round count, so their
 * assertions are counts and byte totals, never wall-clock numbers.
 */
function grokLine(obj: unknown): string {
	return JSON.stringify(obj) + '\n';
}

export const GROK_SYNTHETIC_ROUNDS = 400;
export const GROK_SYNTHETIC_SESSION_ID = '0197c3a2-0000-7000-8000-000000000001';

/** thought, text, tool_call, usage, tool_call_update. */
export const GROK_SYNTHETIC_LINES_PER_ROUND = 5;

export interface GrokSyntheticStream {
	/** Raw JSONL lines in arrival order, five per round plus the optional end. */
	lines: string[];
	/** The concatenated text deltas: the answer a completed turn shows. */
	answer: string;
	/** Total length of the thought deltas. */
	thoughtBytes: number;
	rounds: number;
}

export function grokSyntheticStream(
	rounds: number,
	options: { end?: 'end_turn' | 'cancelled' | null } = {}
): GrokSyntheticStream {
	const lines: string[] = [];
	let answer = '';
	let thoughtBytes = 0;
	for (let i = 0; i < rounds; i++) {
		const thought = `Step ${i}: weighing option ${i % 7}. `;
		const text = `Part ${i}. `;
		thoughtBytes += thought.length;
		answer += text;
		lines.push(grokLine({ type: 'thought', data: thought }));
		lines.push(grokLine({ type: 'text', data: text }));
		lines.push(
			grokLine({
				type: 'tool_call',
				toolCallId: `call-${i}`,
				toolName: 'read_file',
				kind: 'read',
				rawInput: { path: `fixture/file-${i}.txt` },
			})
		);
		lines.push(
			grokLine({
				type: 'usage',
				messageId: `msg-${i}`,
				usage: {
					input_tokens: 100,
					output_tokens: 20,
					cache_read_input_tokens: 50,
					cache_creation_input_tokens: 0,
					reasoning_tokens: 5,
				},
			})
		);
		lines.push(
			grokLine({
				type: 'tool_call_update',
				toolCallId: `call-${i}`,
				status: 'completed',
				content: [{ type: 'content', content: { type: 'text', text: `contents ${i}` } }],
			})
		);
	}
	const end = options.end === undefined ? 'end_turn' : options.end;
	if (end) {
		lines.push(
			grokLine({
				type: 'end',
				stopReason: end,
				sessionId: GROK_SYNTHETIC_SESSION_ID,
				requestId: '0197c3a2-0000-7000-8000-0000000000ff',
				num_turns: rounds,
				usage: {
					input_tokens: 100 * rounds,
					output_tokens: 20 * rounds,
					cache_read_input_tokens: 50 * rounds,
					cache_creation_input_tokens: 0,
					reasoning_tokens: 5 * rounds,
				},
				total_cost_usd: 0.25,
			})
		);
	}
	return { lines, answer, thoughtBytes, rounds };
}

/** Re-cut a JSONL stream into fixed-size chunks that straddle line boundaries. */
export function rechunk(lines: string[], size: number): string[] {
	const joined = lines.join('');
	const chunks: string[] = [];
	for (let at = 0; at < joined.length; at += size) chunks.push(joined.slice(at, at + size));
	return chunks;
}
