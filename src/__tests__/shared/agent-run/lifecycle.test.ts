import { describe, expect, it } from 'vitest';
import {
	assertTransition,
	canTransition,
	isTerminalAgentRunStatus,
	TERMINAL_AGENT_RUN_STATUSES,
} from '../../../shared/agent-run/lifecycle';
import { AGENT_RUN_STATUSES, type AgentRunStatus } from '../../../shared/agent-run/types';

/**
 * The lifecycle contract, restated independently of the implementation. If the
 * guard's edge set drifts from this spec, the full-matrix test below fails.
 * Terminal sources list the audited-only edges they may still take.
 */
const LEGAL_EDGES: Record<AgentRunStatus, AgentRunStatus[]> = {
	queued: ['running', 'waiting', 'cancelled', 'failed'],
	running: ['waiting', 'needs_review', 'fixing', 'completed', 'failed', 'cancelled'],
	waiting: ['running', 'needs_review', 'completed', 'failed', 'cancelled'],
	needs_review: ['fixing', 'completed', 'merged', 'failed', 'cancelled', 'discarded'],
	fixing: ['running', 'needs_review', 'completed', 'failed', 'cancelled'],
	completed: ['merged', 'needs_review', 'discarded'],
	failed: ['running', 'discarded'],
	cancelled: ['running', 'discarded'],
	merged: [],
	discarded: [],
};

const TERMINAL: AgentRunStatus[] = ['completed', 'failed', 'cancelled', 'merged', 'discarded'];
const NON_TERMINAL: AgentRunStatus[] = ['queued', 'running', 'waiting', 'needs_review', 'fixing'];

const isTerminalSpec = (status: AgentRunStatus): boolean => TERMINAL.includes(status);

/** Flat list of every legal edge whose source is a non-terminal status. */
const legalNonTerminalEdges: [AgentRunStatus, AgentRunStatus][] = NON_TERMINAL.flatMap((from) =>
	LEGAL_EDGES[from].map((to) => [from, to] as [AgentRunStatus, AgentRunStatus])
);

describe('canTransition / assertTransition - legal non-terminal transitions', () => {
	it.each(legalNonTerminalEdges)('%s -> %s is legal without an audited action', (from, to) => {
		expect(canTransition(from, to)).toBe(true);
		expect(assertTransition(from, to)).toBe(to);
		expect(() => assertTransition(from, to)).not.toThrow();
	});
});

describe('canTransition / assertTransition - no-op transitions', () => {
	it.each([...AGENT_RUN_STATUSES])('%s -> %s (no-op) is always legal', (status) => {
		expect(canTransition(status, status)).toBe(true);
		expect(assertTransition(status, status)).toBe(status);
	});

	it('a no-op on a terminal state is legal without an audited action', () => {
		// from === to short-circuits before the terminal guard.
		expect(canTransition('merged', 'merged')).toBe(true);
		expect(canTransition('discarded', 'discarded')).toBe(true);
		expect(canTransition('completed', 'completed')).toBe(true);
	});
});

describe('canTransition / assertTransition - illegal transitions', () => {
	const representativeIllegal: [AgentRunStatus, AgentRunStatus][] = [
		['completed', 'running'], // running is not even an audited edge of completed
		['queued', 'merged'], // merge only reachable from needs_review/completed
		['merged', 'running'], // merged is a sink: zero outgoing edges
		['merged', 'needs_review'],
		['discarded', 'running'], // discarded is a sink: zero outgoing edges
		['queued', 'needs_review'], // must run before review
		['queued', 'completed'], // cannot complete straight from the queue
		['running', 'merged'], // merge requires review first
		['running', 'discarded'],
		['fixing', 'merged'],
		['waiting', 'fixing'],
		['needs_review', 'running'],
	];

	it.each(representativeIllegal)('%s -> %s is rejected and assertTransition throws', (from, to) => {
		expect(canTransition(from, to)).toBe(false);
		expect(() => assertTransition(from, to)).toThrow(
			`illegal agent-run transition: ${from} -> ${to}`
		);
	});

	it('rejects every edge not in the table across the full unaudited status matrix', () => {
		for (const from of AGENT_RUN_STATUSES) {
			for (const to of AGENT_RUN_STATUSES) {
				if (from === to) continue;
				const expected = !isTerminalSpec(from) && LEGAL_EDGES[from].includes(to);
				expect(canTransition(from, to), `${from} -> ${to} (unaudited)`).toBe(expected);
				if (!expected) {
					expect(() => assertTransition(from, to), `${from} -> ${to}`).toThrow(
						/^illegal agent-run transition:/
					);
				}
			}
		}
	});
});

describe('canTransition / assertTransition - terminal invariant', () => {
	const auditedEscapes: [AgentRunStatus, AgentRunStatus][] = [
		['completed', 'merged'],
		['failed', 'running'],
		['cancelled', 'running'],
		['completed', 'discarded'],
	];

	it.each(auditedEscapes)(
		'leaving terminal %s -> %s is rejected without audited and allowed with it',
		(from, to) => {
			expect(canTransition(from, to)).toBe(false);
			expect(() => assertTransition(from, to)).toThrow(
				`illegal agent-run transition: ${from} -> ${to}`
			);

			expect(canTransition(from, to, { audited: true })).toBe(true);
			expect(assertTransition(from, to, { audited: true })).toBe(to);
			expect(() => assertTransition(from, to, { audited: true })).not.toThrow();
		}
	);

	it('audited: false is treated the same as omitting the option', () => {
		expect(canTransition('completed', 'merged', { audited: false })).toBe(false);
		expect(() => assertTransition('completed', 'merged', { audited: false })).toThrow(
			'illegal agent-run transition: completed -> merged'
		);
	});

	const sinkEscapes: [AgentRunStatus, AgentRunStatus][] = [
		['merged', 'running'],
		['merged', 'needs_review'],
		['merged', 'completed'],
		['discarded', 'running'],
		['discarded', 'completed'],
		['discarded', 'needs_review'],
	];

	it.each(sinkEscapes)(
		'%s -> %s stays rejected even with an audited action (zero outgoing edges)',
		(from, to) => {
			expect(canTransition(from, to, { audited: true })).toBe(false);
			expect(() => assertTransition(from, to, { audited: true })).toThrow(
				`illegal agent-run transition: ${from} -> ${to}`
			);
		}
	);

	it('completed -> running is illegal even when audited (not a listed edge)', () => {
		expect(canTransition('completed', 'running', { audited: true })).toBe(false);
		expect(() => assertTransition('completed', 'running', { audited: true })).toThrow(
			'illegal agent-run transition: completed -> running'
		);
	});
});

describe('assertTransition - error message', () => {
	it('names both the source and target status', () => {
		expect(() => assertTransition('queued', 'merged')).toThrow(
			'illegal agent-run transition: queued -> merged'
		);
	});

	it('appends a terminal hint when leaving a terminal state without an audited action', () => {
		expect(() => assertTransition('completed', 'merged')).toThrow(
			'illegal agent-run transition: completed -> merged (terminal, needs audited action)'
		);
	});

	it('omits the terminal hint for a plain unlisted-edge rejection', () => {
		let message = '';
		try {
			assertTransition('queued', 'merged');
		} catch (error) {
			message = (error as Error).message;
		}
		expect(message).toBe('illegal agent-run transition: queued -> merged');
		expect(message).not.toContain('terminal, needs audited action');
	});
});

describe('isTerminalAgentRunStatus', () => {
	it.each(TERMINAL)('%s is terminal', (status) => {
		expect(isTerminalAgentRunStatus(status)).toBe(true);
	});

	it.each(NON_TERMINAL)('%s is not terminal', (status) => {
		expect(isTerminalAgentRunStatus(status)).toBe(false);
	});

	it('classifies every declared status as exactly terminal xor non-terminal', () => {
		for (const status of AGENT_RUN_STATUSES) {
			expect(isTerminalAgentRunStatus(status)).toBe(TERMINAL.includes(status));
		}
	});
});

describe('TERMINAL_AGENT_RUN_STATUSES', () => {
	it('contains exactly the five terminal statuses and nothing else', () => {
		expect(TERMINAL_AGENT_RUN_STATUSES).toHaveLength(5);
		expect([...TERMINAL_AGENT_RUN_STATUSES].sort()).toEqual(
			['cancelled', 'completed', 'discarded', 'failed', 'merged'].sort()
		);
		for (const status of NON_TERMINAL) {
			expect(TERMINAL_AGENT_RUN_STATUSES).not.toContain(status);
		}
	});
});
