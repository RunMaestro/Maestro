/**
 * Tests for src/shared/deep-link-urls.ts
 */

import { describe, it, expect } from 'vitest';
import {
	buildSessionDeepLink,
	buildGroupDeepLink,
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
});
