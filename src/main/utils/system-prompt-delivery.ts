/**
 * How a Maestro system prompt reaches a spawned agent.
 *
 * Moved into maestro-lib (`turns/args.ts`, beside the placement rule
 * `applySystemPromptDelivery` there), so the desktop `process:spawn` handler,
 * Cue runs, Group Chat, consults, and the headless runtime's turns all deliver
 * it through one realization: the args, the embedded prompt, the Windows temp
 * file and its cleanup, and the logging. The library's own
 * `applySystemPromptDelivery` is the pure placement rule, so the realization
 * goes by `deliverSystemPrompt` there; this keeps the name every main-process
 * importer uses, and reports a failed cleanup to this process's Sentry as it
 * always has.
 *
 * The CLI (`src/cli/services/agent-spawner.ts`) realizes the same decision
 * itself: it cleans its temp file up when the child exits rather than on a
 * timer.
 */

import {
	deliverSystemPrompt,
	type SystemPromptDeliveryInput,
	type SystemPromptDeliveryResult,
} from '../../shared/maestro-lib/turns/args';
import { captureException } from './sentry';

export {
	redactSystemPromptArg,
	systemPromptTempFileName,
	SYSTEM_PROMPT_TEMP_FILE_TTL_MS,
	type DeliveredSystemPrompt as SystemPromptDelivery,
	type SystemPromptDeliveryInput,
	type SystemPromptDeliveryResult,
} from '../../shared/maestro-lib/turns/args';

/**
 * Apply the system prompt to a spawn's args/prompt. Returns new values; the
 * inputs are not mutated.
 */
export function applySystemPromptDelivery(
	input: SystemPromptDeliveryInput
): Promise<SystemPromptDeliveryResult> {
	return deliverSystemPrompt({ captureException, ...input });
}
