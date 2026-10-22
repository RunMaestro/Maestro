/**
 * How a finished run-layer turn is reported to the engine (`turnEndOf`).
 */
import { describe, expect, it } from 'vitest';

import { turnEndOf } from '../turn-end';

const exit = (overrides = {}) => ({
	exitCode: 0 as number | null,
	stdoutText: '',
	stderrText: '',
	...overrides,
});

describe('turnEndOf', () => {
	it('reports the answer as both the reply and what came back, with the exit code for logs', () => {
		expect(turnEndOf('p1', { answerText: 'All good.', exit: exit({ exitCode: 137 }) })).toEqual({
			processId: 'p1',
			text: 'All good.',
			rawOutput: 'All good.',
			exitCode: 137,
		});
	});

	it('reports nothing for a turn that said nothing, whatever noise its streams made', () => {
		const end = turnEndOf('p1', {
			exit: exit({
				exitCode: 1,
				stdoutText: '{"type":"system"}',
				stderrText: 'warning: slow disk',
			}),
		});
		expect(end).toMatchObject({ text: '', rawOutput: '', exitCode: 1 });
	});

	it('reads a vanished session from the streams’ tails, where the answer never carried it', () => {
		const end = turnEndOf('p1', {
			exit: exit({
				exitCode: 1,
				stderrText: 'Error: No conversation found with session ID: 0f1e2d',
			}),
		});
		expect(end.text).toBe('');
		expect(end.rawOutput).toContain('No conversation found with session ID');
	});

	it('keeps the answer first when it and the tails both speak', () => {
		const end = turnEndOf('p1', {
			answerText: 'Partial.',
			exit: exit({ stderrText: 'session not found' }),
		});
		expect(end.rawOutput).toBe('Partial.\nsession not found');
		expect(end.text).toBe('Partial.');
	});

	it('passes a signal exit through as no code', () => {
		expect(
			turnEndOf('p1', { answerText: 'x', exit: exit({ exitCode: null }) }).exitCode
		).toBeNull();
	});
});
