import { getGrokTextDelta } from './grokWizard';

export interface StreamJsonResultOptions {
	/**
	 * Copilot final-answer records are supported only by the two wizard
	 * conversation flows. Document-generation callers intentionally leave this
	 * disabled because their stream contract never supported those records.
	 */
	allowCopilotFinalAnswer?: boolean;
}

interface StreamJsonRecord {
	type?: unknown;
	result?: unknown;
	text?: unknown;
	part?: { text?: unknown };
	content?: unknown;
	data?: { phase?: unknown; content?: unknown };
	message?: { content?: unknown };
	delta?: { text?: unknown };
}

function parseJsonLine(line: string): StreamJsonRecord | null {
	try {
		const value: unknown = JSON.parse(line);
		return value && typeof value === 'object' ? (value as StreamJsonRecord) : null;
	} catch {
		return null;
	}
}

function collectTextParts(
	lines: string[],
	extract: (message: StreamJsonRecord) => string[]
): string | null {
	const textParts: string[] = [];
	for (const line of lines) {
		if (!line.trim()) continue;
		const message = parseJsonLine(line);
		if (message) textParts.push(...extract(message));
	}
	return textParts.length > 0 ? textParts.join('') : null;
}

function extractTextBlocks(blocks: unknown): string[] {
	if (!Array.isArray(blocks)) return [];

	const textParts: string[] = [];
	for (const block of blocks) {
		if (!block || typeof block !== 'object') continue;
		const record = block as { type?: unknown; text?: unknown };
		if (record.type === 'text' && typeof record.text === 'string' && record.text) {
			textParts.push(record.text);
		}
	}
	return textParts;
}

/**
 * Extract a completed response from the compatible wizard streaming-JSON
 * protocols. Provider-specific paths run before the Claude result fallback,
 * matching the original callers' precedence.
 */
export function extractStreamJsonResult(
	output: string,
	agentType: string,
	options: StreamJsonResultOptions = {}
): string | null {
	const lines = output.split('\n');

	if (agentType === 'opencode') {
		const text = collectTextParts(lines, (message) =>
			message.type === 'text' && typeof message.part?.text === 'string' && message.part.text
				? [message.part.text]
				: []
		);
		if (text) return text;
	}

	if (agentType === 'codex') {
		const text = collectTextParts(lines, (message) => {
			const textParts = message.type === 'agent_message' ? extractTextBlocks(message.content) : [];
			if (message.type === 'message' && typeof message.text === 'string' && message.text) {
				textParts.push(message.text);
			}
			return textParts;
		});
		if (text) return text;
	}

	if (agentType === 'grok') {
		const text = collectTextParts(lines, (message) => {
			const delta = getGrokTextDelta(message);
			return delta ? [delta] : [];
		});
		if (text) return text;
	}

	if (agentType === 'copilot-cli' && options.allowCopilotFinalAnswer) {
		for (const line of lines) {
			if (!line.trim()) continue;
			const message = parseJsonLine(line);
			if (
				message?.type === 'assistant.message' &&
				message.data?.phase === 'final_answer' &&
				typeof message.data.content === 'string'
			) {
				return message.data.content;
			}
		}
	}

	for (const line of lines) {
		if (!line.trim()) continue;
		const message = parseJsonLine(line);
		if (message?.type === 'result' && typeof message.result === 'string' && message.result) {
			return message.result;
		}
	}

	return null;
}

/** Extract compatible streaming text for the document-generation display. */
export function extractStreamJsonDisplayText(output: string, agentType: string): string {
	const lines = output.split('\n');

	if (agentType === 'claude-code') {
		return (
			collectTextParts(lines, (message) => {
				if (
					message.type === 'content_block_delta' &&
					typeof message.delta?.text === 'string' &&
					message.delta.text
				) {
					return [message.delta.text];
				}
				return message.type === 'assistant' ? extractTextBlocks(message.message?.content) : [];
			}) ?? ''
		);
	}

	if (agentType === 'opencode') {
		return (
			collectTextParts(lines, (message) =>
				message.type === 'text' && typeof message.part?.text === 'string' && message.part.text
					? [message.part.text]
					: []
			) ?? ''
		);
	}

	if (agentType === 'codex') {
		return (
			collectTextParts(lines, (message) => {
				const textParts =
					message.type === 'agent_message' ? extractTextBlocks(message.content) : [];
				if (message.type === 'message' && typeof message.text === 'string' && message.text) {
					textParts.push(message.text);
				}
				return textParts;
			}) ?? ''
		);
	}

	if (agentType === 'grok') {
		return (
			collectTextParts(lines, (message) => {
				const delta = getGrokTextDelta(message);
				return delta ? [delta] : [];
			}) ?? ''
		);
	}

	return '';
}

export interface SplitPhaseDocument {
	filename: string;
	content: string;
	phase: number;
}

/** Split a raw markdown plan into sequential phase documents. */
export function splitMarkdownIntoPhases(content: string): SplitPhaseDocument[] {
	const documents: SplitPhaseDocument[] = [];
	const phaseSectionPattern =
		/(?:^|\n)(#{1,2}\s*Phase\s*\d+[^\n]*)\n([\s\S]*?)(?=\n#{1,2}\s*Phase\s*\d+|$)/gi;

	let match: RegExpExecArray | null;
	let phaseNumber = 1;
	while ((match = phaseSectionPattern.exec(content)) !== null) {
		const header = match[1].trim();
		const sectionContent = match[2].trim();
		const descMatch = header.match(/Phase\s*\d+[:\s-]*(.*)/i);
		const description =
			descMatch && descMatch[1].trim()
				? descMatch[1]
						.trim()
						.replace(/[^a-zA-Z0-9\s-]/g, '')
						.trim()
						.replace(/\s+/g, '-')
				: 'Tasks';

		documents.push({
			filename: `Phase-${String(phaseNumber).padStart(2, '0')}-${description}.md`,
			content: `${header}\n\n${sectionContent}`,
			phase: phaseNumber++,
		});
	}

	if (documents.length === 0 && content.trim()) {
		documents.push({
			filename: 'Phase-01-Initial-Setup.md',
			content: content.trim(),
			phase: 1,
		});
	}

	return documents;
}

/** Count permissive Markdown task-checkbox markers used by wizard documents. */
export function countMarkdownTasks(content: string): number {
	const matches = content.match(/^-\s*\[\s*[xX ]?\s*\]/gm);
	return matches ? matches.length : 0;
}
