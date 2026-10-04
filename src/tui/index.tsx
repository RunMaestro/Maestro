import { render } from 'ink';
import { resolveMaestroPaths, setMaestroLibLogger } from '../shared/maestro-lib';
import { App } from './App';
import { parseTuiArgs } from './args';
import { createFileLogger, tuiLogFilePath } from './logger';

const args = parseTuiArgs(process.argv.slice(2));

const paths = resolveMaestroPaths({
	env: args.dataDir ? { ...process.env, MAESTRO_USER_DATA: args.dataDir } : process.env,
	...(args.dev ? { isDevelopment: true } : {}),
});

// The library's log lines go to a file: Ink owns stdout and stderr. The error
// reporter stays the default no-op.
setMaestroLibLogger(createFileLogger(tuiLogFilePath(paths.userDataDir)));

render(<App userDataDir={paths.userDataDir} />);
