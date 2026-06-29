// Electron main-process glue for the Maestro bridge / session-ingest host.
//
// Builds `MaeHostDeps` from the real desktop services and starts the
// loopback-only host (src/mae). Constructing it here keeps src/mae electron-free
// and unit-tested; this file is the thin, electron-coupled seam.
//
// NOTE: the host logic, security model, and mappers are fully unit-tested in
// src/mae. This wiring is typechecked by tsc-main but its runtime behavior
// (real sessions/cues/toasts + renderer push) requires the running app.

import { Notification, app } from 'electron';
import type { BrowserWindow } from 'electron';
import { promises as fsp } from 'node:fs';
import * as nodePath from 'node:path';
import { getSessionsStore } from '../stores';
import { createMaeHandlers, startBridgeHost } from '../../mae/host-entry';
import type {
	BridgeHost,
	CueGraphSessionLike,
	CueRunResultLike,
	PlaybookFileLike,
} from '../../mae/host-entry';

// Structural, optional view of the cue engine query surface we read. Optional so
// any engine instance is assignable and a missing/renamed method degrades to an
// empty cue list rather than a crash.
interface CueQueryLike {
	getGraphData?: () => CueGraphSessionLike[];
	getActivityLog?: (limit?: number) => CueRunResultLike[];
}

export interface StartMaeBridgeOptions {
	getMainWindow: () => BrowserWindow | null;
	getCueEngine: () => CueQueryLike | null;
	userDataPath?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toPlaybookFileLike(value: unknown): PlaybookFileLike {
	if (!isObject(value)) return {};
	const out: PlaybookFileLike = {};
	if (typeof value.id === 'string') out.id = value.id;
	if (typeof value.name === 'string') out.name = value.name;
	return out;
}

// Maestro stores playbooks as per-session JSON files under <userData>/playbooks.
async function readPlaybookFiles(
	userDataPath: string
): Promise<{ playbooks?: PlaybookFileLike[] }[]> {
	const dir = nodePath.join(userDataPath, 'playbooks');
	let names: string[];
	try {
		names = (await fsp.readdir(dir)).filter((name) => name.endsWith('.json'));
	} catch {
		return [];
	}
	const files: { playbooks?: PlaybookFileLike[] }[] = [];
	for (const name of names) {
		try {
			const parsed: unknown = JSON.parse(await fsp.readFile(nodePath.join(dir, name), 'utf8'));
			if (isObject(parsed) && Array.isArray(parsed.playbooks)) {
				files.push({ playbooks: parsed.playbooks.map(toPlaybookFileLike) });
			}
		} catch {
			// skip unreadable / malformed playbook files
		}
	}
	return files;
}

export async function startMaeBridge(options: StartMaeBridgeOptions): Promise<BridgeHost> {
	const userDataPath = options.userDataPath ?? app.getPath('userData');

	const send = (channel: string, payload: unknown): void => {
		const win = options.getMainWindow();
		if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
	};

	const handlers = createMaeHandlers({
		getStoredSessions: () => getSessionsStore().get('sessions', []),
		getPlaybookFiles: () => readPlaybookFiles(userDataPath),
		getCueGraph: () => options.getCueEngine()?.getGraphData?.() ?? [],
		getCueActivity: () => options.getCueEngine()?.getActivityLog?.(50) ?? [],
		showToast: (title, message) => {
			if (Notification.isSupported()) {
				new Notification({ title, body: message, silent: true }).show();
			}
		},
		onSessionRegister: (params) => send('mae:sessionRegistered', params),
		onSessionEvent: (params) => send('mae:sessionEvent', params),
		onSessionEnd: (params) => send('mae:sessionEnded', params),
	});

	return startBridgeHost({ handlers });
}
