/**
 * `maestro-cli cue enable|disable|activity` - the Cue dashboard's per-
 * subscription toggle and its activity log, for an agent.
 *
 * `cue schedule --pause/--resume` only reaches clock-driven subscriptions;
 * these reach every event type. The toggle writes the subscription's
 * `enabled` flag into its cue.yaml through the engine, exactly as the UI's
 * switch does.
 */

import { withMaestroClient } from '../services/maestro-client';
import {
	errorFrameMessage,
	failCommand,
	failFromError,
	resolveAgentOrFail,
} from '../services/session-command';

interface CueSubscriptionSummary {
	id: string;
	name: string;
	eventType: string;
	sessionId: string;
	sessionName: string;
	enabled: boolean;
}

interface CueActivityEntry {
	id: string;
	subscriptionId: string;
	subscriptionName: string;
	eventType: string;
	sessionId: string;
	timestamp: number;
	status: 'triggered' | 'running' | 'completed' | 'failed';
	result?: string;
	duration?: number;
}

interface ToggleOptions {
	agent?: string;
	json?: boolean;
}

interface ActivityOptions {
	agent?: string;
	limit?: string;
	json?: boolean;
}

/**
 * Resolve what the caller typed to one subscription. Accepts the full id
 * (`<agent>::<pipeline>::<name>`, as `cue list --json` prints it) or a name.
 * A name that several agents share is refused unless `--agent` narrows it:
 * toggling the wrong agent's automation is not a guess worth making.
 */
export function resolveSubscription(
	subs: CueSubscriptionSummary[],
	target: string,
	agentId?: string
): CueSubscriptionSummary {
	const byId = subs.find((s) => s.id === target);
	if (byId) return byId;
	const pool = agentId ? subs.filter((s) => s.sessionId === agentId) : subs;
	const matches = pool.filter((s) => s.name === target);
	if (matches.length === 1) return matches[0];
	if (matches.length > 1) {
		const owners = matches.map((s) => `${s.sessionName} (${s.sessionId})`).join(', ');
		throw new Error(
			`"${target}" names ${matches.length} subscriptions (${owners}). Pass --agent or the full id from \`cue list --json\`.`
		);
	}
	throw new Error(`No Cue subscription named "${target}"${agentId ? ` on ${agentId}` : ''}.`);
}

async function setEnabled(target: string, enabled: boolean, options: ToggleOptions): Promise<void> {
	const agentId = options.agent ? resolveAgentOrFail(options.agent, options.json) : undefined;
	let sub: CueSubscriptionSummary;
	let reply: Record<string, unknown>;
	try {
		reply = await withMaestroClient(async (client) => {
			const list = await client.sendCommand<{ subscriptions?: CueSubscriptionSummary[] }>(
				{ type: 'get_cue_subscriptions' },
				'cue_subscriptions'
			);
			sub = resolveSubscription(list.subscriptions ?? [], target, agentId);
			return client.sendCommand<Record<string, unknown>>(
				{ type: 'toggle_cue_subscription', subscriptionId: sub.id, enabled },
				'toggle_cue_subscription_result'
			);
		});
	} catch (error) {
		failFromError(error, options.json);
	}

	const frameError = errorFrameMessage(reply);
	if (frameError) failCommand(frameError, options.json);
	if (reply.success !== true) {
		failCommand(`Could not ${enabled ? 'enable' : 'disable'} "${sub!.name}"`, options.json);
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, subscriptionId: sub!.id, enabled }));
	} else {
		console.log(`${enabled ? 'Enabled' : 'Disabled'} ${sub!.name} (${sub!.sessionName})`);
	}
}

export function cueEnable(target: string, options: ToggleOptions): Promise<void> {
	return setEnabled(target, true, options);
}

export function cueDisable(target: string, options: ToggleOptions): Promise<void> {
	return setEnabled(target, false, options);
}

/** `cue activity` - recent Cue runs, newest first. */
export async function cueActivity(options: ActivityOptions): Promise<void> {
	const sessionId = options.agent ? resolveAgentOrFail(options.agent, options.json) : undefined;
	const limit = options.limit === undefined ? 20 : Number(options.limit);
	if (!Number.isInteger(limit) || limit <= 0) {
		failCommand(`--limit expects a positive integer, got "${options.limit}"`, options.json);
	}

	let reply: { entries?: CueActivityEntry[] } & Record<string, unknown>;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand({ type: 'get_cue_activity', sessionId, limit }, 'cue_activity')
		);
	} catch (error) {
		failFromError(error, options.json);
	}
	const frameError = errorFrameMessage(reply);
	if (frameError) failCommand(frameError, options.json);

	const entries = reply.entries ?? [];
	if (options.json) {
		console.log(JSON.stringify(entries, null, 2));
		return;
	}
	if (entries.length === 0) {
		console.log('No Cue activity.');
		return;
	}
	for (const entry of entries) {
		const when = new Date(entry.timestamp).toLocaleString();
		const took =
			typeof entry.duration === 'number' ? `  ${(entry.duration / 1000).toFixed(1)}s` : '';
		console.log(
			`${when}  ${entry.status.padEnd(9)}  ${entry.subscriptionName}  [${entry.eventType}]${took}`
		);
	}
}
