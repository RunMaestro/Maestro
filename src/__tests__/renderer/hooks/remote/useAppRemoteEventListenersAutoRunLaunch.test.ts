/**
 * Covers the document-name half of the `maestro:configureAutoRun` listener -
 * the renderer end of `maestro-cli auto-run --save-as` and `--launch`.
 */
import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useAppRemoteEventListeners } from '../../../../renderer/hooks/remote/useAppRemoteEventListeners';
import { createMockSession } from '../../../helpers/mockSession';
import type { Session } from '../../../../renderer/types';

vi.mock('../../../../renderer/stores/sessionStore', () => ({
	useSessionStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
	selectSessionById: vi.fn(() => () => undefined),
}));
vi.mock('../../../../renderer/stores/settingsStore', () => ({
	useSettingsStore: Object.assign(vi.fn(), { getState: vi.fn(() => ({})) }),
}));
vi.mock('../../../../renderer/hooks/batch/batchUtils', () => ({
	DEFAULT_BATCH_PROMPT: 'default prompt',
}));
vi.mock('../../../../renderer/services/git', () => ({ gitService: {} }));
vi.mock('../../../../renderer/utils/worktreeSpawn', () => ({
	spawnWorktreeAgentAndDispatch: vi.fn(),
}));
vi.mock('../../../../renderer/stores/notificationStore', () => ({ notifyToast: vi.fn() }));
vi.mock('../../../../renderer/utils/browserTabPersistence', () => ({
	getBrowserTabPartition: () => 'persist:test',
}));
vi.mock('../../../../renderer/utils/ids', () => ({ generateId: () => 'doc-id' }));
vi.mock('../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
	captureMessage: vi.fn(),
}));

const ack = vi.fn();
const SESSION_ID = 'agent-1';
const FOLDER = '/repo/.maestro/playbooks';

function makeSession(): Session {
	return createMockSession({
		id: SESSION_ID,
		name: 'Worker',
		autoRunFolderPath: FOLDER,
	}) as Session;
}

function setup(startBatchRun: ReturnType<typeof vi.fn>, sessions: Session[] = [makeSession()]) {
	renderHook(() =>
		useAppRemoteEventListeners({
			sessionsRef: { current: sessions },
			setActiveSessionId: vi.fn(),
			setSessions: vi.fn(),
			setGroups: vi.fn(),
			handleOpenFileTab: vi.fn(),
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh: vi.fn(),
			startBatchRun,
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		} as any)
	);
}

function launch(config: Record<string, unknown> = {}) {
	window.dispatchEvent(
		new CustomEvent('maestro:configureAutoRun', {
			detail: {
				sessionId: SESSION_ID,
				config: {
					documents: [{ filename: `${FOLDER}/ship-it.md` }],
					launch: true,
					...config,
				},
				responseChannel: 'ch',
			},
		})
	);
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	vi.clearAllMocks();
	(window as any).maestro = {
		process: { sendRemoteConfigureAutoRunResponse: ack },
		logger: { log: vi.fn() },
	};
});

// that kept the absolute paths could never run.
describe('maestro:configureAutoRun document names', () => {
	const create = vi.fn();

	beforeEach(() => {
		create.mockResolvedValue({ success: true, playbook: { id: 'pb-1' } });
		(window as any).maestro.playbooks = { create };
	});

	it('saves a playbook with folder-relative names without .md', async () => {
		setup(vi.fn(() => Promise.resolve()));

		launch({
			launch: undefined,
			saveAsPlaybook: 'Nightly',
			documents: [
				{ filename: `${FOLDER}/batch/DOC-01.md` },
				{ filename: `${FOLDER}/batch/DOC-02.md`, resetOnCompletion: true },
			],
		});
		await flush();

		expect(create).toHaveBeenCalledWith(SESSION_ID, {
			name: 'Nightly',
			documents: [
				{ filename: 'batch/DOC-01', resetOnCompletion: false },
				{ filename: 'batch/DOC-02', resetOnCompletion: true },
			],
			loopEnabled: false,
			maxLoops: undefined,
			prompt: '',
		});
		expect(ack).toHaveBeenCalledWith('ch', { success: true, playbookId: 'pb-1', error: undefined });
	});

	it('refuses to save a playbook naming a document outside the Auto Run folder', async () => {
		setup(vi.fn(() => Promise.resolve()));

		launch({
			launch: undefined,
			saveAsPlaybook: 'Nightly',
			documents: [{ filename: `${FOLDER}/ok.md` }, { filename: '/elsewhere/stray.md' }],
		});
		await flush();

		expect(create).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledWith('ch', {
			success: false,
			error: `Document is outside the Auto Run folder (${FOLDER}): /elsewhere/stray.md`,
		});
	});

	it('refuses to launch a document outside the Auto Run folder instead of running its basename', async () => {
		const startBatchRun = vi.fn(() => Promise.resolve());
		setup(startBatchRun);

		launch({ documents: [{ filename: '/elsewhere/ship-it.md' }] });
		await flush();

		expect(startBatchRun).not.toHaveBeenCalled();
		expect(ack).toHaveBeenCalledWith('ch', {
			success: false,
			error: `Document is outside the Auto Run folder (${FOLDER}): /elsewhere/ship-it.md`,
		});
	});

	it('keeps subfolders when launching', async () => {
		const startBatchRun = vi.fn(() => Promise.resolve());
		setup(startBatchRun);

		launch({ documents: [{ filename: `${FOLDER}/phase/one.md` }] });
		await flush();

		expect(((startBatchRun.mock.calls[0] as unknown[])[1] as any).documents[0].filename).toBe(
			'phase/one'
		);
	});
});
