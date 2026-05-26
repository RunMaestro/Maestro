/**
 * Tests for src/shared/deep-link-urls.ts
 */

import { describe, it, expect } from 'vitest';
import {
	buildSessionDeepLink,
	buildGroupDeepLink,
	buildFileDeepLink,
	parseMaestroDeepLink,
} from '../../shared/deep-link-urls';

describe('buildSessionDeepLink', () => {
	it('should build a session-only deep link', () => {
		expect(buildSessionDeepLink('abc123')).toBe('maestro://session/abc123');
	});

	it('should build a session + tab deep link', () => {
		expect(buildSessionDeepLink('abc123', 'tab456')).toBe('maestro://session/abc123/tab/tab456');
	});

	it('should URI-encode session IDs with special characters', () => {
		expect(buildSessionDeepLink('id/with/slashes')).toBe(
			`maestro://session/${encodeURIComponent('id/with/slashes')}`
		);
	});

	it('should URI-encode tab IDs with special characters', () => {
		expect(buildSessionDeepLink('sess', 'tab?special')).toBe(
			`maestro://session/sess/tab/${encodeURIComponent('tab?special')}`
		);
	});

	it('should not include tab segment when tabId is undefined', () => {
		expect(buildSessionDeepLink('abc123', undefined)).toBe('maestro://session/abc123');
	});
});

describe('buildGroupDeepLink', () => {
	it('should build a group deep link', () => {
		expect(buildGroupDeepLink('grp789')).toBe('maestro://group/grp789');
	});

	it('should URI-encode group IDs with special characters', () => {
		expect(buildGroupDeepLink('group/name')).toBe(
			`maestro://group/${encodeURIComponent('group/name')}`
		);
	});
});

describe('parseMaestroDeepLink', () => {
	it('parses focus URLs', () => {
		expect(parseMaestroDeepLink('maestro://focus')).toEqual({ action: 'focus' });
		expect(parseMaestroDeepLink('maestro://')).toEqual({ action: 'focus' });
		expect(parseMaestroDeepLink('maestro:')).toEqual({ action: 'focus' });
	});

	it('parses session URLs with and without tabs', () => {
		expect(parseMaestroDeepLink('maestro://session/abc123')).toEqual({
			action: 'session',
			sessionId: 'abc123',
		});
		expect(parseMaestroDeepLink('maestro://session/abc123/tab/tab456')).toEqual({
			action: 'session',
			sessionId: 'abc123',
			tabId: 'tab456',
		});
	});

	it('decodes URI-encoded IDs', () => {
		expect(parseMaestroDeepLink('maestro://session/session%20with%20space')).toEqual({
			action: 'session',
			sessionId: 'session with space',
		});
		expect(parseMaestroDeepLink('maestro://group/group%20name')).toEqual({
			action: 'group',
			groupId: 'group name',
		});
	});

	it('parses Windows-style URLs without double slash', () => {
		expect(parseMaestroDeepLink('maestro:session/abc123')).toEqual({
			action: 'session',
			sessionId: 'abc123',
		});
	});

	it('returns null for unrecognized resources and malformed inputs', () => {
		expect(parseMaestroDeepLink('maestro://unknown/abc')).toBeNull();
		expect(parseMaestroDeepLink('maestro://session')).toBeNull();
		expect(parseMaestroDeepLink('maestro://session/')).toBeNull();
		expect(parseMaestroDeepLink('maestro://group')).toBeNull();
	});

	it('parses file URLs with and without line fragments', () => {
		const path = '/Users/me/proj/notes.md';
		expect(parseMaestroDeepLink(buildFileDeepLink('sess1', path))).toEqual({
			action: 'file',
			sessionId: 'sess1',
			filePath: path,
		});
		expect(parseMaestroDeepLink(buildFileDeepLink('sess1', path, 42))).toEqual({
			action: 'file',
			sessionId: 'sess1',
			filePath: path,
			line: 42,
		});
	});

	it('ignores malformed line fragments on file URLs', () => {
		const url = `${buildFileDeepLink('sess1', '/x/y.md')}#L0`;
		expect(parseMaestroDeepLink(url)).toEqual({
			action: 'file',
			sessionId: 'sess1',
			filePath: '/x/y.md',
		});
		const url2 = `${buildFileDeepLink('sess1', '/x/y.md')}#Lfoo`;
		expect(parseMaestroDeepLink(url2)).toEqual({
			action: 'file',
			sessionId: 'sess1',
			filePath: '/x/y.md',
		});
	});

	it('round-trips file paths with spaces and special characters', () => {
		const path = '/Users/me/My Notes/2026 plan & ideas.md';
		const url = buildFileDeepLink('s', path, 7);
		expect(parseMaestroDeepLink(url)).toEqual({
			action: 'file',
			sessionId: 's',
			filePath: path,
			line: 7,
		});
	});
});

describe('buildFileDeepLink', () => {
	it('encodes the file path so slashes do not break path-segment parsing', () => {
		const url = buildFileDeepLink('sess', '/a/b.md');
		expect(url).toBe(`maestro://file/sess/${encodeURIComponent('/a/b.md')}`);
	});

	it('omits the line fragment when line is undefined or non-positive', () => {
		expect(buildFileDeepLink('s', '/x.md')).not.toMatch(/#/);
		expect(buildFileDeepLink('s', '/x.md', 0)).not.toMatch(/#/);
		expect(buildFileDeepLink('s', '/x.md', -1)).not.toMatch(/#/);
	});

	it('emits #L<n> when line is a positive integer', () => {
		expect(buildFileDeepLink('s', '/x.md', 3)).toMatch(/#L3$/);
	});
});
