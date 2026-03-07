/**
 * Tests for src/shared/deep-link-urls.ts
 */

import { describe, it, expect } from 'vitest';
import {
	buildSessionDeepLink,
	buildGroupDeepLink,
	buildFocusDeepLink,
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

describe('buildFocusDeepLink', () => {
	it('should build a focus deep link', () => {
		expect(buildFocusDeepLink()).toBe('maestro://focus');
	});
});
