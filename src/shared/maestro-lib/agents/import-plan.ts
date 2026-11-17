/**
 * One rule for an `import_agent` (Federation lift) on any host: the checks an imported agent must
 * pass against the host's own agents, groups and filesystem, then the record it is stored as.
 *
 * Two hosts answer `import_agent`: the headless host (`maestro-cli host`, through the repository)
 * and the desktop app (`src/main/federation/import-agent.ts`, when the remote runs Maestro itself).
 * Both call this, so the refusals and the stored record cannot drift between them. What differs is
 * only where the record is written.
 */

import type { AgentImportInput } from '../client/types';
import { unusableCwdReason } from '../launch/cwd';
import type { AgentRecord } from '../store/records';
import { liftSessionDirProblem } from './lift-env';
import {
	buildImportedAgentRecord,
	checkAgentImportInput,
	DEFAULT_RULE_CONTEXT,
	validateNewAgent,
	type RuleContext,
	type TabDefaults,
	type ValidatedAgent,
} from './rules';

export interface AgentImportPlanContext {
	/** The host's agents, for the duplicate-name and same-directory checks. */
	agents: readonly ValidatedAgent[];
	/** The host's group ids. An import into a group the host lacks is refused. */
	groupIds: readonly string[];
	/** The host's new-tab defaults, read from its settings. */
	defaults: TabDefaults;
	ctx?: RuleContext;
	/** Why a working directory cannot be used here, or null. Defaults to the spawn check. */
	checkCwd?: (cwd: string) => string | null;
}

export type AgentImportPlan =
	| { ok: true; agent: AgentRecord }
	| { ok: false; code: 'invalid' | 'rejected' | 'not-found'; message: string };

/**
 * The record `input` is stored as on this host, or why it is refused. Nothing is written: the
 * caller stores the record the way its host stores agents.
 */
export function planAgentImport(
	input: AgentImportInput,
	context: AgentImportPlanContext
): AgentImportPlan {
	const checked = checkAgentImportInput(input);
	if (!checked.ok) return checked;

	const validation = validateNewAgent(checked.value.name, checked.value.cwd, context.agents, null);
	if (!validation.valid) {
		return {
			ok: false,
			code: 'invalid',
			message: validation.error ?? 'The agent cannot be imported.',
		};
	}
	const groupId = input.agent.groupId;
	if (groupId && !context.groupIds.includes(groupId)) {
		return { ok: false, code: 'not-found', message: `No group ${groupId}.` };
	}
	// The same check `create` applies to a local agent: the agent runs here, so its directory
	// must be here.
	const reason = (context.checkCwd ?? unusableCwdReason)(checked.value.cwd);
	if (reason) return { ok: false, code: 'invalid', message: reason };
	// The tabs resume provider sessions from the dir the agent's env selects. A dir the host lacks
	// would start new sessions silently, so refuse instead.
	const sessionDir = liftSessionDirProblem(input.agent.provider, input.agent.env);
	if (sessionDir) return { ok: false, code: 'invalid', message: sessionDir };

	return {
		ok: true,
		agent: buildImportedAgentRecord(
			input,
			checked.value,
			context.ctx ?? DEFAULT_RULE_CONTEXT,
			context.defaults
		),
	};
}
