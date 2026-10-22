/**
 * Stored records to assembly inputs.
 *
 * `AgentRecord` and `AITabRecord` keep every field this build does not name as `unknown`,
 * because a record read from disk is not trusted: a hand edit, or a build that stored a
 * different shape. `assembleTurn` reads typed fields, so each is checked here and one
 * that is the wrong type reads as absent, never as a wrong value.
 */

import type { AdditionalDirectory, AgentSshRemoteConfig } from '../../types';
import { sshRecordOf } from '../agents/rules';
import type { AgentRecord, AITabRecord } from '../store/records';
import type { TurnAgent, TurnTab } from './assemble';

const str = (value: unknown): string | undefined =>
	typeof value === 'string' && value !== '' ? value : undefined;

const bool = (value: unknown): boolean | undefined =>
	typeof value === 'boolean' ? value : undefined;

const num = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function stringMap(value: unknown): Record<string, string> | undefined {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
	const entries = Object.entries(value).filter(
		(entry): entry is [string, string] => typeof entry[1] === 'string'
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function additionalDirectories(value: unknown): AdditionalDirectory[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const dirs = value.flatMap((entry): AdditionalDirectory[] => {
		if (typeof entry !== 'object' || entry === null) return [];
		const record = entry as Record<string, unknown>;
		if (typeof record.path !== 'string' || !record.path) return [];
		return [
			{
				path: record.path,
				read: record.read === true,
				write: record.write === true,
				...(typeof record.description === 'string' ? { description: record.description } : {}),
			},
		];
	});
	return dirs.length > 0 ? dirs : undefined;
}

function agentCommands(value: unknown): TurnAgent['agentCommands'] {
	if (!Array.isArray(value)) return undefined;
	const commands = value.flatMap((entry) => {
		if (typeof entry !== 'object' || entry === null) return [];
		const record = entry as Record<string, unknown>;
		if (typeof record.command !== 'string') return [];
		return [
			{
				command: record.command,
				...(typeof record.description === 'string' ? { description: record.description } : {}),
				...(typeof record.prompt === 'string' && record.prompt ? { prompt: record.prompt } : {}),
			},
		];
	});
	return commands.length > 0 ? commands : undefined;
}

/** The agent fields a turn reads. An agent without a working directory has none to run in. */
export function toTurnAgent(record: AgentRecord): TurnAgent | undefined {
	const cwd = str(record.cwd);
	if (!cwd) return undefined;
	const ssh = sshRecordOf(record.sessionSshRemoteConfig);
	const worktreeBasePath =
		typeof record.worktreeConfig === 'object' && record.worktreeConfig !== null
			? str((record.worktreeConfig as Record<string, unknown>).basePath)
			: undefined;
	const sshConfig: AgentSshRemoteConfig | undefined = ssh
		? {
				...(ssh as unknown as AgentSshRemoteConfig),
				enabled: ssh.enabled === true,
				remoteId: typeof ssh.remoteId === 'string' ? ssh.remoteId : null,
			}
		: undefined;
	return {
		id: record.id,
		name: record.name,
		toolType: record.toolType,
		cwd,
		projectRoot: str(record.projectRoot),
		fullPath: str(record.fullPath),
		groupId: str(record.groupId),
		autoRunFolderPath: str(record.autoRunFolderPath),
		additionalDirectories: additionalDirectories(record.additionalDirectories),
		worktreeConfig: worktreeBasePath ? { basePath: worktreeBasePath } : undefined,
		isGitRepo: bool(record.isGitRepo),
		contextUsage: num(record.contextUsage),
		agentSessionId: str(record.agentSessionId),
		isPianola: bool(record.isPianola),
		nudgeMessage: str(record.nudgeMessage),
		newSessionMessage: str(record.newSessionMessage),
		customPath: str(record.customPath),
		customArgs: str(record.customArgs),
		customEnvVars: stringMap(record.customEnvVars),
		customModel: str(record.customModel),
		customEffort: str(record.customEffort),
		customContextWindow: num(record.customContextWindow),
		sessionSshRemoteConfig: sshConfig,
		agentCommands: agentCommands(record.agentCommands),
	};
}

const PERMISSION_MODES = ['full', 'standard', 'readonly'] as const;

/** The tab fields a turn reads. */
export function toTurnTab(record: AITabRecord): TurnTab {
	const mode = PERMISSION_MODES.find((candidate) => candidate === record.permissionMode);
	return {
		id: record.id,
		agentSessionId: str(record.agentSessionId) ?? null,
		customModel: str(record.customModel),
		customEffort: str(record.customEffort),
		readOnlyMode: bool(record.readOnlyMode),
		permissionMode: mode,
		pendingMergedContext: str(record.pendingMergedContext),
	};
}
