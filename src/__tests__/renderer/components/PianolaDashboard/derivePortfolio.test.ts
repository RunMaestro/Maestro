/**
 * @file derivePortfolio.test.ts
 * @description Tests for the pure portfolio derivation: founder-ask ordering,
 * grouping Working / Results rows by program, and Results reading only the
 * brief's verified list.
 */

import { describe, it, expect } from 'vitest';
import {
	deriveDashboard,
	derivePortfolio,
	deriveResults,
	type PortfolioSnapshot,
} from '../../../../renderer/components/PianolaDashboard/usePianolaDashboardData';
import type { Session, SessionState } from '../../../../renderer/types';
import type {
	PianolaAsk,
	PianolaAskSeverity,
	PianolaBrief,
	PianolaBriefVerified,
	PianolaProgram,
} from '../../../../shared/pianola/pianola-programs';

function session(overrides: Partial<Session> & { id: string; state: SessionState }): Session {
	return { cwd: '', name: overrides.id, aiTabs: [], ...overrides } as Session;
}

const at = (minute: number): string => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

function ask(
	id: string,
	severity: PianolaAskSeverity,
	minute: number,
	over: Partial<PianolaAsk> = {}
) {
	return {
		id,
		createdAt: at(minute),
		updatedAt: at(minute),
		title: `ask ${id}`,
		detail: '',
		severity,
		dedupeKey: `unknown:global`,
		status: 'open',
		...over,
	} satisfies PianolaAsk;
}

function program(id: string, title: string, over: Partial<PianolaProgram> = {}): PianolaProgram {
	return {
		id,
		title,
		root: '/r',
		roles: {},
		charter: { maxConcurrent: 1, maxAttempts: 1, validationRequired: true },
		status: 'active',
		createdAt: 0,
		updatedAt: 0,
		...over,
	};
}

function brief(over: Partial<PianolaBrief> = {}): PianolaBrief {
	return { generatedAt: at(0), needsMe: [], inFlight: [], verified: [], programs: [], ...over };
}

function verified(taskId: string, minute: number, programId?: string): PianolaBriefVerified {
	return {
		programId,
		planId: 'plan',
		planTitle: 'Plan',
		taskId,
		taskTitle: `task ${taskId}`,
		checkName: 'independent-validation',
		completedAt: at(minute),
	};
}

function portfolio(snapshot: Partial<PortfolioSnapshot>, sessions: Session[] = []) {
	const full: PortfolioSnapshot = { brief: null, asks: [], programs: [], ...snapshot };
	return derivePortfolio(deriveDashboard(sessions, []), full, sessions);
}

describe('derivePortfolio', () => {
	it('orders open asks by severity, then oldest first, and drops settled ones', () => {
		const { asks } = portfolio({
			asks: [
				ask('low-old', 'low', 1),
				ask('high-new', 'high', 9),
				ask('critical', 'critical', 5),
				ask('high-old', 'high', 2),
				ask('resolved', 'critical', 0, { status: 'resolved' }),
			],
		});
		expect(asks.map((a) => a.id)).toEqual(['critical', 'high-old', 'high-new', 'low-old']);
	});

	it('names an ask by its program title', () => {
		const { asks } = portfolio({
			asks: [ask('a', 'medium', 1, { programId: 'p1' })],
			programs: [program('p1', 'Checkout')],
		});
		expect(asks[0].programTitle).toBe('Checkout');
	});

	it('groups Working by program, puts a task on its agent, and leaves loose agents last', () => {
		const sessions = [
			session({ id: 'lead', state: 'busy', name: 'Lead' }),
			session({ id: 'dev', state: 'busy', name: 'Dev' }),
			session({ id: 'solo', state: 'busy', name: 'Solo' }),
		];
		const { working } = portfolio(
			{
				programs: [
					program('p-b', 'Beta program', { leadAgentId: 'lead' }),
					program('p-a', 'Alpha program', { roles: { dev: { name: 'dev', agentId: 'dev' } } }),
				],
				brief: brief({
					inFlight: [
						{
							programId: 'p-a',
							planId: 'plan',
							planTitle: 'Plan A',
							taskId: 't1',
							taskTitle: 'Build form',
							status: 'fixing',
							agentId: 'dev',
						},
					],
				}),
			},
			sessions
		);

		expect(working.map((g) => g.programTitle)).toEqual([
			'Alpha program',
			'Beta program',
			undefined,
		]);
		// The in-flight task replaces Dev's plain session row rather than doubling it.
		expect(working[0].rows).toHaveLength(1);
		expect(working[0].rows[0]).toMatchObject({
			sessionId: 'dev',
			agentName: 'Dev',
			description: 'Build form · Plan A · fixing',
		});
		expect(working[1].rows.map((r) => r.sessionId)).toEqual(['lead']);
		expect(working[2].rows.map((r) => r.sessionId)).toEqual(['solo']);
	});

	it('takes Results only from the brief verified list, never from in-flight or needs items', () => {
		const { results } = portfolio({
			brief: brief({
				inFlight: [
					{
						planId: 'plan',
						planTitle: 'Plan',
						taskId: 't1',
						taskTitle: 'still running',
						status: 'running',
					},
				],
				needsMe: [{ kind: 'needs_review', id: 'plan:t2', title: 'awaiting review', since: at(1) }],
			}),
		});
		expect(results).toEqual([]);
	});
});

describe('deriveResults', () => {
	it('groups verified tasks by program, newest first, with the proving check', () => {
		const groups = deriveResults(
			[verified('old', 1, 'p1'), verified('loose', 3), verified('new', 5, 'p1')],
			new Map([['p1', 'Checkout']])
		);
		expect(groups.map((g) => g.programTitle)).toEqual(['Checkout', undefined]);
		expect(groups[0].rows.map((r) => r.taskTitle)).toEqual(['task new', 'task old']);
		expect(groups[0].rows[0].checkName).toBe('independent-validation');
		expect(groups[0].rows[0].completedAt).toBe(Date.parse(at(5)));
	});

	it('is empty when nothing is verified', () => {
		expect(deriveResults([])).toEqual([]);
	});
});
