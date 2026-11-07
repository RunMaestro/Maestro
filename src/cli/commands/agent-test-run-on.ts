// `maestro-cli agent test-run-on <agent>` - the Run on picker's Test button.
//
// One short read-only turn through the agent's own harness on its stored Run on
// target, run by the desktop app (the same `testAgentRunOn` the button calls),
// because the app owns the model server and the agent's launch. Only the
// agent's id is sent: the test launches what is stored.

import { RUN_ON_TEST_PROMPT, type RunOnTestResult } from '../../shared/local-models/run-on';
import { ExitCode, exitWith } from '../exit-codes';
import { formatError, formatSuccess } from '../output/formatter';
import { withMaestroClient } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';
import { failCommand, failFromError } from '../services/session-command';

interface TestRunOnOptions {
	json?: boolean;
}

/**
 * Long enough for the app to start the model server, load the model and run a
 * cold turn. The app applies its own budget to each of those and answers with
 * the reason when one runs out, so this is only the outer bound.
 */
const TEST_RUN_ON_TIMEOUT_MS = 20 * 60 * 1000;

export async function agentTestRunOn(agentRef: string, options: TestRunOnOptions): Promise<void> {
	let agentId: string;
	try {
		agentId = resolveAgentId(agentRef);
	} catch (error) {
		failCommand(error instanceof Error ? error.message : String(error), options.json);
	}

	let reply: { success: boolean; result?: RunOnTestResult; error?: string };
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand(
				{ type: 'local_models_run_on_test', agentId },
				'local_models_run_on_test_result',
				TEST_RUN_ON_TIMEOUT_MS
			)
		);
	} catch (error) {
		failFromError(error, options.json);
	}

	if (!reply.success || !reply.result) {
		failCommand(reply.error || 'The Run on test did not run', options.json);
	}
	const result = reply.result;

	if (!result.ok) {
		// The code is what a script branches on: a `run-on-*` refusal is the
		// launch's own, a `run-on-test-*` one is the test's.
		if (options.json) {
			console.log(
				JSON.stringify({
					success: false,
					code: result.code,
					error: result.message,
					...(result.durationMs === undefined ? {} : { durationMs: result.durationMs }),
				})
			);
		} else {
			console.error(formatError(`${result.message} [${result.code}]`));
		}
		exitWith(ExitCode.GeneralError);
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, ...result }));
		return;
	}
	console.log(formatSuccess(`${result.label} answered in ${Math.round(result.durationMs)} ms`));
	console.log(`  Model:   ${result.model}`);
	console.log(`  Context: ${result.contextTokens} tokens`);
	console.log(`  Asked:   ${RUN_ON_TEST_PROMPT}`);
	console.log(`  Reply:   ${result.reply}`);
}
