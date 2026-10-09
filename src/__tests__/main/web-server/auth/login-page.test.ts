/**
 * Tests for the served login page.
 *
 * The page is rendered in the main process because the web-desktop bundle is
 * exactly what the gate protects - serving the app's JavaScript and then asking
 * it to draw a form would hand the renderer to an unauthenticated browser and
 * only then ask who it is. That makes this a plain string builder, and the one
 * thing a string builder gets wrong is escaping: `next` arrives from the query
 * string of a link somebody else can send.
 */

import { describe, it, expect } from 'vitest';
import {
	escapeHtml,
	renderLoginPage,
	safeNextPath,
} from '../../../../main/web-server/auth/login-page';
import { getThemeById } from '../../../../shared/themes';
import type { Theme } from '../../../../shared/themes';

const theme = getThemeById('dracula') as Theme;

function render(overrides: Partial<Parameters<typeof renderLoginPage>[0]> = {}): string {
	return renderLoginPage({ token: 'tok-123', theme, hasUsers: true, ...overrides });
}

describe('escapeHtml', () => {
	it('escapes every character that can break out of text or an attribute', () => {
		expect(escapeHtml('<script>')).toBe('&lt;script&gt;');
		expect(escapeHtml('a&b')).toBe('a&amp;b');
		expect(escapeHtml('"quoted"')).toBe('&quot;quoted&quot;');
		expect(escapeHtml("it's")).toBe('it&#39;s');
	});

	it('escapes the ampersand first so an entity is not double-decoded', () => {
		// `&lt;` must survive as `&amp;lt;`, not come back out as `<`.
		expect(escapeHtml('&lt;')).toBe('&amp;lt;');
	});
});

describe('safeNextPath', () => {
	it('keeps a path under this token, including the bare token', () => {
		expect(safeNextPath('tok-123', '/tok-123/session/abc?x=1')).toBe('/tok-123/session/abc?x=1');
		expect(safeNextPath('tok-123', '/tok-123')).toBe('/tok-123');
	});

	it('refuses a foreign token, a scheme, and a protocol-relative host', () => {
		expect(safeNextPath('tok-123', '/tok-1234/x')).toBeUndefined();
		expect(safeNextPath('tok-123', 'https://evil.example/')).toBeUndefined();
		expect(safeNextPath('tok-123', '//evil.example/')).toBeUndefined();
		expect(safeNextPath('tok-123', '/\\evil.example/')).toBeUndefined();
		expect(safeNextPath('tok-123', undefined)).toBeUndefined();
	});

	it('strips the control characters the URL parser would drop before judging', () => {
		// `/<TAB>/evil.example` reads as a same-origin path to a naive check and
		// as `//evil.example` to the browser, which removes tabs before parsing.
		expect(safeNextPath('tok-123', '/\t/evil.example')).toBeUndefined();
		expect(safeNextPath('tok-123', '/\n\ttok-123/x')).toBe('/tok-123/x');
	});
});

describe('renderLoginPage', () => {
	it('renders the wordmark and the two named fields', () => {
		const html = render();

		expect(html).toContain('MAESTRO');
		expect(html).toContain('name="username"');
		expect(html).toContain('name="password"');
		expect(html).toContain('autocomplete="current-password"');
		expect(html).toContain('autofocus');
	});

	it('posts to the auth endpoint under this server token', () => {
		const html = render();

		expect(html).toContain('data-home="/tok-123/"');
		expect(html).toContain('"auth/login"');
	});

	it('paints with the active theme so the wall looks like Maestro', () => {
		const html = render();

		expect(html).toContain(`--bg-main: ${theme.colors.bgMain};`);
		expect(html).toContain(`--accent: ${theme.colors.accent};`);
		expect(html).toContain(`<meta name="theme-color" content="${theme.colors.bgMain}" />`);
	});

	it('sets the phone metadata the app bundle sets', () => {
		const html = render();

		expect(html).toContain('name="viewport"');
		expect(html).toContain('viewport-fit=cover');
	});

	it('shows an error above the form when one is passed', () => {
		const html = render({ error: 'Wrong username or password.' });

		expect(html).toContain('Wrong username or password.');
	});

	it('explains where to add the first account when none exist', () => {
		// Otherwise a fresh install shows a form that can never succeed, with no
		// hint that the accounts live on the desktop.
		const html = render({ hasUsers: false });

		expect(html).toContain('No accounts exist yet.');
		expect(html).toContain('Web Login tile');
	});

	it('prefers an explicit error over the no-users copy', () => {
		// The no-users sentence also lives in the script's REASONS map (it is one
		// of the answers the API can give), so this asserts on the BANNER rather
		// than on the document.
		const banner = (html: string) => /<div class="error" id="error">(.*?)<\/div>/s.exec(html)?.[1];

		expect(banner(render({ hasUsers: false, error: 'Something else went wrong.' }))).toBe(
			'Something else went wrong.'
		);
		expect(banner(render({ hasUsers: false }))).toContain('No accounts exist yet.');
		expect(banner(render())).toBe('');
	});

	it('drops a hostile next entirely rather than interpolating it into the script', () => {
		// A value that is not a path under this token never reaches the page at
		// all; and even when one did, the attribute is escaped, since
		// JSON.stringify does NOT escape `</script>`.
		const html = render({ next: '"></script><img src=x onerror=alert(1)>' });

		expect(html).not.toContain('<img src=x onerror=alert(1)>');
		expect(html).not.toContain('</script><img');
		expect(html).toContain('data-next=""');

		const underToken = render({ next: '/tok-123/x?q="><script>' });
		expect(underToken).toContain('data-next="/tok-123/x?q=&quot;&gt;&lt;script&gt;"');
	});

	it('carries a legitimate next through as an attribute', () => {
		const html = render({ next: '/tok-123/session/abc' });

		expect(html).toContain('data-next="/tok-123/session/abc"');
	});

	it('re-checks next in the script that performs the redirect', () => {
		// The server already refused anything outside this token; the script
		// applies the same rule to the bytes the browser will actually use.
		const html = render();

		expect(html).toContain('cleaned.indexOf(HOME) === 0');
		expect(html).toContain('RAW_NEXT.replace(/[\\u0000-\\u001f\\u007f]/g');
	});

	it('names the three login failures the API can report', () => {
		const html = render();

		expect(html).toContain('Wrong username or password.');
		expect(html).toContain('This account is disabled.');
		expect(html).toContain('No accounts exist yet.');
	});

	it('is a complete document', () => {
		const html = render();

		expect(html.startsWith('<!doctype html>')).toBe(true);
		expect(html.trimEnd().endsWith('</html>')).toBe(true);
	});
});
