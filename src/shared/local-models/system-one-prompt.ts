/**
 * What an agent's system prompt says about System One (pure, bundle-safe).
 *
 * System One is disclosed to an agent in three steps. This module is the first:
 * the short section every agent is spawned with while a request from it would
 * be answered. The second is `maestro-cli s1 guide`
 * (`./system-one-guide.ts`), the third is the `_system-one` reference the
 * section points at.
 *
 * Two rules live here so the three system prompt builders cannot disagree:
 *
 *   - {@link isSystemOneAdvertised}: whether the section is there at all. It is
 *     the answer `getSystemOneAgentAccess()` gives for the agent, so an agent
 *     is told about System One exactly while its `maestro-cli s1` verbs would
 *     work, and is told nothing while they would refuse.
 *   - {@link systemOnePromptVariables}: the words the section's template
 *     variables are filled with. The engine is named and so is whether its
 *     numbers are calibrated, the same as on every answer.
 */

import { formatCost } from '../formatters';
import { systemOneCostUsd } from './system-one';
import type { SystemOneAgentAccess, SystemOneAgentBudget } from './system-one-agent';

/** The core prompt that holds the section. */
export const SYSTEM_ONE_SYSTEM_PROMPT_ID = 'system-one-system';

/** The include the section points at with `{{REF:...}}`: the full reference. */
export const SYSTEM_ONE_REFERENCE_PROMPT_ID = '_system-one';

/**
 * True when an agent is told about System One.
 *
 * `access` is `getSystemOneAgentAccess()` for the agent being spawned, or
 * nothing when the builder could not ask (the desktop app is closed, or older
 * than this build). No answer reads as "not allowed": an agent is never told
 * about a tool that may refuse it.
 *
 * An SSH remote agent is never told. Its shell is on another host, where
 * `maestro-cli` cannot reach this desktop.
 */
export function isSystemOneAdvertised(
	access: SystemOneAgentAccess | null | undefined,
	opts: { isSsh: boolean }
): access is SystemOneAgentAccess {
	if (opts.isSsh || !access) return false;
	return access.allowed === true && access.engine !== 'off';
}

/** What `{{SYSTEM_ONE_ENGINE}}`, `{{SYSTEM_ONE_CALIBRATED}}` and `{{SYSTEM_ONE_BUDGET}}` render. */
export interface SystemOnePromptVariables {
	/** The engine as a person reads it, for example "Jev (TypeSafe cloud)". */
	engine: string;
	/** Whether the engine's numbers are probabilities, and what to do about it. */
	calibrated: string;
	/** The day's budget and roughly how much of it is left. */
	budget: string;
}

/** What the variables render while an agent is not told about System One. */
export const EMPTY_SYSTEM_ONE_PROMPT_VARIABLES: SystemOnePromptVariables = Object.freeze({
	engine: '',
	calibrated: '',
	budget: '',
});

/** What an agent is told about an engine whose numbers are calibrated. */
export const SYSTEM_ONE_CALIBRATED_NOTE =
	'calibrated: of the answers it gives 0.8, about 80% are true, so act on thresholds';

/** What an agent is told about the local judge. It must never read as a probability. */
export const SYSTEM_ONE_UNCALIBRATED_NOTE =
	"NOT calibrated: a general model's opinion. Read the answer (yes or no, the option, the level), never the number, and never gate a destructive action on it";

/** What an agent is told about spend on an engine that has no price. */
export const SYSTEM_ONE_FREE_ENGINE_NOTE = 'this engine has no price, so a request costs nothing';

/**
 * How much of a budget is left, in three words at most.
 *
 * The section is part of the system prompt, which a provider caches by its
 * exact text. An exact figure would change after every request any agent
 * sends, and each change costs every agent its cached prompt on its next turn.
 * A band changes at most twice a day. The exact figure is on the engine line
 * under every answer and in `maestro-cli s1 usage`.
 */
function budgetBand(fractionLeft: number): string {
	if (fractionLeft > 0.5) return 'more than half is left';
	if (fractionLeft > 0.1) return 'less than half is left';
	return 'less than a tenth is left';
}

/** The share of a budget that is left, 0 to 1. A budget of 0 has nothing left. */
function fractionLeft(remainingUsd: number, budgetUsd: number): number {
	return budgetUsd > 0 ? Math.min(1, Math.max(0, remainingUsd / budgetUsd)) : 0;
}

/** The budget sentence: what the day allows, and the band of the tighter of the two budgets. */
function budgetNote(budget: SystemOneAgentBudget): string {
	let left = fractionLeft(budget.remainingTodayUsd, budget.dailyBudgetUsd);
	let allowed = `${formatCost(budget.dailyBudgetUsd)} a day across all agents`;
	const own = budget.agent;
	if (own && own.budgetUsd !== null && own.remainingTodayUsd !== null) {
		allowed += `, ${formatCost(own.budgetUsd)} a day for this agent`;
		left = Math.min(left, fractionLeft(own.remainingTodayUsd, own.budgetUsd));
	}
	return `${allowed}; ${budgetBand(left)} today`;
}

/**
 * The words the section's variables are filled with, from the access the gate
 * was decided on. Every one is empty while System One is off, so a prompt that
 * names a variable outside the section renders nothing rather than a guess.
 */
export function systemOnePromptVariables(
	access: SystemOneAgentAccess | null | undefined
): SystemOnePromptVariables {
	if (!access || access.engine === 'off') return EMPTY_SYSTEM_ONE_PROMPT_VARIABLES;
	// A million tokens cost nothing on an engine that has no price.
	const free = systemOneCostUsd(access.engine, 1_000_000) === 0;
	return {
		engine: access.engineLabel,
		calibrated: access.calibrated ? SYSTEM_ONE_CALIBRATED_NOTE : SYSTEM_ONE_UNCALIBRATED_NOTE,
		budget: free ? SYSTEM_ONE_FREE_ENGINE_NOTE : budgetNote(access.budget),
	};
}
