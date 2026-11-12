/**
 * The served login page.
 *
 * Rendered in the main process rather than shipped inside the web-desktop
 * bundle, for one reason: the bundle is what the gate protects. Serving the
 * app's JavaScript and then asking it to draw a form would hand the whole
 * renderer to an unauthenticated browser and only then ask who it is.
 *
 * It is a single self-contained document with no build step and no imports at
 * runtime - the only assets it references are the PWA icons, which the hook in
 * `web-login-hook.ts` deliberately leaves reachable. Its colors come from the
 * user's active theme so the wall in front of Maestro looks like Maestro.
 */

import type { Theme } from '../../../shared/themes';
import { WEB_LOGIN_PATHS } from '../../../shared/webLogin';

/**
 * HTML-escape a value for interpolation into text or a double-quoted
 * attribute. The `next` parameter is the one that matters: it arrives from the
 * query string, so without this a crafted link would put script into the page
 * the user is about to type their password into.
 */
export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

/**
 * The subset of the theme this page paints with, as CSS custom properties.
 *
 * Deliberately NOT `generateCSSString()` from `src/web/utils`: that module is
 * part of the browser bundle and reaches for `document` in its sibling
 * exports, so it cannot be type-checked under the main process's DOM-free lib.
 * Eight declarations are not worth coupling main to the web tree for.
 */
function themeVariables(theme: Theme): string {
	const c = theme.colors;
	const vars: Array<[string, string]> = [
		['--bg-main', c.bgMain],
		['--bg-sidebar', c.bgSidebar],
		['--border', c.border],
		['--text-main', c.textMain],
		['--text-dim', c.textDim],
		['--accent', c.accent],
		['--accent-foreground', c.accentForeground],
		['--error', c.error],
	];
	return vars.map(([name, value]) => `\t\t\t\t${name}: ${escapeHtml(String(value))};`).join('\n');
}

export interface LoginPageOptions {
	/** The server's security token - every form action is relative to `/<token>/`. */
	token: string;
	/** The user's active theme. */
	theme: Theme;
	/** False when nobody has added an account yet, which needs its own copy. */
	hasUsers: boolean;
	/** A failure to show above the form (already plain text, escaped here). */
	error?: string;
	/** Where to land after a successful login. Defaults to `/<token>/`. */
	next?: string;
}

/**
 * The only `next` a login may land on: an absolute path under THIS token.
 *
 * Checked on the server before the value reaches the page, and again in the
 * page script, because the two see different bytes. The WHATWG URL parser
 * strips ASCII tab and newline before parsing, so `/<TAB>/evil.example` reads
 * as a same-origin path to a character-by-character check and as the
 * scheme-relative `//evil.example` to the browser. Control characters are
 * removed first, then the value must start with `/<token>/` (or be exactly
 * `/<token>`). Anything else falls back to home.
 */
export function safeNextPath(token: string, raw: string | undefined): string | undefined {
	if (typeof raw !== 'string') return undefined;
	const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, '');
	if (cleaned === `/${token}` || cleaned.startsWith(`/${token}/`)) return cleaned;
	return undefined;
}

/** The complete login document. */
export function renderLoginPage(opts: LoginPageOptions): string {
	const token = escapeHtml(opts.token);
	const home = `/${token}/`;
	// `next` is attacker-supplied, so it is carried as an escaped ATTRIBUTE and
	// read back from the DOM rather than interpolated into the inline script.
	// `JSON.stringify` does not escape `</script>`, so a crafted link would
	// otherwise close the script element and run its own. The script then
	// additionally refuses anything that is not a same-origin absolute path, so
	// a `//evil.example` or `javascript:` value cannot become a destination.
	const next = escapeHtml(safeNextPath(opts.token, opts.next) ?? '');
	const initialError = opts.hasUsers
		? (opts.error ?? '')
		: (opts.error ??
			"No accounts exist yet. Add one on the Web Login tile in Maestro's Settings, under Extensions.");

	return `<!doctype html>
<html lang="en">
	<head>
		<meta charset="UTF-8" />
		<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
		<meta name="theme-color" content="${escapeHtml(String(opts.theme.colors.bgMain))}" />
		<meta name="apple-mobile-web-app-capable" content="yes" />
		<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
		<meta name="mobile-web-app-capable" content="yes" />
		<meta name="robots" content="noindex, nofollow" />
		<link rel="icon" href="${home}icons/icon-192x192.png" />
		<link rel="apple-touch-icon" href="${home}icons/icon-192x192.png" />
		<title>Maestro</title>
		<style>
			:root {
${themeVariables(opts.theme)}
			}
			* {
				box-sizing: border-box;
			}
			html,
			body {
				margin: 0;
				padding: 0;
				min-height: 100%;
				background: var(--bg-main);
				color: var(--text-main);
				font-family: 'JetBrains Mono', 'Fira Code', ui-monospace, 'SF Mono', SFMono-Regular,
					Menlo, Monaco, 'Courier New', monospace;
				-webkit-font-smoothing: antialiased;
			}
			.wrap {
				min-height: 100dvh;
				display: flex;
				flex-direction: column;
				align-items: center;
				justify-content: center;
				gap: 28px;
				padding: 24px;
				padding-top: max(24px, env(safe-area-inset-top));
			}
			/* Matches the pre-React splash in src/web-desktop/index.html: the brand
			   mark never follows a reading-font setting. */
			.wordmark {
				font-family: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
				font-weight: 700;
				font-size: 22px;
				letter-spacing: 0.35em;
				padding-left: 0.35em;
				color: var(--text-main);
			}
			.card {
				width: 100%;
				max-width: 360px;
				background: var(--bg-sidebar);
				border: 1px solid var(--border);
				border-radius: 12px;
				padding: 24px;
				display: flex;
				flex-direction: column;
				gap: 14px;
			}
			label {
				display: block;
				font-size: 11px;
				text-transform: uppercase;
				letter-spacing: 0.08em;
				color: var(--text-dim);
				margin-bottom: 6px;
			}
			input {
				width: 100%;
				padding: 10px 12px;
				font: inherit;
				font-size: 14px;
				color: var(--text-main);
				background: var(--bg-main);
				border: 1px solid var(--border);
				border-radius: 8px;
			}
			input:focus {
				outline: none;
				border-color: var(--accent);
			}
			button {
				width: 100%;
				padding: 11px 12px;
				font: inherit;
				font-size: 14px;
				font-weight: 700;
				color: var(--accent-foreground);
				background: var(--accent);
				border: none;
				border-radius: 8px;
				cursor: pointer;
			}
			button[disabled] {
				opacity: 0.6;
				cursor: default;
			}
			.error {
				font-size: 12px;
				line-height: 1.5;
				color: var(--error);
				border: 1px solid var(--error);
				border-radius: 8px;
				padding: 10px 12px;
			}
			.error:empty {
				display: none;
			}
		</style>
	</head>
	<body>
		<div class="wrap">
			<div class="wordmark">MAESTRO</div>
			<form class="card" id="form" autocomplete="on" data-home="${home}" data-next="${next}">
				<div class="error" id="error">${escapeHtml(initialError)}</div>
				<div>
					<label for="username">Username</label>
					<input id="username" name="username" type="text" autocomplete="username"
						autocapitalize="none" autocorrect="off" spellcheck="false" autofocus />
				</div>
				<div>
					<label for="password">Password</label>
					<input id="password" name="password" type="password" autocomplete="current-password" />
				</div>
				<button type="submit" id="submit">Sign in</button>
			</form>
		</div>
		<script>
			(function () {
				var form = document.getElementById('form');
				var HOME = form.getAttribute('data-home') || '/';
				var LOGIN = HOME + ${JSON.stringify(WEB_LOGIN_PATHS.login)};
				var RAW_NEXT = form.getAttribute('data-next') || '';
				var REASONS = {
					invalid: 'Wrong username or password.',
					disabled: 'This account is disabled.',
					'no-users':
						"No accounts exist yet. Add one on the Web Login tile in Maestro's Settings, under Extensions."
				};
				// Only a same-origin absolute path is an acceptable destination. A
				// protocol-relative "//host" or a "javascript:" value would otherwise
				// turn the login form into an open redirect.
				function safeNext() {
					// Same rule as safeNextPath on the server: strip the control
					// characters the URL parser would drop, then require a path
					// under this token. A "//host" or "javascript:" value never
					// survives it.
					var cleaned = RAW_NEXT.replace(/[\\u0000-\\u001f\\u007f]/g, '');
					if (cleaned === HOME.slice(0, -1) || cleaned.indexOf(HOME) === 0) return cleaned;
					return HOME;
				}
				var errorEl = document.getElementById('error');
				var submit = document.getElementById('submit');
				form.addEventListener('submit', function (ev) {
					ev.preventDefault();
					errorEl.textContent = '';
					submit.disabled = true;
					fetch(LOGIN, {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						credentials: 'same-origin',
						body: JSON.stringify({
							username: document.getElementById('username').value,
							password: document.getElementById('password').value
						})
					})
						.then(function (res) {
							return res.json().catch(function () {
								return { ok: false };
							});
						})
						.then(function (body) {
							if (body && body.ok) {
								window.location.href = safeNext();
								return;
							}
							submit.disabled = false;
							errorEl.textContent =
								(body && REASONS[body.reason]) || 'Could not sign in. Please try again.';
						})
						.catch(function () {
							submit.disabled = false;
							errorEl.textContent = 'Could not reach Maestro. Check the connection and retry.';
						});
				});
			})();
		</script>
	</body>
</html>
`;
}
