/** Bound headless process startup and teardown without relying on child close. */
import type { ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import {
	createIdleWatchdog,
	type IdleWatchdog,
} from '../../shared/maestro-lib/control/idle-watchdog';
import type { ParsedEvent } from '../../shared/maestro-lib/parsers/agent-output-parser';
import type { UsageReporting } from '../../shared/maestro-lib/run/turn-capture';
import type { HeadlessIdleProfile } from '../../shared/plugins/headless-agent-timeouts';
import {
	stopProcess,
	BACKGROUND_STOP_GRACE_MS,
	type StopHandle,
} from '../../shared/maestro-lib/control/termination';
import { HEADLESS_PROCESS_CLOSE_TIMEOUT_MS } from '../../shared/plugins/headless-agent-timeouts';

/** Validate before process creation; the supervisor repeats this defensive boundary. */
export function assertHeadlessIdleProfile(
	profile: HeadlessIdleProfile | undefined,
	timeoutMs?: number
): void {
	if (
		profile &&
		(!timeoutMs ||
			timeoutMs <= 0 ||
			!Number.isFinite(timeoutMs) ||
			![profile.warnMs, profile.idleMs, profile.toolMs].every(
				(value) => Number.isFinite(value) && value > 0
			) ||
			profile.warnMs >= profile.idleMs ||
			profile.toolMs < profile.idleMs)
	) {
		throw new Error('Invalid headless idle profile');
	}
}

export function superviseAgentProcess(
	child: ChildProcess,
	options: {
		timeoutMs?: number;
		idle?: HeadlessIdleProfile;
		usageReporting?: UsageReporting;
		onStatus?: (text: string) => void;
		startupMs?: number;
		signal?: AbortSignal;
		onStop: (reason: string) => void;
		onForcedStop: () => void;
	}
): { modelActivity: () => void; observe: (event: ParsedEvent) => void; dispose: () => void } {
	let disposed = false;
	let stopping = false;
	let termination: StopHandle | undefined;
	let startup: IdleWatchdog | undefined;
	let lifetime: IdleWatchdog | undefined;
	let silence: IdleWatchdog | undefined;
	let warning: IdleWatchdog | undefined;
	let exitDrain: IdleWatchdog | undefined;
	let forced = false;
	let warned = false;
	let lastProgress = Date.now();
	// A correlated tool allowance may follow new model work; an ID-less
	// declaration has its own original fixed deadline. Neither owns the other.
	let correlatedToolDeadline: number | undefined;
	let anonymousToolDeadline: number | undefined;
	let lastToolCompletion: number | undefined;
	const tools = new Map<string, boolean>();
	const seenText = new Set<string>();
	const usage = new Map<string, number[]>();
	const profile = options.idle ? { ...options.idle } : undefined;
	assertHeadlessIdleProfile(profile, options.timeoutMs);
	let closeDeadline: ReturnType<typeof setTimeout> | undefined;

	const forceStop = (): void => {
		if (disposed || forced) return;
		forced = true;
		child.stdout?.destroy();
		child.stderr?.destroy();
		options.onForcedStop();
	};
	const stop = (reason: string): void => {
		if (disposed || stopping) return;
		stopping = true;
		startup?.disarm();
		lifetime?.disarm();
		silence?.disarm();
		warning?.disarm();
		exitDrain?.disarm();
		options.onStop(reason);
		// Arm before killing: close can be delivered during kill in a harness.
		closeDeadline = setTimeout(
			forceStop,
			BACKGROUND_STOP_GRACE_MS + HEADLESS_PROCESS_CLOSE_TIMEOUT_MS
		);
		// Snapshot and terminate descendants before their launcher can exit and
		// reparent them. Reuse the same tree kill as the host's Stop action.
		termination = stopProcess(
			{ child },
			{ from: 'terminate', graceMs: BACKGROUND_STOP_GRACE_MS, label: 'headless agent' }
		);
		options.onStatus?.(reason);
	};
	const abort = (): void => stop('Agent run cancelled');
	const armSilence = (): void => {
		if (!profile || disposed || stopping) return;
		silence?.disarm();
		const modelDeadline = lastProgress + profile.idleMs;
		const hasOpenCorrelatedTool = [...tools.values()].some(Boolean);
		const hasOpenTool = anonymousToolDeadline !== undefined || hasOpenCorrelatedTool;
		const toolReturnDeadline =
			lastToolCompletion !== undefined && correlatedToolDeadline !== undefined
				? Math.min(lastToolCompletion + profile.idleMs, correlatedToolDeadline)
				: modelDeadline;
		const deadline = Math.max(
			modelDeadline,
			anonymousToolDeadline ?? modelDeadline,
			hasOpenCorrelatedTool && correlatedToolDeadline !== undefined
				? correlatedToolDeadline
				: toolReturnDeadline
		);
		silence = createIdleWatchdog({
			idleMs: Math.max(1, deadline - Date.now()),
			onIdle: () =>
				stop(
					hasOpenTool
						? 'Agent run stopped: bounded tool or wait budget exhausted without new model progress'
						: 'Agent run stopped: semantic inactivity budget exhausted'
				),
		});
	};
	const armWarning = (): void => {
		if (!profile || disposed || stopping) return;
		warning?.disarm();
		warning = createIdleWatchdog({
			idleMs: profile.warnMs,
			onIdle: () => {
				warned = true;
				options.onStatus?.(
					'Warning: no new model progress; monitoring bounded inactivity and tool/wait budgets'
				);
			},
		});
	};
	const modelProgress = (): void => {
		lastProgress = Date.now();
		startup?.disarm();
		// Only the correlated allowance follows new model work. The anonymous
		// declaration retains its original deadline even when both are open.
		correlatedToolDeadline = undefined;
		lastToolCompletion = undefined;
		// New model work may renew the bounded allowance of an existing tool.
		if (profile && [...tools.values()].some(Boolean))
			correlatedToolDeadline = lastProgress + profile.toolMs;
		if (warned) options.onStatus?.('Agent run recovered: new model progress observed');
		warned = false;
		armWarning();
		armSilence();
	};
	const observe = (event: ParsedEvent): void => {
		if (disposed || stopping || options.signal?.aborted || event.isRetryNotice) return;
		// Unparsed stdout, typing and transport notices do not prove model work.
		if (!event.raw || typeof event.raw !== 'object') return;
		const parent = event.parentToolUseId ?? '';
		if (parent && !tools.get(parent)) return;
		let fresh = false;
		if ((event.type === 'text' || event.type === 'result') && event.text?.trim()) {
			// Store digests only. Equal deltas without a stable provider event ID
			// cannot be distinguished from replay; conservatively count them once.
			const key = createHash('sha256')
				.update(`${parent}\0${!!event.isReasoning}\0${event.text}`)
				.digest('hex');
			if (!seenText.has(key) && seenText.size < 65536) {
				seenText.add(key);
				fresh = true;
			}
		}
		if (event.usage) {
			const next = [
				event.usage.inputTokens,
				event.usage.outputTokens,
				event.usage.cacheReadTokens ?? 0,
				event.usage.cacheCreationTokens ?? 0,
				event.usage.reasoningTokens ?? 0,
			];
			const stepId =
				options.usageReporting === 'per-step' &&
				typeof event.usageEventId === 'string' &&
				event.usageEventId.length <= 256
					? event.usageEventId
					: '';
			const key = `${parent}\0${stepId}`;
			const previous = usage.get(key) ?? next.map(() => 0);
			fresh ||=
				(usage.has(key) || !!stepId) &&
				(usage.has(key) || usage.size < 65536) &&
				next.some((value, i) => Number.isFinite(value) && value > previous[i]);
			if (usage.has(key) || usage.size < 65536)
				usage.set(
					key,
					next.map((value, i) =>
						Number.isFinite(value) ? Math.max(value, previous[i]) : previous[i]
					)
				);
		}
		if (fresh) modelProgress();
		const toolEvents = [
			...(event.type === 'tool_use' ? [event] : []),
			...(event.toolUseBlocks ?? []).map((block) => ({
				toolCallId: block.id,
				toolState: { status: 'running' },
				parentToolUseId: parent,
			})),
			...(event.toolResultBlocks ?? []),
		];
		for (const tool of toolEvents) {
			const id = tool.toolCallId;
			if (tool.parentToolUseId && !tools.get(tool.parentToolUseId)) continue;
			const state = tool.toolState as { status?: unknown } | undefined;
			const status = state?.status;
			if (!id) {
				// No ID means no trustworthy completion or replay correlation. A
				// running declaration gets only the original finite opaque allowance.
				if (['running', 'pending', 'in_progress'].includes(String(status))) {
					startup?.disarm();
					if (profile && anonymousToolDeadline === undefined)
						anonymousToolDeadline = Date.now() + profile.toolMs;
				}
				continue;
			}
			if (id.length > 256) continue;
			if (status === 'running' || status === 'pending' || status === 'in_progress') {
				if (!tools.has(id) && tools.size < 4096) {
					tools.set(id, true);
					startup?.disarm();
					if (profile && correlatedToolDeadline === undefined)
						correlatedToolDeadline = Date.now() + profile.toolMs;
				}
			} else if (
				['completed', 'success', 'failed', 'error'].includes(String(status)) &&
				tools.get(id)
			) {
				tools.set(id, false);
				lastToolCompletion = Date.now();
			}
		}
		armSilence();
	};
	if (options.startupMs) {
		startup = createIdleWatchdog({
			idleMs: options.startupMs,
			onIdle: () =>
				stop(
					`Codex produced no model activity within ${options.startupMs! / 1000} seconds. Startup or authentication may be blocked, for example by an interactive keyring prompt. Check Codex login and the credential store on the agent host; after fixing them, retry the request. For a host already using file credentials, verify the agent's -c cli_auth_credentials_store=file setting.`
				),
		});
	}
	if (options.timeoutMs) {
		lifetime = createIdleWatchdog({
			idleMs: options.timeoutMs,
			onIdle: () => stop('Agent run stopped: absolute runtime ceiling exceeded'),
		});
	}
	const onExit = (): void => {
		if (disposed || stopping) return;
		exitDrain = createIdleWatchdog({
			idleMs: HEADLESS_PROCESS_CLOSE_TIMEOUT_MS,
			onIdle: () => {
				stop('Agent run stopped: provider exited without closing output streams');
				forceStop();
			},
		});
	};
	child.once?.('exit', onExit);
	armWarning();
	armSilence();
	options.signal?.addEventListener('abort', abort, { once: true });
	if (options.signal?.aborted) abort();
	return {
		modelActivity: () => {
			if (!disposed && !stopping) startup?.disarm();
		},
		observe,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			startup?.disarm();
			lifetime?.disarm();
			silence?.disarm();
			warning?.disarm();
			exitDrain?.disarm();
			child.removeListener?.('exit', onExit);
			if (closeDeadline) clearTimeout(closeDeadline);
			options.signal?.removeEventListener('abort', abort);
			termination?.dispose();
		},
	};
}
