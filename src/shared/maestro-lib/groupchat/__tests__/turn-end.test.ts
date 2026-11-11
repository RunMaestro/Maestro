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

/**
 * The tails are read with the patterns of the provider that ran the turn. The lines
 * below are what grok v0.2.93 prints on stderr for `--resume <id>`: the first precedes every
 * remote restore, successful or not; only the second and third mean the session is gone.
 */
describe('turnEndOf with the participant provider', () => {
	const RESTORING = 'Session 6b1f0c2e not found locally, restoring from remote...';
	const DEAD =
		'Error: Failed to restore session from remote: fetching session record: session get failed: 404 Not Found';

	it("keeps a successful Grok remote restore out of what came back when Grok's patterns read it", () => {
		const end = turnEndOf('p1', { exit: exit({ stderrText: RESTORING }) }, 'grok');
		expect(end).toMatchObject({ text: '', rawOutput: '' });
	});

	it('would have counted the same restore line as a lost session under the default patterns', () => {
		// The contrast that makes the case above meaningful: Claude's `session.*not found` matches.
		const end = turnEndOf('p1', { exit: exit({ stderrText: RESTORING }) });
		expect(end.rawOutput).toBe(RESTORING);
	});

	it('leaves a Grok answer alone after a successful restore', () => {
		const end = turnEndOf(
			'p1',
			{ answerText: 'Restored and answered.', exit: exit({ stderrText: RESTORING }) },
			'grok'
		);
		expect(end).toMatchObject({
			text: 'Restored and answered.',
			rawOutput: 'Restored and answered.',
		});
	});

	it("reaches recovery for a dead Grok session through Grok's own patterns", () => {
		const end = turnEndOf(
			'p1',
			{ exit: exit({ exitCode: 1, stderrText: `${RESTORING}\n${DEAD}` }) },
			'grok'
		);
		expect(end.text).toBe('');
		expect(end.rawOutput).toContain('Failed to restore session');
		expect(end.rawOutput).toContain('session get failed: 404 Not Found');
		expect(end.exitCode).toBe(1);
	});

	it("keeps Claude's vanished session unchanged when the provider is named", () => {
		const end = turnEndOf(
			'p1',
			{
				exit: exit({
					exitCode: 1,
					stderrText: 'Error: No conversation found with session ID: 0f1e2d',
				}),
			},
			'claude-code'
		);
		expect(end.rawOutput).toBe('Error: No conversation found with session ID: 0f1e2d');
	});

	it('keeps the tails out for a provider with no session_not_found match', () => {
		// Pi declares no session_not_found patterns; the line matches no raw fallback either.
		const end = turnEndOf('p1', { exit: exit({ exitCode: 1, stderrText: RESTORING }) }, 'pi');
		expect(end).toMatchObject({ text: '', rawOutput: '', exitCode: 1 });
	});
});
