/**
 * Asking a detached host about itself, and asking it to stop (`maestro-cli host status|stop`).
 *
 * Two typed messages beside the desktop bridge's own, answered only by `maestro-cli host`: the
 * desktop has no use for them, and an older host answers an unknown message with an `echo`, which
 * the connection reports as an unsupported command. The types are here, in the client folder, so
 * the server that answers (`runtime/server.ts`) and the callers share one definition.
 */

import type WebSocket from 'ws';
import { BridgeConnection } from './bridge-connection';
import type { RuntimeLockInfo } from '../runtime/data-dir-lock';

/** A run in flight, as the host reports it. */
export interface HostRunSummary {
	agentId: string;
	kind: 'playbook' | 'goal';
	startedAt: number;
	/** Parked on an error or a gate, waiting for an answer. */
	paused: boolean;
}

/** The work a stop would cut off. */
export interface HostWork {
	/** Chat turns running now. */
	turns: number;
	runs: HostRunSummary[];
}

/** Where the Cue engine stands in the host process (spec D3, Q5). */
export type HostCueState =
	/** Cue is off in the shared Encore settings. */
	| { state: 'disabled' }
	/** This host runs the Cue engine. */
	| { state: 'running' }
	/** Another engine holds the Cue lock, so this host runs without Cue. */
	| { state: 'held'; mode: string; pid: number }
	/** Cue is on, but the engine did not start. */
	| { state: 'failed'; reason: string };

export interface HostStatusReport {
	pid: number;
	/** Epoch ms. */
	startedAt: number;
	uptimeMs: number;
	version?: string;
	/** What this process wrote into `maestro-runtime.lock`. */
	lock: RuntimeLockInfo;
	/** Clients attached to the bridge right now. */
	clients: number;
	work: HostWork;
	cue: HostCueState;
}

export type HostStopReply =
	| { stopping: true }
	| { stopping: false; reason: 'work-in-flight'; work: HostWork };

export const HOST_STATUS_MESSAGE = 'host_status';
export const HOST_STATUS_REPLY = 'host_status_result';
export const HOST_STOP_MESSAGE = 'host_stop';
export const HOST_STOP_REPLY = 'host_stop_result';

/** `true` when the host has anything a stop would interrupt. */
export function hostHasWork(work: HostWork): boolean {
	return work.turns > 0 || work.runs.length > 0;
}

export interface HostControlOptions {
	/** Test seam. */
	WebSocketImpl?: typeof WebSocket;
}

async function withHost<T>(
	userDataDir: string,
	options: HostControlOptions,
	action: (connection: BridgeConnection) => Promise<T>
): Promise<T> {
	const connection = new BridgeConnection({
		userDataDir,
		...(options.WebSocketImpl ? { WebSocketImpl: options.WebSocketImpl } : {}),
	});
	await connection.connect();
	try {
		return await action(connection);
	} finally {
		connection.disconnect();
	}
}

/** Read the host's status. Throws when no host answers on `userDataDir`. */
export function requestHostStatus(
	userDataDir: string,
	options: HostControlOptions = {}
): Promise<HostStatusReport> {
	return withHost(userDataDir, options, async (connection) => {
		const reply = await connection.sendCommand<{ report: HostStatusReport }>(
			{ type: HOST_STATUS_MESSAGE },
			HOST_STATUS_REPLY
		);
		return reply.report;
	});
}

/**
 * Ask the host to stop. It refuses while a turn or run is in flight unless `force`; a refusal is a
 * value, not a throw, so the caller can name the work.
 */
export function requestHostStop(
	userDataDir: string,
	input: { force?: boolean },
	options: HostControlOptions = {}
): Promise<HostStopReply> {
	return withHost(userDataDir, options, async (connection) => {
		const reply = await connection.sendCommand<HostStopReply & { type: string }>(
			{ type: HOST_STOP_MESSAGE, force: input.force === true },
			HOST_STOP_REPLY
		);
		return reply.stopping
			? { stopping: true }
			: { stopping: false, reason: 'work-in-flight', work: reply.work };
	});
}
