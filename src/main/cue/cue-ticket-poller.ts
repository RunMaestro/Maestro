/**
 * Ticket poller for Maestro Cue `ticket.created` and `ticket.assigned`
 * subscriptions (Linear and Jira).
 *
 * Asks the provider for the tickets that currently match the subscription
 * (`cue-ticket-providers.ts`), fires a CueEvent for each one not seen before,
 * and records it in the same per-subscription seen table the GitHub poller
 * uses. The first SUCCESSFUL poll seeds silently, so adding a subscription
 * does not replay every ticket already on the board.
 *
 * Unlike the GitHub poller, a failed first poll does not plant a seed marker.
 * The usual first failure here is a credential the user has not set yet, and
 * a marker would make the poll after they set it fire on every open ticket at
 * once - a run per ticket, all at the same time.
 *
 * "Assigned" means "assigned to the credential's owner": the subscription
 * fires the first time a ticket shows up in that person's open queue, which
 * is the Amp-style "start on it the moment it lands on me" loop.
 */

import type { CueTicketProvider } from '../../shared/cue';
import type { CueLogPayload } from '../../shared/cue-log-types';
import {
	hasAnyGitHubSeen,
	isCueDbReady,
	isGitHubItemSeen,
	markGitHubItemSeen,
	pruneGitHubSeen,
	setGitHubItemRevision,
} from './cue-db';
import {
	fetchTickets,
	TicketProviderError,
	type CueTicket,
	type TicketQuery,
} from './cue-ticket-providers';
import { createCueEvent, type CueEvent } from './cue-types';
import { captureException } from '../utils/sentry';

/** Default poll cadence when the subscription omits `poll_minutes`. */
export const DEFAULT_TICKET_POLL_MINUTES = 5;

/** Backoff ceiling after a rate limit, matching the GitHub poller. */
const TICKET_RATE_LIMIT_MAX_BACKOFF_MS = 60 * 60 * 1000;

/** Seen-row retention. Rows for tickets still in the window are refreshed every poll. */
const TICKET_SEEN_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const SEED_MARKER_KEY = '__seed_marker__';

export interface CueTicketPollerConfig {
	eventType: TicketQuery['eventType'];
	provider: CueTicketProvider;
	project?: string;
	pollMinutes: number;
	triggerName: string;
	/**
	 * Seen-state key. Should change whenever the subscription's scope does
	 * (provider, project, event), so a re-scoped subscription seeds afresh
	 * instead of firing on every ticket in its new scope.
	 */
	seenKey: string;
	/** The owning agent's effective environment, read fresh on every poll. */
	getEnv: () => Record<string, string | undefined>;
	onEvent: (event: CueEvent) => void;
	onLog: (level: string, message: string, data?: unknown) => void;
	/** Same contract as the GitHub poller's `onReady`. */
	onReady?: (handle: { pollNow: () => void }) => void;
	/** Visibility-aware pause gate. Defaults to always active. */
	isActive?: () => boolean;
	/** Injectable for tests. */
	fetch?: typeof fetchTickets;
}

/** Seen-row key for one ticket. */
export function ticketItemKey(provider: CueTicketProvider, ticket: CueTicket): string {
	return `${provider}:${ticket.id}`;
}

/** Event payload for one ticket. Field names are what `filter:` blocks match on. */
export function buildTicketPayload(
	provider: CueTicketProvider,
	ticket: CueTicket
): Record<string, unknown> {
	return {
		provider,
		ticket_id: ticket.identifier,
		title: ticket.title,
		body: ticket.body,
		url: ticket.url,
		state: ticket.state,
		priority: ticket.priority,
		assignee: ticket.assignee,
		reporter: ticket.reporter,
		labels: ticket.labels.join(','),
		project: ticket.project,
		created_at: ticket.createdAt,
		updated_at: ticket.updatedAt,
	};
}

/**
 * Start polling. Returns a cleanup function that stops every timer.
 */
export function createCueTicketPoller(config: CueTicketPollerConfig): () => void {
	const { eventType, provider, project, triggerName, seenKey, onEvent, onLog } = config;
	const isActive = config.isActive ?? (() => true);
	const fetchImpl = config.fetch ?? fetchTickets;
	const providerName = provider === 'linear' ? 'Linear' : 'Jira';

	const basePollMs = Math.max(1, config.pollMinutes) * 60 * 1000;
	let currentPollMs = basePollMs;
	let stopped = false;
	let polling = false;
	let initialTimeout: ReturnType<typeof setTimeout> | null = null;
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let pruneInterval: ReturnType<typeof setInterval> | null = null;
	// A missing key or a bad project fails every tick until the user acts;
	// repeating the identical warning every five minutes only buries it.
	let lastReportedProblem: string | null = null;

	function reportProblem(level: 'warn' | 'error', message: string, data?: unknown): void {
		if (message === lastReportedProblem) return;
		lastReportedProblem = message;
		onLog(level, message, data);
	}

	async function doPoll(): Promise<void> {
		if (stopped || polling) return;
		if (!isActive()) return;
		if (!isCueDbReady()) {
			onLog(
				'warn',
				`[CUE] Cue database not ready - skipping ${providerName} poll for "${triggerName}"`
			);
			return;
		}

		polling = true;
		try {
			const tickets = await fetchImpl({ provider, eventType, project }, config.getEnv());
			if (stopped) return;

			if (lastReportedProblem !== null) {
				onLog('info', `[CUE] "${triggerName}" reconnected to ${providerName}`);
				lastReportedProblem = null;
			}
			currentPollMs = basePollMs;

			// First successful poll: everything already there is history, not news.
			if (!hasAnyGitHubSeen(seenKey)) {
				for (const ticket of tickets) {
					setGitHubItemRevision(seenKey, ticketItemKey(provider, ticket), ticket.updatedAt);
				}
				markGitHubItemSeen(seenKey, SEED_MARKER_KEY);
				onLog(
					'info',
					`[CUE] "${triggerName}" seeded ${tickets.length} existing ${providerName} ticket(s) - only new ones will fire`
				);
				return;
			}

			// Oldest first, so a batch reaches the agent in the order it happened.
			const fresh = tickets.filter((t) => !isGitHubItemSeen(seenKey, ticketItemKey(provider, t)));
			fresh.reverse();

			for (const ticket of tickets) {
				// Refresh every ticket still in the window so its row outlives the
				// 30-day prune for as long as the provider keeps returning it.
				setGitHubItemRevision(seenKey, ticketItemKey(provider, ticket), ticket.updatedAt);
			}

			for (const ticket of fresh) {
				if (stopped) return;
				onEvent(createCueEvent(eventType, triggerName, buildTicketPayload(provider, ticket)));
			}
		} catch (err) {
			handlePollError(err);
		} finally {
			polling = false;
		}
	}

	function handlePollError(err: unknown): void {
		const message = err instanceof Error ? err.message : String(err);
		const kind = err instanceof TicketProviderError ? err.kind : 'other';

		switch (kind) {
			case 'rate_limit': {
				currentPollMs = Math.min(currentPollMs * 2, TICKET_RATE_LIMIT_MAX_BACKOFF_MS);
				const payload: CueLogPayload = {
					type: 'rateLimitBackoff',
					triggerName,
					backoffMs: currentPollMs,
				};
				onLog(
					'warn',
					`[CUE] "${triggerName}" rate-limited by ${providerName} - backing off to ${Math.round(currentPollMs / 60000)}m`,
					payload
				);
				break;
			}
			case 'unreachable':
				onLog('warn', `[CUE] ${providerName} poll skipped for "${triggerName}": ${message}`);
				break;
			case 'missing_credentials':
			case 'auth':
			case 'rejected':
				// Fixable only by the user, so say what is wrong once rather than
				// filing a crash report on every tick.
				reportProblem('warn', `[CUE] "${triggerName}" cannot poll ${providerName}: ${message}`);
				break;
			default:
				reportProblem('error', `[CUE] ${providerName} poll error for "${triggerName}": ${message}`);
				void captureException(err, { operation: 'cue:ticket:doPoll', triggerName, provider });
		}
	}

	function scheduleNextPoll(): void {
		if (stopped) return;
		pollTimer = setTimeout(() => {
			// doPoll handles its own errors; finally keeps the loop alive anyway.
			void doPoll().finally(scheduleNextPoll);
		}, currentPollMs);
	}

	initialTimeout = setTimeout(() => {
		if (stopped) return;
		void doPoll().finally(scheduleNextPoll);
	}, 2000);

	pruneInterval = setInterval(
		() => {
			if (isCueDbReady()) pruneGitHubSeen(TICKET_SEEN_RETENTION_MS);
		},
		24 * 60 * 60 * 1000
	);

	config.onReady?.({
		pollNow: () => {
			if (stopped) return;
			void doPoll();
		},
	});

	return () => {
		stopped = true;
		if (initialTimeout) clearTimeout(initialTimeout);
		if (pollTimer) clearTimeout(pollTimer);
		if (pruneInterval) clearInterval(pruneInterval);
		initialTimeout = null;
		pollTimer = null;
		pruneInterval = null;
	};
}
