/**
 * useModelServer - the Maestro model server for a surface: its report, live
 * install progress, and the card's actions.
 *
 * Mounting reads the report and nothing else: it never starts the server or
 * downloads the engine. The report is read again when main says the state
 * changed, after every action, and every few seconds while the server runs,
 * because a model loads on demand (a harness asks for it) with no state change.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
	ModelServerBind,
	ModelServerEngineProgress,
	ModelServerReport,
} from '../../../shared/local-models/model-server';
import type { ServerBuildChoice } from '../../../shared/local-models/server-engine';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';

/** How often the report is re-read while the server runs, for the loaded models. */
export const MODEL_SERVER_POLL_MS = 5_000;

/** Which action is running, so the card can disable its buttons and say so. */
export type ModelServerBusy = 'start' | 'stop' | 'set' | 'rotate' | 'install' | null;

export interface ModelServerHookState {
	/** Null until the first read answers. */
	report: ModelServerReport | null;
	/** The engine install running now, from the broadcast; null when none. */
	progress: ModelServerEngineProgress | null;
	busy: ModelServerBusy;
	/** Why the last read or action failed, or null. */
	error: string | null;
	refresh: () => Promise<void>;
	start: () => Promise<void>;
	stop: () => Promise<void>;
	setBind: (bind: ModelServerBind) => Promise<void>;
	setMaxModels: (maxModels: number) => Promise<void>;
	rotateKey: () => Promise<void>;
	/** The key, for Copy. Null when it could not be read (the error says why). */
	readKey: () => Promise<string | null>;
	installEngine: (choice: ServerBuildChoice) => Promise<void>;
}

/** Resolved per call: the bridge is installed by the preload, and a test swaps it per case. */
function server() {
	return window.maestro.localModels.server;
}

export function useModelServer(): ModelServerHookState {
	const [report, setReport] = useState<ModelServerReport | null>(null);
	const [progress, setProgress] = useState<ModelServerEngineProgress | null>(null);
	const [busy, setBusy] = useState<ModelServerBusy>(null);
	const [error, setError] = useState<string | null>(null);
	const mountedRef = useRef(true);
	// Only the newest read may answer: a slow read must not overwrite a newer one.
	const latestRef = useRef(0);

	const refresh = useCallback(async () => {
		const request = ++latestRef.current;
		try {
			const next = await window.maestro.localModels.server.report();
			if (!mountedRef.current || request !== latestRef.current) return;
			setReport(next);
			if (!next.installing) setProgress(null);
		} catch (err) {
			if (!mountedRef.current || request !== latestRef.current) return;
			setError(ipcErrorMessage(err));
		}
	}, []);

	useEffect(() => {
		mountedRef.current = true;
		void refresh();
		const offChanged = server().onChanged(() => void refresh());
		const offProgress = server().onProgress((next) => {
			if (!mountedRef.current) return;
			setProgress(next.phase === 'done' ? null : next);
			if (next.phase === 'done') void refresh();
		});
		return () => {
			mountedRef.current = false;
			offChanged();
			offProgress();
		};
	}, [refresh]);

	const running = report?.status.state === 'running';
	useEffect(() => {
		if (!running) return;
		const timer = setInterval(() => void refresh(), MODEL_SERVER_POLL_MS);
		return () => clearInterval(timer);
	}, [running, refresh]);

	/** Run one action: mark it busy, clear the last error, report a failure, re-read. */
	const act = useCallback(
		async (kind: Exclude<ModelServerBusy, null>, work: () => Promise<unknown>) => {
			setBusy(kind);
			setError(null);
			try {
				await work();
			} catch (err) {
				if (mountedRef.current) setError(ipcErrorMessage(err));
			} finally {
				if (mountedRef.current) setBusy(null);
				await refresh();
			}
		},
		[refresh]
	);

	return {
		report,
		progress: progress ?? report?.installing ?? null,
		busy,
		error,
		refresh,
		start: useCallback(() => act('start', () => server().start()), [act]),
		stop: useCallback(() => act('stop', () => server().stop()), [act]),
		setBind: useCallback(
			(bind: ModelServerBind) => act('set', () => server().set({ bind })),
			[act]
		),
		setMaxModels: useCallback(
			(maxModels: number) => act('set', () => server().set({ maxModels })),
			[act]
		),
		rotateKey: useCallback(() => act('rotate', () => server().set({ rotateKey: true })), [act]),
		readKey: useCallback(async () => {
			try {
				return await server().key();
			} catch (err) {
				if (mountedRef.current) setError(ipcErrorMessage(err));
				return null;
			}
		}, []),
		installEngine: useCallback(
			(choice: ServerBuildChoice) => act('install', () => server().installEngine(choice)),
			[act]
		),
	};
}
