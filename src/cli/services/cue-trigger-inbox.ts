/**
 * How `maestro-cli cue trigger` reaches a STANDALONE Cue engine.
 *
 * With the desktop app running, a trigger travels over its WebSocket
 * (`withMaestroClient`). A standalone runner (`maestro-cli cue engine start`)
 * has no such channel, so `cli.trigger` subscriptions could not be fired at
 * all when Cue ran unattended. This is the smallest channel that works across
 * processes and platforms: a request file dropped into
 * `<data dir>/cue-trigger-inbox/`, which the engine polls, answered by a
 * result file beside it. It runs through the SAME `triggerSubscription()` the
 * desktop path calls, so what fires is identical.
 *
 * The inbox lives in the user's own data directory, the same trust boundary as
 * `cue.yaml` itself: anyone who can write there can already edit what Cue runs.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { resolveMaestroUserDataDir } from '../../shared/maestroUserDataDir';

const INBOX_DIR_NAME = 'cue-trigger-inbox';
const REQUEST_SUFFIX = '.request.json';
const RESULT_SUFFIX = '.result.json';
/** How often the engine looks for requests. */
export const CUE_TRIGGER_INBOX_POLL_MS = 500;
/** A request older than this when the engine first sees it is dropped, not run: its sender gave up long ago. */
const STALE_REQUEST_MS = 30_000;
/** How long `cue trigger` waits for the engine to answer. */
const DEFAULT_SUBMIT_TIMEOUT_MS = 10_000;

export interface CueTriggerRequest {
	subscriptionName: string;
	prompt?: string;
	sourceAgentId?: string;
	/** Epoch ms the request was written. */
	requestedAt: number;
}

export interface CueTriggerResult {
	success: boolean;
	error?: string;
}

export type CueTriggerHandler = (
	subscriptionName: string,
	prompt?: string,
	sourceAgentId?: string
) => boolean;

function inboxDir(dataDir: string = resolveMaestroUserDataDir()): string {
	return path.join(dataDir, INBOX_DIR_NAME);
}

/** Write via a temp file + rename so the other side never reads half a JSON document. */
function writeJsonAtomic(filePath: string, value: unknown): void {
	const tmp = `${filePath}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(value), 'utf-8');
	fs.renameSync(tmp, filePath);
}

function parseRequest(raw: string): CueTriggerRequest | null {
	try {
		const value = JSON.parse(raw) as Partial<CueTriggerRequest>;
		if (typeof value.subscriptionName !== 'string' || !value.subscriptionName.trim()) return null;
		return {
			subscriptionName: value.subscriptionName,
			prompt: typeof value.prompt === 'string' ? value.prompt : undefined,
			sourceAgentId: typeof value.sourceAgentId === 'string' ? value.sourceAgentId : undefined,
			requestedAt: typeof value.requestedAt === 'number' ? value.requestedAt : 0,
		};
	} catch {
		return null;
	}
}

/**
 * Process every pending request once. Exported for tests; the engine calls it
 * on a timer through {@link startCueTriggerInbox}.
 */
export function drainCueTriggerInbox(handler: CueTriggerHandler, dataDir?: string): number {
	const dir = inboxDir(dataDir);
	let names: string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return 0;
	}
	let handled = 0;
	for (const name of names) {
		if (!name.endsWith(REQUEST_SUFFIX)) continue;
		const id = name.slice(0, -REQUEST_SUFFIX.length);
		const requestPath = path.join(dir, name);
		let raw: string;
		try {
			raw = fs.readFileSync(requestPath, 'utf-8');
			// Claim it before running, so a second poll cannot fire it again.
			fs.unlinkSync(requestPath);
		} catch {
			continue;
		}
		const request = parseRequest(raw);
		let result: CueTriggerResult;
		if (!request) {
			result = { success: false, error: 'Malformed trigger request' };
		} else if (Date.now() - request.requestedAt > STALE_REQUEST_MS) {
			// Nobody is waiting for this answer, and firing it now would surprise.
			continue;
		} else {
			try {
				result = handler(request.subscriptionName, request.prompt, request.sourceAgentId)
					? { success: true }
					: { success: false };
			} catch (err) {
				result = { success: false, error: err instanceof Error ? err.message : String(err) };
			}
		}
		try {
			writeJsonAtomic(path.join(dir, `${id}${RESULT_SUFFIX}`), result);
		} catch {
			// The sender times out and reports it; nothing more to do here.
		}
		handled++;
	}
	return handled;
}

/** Start serving the inbox. Returns a stop function. */
export function startCueTriggerInbox(handler: CueTriggerHandler, dataDir?: string): () => void {
	fs.mkdirSync(inboxDir(dataDir), { recursive: true });
	const timer = setInterval(
		() => drainCueTriggerInbox(handler, dataDir),
		CUE_TRIGGER_INBOX_POLL_MS
	);
	return () => clearInterval(timer);
}

/**
 * Ask the standalone engine to fire a subscription and wait for its answer.
 * Resolves (never rejects) so the CLI can report a timeout the same way as any
 * other failure.
 */
export async function submitCueTrigger(
	request: Omit<CueTriggerRequest, 'requestedAt'>,
	options: { dataDir?: string; timeoutMs?: number } = {}
): Promise<CueTriggerResult> {
	const dir = inboxDir(options.dataDir);
	fs.mkdirSync(dir, { recursive: true });
	const id = crypto.randomUUID();
	const requestPath = path.join(dir, `${id}${REQUEST_SUFFIX}`);
	const resultPath = path.join(dir, `${id}${RESULT_SUFFIX}`);
	writeJsonAtomic(requestPath, { ...request, requestedAt: Date.now() });

	const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_SUBMIT_TIMEOUT_MS);
	while (Date.now() < deadline) {
		try {
			const raw = fs.readFileSync(resultPath, 'utf-8');
			fs.rmSync(resultPath, { force: true });
			const parsed = JSON.parse(raw) as Partial<CueTriggerResult>;
			return {
				success: parsed.success === true,
				error: typeof parsed.error === 'string' ? parsed.error : undefined,
			};
		} catch {
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}
	// Withdraw the request so a late-starting engine does not fire it unasked.
	fs.rmSync(requestPath, { force: true });
	return { success: false, error: 'The standalone Cue engine did not answer in time' };
}
