/**
 * Output parsing utilities for group chat.
 * Extracts text content from agent JSON/JSONL output formats.
 */

import { getOutputParser } from '../parsers';
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
