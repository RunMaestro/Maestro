/**
 * Tests for main/ipc/handlers/cot-export.ts.
 *
 * WHAT THEY PIN
 * - Who may call. Only a window of the desktop app gets past the sender
 *   check. The event the web bridge hands to a handler is refused, and so is
 *   a call that comes in through the bridge's own dispatch
 *   (`handleBridgeInvoke`), which is the path an agent would take.
 * - What a refusal costs the caller: nothing is read, nothing is made, and
 *   the answer names no reason.
 * - `set` goes through the store's own validation, and a refusal leaves
 *   export off.
 * - `verify` gives one verdict per chain, and checks the stored head against
 *   the disk first, so a log that is intact after a hard stop reads as intact.
 *   The walk runs with the agent's writes held, and a folder that cannot be
 *   read costs only its own verdict.
 * - A failing log raises one native notification per agent per hour, and a
 *   saved state that could not be read raises one when the app starts.
 *
 * The store and the writer are the APP'S own (`getCotConfigStore`,
 * `getCotWriter`), over a fresh directory in the OS temp dir. `electron` is
 * mocked, so `app.getPath` points there and no test reads or writes the
 * user's real data. Paths are built with `path.join`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const electronMock = vi.hoisted(() => {
	const state = {
		userData: '',
		/** Every `WebContents` the mocked Electron has, by id. */
		contents: new Map<number, object>(),
		/** The `BrowserWindow` that owns a `WebContents`. */
		owners: new Map<object, object>(),
		/** Windows that load the app's page and are not ones a person works in. */
		helperWindows: new Set<object>(),
		notificationsSupported: true,
		/** Every notification that was made, in order. */
		notices: [] as Array<{ title: string; body: string; shown: boolean }>,
	};
	const invokeHandlers = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

	class Notification {
		static isSupported(): boolean {
			return state.notificationsSupported;
		}

		private readonly notice: { title: string; body: string; shown: boolean };

		constructor(options: { title: string; body: string }) {
			this.notice = { title: options.title, body: options.body, shown: false };
			state.notices.push(this.notice);
		}

		show(): void {
			this.notice.shown = true;
		}
	}

	return {
		state,
		invokeHandlers,
		module: {
			app: { getPath: (): string => state.userData, getVersion: (): string => '0.0.0-test' },
			// The app's store seals its file with this. The seal only marks the text.
			safeStorage: {
				isEncryptionAvailable: (): boolean => true,
				encryptString: (plain: string): Buffer => Buffer.from(`sealed:${plain}`, 'utf8'),
				decryptString: (blob: Buffer): string => blob.toString('utf8').slice('sealed:'.length),
			},
			ipcMain: {
				handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
					invokeHandlers.set(channel, handler);
				},
				// Where Electron keeps `handle` registrations, and where the web
				// bridge looks a channel up.
				_invokeHandlers: invokeHandlers,
				on: (): void => undefined,
				listenerCount: (): number => 0,
				emit: (): boolean => false,
			},
			BrowserWindow: {
				fromWebContents: (contents: object): object | null => state.owners.get(contents) ?? null,
			},
			webContents: {
				fromId: (id: number): object | undefined => state.contents.get(id),
			},
			Notification,
		},
	};
});

const sessionsMock = vi.hoisted(() => ({ sessions: [] as Array<Record<string, unknown>> }));

vi.mock('electron', () => electronMock.module);
vi.mock('../../../../main/stores/getters', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../main/stores/getters')>()),
	// The app's store asks this for every agent's folders.
	getSessionsStore: () => ({ get: () => sessionsMock.sessions }),
	getLiveSessions: () => sessionsMock.sessions,
}));
vi.mock('../../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(async () => undefined),
	captureMessage: vi.fn(async () => undefined),
	addBreadcrumb: vi.fn(async () => undefined),
}));
vi.mock('../../../../main/cot-export/verify', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../main/cot-export/verify')>()),
	// The real walk, unless a test stands in for an agent that writes during it.
	verifyAgentChain: vi.fn(),
}));

import {
	COT_CONFIG_STORE_NAME,
	__resetCotConfigStoreForTests,
	flushCotConfigStoreSync,
	getCotConfigStore,
} from '../../../../main/cot-export/config-store';
import { turnFilePath } from '../../../../main/cot-export/layout';
import { __resetCotWriterForTests, getCotWriter } from '../../../../main/cot-export/runtime';
import { verifyAgentChain } from '../../../../main/cot-export/verify';
import type { CotRecordDraft } from '../../../../main/cot-export/writer';
import {
	COT_FAILURE_NOTICE_INTERVAL_MS,
	COT_STATE_ANCHOR_CHECK_DELAY_MS,
	__cancelCotStateAnchorCheckForTests,
	assertDesktopSender,
	registerCotExportHandlers,
	shortFailureReason,
} from '../../../../main/ipc/handlers/cot-export';
import { handleBridgeInvoke } from '../../../../main/web-server/handlers/bridgeHandlers';
import type { Anchor, AnchorStore } from '../../../../main/utils/keyring-anchor';
import type { WebClient } from '../../../../main/web-server/types';
import { COT_EXPORT_CHANNELS } from '../../../../shared/cotExport/channels';
import type { CotExportChannel } from '../../../../shared/cotExport/channels';
import type {
	CotAgentConfig,
	CotAgentStatus,
	CotChainVerifyResult,
	CotFolderValidation,
	CotRecord,
	CotSetResult,
} from '../../../../shared/cotExport/types';
import { readTurnFiles } from '../../cot-export/helpers';

// ============================================================================
// Fixtures
// ============================================================================

const AGENT = 'agent-1';
const OTHER_AGENT = 'agent-2';
/** An agent that has a log and is no longer in the agent list. */
const GONE_AGENT = 'agent-gone';

/** 14:05:09 on 10 October 2026, on the local clock: when the test turns start. */
const TURN_START = new Date(2026, 9, 10, 14, 5, 9);
const TS = '2026-10-10T14:05:10.000Z';
/** When the first failure of a notice test happens. */
const T0 = new Date(2026, 9, 10, 15, 0, 0).getTime();
const MINUTE_MS = 60 * 1000;

/**
 * The event the web bridge hands to every handler it dispatches: `FAKE_EVENT`
 * in `web-server/handlers/bridgeHandlers.ts`. It has no `sender`.
 */
const BRIDGE_EVENT = { senderFrame: null, frameId: -1, processId: -1, type: 'bridge' };

const NOT_AVAILABLE = { message: 'Not available' };

/** Every channel of the feature. */
const CHANNELS: CotExportChannel[] = Object.values(COT_EXPORT_CHANNELS);

interface FakeContents {
	id: number;
	getType: () => string;
	/** The frame of the window's own page. */
	mainFrame: object;
}

interface FakeEvent {
	sender: FakeContents;
	senderFrame: object | null;
}

/** A `WebContents` the mocked Electron has, owned by a window or by none. */
function addContents(id: number, type: string, ownedByWindow: boolean): FakeContents {
	const contents: FakeContents = { id, getType: () => type, mainFrame: { frameOf: id } };
	electronMock.state.contents.set(id, contents);
	if (ownedByWindow) electronMock.state.owners.set(contents, { windowOf: id });
	return contents;
}

/** An IPC event sent by the page `contents` shows. */
function eventFrom(contents: FakeContents): FakeEvent {
	return { sender: contents, senderFrame: contents.mainFrame };
}

/** An IPC event from a window of the desktop app. */
function windowEvent(): FakeEvent {
	return eventFrom(addContents(1, 'window', true));
}

function text(turnId: string, body: string): CotRecordDraft {
	return { turnId, ts: TS, kind: 'text', text: body };
}

/** Strips line and block comments, so prose is not read as code. */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
}

describe('cot-export IPC handlers', () => {
	let root: string;
	let dataDir: string;
	let workspace: string;
	let walkChain: typeof verifyAgentChain;
	/** What the OS credential store holds for this app, across "restarts". */
	let anchorValue: Anchor | null;
	const anchor: AnchorStore = {
		available: () => true,
		read: () => anchorValue,
		write: (next) => {
			anchorValue = next;
		},
		clear: () => {
			anchorValue = null;
		},
	};

	/** A log folder outside every workspace. `set` creates it. */
	const logFolder = (name: string): string => path.join(root, name);
	const storeFile = (): string => path.join(dataDir, `${COT_CONFIG_STORE_NAME}.json`);

	/** Calls a channel's handler the way Electron does: the event, then the arguments. */
	const invoke = <T>(channel: CotExportChannel, event: unknown, ...args: unknown[]): Promise<T> => {
		const handler: IpcHandler | undefined = electronMock.invokeHandlers.get(channel);
		if (!handler) throw new Error(`No handler is registered for ${channel}`);
		return handler(event, ...args) as Promise<T>;
	};

	/** Calls a channel from a window of the desktop app. */
	const fromWindow = <T>(channel: CotExportChannel, ...args: unknown[]): Promise<T> =>
		invoke<T>(channel, windowEvent(), ...args);

	/** Turns export on for `agentId` in `folder`, from the desktop window. */
	const turnOn = async (agentId: string, folder: string): Promise<void> => {
		const result = await fromWindow<CotSetResult>(COT_EXPORT_CHANNELS.set, agentId, {
			enabled: true,
			folder,
		});
		expect(result.ok).toBe(true);
	};

	/** Writes one record of `agentId` into a turn file under `folder`, through the app's writer. */
	const writeRecord = async (
		agentId: string,
		folder: string,
		turnId: string,
		body: string
	): Promise<CotRecord> => {
		const file = turnFilePath(folder, TURN_START, 'tab-1', turnId);
		const record = await getCotWriter().append(agentId, file, text(turnId, body));
		if (!record) throw new Error('The record was not written.');
		return record;
	};

	beforeAll(async () => {
		const actual = await vi.importActual<typeof import('../../../../main/cot-export/verify')>(
			'../../../../main/cot-export/verify'
		);
		walkChain = actual.verifyAgentChain;
	});

	beforeEach(() => {
		// The real path, so a folder the store resolves compares equal on macOS,
		// where the temp dir is reached through a symlink.
		root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cot-ipc-')));
		dataDir = path.join(root, 'data');
		workspace = path.join(root, 'workspace');
		for (const dir of [dataDir, workspace]) fs.mkdirSync(dir);

		electronMock.state.userData = dataDir;
		electronMock.state.contents.clear();
		electronMock.state.owners.clear();
		electronMock.state.helperWindows.clear();
		electronMock.state.notificationsSupported = true;
		electronMock.state.notices.length = 0;
		electronMock.invokeHandlers.clear();
		anchorValue = null;
		sessionsMock.sessions = [
			{ id: AGENT, name: 'Backend', cwd: workspace, projectRoot: workspace },
			{ id: OTHER_AGENT, name: 'Frontend', cwd: workspace, projectRoot: workspace },
		];
		vi.mocked(verifyAgentChain).mockReset();
		vi.mocked(verifyAgentChain).mockImplementation(walkChain);

		__resetCotConfigStoreForTests();
		__resetCotWriterForTests();
		register();
	});

	/**
	 * The next start of the app: a new store and a new writer over what is on
	 * disk, and the handlers registered again. The anchor keeps its value, as
	 * the OS credential store does.
	 */
	const restart = (): void => {
		__resetCotConfigStoreForTests();
		__resetCotWriterForTests();
		electronMock.invokeHandlers.clear();
		electronMock.state.notices.length = 0;
		register();
	};

	/** Registers the handlers the way the app does at start. */
	const register = (): void => {
		registerCotExportHandlers({
			getAgentName: (agentId) => {
				const name = sessionsMock.sessions.find((session) => session.id === agentId)?.name;
				return typeof name === 'string' ? name : undefined;
			},
			isAppWindow: (window) => !electronMock.state.helperWindows.has(window),
			anchor,
		});
	};

	afterEach(() => {
		// A store dropped by a "hard stop" still has a save waiting on a fake
		// timer. Going back to real timers discards it, so it cannot fire after
		// the temp dir is gone and bring the directory back.
		vi.useRealTimers();
		// The check of the anchor would make a store over a temp dir that is gone.
		__cancelCotStateAnchorCheckForTests();
		flushCotConfigStoreSync();
		__resetCotConfigStoreForTests();
		__resetCotWriterForTests();
		fs.rmSync(root, { recursive: true, force: true });
	});

	// ========================================================================
	// Who may call
	// ========================================================================

	describe('who may call', () => {
		it.each([...CHANNELS])(
			'%s refuses the event the web bridge hands over, which has no sender',
			async (channel) => {
				await expect(invoke(channel, BRIDGE_EVENT, AGENT)).rejects.toMatchObject(NOT_AVAILABLE);
			}
		);

		it.each([...CHANNELS])(
			'%s cannot invoke a desktop-only handler over the web bridge',
			async (channel) => {
				const handler = vi.fn();
				electronMock.invokeHandlers.set(channel, handler);
				const responses: object[] = [];
				const client = { id: 'web-client-1' } as unknown as WebClient;

				await handleBridgeInvoke(
					client,
					{
						type: 'bridge.invoke',
						requestId: 7,
						channel,
						args: [AGENT, { enabled: true, folder: logFolder('logs') }],
					},
					(_client, payload) => responses.push(payload)
				);

				expect(handler).not.toHaveBeenCalled();
				expect(responses).toEqual([
					expect.objectContaining({ type: 'bridge.response', requestId: 7, ok: false }),
				]);
			}
		);

		it('changes nothing, and makes nothing, for a caller it refuses', async () => {
			const logs = logFolder('logs');

			await expect(
				invoke(COT_EXPORT_CHANNELS.set, BRIDGE_EVENT, AGENT, { enabled: true, folder: logs })
			).rejects.toMatchObject(NOT_AVAILABLE);
			await expect(
				invoke(COT_EXPORT_CHANNELS.validateFolder, BRIDGE_EVENT, AGENT, logs)
			).rejects.toMatchObject(NOT_AVAILABLE);

			// Neither call got as far as its arguments: the folder a valid `set`
			// or `validateFolder` creates is not there, and no setting was saved.
			expect(fs.existsSync(logs)).toBe(false);
			expect(fs.existsSync(storeFile())).toBe(false);
			expect(getCotConfigStore().isEnabled(AGENT)).toBe(false);
		});

		it('refuses a WebContents that no BrowserWindow owns', async () => {
			const event = eventFrom(addContents(2, 'window', false));
			await expect(invoke(COT_EXPORT_CHANNELS.get, event, AGENT)).rejects.toMatchObject(
				NOT_AVAILABLE
			);
		});

		it('refuses a webview guest, which a window owns too', async () => {
			const event = eventFrom(addContents(3, 'webview', true));
			await expect(invoke(COT_EXPORT_CHANNELS.get, event, AGENT)).rejects.toMatchObject(
				NOT_AVAILABLE
			);
		});

		it('refuses a frame inside the window, and an event that names no frame', async () => {
			const contents = addContents(5, 'window', true);
			for (const senderFrame of [{ frameOf: 'an embedded page' }, null, undefined]) {
				await expect(
					invoke(COT_EXPORT_CHANNELS.get, { sender: contents, senderFrame }, AGENT)
				).rejects.toMatchObject(NOT_AVAILABLE);
			}
		});

		it('refuses a window that loads the app page and is not one a person works in', async () => {
			const contents = addContents(6, 'window', true);
			const owner = electronMock.state.owners.get(contents);
			if (!owner) throw new Error('The window has no owner.');
			electronMock.state.helperWindows.add(owner);

			await expect(
				invoke(COT_EXPORT_CHANNELS.get, eventFrom(contents), AGENT)
			).rejects.toMatchObject(NOT_AVAILABLE);
		});

		it('refuses an object that only looks like the window', async () => {
			const real = addContents(1, 'window', true);
			// The same id and type, and a window that would vouch for it. It is
			// still not the WebContents Electron keeps under that id.
			const forged: FakeContents = {
				id: real.id,
				getType: () => 'window',
				mainFrame: real.mainFrame,
			};
			electronMock.state.owners.set(forged, { windowOf: real.id });

			await expect(invoke(COT_EXPORT_CHANNELS.get, eventFrom(forged), AGENT)).rejects.toMatchObject(
				NOT_AVAILABLE
			);
		});

		it.each([
			['no event', undefined],
			['an empty event', {}],
			['a null sender', { sender: null }],
			['a sender with no id', { sender: { getType: (): string => 'window' } }],
			['a sender Electron does not have', { sender: { id: 99, getType: (): string => 'window' } }],
		])('refuses %s', async (_name, event) => {
			await expect(invoke(COT_EXPORT_CHANNELS.get, event, AGENT)).rejects.toMatchObject(
				NOT_AVAILABLE
			);
		});

		it('refuses when the check itself fails', async () => {
			const contents = addContents(4, 'window', true);
			contents.getType = () => {
				throw new Error('Object has been destroyed');
			};
			await expect(
				invoke(COT_EXPORT_CHANNELS.get, eventFrom(contents), AGENT)
			).rejects.toMatchObject(NOT_AVAILABLE);
		});

		it('gives a refusal no detail', () => {
			let thrown: unknown;
			try {
				assertDesktopSender(BRIDGE_EVENT as unknown as Electron.IpcMainInvokeEvent);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(Error);
			expect((thrown as Error).message).toBe('Not available');
			expect(Object.keys(thrown as Error)).toEqual([]);
		});

		it('serves a window of the desktop app', async () => {
			expect(() =>
				assertDesktopSender(windowEvent() as unknown as Electron.IpcMainInvokeEvent)
			).not.toThrow();
			expect(await fromWindow<CotAgentConfig>(COT_EXPORT_CHANNELS.get, AGENT)).toEqual({
				enabled: false,
				folder: null,
				updatedAt: 0,
			});
		});
	});

	// ========================================================================
	// get, set, status
	// ========================================================================

	describe('get, set, and status', () => {
		it('turns export on, and answers with the status after the change', async () => {
			const logs = logFolder('logs');

			const result = await fromWindow<CotSetResult>(COT_EXPORT_CHANNELS.set, AGENT, {
				enabled: true,
				folder: logs,
			});

			const status: CotAgentStatus = {
				enabled: true,
				folder: logs,
				turnsToday: 0,
				unencrypted: false,
			};
			expect(result).toEqual({ ok: true, status });
			expect(await fromWindow<CotAgentStatus>(COT_EXPORT_CHANNELS.status, AGENT)).toEqual(status);
			expect(await fromWindow<CotAgentConfig>(COT_EXPORT_CHANNELS.get, AGENT)).toMatchObject({
				enabled: true,
				folder: logs,
			});
			// The change is on disk when the call returns, sealed.
			expect(Object.keys(JSON.parse(fs.readFileSync(storeFile(), 'utf8')))).toEqual(['blob']);
		});

		it('answers an invalid folder with the reason, and leaves export off', async () => {
			const inside = path.join(workspace, 'logs');

			const result = await fromWindow<CotSetResult>(COT_EXPORT_CHANNELS.set, AGENT, {
				enabled: true,
				folder: inside,
			});

			expect(result).toEqual({
				ok: false,
				reason: `The folder is inside the workspace of Backend (${workspace}), where that agent could read it.`,
			});
			expect(await fromWindow<CotAgentConfig>(COT_EXPORT_CHANNELS.get, AGENT)).toEqual({
				enabled: false,
				folder: null,
				updatedAt: 0,
			});
			expect((await fromWindow<CotAgentStatus>(COT_EXPORT_CHANNELS.status, AGENT)).enabled).toBe(
				false
			);
			expect(getCotConfigStore().isEnabled(AGENT)).toBe(false);
			expect(fs.existsSync(inside)).toBe(false);
		});

		it('keeps export on in the old folder when a new folder is refused', async () => {
			const logs = logFolder('logs');
			await turnOn(AGENT, logs);

			const result = await fromWindow<CotSetResult>(COT_EXPORT_CHANNELS.set, AGENT, {
				enabled: true,
				folder: path.join(workspace, 'logs'),
			});

			expect(result.ok).toBe(false);
			expect(await fromWindow<CotAgentConfig>(COT_EXPORT_CHANNELS.get, AGENT)).toMatchObject({
				enabled: true,
				folder: logs,
			});
		});

		it('refuses to turn export on with no folder', async () => {
			expect(
				await fromWindow<CotSetResult>(COT_EXPORT_CHANNELS.set, AGENT, {
					enabled: true,
					folder: null,
				})
			).toEqual({ ok: false, reason: 'Choose a folder before you turn the audit log on.' });
		});

		it('turns export off and keeps the folder', async () => {
			const logs = logFolder('logs');
			await turnOn(AGENT, logs);

			const result = await fromWindow<CotSetResult>(COT_EXPORT_CHANNELS.set, AGENT, {
				enabled: false,
				folder: logs,
			});

			expect(result).toMatchObject({ ok: true, status: { enabled: false, folder: logs } });
		});

		it.each([
			['no choice', undefined],
			['a null choice', null],
			['a switch that is not a boolean', { enabled: 'yes', folder: null }],
			['a folder that is left out', { enabled: false }],
			['a folder that is not a path', { enabled: false, folder: 42 }],
		])('makes no change from %s', async (_name, choice) => {
			const logs = logFolder('logs');
			await turnOn(AGENT, logs);

			await expect(fromWindow(COT_EXPORT_CHANNELS.set, AGENT, choice)).rejects.toThrow(
				'A change needs `enabled` (a boolean) and `folder` (a path or null).'
			);

			// A malformed choice must not read as "off".
			expect(await fromWindow<CotAgentConfig>(COT_EXPORT_CHANNELS.get, AGENT)).toMatchObject({
				enabled: true,
				folder: logs,
			});
		});

		it.each([...CHANNELS])('%s needs an agent id', async (channel) => {
			await expect(fromWindow(channel, '')).rejects.toThrow('An agent id is required.');
			await expect(fromWindow(channel, 42)).rejects.toThrow('An agent id is required.');
			await expect(fromWindow(channel)).rejects.toThrow('An agent id is required.');
		});
	});

	// ========================================================================
	// validateFolder
	// ========================================================================

	describe('validateFolder', () => {
		it('answers as the store does, and changes nothing', async () => {
			const logs = logFolder('logs');

			expect(
				await fromWindow<CotFolderValidation>(COT_EXPORT_CHANNELS.validateFolder, AGENT, logs)
			).toEqual({ ok: true, resolved: logs });
			expect(
				await fromWindow<CotFolderValidation>(
					COT_EXPORT_CHANNELS.validateFolder,
					AGENT,
					path.join(workspace, 'logs')
				)
			).toEqual({
				ok: false,
				reason: `The folder is inside the workspace of Backend (${workspace}), where that agent could read it.`,
			});

			expect(await fromWindow<CotAgentConfig>(COT_EXPORT_CHANNELS.get, AGENT)).toEqual({
				enabled: false,
				folder: null,
				updatedAt: 0,
			});
		});

		it('refuses the folder of another agent, a rule only the store knows', async () => {
			const logs = logFolder('logs');
			await turnOn(OTHER_AGENT, logs);

			const result = await fromWindow<CotFolderValidation>(
				COT_EXPORT_CHANNELS.validateFolder,
				AGENT,
				logs
			);

			expect(result.ok).toBe(false);
			expect(result).toMatchObject({ reason: expect.stringContaining('another agent') });
		});

		it('refuses a folder that is not a path, with a reason for the person', async () => {
			expect(
				await fromWindow<CotFolderValidation>(COT_EXPORT_CHANNELS.validateFolder, AGENT, 42)
			).toEqual({ ok: false, reason: 'Choose a folder to hold the log.' });
		});
	});

	// ========================================================================
	// verify
	// ========================================================================

	describe('verify', () => {
		it('gives no verdict for an agent that has no chain', async () => {
			expect(await fromWindow<CotChainVerifyResult[]>(COT_EXPORT_CHANNELS.verify, AGENT)).toEqual(
				[]
			);
		});

		it('gives one verdict per chain, the current folder first', async () => {
			const first = logFolder('first');
			const second = logFolder('second');
			await turnOn(AGENT, first);
			await writeRecord(AGENT, first, 'turn-a', 'one');
			await writeRecord(AGENT, first, 'turn-a', 'two');
			// A change of folder closes the first chain and keeps it.
			await turnOn(AGENT, second);
			await writeRecord(AGENT, second, 'turn-b', 'three');

			expect(await fromWindow<CotChainVerifyResult[]>(COT_EXPORT_CHANNELS.verify, AGENT)).toEqual([
				{ folder: second, ok: true, filesChecked: 1, recordsChecked: 1, headMatches: true },
				{ folder: first, ok: true, filesChecked: 1, recordsChecked: 2, headMatches: true },
			]);
		});

		it('names the file and the record of a log that was changed', async () => {
			const logs = logFolder('logs');
			await turnOn(AGENT, logs);
			await writeRecord(AGENT, logs, 'turn-a', 'one');
			const edited = await writeRecord(AGENT, logs, 'turn-a', 'two');
			const file = turnFilePath(logs, TURN_START, 'tab-1', 'turn-a');
			fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('"two"', '"2"'));

			const [verdict] = await fromWindow<CotChainVerifyResult[]>(COT_EXPORT_CHANNELS.verify, AGENT);

			expect(verdict.ok).toBe(false);
			expect(verdict.folder).toBe(logs);
			expect(verdict.firstBreak).toMatchObject({ file, chainSeq: edited.chainSeq });
			expect(verdict.firstBreak?.reason).toContain('was changed after it was written');
		});

		it('says the newest records are missing when a turn file was removed', async () => {
			const logs = logFolder('logs');
			await turnOn(AGENT, logs);
			await writeRecord(AGENT, logs, 'turn-a', 'one');
			fs.rmSync(turnFilePath(logs, TURN_START, 'tab-1', 'turn-a'));

			expect(await fromWindow<CotChainVerifyResult[]>(COT_EXPORT_CHANNELS.verify, AGENT)).toEqual([
				{ folder: logs, ok: false, filesChecked: 0, recordsChecked: 0, headMatches: false },
			]);
		});

		it('checks the stored head against the disk first, so a hard stop is not read as tampering', async () => {
			// Only the timers are faked, so the clock that saves the head never beats.
			vi.useFakeTimers({
				toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
			});
			const logs = logFolder('logs');
			await turnOn(AGENT, logs);
			await writeRecord(AGENT, logs, 'turn-a', 'one');
			const newest = await writeRecord(AGENT, logs, 'turn-a', 'two');

			// The hard stop: the app goes away before the head was saved, and the
			// next start reads the head the last save left, which is the start of
			// the chain.
			__resetCotConfigStoreForTests();
			__resetCotWriterForTests();
			expect(getCotConfigStore().getChainState(AGENT, logs)?.head).not.toBe(newest.hash);
			expect((await readTurnFiles(logs)).flat()).toHaveLength(2);

			expect(await fromWindow<CotChainVerifyResult[]>(COT_EXPORT_CHANNELS.verify, AGENT)).toEqual([
				{ folder: logs, ok: true, filesChecked: 1, recordsChecked: 2, headMatches: true },
			]);
			expect(getCotConfigStore().getChainState(AGENT, logs)?.head).toBe(newest.hash);
		});

		it('holds the writes of the agent until the walk is over, and loses none', async () => {
			const logs = logFolder('logs');
			await turnOn(AGENT, logs);
			await writeRecord(AGENT, logs, 'turn-a', 'one');
			// A record is handed to the writer while the walk runs. A walk beside
			// the writer would see a record its head does not know.
			let late: Promise<CotRecord> | undefined;
			vi.mocked(verifyAgentChain).mockImplementationOnce(async (folder, head) => {
				late = writeRecord(AGENT, logs, 'turn-a', 'two');
				// Long enough for a write that was not held to land.
				await new Promise((resolve) => setTimeout(resolve, 20));
				expect((await readTurnFiles(logs)).flat()).toHaveLength(1);
				return walkChain(folder, head);
			});

			expect(await fromWindow<CotChainVerifyResult[]>(COT_EXPORT_CHANNELS.verify, AGENT)).toEqual([
				{ folder: logs, ok: true, filesChecked: 1, recordsChecked: 1, headMatches: true },
			]);
			expect(verifyAgentChain).toHaveBeenCalledTimes(1);

			// The record that waited is written once the walk is done.
			expect((await late)?.chainSeq).toBe(1);
			expect(await fromWindow<CotChainVerifyResult[]>(COT_EXPORT_CHANNELS.verify, AGENT)).toEqual([
				{ folder: logs, ok: true, filesChecked: 1, recordsChecked: 2, headMatches: true },
			]);
		});

		it('gives no verdict on a folder it cannot read, and still checks the others', async () => {
			const first = logFolder('first');
			const second = logFolder('second');
			await turnOn(AGENT, first);
			await writeRecord(AGENT, first, 'turn-a', 'one');
			await turnOn(AGENT, second);
			await writeRecord(AGENT, second, 'turn-b', 'two');
			// The current folder cannot be listed. The past one can.
			vi.mocked(verifyAgentChain).mockImplementationOnce(async () => {
				throw Object.assign(new Error(`EACCES: permission denied, scandir '${second}'`), {
					code: 'EACCES',
				});
			});

			expect(await fromWindow<CotChainVerifyResult[]>(COT_EXPORT_CHANNELS.verify, AGENT)).toEqual([
				{
					folder: second,
					ok: false,
					filesChecked: 0,
					recordsChecked: 0,
					headMatches: false,
					error: 'The folder could not be read (EACCES).',
				},
				{ folder: first, ok: true, filesChecked: 1, recordsChecked: 1, headMatches: true },
			]);
		});
	});

	// ========================================================================
	// The failure notice
	// ========================================================================

	describe('the failure notice', () => {
		const DISK_FULL = "ENOSPC: no space left on device, open '/logs/2026/10/10/14/140509.jsonl'";

		it('tells the person once per agent per hour, however often the log fails', async () => {
			await turnOn(AGENT, logFolder('logs'));
			const store = getCotConfigStore();

			store.recordError(AGENT, DISK_FULL, T0);
			store.recordError(AGENT, DISK_FULL, T0 + MINUTE_MS);
			store.recordError(AGENT, DISK_FULL, T0 + COT_FAILURE_NOTICE_INTERVAL_MS - 1);

			expect(electronMock.state.notices).toEqual([
				{
					title: 'Maestro',
					body: 'The audit log of Backend is failing: ENOSPC: no space left on device',
					shown: true,
				},
			]);

			// The hour is over: the next failure is told again.
			store.recordError(AGENT, DISK_FULL, T0 + COT_FAILURE_NOTICE_INTERVAL_MS);
			expect(electronMock.state.notices).toHaveLength(2);
			expect(COT_FAILURE_NOTICE_INTERVAL_MS).toBe(60 * MINUTE_MS);
		});

		it('keeps the hour per agent', async () => {
			await turnOn(AGENT, logFolder('logs'));
			await turnOn(OTHER_AGENT, logFolder('other-logs'));
			const store = getCotConfigStore();

			store.recordError(AGENT, DISK_FULL, T0);
			store.recordError(OTHER_AGENT, DISK_FULL, T0 + MINUTE_MS);
			store.recordError(AGENT, DISK_FULL, T0 + 2 * MINUTE_MS);

			expect(electronMock.state.notices.map((notice) => notice.body)).toEqual([
				'The audit log of Backend is failing: ENOSPC: no space left on device',
				'The audit log of Frontend is failing: ENOSPC: no space left on device',
			]);
		});

		it('is raised by a record the writer could not write', async () => {
			await turnOn(AGENT, logFolder('logs'));
			// A turn file in a folder that holds no chain of the agent: the
			// writer loses the record and reports it.
			const stray = turnFilePath(logFolder('elsewhere'), TURN_START, 'tab-1', 'turn-a');

			expect(await getCotWriter().append(AGENT, stray, text('turn-a', 'lost'))).toBeNull();
			expect(await getCotWriter().append(AGENT, stray, text('turn-a', 'lost too'))).toBeNull();

			expect(electronMock.state.notices).toEqual([
				{
					title: 'Maestro',
					body: 'The audit log of Backend is failing: The record belongs to a folder that holds no chain for its agent.',
					shown: true,
				},
			]);
			expect(
				(await fromWindow<CotAgentStatus>(COT_EXPORT_CHANNELS.status, AGENT)).lastError?.message
			).toBe('The record belongs to a folder that holds no chain for its agent.');
		});

		it('says "an agent" for an agent that is no longer in the agent list', async () => {
			await turnOn(GONE_AGENT, logFolder('logs'));

			getCotConfigStore().recordError(GONE_AGENT, DISK_FULL, T0);

			expect(electronMock.state.notices.map((notice) => notice.body)).toEqual([
				'The audit log of an agent is failing: ENOSPC: no space left on device',
			]);
		});

		it('raises nothing where the OS has no notifications, and does not count that as told', async () => {
			await turnOn(AGENT, logFolder('logs'));
			const store = getCotConfigStore();

			electronMock.state.notificationsSupported = false;
			store.recordError(AGENT, DISK_FULL, T0);
			expect(electronMock.state.notices).toEqual([]);

			electronMock.state.notificationsSupported = true;
			store.recordError(AGENT, DISK_FULL, T0 + MINUTE_MS);
			expect(electronMock.state.notices).toHaveLength(1);
		});

		it('says nothing for an agent that was never set up', () => {
			getCotConfigStore().recordError(AGENT, DISK_FULL, T0);
			expect(electronMock.state.notices).toEqual([]);
		});

		it('tells the person at start that the saved state could not be read', async () => {
			await turnOn(AGENT, logFolder('logs'));
			// The next start finds a file it cannot open: bytes sealed with a key
			// this run does not have.
			fs.writeFileSync(
				storeFile(),
				JSON.stringify({ blob: Buffer.from('not ours').toString('base64') })
			);
			restart();

			expect(getCotConfigStore().isEnabled(AGENT)).toBe(false);
			expect(electronMock.state.notices).toEqual([
				{
					title: 'Maestro',
					body: 'The audit log is off for every agent: its saved settings could not be read. Open Edit Agent to turn it on again.',
					shown: true,
				},
			]);
		});

		it('says nothing at start when the saved state was read, or there was none', async () => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			// A first start: nothing on disk, nothing in the credential store.
			restart();
			vi.advanceTimersByTime(COT_STATE_ANCHOR_CHECK_DELAY_MS);
			expect(electronMock.state.notices).toEqual([]);
			expect(anchorValue).toBeNull();

			await turnOn(AGENT, logFolder('logs'));
			restart();
			vi.advanceTimersByTime(COT_STATE_ANCHOR_CHECK_DELAY_MS);

			expect(getCotConfigStore().isEnabled(AGENT)).toBe(true);
			expect(electronMock.state.notices).toEqual([]);
		});

		it('tells the person, a moment after start, that the saved state went missing', async () => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			await turnOn(AGENT, logFolder('logs'));
			expect(anchorValue).toMatchObject({ epoch: 1 });
			// Something removed the file between two runs of the app.
			fs.rmSync(storeFile());

			restart();

			// Not during startup: reading the credential store is kept off it.
			expect(electronMock.state.notices).toEqual([]);
			vi.advanceTimersByTime(COT_STATE_ANCHOR_CHECK_DELAY_MS - 1);
			expect(electronMock.state.notices).toEqual([]);
			vi.advanceTimersByTime(1);

			expect(getCotConfigStore().isEnabled(AGENT)).toBe(false);
			expect(electronMock.state.notices).toEqual([
				{
					title: 'Maestro',
					body: 'The audit log is off for every agent: its saved settings are missing. Open Edit Agent to turn it on again.',
					shown: true,
				},
			]);
			expect(
				(await fromWindow<CotAgentStatus>(COT_EXPORT_CHANNELS.status, AGENT)).lastError?.message
			).toMatch(/are missing/);
		});

		it('tells the person that an older copy of the saved state was put back', async () => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			const logs = logFolder('logs');
			await fromWindow(COT_EXPORT_CHANNELS.set, AGENT, { enabled: false, folder: logs });
			const older = fs.readFileSync(storeFile());
			await turnOn(AGENT, logs);
			fs.writeFileSync(storeFile(), older);

			restart();
			vi.advanceTimersByTime(COT_STATE_ANCHOR_CHECK_DELAY_MS);

			expect(electronMock.state.notices).toEqual([
				{
					title: 'Maestro',
					body: 'The saved settings of the audit log were replaced with an older copy. Open Edit Agent to check which agents are recorded.',
					shown: true,
				},
			]);
		});

		it('says it once per start, however the problem was found', async () => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			await turnOn(AGENT, logFolder('logs'));
			fs.writeFileSync(
				storeFile(),
				JSON.stringify({ blob: Buffer.from('not ours').toString('base64') })
			);

			restart();
			// Known at once, with no anchor needed, and not said again by the check.
			expect(electronMock.state.notices).toHaveLength(1);
			vi.advanceTimersByTime(COT_STATE_ANCHOR_CHECK_DELAY_MS);
			expect(electronMock.state.notices).toHaveLength(1);
		});

		describe('shortFailureReason', () => {
			it('drops the call and the path a file system error ends in', () => {
				expect(shortFailureReason(DISK_FULL)).toBe('ENOSPC: no space left on device');
				expect(
					shortFailureReason(
						"EACCES: permission denied, mkdir 'C:\\Users\\me\\Agent Logs\\2026\\10'"
					)
				).toBe('EACCES: permission denied');
				expect(
					shortFailureReason("EXDEV: cross-device link not permitted, rename '/a' -> '/b'")
				).toBe('EXDEV: cross-device link not permitted');
			});

			it('leaves a message with no path as it is', () => {
				expect(shortFailureReason('ENOSPC: no space left on device, write')).toBe(
					'ENOSPC: no space left on device, write'
				);
				expect(shortFailureReason('The disk is full.')).toBe('The disk is full.');
			});

			it('keeps the first line only, and cuts a long one', () => {
				expect(shortFailureReason('The first line.\n    at stack (file.js:1:1)')).toBe(
					'The first line.'
				);
				const long = shortFailureReason('x'.repeat(500));
				expect(long).toHaveLength(120);
				expect(long.endsWith('...')).toBe(true);
			});

			it('never comes back empty', () => {
				expect(shortFailureReason('')).toBe('unknown error');
				expect(shortFailureReason('   \n')).toBe('unknown error');
			});
		});
	});

	// ========================================================================
	// What the file leaves alone
	// ========================================================================

	describe('what the handlers leave alone', () => {
		const MAIN = path.resolve(__dirname, '..', '..', '..', '..', 'main');
		const code = (...segments: string[]): string =>
			stripComments(fs.readFileSync(path.join(MAIN, ...segments), 'utf8'));

		it('sends nothing to the renderer, and writes to no log and no crash report', () => {
			const handlers = code('ipc', 'handlers', 'cot-export.ts');
			expect(handlers).toContain('assertDesktopSender(event)');
			expect(handlers).not.toMatch(/safe-?send|\.send\(|logger|sentry|capture(Exception|Message)/i);
		});

		it('registers its channels by hand, behind no helper that drops the event', () => {
			const handlers = code('ipc', 'handlers', 'cot-export.ts');
			expect(handlers).not.toMatch(/createIpcHandler|createHandler|withIpcErrorLogging/);
		});

		it('is registered on the live path', () => {
			expect(code('ipc', 'bootstrap', 'index.ts')).toMatch(/registerCotExportHandlers\(/);
		});
	});
});
