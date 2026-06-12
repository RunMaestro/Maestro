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
import type { AgentConfigsData, SessionsData } from '../stores/types';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { resolveCodexHomeKey, setCodexUsageSnapshot } from '../stores/codexUsageStore';
import { sampleCodexUsage } from './codex-usage-sampler';

const LOG_CONTEXT = '[CodexUsageSampler]';

export interface CodexUsageSamplingDeps {
	// Read-only slice of the sessions store: the sampler only enumerates stored
	// sessions, never writes. Typing it as `Pick<Store<SessionsData>, 'get'>`
	// (rather than a looser `Store<{ sessions: any[] }>`) lets the real store
	// instance assign without an `as unknown as` cast at the call site.
	sessionsStore: Pick<Store<SessionsData>, 'get'>;
	agentConfigsStore: Store<AgentConfigsData>;
	agentDetector: AgentDetector;
}

interface SamplingTarget {
	codexHome: string;
	codexHomeKey: string;
}

const ACCOUNT_DIR_EXCLUDE_RE =
	/(^|[-_.])(backup|bak|old|archive|archived|stage|local|server)([-_.]|$)/i;
const RECOVERABLE_DISCOVERY_ERROR_CODES = new Set(['ENOENT', 'EACCES', 'ENOTDIR']);
const RECOVERABLE_SAMPLE_ERROR_CODES = new Set([
	'ENOENT',
	'EACCES',
	'ENOTDIR',
	'ECONNRESET',
	'ECONNREFUSED',
	'ENOTFOUND',
	'ETIMEDOUT',
	'EAI_AGAIN',
]);

function isLikelyCodexAccountDirName(name: string): boolean {
	return name === '.codex' || name.startsWith('.codex-');
}

function getErrorCode(err: unknown): string | undefined {
	if (!err || typeof err !== 'object' || !('code' in err)) return undefined;
	const code = (err as { code?: unknown }).code;
	return typeof code === 'string' ? code : undefined;
}

function isRecoverableSampleError(err: unknown): boolean {
	const code = getErrorCode(err);
	if (code && RECOVERABLE_SAMPLE_ERROR_CODES.has(code)) return true;
	return err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError');
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
		const code = getErrorCode(err);
		if (!code || !RECOVERABLE_DISCOVERY_ERROR_CODES.has(code)) {
			void captureException(err, {
				operation: 'codexUsage:discoverCodexHomes.readdir',
				homeDir,
			});
			throw err;
		}
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

	const results = await Promise.allSettled(
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
				const error = err instanceof Error ? err : new Error(String(err));
				const context = {
					codexHomeKey: target.codexHomeKey,
					error: error.message,
				};
				if (isRecoverableSampleError(err)) {
					logger.warn('Failed to sample Codex usage snapshot', LOG_CONTEXT, context);
					return;
				}
				logger.warn('Unexpected failure while sampling Codex usage snapshot', LOG_CONTEXT, context);
				void captureException(error, {
					operation: 'codexUsage:runCodexUsageSampling.sample',
					codexHome: target.codexHome,
					codexHomeKey: target.codexHomeKey,
				});
				throw error;
			}
		})
	);

	const unexpectedFailure = results.find(
		(result): result is PromiseRejectedResult => result.status === 'rejected'
	);
	if (unexpectedFailure) {
		throw unexpectedFailure.reason;
	}
}
