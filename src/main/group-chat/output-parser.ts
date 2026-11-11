/**
 * Output parsing utilities for group chat.
 * Extracts text content from agent JSON/JSONL output formats.
 */

import { getOutputParser } from '../parsers';
import { createOutputParser } from '../parsers/parser-factory';
import { logger } from '../utils/logger';

/**
 * Generic text extraction fallback for unknown agent types.
 * Tries common patterns for JSON output.
 */
export function extractTextGeneric(rawOutput: string): string {
	const lines = rawOutput.split('\n');

	// Check if this looks like JSONL output (first non-empty line starts with '{')
	// If not JSONL, return the raw output as-is (it's already parsed text)
	const firstNonEmptyLine = lines.find((line) => line.trim());
	if (firstNonEmptyLine && !firstNonEmptyLine.trim().startsWith('{')) {
		return rawOutput;
	}

	const textParts: string[] = [];

	for (const line of lines) {
		if (!line.trim()) continue;

		try {
			const msg = JSON.parse(line);

			// Try common patterns
			if (msg.result) return msg.result;
			if (msg.text) textParts.push(msg.text);
			if (msg.part?.text) textParts.push(msg.part.text);
			if (msg.message?.content) {
				const content = msg.message.content;
				if (typeof content === 'string') {
					textParts.push(content);
				}
			}
		} catch {
			// Not valid JSON - include raw text if it looks like content
			if (!line.startsWith('{') && !line.includes('session_id') && !line.includes('sessionID')) {
				textParts.push(line);
			}
		}
	}

	// Join with newlines to preserve paragraph structure
	return textParts.join('\n');
}

/**
 * Extract text content from agent JSON output format.
 * Uses the registered output parser for the given agent type.
 * Different agents have different output formats:
 * - Claude: { type: 'result', result: '...' } and { type: 'assistant', message: { content: ... } }
 * - OpenCode: { type: 'text', part: { text: '...' } } and { type: 'step_finish', part: { reason: 'stop' } }
 *
 * @param rawOutput - The raw JSONL output from the agent
 * @param agentType - The agent type (e.g., 'claude-code', 'opencode')
 * @returns Extracted text content
 */
export function extractTextFromAgentOutput(rawOutput: string, agentType: string): string {
	if (agentType === 'grok') {
		return extractGrokText(rawOutput);
	}

	const parser = getOutputParser(agentType);

	// If no parser found, try a generic extraction
	if (!parser) {
		logger.warn(
			`No parser found for agent type '${agentType}', using generic extraction`,
			'[GroupChat]'
		);
		return extractTextGeneric(rawOutput);
	}

	const lines = rawOutput.split('\n');

	// Check if this looks like JSONL output (first non-empty line starts with '{')
	// If not JSONL, return the raw output as-is (it's already parsed text from process-manager)
	const firstNonEmptyLine = lines.find((line) => line.trim());
	if (firstNonEmptyLine && !firstNonEmptyLine.trim().startsWith('{')) {
		logger.debug(
			`[GroupChat] Input is not JSONL, returning as plain text (len=${rawOutput.length})`,
			'[GroupChat]'
		);
		return rawOutput;
	}

	const textParts: string[] = [];
	let resultText: string | null = null;
	let _resultMessageCount = 0;
	let _textMessageCount = 0;

	for (const line of lines) {
		if (!line.trim()) continue;

		const event = parser.parseJsonLine(line);
		if (!event) continue;

		// Extract text based on event type
		if (event.type === 'result' && event.text) {
			// Result message is the authoritative final response - save it
			resultText = event.text;
			_resultMessageCount++;
		}

		if (event.type === 'text' && event.text) {
			textParts.push(event.text);
			_textMessageCount++;
		}
	}

	// Prefer result message if available (it contains the complete formatted response)
	if (resultText) {
		return resultText;
	}

	// Fallback: if no result message, concatenate streaming text parts with newlines
	// to preserve paragraph structure from partial streaming events
	return textParts.join('\n');
}

/** The line types a Grok `streaming-json` stream is made of (see GrokOutputParser). */
const GROK_NATIVE_TYPES = new Set([
	'thought',
	'text',
	'tool_call',
	'tool_call_update',
	'usage',
	'end',
	'error',
	'max_turns_reached',
]);

/** The native record type of a Grok stream line, or null when it is not one. */
function grokNativeType(line: string): string | null {
	try {
		const msg: unknown = JSON.parse(line);
		if (!msg || typeof msg !== 'object') return null;
		const type = String((msg as { type?: unknown }).type);
		return GROK_NATIVE_TYPES.has(type) ? type : null;
	} catch {
		return null;
	}
}

function isGrokNativeLine(line: string): boolean {
	return grokNativeType(line) !== null;
}

/**
 * Grok's answer, read through the shared Grok parser.
 *
 * Grok streams the answer as token-sized `text` deltas whose whitespace is in the
 * payload, beside `thought` deltas tagged `isReasoning`, and names no answer on its
 * `end` record. Joining the deltas with newlines (the generic fallback) split words
 * and moderator `@mention` tags across lines, and keeping the thoughts would hand
 * the model's reasoning to the router as instructions. So the deltas are
 * concatenated directly, thoughts and tool records are dropped, and the text counts
 * only once a successful terminal record arrived, which is when the process manager
 * emits it on the desktop path too. Any native record after that terminal (other
 * than a trailing usage line) is corruption, and the read returns no answer.
 *
 * The parser is a fresh instance: a Grok parser latches the turn's terminal outcome,
 * so the shared registry instance would carry one turn's failure into the next read.
 * Output with no native Grok line (the plain text the process manager already
 * extracted, which may itself begin with `{`) is returned as it is.
 */
function extractGrokText(rawOutput: string): string {
	const lines = rawOutput.split('\n');
	if (!lines.some(isGrokNativeLine)) return rawOutput;

	const parser = createOutputParser('grok');
	if (!parser) return extractTextGeneric(rawOutput);

	let answer = '';
	let succeeded = false;
	let resultText: string | null = null;
	for (const line of lines) {
		if (succeeded) {
			// The successful terminal record closes the turn. A later native record
			// (text, error, a second end) is a corrupted stream, and splicing it in
			// would hand the router an instruction the turn never answered with. A
			// trailing usage line carries no text and the parser already ignores it.
			const type = grokNativeType(line);
			if (type !== null && type !== 'usage') return '';
			continue;
		}
		const event = parser.parseJsonLine(line);
		if (!event) continue;
		if (event.type === 'text' && event.text && !event.isReasoning) {
			answer += event.text;
		} else if (event.type === 'result') {
			// A failed turn never reads `result`: the parser latches the failure,
			// so a later `end` arrives as `error` too.
			succeeded = true;
			if (event.text) resultText = event.text;
		}
	}
	if (!succeeded) return '';
	return resultText ?? answer;
}

/**
 * Extract text content from stream-json output (JSONL).
 * Uses the agent-specific parser when the agent type is known.
 */
export function extractTextFromStreamJson(rawOutput: string, agentType?: string): string {
	if (agentType) {
		return extractTextFromAgentOutput(rawOutput, agentType);
	}

	return extractTextGeneric(rawOutput);
}
