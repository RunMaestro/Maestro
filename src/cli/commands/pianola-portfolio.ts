import * as fs from 'fs';
import * as path from 'path';
import yaml from 'js-yaml';
import { MaestroClient } from '../services/maestro-client';
import { readAgentRuns } from '../services/agent-run-store';
import { pianolaTaskAgentRunId } from '../../shared/agent-run';
import { generateUUID } from '../../shared/uuid';
import { ensurePianolaEnabled } from './pianola';
import {
	readPianolaPrograms,
	upsertPianolaProgram,
	readPianolaAsks,
	writePianolaAsks,
	readPianolaPlans,
	readPianolaDecisions,
} from '../services/pianola-store';
import {
	validatePianolaProgram,
	dedupeAsk,
	briefRunsForPlans,
	derivePianolaBrief,
	type PianolaProgram,
	type PianolaAsk,
	type PianolaAskSeverity,
} from '../../shared/pianola/pianola-programs';

const print = (value: unknown, json?: boolean): void => {
	console.log(
		json
			? JSON.stringify(value)
			: typeof value === 'string'
				? value
				: JSON.stringify(value, null, 2)
	);
};
const fail = (message: string, json?: boolean): never => {
	if (json) console.log(JSON.stringify({ success: false, error: message }));
	else console.error(message);
	process.exit(1);
};

export async function pianolaProgramApply(options: {
	file: string;
	json?: boolean;
}): Promise<void> {
	ensurePianolaEnabled(options.json);
	let manifest: unknown;
	try {
		const content = fs.readFileSync(path.resolve(options.file), 'utf-8');
		manifest = /\.json$/i.test(options.file) ? JSON.parse(content) : yaml.load(content);
	} catch (error) {
		fail(
			`Could not load program file: ${error instanceof Error ? error.message : String(error)}`,
			options.json
		);
	}
	const programs =
		manifest && typeof manifest === 'object' && 'programs' in manifest
			? manifest.programs
			: undefined;
	if (!Array.isArray(programs))
		return fail('Program file must contain a programs array', options.json);
	const ids = new Set<string>();
	const candidates: PianolaProgram[] = [];
	for (const raw of programs) {
		const existing =
			raw && typeof raw === 'object' && 'id' in raw && typeof raw.id === 'string'
				? readPianolaPrograms().find((p) => p.id === raw.id)
				: undefined;
		if (!raw || typeof raw !== 'object' || Array.isArray(raw))
			return fail('Invalid program entry', options.json);
		const input = raw as Record<string, unknown>;
		const roles =
			input.roles && typeof input.roles === 'object' && !Array.isArray(input.roles)
				? (input.roles as Record<string, unknown>)
				: {};
		const mergedRoles: Record<string, unknown> = {};
		for (const [key, role] of Object.entries(roles)) {
			mergedRoles[key] =
				role && typeof role === 'object' && !Array.isArray(role)
					? {
							...role,
							agentId:
								('agentId' in role ? role.agentId : undefined) ?? existing?.roles[key]?.agentId,
						}
					: role;
		}
		const now = Date.now();
		const candidate = validatePianolaProgram({
			...input,
			roles: mergedRoles,
			status: existing?.status ?? input.status ?? 'active',
			createdAt: existing?.createdAt ?? now,
			updatedAt: existing?.updatedAt ?? now,
		});
		if (!candidate)
			return fail('Invalid program: ' + String(input.id ?? '(missing id)'), options.json);
		if (ids.has(candidate.id)) return fail('Duplicate program id: ' + candidate.id, options.json);
		ids.add(candidate.id);
		candidates.push(candidate);
	}
	let client: MaestroClient | undefined;
	const applied: PianolaProgram[] = [];
	try {
		for (let program of candidates) {
			const existing = readPianolaPrograms().find((p) => p.id === program.id);
			if (
				existing &&
				JSON.stringify(existing) === JSON.stringify(program) &&
				Object.values(program.roles).every((role) => !!role.agentId)
			) {
				applied.push(existing);
				continue;
			}
			program = { ...program, updatedAt: existing ? Date.now() : program.updatedAt };
			upsertPianolaProgram(program);
			for (const [key, role] of Object.entries(program.roles)) {
				if (role.agentId) continue;
				if (!client) {
					client = new MaestroClient();
					await client.connect();
				}
				const result = await client.sendCommand<{
					success: boolean;
					sessionId?: string;
					error?: string;
				}>(
					{
						type: 'create_session',
						name: role.name,
						toolType: role.agentType ?? 'omp',
						cwd: program.root,
						...(role.model ? { customModel: role.model } : {}),
						...(program.remoteId
							? {
									sessionSshRemoteConfig: {
										enabled: true,
										remoteId: program.remoteId,
										workingDirOverride: program.root,
									},
								}
							: {}),
					},
					'create_session_result'
				);
				if (!result.success || !result.sessionId)
					throw new Error(result.error ?? `No sessionId for ${program.id}:${key}`);
				program = {
					...program,
					roles: { ...program.roles, [key]: { ...role, agentId: result.sessionId } },
				};
				upsertPianolaProgram(program);
			}
			applied.push(program);
		}
	} catch (error) {
		fail(
			`Program apply failed: ${error instanceof Error ? error.message : String(error)}`,
			options.json
		);
	} finally {
		client?.disconnect();
	}
	print(applied, options.json);
}

export function pianolaProgramList(options: { json?: boolean }): void {
	ensurePianolaEnabled(options.json);
	print(readPianolaPrograms(), options.json);
}
export function pianolaProgramShow(id: string, options: { json?: boolean }): void {
	ensurePianolaEnabled(options.json);
	const program = readPianolaPrograms().find((p) => p.id === id);
	if (!program) fail(`Program not found: ${id}`, options.json);
	print(program, options.json);
}
export function pianolaProgramStatus(
	id: string,
	status: 'active' | 'paused',
	options: { json?: boolean }
): void {
	ensurePianolaEnabled(options.json);
	const current = readPianolaPrograms().find((p) => p.id === id);
	if (!current) return fail('Program not found: ' + id, options.json);
	const updated =
		current.status === status ? current : { ...current, status, updatedAt: Date.now() };
	if (updated !== current) upsertPianolaProgram(updated);
	print(updated, options.json);
}

export interface EscalateOptions {
	title: string;
	detail: string;
	program?: string;
	agent?: string;
	tab?: string;
	severity?: PianolaAskSeverity;
	requestedAction?: string;
	distinct?: boolean;
	json?: boolean;
}
export function pianolaEscalate(options: EscalateOptions): void {
	ensurePianolaEnabled(options.json);
	if (!options.title?.trim() || !options.detail?.trim())
		fail('Title and detail are required', options.json);
	if (options.severity && !['low', 'medium', 'high', 'critical'].includes(options.severity))
		fail('Invalid severity', options.json);
	const now = new Date().toISOString();
	const ask: PianolaAsk = {
		id: generateUUID(),
		createdAt: now,
		updatedAt: now,
		title: options.title,
		detail: options.detail,
		severity: options.severity ?? 'medium',
		dedupeKey: `${options.agent ?? 'unknown'}:${options.program ?? 'global'}`,
		status: 'open',
		...(options.program ? { programId: options.program } : {}),
		...(options.agent ? { agentId: options.agent } : {}),
		...(options.tab ? { tabId: options.tab } : {}),
		...(options.requestedAction ? { requestedAction: options.requestedAction } : {}),
	};
	const result = dedupeAsk(readPianolaAsks(), ask, options.distinct);
	writePianolaAsks(result.asks);
	print(result.ask, options.json);
}
export function pianolaResolve(
	id: string,
	options: { option: string; note?: string; json?: boolean }
): void {
	ensurePianolaEnabled(options.json);
	if (!options.option?.trim()) fail('Resolution option is required', options.json);
	const asks = readPianolaAsks();
	const ask = asks.find((a) => a.id === id && a.status === 'open');
	if (!ask) return fail('Open ask not found: ' + id, options.json);
	const now = new Date().toISOString();
	const updated: PianolaAsk = {
		...ask,
		status: 'resolved',
		updatedAt: now,
		resolution: {
			option: options.option,
			...(options.note === undefined ? {} : { note: options.note }),
			resolvedAt: now,
		},
	};
	writePianolaAsks(asks.map((a) => (a.id === id ? updated : a)));
	print(updated, options.json);
}
export function pianolaDismiss(id: string, options: { json?: boolean }): void {
	ensurePianolaEnabled(options.json);
	const asks = readPianolaAsks();
	const ask = asks.find((a) => a.id === id && a.status === 'open');
	if (!ask) return fail('Open ask not found: ' + id, options.json);
	const updated: PianolaAsk = { ...ask, status: 'dismissed', updatedAt: new Date().toISOString() };
	writePianolaAsks(asks.map((a) => (a.id === id ? updated : a)));
	print(updated, options.json);
}
function brief() {
	const plans = readPianolaPlans();
	const runs = briefRunsForPlans(plans, readAgentRuns(), pianolaTaskAgentRunId);
	return derivePianolaBrief(
		readPianolaPrograms(),
		plans,
		readPianolaAsks(),
		readPianolaDecisions(),
		runs
	);
}
export function pianolaNeedsMe(options: { json?: boolean }): void {
	ensurePianolaEnabled(options.json);
	print(brief().needsMe, options.json);
}
export function pianolaBrief(options: { json?: boolean }): void {
	ensurePianolaEnabled(options.json);
	print(brief(), options.json);
}
