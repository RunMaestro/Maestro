/**
 * Tests for deep link URL parsing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron before importing the module under test
vi.mock('electron', () => ({
	app: {
		isPackaged: false,
		setAsDefaultProtocolClient: vi.fn(),
		requestSingleInstanceLock: vi.fn().mockReturnValue(true),
		on: vi.fn(),
		quit: vi.fn(),
	},
	BrowserWindow: {
		getAllWindows: vi.fn().mockReturnValue([]),
	},
}));

vi.mock('../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

vi.mock('../../main/utils/safe-send', () => ({
	isWebContentsAvailable: vi.fn().mockReturnValue(true),
}));

import { parseDeepLink } from '../../main/deep-links';

describe('parseDeepLink', () => {
	describe('focus action', () => {
		it('should parse maestro://focus', () => {
			expect(parseDeepLink('maestro://focus')).toEqual({ action: 'focus' });
		});

		it('should parse empty path as focus', () => {
			expect(parseDeepLink('maestro://')).toEqual({ action: 'focus' });
		});

		it('should parse protocol-only as focus', () => {
			expect(parseDeepLink('maestro:')).toEqual({ action: 'focus' });
		});
	});

	describe('session action', () => {
		it('should parse session URL', () => {
			expect(parseDeepLink('maestro://session/abc123')).toEqual({
				action: 'session',
				sessionId: 'abc123',
			});
		});

		it('should parse session URL with tab', () => {
			expect(parseDeepLink('maestro://session/abc123/tab/tab456')).toEqual({
				action: 'session',
				sessionId: 'abc123',
				tabId: 'tab456',
			});
		});

		it('should decode URI-encoded session IDs', () => {
			expect(parseDeepLink('maestro://session/session%20with%20space')).toEqual({
				action: 'session',
				sessionId: 'session with space',
			});
		});

		it('should decode URI-encoded tab IDs', () => {
			expect(parseDeepLink('maestro://session/abc/tab/tab%2Fslash')).toEqual({
				action: 'session',
				sessionId: 'abc',
				tabId: 'tab/slash',
			});
		});

		it('should return null for session without ID', () => {
			expect(parseDeepLink('maestro://session')).toBeNull();
			expect(parseDeepLink('maestro://session/')).toBeNull();
		});

		it('should ignore extra path segments after tab ID', () => {
			const result = parseDeepLink('maestro://session/abc/tab/tab1/extra/stuff');
			expect(result).toEqual({
				action: 'session',
				sessionId: 'abc',
				tabId: 'tab1',
			});
		});
	});

	describe('group action', () => {
		it('should parse group URL', () => {
			expect(parseDeepLink('maestro://group/grp789')).toEqual({
				action: 'group',
				groupId: 'grp789',
			});
		});

		it('should decode URI-encoded group IDs', () => {
			expect(parseDeepLink('maestro://group/group%20name')).toEqual({
				action: 'group',
				groupId: 'group name',
			});
		});

		it('should return null for group without ID', () => {
			expect(parseDeepLink('maestro://group')).toBeNull();
			expect(parseDeepLink('maestro://group/')).toBeNull();
		});
	});

	describe('Windows compatibility', () => {
		it('should handle Windows maestro: prefix (no double slash)', () => {
			expect(parseDeepLink('maestro:session/abc123')).toEqual({
				action: 'session',
				sessionId: 'abc123',
			});
		});

		it('should handle Windows focus without double slash', () => {
			expect(parseDeepLink('maestro:focus')).toEqual({ action: 'focus' });
		});
	});

	describe('error handling', () => {
		it('should return null for unrecognized resource', () => {
			expect(parseDeepLink('maestro://unknown/abc')).toBeNull();
		});

		it('should return null for completely malformed URLs', () => {
			// parseDeepLink is tolerant of most inputs, but unrecognized resources return null
			expect(parseDeepLink('maestro://settings')).toBeNull();
		});
	});
});
