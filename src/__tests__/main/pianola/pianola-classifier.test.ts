/**
 * @file pianola-classifier.test.ts
 * @description Unit tests for the pure Pianola classifier.
 */

import { describe, it, expect } from 'vitest';
import { classifyMessages, riskAtMost, maxRisk } from '../../../main/pianola/pianola-classifier';
import type { AwaitingInputSignal, PianolaMessage } from '../../../shared/pianola/types';

let seq = 0;
function msg(
	role: PianolaMessage['role'],
	content: string,
	awaitingInput?: AwaitingInputSignal
): PianolaMessage {
	seq += 1;
	return {
		id: `m${seq}`,
		role,
		source: role === 'assistant' ? 'ai' : role,
		content,
		timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, seq)).toISOString(),
		awaitingInput,
	};
}

describe('risk helpers', () => {
	it('orders risk low < medium < high', () => {
		expect(riskAtMost('low', 'high')).toBe(true);
		expect(riskAtMost('high', 'low')).toBe(false);
		expect(riskAtMost('medium', 'medium')).toBe(true);
		expect(maxRisk('low', 'high')).toBe('high');
		expect(maxRisk('medium', 'low')).toBe('medium');
	});
});

describe('classifyMessages - edge cases', () => {
	it('returns none for an empty transcript', () => {
		expect(classifyMessages([]).kind).toBe('none');
	});

	it('returns none when there is no assistant message', () => {
		const c = classifyMessages([msg('user', 'hello?'), msg('tool', 'ran something')]);
		expect(c.kind).toBe('none');
	});

	it('returns none when the user already replied after the assistant asked', () => {
		const c = classifyMessages([
			msg('assistant', 'Which database should I use?'),
			msg('user', 'postgres'),
		]);
		expect(c.kind).toBe('none');
		expect(c.evidence.reason).toContain('user has replied');
	});
});

describe('classifyMessages - structured signal (authoritative)', () => {
	it('treats a permission signal as blocked, at least medium risk, high confidence', () => {
		const signal: AwaitingInputSignal = { kind: 'permission', prompt: 'Allow reading config.ts?' };
		const c = classifyMessages([msg('assistant', 'May I?', signal)]);
		expect(c.kind).toBe('blocked');
		expect(c.confidence).toBe('high');
		expect(c.evidence.structured).toBe(true);
		expect(riskAtMost('medium', c.risk)).toBe(true); // medium or higher
	});

	it('escalates structured permission for a destructive action to high risk', () => {
		const signal: AwaitingInputSignal = {
			kind: 'permission',
			prompt: 'Allow running rm -rf build to delete the output?',
		};
		const c = classifyMessages([msg('assistant', 'ok?', signal)]);
		expect(c.risk).toBe('high');
	});

	it('maps a question signal to kind question', () => {
		const signal: AwaitingInputSignal = { kind: 'question', prompt: 'What name do you want?' };
		const c = classifyMessages([msg('assistant', '...', signal)]);
		expect(c.kind).toBe('question');
		expect(c.confidence).toBe('high');
	});
});

describe('classifyMessages - heuristics', () => {
	it('detects a question phrase with medium confidence', () => {
		const c = classifyMessages([msg('assistant', 'Should I use tabs or spaces for the new file?')]);
		expect(c.kind).toBe('question');
		expect(c.confidence).toBe('medium');
		expect(c.evidence.structured).toBe(false);
		expect(c.topic.length).toBeGreaterThan(0);
	});

	it('detects an explicit choice marker', () => {
		const c = classifyMessages([msg('assistant', 'Proceed with the rename? [y/n]')]);
		expect(c.kind).toBe('question');
		expect(c.confidence).toBe('medium');
	});

	it('detects a blocked phrase', () => {
		const c = classifyMessages([msg('assistant', 'I am blocked: I need the API key to continue.')]);
		expect(c.kind).toBe('blocked');
	});

	it('treats a trailing question mark alone as low-confidence question', () => {
		const c = classifyMessages([msg('assistant', 'That file looks odd, right?')]);
		expect(c.kind).toBe('question');
		expect(c.confidence).toBe('low');
	});

	it('returns none for a plain statement', () => {
		const c = classifyMessages([msg('assistant', 'I finished updating the README.')]);
		expect(c.kind).toBe('none');
	});
});

describe('classifyMessages - risk rating', () => {
	it('rates destructive prompts high', () => {
		const c = classifyMessages([
			msg('assistant', 'Should I force push to production and drop the old table?'),
		]);
		expect(c.risk).toBe('high');
	});

	it('rates dependency changes medium', () => {
		const c = classifyMessages([msg('assistant', 'Should I upgrade the react dependency?')]);
		expect(c.risk).toBe('medium');
	});

	it('rates a cosmetic choice low', () => {
		const c = classifyMessages([msg('assistant', 'Should I name the variable count or total?')]);
		expect(c.risk).toBe('low');
	});

	it('uses the most recent assistant turn', () => {
		const c = classifyMessages([
			msg('assistant', 'Working on it.'),
			msg('tool', 'edited file'),
			msg('assistant', 'Should I delete the secret from the .env file?'),
		]);
		expect(c.kind).toBe('question');
		expect(c.risk).toBe('high');
	});
});
