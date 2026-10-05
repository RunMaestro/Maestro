import type {
	AITabRecord,
	AgentRecord,
	ClientError,
	ClientMethod,
	ClientResult,
	ConnectionState,
	GroupChatRecord,
	GroupRecord,
	HostInfo,
	LogEntryRecord,
	MaestroClient,
	MaestroEvent,
	EventFilter,
	ProviderInfo,
	QueuedTurn,
	SshRemoteConfig,
	TurnSendReceipt,
} from '../../shared/maestro-lib';

export interface FakeClientOptions {
	agents?: AgentRecord[];
	groups?: GroupRecord[];
	host?: HostInfo;
	/** Transcripts by `agentId:tabId`. */
	transcripts?: Record<string, LogEntryRecord[]>;
	/** Make `discover` or `connect` fail with this code. */
	discoverError?: ClientError['code'];
	connectError?: ClientError['code'];
	providers?: ProviderInfo[];
	sshRemotes?: SshRemoteConfig[];
	/** Model ids by provider id. */
	models?: Record<string, string[]>;
	/** What `turns.send` answers, one per call in order; once used up it answers `started`. */
	sendReceipts?: TurnSendReceipt[];
	/** The host's execution queue, as `turns.queue.list` reports it. */
	queue?: QueuedTurn[];
	/** What `turns.interrupt` reports as `stopped`. Default true. */
	interruptStopped?: boolean;
	/** What `agents.update` reports as `notices`: what a provider swap could not park. */
	updateNotices?: string[];
	/** What `autoRun.launchGoal` reports as `tabId`. */
	goalRunTabId?: string;
	/** The group chats the host holds. `groupChats.get` returns one with its lines; `list` returns them without. */
	groupChats?: GroupChatRecord[];
	/** Make these methods fail with this code, so a test can see how a refusal is shown. */
	failures?: Partial<Record<ClientMethod, ClientError['code']>>;
}

export interface FakeClient {
	client: MaestroClient;
	/** Deliver an event to every subscriber, as the real client does. */
	push(event: MaestroEvent): void;
	/** Replace a transcript; the next `tabs.transcript` read returns it. */
	setTranscript(agentId: string, tabId: string, entries: LogEntryRecord[]): void;
	/** Replace the execution queue the next `turns.queue.list` reports. */
	setQueue(items: QueuedTurn[]): void;
	/** Every `tabs.transcript` call, as `agentId:tabId`. */
	transcriptReads: string[];
	/** The group chats the host holds: a test edits a chat here to change what the next `get` reads. */
	groupChats: GroupChatRecord[];
	/** Every `groupChats.get` call, as the chat id. */
	chatReads: string[];
	/** Tabs closed through `tabs.close`, as the host's closed-tab history holds them. */
	closedTabs: Array<{ agentId: string; tab: AITabRecord }>;
	/** What the connection did, in order. */
	calls: string[];
	/** Every call that changes or asks something, with the arguments the TUI passed, in order. */
	requests: Array<{ method: ClientMethod; args: unknown[] }>;
	setState(state: ConnectionState): void;
}

export const DESKTOP_HOST: HostInfo = { kind: 'desktop', pid: 4121, label: 'desktop pid 4121' };

const fail = (method: ClientMethod, code: ClientError['code']): ClientResult<never> => ({
	ok: false,
	error: { code, message: `fake ${code}`, method },
});

const matches = (filter: EventFilter | undefined, event: MaestroEvent): boolean => {
	if (filter?.types && !filter.types.includes(event.type)) return false;
	return true;
};

/**
 * A `MaestroClient` for tests: it serves the agents it was given, lets a test
 * push events, and answers every method the TUI has not started using with
 * `unsupported`. Later tasks extend it as the TUI grows a call at a time.
 */
export function createFakeClient(options: FakeClientOptions = {}): FakeClient {
	const host = options.host ?? DESKTOP_HOST;
	const agents = options.agents ?? [];
	const groups = (options.groups ?? []).map((group) => ({ ...group }));
	const transcripts = { ...options.transcripts };
	const sendReceipts = [...(options.sendReceipts ?? [])];
	let queue = [...(options.queue ?? [])];
	const listeners = new Set<{
		listener: (event: MaestroEvent) => void;
		filter?: EventFilter;
	}>();
	const transcriptReads: string[] = [];
	const calls: string[] = [];
	const requests: FakeClient['requests'] = [];
	const closedTabs: FakeClient['closedTabs'] = [];
	let tabCount = 0;
	let createdCount = 0;
	let groupCount = 0;
	let chatCount = 0;
	const chats = (options.groupChats ?? []).map((chat) => ({ ...chat }));
	const chatReads: string[] = [];
	let state: ConnectionState = 'idle';

	const record = (method: ClientMethod, ...args: unknown[]): ClientResult<never> | undefined => {
		requests.push({ method, args });
		const code = options.failures?.[method];
		return code ? fail(method, code) : undefined;
	};
	const unsupported = async (method: ClientMethod) => fail(method, 'unsupported');
	const push = (event: MaestroEvent) => {
		for (const entry of [...listeners]) {
			if (matches(entry.filter, event)) entry.listener(event);
		}
	};

	const client: MaestroClient = {
		connection: {
			discover: async () => {
				calls.push('discover');
				return options.discoverError
					? fail('connection.discover', options.discoverError)
					: { ok: true, value: host };
			},
			connect: async () => {
				calls.push('connect');
				if (options.connectError) return fail('connection.connect', options.connectError);
				state = 'connected';
				push({ type: 'host.connected', host, resumed: false });
				// Copies: the fake edits its own arrays in place, and a shared reference would hide the change from the TUI's reducer.
				push({ type: 'snapshot', agents: [...agents], groups: [...groups] });
				return { ok: true, value: host };
			},
			reconnect: async () => ({ ok: true, value: host }),
			close: async () => {
				calls.push('close');
				state = 'idle';
			},
			state: () => state,
			host: () => (state === 'connected' ? host : undefined),
		},
		agents: {
			list: async () => ({ ok: true, value: [...agents] }),
			get: async (agentId) => {
				const refused = record('agents.get', agentId);
				if (refused) return refused;
				const found = agents.find((agent) => agent.id === agentId);
				return found ? { ok: true, value: found } : fail('agents.get', 'not-found');
			},
			create: async (input) => {
				const refused = record('agents.create', input);
				if (refused) return refused;
				createdCount += 1;
				const agentId = `new-agent-${createdCount}`;
				const created: AgentRecord = {
					id: agentId,
					name: input.name,
					toolType: input.provider,
					cwd: input.cwd,
					...(input.groupId ? { groupId: input.groupId } : {}),
				};
				agents.push(created);
				push({ type: 'agent.added', agent: created });
				return { ok: true, value: { agentId } };
			},
			update: async (agentId, patch) => {
				const refused = record('agents.update', agentId, patch);
				if (refused) return refused;
				return {
					ok: true,
					value: {
						applied: Object.keys(patch) as never[],
						...(options.updateNotices ? { notices: options.updateNotices } : {}),
					},
				};
			},
			rename: async (agentId, name) => {
				const refused = record('agents.rename', agentId, name);
				if (refused) return refused;
				const found = agents.find((agent) => agent.id === agentId);
				if (!found) return fail('agents.rename', 'not-found');
				found.name = name;
				push({ type: 'agent.updated', agent: { ...found } });
				return { ok: true, value: undefined };
			},
			remove: async (agentId) => {
				const refused = record('agents.remove', agentId);
				if (refused) return refused;
				const at = agents.findIndex((agent) => agent.id === agentId);
				if (at < 0) return fail('agents.remove', 'not-found');
				agents.splice(at, 1);
				push({ type: 'agent.removed', agentId });
				return { ok: true, value: undefined };
			},
		},
		groups: {
			list: async () => ({ ok: true, value: [...groups] }),
			create: async (input) => {
				const refused = record('groups.create', input);
				if (refused) return refused;
				groupCount += 1;
				const groupId = `new-group-${groupCount}`;
				groups.push({
					id: groupId,
					name: input.name,
					...(input.emoji ? { emoji: input.emoji } : {}),
				});
				push({ type: 'groups.changed', groups: [...groups] });
				return { ok: true, value: { groupId } };
			},
			rename: async (groupId, name) => {
				const refused = record('groups.rename', groupId, name);
				if (refused) return refused;
				const found = groups.find((group) => group.id === groupId);
				if (!found) return fail('groups.rename', 'not-found');
				found.name = name;
				push({ type: 'groups.changed', groups: groups.map((group) => ({ ...group })) });
				return { ok: true, value: undefined };
			},
			remove: async (groupId) => {
				const refused = record('groups.remove', groupId);
				if (refused) return refused;
				const at = groups.findIndex((group) => group.id === groupId);
				if (at < 0) return fail('groups.remove', 'not-found');
				groups.splice(at, 1);
				push({ type: 'groups.changed', groups: [...groups] });
				// Members become ungrouped, as the desktop does it; none is deleted.
				for (const agent of agents) {
					if (agent.groupId !== groupId) continue;
					delete agent.groupId;
					push({ type: 'agent.updated', agent: { ...agent } });
				}
				return { ok: true, value: undefined };
			},
			moveAgent: async (agentId, groupId) => {
				const refused = record('groups.moveAgent', agentId, groupId);
				if (refused) return refused;
				const found = agents.find((agent) => agent.id === agentId);
				if (!found) return fail('groups.moveAgent', 'not-found');
				if (groupId === null) delete found.groupId;
				else found.groupId = groupId;
				push({ type: 'agent.updated', agent: { ...found } });
				return { ok: true, value: undefined };
			},
		},
		tabs: {
			list: async (agentId) => {
				const found = agents.find((agent) => agent.id === agentId);
				return found
					? { ok: true, value: (found.aiTabs ?? []) as AITabRecord[] }
					: fail('tabs.list', 'not-found');
			},
			create: async (agentId) => {
				const refused = record('tabs.create', agentId);
				if (refused) return refused;
				const found = agents.find((agent) => agent.id === agentId);
				if (!found) return fail('tabs.create', 'not-found');
				tabCount += 1;
				const tabId = `new-tab-${tabCount}`;
				found.aiTabs = [...(found.aiTabs ?? []), { id: tabId }];
				push({ type: 'agent.updated', agent: { ...found } });
				return { ok: true, value: { tabId } };
			},
			rename: async (agentId, tabId, name) => {
				const refused = record('tabs.rename', agentId, tabId, name);
				if (refused) return refused;
				const found = agents.find((agent) => agent.id === agentId);
				const tab = found?.aiTabs?.find((candidate) => candidate.id === tabId);
				if (!found || !tab) return fail('tabs.rename', 'not-found');
				if (name) tab.name = name;
				else delete tab.name;
				push({ type: 'agent.updated', agent: { ...found, aiTabs: [...(found.aiTabs ?? [])] } });
				return { ok: true, value: undefined };
			},
			close: async (agentId, tabId) => {
				const refused = record('tabs.close', agentId, tabId);
				if (refused) return refused;
				const found = agents.find((agent) => agent.id === agentId);
				const tab = found?.aiTabs?.find((candidate) => candidate.id === tabId);
				if (!found || !tab) return fail('tabs.close', 'not-found');
				// Like the desktop: the tab moves to closed-tab history with its transcript, and closing the last one leaves a fresh empty tab.
				closedTabs.push({ agentId, tab });
				const rest = (found.aiTabs ?? []).filter((candidate) => candidate.id !== tabId);
				tabCount += 1;
				found.aiTabs = rest.length > 0 ? rest : [{ id: `new-tab-${tabCount}` }];
				push({ type: 'agent.updated', agent: { ...found } });
				return { ok: true, value: undefined };
			},
			star: () => unsupported('tabs.star'),
			update: () => unsupported('tabs.update'),
			transcript: async (agentId, tabId) => {
				transcriptReads.push(`${agentId}:${tabId}`);
				return { ok: true, value: transcripts[`${agentId}:${tabId}`] ?? [] };
			},
		},
		turns: {
			send: async (agentId, tabId, input) => {
				const refused = record('turns.send', agentId, tabId, input);
				if (refused) return refused;
				return { ok: true, value: sendReceipts.shift() ?? { status: 'started' } };
			},
			interrupt: async (agentId, tabId) => {
				const refused = record('turns.interrupt', agentId, tabId);
				if (refused) return refused;
				return { ok: true, value: { stopped: options.interruptStopped ?? true } };
			},
			queue: {
				// Reads are not recorded: the TUI re-reads the queue on turn events, and tests assert the writes.
				list: async () => ({ ok: true, value: [...queue] }),
				remove: () => unsupported('turns.queue.remove'),
			},
			subscribe: (agentId, tabId, listener) => {
				const entry = {
					listener: (event: MaestroEvent) => {
						if (event.type === 'turn' && event.agentId === agentId && event.tabId === tabId)
							listener(event.event);
					},
				};
				listeners.add(entry);
				return () => listeners.delete(entry);
			},
		},
		autoRun: {
			launch: async (agentId, input) => {
				const refused = record('autoRun.launch', agentId, input);
				if (refused) return refused;
				return { ok: true, value: undefined };
			},
			launchGoal: async (agentId, input) => {
				const refused = record('autoRun.launchGoal', agentId, input);
				if (refused) return refused;
				return { ok: true, value: options.goalRunTabId ? { tabId: options.goalRunTabId } : {} };
			},
			stop: async (agentId) => record('autoRun.stop', agentId) ?? { ok: true, value: undefined },
			resume: async (agentId) =>
				record('autoRun.resume', agentId) ?? { ok: true, value: undefined },
			skip: async (agentId) => record('autoRun.skip', agentId) ?? { ok: true, value: undefined },
			abort: async (agentId) => record('autoRun.abort', agentId) ?? { ok: true, value: undefined },
		},
		groupChats: {
			// Reads are not recorded: the TUI re-reads a chat on events, and tests assert the writes.
			list: async () => {
				const refused = options.failures?.['groupChats.list'];
				if (refused) return fail('groupChats.list', refused);
				return { ok: true, value: chats.map((chat) => ({ ...chat, lines: [] })) };
			},
			get: async (chatId) => {
				chatReads.push(chatId);
				const refused = options.failures?.['groupChats.get'];
				if (refused) return fail('groupChats.get', refused);
				const found = chats.find((chat) => chat.id === chatId);
				return found ? { ok: true, value: { ...found } } : fail('groupChats.get', 'not-found');
			},
			create: async (input) => {
				const refused = record('groupChats.create', input);
				if (refused) return refused;
				chatCount += 1;
				const chatId = `new-chat-${chatCount}`;
				chats.push({
					id: chatId,
					name: input.name,
					participants: [],
					state: 'moderator-thinking',
					working: [],
					archived: false,
					lines: [],
				});
				return { ok: true, value: { chatId } };
			},
			send: async (chatId, message) =>
				record('groupChats.send', chatId, message) ?? { ok: true, value: undefined },
			stop: async (chatId) => record('groupChats.stop', chatId) ?? { ok: true, value: undefined },
			rename: async (chatId, name) => {
				const refused = record('groupChats.rename', chatId, name);
				if (refused) return refused;
				const found = chats.find((chat) => chat.id === chatId);
				if (!found) return fail('groupChats.rename', 'not-found');
				found.name = name;
				return { ok: true, value: undefined };
			},
			remove: async (chatId) => {
				const refused = record('groupChats.remove', chatId);
				if (refused) return refused;
				const at = chats.findIndex((chat) => chat.id === chatId);
				if (at < 0) return fail('groupChats.remove', 'not-found');
				chats.splice(at, 1);
				return { ok: true, value: undefined };
			},
		},
		settings: {
			get: async () => ({ ok: true, value: {} }),
			subscribe: () => () => undefined,
			sshRemotes: async () => ({ ok: true, value: options.sshRemotes ?? [] }),
		},
		providers: {
			list: async (listOptions) => {
				const refused = record('providers.list', listOptions);
				if (refused) return refused;
				return { ok: true, value: options.providers ?? [] };
			},
			models: async (providerId) => ({ ok: true, value: options.models?.[providerId] ?? [] }),
		},
		events: {
			subscribe: (listener, filter) => {
				const entry = { listener, filter };
				listeners.add(entry);
				return () => listeners.delete(entry);
			},
		},
	};

	return {
		client,
		push,
		setQueue: (items) => {
			queue = [...items];
		},
		setTranscript: (agentId, tabId, entries) => {
			transcripts[`${agentId}:${tabId}`] = entries;
		},
		transcriptReads,
		groupChats: chats,
		chatReads,
		closedTabs,
		calls,
		requests,
		setState: (next) => {
			state = next;
		},
	};
}
