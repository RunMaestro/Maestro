import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	embedSystemPromptInPrompt,
	stripEmbeddedSystemPrompt,
	hasEmbeddedSystemPrompt,
	EMBEDDED_SYSTEM_PROMPT_SEPARATOR,
} from '../../embeddedSystemPrompt';

export const TRANSLATION_KNOWLEDGE_ENV_VAR = 'MAESTRO_TRANSLATION_KNOWLEDGE';

/** Deliver on every continuation too; a resume may skip provider system-prompt flags. */
export function bindTranslationKnowledge(
	prompt: string | undefined,
	directory: string | undefined
): string | undefined {
	if (!prompt || !directory) return prompt;
	const normalized = path.resolve(directory).replace(/\\/g, '/');
	if (!/\/\.maestro\/provider-knowledge\/[a-f0-9]{64}\/[a-f0-9-]{36}$/.test(normalized))
		throw new Error('Unsafe provider knowledge binding');
	const index = fs.readFileSync(path.join(directory, 'knowledge-index.md'), 'utf8');
	if (!index.trim()) return prompt;
	const userPrompt = stripEmbeddedSystemPrompt(prompt);
	const existing = hasEmbeddedSystemPrompt(prompt)
		? prompt.slice(0, prompt.indexOf(EMBEDDED_SYSTEM_PROMPT_SEPARATOR))
		: '';
	return embedSystemPromptInPrompt([existing, index].filter(Boolean).join('\n\n'), userPrompt);
}
