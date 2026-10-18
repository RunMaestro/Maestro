/**
 * Chain of thought export: the per-agent switch, and where each chain stands.
 *
 * Everything this feature remembers lives here and nowhere else: which agents
 * are recorded, into which folder, the newest hash of every chain, and each
 * agent's last write and last failure. None of it is copied onto the agent
 * (`Session`) object, into settings, or into the agent configs. Nothing under
 * `src/cli` or `src/main/web-server` may read this module.
 *
 * WHAT AN AGENT CAN FIND ON DISK
 * One file in Maestro's data folder, `maestro-device-state.json`. When the
 * operating system offers encryption, the file holds one field, `blob`: the
 * whole state, sealed with the key the OS keeps for this app. The folder
 * paths, the agent ids, and the field names are all inside the seal. When the
 * OS offers none (a Linux machine with no keyring), the file holds `obscured`:
 * the same state under a key that is built into the app (`obscuringSeal`). It
 * is never written as readable text. Every status then says `unencrypted`, so
 * the person can be told that the file is obscured and not encrypted.
 *
 * The limit, stated plainly: Maestro and its agents run as the same OS user.
 * The seal keeps a search of the disk from turning up a log folder. It does
 * not stop a process that sets out to get the same key from the OS, and the
 * obscured form does not stop anything that has read this app.
 *
 * For someone who never turned this on there is no file, and nothing is ever
 * written to the OS key store. It is read once, a few seconds after the app
 * starts (see "A file that went missing" below), and never at a turn.
 *
 * WHY THE HEAD IS KEPT HERE
 * A log folder cannot vouch for records that were removed from its end. So the
 * newest hash of each chain is kept here, outside the folder, and the verifier
 * compares the two.
 *
 * ONE FOLDER, ONE CHAIN
 * An agent has at most one chain per folder, and no two agents share a folder.
 * A change of folder closes the current chain into `pastChains` and opens a
 * chain in the new folder, so the old folder can still be verified. A turn
 * that started before the change keeps writing to the old chain, so a head can
 * arrive for a chain that is already closed: `getChainState` and
 * `setChainHead` go by folder, never by "the current chain". Going back to a
 * folder that holds a chain takes that chain up again. A second chain started
 * at the genesis hash in the same folder would repeat every position, and the
 * verifier reports that as a break.
 *
 * A FILE THAT WENT MISSING
 * A deleted file reads exactly like a first start, and an older sealed copy put
 * back in its place opens like the newest. Either would turn recording off, or
 * back to an earlier choice, with nobody told. So each change the person makes
 * is counted (`epoch`), and the count is kept in two places: inside the sealed
 * file, and in the OS credential store (`AnchorStore`). `checkStateAnchor`
 * compares them once per start:
 * - the credential store has a count and the file is gone: the person is told
 *   that the settings are missing
 * - the file's count is behind, or the file belongs to another anchor: the
 *   person is told that an older copy was put back. The file is still used as
 *   it is, because dropping it would turn recording off, which is the outcome
 *   this check exists to make visible.
 * The limit, stated plainly: a process that runs as the same OS user can remove
 * the credential entry as well as the file, and then nothing is left to
 * compare. This makes the removal of one file loud. It is not a wall.
 *
 * WHEN IT SAVES
 * A change the person makes (`setAgentConfig`) is saved before the call
 * returns. Everything else (a head, a write time, a failure) is kept in memory
 * and saved by a clock: the whole file is written again every
 * `PERSIST_INTERVAL_MS`, whether or not anything changed, from the moment the
 * store holds its first agent until the app quits, and once more on the way
 * out (`flushSync`). An app that stops hard in between loses nothing for good:
 * the writer finds the records past the stored head at its next write and
 * takes them up.
 *
 * The clock is the point. A file saved when a record lands would change, and
 * show a new time, only while a turn is being recorded, and anything that can
 * list the data folder could read that. Saved by the clock, the file says the
 * same thing whether an agent is recorded, idle, or switched off. Each save
 * also carries a new random `nonce`, so the bytes differ every time (the OS
 * seal alone gives the same bytes for the same state). Two limits: a save the
 * person makes lands off the beat, and a busy app can be late for one.
 *
 * This feature is hidden from agents on purpose. Read the header of
 * `src/shared/cotExport/types.ts` before you change or expose anything here.
 */

import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { app, safeStorage } from 'electron';
import Store from 'electron-store';
import { COT_GENESIS_CHAIN_SEQ, COT_GENESIS_HASH } from '../../shared/cotExport/types';
import type {
	CotAgentConfig,
	CotAgentStatus,
	CotChainState,
	CotFolderValidation,
	CotLastError,
	CotPastChain,
} from '../../shared/cotExport/types';
import { corruptStorePath, createStoreDeserializer } from '../stores/corrupt-store-recovery';
import { getLiveSessions, getSessionsStore, getSyncPath } from '../stores/getters';
import { createKeyringAnchor, noAnchor } from '../utils/keyring-anchor';
import type { AnchorStore } from '../utils/keyring-anchor';
import { logger } from '../utils/logger';
import { obscuringSeal, safeStorageSeal } from '../utils/safe-storage-seal';
import type { SealProvider } from '../utils/safe-storage-seal';
import { countTurnFilesOnDay, isSameFolder, validateAgentFolder } from './layout';
import type { AgentFolderContext, AgentWorkspace } from './layout';

// ============================================================================
// Contract
// ============================================================================

/**
 * Name of the store file, without its `.json`. It is bland on purpose: a name
 * that said what the file is for would be the one signal this feature must
 * not give. The name is friction, not security. What protects the content is
 * the seal, and the header above says how far that goes.
 */
export const COT_CONFIG_STORE_NAME = 'maestro-device-state';

/**
 * How often the whole file is saved, by the clock (see "When it saves" in the
 * header). It is also the longest a new head waits: the head kept here is what
 * shows that the end of a log was removed, and after a hard stop nothing past
 * the saved head can be told from a record that was never written.
 */
export const PERSIST_INTERVAL_MS = 2000;

const LOG_CONTEXT = 'Stores';

/** What the person is told when the saved state could not be read at start. */
const UNREADABLE_MESSAGE =
	'Maestro could not read the saved settings for this feature, so it is off for every agent until you turn it on again.';

/** What the person is told when the saved state is gone and the anchor says there was one. */
const MISSING_MESSAGE =
	'The saved settings for this feature are missing, so it is off for every agent until you turn it on again.';

/** What the person is told when the file on disk is older than the last change they made. */
const REPLACED_MESSAGE =
	'The saved settings for this feature were replaced with an older copy. Check which agents have it turned on, then choose a folder or change the switch to confirm.';

/**
 * Why the saved state is not the one the person last left:
 * - `unreadable`: there is a file and it could not be read
 * - `missing`: there is no file, and the credential store says there was one
 * - `replaced`: the file is an older copy, or belongs to another anchor
 */
export type CotStateProblemKind = 'unreadable' | 'missing' | 'replaced';

/** A problem with the saved state as a whole, for the notice raised at start. */
export interface CotStateProblem extends CotLastError {
	kind: CotStateProblemKind;
}

/** Everything the store holds about one agent. */
interface CotAgentEntry {
	config: CotAgentConfig;
	/**
	 * The chain in `config.folder`. Null exactly when no folder is chosen, so
	 * an agent that is on always has a chain to write to.
	 */
	chain: CotChainState | null;
	/** Chains in folders the agent used before. Kept so they can be verified. */
	pastChains: CotPastChain[];
	status: { lastWriteAt?: number; lastError?: CotLastError };
	/**
	 * From when the runs of the command line are taken into the log (see
	 * `ledger-runs.ts`). Set when export is turned on.
	 */
	ledger?: { since: number };
}

/** The state as it is sealed. */
interface CotStoreState {
	/** Random, and new at every save, so that no two saves give the same bytes. First on purpose. */
	nonce?: string;
	agents: Record<string, CotAgentEntry>;
	/**
	 * How many changes the person has made. The same number is kept in the OS
	 * credential store, and a file whose number is behind is an older copy.
	 */
	epoch?: number;
	/** Binds this file to its anchor in the credential store. */
	installSecret?: string;
}

/** The store file: one of the two fields, never both. */
interface CotStoreFile {
	/** Base64 of the state, sealed with the key the OS holds. */
	blob?: string;
	/** Base64 of the state under the app's own key, on a system that offers no encryption. */
	obscured?: string;
}

/**
 * The answer to a change of config. `reason` is one sentence for the person
 * who made the change. On a refusal nothing was changed.
 */
export type CotSetConfigResult =
	| { ok: true; config: CotAgentConfig }
	| { ok: false; reason: string };

/** Everything the store needs from outside. */
export interface CotConfigStoreDeps {
	/** The folder that holds the store file. */
	cwd: string;
	/** Seals the state with a key the OS holds, when the OS has one to offer. */
	seal: SealProvider;
	/**
	 * What `validateAgentFolder` checks a folder against. It is asked at every
	 * change of config, because agents come and go.
	 */
	getFolderContext: () => AgentFolderContext;
	/**
	 * A failure was kept as an agent's last error. It is told every failure,
	 * with no limit on how often, and nothing for an agent that was never set
	 * up. A throw from it goes nowhere.
	 */
	onError?: CotFailureListener;
	/**
	 * Where the count of the person's changes is kept outside the data folder.
	 * Defaults to none, and then a missing or older file cannot be told from an
	 * honest one.
	 */
	anchor?: AnchorStore;
	/**
	 * Whether Maestro has no agents at all. A missing file is then a profile
	 * that was reset, not a file that was taken away, and nobody is told.
	 */
	isFreshProfile?: () => boolean;
	/** A new install secret. Defaults to 32 random bytes as hex. */
	newSecret?: () => string;
	/**
	 * What the state is written under when `seal` is not available, so that it
	 * is never readable text. Defaults to `obscuringSeal()`.
	 */
	fallbackSeal?: SealProvider;
	/** The clock, in epoch milliseconds. Defaults to `Date.now`. */
	now?: () => number;
}

/** Hears a failure the store kept: which agent, and what went wrong. */
export type CotFailureListener = (agentId: string, error: CotLastError) => void;

export interface CotConfigStore {
	/** What the person chose for the agent. An agent never set up is off, with no folder. */
	getAgentConfig(agentId: string): CotAgentConfig;
	/**
	 * Changes what the person chose, and saves it before returning.
	 *
	 * A folder is checked with `validateAgentFolder` whenever export goes from
	 * off to on or the folder is a new one, and the real path is what gets
	 * stored. Turning export OFF with the folder left as it is always works: a
	 * folder that has gone bad must not be able to keep the person from
	 * stopping.
	 *
	 * The check runs when the person decides, not at every turn. A folder that
	 * passed stays in use if an agent is later given a workspace around it.
	 */
	setAgentConfig(
		agentId: string,
		next: { enabled: boolean; folder: string | null }
	): CotSetConfigResult;
	/**
	 * Whether `folder` may hold this agent's log, with nothing changed in the
	 * store: the checks of `validateAgentFolder`, and no chain of another agent
	 * in it. It is the check `setAgentConfig` runs, so a folder that passes
	 * here is one that call accepts. A folder that passes and does not exist
	 * yet is created.
	 */
	validateFolder(agentId: string, folder: string): CotFolderValidation;
	/**
	 * Whether the agent's turns are recorded. Served from memory with no disk
	 * read, because it is asked at the start of every turn of every agent.
	 */
	isEnabled(agentId: string): boolean;
	/**
	 * The agent's chain in `folder`, current or past, or null when it has none
	 * there. This is the writer's `getChainState`.
	 */
	getChainState(agentId: string, folder: string): CotChainState | null;
	/** Every chain of the agent, for a verify of each folder it has used. */
	getChains(agentId: string): { current: CotChainState | null; past: CotPastChain[] };
	/**
	 * The new head of the chain in `state.folder`, which can be a past chain.
	 * This is the writer's `onHeadAdvanced`. A head for a folder that holds no
	 * chain of the agent is ignored: a head never creates a chain.
	 */
	setChainHead(agentId: string, state: CotChainState): void;
	/** A record was written at `at`. */
	recordWrite(agentId: string, at: number): void;
	/** A record could not be written, or a head could not be checked. */
	recordError(agentId: string, message: string, at: number): void;
	/** What the Edit Agent dialog shows. It reads today's folders to count turns. */
	getStatus(agentId: string): Promise<CotAgentStatus>;
	/**
	 * Compares the saved state with the anchor in the OS credential store, once.
	 * A later call does nothing. It makes a synchronous call into the OS, so
	 * call it after startup and not during it. It never throws.
	 */
	checkStateAnchor(): void;
	/**
	 * Set when the saved state is not the one the person last left: it could
	 * not be read, it is missing, or it is an older copy. Null otherwise. The
	 * last two are known only after `checkStateAnchor`.
	 */
	getStateProblem(): CotStateProblem | null;
	/** The agents whose turns are recorded right now. */
	listEnabledAgents(): string[];
	/**
	 * When export was last turned on for the agent, in epoch milliseconds, or
	 * null for an agent that was never turned on. A run of the command line
	 * that started before it is not taken into the log.
	 */
	getLedgerSince(agentId: string): number | null;
	/** Saves now, without waiting for the clock. For the way out of the app. */
	flushSync(): void;
	/** Stops the clock that saves the file. `flushSync` still saves. For tests. */
	dispose(): void;
}

// ============================================================================
// Reading a stored state
// ============================================================================

const DEFAULT_CONFIG: CotAgentConfig = { enabled: false, folder: null, updatedAt: 0 };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readChain(raw: unknown): CotChainState | null {
	if (!isRecord(raw)) return null;
	const { folder, head, chainSeq } = raw;
	if (typeof folder !== 'string' || typeof head !== 'string' || typeof chainSeq !== 'number') {
		return null;
	}
	return { folder, head, chainSeq };
}

function readLastError(raw: unknown): CotLastError | undefined {
	if (!isRecord(raw) || typeof raw.message !== 'string' || typeof raw.at !== 'number') {
		return undefined;
	}
	return { message: raw.message, at: raw.at };
}

/**
 * One agent's entry, with the rules the rest of this module relies on put
 * back in force: a chain only in the chosen folder, and no agent on without a
 * chain. Maestro writes no other shape itself. The obscured form is a file a
 * person can edit, and a newer or older build can have written it.
 *
 * A chain is never dropped: one that does not belong to the chosen folder is
 * kept as a past chain, because its head is the only copy.
 */
function readEntry(raw: unknown): CotAgentEntry | null {
	if (!isRecord(raw)) return null;
	const config = isRecord(raw.config) ? raw.config : {};
	const folder = typeof config.folder === 'string' && config.folder !== '' ? config.folder : null;
	const updatedAt = typeof config.updatedAt === 'number' ? config.updatedAt : 0;

	const pastChains: CotPastChain[] = [];
	for (const item of Array.isArray(raw.pastChains) ? raw.pastChains : []) {
		const past = readChain(item);
		if (!past) continue;
		const closedAt = (item as Record<string, unknown>).closedAt;
		pastChains.push({ ...past, closedAt: typeof closedAt === 'number' ? closedAt : updatedAt });
	}

	const stored = readChain(raw.chain);
	const chain = stored && folder !== null && isSameFolder(stored.folder, folder) ? stored : null;
	if (stored && !chain) pastChains.push({ ...stored, closedAt: updatedAt });

	const status: CotAgentEntry['status'] = {};
	if (isRecord(raw.status)) {
		if (typeof raw.status.lastWriteAt === 'number') status.lastWriteAt = raw.status.lastWriteAt;
		const lastError = readLastError(raw.status.lastError);
		if (lastError) status.lastError = lastError;
	}

	const entry: CotAgentEntry = {
		config: { enabled: config.enabled === true && chain !== null, folder, updatedAt },
		chain,
		pastChains,
		status,
	};
	if (isRecord(raw.ledger) && typeof raw.ledger.since === 'number') {
		entry.ledger = { since: raw.ledger.since };
	}
	return entry;
}

/** The agents of a stored state. Throws when `raw` is not a state at all. */
function readAgents(raw: unknown): Map<string, CotAgentEntry> {
	if (!isRecord(raw) || !isRecord(raw.agents)) {
		throw new Error('The stored state has no agents.');
	}
	const agents = new Map<string, CotAgentEntry>();
	for (const [agentId, value] of Object.entries(raw.agents)) {
		const entry = readEntry(value);
		if (entry) agents.set(agentId, entry);
	}
	return agents;
}

/** The count and the install secret of a stored state. A state with neither is at zero. */
function readFreshness(raw: unknown): { epoch: number; installSecret: string | null } {
	const state = isRecord(raw) ? raw : {};
	return {
		epoch: typeof state.epoch === 'number' && Number.isFinite(state.epoch) ? state.epoch : 0,
		installSecret:
			typeof state.installSecret === 'string' && state.installSecret !== ''
				? state.installSecret
				: null,
	};
}

/** Why a save failed, in one sentence. */
function describeSaveError(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | null)?.code;
	return code
		? `Maestro could not save the change (${code}).`
		: 'Maestro could not save the change.';
}

// ============================================================================
// Store
// ============================================================================

export function createCotConfigStore(deps: CotConfigStoreDeps): CotConfigStore {
	const now = deps.now ?? Date.now;
	const anchor = deps.anchor ?? noAnchor();
	const fallbackSeal = deps.fallbackSeal ?? obscuringSeal();
	const newSecret = deps.newSecret ?? ((): string => randomBytes(32).toString('hex'));
	const storePath = path.resolve(deps.cwd, `${COT_CONFIG_STORE_NAME}.json`);
	const store = new Store<CotStoreFile>({
		name: COT_CONFIG_STORE_NAME,
		cwd: deps.cwd,
		deserialize: createStoreDeserializer<CotStoreFile>(storePath),
	});

	// A Map, not an object: an agent id arrives from outside this module, and a
	// Map has no key that means something else.
	let agents = new Map<string, CotAgentEntry>();
	/** The agents that are on. `isEnabled` reads only this. */
	let enabledAgents = new Set<string>();
	/**
	 * Set when the file on disk could not be read at start. It is shown as the
	 * last error of every agent the person has not set up again since.
	 */
	let loadProblem: CotStateProblem | null = null;
	/**
	 * Set when the file was read and is an older copy. It is shown for every
	 * agent that has no failure of its own, until the person makes a change.
	 */
	let replacedProblem: CotStateProblem | null = null;
	/** How many changes the person has made, as the file on disk has it. */
	let epoch = 0;
	/** What binds the file to its anchor. Null until the first change is saved. */
	let installSecret: string | null = null;
	/** There was no state on disk at start: a first start, or a file that was removed. */
	let nothingOnDisk = false;
	let anchorChecked = false;
	/**
	 * The file on disk is one this start could not read. It is moved aside,
	 * never written over, before the first save.
	 */
	let unreadableOnDisk = false;
	let saveFailing = false;

	function refreshEnabled(): void {
		const next = new Set<string>();
		for (const [agentId, entry] of agents) {
			if (entry.config.enabled) next.add(agentId);
		}
		enabledAgents = next;
	}

	/**
	 * Writes `next` to disk: sealed when the OS can seal, and under the app's
	 * own key when it cannot. It throws when the state could not be saved, and
	 * then the file on disk is as it was.
	 */
	function write(
		next: Map<string, CotAgentEntry>,
		freshness: { epoch: number; installSecret: string | null } = { epoch, installSecret }
	): void {
		if (unreadableOnDisk) {
			// The bytes this start could not read can be another start's whole
			// state: a keyring that was locked today, or a build signed with
			// another key. Keep them. If they cannot be moved, nothing is written.
			if (fs.existsSync(storePath)) {
				fs.renameSync(storePath, corruptStorePath(storePath, new Date(now())));
			}
			unreadableOnDisk = false;
		}
		const state: CotStoreState = {
			// First, so that it changes every block of a seal that chains its blocks.
			nonce: randomBytes(16).toString('hex'),
			agents: Object.fromEntries(next),
			epoch: freshness.epoch,
		};
		if (freshness.installSecret !== null) state.installSecret = freshness.installSecret;
		const text = JSON.stringify(state);
		// Assigning the whole document replaces it, so an `obscured` left from a
		// time without encryption does not stay beside a new `blob`.
		store.store = deps.seal.available()
			? { blob: deps.seal.seal(text).toString('base64') }
			: { obscured: fallbackSeal.seal(text).toString('base64') };
	}

	/**
	 * Saves the whole state now. It does nothing while the store holds no
	 * agent (someone who never turned this on gets no file), and nothing once
	 * the data folder is gone (a folder that was removed is not brought back).
	 */
	function save(): void {
		if (agents.size === 0) return;
		try {
			if (!fs.existsSync(deps.cwd)) return;
			write(agents);
			saveFailing = false;
		} catch (error) {
			// The state is still in memory, and the next beat tries again. Logged
			// once per run of failures, so a full disk does not fill the log as
			// well, and without the file's name: agents can read Maestro's logs,
			// and the name is what would point one at the file.
			if (!saveFailing) {
				const code = (error as NodeJS.ErrnoException | null)?.code ?? 'unknown error';
				logger.warn(`Could not save a state file (${code}).`, LOG_CONTEXT);
			}
			saveFailing = true;
		}
	}

	let beat: ReturnType<typeof setInterval> | null = null;
	let disposed = false;

	/** Starts the clock that saves the file, once the store holds an agent. */
	function startBeat(): void {
		if (beat !== null || disposed || agents.size === 0) return;
		beat = setInterval(save, PERSIST_INTERVAL_MS);
		// The clock must not keep the app from quitting.
		beat.unref?.();
	}

	function load(): void {
		let file: CotStoreFile;
		try {
			file = store.store;
		} catch {
			markUnreadable();
			return;
		}
		if (typeof file.blob === 'string') {
			try {
				// With no encryption on offer today there is no key to open it with.
				if (!deps.seal.available()) throw new Error('No encryption is available.');
				const state: unknown = JSON.parse(deps.seal.unseal(Buffer.from(file.blob, 'base64')));
				agents = readAgents(state);
				({ epoch, installSecret } = readFreshness(state));
			} catch {
				markUnreadable();
			}
			return;
		}
		if (typeof file.obscured !== 'string') {
			// A first start, or a file that was removed. The anchor tells them apart.
			nothingOnDisk = true;
			return;
		}
		try {
			const state: unknown = JSON.parse(fallbackSeal.unseal(Buffer.from(file.obscured, 'base64')));
			agents = readAgents(state);
			({ epoch, installSecret } = readFreshness(state));
		} catch {
			markUnreadable();
			return;
		}
		// The state was only obscured because there was no key then. There is one
		// now, so seal it. If that fails it stays as it is until the next save.
		if (deps.seal.available()) {
			try {
				write(agents);
			} catch {
				// Nothing is lost: the file on disk is still the whole state.
			}
		}
	}

	/**
	 * No log line: the person is told on their own screen (`getStateProblem`),
	 * and a line here would tell anything that reads Maestro's logs that the
	 * file had stopped being readable.
	 */
	function markUnreadable(): void {
		agents = new Map();
		unreadableOnDisk = true;
		loadProblem = { kind: 'unreadable', message: UNREADABLE_MESSAGE, at: now() };
	}

	/** Whether there is an anchor to compare against. Never throws. */
	function anchorUsable(): boolean {
		try {
			// With no seal the state lies in the clear, where anyone can set its
			// count, so an anchor would vouch for nothing.
			return deps.seal.available() && anchor.available();
		} catch {
			return false;
		}
	}

	function checkStateAnchor(): void {
		if (anchorChecked) return;
		anchorChecked = true;
		try {
			if (!anchorUsable()) return;
			const held = anchor.read();
			if (!held) {
				// State from before there was an anchor, or an anchor that was
				// removed while the file was left. Vouch for the file as it is.
				if (agents.size > 0) {
					// The next save by the clock puts the secret into the file too.
					installSecret ??= newSecret();
					anchor.write({ installSecret, epoch });
				}
				return;
			}
			// A file that could not be read is already reported.
			if (loadProblem) return;
			if (nothingOnDisk) {
				if (deps.isFreshProfile?.()) {
					// The whole profile was reset. There is no agent to record, and
					// an anchor left behind would call every later start a loss.
					anchor.clear();
					return;
				}
				loadProblem = { kind: 'missing', message: MISSING_MESSAGE, at: now() };
				return;
			}
			if (installSecret !== held.installSecret || epoch < held.epoch) {
				replacedProblem = { kind: 'replaced', message: REPLACED_MESSAGE, at: now() };
			}
		} catch {
			// A credential store that fails has nothing to say. The state is used
			// as it was read, which is what happens with no anchor at all.
		}
	}

	/** The agent's chain in `folder`, as the live object, and where it is kept. */
	function findChain(
		entry: CotAgentEntry,
		folder: string
	): { chain: CotChainState; pastIndex: number } | null {
		if (entry.chain && isSameFolder(entry.chain.folder, folder)) {
			return { chain: entry.chain, pastIndex: -1 };
		}
		const pastIndex = entry.pastChains.findIndex((past) => isSameFolder(past.folder, folder));
		return pastIndex === -1 ? null : { chain: entry.pastChains[pastIndex], pastIndex };
	}

	/** Whether an agent other than `agentId` has, or had, a chain in `folder`. */
	function isFolderOfAnotherAgent(agentId: string, folder: string): boolean {
		for (const [otherId, other] of agents) {
			if (otherId === agentId) continue;
			if (other.config.folder !== null && isSameFolder(other.config.folder, folder)) return true;
			if (findChain(other, folder)) return true;
		}
		return false;
	}

	function validateFolder(agentId: string, candidate: string): CotFolderValidation {
		const validation = validateAgentFolder(candidate, deps.getFolderContext());
		if (!validation.ok) return validation;
		if (isFolderOfAnotherAgent(agentId, validation.resolved)) {
			return {
				ok: false,
				reason:
					'That folder already holds the log of another agent. Choose a folder that only this agent uses.',
			};
		}
		return validation;
	}

	load();
	refreshEnabled();
	startBeat();

	return {
		getAgentConfig(agentId) {
			return { ...(agents.get(agentId)?.config ?? DEFAULT_CONFIG) };
		},

		setAgentConfig(agentId, next) {
			const entry: CotAgentEntry = agents.get(agentId) ?? {
				config: { ...DEFAULT_CONFIG },
				chain: null,
				pastChains: [],
				status: {},
			};
			const stored = entry.config.folder;
			const asked =
				typeof next.folder === 'string' && next.folder.trim() !== '' ? next.folder : null;
			const enabled = next.enabled === true;

			let folder: string | null = null;
			if (asked === null) {
				if (enabled)
					return { ok: false, reason: 'Choose a folder before you turn the audit log on.' };
			} else if (
				stored !== null &&
				isSameFolder(asked, stored) &&
				(!enabled || entry.config.enabled)
			) {
				// The folder is left as it is and export is not being turned on, so
				// no new decision is made and none is checked. This is what lets the
				// person turn export off when the folder has gone bad.
				folder = stored;
			} else {
				const validation = validateFolder(agentId, asked);
				if (!validation.ok) return validation;
				// Another spelling of the stored folder (a symlink, another case)
				// is the stored folder. Keep the stored text, so the chain's
				// folder and the config's folder stay one string.
				folder =
					stored !== null && isSameFolder(validation.resolved, stored)
						? stored
						: validation.resolved;
			}

			const folderChanged = folder !== stored;
			if (!folderChanged && enabled === entry.config.enabled) {
				// Nothing to change, so nothing to save. An agent that was never
				// set up gets no entry for being asked to stay off.
				return { ok: true, config: { ...entry.config } };
			}
			const at = now();
			let chain = entry.chain;
			let pastChains = entry.pastChains;
			if (folderChanged && chain) {
				pastChains = [...pastChains, { ...chain, closedAt: at }];
				chain = null;
			}
			if (folder !== null && chain === null) {
				const target = folder;
				const resumed = pastChains.find((past) => isSameFolder(past.folder, target));
				if (resumed) {
					pastChains = pastChains.filter((past) => past !== resumed);
					chain = { folder: resumed.folder, head: resumed.head, chainSeq: resumed.chainSeq };
					folder = resumed.folder;
				} else {
					chain = { folder: target, head: COT_GENESIS_HASH, chainSeq: COT_GENESIS_CHAIN_SEQ };
				}
			}

			// A failure belongs to the setup it happened under. A new folder, or
			// turning export back on, starts clean, and the next failure says so
			// again. Turning it off keeps the failure, so the reason stays visible.
			const startsClean = folderChanged || (enabled && !entry.config.enabled);
			const status = { ...entry.status };
			if (startsClean) delete status.lastError;

			const nextEntry: CotAgentEntry = {
				config: { enabled, folder, updatedAt: at },
				chain,
				pastChains,
				status,
			};
			// Turning export on starts the mark anew: a run of the command line
			// that began before this moment is not recorded.
			if (enabled && !entry.config.enabled) nextEntry.ledger = { since: at };
			else if (entry.ledger) nextEntry.ledger = entry.ledger;
			// Save first, and take the change into memory only once it is on
			// disk: a switch that reads as on and is gone after a restart is
			// worse than one that says it could not be changed.
			const candidate = new Map(agents);
			candidate.set(agentId, nextEntry);
			// A change the person makes is what the anchor counts. The new count
			// is past both the file's and the anchor's, so a change made over an
			// older copy leaves the two in step again.
			const anchored = anchorUsable();
			let held: ReturnType<AnchorStore['read']> = null;
			if (anchored) {
				try {
					held = anchor.read();
				} catch {
					held = null;
				}
			}
			const freshness = {
				epoch: Math.max(epoch, held?.epoch ?? 0) + 1,
				installSecret: installSecret ?? held?.installSecret ?? (anchored ? newSecret() : null),
			};
			try {
				write(candidate, freshness);
			} catch (error) {
				return { ok: false, reason: describeSaveError(error) };
			}
			agents = candidate;
			({ epoch, installSecret } = freshness);
			nothingOnDisk = false;
			// The person has seen the state and changed it: it is theirs again.
			replacedProblem = null;
			if (anchored && installSecret !== null) {
				try {
					// The file first, the anchor second. If this write fails the file
					// is ahead of the anchor, which is never read as an older copy.
					anchor.write({ installSecret, epoch });
				} catch {
					// A locked credential store. The next change tries again.
				}
			}
			saveFailing = false;
			refreshEnabled();
			startBeat();
			return { ok: true, config: { ...nextEntry.config } };
		},

		validateFolder,

		isEnabled(agentId) {
			return enabledAgents.has(agentId);
		},

		getChainState(agentId, folder) {
			const entry = agents.get(agentId);
			const found = entry ? findChain(entry, folder) : null;
			if (!found) return null;
			const { folder: chainFolder, head, chainSeq } = found.chain;
			return { folder: chainFolder, head, chainSeq };
		},

		getChains(agentId) {
			const entry = agents.get(agentId);
			return {
				current: entry?.chain ? { ...entry.chain } : null,
				past: (entry?.pastChains ?? []).map((past) => ({ ...past })),
			};
		},

		setChainHead(agentId, state) {
			const entry = agents.get(agentId);
			const found = entry ? findChain(entry, state.folder) : null;
			if (!entry || !found) return;
			// The stored folder text is kept: only the head and its position move.
			if (found.pastIndex === -1) {
				entry.chain = { folder: found.chain.folder, head: state.head, chainSeq: state.chainSeq };
			} else {
				entry.pastChains[found.pastIndex] = {
					...entry.pastChains[found.pastIndex],
					head: state.head,
					chainSeq: state.chainSeq,
				};
			}
		},

		recordWrite(agentId, at) {
			const entry = agents.get(agentId);
			if (!entry) return;
			entry.status.lastWriteAt = at;
		},

		recordError(agentId, message, at) {
			const entry = agents.get(agentId);
			if (!entry) return;
			entry.status.lastError = { message, at };
			try {
				deps.onError?.(agentId, { message, at });
			} catch {
				// The failure is kept above. A listener that fails must not throw
				// into the write path that reported it.
			}
		},

		async getStatus(agentId) {
			// The dialog must not be ahead of the check that runs after startup.
			checkStateAnchor();
			const entry = agents.get(agentId);
			const config = entry?.config ?? DEFAULT_CONFIG;
			let turnsToday = 0;
			if (config.folder !== null) {
				try {
					turnsToday = await countTurnFilesOnDay(config.folder, new Date(now()));
				} catch {
					// A folder that cannot be read shows no turns. The write path
					// reports that failure itself, as the agent's last error.
				}
			}
			const status: CotAgentStatus = {
				enabled: config.enabled,
				folder: config.folder,
				turnsToday,
				unencrypted: !deps.seal.available(),
			};
			if (entry?.status.lastWriteAt !== undefined) status.lastWriteAt = entry.status.lastWriteAt;
			// An agent the person has not set up since a failed start is off
			// because of that failure, so that is what its status says.
			// The same for an older copy: it is said for every agent, since it is
			// about what each of them is set to.
			const problem = (entry ? null : loadProblem) ?? replacedProblem;
			const lastError = entry?.status.lastError ?? problem;
			if (lastError) status.lastError = { message: lastError.message, at: lastError.at };
			return status;
		},

		checkStateAnchor,

		getStateProblem() {
			const problem = loadProblem ?? replacedProblem;
			return problem ? { ...problem } : null;
		},

		listEnabledAgents() {
			return [...enabledAgents];
		},

		getLedgerSince(agentId) {
			return agents.get(agentId)?.ledger?.since ?? null;
		},

		flushSync() {
			save();
		},

		dispose() {
			disposed = true;
			if (beat !== null) clearInterval(beat);
			beat = null;
		},
	};
}

// ============================================================================
// The app's store
// ============================================================================

let _store: CotConfigStore | null = null;
let _failureListener: CotFailureListener | null = null;
let _stateAnchor: AnchorStore | null = null;

/**
 * Service name of the anchor in the OS credential store. Bland for the reason
 * the file name is: the credential store lists its entries by name.
 */
export const COT_STATE_ANCHOR_SERVICE = 'com.maestro.device-state';

/**
 * Account name of the anchor for one data folder. A development run, a demo
 * instance and the installed app each have a data folder of their own, and
 * each must have an anchor of its own: one shared entry would make every one
 * of them call the others' files older copies.
 */
export function cotStateAnchorAccount(userDataPath: string): string {
	const digest = createHash('sha256').update(path.resolve(userDataPath), 'utf8').digest('hex');
	return `state:${digest.slice(0, 16)}`;
}

/**
 * The anchor the app's store compares its file against, or null for none. Like
 * the failure listener it can be set before or after the store is made, and it
 * is read each time it is needed. The app sets it where it registers the IPC
 * handlers of this feature. With none set, nothing touches the OS credential
 * store, which is what a test wants.
 */
export function setCotStateAnchor(anchor: AnchorStore | null): void {
	_stateAnchor = anchor;
}

/**
 * The anchor of this app's data folder, in the OS credential store. Making it
 * touches nothing: the native keyring module is loaded at the first use.
 */
export function createCotStateKeyringAnchor(): AnchorStore {
	return createKeyringAnchor(
		COT_STATE_ANCHOR_SERVICE,
		cotStateAnchorAccount(app.getPath('userData'))
	);
}

/** The app's anchor as the store sees it: whichever was set last, read at each call. */
const lateBoundAnchor: AnchorStore = {
	available: () => _stateAnchor?.available() ?? false,
	read: () => _stateAnchor?.read() ?? null,
	write: (value) => _stateAnchor?.write(value),
	clear: () => _stateAnchor?.clear(),
};

/**
 * Who is told when the app's store keeps a failure, or null for nobody. It can
 * be set before or after the store is made, and a second call replaces the
 * first. The IPC handlers of this feature set it, to tell the person.
 */
export function setCotFailureListener(listener: CotFailureListener | null): void {
	_failureListener = listener;
}

/**
 * Every folder a local agent works in or is pointed at: its working directory,
 * its project root, its Auto Run folder (which can lie outside the project,
 * and which the agent is told it may write to), the extra directories it was
 * granted (they reach the provider as flags and are named in its prompt), and
 * the folder its worktrees are created in (each one becomes an agent's working
 * directory, and its siblings are one `ls ..` away). An agent on an SSH remote
 * is left out: its paths are paths on another machine.
 */
export function agentDirsOf(sessions: unknown): AgentWorkspace[] {
	const dirs: AgentWorkspace[] = [];
	if (!Array.isArray(sessions)) return dirs;
	for (const session of sessions) {
		if (!isRecord(session)) continue;
		const ssh = session.sessionSshRemoteConfig;
		if (isRecord(ssh) && ssh.enabled === true) continue;
		const agentName = typeof session.name === 'string' ? session.name : '';
		const granted = Array.isArray(session.additionalDirectories)
			? session.additionalDirectories.map((dir) => (isRecord(dir) ? dir.path : undefined))
			: [];
		const worktrees = isRecord(session.worktreeConfig)
			? session.worktreeConfig.basePath
			: undefined;
		for (const dir of [
			session.cwd,
			session.projectRoot,
			session.autoRunFolderPath,
			worktrees,
			session.worktreeParentPath,
			...granted,
		]) {
			if (typeof dir === 'string' && dir.trim() !== '') dirs.push({ path: dir, agentName });
		}
	}
	return dirs;
}

/**
 * The folder that holds the agent list and the settings when the person moved
 * them out of the data folder (a synced folder). Undefined when they were not
 * moved, or when the stores are not up yet.
 */
function movedSyncPath(userDataPath: string): string | undefined {
	try {
		const syncPath = getSyncPath();
		return isSameFolder(syncPath, userDataPath) ? undefined : syncPath;
	} catch {
		return undefined;
	}
}

/**
 * The app's one store, made at the first call.
 *
 * It is made late for two reasons: `safeStorage` works only after the app's
 * `ready` event, and a test must be able to mock `electron` before this module
 * touches it. Do not call this before the app is ready.
 *
 * The file lies in the app's own data folder: per device, never in the sync
 * folder, and never shared between a development run and the installed app,
 * which seal with different keys and could not read each other's file.
 */
export function getCotConfigStore(): CotConfigStore {
	if (_store === null) {
		const userDataPath = app.getPath('userData');
		_store = createCotConfigStore({
			cwd: userDataPath,
			seal: safeStorageSeal(safeStorage),
			getFolderContext: () => ({
				// Live agents only: a dormant Pianola (flag off) keeps its home-folder
				// cwd in the store and must not claim folders it cannot use.
				agentDirs: agentDirsOf(getLiveSessions()),
				userDataPath,
				syncPath: movedSyncPath(userDataPath),
				homeDir: os.homedir(),
			}),
			// Read at each failure, so a listener set after this point is heard.
			onError: (agentId, error) => _failureListener?.(agentId, error),
			anchor: lateBoundAnchor,
			// The FULL list on purpose: this asks whether the profile was reset,
			// and a dormant agent's persisted record means it was not.
			isFreshProfile: () => {
				const sessions: unknown = getSessionsStore().get('sessions', []);
				return !Array.isArray(sessions) || sessions.length === 0;
			},
		});
	}
	return _store;
}

/**
 * Saves the app's store now. For the quit path, where no later beat of the
 * clock can be relied on. It does nothing when the store was never made, and
 * it never makes one.
 */
export function flushCotConfigStoreSync(): void {
	_store?.flushSync();
}

/** Drops the app's store and its listener so the next call starts new. For tests. */
export function __resetCotConfigStoreForTests(): void {
	_store?.dispose();
	_store = null;
	_failureListener = null;
	_stateAnchor = null;
}
