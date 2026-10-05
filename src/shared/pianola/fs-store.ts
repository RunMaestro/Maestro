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
import type { PianolaProgram, PianolaAsk } from './pianola-programs';
import {
	validateProgramLoopMemo,
	type ProgramLoopMemo,
	type ProgramLoopMemoEntry,
} from './pianola-program-loop';

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
}

/** The store surface shared by the desktop and CLI Pianola stores. */
export interface PianolaFsStore {
	readRulesResult(): RulesLoadResult;
	readRules(): PianolaRule[];
	writeRules(rules: unknown): PianolaRule[];
	appendDecision(record: PianolaDecisionRecord): void;
	readDecisions(limit?: number): PianolaDecisionRecord[];
	readPlans(): PianolaPlan[];
	writePlans(plans: PianolaPlan[]): PianolaPlan[];
	getPlan(planId: string): PianolaPlan | null;
	upsertPlan(plan: PianolaPlan): PianolaPlan[];
	readPrograms(): PianolaProgram[];
	writePrograms(programs: PianolaProgram[]): PianolaProgram[];
	upsertProgram(program: PianolaProgram): PianolaProgram[];
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
	writeSupervisorTargets(targets: PianolaSupervisedTarget[]): PianolaSupervisedTarget[];
	updateSupervisorTargets(
		update: (targets: PianolaSupervisedTarget[]) => PianolaSupervisedTarget[]
	): PianolaSupervisedTarget[];
	upsertSupervisorTarget(target: PianolaSupervisedTarget): PianolaSupervisedTarget[];
	removeSupervisorTarget(id: string): PianolaSupervisedTarget[];
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

	/** Atomically persist a JSON value (temp file + rename) so a reader never sees a partial file. */
	function writeJsonAtomic(name: string, value: unknown): void {
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
			fs.renameSync(tmp, target);
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

	function appendDecision(record: PianolaDecisionRecord): void {
		const dir = resolveDir();
		if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
		const file = path.join(dir, PIANOLA_DECISIONS_FILENAME);
		appendDecisionLine(file, `${JSON.stringify(record)}\n`);
		compactDecisionLog(file, PIANOLA_DECISIONS_MAX_RECORDS, PIANOLA_DECISIONS_COMPACT_BYTES);
	}

	function readPlans(): PianolaPlan[] {
		return readFileOr(
			PIANOLA_PLANS_FILENAME,
			() => [],
			(parsed) => validatePianolaPlansFile(parsed).plans
		);
	}

	function writePlans(plans: PianolaPlan[]): PianolaPlan[] {
		const validated = validatePianolaPlansFile({ plans }).plans;
		writeJsonAtomic(PIANOLA_PLANS_FILENAME, { plans: validated });
		return validated;
	}

	function getPlan(planId: string): PianolaPlan | null {
		return readPlans().find((p) => p.id === planId) ?? null;
	}

	function upsertPlan(plan: PianolaPlan): PianolaPlan[] {
		const current = readPlans();
		const index = current.findIndex((p) => p.id === plan.id);
		const next = index >= 0 ? current.map((p, i) => (i === index ? plan : p)) : [...current, plan];
		return writePlans(next);
	}

	function readPrograms(): PianolaProgram[] {
		return readFileOr(
			PIANOLA_PROGRAMS_FILENAME,
			() => [],
			(raw) => validatePianolaProgramsFile(raw).programs
		);
	}
	function writePrograms(programs: PianolaProgram[]): PianolaProgram[] {
		const validated = validatePianolaProgramsFile({ programs }).programs;
		writeJsonAtomic(PIANOLA_PROGRAMS_FILENAME, { programs: validated });
		return validated;
	}
	function upsertProgram(program: PianolaProgram): PianolaProgram[] {
		const current = readPrograms();
		const index = current.findIndex((p) => p.id === program.id);
		return writePrograms(
			index < 0 ? [...current, program] : current.map((p, i) => (i === index ? program : p))
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
	function* acquireFileLock(name: string, label: string): Generator<void, () => void> {
		const lock = filePath(name) + '.lock';
		fs.mkdirSync(path.dirname(lock), { recursive: true });
		const token = process.pid + '.' + Date.now() + '.' + Math.random().toString(36).slice(2);
		const deadline = Date.now() + ASKS_LOCK_TIMEOUT_MS;
		while (true) {
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for Pianola ${label} lock`);
			try {
				fs.writeFileSync(lock, token, { flag: 'wx' });
				break;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
			}
			try {
				if (Date.now() - fs.statSync(lock).mtimeMs > ASKS_LOCK_STALE_MS) {
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
		return () => {
			if (fs.readFileSync(lock, 'utf8') === token) fs.rmSync(lock, { force: true });
		};
	}
	function withFileLock<T>(name: string, label: string, operation: () => T): T {
		const acquisition = acquireFileLock(name, label);
		let attempt = acquisition.next();
		while (!attempt.done) {
			Atomics.wait(lockWait, 0, 0, 10);
			attempt = acquisition.next();
		}
		try {
			return operation();
		} finally {
			attempt.value();
		}
	}
	async function withFileLockAsync<T>(name: string, label: string, operation: () => T): Promise<T> {
		const acquisition = acquireFileLock(name, label);
		let attempt = acquisition.next();
		while (!attempt.done) {
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
			attempt = acquisition.next();
		}
		try {
			return operation();
		} finally {
			attempt.value();
		}
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
		return readFileOr(
			PIANOLA_SUGGESTIONS_FILENAME,
			() => validatePianolaSuggestionsFile(undefined),
			(parsed) => validatePianolaSuggestionsFile(parsed)
		);
	}

	function writeSuggestions(file: PianolaSuggestionsFile): PianolaSuggestionsFile {
		const validated = validatePianolaSuggestionsFile(file);
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

	function persistSupervisorTargets(targets: PianolaSupervisedTarget[]): PianolaSupervisedTarget[] {
		const validated = validatePianolaSupervisorFile({ targets }).targets;
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
		readDecisions,
		readPlans,
		writePlans,
		getPlan,
		upsertPlan,
		readPrograms,
		writePrograms,
		upsertProgram,
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
		writeSupervisorTargets,
		updateSupervisorTargets,
		upsertSupervisorTarget,
		removeSupervisorTarget,
		writeSupervisorTargetsAsync,
		updateSupervisorTargetsAsync,
		upsertSupervisorTargetAsync,
		removeSupervisorTargetAsync,
		supervisorFilePath,
	};
}
