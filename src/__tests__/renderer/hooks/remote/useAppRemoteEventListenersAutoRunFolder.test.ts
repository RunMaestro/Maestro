/**
 * Covers the CLI/web `set Auto Run folder` bridge in useAppRemoteEventListeners.
 *
 * The caller names the folder. When it is missing, not a folder, or unreadable,
 * the error goes back to the caller and is not a Maestro fault, so it must not
 * reach Sentry (MAESTRO-15D). A failure with no such explanation still reports.
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	useAppRemoteEventListeners,
	isUnreadableFolderError,
} from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { createMockSession } from '../../../helpers/mockSession';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import { captureMessage } from '../../../../renderer/utils/sentry';

vi.mock('../../../../renderer/stores/sessionStore', () => ({
	useSessionStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
	selectSessionById: vi.fn(),
}));
vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
}));
vi.mock('../../../../renderer/hooks/batch/batchUtils', () => ({ DEFAULT_BATCH_PROMPT: '' }));
vi.mock('../../../../renderer/services/git', () => ({ gitService: {} }));
vi.mock('../../../../renderer/utils/worktreeSpawn', () => ({
	spawnWorktreeAgentAndDispatch: vi.fn(),
}));
vi.mock('../../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
vi.mock('../../../../renderer/utils/browserTabPersistence', () => ({
	getBrowserTabPartition: () => 'persist:test',
}));
vi.mock('../../../../renderer/utils/ids', () => ({ generateId: () => 'new-tab-id' }));
vi.mock('../../../../renderer/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

const FOLDER = '/Users/someone/missing/playbooks';

let listDocs: ReturnType<typeof vi.fn>;
let sendResponse: ReturnType<typeof vi.fn>;
let originalMaestro: unknown;

function setup() {
	vi.mocked(useSessionStore.getState).mockReturnValue({ activeSessionId: 'agent-1' } as never);
	const setSessions = vi.fn();
	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef: { current: [createMockSession({ id: 'agent-1' })] },
			setActiveSessionId: vi.fn(),
			setSessions,
			setGroups: vi.fn(),
			handleOpenFileTab: vi.fn(),
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh: vi.fn(),
			startBatchRun: vi.fn(),
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		} as never)
	);
	return { setSessions };
}

async function dispatchSetFolder() {
	window.dispatchEvent(
		new CustomEvent('maestro:setAutoRunFolder', {
			detail: { sessionId: 'agent-1', folderPath: FOLDER, responseChannel: 'resp-1' },
		})
	);
	await vi.waitFor(() => expect(sendResponse).toHaveBeenCalled());
}

describe('remote set Auto Run folder failure reporting', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		listDocs = vi.fn();
		sendResponse = vi.fn();
		originalMaestro = (window as unknown as { maestro: unknown }).maestro;
		const base = (originalMaestro ?? {}) as Record<string, unknown>;
		(window as unknown as { maestro: unknown }).maestro = {
			...base,
			autorun: { ...(base.autorun as object), listDocs },
			process: {
				...(base.process as object),
				sendRemoteSetAutoRunFolderResponse: sendResponse,
			},
		};
	});

	afterEach(() => {
		(window as unknown as { maestro: unknown }).maestro = originalMaestro;
	});

	it('does not report a folder that does not exist, and tells the caller why', async () => {
		const error = `Error: ENOENT: no such file or directory, stat '${FOLDER}'`;
		listDocs.mockResolvedValue({ success: false, error });
		const { setSessions } = setup();

		await dispatchSetFolder();

		expect(captureMessage).not.toHaveBeenCalled();
		expect(sendResponse).toHaveBeenCalledWith('resp-1', { success: false, error });
		expect(setSessions).not.toHaveBeenCalled();
	});

	it('still reports a failure it cannot explain', async () => {
		listDocs.mockResolvedValue({
			success: false,
			error: "TypeError: Cannot read properties of undefined (reading 'name')",
		});
		setup();

		await dispatchSetFolder();

		expect(captureMessage).toHaveBeenCalledWith(
			'AutoRun listDocs returned failure',
			expect.objectContaining({ level: 'error' })
		);
	});
});

describe('isUnreadableFolderError', () => {
	it.each([
		"Error: ENOENT: no such file or directory, stat '/x'",
		"Error: ENOTDIR: not a directory, scandir '/x/file.md'",
		"Error: EACCES: permission denied, scandir '/x'",
		"Error: EPERM: operation not permitted, scandir '/x'",
		'Error: Path is not a directory',
	])('matches %s', (error) => {
		expect(isUnreadableFolderError(error)).toBe(true);
	});

	it.each([
		undefined,
		'',
		"TypeError: Cannot read properties of undefined (reading 'name')",
		'Error: SSH remote not found: abc',
	])('does not match %p', (error) => {
		expect(isUnreadableFolderError(error)).toBe(false);
	});
});
