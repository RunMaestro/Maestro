/**
 * Where each setting of a hosted agent lives, for `maestro-cli show agent`: the facts the Edit
 * Agent badges draw (From host, Yours only, This machine, Not synced yet, Pending, Conflict).
 *
 * The scope of every field comes from the tables in `lift-settings-sync.ts`, so it is known here
 * without the desktop. What waits on a field (an edit the host has not taken, a conflict) lives in
 * the desktop window that runs the settings sync, so it is asked for through the bridge. With no
 * desktop to ask, the block still carries every scope, and `stateKnown` says the rest is unknown.
 */

import {
	describeFederationFields,
	FEDERATION_SCOPE_LABELS,
	type FederationFieldId,
	type FederationFieldScope,
	type FederationFieldStatus,
} from '../../shared/maestro-lib/agents/lift-settings-sync';
import { peerAgentRef } from '../../shared/maestro-lib/agents/lift-pointer';
import {
	FEDERATION_COMMAND,
	FEDERATION_COMMAND_RESULT,
	type FederationCommandResult,
} from '../../shared/federationCommands';
import { withMaestroClient } from './maestro-client';

/** One setting in `show agent --json`'s `federation.fields`. */
export interface FederationFieldReport {
	scope: FederationFieldScope;
	/** What the badge says. */
	label: string;
	why: string;
	pending: boolean;
	conflict: boolean;
}

/** `show agent --json`'s `federation` block. */
export interface AgentFederationReport {
	/** The hosted agent, `peer:agentId`: where its shared settings live. */
	host: string;
	/** False when the desktop could not say what waits; `pending` and `conflict` read false then. */
	stateKnown: boolean;
	/** Why the state is unknown. */
	stateError?: string;
	fields: Partial<Record<FederationFieldId, FederationFieldReport>>;
}

function toReport(
	host: string,
	statuses: readonly FederationFieldStatus[],
	stateKnown: boolean,
	stateError?: string
): AgentFederationReport {
	const fields: AgentFederationReport['fields'] = {};
	for (const status of statuses) {
		fields[status.field] = {
			scope: status.scope,
			label: FEDERATION_SCOPE_LABELS[status.scope],
			why: status.why,
			pending: status.pending,
			conflict: status.conflict,
		};
	}
	return { host, stateKnown, ...(stateError ? { stateError } : {}), fields };
}

/** The `federation` block of one hosted agent, by its host's peer id and agent id. */
export async function readAgentFederation(
	peerId: string,
	agentId: string
): Promise<AgentFederationReport> {
	const host = peerAgentRef(peerId, agentId);
	try {
		const reply = await withMaestroClient((client) =>
			client.sendCommand<FederationCommandResult & { type: string }>(
				{ type: FEDERATION_COMMAND, action: 'settings-fields', agent: host },
				FEDERATION_COMMAND_RESULT
			)
		);
		if (reply.success && reply.fields) return toReport(host, reply.fields, true);
		return toReport(host, describeFederationFields(), false, reply.error);
	} catch (error) {
		return toReport(
			host,
			describeFederationFields(),
			false,
			error instanceof Error ? error.message : String(error)
		);
	}
}
