import net from 'node:net';
import { pathToFileURL } from 'node:url';

// Deliberately NOT 5173: that is Vite's universal default port, so every web
// project an agent scaffolds and runs with its dev script competes for it. When
// such a server wins the bind, Electron (pointed at the same localhost port)
// loads the stranger's page and the whole app shell is replaced. A private base
// port keeps Maestro's dev server out of that contention entirely.
const DEFAULT_START_PORT = 17173;
const DEFAULT_MAX_ATTEMPTS = 20;
const LOCALHOST_HOSTS = ['127.0.0.1', '::1'];

function parsePort(value) {
	const port = Number.parseInt(value ?? '', 10);
	return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
}

export function getPreferredDevPort() {
	return parsePort(process.env.VITE_PORT) ?? DEFAULT_START_PORT;
}

function isPortInUse(port) {
	return new Promise((resolve) => {
		let resolved = false;
		let pending = LOCALHOST_HOSTS.length;

		for (const host of LOCALHOST_HOSTS) {
			const socket = net.createConnection({ host, port });

			socket.once('connect', () => {
				if (resolved) return;
				resolved = true;
				socket.end();
				resolve(true);
			});

			socket.once('error', () => {
				socket.destroy();
				pending -= 1;
				if (!resolved && pending === 0) {
					resolve(false);
				}
			});
		}
	});
}

export async function findAvailablePort(
	startPort = getPreferredDevPort(),
	attempts = DEFAULT_MAX_ATTEMPTS
) {
	for (let offset = 0; offset < attempts; offset += 1) {
		const candidatePort = startPort + offset;
		if (!(await isPortInUse(candidatePort))) {
			return candidatePort;
		}
	}

	throw new Error(
		`No available Vite dev port found in range ${startPort}-${startPort + attempts - 1}`
	);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const port = await findAvailablePort();
	process.stdout.write(`${port}\n`);
}
