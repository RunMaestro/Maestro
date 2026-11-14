/**
 * useLocalModelsHardware - what this computer has to run a model on, for the
 * fit labels a model list shows.
 *
 * Mounting it issues ONE read (`localModels:hardware`): the OS and a stored
 * file, never a binary. The verdict itself is `modelFit()` in
 * `shared/local-models/model-fit`, which the CLI computes from the same
 * profile, so a row and `maestro-cli models list --fit` cannot disagree.
 *
 * On a PC the GPU's memory comes from the model server engine's device check,
 * so the profile is read again when an engine install finishes: that is the
 * moment "judged as if it ran on the CPU" stops being true.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { HardwareProfile } from '../../../shared/local-models/model-fit';

export interface LocalModelsHardwareState {
	/** Null until the first read lands, or when it failed. */
	profile: HardwareProfile | null;
	error: string | null;
	refresh: () => Promise<void>;
}

export function useLocalModelsHardware(): LocalModelsHardwareState {
	const [profile, setProfile] = useState<HardwareProfile | null>(null);
	const [error, setError] = useState<string | null>(null);

	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
		};
	}, []);

	const refresh = useCallback(async () => {
		try {
			const next = await window.maestro.localModels.hardware();
			if (!mounted.current) return;
			setProfile(next);
			setError(null);
		} catch (err) {
			if (!mounted.current) return;
			setError(err instanceof Error ? err.message : String(err));
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	useEffect(() => {
		// The bridge owns its own teardown, so this returns the unsubscribe.
		return window.maestro.localModels.server.onProgress((progress) => {
			if (progress.phase === 'done') void refresh();
		});
	}, [refresh]);

	return { profile, error, refresh };
}
