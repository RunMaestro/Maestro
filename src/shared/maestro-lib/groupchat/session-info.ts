/**
 * @file groupchat/session-info.ts
 * @description An agent as a group chat resolves an `@mention` to it.
 *
 * The engine matches a mention against `GroupChatSessionInfo`: the few fields it needs to add the
 * agent as a participant with its own launch settings (arguments, environment, model, SSH remote,
 * Claude token source). The desktop builds that from its persisted sessions, the headless runtime
 * from its repository's agent records, and both come through here, so the two cannot disagree about
 * what an agent contributes to a chat.
 */

import * as os from 'os';

import type { GroupChatSessionInfo } from './types';

/** The persisted agent fields a mention reads. Every one is optional: a record is not trusted. */
export interface MentionableSession {
	id: string;
	name: string;
	toolType: string;
	cwd?: string;
	fullPath?: string;
	customArgs?: string;
	customEnvVars?: Record<string, string>;
	customModel?: string;
	enableMaestroP?: boolean;
	maestroPMode?: 'interactive' | 'dynamic';
	maestroPPath?: string;
	sessionSshRemoteConfig?: GroupChatSessionInfo['sshRemoteConfig'];
	autoRunFolderPath?: string;
}

export interface SessionInfoContext {
	/** The name of an SSH remote, for the participant card's pill. Absent when the remote is unknown. */
	sshRemoteName(remoteId: string): string | undefined;
	/**
	 * Whether this agent is running a turn right now. Live liveness, never the stored state: a
	 * persisted agent always reads idle, so only the host's own processes can answer.
	 */
	isBusy: boolean;
	/** Where an agent with no directory resolves to. Default: the home directory. */
	homeDir?: string;
}

export function toGroupChatSessionInfo(
	session: MentionableSession,
	context: SessionInfoContext
): GroupChatSessionInfo {
	// Resolve the SSH remote name if the agent has an SSH config
	const ssh = session.sessionSshRemoteConfig;
	const sshRemoteName =
		ssh?.enabled && ssh.remoteId ? context.sshRemoteName(ssh.remoteId) : undefined;
	return {
		id: session.id,
		name: session.name,
		toolType: session.toolType,
		cwd: session.cwd || session.fullPath || context.homeDir || os.homedir(),
		customArgs: session.customArgs,
		customEnvVars: session.customEnvVars,
		customModel: session.customModel,
		// Claude token-source selection, so group chat participants honor
		// the same maestro-p TUI / API / dynamic choice as their agent.
		enableMaestroP: session.enableMaestroP,
		maestroPMode: session.maestroPMode,
		maestroPPath: session.maestroPPath,
		sshRemoteName,
		// The full SSH config, for remote execution
		sshRemoteConfig: ssh,
		autoRunFolderPath: session.autoRunFolderPath,
		isBusy: context.isBusy,
	};
}
