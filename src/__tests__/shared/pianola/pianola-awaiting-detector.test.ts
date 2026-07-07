/**
 * @file pianola-awaiting-detector.test.ts
 * @description Unit tests for the pure structured awaiting-input detector.
 */

import { describe, it, expect } from 'vitest';
import {
	detectAwaitingInput,
	enrichWithAwaitingInput,
} from '../../../shared/pianola/pianola-awaiting-detector';
import { classifyMessages } from '../../../shared/pianola/pianola-classifier';
import type { PianolaMessage } from '../../../shared/pianola/types';

let seq = 0;
function msg(role: PianolaMessage['role'], content: string): PianolaMessage {
	seq += 1;
	return {
		id: `m${seq}`,
		role,
		source: role === 'assistant' ? 'ai' : role,
		content,
		timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
	};
}

describe('detectAwaitingInput - kinds', () => {
	it('detects plan review', () => {
		const s = detectAwaitingInput("Here's the plan: refactor the parser. Ready to code?");
		expect(s?.kind).toBe('plan_review');
	});

	it('detects a permission request', () => {
		const s = detectAwaitingInput('Do you want me to run the migration now?');
		expect(s?.kind).toBe('permission');
	});

	it('detects an explicit choice and extracts numbered options', () => {
		const s = detectAwaitingInput('How should I proceed? 1) keep it 2) remove it 3) rename it');
		expect(s?.kind).toBe('choice');
		expect(s?.options).toEqual(['keep it', 'remove it', 'rename it']);
	});

	it('extracts slash-bracket options', () => {
		const s = detectAwaitingInput('Proceed with the change? [keep/discard]');
		expect(s?.options).toEqual(['keep', 'discard']);
	});

	it('detects a direct question', () => {
		const s = detectAwaitingInput('Should I use tabs or spaces?');
		expect(s?.kind).toBe('question');
		expect(s?.prompt).toContain('Should I use tabs or spaces?');
	});

	it('returns null for a plain statement', () => {
		expect(detectAwaitingInput('I updated the README and ran the tests.')).toBeNull();
	});

	it('returns null for question intent that is not actually a question', () => {
		// No trailing question mark -> left to the classifier heuristics, not structured.
		expect(detectAwaitingInput('I will decide which option is best and continue.')).toBeNull();
	});

	it('returns null for empty content', () => {
		expect(detectAwaitingInput('   ')).toBeNull();
	});

	it('prefers plan review over permission when both phrasings appear', () => {
		const s = detectAwaitingInput('Here is the plan. May I proceed with the plan?');
		expect(s?.kind).toBe('plan_review');
	});
});

describe('detectAwaitingInput - false-positive hardening', () => {
	it('does not treat a markdown link as options', () => {
		expect(detectAwaitingInput('See the guide at [docs/api](https://x.example). Done.')).toBeNull();
	});

	it('does not treat a bracketed file path as options', () => {
		expect(detectAwaitingInput('I edited [src/foo.ts] as requested.')).toBeNull();
	});

	it('does not treat a version number as a numbered choice', () => {
		expect(detectAwaitingInput('Bumped the package to 1.2.3 today.')).toBeNull();
	});

	it('does not treat a changelog-style numbered list without a question as a choice', () => {
		expect(
			detectAwaitingInput('Changes in this release: 1) fixed a bug 2) added a feature')
		).toBeNull();
	});

	it('still treats a genuine bracketed choice with asking context as a choice', () => {
		const s = detectAwaitingInput('Proceed? [approve/cancel]');
		expect(s?.kind).toBe('choice');
		expect(s?.options).toEqual(['approve', 'cancel']);
	});
});

describe('enrichWithAwaitingInput', () => {
	it('fills awaitingInput on assistant messages without mutating inputs', () => {
		const input = [msg('user', 'go'), msg('assistant', 'Do you want me to deploy to production?')];
		const frozenContent = input[1].content;
		const out = enrichWithAwaitingInput(input);
		expect(out[1].awaitingInput?.kind).toBe('permission');
		expect(input[1].awaitingInput).toBeUndefined(); // original untouched
		expect(input[1].content).toBe(frozenContent);
	});

	it('leaves non-assistant messages and plain statements alone', () => {
		const out = enrichWithAwaitingInput([
			msg('user', 'should I do it?'),
			msg('assistant', 'Done, all tests pass.'),
		]);
		expect(out[0].awaitingInput).toBeUndefined();
		expect(out[1].awaitingInput).toBeUndefined();
	});

	it('does not overwrite a pre-existing signal', () => {
		const pre: PianolaMessage = {
			...msg('assistant', 'anything?'),
			awaitingInput: { kind: 'choice' },
		};
		const out = enrichWithAwaitingInput([pre]);
		expect(out[0].awaitingInput?.kind).toBe('choice');
	});
});

describe('detector + classifier integration', () => {
	it('upgrades a permission prompt to a high-confidence structured classification', () => {
		const enriched = enrichWithAwaitingInput([
			msg('assistant', 'Do you want me to force push the branch?'),
		]);
		const c = classifyMessages(enriched);
		expect(c.evidence.structured).toBe(true);
		expect(c.confidence).toBe('high');
		expect(c.kind).toBe('blocked'); // permission maps to blocked
		expect(c.risk).toBe('high'); // force push
	});

	it('keeps a low-risk auto-answerable choice as a structured choice signal', () => {
		const enriched = enrichWithAwaitingInput([
			msg('assistant', 'Which name do you prefer? 1) count 2) total'),
		]);
		const c = classifyMessages(enriched);
		expect(c.evidence.structured).toBe(true);
		expect(c.kind).toBe('blocked'); // choice maps to blocked (awaiting a pick)
		expect(c.risk).toBe('low');
	});
});
