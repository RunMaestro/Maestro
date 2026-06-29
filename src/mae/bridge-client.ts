// Client for the per-run, capability-scoped Maestro bridge endpoint. Used by the
// maestro-bridge omp extension. It only ever talks to the scoped endpoint the
// launcher wired via env (never a general desktop token), and it refuses
// dispatch-equivalent verbs client-side as defense in depth.

import {
	BRIDGE_ENV,
	BridgeErrorCode,
	type BridgeResponse,
	type BridgeVerb,
	err,
	isDispatchVerb,
	parseResponse,
} from './protocol';

export interface FetchResponseLike {
	json(): Promise<unknown>;
}
export type FetchLike = (
	input: string,
	init: { method: string; headers: Record<string, string>; body: string }
) => Promise<FetchResponseLike>;

export interface BridgeEnv {
	[key: string]: string | undefined;
}

export interface BridgeClient {
	readonly enabled: boolean;
	readonly runId: string | undefined;
	call(verb: BridgeVerb, params?: unknown): Promise<BridgeResponse<unknown>>;
}

const defaultFetch: FetchLike = async (input, init) => {
	const response = await fetch(input, init);
	return { json: () => response.json() };
};

export function createBridgeClient(
	env: BridgeEnv,
	fetchImpl: FetchLike = defaultFetch
): BridgeClient {
	const url = env[BRIDGE_ENV.url];
	const token = env[BRIDGE_ENV.token];
	const runId = env[BRIDGE_ENV.runId];
	const enabled = Boolean(url && token);

	async function call(verb: BridgeVerb, params?: unknown): Promise<BridgeResponse<unknown>> {
		if (isDispatchVerb(verb)) {
			return err(
				BridgeErrorCode.Phase4Required,
				`${verb} is gated until Phase 4 (dispatch-equivalent: it can cause agent execution) and is not yet wired`
			);
		}
		if (!enabled || !url || !token) {
			return err(
				BridgeErrorCode.AppUnavailable,
				'Maestro app is not connected; bridge tools are unavailable in this run'
			);
		}
		try {
			const response = await fetchImpl(`${url}/v1/bridge`, {
				method: 'POST',
				headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
				body: JSON.stringify({ verb, params }),
			});
			return parseResponse(await response.json());
		} catch (error) {
			return err(
				BridgeErrorCode.AppUnavailable,
				error instanceof Error ? error.message : 'bridge request failed'
			);
		}
	}

	return { enabled, runId, call };
}
