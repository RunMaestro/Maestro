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
import { collectSessions, DebugSessionInfo } from './collectors/sessions';
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
import { AgentDetector } from '../agents';
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

type DebugPackageCollectionState = {
	contents: Partial<PackageContents>;
	filesIncluded: string[];
	errors: string[];
};

/**
 * Runs one named collector without allowing a failed category to prevent the
 * remaining diagnostic categories from being packaged.
 */
async function collectCategory(
	state: DebugPackageCollectionState,
	filename: keyof PackageContents,
	errorLabel: string,
	logMessage: string,
	collector: () => unknown | Promise<unknown>
): Promise<void> {
	try {
		state.contents[filename] = await collector();
		state.filesIncluded.push(filename);
	} catch (error) {
		const errMsg = error instanceof Error ? error.message : String(error);
		state.errors.push(`${errorLabel}: ${errMsg}`);
		logger.error(logMessage, 'DebugPackage', error);
	}
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

	const state: DebugPackageCollectionState = {
		contents: {},
		filesIncluded: [],
		errors: [],
	};

	logger.info('Starting debug package generation', 'DebugPackage');

	// Collect system info (always included)
	await collectCategory(
		state,
		'system-info.json',
		'system-info',
		'Failed to collect system info',
		() => collectSystemInfo()
	);

	// Collect settings (always included)
	await collectCategory(state, 'settings.json', 'settings', 'Failed to collect settings', () =>
		collectSettings(deps.settingsStore, deps.bootstrapStore)
	);

	// Collect agent configurations (always included)
	await collectCategory(state, 'agents.json', 'agents', 'Failed to collect agent info', () =>
		collectAgents(deps.getAgentDetector())
	);

	// Collect external tools (always included)
	await collectCategory(
		state,
		'external-tools.json',
		'external-tools',
		'Failed to collect external tools info',
		() => collectExternalTools()
	);

	// Collect Windows-specific diagnostics (always included, minimal on non-Windows)
	await collectCategory(
		state,
		'windows-diagnostics.json',
		'windows-diagnostics',
		'Failed to collect Windows diagnostics',
		() => collectWindowsDiagnostics()
	);

	// Collect groups (always included)
	await collectCategory(state, 'groups.json', 'groups', 'Failed to collect groups', () =>
		deps.groupsStore.get('groups', [])
	);

	// Collect sessions (optional)
	if (opts.includeSessions) {
		await collectCategory(state, 'sessions.json', 'sessions', 'Failed to collect sessions', () =>
			collectSessions(deps.sessionsStore)
		);
	}

	// Collect processes (always included)
	await collectCategory(state, 'processes.json', 'processes', 'Failed to collect processes', () =>
		collectProcesses(deps.getProcessManager())
	);

	// Collect logs (optional)
	if (opts.includeLogs) {
		await collectCategory(state, 'logs.json', 'logs', 'Failed to collect logs', () =>
			collectLogs(500)
		);
	}

	// Collect errors (optional)
	if (opts.includeErrors) {
		await collectCategory(state, 'errors.json', 'errors', 'Failed to collect errors', () =>
			collectErrors(deps.sessionsStore)
		);
	}

	// Collect web server info (always included)
	await collectCategory(
		state,
		'web-server.json',
		'web-server',
		'Failed to collect web server info',
		() => collectWebServer(deps.getWebServer())
	);

	// Collect storage info (always included)
	await collectCategory(
		state,
		'storage-info.json',
		'storage-info',
		'Failed to collect storage info',
		() => collectStorage(deps.bootstrapStore)
	);

	// Collect group chats (optional)
	if (opts.includeGroupChats) {
		await collectCategory(
			state,
			'group-chats.json',
			'group-chats',
			'Failed to collect group chats',
			() => collectGroupChats()
		);
	}

	// Collect batch state (optional)
	if (opts.includeBatchState) {
		await collectCategory(
			state,
			'batch-state.json',
			'batch-state',
			'Failed to collect batch state',
			() => collectBatchState(deps.sessionsStore)
		);
	}

	// Add collection errors to the package if any occurred
	if (state.errors.length > 0) {
		state.contents['collection-errors.json'] = {
			timestamp: Date.now(),
			errors: state.errors,
		};
		state.filesIncluded.push('collection-errors.json');
	}

	// Create the zip package
	try {
		const result = await createZipPackage(outputDir, state.contents);
		logger.info(
			`Debug package created: ${result.path} (${result.sizeBytes} bytes)`,
			'DebugPackage'
		);

		return {
			success: true,
			path: result.path,
			filesIncluded: state.filesIncluded,
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
	DebugSessionInfo,
	ProcessInfo,
	LogsInfo,
	ErrorsInfo,
	WebServerInfo,
	StorageInfo,
	GroupChatInfo,
	BatchStateInfo,
};
