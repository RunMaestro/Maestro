import type { ProcessManager } from '../ProcessManager';
import { REGEX_SYNOPSIS_SESSION } from '../../constants';

/**
 * How long a new turn waits for a background synopsis that is still writing
 * the provider session it is about to resume. A synopsis is one short reply
 * (seconds for Codex, rarely more than half a minute for a long Claude
 * transcript), so hitting this means the synopsis is stuck, and the user's
 * turn outranks the History entry it would have produced.
 */
export const SYNOPSIS_WRITER_WAIT_MS = 60_000;

/** After the wait runs out the synopsis is killed; this is how long its exit gets. */
export const SYNOPSIS_WRITER_KILL_GRACE_MS = 5_000;

type ProcessRegistry = Pick<ProcessManager, 'getAll' | 'get' | 'kill' | 'on' | 'off'>;

export interface SynopsisWriterGateResult {
	/** Synopsis process ids the caller waited on. Empty when nothing was in the way. */
	waitedFor: string[];
	/** Synopsis process ids killed because they outlived the wait. */
	killed: string[];
	elapsedMs: number;
}

function waitForExit(registry: ProcessRegistry, sessionId: string, ms: number): Promise<boolean> {
	return new Promise((resolve) => {
		const onExit = (exitedId: string) => {
			if (exitedId === sessionId) settle(true);
		};
		const timer = setTimeout(() => settle(false), ms);
		function settle(exited: boolean) {
			clearTimeout(timer);
			registry.off('exit', onExit);
			resolve(exited);
		}
		registry.on('exit', onExit);
		// Subscribe first, then check: an exit between the scan and the
		// subscription would otherwise be missed and cost the full wait.
		if (!registry.get(sessionId)) settle(true);
	});
}

/**
 * Hold a spawn that resumes `agentSessionId` until no background synopsis is
 * still writing that provider session.
 *
 * The exit listener resumes the tab's provider session for a synopsis right
 * after every turn, under a synthetic `{id}-synopsis-{ts}` process id that
 * never marks the tab busy. A turn sent in that window (a queued item, a
 * `maestro-cli dispatch`, a fast follow-up) resumes the same session while the
 * synopsis still holds it. Codex allows one writer per thread and refuses the
 * second outright ("thread ... already has an active writer"), failing the
 * user's turn; Claude accepts both and interleaves two writers into one JSONL.
 * Serializing here, at the one spawn choke point, covers every send path.
 */
export async function awaitSynopsisWriters(
	registry: ProcessRegistry,
	agentSessionId: string,
	opts: { waitMs?: number; killGraceMs?: number } = {}
): Promise<SynopsisWriterGateResult> {
	const startedAt = Date.now();
	const writers = registry
		.getAll()
		.filter((p) => p.agentSessionId === agentSessionId && REGEX_SYNOPSIS_SESSION.test(p.sessionId))
		.map((p) => p.sessionId);
	if (writers.length === 0) return { waitedFor: [], killed: [], elapsedMs: 0 };

	const waitMs = opts.waitMs ?? SYNOPSIS_WRITER_WAIT_MS;
	const killGraceMs = opts.killGraceMs ?? SYNOPSIS_WRITER_KILL_GRACE_MS;
	const killed: string[] = [];
	await Promise.all(
		writers.map(async (sessionId) => {
			if (await waitForExit(registry, sessionId, waitMs)) return;
			killed.push(sessionId);
			registry.kill(sessionId);
			await waitForExit(registry, sessionId, killGraceMs);
		})
	);
	return { waitedFor: writers, killed, elapsedMs: Date.now() - startedAt };
}
