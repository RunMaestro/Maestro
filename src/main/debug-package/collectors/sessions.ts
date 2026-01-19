/**
 * Sessions Collector
 *
 * Collects session metadata without conversation content.
 * - Paths are sanitized
 * - No AI logs or shell logs included
 * - No message content included
 */

import Store from 'electron-store';
import { sanitizePath } from './settings';

export interface SessionInfo {
	id: string;
	name: string;
	groupId?: string;
	toolType: string;
	state: string;
	inputMode: string;
	cwd: string; // Sanitized
	projectRoot: string; // Sanitized
	isGitRepo: boolean;
	isLive: boolean;
	tabCount: number;
	activeTabId: string;
	executionQueueLength: number;
	contextUsage: number;
	hasUsageStats: boolean;
	hasError: boolean;
	errorType?: string; // Just the error type, not full details
	createdAt?: number;
	bookmarked: boolean;
	// Auto Run state
	hasAutoRunFolder: boolean;
	autoRunMode?: string;
	// Changed files count (not content)
	changedFilesCount: number;
}

/**
 * Collect session metadata without conversation content.
 */
export async function collectSessions(sessionsStore: Store<any>): Promise<SessionInfo[]> {
	const sessions: SessionInfo[] = [];

	// Get all sessions from the store
	const storedSessions = sessionsStore.get('sessions', []) as any[];

	for (const session of storedSessions) {
		const sessionInfo: SessionInfo = {
			id: session.id || 'unknown',
			name: session.name || 'Unnamed',
			groupId: session.groupId,
			toolType: session.toolType || 'unknown',
			state: session.state || 'unknown',
			inputMode: session.inputMode || 'ai',
			cwd: sanitizePath(session.cwd || ''),
			projectRoot: sanitizePath(session.projectRoot || ''),
			isGitRepo: !!session.isGitRepo,
			isLive: !!session.isLive,
			tabCount: Array.isArray(session.aiTabs) ? session.aiTabs.length : 0,
			activeTabId: session.activeTabId || '',
			executionQueueLength: Array.isArray(session.executionQueue)
				? session.executionQueue.length
				: 0,
			contextUsage: session.contextUsage || 0,
			hasUsageStats: !!session.usageStats,
			hasError: !!session.agentError,
			errorType: session.agentError?.type,
			createdAt: session.createdAt,
			bookmarked: !!session.bookmarked,
			hasAutoRunFolder: !!session.autoRunFolderPath,
			autoRunMode: session.autoRunMode,
			changedFilesCount: Array.isArray(session.changedFiles) ? session.changedFiles.length : 0,
		};

		sessions.push(sessionInfo);
	}

	return sessions;
}
