import { stripEmojis } from '../emojiUtils';
import type { RosterAgent } from './protocol';

export const MAX_SPEECH_VOCABULARY_TERMS = 128;
export const MAX_SPEECH_VOCABULARY_CHARS = 1600;

/** Literal recognition hints, never a transcript or instructions to a model. */
export function normalizeSpeechVocabulary(input: unknown): string[] {
	if (!Array.isArray(input)) return [];
	const result: string[] = [];
	const seen = new Set<string>();
	let chars = 0;
	for (const value of input) {
		if (typeof value !== 'string') continue;
		const term = stripEmojis(value).normalize('NFC').replace(/\s+/g, ' ').trim();
		if (!term || term.length > 80 || /[<>\p{Cc}]/u.test(term)) continue;
		const key = term.toLocaleLowerCase();
		if (seen.has(key) || chars + term.length + 2 > MAX_SPEECH_VOCABULARY_CHARS) continue;
		result.push(term);
		seen.add(key);
		chars += term.length + 2;
		if (result.length === MAX_SPEECH_VOCABULARY_TERMS) break;
	}
	return result;
}

/** Prioritize the current agent, custom terms and agent names ahead of tab titles. */
export function buildSpeechVocabulary(
	roster: readonly RosterAgent[],
	custom: readonly string[] = [],
	activeAgentId?: string | null
): string[] {
	return normalizeSpeechVocabulary([
		roster.find((agent) => agent.sessionId === activeAgentId)?.name,
		...custom,
		'Maestro',
		...roster.map((agent) => agent.name),
		...roster.flatMap((agent) => agent.tabs.map((tab) => tab.name)),
	]);
}
