/**
 * Feedback response extraction from OpenCode-style JSONL.
 *
 * OpenCode and its forks (Kilo) wrap the answer in `{ type: 'text', part: { text } }`
 * lines, so the JSON the feedback flow wants sits inside a JSON *string* with its
 * quotes escaped. The brace-balanced scan finds the envelope rather than the
 * payload, so without a dedicated strategy a successful run silently degrades to
 * the default "I didn't quite catch that" response.
 */

import { describe, expect, it } from 'vitest';
import { extractJsonFromOutput } from '../../../renderer/services/feedbackConversation';

function textEvent(text: string): string {
	return JSON.stringify({
		type: 'text',
		timestamp: 1,
		sessionID: 'ses_abc',
		part: { type: 'text', text },
	});
}

// `confidence` is a 0-100 integer (normalizeResponse rounds and clamps it).
const RESPONSE = { confidence: 90, message: 'Thanks, logged it.' };

describe('extractJsonFromOutput - OpenCode/Kilo JSONL', () => {
	it('reads the response out of a single text event', () => {
		const output = [
			JSON.stringify({ type: 'step_start', sessionID: 'ses_abc', part: { type: 'step-start' } }),
			textEvent(JSON.stringify(RESPONSE)),
			JSON.stringify({ type: 'step_finish', sessionID: 'ses_abc', part: { reason: 'stop' } }),
		].join('\n');

		const parsed = extractJsonFromOutput(output);
		expect(parsed).not.toBeNull();
		expect(parsed?.confidence).toBe(90);
		expect(parsed?.message).toBe('Thanks, logged it.');
	});

	it('concatenates text split across several streamed events', () => {
		const whole = JSON.stringify(RESPONSE);
		const half = Math.floor(whole.length / 2);
		const output = [textEvent(whole.slice(0, half)), textEvent(whole.slice(half))].join('\n');

		expect(extractJsonFromOutput(output)?.message).toBe('Thanks, logged it.');
	});

	it('handles a response fenced inside the text part', () => {
		const output = textEvent(`Here you go:\n\n\`\`\`json\n${JSON.stringify(RESPONSE)}\n\`\`\``);

		expect(extractJsonFromOutput(output)?.confidence).toBe(90);
	});

	it('returns null when no event carries a usable response', () => {
		const output = [textEvent('just some prose, no JSON here')].join('\n');

		expect(extractJsonFromOutput(output)).toBeNull();
	});

	it('still reads a bare JSON response, unchanged', () => {
		expect(extractJsonFromOutput(JSON.stringify(RESPONSE))?.message).toBe('Thanks, logged it.');
	});
});
