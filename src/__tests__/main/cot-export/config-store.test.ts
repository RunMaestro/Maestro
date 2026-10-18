/**
 * Tests for main/cot-export/config-store.ts.
 *
 * The store runs against a real `electron-store` file in a fresh directory
 * under the OS temp dir, so the bytes on disk can be read back. `electron`
 * is mocked: `safeStorage` is a small reversible cipher that can be switched
 * off (a system with no keyring) or re-keyed (a file sealed by another
 * install), and `app.getPath` points at the temp dir. No test reads or writes
 * the user's real data.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const electronMock = vi.hoisted(() => {
	const state = {
		/** What `isEncryptionAvailable` answers. */
		available: true,
		/** The "OS key". A blob sealed under another key cannot be opened. */
		key: 0x5a,
		/** Makes `encryptString` fail, as a save that cannot be sealed. */
		encryptThrows: false,
		userData: '',
	};
	const safeStorage = {
		isEncryptionAvailable: (): boolean => state.available,
		encryptString: (plain: string): Buffer => {
			if (state.encryptThrows) throw new Error('Error while encrypting the text.');
			const bytes = Buffer.from(plain, 'utf8');
			const out = Buffer.alloc(bytes.length + 1);
			out[0] = state.key;
			for (let i = 0; i < bytes.length; i++) out[i + 1] = bytes[i] ^ state.key;
			return out;
		},
		decryptString: (blob: Buffer): string => {
			if (blob.length === 0 || blob[0] !== state.key) {
				throw new Error('Error while decrypting the ciphertext.');
			}
			const out = Buffer.alloc(blob.length - 1);
			for (let i = 1; i < blob.length; i++) out[i - 1] = blob[i] ^ state.key;
			return out.toString('utf8');
		},
	};
	return { state, safeStorage, app: { getPath: (): string => state.userData } };
});

const sessionsMock = vi.hoisted(() => ({
	sessions: [] as Array<Record<string, unknown>>,
	/** The persisted Encore flags, read for which agents are live. */
	encoreFeatures: {} as Record<string, boolean>,
	/** Where the agent list and the settings lie. Null while the stores are not up. */
	syncPath: null as string | null,
}));

vi.mock('electron', () => ({ safeStorage: electronMock.safeStorage, app: electronMock.app }));
vi.mock('../../../main/stores/getters', async () => {
	const { filterLiveAgents } = await import('../../../shared/agentVisibility');
	return {
		getSessionsStore: () => ({ get: () => sessionsMock.sessions }),
		getLiveSessions: () => filterLiveAgents(sessionsMock.sessions, sessionsMock.encoreFeatures),
		getSyncPath: (): string => {
			if (sessionsMock.syncPath === null) throw new Error('Stores not initialized.');
			return sessionsMock.syncPath;
		},
	};
});
vi.mock('../../../main/utils/logger', () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import {
	COT_CONFIG_STORE_NAME,
	COT_STATE_ANCHOR_SERVICE,
	PERSIST_INTERVAL_MS,
	__resetCotConfigStoreForTests,
	cotStateAnchorAccount,
	createCotConfigStore,
	flushCotConfigStoreSync,
	getCotConfigStore,
	setCotFailureListener,
	setCotStateAnchor,
} from '../../../main/cot-export/config-store';
import type { CotConfigStore, CotConfigStoreDeps } from '../../../main/cot-export/config-store';
import { turnFilePath } from '../../../main/cot-export/layout';
import type { Anchor, AnchorStore } from '../../../main/utils/keyring-anchor';
import { safeStorageSeal } from '../../../main/utils/safe-storage-seal';
import { COT_GENESIS_CHAIN_SEQ, COT_GENESIS_HASH } from '../../../shared/cotExport/types';
import type { CotLastError } from '../../../shared/cotExport/types';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const AGENT = 'agent-1';
const OTHER_AGENT = 'agent-2';

/** 15:00 on 10 October 2026, on the local clock. */
const START = new Date(2026, 9, 10, 15, 0, 0).getTime();

describe('cot-export/config-store', () => {
	let root: string;
	let dataDir: string;
	let workspace: string;
	let homeDir: string;
	let agentDirs: string[];
	let clock: number;
	let stores: CotConfigStore[];

	const storeFile = (): string => path.join(dataDir, `${COT_CONFIG_STORE_NAME}.json`);
	const readFile = (): Record<string, unknown> => JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
	/** A log folder outside every workspace. `setAgentConfig` creates it. */
	const logFolder = (name: string): string => path.join(root, name);

	/**
	 * A store over the temp data dir, as the app would make it after a restart.
	 * The stores made before it stop their clocks, as a process that is gone
	 * does: two stores that both save by the clock would write over each other.
	 */
	const makeStore = (extra: Partial<CotConfigStoreDeps> = {}): CotConfigStore => {
		for (const earlier of stores) earlier.dispose();
		const store = createCotConfigStore({
			cwd: dataDir,
			seal: safeStorageSeal(electronMock.safeStorage),
			getFolderContext: () => ({ agentDirs, userDataPath: dataDir, homeDir }),
			now: () => clock,
			...extra,
		});
		stores.push(store);
		return store;
	};

	/**
	 * What a start of the app would read from disk right now, with the stores
	 * that are running left as they are. The store that reads never saves.
	 */
	const readDisk = <T>(read: (store: CotConfigStore) => T): T => {
		const reader = createCotConfigStore({
			cwd: dataDir,
			seal: safeStorageSeal(electronMock.safeStorage),
			getFolderContext: () => ({ agentDirs, userDataPath: dataDir, homeDir }),
			now: () => clock,
		});
		reader.dispose();
		return read(reader);
	};

	beforeEach(() => {
		electronMock.state.available = true;
		electronMock.state.key = 0x5a;
		electronMock.state.encryptThrows = false;
		// The real path, so a folder the store resolves compares equal on macOS,
		// where the temp dir is reached through a symlink.
		root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cot-config-')));
		dataDir = path.join(root, 'data');
		workspace = path.join(root, 'workspace');
		homeDir = path.join(root, 'home');
		for (const dir of [dataDir, workspace, homeDir]) fs.mkdirSync(dir);
		agentDirs = [workspace];
		clock = START;
		stores = [];
		electronMock.state.userData = dataDir;
		sessionsMock.sessions = [];
		sessionsMock.encoreFeatures = {};
		sessionsMock.syncPath = null;
		__resetCotConfigStoreForTests();
	});

	afterEach(() => {
		vi.useRealTimers();
		// No clock may beat after the temp dir is gone.
		for (const store of stores) store.dispose();
		flushCotConfigStoreSync();
		__resetCotConfigStoreForTests();
		fs.rmSync(root, { recursive: true, force: true });
	});

	describe('when the OS offers encryption', () => {
		it('round-trips the config, the chain, and the status through the file', async () => {
			const logs = logFolder('logs');
			const store = makeStore();

			expect(store.setAgentConfig(AGENT, { enabled: true, folder: logs })).toEqual({
				ok: true,
				config: { enabled: true, folder: logs, updatedAt: START },
			});
			store.setChainHead(AGENT, { folder: logs, head: HASH_A, chainSeq: 4 });
			store.recordWrite(AGENT, START + 10);
			store.recordError(AGENT, 'The disk is full.', START + 20);
			store.flushSync();

			const again = makeStore();
			expect(again.getAgentConfig(AGENT)).toEqual({
				enabled: true,
				folder: logs,
				updatedAt: START,
			});
			expect(again.isEnabled(AGENT)).toBe(true);
			expect(again.getChainState(AGENT, logs)).toEqual({ folder: logs, head: HASH_A, chainSeq: 4 });
			expect(await again.getStatus(AGENT)).toEqual({
				enabled: true,
				folder: logs,
				turnsToday: 0,
				unencrypted: false,
				lastWriteAt: START + 10,
				lastError: { message: 'The disk is full.', at: START + 20 },
			});
		});

		it('keeps every path, id, and field name out of the file', () => {
			const logs = logFolder('audit-trail-folder');
			const store = makeStore();
			store.setAgentConfig(AGENT, { enabled: true, folder: logs });
			store.setChainHead(AGENT, { folder: logs, head: HASH_A, chainSeq: 0 });
			store.flushSync();

			expect(path.basename(storeFile())).toBe('maestro-device-state.json');
			expect(Object.keys(readFile())).toEqual(['blob']);
			const raw = fs.readFileSync(storeFile(), 'utf8');
			for (const secret of ['audit-trail-folder', AGENT, 'agents', 'folder', 'chainSeq', HASH_A]) {
				expect(raw).not.toContain(secret);
			}
		});
	});

	describe('when the OS offers no encryption', () => {
		beforeEach(() => {
			electronMock.state.available = false;
		});

		it('never writes the state as readable text, says so, and reads it back', async () => {
			const logs = logFolder('audit-trail-folder');
			const store = makeStore();
			expect(store.setAgentConfig(AGENT, { enabled: true, folder: logs }).ok).toBe(true);

			expect(Object.keys(readFile())).toEqual(['obscured']);
			const onDisk = fs.readFileSync(storeFile(), 'utf8');
			for (const word of ['audit-trail-folder', AGENT, 'enabled', 'agents', 'folder']) {
				expect(onDisk, word).not.toContain(word);
			}
			expect((await store.getStatus(AGENT)).unencrypted).toBe(true);

			const again = makeStore();
			expect(again.isEnabled(AGENT)).toBe(true);
			expect(again.getChainState(AGENT, logs)).toEqual({
				folder: logs,
				head: COT_GENESIS_HASH,
				chainSeq: COT_GENESIS_CHAIN_SEQ,
			});
			expect((await again.getStatus(AGENT)).unencrypted).toBe(true);
		});

		it('does not open an obscured file that was edited by hand', () => {
			makeStore().setAgentConfig(AGENT, { enabled: true, folder: logFolder('logs') });
			const bytes = Buffer.from((readFile() as { obscured: string }).obscured, 'base64');
			bytes[bytes.length - 1] ^= 0x01;
			fs.writeFileSync(storeFile(), JSON.stringify({ obscured: bytes.toString('base64') }));

			const store = makeStore();

			expect(store.isEnabled(AGENT)).toBe(false);
			expect(store.getStateProblem()).toMatchObject({ kind: 'unreadable' });
		});

		it('takes no state from readable text someone put in the file', () => {
			// A file written by hand, in the shape the state has inside the seal.
			fs.writeFileSync(
				storeFile(),
				JSON.stringify({
					plain: {
						agents: {
							[AGENT]: {
								config: { enabled: true, folder: logFolder('logs'), updatedAt: START },
								chain: { folder: logFolder('logs'), head: HASH_A, chainSeq: 3 },
							},
						},
					},
					agents: { [AGENT]: { config: { enabled: true, folder: logFolder('logs') } } },
				})
			);

			const store = makeStore();

			expect(store.isEnabled(AGENT)).toBe(false);
			expect(store.getAgentConfig(AGENT)).toEqual({ enabled: false, folder: null, updatedAt: 0 });
		});

		it('seals an obscured file as soon as encryption is there', async () => {
			const logs = logFolder('logs');
			makeStore().setAgentConfig(AGENT, { enabled: true, folder: logs });
			expect(Object.keys(readFile())).toEqual(['obscured']);

			electronMock.state.available = true;
			const sealed = makeStore();

			expect(Object.keys(readFile())).toEqual(['blob']);
			expect(sealed.getAgentConfig(AGENT).folder).toBe(logs);
			expect(sealed.isEnabled(AGENT)).toBe(true);
			expect((await sealed.getStatus(AGENT)).unencrypted).toBe(false);
		});

		it('cannot open a sealed file once encryption is gone, and says so', () => {
			electronMock.state.available = true;
			makeStore().setAgentConfig(AGENT, { enabled: true, folder: logFolder('logs') });
			electronMock.state.available = false;

			const store = makeStore();

			expect(store.isEnabled(AGENT)).toBe(false);
			expect(store.getStateProblem()).toMatchObject({ kind: 'unreadable' });
		});
	});

	describe('a file that cannot be read', () => {
		let logs: string;
		let sealedBytes: Buffer;

		beforeEach(() => {
			logs = logFolder('logs');
			const store = makeStore();
			store.setAgentConfig(AGENT, { enabled: true, folder: logs });
			store.setChainHead(AGENT, { folder: logs, head: HASH_A, chainSeq: 7 });
			store.flushSync();
			sealedBytes = fs.readFileSync(storeFile());
		});

		it('says that the saved state could not be read, and only then', () => {
			expect(makeStore().getStateProblem()).toBeNull();

			electronMock.state.key = 0x33;
			const problem = makeStore().getStateProblem();
			expect(problem?.kind).toBe('unreadable');
			expect(problem?.message).toMatch(/could not read/i);
			expect(problem?.at).toBe(START);
		});

		it('starts empty, tells the person, and leaves the file as it is', async () => {
			// Another install's key: this start cannot open the blob.
			electronMock.state.key = 0x33;
			const store = makeStore();

			expect(store.isEnabled(AGENT)).toBe(false);
			expect(store.getAgentConfig(AGENT)).toEqual({ enabled: false, folder: null, updatedAt: 0 });
			expect(store.getChainState(AGENT, logs)).toBeNull();
			const status = await store.getStatus(AGENT);
			expect(status.enabled).toBe(false);
			expect(status.lastError?.message).toMatch(/could not read/i);

			// Nothing writes over bytes that another start may be able to read.
			store.setChainHead(AGENT, { folder: logs, head: HASH_B, chainSeq: 8 });
			store.recordWrite(AGENT, START);
			store.flushSync();
			expect(fs.readFileSync(storeFile()).equals(sealedBytes)).toBe(true);

			// With the right key back, the state is all there.
			electronMock.state.key = 0x5a;
			expect(makeStore().getChainState(AGENT, logs)).toEqual({
				folder: logs,
				head: HASH_A,
				chainSeq: 7,
			});
		});

		it('moves the unreadable file aside before the first save', async () => {
			electronMock.state.key = 0x33;
			const store = makeStore();
			const otherLogs = logFolder('other-logs');

			expect(store.setAgentConfig(OTHER_AGENT, { enabled: true, folder: otherLogs }).ok).toBe(true);

			const asideNames = fs
				.readdirSync(dataDir)
				.filter((name) => /^maestro-device-state\.corrupt-.+\.json$/.test(name));
			expect(asideNames).toHaveLength(1);
			expect(fs.readFileSync(path.join(dataDir, asideNames[0])).equals(sealedBytes)).toBe(true);

			// The new file is this start's own, and reads back.
			expect(makeStore().isEnabled(OTHER_AGENT)).toBe(true);
			// The agent the person set up again shows its own status. One that was
			// not still says why it is off.
			expect((await store.getStatus(OTHER_AGENT)).lastError).toBeUndefined();
			expect((await store.getStatus(AGENT)).lastError?.message).toMatch(/could not read/i);
		});

		it('takes a sealed file as unreadable when encryption is gone', async () => {
			electronMock.state.available = false;
			const store = makeStore();

			expect(store.isEnabled(AGENT)).toBe(false);
			const status = await store.getStatus(AGENT);
			expect(status.unencrypted).toBe(true);
			expect(status.lastError?.message).toMatch(/could not read/i);
			expect(fs.readFileSync(storeFile()).equals(sealedBytes)).toBe(true);
		});

		it('starts empty from a sealed state that is not a state', () => {
			const blob = electronMock.safeStorage.encryptString('{"agents":[]}').toString('base64');
			fs.writeFileSync(storeFile(), JSON.stringify({ blob }));
			expect(makeStore().isEnabled(AGENT)).toBe(false);
		});
	});

	describe('a file that went missing, or was put back from an older copy', () => {
		/** An anchor that lives in memory, as the OS credential store would hold it. */
		interface FakeAnchor extends AnchorStore {
			value: Anchor | null;
			usable: boolean;
			reads: number;
			writes: Anchor[];
			writeThrows: boolean;
		}

		const makeAnchor = (): FakeAnchor => {
			const fake: FakeAnchor = {
				value: null,
				usable: true,
				reads: 0,
				writes: [],
				writeThrows: false,
				available: () => fake.usable,
				read: () => {
					fake.reads += 1;
					return fake.value ? { ...fake.value } : null;
				},
				write: (next) => {
					if (fake.writeThrows) throw new Error('The credential store is locked.');
					fake.value = { ...next };
					fake.writes.push({ ...next });
				},
				clear: () => {
					fake.value = null;
				},
			};
			return fake;
		};

		let anchor: FakeAnchor;
		let logs: string;
		let secrets: number;

		/** A store with the anchor, as the app would make it after a restart. */
		const anchored = (extra: Partial<CotConfigStoreDeps> = {}): CotConfigStore =>
			makeStore({ anchor, newSecret: () => `secret-${++secrets}`, ...extra });

		beforeEach(() => {
			anchor = makeAnchor();
			logs = logFolder('logs');
			secrets = 0;
		});

		it('counts each change the person makes, in the file and in the anchor', () => {
			const store = anchored();
			store.setAgentConfig(AGENT, { enabled: true, folder: logs });
			expect(anchor.value).toEqual({ installSecret: 'secret-1', epoch: 1 });

			store.setAgentConfig(AGENT, { enabled: false, folder: logs });
			expect(anchor.value).toEqual({ installSecret: 'secret-1', epoch: 2 });

			// A head is not a change the person made: it moves with every record.
			store.setChainHead(AGENT, { folder: logs, head: HASH_A, chainSeq: 0 });
			store.flushSync();
			expect(anchor.writes).toHaveLength(2);

			// A change that changes nothing is not counted either.
			store.setAgentConfig(AGENT, { enabled: false, folder: logs });
			expect(anchor.writes).toHaveLength(2);
		});

		it('finds nothing wrong with the state it saved', async () => {
			anchored().setAgentConfig(AGENT, { enabled: true, folder: logs });

			const store = anchored();
			store.checkStateAnchor();

			expect(store.getStateProblem()).toBeNull();
			expect(store.isEnabled(AGENT)).toBe(true);
			expect((await store.getStatus(AGENT)).lastError).toBeUndefined();
		});

		it('says so when the file is gone and the anchor says there was one', async () => {
			anchored().setAgentConfig(AGENT, { enabled: true, folder: logs });
			fs.rmSync(storeFile());

			const store = anchored();
			// Nothing is known until the anchor is read: the start itself reads none.
			expect(store.getStateProblem()).toBeNull();
			expect(anchor.reads).toBe(1);
			store.checkStateAnchor();

			expect(store.isEnabled(AGENT)).toBe(false);
			expect(store.getStateProblem()).toMatchObject({ kind: 'missing', at: START });
			expect((await store.getStatus(AGENT)).lastError?.message).toMatch(/are missing/);
			// Telling is not mending: the anchor still says a state is owed.
			expect(anchor.value).toEqual({ installSecret: 'secret-1', epoch: 1 });
			expect(fs.existsSync(storeFile())).toBe(false);
		});

		it('is in step again once the person turns export back on', () => {
			anchored().setAgentConfig(AGENT, { enabled: true, folder: logs });
			fs.rmSync(storeFile());
			const store = anchored();
			store.checkStateAnchor();

			expect(store.setAgentConfig(AGENT, { enabled: true, folder: logs }).ok).toBe(true);
			// Past the anchor's count, under the anchor's own secret.
			expect(anchor.value).toEqual({ installSecret: 'secret-1', epoch: 2 });

			const next = anchored();
			next.checkStateAnchor();
			expect(next.getStateProblem()).toBeNull();
			expect(next.isEnabled(AGENT)).toBe(true);
		});

		it('says nothing for a first start, and writes nothing to the anchor', () => {
			const store = anchored();
			store.checkStateAnchor();

			expect(store.getStateProblem()).toBeNull();
			expect(anchor.writes).toEqual([]);
			expect(fs.readdirSync(dataDir)).toEqual([]);
		});

		it('takes a missing file for a reset profile when Maestro has no agent at all', () => {
			anchored().setAgentConfig(AGENT, { enabled: true, folder: logs });
			fs.rmSync(storeFile());

			const store = anchored({ isFreshProfile: () => true });
			store.checkStateAnchor();

			expect(store.getStateProblem()).toBeNull();
			// The anchor is let go, so the next start is a first start.
			expect(anchor.value).toBeNull();
		});

		it('says so when an older copy of the file was put back, and still uses it', async () => {
			const first = anchored();
			first.setAgentConfig(AGENT, { enabled: false, folder: logs });
			const older = fs.readFileSync(storeFile());
			first.setAgentConfig(AGENT, { enabled: true, folder: logs });
			first.setAgentConfig(OTHER_AGENT, { enabled: true, folder: logFolder('other') });
			expect(anchor.value?.epoch).toBe(3);
			fs.writeFileSync(storeFile(), older);

			const store = anchored();
			store.checkStateAnchor();

			expect(store.getStateProblem()).toMatchObject({ kind: 'replaced', at: START });
			// The older copy is what there is. Dropping it would turn everything off.
			expect(store.getAgentConfig(AGENT)).toMatchObject({ enabled: false, folder: logs });
			expect(store.isEnabled(AGENT)).toBe(false);
			// It is said for an agent with an entry and for one without.
			expect((await store.getStatus(AGENT)).lastError?.message).toMatch(/older copy/);
			expect((await store.getStatus(OTHER_AGENT)).lastError?.message).toMatch(/older copy/);
		});

		it("is the person's own again once they change something over an older copy", async () => {
			const first = anchored();
			first.setAgentConfig(AGENT, { enabled: false, folder: logs });
			const older = fs.readFileSync(storeFile());
			first.setAgentConfig(AGENT, { enabled: true, folder: logs });
			fs.writeFileSync(storeFile(), older);
			const store = anchored();
			store.checkStateAnchor();

			store.setAgentConfig(AGENT, { enabled: true, folder: logs });

			expect(store.getStateProblem()).toBeNull();
			expect((await store.getStatus(AGENT)).lastError).toBeUndefined();
			// Past the anchor's count, not past the older file's.
			expect(anchor.value?.epoch).toBe(3);
			const next = anchored();
			next.checkStateAnchor();
			expect(next.getStateProblem()).toBeNull();
		});

		it('says so when the file belongs to another anchor', () => {
			anchored().setAgentConfig(AGENT, { enabled: true, folder: logs });
			anchor.value = { installSecret: 'another-install', epoch: 1 };

			const store = anchored();
			store.checkStateAnchor();

			expect(store.getStateProblem()).toMatchObject({ kind: 'replaced' });
		});

		it('does not call a file that is ahead of its anchor an older copy', () => {
			anchor.writeThrows = true;
			const first = anchored();
			// The file is saved and the anchor is not: the change still holds.
			expect(first.setAgentConfig(AGENT, { enabled: true, folder: logs }).ok).toBe(true);
			anchor.writeThrows = false;
			first.setAgentConfig(AGENT, { enabled: false, folder: logs });
			anchor.writeThrows = true;
			first.setAgentConfig(AGENT, { enabled: true, folder: logs });
			expect(anchor.value).toEqual({ installSecret: 'secret-1', epoch: 2 });

			const store = anchored();
			store.checkStateAnchor();

			expect(store.getStateProblem()).toBeNull();
			expect(store.isEnabled(AGENT)).toBe(true);
		});

		it('vouches for a state that has no anchor yet', () => {
			// Saved with no anchor, as a store without one would.
			makeStore().setAgentConfig(AGENT, { enabled: true, folder: logs });

			const store = anchored();
			store.checkStateAnchor();

			expect(store.getStateProblem()).toBeNull();
			expect(anchor.value).toEqual({ installSecret: 'secret-1', epoch: 1 });
			// The secret is in the file too, so the next start finds them in step.
			store.flushSync();
			const next = anchored();
			next.checkStateAnchor();
			expect(next.getStateProblem()).toBeNull();
		});

		it('reads the anchor once, however often it is asked', async () => {
			anchored().setAgentConfig(AGENT, { enabled: true, folder: logs });
			const store = anchored();
			const before = anchor.reads;

			store.checkStateAnchor();
			store.checkStateAnchor();
			await store.getStatus(AGENT);
			await store.getStatus(AGENT);

			expect(anchor.reads).toBe(before + 1);
			// A turn asks only this, and it never goes near the anchor.
			store.isEnabled(AGENT);
			expect(anchor.reads).toBe(before + 1);
		});

		it('checks from the dialog too, so the status is never ahead of the check', async () => {
			anchored().setAgentConfig(AGENT, { enabled: true, folder: logs });
			fs.rmSync(storeFile());

			const status = await anchored().getStatus(AGENT);

			expect(status.lastError?.message).toMatch(/are missing/);
		});

		it.each([
			['the OS has no credential store', (): void => void (anchor.usable = false)],
			['the OS offers no encryption', (): void => void (electronMock.state.available = false)],
			[
				'the credential store fails',
				(): void => {
					anchor.read = () => {
						throw new Error('The credential store is locked.');
					};
				},
			],
		])('has nothing to say when %s', (_name, arrange) => {
			anchored().setAgentConfig(AGENT, { enabled: true, folder: logs });
			fs.rmSync(storeFile());
			arrange();

			const store = anchored();
			expect(() => store.checkStateAnchor()).not.toThrow();

			expect(store.getStateProblem()).toBeNull();
		});

		it('leaves a file it could not read to the report it already has', () => {
			anchored().setAgentConfig(AGENT, { enabled: true, folder: logs });
			electronMock.state.key = 0x33;

			const store = anchored();
			store.checkStateAnchor();

			expect(store.getStateProblem()).toMatchObject({ kind: 'unreadable' });
		});
	});

	describe('what is inside the seal', () => {
		it('opens with a nonce that is new at every save', () => {
			const store = makeStore();
			store.setAgentConfig(AGENT, { enabled: true, folder: logFolder('logs') });
			const unsealed = (): Record<string, unknown> =>
				JSON.parse(
					electronMock.safeStorage.decryptString(
						Buffer.from((readFile() as { blob: string }).blob, 'base64')
					)
				);

			const first = unsealed();
			store.flushSync();
			const second = unsealed();

			// First, so that it changes every block of a seal that chains them.
			expect(Object.keys(first)[0]).toBe('nonce');
			expect(first.nonce).toMatch(/^[0-9a-f]{32}$/);
			expect(second.nonce).not.toBe(first.nonce);
			expect(second.agents).toEqual(first.agents);
		});
	});

	describe('for someone who never turned it on', () => {
		it('never starts the clock, and never makes a file', () => {
			vi.useFakeTimers();
			const store = makeStore();
			store.isEnabled(AGENT);
			store.recordWrite(AGENT, START);

			vi.advanceTimersByTime(10 * PERSIST_INTERVAL_MS);
			store.flushSync();

			expect(fs.readdirSync(dataDir)).toEqual([]);
		});

		it('asks the OS key store for nothing, and writes nothing', () => {
			// On macOS the first use of the key can raise a keychain prompt. A
			// start, and every turn of every agent, must not cause one.
			const touched = (): never => {
				throw new Error('The seal was used.');
			};
			const store = createCotConfigStore({
				cwd: dataDir,
				seal: { available: touched, seal: touched, unseal: touched },
				getFolderContext: () => ({ agentDirs, userDataPath: dataDir, homeDir }),
				now: () => clock,
			});
			stores.push(store);

			expect(store.isEnabled(AGENT)).toBe(false);
			expect(store.getAgentConfig(AGENT)).toEqual({ enabled: false, folder: null, updatedAt: 0 });
			expect(store.getChainState(AGENT, logFolder('logs'))).toBeNull();
			store.setChainHead(AGENT, { folder: logFolder('logs'), head: HASH_A, chainSeq: 0 });
			store.recordWrite(AGENT, START);
			store.recordError(AGENT, 'nothing', START);
			store.flushSync();
			expect(fs.readdirSync(dataDir)).toEqual([]);
		});
	});

	describe('setAgentConfig', () => {
		it('refuses to turn export on with no folder', () => {
			const store = makeStore();
			for (const folder of [null, '', '   ']) {
				const result = store.setAgentConfig(AGENT, { enabled: true, folder });
				expect(result.ok).toBe(false);
				if (!result.ok) expect(result.reason).toMatch(/folder/i);
			}
			expect(store.isEnabled(AGENT)).toBe(false);
			expect(fs.existsSync(storeFile())).toBe(false);
		});

		it('refuses a folder that fails validation, and changes nothing', () => {
			const store = makeStore();
			const inside = path.join(workspace, 'logs');

			const relative = store.setAgentConfig(AGENT, { enabled: true, folder: 'logs' });
			expect(relative.ok).toBe(false);
			const inWorkspace = store.setAgentConfig(AGENT, { enabled: true, folder: inside });
			expect(inWorkspace.ok).toBe(false);
			if (!inWorkspace.ok) expect(inWorkspace.reason).toMatch(/workspace/i);
			// A folder that is only being stored, with export off, is checked too.
			expect(store.setAgentConfig(AGENT, { enabled: false, folder: inside }).ok).toBe(false);

			expect(store.isEnabled(AGENT)).toBe(false);
			expect(store.getAgentConfig(AGENT)).toEqual({ enabled: false, folder: null, updatedAt: 0 });
			expect(fs.existsSync(inside)).toBe(false);
			expect(fs.existsSync(storeFile())).toBe(false);
		});

		it('keeps a setting that was on when the new folder is refused', () => {
			const logs = logFolder('logs');
			const store = makeStore();
			store.setAgentConfig(AGENT, { enabled: true, folder: logs });

			const result = store.setAgentConfig(AGENT, {
				enabled: true,
				folder: path.join(workspace, 'logs'),
			});

			expect(result.ok).toBe(false);
			expect(store.getAgentConfig(AGENT)).toEqual({
				enabled: true,
				folder: logs,
				updatedAt: START,
			});
			expect(store.getChains(AGENT).past).toEqual([]);
		});

		it.skipIf(process.platform === 'win32')(
			'stores the real path, and takes a link to the stored folder as that folder',
			() => {
				const logs = logFolder('logs');
				const link = path.join(root, 'link-to-logs');
				fs.mkdirSync(logs);
				fs.symlinkSync(logs, link, 'dir');
				const store = makeStore();

				const first = store.setAgentConfig(AGENT, { enabled: true, folder: link });
				expect(first).toEqual({
					ok: true,
					config: { enabled: true, folder: logs, updatedAt: START },
				});
				store.setChainHead(AGENT, { folder: logs, head: HASH_A, chainSeq: 2 });

				// The same folder by another name is not a change of folder.
				clock = START + 1000;
				store.setAgentConfig(AGENT, { enabled: false, folder: link });
				expect(store.getChains(AGENT)).toEqual({
					current: { folder: logs, head: HASH_A, chainSeq: 2 },
					past: [],
				});
			}
		);

		it('turns export off even when the folder no longer passes', () => {
			const logs = logFolder('logs');
			const store = makeStore();
			store.setAgentConfig(AGENT, { enabled: true, folder: logs });
			// A new agent now works in a folder that holds the log.
			agentDirs.push(root);
			// Asking for what is already set is no new decision, so it is not refused.
			expect(store.setAgentConfig(AGENT, { enabled: true, folder: logs }).ok).toBe(true);
			expect(store.isEnabled(AGENT)).toBe(true);

			clock = START + 1000;
			const off = store.setAgentConfig(AGENT, { enabled: false, folder: logs });
			expect(off).toEqual({
				ok: true,
				config: { enabled: false, folder: logs, updatedAt: START + 1000 },
			});
			expect(store.isEnabled(AGENT)).toBe(false);

			// Turning it back on is a new decision, and that one is checked.
			const on = store.setAgentConfig(AGENT, { enabled: true, folder: logs });
			expect(on.ok).toBe(false);
			expect(store.isEnabled(AGENT)).toBe(false);
		});

		it('refuses a folder another agent uses, now or before', () => {
			const logs = logFolder('logs');
			const moved = logFolder('moved');
			const store = makeStore();
			store.setAgentConfig(AGENT, { enabled: true, folder: logs });

			const taken = store.setAgentConfig(OTHER_AGENT, { enabled: true, folder: logs });
			expect(taken.ok).toBe(false);
			if (!taken.ok) expect(taken.reason).toMatch(/another agent/i);

			// The first agent moves on. Its old folder still holds its chain.
			store.setAgentConfig(AGENT, { enabled: true, folder: moved });
			expect(store.setAgentConfig(OTHER_AGENT, { enabled: true, folder: logs }).ok).toBe(false);
			expect(store.isEnabled(OTHER_AGENT)).toBe(false);
		});

		it('reports a save that failed and keeps the old setting', () => {
			const logs = logFolder('logs');
			const store = makeStore();
			store.setAgentConfig(AGENT, { enabled: true, folder: logs });
			const before = fs.readFileSync(storeFile());

			electronMock.state.encryptThrows = true;
			const result = store.setAgentConfig(AGENT, { enabled: false, folder: logs });

			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toMatch(/could not save/i);
			expect(store.isEnabled(AGENT)).toBe(true);
			expect(store.getAgentConfig(AGENT).enabled).toBe(true);
			expect(fs.readFileSync(storeFile()).equals(before)).toBe(true);
		});

		it('saves nothing, and keeps the change time, when nothing changes', () => {
			const logs = logFolder('logs');
			const store = makeStore();
			store.setAgentConfig(AGENT, { enabled: true, folder: logs });
			const before = fs.readFileSync(storeFile());

			clock = START + 5000;
			expect(store.setAgentConfig(AGENT, { enabled: true, folder: logs })).toEqual({
				ok: true,
				config: { enabled: true, folder: logs, updatedAt: START },
			});
			expect(fs.readFileSync(storeFile()).equals(before)).toBe(true);

			// An agent that was never set up gets no entry for being left off.
			expect(store.setAgentConfig(OTHER_AGENT, { enabled: false, folder: null }).ok).toBe(true);
			expect(fs.readFileSync(storeFile()).equals(before)).toBe(true);
		});

		it('saves a change before it returns, with no timer', () => {
			vi.useFakeTimers();
			const logs = logFolder('logs');
			makeStore().setAgentConfig(AGENT, { enabled: true, folder: logs });
			expect(makeStore().isEnabled(AGENT)).toBe(true);
		});
	});

	describe('validateFolder', () => {
		it('answers as setAgentConfig would, and changes nothing', () => {
			const logs = logFolder('logs');
			const store = makeStore();

			expect(store.validateFolder(AGENT, logs)).toEqual({ ok: true, resolved: logs });
			expect(store.validateFolder(AGENT, path.join(workspace, 'logs')).ok).toBe(false);
			expect(store.validateFolder(AGENT, 'logs').ok).toBe(false);

			expect(store.isEnabled(AGENT)).toBe(false);
			expect(store.getAgentConfig(AGENT).folder).toBeNull();
			expect(fs.existsSync(storeFile())).toBe(false);
		});

		it("refuses the folder of another agent, and takes the agent's own", () => {
			const logs = logFolder('logs');
			const store = makeStore();
			store.setAgentConfig(AGENT, { enabled: true, folder: logs });

			const taken = store.validateFolder(OTHER_AGENT, logs);
			expect(taken.ok).toBe(false);
			if (!taken.ok) expect(taken.reason).toMatch(/another agent/i);
			expect(store.validateFolder(AGENT, logs)).toEqual({ ok: true, resolved: logs });
		});
	});

	describe('a change of folder', () => {
		let first: string;
		let second: string;
		let store: CotConfigStore;

		beforeEach(() => {
			first = logFolder('first');
			second = logFolder('second');
			store = makeStore();
			store.setAgentConfig(AGENT, { enabled: true, folder: first });
			store.setChainHead(AGENT, { folder: first, head: HASH_A, chainSeq: 3 });
		});

		it('closes the old chain and opens one at the genesis hash', () => {
			clock = START + 1000;
			expect(store.setAgentConfig(AGENT, { enabled: true, folder: second }).ok).toBe(true);

			expect(store.getChains(AGENT)).toEqual({
				current: { folder: second, head: COT_GENESIS_HASH, chainSeq: COT_GENESIS_CHAIN_SEQ },
				past: [{ folder: first, head: HASH_A, chainSeq: 3, closedAt: START + 1000 }],
			});
			// Both survive a restart, so the old folder can still be verified.
			expect(makeStore().getChains(AGENT)).toEqual(store.getChains(AGENT));
		});

		it('goes by folder, so a turn that started before the change advances the closed chain', () => {
			clock = START + 1000;
			store.setAgentConfig(AGENT, { enabled: true, folder: second });

			// The writer still finds the old chain by its folder...
			expect(store.getChainState(AGENT, first)).toEqual({
				folder: first,
				head: HASH_A,
				chainSeq: 3,
			});
			// ...and its next head lands on that chain, not on the new one.
			store.setChainHead(AGENT, { folder: first, head: HASH_B, chainSeq: 4 });

			expect(store.getChains(AGENT)).toEqual({
				current: { folder: second, head: COT_GENESIS_HASH, chainSeq: COT_GENESIS_CHAIN_SEQ },
				past: [{ folder: first, head: HASH_B, chainSeq: 4, closedAt: START + 1000 }],
			});
			store.flushSync();
			expect(makeStore().getChainState(AGENT, first)).toEqual({
				folder: first,
				head: HASH_B,
				chainSeq: 4,
			});
		});

		it('takes a chain up again when the person goes back to its folder', () => {
			clock = START + 1000;
			store.setAgentConfig(AGENT, { enabled: true, folder: second });
			store.setChainHead(AGENT, { folder: second, head: HASH_B, chainSeq: 0 });
			clock = START + 2000;
			store.setAgentConfig(AGENT, { enabled: true, folder: first });

			// One chain per folder: the first is current again, where it stood.
			expect(store.getChains(AGENT)).toEqual({
				current: { folder: first, head: HASH_A, chainSeq: 3 },
				past: [{ folder: second, head: HASH_B, chainSeq: 0, closedAt: START + 2000 }],
			});
		});

		it('closes the chain when the folder is cleared, and takes it up again later', () => {
			clock = START + 1000;
			expect(store.setAgentConfig(AGENT, { enabled: false, folder: null })).toEqual({
				ok: true,
				config: { enabled: false, folder: null, updatedAt: START + 1000 },
			});
			expect(store.getChains(AGENT)).toEqual({
				current: null,
				past: [{ folder: first, head: HASH_A, chainSeq: 3, closedAt: START + 1000 }],
			});

			store.setAgentConfig(AGENT, { enabled: true, folder: first });
			expect(store.getChains(AGENT)).toEqual({
				current: { folder: first, head: HASH_A, chainSeq: 3 },
				past: [],
			});
		});
	});

	describe('isEnabled', () => {
		it('follows every change of the switch', () => {
			const logs = logFolder('logs');
			const store = makeStore();
			expect(store.isEnabled(AGENT)).toBe(false);

			store.setAgentConfig(AGENT, { enabled: true, folder: logs });
			expect(store.isEnabled(AGENT)).toBe(true);
			expect(store.isEnabled(OTHER_AGENT)).toBe(false);

			store.setAgentConfig(AGENT, { enabled: false, folder: logs });
			expect(store.isEnabled(AGENT)).toBe(false);

			store.setAgentConfig(AGENT, { enabled: true, folder: logs });
			expect(store.isEnabled(AGENT)).toBe(true);
		});

		it('is not fooled by an id that is a property of every object', () => {
			const store = makeStore();
			for (const id of ['__proto__', 'constructor', 'toString']) {
				expect(store.isEnabled(id)).toBe(false);
				expect(store.getAgentConfig(id)).toEqual({ enabled: false, folder: null, updatedAt: 0 });
			}
		});
	});

	describe('saving by the clock', () => {
		let logs: string;
		let store: CotConfigStore;

		beforeEach(() => {
			vi.useFakeTimers();
			logs = logFolder('logs');
			store = makeStore();
			store.setAgentConfig(AGENT, { enabled: true, folder: logs });
		});

		/** The head a start of the app would read from disk. */
		const headOnDisk = (): string | undefined =>
			readDisk((reader) => reader.getChainState(AGENT, logs)?.head);

		it('saves a new head at the next beat, and not before', () => {
			store.setChainHead(AGENT, { folder: logs, head: HASH_A, chainSeq: 0 });
			vi.advanceTimersByTime(PERSIST_INTERVAL_MS - 1);
			expect(headOnDisk()).toBe(COT_GENESIS_HASH);

			vi.advanceTimersByTime(1);
			expect(headOnDisk()).toBe(HASH_A);
			expect(PERSIST_INTERVAL_MS).toBe(2000);
		});

		it('saves at every beat whether or not anything changed, and never the same bytes twice', () => {
			const seen = new Set([fs.readFileSync(storeFile(), 'utf8')]);

			for (let beat = 0; beat < 4; beat++) {
				// Removed, so that a file here after the beat is a file it wrote.
				fs.rmSync(storeFile());
				vi.advanceTimersByTime(PERSIST_INTERVAL_MS);
				expect(fs.existsSync(storeFile())).toBe(true);
				seen.add(fs.readFileSync(storeFile(), 'utf8'));
			}

			// Nothing changed in between, and yet no two saves are alike.
			expect(seen.size).toBe(5);
			expect(headOnDisk()).toBe(COT_GENESIS_HASH);
		});

		it('beats the same for an agent that is switched off', () => {
			store.setAgentConfig(AGENT, { enabled: false, folder: logs });
			fs.rmSync(storeFile());

			vi.advanceTimersByTime(PERSIST_INTERVAL_MS);

			expect(fs.existsSync(storeFile())).toBe(true);
			expect(readDisk((reader) => reader.isEnabled(AGENT))).toBe(false);
		});

		it('saves a write time and a failure the same way', async () => {
			store.recordWrite(AGENT, START + 5);
			store.recordError(AGENT, 'The folder is gone.', START + 6);
			expect((await readDisk((reader) => reader.getStatus(AGENT))).lastWriteAt).toBeUndefined();

			vi.advanceTimersByTime(PERSIST_INTERVAL_MS);
			const status = await readDisk((reader) => reader.getStatus(AGENT));
			expect(status.lastWriteAt).toBe(START + 5);
			expect(status.lastError).toEqual({ message: 'The folder is gone.', at: START + 6 });
		});

		it('flushSync saves at once', () => {
			store.setChainHead(AGENT, { folder: logs, head: HASH_A, chainSeq: 0 });
			store.flushSync();
			expect(headOnDisk()).toBe(HASH_A);
		});

		it('stops beating once it is disposed, and can still be flushed', () => {
			store.dispose();
			store.setChainHead(AGENT, { folder: logs, head: HASH_A, chainSeq: 0 });
			fs.rmSync(storeFile());

			vi.advanceTimersByTime(10 * PERSIST_INTERVAL_MS);
			expect(fs.existsSync(storeFile())).toBe(false);

			store.flushSync();
			expect(headOnDisk()).toBe(HASH_A);
		});

		it('does not bring back a data folder that is gone', () => {
			fs.rmSync(dataDir, { recursive: true, force: true });

			vi.advanceTimersByTime(PERSIST_INTERVAL_MS);
			store.flushSync();

			expect(fs.existsSync(dataDir)).toBe(false);
			fs.mkdirSync(dataDir);
		});

		it('ignores a head or a status for an agent or a folder it does not know', async () => {
			store.setChainHead(OTHER_AGENT, { folder: logs, head: HASH_A, chainSeq: 0 });
			store.setChainHead(AGENT, { folder: logFolder('elsewhere'), head: HASH_A, chainSeq: 0 });
			store.recordWrite(OTHER_AGENT, START);
			store.recordError(OTHER_AGENT, 'nothing', START);
			vi.advanceTimersByTime(PERSIST_INTERVAL_MS);

			expect(store.getChains(OTHER_AGENT)).toEqual({ current: null, past: [] });
			expect(store.getChains(AGENT).current?.head).toBe(COT_GENESIS_HASH);
			expect(store.getChainState(AGENT, logFolder('elsewhere'))).toBeNull();
			expect(await store.getStatus(OTHER_AGENT)).toEqual({
				enabled: false,
				folder: null,
				turnsToday: 0,
				unencrypted: false,
			});
		});

		it('keeps a change in memory when the save fails, and saves it at the next beat', () => {
			electronMock.state.encryptThrows = true;
			store.setChainHead(AGENT, { folder: logs, head: HASH_A, chainSeq: 0 });
			expect(() => vi.advanceTimersByTime(PERSIST_INTERVAL_MS)).not.toThrow();
			expect(store.getChainState(AGENT, logs)?.head).toBe(HASH_A);

			electronMock.state.encryptThrows = false;
			expect(headOnDisk()).toBe(COT_GENESIS_HASH);
			vi.advanceTimersByTime(PERSIST_INTERVAL_MS);
			expect(headOnDisk()).toBe(HASH_A);
		});
	});

	describe('from when the runs of the command line are recorded', () => {
		let logs: string;

		beforeEach(() => {
			logs = logFolder('logs');
		});

		it('is never, for an agent that was never turned on', () => {
			const store = makeStore();
			expect(store.getLedgerSince(AGENT)).toBeNull();

			store.setAgentConfig(AGENT, { enabled: false, folder: logs });
			expect(store.getLedgerSince(AGENT)).toBeNull();
		});

		it('is the moment export is turned on, and is saved', () => {
			const store = makeStore();
			store.setAgentConfig(AGENT, { enabled: true, folder: logs });

			expect(store.getLedgerSince(AGENT)).toBe(START);
			expect(makeStore().getLedgerSince(AGENT)).toBe(START);
		});

		it('is kept through a change of folder, and through being turned off', () => {
			const store = makeStore();
			store.setAgentConfig(AGENT, { enabled: true, folder: logs });
			clock = START + 60_000;

			store.setAgentConfig(AGENT, { enabled: true, folder: logFolder('other-logs') });
			expect(store.getLedgerSince(AGENT)).toBe(START);

			store.setAgentConfig(AGENT, { enabled: false, folder: logFolder('other-logs') });
			expect(store.getLedgerSince(AGENT)).toBe(START);
		});

		it('starts anew when export is turned on again, so a run from the time it was off is left out', () => {
			const store = makeStore();
			store.setAgentConfig(AGENT, { enabled: true, folder: logs });
			store.setAgentConfig(AGENT, { enabled: false, folder: logs });
			clock = START + 60_000;

			store.setAgentConfig(AGENT, { enabled: true, folder: logs });

			expect(store.getLedgerSince(AGENT)).toBe(START + 60_000);
		});

		it('lists the agents that are recorded right now', () => {
			const store = makeStore();
			expect(store.listEnabledAgents()).toEqual([]);

			store.setAgentConfig(AGENT, { enabled: true, folder: logs });
			store.setAgentConfig(OTHER_AGENT, { enabled: false, folder: logFolder('other-logs') });

			expect(store.listEnabledAgents()).toEqual([AGENT]);
		});
	});

	describe('getStatus', () => {
		const touch = (folder: string, start: Date, turnId: string): void => {
			const file = turnFilePath(folder, start, 'tab', turnId);
			fs.mkdirSync(path.dirname(file), { recursive: true });
			fs.writeFileSync(file, '');
		};

		it('counts the turns filed under today, on the local clock', async () => {
			const logs = logFolder('logs');
			const store = makeStore();
			store.setAgentConfig(AGENT, { enabled: true, folder: logs });
			touch(logs, new Date(2026, 9, 10, 9, 0, 0), 'turn-a');
			touch(logs, new Date(2026, 9, 10, 14, 59, 0), 'turn-b');
			touch(logs, new Date(2026, 9, 9, 23, 0, 0), 'turn-c');

			expect((await store.getStatus(AGENT)).turnsToday).toBe(2);
			clock = new Date(2026, 9, 11, 0, 0, 1).getTime();
			expect((await store.getStatus(AGENT)).turnsToday).toBe(0);
		});

		it('says an agent that was never set up is off, with no folder', async () => {
			expect(await makeStore().getStatus(AGENT)).toEqual({
				enabled: false,
				folder: null,
				turnsToday: 0,
				unencrypted: false,
			});
		});

		it('drops the last failure on a new folder or on turning back on, not on turning off', async () => {
			const logs = logFolder('logs');
			const store = makeStore();
			store.setAgentConfig(AGENT, { enabled: true, folder: logs });
			store.recordError(AGENT, 'The disk is full.', START);

			store.setAgentConfig(AGENT, { enabled: false, folder: logs });
			expect((await store.getStatus(AGENT)).lastError?.message).toBe('The disk is full.');

			store.setAgentConfig(AGENT, { enabled: true, folder: logs });
			expect((await store.getStatus(AGENT)).lastError).toBeUndefined();

			store.recordError(AGENT, 'The disk is full.', START);
			store.setAgentConfig(AGENT, { enabled: true, folder: logFolder('roomier') });
			expect((await store.getStatus(AGENT)).lastError).toBeUndefined();
		});
	});

	describe('a failure it keeps', () => {
		it('hands every failure of a set-up agent to onError, with no limit of its own', () => {
			const heard: Array<{ agentId: string; error: CotLastError }> = [];
			const store = makeStore({ onError: (agentId, error) => heard.push({ agentId, error }) });
			store.setAgentConfig(AGENT, { enabled: true, folder: logFolder('logs') });

			store.recordError(AGENT, 'The disk is full.', START + 1);
			store.recordError(AGENT, 'The disk is full.', START + 2);

			expect(heard).toEqual([
				{ agentId: AGENT, error: { message: 'The disk is full.', at: START + 1 } },
				{ agentId: AGENT, error: { message: 'The disk is full.', at: START + 2 } },
			]);
		});

		it('says nothing for an agent that was never set up', () => {
			const onError = vi.fn();
			makeStore({ onError }).recordError(OTHER_AGENT, 'nothing', START);
			expect(onError).not.toHaveBeenCalled();
		});

		it('keeps the failure when onError throws, and does not throw into the caller', async () => {
			const store = makeStore({
				onError: () => {
					throw new Error('The notice could not be raised.');
				},
			});
			store.setAgentConfig(AGENT, { enabled: true, folder: logFolder('logs') });

			expect(() => store.recordError(AGENT, 'The disk is full.', START + 1)).not.toThrow();
			expect((await store.getStatus(AGENT)).lastError).toEqual({
				message: 'The disk is full.',
				at: START + 1,
			});
		});
	});

	describe("the app's store", () => {
		it('tells the failure listener, whether it was set before the store was made or after', () => {
			const before = vi.fn();
			setCotFailureListener(before);
			const store = getCotConfigStore();
			store.setAgentConfig(AGENT, { enabled: true, folder: logFolder('logs') });
			store.recordError(AGENT, 'The disk is full.', START + 1);
			expect(before).toHaveBeenCalledWith(AGENT, { message: 'The disk is full.', at: START + 1 });

			// A second listener replaces the first, and null means nobody.
			const after = vi.fn();
			setCotFailureListener(after);
			store.recordError(AGENT, 'The disk is full.', START + 2);
			expect(before).toHaveBeenCalledTimes(1);
			expect(after).toHaveBeenCalledWith(AGENT, { message: 'The disk is full.', at: START + 2 });

			setCotFailureListener(null);
			expect(() => store.recordError(AGENT, 'The disk is full.', START + 3)).not.toThrow();
			expect(after).toHaveBeenCalledTimes(1);
		});

		it('lies in the app data folder, under the bland name, and is made once', () => {
			const store = getCotConfigStore();
			expect(getCotConfigStore()).toBe(store);

			expect(store.setAgentConfig(AGENT, { enabled: true, folder: logFolder('logs') }).ok).toBe(
				true
			);
			expect(fs.readdirSync(dataDir)).toEqual(['maestro-device-state.json']);
			expect(Object.keys(readFile())).toEqual(['blob']);
		});

		it('refuses a folder inside what a local agent works in, and inside the data folder', () => {
			const projectRoot = path.join(root, 'project');
			const playbooks = path.join(root, 'playbooks');
			for (const dir of [projectRoot, playbooks]) fs.mkdirSync(dir);
			sessionsMock.sessions = [
				{ id: 'a', cwd: workspace, projectRoot, autoRunFolderPath: playbooks },
				// Entries a damaged sessions file can hold must not break the check.
				null as unknown as Record<string, unknown>,
				{ id: 'b', cwd: '', projectRoot: 42 },
			];
			const store = getCotConfigStore();

			for (const inside of [workspace, projectRoot, playbooks, dataDir]) {
				const result = store.setAgentConfig(AGENT, {
					enabled: true,
					folder: path.join(inside, 'logs'),
				});
				expect(result.ok).toBe(false);
			}
			expect(store.setAgentConfig(AGENT, { enabled: true, folder: logFolder('logs') }).ok).toBe(
				true
			);
		});

		it('ignores the folders of a dormant Pianola agent while its Encore flag is off', () => {
			const pianolaCwd = path.join(root, 'pianola-cwd');
			fs.mkdirSync(pianolaCwd);
			sessionsMock.sessions = [
				{ id: 'pianola', isPianola: true, cwd: pianolaCwd, projectRoot: pianolaCwd },
			];
			const store = getCotConfigStore();
			const logs = path.join(pianolaCwd, 'logs');

			// Flag off: the agent is dormant and claims nothing.
			expect(store.setAgentConfig(AGENT, { enabled: true, folder: logs }).ok).toBe(true);

			// Flag on: the same agent is live and its workspace is refused.
			sessionsMock.encoreFeatures = { pianola: true };
			store.setAgentConfig(AGENT, { enabled: false, folder: logs });
			expect(store.setAgentConfig(AGENT, { enabled: true, folder: logs }).ok).toBe(false);
		});

		it('refuses a folder inside a directory an agent was granted, and inside where its worktrees go', () => {
			const granted = path.join(root, 'granted');
			const worktrees = path.join(root, 'worktrees');
			const legacyWorktrees = path.join(root, 'legacy-worktrees');
			for (const dir of [granted, worktrees, legacyWorktrees]) fs.mkdirSync(dir);
			sessionsMock.sessions = [
				{
					id: 'a',
					cwd: workspace,
					additionalDirectories: [
						{ path: granted, read: true, write: false },
						// Entries a damaged sessions file can hold must not break the check.
						null,
						{ path: 42 },
					],
					worktreeConfig: { basePath: worktrees },
				},
				{ id: 'b', cwd: workspace, worktreeParentPath: legacyWorktrees },
				{ id: 'c', cwd: workspace, additionalDirectories: 'not a list', worktreeConfig: 7 },
			];
			const store = getCotConfigStore();

			for (const inside of [granted, worktrees, legacyWorktrees]) {
				const result = store.setAgentConfig(AGENT, {
					enabled: true,
					folder: path.join(inside, 'logs'),
				});
				expect(result, inside).toMatchObject({ ok: false });
			}
			expect(store.setAgentConfig(AGENT, { enabled: true, folder: logFolder('logs') }).ok).toBe(
				true
			);
		});

		it('refuses a folder inside the folder the agent list was moved to', () => {
			const synced = path.join(root, 'synced');
			fs.mkdirSync(synced);
			sessionsMock.syncPath = synced;
			const store = getCotConfigStore();

			const result = store.setAgentConfig(AGENT, {
				enabled: true,
				folder: path.join(synced, 'logs'),
			});
			expect(result).toMatchObject({ ok: false });

			// Not moved: the agent list lies in the data folder, which is refused
			// as the data folder and adds nothing of its own.
			sessionsMock.syncPath = dataDir;
			expect(store.setAgentConfig(AGENT, { enabled: true, folder: logFolder('logs') }).ok).toBe(
				true
			);
		});

		it('reads the agents again at every change, and leaves out an agent on an SSH remote', () => {
			const remoteWorkspace = path.join(root, 'remote-workspace');
			sessionsMock.sessions = [
				{
					id: 'remote',
					cwd: remoteWorkspace,
					projectRoot: remoteWorkspace,
					sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
				},
			];
			const store = getCotConfigStore();
			const logs = path.join(remoteWorkspace, 'logs');

			// That path is a path on another machine. Here it is only a folder.
			expect(store.setAgentConfig(AGENT, { enabled: true, folder: logs }).ok).toBe(true);

			// The same agent, now local: the folder is inside its workspace.
			sessionsMock.sessions = [
				{ id: 'remote', cwd: remoteWorkspace, projectRoot: remoteWorkspace },
			];
			store.setAgentConfig(AGENT, { enabled: false, folder: logs });
			expect(store.setAgentConfig(AGENT, { enabled: true, folder: logs }).ok).toBe(false);
		});

		it('compares against the anchor that was set, whether before the store was made or after', () => {
			const held: { value: Anchor | null } = { value: null };
			const fake: AnchorStore = {
				available: () => true,
				read: () => held.value,
				write: (next) => {
					held.value = next;
				},
				clear: () => {
					held.value = null;
				},
			};
			sessionsMock.sessions = [{ id: AGENT, cwd: workspace }];

			// With none set, nothing is kept outside the file.
			const store = getCotConfigStore();
			store.setAgentConfig(AGENT, { enabled: true, folder: logFolder('logs') });
			expect(held.value).toBeNull();

			setCotStateAnchor(fake);
			store.setAgentConfig(AGENT, { enabled: false, folder: logFolder('logs') });
			expect(held.value).toMatchObject({ epoch: 2 });

			// The next start: the file is gone, and Maestro still has an agent.
			fs.rmSync(storeFile());
			__resetCotConfigStoreForTests();
			setCotStateAnchor(fake);
			const next = getCotConfigStore();
			next.checkStateAnchor();
			expect(next.getStateProblem()).toMatchObject({ kind: 'missing' });
		});

		it('lets the anchor go when the file is gone and Maestro has no agent', () => {
			const held: { value: Anchor | null } = { value: { installSecret: 's', epoch: 4 } };
			setCotStateAnchor({
				available: () => true,
				read: () => held.value,
				write: (next) => {
					held.value = next;
				},
				clear: () => {
					held.value = null;
				},
			});
			sessionsMock.sessions = [];

			const store = getCotConfigStore();
			store.checkStateAnchor();

			expect(store.getStateProblem()).toBeNull();
			expect(held.value).toBeNull();
		});

		it('names one anchor per data folder, under a bland service', () => {
			expect(COT_STATE_ANCHOR_SERVICE).toBe('com.maestro.device-state');
			const account = cotStateAnchorAccount(dataDir);
			expect(account).toMatch(/^state:[0-9a-f]{16}$/);
			expect(cotStateAnchorAccount(path.join(dataDir, '.'))).toBe(account);
			expect(cotStateAnchorAccount(path.join(root, 'other-data'))).not.toBe(account);
		});

		it('flushCotConfigStoreSync saves what is waiting, and never makes a store', () => {
			flushCotConfigStoreSync();
			expect(fs.readdirSync(dataDir)).toEqual([]);

			vi.useFakeTimers();
			const logs = logFolder('logs');
			const store = getCotConfigStore();
			store.setAgentConfig(AGENT, { enabled: true, folder: logs });
			store.setChainHead(AGENT, { folder: logs, head: HASH_A, chainSeq: 0 });

			flushCotConfigStoreSync();
			expect(makeStore().getChainState(AGENT, logs)?.head).toBe(HASH_A);
		});
	});
});
