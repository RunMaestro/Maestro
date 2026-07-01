import { describe, expect, it } from 'vitest';
import {
	deriveTerminalStatus,
	hasOpenCriticalOrHighFinding,
	hasOpenReviewFinding,
} from '../../../shared/agent-run/terminal-status';
import type {
	AgentRun,
	AgentRunReviewFinding,
	AgentRunReviewSeverity,
	AgentRunReviewStatus,
} from '../../../shared/agent-run/types';

/**
 * deriveTerminalStatus decides what status a run settles to on process exit:
 * nonzero exit is always failed; a clean exit carrying an open critical/high
 * finding diverts to needs_review; any other clean exit is completed. The two
 * predicates back that decision and the signal producers' guards.
 *
 * Runs are built as full AgentRun objects so the tests exercise the real type,
 * with only `reviews` varied since that is the field these pure helpers read.
 */

function makeFinding(
	severity: AgentRunReviewSeverity,
	status: AgentRunReviewStatus
): AgentRunReviewFinding {
	return {
		severity,
		status,
		category: 'security',
		message: `${severity} ${status} finding`,
	};
}

function makeRun(reviews: AgentRunReviewFinding[]): AgentRun {
	return {
		id: 'run-1',
		createdAt: 1000,
		updatedAt: 2000,
		provider: 'claude-code',
		status: 'running',
		artifacts: [],
		touchedFiles: [],
		checks: [],
		reviews,
	};
}

describe('deriveTerminalStatus - nonzero exit always fails', () => {
	it('nonzero exit with a clean run is failed (never completed)', () => {
		expect(deriveTerminalStatus(makeRun([]), 1)).toBe('failed');
	});

	it('nonzero exit with an open critical finding is still failed, not needs_review', () => {
		const run = makeRun([makeFinding('critical', 'open')]);
		expect(deriveTerminalStatus(run, 1)).toBe('failed');
	});

	it.each([1, 2, 127, 130, -1])('exit code %i is failed', (code) => {
		expect(deriveTerminalStatus(makeRun([]), code)).toBe('failed');
	});
});

describe('deriveTerminalStatus - clean exit with open high-severity findings', () => {
	it('exit 0 + open critical finding -> needs_review', () => {
		const run = makeRun([makeFinding('critical', 'open')]);
		expect(deriveTerminalStatus(run, 0)).toBe('needs_review');
	});

	it('exit 0 + open high finding -> needs_review', () => {
		const run = makeRun([makeFinding('high', 'open')]);
		expect(deriveTerminalStatus(run, 0)).toBe('needs_review');
	});

	it('exit 0 + open high alongside fixed critical -> needs_review', () => {
		const run = makeRun([makeFinding('critical', 'fixed'), makeFinding('high', 'open')]);
		expect(deriveTerminalStatus(run, 0)).toBe('needs_review');
	});
});

describe('deriveTerminalStatus - clean exit that completes', () => {
	it('exit 0 + no findings -> completed', () => {
		expect(deriveTerminalStatus(makeRun([]), 0)).toBe('completed');
	});

	it('exit 0 + only open low/medium/info findings -> completed', () => {
		const run = makeRun([
			makeFinding('low', 'open'),
			makeFinding('medium', 'open'),
			makeFinding('info', 'open'),
		]);
		expect(deriveTerminalStatus(run, 0)).toBe('completed');
	});

	it('exit 0 + critical/high findings all fixed or dismissed -> completed', () => {
		const run = makeRun([makeFinding('critical', 'fixed'), makeFinding('high', 'dismissed')]);
		expect(deriveTerminalStatus(run, 0)).toBe('completed');
	});
});

describe('hasOpenReviewFinding', () => {
	it('true when at least one finding is open (any severity)', () => {
		expect(hasOpenReviewFinding(makeRun([makeFinding('info', 'open')]))).toBe(true);
		expect(hasOpenReviewFinding(makeRun([makeFinding('low', 'open')]))).toBe(true);
	});

	it('false for an empty review list', () => {
		expect(hasOpenReviewFinding(makeRun([]))).toBe(false);
	});

	it('false when every finding is fixed or dismissed', () => {
		const run = makeRun([makeFinding('critical', 'fixed'), makeFinding('high', 'dismissed')]);
		expect(hasOpenReviewFinding(run)).toBe(false);
	});
});

describe('hasOpenCriticalOrHighFinding', () => {
	it('true for an open critical finding', () => {
		expect(hasOpenCriticalOrHighFinding(makeRun([makeFinding('critical', 'open')]))).toBe(true);
	});

	it('true for an open high finding', () => {
		expect(hasOpenCriticalOrHighFinding(makeRun([makeFinding('high', 'open')]))).toBe(true);
	});

	it('false when critical/high findings are open only at lower severities', () => {
		const run = makeRun([makeFinding('medium', 'open'), makeFinding('low', 'open')]);
		expect(hasOpenCriticalOrHighFinding(run)).toBe(false);
	});

	it('false when a critical finding is fixed (severity matches but not open)', () => {
		expect(hasOpenCriticalOrHighFinding(makeRun([makeFinding('critical', 'fixed')]))).toBe(false);
	});

	it('false for an empty review list', () => {
		expect(hasOpenCriticalOrHighFinding(makeRun([]))).toBe(false);
	});
});
