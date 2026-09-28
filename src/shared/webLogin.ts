/**
 * Web Login - the wire shapes and rules shared by main (the users store, the
 * login routes, the bridge), the renderer (the Users management body under the
 * Web Login Encore tile, the sign-out entry on web-desktop) and the served
 * login page.
 *
 * Login is an OPTIONAL gate on the web interface. With the `webLogin` Encore
 * flag off nothing here is consulted and the interface is reached exactly as
 * before: possession of the URL token is the whole credential. With it on, a
 * browser must also hold a session cookie issued by `POST /<token>/auth/login`
 * for one of the accounts managed here, and every turn that browser sends is
 * attributed to that account (History pill + filter, `query_events.user_name`).
 *
 * Every account is an equal OPERATOR - there are no roles. The desktop is the
 * administrator: the `webLogin:*` IPC channels that create, delete and reset
 * accounts are refused over the bridge (`BRIDGE_DENIED_CHANNELS`), so a
 * logged-in browser can never mint or remove another account.
 */

/** Public shape of an account - never carries the password hash. */
export interface WebUserPublic {
	id: string;
	username: string;
	displayName: string;
	createdAt: number;
	lastLoginAt?: number;
	/** A disabled account keeps its history attribution but cannot log in. */
	disabled?: boolean;
}

/** Who a bridge call or a spawned turn is acting as. */
export interface WebActingUser {
	id: string;
	username: string;
	displayName: string;
}

/** Name of the session cookie. Scoped to `/<token>` by the login route. */
export const WEB_LOGIN_COOKIE = 'maestro_web_session';

/** Path segments under `/<token>/`. */
export const WEB_LOGIN_PATHS = {
	/** The served login page (GET). */
	page: 'login',
	/** JSON API: `{ username, password }` -> sets the cookie. */
	login: 'auth/login',
	/** JSON API: clears the cookie and revokes the session. */
	logout: 'auth/logout',
	/** JSON API: `{ required, user }` for the calling browser. */
	me: 'auth/me',
} as const;

/** WebSocket close code sent to a client whose session is missing or revoked. */
export const WEB_LOGIN_WS_CLOSE_CODE = 4401;

/**
 * Request header `maestro-cli` sends on its WebSocket upgrade, carrying the
 * per-boot secret from `cli-server.json`. The gate admits it in place of a
 * session cookie. A browser cannot set a custom header on an upgrade, and a
 * remote caller cannot read the file, so this is what keeps the CLI working
 * without waving through everything else that arrives over loopback (the
 * Cloudflare tunnel does).
 */
export const CLI_SECRET_HEADER = 'x-maestro-cli-secret';

/** Environment variable stamped on every agent process a logged-in browser starts. */
export const QUERY_USER_ENV_VAR = 'MAESTRO_QUERY_USER';

export const WEB_LOGIN_USERNAME_MIN = 2;
export const WEB_LOGIN_USERNAME_MAX = 32;
export const WEB_LOGIN_PASSWORD_MIN = 8;
export const WEB_LOGIN_PASSWORD_MAX = 256;
export const WEB_LOGIN_DISPLAY_NAME_MAX = 64;

/** Lowercase letters, digits, dot, dash, underscore. Case-insensitive on lookup. */
const USERNAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

export function normalizeWebUsername(raw: string): string {
	return raw.trim().toLowerCase();
}

/** `null` when valid, otherwise the reason to show the user. */
export function validateWebUsername(raw: string): string | null {
	const username = normalizeWebUsername(raw);
	if (username.length < WEB_LOGIN_USERNAME_MIN) {
		return `Username must be at least ${WEB_LOGIN_USERNAME_MIN} characters.`;
	}
	if (username.length > WEB_LOGIN_USERNAME_MAX) {
		return `Username must be at most ${WEB_LOGIN_USERNAME_MAX} characters.`;
	}
	if (!USERNAME_PATTERN.test(username)) {
		return 'Username may contain letters, digits, dots, dashes and underscores, and must start with a letter or digit.';
	}
	return null;
}

/** `null` when valid, otherwise the reason to show the user. */
export function validateWebPassword(password: string): string | null {
	if (typeof password !== 'string' || password.length < WEB_LOGIN_PASSWORD_MIN) {
		return `Password must be at least ${WEB_LOGIN_PASSWORD_MIN} characters.`;
	}
	if (password.length > WEB_LOGIN_PASSWORD_MAX) {
		return `Password must be at most ${WEB_LOGIN_PASSWORD_MAX} characters.`;
	}
	return null;
}

/** Display name falls back to the username; trimmed and capped. */
export function normalizeWebDisplayName(raw: string | undefined, username: string): string {
	const trimmed = (raw ?? '').trim();
	if (trimmed.length === 0) return username;
	return trimmed.slice(0, WEB_LOGIN_DISPLAY_NAME_MAX);
}
