import { spawn, execFile } from 'child_process';
import type { ChildProcess } from 'child_process';
import { promisify } from 'util';
import net from 'net';
import { buildSshConnectionArgs, describeSshConnectionError } from '../../shared/sshConnection';
import type { SshRemoteConfig } from '../../shared/types';

export function tunnelArgs(config: SshRemoteConfig, endpoint: URL, localPort: number): string[] {
	if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535)
		throw new Error('Invalid local tunnel port.');
	const remotePort = Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : 80));
	const target = endpoint.hostname === '[::1]' ? '[::1]' : '127.0.0.1';
	return [
		'-N',
		'-o',
		'StrictHostKeyChecking=yes',
		'-o',
		'ExitOnForwardFailure=yes',
		'-o',
		'NoHostAuthenticationForLocalhost=no',
		'-o',
		'ForwardAgent=no',
		'-o',
		'ClearAllForwardings=no',
		'-o',
		'BatchMode=yes',
		'-o',
		'PermitLocalCommand=no',
		'-o',
		'ControlMaster=no',
		'-o',
		'ControlPath=none',
		'-o',
		'ControlPersist=no',
		'-o',
		'ForkAfterAuthentication=no',
		'-o',
		'ServerAliveInterval=15',
		'-o',
		'ServerAliveCountMax=2',
		'-L',
		`127.0.0.1:${localPort}:${target}:${remotePort}`,
		...buildSshConnectionArgs(config),
	];
}

export class OwnedTunnel {
	private stopped = false;
	private readonly closed: Promise<void>;
	constructor(private readonly child: ChildProcess) {
		const closed = Promise.withResolvers<void>();
		this.closed = closed.promise;
		child.once('close', () => closed.resolve());
	}
	stop(): Promise<void> {
		if (!this.stopped) {
			this.stopped = true;
			this.child.kill();
		}
		return this.closed;
	}
}

async function availablePort(port = 0): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const listener = net.createServer();
	listener.once('error', reject);
	listener.listen(port, '127.0.0.1', () => {
		const address = listener.address();
		listener.close((error) => (error ? reject(error) : resolve((address as net.AddressInfo).port)));
	});
	return promise;
}

export async function openTunnel(
	config: SshRemoteConfig,
	endpoint: URL,
	signal: AbortSignal,
	onExit: (message: string) => void,
	preferredPort?: number
): Promise<{ tunnel: OwnedTunnel; url: URL }> {
	const port = await availablePort(preferredPort).catch((error: NodeJS.ErrnoException) => {
		if (preferredPort && error.code === 'EADDRINUSE') return availablePort();
		throw error;
	});
	const args = tunnelArgs(config, endpoint, port);
	// Respect aliases/agent/key/jump resolution, but refuse inherited extra listeners.
	const { stdout } = await promisify(execFile)('ssh', ['-G', ...args], {
		windowsHide: true,
		timeout: 10000,
		signal,
	});
	const forwards = stdout
		.split('\n')
		.filter((line) => /^(localforward|remoteforward|dynamicforward)\s+/.test(line));
	const remotePort = endpoint.port || (endpoint.protocol === 'https:' ? '443' : '80');
	const target = endpoint.hostname === '[::1]' ? '::1' : '127.0.0.1';
	if (
		forwards.length !== 1 ||
		forwards[0].trim() !== `localforward [127.0.0.1]:${port} [${target}]:${remotePort}`
	)
		throw new Error(
			'SSH config contains additional forwarding. Use a connection-only SSH alias without LocalForward, RemoteForward, or DynamicForward.'
		);
	if (signal.aborted) throw new Error('Connection canceled.');
	const child = spawn('ssh', args, {
		stdio: ['ignore', 'ignore', 'pipe'],
		windowsHide: true,
		shell: false,
	});
	const tunnel = new OwnedTunnel(child);
	let stderr = '';
	let failure: Error | undefined;
	child.stderr?.on('data', (data: Buffer) => {
		stderr = (stderr + data.toString()).slice(-8192);
	});
	child.once('error', (error) => {
		failure = error;
	});
	child.once('exit', (code) => {
		failure = new Error(
			describeSshConnectionError(stderr) ??
				`SSH forwarding ended (${code ?? 'signal'}): ${stderr.trim()}`
		);
		if (!signal.aborted) onExit(failure.message);
	});
	const stop = () => tunnel.stop();
	signal.addEventListener('abort', stop, { once: true });
	child.once('exit', () => signal.removeEventListener('abort', stop));
	try {
		const deadline = Date.now() + 15000;
		while (Date.now() < deadline) {
			if (signal.aborted) throw new Error('Connection canceled.');
			if (failure) throw failure;
			const readiness = Promise.withResolvers<boolean>();
			const socket = net.connect({ host: '127.0.0.1', port });
			socket.setTimeout(250);
			const finish = (ready: boolean) => {
				socket.destroy();
				readiness.resolve(ready);
			};
			socket.once('connect', () => finish(true));
			socket.once('error', () => finish(false));
			socket.once('timeout', () => finish(false));
			const listening = await readiness.promise;
			if (listening) {
				const url = new URL(endpoint);
				url.hostname = '127.0.0.1';
				url.port = String(port);
				return { tunnel, url };
			}
			const delay = Promise.withResolvers<void>();
			setTimeout(delay.resolve, 100);
			await delay.promise;
		}
		throw new Error(
			'SSH forwarding did not become ready. Check the SSH host, key/agent, and host Remote Control endpoint.'
		);
	} catch (error) {
		await tunnel.stop();
		throw error;
	}
}
