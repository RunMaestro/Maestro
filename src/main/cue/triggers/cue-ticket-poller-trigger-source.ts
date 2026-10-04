/**
 * Trigger source for `ticket.created` and `ticket.assigned` subscriptions.
 *
 * Adapts `createCueTicketPoller` to the {@link CueTriggerSource} interface,
 * resolves the owning agent's credentials, and routes each ticket through
 * the same filter and SusFactor gates GitHub events pass: a ticket body is
 * text a third party wrote, handed straight to an agent.
 */

import { resolveAgentEnvironment } from '../../../shared/agentEnvironment';
import { getAgentConfigsStore, getSessionsStore, getSettingsStore } from '../../stores/getters';
import { isCueActive } from '../cue-active-state';
import { guardGitHubEvent } from '../cue-susfactor';
import { createCueTicketPoller, DEFAULT_TICKET_POLL_MINUTES } from '../cue-ticket-poller';
import { DEFAULT_CUE_SETTINGS } from '../cue-types';
import type { SessionInfo } from '../../../shared/types';
import { passesFilter } from './cue-trigger-filter';
import type { CueTriggerSource, CueTriggerSourceContext } from './cue-trigger-source';

/**
 * The agent's effective environment over `process.env`.
 *
 * The three Maestro layers merge exactly as a spawn merges them
 * (`resolveAgentEnvironment`), so a key set on the agent wins over the
 * provider default, which wins over Settings -> Environment. `process.env`
 * sits underneath so a key exported in the shell that launched Maestro also
 * works. Read on every poll: a user who adds the key after saving the
 * subscription should not have to restart anything.
 */
export function readTicketCredentialEnv(session: SessionInfo): Record<string, string | undefined> {
	const storedSessions = getSessionsStore().get('sessions', []) as Array<{
		id: string;
		customEnvVars?: Record<string, string>;
	}>;
	const stored = storedSessions.find((s) => s.id === session.id);
	const providerVars = getAgentConfigsStore().get('configs', {})[session.toolType]
		?.customEnvVars as Record<string, string> | undefined;
	const resolved = resolveAgentEnvironment({
		global: getSettingsStore().get('shellEnvVars', {}) as Record<string, string>,
		agent: providerVars,
		session: stored?.customEnvVars,
	});
	const env: Record<string, string | undefined> = { ...process.env };
	for (const entry of resolved) env[entry.key] = entry.value;
	return env;
}

export function createCueTicketPollerTriggerSource(
	ctx: CueTriggerSourceContext
): CueTriggerSource | null {
	const eventType = ctx.subscription.event;
	if (eventType !== 'ticket.created' && eventType !== 'ticket.assigned') return null;

	const provider = ctx.subscription.ticket_provider;
	if (!provider) return null;

	const project = ctx.subscription.ticket_project;
	const subscriptionId = `${ctx.session.id}:${ctx.subscription.name}`;
	let cleanup: (() => void) | null = null;
	let pollNowFn: (() => void) | null = null;

	return {
		start() {
			if (cleanup) return;
			cleanup = createCueTicketPoller({
				eventType,
				provider,
				project,
				pollMinutes: ctx.subscription.poll_minutes ?? DEFAULT_TICKET_POLL_MINUTES,
				triggerName: ctx.subscription.name,
				// Scope is part of the key: pointing a subscription at another
				// team must seed that team, not fire on its whole board.
				seenKey: `${subscriptionId}:${eventType}:${provider}:${project ?? '*'}`,
				getEnv: () => readTicketCredentialEnv(ctx.session),
				onLog: (level, message, data) =>
					ctx.onLog(level as Parameters<typeof ctx.onLog>[0], message, data),
				isActive: isCueActive,
				onEvent: (event) => {
					if (!ctx.enabled()) return;
					if (!passesFilter(ctx.subscription, event, ctx.onLog)) return;

					const settings = ctx.registry.get(ctx.session.id)?.config.settings;
					void guardGitHubEvent({
						event,
						sessionId: ctx.session.id,
						subscriptionId,
						subscriptionName: ctx.subscription.name,
						enabled: settings?.susfactor_enabled !== false,
						threshold:
							settings?.susfactor_threshold ?? DEFAULT_CUE_SETTINGS.susfactor_threshold ?? 0.95,
						onLog: (level, message) => ctx.onLog(level as Parameters<typeof ctx.onLog>[0], message),
					}).then((allowed) => {
						if (!allowed) return;
						ctx.onLog(
							'cue',
							`[CUE] "${ctx.subscription.name}" triggered (${eventType}: ${String(event.payload.ticket_id ?? '')})`
						);
						ctx.emit(event);
					});
				},
				onReady: (handle) => {
					pollNowFn = handle.pollNow;
				},
			});
		},

		stop() {
			cleanup?.();
			cleanup = null;
			pollNowFn = null;
		},

		nextTriggerAt() {
			// Fires whenever a matching ticket appears upstream.
			return null;
		},

		pollNow() {
			pollNowFn?.();
		},
	};
}
