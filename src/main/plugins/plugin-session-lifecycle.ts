/** Main's plugin session lifecycle adapter. No observation or send consent is minted here. */
import { nativeCurrentTurns } from '../pianola/current-turn';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import type { PluginSessionMetadata } from './plugin-host-handlers';
import type { PianolaSupervisor, AutoWatchSession } from '../pianola/pianola-supervisor';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';

export function createPluginSessionLifecycle(deps: {
	readSessions: () => Array<Record<string, unknown>>;
	writeSessions: (sessions: Array<Record<string, unknown>>) => void;
	flush: () => Promise<void>;
	getActiveSessionId: () => string;
	setActiveSessionId: (id: string) => void;
	getSupervisor: () => Pick<PianolaSupervisor, 'autoWatchNewSessions'> | null | undefined;
}) {
	const create = async (params: Record<string, unknown>): Promise<PluginSessionMetadata> => {
		const now = Date.now();
		const sessionId = typeof params.id === 'string' ? params.id : crypto.randomUUID();
		// Duplicate delivery is a failed create, never an activation or overwrite.
		if (deps.readSessions().some((session) => session.id === sessionId))
			throw new Error(`Session already exists: ${sessionId}`);
		const tabId = crypto.randomUUID();
		const title =
			typeof params.title === 'string'
				? params.title
				: typeof params.name === 'string'
					? params.name
					: 'Plugin Session';
		const toolType =
			typeof params.agentId === 'string'
				? params.agentId
				: typeof params.toolType === 'string'
					? params.toolType
					: 'claude-code';
		const cwd =
			typeof params.projectPath === 'string'
				? params.projectPath
				: typeof params.cwd === 'string'
					? params.cwd
					: os.homedir();
		const session = {
			id: sessionId,
			name: title,
			toolType,
			state: 'idle',
			cwd,
			fullPath: cwd,
			projectRoot: cwd,
			createdAt: now,
			updatedAt: now,
			aiLogs: [],
			shellLogs: [],
			workLog: [],
			contextUsage: 0,
			inputMode: 'ai',
			aiPid: 0,
			terminalPid: 0,
			port: 0,
			isLive: false,
			changedFiles: [],
			isGitRepo: false,
			fileTree: [],
			fileExplorerExpanded: [],
			fileExplorerScrollPos: 0,
			executionQueue: [],
			activeTimeMs: 0,
			aiTabs: [
				{
					id: tabId,
					agentSessionId: null,
					name: null,
					starred: false,
					logs: [],
					inputValue: '',
					stagedImages: [],
					createdAt: now,
					state: 'idle',
				},
			],
			activeTabId: tabId,
			closedTabHistory: [],
			filePreviewTabs: [],
			activeFileTabId: null,
			browserTabs: [],
			activeBrowserTabId: null,
			terminalTabs: [],
			activeTerminalTabId: null,
			unifiedTabOrder: [{ type: 'ai', id: tabId }],
			unifiedClosedTabHistory: [],
		};
		const previousSessions = deps.readSessions();
		deps.writeSessions([...previousSessions, session]);
		// Stage birth before yielding: a spawn/owner commit during the flush consumes
		// it permanently. A successful flush cannot revive that lost boundary.
		const finishCreation = nativeCurrentTurns.recordHostEmptyCreation({
			agentId: sessionId,
			tabId,
			createdAt: now,
			provider: toolType,
		});
		try {
			await deps.flush();
		} catch (error) {
			finishCreation(false);
			throw error;
		}
		if (
			!deps
				.readSessions()
				.some(
					(stored) =>
						stored.id === sessionId && stored.activeTabId === tabId && stored.state === 'idle'
				)
		) {
			finishCreation(false);
			throw new Error(`Session changed during creation: ${sessionId}`);
		}
		finishCreation(true);
		try {
			await deps
				.getSupervisor()
				?.autoWatchNewSessions([session], deps.readSessions() as unknown as AutoWatchSession[]);
		} catch (error) {
			logger.error('Could not register new Pianola watch', '[Pianola]', error);
			void captureException(error, { operation: 'pianola:autoWatchPluginSession' });
		}
		if (
			!deps.readSessions().some((stored) => stored.id === sessionId && stored.activeTabId === tabId)
		)
			throw new Error(`Session removed during creation: ${sessionId}`);
		deps.setActiveSessionId(sessionId);
		return {
			id: sessionId,
			title,
			agentId: toolType,
			status: 'idle',
			createdAt: now,
			projectPath: cwd,
		};
	};
	const remove = async (sessionId: string): Promise<boolean> => {
		const sessions = deps.readSessions();
		if (!sessions.some((s) => s.id === sessionId)) return false;
		const remaining = sessions.filter((s) => s.id !== sessionId);
		deps.writeSessions(remaining);
		nativeCurrentTurns.forgetHostEmptyCreation(sessionId);
		await deps.flush();
		try {
			await deps
				.getSupervisor()
				?.autoWatchNewSessions([], deps.readSessions() as unknown as AutoWatchSession[], [
					sessionId,
				]);
		} catch (error) {
			logger.error('Could not retire Pianola watch', '[Pianola]', error);
			void captureException(error, { operation: 'pianola:retireAutoWatch' });
		}
		if (deps.getActiveSessionId() === sessionId) {
			const nextActive = deps.readSessions()[0]?.id;
			deps.setActiveSessionId(typeof nextActive === 'string' ? nextActive : '');
		}
		return true;
	};

	return { create, remove };
}
