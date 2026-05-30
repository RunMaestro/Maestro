/**
 * Tagged logger for the Cue authoring/save/render flow.
 *
 * Usage: `cueDebugLog('save:intent', { ... })`
 *
 * Lines are prefixed with `[CueDebug]` so they can be grepped from either the
 * renderer DevTools console or the `npm run dev` terminal (main process) and
 * pasted into a debugging conversation with the user/assistant. Set
 * `MAESTRO_CUE_DEBUG=0` to silence.
 */

const ENABLED = (() => {
	try {
		return typeof process !== 'undefined' && process.env?.MAESTRO_CUE_DEBUG !== '0';
	} catch {
		return true;
	}
})();

export function cueDebugLog(stage: string, data?: unknown): void {
	if (!ENABLED) return;
	if (data === undefined) {
		console.log(`[CueDebug] ${stage}`);
	} else {
		console.log(`[CueDebug] ${stage}`, data);
	}
}
