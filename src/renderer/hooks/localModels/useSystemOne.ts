/**
 * useSystemOne - the System One engine for a surface: its report, the changes
 * a card can make, and the last Test.
 *
 * Mounting reads the report and nothing else: it sends nothing to an engine.
 * The report is read again after every action and whenever main says the
 * settings or a key changed, which is how a change made with `maestro-cli s1`
 * shows without a reload.
 *
 * No key is ever held here. `setKey` hands one to main and forgets it; the
 * report says only where a key comes from.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { SystemOneRemoteEngineId } from '../../../shared/local-models/system-one';
import type {
	SystemOneReport,
	SystemOneSettingsPatch,
	SystemOneTestResult,
} from '../../../shared/local-models/system-one-settings';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';

/** Which action is running, so a card can disable its controls and say so. */
export type SystemOneBusy = 'set' | 'key' | 'test' | null;

export interface SystemOneHookState {
	/** Null until the first read answers. */
	report: SystemOneReport | null;
	busy: SystemOneBusy;
	/** Why the last read or change failed, or null. */
	error: string | null;
	/** The last Test, until the next change to what it tested. */
	test: SystemOneTestResult | null;
	refresh: () => Promise<void>;
	/** Resolves true when the change was stored. */
	set: (patch: SystemOneSettingsPatch) => Promise<boolean>;
	setKey: (engine: SystemOneRemoteEngineId, key: string) => Promise<boolean>;
	clearKey: (engine: SystemOneRemoteEngineId) => Promise<boolean>;
	runTest: () => Promise<void>;
}

/** The settings a change may touch without dropping the last Test: they are not part of the engine. */
const TEST_KEEPING_FIELDS: ReadonlySet<string> = new Set(['failPolicy', 'keepInputs', 'agents']);

/** Resolved per call: the bridge is installed by the preload, and a test swaps it per case. */
function systemOne() {
	return window.maestro.localModels.systemOne;
}

export function useSystemOne(): SystemOneHookState {
	const [report, setReport] = useState<SystemOneReport | null>(null);
	const [busy, setBusy] = useState<SystemOneBusy>(null);
	const [error, setError] = useState<string | null>(null);
	const [test, setTest] = useState<SystemOneTestResult | null>(null);
	const mountedRef = useRef(true);
	// Only the newest read may answer: a slow read must not overwrite a newer one.
	const latestRef = useRef(0);

	const refresh = useCallback(async () => {
		const request = ++latestRef.current;
		try {
			const next = await systemOne().report();
			if (!mountedRef.current || request !== latestRef.current) return;
			setReport(next);
		} catch (err) {
			if (!mountedRef.current || request !== latestRef.current) return;
			setError(ipcErrorMessage(err));
		}
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		void refresh();
		const offChanged = systemOne().onChanged(() => void refresh());
		return () => {
			mountedRef.current = false;
			offChanged();
		};
	}, [refresh]);

	/**
	 * Run one change: mark it busy, store the answer, report a failure. The last
	 * Test is dropped unless the change left what it tested alone (`keepTest`).
	 */
	const change = useCallback(
		async (
			kind: Exclude<SystemOneBusy, null | 'test'>,
			work: () => Promise<SystemOneReport>,
			keepTest = false
		) => {
			setBusy(kind);
			setError(null);
			try {
				const next = await work();
				if (!mountedRef.current) return true;
				// A newer read may be in flight; it must not replace this answer with an older one.
				latestRef.current += 1;
				setReport(next);
				if (!keepTest) setTest(null);
				return true;
			} catch (err) {
				if (mountedRef.current) setError(ipcErrorMessage(err));
				return false;
			} finally {
				if (mountedRef.current) setBusy(null);
			}
		},
		[]
	);

	return {
		report,
		busy,
		error,
		test,
		refresh,
		set: useCallback(
			(patch: SystemOneSettingsPatch) =>
				change(
					'set',
					() => systemOne().set(patch),
					// A fail policy is what a task does with no answer, Keep inputs is what
					// the ledger holds, and the agents block is who may ask and how much:
					// none is part of the engine the Test asked.
					Object.keys(patch).every((field) => TEST_KEEPING_FIELDS.has(field))
				),
			[change]
		),
		setKey: useCallback(
			(engine: SystemOneRemoteEngineId, key: string) =>
				change('key', () => systemOne().setKey({ engine, key })),
			[change]
		),
		clearKey: useCallback(
			(engine: SystemOneRemoteEngineId) => change('key', () => systemOne().clearKey({ engine })),
			[change]
		),
		runTest: useCallback(async () => {
			setBusy('test');
			setError(null);
			try {
				const result = await systemOne().test();
				if (mountedRef.current) setTest(result);
			} catch (err) {
				if (mountedRef.current) setError(ipcErrorMessage(err));
			} finally {
				if (mountedRef.current) setBusy(null);
			}
		}, []),
	};
}
