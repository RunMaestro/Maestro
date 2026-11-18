/**
 * Shared Grok helpers for wizard surfaces (inline wizard, onboarding
 * conversationManager, document generation).
 *
 * Keeps discovery args and streaming-json text extraction in one place so CLI
 * schema / cap changes do not drift across the three call sites.
 */

import { GrokOutputParser } from '../../shared/maestro-lib/parsers/grok-output-parser';

/**
 * CLI flags for Grok wizard discovery spawns.
 *
 * The pinned 1.0.70 source supports these headless bounds. Permission intent
 * belongs to process.spawn so the canonical builder selects read-only args
 * and removes full-access flags. These bounds are not a permission boundary.
 */
export const GROK_WIZARD_DISCOVERY_ARGS: readonly string[] = ['--max-turns', '8', '--no-subagents'];

/** Generation may write documents, with a finite budget distinct from discovery. */
export const GROK_WIZARD_GENERATION_ARGS: readonly string[] = [
	'--max-turns',
	'32',
	'--no-subagents',
];

/** Extract the string payload from a Grok `{"type":"text","data":"..."}` delta. */
export function getGrokTextDelta(msg: unknown): string | null {
	const event = new GrokOutputParser().parseJsonObject(msg);
	return event?.type === 'text' && !event.isReasoning ? (event.text ?? null) : null;
}

/**
 * Join Grok streaming-json text deltas from JSONL lines.
 * Skips thought/reasoning deltas; the `end` event has no result body.
 */
export function extractGrokTextFromJsonl(lines: string[]): string | null {
	const textParts: string[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		try {
			const data = getGrokTextDelta(JSON.parse(line));
			if (data) textParts.push(data);
		} catch {
			// Ignore non-JSON lines
		}
	}
	return textParts.length > 0 ? textParts.join('') : null;
}

/**
 * Desktop onData already contains answer text; native JSONL is retained for
 * legacy callers. Never fall back to raw envelopes when they contain no answer.
 * The shared parser owns cancellation, denial, limits and malformed terminals.
 * Desktop callers must also listen to onAgentError and check the process exit.
 */
export function readGrokWizardOutput(
	output: string,
	requireComplete = true
): { text: string; error?: string } {
	const lines = output.split('\n');
	// Inspect the leading envelope, not JSON examples inside answer Markdown.
	const firstLine = lines.find((line) => line.trim()) ?? '';
	const isNativeStream = (() => {
		try {
			const parsed = JSON.parse(firstLine);
			if (typeof parsed?.type !== 'string') return false;
			const event = new GrokOutputParser().parseJsonObject(parsed);
			return event !== null && (event.type !== 'system' || parsed.type === 'usage');
		} catch {
			return /^\s*\{\s*"type"\s*:/.test(firstLine);
		}
	})();
	if (!isNativeStream) return { text: output };
	if (!requireComplete) return { text: extractGrokTextFromJsonl(lines) ?? '' };
	const parser = new GrokOutputParser();
	let completed = false;
	for (const line of lines) {
		const event = parser.parseJsonLine(line);
		if (event?.terminal?.status === 'success') completed = true;
	}
	const error = parser.detectErrorFromExit(0, '', output)?.message;
	return {
		text: error || !completed ? '' : (extractGrokTextFromJsonl(lines) ?? ''),
		error: error ?? (completed ? undefined : 'Grok did not complete the native response.'),
	};
}
