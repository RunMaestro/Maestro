/**
 * Tests for the ticket poller: first-run seeding, firing on new tickets only,
 * scope-keyed seen state, and how each failure kind is reported.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { seen, mockCaptureException } = vi.hoisted(() => ({
	seen: new Map<string, Map<string, string | null>>(),
	mockCaptureException: vi.fn(),
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: (...args: unknown[]) => {
		mockCaptureException(...args);
		return Promise.resolve();
	},
}));

// A small in-memory stand-in for the cue_github_seen table.
vi.mock('../../../main/cue/cue-db', () => ({
	isCueDbReady: () => true,
	hasAnyGitHubSeen: (sub: string) => (seen.get(sub)?.size ?? 0) > 0,
	isGitHubItemSeen: (sub: string, key: string) => seen.get(sub)?.has(key) ?? false,
	markGitHubItemSeen: (sub: string, key: string) => {
		if (!seen.has(sub)) seen.set(sub, new Map());
		if (!seen.get(sub)!.has(key)) seen.get(sub)!.set(key, null);
	},
	setGitHubItemRevision: (sub: string, key: string, revision: string) => {
		if (!seen.has(sub)) seen.set(sub, new Map());
		seen.get(sub)!.set(key, revision);
	},
	pruneGitHubSeen: vi.fn(),
}));

import { createCueTicketPoller } from '../../../main/cue/cue-ticket-poller';
import {
	TicketProviderError,
	type CueTicket,
	type fetchTickets,
} from '../../../main/cue/cue-ticket-providers';
import type { CueEvent } from '../../../main/cue/cue-types';

function ticket(n: number): CueTicket {
	return {
		id: `id-${n}`,
		identifier: `ENG-${n}`,
		title: `Ticket ${n}`,
		body: `Body ${n}`,
		url: `https://linear.app/acme/issue/ENG-${n}`,
		state: 'Todo',
		priority: 'High',
		assignee: 'Pedram',
		reporter: 'Dana',
		labels: ['bug'],
		project: 'ENG',
		createdAt: `2026-10-0${n}T00:00:00.000Z`,
		updatedAt: `2026-10-0${n}T00:00:00.000Z`,
	};
}

describe('createCueTicketPoller', () => {
	let events: CueEvent[];
	let logs: Array<{ level: string; message: string }>;
	let responses: Array<CueTicket[] | Error>;
	let fetchMock: ReturnType<typeof vi.fn>;
	let stop: (() => void) | null;

	function start(overrides: { seenKey?: string } = {}) {
		stop = createCueTicketPoller({
			eventType: 'ticket.assigned',
			provider: 'linear',
			project: 'ENG',
			pollMinutes: 1,
			triggerName: 'fix-tickets',
			seenKey: overrides.seenKey ?? 'sess:fix-tickets:ticket.assigned:linear:ENG',
			getEnv: () => ({ LINEAR_API_KEY: 'k' }),
			onEvent: (e) => events.push(e),
			onLog: (level, message) => logs.push({ level, message }),
			fetch: fetchMock as unknown as typeof fetchTickets,
		});
	}

	async function tick(ms: number) {
		await vi.advanceTimersByTimeAsync(ms);
	}

	beforeEach(() => {
		vi.useFakeTimers();
		seen.clear();
		mockCaptureException.mockClear();
		events = [];
		logs = [];
		responses = [];
		stop = null;
		fetchMock = vi.fn(async () => {
			const next = responses.shift() ?? [];
			if (next instanceof Error) throw next;
			return next;
		});
	});

	afterEach(() => {
		stop?.();
		vi.useRealTimers();
	});

	it('seeds silently on the first poll, then fires only new tickets, oldest first', async () => {
		// Providers return newest first.
		responses.push([ticket(2), ticket(1)]);
		responses.push([ticket(4), ticket(3), ticket(2), ticket(1)]);
		responses.push([ticket(4), ticket(3), ticket(2), ticket(1)]);
		start();

		await tick(2000);
		expect(events).toEqual([]);
		expect(logs.some((l) => l.message.includes('seeded 2 existing Linear ticket(s)'))).toBe(true);

		await tick(60_000);
		expect(events.map((e) => e.payload.ticket_id)).toEqual(['ENG-3', 'ENG-4']);
		expect(events[0].type).toBe('ticket.assigned');
		expect(events[0].payload).toMatchObject({
			provider: 'linear',
			title: 'Ticket 3',
			body: 'Body 3',
			labels: 'bug',
			project: 'ENG',
			reporter: 'Dana',
		});

		await tick(60_000);
		expect(events).toHaveLength(2);
		expect(fetchMock).toHaveBeenCalledWith(
			{ provider: 'linear', eventType: 'ticket.assigned', project: 'ENG' },
			{ LINEAR_API_KEY: 'k' }
		);
	});

	it('seeds an empty board too, so the first ticket after it fires', async () => {
		responses.push([]);
		responses.push([ticket(1)]);
		start();

		await tick(2000);
		expect(events).toEqual([]);
		await tick(60_000);
		expect(events.map((e) => e.payload.ticket_id)).toEqual(['ENG-1']);
	});

	it('does not flood once a missing credential is fixed', async () => {
		const missing = new TicketProviderError('missing_credentials', 'LINEAR_API_KEY is not set.');
		responses.push(missing, missing, [ticket(2), ticket(1)], [ticket(3), ticket(2), ticket(1)]);
		start();

		await tick(2000);
		await tick(60_000);
		// Reported once, not on every tick, and never as a crash.
		expect(logs.filter((l) => l.message.includes('LINEAR_API_KEY is not set'))).toHaveLength(1);
		expect(mockCaptureException).not.toHaveBeenCalled();

		await tick(60_000);
		expect(events).toEqual([]);
		expect(logs.some((l) => l.message.includes('reconnected to Linear'))).toBe(true);

		await tick(60_000);
		expect(events.map((e) => e.payload.ticket_id)).toEqual(['ENG-3']);
	});

	it('backs off on a rate limit and reports unexpected errors to Sentry', async () => {
		responses.push(new TicketProviderError('rate_limit', 'slow down'));
		responses.push(new Error('boom'));
		start();

		await tick(2000);
		expect(logs.some((l) => l.message.includes('backing off to 2m'))).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// The next poll waits for the doubled interval, not the base one.
		await tick(60_000);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		await tick(60_000);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(mockCaptureException).toHaveBeenCalledTimes(1);
	});

	it('keeps separate seen state per scope', async () => {
		seen.set('old-scope', new Map([['linear:id-1', null]]));
		responses.push([ticket(1)]);
		start({ seenKey: 'new-scope' });

		await tick(2000);
		// A new scope seeds rather than inheriting another scope's history.
		expect(events).toEqual([]);
		expect(seen.get('new-scope')?.has('linear:id-1')).toBe(true);
	});

	it('stops polling after cleanup', async () => {
		start();
		stop!();
		stop = null;
		await tick(5 * 60_000);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
