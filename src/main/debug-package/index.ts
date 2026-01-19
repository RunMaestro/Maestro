/**
 * Debug Package Generator
 *
 * Creates a comprehensive debug/support package containing sanitized system state,
 * configurations, logs, and session metadata for bug analysis.
 *
 * Privacy guarantees:
 * - NO API keys, tokens, or passwords
 * - NO conversation content (user messages, AI responses)
 * - NO personal file contents
 * - All file paths sanitized (usernames replaced with ~)
 */

import { collectSystemInfo, SystemInfo } from './collectors/system';
import { collectSettings, SanitizedSettings } from './collectors/settings';
import { collectAgents, AgentsInfo } from './collectors/agents';
import { collectExternalTools, ExternalToolsInfo } from './collectors/external-tools';
import { collectSessions, SessionInfo } from './collectors/sessions';
import { collectProcesses, ProcessInfo } from './collectors/processes';
import { collectLogs, LogsInfo } from './collectors/logs';
import { collectErrors, ErrorsInfo } from './collectors/errors';
import { collectWebServer, WebServerInfo } from './collectors/web-server';
import { collectStorage, StorageInfo } from './collectors/storage';
import { collectGroupChats, GroupChatInfo } from './collectors/group-chats';
import { collectBatchState, BatchStateInfo } from './collectors/batch-state';
import {
	collectWindowsDiagnostics,
	WindowsDiagnosticsInfo,
} from './collectors/windows-diagnostics';
import { createZipPackage, PackageContents } from './packager';
import { logger } from '../utils/logger';
import { AgentDetector } from '../agent-detector';
import { ProcessManager } from '../process-manager';
import { WebServer } from '../web-server';
import Store from 'electron-store';

export interface DebugPackageOptions {
	includeLogs?: boolean; // Default: true
	includeErrors?: boolean; // Default: true
	includeSessions?: boolean; // Default: true
	includeGroupChats?: boolean; // Default: true
	includeBatchState?: boolean; // Default: true
}

export interface DebugPackageResult {
	success: boolean;
	path?: string; // Path to the generated zip file
	error?: string;
	filesIncluded: string[]; // List of files in the package
	totalSizeBytes: number;
}

export interface DebugPackageDependencies {
	getAgentDetector: () => AgentDetector | null;
	getProcessManager: () => ProcessManager | null;
	getWebServer: () => WebServer | null;
	settingsStore: Store<any>;
	sessionsStore: Store<any>;
	groupsStore: Store<any>;
	bootstrapStore?: Store<any>;
}

/**
 * Generate a debug package containing sanitized diagnostic information.
 * The package is saved as a zip file to the specified output directory.
 */
export async function generateDebugPackage(
	outputDir: string,
	deps: DebugPackageDependencies,
	options?: DebugPackageOptions
): Promise<DebugPackageResult> {
	const opts = {
		includeLogs: true,
		includeErrors: true,
		includeSessions: true,
		includeGroupChats: true,
		includeBatchState: true,
		...options,
	};

	const filesIncluded: string[] = [];
	const contents: Partial<PackageContents> = {};
	const errors: string[] = [];

	logger.info('Starting debug package generation', 'DebugPackage');

	// Collect system info (always included)
	try {
		const systemInfo = collectSystemInfo();
		contents['system-info.json'] = systemInfo;
		filesIncluded.push('system-info.json');
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		errors.push(`system-info: ${errMsg}`);
		logger.error('Failed to collect system info', 'DebugPackage', error);
	}

	// Collect settings (always included)
	try {
		const settings = await collectSettings(deps.settingsStore, deps.bootstrapStore);
		contents['settings.json'] = settings;
		filesIncluded.push('settings.json');
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		errors.push(`settings: ${errMsg}`);
		logger.error('Failed to collect settings', 'DebugPackage', error);
	}

	// Collect agent configurations (always included)
	try {
		const agentDetector = deps.getAgentDetector();
		const agents = await collectAgents(agentDetector);
		contents['agents.json'] = agents;
		filesIncluded.push('agents.json');
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		errors.push(`agents: ${errMsg}`);
		logger.error('Failed to collect agent info', 'DebugPackage', error);
	}

	// Collect external tools (always included)
	try {
		const externalTools = await collectExternalTools();
		contents['external-tools.json'] = externalTools;
		filesIncluded.push('external-tools.json');
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		errors.push(`external-tools: ${errMsg}`);
		logger.error('Failed to collect external tools info', 'DebugPackage', error);
	}

	// Collect Windows-specific diagnostics (always included, minimal on non-Windows)
	try {
		const windowsDiagnostics = await collectWindowsDiagnostics();
		contents['windows-diagnostics.json'] = windowsDiagnostics;
		filesIncluded.push('windows-diagnostics.json');
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		errors.push(`windows-diagnostics: ${errMsg}`);
		logger.error('Failed to collect Windows diagnostics', 'DebugPackage', error);
	}

	// Collect groups (always included)
	try {
		const groupsData = deps.groupsStore.get('groups', []);
		contents['groups.json'] = groupsData;
		filesIncluded.push('groups.json');
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		errors.push(`groups: ${errMsg}`);
		logger.error('Failed to collect groups', 'DebugPackage', error);
	}

	// Collect sessions (optional)
	if (opts.includeSessions) {
		try {
			const sessions = await collectSessions(deps.sessionsStore);
			contents['sessions.json'] = sessions;
			filesIncluded.push('sessions.json');
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			errors.push(`sessions: ${errMsg}`);
			logger.error('Failed to collect sessions', 'DebugPackage', error);
		}
	}

	// Collect processes (always included)
	try {
		const processManager = deps.getProcessManager();
		const processes = await collectProcesses(processManager);
		contents['processes.json'] = processes;
		filesIncluded.push('processes.json');
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		errors.push(`processes: ${errMsg}`);
		logger.error('Failed to collect processes', 'DebugPackage', error);
	}

	// Collect logs (optional)
	if (opts.includeLogs) {
		try {
			const logs = collectLogs(500);
			contents['logs.json'] = logs;
			filesIncluded.push('logs.json');
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			errors.push(`logs: ${errMsg}`);
			logger.error('Failed to collect logs', 'DebugPackage', error);
		}
	}

	// Collect errors (optional)
	if (opts.includeErrors) {
		try {
			const errorsInfo = collectErrors(deps.sessionsStore);
			contents['errors.json'] = errorsInfo;
			filesIncluded.push('errors.json');
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			errors.push(`errors: ${errMsg}`);
			logger.error('Failed to collect errors', 'DebugPackage', error);
		}
	}

	// Collect web server info (always included)
	try {
		const webServer = deps.getWebServer();
		const webServerInfo = await collectWebServer(webServer);
		contents['web-server.json'] = webServerInfo;
		filesIncluded.push('web-server.json');
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		errors.push(`web-server: ${errMsg}`);
		logger.error('Failed to collect web server info', 'DebugPackage', error);
	}

	// Collect storage info (always included)
	try {
		const storageInfo = await collectStorage(deps.bootstrapStore);
		contents['storage-info.json'] = storageInfo;
		filesIncluded.push('storage-info.json');
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		errors.push(`storage-info: ${errMsg}`);
		logger.error('Failed to collect storage info', 'DebugPackage', error);
	}

	// Collect group chats (optional)
	if (opts.includeGroupChats) {
		try {
			const groupChats = await collectGroupChats();
			contents['group-chats.json'] = groupChats;
			filesIncluded.push('group-chats.json');
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			errors.push(`group-chats: ${errMsg}`);
			logger.error('Failed to collect group chats', 'DebugPackage', error);
		}
	}

	// Collect batch state (optional)
	if (opts.includeBatchState) {
		try {
			const batchState = collectBatchState(deps.sessionsStore);
			contents['batch-state.json'] = batchState;
			filesIncluded.push('batch-state.json');
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			errors.push(`batch-state: ${errMsg}`);
			logger.error('Failed to collect batch state', 'DebugPackage', error);
		}
	}

	// Add collection errors to the package if any occurred
	if (errors.length > 0) {
		contents['collection-errors.json'] = {
			timestamp: Date.now(),
			errors,
		};
		filesIncluded.push('collection-errors.json');
	}

	// Create the zip package
	try {
		const result = await createZipPackage(outputDir, contents);
		logger.info(
			`Debug package created: ${result.path} (${result.sizeBytes} bytes)`,
			'DebugPackage'
		);

		return {
			success: true,
			path: result.path,
			filesIncluded,
			totalSizeBytes: result.sizeBytes,
		};
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		logger.error('Failed to create debug package', 'DebugPackage', error);

		return {
			success: false,
			error: errMsg,
			filesIncluded: [],
			totalSizeBytes: 0,
		};
	}
}

/**
 * Preview what will be included in the debug package.
 * Returns categories and approximate sizes.
 */
export function previewDebugPackage(): {
	categories: Array<{
		id: string;
		name: string;
		included: boolean;
		sizeEstimate: string;
	}>;
} {
	return {
		categories: [
			{ id: 'system', name: 'System Information', included: true, sizeEstimate: '< 1 KB' },
			{ id: 'settings', name: 'Settings', included: true, sizeEstimate: '< 5 KB' },
			{ id: 'agents', name: 'Agent Configurations', included: true, sizeEstimate: '< 2 KB' },
			{ id: 'externalTools', name: 'External Tools', included: true, sizeEstimate: '< 2 KB' },
			{
				id: 'windowsDiagnostics',
				name: 'Windows Diagnostics',
				included: true,
				sizeEstimate: '< 10 KB',
			},
			{ id: 'sessions', name: 'Session Metadata', included: true, sizeEstimate: '~10-50 KB' },
			{ id: 'logs', name: 'System Logs', included: true, sizeEstimate: '~50-200 KB' },
			{ id: 'errors', name: 'Error States', included: true, sizeEstimate: '< 10 KB' },
			{ id: 'webServer', name: 'Web Server State', included: true, sizeEstimate: '< 2 KB' },
			{ id: 'storage', name: 'Storage Info', included: true, sizeEstimate: '< 2 KB' },
			{ id: 'groupChats', name: 'Group Chat Metadata', included: true, sizeEstimate: '< 5 KB' },
			{ id: 'batchState', name: 'Auto Run State', included: true, sizeEstimate: '< 5 KB' },
		],
	};
}

// Re-export types for convenience
export type {
	SystemInfo,
	SanitizedSettings,
	AgentsInfo,
	ExternalToolsInfo,
	WindowsDiagnosticsInfo,
	SessionInfo,
	ProcessInfo,
	LogsInfo,
	ErrorsInfo,
	WebServerInfo,
	StorageInfo,
	GroupChatInfo,
	BatchStateInfo,
};
