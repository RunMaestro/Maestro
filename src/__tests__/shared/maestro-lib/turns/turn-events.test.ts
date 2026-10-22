/**
 * Parsed provider events as the turn events a client reads: what is answer text, what is thought,
 * what is a tool, and what is said once.
 */
import { describe, expect, it } from 'vitest';

import type { ParsedEvent } from '../../../../shared/maestro-lib/parsers/agent-output-parser';
import {
	createTurnEventMapper,
	toolCallStatus,
	type UnstampedTurnEvent,
} from '../../../../shared/maestro-lib/turns/turn-events';

function run(events: ParsedEvent[], options: Parameters<typeof createTurnEventMapper>[0]) {
	const mapper = createTurnEventMapper({ now: () => 99, ...options });
	const out: UnstampedTurnEvent[] = [];
	for (const event of events) out.push(...mapper.map(event));
	return { out, mapper };
}

const kinds = (events: UnstampedTurnEvent[]) => events.map((event) => event.kind);

describe('createTurnEventMapper', () => {
	it('says the answer once: streamed partials win and the result that repeats them is dropped', () => {
		const { out } = run(
			[
				{ type: 'init', sessionId: 'S1' },
				{ type: 'text', text: 'Paris', isPartial: true, sessionId: 'S1' },
				{ type: 'result', text: 'Paris', sessionId: 'S1' },
			],
			{ agentId: 'claude-code' }
		);
		expect(out).toEqual([
			{ kind: 'session', providerSessionId: 'S1' },
			{ kind: 'text', text: 'Paris' },
		]);
	});

	it('reads a provider that never streams from its result', () => {
		const { out } = run([{ type: 'result', text: 'The answer.' }], { agentId: 'opencode' });
		expect(out).toEqual([{ kind: 'text', text: 'The answer.' }]);
	});

	it('keeps reasoning out of the answer and says it as thinking', () => {
		const { out } = run(
			[
				{ type: 'text', text: 'hmm', isPartial: true, isReasoning: true },
				{ type: 'text', text: 'done', isPartial: true },
				{ type: 'result', text: 'done' },
			],
			{ agentId: 'copilot-cli' }
		);
		expect(out).toEqual([
			{ kind: 'thinking', text: 'hmm' },
			{ kind: 'text', text: 'done' },
		]);
	});

	it('reports a session id once, and not the id a resumed turn already had', () => {
		const resumed = run(
			[
				{ type: 'init', sessionId: 'S1' },
				{ type: 'result', text: 'x', sessionId: 'S1' },
			],
			{ agentId: 'claude-code', resumedSessionId: 'S1' }
		);
		expect(kinds(resumed.out)).not.toContain('session');
		expect(resumed.mapper.sessionId()).toBe('S1');

		const changed = run([{ type: 'init', sessionId: 'S2' }], {
			agentId: 'claude-code',
			resumedSessionId: 'S1',
		});
		expect(changed.out).toEqual([{ kind: 'session', providerSessionId: 'S2' }]);

		const first = run([{ type: 'init', sessionId: 'S1' }], { agentId: 'claude-code' });
		expect(first.out).toEqual([{ kind: 'session', providerSessionId: 'S1' }]);
	});

	it('turns tool blocks and tool results into calls with a status, a call id, and a parent', () => {
		const { out } = run(
			[
				{
					type: 'text',
					isPartial: true,
					toolUseBlocks: [{ name: 'Read', id: 'c1', input: { file: 'a.ts' } }],
					parentToolUseId: 'p1',
				},
				{
					type: 'tool_use',
					toolName: 'Read',
					toolCallId: 'c1',
					toolState: { status: 'completed', output: 'ok' },
					parentToolUseId: 'p1',
					toolResultBlocks: [
						{ toolName: 'Bash', toolCallId: 'c2', toolState: { status: 'failed' } },
					],
				},
			],
			{ agentId: 'claude-code' }
		);
		expect(out).toEqual([
			{
				kind: 'tool',
				tool: {
					name: 'Read',
					id: 'c1',
					status: 'running',
					detail: { file: 'a.ts' },
					parentId: 'p1',
				},
			},
			{
				kind: 'tool',
				tool: {
					name: 'Read',
					id: 'c1',
					status: 'completed',
					detail: { status: 'completed', output: 'ok' },
					parentId: 'p1',
				},
			},
			{
				kind: 'tool',
				tool: {
					name: 'Bash',
					id: 'c2',
					status: 'error',
					detail: { status: 'failed' },
					parentId: 'p1',
				},
			},
		]);
	});

	it('passes usage on as the provider reported it, in the shared stats shape', () => {
		const { out } = run(
			[
				{
					type: 'usage',
					usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 5, costUsd: 0.1 },
				},
			],
			{ agentId: 'opencode' }
		);
		expect(out).toEqual([
			{
				kind: 'usage',
				usage: expect.objectContaining({
					inputTokens: 10,
					outputTokens: 2,
					cacheReadInputTokens: 5,
					totalCostUsd: 0.1,
				}),
			},
		]);
	});

	it('classifies an error through the provider parser, and words one it cannot classify', () => {
		const classified = run([{ type: 'error', text: 'login required', raw: { r: 1 } }], {
			agentId: 'claude-code',
			parser: {
				detectErrorFromParsed: () => ({
					type: 'auth_expired',
					message: 'Sign in again',
					recoverable: true,
					agentId: 'claude-code',
					timestamp: 1,
				}),
			},
		});
		expect(classified.out).toEqual([
			{ kind: 'error', error: expect.objectContaining({ type: 'auth_expired' }) },
		]);

		const unclassified = run([{ type: 'error', text: 'boom' }], {
			agentId: 'opencode',
			parser: { detectErrorFromParsed: () => null },
		});
		expect(unclassified.out).toEqual([
			{
				kind: 'error',
				error: {
					type: 'unknown',
					message: 'boom',
					recoverable: false,
					agentId: 'opencode',
					timestamp: 99,
				},
			},
		]);
	});

	it('says nothing for events that carry nothing a client shows', () => {
		const { out } = run(
			[
				{ type: 'system', text: 'hook output' },
				{ type: 'text', isPartial: true, text: '' },
			],
			{ agentId: 'claude-code' }
		);
		expect(out).toEqual([]);
	});
});

describe('toolCallStatus', () => {
	it('reads the status words providers use, and treats a missing one as still running', () => {
		expect(toolCallStatus({ status: 'completed' })).toBe('completed');
		expect(toolCallStatus({ status: 'error' })).toBe('error');
		expect(toolCallStatus({ status: 'failed' })).toBe('error');
		expect(toolCallStatus({ status: 'pending' })).toBe('running');
		expect(toolCallStatus(undefined)).toBe('running');
		expect(toolCallStatus('completed')).toBe('running');
	});
});
