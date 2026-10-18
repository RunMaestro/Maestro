/**
 * Wire shape for the `throughput_gauge_command` message - the CLI half of the
 * Throughput Gauge (`maestro-cli throughput-gauge`).
 *
 * Every gauge action is reachable by clicking: show and hide through the
 * hotkey, the palette, the hamburger menu, and the card's close button; the
 * five settings through the gear popover; Reset peak on the card. This module
 * makes the same actions reachable from the CLI, plus a `status` read so a
 * script can verify what a write did. It lives in `shared/` because all three
 * processes need it: the CLI builds the request, the main process validates it
 * on the way through, and the primary window's renderer, which owns the live
 * rates, answers it.
 *
 * One message with an `action`, for the same reason as `snooze_command`: the
 * verbs differ only in whether they carry a settings patch, and parallel
 * callbacks would be parallel chances to drift from the click path.
 *
 * `toggle` is here because the hotkey is a toggle, but scripts should prefer
 * `show` / `hide`: re-running a toggle flips the card back.
 */

import {
	applyThroughputGaugeSettingsPatch,
	DEFAULT_THROUGHPUT_GAUGE_SETTINGS,
	type ThroughputGaugeSettings,
} from './throughputGauge';
import type { ThroughputRates } from './throughputRate';

/** The verbs a Throughput Gauge command can carry. */
export const THROUGHPUT_GAUGE_ACTIONS = [
	'show',
	'hide',
	'toggle',
	'status',
	'set',
	'reset-peak',
] as const;

export type ThroughputGaugeAction = (typeof THROUGHPUT_GAUGE_ACTIONS)[number];

/** Narrow an unknown value to a Throughput Gauge action. */
export function isThroughputGaugeAction(value: unknown): value is ThroughputGaugeAction {
	return (
		typeof value === 'string' && THROUGHPUT_GAUGE_ACTIONS.includes(value as ThroughputGaugeAction)
	);
}

/**
 * What a write answers when the Encore Feature is off. The gauge does not
 * exist then, so there is nothing to show, hide, or configure; the hint names
 * the one command that fixes it.
 */
export const THROUGHPUT_GAUGE_DISABLED_ERROR =
	'Throughput Gauge is off. Enable it with: maestro-cli encore enable throughput-gauge';

/** One Throughput Gauge command, already validated. */
export interface ThroughputGaugeCommandRequest {
	action: ThroughputGaugeAction;
	/** `set` only: the fields to change. Never empty, every value allowed. */
	patch?: Partial<ThroughputGaugeSettings>;
}

/** The gauge as the CLI reads it: what every verb answers with. */
export interface ThroughputGaugeStatus {
	/** The `throughputGauge` Encore Feature. When false nothing else is live. */
	enabled: boolean;
	/** Whether the floating card is on screen. */
	visible: boolean;
	settings: ThroughputGaugeSettings;
	/** Latest published rates, tokens per second. */
	rates: ThroughputRates;
	/** Highest reading per metric since the last reset, tokens per second. */
	peak: ThroughputRates;
	/** Rolling-average window the rates are taken over (`settings.windowMs`). */
	windowMs: number;
}

/** What the renderer answers a Throughput Gauge command with. */
export interface ThroughputGaugeCommandResult {
	success: boolean;
	error?: string;
	/** Present on success: the gauge after the command ran. */
	status?: ThroughputGaugeStatus;
}

/**
 * Narrow whatever the renderer sent back to a result.
 *
 * The reply crosses an IPC boundary from a process that can be a different
 * build, so a malformed answer becomes a failed command rather than a
 * `success: undefined` the CLI reports as done.
 */
export function normalizeThroughputGaugeCommandResult(raw: unknown): ThroughputGaugeCommandResult {
	if (!raw || typeof raw !== 'object') {
		return { success: false, error: 'Invalid Throughput Gauge response' };
	}
	const candidate = raw as Partial<ThroughputGaugeCommandResult>;
	if (candidate.success !== true) {
		return {
			success: false,
			error:
				typeof candidate.error === 'string' ? candidate.error : 'Throughput Gauge command failed',
		};
	}
	if (!candidate.status || typeof candidate.status !== 'object') {
		return { success: false, error: 'Throughput Gauge response carried no status' };
	}
	return { success: true, status: candidate.status };
}

/**
 * Validate a raw `throughput_gauge_command` message.
 *
 * Runs in the main process, between a CLI that can be any version and a
 * renderer that must never be handed a half-formed request. A `set` patch is
 * checked by {@link applyThroughputGaugeSettingsPatch}, the same validator the
 * gear popover and the palette use, so the CLI cannot store a value the UI
 * would refuse. Merging onto the defaults here only validates; the renderer
 * merges onto the live settings.
 *
 * @returns The validated request, or a message naming what is wrong.
 */
export function parseThroughputGaugeCommandRequest(
	message: Record<string, unknown>
): { ok: true; request: ThroughputGaugeCommandRequest } | { ok: false; error: string } {
	const action = message.action;
	if (!isThroughputGaugeAction(action)) {
		return {
			ok: false,
			error: `Invalid or missing Throughput Gauge action. Must be one of: ${THROUGHPUT_GAUGE_ACTIONS.join(', ')}`,
		};
	}
	if (action !== 'set') return { ok: true, request: { action } };

	const rawPatch = message.patch;
	const checked = applyThroughputGaugeSettingsPatch(DEFAULT_THROUGHPUT_GAUGE_SETTINGS, rawPatch);
	if (!checked.ok) return { ok: false, error: checked.error };

	// The validator returned a full settings object; keep only the fields the
	// caller named, so `set --style lcd` never resets the scope it left alone.
	const fields = Object.keys(rawPatch as object) as Array<keyof ThroughputGaugeSettings>;
	if (fields.length === 0) {
		return { ok: false, error: 'Throughput Gauge set needs at least one setting to change' };
	}
	const patch: Partial<ThroughputGaugeSettings> = {};
	for (const field of fields) {
		(patch as Record<string, unknown>)[field] = checked.settings[field];
	}
	return { ok: true, request: { action, patch } };
}
