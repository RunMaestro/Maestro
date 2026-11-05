/**
 * Shared Pianola filesystem store - NODE ONLY (imports `fs`).
 *
 * Intentionally NOT imported by the renderer: only the main-process store
 * (`main/pianola/pianola-store-main.ts`) and the CLI store
 * (`cli/services/pianola-store.ts`) use it, so it never enters the renderer
 * bundle (same convention as `decision-log.ts`).
 *
 * The two stores were ~95% duplicated and had already drifted (tab vs 2-space
 * indent, trailing-newline). This single source keeps their read / validate /
 * atomic-write / compaction behavior identical; the only per-store differences -
 * the data directory and the JSON formatting - are injected.
 */

import * as fs from 'fs';
import * as path from 'path';
import { isDeepStrictEqual } from 'node:util';
import { reconcileSuggestionEvidence } from './pianola-synthesis';
import { settledDecisionPairs } from './transcript-mining';
import { createHash } from 'crypto';
import { assertSerializedJsonIsSafe } from '../jsonUtils';
import {
	PIANOLA_RULES_FILENAME,
	PIANOLA_DECISIONS_FILENAME,
	PIANOLA_PLANS_FILENAME,
	PIANOLA_PROGRAMS_FILENAME,
	PIANOLA_ASKS_FILENAME,
	PIANOLA_SUPERVISOR_FILENAME,
	PIANOLA_PROGRAM_LOOP_FILENAME,
	PIANOLA_PROFILES_FILENAME,
	PIANOLA_SUGGESTIONS_FILENAME,
	PIANOLA_DECISIONS_MAX_RECORDS,
	PIANOLA_DECISIONS_COMPACT_BYTES,
	PIANOLA_DECISION_RECORD_MAX_BYTES,
	validatePianolaRules,
	validatePianolaDecisionRecord,
	validatePianolaPlansFile,
	validatePianolaProgramsFile,
	validatePianolaAsksFile,
	validatePianolaSupervisorFile,
	validatePianolaSuggestionsFile,
	validatePianolaProfiles,
	resolveProfile,
	type PianolaSuggestionsFile,
	type PianolaProfiles,
	type PianolaProfileEntry,
	type PianolaProfileSource,
	type PianolaDecisionRecord,
	type RulesLoadResult,
	type PianolaPlan,
	type PianolaSupervisedTarget,
} from './storage';
import { appendDecisionLine, compactDecisionLog } from './decision-log';
import type { PianolaRule } from './types';
import {
	validatePianolaScopeCheckpoint,
	type PianolaScopeCheckpoint,
} from './pianola-scope-checkpoint';
import { isPianolaScopeId } from './pianola-scope';
import { canonicalJson } from '../canonicalJson';
import { isWindows } from '../platformDetection';
import type { PianolaProgram, PianolaAsk } from './pianola-programs';
import {
	validateProgramLoopMemo,
	type ProgramLoopMemo,
	type ProgramLoopMemoEntry,
} from './pianola-program-loop';

import {
	validatePianolaDispatchAdmission,
	type PianolaDispatchAdmission,
} from './pianola-dispatch';

const ASKS_LOCK_TIMEOUT_MS = 5_000;
const ASKS_LOCK_STALE_MS = 30_000;
const lockWait = new Int32Array(new SharedArrayBuffer(4));
export interface PianolaFsStoreConfig {
	/** Resolve the data dir (Electron userData for main, config dir for CLI). Re-read per op. */
	resolveDir: () => string;
	/** JSON.stringify indent for the object files (`'\t'` for main, `2` for CLI). */
	indent: string | number;
	/** Append a trailing newline to object files (CLI does; main does not). */
	trailingNewline: boolean;
	/** Main must refuse contended synchronous decision claims without waiting. */
	decisionLockMode?: 'try';
}

/** Exact content around a successful mutation while its file lock is held. */
export interface PianolaFileMutationReceipt {
	before: string | null;
	after: string | null;
}

/** The store surface shared by the desktop and CLI Pianola stores. */
export interface PianolaFsStore {
	readRulesResult(): RulesLoadResult;
	readRules(): PianolaRule[];
	writeRules(rules: unknown): PianolaRule[];
	/** Compare-and-append under the decision lock; updates the supplied revision on success.
	 * Conflicts throw before a caller may send; reread rather than retrying stale state. */
	appendDecision(
		record: PianolaDecisionRecord,
		receipt?: (value: PianolaFileMutationReceipt) => void
	): void;
	/** Yields while waiting; holds the same CAS/append/compaction lock only for synchronous IO. */
	appendDecisionAsync(record: PianolaDecisionRecord): Promise<void>;
	readDecisions(limit?: number): PianolaDecisionRecord[];
	readPlans(): PianolaPlan[];
	writePlans(plans: PianolaPlan[]): PianolaPlan[];
	getPlan(planId: string): PianolaPlan | null;
	upsertPlan(plan: PianolaPlan): PianolaPlan[];
	updatePlans(update: (plans: PianolaPlan[]) => PianolaPlan[]): PianolaPlan[];
	writePlansAsync(plans: PianolaPlan[]): Promise<PianolaPlan[]>;
	updatePlansAsync(update: (plans: PianolaPlan[]) => PianolaPlan[]): Promise<PianolaPlan[]>;
	upsertPlanAsync(plan: PianolaPlan): Promise<PianolaPlan[]>;
	readPrograms(): PianolaProgram[];
	writePrograms(programs: PianolaProgram[]): PianolaProgram[];
	upsertProgram(program: PianolaProgram): PianolaProgram[];
	updatePrograms(update: (programs: PianolaProgram[]) => PianolaProgram[]): PianolaProgram[];
	writeProgramsAsync(programs: PianolaProgram[]): Promise<PianolaProgram[]>;
	updateProgramsAsync(
		update: (programs: PianolaProgram[]) => PianolaProgram[]
	): Promise<PianolaProgram[]>;
	upsertProgramAsync(program: PianolaProgram): Promise<PianolaProgram[]>;
	/** Hold exclusive ownership across the complete asynchronous loop tick. */
	withProgramLoopLock<T>(programId: string, operation: () => Promise<T>): Promise<T>;
	/** Serialize revisions with the complete orchestrator tick for this plan. */
	withPlanLock<T>(
		planId: string,
		operation: () => Promise<T>,
		options?: { waitForTurn?: boolean }
	): Promise<T>;
	readAsks(): PianolaAsk[];
	writeAsks(asks: PianolaAsk[]): PianolaAsk[];
	updateAsks(update: (asks: PianolaAsk[]) => PianolaAsk[]): PianolaAsk[];
	/** Desktop variants yield between lock attempts; sync variants are for the CLI. */
	writeAsksAsync(asks: PianolaAsk[]): Promise<PianolaAsk[]>;
	updateAsksAsync(update: (asks: PianolaAsk[]) => PianolaAsk[]): Promise<PianolaAsk[]>;
	readProgramLoopMemo(): ProgramLoopMemo;
	writeProgramLoopMemo(memo: ProgramLoopMemo): void;
	updateProgramLoopMemo(programId: string, entry: ProgramLoopMemoEntry): void;
	writeProgramLoopMemoAsync(memo: ProgramLoopMemo): Promise<void>;
	updateProgramLoopMemoAsync(programId: string, entry: ProgramLoopMemoEntry): Promise<void>;
	readSuggestions(): PianolaSuggestionsFile;
	writeSuggestions(file: PianolaSuggestionsFile): PianolaSuggestionsFile;
	readProfiles(): PianolaProfiles;
	writeProfiles(profiles: PianolaProfiles): PianolaProfiles;
	getProfile(projectPath?: string): {
		source: PianolaProfileSource;
		entry: PianolaProfileEntry | null;
	};
	setProfile(entry: PianolaProfileEntry, projectPath?: string): PianolaProfiles;
	readSupervisorTargets(): PianolaSupervisedTarget[];
	/** Revalidate the on-disk revision synchronously at the final host send boundary. */
	readSupervisorTarget(id: string): PianolaSupervisedTarget | undefined;
	writeSupervisorTargets(targets: PianolaSupervisedTarget[]): PianolaSupervisedTarget[];
	updateSupervisorTargets(
		update: (targets: PianolaSupervisedTarget[]) => PianolaSupervisedTarget[]
	): PianolaSupervisedTarget[];
	upsertSupervisorTarget(target: PianolaSupervisedTarget): PianolaSupervisedTarget[];
	removeSupervisorTarget(id: string): PianolaSupervisedTarget[];
	/** Corrupt admission records must never be treated as a new dispatch. */
	readDispatchAdmission(dispatchId: string): PianolaDispatchAdmission | null;
	writeDispatchAdmission(admission: PianolaDispatchAdmission): void;
	/** A missing checkpoint is a first enrollment; a corrupt one throws. */
	readScopeCheckpoint(scopeId: string): PianolaScopeCheckpoint | null;
	writeScopeCheckpoint(
		checkpoint: PianolaScopeCheckpoint,
		durable?: boolean,
		receipt?: (value: PianolaFileMutationReceipt) => void
	): void;
	writeSupervisorTargetsAsync(
		targets: PianolaSupervisedTarget[]
	): Promise<PianolaSupervisedTarget[]>;
	updateSupervisorTargetsAsync(
		update: (targets: PianolaSupervisedTarget[]) => PianolaSupervisedTarget[]
	): Promise<PianolaSupervisedTarget[]>;
	upsertSupervisorTargetAsync(target: PianolaSupervisedTarget): Promise<PianolaSupervisedTarget[]>;
	removeSupervisorTargetAsync(id: string): Promise<PianolaSupervisedTarget[]>;
	/** Absolute path to the supervised-target registry the desktop supervisor watches. */
	supervisorFilePath(): string;
}

export function createPianolaFsStore(config: PianolaFsStoreConfig): PianolaFsStore {
	const { resolveDir, indent, trailingNewline } = config;

	const filePath = (name: string): string => path.join(resolveDir(), name);
	function readMutationContent(name: string): string | null {
		try {
			return fs.readFileSync(filePath(name), 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw error;
		}
	}

	/** Atomically persist a JSON value (temp file + rename) so a reader never sees a partial file. */
	function writeJsonAtomic(name: string, value: unknown, durable = false): void {
		const dir = resolveDir();
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		const target = path.join(dir, name);
		const tmp =
			target +
			'.' +
			process.pid +
			'.' +
			Date.now() +
			'.' +
			Math.random().toString(36).slice(2) +
			'.tmp';
		const body = JSON.stringify(value, null, indent);
		assertSerializedJsonIsSafe(body, target);
		try {
			fs.writeFileSync(tmp, trailingNewline ? body + '\n' : body, {
				encoding: 'utf-8',
				flag: 'wx',
			});
			if (durable) {
				const fd = fs.openSync(tmp, 'r+');
				try {
					fs.fsyncSync(fd);
				} finally {
					fs.closeSync(fd);
				}
			}
			fs.renameSync(tmp, target);
			// Windows has no directory fsync via Node; host caller proofs remain unavailable there.
			if (durable && !isWindows()) {
				const fd = fs.openSync(dir, 'r');
				try {
					fs.fsyncSync(fd);
				} finally {
					fs.closeSync(fd);
				}
			}
		} finally {
			fs.rmSync(tmp, { force: true });
		}
	}

	/** Read + JSON.parse a file; `fallback()` covers a missing file AND unparseable JSON. */
	function readFileOr<T>(name: string, fallback: () => T, parse: (parsed: unknown) => T): T {
		let content: string;
		try {
			content = fs.readFileSync(filePath(name), 'utf-8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback();
			throw error;
		}
		try {
			return parse(JSON.parse(content));
		} catch {
			return fallback();
		}
	}

	function readRulesResult(): RulesLoadResult {
		let content: string;
		try {
			content = fs.readFileSync(filePath(PIANOLA_RULES_FILENAME), 'utf-8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
				return { rules: [], malformed: false };
			}
			throw error;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(content);
		} catch {
			return { rules: [], malformed: true };
		}
		const raw = Array.isArray(parsed)
			? parsed
			: ((parsed as { rules?: unknown } | null)?.rules ?? []);
		return { rules: validatePianolaRules(raw), malformed: false };
	}

	function readDecisions(limit?: number): PianolaDecisionRecord[] {
		let content: string;
		try {
			content = fs.readFileSync(filePath(PIANOLA_DECISIONS_FILENAME), 'utf-8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
			throw error;
		}
		// Records sharing an id (intent + outcome) are folded, latest winning.
		const byId = new Map<string, PianolaDecisionRecord>();
		for (const line of content.split('\n')) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				continue;
			}
			const record = validatePianolaDecisionRecord(parsed);
			if (record) byId.set(record.id, record);
		}
		const records = [...byId.values()];
		if (limit !== undefined && limit >= 0 && records.length > limit) {
			return records.slice(records.length - limit);
		}
		return records;
	}

	function appendDecision(
		record: PianolaDecisionRecord,
		receipt?: (value: PianolaFileMutationReceipt) => void
	): void {
		// All lifecycle writers (CLI, native admission, receipts and resolutions)
		// compare their source row and append/compact under this same short lock.
		// Throwing on conflict also prevents a stale native claim from sending.
		withFileLock(
			PIANOLA_DECISIONS_FILENAME,
			'decisions',
			() => persistDecision(record, receipt),
			config.decisionLockMode === 'try'
		);
	}

	function appendDecisionAsync(record: PianolaDecisionRecord): Promise<void> {
		return withFileLockAsync(PIANOLA_DECISIONS_FILENAME, 'decisions', () =>
			persistDecision(record)
		);
	}

	function persistDecision(
		record: PianolaDecisionRecord,
		receipt?: (value: PianolaFileMutationReceipt) => void
	): void {
		const before = receipt ? readMutationContent(PIANOLA_DECISIONS_FILENAME) : null;
		const records = readDecisions();
		const current = records.find((candidate) => candidate.id === record.id);
		if (current?.lifecycle || record.lifecycle) {
			if (
				current?.mutationRevision !== record.mutationRevision ||
				(current && !record.lifecycle) ||
				(!current && record.mutationRevision) ||
				(current &&
					(current.agentId !== record.agentId ||
						current.tabId !== record.tabId ||
						current.classification.evidence.messageId !== record.classification.evidence.messageId))
			)
				throw new Error('Pianola decision mutation conflict; reread the current decision');
			if (current?.lifecycle?.status === 'done' && record.lifecycle?.status !== 'done')
				throw new Error('Pianola decision mutation conflict; decision already done');
			if (
				!record.dryRun &&
				record.lifecycle &&
				(!current ||
					record.deliveryStatus === 'admitted' ||
					record.lifecycle.delivery === 'intent') &&
				records.some(
					(candidate) =>
						candidate.id !== record.id &&
						!candidate.dryRun &&
						candidate.agentId === record.agentId &&
						candidate.tabId === record.tabId &&
						candidate.lifecycle?.guard.scopeId === record.lifecycle!.guard.scopeId &&
						candidate.lifecycle.guard.messageId === record.lifecycle!.guard.messageId &&
						candidate.lifecycle.delivery !== 'rejected' &&
						(candidate.lifecycle.delivery === 'intent' ||
							candidate.lifecycle.delivery === 'unknown' ||
							candidate.deliveryStatus === 'admitted' ||
							candidate.dispatched)
				)
			)
				throw new Error('Pianola decision already claimed this ask');
		}
		const next = record.lifecycle
			? {
					...record,
					mutationRevision: createHash('sha256').update(canonicalJson(record)).digest('hex'),
				}
			: record;
		const line = `${JSON.stringify(next)}\n`;
		if (
			record.lifecycle &&
			(!validatePianolaDecisionRecord(next) ||
				Buffer.byteLength(line, 'utf-8') > PIANOLA_DECISION_RECORD_MAX_BYTES)
		)
			throw new Error('Invalid or oversized Pianola decision lifecycle');
		const file = filePath(PIANOLA_DECISIONS_FILENAME);
		appendDecisionLine(file, line);
		compactDecisionLog(file, PIANOLA_DECISIONS_MAX_RECORDS, PIANOLA_DECISIONS_COMPACT_BYTES, true);
		// Let the caller continue from precisely the successfully persisted row.
		if (next.mutationRevision) record.mutationRevision = next.mutationRevision;
		receipt?.({ before, after: readMutationContent(PIANOLA_DECISIONS_FILENAME) });
	}

	function readPlans(): PianolaPlan[] {
		return readFileOr(
			PIANOLA_PLANS_FILENAME,
			() => [],
			(parsed) => validatePianolaPlansFile(parsed).plans
		);
	}

	function persistPlans(plans: PianolaPlan[]): PianolaPlan[] {
		const validated = validatePianolaPlansFile({ plans }).plans;
		writeJsonAtomic(PIANOLA_PLANS_FILENAME, { plans: validated });
		return validated;
	}

	function getPlan(planId: string): PianolaPlan | null {
		return readPlans().find((p) => p.id === planId) ?? null;
	}

	function upsertPlan(value: PianolaPlan): PianolaPlan[] {
		return updatePlans((current) =>
			current.some((p) => p.id === value.id)
				? current.map((p) => (p.id === value.id ? value : p))
				: [...current, value]
		);
	}
	function upsertPlanAsync(value: PianolaPlan): Promise<PianolaPlan[]> {
		return updatePlansAsync((current) =>
			current.some((p) => p.id === value.id)
				? current.map((p) => (p.id === value.id ? value : p))
				: [...current, value]
		);
	}
	function writePlans(values: PianolaPlan[]): PianolaPlan[] {
		return withFileLock(PIANOLA_PLANS_FILENAME, 'plans', () => persistPlans(values));
	}
	function updatePlans(update: (values: PianolaPlan[]) => PianolaPlan[]): PianolaPlan[] {
		return withFileLock(PIANOLA_PLANS_FILENAME, 'plans', () => persistPlans(update(readPlans())));
	}
	function writePlansAsync(values: PianolaPlan[]): Promise<PianolaPlan[]> {
		return withFileLockAsync(PIANOLA_PLANS_FILENAME, 'plans', () => persistPlans(values));
	}
	function updatePlansAsync(
		update: (values: PianolaPlan[]) => PianolaPlan[]
	): Promise<PianolaPlan[]> {
		return withFileLockAsync(PIANOLA_PLANS_FILENAME, 'plans', () =>
			persistPlans(update(readPlans()))
		);
	}

	function readPrograms(): PianolaProgram[] {
		return readFileOr(
			PIANOLA_PROGRAMS_FILENAME,
			() => [],
			(raw) => validatePianolaProgramsFile(raw).programs
		);
	}
	function persistPrograms(programs: PianolaProgram[]): PianolaProgram[] {
		const validated = validatePianolaProgramsFile({ programs }).programs;
		writeJsonAtomic(PIANOLA_PROGRAMS_FILENAME, { programs: validated });
		return validated;
	}
	function upsertProgram(value: PianolaProgram): PianolaProgram[] {
		return updatePrograms((current) =>
			current.some((p) => p.id === value.id)
				? current.map((p) => (p.id === value.id ? value : p))
				: [...current, value]
		);
	}
	function upsertProgramAsync(value: PianolaProgram): Promise<PianolaProgram[]> {
		return updateProgramsAsync((current) =>
			current.some((p) => p.id === value.id)
				? current.map((p) => (p.id === value.id ? value : p))
				: [...current, value]
		);
	}
	function writePrograms(values: PianolaProgram[]): PianolaProgram[] {
		return withFileLock(PIANOLA_PROGRAMS_FILENAME, 'programs', () => persistPrograms(values));
	}
	function updatePrograms(
		update: (values: PianolaProgram[]) => PianolaProgram[]
	): PianolaProgram[] {
		return withFileLock(PIANOLA_PROGRAMS_FILENAME, 'programs', () =>
			persistPrograms(update(readPrograms()))
		);
	}
	function writeProgramsAsync(values: PianolaProgram[]): Promise<PianolaProgram[]> {
		return withFileLockAsync(PIANOLA_PROGRAMS_FILENAME, 'programs', () => persistPrograms(values));
	}
	function updateProgramsAsync(
		update: (values: PianolaProgram[]) => PianolaProgram[]
	): Promise<PianolaProgram[]> {
		return withFileLockAsync(PIANOLA_PROGRAMS_FILENAME, 'programs', () =>
			persistPrograms(update(readPrograms()))
		);
	}
	function readAsks(): PianolaAsk[] {
		return readFileOr(
			PIANOLA_ASKS_FILENAME,
			() => [],
			(raw) => validatePianolaAsksFile(raw).asks
		);
	}
	/** Shared protocol: each yield requests a delay before the next exclusive-create attempt. */
	function* acquireFileLock(
		name: string,
		label: string,
		waitForTurn = false,
		immediate = false
	): Generator<void, (renew?: boolean) => void> {
		const lock = filePath(name) + '.lock';
		fs.mkdirSync(path.dirname(lock), { recursive: true });
		const token = process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2);
		let observedMtime: number | undefined;
		let deadline = Date.now() + (waitForTurn ? ASKS_LOCK_STALE_MS : ASKS_LOCK_TIMEOUT_MS);
		while (true) {
			if (!waitForTurn && Date.now() >= deadline)
				throw new Error(`Timed out waiting for Pianola ${label} lock`);
			try {
				fs.writeFileSync(lock, token, { flag: 'wx' });
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			}
			if (immediate) {
				yield;
				return () => {};
			}
			try {
				const mtime = fs.statSync(lock).mtimeMs;
				if (waitForTurn) {
					if (mtime !== observedMtime) {
						observedMtime = mtime;
						deadline = Date.now() + ASKS_LOCK_STALE_MS;
					}
					if (Date.now() >= deadline)
						throw new Error(`Timed out waiting for Pianola ${label} lock`);
				}
				if (Date.now() - mtime > ASKS_LOCK_STALE_MS) {
					const observedToken = fs.readFileSync(lock, 'utf8');
					const ownerAlive = (value: string): boolean => {
						const owner = Number(value.split('.')[0]);
						if (!Number.isInteger(owner) || owner <= 0) return false;
						try {
							process.kill(owner, 0);
							return true;
						} catch (error) {
							return (error as NodeJS.ErrnoException).code !== 'ESRCH';
						}
					};
					const alive = ownerAlive(observedToken);
					if (!alive) {
						const stale = lock + '.' + token + '.stale';
						fs.renameSync(lock, stale);
						const movedToken = fs.readFileSync(stale, 'utf8');
						if (movedToken !== observedToken || ownerAlive(movedToken)) {
							try {
								fs.linkSync(stale, lock);
							} catch (error) {
								if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
							} finally {
								fs.rmSync(stale, { force: true });
							}
							yield;
							continue;
						}
						fs.rmSync(stale, { force: true });
						continue;
					}
				}
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
				throw error;
			}
			yield;
		}
		return (renew = false) => {
			if (fs.readFileSync(lock, 'utf8') !== token) {
				if (renew) throw new Error(`Lost Pianola ${label} lock ownership`);
				return;
			}
			if (renew) {
				const now = new Date();
				fs.utimesSync(lock, now, now);
			} else fs.rmSync(lock, { force: true });
		};
	}
	function withFileLock<T>(name: string, label: string, operation: () => T, immediate = false): T {
		const acquisition = acquireFileLock(name, label, false, immediate);
		let attempt = acquisition.next();
		while (!attempt.done) {
			if (immediate) {
				acquisition.return(() => {});
				throw new Error(`Pianola ${label} lock busy; no mutation admitted, reread before retrying`);
			}
			Atomics.wait(lockWait, 0, 0, 10);
			attempt = acquisition.next();
		}
		try {
			return operation();
		} finally {
			attempt.value();
		}
	}
	async function withFileLockAsync<T>(
		name: string,
		label: string,
		operation: () => T | Promise<T>,
		waitForTurn = false,
		renewWhileHeld = false
	): Promise<T> {
		const acquisition = acquireFileLock(name, label, waitForTurn);
		let attempt = acquisition.next();
		while (!attempt.done) {
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
			attempt = acquisition.next();
		}
		const ownership = attempt.value;
		let renewalError: { error: unknown } | undefined;
		const heartbeat = renewWhileHeld
			? setInterval(() => {
					if (renewalError) return;
					try {
						ownership(true);
					} catch (error) {
						renewalError = { error };
					}
				}, ASKS_LOCK_STALE_MS / 3)
			: undefined;
		heartbeat?.unref();
		try {
			const pending = operation();
			// Synchronous mutations (including decision CAS + append + compaction)
			// release ownership in this turn, without holding it over an await.
			const result = pending instanceof Promise ? await pending : pending;
			if (renewalError) throw renewalError.error;
			return result;
		} finally {
			if (heartbeat) clearInterval(heartbeat);
			ownership();
		}
	}
	function withProgramLoopLock<T>(programId: string, operation: () => Promise<T>): Promise<T> {
		const key = createHash('sha256').update(programId).digest('hex');
		return withFileLockAsync(`pianola-program-loop-${key}`, 'program loop', operation);
	}
	function withPlanLock<T>(
		planId: string,
		operation: () => Promise<T>,
		options?: { waitForTurn?: boolean }
	): Promise<T> {
		const key = createHash('sha256').update(planId).digest('hex');
		return withFileLockAsync(
			`pianola-plan-${key}`,
			'plan orchestration',
			operation,
			options?.waitForTurn,
			true
		);
	}
	function persistAsks(asks: PianolaAsk[]): PianolaAsk[] {
		const validated = validatePianolaAsksFile({ asks }).asks;
		writeJsonAtomic(PIANOLA_ASKS_FILENAME, { asks: validated });
		return validated;
	}
	function writeAsks(asks: PianolaAsk[]): PianolaAsk[] {
		return withFileLock(PIANOLA_ASKS_FILENAME, 'asks', () => persistAsks(asks));
	}
	function updateAsks(update: (asks: PianolaAsk[]) => PianolaAsk[]): PianolaAsk[] {
		return withFileLock(PIANOLA_ASKS_FILENAME, 'asks', () => persistAsks(update(readAsks())));
	}
	function writeAsksAsync(asks: PianolaAsk[]): Promise<PianolaAsk[]> {
		return withFileLockAsync(PIANOLA_ASKS_FILENAME, 'asks', () => persistAsks(asks));
	}
	function updateAsksAsync(update: (asks: PianolaAsk[]) => PianolaAsk[]): Promise<PianolaAsk[]> {
		return withFileLockAsync(PIANOLA_ASKS_FILENAME, 'asks', () => persistAsks(update(readAsks())));
	}
	function readSuggestions(): PianolaSuggestionsFile {
		let content: string;
		try {
			content = fs.readFileSync(filePath(PIANOLA_SUGGESTIONS_FILENAME), 'utf-8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT')
				return validatePianolaSuggestionsFile(undefined);
			throw error;
		}
		// Corruption must not erase persistent rejection/approval evidence.
		const raw: unknown = JSON.parse(content);
		if (!raw || typeof raw !== 'object' || Array.isArray(raw))
			throw new Error('InvalidSuggestionFile');
		return validatePianolaSuggestionsFile(raw);
	}

	function writeSuggestions(file: PianolaSuggestionsFile): PianolaSuggestionsFile {
		let validated = validatePianolaSuggestionsFile(file);
		const current = readSuggestions();
		// Re-read at the atomic write boundary: asynchronous mining must never
		// overwrite a review that was committed while it was in flight.
		if (current.rejections || validated.rejections) {
			const rejections = new Map<
				string,
				NonNullable<PianolaSuggestionsFile['rejections']>[number]
			>();
			for (const item of [...(current.rejections ?? []), ...(validated.rejections ?? [])]) {
				const key = canonicalJson([item.candidateId, item.evidenceFingerprint]);
				const previous = rejections.get(key);
				if (
					previous &&
					(previous.principal !== item.principal || previous.actorId !== item.actorId)
				)
					throw new Error('ConflictingSuggestionReview');
				rejections.set(key, item);
			}
			validated.rejections = [...rejections.values()];
		}
		if (current.approvals || validated.approvals) {
			const approvals = new Map<string, NonNullable<PianolaSuggestionsFile['approvals']>[number]>();
			for (const item of [...(current.approvals ?? []), ...(validated.approvals ?? [])]) {
				const key = canonicalJson([
					item.candidate.id,
					item.candidate.evidenceFingerprint,
					item.approvedAt,
				]);
				const previous = approvals.get(key);
				if (
					previous &&
					(previous.principal !== item.principal || previous.actorId !== item.actorId)
				)
					throw new Error('ConflictingSuggestionReview');
				approvals.set(key, item);
			}
			validated.approvals = [...approvals.values()];
		}
		// Conflicts are durable review requests. Empty/legacy/stale writers cannot
		// erase one or its source examples, including after log compaction.
		if (current.conflicts || validated.conflicts) {
			const conflicts = new Map<string, NonNullable<PianolaSuggestionsFile['conflicts']>[number]>();
			for (const item of [...(current.conflicts ?? []), ...(validated.conflicts ?? [])]) {
				const key = canonicalJson([item.ruleId, item.evidenceFingerprint, item.approvedAt]);
				const previous = conflicts.get(key);
				const evidence = new Map(
					[...(previous?.evidence ?? []), ...item.evidence].map((source) => [
						canonicalJson(source),
						source,
					])
				);
				conflicts.set(key, {
					...item,
					detectedAt: Math.min(previous?.detectedAt ?? item.detectedAt, item.detectedAt),
					reason: previous?.reason === 'source_corrected' ? previous.reason : item.reason,
					evidence: [...evidence.values()],
				});
			}
			validated.conflicts = [...conflicts.values()];
		}
		if (validated.candidates) {
			validated.candidates = validated.candidates.filter(
				(candidate) =>
					!validated.rejections?.some(
						(item) =>
							item.candidateId === candidate.id &&
							item.evidenceFingerprint === candidate.evidenceFingerprint
					)
			);
			validated.proposals = validated.candidates.map((candidate) => candidate.rule);
		} else {
			// Legacy writers cannot resurrect a rejected source-linked candidate.
			validated.proposals = validated.proposals.filter(
				(proposal) => !validated.rejections?.some((item) => item.candidateId === proposal.id)
			);
		}
		// Re-read native evidence at the final write boundary. A correction or
		// approval committed during asynchronous mining must win over old staging.
		validated = reconcileSuggestionEvidence(
			validated,
			settledDecisionPairs(readDecisions(), { snapshots: true }),
			readRulesResult().rules,
			Date.now()
		);
		if (canonicalJson(validated) !== canonicalJson(current))
			writeJsonAtomic(PIANOLA_SUGGESTIONS_FILENAME, validated);
		return validated;
	}

	function readProfiles(): PianolaProfiles {
		return readFileOr(
			PIANOLA_PROFILES_FILENAME,
			() => ({ projects: {} }),
			(parsed) => validatePianolaProfiles(parsed)
		);
	}

	function writeProfiles(profiles: PianolaProfiles): PianolaProfiles {
		const validated = validatePianolaProfiles(profiles);
		writeJsonAtomic(PIANOLA_PROFILES_FILENAME, validated);
		return validated;
	}

	function getProfile(projectPath?: string): {
		source: PianolaProfileSource;
		entry: PianolaProfileEntry | null;
	} {
		return resolveProfile(readProfiles(), projectPath);
	}

	function setProfile(entry: PianolaProfileEntry, projectPath?: string): PianolaProfiles {
		const current = readProfiles();
		const next: PianolaProfiles = { global: current.global, projects: { ...current.projects } };
		if (projectPath) next.projects[projectPath] = entry;
		else next.global = entry;
		return writeProfiles(next);
	}

	function supervisorFilePath(): string {
		return filePath(PIANOLA_SUPERVISOR_FILENAME);
	}

	function readSupervisorTargets(): PianolaSupervisedTarget[] {
		return readFileOr(
			PIANOLA_SUPERVISOR_FILENAME,
			() => [],
			(parsed) => validatePianolaSupervisorFile(parsed).targets
		);
	}

	let supervisorRevision: string | undefined;
	let supervisorIndex = new Map<string, PianolaSupervisedTarget>();
	function readSupervisorTarget(id: string): PianolaSupervisedTarget | undefined {
		const file = supervisorFilePath();
		// A pending canonical writer is indeterminate, even before its rename.
		// No watcher delivery or timer participates in this authority check.
		const revision = (): string | undefined => {
			if (fs.existsSync(file + '.lock')) return undefined;
			const stat = fs.statSync(file, { bigint: true });
			return [file, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
		};
		try {
			const before = revision();
			if (!before) {
				supervisorRevision = undefined;
				supervisorIndex.clear();
				return undefined;
			}
			if (before !== supervisorRevision) {
				const targets = readSupervisorTargets();
				if (revision() !== before) {
					supervisorRevision = undefined;
					supervisorIndex.clear();
					return undefined;
				}
				supervisorIndex = new Map(targets.map((target) => [target.id, target]));
				supervisorRevision = before;
			}
			const target = supervisorIndex.get(id);
			return target ? structuredClone(target) : undefined;
		} catch (error) {
			supervisorRevision = undefined;
			supervisorIndex.clear();
			if (
				['ENOENT', 'EACCES', 'EPERM', 'EIO', 'ENOTDIR'].includes(
					(error as NodeJS.ErrnoException).code ?? ''
				)
			)
				return undefined;
			throw error;
		}
	}

	function persistSupervisorTargets(targets: PianolaSupervisedTarget[]): PianolaSupervisedTarget[] {
		// A stale writer cannot resurrect an owner after an atomic handover.
		const fences = new Map(
			readSupervisorTargets()
				.filter((target) => target.migratedToScopeId)
				.map((target) => [target.id, target])
		);
		const ids = new Set(targets.map((target) => target.id));
		const merged = targets.map((target) => {
			const fence = fences.get(target.id);
			return fence ? { ...fence, enabled: false } : target;
		});
		for (const fence of fences.values()) if (!ids.has(fence.id)) merged.push(fence);
		const validated = validatePianolaSupervisorFile({ targets: merged }).targets;
		writeJsonAtomic(PIANOLA_SUPERVISOR_FILENAME, { targets: validated });
		return validated;
	}
	function updateSupervisorTargets(
		update: (targets: PianolaSupervisedTarget[]) => PianolaSupervisedTarget[]
	): PianolaSupervisedTarget[] {
		return withFileLock(PIANOLA_SUPERVISOR_FILENAME, 'supervisor targets', () => {
			const current = readSupervisorTargets();
			const next = update(current);
			return next === current ? current : persistSupervisorTargets(next);
		});
	}
	function updateSupervisorTargetsAsync(
		update: (targets: PianolaSupervisedTarget[]) => PianolaSupervisedTarget[]
	): Promise<PianolaSupervisedTarget[]> {
		return withFileLockAsync(PIANOLA_SUPERVISOR_FILENAME, 'supervisor targets', () => {
			const current = readSupervisorTargets();
			const next = update(current);
			return next === current ? current : persistSupervisorTargets(next);
		});
	}
	function writeSupervisorTargetsAsync(
		targets: PianolaSupervisedTarget[]
	): Promise<PianolaSupervisedTarget[]> {
		return updateSupervisorTargetsAsync(() => targets);
	}
	function upsertSupervisorTargetAsync(
		target: PianolaSupervisedTarget
	): Promise<PianolaSupervisedTarget[]> {
		return updateSupervisorTargetsAsync((current) => {
			const index = current.findIndex((t) => t.id === target.id);
			return index >= 0 ? current.map((t, i) => (i === index ? target : t)) : [...current, target];
		});
	}
	function removeSupervisorTargetAsync(id: string): Promise<PianolaSupervisedTarget[]> {
		return updateSupervisorTargetsAsync((current) => current.filter((target) => target.id !== id));
	}
	function writeSupervisorTargets(targets: PianolaSupervisedTarget[]): PianolaSupervisedTarget[] {
		return updateSupervisorTargets(() => targets);
	}

	function upsertSupervisorTarget(target: PianolaSupervisedTarget): PianolaSupervisedTarget[] {
		return updateSupervisorTargets((current) => {
			const index = current.findIndex((t) => t.id === target.id);
			return index >= 0 ? current.map((t, i) => (i === index ? target : t)) : [...current, target];
		});
	}

	function removeSupervisorTarget(id: string): PianolaSupervisedTarget[] {
		return updateSupervisorTargets((current) => current.filter((target) => target.id !== id));
	}

	function admissionName(dispatchId: string): string {
		if (!isPianolaScopeId(dispatchId)) throw new Error('Invalid Pianola dispatch ID');
		return `maestro-pianola-dispatch-${dispatchId}.json`;
	}
	function readDispatchAdmission(dispatchId: string): PianolaDispatchAdmission | null {
		let body: string;
		try {
			const file = filePath(admissionName(dispatchId));
			if (fs.statSync(file).size > 16384) throw new Error('Pianola admission too large');
			body = fs.readFileSync(file, 'utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw error;
		}
		const value = validatePianolaDispatchAdmission(JSON.parse(body));
		if (!value || value.dispatchId !== dispatchId) throw new Error('Invalid Pianola admission');
		return value;
	}
	function writeDispatchAdmission(admission: PianolaDispatchAdmission): void {
		if (!validatePianolaDispatchAdmission(admission)) throw new Error('Invalid Pianola admission');
		if (Buffer.byteLength(JSON.stringify(admission, null, indent), 'utf8') + 1 > 16384)
			throw new Error('Pianola admission too large');
		writeJsonAtomic(admissionName(admission.dispatchId), admission, true);
	}

	function checkpointName(scopeId: string): string {
		if (!isPianolaScopeId(scopeId)) throw new Error('Invalid Pianola scope ID');
		return `maestro-pianola-scope-${scopeId}.json`;
	}

	function readScopeCheckpoint(scopeId: string): PianolaScopeCheckpoint | null {
		const file = filePath(checkpointName(scopeId));
		let content: string;
		try {
			if (fs.statSync(file).size > 20 * 1024 * 1024)
				throw new Error('Pianola checkpoint too large');
			content = fs.readFileSync(file, 'utf-8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
			throw error;
		}
		let raw: unknown;
		try {
			raw = JSON.parse(content);
		} catch {
			throw new Error('Invalid Pianola scope checkpoint JSON');
		}
		const checkpoint = validatePianolaScopeCheckpoint(raw, scopeId);
		if (!checkpoint) throw new Error('Invalid Pianola scope checkpoint');
		return checkpoint;
	}

	function writeScopeCheckpoint(
		checkpoint: PianolaScopeCheckpoint,
		durable = false,
		receipt?: (value: PianolaFileMutationReceipt) => void
	): void {
		const name = checkpointName(checkpoint.scopeId);
		if (!validatePianolaScopeCheckpoint(checkpoint, checkpoint.scopeId)) {
			throw new Error('Invalid Pianola scope checkpoint');
		}
		withFileLock(name, 'scope checkpoint', () => {
			const before = receipt ? readMutationContent(name) : null;
			const current = readScopeCheckpoint(checkpoint.scopeId);
			if ((current?.enrollmentRevision ?? 0) > (checkpoint.enrollmentRevision ?? 0))
				throw new Error('Scope enrollment changed; discard the old cycle and reload');
			// A CLI cycle may have captured its census before host admission. Preserve
			// only newly enrolled tabs it never saw, under the same configuration.
			if (current?.configurationFingerprint === checkpoint.configurationFingerprint) {
				const members = new Set(
					checkpoint.tabs.map((tab) => canonicalJson([tab.agentId, tab.tabId]))
				);
				for (const tab of current.tabs) {
					if (tab.dispatchEnrollmentId && !members.has(canonicalJson([tab.agentId, tab.tabId])))
						checkpoint.tabs.push(tab);
				}
			}
			if (!validatePianolaScopeCheckpoint(checkpoint, checkpoint.scopeId))
				throw new Error('Invalid Pianola scope checkpoint');
			if (
				Buffer.byteLength(JSON.stringify(checkpoint, null, indent), 'utf8') + 1 >
				20 * 1024 * 1024
			)
				throw new Error('Pianola checkpoint too large');
			// Observation clocks and the sweep position alone do not justify rewriting
			// the whole fleet. Refresh their durable projection at most every 20s.
			const observationState = (value: PianolaScopeCheckpoint): unknown => ({
				...value,
				lastSnapshotAt: undefined,
				nextTabIndex: undefined,
				tabs: value.tabs.map((tab) => ({
					...tab,
					// The cycle may set these optional fields to undefined. JSON
					// omits object members with that value on the next disk read.
					nextWatchAt: tab.nextWatchAt,
					emptyEnrollment: tab.emptyEnrollment,
					coverage: tab.coverage ? { ...tab.coverage, observedAt: undefined } : undefined,
				})),
			});
			if (current && isDeepStrictEqual(current, checkpoint)) {
				receipt?.({ before, after: before });
				return;
			}
			if (
				!durable &&
				current &&
				(checkpoint.lastSnapshotAt ?? 0) >= (current.lastSnapshotAt ?? 0) &&
				(checkpoint.lastSnapshotAt ?? 0) - (current.lastSnapshotAt ?? 0) < 20_000 &&
				isDeepStrictEqual(observationState(current), observationState(checkpoint))
			) {
				receipt?.({ before, after: before });
				return;
			}
			// All changed authority/cursor/enrollment states survive a crash, even
			// when the caller is flushing a batch of passive observations.
			writeJsonAtomic(name, checkpoint, true);
			receipt?.({ before, after: readMutationContent(name) });
		});
	}

	function readProgramLoopMemo(): ProgramLoopMemo {
		return readFileOr(
			PIANOLA_PROGRAM_LOOP_FILENAME,
			() => validateProgramLoopMemo(undefined),
			validateProgramLoopMemo
		);
	}
	function writeProgramLoopMemo(memo: ProgramLoopMemo): void {
		withFileLock(PIANOLA_PROGRAM_LOOP_FILENAME, 'program loop memo', () =>
			writeJsonAtomic(PIANOLA_PROGRAM_LOOP_FILENAME, validateProgramLoopMemo(memo))
		);
	}
	function updateProgramLoopMemo(programId: string, entry: ProgramLoopMemoEntry): void {
		withFileLock(PIANOLA_PROGRAM_LOOP_FILENAME, 'program loop memo', () =>
			writeJsonAtomic(
				PIANOLA_PROGRAM_LOOP_FILENAME,
				validateProgramLoopMemo({
					...readProgramLoopMemo(),
					[programId]: entry,
				})
			)
		);
	}
	function writeProgramLoopMemoAsync(memo: ProgramLoopMemo): Promise<void> {
		return withFileLockAsync(PIANOLA_PROGRAM_LOOP_FILENAME, 'program loop memo', () =>
			writeJsonAtomic(PIANOLA_PROGRAM_LOOP_FILENAME, validateProgramLoopMemo(memo))
		);
	}
	function updateProgramLoopMemoAsync(
		programId: string,
		entry: ProgramLoopMemoEntry
	): Promise<void> {
		return withFileLockAsync(PIANOLA_PROGRAM_LOOP_FILENAME, 'program loop memo', () =>
			writeJsonAtomic(
				PIANOLA_PROGRAM_LOOP_FILENAME,
				validateProgramLoopMemo({
					...readProgramLoopMemo(),
					[programId]: entry,
				})
			)
		);
	}
	return {
		readRulesResult,
		readRules: () => readRulesResult().rules,
		writeRules(rules: unknown): PianolaRule[] {
			const validated = validatePianolaRules(rules);
			writeJsonAtomic(PIANOLA_RULES_FILENAME, validated);
			return validated;
		},
		appendDecision,
		appendDecisionAsync,
		readDecisions,
		readPlans,
		writePlans,
		getPlan,
		upsertPlan,
		updatePlans,
		writePlansAsync,
		updatePlansAsync,
		upsertPlanAsync,
		readPrograms,
		writePrograms,
		upsertProgram,
		updatePrograms,
		writeProgramsAsync,
		updateProgramsAsync,
		upsertProgramAsync,
		withProgramLoopLock,
		withPlanLock,
		readAsks,
		writeAsks,
		updateAsks,
		writeAsksAsync,
		updateAsksAsync,
		readSuggestions,
		readProgramLoopMemo,
		writeProgramLoopMemo,
		updateProgramLoopMemo,
		writeProgramLoopMemoAsync,
		updateProgramLoopMemoAsync,
		writeSuggestions,
		readProfiles,
		writeProfiles,
		getProfile,
		setProfile,
		readSupervisorTargets,
		readSupervisorTarget,
		writeSupervisorTargets,
		updateSupervisorTargets,
		upsertSupervisorTarget,
		removeSupervisorTarget,
		readDispatchAdmission,
		writeDispatchAdmission,
		readScopeCheckpoint,
		writeScopeCheckpoint,
		writeSupervisorTargetsAsync,
		updateSupervisorTargetsAsync,
		upsertSupervisorTargetAsync,
		removeSupervisorTargetAsync,
		supervisorFilePath,
	};
}
