import { assertSafeOmpCwd } from './discovery';
import { OmpRpcClient } from './rpc-client';
import { OmpSessionController } from './session-controller';
import type { OmpBinaryDiscovery, OmpProcessFactory } from './types';

export interface OmpRuntimeSupervisorOptions {
	readonly discovery: OmpBinaryDiscovery;
	readonly processFactory: OmpProcessFactory;
	readonly gracefulShutdownMs?: number;
	readonly requestTimeoutMs?: number;
	readonly readyTimeoutMs?: number;
}

export interface OmpStartRequest {
	readonly sessionKey: string;
	readonly cwd: string;
}

export class OmpRuntimeError extends Error {
	readonly code: 'session_active' | 'session_unknown';

	constructor(code: OmpRuntimeError['code'], message: string) {
		super(message);
		this.name = 'OmpRuntimeError';
		this.code = code;
	}
}

interface ManagedSession {
	readonly request: OmpStartRequest;
	readonly controller: OmpSessionController;
}

export class OmpRuntimeSupervisor {
	private readonly sessions = new Map<string, ManagedSession>();
	private readonly starting = new Map<string, Promise<OmpSessionController>>();
	private readonly gracefulShutdownMs: number;

	constructor(private readonly options: OmpRuntimeSupervisorOptions) {
		this.gracefulShutdownMs = options.gracefulShutdownMs ?? 5_000;
	}

	async start(request: OmpStartRequest): Promise<OmpSessionController> {
		if (this.sessions.has(request.sessionKey) || this.starting.has(request.sessionKey)) {
			throw new OmpRuntimeError(
				'session_active',
				`OMP session ${request.sessionKey} is already active`
			);
		}
		const start = this.createSession(request);
		this.starting.set(request.sessionKey, start);
		try {
			const controller = await start;
			return controller;
		} finally {
			this.starting.delete(request.sessionKey);
		}
	}

	async restart(sessionKey: string): Promise<OmpSessionController> {
		const existing = this.sessions.get(sessionKey);
		if (!existing)
			throw new OmpRuntimeError('session_unknown', `OMP session ${sessionKey} does not exist`);
		if (existing.controller.state !== 'crashed' && existing.controller.state !== 'stopped') {
			await this.shutdown(sessionKey);
		} else {
			this.sessions.delete(sessionKey);
		}
		return this.start(existing.request);
	}

	get(sessionKey: string): OmpSessionController | undefined {
		return this.sessions.get(sessionKey)?.controller;
	}

	async shutdown(sessionKey: string): Promise<void> {
		const session = this.sessions.get(sessionKey);
		if (!session) return;
		const { controller } = session;
		controller.beginShutdown();
		controller.transport.closeInput();
		if (!(await exitsWithin(controller.waitForExit(), this.gracefulShutdownMs))) {
			controller.transport.kill('SIGKILL');
		}
		controller.markStopped();
		this.sessions.delete(sessionKey);
	}

	private async createSession(request: OmpStartRequest): Promise<OmpSessionController> {
		const cwd = assertSafeOmpCwd(request.cwd);
		const executable = await this.options.discovery.discover();
		const transport = this.options.processFactory.spawn(executable.path, ['--mode', 'rpc'], {
			cwd,
		});
		const client = new OmpRpcClient(transport, {
			requestTimeoutMs: this.options.requestTimeoutMs,
			readyTimeoutMs: this.options.readyTimeoutMs,
		});
		const controller = new OmpSessionController(request.sessionKey, transport, client);
		this.sessions.set(request.sessionKey, {
			request: { sessionKey: request.sessionKey, cwd },
			controller,
		});
		try {
			await controller.initialize();
			return controller;
		} catch (error) {
			this.sessions.delete(request.sessionKey);
			controller.beginShutdown();
			transport.closeInput();
			transport.kill('SIGKILL');
			controller.markStopped();
			throw error;
		}
	}
}

async function exitsWithin(exited: Promise<void>, timeoutMs: number): Promise<boolean> {
	return Promise.race([
		exited.then(() => true),
		new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
	]);
}
