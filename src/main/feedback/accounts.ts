/**
 * Feedback account selection, main-process half.
 *
 * Reads the agents and provider settings, builds the candidate list with
 * `src/shared/feedbackAccounts.ts`, and checks each candidate cheaply: is the
 * binary there, and does its config dir hold a login. The desktop Feedback chat
 * and `maestro-cli feedback accounts` both call {@link listFeedbackAccounts}, so
 * they agree on which account runs the interview.
 *
 * The login check reads files and never spawns anything. That makes it a guess
 * (an expired token still leaves its files behind), which is why the renderer
 * also falls through to the next account when a first turn fails.
 */

import fs from 'fs/promises';
import { constants as fsConstants } from 'fs';
import os from 'os';
import path from 'path';

import { readClaudeAccountIdentity } from '../agents/claude-account-identity';
import type { AgentDetector } from '../agents';
import {
	getAgentConfigsStore,
	getSessionsStore,
	getSettingsStore,
	getSshRemoteById,
} from '../stores/getters';
import { isInitialized } from '../stores/instances';
import { logger } from '../utils/logger';
import { resolveAgentBillingCredential } from '../../shared/providerProfiles';
import {
	buildFeedbackAccountCandidates,
	orderFeedbackAccounts,
	type FeedbackAccount,
	type FeedbackAccountCandidate,
	type FeedbackAccountSource,
	type FeedbackAccountsResponse,
} from '../../shared/feedbackAccounts';

const LOG_CONTEXT = '[FeedbackAccounts]';

/** Settings key holding the account that last carried a feedback conversation. */
export const FEEDBACK_ACCOUNT_SETTING = 'feedbackAccountKey';

async function isExecutable(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath, fsConstants.X_OK);
		return true;
	} catch {
		return false;
	}
}

async function isReadable(filePath: string): Promise<boolean> {
	try {
		await fs.access(filePath, fsConstants.R_OK);
		return true;
	} catch {
		return false;
	}
}

/**
 * Whether the account's config dir holds a login. A credential in the env (API
 * key, gateway, cloud provider) outranks the login, so it counts as signed in.
 */
async function checkLogin(
	candidate: FeedbackAccountCandidate,
	homeDir: string
): Promise<Pick<FeedbackAccount, 'status' | 'statusDetail'>> {
	const credential = resolveAgentBillingCredential(candidate.toolType, candidate.env);
	if (credential) return { status: 'ready', statusDetail: `Uses ${credential.label}` };

	if (candidate.toolType === 'claude-code') {
		const configDir = candidate.env.CLAUDE_CONFIG_DIR?.trim();
		// With CLAUDE_CONFIG_DIR unset, Claude keeps `.claude.json` in $HOME,
		// not inside `~/.claude`.
		const identity = await readClaudeAccountIdentity(configDir || homeDir);
		if (identity) {
			return {
				status: 'ready',
				statusDetail: identity.email ? `Signed in as ${identity.email}` : 'Signed in',
			};
		}
		return {
			status: 'not-logged-in',
			statusDetail: `No Claude login in ${configDir || path.join(homeDir, '.claude')}`,
		};
	}

	if (candidate.toolType === 'codex') {
		const codexHome = candidate.env.CODEX_HOME?.trim() || path.join(homeDir, '.codex');
		if (await isReadable(path.join(codexHome, 'auth.json'))) {
			return { status: 'ready', statusDetail: 'Signed in' };
		}
		return { status: 'not-logged-in', statusDetail: `No Codex login in ${codexHome}` };
	}

	// OpenCode keeps no per-account dir Maestro can read.
	return { status: 'unknown' };
}

async function checkCandidate(
	candidate: FeedbackAccountCandidate,
	availableToolTypes: ReadonlySet<string>,
	homeDir: string
): Promise<FeedbackAccount> {
	// A remote account is checked by running it: nothing on this disk describes it.
	if (candidate.sshRemoteId) {
		return { ...candidate, status: 'unknown', statusDetail: 'Runs on an SSH remote' };
	}
	const installed = candidate.customPath
		? await isExecutable(candidate.customPath)
		: availableToolTypes.has(candidate.toolType);
	if (!installed) {
		return {
			...candidate,
			status: 'not-installed',
			statusDetail: candidate.customPath
				? `${candidate.customPath} is not executable`
				: 'Not installed on this machine',
		};
	}
	return { ...candidate, ...(await checkLogin(candidate, homeDir)) };
}

function readAgentSources(): FeedbackAccountSource[] {
	const sessions = getSessionsStore().get('sessions', []) ?? [];
	return sessions.map((session) => {
		const ssh = session.sessionSshRemoteConfig;
		const remoteId = ssh?.enabled && typeof ssh.remoteId === 'string' ? ssh.remoteId : null;
		return {
			name: session.name,
			toolType: session.toolType,
			customEnvVars: session.customEnvVars,
			customPath: typeof session.customPath === 'string' ? session.customPath : undefined,
			cwd: ssh?.workingDirOverride || session.cwd,
			sshRemote: remoteId ? { id: remoteId, name: getSshRemoteById(remoteId)?.name } : null,
		};
	});
}

function readProviderEnv(): Record<string, Record<string, string> | undefined> {
	const configs = getAgentConfigsStore().get('configs', {}) ?? {};
	const env: Record<string, Record<string, string> | undefined> = {};
	for (const [toolType, config] of Object.entries(configs)) {
		const vars = config?.customEnvVars;
		if (vars && typeof vars === 'object') env[toolType] = vars as Record<string, string>;
	}
	return env;
}

/** The account that last carried a conversation, if one was recorded. */
export function getLastFeedbackAccountKey(): string | null {
	if (!isInitialized()) return null;
	const value = getSettingsStore().get(FEEDBACK_ACCOUNT_SETTING);
	return typeof value === 'string' && value ? value : null;
}

/**
 * Remember the account the next conversation should try first. The chat calls
 * it after a turn succeeds; `maestro-cli feedback accounts --use` calls it to
 * pick one by hand.
 */
export function rememberFeedbackAccount(key: string | null): void {
	if (!isInitialized()) return;
	getSettingsStore().set(FEEDBACK_ACCOUNT_SETTING, key && key.trim() ? key.trim() : null);
}

/**
 * Every account the feedback chat could run as, checked and ordered. The
 * automatic pick is the first entry that is not `not-installed`.
 */
export async function listFeedbackAccounts(
	getAgentDetector: () => AgentDetector | null
): Promise<FeedbackAccountsResponse> {
	const homeDir = os.homedir();
	const candidates = isInitialized()
		? buildFeedbackAccountCandidates({
				agents: readAgentSources(),
				providerEnvByToolType: readProviderEnv(),
				homeDir,
			})
		: buildFeedbackAccountCandidates({ agents: [], providerEnvByToolType: {}, homeDir });

	const detector = getAgentDetector();
	const available = new Set<string>();
	if (detector) {
		for (const agent of await detector.detectAgents()) {
			if (agent.available) available.add(agent.id);
		}
	} else {
		logger.warn('Agent detector not ready; feedback accounts report as not installed', LOG_CONTEXT);
	}

	const checked = await Promise.all(
		candidates.map((candidate) => checkCandidate(candidate, available, homeDir))
	);
	const remembered = getLastFeedbackAccountKey();
	const lastWorkingKey = checked.some((account) => account.key === remembered) ? remembered : null;
	return { accounts: orderFeedbackAccounts(checked, lastWorkingKey), lastWorkingKey };
}
