// `maestro-cli playbook configure <playbook-id> [--set NAME=VALUE ...]`
//
// Without --set it reads: each declared parameter, its saved answer or
// default, and which required ones are still missing. With --set it saves the
// answers onto the playbook record through the desktop app (`update_playbook`,
// the same `playbooks:update` path the Auto Run panel uses; the CLI never
// writes the store itself), then removes the missing-parameters halt marker
// Maestro wrote for an automation run once nothing required is missing.

import { findPlaybookById } from '../services/playbooks';
import { getSessionById } from '../services/storage';
import {
	PlaybookParamInputError,
	checkParamAnswers,
	mergeParamValues,
	parseParamAssignments,
	playbookParamSpecs,
	reportPlaybookParams,
	storedParamValues,
	stripMissingParamsHaltMarkersFromPlaybook,
	type PlaybookParamReport,
} from '../services/playbook-params';
import {
	errorFrameMessage,
	failCommand,
	failFromError,
	sendSimpleCommand,
} from '../services/session-command';
import { ExitCode, exitWith } from '../exit-codes';
import { formatError, formatInfo, formatSuccess } from '../output/formatter';
import {
	collectUnresolvedRequired,
	describeMissingRequiredParams,
	type PlaybookParamSpec,
} from '../../shared/playbookParams';
import type { Playbook } from '../../shared/types';

interface ConfigurePlaybookOptions {
	/** Repeated `--set NAME=VALUE`; `NAME=` clears the saved answer. */
	set?: string[];
	json?: boolean;
}

function printParams(
	playbook: Playbook,
	params: PlaybookParamReport[],
	missing: PlaybookParamSpec[]
): void {
	console.log(formatInfo(`Playbook: ${playbook.name} (${playbook.id})`));
	if (params.length === 0) {
		console.log('  This playbook declares no parameters.');
		return;
	}
	for (const param of params) {
		const state =
			param.value !== undefined
				? `= ${param.value}`
				: param.default !== undefined
					? `default ${param.default}`
					: '<unset>';
		const flags = [param.type, param.required ? 'required' : 'optional'].join(', ');
		console.log(`  ${param.name}  ${state}  (${flags})${param.help ? `  ${param.help}` : ''}`);
	}
	if (missing.length > 0) {
		console.log(
			formatError(`${describeMissingRequiredParams(missing)}. Set them with --set NAME=VALUE.`)
		);
	}
}

export async function configurePlaybook(
	playbookId: string,
	options: ConfigurePlaybookOptions
): Promise<void> {
	const json = options.json;

	let playbook: Playbook;
	let agentId: string;
	try {
		({ playbook, agentId } = findPlaybookById(playbookId));
	} catch (error) {
		return failCommand(error instanceof Error ? error.message : String(error), json);
	}

	const specs = playbookParamSpecs(playbook);
	const stored = storedParamValues(playbook);
	const sets = options.set ?? [];

	// Read: the form as it stands.
	if (sets.length === 0) {
		const missingSpecs = collectUnresolvedRequired(specs, stored);
		const parameters = reportPlaybookParams(specs, stored);
		if (json) {
			const missing = missingSpecs.map((spec) => spec.name);
			console.log(JSON.stringify({ success: true, playbookId: playbook.id, parameters, missing }));
		} else {
			printParams(playbook, parameters, missingSpecs);
		}
		return;
	}

	let answers;
	try {
		answers = parseParamAssignments(sets, '--set');
		const problems = checkParamAnswers(specs, answers);
		if (problems.length > 0) throw new PlaybookParamInputError(problems.join('\n'));
	} catch (error) {
		if (!(error instanceof PlaybookParamInputError)) throw error;
		if (json) {
			console.log(
				JSON.stringify({ success: false, error: error.message, code: 'INVALID_PARAMETERS' })
			);
		} else {
			console.error(formatError(error.message));
		}
		return exitWith(ExitCode.InvalidUsage);
	}

	const values = mergeParamValues(stored, answers);

	let result: { success: boolean; error?: string };
	try {
		result = await sendSimpleCommand<{ success: boolean; error?: string }>(
			{
				type: 'update_playbook',
				sessionId: agentId,
				playbookId: playbook.id,
				updates: { parameterValues: values },
			},
			'update_playbook_result'
		);
	} catch (error) {
		return failFromError(error, json);
	}
	const frameError = errorFrameMessage(result);
	if (frameError || !result.success) {
		return failCommand(
			frameError ?? result.error ?? `The desktop app did not save playbook ${playbook.id}.`,
			json
		);
	}

	// Once nothing required is missing, the halt marker an automation run wrote
	// for the missing answers is stale; leaving it would keep the playbook refused.
	const missingSpecs = collectUnresolvedRequired(specs, values);
	const missing = missingSpecs.map((spec) => spec.name);
	const folder = getSessionById(agentId)?.autoRunFolderPath;
	const clearedHaltMarkers =
		missing.length === 0 && folder
			? stripMissingParamsHaltMarkersFromPlaybook(folder, playbook)
			: [];

	if (json) {
		console.log(
			JSON.stringify({
				success: true,
				playbookId: playbook.id,
				parameters: reportPlaybookParams(specs, values),
				missing,
				clearedHaltMarkers,
			})
		);
		return;
	}
	console.log(formatSuccess(`Saved parameters for playbook ${playbook.name} (${playbook.id})`));
	for (const filename of clearedHaltMarkers) {
		console.log(formatInfo(`Removed the missing-parameters halt marker from ${filename}.md`));
	}
	if (missingSpecs.length > 0) {
		console.log(
			formatError(`${describeMissingRequiredParams(missingSpecs)}. The playbook cannot run yet.`)
		);
	}
}
