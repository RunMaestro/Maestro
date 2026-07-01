import { describe, it, expect } from 'vitest';
import {
	accumulateCrossAgentChunk,
	buildCrossAgentLogEntry,
} from '../../../renderer/hooks/agent/useCrossAgentDispatch';
import type { CrossAgentResponseChunk } from '../../../shared/crossAgentTypes';

/**
 * Isolated tests for the pure chunk-accumulation logic behind
 * useCrossAgentDispatch - no IPC or React needed. The hook itself just wires
 * these into an updateSessionWith call.
 */

function chunk(overrides: Partial<CrossAgentResponseChunk> = {}): CrossAgentResponseChunk {
	return {
		requestId: 'r1',
		sourceSessionId: 'src',
		sourceTabId: 'tab',
		targetSessionId: 'tgt',
		targetAgentName: 'Codex',
		targetToolType: 'codex',
		chunk: '',
		done: false,
		...overrides,
	};
}

describe('accumulateCrossAgentChunk', () => {
	it('appends chunk text to the prior accumulation', () => {
		const result = accumulateCrossAgentChunk('Hello', chunk({ chunk: ' world' }));
		expect(result.accumulated).toBe('Hello world');
		expect(result.displayText).toBe('Hello world');
	});

	it('accumulates across multiple streamed chunks', () => {
		let acc = '';
		for (const piece of ['a', 'b', 'c']) {
			acc = accumulateCrossAgentChunk(acc, chunk({ chunk: piece })).accumulated;
		}
		expect(acc).toBe('abc');
	});

	it('treats a missing chunk field as empty (no NaN / "undefined")', () => {
		const result = accumulateCrossAgentChunk('x', chunk({ chunk: undefined as unknown as string }));
		expect(result.accumulated).toBe('x');
		expect(result.displayText).toBe('x');
	});

	it('surfaces a failure note when an error chunk carries no accumulated text', () => {
		const result = accumulateCrossAgentChunk('', chunk({ done: true, error: 'boom' }));
		expect(result.displayText).toContain('Codex');
		expect(result.displayText).toContain('boom');
	});

	it('keeps accumulated text over the error note when text already exists', () => {
		const result = accumulateCrossAgentChunk(
			'partial answer',
			chunk({ done: true, error: 'late failure' })
		);
		expect(result.displayText).toBe('partial answer');
	});
});

describe('buildCrossAgentLogEntry', () => {
	it('builds an ai-source entry stamped with crossAgent provenance', () => {
		const entry = buildCrossAgentLogEntry(
			'e1',
			123,
			'the answer',
			chunk({ chunk: 'the answer', done: true })
		);
		expect(entry.id).toBe('e1');
		expect(entry.timestamp).toBe(123);
		expect(entry.source).toBe('ai');
		expect(entry.text).toBe('the answer');
		expect(entry.metadata?.crossAgent).toEqual({
			requestId: 'r1',
			fromSessionId: 'tgt',
			fromAgentName: 'Codex',
			fromToolType: 'codex',
		});
	});
});
