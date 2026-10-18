/**
 * Tests for XTerminal link handling: plain-text URL detection (including
 * routing-hinted URLs) and the shared activate path for plain-text and OSC 8
 * links.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../renderer/utils/openUrl', () => ({
	openUrl: vi.fn(),
}));

import { openUrl } from '../../../renderer/utils/openUrl';
import { activateTerminalLink, TERMINAL_URL_PATTERN } from '../../../renderer/components/XTerminal';

function findLinks(text: string): string[] {
	return [...text.matchAll(new RegExp(TERMINAL_URL_PATTERN.source, 'g'))].map((m) => m[0]);
}

const click = (
	overrides: Partial<{ button: number; ctrlKey: boolean; metaKey: boolean }> = {}
) => ({
	button: 0,
	ctrlKey: false,
	metaKey: false,
	...overrides,
});

beforeEach(() => {
	vi.clearAllMocks();
});

describe('TERMINAL_URL_PATTERN', () => {
	it('detects plain http(s) URLs and trims trailing punctuation', () => {
		expect(findLinks('see https://example.com/a, then http://localhost:8000.')).toEqual([
			'https://example.com/a',
			'http://localhost:8000',
		]);
	});

	it('detects routing-hinted URLs as one link, hint included', () => {
		expect(findLinks('open maestro+http://localhost:8000/x or system+https://github.com')).toEqual([
			'maestro+http://localhost:8000/x',
			'system+https://github.com',
		]);
	});
});

describe('activateTerminalLink', () => {
	it('opens a left-clicked link through openUrl', () => {
		activateTerminalLink(click(), 'https://example.com');
		expect(openUrl).toHaveBeenCalledWith('https://example.com', { ctrlKey: false });
	});

	it('treats Cmd (metaKey) as the inversion modifier, like Ctrl', () => {
		activateTerminalLink(click({ metaKey: true }), 'https://example.com');
		expect(openUrl).toHaveBeenCalledWith('https://example.com', { ctrlKey: true });
	});

	it('still treats Ctrl as the inversion modifier', () => {
		activateTerminalLink(click({ ctrlKey: true }), 'https://example.com');
		expect(openUrl).toHaveBeenCalledWith('https://example.com', { ctrlKey: true });
	});

	it('ignores non-left clicks (right-click is the context menu)', () => {
		activateTerminalLink(click({ button: 2 }), 'https://example.com');
		expect(openUrl).not.toHaveBeenCalled();
	});

	it('passes a hinted link to openUrl, which owns the routing decision', () => {
		activateTerminalLink(click(), 'maestro+http://localhost:8000/x');
		expect(openUrl).toHaveBeenCalledWith('maestro+http://localhost:8000/x', { ctrlKey: false });
	});

	it.each([
		'file:///etc/passwd',
		'ssh://host',
		'maestro+file:///tmp/x',
		'maestro+javascript:void(0)',
		'system+ssh://host',
	])('drops a non-http OSC 8 target: %s', (url) => {
		activateTerminalLink(click(), url);
		expect(openUrl).not.toHaveBeenCalled();
	});
});
