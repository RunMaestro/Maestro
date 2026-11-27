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

const { firePromptLink } = vi.hoisted(() => ({
	firePromptLink: vi.fn().mockResolvedValue({ ok: true }),
}));
vi.mock('../../main/prompt-links', () => ({ firePromptLink }));

import { app } from 'electron';
import { logger } from '../../main/utils/logger';
import { parseDeepLink, setupDeepLinkHandling } from '../../main/deep-links';

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

describe('run action (Prompt Links)', () => {
	it('parses a run URL', () => {
		expect(parseDeepLink('maestro://run/tok123')).toEqual({ action: 'run', token: 'tok123' });
	});

	it('hands the token to the Prompt Links service and never to the renderer', () => {
		const send = vi.fn();
		const win = {
			isMinimized: vi.fn(() => false),
			restore: vi.fn(),
			show: vi.fn(),
			focus: vi.fn(),
			webContents: { send },
		};
		process.env.ENFORCE_SINGLE_INSTANCE_IN_DEV = '1';
		vi.mocked(app.on).mockClear();
		try {
			setupDeepLinkHandling(() => win as never);
		} finally {
			delete process.env.ENFORCE_SINGLE_INSTANCE_IN_DEV;
		}
		const openUrl = vi.mocked(app.on).mock.calls.find(([event]) => event === 'open-url')?.[1] as
			| ((event: { preventDefault: () => void }, url: string) => void)
			| undefined;
		expect(openUrl).toBeDefined();

		openUrl?.({ preventDefault: vi.fn() }, 'maestro://run/secret-token-value');

		expect(firePromptLink).toHaveBeenCalledWith('secret-token-value', expect.any(Function));
		// The link's own `open` setting decides focus; the handler must not raise
		// the window or forward the payload.
		expect(win.show).not.toHaveBeenCalled();
		expect(send).not.toHaveBeenCalled();
		// The token never reaches the log in full.
		const logged = JSON.stringify(vi.mocked(logger.info).mock.calls);
		expect(logged).not.toContain('secret-token-value');
		expect(logged).toContain('maestro://run/secr...');
	});
});
