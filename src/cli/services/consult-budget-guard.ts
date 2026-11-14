/**
 * The consult budget, as a `maestro-cli` verb meets it.
 *
 * Every verb that reaches another agent (`send`, `ask`, `dispatch`) calls
 * `admitCliConsult()` once, after its arguments are known to be good and
 * before anything is spawned or sent. The rule itself is `admitConsult()`
 * (`src/main/peer-consults/consult-budget.ts`), which the app's `@mention`
 * router calls too; this module only supplies the three things the rule needs
 * from a CLI process: the chain its shell inherited, whether an agent's shell
 * ran it, and the setting.
 *
 * On a refusal the verb prints `message` and `code` in its own error shape and
 * exits non-zero. On success it hands `chain` to whatever spawns the target, so
 * the target's own consults keep spending the same budget.
 */

import { readSettingValue } from './storage';
import {
	admitConsult,
	type ConsultAdmission,
	type ConsultBudgetStoreOptions,
} from '../../main/peer-consults/consult-budget';
import { readCallerIdentity } from '../../shared/agentDelegation';
import {
	MAX_CONSULTATIONS_PER_TURN_SETTING,
	normalizeMaxConsultationsPerTurn,
	readConsultChainEnv,
} from '../../shared/consultBudget';

/**
 * Admit one consult or delegation made by this command.
 *
 * `env` is the environment the command runs in: an agent's shell carries its
 * chain (`MAESTRO_CONSULT_CHAIN`) and its identity; the user's own shell
 * carries neither, which is what makes the call the user's message rather than
 * a consult (see the three callers on `admitConsult()`).
 *
 * `options` exists for tests, which MUST pass a temp `dataDir`: the default is
 * the live Maestro data directory.
 */
export function admitCliConsult(
	env: Record<string, string | undefined> = process.env,
	options: ConsultBudgetStoreOptions = {}
): ConsultAdmission {
	return admitConsult(
		{
			chain: readConsultChainEnv(env),
			fromAgent: readCallerIdentity(env) !== undefined,
			limit: normalizeMaxConsultationsPerTurn(readSettingValue(MAX_CONSULTATIONS_PER_TURN_SETTING)),
		},
		options
	);
}
