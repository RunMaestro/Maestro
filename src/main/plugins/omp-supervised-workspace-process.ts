import { spawn as nodeSpawn } from 'node:child_process';
import { basename, isAbsolute } from 'node:path';

import { defaultProcessTreeKiller, type ProcessTreeKiller } from './managed-runtime-process';
import type { OmpSupervisedWorkspaceProcess } from './omp-host-safety-brokers';

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface WorkspaceProcessChild {
	readonly pid?: number;
	readonly stdout?: { on(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown };
	readonly stderr?: { on(event: 'data', listener: (chunk: Uint8Array | string) => void): unknown };
	on(
		event: 'close',
		listener: (code: number | null, signal: NodeJS.Signals | null) => void
	): unknown;
	on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface WorkspaceProcessSpawnOptions {
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly shell: false;
	readonly stdio: readonly ['ignore', 'pipe', 'pipe'];
}

export type WorkspaceProcessSpawner = (
	command: string,
	args: readonly string[],
	options: WorkspaceProcessSpawnOptions
) => WorkspaceProcessChild;

export interface OmpWorkspaceShellInspection {
	readonly isRegularFile: boolean;
	readonly isReparsePoint: boolean;
	readonly canonicalPath: string;
}

export interface ConfiguredOmpWorkspaceProcessOptions {
	readonly selectedShell: string;
	readonly resolveShellPath: (shell: string) => string;
	readonly inspectShell: (shellPath: string) => Promise<OmpWorkspaceShellInspection>;
	readonly privateHome: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly spawn?: WorkspaceProcessSpawner;
	readonly killTree?: ProcessTreeKiller;
	readonly ensurePrivateHome?: () => Promise<void>;
}

export interface OmpSupervisedWorkspaceProcessOptions {
	readonly shellPath: string;
	readonly fixedArgs: readonly string[];
	readonly privateHome: string;
	readonly environment: Readonly<Record<string, string | undefined>>;
	readonly spawn?: WorkspaceProcessSpawner;
	readonly killTree?: ProcessTreeKiller;
}

/**
 * Creates the closed process authority used exclusively by the root-bound OMP
 * tool broker. The request surface admits no shell, environment, or cwd
 * overrides; the caller owns those values before invoking the adapter.
 */
export function createOmpSupervisedWorkspaceProcess(
	options: OmpSupervisedWorkspaceProcessOptions
): OmpSupervisedWorkspaceProcess {
	return new SupervisedWorkspaceProcess(options);
}

/**
 * Resolves and validates the shell selected by host settings. Invalid settings
 * deliberately remove `maestro.workspace.run` from the exposed tool catalog.
 */
export async function createConfiguredOmpSupervisedWorkspaceProcess(
	options: ConfiguredOmpWorkspaceProcessOptions
): Promise<OmpSupervisedWorkspaceProcess | null> {
	const selected = options.selectedShell.trim();
	if (!selected) return null;
	const shellPath = options.resolveShellPath(selected);
	if (!isAbsolute(shellPath)) return null;
	try {
		const inspection = await options.inspectShell(shellPath);
		if (
			!inspection.isRegularFile ||
			inspection.isReparsePoint ||
			!samePath(inspection.canonicalPath, shellPath)
		) {
			return null;
		}
		await options.ensurePrivateHome?.();
	} catch {
		return null;
	}
	return createOmpSupervisedWorkspaceProcess({
		shellPath,
		fixedArgs: fixedShellArgs(shellPath),
		privateHome: options.privateHome,
		environment: options.environment,
		...(options.spawn ? { spawn: options.spawn } : {}),
		...(options.killTree ? { killTree: options.killTree } : {}),
	});
}

class SupervisedWorkspaceProcess implements OmpSupervisedWorkspaceProcess {
	private active: ActiveProcess | undefined;
	private revoked = false;

	constructor(private readonly options: OmpSupervisedWorkspaceProcessOptions) {}

	async run(request: {
		readonly command: string;
		readonly cwd: string;
		readonly timeoutMs: number;
		readonly signal: AbortSignal;
	}): Promise<{
		readonly stdout: string;
		readonly stderr: string;
		readonly exitCode: number | null;
	}> {
		if (
			this.revoked ||
			this.active ||
			request.signal.aborted ||
			!Number.isInteger(request.timeoutMs) ||
			request.timeoutMs < MIN_TIMEOUT_MS ||
			request.timeoutMs > MAX_TIMEOUT_MS
		) {
			throw unavailable();
		}
		const spawn = this.options.spawn ?? defaultWorkspaceProcessSpawn;
		const active = new ActiveProcess(this.options.killTree ?? defaultProcessTreeKiller);
		this.active = active;
		let child: WorkspaceProcessChild;
		try {
			child = spawn(this.options.shellPath, [...this.options.fixedArgs, request.command], {
				cwd: request.cwd,
				env: closedEnvironment(this.options.privateHome, this.options.environment),
				shell: false,
				stdio: ['ignore', 'pipe', 'pipe'],
			});
		} catch (error) {
			this.active = undefined;
			throw error;
		}
		active.attach(child);
		const timeout = setTimeout(() => active.fail('workspace process timed out'), request.timeoutMs);
		const abort = () => active.fail('workspace process cancelled');
		request.signal.addEventListener('abort', abort, { once: true });
		try {
			return await active.promise;
		} finally {
			clearTimeout(timeout);
			request.signal.removeEventListener('abort', abort);
			if (this.active === active) this.active = undefined;
		}
	}

	cancel(): void {
		this.active?.fail('workspace process cancelled');
	}

	revoke(): void {
		this.revoked = true;
		this.active?.fail('workspace process revoked');
	}
}

class ActiveProcess {
	private readonly completion = Promise.withResolvers<{
		readonly stdout: string;
		readonly stderr: string;
		readonly exitCode: number | null;
	}>();
	private child: WorkspaceProcessChild | undefined;
	private readonly stdout: Buffer[] = [];
	private readonly stderr: Buffer[] = [];
	private outputBytes = 0;
	private settled = false;

	constructor(private readonly killTree: ProcessTreeKiller) {}

	get promise(): Promise<{
		readonly stdout: string;
		readonly stderr: string;
		readonly exitCode: number | null;
	}> {
		return this.completion.promise;
	}

	attach(child: WorkspaceProcessChild): void {
		this.child = child;
		child.stdout?.on('data', (chunk) => this.append(chunk, false));
		child.stderr?.on('data', (chunk) => this.append(chunk, true));
		child.on('close', (exitCode) =>
			this.complete({
				stdout: Buffer.concat(this.stdout).toString('utf8'),
				stderr: Buffer.concat(this.stderr).toString('utf8'),
				exitCode,
			})
		);
		child.on('error', () => this.fail('workspace process failed to start'));
	}

	fail(message: string): void {
		if (this.settled) return;
		this.settled = true;
		this.stop();
		this.completion.reject(new Error(message));
	}

	private append(chunk: Uint8Array | string, stderr: boolean): void {
		if (this.settled) return;
		const bytes = Buffer.from(chunk);
		if (this.outputBytes + bytes.byteLength > MAX_OUTPUT_BYTES) {
			this.fail('workspace process output exceeds limit');
			return;
		}
		this.outputBytes += bytes.byteLength;
		if (stderr) this.stderr.push(bytes);
		else this.stdout.push(bytes);
	}

	private complete(result: {
		readonly stdout: string;
		readonly stderr: string;
		readonly exitCode: number | null;
	}): void {
		if (this.settled) return;
		this.settled = true;
		this.completion.resolve(result);
	}

	private stop(): void {
		const pid = this.child?.pid;
		if (pid === undefined) return;
		void this.killTree(pid, true).catch(() => undefined);
	}
}

function fixedShellArgs(shellPath: string): readonly string[] {
	const executable = basename(shellPath).toLowerCase();
	if (executable === 'powershell.exe' || executable === 'pwsh.exe') {
		return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command'];
	}
	return ['--noprofile', '--norc', '-c'];
}

function closedEnvironment(
	privateHome: string,
	environment: Readonly<Record<string, string | undefined>>
): Readonly<Record<string, string>> {
	const result: Record<string, string> = { HOME: privateHome, USERPROFILE: privateHome };
	for (const key of ['PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'TMP', 'TEMP']) {
		const value = environment[key];
		if (typeof value === 'string' && value.length > 0) result[key] = value;
	}
	return result;
}

const defaultWorkspaceProcessSpawn: WorkspaceProcessSpawner = (command, args, options) =>
	nodeSpawn(command, args, {
		...options,
		stdio: ['ignore', 'pipe', 'pipe'],
	}) as WorkspaceProcessChild;

function unavailable(): Error {
	return new Error('workspace process unavailable');
}

function samePath(left: string, right: string): boolean {
	return process.platform === 'win32'
		? left.toLocaleLowerCase() === right.toLocaleLowerCase()
		: left === right;
}
