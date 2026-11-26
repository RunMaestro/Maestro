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
	/**
	 * The host's agents, for the duplicate-name and same-directory checks, and the marker a copy
	 * to replace must carry (`liftedFromAgentId`).
	 */
	agents: readonly ImportHostAgent[];
	/** The host's group ids. An import into a group the host lacks is refused. */
	groupIds: readonly string[];
	/** The host's new-tab defaults, read from its settings. */
	defaults: TabDefaults;
	ctx?: RuleContext;
	/** Why a working directory cannot be used here, or null. Defaults to the spawn check. */
	checkCwd?: (cwd: string) => string | null;
}

/** A host agent as the import reads it. */
export type ImportHostAgent = ValidatedAgent & { liftedFromAgentId?: unknown };

/** The longest agent id the marker may hold: ids are generated, never prose. */
const MAX_LIFTED_FROM_ID_CHARS = 200;

/**
 * Why `copy` is not the stale copy of the agent an import moves, or null when it is: it must carry
 * the marker of that same agent (`liftedFromAgentId`, stored when it was imported) and the same
 * name. One rule for the host that replaces and the client that asks it to (`runLift()`).
 */
export function staleCopyMismatch(
	copy: { id: string; name: string; liftedFromAgentId?: unknown },
	moving: { name: string; liftedFromAgentId?: unknown }
): string | null {
	const wanted = typeof moving.liftedFromAgentId === 'string' ? moving.liftedFromAgentId : '';
	if (!wanted) {
		return `The move does not say which agent it is, so the copy ${copy.id} is not replaced.`;
	}
	if (typeof copy.liftedFromAgentId !== 'string' || !copy.liftedFromAgentId) {
		return `The copy ${copy.id} carries no record of the agent it was moved from, so it is not replaced.`;
	}
	if (copy.liftedFromAgentId !== wanted) {
		return `The copy ${copy.id} was moved from another agent, so it is not replaced.`;
	}
	if (copy.name.trim().toLowerCase() !== moving.name.trim().toLowerCase()) {
		return `The copy ${copy.id} is named "${copy.name}", not "${moving.name}", so it is not replaced.`;
	}
	return null;
}

export type AgentImportPlan =
	| {
			ok: true;
			agent: AgentRecord;
			/**
			 * The host agent this import replaces (`AgentImportInput.replacesAgentId`): the caller
			 * removes it in the same write that stores `agent`. Absent: nothing is replaced.
			 */
			replaces?: string;
	  }
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
	const liftedFrom = input.liftedFromAgentId;
	if (
		liftedFrom !== undefined &&
		(typeof liftedFrom !== 'string' || !liftedFrom || liftedFrom.length > MAX_LIFTED_FROM_ID_CHARS)
	) {
		return { ok: false, code: 'invalid', message: 'The id of the moved agent is not valid.' };
	}

	// The agent's own earlier copy (left by a Move Back while this host was down) is replaced, so
	// its name and directory are not a conflict. A copy already gone replaces nothing. The copy
	// must be that agent's (`staleCopyMismatch()`): a wrong id from the client never removes
	// another agent. Any other agent with the name still refuses the import.
	const copy =
		typeof input.replacesAgentId === 'string' && input.replacesAgentId
			? context.agents.find((agent) => agent.id === input.replacesAgentId)
			: undefined;
	if (copy) {
		const mismatch = staleCopyMismatch(copy, {
			name: checked.value.name,
			liftedFromAgentId: liftedFrom,
		});
		if (mismatch) {
			return {
				ok: false,
				code: 'rejected',
				message: `${mismatch} Remove it from the machine you move from (maestro-cli remove-agent <peer>:${copy.id}), then move again.`,
			};
		}
	}
	const replaces = copy?.id;
	const others = replaces
		? context.agents.filter((agent) => agent.id !== replaces)
		: context.agents;
	const validation = validateNewAgent(checked.value.name, checked.value.cwd, others, null);
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

	const agent = buildImportedAgentRecord(
		input,
		checked.value,
		context.ctx ?? DEFAULT_RULE_CONTEXT,
		context.defaults
	);
	return {
		ok: true,
		// The marker a later lift of the same agent is checked against.
		agent: liftedFrom ? { ...agent, liftedFromAgentId: liftedFrom } : agent,
		...(replaces ? { replaces } : {}),
	};
}
