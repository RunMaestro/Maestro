import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { render } from 'ink';
import {
	createMaestroRuntime,
	createWsMaestroClient,
	resolveMaestroPaths,
	setMaestroLibLogger,
} from '../shared/maestro-lib';
import { App } from './App';
import { parseTuiArgs } from './args';
import { runDoctor } from './doctor';
import { createFileLogger, tuiLogFilePath } from './logger';
import { resolveTuiTurnOptions, startTuiHost } from './startup';

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
// client. A running desktop is attached to; anything else opens read-only (see `startup.ts`).
const startup = await startTuiHost(paths, {
	startRuntime: (options) =>
		createMaestroRuntime({
			...options,
			turns: resolveTuiTurnOptions(dirname(fileURLToPath(import.meta.url))),
		}),
	attachToHost: () => createWsMaestroClient({ userDataDir: paths.userDataDir }),
});
const client = startup.branch === 'read-only' ? undefined : startup.client;

try {
	// Ctrl-C is a key the App answers (it interrupts a running turn; twice within a second quits), so Ink must not exit on it.
	const instance = render(
		<App
			paths={paths}
			client={client}
			{...(startup.branch === 'read-only'
				? { readOnlyLabel: startup.label, startupNotice: startup.notice }
				: {})}
		/>,
		{ exitOnCtrlC: false }
	);
	await instance.waitUntilExit();
} finally {
	// For the runtime this is the shutdown: it stops what it started and releases the data-dir lock.
	await client?.connection.close();
}
