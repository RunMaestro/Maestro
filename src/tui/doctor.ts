/**
 * `maestro-cli tui --doctor`: print the data-directory report and exit,
 * without starting the UI. Exits non-zero when no data directory resolves.
 */

import {
	buildDoctorReport,
	formatDoctorReport,
	resolveMaestroPaths,
	resolveUserDataDirRule,
	userDataDirCandidates,
	type ResolveMaestroPathsOptions,
} from '../shared/maestro-lib';

/** Prints the report through `write` and returns the process exit code. */
export function runDoctor(
	options: ResolveMaestroPathsOptions,
	write: (text: string) => void = (text) => process.stdout.write(text)
): number {
	const report = buildDoctorReport({
		paths: resolveMaestroPaths(options),
		rule: resolveUserDataDirRule(options),
		candidates: userDataDirCandidates(options),
	});
	write(`${formatDoctorReport(report)}\n`);
	return report.ok ? 0 : 1;
}
