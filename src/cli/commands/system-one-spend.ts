// `maestro-cli s1 usage|cost` - what System One has cost, and what a job would.
//
//   usage   what agents' own requests came to, per agent, from the decision
//           ledger, with today's spend against the budget. It runs in the
//           desktop, through the function the Settings view reads.
//   cost    a request or a job before it is run: its tokens against the request
//           limit, the requests it splits into, and the price. Arithmetic on
//           the caller's own text; the desktop is asked only which engine is in
//           force, and nothing is sent to an engine.

import * as fs from 'fs';

import { callerMessageFields, readCallerIdentity } from '../../shared/agentDelegation';
import { parseTimeInput } from '../../shared/timeInput';
import {
	JEV_PRICE_PER_MTOK_INPUT_USD,
	systemOneEngineLabel,
	systemOneStateProblem,
	type SystemOneState,
} from '../../shared/local-models/system-one';
import {
	estimateSystemOneJob,
	systemOneJobShapeProblem,
	type SystemOneUsageQuery,
	type SystemOneUsageReport,
} from '../../shared/local-models/system-one-spend';
import { ExitCode } from '../exit-codes';
import { formatSystemOneJobEstimate, formatSystemOneUsage } from '../output/system-one-answers';
import { resolveAgentOrFail, failCommand } from '../services/session-command';
import { SystemOneInputError, readState, type StateFlags } from '../services/system-one-input';
import { resolveCliPath } from '../utils/parse';
import { readStatus, send } from './system-one';

interface UsageOptions {
	agent?: string;
	since?: string;
	json?: boolean;
}

export async function systemOneUsage(options: UsageOptions): Promise<void> {
	const { json } = options;
	const query: SystemOneUsageQuery = {};
	if (options.agent !== undefined) query.agentId = resolveAgentOrFail(options.agent, json);
	if (options.since !== undefined) {
		const since = parseTimeInput(options.since, Date.now());
		if (since === null) {
			failCommand(
				`"${options.since}" is not a time. Use 30m, 2h, 1d, 1w, ISO-8601, or epoch.`,
				json,
				ExitCode.InvalidUsage
			);
		}
		query.since = since;
	}

	const reply = await send<{ success: boolean; error?: string; report?: SystemOneUsageReport }>(
		{ type: 'system_one_usage', query, ...callerMessageFields(readCallerIdentity(process.env)) },
		'system_one_usage_result',
		json
	);
	if (!reply.report) failCommand('The desktop app sent no usage report.', json);
	if (json) console.log(JSON.stringify({ success: true, ...reply.report }));
	else console.log(formatSystemOneUsage(reply.report));
}

interface CostOptions extends StateFlags {
	questions?: string;
	questionChars?: string;
	items?: string;
	perItem?: boolean;
	json?: boolean;
}

/** A flag that is a whole number, or absent. A wrong value is reported with the shape it belongs to. */
function count(value: string | undefined): number | undefined {
	return value === undefined ? undefined : Number(value);
}

/**
 * The state named as an argument: `-`, `@path`, the path of a file that exists,
 * or the text itself. It is the state flags' `--state`, with one addition: a
 * bare path is read, because `s1 cost notes.md` can only mean the file.
 */
function stateArgument(word: string): StateFlags {
	if (word === '-' || word.startsWith('@')) return { state: word };
	try {
		if (fs.statSync(resolveCliPath(word)).isFile()) return { stateFile: word };
	} catch {
		// Not a file: the word is the text.
	}
	return { state: word };
}

export async function systemOneCost(word: string | undefined, options: CostOptions): Promise<void> {
	const { json } = options;
	const shape = {
		questions: count(options.questions),
		questionChars: count(options.questionChars),
		items: count(options.items),
		perItem: options.perItem === true,
	};
	const shapeProblem = systemOneJobShapeProblem(shape);
	if (shapeProblem) failCommand(shapeProblem, json, ExitCode.InvalidUsage);

	let state: SystemOneState;
	try {
		const flags: StateFlags = { ...options };
		if (word !== undefined) {
			if (options.state !== undefined || options.stateFile !== undefined) {
				throw new SystemOneInputError(
					'Give the state one way: as the argument, or with --state or --state-file.'
				);
			}
			Object.assign(flags, stateArgument(word));
		}
		const read = await readState(flags);
		const problem = systemOneStateProblem(read);
		if (problem) throw new SystemOneInputError(problem);
		state = read as SystemOneState;
	} catch (error) {
		if (error instanceof SystemOneInputError)
			failCommand(error.message, json, ExitCode.InvalidUsage);
		throw error;
	}

	// The price and the limits are the engine's, so the desktop is asked which
	// one is in force. With none chosen the estimate is the hosted Jev's, and
	// says so: a person sizing a job before choosing an engine wants that number.
	const report = await readStatus(json);
	const chosen = report.settings.engine;
	const engine = chosen === 'off' ? 'jev-cloud' : chosen;
	const engineLabel = chosen === 'off' ? systemOneEngineLabel('jev-cloud') : report.engineLabel;
	const note =
		chosen === 'off'
			? `No engine is chosen, so this is priced as ${engineLabel} at its list price of $${JEV_PRICE_PER_MTOK_INPUT_USD} per million input tokens.`
			: undefined;
	const estimate = estimateSystemOneJob({
		engine,
		state,
		...(shape.questions !== undefined ? { questions: shape.questions } : {}),
		...(shape.questionChars !== undefined ? { questionChars: shape.questionChars } : {}),
		...(shape.items !== undefined ? { items: shape.items } : {}),
		...(shape.perItem ? { perItem: true } : {}),
	});

	if (json) {
		console.log(
			JSON.stringify({
				success: true,
				...estimate,
				engineLabel,
				engineChosen: chosen,
				...(note ? { note } : {}),
			})
		);
	} else {
		console.log(formatSystemOneJobEstimate(estimate, engineLabel, note));
	}
}
