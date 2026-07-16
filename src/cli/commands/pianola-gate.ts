import { readSettingValue } from '../services/storage';

const DEFAULT_INTERVAL_SECONDS = 5;
const DISABLED_MESSAGE =
	'Pianola is not enabled. Enable it with: maestro-cli encore set pianola on';

/** Parse `--interval` as seconds (`5` or `5s`); defaults to 5, minimum 1. */
export function parsePianolaIntervalSeconds(raw?: string): number {
	if (!raw) return DEFAULT_INTERVAL_SECONDS;
	const match = raw.trim().match(/^(\d+)s?$/i);
	if (!match) return DEFAULT_INTERVAL_SECONDS;
	return Math.max(1, parseInt(match[1], 10));
}

/** Exit with the established CLI envelope when the Pianola Encore feature is disabled. */
export function ensurePianolaEnabled(json?: boolean): void {
	if (pianolaEnabledNow()) return;
	if (json) {
		console.log(
			JSON.stringify({ success: false, error: DISABLED_MESSAGE, code: 'PIANOLA_DISABLED' })
		);
	} else {
		console.error(DISABLED_MESSAGE);
	}
	process.exit(1);
}

/** Read the current consent state; polling callers intentionally re-check this every iteration. */
export function pianolaEnabledNow(): boolean {
	const flags = readSettingValue('encoreFeatures') as Record<string, unknown> | undefined;
	return flags?.pianola === true;
}

export interface PianolaPollingGate {
	readonly intervalMs: number;
	readonly stopped: boolean;
	wait(): Promise<void>;
	stop(): void;
}

/**
 * Owns the one delay between sequential Pianola iterations. The command retains
 * its action/persistence loop; this gate only makes repeated waits coalesce and
 * lets SIGINT release the pending delay without leaving a timer behind.
 */
export function createPianolaPollingGate(interval?: string): PianolaPollingGate {
	const intervalMs = parsePianolaIntervalSeconds(interval) * 1000;
	let timer: NodeJS.Timeout | undefined;
	let pending: Promise<void> | undefined;
	let resolvePending: (() => void) | undefined;
	let isStopped = false;

	const settle = (): void => {
		timer = undefined;
		pending = undefined;
		const resolve = resolvePending;
		resolvePending = undefined;
		resolve?.();
	};

	return {
		intervalMs,
		get stopped(): boolean {
			return isStopped;
		},
		wait(): Promise<void> {
			if (isStopped) return Promise.resolve();
			if (pending) return pending;
			pending = new Promise<void>((resolve) => {
				resolvePending = resolve;
				timer = setTimeout(settle, intervalMs);
			});
			return pending;
		},
		stop(): void {
			if (isStopped) return;
			isStopped = true;
			if (timer) clearTimeout(timer);
			settle();
		},
	};
}
