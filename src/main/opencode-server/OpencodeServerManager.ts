// src/main/opencode-server/OpencodeServerManager.ts

/**
 * Owns the long-lived `opencode serve` process(es) that back the SDK execution
 * path, and the SDK client bound to each.
 *
 * OpenCode's server is project-scoped via a `directory` query param on every
 * request, so a single server process serves every Maestro workspace - we key
 * instances by the resolved binary path (a user could point different agents at
 * different opencode builds; almost always there's just one). The server is
 * spawned lazily on first prompt and torn down on app shutdown.
 *
 * We deliberately spawn the server ourselves instead of using the SDK's
 * `createOpencodeServer`, because that helper hardcodes the `opencode` binary on
 * PATH and Maestro must honor the user's resolved/custom binary and its spawn
 * environment (version-manager PATH, shell env vars, etc.).
 */

import { spawn, type ChildProcess } from 'child_process';
import type { OpencodeClient } from '@opencode-ai/sdk';
import { loadOpencodeSdk } from './sdk-loader';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { buildChildProcessEnv } from '../process-manager/utils/envBuilder';

/**
 * Auto-approve every tool. This mirrors the CLI path's `OPENCODE_CONFIG_CONTENT`
 * so the SDK migration is behavior-preserving: no permission prompts today. When
 * the permission-bubbling feature lands, this becomes per-tool `ask` and the
 * `permission.updated` SSE events get surfaced to the renderer.
 */
const AUTO_APPROVE_CONFIG = {
	permission: { '*': 'allow', external_directory: 'allow', question: 'deny' },
	tools: { question: false },
} as const;

// COWORKING FOLLOW-UP (gated behind encoreFeatures.opencodeServer): the shared
// serve process gets no per-session coworking env, so its env-less MCP
// subprocess fails the bridge handshake (ppid → serve PID, untracked) and
// coworking tools are cleanly unavailable. The way around, when we want
// coworking on this transport, is to move identity off the process env and onto
// a per-session MCP *registration*: (1) add `mcp: { 'maestro-coworking': { enabled: false } }`
// here so the global env-less entry never loads, then (2) per session call
// `client.mcp.add({ query: { directory }, body: { name: 'maestro-coworking-<maestroSessionId>',
// config: { type: 'local', command: [node, scriptPath], environment: {
// MAESTRO_COWORKING_SESSION_ID, MAESTRO_COWORKING_SOCKET_OVERRIDE } } } })` so the
// id rides the named server (existing bridge handshake + fail-closed logic work
// unchanged), and (3) scope visibility with the per-prompt `tools` map on
// `session.promptAsync` so one session can't see another's `maestro-coworking-*`
// tools. Blockers to verify against the live opencode build first: mcp.add
// scoping/persistence semantics, no de-registration endpoint (only disconnect),
// and the tool-key wildcard semantics of the per-prompt `tools` filter.

/** How long to wait for the server to print its readiness line before failing. */
const SERVER_START_TIMEOUT_MS = 15000;

export interface OpencodeServerHandle {
	url: string;
	client: OpencodeClient;
}

interface ServerInstance extends OpencodeServerHandle {
	process: ChildProcess;
}

export interface EnsureServerOptions {
	/** Resolved opencode binary path (ProcessConfig.command). */
	binaryPath: string;
	/** Session-level custom env vars (ProcessConfig.customEnvVars). */
	customEnvVars?: Record<string, string>;
	/** Global shell env vars (ProcessConfig.shellEnvVars). */
	shellEnvVars?: Record<string, string>;
	/** Extra PATH dirs (ProcessConfig.extraPathDirs). */
	extraPathDirs?: string[];
	/** Working directory to spawn the server in (any workspace; requests are
	 *  scoped per-call via `directory`). */
	cwd: string;
}

class OpencodeServerManager {
	/** Ready server instances, keyed by the composite server key (binary + env). */
	private servers = new Map<string, ServerInstance>();
	/** In-flight startups, keyed by the composite server key, to dedupe concurrent spawns. */
	private starting = new Map<string, Promise<OpencodeServerHandle>>();
	/** Startup child processes not yet promoted to `servers`, so shutdown can kill
	 *  a server still waiting on its readiness banner. */
	private startupChildren = new Set<ChildProcess>();

	/**
	 * Ensure a server for the given binary + environment is running and return its
	 * client. Concurrent callers for the same key share a single startup.
	 */
	async ensureServer(opts: EnsureServerOptions): Promise<OpencodeServerHandle> {
		const key = buildServerKey(opts);

		const existing = this.servers.get(key);
		if (existing) return { url: existing.url, client: existing.client };

		const inFlight = this.starting.get(key);
		if (inFlight) return inFlight;

		const startup = this.startServer(opts, key)
			.then((instance) => {
				this.servers.set(key, instance);
				this.starting.delete(key);
				return { url: instance.url, client: instance.client };
			})
			.catch((err) => {
				this.starting.delete(key);
				throw err;
			});

		this.starting.set(key, startup);
		return startup;
	}

	private async startServer(opts: EnsureServerOptions, key: string): Promise<ServerInstance> {
		const hostname = '127.0.0.1';
		const env = buildChildProcessEnv(
			opts.customEnvVars,
			false,
			opts.shellEnvVars,
			opts.extraPathDirs
		);
		env.OPENCODE_CONFIG_CONTENT = JSON.stringify(AUTO_APPROVE_CONFIG);

		logger.info('[OpencodeServer] Starting shared server', 'OpencodeServer', {
			binaryPath: opts.binaryPath,
			hostname,
			cwd: opts.cwd,
		});

		// Bind to an OS-assigned port (`--port=0`) and read the real URL from the
		// readiness banner. Pre-picking a "free" port and passing it separately is a
		// TOCTOU race — the port can be taken between the probe and the server's
		// bind, surfacing only as an opaque 15s startup timeout.
		const child = spawn(opts.binaryPath, ['serve', `--hostname=${hostname}`, '--port=0'], {
			cwd: opts.cwd,
			env,
			stdio: ['ignore', 'pipe', 'pipe'],
		});

		// Track the child so shutdown() can kill it even if readiness never resolves.
		this.startupChildren.add(child);
		try {
			const url = await this.awaitReadiness(child);

			// Keep the pipes draining after readiness. awaitReadiness detaches its
			// accumulating listeners, which would otherwise pause the streams and
			// eventually block the server once the OS pipe buffer fills.
			child.stdout?.resume();
			child.stderr?.resume();

			// Once ready, drop the cached instance if the server ever exits so the next
			// prompt re-spawns a fresh one instead of hitting a dead socket.
			child.on('exit', (code, signal) => {
				logger.warn('[OpencodeServer] Server process exited', 'OpencodeServer', {
					binaryPath: opts.binaryPath,
					code,
					signal,
				});
				const current = this.servers.get(key);
				if (current?.process === child) {
					this.servers.delete(key);
				}
			});

			const { createOpencodeClient } = await loadOpencodeSdk();
			const client = createOpencodeClient({ baseUrl: url });
			logger.info('[OpencodeServer] Server ready', 'OpencodeServer', { url });
			return { url, client, process: child };
		} finally {
			// Once promoted to `servers` (or dead on failure), it's no longer a
			// pending startup child.
			this.startupChildren.delete(child);
		}
	}

	/**
	 * Resolve when the server prints `opencode server listening on <url>`, or
	 * reject on early exit / timeout. Mirrors the SDK's readiness detection.
	 */
	private awaitReadiness(child: ChildProcess): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			let output = '';
			// Unparsed remainder: only complete (newline-terminated) lines are scanned
			// for the banner, so a banner split across chunks can't resolve on a
			// truncated URL.
			let lineBuf = '';
			let settled = false;

			// Named handlers so `finish` can detach them once the promise settles;
			// otherwise they keep appending the long-lived server's output to `output`
			// forever (unbounded memory growth). The caller resumes the streams after
			// readiness to keep the pipes draining.
			const onStdout = (chunk: string) => {
				output += chunk;
				lineBuf += chunk;
				const lastNl = lineBuf.lastIndexOf('\n');
				if (lastNl === -1) return;
				const complete = lineBuf.slice(0, lastNl);
				lineBuf = lineBuf.slice(lastNl + 1);
				for (const line of complete.split('\n')) {
					if (line.startsWith('opencode server listening')) {
						const match = line.match(/on\s+(https?:\/\/[^\s]+)/);
						if (match) {
							finish(() => resolve(match[1]));
							return;
						}
					}
				}
			};
			const onStderr = (chunk: string) => {
				output += chunk;
			};
			const onError = (err: Error) => finish(() => reject(err));
			const onExit = (code: number | null) =>
				finish(() =>
					reject(
						new Error(
							`opencode server exited with code ${code} before becoming ready.` +
								(output.trim() ? `\nOutput: ${output.slice(-2000)}` : '')
						)
					)
				);

			const finish = (fn: () => void) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				child.stdout?.off('data', onStdout);
				child.stderr?.off('data', onStderr);
				child.off('error', onError);
				child.off('exit', onExit);
				fn();
			};

			const timer = setTimeout(() => {
				finish(() => {
					try {
						child.kill();
					} catch {
						// already dead
					}
					reject(
						new Error(
							`Timed out after ${SERVER_START_TIMEOUT_MS}ms waiting for opencode server.` +
								(output.trim() ? `\nOutput: ${output.slice(-2000)}` : '')
						)
					);
				});
			}, SERVER_START_TIMEOUT_MS);

			child.stdout?.setEncoding('utf8');
			child.stdout?.on('data', onStdout);
			child.stderr?.setEncoding('utf8');
			child.stderr?.on('data', onStderr);
			child.on('error', onError);
			child.on('exit', onExit);
		});
	}

	/** Kill every running server and any still-starting child. Called on app shutdown. */
	shutdown(): void {
		for (const [key, instance] of this.servers) {
			try {
				instance.process.kill();
			} catch (err) {
				void captureException(err);
			}
			this.servers.delete(key);
		}
		// Kill servers still waiting on their readiness banner (tracked separately
		// from `servers`, so the loop above misses them).
		for (const child of this.startupChildren) {
			try {
				child.kill();
			} catch (err) {
				void captureException(err);
			}
		}
		this.startupChildren.clear();
		this.starting.clear();
	}
}

/**
 * Build the cache key for a server instance. Keying on the binary path alone
 * would let agents/sessions with different environments (e.g. distinct API keys
 * or PATH) reuse a server started with someone else's env, leaking credentials
 * and config across sessions. Fold a stable fingerprint of the env inputs into
 * the key so those get their own server.
 */
function buildServerKey(opts: EnsureServerOptions): string {
	const fingerprint = (record?: Record<string, string>): string =>
		record
			? Object.keys(record)
					.sort()
					.map((k) => `${k}=${record[k]}`)
					.join(' ')
			: '';
	return [
		opts.binaryPath,
		fingerprint(opts.customEnvVars),
		fingerprint(opts.shellEnvVars),
		(opts.extraPathDirs ?? []).join(':'),
	].join('\u0001');
}

/** Process-wide singleton. */
export const opencodeServerManager = new OpencodeServerManager();
