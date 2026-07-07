/**
 * @file pianola-completion-detector.test.ts
 * @description Unit tests for the pure Pianola completion/failure detector.
 */

import { describe, it, expect } from 'vitest';
import {
	detectTaskOutcome,
	hasFailureMarker,
	FAILURE_MARKER_PATTERNS,
	type AgentRunState,
} from '../../../shared/pianola/pianola-completion-detector';
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

function input(
	currentState: AgentRunState,
	previousState?: AgentRunState,
	recentMessages: readonly PianolaMessage[] = []
) {
	return { previousState, currentState, recentMessages };
}

describe('detectTaskOutcome - completion', () => {
	it('busy -> idle with no failure is done', () => {
		const r = detectTaskOutcome(
			input('idle', 'busy', [msg('assistant', 'All set, README updated.')])
		);
		expect(r.outcome).toBe('done');
		expect(r.reason).toContain('idle');
	});

	it('connecting -> idle with no failure is done', () => {
		const r = detectTaskOutcome(input('idle', 'connecting', [msg('assistant', 'Done.')]));
		expect(r.outcome).toBe('done');
	});

	it('done verdict requires no message history beyond clean output', () => {
		const r = detectTaskOutcome(input('idle', 'busy', []));
		expect(r.outcome).toBe('done');
	});
});

describe('detectTaskOutcome - failure', () => {
	it('error state is failed', () => {
		const r = detectTaskOutcome(input('error', 'busy', []));
		expect(r.outcome).toBe('failed');
		expect(r.reason).toContain('error state');
	});

	it('error state beats everything, even a clean transition', () => {
		const r = detectTaskOutcome(input('error', 'busy', [msg('assistant', 'looking good')]));
		expect(r.outcome).toBe('failed');
	});

	it('failure-marker message is failed even when idle', () => {
		const r = detectTaskOutcome(
			input('idle', 'busy', [msg('assistant', 'Build failed: 3 errors in compiler output.')])
		);
		expect(r.outcome).toBe('failed');
		expect(r.reason).toContain('failure marker');
	});

	it('an error-role message in the tail is a failure', () => {
		const r = detectTaskOutcome(input('idle', 'busy', [msg('error', 'connection reset')]));
		expect(r.outcome).toBe('failed');
	});

	it('a fatal error marker fails the task', () => {
		const r = detectTaskOutcome(
			input('idle', 'busy', [msg('assistant', 'A fatal error occurred while writing.')])
		);
		expect(r.outcome).toBe('failed');
	});
});

describe('detectTaskOutcome - working', () => {
	it('still busy is working', () => {
		const r = detectTaskOutcome(input('busy', 'busy', [msg('assistant', 'Editing files...')]));
		expect(r.outcome).toBe('working');
		expect(r.reason).toContain('busy');
	});

	it('connecting is working', () => {
		const r = detectTaskOutcome(input('connecting', 'idle', []));
		expect(r.outcome).toBe('working');
	});

	it('waiting_input is working (the watcher handles the ask)', () => {
		const r = detectTaskOutcome(
			input('waiting_input', 'busy', [msg('assistant', 'Which database should I use?')])
		);
		expect(r.outcome).toBe('working');
		expect(r.reason).toContain('waiting');
	});

	it('idle with no prior working state is working (no transition observed)', () => {
		const r = detectTaskOutcome(input('idle', 'idle', [msg('assistant', 'hello')]));
		expect(r.outcome).toBe('working');
		expect(r.reason).toContain('no completion transition observed');
	});

	it('idle with no previousState at all is working', () => {
		const r = detectTaskOutcome(input('idle', undefined, []));
		expect(r.outcome).toBe('working');
		expect(r.reason).toContain('no completion transition observed');
	});

	it('waiting_input is not failed even with a question mark', () => {
		const r = detectTaskOutcome(
			input('waiting_input', 'busy', [msg('assistant', 'Proceed with the rename? [y/n]')])
		);
		expect(r.outcome).toBe('working');
	});
});

describe('hasFailureMarker', () => {
	it('is false for an empty transcript', () => {
		expect(hasFailureMarker([])).toBe(false);
	});

	it('is false for a clean completion message', () => {
		expect(hasFailureMarker([msg('assistant', 'Finished updating the README successfully.')])).toBe(
			false
		);
	});

	it('is true for an error-role message regardless of content', () => {
		expect(hasFailureMarker([msg('error', 'something went sideways')])).toBe(true);
	});

	it('is true for "error:" prefix in assistant output', () => {
		expect(hasFailureMarker([msg('assistant', 'error: cannot find module foo')])).toBe(true);
	});

	it('is true for an exception/traceback', () => {
		expect(hasFailureMarker([msg('assistant', 'Traceback (most recent call last):')])).toBe(true);
	});

	it('is true for a non-zero exit code', () => {
		expect(hasFailureMarker([msg('assistant', 'process ended with exit code 1')])).toBe(true);
	});

	it('only inspects the latest assistant/error message', () => {
		// An earlier failure followed by a clean assistant turn is not a failure:
		// the detector keys off the latest relevant turn, like the classifier.
		const messages = [
			msg('assistant', 'Build failed earlier.'),
			msg('tool', 'reran build'),
			msg('assistant', 'All green now, build succeeded.'),
		];
		expect(hasFailureMarker(messages)).toBe(false);
	});

	it('ignores tool/user messages when finding the latest relevant turn', () => {
		const messages = [msg('assistant', 'compilation failed: see log'), msg('user', 'ok thanks')];
		// Latest assistant is the failure; the trailing user message is skipped.
		expect(hasFailureMarker(messages)).toBe(true);
	});
});

describe('FAILURE_MARKER_PATTERNS', () => {
	it('is a non-empty exported pattern array', () => {
		expect(Array.isArray(FAILURE_MARKER_PATTERNS)).toBe(true);
		expect(FAILURE_MARKER_PATTERNS.length).toBeGreaterThan(0);
	});

	it('does not over-fire on benign prose', () => {
		expect(hasFailureMarker([msg('assistant', 'The build is green and tests pass.')])).toBe(false);
	});
});

describe('detectTaskOutcome - failure lexicon precision', () => {
	it('does not fail a task on benign failed/aborted narration', () => {
		const benign = [
			'All tests pass; 0 failed.',
			'The test failed earlier but now passes.',
			'I aborted the old approach and finished the new one.',
			'No failures found.',
		];
		for (const text of benign) {
			expect(detectTaskOutcome(input('idle', 'busy', [msg('assistant', text)])).outcome).toBe(
				'done'
			);
		}
	});

	it('still fails on tool/exit-shaped failure signals', () => {
		const failing = [
			'error: ENOENT: no such file or directory',
			'fatal: not a git repository',
			'Traceback (most recent call last):',
			'panic: runtime error',
			'the process exited with exit code 1',
			'command not found: foo',
		];
		for (const text of failing) {
			expect(detectTaskOutcome(input('idle', 'busy', [msg('assistant', text)])).outcome).toBe(
				'failed'
			);
		}
	});

	it('treats an error-role message as failure regardless of wording', () => {
		expect(detectTaskOutcome(input('idle', 'busy', [msg('error', 'all good here')])).outcome).toBe(
			'failed'
		);
	});
});

describe('FAILURE_MARKER_PATTERNS - exception/error-prefix precision (Q7)', () => {
	const negatives = [
		'Added exception handling; task complete.',
		'Completed without exception.',
		'Result: no error: all tests pass',
		'0 errors, build succeeded',
	];
	for (const text of negatives) {
		it(`does not fire on benign prose: ${text}`, () => {
			expect(hasFailureMarker([msg('assistant', text)])).toBe(false);
			expect(detectTaskOutcome(input('idle', 'busy', [msg('assistant', text)])).outcome).toBe(
				'done'
			);
		});
	}

	const positives = [
		'Uncaught exception: TypeError',
		'Traceback (most recent call last):',
		'error: cannot find module',
		'Build failed: 3 errors',
		'exit code 1',
		'command not found',
	];
	for (const text of positives) {
		it(`still detects a real failure signal: ${text}`, () => {
			expect(hasFailureMarker([msg('assistant', text)])).toBe(true);
			expect(detectTaskOutcome(input('idle', 'busy', [msg('assistant', text)])).outcome).toBe(
				'failed'
			);
		});
	}
});
