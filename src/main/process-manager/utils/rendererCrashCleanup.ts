/**
 * Which processes the primary window's crash must stop.
 *
 * A renderer crash reloads the window while the main process keeps running.
 * Session restoration reattaches to the AI tab turns main still runs
 * (`resolveLiveAiTurns` in src/renderer/utils/liveTurnReattach.ts), so those
 * survive. A process whose owner lived in the crashed renderer has no one to
 * reattach to it and is stopped:
 *
 * - a terminal PTY: the restored tab starts with pid 0 and opens a fresh shell,
 *   so the old one (a background tab's too) would leak.
 * - an Auto Run task (`{agentId}-batch-{ts}`): its runner, completion callback
 *   and maximum-duration check were in the renderer, so left alone it would keep
 *   editing files with nothing watching it.
 * - a synopsis (`{agentId}-synopsis-{ts}`): its result was for a callback that
 *   no longer exists, and it would resume the provider session beside the
 *   reattached turn.
 *
 * Main-owned work (Cue runs, Group Chat, consults) is left alone.
 */

import { REGEX_BATCH_SESSION, REGEX_SYNOPSIS_SESSION } from '../../constants';

export function isRetiredOnRendererCrash(proc: {
	sessionId: string;
	isTerminal: boolean;
}): boolean {
	return (
		proc.isTerminal ||
		REGEX_BATCH_SESSION.test(proc.sessionId) ||
		REGEX_SYNOPSIS_SESSION.test(proc.sessionId)
	);
}
