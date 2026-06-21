/**
 * ConversationScreen.test.ts
 *
 * Tests for the deferred response phrase detection logic used in auto-continue.
 * The actual function is internal to ConversationScreen.tsx, so we replicate
 * the patterns here for testing purposes.
 */

import { describe, it, expect } from 'vitest';

/**
 * Patterns that indicate the AI said it will do something asynchronously.
 * Must be kept in sync with ConversationScreen.tsx
 */
const DEFERRED_RESPONSE_PATTERNS = [
	/let me (?:research|investigate|look into|think about|analyze|examine|check|explore)/i,
	/give me a (?:moment|minute|second)/i,
	/i(?:'ll| will) (?:look into|research|investigate|get back|check)/i,
	/(?:researching|investigating|looking into) (?:this|that|it)/i,
	/let me (?:take a )?(?:closer )?look/i,
];

function containsDeferredResponsePhrase(message: string): boolean {
	return DEFERRED_RESPONSE_PATTERNS.some((pattern) => pattern.test(message));
}

describe('ConversationScreen', () => {
	describe('containsDeferredResponsePhrase', () => {
		describe('should detect deferred response phrases', () => {
			it('detects "let me research"', () => {
				expect(containsDeferredResponsePhrase('Let me research this for you.')).toBe(true);
				expect(containsDeferredResponsePhrase('let me research the options')).toBe(true);
			});

			it('detects "let me investigate"', () => {
				expect(containsDeferredResponsePhrase('Let me investigate that further.')).toBe(true);
			});

			it('detects "let me look into"', () => {
				expect(containsDeferredResponsePhrase('Let me look into this more.')).toBe(true);
			});

			it('detects "let me think about"', () => {
				expect(containsDeferredResponsePhrase('Let me think about this more carefully.')).toBe(
					true
				);
			});

			it('detects "let me analyze"', () => {
				expect(containsDeferredResponsePhrase('Let me analyze the requirements.')).toBe(true);
			});

			it('detects "let me examine"', () => {
				expect(containsDeferredResponsePhrase('Let me examine the codebase.')).toBe(true);
			});

			it('detects "let me check"', () => {
				expect(containsDeferredResponsePhrase('Let me check on that.')).toBe(true);
			});

			it('detects "let me explore"', () => {
				expect(containsDeferredResponsePhrase('Let me explore the possibilities.')).toBe(true);
			});

			it('detects "give me a moment"', () => {
				expect(containsDeferredResponsePhrase('Give me a moment to think.')).toBe(true);
			});

			it('detects "give me a minute"', () => {
				expect(containsDeferredResponsePhrase('Give me a minute to process this.')).toBe(true);
			});

			it('detects "give me a second"', () => {
				expect(containsDeferredResponsePhrase('Give me a second...')).toBe(true);
			});

			it('detects "I\'ll look into"', () => {
				expect(containsDeferredResponsePhrase("I'll look into that for you.")).toBe(true);
			});

			it('detects "I will research"', () => {
				expect(containsDeferredResponsePhrase('I will research the best approach.')).toBe(true);
			});

			it('detects "I\'ll get back"', () => {
				expect(containsDeferredResponsePhrase("I'll get back to you on that.")).toBe(true);
			});

			it('detects "researching this"', () => {
				expect(containsDeferredResponsePhrase('Researching this now...')).toBe(true);
			});

			it('detects "investigating that"', () => {
				expect(containsDeferredResponsePhrase('Investigating that issue.')).toBe(true);
			});

			it('detects "looking into it"', () => {
				expect(containsDeferredResponsePhrase('Looking into it now.')).toBe(true);
			});

			it('detects "let me take a look"', () => {
				expect(containsDeferredResponsePhrase('Let me take a look at the files.')).toBe(true);
			});

			it('detects "let me take a closer look"', () => {
				expect(containsDeferredResponsePhrase('Let me take a closer look at this.')).toBe(true);
			});

			it('detects phrases in longer messages', () => {
				const longMessage = `Great questions! Let me do some research on the Netflix ecosystem and content metadata APIs to give you solid recommendations.

I'll investigate:
1. Netflix API/Integration options
2. Content metadata APIs
3. Parental control mechanisms

Give me a moment to research this...`;
				expect(containsDeferredResponsePhrase(longMessage)).toBe(true);
			});
		});

		describe('should NOT detect normal conversation phrases', () => {
			it('does not match "I can help you with that"', () => {
				expect(containsDeferredResponsePhrase('I can help you with that.')).toBe(false);
			});

			it('does not match questions', () => {
				expect(containsDeferredResponsePhrase('What type of project is this?')).toBe(false);
			});

			it('does not match analysis statements', () => {
				expect(
					containsDeferredResponsePhrase('Based on what you described, this sounds like a web app.')
				).toBe(false);
			});

			it('does not match "let me know"', () => {
				expect(containsDeferredResponsePhrase('Let me know if you have questions.')).toBe(false);
			});

			it('does not match "let me explain"', () => {
				expect(containsDeferredResponsePhrase('Let me explain how this works.')).toBe(false);
			});

			it('does not match "let me summarize"', () => {
				expect(containsDeferredResponsePhrase('Let me summarize what I understand.')).toBe(false);
			});

			it('does not match past tense "researched"', () => {
				expect(containsDeferredResponsePhrase('I researched this topic yesterday.')).toBe(false);
			});

			it('does not match "looking forward"', () => {
				expect(containsDeferredResponsePhrase('Looking forward to working on this!')).toBe(false);
			});

			it('does not match confidence statements', () => {
				expect(containsDeferredResponsePhrase("I'm ready to create your Playbook.")).toBe(false);
			});

			it('does not match empty string', () => {
				expect(containsDeferredResponsePhrase('')).toBe(false);
			});
		});

		describe('case insensitivity', () => {
			it('matches uppercase', () => {
				expect(containsDeferredResponsePhrase('LET ME RESEARCH THIS')).toBe(true);
			});

			it('matches mixed case', () => {
				expect(containsDeferredResponsePhrase('Let Me Research This')).toBe(true);
			});

			it('matches lowercase', () => {
				expect(containsDeferredResponsePhrase('let me research this')).toBe(true);
			});
		});
	});
});
