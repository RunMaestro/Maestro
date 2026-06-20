import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentOutputParser, ParsedEvent } from '../../main/parsers/agent-output-parser';

const mocks = vi.hoisted(() => ({
	ipcHandle: vi.fn(),
	ipcInvoke: vi.fn(),
	ipcOn: vi.fn(),
	ipcRemoveListener: vi.fn(),
	exposeInMainWorld: vi.fn(),
	loggerDebug: vi.fn(),
	loggerInfo: vi.fn(),
	registerSessionStorage: vi.fn(),
	setupForwardingListeners: vi.fn(),
	setupDataListener: vi.fn(),
	setupUsageListener: vi.fn(),
	setupSessionIdListener: vi.fn(),
	setupErrorListener: vi.fn(),
	setupStatsListener: vi.fn(),
	setupExitListener: vi.fn(),
}));

vi.mock('electron', () => ({
	ipcMain: {
		handle: mocks.ipcHandle,
	},
	ipcRenderer: {
		invoke: mocks.ipcInvoke,
		on: mocks.ipcOn,
		removeListener: mocks.ipcRemoveListener,
	},
	contextBridge: {
		exposeInMainWorld: mocks.exposeInMainWorld,
	},
}));

vi.mock('../../main/utils/logger', () => ({
	logger: {
		debug: mocks.loggerDebug,
		info: mocks.loggerInfo,
	},
}));

vi.mock('../../main/agents', () => ({
	registerSessionStorage: mocks.registerSessionStorage,
}));

vi.mock('../../main/storage/claude-session-storage', () => ({
	ClaudeSessionOriginsData: class ClaudeSessionOriginsData {},
	ClaudeSessionStorage: class ClaudeSessionStorage {
		constructor(public originsStore?: unknown) {}
	},
}));

vi.mock('../../main/storage/opencode-session-storage', () => ({
	OpenCodeSessionStorage: class OpenCodeSessionStorage {},
}));

vi.mock('../../main/storage/codex-session-storage', () => ({
	CodexSessionStorage: class CodexSessionStorage {},
}));

vi.mock('../../main/storage/factory-droid-session-storage', () => ({
	FactoryDroidSessionStorage: class FactoryDroidSessionStorage {},
}));

vi.mock('../../main/process-listeners/forwarding-listeners', () => ({
	setupForwardingListeners: mocks.setupForwardingListeners,
}));

vi.mock('../../main/process-listeners/data-listener', () => ({
	setupDataListener: mocks.setupDataListener,
}));

vi.mock('../../main/process-listeners/usage-listener', () => ({
	setupUsageListener: mocks.setupUsageListener,
}));

vi.mock('../../main/process-listeners/session-id-listener', () => ({
	setupSessionIdListener: mocks.setupSessionIdListener,
}));

vi.mock('../../main/process-listeners/error-listener', () => ({
	setupErrorListener: mocks.setupErrorListener,
}));

vi.mock('../../main/process-listeners/stats-listener', () => ({
	setupStatsListener: mocks.setupStatsListener,
}));

vi.mock('../../main/process-listeners/exit-listener', () => ({
	setupExitListener: mocks.setupExitListener,
}));

import {
	clearParserRegistry,
	getAllOutputParsers,
	getOutputParser,
	hasOutputParser,
	initializeOutputParsers,
	registerOutputParser,
} from '../../main/parsers';
import {
	emitAgent,
	emitComplete,
	emitDocumentComplete,
	emitDocumentStart,
	emitError,
	emitGroup,
	emitJsonl,
	emitLoopComplete,
	emitPlaybook,
	emitStart,
	emitTaskComplete,
	emitTaskStart,
} from '../../cli/output/jsonl';
import { registerAgentErrorHandlers } from '../../main/ipc/handlers/agent-error';
import { createAttachmentsApi } from '../../main/preload/attachments';
import { createDirectorNotesApi } from '../../main/preload/directorNotes';
import { createSymphonyApi } from '../../main/preload/symphony';
import { createTabNamingApi } from '../../main/preload/tabNaming';
import { createWakatimeApi } from '../../main/preload/wakatime';
import { setupProcessListeners } from '../../main/process-listeners';
import { initializeSessionStorages } from '../../main/storage';
import {
	getOpenSpecCommand,
	getOpenSpecCommandBySlash,
	getOpenSpecMetadata,
	openspecCommands,
} from '../../prompts/openspec';
import {
	getSpeckitCommand,
	getSpeckitCommandBySlash,
	getSpeckitMetadata,
	speckitCommands,
} from '../../prompts/speckit';

function fakeParser(agentId: AgentOutputParser['agentId']): AgentOutputParser {
	return {
		agentId,
		parseJsonLine: vi.fn((): ParsedEvent => ({ type: 'text', text: 'parsed' })),
		isResultMessage: vi.fn(() => false),
		extractSessionId: vi.fn(() => null),
		extractUsage: vi.fn(() => null),
		extractSlashCommands: vi.fn(() => null),
		parseJsonObject: vi.fn((): ParsedEvent => ({ type: 'text', text: 'parsed' })),
		detectErrorFromLine: vi.fn(() => null),
		detectErrorFromParsed: vi.fn(() => null),
		detectErrorFromExit: vi.fn(() => null),
	};
}

describe('CLI, parser, preload, and prompt module integration', () => {
	beforeEach(() => {
		vi.setSystemTime(new Date('2026-05-27T09:00:00Z'));
		mocks.ipcHandle.mockClear();
		mocks.ipcInvoke.mockClear();
		mocks.ipcInvoke.mockResolvedValue('ok');
		mocks.ipcOn.mockClear();
		mocks.ipcRemoveListener.mockClear();
		mocks.loggerDebug.mockClear();
		mocks.registerSessionStorage.mockClear();
		mocks.loggerInfo.mockClear();
		mocks.setupForwardingListeners.mockClear();
		mocks.setupDataListener.mockClear();
		mocks.setupUsageListener.mockClear();
		mocks.setupSessionIdListener.mockClear();
		mocks.setupErrorListener.mockClear();
		mocks.setupStatsListener.mockClear();
		mocks.setupExitListener.mockClear();
		clearParserRegistry();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		clearParserRegistry();
	});

	it('emits machine-parseable JSONL events with timestamps', () => {
		const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

		emitJsonl({ type: 'custom', value: 1 });
		emitError('failed', 'E_FAIL');
		emitStart(
			{ id: 'playbook-1', name: 'Playbook' },
			{ id: 'session-1', name: 'Session', cwd: '/tmp' }
		);
		emitDocumentStart('doc.md', 0, 3);
		emitTaskStart('doc.md', 1);
		emitTaskComplete('doc.md', 1, true, 'done', 25, {
			fullResponse: 'full',
			usageStats: { inputTokens: 1, outputTokens: 2 },
			agentSessionId: 'agent-session-1',
		});
		emitDocumentComplete('doc.md', 3);
		emitLoopComplete(2, 6, 100, { inputTokens: 3, outputTokens: 4 });
		emitComplete(true, 6, 200, 0.12);
		emitGroup({ id: 'group-1', name: 'Group', emoji: 'G', collapsed: false });
		emitAgent({
			id: 'agent-1',
			name: 'Agent',
			toolType: 'codex',
			cwd: '/repo',
			groupId: 'group-1',
		});
		emitPlaybook({
			id: 'playbook-1',
			name: 'Playbook',
			sessionId: 'session-1',
			documents: ['doc.md'],
			loopEnabled: true,
			maxLoops: null,
		});

		const events = consoleSpy.mock.calls.map(([line]) => JSON.parse(String(line)));

		expect(events.map((event) => event.type)).toEqual([
			'custom',
			'error',
			'start',
			'document_start',
			'task_start',
			'task_complete',
			'document_complete',
			'loop_complete',
			'complete',
			'group',
			'agent',
			'playbook',
		]);
		expect(events.every((event) => event.timestamp === Date.now())).toBe(true);
		expect(events[5]).toMatchObject({
			success: true,
			summary: 'done',
			fullResponse: 'full',
			agentSessionId: 'agent-session-1',
		});
	});

	it('registers output parsers and rejects invalid parser ids', () => {
		expect(getOutputParser('not-real')).toBeNull();
		expect(hasOutputParser('not-real')).toBe(false);
		expect(getOutputParser('codex')).toBeNull();
		expect(hasOutputParser('codex')).toBe(false);

		const parser = fakeParser('codex');
		registerOutputParser(parser);

		expect(getOutputParser('codex')).toBe(parser);
		expect(hasOutputParser('codex')).toBe(true);
		expect(getAllOutputParsers()).toEqual([parser]);

		initializeOutputParsers();
		expect(
			getAllOutputParsers()
				.map((registered) => registered.agentId)
				.sort()
		).toEqual(['claude-code', 'codex', 'copilot-cli', 'factory-droid', 'opencode']);
		expect(mocks.loggerInfo).toHaveBeenCalledWith(
			'Initialized output parsers: claude-code, opencode, codex, factory-droid, copilot-cli',
			'[OutputParsers]'
		);

		clearParserRegistry();
		initializeOutputParsers();
		expect(getAllOutputParsers()).toHaveLength(5);
		clearParserRegistry();
		expect(getAllOutputParsers()).toHaveLength(0);
	});

	it('routes preload factory calls through the intended IPC channels', async () => {
		const attachments = createAttachmentsApi();
		const directorNotes = createDirectorNotesApi();
		const tabNaming = createTabNamingApi();
		const wakatime = createWakatimeApi();

		await attachments.save('session-1', 'base64', 'image.png');
		await attachments.load('session-1', 'image.png');
		await attachments.delete('session-1', 'image.png');
		await attachments.list('session-1');
		await attachments.getPath('session-1');
		await directorNotes.getUnifiedHistory({ lookbackDays: 7, limit: 10, offset: 0 });
		await directorNotes.generateSynopsis({ lookbackDays: 7, provider: 'codex' });
		await tabNaming.generateTabName({ userMessage: 'Fix tests', agentType: 'codex', cwd: '/repo' });
		await wakatime.checkCli();
		await wakatime.validateApiKey('waka_test');

		expect(mocks.ipcInvoke.mock.calls).toEqual([
			['attachments:save', 'session-1', 'base64', 'image.png'],
			['attachments:load', 'session-1', 'image.png'],
			['attachments:delete', 'session-1', 'image.png'],
			['attachments:list', 'session-1'],
			['attachments:getPath', 'session-1'],
			['director-notes:getUnifiedHistory', { lookbackDays: 7, limit: 10, offset: 0 }],
			['director-notes:generateSynopsis', { lookbackDays: 7, provider: 'codex' }],
			['tabNaming:generateTabName', { userMessage: 'Fix tests', agentType: 'codex', cwd: '/repo' }],
			['wakatime:checkCli'],
			['wakatime:validateApiKey', 'waka_test'],
		]);
	});

	it('routes Symphony preload calls and realtime subscriptions through IPC', async () => {
		const api = createSymphonyApi();
		const contributionParams = {
			contributionId: 'contribution-1',
			sessionId: 'session-1',
			repoSlug: 'owner/repo',
			repoName: 'Repo',
			issueNumber: 7,
			issueTitle: 'Fix docs',
			repoUrl: 'https://github.com/owner/repo',
			localPath: '/tmp/repo',
			branchName: 'fix-docs',
			agentType: 'codex',
			totalDocuments: 2,
			documentPaths: [{ name: 'README.md', path: 'README.md', isExternal: false }],
		};

		await api.getRegistry(true);
		await api.getIssues('owner/repo', true);
		await api.getIssueCounts(['owner/repo'], true);
		await api.getState();
		await api.getActive();
		await api.getCompleted(5);
		await api.getStats();
		await api.start({
			repoSlug: contributionParams.repoSlug,
			repoUrl: contributionParams.repoUrl,
			repoName: contributionParams.repoName,
			issueNumber: contributionParams.issueNumber,
			issueTitle: contributionParams.issueTitle,
			documentPaths: contributionParams.documentPaths,
			agentType: contributionParams.agentType,
			sessionId: contributionParams.sessionId,
		});
		await api.registerActive(contributionParams);
		await api.updateStatus({
			contributionId: contributionParams.contributionId,
			status: 'running',
			progress: { completedTasks: 1 },
		});
		await api.complete({ contributionId: contributionParams.contributionId, prBody: 'Ready' });
		await api.cancel(contributionParams.contributionId, false);
		await api.checkPRStatuses();
		await api.syncContribution(contributionParams.contributionId);
		await api.clearCache();
		await api.cloneRepo({
			repoUrl: contributionParams.repoUrl,
			localPath: contributionParams.localPath,
		});
		await api.startContribution({
			contributionId: contributionParams.contributionId,
			sessionId: contributionParams.sessionId,
			repoSlug: contributionParams.repoSlug,
			issueNumber: contributionParams.issueNumber,
			issueTitle: contributionParams.issueTitle,
			localPath: contributionParams.localPath,
			documentPaths: contributionParams.documentPaths,
		});
		await api.createDraftPR({
			contributionId: contributionParams.contributionId,
			title: 'Fix docs',
			body: 'Ready',
		});
		await api.fetchDocumentContent('https://example.com/README.md');
		await api.manualCredit({
			repoSlug: contributionParams.repoSlug,
			repoName: contributionParams.repoName,
			issueNumber: contributionParams.issueNumber,
			issueTitle: contributionParams.issueTitle,
			prNumber: 12,
			prUrl: 'https://github.com/owner/repo/pull/12',
		});

		expect(mocks.ipcInvoke.mock.calls.map(([channel]) => channel)).toEqual([
			'symphony:getRegistry',
			'symphony:getIssues',
			'symphony:getIssueCounts',
			'symphony:getState',
			'symphony:getActive',
			'symphony:getCompleted',
			'symphony:getStats',
			'symphony:start',
			'symphony:registerActive',
			'symphony:updateStatus',
			'symphony:complete',
			'symphony:cancel',
			'symphony:checkPRStatuses',
			'symphony:syncContribution',
			'symphony:clearCache',
			'symphony:cloneRepo',
			'symphony:startContribution',
			'symphony:createDraftPR',
			'symphony:fetchDocumentContent',
			'symphony:manualCredit',
		]);
		expect(mocks.ipcInvoke).toHaveBeenCalledWith('symphony:cancel', 'contribution-1', false);
		expect(mocks.ipcInvoke).toHaveBeenCalledWith('symphony:fetchDocumentContent', {
			url: 'https://example.com/README.md',
		});

		const onUpdated = vi.fn();
		const onContributionStarted = vi.fn();
		const onPRCreated = vi.fn();
		const cleanupUpdated = api.onUpdated(onUpdated);
		const cleanupStarted = api.onContributionStarted(onContributionStarted);
		const cleanupPR = api.onPRCreated(onPRCreated);

		mocks.ipcOn.mock.calls[0][1]();
		mocks.ipcOn.mock.calls[1][1](null, {
			contributionId: 'contribution-1',
			sessionId: 'session-1',
			localPath: '/tmp/repo',
			branchName: 'fix-docs',
		});
		mocks.ipcOn.mock.calls[2][1](null, {
			contributionId: 'contribution-1',
			prNumber: 12,
			prUrl: 'https://github.com/owner/repo/pull/12',
		});

		expect(onUpdated).toHaveBeenCalledTimes(1);
		expect(onContributionStarted).toHaveBeenCalledWith({
			contributionId: 'contribution-1',
			sessionId: 'session-1',
			localPath: '/tmp/repo',
			branchName: 'fix-docs',
		});
		expect(onPRCreated).toHaveBeenCalledWith({
			contributionId: 'contribution-1',
			prNumber: 12,
			prUrl: 'https://github.com/owner/repo/pull/12',
		});

		cleanupUpdated();
		cleanupStarted();
		cleanupPR();
		expect(mocks.ipcRemoveListener.mock.calls.map(([channel]) => channel)).toEqual([
			'symphony:updated',
			'symphony:contributionStarted',
			'symphony:prCreated',
		]);
	});

	it('registers agent-error IPC handlers and logs sanitized retry metadata', async () => {
		registerAgentErrorHandlers();

		expect(mocks.ipcHandle.mock.calls.map(([channel]) => channel)).toEqual([
			'agent:clearError',
			'agent:retryAfterError',
		]);

		const clearHandler = mocks.ipcHandle.mock.calls[0][1];
		const retryHandler = mocks.ipcHandle.mock.calls[1][1];

		await expect(clearHandler(null, 'session-1')).resolves.toEqual({ success: true });
		await expect(
			retryHandler(null, 'session-1', { prompt: 'try again', newSession: true })
		).resolves.toEqual({ success: true });
		await expect(retryHandler(null, 'session-2')).resolves.toEqual({ success: true });

		expect(mocks.loggerDebug).toHaveBeenCalledWith(
			'Clearing agent error for session',
			'AgentError',
			{
				sessionId: 'session-1',
			}
		);
		expect(mocks.loggerInfo).toHaveBeenCalledWith('Retrying after agent error', 'AgentError', {
			sessionId: 'session-1',
			hasPrompt: true,
			newSession: true,
		});
		expect(mocks.loggerInfo).toHaveBeenCalledWith('Retrying after agent error', 'AgentError', {
			sessionId: 'session-2',
			hasPrompt: false,
			newSession: false,
		});
	});

	it('wires every process listener module with shared dependencies', () => {
		const processManager = { name: 'process-manager' };
		const deps = { getMainWindow: vi.fn(), sessionsStore: { get: vi.fn() } };

		setupProcessListeners(processManager as any, deps as any);

		const listenerMocks = [
			mocks.setupForwardingListeners,
			mocks.setupDataListener,
			mocks.setupUsageListener,
			mocks.setupSessionIdListener,
			mocks.setupErrorListener,
			mocks.setupStatsListener,
			mocks.setupExitListener,
		];

		for (const listenerMock of listenerMocks) {
			expect(listenerMock).toHaveBeenCalledWith(processManager, deps);
		}
		expect(listenerMocks.map((listenerMock) => listenerMock.mock.invocationCallOrder[0])).toEqual(
			[...listenerMocks.map((listenerMock) => listenerMock.mock.invocationCallOrder[0])].sort(
				(a, b) => a - b
			)
		);
	});

	it('registers all session storage providers', () => {
		const originsStore = { name: 'origins-store' };

		initializeSessionStorages({ claudeSessionOriginsStore: originsStore } as any);

		expect(
			mocks.registerSessionStorage.mock.calls.map(([storage]) => storage.constructor.name)
		).toEqual([
			'ClaudeSessionStorage',
			'OpenCodeSessionStorage',
			'CodexSessionStorage',
			'FactoryDroidSessionStorage',
			'CopilotSessionStorage',
		]);
		expect(mocks.registerSessionStorage.mock.calls[0][0].originsStore).toBe(originsStore);
	});

	it('looks up bundled OpenSpec and Spec Kit commands and metadata', () => {
		expect(openspecCommands.map((command) => command.id)).toEqual([
			'help',
			'proposal',
			'apply',
			'archive',
			'implement',
		]);
		expect(getOpenSpecCommand('proposal')?.command).toBe('/openspec.proposal');
		expect(getOpenSpecCommandBySlash('/openspec.implement')?.id).toBe('implement');
		expect(getOpenSpecCommand('missing')).toBeUndefined();
		expect(getOpenSpecCommandBySlash('/openspec.missing')).toBeUndefined();
		expect(getOpenSpecMetadata()).toEqual(
			expect.objectContaining({
				lastRefreshed: expect.any(String),
				commitSha: expect.any(String),
				sourceVersion: expect.any(String),
				sourceUrl: expect.any(String),
			})
		);

		expect(speckitCommands.map((command) => command.id)).toEqual([
			'help',
			'constitution',
			'specify',
			'clarify',
			'plan',
			'tasks',
			'analyze',
			'checklist',
			'taskstoissues',
			'implement',
		]);
		expect(getSpeckitCommand('tasks')?.command).toBe('/speckit.tasks');
		expect(getSpeckitCommandBySlash('/speckit.implement')?.id).toBe('implement');
		expect(getSpeckitCommand('missing')).toBeUndefined();
		expect(getSpeckitCommandBySlash('/speckit.missing')).toBeUndefined();
		expect(getSpeckitMetadata()).toEqual(
			expect.objectContaining({
				lastRefreshed: expect.any(String),
				commitSha: expect.any(String),
				sourceVersion: expect.any(String),
				sourceUrl: expect.any(String),
			})
		);
	});
});
