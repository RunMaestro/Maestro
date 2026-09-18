import { describe, it, expect, beforeEach, vi } from 'vitest';

const { settings, sessions } = vi.hoisted(() => ({
	settings: new Map<string, unknown>(),
	sessions: new Map<string, { id: string; username: string; displayName: string }>(),
}));

vi.mock('../../../../main/stores/getters', () => ({
	getSettingsStore: () => ({ get: (k: string) => settings.get(k) }),
}));
vi.mock('../../../../main/web-server/auth/web-user-store', () => ({
	getWebUserStore: () => ({
		resolveSession: (sid: string | undefined) => (sid ? sessions.get(sid) : undefined),
	}),
}));

import {
	isCliRequest,
	isWebLoginEnabled,
	isWebRequestAuthorized,
	parseCookies,
	readSessionCookie,
	resolveWebRequestAuth,
} from '../../../../main/web-server/auth/web-login-policy';
import { getCliSecret } from '../../../../main/web-server/auth/cli-secret';
import { CLI_SECRET_HEADER } from '../../../../shared/webLogin';

const user = { id: 'u1', username: 'pedram', displayName: 'Pedram' };

function req(opts: { cookie?: string; ip?: string; cliSecret?: string }) {
	return {
		headers: {
			...(opts.cookie ? { cookie: opts.cookie } : {}),
			...(opts.cliSecret ? { [CLI_SECRET_HEADER]: opts.cliSecret } : {}),
		},
		ip: opts.ip ?? '192.168.1.20',
		socket: { remoteAddress: opts.ip ?? '192.168.1.20' },
	} as never;
}

beforeEach(() => {
	settings.clear();
	sessions.clear();
});

describe('parseCookies / readSessionCookie', () => {
	it('parses a header with several cookies and decodes values', () => {
		expect(parseCookies('a=1; maestro_web_session=abc%3D; b = 2')).toEqual({
			a: '1',
			maestro_web_session: 'abc=',
			b: '2',
		});
		expect(parseCookies(undefined)).toEqual({});
		expect(parseCookies('junk; =nope')).toEqual({});
	});

	it('reads the session cookie by name', () => {
		expect(readSessionCookie(req({ cookie: 'x=1; maestro_web_session=sid' }))).toBe('sid');
		expect(readSessionCookie(req({}))).toBeUndefined();
	});
});

describe('isCliRequest', () => {
	it("admits only this boot's secret, wherever the request came from", () => {
		expect(isCliRequest(req({ cliSecret: getCliSecret() }))).toBe(true);
		expect(isCliRequest(req({ cliSecret: getCliSecret(), ip: '10.0.0.5' }))).toBe(true);
		expect(isCliRequest(req({ cliSecret: 'not-it' }))).toBe(false);
		expect(isCliRequest(req({ ip: '127.0.0.1' }))).toBe(false);
	});
});

describe('isWebLoginEnabled', () => {
	it('reads the Encore flag, defaulting off', () => {
		expect(isWebLoginEnabled()).toBe(false);
		settings.set('encoreFeatures', { webLogin: true });
		expect(isWebLoginEnabled()).toBe(true);
	});
});

describe('resolveWebRequestAuth / isWebRequestAuthorized', () => {
	it('authorizes everything when the flag is off, but still names a signed-in user', () => {
		sessions.set('sid', user);
		const auth = resolveWebRequestAuth(req({ cookie: 'maestro_web_session=sid' }));
		expect(auth).toEqual({ required: false, user, sessionId: 'sid', cli: false });
		expect(isWebRequestAuthorized(auth)).toBe(true);
		expect(isWebRequestAuthorized(resolveWebRequestAuth(req({})))).toBe(true);
	});

	it('requires a valid session when the flag is on', () => {
		settings.set('encoreFeatures', { webLogin: true });
		expect(isWebRequestAuthorized(resolveWebRequestAuth(req({})))).toBe(false);
		expect(
			isWebRequestAuthorized(resolveWebRequestAuth(req({ cookie: 'maestro_web_session=bogus' })))
		).toBe(false);
		sessions.set('sid', user);
		const auth = resolveWebRequestAuth(req({ cookie: 'maestro_web_session=sid' }));
		expect(auth.user).toEqual(user);
		expect(auth.sessionId).toBe('sid');
		expect(isWebRequestAuthorized(auth)).toBe(true);
	});

	it('reports no sessionId for a cookie that resolves to nobody', () => {
		settings.set('encoreFeatures', { webLogin: true });
		const auth = resolveWebRequestAuth(req({ cookie: 'maestro_web_session=stale' }));
		expect(auth.user).toBeUndefined();
		expect(auth.sessionId).toBeUndefined();
	});

	it('never gates maestro-cli presenting the boot secret', () => {
		settings.set('encoreFeatures', { webLogin: true });
		const auth = resolveWebRequestAuth(req({ cliSecret: getCliSecret() }));
		expect(auth.cli).toBe(true);
		expect(auth.user).toBeUndefined();
		expect(isWebRequestAuthorized(auth)).toBe(true);
	});

	it('gates a bare loopback request: the tunnel and any local proxy arrive that way too', () => {
		settings.set('encoreFeatures', { webLogin: true });
		const auth = resolveWebRequestAuth(req({ ip: '127.0.0.1' }));
		expect(auth.cli).toBe(false);
		expect(isWebRequestAuthorized(auth)).toBe(false);
	});
});
