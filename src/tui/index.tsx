import { render } from 'ink';
import {
	createWsMaestroClient,
	resolveMaestroPaths,
	setMaestroLibLogger,
} from '../shared/maestro-lib';
import { App } from './App';
import { parseTuiArgs } from './args';
import { runDoctor } from './doctor';
import { createFileLogger, tuiLogFilePath } from './logger';

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

// The App attaches to a running desktop through this client, and reads the store
// files when there is none. It keeps the connection until the TUI quits.
const client = createWsMaestroClient({ userDataDir: paths.userDataDir });

const instance = render(<App paths={paths} client={client} />);
await instance.waitUntilExit();
await client.connection.close();
