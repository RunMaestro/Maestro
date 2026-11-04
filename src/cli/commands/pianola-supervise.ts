/**
 * Pianola supervise CLI commands.
 *
 * Scope selections use the owner-authorized host service over the bridge.
 * Other commands register, list, and remove background targets in the SHARED
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
	updatePianolaSupervisorTargets,
	removePianolaSupervisorTarget,
	type PianolaSupervisedTarget,
} from '../services/pianola-store';
import { generateUUID } from '../../shared/uuid';
import { ensurePianolaEnabled } from './pianola';
import { MaestroClient, withMaestroClient } from '../services/maestro-client';
import { exitIfMaestroNotRunning } from '../services/session-command';
import type { PianolaSupervisorSnapshot } from '../../main/ipc/handlers/pianola';

const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_CONCURRENCY = 3;

export interface PianolaSuperviseWatchOptions {
	agent?: string;
	interval?: string;
	idleHours?: string;
	json?: boolean;
}

export interface PianolaSuperviseOrchestrateOptions {
	concurrency?: string;
	interval?: string;
	json?: boolean;
}

export interface PianolaSuperviseCommonOptions {
	json?: boolean;
	live?: boolean;
}

export interface PianolaSuperviseScopeOptions {
	id?: string;
	manager: string;
	label: string;
	agents?: string;
	groups?: string;
	exclude?: string;
	futureLocalAgents?: boolean;
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

/** Ask the host to reconcile an owner-authorized whole-agent selection. */
export async function pianolaSuperviseScope(options: PianolaSuperviseScopeOptions): Promise<void> {
	ensurePianolaEnabled(options.json);
	if (options.futureLocalAgents && !options.id)
		fail('--future-local-agents requires an existing --id', options.json);
	const ids = (value?: string): string[] =>
		(value ?? '')
			.split(',')
			.map((id) => id.trim())
			.filter(Boolean);
	const client = new MaestroClient();
	try {
		await client.connect();
		const response = await client.sendCommand<{
			ok: boolean;
			error?: string;
			result: PianolaSupervisorSnapshot;
		}>(
			{
				type: 'bridge.invoke',
				channel: 'pianola:supervisor-add',
				args: [
					{
						id: options.id,
						kind: 'watch-scope',
						managerAgentId: options.manager,
						selection: {
							label: options.label,
							mode: 'agents-and-groups',
							agentIds: ids(options.agents),
							groupIds: ids(options.groups),
							excludedAgentIds: ids(options.exclude),
							...(options.futureLocalAgents ? { futureLocalAgents: true } : {}),
						},
					},
				],
			},
			'bridge.response'
		);
		if (!response.ok) fail(response.error ?? 'Scope host request failed', options.json);
		const migration = response.result.migration;
		if (!migration || migration.status === 'NeedsConfiguration') {
			if (options.json) console.log(JSON.stringify({ success: false, migration }));
			else console.error(migration?.reason ?? 'Scope host service unavailable');
			process.exitCode = 1;
			return;
		}
		const target = response.result.targets.find((entry) => entry.id === migration.scopeId);
		if (options.json) console.log(JSON.stringify({ success: true, target, migration }));
		else
			console.log(
				`Saved watch scope ${migration.scopeId} (${target?.enabled ? 'enabled' : 'paused'}).`
			);
	} catch (error) {
		exitIfMaestroNotRunning(error, options);
		throw error;
	} finally {
		client.disconnect();
	}
}

/** Register (or refresh) a supervised tab watcher. */
export function pianolaSuperviseWatch(tabId: string, options: PianolaSuperviseWatchOptions): void {
	ensurePianolaEnabled(options.json);
	if (!options.agent || options.agent.trim().length === 0) {
		fail('supervise watch requires --agent <agent-id>', options.json);
	}

	// Reuse an existing watcher for the same (kind, tabId, agentId) so registering
	let parsedIdleHours: number | undefined;
	if (options.idleHours !== undefined) {
		const parsed = Number(options.idleHours.trim());
		if (options.idleHours.trim() === '' || !Number.isFinite(parsed) || parsed < 0) {
			fail('--idle-hours must be a number of hours (0 = never)', options.json);
		}
		parsedIdleHours = parsed;
	}
	// the same tab twice replaces it in place instead of spawning a second watcher
	// that would double-answer the same prompt.
	let target!: PianolaSupervisedTarget;
	const written = updatePianolaSupervisorTargets((current) => {
		const existing = current.find(
			(t) => t.kind === 'watch' && t.tabId === tabId && t.agentId === options.agent
		);
		target = {
			id: existing?.id ?? generateUUID(),
			kind: 'watch',
			enabled: true,
			createdAt: existing?.createdAt ?? Date.now(),
			tabId,
			agentId: options.agent,
		};
		const interval = parsePositiveInt(options.interval, 1);
		if (interval !== undefined) target.intervalSeconds = interval;
		// Keep a previously chosen idle timeout when re-registering without the flag.
		const idleHours = parsedIdleHours ?? existing?.idleHours;
		if (idleHours !== undefined) target.idleHours = idleHours;
		return existing
			? current.map((entry) => (entry.id === existing.id ? target : entry))
			: [...current, target];
	});
	const saved = written.find((t) => t.id === target.id);
	if (saved?.migratedToScopeId) {
		fail(
			`Legacy watch was migrated to scope ${saved.migratedToScopeId}; it cannot be restarted`,
			options.json
		);
	}
	if (!saved) {
		fail('Target failed validation and was not saved', options.json);
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, target, targetCount: written.length }));
	} else {
		console.log(
			`Registered legacy tab watch ${tabId} (agent ${options.agent}). Target id: ${target.id}. Running status is available in the desktop.`
		);
	}
}

/** Register (or refresh) a supervised plan orchestration. */
export function pianolaSuperviseOrchestrate(
	planId: string,
	options: PianolaSuperviseOrchestrateOptions
): void {
	ensurePianolaEnabled(options.json);
	let target!: PianolaSupervisedTarget;
	const written = updatePianolaSupervisorTargets((current) => {
		const existing = current.find(
			(target) => target.kind === 'orchestrate' && target.planId === planId
		);
		target = {
			id: existing?.id ?? generateUUID(),
			kind: 'orchestrate',
			enabled: true,
			createdAt: existing?.createdAt ?? Date.now(),
			planId,
		};
		const interval = parsePositiveInt(options.interval, 1);
		if (interval !== undefined) target.intervalSeconds = interval;
		const concurrency = parsePositiveInt(options.concurrency, 1);
		if (concurrency !== undefined) target.concurrency = concurrency;
		return existing
			? current.map((entry) => (entry.id === existing.id ? target : entry))
			: [...current, target];
	});
	if (!written.some((t) => t.id === target.id)) {
		fail('Target failed validation and was not saved', options.json);
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, target, targetCount: written.length }));
	} else {
		console.log(`Supervising orchestration of plan ${planId}. Target id: ${target.id}`);
	}
}

export function pianolaSuperviseProgram(
	programId: string,
	options: { interval?: string; json?: boolean }
): void {
	ensurePianolaEnabled(options.json);
	let target!: PianolaSupervisedTarget;
	const written = updatePianolaSupervisorTargets((current) => {
		const existing = current.find(
			(target) => target.kind === 'program' && target.programId === programId
		);
		target = {
			id: existing?.id ?? generateUUID(),
			kind: 'program',
			enabled: true,
			createdAt: existing?.createdAt ?? Date.now(),
			programId,
			intervalSeconds: parsePositiveInt(options.interval, 1) ?? 120,
		};
		return existing
			? current.map((entry) => (entry.id === existing.id ? target : entry))
			: [...current, target];
	});
	if (!written.some((entry) => entry.id === target.id))
		fail('Target failed validation and was not saved', options.json);
	if (options.json)
		console.log(JSON.stringify({ success: true, target, targetCount: written.length }));
	else console.log('Supervising program ' + programId + '. Target: ' + target.id);
}
/** Describe one target's spawn args in a human-readable form. */
function describeTarget(target: PianolaSupervisedTarget): string {
	if (target.kind === 'watch-scope') {
		return `watch scope ${target.selection?.label ?? '?'} (manager ${target.managerAgentId ?? '?'}, interval ${target.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS}s)`;
	}
	if (target.kind === 'watch') {
		return `watch tab ${target.tabId} (agent ${target.agentId}, interval ${
			target.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS
		}s)`;
	}
	if (target.kind === 'program')
		return 'program ' + target.programId + ' (interval ' + (target.intervalSeconds ?? 120) + 's)';
	return `orchestrate plan ${target.planId} (concurrency ${
		target.concurrency ?? DEFAULT_CONCURRENCY
	}, interval ${target.intervalSeconds ?? DEFAULT_INTERVAL_SECONDS}s)`;
}

/** List stored targets, or request actual worker and coverage evidence from the host. */
export async function pianolaSuperviseList(options: PianolaSuperviseCommonOptions): Promise<void> {
	ensurePianolaEnabled(options.json);
	if (options.live) {
		try {
			const response = await withMaestroClient((client) =>
				client.sendCommand<{
					ok: boolean;
					error?: string;
					result: PianolaSupervisorSnapshot;
				}>(
					{ type: 'bridge.invoke', channel: 'pianola:supervisor-list', args: [] },
					'bridge.response'
				)
			);
			if (!response.ok) fail(response.error ?? 'Supervisor status unavailable', options.json);
			if (options.json) console.log(JSON.stringify(response.result));
			else {
				for (const target of response.result.targets) {
					const health = response.result.health.find((item) => item.id === target.id);
					const coverage = response.result.checkpoints.find((item) => item.scopeId === target.id);
					console.log(
						`${target.id} registry: ${target.enabled ? 'enabled' : 'paused'}; worker: ${health?.state ?? 'unknown'}; ${describeTarget(target)}`
					);
					if (target.kind === 'watch-scope')
						console.log(
							`  coverage: ${coverage?.coverage ? `${coverage.coverage.status} (${coverage.coverage.fresh ? 'fresh' : 'not fresh'}): ${coverage.coverage.reason}` : 'unknown'}${coverage?.error ? `; ${coverage.error}` : ''}`
						);
				}
				if (!response.result.targets.length) console.log('No supervised targets registered.');
			}
			return;
		} catch (error) {
			exitIfMaestroNotRunning(error, options);
			throw error;
		}
	}
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
	const written = updatePianolaSupervisorTargets((current) =>
		current.map((target) => (target.id === id ? { ...target, enabled } : target))
	);
	if (!written.some((target) => target.id === id))
		fail('No supervised target with id ' + id, options.json);
	const verb = enabled ? 'Enabled' : 'Disabled';
	if (options.json) {
		console.log(JSON.stringify({ success: true, id, enabled, targetCount: written.length }));
	} else {
		console.log(`${verb} supervised target ${id}.`);
	}
}
