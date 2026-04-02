import { describe, expect, it } from 'vitest';
import { OpenClawOutputParser } from '../../../main/parsers/openclaw-output-parser';

const RAW_SESSION_ID = 'e491f1ca-c469-4e23-9144-5068d30f55f3';

function makeResult(sessionId: string) {
	return {
		payloads: [{ text: 'Hello from OpenClaw', mediaUrl: null }],
		meta: {
			durationMs: 123,
			agentMeta: {
				sessionId,
				provider: 'anthropic',
				model: 'claude-sonnet-4-6',
				usage: { input: 1, output: 2, total: 3 },
			},
		},
	};
}

function makeResultWithAgentName(sessionId: string, agentName: string) {
	return {
		payloads: [{ text: 'Hello from OpenClaw', mediaUrl: null }],
		meta: {
			durationMs: 123,
			agentMeta: {
				sessionId,
				agentName,
				provider: 'anthropic',
				model: 'claude-sonnet-4-6',
				usage: { input: 1, output: 2, total: 3 },
			},
		},
	};
}

describe('OpenClawOutputParser session ID normalization', () => {
	it('normalizes to the canonical composite form when agent name is provided', () => {
		const parser = new OpenClawOutputParser({ agentName: 'main' });
		const event = parser.parseJsonObject(makeResult(RAW_SESSION_ID));

		expect(event?.sessionId).toBe(`main:${RAW_SESSION_ID}`);
	});

	it('preserves an already canonical composite session ID', () => {
		const parser = new OpenClawOutputParser();
		const event = parser.parseJsonObject(makeResult(`main:${RAW_SESSION_ID}`));

		expect(event?.sessionId).toBe(`main:${RAW_SESSION_ID}`);
	});

	it('leaves raw runtime IDs untouched when no agent name is available yet', () => {
		const parser = new OpenClawOutputParser();
		const event = parser.parseJsonObject(makeResult(RAW_SESSION_ID));

		expect(event?.sessionId).toBe(RAW_SESSION_ID);
	});

	it('normalizes from JSON agent meta when parser is instantiated without agent name', () => {
		const parser = new OpenClawOutputParser();
		const event = parser.parseJsonObject(makeResultWithAgentName(RAW_SESSION_ID, 'main'));

		expect(event?.sessionId).toBe(`main:${RAW_SESSION_ID}`);
	});
});
