import { useEffect, useMemo, useState } from 'react';
import {
	transcriptOf,
	type AITabRecord,
	type LogEntryRecord,
	type MaestroClient,
	type MaestroPaths,
} from '../../shared/maestro-lib';
import {
	applyClientEvent,
	hostLabelFor,
	liveAgentData,
	type LiveState,
	type SourceConnection,
} from './agentSource';
import { loadAgentData, type AgentData } from './loadAgentData';

type StorePaths = Pick<
	MaestroPaths,
	'sessionsFile' | 'groupsFile' | 'settingsFile' | 'agentConfigsFile'
>;

export interface AgentSource {
	data: AgentData;
	/** What the status bar prints after `host: `. */
	hostLabel: string;
	/** The client, while a desktop is attached; its transcripts replace the file's. */
	client: MaestroClient | undefined;
	/** True while the desktop is attached or was a moment ago. */
	live: boolean;
}

/**
 * Where the Agents pane and the tab strip get their data. With a client, the
 * TUI finds the running desktop and follows it live; with no client, or no
 * desktop to attach, it reads the store files once, read-only (Phase 2). The
 * files stay on screen while the client is still looking, so the first frame
 * is never empty.
 */
export function useAgentSource(paths: StorePaths, client: MaestroClient | undefined): AgentSource {
	const [fileData, setFileData] = useState(() => loadAgentData(paths));
	const [connection, setConnection] = useState<SourceConnection>(
		client ? { mode: 'connecting' } : { mode: 'files' }
	);
	const [live, setLive] = useState<LiveState | undefined>(undefined);

	useEffect(() => {
		if (!client) return;
		let cancelled = false;
		let attached: Extract<SourceConnection, { mode: 'desktop' }>['host'] | undefined;

		const fallBackToFiles = (reason: Extract<SourceConnection, { mode: 'files' }>['reason']) => {
			attached = undefined;
			setLive(undefined);
			// The desktop may have written since the TUI started, so read again.
			setFileData(loadAgentData(paths));
			setConnection({ mode: 'files', reason });
		};

		const unsubscribe = client.events.subscribe((event) => {
			if (cancelled) return;
			switch (event.type) {
				case 'host.connected':
					attached = event.host;
					setConnection({ mode: 'desktop', host: event.host });
					return;
				case 'host.lost':
					// The client gives up (and goes idle) only when the desktop refuses it twice.
					if (client.connection.state() === 'idle') fallBackToFiles('unauthorized');
					else if (attached) setConnection({ mode: 'lost', host: attached });
					return;
				default:
					setLive((state) => applyClientEvent(state ?? { agents: [], groups: [] }, event));
			}
		});

		void (async () => {
			const found = await client.connection.discover();
			if (cancelled) return;
			if (!found.ok) return fallBackToFiles(found.error.code);
			const connected = await client.connection.connect();
			if (cancelled) return;
			if (!connected.ok) return fallBackToFiles(connected.error.code);
			// `host.connected` and the snapshot arrive as events; this read covers a
			// client that raised them before the listener above saw them.
			const [agents, groups] = await Promise.all([client.agents.list(), client.groups.list()]);
			if (cancelled || !agents.ok || !groups.ok) return;
			setLive((state) => state ?? { agents: agents.value, groups: groups.value });
		})();

		return () => {
			cancelled = true;
			unsubscribe();
		};
		// `paths` is fixed for the life of the process.
	}, [client]);

	const attachedToDesktop = connection.mode === 'desktop' || connection.mode === 'lost';
	const data = useMemo(
		() => (attachedToDesktop && live ? liveAgentData(live) : fileData),
		[attachedToDesktop, live, fileData]
	);
	return {
		data,
		hostLabel: hostLabelFor(connection),
		client: attachedToDesktop ? client : undefined,
		live: attachedToDesktop && live !== undefined,
	};
}

/** How long a burst of turn events waits before the transcript is read again. */
const TRANSCRIPT_REFRESH_MS = 200;

const NO_ENTRIES: readonly LogEntryRecord[] = [];

/**
 * The entries of one tab. From the store file the tab record carries them; from
 * the desktop the record has none (records never hold transcripts), so they are
 * read with `tabs.transcript` and read again when the host reports a turn or a
 * change to the tab.
 */
export function useTabEntries(
	source: Pick<AgentSource, 'client' | 'live'>,
	agentId: string | undefined,
	tab: AITabRecord | undefined
): readonly LogEntryRecord[] {
	const { client, live } = source;
	const tabId = tab?.id;
	const key = agentId && tabId ? `${agentId}:${tabId}` : undefined;
	const [loaded, setLoaded] = useState<{ key: string; entries: LogEntryRecord[] } | undefined>(
		undefined
	);

	useEffect(() => {
		if (!client || !live || !agentId || !tabId || !key) return;
		let cancelled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const load = async () => {
			const read = await client.tabs.transcript(agentId, tabId);
			// A failed read keeps what is already on screen; the next event tries again.
			if (!cancelled && read.ok) setLoaded({ key, entries: read.value });
		};
		const schedule = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => void load(), TRANSCRIPT_REFRESH_MS);
		};

		void load();
		const unsubscribe = client.events.subscribe(
			(event) => {
				if (event.type === 'turn' || event.type === 'tab.updated') {
					if (event.agentId !== agentId) return;
					if (event.type === 'turn' ? event.tabId !== tabId : event.tab.id !== tabId) return;
				}
				schedule();
			},
			{ types: ['turn', 'tab.updated', 'snapshot', 'host.connected'] }
		);
		return () => {
			cancelled = true;
			if (timer) clearTimeout(timer);
			unsubscribe();
		};
	}, [client, live, agentId, tabId, key]);

	const fromFile = useMemo(() => (tab ? transcriptOf(tab) : NO_ENTRIES), [tab]);
	if (!live) return fromFile;
	return loaded && loaded.key === key ? loaded.entries : NO_ENTRIES;
}
