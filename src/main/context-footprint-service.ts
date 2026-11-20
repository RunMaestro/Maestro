/** Stored-agent scope for the on-demand, read-only context audit. */
import path from 'path';
import { isValidAgentId, type SessionInfo } from '../shared/types';
import type { ContextFootprintAudit } from '../shared/contextFootprint';
import { prepareMaestroSystemPromptCli } from '../cli/services/system-prompt';
import { collectContextFootprint, type FootprintTarget } from './context-footprint';
import { resolveAgentAccountDir } from './agents/provider-account-dirs';
import { resolveMemoryLayout } from './memory-location';
import { getLiveSessions } from './stores/getters';
import { execGitReadOnly } from './utils/remote-git';

/** The only input is an exact stored identity, never renderer-supplied paths or environment. */
export async function auditStoredAgentContextFootprint(
	agentId: string
): Promise<ContextFootprintAudit> {
	if (typeof agentId !== 'string' || !agentId.trim()) {
		throw new Error('A stored agent ID is required for a context audit');
	}
	const sessions = getLiveSessions();
	const stored = sessions.find((session) => session.id === agentId);
	if (!stored) throw new Error('The selected agent is no longer available');
	if (!isValidAgentId(stored.toolType) || stored.toolType === 'terminal') {
		throw new Error('Context audits require a supported AI agent');
	}
	const projectRoot = stored.projectRoot || stored.cwd;
	if (typeof projectRoot !== 'string') throw new Error('The agent has no project root');
	const target: FootprintTarget = {
		agentId: stored.id,
		agentName: stored.name,
		toolType: stored.toolType,
		projectRoot,
		remote: !!(stored.sessionSshRemoteConfig?.enabled || stored.sshRemoteId),
		newSessionMessage: stored.newSessionMessage,
		nudgeMessage: stored.nudgeMessage,
	};
	// Both remote identities veto every local resolver and prompt build. Even a
	// Git query in a path that happens to exist here would concern the wrong host.
	if (target.remote) return collectContextFootprint(target);

	target.accountDir = resolveAgentAccountDir(agentId, { sessions });
	if (path.isAbsolute(projectRoot)) {
		try {
			target.memory = await resolveMemoryLayout({
				agentId,
				projectPath: projectRoot,
				toolType: stored.toolType,
			});
		} catch (error) {
			target.memory = { unavailable: error instanceof Error ? error.message : String(error) };
		}
	}
	if (typeof stored.cwd === 'string' && path.isAbsolute(stored.cwd)) {
		// Reuse the CLI's read-only assembly rather than the spawn builder, which
		// consults runtime readiness services. Supply bounded async Git facts so
		// its synchronous CLI probes never block the main process for this audit.
		const git = await execGitReadOnly(['rev-parse', '--abbrev-ref', 'HEAD'], stored.cwd);
		const text = await prepareMaestroSystemPromptCli(
			{ ...stored, toolType: stored.toolType, projectRoot },
			{
				readAgents: () => sessions as SessionInfo[],
				readSystemOneAccess: async () => undefined,
				gitInfo: { isRepo: git.exitCode === 0, branch: git.stdout.trim() || undefined },
			}
		);
		if (text) {
			target.maestroSystemPrompt = {
				text,
				caveat:
					'Configured-text preview assembled from the stored agent and saved prompt settings. Runtime-dependent System One text is omitted; saved settings may lag a pending desktop write. This does not prove delivery or current context-window membership.',
			};
		}
	}
	return collectContextFootprint(target);
}
