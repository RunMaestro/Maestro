/**
 * A headless `maestro-cli host` answering `get_project_token_usage`: the token usage of its agents'
 * conversations, computed here where the transcripts are, for a desktop whose Usage Dashboard
 * counts its SSH and hosted agents (`src/shared/projectTokenUsage.ts`).
 *
 * The numbers come from the desktop's own session storages and `projectTokenUsage()`
 * (`src/main/stats/token-usage/project-breakdowns.ts`), so a conversation adds up to the same
 * totals on either host kind. Each storage streams its transcripts and keeps an unchanged one in
 * its fingerprint cache, so a repeat ask parses nothing new.
 *
 * Plain Node can load only the storages that need no SQLite: Claude Code and Codex. A project of
 * any other provider is answered as `unsupportedProviders`, and the desktop names that agent as not
 * counted. Everything is loaded on the first ask (a dynamic `import()`), so a host that is never
 * asked, and every other CLI verb, never loads a storage.
 */

import {
	MAX_PROJECT_TOKEN_USAGE_PROJECTS,
	PROJECT_TOKEN_USAGE_MESSAGE,
	PROJECT_TOKEN_USAGE_FAILED,
	parseProjectTokenUsageRequest,
	projectTokenUsageFailureFrame,
	projectTokenUsageReplyFrame,
	type ProjectTokenUsage,
	type ProjectTokenUsageProject,
} from '../../shared/projectTokenUsage';
import type { ProjectSessionStorage } from '../../main/stats/token-usage/project-breakdowns';
import type { ClaudeSessionOriginsData } from '../../main/storage/claude-session-storage';
import type { MaestroClient } from '../../shared/maestro-lib/client/types';
import { readAgentConfigsStoreFile } from '../../main/stores/agent-configs-store-file';

/** Reads the usage of projects on this machine. */
export type ProjectTokenUsageReader = (
	projects: readonly ProjectTokenUsageProject[]
) => Promise<ProjectTokenUsage>;

/** Answers the message, or `undefined` for any other message (the server then echoes it). */
export type HostTokenUsageAnswer = (
	message: Record<string, unknown>
) => Promise<Record<string, unknown> | undefined>;

/**
 * What a headless host knows about its accounts: its stored agents (an agent's own
 * `CLAUDE_CONFIG_DIR` or `CODEX_HOME`), each provider's `customEnvVars`, and Settings ->
 * Environment. The desktop reads these from its stores; a headless host has no desktop stores, so
 * it hands them to account discovery itself. Without them an account set only there (a config dir
 * outside `$HOME`) would never be read.
 */
export interface HeadlessAccountSources {
	sessions: Array<Record<string, unknown>>;
	globalShellEnvVars: Record<string, string>;
	agentLevelEnvVars(toolType: string): Record<string, string>;
}

/** A string-to-string map from an untrusted settings value, or an empty one. */
function stringMap(value: unknown): Record<string, string> {
	if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
	return Object.fromEntries(
		Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
	);
}

/**
 * The account sources of a running headless host: its runtime's agents and settings, and its agent
 * configs file. Throws when one cannot be read: an account named only there would be missed, and
 * the answer would look whole while it is short, so the read fails and the peer names its agents.
 * An absent configs file is not a failure (the reader returns no configs for it).
 */
export async function headlessAccountSources(
	runtime: Pick<MaestroClient, 'agents' | 'settings'>,
	productionDataDir: string
): Promise<HeadlessAccountSources> {
	const [agents, settings] = await Promise.all([
		runtime.agents.list(),
		runtime.settings.get(['shellEnvVars']),
	]);
	if (!agents.ok) throw new Error('Could not read the stored agents for account discovery.');
	if (!settings.ok) throw new Error('Could not read the settings for account discovery.');
	const configs: Record<string, Record<string, unknown>> = readAgentConfigsStoreFile(
		productionDataDir
	).configs;
	return {
		sessions: agents.value as unknown as Array<Record<string, unknown>>,
		globalShellEnvVars: stringMap(settings.value.shellEnvVars),
		agentLevelEnvVars: (toolType) => stringMap(configs[toolType]?.customEnvVars),
	};
}

/**
 * The reader a headless host uses: the Claude Code and Codex storages, built once on the first ask,
 * and this machine's account dirs, found with the host's own account sources.
 */
export function createHeadlessTokenUsageReader(
	accountSources: () => Promise<HeadlessAccountSources>
): ProjectTokenUsageReader {
	let loaded: Promise<ProjectTokenUsageReader> | undefined;
	const load = async (): Promise<ProjectTokenUsageReader> => {
		const [breakdowns, claude, codex, accounts, { default: Store }] = await Promise.all([
			import('../../main/stats/token-usage/project-breakdowns'),
			import('../../main/storage/claude-session-storage'),
			import('../../main/storage/codex-session-storage'),
			// The rule with no stores: a headless host hands in its own sources.
			import('../../main/agents/provider-account-dirs-core'),
			import('electron-store'),
		]);
		const origins = new Store<ClaudeSessionOriginsData>({
			name: 'claude-session-origins',
			defaults: { origins: {} },
		});
		// Only these two: every other storage needs SQLite, which plain Node cannot load.
		const storages = new Map<string, ProjectSessionStorage>([
			['claude-code', new claude.ClaudeSessionStorage(origins)],
			['codex', new codex.CodexSessionStorage(origins)],
		]);
		// This host parses inline on its own event loop: a repeat ask during a long cold parse joins
		// it, and at most SESSION_LIST_CONCURRENCY listings run at once.
		const gate = breakdowns.createSessionListGate();
		return async (projects) => {
			const sources = await accountSources();
			return breakdowns.projectTokenUsage(projects, {
				storageFor: (agentType) => storages.get(agentType) ?? null,
				gate,
				accountDirsFor: (agentType) =>
					accounts.findProviderAccountDirs(agentType, {
						sessions: sources.sessions,
						globalShellEnvVars: sources.globalShellEnvVars,
						agentLevelEnvVars: sources.agentLevelEnvVars(agentType),
					}),
			});
		};
	};
	return async (projects) => {
		loaded ??= load();
		loaded.catch(() => {
			loaded = undefined;
		});
		return (await loaded)(projects);
	};
}

export interface HostTokenUsageAnswerOptions {
	/** The host's own log: where a failed read's detail goes, since the wire carries none. */
	log?(line: string): void;
}

/**
 * The host's answer to `get_project_token_usage`, over `read`. A failed read answers a generic
 * error: its message can name this machine's paths, so the detail goes only to the host's log.
 */
export function createHostTokenUsageAnswer(
	read: ProjectTokenUsageReader,
	options: HostTokenUsageAnswerOptions = {}
): HostTokenUsageAnswer {
	return async (message) => {
		if (message.type !== PROJECT_TOKEN_USAGE_MESSAGE) return undefined;
		const projects = parseProjectTokenUsageRequest(message);
		if (!projects) {
			return projectTokenUsageFailureFrame(
				`Name 1 to ${MAX_PROJECT_TOKEN_USAGE_PROJECTS} projects, each with a provider and a path.`
			);
		}
		try {
			return projectTokenUsageReplyFrame(await read(projects));
		} catch (error) {
			options.log?.(
				`Token usage read failed: ${error instanceof Error ? error.message : String(error)}`
			);
			return projectTokenUsageFailureFrame(PROJECT_TOKEN_USAGE_FAILED);
		}
	};
}
