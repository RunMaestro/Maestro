/**
 * Trigger source for `time.once` subscriptions.
 *
 * Polls every 30 seconds and compares `Date.now()` against the parsed
 * `subscription.fire_at` (an absolute ISO-8601 timestamp with timezone). When
 * the fire time has arrived, the source:
 *
 *  1. dedupes via the registry's `markOnceFired` so a hot-reload that
 *     re-creates the source mid-poll cannot double-fire;
 *  2. checks the missed-fire grace window - if `fire_at` is already past the
 *     grace boundary, the sub self-destructs WITHOUT firing (the user
 *     presumably no longer wants the reminder); and
 *  3. emits a single `time.once` event, then calls `requestSelfDestruct` so
 *     the runtime can rewrite cue.yaml and remove the consumed sub.
 *
 * Self-destruction after a successful fire is delegated to the run-manager /
 * completion path (Phase 02); this source only requests self-destruct on the
 * missed-grace path. All other terminal-status handling happens downstream.
 */

import { createCueEvent } from '../cue-types';
import { passesFilter } from './cue-trigger-filter';
import type { CueTriggerSource, CueTriggerSourceContext } from './cue-trigger-source';

const POLL_INTERVAL_MS = 30_000; // 30 seconds
const DEFAULT_GRACE_MINUTES = 360; // 6 hours

export function createCueOnceTriggerSource(ctx: CueTriggerSourceContext): CueTriggerSource | null {
	const fireAt = ctx.subscription.fire_at;
	if (typeof fireAt !== 'string' || fireAt.length === 0) return null;

	// Bind an explicitly-typed string after the guard above so the value stays
	// `string` (not `string | undefined`) inside the hoisted `checkAndFire`
	// closure, where the registry dedup key requires a concrete string.
	const fireAtIso: string = fireAt;

	const targetMs = Date.parse(fireAtIso);
	if (!Number.isFinite(targetMs)) {
		ctx.onLog(
			'warn',
			`[CUE] "${ctx.subscription.name}" has an unparseable fire_at "${fireAtIso}" - disabling`
		);
		return null;
	}

	const graceMinutes = ctx.subscription.grace_minutes ?? DEFAULT_GRACE_MINUTES;
	const graceMs = graceMinutes * 60_000;

	let timer: ReturnType<typeof setInterval> | null = null;
	let nextFireMs: number | null = targetMs;
	let fired = false;

	function checkAndFire(): void {
		if (fired) return;
		if (!ctx.enabled()) return;

		const now = Date.now();

		if (targetMs > now) {
			nextFireMs = targetMs;
			return;
		}

		// Atomic check-and-set against the registry so a YAML hot-reload that
		// re-creates the source mid-poll cannot double-fire.
		if (!ctx.registry.markOnceFired(ctx.session.id, ctx.subscription.name, fireAtIso)) {
			fired = true;
			nextFireMs = null;
			stopInternal();
			return;
		}

		fired = true;
		nextFireMs = null;

		// Missed-fire grace: if `fire_at` is already past the grace boundary,
		// self-destruct without firing. graceMs === 0 disables the rescue path
		// entirely (no late fires allowed).
		const elapsed = now - targetMs;
		if (graceMs <= 0 || elapsed > graceMs) {
			ctx.onLog(
				'cue',
				`[CUE] "${ctx.subscription.name}" missed its fire window (fired_at: ${fireAtIso}, grace: ${graceMinutes}m) - self-destructing without firing`
			);
			ctx.requestSelfDestruct?.(ctx.subscription.name, 'missed-grace');
			stopInternal();
			return;
		}

		const event = createCueEvent('time.once', ctx.subscription.name, {
			fire_at: fireAtIso,
			fired_at: new Date(now).toISOString(),
			grace_minutes: graceMinutes,
		});

		if (!passesFilter(ctx.subscription, event, ctx.onLog)) {
			// The sub is consumed for this process (markOnceFired ran above) and
			// will never fire, so it must self-destruct - otherwise the YAML entry
			// is stranded forever, mirroring the missed-grace path.
			ctx.requestSelfDestruct?.(ctx.subscription.name, 'filtered');
			stopInternal();
			return;
		}

		ctx.onLog('cue', `[CUE] "${ctx.subscription.name}" triggered (time.once)`);
		ctx.emit(event);
		stopInternal();
	}

	function stopInternal(): void {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
	}

	return {
		start() {
			if (timer) return; // idempotent
			// Run an immediate check so a fire_at within the same 30s window as
			// start() is not missed waiting for the first interval tick.
			checkAndFire();
			if (fired) return;
			timer = setInterval(checkAndFire, POLL_INTERVAL_MS);
		},

		stop() {
			stopInternal();
			nextFireMs = null;
		},

		nextTriggerAt() {
			return nextFireMs;
		},
	};
}
