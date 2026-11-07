/**
 * useRunOnSources - every source an agent's Run on picker can offer, with the
 * models each one lists right now.
 *
 * The Maestro model server comes first, then each enabled saved source in the
 * order the user keeps them. Mounting it asks each of those what it serves:
 * the server answers from disk (it is never started for a listing), and a
 * saved source is a server the user already chose to call. A disabled source
 * is not asked.
 *
 * A source that could not be listed is reported in `problems` with the reason,
 * so the picker can say why a model the user expects is missing.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import {
	MODEL_SERVER_ENDPOINT_ID,
	MODEL_SERVER_NAME,
} from '../../../shared/local-models/model-server';
import type { LocalModelEndpoint } from '../../../shared/local-models/endpoints';
import type { RunOnPickerSource } from '../../../shared/local-models/run-on-picker';
import { useLocalModelEndpoints, type EndpointModelsState } from './useLocalModelEndpoints';

export interface RunOnSourceProblem {
	endpointId: string;
	name: string;
	message: string;
}

export interface RunOnSourcesState {
	/** Each source that lists at least one model. */
	sources: RunOnPickerSource[];
	/** The saved sources, enabled or not, for naming a target none of them lists. */
	endpoints: LocalModelEndpoint[];
	/** At least one source has not answered yet. */
	loading: boolean;
	problems: RunOnSourceProblem[];
}

function listed(state: EndpointModelsState | undefined): string[] | null {
	if (!state || !('ok' in state) || !state.ok) return null;
	return state.models.map((model) => model.id);
}

function problemOf(state: EndpointModelsState | undefined): string | null {
	if (!state || !('ok' in state) || state.ok) return null;
	return state.error.message;
}

export function useRunOnSources(): RunOnSourcesState {
	const { endpoints, models } = useLocalModelEndpoints();
	const [server, setServer] = useState<EndpointModelsState>({ status: 'loading' });

	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		void window.maestro.localModels.endpoints
			.listModels(MODEL_SERVER_ENDPOINT_ID)
			.then((result) => {
				if (mounted.current) setServer(result);
			})
			.catch((error: unknown) => {
				if (!mounted.current) return;
				setServer({
					ok: false,
					error: { kind: 'ipc', message: error instanceof Error ? error.message : String(error) },
				});
			});
		return () => {
			mounted.current = false;
		};
	}, []);

	return useMemo(() => {
		const all: Array<{ endpointId: string; name: string; state: EndpointModelsState | undefined }> =
			[
				{ endpointId: MODEL_SERVER_ENDPOINT_ID, name: MODEL_SERVER_NAME, state: server },
				...endpoints
					.filter((endpoint) => endpoint.enabled)
					.map((endpoint) => ({
						endpointId: endpoint.id,
						name: endpoint.name,
						state: models[endpoint.id],
					})),
			];
		const sources: RunOnPickerSource[] = [];
		const problems: RunOnSourceProblem[] = [];
		let loading = false;
		for (const { endpointId, name, state } of all) {
			const ids = listed(state);
			if (ids) {
				if (ids.length > 0) sources.push({ endpointId, name, models: ids });
				continue;
			}
			const message = problemOf(state);
			if (message) problems.push({ endpointId, name, message });
			else loading = true;
		}
		return { sources, endpoints, loading, problems };
	}, [endpoints, models, server]);
}
