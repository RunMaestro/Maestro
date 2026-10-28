/**
 * useLocalModelEndpoints - the one connection between a surface and the
 * user's configured model servers.
 *
 * The configured list is the `localModelEndpoints` setting, so it is read from
 * and written to the settings store; every edit runs through the shared list
 * helpers (`addLocalModelEndpoint`, `updateLocalModelEndpoint`,
 * `removeLocalModelEndpoint`) the CLI also uses, so this surface cannot save a
 * record the app would drop on the next read.
 *
 * Network use is narrow on purpose. Mounting lists the models of each ENABLED
 * endpoint, because those servers are ones the user already chose to call; a
 * disabled endpoint is never called unless the user clicks Test or Refresh on
 * it. Detection probes loopback only, and only on `detect()`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
	DetectedEndpoint,
	EndpointModel,
	EndpointModelsResult,
	EndpointTestResult,
} from '../../../main/local-models/endpoint-client';
import {
	addLocalModelEndpoint,
	removeLocalModelEndpoint,
	updateLocalModelEndpoint,
	type LocalModelEndpoint,
	type LocalModelEndpointListChange,
} from '../../../shared/local-models/endpoints';
import { useSettingsStore } from '../../stores/settingsStore';

/**
 * An IPC call that rejected instead of answering `{ ok: false }`: the handler
 * itself failed, so no endpoint error kind applies. Kept apart from the
 * endpoint kinds so nothing mistakes it for "the server said no".
 */
export interface EndpointCallFailure {
	ok: false;
	error: { kind: 'ipc'; message: string };
}

/** What a row shows for its model list. */
export type EndpointModelsState =
	| { status: 'loading' }
	| EndpointModelsResult
	| EndpointCallFailure;

/** A Test verdict, from the endpoint or from the call failing. */
export type EndpointTestVerdict = EndpointTestResult | EndpointCallFailure;

/** What a row shows after Test. */
export type EndpointTestState = { status: 'testing' } | EndpointTestVerdict;

export interface LocalModelEndpointsState {
	endpoints: LocalModelEndpoint[];
	/** Per endpoint id. Absent until the list is first fetched. */
	models: Record<string, EndpointModelsState>;
	/** Per endpoint id. Absent until the user clicks Test. */
	tests: Record<string, EndpointTestState>;
	/** `null` until the user runs detection. */
	detected: DetectedEndpoint[] | null;
	detecting: boolean;
	detect: () => Promise<void>;
	refreshModels: (id: string) => Promise<void>;
	/** Test a saved endpoint; the verdict lands in {@link tests}. */
	test: (id: string) => Promise<void>;
	/** Test a record that is not saved yet (the edit form). Stores nothing. */
	testDraft: (endpoint: LocalModelEndpoint) => Promise<EndpointTestVerdict>;
	/** `models` seeds the list so a detected server does not get listed twice. */
	add: (candidate: LocalModelEndpoint, models?: EndpointModel[]) => LocalModelEndpointListChange;
	update: (id: string, candidate: LocalModelEndpoint) => LocalModelEndpointListChange;
	remove: (id: string) => LocalModelEndpointListChange;
	setEnabled: (id: string, enabled: boolean) => LocalModelEndpointListChange;
}

/** The fields a model listing depends on; a change to any of them is a new server. */
function listingKey(endpoint: LocalModelEndpoint): string {
	return [endpoint.kind, endpoint.baseUrl, endpoint.apiKeyEnvVar ?? ''].join('|');
}

function failureFrom(error: unknown): EndpointCallFailure {
	return {
		ok: false,
		error: { kind: 'ipc', message: error instanceof Error ? error.message : String(error) },
	};
}

export function useLocalModelEndpoints(): LocalModelEndpointsState {
	const endpoints = useSettingsStore((s) => s.localModelEndpoints);
	const setLocalModelEndpoints = useSettingsStore((s) => s.setLocalModelEndpoints);

	const [models, setModels] = useState<Record<string, EndpointModelsState>>({});
	const [tests, setTests] = useState<Record<string, EndpointTestState>>({});
	const [detected, setDetected] = useState<DetectedEndpoint[] | null>(null);
	const [detecting, setDetecting] = useState(false);
	// The listing key each id was last fetched under, so a settings echo of an
	// unchanged record does not re-list it.
	const listedKeys = useRef<Record<string, string>>({});
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const fetchModels = useCallback(async (endpoint: LocalModelEndpoint) => {
		listedKeys.current[endpoint.id] = listingKey(endpoint);
		setModels((prev) => ({ ...prev, [endpoint.id]: { status: 'loading' } }));
		let result: EndpointModelsResult | EndpointCallFailure;
		try {
			result = await window.maestro.localModels.endpoints.listModels(endpoint);
		} catch (error) {
			result = failureFrom(error);
		}
		if (mounted.current) setModels((prev) => ({ ...prev, [endpoint.id]: result }));
	}, []);

	useEffect(() => {
		for (const endpoint of endpoints) {
			if (!endpoint.enabled) continue;
			if (listedKeys.current[endpoint.id] === listingKey(endpoint)) continue;
			void fetchModels(endpoint);
		}
	}, [endpoints, fetchModels]);

	const refreshModels = useCallback(
		async (id: string) => {
			const endpoint = endpoints.find((candidate) => candidate.id === id);
			if (endpoint) await fetchModels(endpoint);
		},
		[endpoints, fetchModels]
	);

	const testDraft = useCallback(
		async (endpoint: LocalModelEndpoint): Promise<EndpointTestVerdict> => {
			try {
				return await window.maestro.localModels.endpoints.test(endpoint);
			} catch (error) {
				return failureFrom(error);
			}
		},
		[]
	);

	const test = useCallback(
		async (id: string) => {
			const endpoint = endpoints.find((candidate) => candidate.id === id);
			if (!endpoint) return;
			setTests((prev) => ({ ...prev, [id]: { status: 'testing' } }));
			const result = await testDraft(endpoint);
			if (mounted.current) setTests((prev) => ({ ...prev, [id]: result }));
		},
		[endpoints, testDraft]
	);

	const detect = useCallback(async () => {
		setDetecting(true);
		try {
			const found = await window.maestro.localModels.endpoints.detect();
			if (mounted.current) setDetected(found);
		} catch {
			if (mounted.current) setDetected([]);
		} finally {
			if (mounted.current) setDetecting(false);
		}
	}, []);

	const commit = useCallback(
		(change: LocalModelEndpointListChange) => {
			if (change.ok) setLocalModelEndpoints(change.endpoints);
			return change;
		},
		[setLocalModelEndpoints]
	);

	const add = useCallback(
		(candidate: LocalModelEndpoint, seedModels?: EndpointModel[]) => {
			const change = commit(addLocalModelEndpoint(endpoints, candidate));
			if (change.ok) {
				if (seedModels) {
					listedKeys.current[change.endpoint.id] = listingKey(change.endpoint);
					setModels((prev) => ({
						...prev,
						[change.endpoint.id]: { ok: true, models: seedModels },
					}));
				}
				// A detected server that is now configured is no longer an offer.
				setDetected((prev) =>
					prev ? prev.filter((offer) => offer.baseUrl !== candidate.baseUrl) : prev
				);
			}
			return change;
		},
		[commit, endpoints]
	);

	const update = useCallback(
		(id: string, candidate: LocalModelEndpoint) =>
			commit(updateLocalModelEndpoint(endpoints, id, candidate)),
		[commit, endpoints]
	);

	const remove = useCallback(
		(id: string) => {
			const change = commit(removeLocalModelEndpoint(endpoints, id));
			if (change.ok) {
				delete listedKeys.current[id];
				const drop = <T>(prev: Record<string, T>) => {
					const next = { ...prev };
					delete next[id];
					return next;
				};
				setModels(drop);
				setTests(drop);
			}
			return change;
		},
		[commit, endpoints]
	);

	const setEnabled = useCallback(
		(id: string, enabled: boolean) => {
			const endpoint = endpoints.find((candidate) => candidate.id === id);
			if (!endpoint) return { ok: false as const, message: `No endpoint has id "${id}".` };
			return update(id, { ...endpoint, enabled });
		},
		[endpoints, update]
	);

	return {
		endpoints,
		models,
		tests,
		detected,
		detecting,
		detect,
		refreshModels,
		test,
		testDraft,
		add,
		update,
		remove,
		setEnabled,
	};
}
