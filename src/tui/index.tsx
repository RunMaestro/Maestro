import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { render } from 'ink';
import { resolveMaestroPaths, setMaestroLibLogger } from '../shared/maestro-lib';
import { parseTuiArgs } from './args';
import { runDoctor } from './doctor';
import { createFileLogger, tuiLogFilePath } from './logger';
import { runMaestroCliHostStart } from './background-host';
import { Root } from './Root';
import { resolveTuiTurnOptions, startTuiHost, tuiStartupDeps, type TuiStartup } from './startup';

const args = parseTuiArgs(process.argv.slice(2));

const pathOptions = {
	env: args.dataDir ? { ...process.env, MAESTRO_USER_DATA: args.dataDir } : process.env,
	...(args.dev ? { isDevelopment: true } : {}),
};

// A report, not a UI: no logger, no Ink, and nothing is created on disk.
if (args.doctor) process.exit(runDoctor(pathOptions));

const paths = resolveMaestroPaths(pathOptions);

// The library's log lines go to a file: Ink owns stdout and stderr. The error
// reporter stays the default no-op.
setMaestroLibLogger(createFileLogger(tuiLogFilePath(paths.userDataDir)));

// No desktop and no other runtime on the directory: this process hosts it and the runtime is the
// client. A running desktop or detached host is attached to; anything else opens read-only (see
// `startup.ts`).
const moduleDirectory = dirname(fileURLToPath(import.meta.url));
const startupDeps = tuiStartupDeps(paths, moduleDirectory);
let startup: TuiStartup = await startTuiHost(paths, startupDeps);

try {
	// Ctrl-C is a key the App answers (it interrupts a running turn; twice within a second quits), so Ink must not exit on it.
	const instance = render(
		<Root
			paths={paths}
			startup={startup}
			backgroundHost={{
				runHostStart: () =>
					runMaestroCliHostStart({
						cliScript: resolveTuiTurnOptions(moduleDirectory).maestroCliPath,
						userDataDir: paths.userDataDir,
					}),
				restart: () => startTuiHost(paths, startupDeps),
			}}
			onStartupChange={(next) => {
				startup = next;
			}}
		/>,
		{ exitOnCtrlC: false }
	);
	await instance.waitUntilExit();
} finally {
	// For the runtime this is the shutdown: it stops what it started and releases the data-dir lock.
	// An attached client only closes its socket, so a detached host keeps running.
	if (startup.branch !== 'read-only') await startup.client.connection.close();
}
