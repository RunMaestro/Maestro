/**
 * Pianola supervise CLI commands.
 *
 * These register, list, and remove supervised background targets in the SHARED
 * supervisor store (the same maestro-pianola-supervisor.json the desktop reads).
 * They do not spawn anything themselves: the desktop supervisor watches that file
 * and reconciles within ~1s, spawning/killing the actual watch/orchestrate child
 * processes with restart + health. That is the whole point of "supervised" - the
 * process survives crashes and app restarts, unlike a raw `nohup ... &`.
 *
 * Every command hard-gates on the `pianola` Encore flag so a headless CLI cannot
 * register autonomous behavior on an install that has not opted in.
 */

import {
	readPianolaSupervisorTargets,
	upsertPianolaSupervisorTarget,
	removePianolaSupervisorTarget,
	type PianolaSupervisedTarget,
} from '../services/pianola-store';
import { generateUUID } from '../../shared/uuid';
import { ensurePianolaEnabled } from './pianola-gate';

const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_CONCURRENCY = 3;

export interface PianolaSuperviseWatchOptions {
	agent?: string;
	interval?: string;
	json?: boolean;
}

export interface PianolaSuperviseOrchestrateOptions {
	concurrency?: string;
	interval?: string;
	json?: boolean;
}

export interface PianolaSuperviseCommonOptions {
	json?: boolean;
}

/** Print an error (JSON-aware) and exit non-zero. */
function fail(message: string, json?: boolean): never {
	if (json) {
		console.log(JSON.stringify({ success: false, error: message }));
	} else {
		console.error(message);
	}
	process.exit(1);
}

/** Parse a positive-integer seconds/count flag; returns undefined when absent or invalid. */
function parsePositiveInt(raw: string | undefined, min: number): number | undefined {
	if (raw === undefined) return undefined;
	const match = raw.trim().match(/^(\d+)s?$/i);
	if (!match) return undefined;
	return Math.max(min, parseInt(match[1], 10));
}

/** Register (or refresh) a supervised tab watcher. */
export function pianolaSuperviseWatch(tabId: string, options: PianolaSuperviseWatchOptions): void {
	ensurePianolaEnabled(options.json);
	if (!options.agent || options.agent.trim().length === 0) {
		fail('supervise watch requires --agent <agent-id>', options.json);
	}

	// Reuse an existing watcher for the same (kind, tabId, agentId) so registering
	// the same tab twice replaces it in place instead of spawning a second watcher
	// that would double-answer the same prompt.
	const existing = readPianolaSupervisorTargets().find(
		(t) => t.kind === 'watch' && t.tabId === tabId && t.agentId === options.agent
	);
	const target: PianolaSupervisedTarget = {
		id: existing?.id ?? generateUUID(),
		kind: 'watch',
		enabled: true,
		createdAt: existing?.createdAt ?? Date.now(),
		tabId,
		agentId: options.agent,
	};
	const interval = parsePositiveInt(options.interval, 1);
	if (interval !== undefined) target.intervalSeconds = interval;

	const written = upsertPianolaSupervisorTarget(target);
	if (!written.some((t) => t.id === target.id)) {
		fail('Target failed validation and was not saved', options.json);
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, target, targetCount: written.length }));
	} else {
		console.log(
			`Supervising watch on tab ${tabId} (agent ${options.agent}). Target id: ${target.id}`
		);
	}
}

/** Register (or refresh) a supervised plan orchestration. */
export function pianolaSuperviseOrchestrate(
	planId: string,
	options: PianolaSuperviseOrchestrateOptions
): void {
	ensurePianolaEnabled(options.json);

	const target: PianolaSupervisedTarget = {
		id: generateUUID(),
		kind: 'orchestrate',
		enabled: true,
		createdAt: Date.now(),
		planId,
	};
	const interval = parsePositiveInt(options.interval, 1);
	if (interval !== undefined) target.intervalSeconds = interval;
	const concurrency = parsePositiveInt(options.concurrency, 1);
	if (concurrency !== undefined) target.concurrency = concurrency;

	const written = upsertPianolaSupervisorTarget(target);
	if (!written.some((t) => t.id === target.id)) {
		fail('Target failed validation and was not saved', options.json);
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, target, targetCount: written.length }));
	} else {
		console.log(`Supervising orchestration of plan ${planId}. Target id: ${target.id}`);
	}
}

/** Describe one target's spawn args in a human-readable form. */
function describeTarget(target: PianolaSupervisedTarget): string {
	if (target.kind === 'watch') {
		return `watch tab ${target.tabId} (agent ${target.agentId}, interval ${
			target.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS
		}s)`;
	}
	return `orchestrate plan ${target.planId} (concurrency ${
		target.concurrency ?? DEFAULT_CONCURRENCY
	}, interval ${target.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS}s)`;
}

/** List the registered supervised targets (read-only; live health lives in the app). */
export function pianolaSuperviseList(options: PianolaSuperviseCommonOptions): void {
	ensurePianolaEnabled(options.json);
	const targets = readPianolaSupervisorTargets();
	if (options.json) {
		console.log(JSON.stringify({ targets }));
		return;
	}
	if (targets.length === 0) {
		console.log('No supervised targets registered.');
		return;
	}
	console.log('Supervised targets:');
	for (const target of targets) {
		console.log(`  ${target.enabled ? 'on ' : 'off'} ${target.id} ${describeTarget(target)}`);
	}
}

/** Unregister a supervised target by id. */
export function pianolaSuperviseRemove(id: string, options: PianolaSuperviseCommonOptions): void {
	ensurePianolaEnabled(options.json);
	const before = readPianolaSupervisorTargets();
	if (!before.some((t) => t.id === id)) {
		fail(`No supervised target with id ${id}`, options.json);
	}
	const after = removePianolaSupervisorTarget(id);
	if (options.json) {
		console.log(JSON.stringify({ success: true, removed: id, targetCount: after.length }));
	} else {
		console.log(`Removed supervised target ${id}. Remaining: ${after.length}`);
	}
}

/** Enable or disable a supervised target by id. */
export function pianolaSuperviseSetEnabled(
	id: string,
	enabled: boolean,
	options: PianolaSuperviseCommonOptions
): void {
	ensurePianolaEnabled(options.json);
	const current = readPianolaSupervisorTargets().find((t) => t.id === id);
	if (!current) {
		fail(`No supervised target with id ${id}`, options.json);
	}
	// Immutable: build a new target rather than mutating the read result.
	const written = upsertPianolaSupervisorTarget({ ...current, enabled });
	const verb = enabled ? 'Enabled' : 'Disabled';
	if (options.json) {
		console.log(JSON.stringify({ success: true, id, enabled, targetCount: written.length }));
	} else {
		console.log(`${verb} supervised target ${id}.`);
	}
}
