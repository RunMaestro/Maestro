/**
 * The consult budget counter - how much of `maxConsultationsPerTurn` each
 * consult chain has spent (the setting's contract is `src/shared/consultBudget.ts`).
 *
 * A chain is every consult and delegation that descends from one user message.
 * Its members are separate processes: agent A's shell runs `maestro-cli ask B`,
 * B's shell runs `maestro-cli dispatch C`, and the desktop app spawns an
 * `@mention` consult itself. So the count cannot live in any one of them. It
 * lives in ONE JSON file in Maestro's data directory, keyed by chain id:
 *
 *     { "<chainId>": { "count": 3, "updatedAt": 1760000000000 } }
 *
 * A file rather than app state because a headless `maestro-cli ask` with the
 * app closed must still be bounded, and because every participant can reach the
 * filesystem while not every one has a live connection to the app.
 *
 * Three rules hold the bound:
 *
 *  1. Every spend is a read-modify-write under a cross-process lock
 *     (`withDirectoryLock`), so two processes spending at once cannot both read
 *     the same count and each write `count + 1`.
 *  2. The file is replaced through an atomic rename, so a crash mid-write
 *     leaves the old counts, never a truncated file.
 *  3. A counter that cannot be read, locked or written REFUSES the consult and
 *     says why. It never falls back to "nothing spent": a recovery path that
 *     resets the count is a way around the budget for exactly the runaway the
 *     budget exists to stop.
 *
 * NODE ONLY, and free of Electron: `maestro-cli` imports this module too.
 * Everything here is synchronous because the CLI spends before it spawns and
 * the critical section is one small file.
 */

import * as fs from 'fs';
import * as path from 'path';
import { atomicWriteJsonSync } from '../../atomicJsonSync';
import {
	childConsultChain,
	describeConsultBudgetRefusal,
	isConsultChainId,
	type ConsultBudgetRefusal,
	type ConsultBudgetStatus,
	type ConsultChain,
} from '../../consultBudget';
import { withDirectoryLock } from '../../directoryLock';
import { resolveUserDataDir } from '../../userDataDir';
import { generateUUID } from '../../uuid';

/** The counter file, in Maestro's data directory. Per device, never synced. */
export const CONSULT_BUDGET_FILE = 'consult-budget.json';

/**
 * A chain idle for this long is forgotten. Generous on purpose: a chain is
 * live for as long as one user message is being worked on, and the only thing
 * the sweep is for is a run that crashed and will never spend again.
 */
export const CONSULT_CHAIN_TTL_MS = 6 * 60 * 60 * 1000;

/** The guarded work is one small read and one rename, so a holder this old has crashed. */
const LOCK_STALE_MS = 10_000;
/** The app spends on its main thread, so a held lock must not stall it for long. */
const LOCK_TIMEOUT_MS = 2000;

export interface ConsultBudgetStoreOptions {
	/**
	 * The directory that holds the counter file. Defaults to Maestro's data
	 * directory. Tests MUST pass a temp directory: `MAESTRO_USER_DATA` is set in
	 * an agent's shell, so the default is the live one even with Electron mocked.
	 */
	dataDir?: string;
	/** The current time in epoch ms. Injectable so expiry can be tested. */
	now?: number;
}

export interface ConsultBudgetSpend {
	/** Whether this consult may proceed. */
	allowed: boolean;
	/** What the chain has spent, counting this consult when it was allowed. */
	spent: number;
	/**
	 * Set when the consult was refused because the counter could not be used
	 * (unreadable, corrupt, locked, or handed something that is not a chain id)
	 * rather than because the budget ran out. `spent` is then unknown and
	 * reported as `0`. The caller must show this text: it is the only report of
	 * a broken counter.
	 */
	problem?: string;
}

export interface ConsultBudgetSweep {
	/** How many expired chains were removed. */
	swept: number;
	/** Set when the counter could not be used; nothing was removed. */
	problem?: string;
}

interface ChainEntry {
	count: number;
	updatedAt: number;
}

type Chains = Map<string, ChainEntry>;

/** A fresh chain id, minted at the root of a user message. */
export function newConsultChainId(): string {
	return generateUUID();
}

function counterFilePath(options: ConsultBudgetStoreOptions): string {
	return path.join(options.dataDir ?? resolveUserDataDir(), CONSULT_BUDGET_FILE);
}

function isChainEntry(value: unknown): value is ChainEntry {
	if (typeof value !== 'object' || value === null) return false;
	const { count, updatedAt } = value as Partial<ChainEntry>;
	return (
		typeof count === 'number' &&
		Number.isInteger(count) &&
		count >= 0 &&
		typeof updatedAt === 'number' &&
		Number.isFinite(updatedAt)
	);
}

/**
 * The counts on disk. A missing file is an empty counter (nothing has been
 * spent yet). Anything else that is not exactly the expected shape THROWS:
 * a truncated or hand-edited file must not read as "nothing spent".
 */
function readChains(filePath: string): Chains {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, 'utf-8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
		throw error;
	}

	const corrupt = (what: string): Error =>
		new Error(`the file ${what}; delete it to start every consult budget over`);

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw corrupt('is not valid JSON');
	}
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw corrupt('is not a JSON object');
	}

	const chains: Chains = new Map();
	for (const [chainId, entry] of Object.entries(parsed)) {
		if (!isConsultChainId(chainId) || !isChainEntry(entry)) {
			throw corrupt('holds an entry that is not a consult chain');
		}
		chains.set(chainId, { count: entry.count, updatedAt: entry.updatedAt });
	}
	return chains;
}

function isExpired(entry: ChainEntry, now: number): boolean {
	return now - entry.updatedAt > CONSULT_CHAIN_TTL_MS;
}

function dropExpired(chains: Chains, now: number): number {
	let swept = 0;
	for (const [chainId, entry] of chains) {
		if (isExpired(entry, now)) {
			chains.delete(chainId);
			swept += 1;
		}
	}
	return swept;
}

function describeProblem(filePath: string, error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return `The consult budget counter at ${filePath} could not be used: ${detail}.`;
}

/**
 * Read the counter, apply `change`, and write it back, all under the
 * cross-process lock. Expired chains are dropped on the way through, so every
 * write is also a sweep. `change` reports whether it altered anything; nothing
 * is written when neither it nor the sweep did.
 *
 * Throws on any failure (lock timeout, unreadable or corrupt file, failed
 * write). Callers turn that into a refusal; none of them may swallow it.
 */
function updateCounter<T>(
	options: ConsultBudgetStoreOptions,
	change: (chains: Chains, now: number, swept: number) => { value: T; changed: boolean }
): T {
	const filePath = counterFilePath(options);
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	return withDirectoryLock(
		`${filePath}.lock`,
		() => {
			const chains = readChains(filePath);
			const now = options.now ?? Date.now();
			const swept = dropExpired(chains, now);
			const { value, changed } = change(chains, now, swept);
			if (changed || swept > 0) {
				atomicWriteJsonSync(filePath, Object.fromEntries(chains), {
					indent: '\t',
					trailingNewline: true,
				});
			}
			return value;
		},
		{ timeoutMs: LOCK_TIMEOUT_MS, staleMs: LOCK_STALE_MS, label: 'consult budget' }
	);
}

/**
 * Spend one consult or delegation from a chain's budget.
 *
 * Atomic across processes: the count is read, compared with `limit` and
 * written back under one lock. A spend that would pass `limit` is refused and
 * does NOT count, so `spent` on a refusal is the true total and a budget the
 * user raises mid-run takes effect on the next attempt. A refusal still marks
 * the chain as active, so a runaway that keeps asking cannot wait out the
 * expiry and start over.
 *
 * `limit` is the setting read through `normalizeMaxConsultationsPerTurn()`.
 * `0` refuses everything.
 *
 * Never throws. A counter that cannot be used refuses the consult and returns
 * `problem`; it is never treated as an unspent budget.
 */
export function spendConsultBudget(
	chainId: string,
	limit: number,
	options: ConsultBudgetStoreOptions = {}
): ConsultBudgetSpend {
	if (!isConsultChainId(chainId)) {
		return {
			allowed: false,
			spent: 0,
			problem: `The consult was refused because its chain id is not one Maestro minted (${JSON.stringify(chainId)}).`,
		};
	}
	try {
		return updateCounter<ConsultBudgetSpend>(options, (chains, now) => {
			const entry = chains.get(chainId);
			const spent = entry?.count ?? 0;
			if (spent < limit) {
				chains.set(chainId, { count: spent + 1, updatedAt: now });
				return { value: { allowed: true, spent: spent + 1 }, changed: true };
			}
			if (entry) entry.updatedAt = now;
			return { value: { allowed: false, spent }, changed: entry !== undefined };
		});
	} catch (error) {
		return { allowed: false, spent: 0, problem: describeProblem(counterFilePath(options), error) };
	}
}

export interface ConsultAdmissionRequest {
	/**
	 * The caller's own place in a chain (`readConsultChainEnv()` for a process,
	 * `parseConsultChain()` for a message), when it is in one.
	 */
	chain?: ConsultChain;
	/**
	 * Whether an agent is making the call, as opposed to the user. Read only
	 * when `chain` is absent: a caller in a chain is a descendant whoever it is.
	 */
	fromAgent: boolean;
	/** The setting, read through `normalizeMaxConsultationsPerTurn()`. */
	limit: number;
}

export type ConsultAdmission =
	/** `chain` is the place the TARGET takes: put it in the agent that is spawned. */
	{ allowed: true; chain: ConsultChain } | ({ allowed: false } & ConsultBudgetRefusal);

/**
 * Decide whether one consult or delegation may go ahead, spend for it, and
 * name the place in the chain its target takes. The ONE admission rule, shared
 * by every verb (`maestro-cli send`, `ask` and `dispatch` through
 * `admitCliConsult()`, and the app's `@mention` router), so a mixed chain is
 * counted the same way at every hop.
 *
 * Three callers, and the asymmetry between them is deliberate:
 *
 *  1. In a chain: a descendant of some user message. It spends one from that
 *     chain, and its target sits one hop further down.
 *  2. An agent in no chain: its turn was a root nobody gave a chain to (an
 *     agent with no peer roster, a Cue run). The turn becomes the root of a new
 *     chain here and spends the first of it, so a budget of `0` still refuses
 *     it and its target's own consults are bounded.
 *  3. The user, in no chain (a shell, a script, a typed `@mention`): this call
 *     IS the user's message, not a consult made while working on one. It is
 *     always let through and spends nothing, even at a budget of `0`. It still
 *     mints a chain, with the target at depth 0, because without one nothing
 *     the target starts would ever be counted.
 *
 * Never throws. A refusal carries the text and code to report as they are.
 */
export function admitConsult(
	request: ConsultAdmissionRequest,
	options: ConsultBudgetStoreOptions = {}
): ConsultAdmission {
	const root: ConsultChain = { chainId: newConsultChainId(), depth: 0 };
	if (!request.chain && !request.fromAgent) {
		return { allowed: true, chain: root };
	}
	const mine = request.chain ?? root;
	const spend = spendConsultBudget(mine.chainId, request.limit, options);
	if (!spend.allowed) {
		return {
			allowed: false,
			...describeConsultBudgetRefusal({ ...spend, limit: request.limit }),
		};
	}
	return { allowed: true, chain: childConsultChain(mine) };
}

/**
 * What a chain has spent so far, without spending. `null` when that is not
 * known (the counter cannot be read, or the id is not a chain id), so a caller
 * that only wants to SHOW the remaining budget can leave it out rather than
 * print a guess. A chain past its expiry reads as `0`, which is what the next
 * spend would see.
 *
 * Takes no lock: the file is only ever replaced whole.
 */
export function readConsultBudgetSpent(
	chainId: string,
	options: ConsultBudgetStoreOptions = {}
): number | null {
	if (!isConsultChainId(chainId)) return null;
	try {
		const entry = readChains(counterFilePath(options)).get(chainId);
		if (!entry || isExpired(entry, options.now ?? Date.now())) return 0;
		return entry.count;
	} catch {
		// Not swallowed: the next spend on this counter refuses and reports why.
		return null;
	}
}

/**
 * Where the budget stands for a turn that is about to be spawned, for the one
 * sentence its system prompt carries (`formatPeerAgentsForPrompt()`), so the
 * agent can ration instead of finding the ceiling by hitting it.
 *
 * `chain` is the place the turn takes in a chain that already exists (a
 * consult, or a prompt another agent delegated). Without one the turn is a
 * ROOT: its chain is minted at the spawn, so nothing has been spent. A caller
 * that cannot say which of the two its spawn is (a Cue run, a Group Chat
 * participant) must not call this: a figure for a chain the agent is not in
 * is worse than no figure.
 *
 * Undefined when the count cannot be read. The sentence is then left out; the
 * agent's first spend refuses and reports the counter's problem.
 */
export function readConsultBudgetStatus(
	turn: { chain?: ConsultChain; limit: number },
	options: ConsultBudgetStoreOptions = {}
): ConsultBudgetStatus | undefined {
	if (!turn.chain) return { limit: turn.limit, spent: 0 };
	const spent = readConsultBudgetSpent(turn.chain.chainId, options);
	return spent === null ? undefined : { limit: turn.limit, spent };
}

/**
 * Remove every chain idle for longer than `CONSULT_CHAIN_TTL_MS`. Every spend
 * already does this on its way through; this is for a caller that wants the
 * sweep without a spend (startup, a test).
 *
 * Never throws. A counter that cannot be used is left exactly as it is and
 * reported in `problem`.
 */
export function sweepExpiredChains(options: ConsultBudgetStoreOptions = {}): ConsultBudgetSweep {
	try {
		return updateCounter<ConsultBudgetSweep>(options, (_chains, _now, swept) => ({
			value: { swept },
			changed: false,
		}));
	} catch (error) {
		return { swept: 0, problem: describeProblem(counterFilePath(options), error) };
	}
}
