/**
 * Consultation budget - how many peer consults and delegations one user
 * message may spend, counted across the WHOLE tree that descends from it.
 *
 * Peer rosters (`src/shared/peerAgents.ts`) let an agent reach another agent
 * without the user typing anything, and a group grant makes a five-agent group
 * a fully connected graph: A asks B, B asks C, C asks A. Each hop is a full
 * agent spawn. The budget is the one bound on that: a single number, spent by
 * every consult (`maestro-cli ask`, an agent's `@mention`) and every
 * delegation (`maestro-cli dispatch`) anywhere in the chain. It bounds fan-out
 * and chain length together, which a depth cap alone would not.
 *
 * This module is the setting's contract, shared by the three processes that
 * read it (the renderer's setter, the main process, and the CLI), so they
 * cannot disagree on the key, the default, or the range. It is also the
 * contract for how a process learns which chain it is in: the two environment
 * variables every member of a chain carries, and the functions that read and
 * write them.
 */

/** The settings key. Read it through this constant, never a string literal. */
export const MAX_CONSULTATIONS_PER_TURN_SETTING = 'maxConsultationsPerTurn';

/** Generous for a real collaboration, fatal to a runaway. */
export const DEFAULT_MAX_CONSULTATIONS_PER_TURN = 25;

/**
 * The most the setting accepts. A budget is a safety bound, so "unlimited" is
 * deliberately not a value: a tree this size is already a runaway.
 */
export const MAX_CONSULTATIONS_PER_TURN_CEILING = 500;

/**
 * The budget a stored value means.
 *
 * `0` is a real value, not "unset": it turns peer consults and delegations off
 * entirely. A missing or malformed value (never written, or written by hand as
 * a string through `maestro-cli settings set`) is the default, and a number is
 * rounded down and clamped to `0..MAX_CONSULTATIONS_PER_TURN_CEILING`. Every
 * reader goes through this, because the CLI can store any JSON under the key.
 */
export function normalizeMaxConsultationsPerTurn(raw: unknown): number {
	if (typeof raw !== 'number' || !Number.isFinite(raw)) {
		return DEFAULT_MAX_CONSULTATIONS_PER_TURN;
	}
	return Math.min(MAX_CONSULTATIONS_PER_TURN_CEILING, Math.max(0, Math.floor(raw)));
}

/**
 * Where one chain's budget stands: the budget, and what the chain has spent of
 * it. What an agent is TOLD about its budget (the Peer Agents block of its
 * system prompt), as opposed to what a spend decides. Read on Node by
 * `readConsultBudgetStatus()` in `src/main/peer-consults/consult-budget.ts`.
 */
export interface ConsultBudgetStatus {
	/** The setting, read through {@link normalizeMaxConsultationsPerTurn}. */
	limit: number;
	/** Consults and delegations the chain has already made. */
	spent: number;
}

/**
 * How many consults and delegations a chain has left, never below zero (a
 * budget the user lowered mid-run can sit under what was already spent).
 * Undefined when either number is not a count, so a caller that only shows the
 * figure leaves it out rather than print `NaN`.
 */
export function remainingConsultBudget(status: ConsultBudgetStatus): number | undefined {
	const { limit, spent } = status;
	if (!Number.isSafeInteger(limit) || !Number.isSafeInteger(spent) || limit < 0 || spent < 0) {
		return undefined;
	}
	return Math.max(0, limit - spent);
}

/** A chain has spent its whole budget (or the budget is `0`). */
export const CONSULT_BUDGET_EXHAUSTED_CODE = 'CONSULT_BUDGET_EXHAUSTED';

/** The counter could not be used, so the consult was refused rather than waved through. */
export const CONSULT_BUDGET_UNAVAILABLE_CODE = 'CONSULT_BUDGET_UNAVAILABLE';

export type ConsultBudgetRefusalCode =
	| typeof CONSULT_BUDGET_EXHAUSTED_CODE
	| typeof CONSULT_BUDGET_UNAVAILABLE_CODE;

/** A refused consult or delegation, as every verb reports it. */
export interface ConsultBudgetRefusal {
	code: ConsultBudgetRefusalCode;
	message: string;
}

/** Where the user changes the budget, named in every refusal. */
const CONSULT_BUDGET_SETTING_HINT = `the ${MAX_CONSULTATIONS_PER_TURN_SETTING} setting (Settings > General > Consultation Budget, or \`maestro-cli settings set ${MAX_CONSULTATIONS_PER_TURN_SETTING} <n>\`)`;

/**
 * The text of a refused consult or delegation.
 *
 * ONE wording for every verb (`maestro-cli send`, `ask`, `dispatch`, and an
 * agent's `@mention` in the app), because the reader is an agent and it has to
 * learn one thing from it: the peer was never reached. A refusal that read as
 * an empty answer would teach it that the peer had nothing to say. So each
 * message names the budget, what the chain has spent, and the setting.
 *
 * `problem` is the counter's own report that it could not be used
 * (`ConsultBudgetSpend.problem`). The count is then unknown, so it is not
 * printed.
 */
export function describeConsultBudgetRefusal(spend: {
	spent: number;
	limit: number;
	problem?: string;
}): ConsultBudgetRefusal {
	if (spend.problem) {
		return {
			code: CONSULT_BUDGET_UNAVAILABLE_CODE,
			message: `Consultation budget unavailable, so nothing was sent. ${spend.problem}`,
		};
	}
	if (spend.limit <= 0) {
		return {
			code: CONSULT_BUDGET_EXHAUSTED_CODE,
			message: `Peer consults and delegations are switched off, so nothing was sent: the consultation budget is 0. It is ${CONSULT_BUDGET_SETTING_HINT}.`,
		};
	}
	return {
		code: CONSULT_BUDGET_EXHAUSTED_CODE,
		message: `Consultation budget exhausted, so nothing was sent: the agents working on this message have spent ${spend.spent} of ${spend.limit} consults and delegations. Every agent in the chain shares this budget, so do not retry; finish with what you have. The budget is ${CONSULT_BUDGET_SETTING_HINT}.`,
	};
}

/** A UUID fits; so does any id a test or a future minter picks. */
const CONSULT_CHAIN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * Whether a value can name a consult chain.
 *
 * A chain id crosses process boundaries in an environment variable and is used
 * as a key in the counter file (`src/main/peer-consults/consult-budget.ts`), so
 * every reader checks its shape before trusting it. A value that fails is not a
 * chain: the counter refuses to spend on it rather than filing it under a key
 * nobody minted.
 */
export function isConsultChainId(value: unknown): value is string {
	return typeof value === 'string' && CONSULT_CHAIN_ID_PATTERN.test(value);
}

/** The chain a spawned agent's consults and delegations are counted against. */
export const CONSULT_CHAIN_ENV_VAR = 'MAESTRO_CONSULT_CHAIN';

/** How many hops from the user's message the process is. `0` is the root. */
export const CONSULT_DEPTH_ENV_VAR = 'MAESTRO_CONSULT_DEPTH';

/**
 * A process's place in a consult chain: the chain every consult and delegation
 * it makes is counted against, and how many hops it is from the user's message
 * that started the chain.
 *
 * The chain is carried in the environment ({@link CONSULT_CHAIN_ENV_VAR},
 * {@link CONSULT_DEPTH_ENV_VAR}) because its members are separate processes: an
 * agent's shell runs `maestro-cli ask`, which spawns the peer, whose own shell
 * runs `maestro-cli dispatch`. Nothing but the environment tells the last of
 * them that it descends from the first one's turn.
 *
 * The depth is a description, not the bound. The bound is the budget, spent
 * per chain id; the depth is there so a refusal and a log line can say how far
 * down the chain the caller is.
 */
export interface ConsultChain {
	chainId: string;
	depth: number;
}

/**
 * A depth as it was written by someone else. Anything that is not a whole
 * number from 0 up reads as 0: the chain id is what the budget is keyed on, so
 * a chain with a damaged depth is still that chain, and dropping it would hand
 * the caller a fresh budget.
 */
function normalizeConsultDepth(raw: unknown): number {
	const depth = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : raw;
	return typeof depth === 'number' && Number.isSafeInteger(depth) && depth >= 0 ? depth : 0;
}

/**
 * Narrow a chain that arrived as data (a spawn request, a CLI message).
 * Undefined when the id is not a chain id, which means "no chain", not an error.
 */
export function parseConsultChain(value: unknown): ConsultChain | undefined {
	if (typeof value !== 'object' || value === null) return undefined;
	const { chainId, depth } = value as Record<string, unknown>;
	if (!isConsultChainId(chainId)) return undefined;
	return { chainId, depth: normalizeConsultDepth(depth) };
}

/** The chain an environment carries, or undefined when it carries none. */
export function readConsultChainEnv(
	env: Record<string, string | undefined>
): ConsultChain | undefined {
	return parseConsultChain({
		chainId: env[CONSULT_CHAIN_ENV_VAR]?.trim(),
		depth: env[CONSULT_DEPTH_ENV_VAR],
	});
}

/** The env entries that put a spawned agent in a chain. */
export function buildConsultChainEnv(chain: ConsultChain): Record<string, string> {
	return {
		[CONSULT_CHAIN_ENV_VAR]: chain.chainId,
		[CONSULT_DEPTH_ENV_VAR]: String(chain.depth),
	};
}

/** The place in the chain of an agent this one consults or delegates to. */
export function childConsultChain(chain: ConsultChain): ConsultChain {
	return { chainId: chain.chainId, depth: chain.depth + 1 };
}

/**
 * An env override record with the chain removed, for anything that keys a
 * cache on how an agent is CONFIGURED (the omp model catalog). A root spawn
 * mints a new chain id, so keeping it gives every turn its own cache entry.
 * Returns undefined when nothing else is left, which is what an agent with no
 * overrides passes.
 */
export function withoutConsultChainEnv(
	env: Record<string, string> | undefined
): Record<string, string> | undefined {
	if (!env) return undefined;
	const rest = { ...env };
	delete rest[CONSULT_CHAIN_ENV_VAR];
	delete rest[CONSULT_DEPTH_ENV_VAR];
	return Object.keys(rest).length > 0 ? rest : undefined;
}
