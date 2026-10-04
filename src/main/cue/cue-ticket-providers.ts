/**
 * Linear and Jira clients for the `ticket.created` / `ticket.assigned` Cue
 * triggers.
 *
 * Each provider answers one question - "which tickets match this
 * subscription right now?" - and normalizes the answer into a
 * {@link CueTicket}. Deciding which of those are NEW is the poller's job
 * (`cue-ticket-poller.ts`); nothing here touches the seen-state database.
 *
 * Credentials come from the owning agent's effective environment (see
 * `resolveAgentEnvironment` in `src/shared/agentEnvironment.ts`), so the
 * variable names below are the ones a user sets in Settings -> Environment
 * or on the agent itself. Every one of them that carries a secret matches
 * `isSecretEnvKey`, which is what masks it in the environment panels.
 */

import {
	CUE_TICKET_PROJECT_KEY_RE,
	type CueEventType,
	type CueTicketProvider,
} from '../../shared/cue';
import { fetchWithTimeout } from './cue-telemetry';

/** Linear personal API key (or `Bearer <oauth token>`). */
export const LINEAR_API_KEY_ENV = 'LINEAR_API_KEY';
/** Jira Cloud site root, e.g. `https://acme.atlassian.net`. */
export const JIRA_BASE_URL_ENV = 'JIRA_BASE_URL';
/** Atlassian account email the API token belongs to. */
export const JIRA_EMAIL_ENV = 'JIRA_EMAIL';
/** Atlassian API token (id.atlassian.com -> Security -> API tokens). */
export const JIRA_API_TOKEN_ENV = 'JIRA_API_TOKEN';

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql';

/** Tickets fetched per poll. Newest first, so this is a window, not a page. */
export const TICKET_FETCH_LIMIT = 50;

/**
 * How far back `ticket.created` looks. Bounding the query by age keeps an old
 * ticket from re-firing after its seen row is pruned: once it is older than
 * this it can never be returned again.
 */
export const TICKET_CREATED_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** Same cap the GitHub poller applies to issue and PR bodies. */
export const TICKET_BODY_MAX_CHARS = 5000;

/** Per-request budget. A stalled tracker must not stall the poll loop. */
const TICKET_FETCH_TIMEOUT_MS = 15_000;

/** One ticket, normalized across providers. */
export interface CueTicket {
	/** Stable internal id (Linear UUID, Jira numeric id). The dedupe key. */
	id: string;
	/** Human identifier (`ENG-123`). */
	identifier: string;
	title: string;
	body: string;
	url: string;
	state: string;
	priority: string;
	assignee: string;
	reporter: string;
	labels: string[];
	/** Linear team key or Jira project key. */
	project: string;
	createdAt: string;
	updatedAt: string;
}

export type TicketProviderErrorKind =
	| 'missing_credentials'
	| 'auth'
	| 'rate_limit'
	| 'unreachable'
	/** The tracker understood the request and refused it: a team or project
	 *  that does not exist, a malformed key. The user's config, not a bug. */
	| 'rejected'
	| 'other';

/**
 * A failure the poller knows how to report. Every kind except `other` is an
 * operational condition the user fixes (or that fixes itself), so the poller
 * logs it instead of filing a crash report.
 */
export class TicketProviderError extends Error {
	constructor(
		readonly kind: TicketProviderErrorKind,
		message: string
	) {
		super(message);
		this.name = 'TicketProviderError';
	}
}

export interface TicketQuery {
	provider: CueTicketProvider;
	eventType: Extract<CueEventType, 'ticket.created' | 'ticket.assigned'>;
	/** Linear team key or Jira project key; undefined = everything visible. */
	project?: string;
	/** Current time, injectable for tests. */
	now?: number;
}

/** Look up a variable, treating an empty or whitespace value as unset. */
function readVar(env: Record<string, string | undefined>, key: string): string | undefined {
	const value = env[key]?.trim();
	return value ? value : undefined;
}

/** Fetch the tickets that currently match `query`, newest first. */
export async function fetchTickets(
	query: TicketQuery,
	env: Record<string, string | undefined>
): Promise<CueTicket[]> {
	if (query.project !== undefined && !CUE_TICKET_PROJECT_KEY_RE.test(query.project)) {
		throw new TicketProviderError(
			'rejected',
			`ticket_project "${query.project}" is not a valid team or project key`
		);
	}
	return query.provider === 'linear'
		? fetchLinearTickets(query, env)
		: fetchJiraTickets(query, env);
}

// ─── Shared HTTP handling ────────────────────────────────────────────────────

async function requestJson(
	providerName: string,
	url: string,
	init: RequestInit
): Promise<{ status: number; body: unknown }> {
	let response: Response;
	try {
		response = await fetchWithTimeout(url, init, TICKET_FETCH_TIMEOUT_MS);
	} catch (err) {
		// fetch rejects only on transport failure (DNS, refused, reset) or our
		// own abort - all of them "the tracker is unreachable right now".
		const reason = err instanceof Error ? err.message : String(err);
		throw new TicketProviderError('unreachable', `${providerName} is unreachable: ${reason}`);
	}

	if (response.status === 401 || response.status === 403) {
		throw new TicketProviderError(
			'auth',
			`${providerName} rejected the credentials (HTTP ${response.status})`
		);
	}
	if (response.status === 429) {
		throw new TicketProviderError('rate_limit', `${providerName} rate limit reached (HTTP 429)`);
	}
	if (response.status >= 500) {
		throw new TicketProviderError(
			'unreachable',
			`${providerName} is degraded (HTTP ${response.status})`
		);
	}

	const text = await response.text();
	let body: unknown = undefined;
	try {
		body = text ? JSON.parse(text) : undefined;
	} catch {
		// Fall through: a non-JSON body is reported below with its status.
	}
	if (!response.ok && body === undefined) {
		throw new TicketProviderError(
			'other',
			`${providerName} request failed (HTTP ${response.status}): ${text.slice(0, 200)}`
		);
	}
	return { status: response.status, body };
}

function asRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string {
	return typeof value === 'string' ? value : value == null ? '' : String(value);
}

// ─── Linear ──────────────────────────────────────────────────────────────────

const LINEAR_ISSUE_FIELDS = `
	id
	identifier
	title
	description
	url
	priorityLabel
	createdAt
	updatedAt
	state { name }
	assignee { displayName name }
	creator { displayName name }
	team { key }
	labels { nodes { name } }
`;

/** Exported for tests: the GraphQL document and variables for one query. */
export function buildLinearRequest(query: TicketQuery): {
	query: string;
	variables: Record<string, unknown>;
} {
	const now = query.now ?? Date.now();
	const filter: Record<string, unknown> = {};
	if (query.project) {
		filter.team = { key: { eq: query.project } };
	}
	let orderBy: 'createdAt' | 'updatedAt';
	if (query.eventType === 'ticket.created') {
		filter.createdAt = { gt: new Date(now - TICKET_CREATED_LOOKBACK_MS).toISOString() };
		orderBy = 'createdAt';
	} else {
		filter.assignee = { isMe: { eq: true } };
		// Finished work is not work to start on.
		filter.state = { type: { nin: ['completed', 'canceled'] } };
		orderBy = 'updatedAt';
	}
	return {
		query: `query CueTickets($filter: IssueFilter, $first: Int!) {
	issues(filter: $filter, first: $first, orderBy: ${orderBy}) {
		nodes {${LINEAR_ISSUE_FIELDS}}
	}
}`,
		variables: { filter, first: TICKET_FETCH_LIMIT },
	};
}

function personName(value: unknown): string {
	const person = asRecord(value);
	return asString(person.displayName) || asString(person.name);
}

/** Exported for tests: normalize one Linear issue node. */
export function normalizeLinearIssue(node: unknown): CueTicket {
	const issue = asRecord(node);
	const labelNodes = asRecord(issue.labels).nodes;
	return {
		id: asString(issue.id),
		identifier: asString(issue.identifier),
		title: asString(issue.title),
		body: asString(issue.description).slice(0, TICKET_BODY_MAX_CHARS),
		url: asString(issue.url),
		state: asString(asRecord(issue.state).name),
		priority: asString(issue.priorityLabel),
		assignee: personName(issue.assignee),
		reporter: personName(issue.creator),
		labels: Array.isArray(labelNodes)
			? labelNodes.map((l) => asString(asRecord(l).name)).filter(Boolean)
			: [],
		project: asString(asRecord(issue.team).key),
		createdAt: asString(issue.createdAt),
		updatedAt: asString(issue.updatedAt),
	};
}

async function fetchLinearTickets(
	query: TicketQuery,
	env: Record<string, string | undefined>
): Promise<CueTicket[]> {
	const apiKey = readVar(env, LINEAR_API_KEY_ENV);
	if (!apiKey) {
		throw new TicketProviderError(
			'missing_credentials',
			`${LINEAR_API_KEY_ENV} is not set. Add it in Settings -> Environment or on this agent's environment variables.`
		);
	}

	const { body } = await requestJson('Linear', LINEAR_GRAPHQL_URL, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			// Personal API keys go in bare; an OAuth token arrives already
			// prefixed with "Bearer ", which Linear also accepts verbatim.
			Authorization: apiKey,
		},
		body: JSON.stringify(buildLinearRequest(query)),
	});

	const result = asRecord(body);
	const errors = Array.isArray(result.errors) ? result.errors.map(asRecord) : [];
	if (errors.length > 0) {
		const message = errors.map((e) => asString(e.message)).join('; ');
		const codes = errors.map((e) => asString(asRecord(e.extensions).code).toUpperCase());
		const lowered = message.toLowerCase();
		if (codes.includes('RATELIMITED')) {
			throw new TicketProviderError('rate_limit', `Linear rate limit reached: ${message}`);
		}
		if (codes.includes('AUTHENTICATION_ERROR') || lowered.includes('authentication')) {
			throw new TicketProviderError('auth', `Linear rejected ${LINEAR_API_KEY_ENV}: ${message}`);
		}
		throw new TicketProviderError('rejected', `Linear query failed: ${message}`);
	}

	const nodes = asRecord(asRecord(result.data).issues).nodes;
	return Array.isArray(nodes) ? nodes.map(normalizeLinearIssue) : [];
}

// ─── Jira ────────────────────────────────────────────────────────────────────

/** Exported for tests: the JQL for one query. */
export function buildJiraJql(query: TicketQuery): string {
	const clauses: string[] = [];
	if (query.eventType === 'ticket.created') {
		const days = Math.round(TICKET_CREATED_LOOKBACK_MS / (24 * 60 * 60 * 1000));
		clauses.push(`created >= -${days}d`);
	} else {
		clauses.push('assignee = currentUser()', 'statusCategory != Done');
	}
	if (query.project) {
		// Safe to quote: fetchTickets has already checked the key's shape.
		clauses.push(`project = "${query.project}"`);
	}
	const order = query.eventType === 'ticket.created' ? 'created' : 'updated';
	return `${clauses.join(' AND ')} ORDER BY ${order} DESC`;
}

/**
 * Flatten an Atlassian Document Format tree into plain text.
 *
 * Jira's v3 API returns descriptions as ADF JSON. An agent prompt wants the
 * words, not the tree, so block nodes become lines, list items get a bullet,
 * and the inline nodes that carry text of their own (mentions, emoji, links)
 * are rendered as that text. Anything unrecognized contributes its children.
 * A plain string (Jira Server, or an already-flat field) is returned as-is.
 */
export function adfToText(node: unknown): string {
	if (typeof node === 'string') return node;
	const lines: string[] = [];
	let current = '';

	const flush = () => {
		if (current.trim() !== '') lines.push(current.trimEnd());
		current = '';
	};

	const walk = (value: unknown, prefix: string): void => {
		const n = asRecord(value);
		const attrs = asRecord(n.attrs);
		const children = Array.isArray(n.content) ? n.content : [];
		switch (n.type) {
			case 'text':
				current += asString(n.text);
				return;
			case 'hardBreak':
				flush();
				return;
			case 'mention':
			case 'emoji':
				current += asString(attrs.text) || asString(attrs.shortName);
				return;
			case 'inlineCard':
			case 'blockCard':
				current += asString(attrs.url);
				return;
			case 'listItem':
				flush();
				current = prefix;
				for (const child of children) walk(child, prefix);
				flush();
				return;
			case 'bulletList':
			case 'orderedList':
				for (const child of children) walk(child, '- ');
				return;
			case 'paragraph':
			case 'heading':
			case 'codeBlock':
			case 'blockquote':
			case 'panel':
				if (current !== prefix) flush();
				for (const child of children) walk(child, prefix);
				flush();
				return;
			case 'rule':
				flush();
				lines.push('---');
				return;
			default:
				for (const child of children) walk(child, prefix);
		}
	};

	walk(node, '');
	flush();
	return lines.join('\n');
}

/** Exported for tests: normalize one Jira issue from the search response. */
export function normalizeJiraIssue(raw: unknown, baseUrl: string): CueTicket {
	const issue = asRecord(raw);
	const fields = asRecord(issue.fields);
	const key = asString(issue.key);
	const labels = Array.isArray(fields.labels) ? fields.labels.map(asString).filter(Boolean) : [];
	return {
		id: asString(issue.id) || key,
		identifier: key,
		title: asString(fields.summary),
		body: adfToText(fields.description).slice(0, TICKET_BODY_MAX_CHARS),
		url: key ? `${baseUrl}/browse/${key}` : '',
		state: asString(asRecord(fields.status).name),
		priority: asString(asRecord(fields.priority).name),
		assignee: asString(asRecord(fields.assignee).displayName),
		reporter: asString(asRecord(fields.reporter).displayName),
		labels,
		project: asString(asRecord(fields.project).key),
		createdAt: asString(fields.created),
		updatedAt: asString(fields.updated),
	};
}

async function fetchJiraTickets(
	query: TicketQuery,
	env: Record<string, string | undefined>
): Promise<CueTicket[]> {
	const rawBase = readVar(env, JIRA_BASE_URL_ENV);
	const email = readVar(env, JIRA_EMAIL_ENV);
	const token = readVar(env, JIRA_API_TOKEN_ENV);
	const missing = [
		!rawBase && JIRA_BASE_URL_ENV,
		!email && JIRA_EMAIL_ENV,
		!token && JIRA_API_TOKEN_ENV,
	].filter(Boolean);
	if (missing.length > 0 || !rawBase || !email || !token) {
		throw new TicketProviderError(
			'missing_credentials',
			`${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. Add ${missing.length === 1 ? 'it' : 'them'} in Settings -> Environment or on this agent's environment variables.`
		);
	}
	let baseUrl: string;
	try {
		const parsed = new URL(rawBase);
		if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('protocol');
		baseUrl = parsed.origin;
	} catch {
		throw new TicketProviderError(
			'missing_credentials',
			`${JIRA_BASE_URL_ENV} must be a URL like https://your-site.atlassian.net`
		);
	}

	const params = new URLSearchParams({
		jql: buildJiraJql(query),
		maxResults: String(TICKET_FETCH_LIMIT),
		fields: 'summary,description,status,priority,assignee,reporter,labels,project,created,updated',
	});
	const { status, body } = await requestJson(
		'Jira',
		`${baseUrl}/rest/api/3/search/jql?${params.toString()}`,
		{
			method: 'GET',
			headers: {
				Accept: 'application/json',
				Authorization: `Basic ${Buffer.from(`${email}:${token}`).toString('base64')}`,
			},
		}
	);

	const result = asRecord(body);
	if (status >= 400) {
		// Jira reports a bad JQL clause (e.g. a project that does not exist) as
		// a 400 with `errorMessages`; that is the user's config, not a crash.
		const messages = Array.isArray(result.errorMessages)
			? result.errorMessages.map(asString).join('; ')
			: '';
		throw new TicketProviderError(
			'rejected',
			`Jira search failed (HTTP ${status})${messages ? `: ${messages}` : ''}`
		);
	}
	const issues = Array.isArray(result.issues) ? result.issues : [];
	return issues.map((issue) => normalizeJiraIssue(issue, baseUrl));
}
