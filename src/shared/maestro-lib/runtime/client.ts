/**
 * The in-process `MaestroClient`: the agent, group, tab, and settings parts of
 * the client contract answered by the runtime itself instead of a desktop.
 *
 * It is a thin shell. Every state change is a repository command (so a command
 * written here and one written by the desktop's rules cannot differ), every read
 * is served from the repository's memory or a fresh read of a store file, and
 * every event comes from the one bus both client implementations share (RT15).
 *
 * Turns are answered by the runtime's turn service (`./turns`) and Auto Run by its run service
 * (`./autorun`). Group chats and consults answer `unsupported` until the phase that brings them (8). `unsupported` is a value, not a throw, so a
 * TUI written against the contract degrades the same way it does against an
 * older desktop.
 *
 * Design: `Plans/maestro-tui-runtime.md` section 8.
 */

import type { AgentRepository } from '../agents/repository';
import type { EventBus } from '../client/event-bus';
import type {
	AutoRunApi,
	ClientError,
	ClientErrorCode,
	ClientMethod,
	ClientResult,
	ConnectionState,
	HostInfo,
	MaestroClient,
	ProviderInfo,
	SettingsChange,
	TranscriptOptions,
	TurnsApi,
	Unsubscribe,
} from '../client/types';
import type { SshRemoteConfig } from '../../types';
import type { MaestroPaths } from '../paths/resolve';
import { readStoreDocument } from '../store/io';
import { sliceTranscript, transcriptOf, type LogEntryRecord } from '../store/transcript';

/** Where the runtime is in its life, which decides what a call may do. */
export type RuntimePhase =
	/** Serving: reads and commands work. */
	| 'open'
	/** Another process took over the data directory: reads still work, commands answer `host-lost`. */
	| 'fenced'
	/** `close()` ran: everything answers `host-unavailable`. */
	| 'closed';

export interface RuntimeClientDeps {
	paths: MaestroPaths;
	repository: AgentRepository;
	bus: EventBus;
	host: HostInfo;
	phase(): RuntimePhase;
	/** Why the runtime was fenced, for the answer to a call made after it. */
	fencedReason(): string;
	/** Flush, stop what the runtime started, release the lock. Safe to call twice. */
	shutdown(): Promise<void>;
	listProviders(): Promise<ProviderInfo[]>;
	/** Send, interrupt, queue, and the per-tab event stream. */
	turns: TurnsApi;
	/** Launch, stop, resume, skip, and abort a spec-driven or goal-driven run. */
	autoRun: AutoRunApi;
}

const ok = <T>(value: T): ClientResult<T> => ({ ok: true, value });

function fail<T = never>(
	method: ClientMethod,
	code: ClientErrorCode,
	message: string
): ClientResult<T> {
	const error: ClientError = { code, message, method };
	return { ok: false, error };
}

export function createRuntimeClient(deps: RuntimeClientDeps): MaestroClient {
	const { repository, bus, host, paths } = deps;
	let announced = false;

	/** A closed runtime answers nothing. `strict` also refuses a fenced one (connect). */
	const gate = (method: ClientMethod, strict = false): ClientResult<never> | undefined => {
		const phase = deps.phase();
		if (phase === 'closed') return fail(method, 'host-unavailable', 'The runtime was closed.');
		if (phase === 'fenced' && strict) return fail(method, 'host-lost', deps.fencedReason());
		return undefined;
	};

	/** A call that reads or commands: refused only once the runtime is closed. */
	function guarded<T>(
		method: ClientMethod,
		call: () => Promise<ClientResult<T>> | ClientResult<T>
	): Promise<ClientResult<T>> {
		return Promise.resolve(gate(method) ?? call());
	}

	const unsupported = <T>(method: ClientMethod, what: string): Promise<ClientResult<T>> =>
		Promise.resolve(
			gate(method) ?? fail<T>(method, 'unsupported', `${what} needs a later phase of the runtime.`)
		);

	function connect(method: ClientMethod): Promise<ClientResult<HostInfo>> {
		return Promise.resolve(
			gate(method, true) ??
				(() => {
					if (!announced) {
						announced = true;
						bus.emit({ type: 'host.connected', host, resumed: false });
						bus.emit({
							type: 'snapshot',
							agents: repository.listAgents(),
							groups: repository.listGroups(),
						});
					}
					return ok(host);
				})()
		);
	}

	async function settingsDocument(
		method: ClientMethod
	): Promise<ClientResult<Record<string, unknown>>> {
		const read = await readStoreDocument<Record<string, unknown>>(paths.settingsFile);
		if (read.status === 'ok') return ok(read.data);
		if (read.status === 'missing') return ok({});
		return fail(method, 'failed', `The settings file could not be read: ${read.reason}`);
	}

	return {
		connection: {
			discover: () => guarded('connection.discover', () => ok(host)),
			connect: () => connect('connection.connect'),
			reconnect: () => connect('connection.reconnect'),
			close: () => deps.shutdown(),
			state: (): ConnectionState => (deps.phase() === 'open' ? 'connected' : 'idle'),
			host: () => (deps.phase() === 'open' ? host : undefined),
		},

		agents: {
			list: () => guarded('agents.list', () => ok(repository.listAgents())),
			get: (agentId) =>
				guarded('agents.get', () => {
					const agent = repository.getAgent(agentId);
					return agent ? ok(agent) : fail('agents.get', 'not-found', `No agent ${agentId}.`);
				}),
			create: (input) => guarded('agents.create', () => repository.createAgent(input)),
			update: (agentId, patch) =>
				guarded('agents.update', () => repository.updateAgent(agentId, patch)),
			rename: (agentId, name) =>
				guarded('agents.rename', () => repository.renameAgent(agentId, name)),
			remove: (agentId) => guarded('agents.remove', () => repository.removeAgent(agentId)),
		},

		groups: {
			list: () => guarded('groups.list', () => ok(repository.listGroups())),
			create: (input) => guarded('groups.create', () => repository.createGroup(input)),
			rename: (groupId, name) =>
				guarded('groups.rename', () => repository.renameGroup(groupId, name)),
			remove: (groupId) => guarded('groups.remove', () => repository.removeGroup(groupId)),
			moveAgent: (agentId, groupId) =>
				guarded('groups.moveAgent', () => repository.moveAgentToGroup(agentId, groupId)),
		},

		tabs: {
			list: (agentId) =>
				guarded('tabs.list', () => {
					const tabs = repository.listTabs(agentId);
					return tabs ? ok(tabs) : fail('tabs.list', 'not-found', `No agent ${agentId}.`);
				}),
			create: (agentId) => guarded('tabs.create', () => repository.createTab(agentId)),
			rename: (agentId, tabId, name) =>
				guarded('tabs.rename', () => repository.renameTab(agentId, tabId, name)),
			close: (agentId, tabId) => guarded('tabs.close', () => repository.closeTab(agentId, tabId)),
			star: (agentId, tabId, starred) =>
				guarded('tabs.star', () => repository.starTab(agentId, tabId, starred)),
			update: (agentId, tabId, patch) =>
				guarded('tabs.update', () => repository.updateTab(agentId, tabId, patch)),
			transcript: (agentId: string, tabId: string, options?: TranscriptOptions) =>
				guarded('tabs.transcript', (): ClientResult<LogEntryRecord[]> => {
					if (!repository.getAgent(agentId)) {
						return fail('tabs.transcript', 'not-found', `No agent ${agentId}.`);
					}
					const tab = repository.getTab(agentId, tabId);
					if (!tab) return fail('tabs.transcript', 'not-found', `No tab ${tabId}.`);
					// A copy: the stored entries belong to the repository (R6).
					return ok(structuredClone(sliceTranscript(transcriptOf(tab), options)));
				}),
		},

		turns: {
			// A fenced runtime reads but does not start work: a turn it started could not be recorded.
			send: (agentId, tabId, input) =>
				Promise.resolve(gate('turns.send', true) ?? deps.turns.send(agentId, tabId, input)),
			// Stopping and tidying the queue stay available when fenced: they only reduce what runs.
			interrupt: (agentId, tabId) =>
				guarded('turns.interrupt', () => deps.turns.interrupt(agentId, tabId)),
			queue: {
				list: (agentId) => guarded('turns.queue.list', () => deps.turns.queue.list(agentId)),
				remove: (agentId, itemId) =>
					guarded('turns.queue.remove', () => deps.turns.queue.remove(agentId, itemId)),
			},
			subscribe: (agentId, tabId, listener): Unsubscribe =>
				deps.turns.subscribe(agentId, tabId, listener),
		},

		autoRun: {
			// A fenced runtime reads but does not start work: a run it started could not be recorded.
			launch: (agentId, input) =>
				Promise.resolve(gate('autoRun.launch', true) ?? deps.autoRun.launch(agentId, input)),
			launchGoal: (agentId, input) =>
				Promise.resolve(
					gate('autoRun.launchGoal', true) ?? deps.autoRun.launchGoal(agentId, input)
				),
			// Stopping and answering a pause only reduce what runs, so they stay available when fenced.
			stop: (agentId) => guarded('autoRun.stop', () => deps.autoRun.stop(agentId)),
			resume: (agentId) => guarded('autoRun.resume', () => deps.autoRun.resume(agentId)),
			skip: (agentId) => guarded('autoRun.skip', () => deps.autoRun.skip(agentId)),
			abort: (agentId) => guarded('autoRun.abort', () => deps.autoRun.abort(agentId)),
		},

		groupChats: {
			list: () => unsupported('groupChats.list', 'Group chats'),
			get: () => unsupported('groupChats.get', 'Group chats'),
			create: () => unsupported('groupChats.create', 'Group chats'),
			send: () => unsupported('groupChats.send', 'Group chats'),
			stop: () => unsupported('groupChats.stop', 'Group chats'),
			rename: () => unsupported('groupChats.rename', 'Group chats'),
			remove: () => unsupported('groupChats.remove', 'Group chats'),
		},

		consults: {
			ask: () => unsupported('consults.ask', 'Asking another agent'),
		},

		settings: {
			get: (keys) =>
				guarded('settings.get', async () => {
					const document = await settingsDocument('settings.get');
					if (!document.ok) return document;
					const values: Record<string, unknown> = {};
					for (const key of keys) {
						if (Object.prototype.hasOwnProperty.call(document.value, key)) {
							values[key] = document.value[key];
						}
					}
					return ok(values);
				}),
			subscribe: (keys, listener: (change: SettingsChange) => void): Unsubscribe => {
				const wanted = new Set(keys);
				return bus.subscribe(
					(event) => {
						if (event.type !== 'settings.changed') return;
						if (event.keys === 'unknown' || event.keys.some((key) => wanted.has(key))) {
							listener({ keys: event.keys });
						}
					},
					{ types: ['settings.changed'] }
				);
			},
			sshRemotes: () =>
				guarded('settings.sshRemotes', async () => {
					const document = await settingsDocument('settings.sshRemotes');
					if (!document.ok) return document;
					const remotes = document.value.sshRemotes;
					return ok(Array.isArray(remotes) ? (remotes as SshRemoteConfig[]) : []);
				}),
		},

		providers: {
			list: (options) =>
				guarded('providers.list', async () => {
					if (options?.sshRemoteId) {
						return fail<ProviderInfo[]>(
							'providers.list',
							'unsupported',
							'Probing an SSH remote needs the desktop or a later phase of the runtime.'
						);
					}
					return ok(await deps.listProviders());
				}),
			models: () => unsupported('providers.models', 'Listing models'),
		},

		events: {
			subscribe: (listener, filter) => bus.subscribe(listener, filter),
		},
	};
}
