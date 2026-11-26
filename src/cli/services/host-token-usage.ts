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
	PROJECT_TOKEN_USAGE_MESSAGE,
	parseProjectTokenUsageRequest,
	projectTokenUsageFailureFrame,
	projectTokenUsageReplyFrame,
	type ProjectTokenUsage,
	type ProjectTokenUsageProject,
} from '../../shared/projectTokenUsage';
import type { AgentSessionStorage } from '../../main/agents/session-storage';
import type { ClaudeSessionOriginsData } from '../../main/storage/claude-session-storage';

/** Reads the usage of projects on this machine. */
export type ProjectTokenUsageReader = (
	projects: readonly ProjectTokenUsageProject[]
) => Promise<ProjectTokenUsage>;

/** Answers the message, or `undefined` for any other message (the server then echoes it). */
export type HostTokenUsageAnswer = (
	message: Record<string, unknown>
) => Promise<Record<string, unknown> | undefined>;

/**
 * The reader a headless host uses: the Claude Code and Codex storages, built once on the first ask,
 * and this machine's account dirs.
 */
export function createHeadlessTokenUsageReader(): ProjectTokenUsageReader {
	let loaded: Promise<ProjectTokenUsageReader> | undefined;
	const load = async (): Promise<ProjectTokenUsageReader> => {
		const [{ projectTokenUsage }, claude, codex, accounts, { default: Store }] = await Promise.all([
			import('../../main/stats/token-usage/project-breakdowns'),
			import('../../main/storage/claude-session-storage'),
			import('../../main/storage/codex-session-storage'),
			import('../../main/agents/provider-account-dirs'),
			import('electron-store'),
		]);
		const origins = new Store<ClaudeSessionOriginsData>({
			name: 'claude-session-origins',
			defaults: { origins: {} },
		});
		// Only these two: every other storage needs SQLite, which plain Node cannot load.
		const storages = new Map<string, Pick<AgentSessionStorage, 'listSessions'>>([
			['claude-code', new claude.ClaudeSessionStorage(origins)],
			['codex', new codex.CodexSessionStorage(origins)],
		]);
		return (projects) =>
			projectTokenUsage(projects, {
				storageFor: (agentType) => storages.get(agentType) ?? null,
				accountDirsFor: (agentType) => accounts.getProviderAccountDirs(agentType),
			});
	};
	return async (projects) => {
		loaded ??= load();
		loaded.catch(() => {
			loaded = undefined;
		});
		return (await loaded)(projects);
	};
}

/** The host's answer to `get_project_token_usage`, over `read`. */
export function createHostTokenUsageAnswer(read: ProjectTokenUsageReader): HostTokenUsageAnswer {
	return async (message) => {
		if (message.type !== PROJECT_TOKEN_USAGE_MESSAGE) return undefined;
		const projects = parseProjectTokenUsageRequest(message);
		if (projects.length === 0) {
			return projectTokenUsageFailureFrame('Name at least one project (provider and path).');
		}
		try {
			return projectTokenUsageReplyFrame(await read(projects));
		} catch (error) {
			return projectTokenUsageFailureFrame(
				`Failed to read token usage: ${error instanceof Error ? error.message : String(error)}`
			);
		}
	};
}
