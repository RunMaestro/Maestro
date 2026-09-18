/**
 * Tests for the system-prompt envelope Maestro wraps a first user turn in when
 * the provider has no `--append-system-prompt` flag (issue #1533).
 *
 * The producer and the reader have to agree exactly: the envelope is written
 * into the provider's session file on disk, so a reader that fails to recognise
 * it renders the whole system prompt as something the user typed.
 */

import { describe, it, expect } from 'vitest';
import {
	EMBEDDED_SYSTEM_PROMPT_SEPARATOR,
	embedSystemPromptInPrompt,
	hasEmbeddedSystemPrompt,
	stripEmbeddedSystemPrompt,
} from '../../shared/embeddedSystemPrompt';

const SYSTEM_PROMPT = '# Maestro System Context\n\nYou are **Scout**, powered by **codex**.';

describe('embedSystemPromptInPrompt', () => {
	it('round-trips: the strip recovers exactly what was embedded', () => {
		const wrapped = embedSystemPromptInPrompt(SYSTEM_PROMPT, 'summarise the release notes');

		expect(wrapped.startsWith(SYSTEM_PROMPT)).toBe(true);
		expect(stripEmbeddedSystemPrompt(wrapped)).toBe('summarise the release notes');
	});

	it('keeps the on-disk wire format that existing transcripts were written with', () => {
		// Changing this string orphans every transcript already on disk.
		expect(EMBEDDED_SYSTEM_PROMPT_SEPARATOR).toBe('\n\n---\n\n# User Request\n\n');
	});

	it('preserves a multi-line user request verbatim', () => {
		const prompt = 'line one\n\n---\n\nline two';
		expect(stripEmbeddedSystemPrompt(embedSystemPromptInPrompt(SYSTEM_PROMPT, prompt))).toBe(
			prompt
		);
	});
});

describe('stripEmbeddedSystemPrompt', () => {
	it('leaves an ordinary message untouched', () => {
		expect(stripEmbeddedSystemPrompt('just a question')).toBe('just a question');
	});

	it('leaves empty text untouched', () => {
		expect(stripEmbeddedSystemPrompt('')).toBe('');
	});

	it('does not strip a message that OPENS with the heading', () => {
		// Nothing precedes the separator, so this was never wrapped - stripping
		// would delete the user's own first line.
		const text = '# User Request\n\nplease look at the build';
		expect(stripEmbeddedSystemPrompt(text)).toBe(text);
	});

	it('honours the first separator only, so the user can use the marker themselves', () => {
		const prompt = 'compare these two\n\n---\n\n# User Request\n\nsecond one';
		expect(stripEmbeddedSystemPrompt(embedSystemPromptInPrompt(SYSTEM_PROMPT, prompt))).toBe(
			prompt
		);
	});
});

describe('hasEmbeddedSystemPrompt', () => {
	it('reports the envelope only when something precedes the separator', () => {
		expect(hasEmbeddedSystemPrompt(embedSystemPromptInPrompt(SYSTEM_PROMPT, 'hi'))).toBe(true);
		expect(hasEmbeddedSystemPrompt('# User Request\n\nhi')).toBe(false);
		expect(hasEmbeddedSystemPrompt('plain message')).toBe(false);
		expect(hasEmbeddedSystemPrompt('')).toBe(false);
	});
});
