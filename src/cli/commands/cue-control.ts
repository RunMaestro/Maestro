/**
 * `maestro-cli cue enable|disable|gate|screen|activity` - the Cue dashboard's
 * per-subscription toggle, the pipeline editor's Gate and injection screen
 * fields, and the activity log, for an agent.
 *
 * `cue schedule --pause/--resume` only reaches clock-driven subscriptions;
 * these reach every event type. The toggle writes the subscription's
 * `enabled` flag into its cue.yaml through the engine, exactly as the UI's
 * switch does, and `cue gate` writes `gate` / `gate_on_unavailable` the same
 * way, as `cue screen` does `screen_injection` / `injection_threshold`.
 */

import { withMaestroClient, type MaestroClient } from '../services/maestro-client';
import {
	errorFrameMessage,
	failCommand,
	resolveAgentOrFail,
	failFromError,
} from '../services/session-command';
import {
	CUE_GATE_ON_UNAVAILABLE,
	DEFAULT_CUE_GATE_ON_UNAVAILABLE,
	cueGateConditionProblem,
	parseCueGateOnUnavailable,
	type CueGateOnUnavailable,
} from '../../shared/cue/gate';
import {
	CUE_INJECTION_SCREEN_MODES,
	DEFAULT_CUE_INJECTION_THRESHOLD,
	cueInjectionThresholdProblem,
	parseCueInjectionScreenMode,
	readCueInjectionScreenSetting,
	type CueInjectionScreenMode,
} from '../../shared/cue/injection-screen';
import type { LocalModelTaskId } from '../../shared/local-models/tasks';
import type { LocalModelTaskReadiness } from '../../shared/local-models/task-readiness';

interface CueSubscriptionSummary {
	id: string;
	name: string;
	eventType: string;
	sessionId: string;
	sessionName: string;
	enabled: boolean;
	gate?: string;
	gateOnUnavailable?: CueGateOnUnavailable;
	screenInjection?: boolean;
	injectionThreshold?: number;
}

interface CueActivityEntry {
	id: string;
	subscriptionId: string;
	subscriptionName: string;
	eventType: string;
	sessionId: string;
	timestamp: number;
	status: 'triggered' | 'running' | 'completed' | 'failed' | 'gated' | 'blocked';
	result?: string;
	duration?: number;
}

interface ToggleOptions {
	agent?: string;
	json?: boolean;
}

interface GateOptions {
	set?: string;
	onUnavailable?: string;
	clear?: boolean;
	agent?: string;
	json?: boolean;
}

interface ScreenOptions {
	mode?: string;
	threshold?: string;
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

/** What `--on-unavailable` means, in the words the trigger panel uses. */
function describeGatePolicy(policy: CueGateOnUnavailable): string {
	return policy === 'skip' ? 'skip the event' : 'start the run and warn';
}

/**
 * Why a Local Models task cannot run right now, or `null` when it can.
 *
 * Best effort: callers ask after a write that already landed, so a readiness
 * call that fails must not turn a good write into a failed command.
 */
async function taskNotReadyReason(
	client: MaestroClient,
	taskId: LocalModelTaskId
): Promise<string | null> {
	try {
		const reply = await client.sendCommand<{ readiness?: LocalModelTaskReadiness[] }>(
			{ type: 'local_models_task_readiness', taskId },
			'local_models_task_readiness_result'
		);
		const verdict = reply.readiness?.find((row) => row.taskId === taskId);
		if (!verdict || verdict.state === 'ready') return null;
		return [verdict.detail, verdict.suggestedAction].filter(Boolean).join(' ');
	} catch {
		return null;
	}
}

/**
 * One line on whether the gate will be CHECKED, or `null` when it will. A
 * gate is two halves: the condition on the subscription, and a model on the
 * `cue-gate` Local Models task. The second is off by default, and a gate
 * without it checks nothing, so a write that reported plain success would
 * leave the caller believing events are being screened.
 */
async function gateReadinessNote(
	client: MaestroClient,
	policy: CueGateOnUnavailable
): Promise<string | null> {
	const reason = await taskNotReadyReason(client, 'cue-gate');
	if (!reason) return null;
	const until =
		policy === 'skip'
			? 'Until it can answer, every event is skipped.'
			: 'Until it can answer, every event starts a run unchecked.';
	return `${reason} ${until}`;
}

/**
 * `cue gate <subscription>` - show, set, or remove a subscription's gate: the
 * plain-language condition a local model checks before an event starts a run.
 * The CLI half of the Gate field on a trigger in the pipeline editor.
 *
 *   cue gate <sub>                                   show the gate
 *   cue gate <sub> --set "<condition>"               set (or replace) it
 *   cue gate <sub> --on-unavailable skip             change only the policy
 *   cue gate <sub> --clear                           remove it
 *
 * A write lands on every subscription that is the same trigger as the one
 * named (a trigger that fans out is several subscriptions), and reports each
 * name it changed.
 */
export async function cueGate(target: string, options: GateOptions): Promise<void> {
	const json = options.json;
	const hasSet = options.set !== undefined;
	const hasPolicy = options.onUnavailable !== undefined;
	if (options.clear && (hasSet || hasPolicy)) {
		failCommand('--clear cannot be combined with --set or --on-unavailable', json);
	}
	if (hasSet) {
		const problem = cueGateConditionProblem(options.set!);
		if (problem) failCommand(`--set: ${problem}`, json);
	}
	let policy: CueGateOnUnavailable | undefined;
	if (hasPolicy) {
		const parsed = parseCueGateOnUnavailable(options.onUnavailable);
		if (!parsed) {
			failCommand(`--on-unavailable must be one of: ${CUE_GATE_ON_UNAVAILABLE.join(', ')}`, json);
		}
		policy = parsed;
	}
	const agentId = options.agent ? resolveAgentOrFail(options.agent, json) : undefined;
	const writing = options.clear === true || hasSet || hasPolicy;

	/** What the bridge round trip produced. `write` is absent for a read. */
	interface GateOutcome {
		sub: CueSubscriptionSummary;
		write?: {
			reply: Record<string, unknown>;
			/** The condition written, or `null` when the gate was removed. */
			condition: string | null;
			policy: CueGateOnUnavailable;
			note: string | null;
		};
	}

	let outcome: GateOutcome;
	try {
		outcome = await withMaestroClient(async (client): Promise<GateOutcome> => {
			const list = await client.sendCommand<{ subscriptions?: CueSubscriptionSummary[] }>(
				{ type: 'get_cue_subscriptions' },
				'cue_subscriptions'
			);
			const sub = resolveSubscription(list.subscriptions ?? [], target, agentId);
			if (!writing) return { sub };

			// Only what was passed is changed: a new condition keeps the policy
			// the gate had, and a new policy keeps its condition.
			let condition: string | null = null;
			if (!options.clear) {
				condition = hasSet ? options.set!.trim() : (sub.gate ?? null);
				if (condition === null) {
					throw new Error(
						`"${sub.name}" has no gate to set a policy on. Pass --set "<condition>" too.`
					);
				}
			}
			const effective = policy ?? sub.gateOnUnavailable ?? DEFAULT_CUE_GATE_ON_UNAVAILABLE;
			const reply = await client.sendCommand<Record<string, unknown>>(
				{
					type: 'set_cue_subscription_gate',
					subscriptionId: sub.id,
					gate: condition,
					...(condition !== null ? { gateOnUnavailable: effective } : {}),
				},
				'set_cue_subscription_gate_result'
			);
			const note =
				condition !== null && reply.success === true && !json
					? await gateReadinessNote(client, effective)
					: null;
			return { sub, write: { reply, condition, policy: effective, note } };
		});
	} catch (error) {
		failFromError(error, json);
	}

	const { sub, write } = outcome;
	if (!write) {
		const effective = sub.gateOnUnavailable ?? DEFAULT_CUE_GATE_ON_UNAVAILABLE;
		if (json) {
			console.log(
				JSON.stringify({
					subscriptionId: sub.id,
					name: sub.name,
					gate: sub.gate ?? null,
					gateOnUnavailable: sub.gate ? effective : null,
				})
			);
		} else if (sub.gate) {
			console.log(`${sub.name} (${sub.sessionName})`);
			console.log(`  gate: ${sub.gate}`);
			console.log(`  if no model can answer: ${describeGatePolicy(effective)}`);
		} else {
			console.log(`${sub.name} (${sub.sessionName}) has no gate. Every event starts a run.`);
		}
		return;
	}

	const frameError = errorFrameMessage(write.reply);
	if (frameError) failCommand(frameError, json);
	const result = write.reply as { success?: boolean; updated?: string[]; error?: string };
	if (result.success !== true) {
		failCommand(result.error || `Could not change the gate on "${sub.name}"`, json);
	}

	const updated = result.updated ?? [sub.name];
	if (json) {
		console.log(
			JSON.stringify({
				success: true,
				subscriptionId: sub.id,
				updated,
				gate: write.condition,
				gateOnUnavailable: write.condition === null ? null : write.policy,
			})
		);
		return;
	}
	const names = updated.join(', ');
	if (write.condition === null) {
		console.log(`Removed the gate from ${names} (${sub.sessionName}).`);
		return;
	}
	console.log(`Gate set on ${names} (${sub.sessionName}): ${write.condition}`);
	console.log(`  if no model can answer: ${describeGatePolicy(write.policy)}`);
	if (write.note) console.log(`Note: ${write.note}`);
}

/** What a screen mode does, in the words the trigger panel uses. */
function describeScreenMode(mode: CueInjectionScreenMode): string {
	if (mode === 'on') return 'on (untrusted text is always screened)';
	if (mode === 'off') return 'off (never screened)';
	return 'auto (commands that use untrusted text are screened)';
}

/**
 * `cue screen <subscription>` - show or set a subscription's prompt-injection
 * screen: whether the untrusted text it substitutes (a comment, an issue
 * body, a webhook payload) is scored by a local classifier before a run
 * starts, and the score that blocks it. The CLI half of the injection screen
 * field on a trigger in the pipeline editor.
 *
 *   cue screen <sub>                       show the screen
 *   cue screen <sub> --mode on             always screen
 *   cue screen <sub> --mode off            never screen
 *   cue screen <sub> --mode auto           back to the default
 *   cue screen <sub> --threshold 0.9       change only the threshold
 *
 * Like `cue gate`, a write lands on every subscription of the named trigger
 * and reports each name it changed.
 */
export async function cueScreen(target: string, options: ScreenOptions): Promise<void> {
	const json = options.json;
	let mode: CueInjectionScreenMode | undefined;
	if (options.mode !== undefined) {
		const parsed = parseCueInjectionScreenMode(options.mode);
		if (!parsed)
			failCommand(`--mode must be one of: ${CUE_INJECTION_SCREEN_MODES.join(', ')}`, json);
		mode = parsed;
	}
	let threshold: number | undefined;
	if (options.threshold !== undefined) {
		threshold = Number(options.threshold);
		const problem = cueInjectionThresholdProblem(threshold);
		if (problem) failCommand(`--threshold: ${problem}`, json);
	}
	if (mode === 'off' && threshold !== undefined) {
		failCommand('--threshold has no effect with --mode off', json);
	}
	const agentId = options.agent ? resolveAgentOrFail(options.agent, json) : undefined;
	const writing = mode !== undefined || threshold !== undefined;

	/** What the bridge round trip produced. `write` is absent for a read. */
	interface ScreenOutcome {
		sub: CueSubscriptionSummary;
		write?: {
			reply: Record<string, unknown>;
			mode: CueInjectionScreenMode;
			threshold: number;
			note: string | null;
		};
	}

	let outcome: ScreenOutcome;
	try {
		outcome = await withMaestroClient(async (client): Promise<ScreenOutcome> => {
			const list = await client.sendCommand<{ subscriptions?: CueSubscriptionSummary[] }>(
				{ type: 'get_cue_subscriptions' },
				'cue_subscriptions'
			);
			const sub = resolveSubscription(list.subscriptions ?? [], target, agentId);
			if (!writing) return { sub };

			// Only what was passed is changed: a new mode keeps the threshold
			// the screen had, and a new threshold keeps its mode.
			const current = readCueInjectionScreenSetting({
				screen_injection: sub.screenInjection,
				injection_threshold: sub.injectionThreshold,
			});
			const nextMode = mode ?? current.mode;
			if (nextMode === 'off' && threshold !== undefined) {
				throw new Error(
					`"${sub.name}" has its screen off, so a threshold would not apply. Pass --mode on or --mode auto too.`
				);
			}
			const nextThreshold = threshold ?? current.threshold ?? DEFAULT_CUE_INJECTION_THRESHOLD;
			const reply = await client.sendCommand<Record<string, unknown>>(
				{
					type: 'set_cue_subscription_injection_screen',
					subscriptionId: sub.id,
					mode: nextMode,
					...(nextMode !== 'off' ? { threshold: nextThreshold } : {}),
				},
				'set_cue_subscription_injection_screen_result'
			);
			const note =
				nextMode !== 'off' && reply.success === true && !json
					? await taskNotReadyReason(client, 'injection-screen')
					: null;
			return { sub, write: { reply, mode: nextMode, threshold: nextThreshold, note } };
		});
	} catch (error) {
		failFromError(error, json);
	}

	const { sub, write } = outcome;
	if (!write) {
		const current = readCueInjectionScreenSetting({
			screen_injection: sub.screenInjection,
			injection_threshold: sub.injectionThreshold,
		});
		const effective = current.threshold ?? DEFAULT_CUE_INJECTION_THRESHOLD;
		if (json) {
			console.log(
				JSON.stringify({
					subscriptionId: sub.id,
					name: sub.name,
					mode: current.mode,
					threshold: current.mode === 'off' ? null : effective,
				})
			);
			return;
		}
		console.log(`${sub.name} (${sub.sessionName})`);
		console.log(`  injection screen: ${describeScreenMode(current.mode)}`);
		if (current.mode !== 'off') console.log(`  blocks at a score of: ${effective}`);
		return;
	}

	const frameError = errorFrameMessage(write.reply);
	if (frameError) failCommand(frameError, json);
	const result = write.reply as { success?: boolean; updated?: string[]; error?: string };
	if (result.success !== true) {
		failCommand(result.error || `Could not change the injection screen on "${sub.name}"`, json);
	}

	const updated = result.updated ?? [sub.name];
	if (json) {
		console.log(
			JSON.stringify({
				success: true,
				subscriptionId: sub.id,
				updated,
				mode: write.mode,
				threshold: write.mode === 'off' ? null : write.threshold,
			})
		);
		return;
	}
	console.log(
		`Injection screen on ${updated.join(', ')} (${sub.sessionName}): ${describeScreenMode(write.mode)}`
	);
	if (write.mode !== 'off') console.log(`  blocks at a score of: ${write.threshold}`);
	if (write.note) {
		// What happens until the classifier is ready depends on the action,
		// which this verb does not see, so both halves of the policy are named.
		console.log(
			`Note: ${write.note} Until it can run, a screened command is blocked and a screened prompt starts unscreened with a warning.`
		);
	}
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
		// A gated or blocked event ran nothing; its `result` is why.
		const skipped = entry.status === 'gated' || entry.status === 'blocked';
		const why = skipped && entry.result ? `  - ${entry.result}` : '';
		console.log(
			`${when}  ${entry.status.padEnd(9)}  ${entry.subscriptionName}  [${entry.eventType}]${took}${why}`
		);
	}
}
