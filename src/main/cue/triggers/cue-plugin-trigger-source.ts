import {
	CUE_EVENT_TYPES,
	type CueEvent,
	type CuePluginSource,
} from '../../../shared/cue/contracts';
import { PluginAuthorityError } from '../../plugins/plugin-authority';
import { parseCuePluginSource } from '../../../shared/plugins/plugin-json';
export { parseCuePluginSource } from '../../../shared/plugins/plugin-json';
import type { CueTriggerSource, CueTriggerSourceContext } from './cue-trigger-source';

export interface PluginCueHost {
	register(ctx: CueTriggerSourceContext, source: CuePluginSource): () => void;
	authorize(event: CueEvent, agentId: string, subscriptionName: string, queued: boolean): boolean;
	prepare(
		event: CueEvent,
		agentId: string,
		name: string,
		queued: boolean,
		runId?: string
	): Promise<boolean>;
	finish?(event: CueEvent, runId: string, started: boolean): Promise<void>;
}
let host: PluginCueHost | undefined;
export function configurePluginCueHost(value: PluginCueHost | undefined): void {
	host = value;
}
export function authorizePluginCueEvent(
	event: CueEvent,
	agentId: string,
	name: string,
	queued = true
): boolean {
	if (!CUE_EVENT_TYPES.includes(event.type)) return false;
	if (event.type !== 'plugin.event') return event.pluginSource === undefined;
	try {
		return host?.authorize(event, agentId, name, queued) === true;
	} catch {
		return false;
	}
}
/** Fresh disk preparation before awaited run/result/effect segments. Sync checks still
 * revalidate current grants/source/consumer immediately at their commit boundary. */
export async function preparePluginCueEvent(
	event: CueEvent,
	agentId: string,
	name: string,
	queued = true,
	runId?: string
): Promise<boolean> {
	if (event.type !== 'plugin.event') return authorizePluginCueEvent(event, agentId, name, queued);
	const owner = host;
	try {
		if (
			!owner ||
			typeof owner.prepare !== 'function' ||
			!(await owner.prepare(event, agentId, name, queued, runId))
		)
			return false;
		return host === owner && authorizePluginCueEvent(event, agentId, name, queued);
	} catch {
		return false;
	}
}
export function isDurableCueEvent(event: CueEvent): boolean {
	return event.type === 'plugin.event';
}
export function createCuePluginTriggerSource(
	ctx: CueTriggerSourceContext
): CueTriggerSource | null {
	let source: CuePluginSource;
	try {
		source = parseCuePluginSource(ctx.subscription.plugin);
	} catch {
		return null;
	}
	let unregister: (() => void) | undefined;
	return {
		start() {
			if (unregister) return;
			if (!host) {
				ctx.onLog('warn', '[CUE] Plugin source was not registered: PLUGIN_UNAVAILABLE');
				return;
			}
			try {
				unregister = host.register(ctx, source);
			} catch (error) {
				const code = error instanceof PluginAuthorityError ? error.code : 'PLUGIN_UNAVAILABLE';
				ctx.onLog('warn', `[CUE] Plugin source was not registered: ${code}`);
			}
		},
		stop() {
			unregister?.();
			unregister = undefined;
		},
		nextTriggerAt: () => null,
	};
}

/** Only the run manager calls this with its own proven execution boundary. */
export async function finishPluginCueEvent(
	event: CueEvent,
	runId: string,
	started: boolean
): Promise<void> {
	if (event.type !== 'plugin.event') return;
	await host?.finish?.(event, runId, started);
}
