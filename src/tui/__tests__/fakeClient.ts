import type {
	AITabRecord,
	AgentRecord,
	ClientError,
	ClientMethod,
	ClientResult,
	ConnectionState,
	GroupRecord,
	HostInfo,
	LogEntryRecord,
	MaestroClient,
	MaestroEvent,
	EventFilter,
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
}

export interface FakeClient {
	client: MaestroClient;
	/** Deliver an event to every subscriber, as the real client does. */
	push(event: MaestroEvent): void;
	/** Replace a transcript; the next `tabs.transcript` read returns it. */
	setTranscript(agentId: string, tabId: string, entries: LogEntryRecord[]): void;
	/** Every `tabs.transcript` call, as `agentId:tabId`. */
	transcriptReads: string[];
	/** What the connection did, in order. */
	calls: string[];
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
	const groups = options.groups ?? [];
	const transcripts = { ...options.transcripts };
	const listeners = new Set<{
		listener: (event: MaestroEvent) => void;
		filter?: EventFilter;
	}>();
	const transcriptReads: string[] = [];
	const calls: string[] = [];
	let state: ConnectionState = 'idle';

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
				push({ type: 'snapshot', agents, groups });
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
			list: async () => ({ ok: true, value: agents }),
			get: async (agentId) => {
				const found = agents.find((agent) => agent.id === agentId);
				return found ? { ok: true, value: found } : fail('agents.get', 'not-found');
			},
			create: () => unsupported('agents.create'),
			update: () => unsupported('agents.update'),
			rename: () => unsupported('agents.rename'),
			remove: () => unsupported('agents.remove'),
		},
		groups: {
			list: async () => ({ ok: true, value: groups }),
			create: () => unsupported('groups.create'),
			rename: () => unsupported('groups.rename'),
			remove: () => unsupported('groups.remove'),
			moveAgent: () => unsupported('groups.moveAgent'),
		},
		tabs: {
			list: async (agentId) => {
				const found = agents.find((agent) => agent.id === agentId);
				return found
					? { ok: true, value: (found.aiTabs ?? []) as AITabRecord[] }
					: fail('tabs.list', 'not-found');
			},
			create: () => unsupported('tabs.create'),
			rename: () => unsupported('tabs.rename'),
			close: () => unsupported('tabs.close'),
			star: () => unsupported('tabs.star'),
			update: () => unsupported('tabs.update'),
			transcript: async (agentId, tabId) => {
				transcriptReads.push(`${agentId}:${tabId}`);
				return { ok: true, value: transcripts[`${agentId}:${tabId}`] ?? [] };
			},
		},
		turns: {
			send: () => unsupported('turns.send'),
			interrupt: () => unsupported('turns.interrupt'),
			queue: {
				list: () => unsupported('turns.queue.list'),
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
		settings: {
			get: async () => ({ ok: true, value: {} }),
			subscribe: () => () => undefined,
			sshRemotes: async () => ({ ok: true, value: [] }),
		},
		providers: {
			list: async () => ({ ok: true, value: [] }),
			models: async () => ({ ok: true, value: [] }),
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
		setTranscript: (agentId, tabId, entries) => {
			transcripts[`${agentId}:${tabId}`] = entries;
		},
		transcriptReads,
		calls,
		setState: (next) => {
			state = next;
		},
	};
}
