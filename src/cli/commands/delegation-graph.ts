// Delegation graph command - print the fleet's peer relationships as one
// directed graph: who may consult whom, and who may delegate to whom.
//
// The read half of the Delegation Graph. It builds the model the canvas draws
// (`buildDelegationGraph`) from the stored agents, so the listing cannot
// disagree with the graph, and it needs no running app. An edge is written with
// `update-agent --peer` / `--remove-peer`; this verb has no drawing mode.

import { readGroups, readSessions, resolveGroupId } from '../services/storage';
import { failCommand, failFromError } from '../services/session-command';
import { formatDelegationGraph } from '../output/formatter';
import {
	buildDelegationGraph,
	delegationAdjacency,
	delegationGraphStats,
	type DelegationGraphScope,
} from '../../shared/delegationGraph';

interface DelegationGraphOptions {
	group?: string;
	json?: boolean;
}

export function delegationGraph(options: DelegationGraphOptions): void {
	// The same resolver `open delegation-graph --group` uses, so the two verbs
	// take the same ids (a full id, or a unique prefix of one).
	let group: { id: string; name: string; emoji?: string } | null = null;
	if (options.group !== undefined) {
		let groupId: string;
		try {
			groupId = resolveGroupId(options.group);
		} catch (error) {
			return failFromError(error, options.json);
		}
		const stored = readGroups().find((candidate) => candidate.id === groupId);
		if (!stored) return failCommand(`Group not found: ${options.group}`, options.json);
		group = { id: stored.id, name: stored.name, ...(stored.emoji ? { emoji: stored.emoji } : {}) };
	}

	const scope: DelegationGraphScope = group
		? { kind: 'group', groupId: group.id }
		: { kind: 'all' };
	const model = buildDelegationGraph(scope, readSessions());
	const stats = delegationGraphStats(model);

	if (options.json) {
		// `nodes` and `edges` are the model as it is built, with nothing renamed.
		console.log(JSON.stringify({ success: true, scope, group, stats, ...model }, null, 2));
		return;
	}
	console.log(formatDelegationGraph({ group, stats, agents: delegationAdjacency(model) }));
}
