import React from 'react';
import { render } from 'ink';
import * as fs from 'fs';
import * as path from 'path';
import { resolveUserDataDir } from '../shared/maestro-lib';
import { setMaestroLibLogger } from '../shared/maestro-lib';

// Set up logging to a file
const userDataDir = resolveUserDataDir();
const logDir = path.join(userDataDir, 'logs');
if (!fs.existsSync(logDir)) {
	fs.mkdirSync(logDir, { recursive: true });
}
const logFile = path.join(logDir, 'maestro-tui.log');
const logStream = fs.createWriteStream(logFile, { flags: 'a' });

setMaestroLibLogger({
	debug: (msg: string) => logStream.write(`[DEBUG] ${msg}\n`),
	info: (msg: string) => logStream.write(`[INFO] ${msg}\n`),
	warn: (msg: string) => logStream.write(`[WARN] ${msg}\n`),
	error: (msg: string) => logStream.write(`[ERROR] ${msg}\n`),
});

interface AppProps {
	onExit: () => void;
}

const App: React.FC<AppProps> = ({ onExit }) => {
	const userDataDir = resolveUserDataDir();

	React.useEffect(() => {
		const handleKeyPress = (ch: string) => {
			if (ch === 'q') {
				onExit();
			}
		};

		if (process.stdin.isTTY) {
			process.stdin.setRawMode(true);
			process.stdin.on('data', (buffer) => {
				const ch = String.fromCharCode(buffer[0]);
				handleKeyPress(ch);
			});
		}

		return () => {
			if (process.stdin.isTTY) {
				process.stdin.setRawMode(false);
			}
		};
	}, [onExit]);

	return (
		<div>
			<div>Maestro TUI</div>
			<div>Data directory: {userDataDir}</div>
			<div>Press 'q' to quit</div>
		</div>
	);
};

const main = () => {
	const { unmount, waitUntilExit } = render(
		<App
			onExit={() => {
				unmount();
				process.exit(0);
			}}
		/>
	);

	// Exit on Ctrl-C
	process.on('SIGINT', () => {
		unmount();
		process.exit(0);
	});

	waitUntilExit().then(() => {
		logStream.end();
	});
};

main();
