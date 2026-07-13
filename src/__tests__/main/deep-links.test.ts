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

vi.mock('../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

import { app } from 'electron';
import {
	flushPendingDeepLink,
	parseDeepLink,
	setupDeepLinkHandling,
	type WorkspaceDeepLinkHandlers,
} from '../../main/deep-links';
import { logger } from '../../main/utils/logger';
import { captureException } from '../../main/utils/sentry';
import type {
	SnapshotToken,
	WorkspaceLinkResolution,
	WorkspaceLocalId,
} from '../../shared/plugins/workspace-foundation';

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

	describe('opaque input safety', () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it('does not send an unrecognized opaque URL to logs or Sentry', () => {
			const opaqueUrl = 'maestro://unknown/opaque-token-value';

			expect(parseDeepLink(opaqueUrl)).toBeNull();

			for (const spy of [logger.info, logger.debug, logger.warn, logger.error, captureException]) {
				expect(spy).not.toHaveBeenCalledWith(expect.stringContaining(opaqueUrl), expect.anything());
				expect(JSON.stringify(vi.mocked(spy).mock.calls)).not.toContain(opaqueUrl);
			}
		});
	});
});

describe('workspace deep link routing', () => {
	const ownerPluginId = 'com.maestro.omp';
	const workspaceLocalId = 'omp-workspace' as WorkspaceLocalId;
	const snapshotToken = 'ABCD1234_efgh5678IJKL9012' as SnapshotToken;
	const workspaceUrl = `maestro://workspace/${ownerPluginId}/${workspaceLocalId}/session/${snapshotToken}`;
	const eventHandlers = new Map<string, (...args: unknown[]) => void>();
	const rendererSend = vi.fn();
	const mainWindow = {
		isMinimized: vi.fn(() => false),
		show: vi.fn(),
		focus: vi.fn(),
		webContents: { send: rendererSend },
	};

	const resolved = (): WorkspaceLinkResolution => ({
		kind: 'resolved',
		ownerPluginId,
		workspaceLocalId,
		externalSession: {
			externalSessionId: 'host-projection-session-1',
			title: 'OMP session',
			status: 'idle',
			unread: 0,
			pendingApproval: false,
			updatedAt: 1,
			snapshotToken,
		},
	});

	const workspaceHandlers = (
		resolveWorkspaceLink: (url: string) => WorkspaceLinkResolution | null = () => resolved(),
		selectBySnapshotToken: (token: SnapshotToken) => WorkspaceLinkResolution | null = () =>
			resolved()
	): WorkspaceDeepLinkHandlers => ({
		resolveWorkspaceLink,
		selectBySnapshotToken,
	});

	const setup = (handlers: WorkspaceDeepLinkHandlers) => {
		vi.stubEnv('ENFORCE_SINGLE_INSTANCE_IN_DEV', '1');
		expect(setupDeepLinkHandling(() => mainWindow as never, handlers)).toBe(true);
	};

	const openUrl = (url: string) => {
		const handler = eventHandlers.get('open-url');
		if (!handler) throw new Error('open-url handler was not registered');
		handler({ preventDefault: vi.fn() }, url);
	};

	beforeEach(() => {
		vi.clearAllMocks();
		eventHandlers.clear();
		vi.mocked(app.on).mockImplementation((event, listener) => {
			eventHandlers.set(event, listener as unknown as (...args: unknown[]) => void);
			return app;
		});
	});

	it('selects a valid current workspace snapshot and forwards only a safe DTO', () => {
		const resolveWorkspaceLink = vi.fn(() => resolved());
		const selectBySnapshotToken = vi.fn(() => resolved());
		setup(workspaceHandlers(resolveWorkspaceLink, selectBySnapshotToken));

		openUrl(workspaceUrl);

		expect(resolveWorkspaceLink).toHaveBeenCalledWith(workspaceUrl);
		expect(selectBySnapshotToken).toHaveBeenCalledWith(snapshotToken);
		expect(selectBySnapshotToken.mock.invocationCallOrder[0]).toBeGreaterThan(
			resolveWorkspaceLink.mock.invocationCallOrder[0]
		);
		expect(rendererSend).toHaveBeenCalledWith('app:deepLink', {
			action: 'workspace',
			ownerPluginId,
			workspaceLocalId,
			externalSessionId: 'host-projection-session-1',
		});
		expect(JSON.stringify(rendererSend.mock.calls)).not.toContain(snapshotToken);
	});

	it('rejects malformed workspace syntax without resolving or selecting a token', () => {
		const resolveWorkspaceLink = vi.fn(() => resolved());
		const selectBySnapshotToken = vi.fn(() => resolved());
		setup(workspaceHandlers(resolveWorkspaceLink, selectBySnapshotToken));

		openUrl(
			`maestro://workspace/${ownerPluginId}/${workspaceLocalId}/session/${snapshotToken}?leak`
		);

		expect(resolveWorkspaceLink).not.toHaveBeenCalled();
		expect(selectBySnapshotToken).not.toHaveBeenCalled();
		expect(rendererSend).not.toHaveBeenCalled();
	});

	it.each<WorkspaceLinkResolution['kind']>([
		'unknown_token',
		'foreign_owner',
		'expired',
		'revoked',
		'disabled_owner',
	])('handles %s without selecting or forwarding an opaque token', (kind) => {
		const opaqueUrl = `${workspaceUrl}-opaque`;
		const resolveWorkspaceLink = vi.fn(() => ({ kind }) as WorkspaceLinkResolution);
		const selectBySnapshotToken = vi.fn(() => resolved());
		setup(workspaceHandlers(resolveWorkspaceLink, selectBySnapshotToken));

		openUrl(opaqueUrl);

		expect(selectBySnapshotToken).not.toHaveBeenCalled();
		expect(rendererSend).not.toHaveBeenCalled();
		for (const spy of [logger.info, logger.debug, logger.warn, logger.error, captureException]) {
			expect(JSON.stringify(vi.mocked(spy).mock.calls)).not.toContain(opaqueUrl);
			expect(JSON.stringify(vi.mocked(spy).mock.calls)).not.toContain(snapshotToken);
		}
	});

	it('defers a cold-start workspace link until the registry resolver is ready', () => {
		const resolveWorkspaceLink = vi.fn<WorkspaceLinkResolution | null, [string]>(() => null);
		const selectBySnapshotToken = vi.fn(() => resolved());
		const handlers = workspaceHandlers(resolveWorkspaceLink, selectBySnapshotToken);
		setup(handlers);

		openUrl(workspaceUrl);
		expect(selectBySnapshotToken).not.toHaveBeenCalled();

		resolveWorkspaceLink.mockReturnValue(resolved());
		flushPendingDeepLink(() => mainWindow as never, handlers);

		expect(selectBySnapshotToken).toHaveBeenCalledWith(snapshotToken);
		expect(rendererSend).toHaveBeenCalledWith('app:deepLink', {
			action: 'workspace',
			ownerPluginId,
			workspaceLocalId,
			externalSessionId: 'host-projection-session-1',
		});
	});

	it('re-resolves repeated workspace links through the registry without raw-token telemetry', () => {
		const resolveWorkspaceLink = vi.fn(() => resolved());
		const selectBySnapshotToken = vi.fn(() => resolved());
		setup(workspaceHandlers(resolveWorkspaceLink, selectBySnapshotToken));

		openUrl(workspaceUrl);
		openUrl(workspaceUrl);

		expect(resolveWorkspaceLink).toHaveBeenCalledTimes(2);
		expect(selectBySnapshotToken).toHaveBeenCalledTimes(2);
		expect(rendererSend).toHaveBeenCalledTimes(2);
		for (const spy of [logger.info, logger.debug, logger.warn, logger.error, captureException]) {
			expect(JSON.stringify(vi.mocked(spy).mock.calls)).not.toContain(workspaceUrl);
			expect(JSON.stringify(vi.mocked(spy).mock.calls)).not.toContain(snapshotToken);
		}
	});
});
