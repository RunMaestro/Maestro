/**
 * Forward Cue notifications to an external URL (`cue engine start
 * --notify-webhook <url>`): every `action: notify` run, and every Cue run that
 * failed on an expired agent login. A headless server has no window to toast
 * in, so this is how a person hears about either.
 *
 * Contract:
 * - Fire-and-forget. `send` is synchronous and never throws; the POST happens
 *   later, so a slow or dead endpoint can never delay or fail a run.
 * - Bounded: at most {@link WEBHOOK_MAX_IN_FLIGHT} POSTs at once and
 *   {@link WEBHOOK_MAX_QUEUED} waiting; beyond that a notification is dropped
 *   and counted.
 * - No retries: these are advisory alerts, and a retry after a slow but
 *   successful POST would deliver the same alert twice.
 * - Logged once per burst: the first failure or drop warns; later ones are
 *   counted until a POST succeeds, which logs one recovery line.
 * - The URL is logged only as origin + path: never its query string or
 *   credentials, which is where tokens for these endpoints usually live.
 * - The body is built from explicitly picked fields (`buildNotifyWebhookBody`):
 *   no prompt of an agent run, no event payload, no run output, no env.
 *
 * No Electron imports.
 */

import { fetchWithTimeout } from '../utils/fetchWithTimeout';

export const WEBHOOK_MAX_IN_FLIGHT = 4;
export const WEBHOOK_MAX_QUEUED = 100;
export const WEBHOOK_TIMEOUT_MS = 5_000;

/** What the standalone runner reports. Everything here ends up in the body. */
export interface CueExternalNotification {
	type: 'cue.notify' | 'agent.auth_expired';
	agent: { id: string; name: string; toolType: string };
	subscription: string;
	pipeline: string | null;
	runId: string;
	/** `cue.notify`: the toast title (the agent's name). `agent.auth_expired`: "<agent>: login expired". */
	title: string;
	/**
	 * `cue.notify`: the toast text the notify action defines (`notify.message`,
	 * then `label`, then the notify subscription's own `prompt` field, then its
	 * name). `agent.auth_expired`: the error bank's fixed classification.
	 */
	message: string;
	sticky: boolean;
}

export interface NotifyWebhookBody extends CueExternalNotification {
	version: 1;
	timestamp: string;
}

/** The parsed target. `display` is the only form that may be logged. */
export interface NotifyWebhookTarget {
	/** The URL POSTed to, WITHOUT user info: fetch refuses a URL carrying credentials. */
	url: string;
	display: string;
	/** `Basic ...` built from the URL's `user:pass@`, when it had one. */
	authorization?: string;
}

/** Accept http(s) URLs only. Throws a message that never echoes the query or credentials. */
export function parseNotifyWebhookUrl(raw: string): NotifyWebhookTarget {
	let parsed: URL;
	try {
		parsed = new URL(String(raw).trim());
	} catch {
		throw new Error('--notify-webhook expects an http:// or https:// URL');
	}
	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error(
			`--notify-webhook expects an http:// or https:// URL, got a ${parsed.protocol.replace(/:$/, '')} URL`
		);
	}
	// fetch() rejects a URL with user info (a TypeError, every time), so
	// `https://user:pass@host/` is turned into a Basic Authorization header.
	let authorization: string | undefined;
	if (parsed.username || parsed.password) {
		const user = decodeURIComponent(parsed.username);
		const pass = decodeURIComponent(parsed.password);
		authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
		parsed.username = '';
		parsed.password = '';
	}
	return {
		url: parsed.toString(),
		display: `${parsed.origin}${parsed.pathname}`,
		...(authorization ? { authorization } : {}),
	};
}

/** The POST body: the notification's fields, a version and a timestamp, and nothing else. */
export function buildNotifyWebhookBody(
	notification: CueExternalNotification,
	now: Date = new Date()
): NotifyWebhookBody {
	return {
		version: 1,
		type: notification.type,
		timestamp: now.toISOString(),
		agent: {
			id: notification.agent.id,
			name: notification.agent.name,
			toolType: notification.agent.toolType,
		},
		subscription: notification.subscription,
		pipeline: notification.pipeline,
		runId: notification.runId,
		title: notification.title,
		message: notification.message,
		sticky: notification.sticky,
	};
}

export interface CueNotifyWebhook {
	readonly display: string;
	/** Queue one notification. Synchronous, never throws, never waits. */
	send(notification: CueExternalNotification): void;
	/** Resolves once nothing is queued or in flight, or after `timeoutMs`. */
	flush(timeoutMs: number): Promise<void>;
}

export function createCueNotifyWebhook(options: {
	target: NotifyWebhookTarget;
	onLog: (level: string, message: string) => void;
	fetchImpl?: typeof fetchWithTimeout;
	timeoutMs?: number;
	now?: () => Date;
}): CueNotifyWebhook {
	const { target, onLog } = options;
	const fetchImpl = options.fetchImpl ?? fetchWithTimeout;
	const timeoutMs = options.timeoutMs ?? WEBHOOK_TIMEOUT_MS;
	const now = options.now ?? (() => new Date());
	const queue: NotifyWebhookBody[] = [];
	let inFlight = 0;
	let troubled = false;
	let missed = 0;
	let idleWaiters: Array<() => void> = [];

	function problem(reason: string): void {
		missed++;
		if (troubled) return;
		troubled = true;
		onLog(
			'warn',
			`Notify webhook ${target.display}: ${reason}. Further failures are counted, not logged, until a delivery succeeds.`
		);
	}

	function delivered(): void {
		if (!troubled) return;
		onLog(
			'info',
			`Notify webhook ${target.display} recovered after ${missed} failed or dropped notification(s)`
		);
		troubled = false;
		missed = 0;
	}

	function notifyIdle(): void {
		if (inFlight > 0 || queue.length > 0) return;
		const waiters = idleWaiters;
		idleWaiters = [];
		for (const resolve of waiters) resolve();
	}

	function pump(): void {
		while (inFlight < WEBHOOK_MAX_IN_FLIGHT && queue.length > 0) {
			const body = queue.shift()!;
			inFlight++;
			let request: Promise<Response>;
			try {
				request = fetchImpl(
					target.url,
					{
						method: 'POST',
						headers: {
							'Content-Type': 'application/json',
							...(target.authorization ? { Authorization: target.authorization } : {}),
						},
						body: JSON.stringify(body),
					},
					timeoutMs
				);
			} catch (err) {
				request = Promise.reject(err);
			}
			request
				.then(
					(response) => {
						if (response.ok) delivered();
						else problem(`HTTP ${response.status}`);
					},
					(err: unknown) => {
						// Name the failure kind only: a fetch error message can quote the URL.
						const name = err instanceof Error ? err.name : 'Error';
						problem(
							name === 'TimeoutError'
								? `timed out after ${timeoutMs}ms`
								: `request failed (${name})`
						);
					}
				)
				.finally(() => {
					inFlight--;
					pump();
					notifyIdle();
				});
		}
	}

	return {
		display: target.display,
		send(notification) {
			try {
				if (queue.length >= WEBHOOK_MAX_QUEUED) {
					problem(`queue full (${WEBHOOK_MAX_QUEUED}), dropping notifications`);
					return;
				}
				queue.push(buildNotifyWebhookBody(notification, now()));
				pump();
			} catch {
				// Forwarding is best effort; it must never fail the run it reports on.
			}
		},
		flush(flushTimeoutMs) {
			if (inFlight === 0 && queue.length === 0) return Promise.resolve();
			return new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, flushTimeoutMs);
				timer.unref?.();
				idleWaiters.push(() => {
					clearTimeout(timer);
					resolve();
				});
			});
		},
	};
}
