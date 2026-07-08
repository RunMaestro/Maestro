/**
 * @vitest-environment jsdom
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImageDiffViewer } from '../../renderer/components/ImageDiffViewer';
import type { Theme } from '../../renderer/types';
import type { HandlerDependencies } from '../../main/ipc/handlers';
import { isValidThemeId } from '../../shared/theme-types';

const electronMocks = vi.hoisted(() => ({
	exposeInMainWorld: vi.fn(),
	invoke: vi.fn(),
	send: vi.fn(),
	on: vi.fn(),
	removeListener: vi.fn(),
}));

const handlerMocks = vi.hoisted(() => {
	const calls: string[] = [];
	const mark = (name: string) =>
		vi.fn(() => {
			calls.push(name);
		});

	return {
		calls,
		registerGitHandlers: mark('git'),
		registerAutorunHandlers: mark('autorun'),
		registerPlaybooksHandlers: mark('playbooks'),
		registerHistoryHandlers: mark('history'),
		registerAgentsHandlers: mark('agents'),
		registerProcessHandlers: mark('process'),
		registerPersistenceHandlers: mark('persistence'),
		registerSystemHandlers: mark('system'),
		setupLoggerEventForwarding: mark('loggerForwarding'),
		registerClaudeHandlers: mark('claude'),
		registerAgentSessionsHandlers: mark('agentSessions'),
		registerGroupChatHandlers: mark('groupChat'),
		registerDebugHandlers: mark('debug'),
		registerSpeckitHandlers: mark('speckit'),
		registerOpenSpecHandlers: mark('openspec'),
		registerBmadHandlers: mark('bmad'),
		registerContextHandlers: mark('context'),
		cleanupAllGroomingSessions: vi.fn(),
		getActiveGroomingSessionCount: vi.fn(),
		registerMarketplaceHandlers: mark('marketplace'),
		registerStatsHandlers: mark('stats'),
		registerCueStatsHandlers: mark('cueStats'),
		registerDocumentGraphHandlers: mark('documentGraph'),
		registerSshRemoteHandlers: mark('sshRemote'),
		registerFilesystemHandlers: mark('filesystem'),
		registerAttachmentsHandlers: mark('attachments'),
		registerWebHandlers: mark('web'),
		registerLeaderboardHandlers: mark('leaderboard'),
		registerNotificationsHandlers: mark('notifications'),
		registerSymphonyHandlers: mark('symphony'),
		registerAgentErrorHandlers: mark('agentError'),
		registerTabNamingHandlers: mark('tabNaming'),
		registerDirectorNotesHandlers: mark('directorNotes'),
		registerFeedbackHandlers: mark('feedback'),
		registerCueBackupHandlers: mark('cueBackup'),
		registerPromptsHandlers: mark('prompts'),
		registerMemoryHandlers: mark('memory'),
		registerWakatimeHandlers: mark('wakatime'),
	};
});

vi.mock('electron', () => ({
	contextBridge: {
		exposeInMainWorld: (...args: unknown[]) => electronMocks.exposeInMainWorld(...args),
	},
	ipcRenderer: {
		invoke: (...args: unknown[]) => electronMocks.invoke(...args),
		send: (...args: unknown[]) => electronMocks.send(...args),
		on: (...args: unknown[]) => electronMocks.on(...args),
		removeListener: (...args: unknown[]) => electronMocks.removeListener(...args),
	},
	ipcMain: {
		handle: vi.fn(),
	},
}));

vi.mock('../../main/ipc/handlers/git', () => ({
	registerGitHandlers: handlerMocks.registerGitHandlers,
}));
vi.mock('../../main/ipc/handlers/autorun', () => ({
	registerAutorunHandlers: handlerMocks.registerAutorunHandlers,
}));
vi.mock('../../main/ipc/handlers/playbooks', () => ({
	registerPlaybooksHandlers: handlerMocks.registerPlaybooksHandlers,
}));
vi.mock('../../main/ipc/handlers/history', () => ({
	registerHistoryHandlers: handlerMocks.registerHistoryHandlers,
}));
vi.mock('../../main/ipc/handlers/agents', () => ({
	registerAgentsHandlers: handlerMocks.registerAgentsHandlers,
}));
vi.mock('../../main/ipc/handlers/process', () => ({
	registerProcessHandlers: handlerMocks.registerProcessHandlers,
}));
vi.mock('../../main/ipc/handlers/persistence', () => ({
	registerPersistenceHandlers: handlerMocks.registerPersistenceHandlers,
}));
vi.mock('../../main/ipc/handlers/system', () => ({
	registerSystemHandlers: handlerMocks.registerSystemHandlers,
	setupLoggerEventForwarding: handlerMocks.setupLoggerEventForwarding,
}));
vi.mock('../../main/ipc/handlers/claude', () => ({
	registerClaudeHandlers: handlerMocks.registerClaudeHandlers,
}));
vi.mock('../../main/ipc/handlers/agentSessions', () => ({
	registerAgentSessionsHandlers: handlerMocks.registerAgentSessionsHandlers,
}));
vi.mock('../../main/ipc/handlers/groupChat', () => ({
	registerGroupChatHandlers: handlerMocks.registerGroupChatHandlers,
}));
vi.mock('../../main/ipc/handlers/debug', () => ({
	registerDebugHandlers: handlerMocks.registerDebugHandlers,
}));
vi.mock('../../main/ipc/handlers/speckit', () => ({
	registerSpeckitHandlers: handlerMocks.registerSpeckitHandlers,
}));
vi.mock('../../main/ipc/handlers/openspec', () => ({
	registerOpenSpecHandlers: handlerMocks.registerOpenSpecHandlers,
}));
vi.mock('../../main/ipc/handlers/bmad', () => ({
	registerBmadHandlers: handlerMocks.registerBmadHandlers,
}));
vi.mock('../../main/ipc/handlers/context', () => ({
	registerContextHandlers: handlerMocks.registerContextHandlers,
	cleanupAllGroomingSessions: handlerMocks.cleanupAllGroomingSessions,
	getActiveGroomingSessionCount: handlerMocks.getActiveGroomingSessionCount,
}));
vi.mock('../../main/ipc/handlers/marketplace', () => ({
	registerMarketplaceHandlers: handlerMocks.registerMarketplaceHandlers,
}));
vi.mock('../../main/ipc/handlers/stats', () => ({
	registerStatsHandlers: handlerMocks.registerStatsHandlers,
}));
vi.mock('../../main/ipc/handlers/cue-stats', () => ({
	registerCueStatsHandlers: handlerMocks.registerCueStatsHandlers,
}));
vi.mock('../../main/ipc/handlers/documentGraph', () => ({
	registerDocumentGraphHandlers: handlerMocks.registerDocumentGraphHandlers,
}));
vi.mock('../../main/ipc/handlers/ssh-remote', () => ({
	registerSshRemoteHandlers: handlerMocks.registerSshRemoteHandlers,
}));
vi.mock('../../main/ipc/handlers/filesystem', () => ({
	registerFilesystemHandlers: handlerMocks.registerFilesystemHandlers,
}));
vi.mock('../../main/ipc/handlers/attachments', () => ({
	registerAttachmentsHandlers: handlerMocks.registerAttachmentsHandlers,
}));
vi.mock('../../main/ipc/handlers/web', () => ({
	registerWebHandlers: handlerMocks.registerWebHandlers,
}));
vi.mock('../../main/ipc/handlers/leaderboard', () => ({
	registerLeaderboardHandlers: handlerMocks.registerLeaderboardHandlers,
}));
vi.mock('../../main/ipc/handlers/notifications', () => ({
	registerNotificationsHandlers: handlerMocks.registerNotificationsHandlers,
}));
vi.mock('../../main/ipc/handlers/symphony', () => ({
	registerSymphonyHandlers: handlerMocks.registerSymphonyHandlers,
}));
vi.mock('../../main/ipc/handlers/agent-error', () => ({
	registerAgentErrorHandlers: handlerMocks.registerAgentErrorHandlers,
}));
vi.mock('../../main/ipc/handlers/tabNaming', () => ({
	registerTabNamingHandlers: handlerMocks.registerTabNamingHandlers,
}));
vi.mock('../../main/ipc/handlers/director-notes', () => ({
	registerDirectorNotesHandlers: handlerMocks.registerDirectorNotesHandlers,
}));
vi.mock('../../main/ipc/handlers/feedback', () => ({
	registerFeedbackHandlers: handlerMocks.registerFeedbackHandlers,
}));
vi.mock('../../main/ipc/handlers/cue-backup', () => ({
	registerCueBackupHandlers: handlerMocks.registerCueBackupHandlers,
}));
vi.mock('../../main/ipc/handlers/prompts', () => ({
	registerPromptsHandlers: handlerMocks.registerPromptsHandlers,
}));
vi.mock('../../main/ipc/handlers/memory', () => ({
	registerMemoryHandlers: handlerMocks.registerMemoryHandlers,
}));
vi.mock('../../main/ipc/handlers/wakatime', () => ({
	registerWakatimeHandlers: handlerMocks.registerWakatimeHandlers,
}));

const mockShowFile = vi.fn();
const mockReadFile = vi.fn();

const theme: Theme = {
	id: 'dracula',
	name: 'Dracula',
	mode: 'dark',
	colors: {
		bgMain: '#111111',
		bgSidebar: '#222222',
		bgActivity: '#333333',
		border: '#444444',
		textMain: '#eeeeee',
		textDim: '#999999',
		accent: '#8b5cf6',
		accentDim: '#8b5cf640',
		accentText: '#a78bfa',
		accentForeground: '#ffffff',
		success: '#10b981',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

describe('zero-coverage entrypoint integration', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
		handlerMocks.calls.length = 0;

		(window as any).maestro = {
			git: {
				showFile: mockShowFile,
			},
			fs: {
				readFile: mockReadFile,
			},
		};
	});

	it('exposes the composed preload API and routes newer namespaces through ipcRenderer', async () => {
		electronMocks.invoke.mockResolvedValue('generated-name');

		const preload = await import('../../main/preload/index');

		expect(electronMocks.exposeInMainWorld).toHaveBeenCalledWith(
			'maestro',
			expect.objectContaining({
				autorun: expect.any(Object),
				directorNotes: expect.any(Object),
				platform: process.platform,
				tabNaming: expect.any(Object),
				wakatime: expect.any(Object),
			})
		);
		expect(preload.createTabNamingApi).toEqual(expect.any(Function));
		expect(preload.createDirectorNotesApi).toEqual(expect.any(Function));
		expect(preload.createWakatimeApi).toEqual(expect.any(Function));

		const exposedApi = electronMocks.exposeInMainWorld.mock.calls[0][1] as {
			tabNaming: ReturnType<typeof preload.createTabNamingApi>;
		};
		const config = { userMessage: 'Name this tab', agentType: 'codex', cwd: '/repo' };

		await expect(exposedApi.tabNaming.generateTabName(config)).resolves.toBe('generated-name');
		expect(electronMocks.invoke).toHaveBeenCalledWith('tabNaming:generateTabName', config);
	});

	it('registers consolidated IPC handlers with scoped dependencies and skips lifecycle handlers', async () => {
		const deps = createHandlerDeps();
		const { registerAllHandlers } = await import('../../main/ipc/handlers');

		registerAllHandlers(deps);

		expect(handlerMocks.calls).toEqual([
			'git',
			'autorun',
			'playbooks',
			'history',
			'agents',
			'process',
			'persistence',
			'system',
			'claude',
			'groupChat',
			'debug',
			'speckit',
			'openspec',
			'bmad',
			'context',
			'marketplace',
			'stats',
			'cueStats',
			'documentGraph',
			'sshRemote',
			'filesystem',
			'attachments',
			'leaderboard',
			'notifications',
			'symphony',
			'agentError',
			'tabNaming',
			'directorNotes',
			'feedback',
			'cueBackup',
			'prompts',
			'memory',
			'loggerForwarding',
		]);
		expect(handlerMocks.registerGitHandlers).toHaveBeenCalledWith({
			settingsStore: deps.settingsStore,
		});
		expect(handlerMocks.registerProcessHandlers).toHaveBeenCalledWith(
			expect.objectContaining({
				getProcessManager: deps.getProcessManager,
				getAgentDetector: deps.getAgentDetector,
				settingsStore: deps.settingsStore,
				getMainWindow: deps.getMainWindow,
				sessionsStore: deps.sessionsStore,
			})
		);
		expect(handlerMocks.registerContextHandlers).toHaveBeenCalledWith({
			getMainWindow: deps.getMainWindow,
			getProcessManager: deps.getProcessManager,
			getAgentDetector: deps.getAgentDetector,
			agentConfigsStore: deps.agentConfigsStore,
		});
		expect(handlerMocks.registerSymphonyHandlers).toHaveBeenCalledWith({
			app: deps.app,
			getMainWindow: deps.getMainWindow,
			sessionsStore: deps.sessionsStore,
			settingsStore: deps.settingsStore,
		});
		expect(handlerMocks.setupLoggerEventForwarding).toHaveBeenCalledWith(deps.getMainWindow);
		expect(handlerMocks.registerAgentSessionsHandlers).not.toHaveBeenCalled();
		expect(handlerMocks.registerWebHandlers).not.toHaveBeenCalled();
		expect(handlerMocks.registerWakatimeHandlers).not.toHaveBeenCalled();
	});

	it('validates theme IDs across accepted and rejected values', () => {
		expect(['dracula', 'github-light', 'custom'].filter(isValidThemeId)).toEqual([
			'dracula',
			'github-light',
			'custom',
		]);
		expect(isValidThemeId('vibe')).toBe(false);
		expect(isValidThemeId('../dracula')).toBe(false);
	});
});

describe('ImageDiffViewer integration', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		(window as any).maestro = {
			git: {
				showFile: mockShowFile,
			},
			fs: {
				readFile: mockReadFile,
			},
		};
	});

	it('shows the loading state while image reads are pending', () => {
		mockShowFile.mockImplementation(() => new Promise(() => {}));
		mockReadFile.mockImplementation(() => new Promise(() => {}));

		const { container } = renderImageDiff();

		expect(screen.getByText('Loading images...')).toBeInTheDocument();
		expect(container.querySelector('.animate-spin')).toBeInTheDocument();
	});

	it('loads and renders both images for a modified file', async () => {
		mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,old' });
		mockReadFile.mockResolvedValue('data:image/png;base64,new');

		renderImageDiff({ sshRemoteId: 'remote-1' });

		await waitFor(() => expect(screen.getByText('Binary file changed')).toBeInTheDocument());
		const images = screen.getAllByRole('img');
		expect(images).toHaveLength(2);
		expect(images[0]).toHaveAttribute('alt', 'Before');
		expect(images[0]).toHaveAttribute('src', 'data:image/png;base64,old');
		expect(images[1]).toHaveAttribute('alt', 'After');
		expect(images[1]).toHaveAttribute('src', 'data:image/png;base64,new');
		expect(mockShowFile).toHaveBeenCalledWith('/repo', 'HEAD', 'old.png');
		expect(mockReadFile).toHaveBeenCalledWith('/repo/new.png', 'remote-1');
	});

	it('renders a new file without loading old content', async () => {
		mockReadFile.mockResolvedValue('data:image/png;base64,new-file');

		renderImageDiff({ isNewFile: true });

		await waitFor(() => expect(screen.getByText('New file')).toBeInTheDocument());
		expect(screen.getByText('File did not exist')).toBeInTheDocument();
		expect(screen.getByText('(file did not exist)')).toBeInTheDocument();
		expect(screen.getByRole('img', { name: 'After' })).toHaveAttribute(
			'src',
			'data:image/png;base64,new-file'
		);
		expect(mockShowFile).not.toHaveBeenCalled();
		expect(mockReadFile).toHaveBeenCalledTimes(1);
	});

	it('renders a deleted file without loading working-tree content', async () => {
		mockShowFile.mockResolvedValue({ content: 'data:image/png;base64,deleted' });

		renderImageDiff({ isDeletedFile: true });

		await waitFor(() => expect(screen.getByText('Deleted')).toBeInTheDocument());
		expect(screen.getByText('File deleted')).toBeInTheDocument();
		expect(screen.getByText('(file deleted)')).toBeInTheDocument();
		expect(screen.getByRole('img', { name: 'Before' })).toHaveAttribute(
			'src',
			'data:image/png;base64,deleted'
		);
		expect(mockShowFile).toHaveBeenCalledTimes(1);
		expect(mockReadFile).not.toHaveBeenCalled();
	});

	it('shows explicit old-image errors and thrown new-image errors', async () => {
		mockShowFile.mockResolvedValue({ error: 'Missing in HEAD' });
		mockReadFile.mockRejectedValue(new Error('Denied by filesystem'));

		renderImageDiff();

		await waitFor(() => {
			expect(screen.getByText('Missing in HEAD')).toBeInTheDocument();
			expect(screen.getByText('Denied by filesystem')).toBeInTheDocument();
		});
		expect(screen.getAllByText('Failed to load')).toHaveLength(2);
	});

	it('shows thrown Error objects from the old image loader', async () => {
		mockShowFile.mockRejectedValue(new Error('Old image exploded'));
		mockReadFile.mockResolvedValue('data:image/png;base64,new');

		renderImageDiff();

		await waitFor(() => expect(screen.getByText('Old image exploded')).toBeInTheDocument());
		expect(screen.getByRole('img', { name: 'After' })).toHaveAttribute(
			'src',
			'data:image/png;base64,new'
		);
	});

	it('falls back for non-Error exceptions and empty image content', async () => {
		mockShowFile.mockRejectedValue('old failed');
		mockReadFile.mockRejectedValue('new failed');

		const { rerender } = renderImageDiff();

		await waitFor(() => {
			expect(screen.getByText('Failed to load old image')).toBeInTheDocument();
			expect(screen.getByText('Failed to load new image')).toBeInTheDocument();
		});

		mockShowFile.mockResolvedValue({ content: null });
		mockReadFile.mockResolvedValue(null);
		rerender(
			<ImageDiffViewer
				oldPath="old-empty.png"
				newPath="new-empty.png"
				cwd="/repo"
				theme={theme}
				isNewFile={false}
				isDeletedFile={false}
			/>
		);

		await waitFor(() => expect(screen.getByText('old-empty.png')).toBeInTheDocument());
		expect(screen.queryAllByRole('img')).toHaveLength(0);
	});
});

function renderImageDiff(overrides: Partial<React.ComponentProps<typeof ImageDiffViewer>> = {}) {
	return render(
		<ImageDiffViewer
			oldPath="old.png"
			newPath="new.png"
			cwd="/repo"
			theme={theme}
			isNewFile={false}
			isDeletedFile={false}
			{...overrides}
		/>
	);
}

function createHandlerDeps(): HandlerDependencies {
	const mainWindow = { id: 'main-window' };
	const agentDetector = { id: 'agent-detector' };
	const processManager = { id: 'process-manager' };
	const webServer = { id: 'web-server' };

	return {
		mainWindow,
		getMainWindow: vi.fn(() => mainWindow),
		app: { name: 'Maestro' },
		getAgentDetector: vi.fn(() => agentDetector),
		agentConfigsStore: { name: 'agent-configs-store' },
		getProcessManager: vi.fn(() => processManager),
		settingsStore: { name: 'settings-store' },
		sessionsStore: { name: 'sessions-store' },
		groupsStore: { name: 'groups-store' },
		getWebServer: vi.fn(() => webServer),
		tunnelManager: { name: 'tunnel-manager' },
		claudeSessionOriginsStore: { name: 'claude-session-origins-store' },
	} as unknown as HandlerDependencies;
}
