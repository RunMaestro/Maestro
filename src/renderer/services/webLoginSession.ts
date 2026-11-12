/**
 * The signed-in Web Login account for THIS browser, and the way out of it.
 *
 * Both halves are tiny and both are awkward where they are needed: the acting
 * user arrives on `window.__MAESTRO_CONFIG__` (the server stamps it into the
 * served page, so the renderer knows who it is before the bridge is up), and
 * signing out is a POST plus a full navigation, which a menu component should
 * not be spelling out inline. Keeping them here is what makes both testable.
 *
 * The logout POST and the navigation are ONE action, not two: the cookie is
 * cleared server-side and the session is revoked, so staying on the page would
 * leave a renderer whose next bridge frame is refused with no explanation. The
 * navigation to `/<token>/login` is the explanation.
 *
 * Read through a local structural type rather than the shared
 * `MaestroWebClientConfig`: the same global is declared with a stricter shape
 * in more than one bundle, and this module only needs two fields off it.
 */

/** Who this browser is signed in as. Mirrors `WebActingUser` in shared/webLogin. */
export interface WebLoginSessionUser {
	id: string;
	username: string;
	displayName: string;
}

interface WebLoginConfigShape {
	securityToken?: string;
	webLoginUser?: WebLoginSessionUser | null;
}

function readConfig(): WebLoginConfigShape | undefined {
	if (typeof window === 'undefined') return undefined;
	return (window as { __MAESTRO_CONFIG__?: WebLoginConfigShape }).__MAESTRO_CONFIG__;
}

/**
 * The account this browser is signed in as, or `null` when Web Login is off,
 * the page predates it, or this is the Electron desktop (no injected config).
 */
export function currentWebLoginUser(): WebLoginSessionUser | null {
	const user = readConfig()?.webLoginUser;
	if (!user || typeof user.username !== 'string') return null;
	return user;
}

/**
 * Revoke this browser's session and land on the login page.
 *
 * Resolves rather than throwing when the POST fails: the navigation is what the
 * user asked for, and a network error on the way out must not strand them in a
 * session they have already decided to leave. The server drops an unknown
 * session id harmlessly, and the login page re-asks either way.
 */
export async function signOutWebLogin(): Promise<void> {
	const token = readConfig()?.securityToken;
	if (!token) return;
	try {
		await fetch(`/${token}/auth/logout`, { method: 'POST', credentials: 'same-origin' });
	} catch {
		// Best effort - fall through to the navigation below.
	}
	window.location.href = `/${token}/login`;
}
