// Throughput Gauge commands - the CLI half of the floating tokens/sec gauge:
// show and hide (the hotkey, the palette, the hamburger menu, the card's close
// button), the five settings under the gear, and Reset peak. Every verb rides
// the one `throughput_gauge_command` message, answered by the primary window
// through the same store actions the UI calls, and every verb answers with the
// gauge's status so a script can verify what it just did.

import { sendSimpleCommand, failCommand, type SimpleResult } from '../services/session-command';
import { isQuiet } from '../output/verbosity';
import {
	formatGaugeRate,
	GAUGE_UNIT,
	THROUGHPUT_GAUGE_SETTING_CONTROLS,
	THROUGHPUT_METRICS,
	THROUGHPUT_SCOPES,
	throughputOptionLabel,
	throughputWindowLabel,
	type ThroughputGaugeSettings,
} from '../../shared/throughputGauge';
import {
	parseThroughputGaugeCommandRequest,
	THROUGHPUT_GAUGE_DISABLED_ERROR,
	type ThroughputGaugeAction,
	type ThroughputGaugeCommandRequest,
	type ThroughputGaugeStatus,
} from '../../shared/throughputGaugeCommands';

export interface ThroughputGaugeOptions {
	json?: boolean;
	scope?: string;
	metric?: string;
	layout?: string;
	style?: string;
	/** Rolling-average window in SECONDS; the wire carries milliseconds. */
	window?: string;
}

interface ThroughputGaugeResponse extends SimpleResult {
	status?: ThroughputGaugeStatus;
}

/** The `set` flags, keyed by the setting each one writes. */
const SET_FLAGS = {
	scope: 'scope',
	metric: 'metric',
	layout: 'layout',
	style: 'style',
	windowMs: 'window',
} as const satisfies Record<keyof ThroughputGaugeSettings, keyof ThroughputGaugeOptions>;

/**
 * The values a `set` flag accepts, as the user types them, read from the
 * shared option lists so the help text never drifts from what the gauge
 * offers. `--window` is in seconds.
 */
export function throughputGaugeFlagChoices(field: keyof ThroughputGaugeSettings): string[] {
	const control = THROUGHPUT_GAUGE_SETTING_CONTROLS.find((c) => c.field === field);
	const values = (control?.options ?? []).map((o) => o.value);
	return values.map((value) =>
		field === 'windowMs' ? String((value as number) / 1000) : String(value)
	);
}

/** Send one verb and hand back the gauge status the desktop answered with. */
async function sendGauge(
	request: ThroughputGaugeCommandRequest,
	json?: boolean
): Promise<ThroughputGaugeStatus> {
	try {
		const result = (await sendSimpleCommand(
			{ type: 'throughput_gauge_command', ...request },
			'throughput_gauge_command_result'
		)) as ThroughputGaugeResponse;
		if (!result.success) failCommand(result.error || 'Throughput Gauge command failed', json);
		if (!result.status) return failCommand('Throughput Gauge response carried no status', json);
		return result.status;
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), json);
	}
}

/**
 * One line a human reads: `Visible, Combined over 10s, all agents: 182 tok/s
 * (peak 640)`. The scope is named generically ("active agent") because the CLI
 * does not know which agent is active in the window.
 */
export function describeThroughputGaugeStatus(status: ThroughputGaugeStatus): string {
	if (!status.enabled) return THROUGHPUT_GAUGE_DISABLED_ERROR;
	const { metric, scope } = status.settings;
	const metricLabel = throughputOptionLabel(THROUGHPUT_METRICS, metric);
	const scopeLabel = throughputOptionLabel(THROUGHPUT_SCOPES, scope).toLowerCase();
	return `${status.visible ? 'Visible' : 'Hidden'}, ${metricLabel} over ${throughputWindowLabel(status.windowMs)}, ${scopeLabel}: ${formatGaugeRate(status.rates[metric])} ${GAUGE_UNIT} (peak ${formatGaugeRate(status.peak[metric])})`;
}

function report(status: ThroughputGaugeStatus, options: ThroughputGaugeOptions, write: boolean) {
	if (options.json) {
		console.log(JSON.stringify(status, null, 2));
		return;
	}
	if (write && isQuiet()) return;
	console.log(describeThroughputGaugeStatus(status));
}

async function runVerb(
	action: Exclude<ThroughputGaugeAction, 'set'>,
	options: ThroughputGaugeOptions
) {
	const status = await sendGauge({ action }, options.json);
	report(status, options, action !== 'status');
}

/** `maestro-cli throughput-gauge show` */
export const throughputGaugeShow = (options: ThroughputGaugeOptions) => runVerb('show', options);
/** `maestro-cli throughput-gauge hide` */
export const throughputGaugeHide = (options: ThroughputGaugeOptions) => runVerb('hide', options);
/** `maestro-cli throughput-gauge toggle` - scripts should prefer show / hide. */
export const throughputGaugeToggle = (options: ThroughputGaugeOptions) =>
	runVerb('toggle', options);
/** `maestro-cli throughput-gauge reset-peak` */
export const throughputGaugeResetPeak = (options: ThroughputGaugeOptions) =>
	runVerb('reset-peak', options);
/** `maestro-cli throughput-gauge status` - the live reading, peak, and settings. */
export const throughputGaugeStatus = (options: ThroughputGaugeOptions) =>
	runVerb('status', options);

/**
 * Turn the `set` flags into a validated patch, or fail before a round trip.
 *
 * `--window` is checked here because the user types seconds and the shared
 * validator speaks milliseconds; every other flag goes through the same
 * validator the desktop runs, so an error names the allowed values.
 */
export function buildThroughputGaugePatch(
	options: ThroughputGaugeOptions
): { ok: true; patch: Partial<ThroughputGaugeSettings> } | { ok: false; error: string } {
	const patch: Record<string, unknown> = {};
	for (const [field, flag] of Object.entries(SET_FLAGS) as Array<
		[keyof ThroughputGaugeSettings, keyof ThroughputGaugeOptions]
	>) {
		const raw = options[flag];
		if (raw === undefined) continue;
		if (field === 'windowMs') {
			const choices = throughputGaugeFlagChoices('windowMs');
			if (!choices.includes(String(raw).trim())) {
				return {
					ok: false,
					error: `Invalid --window "${raw}". Use one of: ${choices.join(', ')} (seconds).`,
				};
			}
			patch.windowMs = Number(raw) * 1000;
		} else {
			patch[field] = raw;
		}
	}
	if (Object.keys(patch).length === 0) {
		return {
			ok: false,
			error: 'Nothing to set. Pass at least one of --scope, --metric, --layout, --style, --window.',
		};
	}
	const parsed = parseThroughputGaugeCommandRequest({ action: 'set', patch });
	if (!parsed.ok) return { ok: false, error: parsed.error };
	return { ok: true, patch: parsed.request.patch ?? {} };
}

/** `maestro-cli throughput-gauge set [--scope] [--metric] [--layout] [--style] [--window]` */
export async function throughputGaugeSet(options: ThroughputGaugeOptions): Promise<void> {
	const built = buildThroughputGaugePatch(options);
	if (!built.ok) return failCommand(built.error, options.json);
	const status = await sendGauge({ action: 'set', patch: built.patch }, options.json);
	report(status, options, true);
}
