/**
 * Standalone Chromium loopback proxy experiment (no Maestro imports).
 * Run: npx electron scripts/spike-socks-pac.mjs
 * Linux without a display: xvfb-run -a npx electron scripts/spike-socks-pac.mjs
 * LOCAL means direct HTTP; REMOTE means the synthetic SOCKS server answered.
 */
import { app, session } from 'electron';
import http from 'node:http';
import net from 'node:net';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Keep Electron's persistent experiment data inside the checkout, not the user's profile.
const userData = fileURLToPath(new URL('../tmp/spike-socks-pac/', import.meta.url));
mkdirSync(userData, { recursive: true });
app.setPath('userData', userData);
app.setPath('sessionData', userData);
app.dock?.hide();

const sockets = new Set();
let activeCase = 'setup';
const connects = [];
const local = http.createServer((_request, response) => {
	response.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
	response.end('LOCAL');
});
const socks = net.createServer((socket) => {
	let buffer = Buffer.alloc(0);
	let stage = 'greeting';
	socket.setTimeout(5000, () => socket.destroy());
	socket.on('data', (chunk) => {
		buffer = Buffer.concat([buffer, chunk]);
		if (buffer.length > 65536) return socket.destroy();

		// TCP may split a message across packets or coalesce multiple stages.
		if (stage === 'greeting') {
			if (buffer.length < 2) return;
			const length = 2 + buffer[1];
			if (buffer.length < length) return;
			if (buffer[0] !== 5 || !buffer.subarray(2, length).includes(0)) {
				socket.end(Buffer.from([5, 255]));
				stage = 'done';
				return;
			}
			buffer = buffer.subarray(length);
			socket.write(Buffer.from([5, 0]));
			stage = 'connect';
		}

		if (stage === 'connect') {
			if (buffer.length < 5) return;
			const atyp = buffer[3];
			if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[2] !== 0 || ![1, 3, 4].includes(atyp)) {
				socket.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0]));
				stage = 'done';
				return;
			}
			const start = atyp === 3 ? 5 : 4;
			const size = atyp === 1 ? 4 : atyp === 4 ? 16 : buffer[4];
			const end = start + size;
			if (buffer.length < end + 2) return;
			const address = buffer.subarray(start, end);
			const host =
				atyp === 3
					? address.toString('utf8')
					: atyp === 1
						? [...address].join('.')
						: Array.from({ length: 8 }, (_, index) =>
								address.readUInt16BE(index * 2).toString(16)
							).join(':');
			const port = buffer.readUInt16BE(end);
			const destination = `${host}:${port} (ATYP=${atyp})`;
			connects.push(destination);
			console.log(`[${activeCase}] SOCKS CONNECT ${destination}`);
			buffer = buffer.subarray(end + 2);
			// Synthetic success only. Never dial the requested destination.
			socket.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 34, 226]));
			stage = 'http';
		}

		if (stage === 'http' && buffer.includes('\r\n\r\n')) {
			stage = 'done';
			socket.end(
				'HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 6\r\nCache-Control: no-store\r\nConnection: close\r\n\r\nREMOTE'
			);
		}
	});
});

for (const server of [local, socks]) {
	server.on('connection', (socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
		socket.on('error', (error) => console.error(`[${activeCase}] socket: ${error.message}`));
	});
}

function listen(server, port) {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, '127.0.0.1', () => {
			server.removeListener('error', reject);
			resolve();
		});
	});
}

async function probe(partition, host) {
	await partition.closeAllConnections();
	const before = connects.length;
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 5000);
	let outcome;
	try {
		const response = await partition.fetch(`http://${host}:8931/`, {
			signal: controller.signal,
			cache: 'no-store',
		});
		outcome = await response.text();
		if (outcome !== 'LOCAL' && outcome !== 'REMOTE') outcome = `UNEXPECTED: ${outcome}`;
	} catch (error) {
		outcome = controller.signal.aborted ? 'TIMEOUT (5s)' : `ERROR: ${error.message}`;
	} finally {
		clearTimeout(timeout);
	}
	console.log(
		`[${activeCase}] ${host}: ${outcome}; CONNECTs: ${connects.slice(before).join(', ') || 'none'}`
	);
	return outcome;
}

const pac = `function FindProxyForURL(url, host) {
	return host === 'localhost' ? 'SOCKS5 127.0.0.1:8930' : 'DIRECT';
}`;
const fixed = { mode: 'fixed_servers', proxyRules: 'socks5://127.0.0.1:8930' };
const automatic = {
	mode: 'pac_script',
	pacScript: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pac).toString('base64')}`,
};

async function main() {
	let partition;
	let exitCode = 0;
	try {
		await app.whenReady();
		await listen(local, 8931);
		await listen(socks, 8930);
		partition = session.fromPartition('persist:maestro-browser-session-spike');
		console.log(
			`Electron ${process.versions.electron}; Chromium ${process.versions.chrome}; ${process.platform}`
		);
		console.log(`PAC:\n${pac}`);
		const results = [];
		for (const [name, config] of [
			['A: fixed', fixed],
			['B: fixed + <-loopback>', { ...fixed, proxyBypassRules: '<-loopback>' }],
			['C: PAC', automatic],
			['D: PAC + <-loopback>', { ...automatic, proxyBypassRules: '<-loopback>' }],
		]) {
			activeCase = name;
			await partition.closeAllConnections();
			await partition.setProxy(config);
			results.push({
				case: name,
				localhost: await probe(partition, 'localhost'),
				// Also measure A/B's numeric escape route to make the comparison complete.
				'127.0.0.1': await probe(partition, '127.0.0.1'),
			});
		}
		console.table(results);
	} catch (error) {
		console.error('Spike setup failed:', error);
		exitCode = 1;
	} finally {
		await partition?.closeAllConnections();
		for (const socket of sockets) socket.destroy();
		await Promise.all(
			[local, socks].map((server) => new Promise((resolve) => server.close(resolve)))
		);
		app.exit(exitCode);
	}
}

void main();
