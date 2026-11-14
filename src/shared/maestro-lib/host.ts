/**
 * The services maestro-lib borrows from whatever process hosts it.
 *
 * The library is plain Node: it spawns, parses, and resolves turns without
 * Electron and without importing `src/main/**` (enforced by the
 * `shared-boundary/no-shared-to-main-imports` lint rule, which allows no
 * exceptions). A few things it touches are not the library's to own, though:
 * where log lines go, where crashes are reported, the desktop's live agent
 * capability snapshots, the content-addressed image store behind
 * `maestro-image://` refs, and Antigravity CLI's on-disk conversation store
 * (a native SQLite read), and the host's SSH translation filesystem adapter.
 * Those arrive through this module instead of an import.
 *
 * Wiring: the desktop module that owns each service registers it when that
 * module loads (`src/main/utils/logger.ts`, `src/main/utils/sentry.ts`,
 * `src/main/agents/capability-snapshot.ts`,
 * `src/main/storage/session-image-store.ts`,
 * `src/main/parsers/antigravity-step-store.ts`). So every process that had the
 * service before - the Electron main process and the CLI, which both load
 * those modules - still has it, with no entry point to remember.
 * `src/main/utils/ssh-spawn-wrapper.ts` registers the SSH filesystem lazily.
 *
 * Defaults, for a host that registers nothing: log lines and crash reports are
 * dropped, no capability snapshot exists (context windows fall back to the
 * static defaults), a `maestro-image://` ref does not resolve (it is treated
 * as unparseable, exactly as a ref whose file is missing), and agy's store
 * reads as empty (no thinking text or command exit codes beyond the stream).
 * Each is what a process without the corresponding desktop module effectively
 * got before this seam existed.
 */

import type { AgentCapabilitiesSnapshot } from '../agentCapabilities';
import type { SshRemoteConfig } from '../types';
import type { TranslationFs } from './translation/fs-port';

export interface MaestroLibLogger {
	debug(message: string, context?: string, data?: unknown): void;
	info(message: string, context?: string, data?: unknown): void;
	warn(message: string, context?: string, data?: unknown): void;
	error(message: string, context?: string, data?: unknown): void;
}

export type MaestroLibSeverity = 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug';

export interface MaestroLibErrorReporter {
	captureException(error: unknown, extra?: Record<string, unknown>): Promise<void> | void;
	captureMessage(
		message: string,
		level?: MaestroLibSeverity,
		extra?: Record<string, unknown>
	): Promise<void> | void;
}

/** Bytes behind a `maestro-image://` ref, or `null` when it cannot be read. */
export type ImageRefResolver = (ref: string) => { buffer: Buffer; mediaType: string } | null;

/** The host's live capability snapshot for an agent, if it has one. */
export type CapabilitySnapshotLookup = (
	agentId: string,
	sshRemoteId?: string | null
) => AgentCapabilitiesSnapshot | undefined;

/**
 * What Antigravity CLI records on disk about a conversation, for the two facts
 * its `stream-json` output leaves out: a model step's thinking summary and a
 * tool step's stored result (which carries a command's exit status). Both
 * methods answer '' when there is nothing to read.
 */
export interface AntigravityStepStore {
	readThinking(conversationId: string, stepIndex: number): string;
	readToolResult(conversationId: string, stepIndex: number): string;
}

const noop = (): void => {};

const NOOP_LOGGER: MaestroLibLogger = { debug: noop, info: noop, warn: noop, error: noop };
const NOOP_REPORTER: MaestroLibErrorReporter = { captureException: noop, captureMessage: noop };

let hostLogger: MaestroLibLogger = NOOP_LOGGER;
let hostReporter: MaestroLibErrorReporter = NOOP_REPORTER;
let hostImageRefResolver: ImageRefResolver = () => null;
let hostCapabilitySnapshot: CapabilitySnapshotLookup = () => undefined;
let hostSshTranslationFs:
	| ((remote: SshRemoteConfig) => TranslationFs | Promise<TranslationFs>)
	| undefined;
let hostAntigravityStepStore: AntigravityStepStore = {
	readThinking: () => '',
	readToolResult: () => '',
};

export function setMaestroLibLogger(next: MaestroLibLogger): void {
	hostLogger = next;
}

export function setMaestroLibErrorReporter(next: MaestroLibErrorReporter): void {
	hostReporter = next;
}

export function setMaestroLibImageRefResolver(next: ImageRefResolver): void {
	hostImageRefResolver = next;
}

export function setMaestroLibCapabilitySnapshotLookup(next: CapabilitySnapshotLookup): void {
	hostCapabilitySnapshot = next;
}

/** Desktop/CLI register their canonical remote-fs adapter; standalone hosts may supply one. */
export function setMaestroLibSshTranslationFs(
	next: ((remote: SshRemoteConfig) => TranslationFs | Promise<TranslationFs>) | undefined
): void {
	hostSshTranslationFs = next;
}

export async function resolveSshTranslationFs(remote: SshRemoteConfig): Promise<TranslationFs> {
	if (!hostSshTranslationFs)
		throw new Error('SSH provider knowledge requires a remote filesystem adapter');
	return hostSshTranslationFs(remote);
}

export function setMaestroLibAntigravityStepStore(next: AntigravityStepStore): void {
	hostAntigravityStepStore = next;
}

/**
 * The library's logger. Every call is forwarded, with exactly the arguments
 * given, to whatever is registered at CALL time, so a module that captured
 * `logger` at import still reaches a logger registered later.
 */
export const logger: MaestroLibLogger = {
	debug: (...args) => hostLogger.debug(...args),
	info: (...args) => hostLogger.info(...args),
	warn: (...args) => hostLogger.warn(...args),
	error: (...args) => hostLogger.error(...args),
};

// Arguments are forwarded exactly as given (not padded with `undefined`), so the
// registered reporter applies its own defaults, e.g. Sentry's `level = 'error'`.
export async function captureException(
	...args: Parameters<MaestroLibErrorReporter['captureException']>
): Promise<void> {
	await hostReporter.captureException(...args);
}

export async function captureMessage(
	...args: Parameters<MaestroLibErrorReporter['captureMessage']>
): Promise<void> {
	await hostReporter.captureMessage(...args);
}

export function resolveImageRef(ref: string): { buffer: Buffer; mediaType: string } | null {
	return hostImageRefResolver(ref);
}

export function getCapabilitySnapshot(
	agentId: string,
	sshRemoteId?: string | null
): AgentCapabilitiesSnapshot | undefined {
	return hostCapabilitySnapshot(agentId, sshRemoteId);
}

/**
 * agy's conversation store, read through whatever is registered at CALL time
 * (`src/main/parsers/antigravity-step-store.ts` registers the SQLite reader).
 * Unregistered, every read is '' and the parser streams without enrichment.
 */
export const antigravityStepStore: AntigravityStepStore = {
	readThinking: (...args) => hostAntigravityStepStore.readThinking(...args),
	readToolResult: (...args) => hostAntigravityStepStore.readToolResult(...args),
};
