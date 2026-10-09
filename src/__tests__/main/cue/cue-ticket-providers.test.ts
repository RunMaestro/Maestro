/**
 * Tests for the Linear and Jira clients behind `ticket.created` /
 * `ticket.assigned`: request building, response normalization, ADF
 * flattening, and the error kinds the poller branches on.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	adfToText,
	buildJiraJql,
	buildLinearRequest,
	fetchTickets,
	normalizeJiraIssue,
	normalizeLinearIssue,
	TICKET_BODY_MAX_CHARS,
	TicketProviderError,
} from '../../../main/cue/cue-ticket-providers';
import { isSecretEnvKey } from '../../../shared/agentEnvironment';

const NOW = Date.parse('2026-10-03T12:00:00.000Z');

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { 'Content-Type': 'application/json' },
	});
}

function stubFetch(response: Response | Error) {
	const fn = vi.fn(async () => {
		if (response instanceof Error) throw response;
		return response;
	});
	vi.stubGlobal('fetch', fn);
	return fn;
}

async function expectKind(promise: Promise<unknown>, kind: string) {
	const err = await promise.then(
		() => null,
		(e: unknown) => e
	);
	expect(err).toBeInstanceOf(TicketProviderError);
	expect((err as TicketProviderError).kind).toBe(kind);
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe('credential variable names', () => {
	it('masks every secret the ticket triggers read', () => {
		expect(isSecretEnvKey('LINEAR_API_KEY')).toBe(true);
		expect(isSecretEnvKey('JIRA_API_TOKEN')).toBe(true);
	});
});

describe('buildLinearRequest', () => {
	it('bounds ticket.created by a seven-day createdAt window, newest first', () => {
		const { query, variables } = buildLinearRequest({
			provider: 'linear',
			eventType: 'ticket.created',
			now: NOW,
		});
		expect(query).toContain('orderBy: createdAt');
		expect(variables.filter).toEqual({
			createdAt: { gt: '2026-09-26T12:00:00.000Z' },
		});
	});

	it('asks ticket.assigned for open issues assigned to the key owner', () => {
		const { query, variables } = buildLinearRequest({
			provider: 'linear',
			eventType: 'ticket.assigned',
			project: 'ENG',
		});
		expect(query).toContain('orderBy: updatedAt');
		expect(variables.filter).toEqual({
			team: { key: { eq: 'ENG' } },
			assignee: { isMe: { eq: true } },
			state: { type: { nin: ['completed', 'canceled'] } },
		});
	});
});

describe('buildJiraJql', () => {
	it('builds the created query with an optional project scope', () => {
		expect(buildJiraJql({ provider: 'jira', eventType: 'ticket.created' })).toBe(
			'created >= -7d ORDER BY created DESC'
		);
		expect(buildJiraJql({ provider: 'jira', eventType: 'ticket.created', project: 'OPS' })).toBe(
			'created >= -7d AND project = "OPS" ORDER BY created DESC'
		);
	});

	it('builds the assigned query against the current user', () => {
		expect(buildJiraJql({ provider: 'jira', eventType: 'ticket.assigned' })).toBe(
			'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC'
		);
	});
});

describe('adfToText', () => {
	it('flattens paragraphs, lists, mentions, and links into lines', () => {
		const doc = {
			type: 'doc',
			content: [
				{
					type: 'paragraph',
					content: [
						{ type: 'text', text: 'Login fails on ' },
						{ type: 'text', text: 'Safari' },
					],
				},
				{
					type: 'bulletList',
					content: [
						{
							type: 'listItem',
							content: [{ type: 'paragraph', content: [{ type: 'text', text: 'open the app' }] }],
						},
						{
							type: 'listItem',
							content: [
								{
									type: 'paragraph',
									content: [
										{ type: 'text', text: 'ping ' },
										{ type: 'mention', attrs: { text: '@dana' } },
									],
								},
							],
						},
					],
				},
				{ type: 'rule' },
				{
					type: 'paragraph',
					content: [{ type: 'inlineCard', attrs: { url: 'https://example.com' } }],
				},
			],
		};
		expect(adfToText(doc)).toBe(
			'Login fails on Safari\n- open the app\n- ping @dana\n---\nhttps://example.com'
		);
	});

	it('passes a plain string through and tolerates null', () => {
		expect(adfToText('already text')).toBe('already text');
		expect(adfToText(null)).toBe('');
	});
});

describe('normalizers', () => {
	it('normalizes a Linear issue node', () => {
		const ticket = normalizeLinearIssue({
			id: 'uuid-1',
			identifier: 'ENG-7',
			title: 'Crash',
			description: 'x'.repeat(TICKET_BODY_MAX_CHARS + 10),
			url: 'https://linear.app/acme/issue/ENG-7',
			priorityLabel: 'Urgent',
			createdAt: '2026-10-01T00:00:00.000Z',
			updatedAt: '2026-10-02T00:00:00.000Z',
			state: { name: 'Todo' },
			assignee: { displayName: 'pedram', name: 'Pedram Amini' },
			creator: { name: 'Dana' },
			team: { key: 'ENG' },
			labels: { nodes: [{ name: 'bug' }, { name: 'ios' }] },
		});
		expect(ticket).toMatchObject({
			id: 'uuid-1',
			identifier: 'ENG-7',
			state: 'Todo',
			priority: 'Urgent',
			assignee: 'pedram',
			reporter: 'Dana',
			labels: ['bug', 'ios'],
			project: 'ENG',
		});
		expect(ticket.body).toHaveLength(TICKET_BODY_MAX_CHARS);
	});

	it('normalizes a Jira issue and builds its browse URL', () => {
		const ticket = normalizeJiraIssue(
			{
				id: '10042',
				key: 'OPS-3',
				fields: {
					summary: 'Disk full',
					description: {
						type: 'doc',
						content: [{ type: 'paragraph', content: [{ type: 'text', text: 'on db-1' }] }],
					},
					status: { name: 'To Do' },
					priority: { name: 'High' },
					assignee: { displayName: 'Pedram' },
					reporter: { displayName: 'Dana' },
					labels: ['infra'],
					project: { key: 'OPS' },
					created: '2026-10-01T00:00:00.000+0000',
					updated: '2026-10-02T00:00:00.000+0000',
				},
			},
			'https://acme.atlassian.net'
		);
		expect(ticket).toMatchObject({
			id: '10042',
			identifier: 'OPS-3',
			title: 'Disk full',
			body: 'on db-1',
			url: 'https://acme.atlassian.net/browse/OPS-3',
			state: 'To Do',
			priority: 'High',
			labels: ['infra'],
			project: 'OPS',
		});
	});
});

describe('fetchTickets - Linear', () => {
	const query = { provider: 'linear' as const, eventType: 'ticket.created' as const };

	it('reports a missing key without touching the network', async () => {
		const fetchMock = stubFetch(jsonResponse(200, {}));
		await expectKind(fetchTickets(query, { LINEAR_API_KEY: '  ' }), 'missing_credentials');
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('sends the key and returns normalized issues', async () => {
		const fetchMock = stubFetch(
			jsonResponse(200, {
				data: { issues: { nodes: [{ id: 'a', identifier: 'ENG-1', title: 'One' }] } },
			})
		);
		const tickets = await fetchTickets(query, { LINEAR_API_KEY: 'lin_api_123' });
		expect(tickets.map((t) => t.identifier)).toEqual(['ENG-1']);
		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		expect(url).toBe('https://api.linear.app/graphql');
		expect((init.headers as Record<string, string>).Authorization).toBe('lin_api_123');
	});

	it('classifies auth, rate-limit, and query errors', async () => {
		stubFetch(jsonResponse(401, {}));
		await expectKind(fetchTickets(query, { LINEAR_API_KEY: 'k' }), 'auth');

		stubFetch(
			jsonResponse(400, {
				errors: [
					{ message: 'Authentication required', extensions: { code: 'AUTHENTICATION_ERROR' } },
				],
			})
		);
		await expectKind(fetchTickets(query, { LINEAR_API_KEY: 'k' }), 'auth');

		stubFetch(
			jsonResponse(400, { errors: [{ message: 'slow down', extensions: { code: 'RATELIMITED' } }] })
		);
		await expectKind(fetchTickets(query, { LINEAR_API_KEY: 'k' }), 'rate_limit');

		stubFetch(jsonResponse(200, { errors: [{ message: 'Team not found' }] }));
		await expectKind(fetchTickets(query, { LINEAR_API_KEY: 'k' }), 'rejected');

		stubFetch(new TypeError('fetch failed'));
		await expectKind(fetchTickets(query, { LINEAR_API_KEY: 'k' }), 'unreachable');

		stubFetch(jsonResponse(503, {}));
		await expectKind(fetchTickets(query, { LINEAR_API_KEY: 'k' }), 'unreachable');
	});

	it('refuses a project key that is not a plain key', async () => {
		const fetchMock = stubFetch(jsonResponse(200, {}));
		await expectKind(
			fetchTickets({ ...query, project: 'ENG" OR 1=1' }, { LINEAR_API_KEY: 'k' }),
			'rejected'
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe('fetchTickets - Jira', () => {
	const query = {
		provider: 'jira' as const,
		eventType: 'ticket.assigned' as const,
		project: 'OPS',
	};
	const env = {
		JIRA_BASE_URL: 'https://acme.atlassian.net/jira/your-work',
		JIRA_EMAIL: 'me@example.com',
		JIRA_API_TOKEN: 'tok',
	};

	it('names every missing variable', async () => {
		const err = await fetchTickets(query, { JIRA_EMAIL: 'me@example.com' }).catch((e) => e);
		expect(err).toBeInstanceOf(TicketProviderError);
		expect(err.kind).toBe('missing_credentials');
		expect(err.message).toContain('JIRA_BASE_URL, JIRA_API_TOKEN are not set');
	});

	it('rejects a base URL that is not a URL', async () => {
		await expectKind(fetchTickets(query, { ...env, JIRA_BASE_URL: 'acme' }), 'missing_credentials');
	});

	it('searches with basic auth against the site origin', async () => {
		const fetchMock = stubFetch(
			jsonResponse(200, { issues: [{ id: '1', key: 'OPS-1', fields: { summary: 'One' } }] })
		);
		const tickets = await fetchTickets(query, env);
		expect(tickets.map((t) => t.url)).toEqual(['https://acme.atlassian.net/browse/OPS-1']);

		const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
		const parsed = new URL(url);
		expect(parsed.origin + parsed.pathname).toBe(
			'https://acme.atlassian.net/rest/api/3/search/jql'
		);
		expect(parsed.searchParams.get('jql')).toBe(
			'assignee = currentUser() AND statusCategory != Done AND project = "OPS" ORDER BY updated DESC'
		);
		expect((init.headers as Record<string, string>).Authorization).toBe(
			`Basic ${Buffer.from('me@example.com:tok').toString('base64')}`
		);
	});

	it('treats a refused JQL query as the user config, not a crash', async () => {
		stubFetch(
			jsonResponse(400, {
				errorMessages: ["The value 'NOPE' does not exist for the field 'project'."],
			})
		);
		const err = await fetchTickets(query, env).catch((e) => e);
		expect(err.kind).toBe('rejected');
		expect(err.message).toContain('NOPE');
	});
});
