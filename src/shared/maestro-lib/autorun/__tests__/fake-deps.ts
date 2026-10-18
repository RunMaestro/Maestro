/**
 * In-memory ports for the Auto Run engine tests: a document store, a recording turn runner,
 * and a History list. Nothing here touches the disk or starts a process.
 */

import type { HistoryEntry, SessionInfo } from '../../../types';
import { countMarkdownTasks } from '../../../markdownTaskScan';
import type { AutoRunDeps, AutoRunTurnRequest, AutoRunTurnResult } from '../engine-types';

export const session = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
	id: 'agent-1',
	name: 'Test Agent',
	toolType: 'claude-code',
	cwd: '/work/project',
	projectRoot: '/work/project',
	...overrides,
});

export const collect = async <T>(generator: AsyncGenerator<T>): Promise<T[]> => {
	const events: T[] = [];
	for await (const event of generator) events.push(event);
	return events;
};

export interface FakeDeps {
	deps: AutoRunDeps;
	/** `name` (no extension) to text. */
	docs: Map<string, string>;
	history: HistoryEntry[];
	requests: AutoRunTurnRequest[];
	/** What the engine told the activity port, in order. */
	activity: string[];
	order: string[];
	/** Answers a task turn. Default: tick the first unchecked box of the named document. */
	onTurn: (
		request: AutoRunTurnRequest,
		fake: FakeDeps
	) => AutoRunTurnResult | Promise<AutoRunTurnResult>;
}

/** Tick the first unchecked task in a document's text. */
export const tickFirstTask = (text: string): string => text.replace('- [ ]', '- [x]');

export function createFakeDeps(initialDocs: Record<string, string>): FakeDeps {
	let tick = 0;
	const fake: FakeDeps = {
		docs: new Map(Object.entries(initialDocs)),
		history: [],
		requests: [],
		activity: [],
		order: [],
		onTurn: (request, f) => {
			if (request.purpose === 'task' && request.document) {
				f.docs.set(request.document, tickFirstTask(f.docs.get(request.document) ?? ''));
				return { success: true, response: 'done', agentSessionId: `provider-${f.requests.length}` };
			}
			return { success: true, response: 'ok' };
		},
		deps: undefined as unknown as AutoRunDeps,
	};

	fake.deps = {
		turns: {
			prepare: async () => {
				fake.order.push('prepare');
			},
			run: async (request) => {
				fake.order.push(`turn:${request.purpose}`);
				fake.requests.push(request);
				return fake.onTurn(request, fake);
			},
		},
		documents: {
			read: (_folder, name) => {
				const content = fake.docs.get(name) ?? '';
				return { content, unchecked: countMarkdownTasks(content).unchecked };
			},
			readTasks: (_folder, name) => {
				const content = fake.docs.get(name) ?? '';
				const tasks = [...content.matchAll(/^\s*- \[ \]\s*(.+)$/gm)].map((m) => m[1].trim());
				return { content, tasks };
			},
			write: (_folder, file, content) => {
				fake.docs.set(file.replace(/\.md$/, ''), content);
			},
			uncheckAll: (content) => content.replace(/^(\s*-\s*)\[x\]/gim, '$1[ ]'),
		},
		history: {
			append: (entry) => {
				fake.order.push('history');
				fake.history.push(entry);
			},
			readAll: () => fake.history,
		},
		prompts: {
			get: async (id) =>
				id === 'autorun-goal' ? 'GOAL {{GOAL}} {{PREDECESSOR_HANDOFF}}' : `prompt:${id}`,
			taskSelectionBlock: async () => 'SELECTION',
		},
		environment: {
			gitBranch: () => 'main',
			isGitRepo: () => true,
			groupName: () => undefined,
		},
		activity: {
			begin: (entry) => {
				fake.activity.push(`begin:${entry.agentId}:${entry.playbookId}`);
			},
			end: (agentId) => {
				fake.activity.push(`end:${agentId}`);
			},
		},
		clock: { now: () => 1_700_000_000_000 + tick++ },
		log: { autorun: () => undefined, warn: () => undefined },
	};
	return fake;
}
