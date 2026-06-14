// Paseo command group for Maestro CLI

import {
	createPaseoSchedule,
	getPaseoScheduleLogs,
	listPaseoSchedules,
	runPaseoAgent,
	type PaseoCommandResult,
} from '../services/paseo';
import { formatError } from '../output/formatter';

interface PaseoBaseOptions {
	cliPath?: string;
	host?: string;
	json?: boolean;
}

interface PaseoScheduleCreateCommandOptions extends PaseoBaseOptions {
	every?: string;
	cron?: string;
	name?: string;
	target?: string;
	provider?: string;
	mode?: string;
	cwd?: string;
	maxRuns?: string;
	expiresIn?: string;
	runNow?: boolean;
}

interface PaseoRunCommandOptions extends PaseoBaseOptions {
	title?: string;
	provider?: string;
	model?: string;
	thinking?: string;
	mode?: string;
	cwd?: string;
	detach?: boolean;
	waitTimeout?: string;
}

function printResult(result: PaseoCommandResult): void {
	if (result.stdout.trim()) {
		console.log(result.stdout.trimEnd());
	}
	if (result.stderr.trim()) {
		console.error(result.stderr.trimEnd());
	}
}

function printError(error: unknown, json?: boolean): void {
	const message = error instanceof Error ? error.message : 'Unknown error';
	if (json) {
		console.error(JSON.stringify({ success: false, error: message }, null, 2));
	} else {
		console.error(formatError(message));
	}
	process.exit(1);
}

export async function paseoRun(prompt: string, options: PaseoRunCommandOptions): Promise<void> {
	try {
		const result = await runPaseoAgent(prompt, options);
		printResult(result);
	} catch (error) {
		printError(error, options.json);
	}
}

export async function paseoScheduleCreate(
	prompt: string,
	options: PaseoScheduleCreateCommandOptions
): Promise<void> {
	try {
		const result = await createPaseoSchedule(prompt, options);
		printResult(result);
	} catch (error) {
		printError(error, options.json);
	}
}

export async function paseoScheduleList(options: PaseoBaseOptions): Promise<void> {
	try {
		const result = await listPaseoSchedules(options);
		printResult(result);
	} catch (error) {
		printError(error, options.json);
	}
}

export async function paseoScheduleLogs(
	scheduleId: string,
	options: PaseoBaseOptions
): Promise<void> {
	try {
		const result = await getPaseoScheduleLogs(scheduleId, options);
		printResult(result);
	} catch (error) {
		printError(error, options.json);
	}
}
