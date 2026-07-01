import { describe, it, expect } from 'vitest';
import {
	serializeTranscript,
	buildCrossAgentPrompt,
} from '../../main/cross-agent/cross-agent-router';
import type { CrossAgentRequest, CrossAgentTranscriptEntry } from '../../shared/crossAgentTypes';

/**
 * Pure prompt-assembly tests for the cross-agent router. The dispatch itself
 * (spawn + stream) needs a live ProcessManager and is exercised end-to-end.
 */

const entry = (source: string, text?: string): CrossAgentTranscriptEntry => ({ source, text });

function request(overrides: Partial<CrossAgentRequest> = {}): CrossAgentRequest {
	return {
		requestId: 'r1',
		sourceSessionId: 'src',
		sourceTabId: 'tab',
		targetSessionId: 'tgt',
		userPrompt: 'What is your take?',
		transcript: [],
		strategy: { kind: 'full' },
		createdAt: 0,
		...overrides,
	};
}

describe('serializeTranscript', () => {
	it('labels user and assistant turns', () => {
		const out = serializeTranscript([entry('user', 'Hi'), entry('ai', 'Hello there')]);
		expect(out).toBe('**User:** Hi\n**Assistant:** Hello there');
	});

	it('drops entries with no visible text', () => {
		const out = serializeTranscript([
			entry('user', 'Question'),
			entry('ai', '   '),
			entry('ai', undefined),
			entry('tool'),
		]);
		expect(out).toBe('**User:** Question');
	});

	it('keeps tool/thinking entries only when they carry visible text', () => {
		const out = serializeTranscript([
			entry('thinking', 'pondering...'),
			entry('tool', 'ran a search'),
		]);
		expect(out).toContain('pondering...');
		expect(out).toContain('ran a search');
	});

	it('returns an empty string for an empty transcript', () => {
		expect(serializeTranscript([])).toBe('');
	});
});

describe('buildCrossAgentPrompt', () => {
	it('prepends the consult header, then transcript, then the relayed question', () => {
		const prompt = buildCrossAgentPrompt(
			request({
				transcript: [entry('user', 'Hi'), entry('ai', 'Yo')],
				userPrompt: 'Thoughts?',
			})
		);
		expect(prompt).toMatch(/^You are being consulted by another agent in Maestro\./);
		expect(prompt).toContain('**User:** Hi');
		expect(prompt).toContain('**Assistant:** Yo');
		expect(prompt).toContain('**Question from the user (relayed via the source agent):**\nThoughts?');
		// The header comes before the transcript, which comes before the question.
		expect(prompt.indexOf('consulted')).toBeLessThan(prompt.indexOf('**User:** Hi'));
		expect(prompt.indexOf('**Assistant:** Yo')).toBeLessThan(prompt.indexOf('Question from the user'));
	});

	it('omits the transcript block entirely when there is nothing to forward', () => {
		const prompt = buildCrossAgentPrompt(request({ transcript: [], userPrompt: 'Just this' }));
		expect(prompt).toContain('You are being consulted');
		expect(prompt).toContain('Just this');
		// No stray blank transcript section: header flows straight into the question.
		expect(prompt).not.toContain('**User:**');
	});
});
