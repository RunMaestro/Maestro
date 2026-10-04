import type { LogEntryRecord } from '../../../shared/maestro-lib';

let counter = 0;

export function entry(
	source: string,
	text: string,
	extra: Partial<LogEntryRecord> = {}
): LogEntryRecord {
	counter += 1;
	return { id: `e${counter}`, timestamp: Date.UTC(2026, 8, 25, 15, 4), source, text, ...extra };
}

export function toolEntry(
	name: string,
	input: unknown,
	state: Record<string, unknown> = { status: 'completed' },
	output?: unknown
): LogEntryRecord {
	return entry('tool', name, { metadata: { toolState: { ...state, input, output } } });
}
