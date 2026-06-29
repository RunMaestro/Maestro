// The identity map links a Maestro session to its omp resume key so either side
// can pick the session up. Persisted as JSON under the Maestro omp profile dir.
// Both the launcher (`mae resume`) and the maestro-bridge extension read/write it.
//
// This is a local convenience cache; the desktop app remains the authoritative
// session store. Pure file IO, no network.

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

export interface SessionMapRecord {
	maestroSessionId: string;
	// omp resume key: the session file path (omp --resume accepts a path).
	ompSessionId: string;
	engine: 'omp';
	cwd: string;
	title?: string;
	runId: string;
	startedAt: number;
	lastActiveAt: number;
}

interface SessionMapFile {
	version: string;
	records: SessionMapRecord[];
}

const MAP_VERSION = '1';

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRecord(value: unknown): value is SessionMapRecord {
	if (!isObject(value)) return false;
	return (
		typeof value.maestroSessionId === 'string' &&
		typeof value.ompSessionId === 'string' &&
		value.engine === 'omp' &&
		typeof value.cwd === 'string' &&
		typeof value.runId === 'string' &&
		typeof value.startedAt === 'number' &&
		typeof value.lastActiveAt === 'number'
	);
}

export async function readMap(mapPath: string): Promise<SessionMapRecord[]> {
	try {
		const raw = await fs.readFile(mapPath, 'utf8');
		const parsed: unknown = JSON.parse(raw);
		if (!isObject(parsed) || !Array.isArray(parsed.records)) return [];
		return parsed.records.filter(isRecord);
	} catch {
		return [];
	}
}

async function writeMap(mapPath: string, records: SessionMapRecord[]): Promise<void> {
	await fs.mkdir(path.dirname(mapPath), { recursive: true });
	const payload: SessionMapFile = { version: MAP_VERSION, records };
	const tmp = `${mapPath}.${process.pid}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(payload, null, 2), 'utf8');
	await fs.rename(tmp, mapPath);
}

export async function upsertRecord(mapPath: string, record: SessionMapRecord): Promise<void> {
	const records = await readMap(mapPath);
	const index = records.findIndex((r) => r.maestroSessionId === record.maestroSessionId);
	if (index >= 0) records[index] = { ...records[index], ...record };
	else records.push(record);
	await writeMap(mapPath, records);
}

export async function touchRecord(
	mapPath: string,
	maestroSessionId: string,
	lastActiveAt: number
): Promise<void> {
	const records = await readMap(mapPath);
	const index = records.findIndex((r) => r.maestroSessionId === maestroSessionId);
	if (index < 0) return;
	records[index] = { ...records[index], lastActiveAt };
	await writeMap(mapPath, records);
}

// Resolve a `mae resume [query]` request. No query -> most recently active.
// With a query, match (priority order): exact id, id prefix, title substring.
// Ties broken by most recent activity.
export async function resolveRecord(
	mapPath: string,
	query?: string
): Promise<SessionMapRecord | undefined> {
	const records = await readMap(mapPath);
	if (records.length === 0) return undefined;
	const byRecency = [...records].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
	const q = query?.trim();
	if (!q) return byRecency[0];
	const exact = byRecency.find((r) => r.maestroSessionId === q || r.ompSessionId === q);
	if (exact) return exact;
	const prefix = byRecency.find(
		(r) => r.maestroSessionId.startsWith(q) || r.ompSessionId.startsWith(q)
	);
	if (prefix) return prefix;
	const lower = q.toLowerCase();
	return byRecency.find((r) => (r.title ?? '').toLowerCase().includes(lower));
}

export async function findByOmpSessionId(
	mapPath: string,
	ompSessionId: string
): Promise<SessionMapRecord | undefined> {
	const records = await readMap(mapPath);
	return records.find((r) => r.ompSessionId === ompSessionId);
}
