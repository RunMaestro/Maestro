import { describe, expect, it } from 'vitest';
import {
	OmpRuntimeSupervisor,
	type OmpBinaryDiscovery,
	type OmpProcessFactory,
	type OmpProcessTransport,
} from '../../../main/omp';

class RuntimeTransport implements OmpProcessTransport {
	readonly pid: number;
	readonly writes: string[] = [];
	readonly kills: Array<string | undefined> = [];
	closedInput = false;
	exitOnClose = false;
	private readonly stdoutListeners: Array<(chunk: Uint8Array | string) => void> = [];
	private readonly stderrListeners: Array<(chunk: Uint8Array | string) => void> = [];
	private readonly exitListeners: Array<(code: number | null, signal: string | null) => void> = [];

	constructor(pid: number) {
		this.pid = pid;
	}

	write(frame: string): void {
		this.writes.push(frame);
	}

	closeInput(): void {
		this.closedInput = true;
		if (this.exitOnClose) this.exit(0);
	}

	kill(signal?: string): void {
		this.kills.push(signal);
	}

	onStdout(listener: (chunk: Uint8Array | string) => void): () => void {
		this.stdoutListeners.push(listener);
		return () => this.stdoutListeners.splice(this.stdoutListeners.indexOf(listener), 1);
	}

	onStderr(listener: (chunk: Uint8Array | string) => void): () => void {
		this.stderrListeners.push(listener);
		return () => this.stderrListeners.splice(this.stderrListeners.indexOf(listener), 1);
	}

	onExit(listener: (code: number | null, signal: string | null) => void): () => void {
		this.exitListeners.push(listener);
		return () => this.exitListeners.splice(this.exitListeners.indexOf(listener), 1);
	}

	stdout(frame: string): void {
		for (const listener of this.stdoutListeners) listener(frame);
	}

	exit(code: number | null = 0, signal: string | null = null): void {
		for (const listener of this.exitListeners) listener(code, signal);
	}
}

class RuntimeFactory implements OmpProcessFactory {
	readonly calls: Array<{ executable: string; args: readonly string[]; cwd: string }> = [];
	readonly transports: RuntimeTransport[] = [];

	spawn(
		executable: string,
		args: readonly string[],
		options: { cwd: string }
	): OmpProcessTransport {
		this.calls.push({ executable, args, cwd: options.cwd });
		const transport = new RuntimeTransport(this.transports.length + 1);
		this.transports.push(transport);
		return transport;
	}
}

const discovery: OmpBinaryDiscovery = {
	discover: async () => ({
		path: 'C:/Program Files/OMP/omp.exe',
		version: '16.4.8',
		provenance: 'system',
	}),
};

async function startedSupervisor(factory = new RuntimeFactory()) {
	const supervisor = new OmpRuntimeSupervisor({
		discovery,
		processFactory: factory,
		gracefulShutdownMs: 0,
		requestTimeoutMs: 5_000,
	});
	const starting = supervisor.start({ sessionKey: 'session-1', cwd: 'C:/workspace/project' });
	await Promise.resolve();
	await Promise.resolve();
	const transport = factory.transports[0];
	if (!transport) throw new Error('expected transport');
	transport.stdout('{"type":"ready"}\n');
	await Promise.resolve();
	const requestId = JSON.parse(transport.writes[0] ?? '').id as string;
	transport.stdout(
		`{"id":"${requestId}","type":"response","command":"get_state","success":true,"data":{"sessionId":"omp-session","thinkingLevel":"medium","isStreaming":false,"isCompacting":false,"steeringMode":"all","followUpMode":"all","interruptMode":"immediate","autoCompactionEnabled":true,"messageCount":0,"queuedMessageCount":0,"todoPhases":[]}}\n`
	);
	return { supervisor, factory, transport, controller: await starting };
}

describe('OmpRuntimeSupervisor', () => {
	it('provenance-checks discovery and launches exactly argv-safe rpc arguments in the requested cwd', async () => {
		const { factory, controller } = await startedSupervisor();

		expect(factory.calls).toEqual([
			{
				executable: 'C:/Program Files/OMP/omp.exe',
				args: ['--mode', 'rpc'],
				cwd: 'C:/workspace/project',
			},
		]);
		expect(controller.state).toBe('ready');
		expect(controller.getState()).toMatchObject({ sessionId: 'omp-session' });
	});

	it('keeps one controller per active session key', async () => {
		const { supervisor } = await startedSupervisor();
		await expect(
			supervisor.start({ sessionKey: 'session-1', cwd: 'C:/workspace/project' })
		).rejects.toMatchObject({
			code: 'session_active',
		});
	});

	it('marks a crashed controller and only creates a replacement through an explicit restart boundary', async () => {
		const { supervisor, factory, transport, controller } = await startedSupervisor();
		transport.exit(23);
		expect(controller.state).toBe('crashed');

		const restarting = supervisor.restart('session-1');
		await Promise.resolve();
		await Promise.resolve();
		const replacement = factory.transports[1];
		if (!replacement) throw new Error('expected replacement transport');
		replacement.stdout('{"type":"ready"}\n');
		await Promise.resolve();
		const requestId = JSON.parse(replacement.writes[0] ?? '').id as string;
		replacement.stdout(
			`{"id":"${requestId}","type":"response","command":"get_state","success":true,"data":{"sessionId":"replacement","thinkingLevel":"medium","isStreaming":false,"isCompacting":false,"steeringMode":"all","followUpMode":"all","interruptMode":"immediate","autoCompactionEnabled":true,"messageCount":0,"queuedMessageCount":0,"todoPhases":[]}}\n`
		);

		await expect(restarting).resolves.toMatchObject({ state: 'ready' });
	});

	it('closes stdin for graceful shutdown then terminates the owned process tree when it does not exit', async () => {
		const { supervisor, transport } = await startedSupervisor();
		await supervisor.shutdown('session-1');

		expect(transport.closedInput).toBe(true);
		expect(transport.kills).toEqual(['SIGKILL']);
	});

	it('does not force-kill a process that exits after its graceful stdin close', async () => {
		const { supervisor, transport } = await startedSupervisor();
		transport.exitOnClose = true;
		await supervisor.shutdown('session-1');

		expect(transport.closedInput).toBe(true);
		expect(transport.kills).toEqual([]);
	});
});
