/**
 * Codex Usage Manual Sampler
 *
 * Builds one quota sampling target per CODEX_HOME referenced by Codex sessions
 * or agent-level custom env vars, then persists the snapshots for the Usage
 * Dashboard. Unlike Claude, Codex sampling is an HTTP metadata request rather
 * than a TUI screen scrape, so the dashboard can refresh it on demand.
 */

import os from 'os';
import path from 'path';
import * as fs from 'fs';
import Store from 'electron-store';

import type { AgentDetector } from './detector';
import type { AgentConfigsData } from '../stores/types';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { resolveCodexHomeKey, setCodexUsageSnapshot } from '../stores/codexUsageStore';
import { sampleCodexUsage } from './codex-usage-sampler';

const LOG_CONTEXT = '[CodexUsageSampler]';

export interface CodexUsageSamplingDeps {
	sessionsStore: Store<{ sessions: any[] }>;
	agentConfigsStore: Store<AgentConfigsData>;
	agentDetector: AgentDetector;
}

interface SamplingTarget {
	codexHome: string;
	codexHomeKey: string;
}

const ACCOUNT_DIR_EXCLUDE_RE =
	/(^|[-_.])(backup|bak|old|archive|archived|stage|local|server)([-_.]|$)/i;

function isLikelyCodexAccountDirName(name: string): boolean {
	return name === '.codex' || name.startsWith('.codex-');
}

/**
 * Discover local Codex account homes, mirroring `/token-cockpit` setups where
 * each OAuth account has its own `CODEX_HOME`.
 */
export async function discoverCodexHomes(homeDir = os.homedir()): Promise<string[]> {
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(homeDir, { withFileTypes: true });
	} catch (err) {
		logger.warn('Failed to discover Codex homes', LOG_CONTEXT, {
			homeDir,
			error: err instanceof Error ? err.message : String(err),
		});
		return [];
	}

	const homes: string[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		if (!isLikelyCodexAccountDirName(entry.name)) continue;
		if (ACCOUNT_DIR_EXCLUDE_RE.test(entry.name)) continue;
		const codexHome = path.join(homeDir, entry.name);
		const authPath = path.join(codexHome, 'auth.json');
		try {
			await fs.promises.access(authPath, fs.constants.R_OK);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			if (code === 'ENOENT' || code === 'EACCES') {
				continue;
			}
			void captureException(err, {
				operation: 'codexUsage:discoverCodexHomes.access',
				codexHome,
				authPath,
			});
			throw err;
		}
		homes.push(codexHome);
	}

	return homes.sort((a, b) => a.localeCompare(b));
}

function getAgentLevelEnvVars(agentConfigsStore: Store<AgentConfigsData>): Record<string, string> {
	const configs = agentConfigsStore.get('configs', {});
	const envVars = configs['codex']?.customEnvVars;
	return envVars && typeof envVars === 'object' ? (envVars as Record<string, string>) : {};
}

function buildTarget(
	session: Record<string, unknown>,
	agentLevelEnvVars: Record<string, string>
): SamplingTarget {
	const sessionEnvVars =
		session.customEnvVars && typeof session.customEnvVars === 'object'
			? (session.customEnvVars as Record<string, string>)
			: {};
	const merged = { ...agentLevelEnvVars, ...sessionEnvVars };
	const configuredCodexHome =
		typeof merged.CODEX_HOME === 'string' && merged.CODEX_HOME.length > 0
			? merged.CODEX_HOME
			: null;
	const codexHome = configuredCodexHome ?? path.join(os.homedir(), '.codex');
	const codexHomeKey = resolveCodexHomeKey({ CODEX_HOME: codexHome });
	return { codexHome, codexHomeKey };
}

export async function runCodexUsageSampling(deps: CodexUsageSamplingDeps): Promise<void> {
	const codexAgent = await deps.agentDetector.getAgent('codex');
	if (!codexAgent) {
		logger.warn('Skipping Codex usage sampling: codex agent not detected', LOG_CONTEXT);
		return;
	}

	const storedSessions = deps.sessionsStore.get('sessions', []) as Array<Record<string, unknown>>;
	const codexSessions = storedSessions.filter((s) => s?.toolType === 'codex');
	const agentLevelEnvVars = getAgentLevelEnvVars(deps.agentConfigsStore);

	const targetsByKey = new Map<string, SamplingTarget>();
	for (const session of codexSessions) {
		const target = buildTarget(session, agentLevelEnvVars);
		if (!targetsByKey.has(target.codexHomeKey)) {
			targetsByKey.set(target.codexHomeKey, target);
		}
	}

	for (const codexHome of await discoverCodexHomes()) {
		const codexHomeKey = resolveCodexHomeKey({ CODEX_HOME: codexHome });
		if (!targetsByKey.has(codexHomeKey)) {
			targetsByKey.set(codexHomeKey, { codexHome, codexHomeKey });
		}
	}

	if (targetsByKey.size === 0) {
		const configuredFallbackHome =
			typeof agentLevelEnvVars.CODEX_HOME === 'string' && agentLevelEnvVars.CODEX_HOME.length > 0
				? agentLevelEnvVars.CODEX_HOME
				: null;
		const fallbackHome = configuredFallbackHome ?? path.join(os.homedir(), '.codex');
		const fallbackKey = resolveCodexHomeKey({ CODEX_HOME: fallbackHome });
		targetsByKey.set(fallbackKey, { codexHome: fallbackHome, codexHomeKey: fallbackKey });
	}

	logger.info(`Sampling Codex usage for ${targetsByKey.size} account(s)`, LOG_CONTEXT, {
		accounts: Array.from(targetsByKey.keys()),
	});

	await Promise.all(
		Array.from(targetsByKey.values()).map(async (target) => {
			try {
				const snapshot = await sampleCodexUsage({ codexHome: target.codexHome });
				setCodexUsageSnapshot(snapshot);
				logger.info('Stored Codex usage snapshot', LOG_CONTEXT, {
					codexHomeKey: snapshot.codexHomeKey,
					authState: snapshot.authState,
					sessionPercent: snapshot.session?.percent,
					weeklyPercent: snapshot.weekly?.percent,
				});
			} catch (err) {
				logger.warn('Failed to sample Codex usage snapshot', LOG_CONTEXT, {
					codexHomeKey: target.codexHomeKey,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		})
	);
}
