/**
 * Tests for the consolidated IPC handler registration table.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { registerAllHandlers, type HandlerDependencies } from '../../../../main/ipc/handlers';

const mocks = vi.hoisted(() => {
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
		registerContextHandlers: mark('context'),
		cleanupAllGroomingSessions: vi.fn(),
		getActiveGroomingSessionCount: vi.fn(),
		registerMarketplaceHandlers: mark('marketplace'),
		registerStatsHandlers: mark('stats'),
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
		registerWakatimeHandlers: mark('wakatime'),
	};
});

vi.mock('../../../../main/ipc/handlers/git', () => ({
	registerGitHandlers: mocks.registerGitHandlers,
}));
vi.mock('../../../../main/ipc/handlers/autorun', () => ({
	registerAutorunHandlers: mocks.registerAutorunHandlers,
}));
vi.mock('../../../../main/ipc/handlers/playbooks', () => ({
	registerPlaybooksHandlers: mocks.registerPlaybooksHandlers,
}));
vi.mock('../../../../main/ipc/handlers/history', () => ({
	registerHistoryHandlers: mocks.registerHistoryHandlers,
}));
vi.mock('../../../../main/ipc/handlers/agents', () => ({
	registerAgentsHandlers: mocks.registerAgentsHandlers,
}));
vi.mock('../../../../main/ipc/handlers/process', () => ({
	registerProcessHandlers: mocks.registerProcessHandlers,
}));
vi.mock('../../../../main/ipc/handlers/persistence', () => ({
	registerPersistenceHandlers: mocks.registerPersistenceHandlers,
}));
vi.mock('../../../../main/ipc/handlers/system', () => ({
	registerSystemHandlers: mocks.registerSystemHandlers,
	setupLoggerEventForwarding: mocks.setupLoggerEventForwarding,
}));
vi.mock('../../../../main/ipc/handlers/claude', () => ({
	registerClaudeHandlers: mocks.registerClaudeHandlers,
}));
vi.mock('../../../../main/ipc/handlers/agentSessions', () => ({
	registerAgentSessionsHandlers: mocks.registerAgentSessionsHandlers,
}));
vi.mock('../../../../main/ipc/handlers/groupChat', () => ({
	registerGroupChatHandlers: mocks.registerGroupChatHandlers,
}));
vi.mock('../../../../main/ipc/handlers/debug', () => ({
	registerDebugHandlers: mocks.registerDebugHandlers,
}));
vi.mock('../../../../main/ipc/handlers/speckit', () => ({
	registerSpeckitHandlers: mocks.registerSpeckitHandlers,
}));
vi.mock('../../../../main/ipc/handlers/openspec', () => ({
	registerOpenSpecHandlers: mocks.registerOpenSpecHandlers,
}));
vi.mock('../../../../main/ipc/handlers/context', () => ({
	registerContextHandlers: mocks.registerContextHandlers,
	cleanupAllGroomingSessions: mocks.cleanupAllGroomingSessions,
	getActiveGroomingSessionCount: mocks.getActiveGroomingSessionCount,
}));
vi.mock('../../../../main/ipc/handlers/marketplace', () => ({
	registerMarketplaceHandlers: mocks.registerMarketplaceHandlers,
}));
vi.mock('../../../../main/ipc/handlers/stats', () => ({
	registerStatsHandlers: mocks.registerStatsHandlers,
}));
vi.mock('../../../../main/ipc/handlers/documentGraph', () => ({
	registerDocumentGraphHandlers: mocks.registerDocumentGraphHandlers,
}));
vi.mock('../../../../main/ipc/handlers/ssh-remote', () => ({
	registerSshRemoteHandlers: mocks.registerSshRemoteHandlers,
}));
vi.mock('../../../../main/ipc/handlers/filesystem', () => ({
	registerFilesystemHandlers: mocks.registerFilesystemHandlers,
}));
vi.mock('../../../../main/ipc/handlers/attachments', () => ({
	registerAttachmentsHandlers: mocks.registerAttachmentsHandlers,
}));
vi.mock('../../../../main/ipc/handlers/web', () => ({
	registerWebHandlers: mocks.registerWebHandlers,
}));
vi.mock('../../../../main/ipc/handlers/leaderboard', () => ({
	registerLeaderboardHandlers: mocks.registerLeaderboardHandlers,
}));
vi.mock('../../../../main/ipc/handlers/notifications', () => ({
	registerNotificationsHandlers: mocks.registerNotificationsHandlers,
}));
vi.mock('../../../../main/ipc/handlers/symphony', () => ({
	registerSymphonyHandlers: mocks.registerSymphonyHandlers,
}));
vi.mock('../../../../main/ipc/handlers/agent-error', () => ({
	registerAgentErrorHandlers: mocks.registerAgentErrorHandlers,
}));
vi.mock('../../../../main/ipc/handlers/tabNaming', () => ({
	registerTabNamingHandlers: mocks.registerTabNamingHandlers,
}));
vi.mock('../../../../main/ipc/handlers/director-notes', () => ({
	registerDirectorNotesHandlers: mocks.registerDirectorNotesHandlers,
}));
vi.mock('../../../../main/ipc/handlers/wakatime', () => ({
	registerWakatimeHandlers: mocks.registerWakatimeHandlers,
}));

describe('registerAllHandlers', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.calls.length = 0;
	});

	it('registers the consolidated IPC handlers in the expected order', () => {
		const deps = createDeps();

		registerAllHandlers(deps);

		expect(mocks.calls).toEqual([
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
			'context',
			'marketplace',
			'stats',
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
			'loggerForwarding',
		]);
	});

	it('passes each handler the dependencies it owns', () => {
		const deps = createDeps();

		registerAllHandlers(deps);

		expect(mocks.registerGitHandlers).toHaveBeenCalledWith({
			settingsStore: deps.settingsStore,
		});
		expect(mocks.registerAutorunHandlers).toHaveBeenCalledWith(deps);
		expect(mocks.registerPlaybooksHandlers).toHaveBeenCalledWith(deps);
		expect(mocks.registerHistoryHandlers).toHaveBeenCalledWith();
		expect(mocks.registerAgentsHandlers).toHaveBeenCalledWith({
			getAgentDetector: deps.getAgentDetector,
			agentConfigsStore: deps.agentConfigsStore,
			settingsStore: deps.settingsStore,
		});
		expect(mocks.registerProcessHandlers).toHaveBeenCalledWith({
			getProcessManager: deps.getProcessManager,
			getAgentDetector: deps.getAgentDetector,
			agentConfigsStore: deps.agentConfigsStore,
			settingsStore: deps.settingsStore,
			getMainWindow: deps.getMainWindow,
			sessionsStore: deps.sessionsStore,
		});
		expect(mocks.registerPersistenceHandlers).toHaveBeenCalledWith({
			settingsStore: deps.settingsStore,
			sessionsStore: deps.sessionsStore,
			groupsStore: deps.groupsStore,
			getWebServer: deps.getWebServer,
		});
		expect(mocks.registerSystemHandlers).toHaveBeenCalledWith({
			getMainWindow: deps.getMainWindow,
			app: deps.app,
			settingsStore: deps.settingsStore,
			tunnelManager: deps.tunnelManager,
			getWebServer: deps.getWebServer,
		});
		expect(mocks.registerClaudeHandlers).toHaveBeenCalledWith({
			claudeSessionOriginsStore: deps.claudeSessionOriginsStore,
			getMainWindow: deps.getMainWindow,
		});
		expect(mocks.registerGroupChatHandlers).toHaveBeenCalledWith({
			getMainWindow: deps.getMainWindow,
			getProcessManager: deps.getProcessManager,
			getAgentDetector: deps.getAgentDetector,
		});
		expect(mocks.registerDebugHandlers).toHaveBeenCalledWith({
			getMainWindow: deps.getMainWindow,
			getAgentDetector: deps.getAgentDetector,
			getProcessManager: deps.getProcessManager,
			getWebServer: deps.getWebServer,
			settingsStore: deps.settingsStore,
			sessionsStore: deps.sessionsStore,
			groupsStore: deps.groupsStore,
		});
		expect(mocks.registerSpeckitHandlers).toHaveBeenCalledWith();
		expect(mocks.registerOpenSpecHandlers).toHaveBeenCalledWith();
		expect(mocks.registerContextHandlers).toHaveBeenCalledWith({
			getMainWindow: deps.getMainWindow,
			getProcessManager: deps.getProcessManager,
			getAgentDetector: deps.getAgentDetector,
			agentConfigsStore: deps.agentConfigsStore,
		});
		expect(mocks.registerMarketplaceHandlers).toHaveBeenCalledWith({
			app: deps.app,
		});
		expect(mocks.registerStatsHandlers).toHaveBeenCalledWith({
			getMainWindow: deps.getMainWindow,
			settingsStore: deps.settingsStore,
		});
		expect(mocks.registerDocumentGraphHandlers).toHaveBeenCalledWith({
			getMainWindow: deps.getMainWindow,
			app: deps.app,
		});
		expect(mocks.registerSshRemoteHandlers).toHaveBeenCalledWith({
			settingsStore: deps.settingsStore,
		});
		expect(mocks.registerFilesystemHandlers).toHaveBeenCalledWith();
		expect(mocks.registerAttachmentsHandlers).toHaveBeenCalledWith({
			app: deps.app,
		});
		expect(mocks.registerLeaderboardHandlers).toHaveBeenCalledWith({
			app: deps.app,
			settingsStore: deps.settingsStore,
		});
		expect(mocks.registerNotificationsHandlers).toHaveBeenCalledWith();
		expect(mocks.registerSymphonyHandlers).toHaveBeenCalledWith({
			app: deps.app,
			getMainWindow: deps.getMainWindow,
			sessionsStore: deps.sessionsStore,
		});
		expect(mocks.registerAgentErrorHandlers).toHaveBeenCalledWith();
		expect(mocks.registerTabNamingHandlers).toHaveBeenCalledWith({
			getProcessManager: deps.getProcessManager,
			getAgentDetector: deps.getAgentDetector,
			agentConfigsStore: deps.agentConfigsStore,
			settingsStore: deps.settingsStore,
		});
		expect(mocks.registerDirectorNotesHandlers).toHaveBeenCalledWith({
			getProcessManager: deps.getProcessManager,
			getAgentDetector: deps.getAgentDetector,
			agentConfigsStore: deps.agentConfigsStore,
		});
		expect(mocks.setupLoggerEventForwarding).toHaveBeenCalledWith(deps.getMainWindow);
	});

	it('does not register handlers that need lifecycle-specific dependencies', () => {
		const deps = createDeps();

		registerAllHandlers(deps);

		expect(mocks.registerAgentSessionsHandlers).not.toHaveBeenCalled();
		expect(mocks.registerWebHandlers).not.toHaveBeenCalled();
		expect(mocks.registerWakatimeHandlers).not.toHaveBeenCalled();
	});
});

function createDeps(): HandlerDependencies {
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
