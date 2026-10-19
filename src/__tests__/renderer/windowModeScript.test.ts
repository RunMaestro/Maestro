/**
 * window-mode.js tags <html> as the Quick Chat, HUD, or tab window before the
 * first paint, so the static loading splash in index.html never shows inside them.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';

const repoFile = (rel: string) => readFileSync(path.resolve(__dirname, '../../..', rel), 'utf8');
const script = repoFile('src/renderer/public/window-mode.js');

function runWithSearch(search: string): DOMTokenList {
	window.history.replaceState(null, '', `/${search}`);
	new Function(script)();
	return document.documentElement.classList;
}

afterEach(() => {
	document.documentElement.classList.remove('quick-chat-window', 'cadenza-hud', 'tab-window');
	window.history.replaceState(null, '', '/');
});

describe('window-mode.js', () => {
	it('tags the Quick Chat window', () => {
		expect(runWithSearch('?quickChat').contains('quick-chat-window')).toBe(true);
	});

	it('tags the cadenza HUD', () => {
		expect(runWithSearch('?cadenzaHud').contains('cadenza-hud')).toBe(true);
	});

	it('tags a tab window', () => {
		expect(runWithSearch('?tabWindow=tw-1').contains('tab-window')).toBe(true);
	});

	it('does not tag a tab window that carries no id', () => {
		expect(runWithSearch('?tabWindow=').contains('tab-window')).toBe(false);
	});

	it('leaves the app window alone', () => {
		const classes = runWithSearch('');
		expect(classes.contains('quick-chat-window')).toBe(false);
		expect(classes.contains('cadenza-hud')).toBe(false);
		expect(classes.contains('tab-window')).toBe(false);
	});

	it('loads in <head> and index.html hides the splash for every reduced mode', () => {
		const html = repoFile('src/renderer/index.html').replace(/<!--[\s\S]*?-->/g, '');
		const head = html.slice(0, html.indexOf('</head>'));
		expect(head).toContain('<script src="./window-mode.js"></script>');
		expect(head).toMatch(
			/html\.quick-chat-window #initial-splash,\s*html\.cadenza-hud #initial-splash,\s*html\.tab-window #initial-splash\s*\{\s*display: none;/
		);
	});
});
