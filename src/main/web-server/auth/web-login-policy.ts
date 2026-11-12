/**
 * Web Login policy - is a login required, and who is this request?
 *
 * Every enforcement point (the served index, the REST routes, the media and
 * image routes, the WebSocket upgrade) asks these two questions and nothing
 * else, so they cannot drift on what "logged in" means.
 */

import type { FastifyRequest } from 'fastify';
import { resolveEncoreFeatures } from '../../../shared/encoreFeatureDefaults';
import { CLI_SECRET_HEADER, WEB_LOGIN_COOKIE, type WebActingUser } from '../../../shared/webLogin';
import { getSettingsStore } from '../../stores/getters';
import { isCliSecret } from './cli-secret';
import { getWebUserStore } from './web-user-store';

/** The `webLogin` Encore flag, read live so a toggle takes effect on the next request. */
export function isWebLoginEnabled(): boolean {
	try {
		return resolveEncoreFeatures(getSettingsStore().get('encoreFeatures')).webLogin === true;
	} catch {
		// Stores not initialized (tests, very early boot): no gate.
		return false;
	}
}

/** Minimal cookie header parse - the request carries at most a handful of cookies. */
export function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(';')) {
		const eq = part.indexOf('=');
		if (eq <= 0) continue;
		const name = part.slice(0, eq).trim();
		const value = part.slice(eq + 1).trim();
		if (!name) continue;
		try {
			out[name] = decodeURIComponent(value);
		} catch {
			out[name] = value;
		}
	}
	return out;
}

export function readSessionCookie(request: Pick<FastifyRequest, 'headers'>): string | undefined {
	const header = request.headers.cookie;
	return parseCookies(Array.isArray(header) ? header.join('; ') : header)[WEB_LOGIN_COOKIE];
}

/**
 * `maestro-cli` is admitted by the per-boot secret it reads from
 * `cli-server.json` and presents as a header, never by its peer address: the
 * Cloudflare tunnel and any local reverse proxy hand every remote request to
 * this server over a loopback connection, so "is it 127.0.0.1?" would admit
 * exactly the callers the gate exists to stop. See `cli-secret.ts`.
 */
export function isCliRequest(request: Pick<FastifyRequest, 'headers'>): boolean {
	return isCliSecret(request.headers[CLI_SECRET_HEADER]);
}

export interface WebRequestAuth {
	/** The `webLogin` Encore flag at the time of the request. */
	required: boolean;
	/** The account behind a valid session cookie, whether or not one is required. */
	user: WebActingUser | undefined;
	/** The session cookie value `user` was resolved from; what revocation is keyed on. */
	sessionId: string | undefined;
	/** `maestro-cli` presenting this boot's secret. Never gated, never signed in. */
	cli: boolean;
}

/**
 * One answer per request. `user` is set whenever a valid session cookie is
 * present, even when login is not required, so attribution keeps working for
 * a browser that signed in before the gate was switched off. A request is
 * AUTHORIZED when `!required || cli || user`.
 */
export function resolveWebRequestAuth(request: Pick<FastifyRequest, 'headers'>): WebRequestAuth {
	const sessionId = readSessionCookie(request);
	const user = getWebUserStore().resolveSession(sessionId);
	return {
		required: isWebLoginEnabled(),
		user,
		sessionId: user ? sessionId : undefined,
		cli: isCliRequest(request),
	};
}

export function isWebRequestAuthorized(auth: WebRequestAuth): boolean {
	return !auth.required || auth.cli || auth.user !== undefined;
}
