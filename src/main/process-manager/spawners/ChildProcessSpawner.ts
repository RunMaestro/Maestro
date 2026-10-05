// src/main/process-manager/spawners/ChildProcessSpawner.ts

import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import { createOutputParser } from '../../parsers';
import type { ProcessConfig, ManagedProcess, SpawnResult } from '../types';
import type { DataBufferManager } from '../handlers/DataBufferManager';
import { StdoutHandler } from '../handlers/StdoutHandler';
import { StderrHandler } from '../handlers/StderrHandler';
import { ExitHandler } from '../handlers/ExitHandler';
import { collectMaestroEnvVars } from '../utils/envBuilder';
import { DEFAULT_QUERY_SOURCE } from '../../../shared/querySource';
import { saveImageToTempFile } from '../utils/imageUtils';
import { captureException } from '../../utils/sentry';
import { nextSpawnGeneration, isSupersededGeneration } from '../generation';
import { startTurn } from '../../../shared/maestro-lib/run/start-turn';
import { planPipeSpawn } from '../../../shared/maestro-lib/run/pipe-spawn';
import { INTERACTIVE_STOP_GRACE_MS } from '../../../shared/maestro-lib/control/termination';

/**
 * Handles spawning of child processes (non-PTY).
 * Used for AI agents in batch mode and interactive mode.
 */
export class ChildProcessSpawner {
	private stdoutHandler: StdoutHandler;
	private stderrHandler: StderrHandler;
	private exitHandler: ExitHandler;

	constructor(
		private processes: Map<string, ManagedProcess>,
		private emitter: EventEmitter,
		private bufferManager: DataBufferManager
	) {
		this.stdoutHandler = new StdoutHandler({
			processes: this.processes,
			emitter: this.emitter,
			bufferManager: this.bufferManager,
		});
		this.stderrHandler = new StderrHandler({
			processes: this.processes,
			emitter: this.emitter,
		});
		this.exitHandler = new ExitHandler({
			processes: this.processes,
			emitter: this.emitter,
			bufferManager: this.bufferManager,
		});
	}

	/**
	 * Spawn a child process for a session
	 */
	spawn(config: ProcessConfig): SpawnResult {
		const { sessionId, toolType, cwd, command, contextWindow, ompModelCatalogKey } = config;
		const { customEnvVars, shellEnvVars } = config;

		try {
			// Create a fresh output parser instance for this process (not the shared singleton)
			// to isolate mutable state like tool name tracking across concurrent sessions
			const outputParser = createOutputParser(toolType) || undefined;

			// What the process starts is decided in the library (`planPipeSpawn`), the same decision the
			// headless runtime's group chat and consult turns make: where the prompt travels, which
			// arguments the images add, the Windows shell escaping, the environment, and what stdin
			// carries. Everything below is this host's: the process record and the renderer events.
			const plan = planPipeSpawn(
				{ ...config, hasOutputParser: !!outputParser },
				{ saveImageToTempFile }
			);
			const { tempImageFiles, isBatchMode, isStreamJsonMode, isResuming } = plan;
			const finalArgs = plan.args;

			// The process is started, streamed and settled by the library's run
			// layer, the same one the CLI and Cue use. Everything the renderer
			// hears is still produced here, from the run layer's callbacks, in the
			// same order as before: raw stdout, then the stdout handler; stderr;
			// then exit. A killed predecessor's late events are dropped by the
			// generation check below. `managedProcess` is built once the process
			// exists; every callback that reads it runs later, from the event loop.
			const isSuperseded = (): boolean =>
				isSupersededGeneration(sessionId, managedProcess.spawnGeneration);

			const turn = startTurn(
				plan.spec,
				{
					onStdout: (output) => {
						if (isSuperseded()) return;
						// Emit raw stdout before processing for live-streaming consumers (e.g., group chat peek).
						// Wrapped in try/catch so a failing listener cannot prevent stdoutHandler from running.
						try {
							this.emitter.emit('raw-stdout', sessionId, output);
						} catch (err) {
							void captureException(err);
							logger.error('[ProcessManager] raw-stdout listener error', 'ProcessManager', {
								sessionId,
								error: String(err),
							});
						}
						this.stdoutHandler.handleData(sessionId, output);
					},
					onStderr: (stderrData) => {
						if (isSuperseded()) return;
						this.stderrHandler.handleData(sessionId, stderrData);
					},
				},
				{
					// The desktop stops through ProcessManager.interrupt() / kill(),
					// which run the same ladder on this child; the turn's own stop
					// methods are not used here.
					stopGraceMs: INTERACTIVE_STOP_GRACE_MS,
					keepStdinOpen: plan.keepStdinOpen,
					// The stdout and stderr handlers keep what the desktop needs; a
					// second copy here would only grow for as long as the process lives.
					stdoutTailLimit: 0,
					stderrTailLimit: 0,
					sessionId,
					label: toolType,
				}
			);
			const childProcess = turn.child;

			// A stream error with no listener is an uncaught exception. stdin's is
			// the common one: EPIPE, from a prompt written to a process that has
			// already gone; the exit that follows reports what happened.
			childProcess.stdin?.on('error', (err) => {
				const errorCode = (err as NodeJS.ErrnoException).code;
				if (errorCode === 'EPIPE') {
					logger.debug(
						'[ProcessManager] stdin EPIPE - process closed before write completed',
						'ProcessManager',
						{ sessionId }
					);
				} else {
					logger.error('[ProcessManager] stdin error', 'ProcessManager', {
						sessionId,
						error: String(err),
						code: errorCode,
					});
				}
			});
			childProcess.stdout?.on('error', (err) => {
				logger.error('[ProcessManager] stdout error', 'ProcessManager', {
					sessionId,
					error: String(err),
				});
			});
			childProcess.stderr?.on('error', (err) => {
				logger.error('[ProcessManager] stderr error', 'ProcessManager', {
					sessionId,
					error: String(err),
				});
			});

			logger.debug('[ProcessManager] Child process spawned', 'ProcessManager', {
				sessionId,
				pid: childProcess.pid,
				hasStdout: !!childProcess.stdout,
				hasStderr: !!childProcess.stderr,
				hasStdin: !!childProcess.stdin,
				killed: childProcess.killed,
				exitCode: childProcess.exitCode,
			});

			logger.debug('[ProcessManager] Output parser lookup', 'ProcessManager', {
				sessionId,
				toolType,
				hasParser: !!outputParser,
				parserId: outputParser?.agentId,
				isStreamJsonMode,
				isBatchMode,
				hasSshStdinScript: !!config.sshStdinScript,
				command: config.command,
				argsCount: finalArgs.length,
			});

			const managedProcess: ManagedProcess = {
				sessionId,
				toolType,
				childProcess,
				cwd,
				pid: childProcess.pid || -1,
				isTerminal: false,
				isBatchMode,
				isStreamJsonMode,
				jsonBuffer: isBatchMode ? '' : undefined,
				startTime: Date.now(),
				outputParser,
				stderrBuffer: '',
				stdoutBuffer: '',
				contextWindow,
				ompModelCatalogKey,
				tempImageFiles: tempImageFiles.length > 0 ? tempImageFiles : undefined,
				command,
				args: finalArgs,
				querySource: config.querySource,
				tabId: config.tabId,
				projectPath: config.projectPath,
				sshRemoteId: config.sshRemoteId,
				sshRemoteHost: config.sshRemoteHost,
				sshRemoteCommand: config.sshRemoteCommand,
				// Seed from config on resume. Copilot emits `session.resume`
				// (no sessionId) instead of `session.start` when --resume=<id>
				// is set, so StdoutHandler can't populate this from the stream
				// for resumed sessions - without the seed, the post-exit disk
				// reconciliation (`ExitHandler.awaitCopilotShutdown` →
				// `readCopilotFinalAnswer` + `readCopilotShutdownUsage`)
				// short-circuits at its `if (!agentSessionId) return` guard and
				// the renderer falls back to the streamed commentary deltas
				// instead of the authoritative task_complete.summary, and the
				// context-window gauge never receives the on-disk currentTokens
				// snapshot. The stream-derived assignment in
				// `StdoutHandler.emitSessionIdIfNeeded` remains the source of
				// truth for fresh sessions.
				agentSessionId: config.agentSessionId,
				maestroEnvVars: collectMaestroEnvVars(
					shellEnvVars,
					customEnvVars,
					isResuming,
					config.querySource ?? DEFAULT_QUERY_SOURCE
				),
			};

			// A killed process keeps emitting stdio and fires `close` well after
			// ProcessManager has registered a replacement under the same sessionId
			// key (`spawn()` kills the predecessor first, then the spawner re-uses
			// the key). Everything downstream is keyed by sessionId alone, so those
			// late events get attributed to the live successor: its `close` reports
			// the dead turn's exit code (143 after SIGTERM) as the live agent
			// crashing AND deletes the successor's tracking entry, orphaning a
			// process the user can no longer stop.
			//
			// Generation, not map identity: the map answers "am I still the entry?",
			// which stops working the moment the successor finishes and deletes its
			// own entry - at which point a predecessor still draining would look
			// current again. See process-manager/generation.ts.
			managedProcess.spawnGeneration = nextSpawnGeneration(sessionId);
			this.processes.set(sessionId, managedProcess);

			// The run layer settles once the streams have ended, so every line the
			// process wrote has been read by then. A process that never started is
			// reported once, as an error, rather than as an error and then a close.
			void turn.done.then((exit) => {
				if (isSuperseded()) {
					logger.warn('[ProcessManager] Ignoring exit from superseded process', 'ProcessManager', {
						sessionId,
						pid: childProcess.pid,
						exitCode: exit.exitCode,
						error: exit.spawnError ? String(exit.spawnError) : undefined,
					});
					return;
				}
				if (exit.spawnError) {
					this.exitHandler.handleError(sessionId, exit.spawnError);
					return;
				}
				// Hand the exiting process in explicitly: it may already have been
				// unregistered, and handleExit must settle THIS process rather than
				// whatever currently owns the session id.
				// `signal` is what tells a kill from a clean exit once `code || 0` has
				// turned the killed process's null code into 0. `stdinError` says the
				// prompt never fully reached the agent.
				return this.exitHandler
					.handleExit(sessionId, exit.exitCode || 0, managedProcess, exit.signal, exit.stdinError)
					.catch((err) => {
						logger.error('[ProcessManager] handleExit threw', 'ProcessManager', {
							sessionId,
							error: String(err),
						});
					});
			});

			return { pid: childProcess.pid || -1, success: true };
		} catch (error) {
			void captureException(error);
			logger.error('[ProcessManager] Failed to spawn process', 'ProcessManager', {
				error: String(error),
			});
			return { pid: -1, success: false };
		}
	}
}
