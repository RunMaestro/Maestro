import type { ToolType } from '../../../../../types';
import { extractGrokTextFromJsonl, readGrokWizardOutput } from '../../../../../utils/grokWizard';
import { STRUCTURED_OUTPUT_SCHEMA } from '../../../services/wizardPrompts';

/** Grok callers pass the accumulated turn output so JSONL may span callbacks. */
export function extractStreamingTextFromChunk(chunk: string, agentType?: ToolType): string {
	if (agentType === 'grok') {
		const leading = chunk.trimStart();
		if (!leading) return '';
		const firstKey = leading.match(/^\{\s*"([^"\\]+)"\s*:/)?.[1];
		// The prompted wizard object can stream before its closing brace. `message`
		// alone is ambiguous because it can also lead a native error envelope.
		const isWizardObject =
			firstKey &&
			firstKey !== 'message' &&
			Object.prototype.hasOwnProperty.call(STRUCTURED_OUTPUT_SCHEMA.properties, firstKey);
		if (isWizardObject) return chunk;
		if (leading.startsWith('{')) {
			try {
				const firstRecord = JSON.parse(leading.split('\n', 1)[0]);
				if (typeof firstRecord?.type === 'string') {
					// Even empty thought or metadata-only tool envelopes must not
					// fall back to raw text when they carry no parsed answer delta.
					return extractGrokTextFromJsonl(chunk.split('\n')) ?? '';
				}
			} catch {
				// Hold an undecided first record, including splits inside its type key.
				// A newline ends a JSONL record; pretty-printed answer JSON is then
				// distinguished by the canonical reader's leading-envelope check.
				if (!leading.includes('\n')) return '';
			}
		}
		return readGrokWizardOutput(chunk, false).text;
	}

	let streamingText = '';

	try {
		const lines = chunk.split('\n').filter((line) => line.trim());
		for (const line of lines) {
			try {
				const msg = JSON.parse(line);

				if (
					msg.type === 'stream_event' &&
					msg.event?.type === 'content_block_delta' &&
					msg.event?.delta?.text
				) {
					streamingText += msg.event.delta.text;
				}
			} catch {
				// Ignore non-JSON lines.
			}
		}
	} catch {
		// Ignore parse errors.
	}

	return streamingText;
}
