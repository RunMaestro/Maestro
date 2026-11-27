// Agent footprint command: what could be adding to one agent's prompt.
//
// A read-only audit of the instruction files, memory, skills and MCP servers an
// agent has on disk (file-size estimates, activation unknown) beside the text
// Maestro's settings add, sized as configured now. Neither is a measure of what
// a provider loaded: a rebuilt prompt or a saved setting is not a record of
// delivery, so that stays unknown. It needs no running app, writes nothing, and
// its figures are never counted as compression savings. The rules are in
// `src/shared/contextFootprint.ts`; the bounded read is `collectContextFootprint()`.

import { readCallerIdentity } from '../../shared/agentDelegation';
import { formatContextFootprint, type ContextFootprintAudit } from '../../shared/contextFootprint';
import type { SessionInfo } from '../../shared/types';
import { collectContextFootprint, type FootprintTarget } from '../../main/context-footprint';
import { resolveProviderMemoryLayout } from '../../main/memory-manager';
import { resolveCliAgentAccountDir } from '../services/agent-account-dir';
import { getGitCommonDir } from '../services/git-utils';
import { failCommand, failFromError } from '../services/session-command';
import { prepareMaestroSystemPromptCli } from '../services/system-prompt';
import { getSessionById, resolveAgentId } from '../services/storage';

interface AgentFootprintOptions {
	json?: boolean;
}

const SYSTEM_ONE_CAVEAT =
	'The Maestro system prompt was built without asking the desktop app, so the System One section, whose presence depends on desktop state, is not counted.';

/** The Memory Viewer's resolver without the desktop's stores, so both find the same store. */
async function resolveMemory(
	agent: SessionInfo,
	projectRoot: string,
	accountDir: string
): Promise<FootprintTarget['memory']> {
	try {
		return await resolveProviderMemoryLayout(agent.toolType, {
			projectPath: projectRoot,
			accountDir,
			readCommonDirectory: async (cwd) => getGitCommonDir(cwd),
		});
	} catch (error) {
		// A provider with no memory store Maestro can read is an expected answer.
		return { unavailable: error instanceof Error ? error.message : String(error) };
	}
}

async function auditAgent(agent: SessionInfo): Promise<ContextFootprintAudit> {
	const remote = !!(
		agent.sessionSshRemoteConfig?.enabled ||
		('sshRemoteId' in agent && agent.sshRemoteId)
	);
	const projectRoot = agent.projectRoot || agent.cwd;
	const accountDir = remote ? undefined : resolveCliAgentAccountDir(agent);
	const memory =
		!remote && accountDir ? await resolveMemory(agent, projectRoot, accountDir) : undefined;
	const systemPrompt = remote
		? undefined
		: await prepareMaestroSystemPromptCli(agent, {
				readSystemOneAccess: async () => undefined,
			});
	return collectContextFootprint({
		agentId: agent.id,
		agentName: agent.name,
		toolType: agent.toolType,
		projectRoot,
		accountDir,
		memory,
		remote,
		newSessionMessage: agent.newSessionMessage,
		nudgeMessage: agent.nudgeMessage,
		maestroSystemPrompt: systemPrompt
			? { text: systemPrompt, caveat: SYSTEM_ONE_CAVEAT }
			: undefined,
	});
}

export async function agentFootprint(
	agentArg: string | undefined,
	options: AgentFootprintOptions
): Promise<void> {
	const reference = agentArg ?? readCallerIdentity(process.env)?.agentId;
	if (!reference) {
		return failCommand('Name an agent: maestro-cli agent footprint <agent-id>', options.json);
	}
	let agent: SessionInfo | undefined;
	try {
		agent = getSessionById(resolveAgentId(reference));
	} catch (error) {
		return failFromError(error, options.json);
	}
	if (!agent) return failCommand(`Agent not found: ${reference}`, options.json);

	let audit: ContextFootprintAudit;
	try {
		audit = await auditAgent(agent);
	} catch (error) {
		return failFromError(error, options.json);
	}
	if (options.json) {
		console.log(JSON.stringify({ success: true, ...audit }, null, 2));
		return;
	}
	console.log(formatContextFootprint(audit));
}
