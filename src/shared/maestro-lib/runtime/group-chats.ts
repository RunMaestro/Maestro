/**
 * The runtime's group chats (GC-1 to GC-5): the `groupChats` part of `MaestroClient`, answered by
 * the library's group chat engine running in this process with no desktop.
 *
 * | Port of the engine | The runtime's answer |
 * | --- | --- |
 * | store | `createGroupChatStore` over `paths.groupChatsDir`, refused once the runtime is fenced (GD21) |
 * | events | the client's `groupChat` bus event: a line, the moderator's state, a participant working, the roster |
 * | agents | the repository's agents, with settings read per call so a desktop edit applies to the next turn |
 * | prompts | the loader chat turns use: the user's edit over the bundled prompt, a missing one throws |
 * | power | none: a headless host has no sleep to block |
 * | launcher | `createBackgroundTurns`: SSH wrap, Claude token source, Windows shell, then the run layer |
 *
 * Rounds are driven by the engine; this reports each finished turn to it in the order it needs
 * (`sessionAnnounced`, `usageReported`, `turnEnded`, so the next spawn reads the stored session id).
 * Because the chat is the desktop's own (same storage, GC-4), one started here continues there.
 *
 * A chat takes one round at a time (B22): `send` is refused while the room is working, and the
 * message is not queued, because no library client queues (GD14).
 *
 * Design: `Plans/maestro-tui-group-chat.md` section 6.
 */

import * as path from 'path';

import type { GroupChatMessage } from '../../group-chat-types';
import { planGroupChatStart, withParticipantMentions } from '../../groupChatRemote';
import type { AgentRepository } from '../agents/repository';
import { listAutoRunDocuments, resolveAutoRunFolder } from '../autorun/documents';
import type { EventBus } from '../client/event-bus';
import type {
	AutoRunApi,
	ClientError,
	ClientErrorCode,
	ClientMethod,
	ClientResult,
	GroupChatsApi,
} from '../client/types';
import {
	mergeGroupChatLines,
	parseGroupChatLine,
	validateGroupChatCreate,
	type GroupChatEvent,
	type GroupChatLine,
	type GroupChatRecord,
	type GroupChatTurnState,
} from '../groupchat/chat';
import { createGroupChatOperations } from '../groupchat/chat-ops';
import { groupChatAutoRunSummary } from '../groupchat/autorun-summary';
import { readLog } from '../groupchat/log';
import { createGroupChatEngine, findSessionForParticipantName } from '../groupchat/router';
import { toGroupChatSessionInfo, type MentionableSession } from '../groupchat/session-info';
import { parseModeratorSessionId, parseParticipantSessionId } from '../groupchat/session-ids';
import { createGroupChatStore, type GroupChat, type GroupChatStore } from '../groupchat/storage';
import { turnEndOf } from '../groupchat/turn-end';
import type { GroupChatTurnMetrics } from '../groupchat/turn-metrics';
import type {
	GroupChatAgentDirectory,
	GroupChatEventSink,
	GroupChatLauncher,
	GroupChatPromptId,
} from '../groupchat/types';
import { logger } from '../host';
import type { MaestroPaths } from '../paths/resolve';
import { createPromptLoaderFor } from '../prompts/load';
import { readAgentConfigsStore, readSettingsStore } from '../store/read-stores';
import type { BackgroundTurns } from './background-turns';
import type { DataDirVerdict } from './data-dir-lock';
import type { ProcessRegistry } from './processes';
import type { RuntimeTurnOptions } from './turns';

const LOG_CONTEXT = '[RuntimeGroupChats]';

export interface RuntimeGroupChatsOptions {
	paths: MaestroPaths;
	repository: AgentRepository;
	bus: EventBus;
	registry: ProcessRegistry;
	fence(): DataDirVerdict;
	background: BackgroundTurns;
	/** The turn clock and usage ledger, shared with the background runner's `beginTurn`. */
	metrics: GroupChatTurnMetrics;
	/** The run service: a participant's `!autorun` runs through it, and a running Auto Run makes its agent busy. */
	autoRun: { api: Pick<AutoRunApi, 'launch' | 'stop'>; holds(agentId: string): boolean };
	options?: RuntimeTurnOptions;
	now?: () => number;
}

export interface RuntimeGroupChats {
	readonly api: GroupChatsApi;
	/** Rounds in flight now: chats whose moderator or a participant is working. */
	roundsInFlight(): number;
	/** Stop every round and every Auto Run a chat started. For shutdown, and for a lost data directory. */
	stopAll(): Promise<void>;
	/** Wait for the store's queued writes. Call before the lock is released. */
	drain(): Promise<void>;
	/** The chat store, for the consult path's and a test's reads. */
	readonly store: GroupChatStore;
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

const errorText = (error: unknown): string =>
	error instanceof Error ? error.message : String(error);

/** The text a store throws for a chat that is gone. */
const isMissingChat = (error: unknown): boolean => /Group chat not found/i.test(errorText(error));

/** A run's last counts, kept while it runs so its end can say what it amounted to. */
interface RunFigures {
	completedTasks: number;
	totalTasks: number;
	documentsProcessed: number;
	wasStopped: boolean;
}

/** Longest a chat's name may be, as the desktop's rename allows. */
const MAX_CHAT_NAME_LENGTH = 255;

export function createRuntimeGroupChats(options: RuntimeGroupChatsOptions): RuntimeGroupChats {
	const { paths, repository, bus, registry, background, metrics } = options;
	const now = options.now ?? (() => Date.now());
	const host = options.options ?? {};

	const store = createGroupChatStore({
		groupChatsDir: () => paths.groupChatsDir,
		// A runtime that lost the data directory stops writing (GD21), as the repository does.
		beforeWrite: () => {
			const verdict = options.fence();
			if (!verdict.ok) throw new Error(verdict.reason);
		},
	});

	// -----------------------------------------------------------------------
	// What a client sees of a room: its state, who is working, and the events
	// -----------------------------------------------------------------------

	const states = new Map<string, GroupChatTurnState>();
	const working = new Map<string, Set<string>>();

	const emit = (chatId: string, event: GroupChatEvent): void => {
		bus.emit({ type: 'groupChat', chatId, event });
	};

	const stateOf = (chatId: string): GroupChatTurnState => states.get(chatId) ?? 'idle';

	/** The ten UI updates a round raises. Four have a client event; the rest have no view headless (W4). */
	const sink: GroupChatEventSink = {
		message: (chatId, message: GroupChatMessage) => {
			const line = parseGroupChatLine(message);
			if (line) emit(chatId, { kind: 'message', at: now(), line });
		},
		stateChange: (chatId, state) => {
			states.set(chatId, state);
			if (state === 'idle') working.delete(chatId);
			emit(chatId, { kind: 'state', at: now(), state });
		},
		participantState: (chatId, name, state) => {
			const names = working.get(chatId) ?? new Set<string>();
			if (state === 'working') names.add(name);
			else names.delete(name);
			working.set(chatId, names);
			emit(chatId, { kind: 'participant', at: now(), name, working: state === 'working' });
		},
		participantsChanged: (chatId, participants) => {
			emit(chatId, {
				kind: 'participants',
				at: now(),
				participants: participants.map((participant) => ({
					sessionId: participant.sessionId,
					name: participant.name,
					provider: participant.agentId,
				})),
			});
		},
		moderatorUsage: () => {},
		historyEntry: () => {},
		moderatorSessionIdChanged: () => {},
		autoRunBatchComplete: () => {},
		participantLiveOutput: () => {},
		autoRunTriggered: (chatId, participantName, filename) => {
			void startParticipantAutoRun(chatId, participantName, filename);
		},
	};

	// -----------------------------------------------------------------------
	// The engine's ports
	// -----------------------------------------------------------------------

	const agentConfigs = (): Record<string, Record<string, unknown>> => {
		const read = readAgentConfigsStore(paths.agentConfigsFile);
		return read.status === 'ok'
			? ((read.data.configs ?? {}) as Record<string, Record<string, unknown>>)
			: {};
	};

	const directory: GroupChatAgentDirectory = {
		list: () =>
			repository.listAgents().map((agent) =>
				toGroupChatSessionInfo(agent as unknown as MentionableSession, {
					sshRemoteName: (remoteId) =>
						background.sshStore.getSshRemotes().find((remote) => remote.id === remoteId)?.name,
					// Live liveness: a chat turn on any of the agent's tabs, or an Auto Run holding its tree.
					// A group chat's own processes are not the agent's (GD20), so they never count.
					isBusy: registry.isBusy(agent.id) || options.autoRun.holds(agent.id),
				})
			),
		providerConfig: (providerId) => agentConfigs()[providerId] ?? {},
		providerEnvVars: (providerId) =>
			agentConfigs()[providerId]?.customEnvVars as Record<string, string> | undefined,
		conductorProfile: () => {
			const settings = readSettingsStore(paths.settingsFile);
			const profile = settings.status === 'ok' ? settings.data.conductorProfile : undefined;
			return typeof profile === 'string' ? profile : '';
		},
		sshStore: () => background.sshStore,
	};

	// Read lazily: a runtime that never runs a chat should not go looking for the bundled prompts.
	let promptLoader: ReturnType<typeof createPromptLoaderFor>;
	let promptLoaderResolved = false;
	const loaderFor = (): ReturnType<typeof createPromptLoaderFor> => {
		if (!promptLoaderResolved) {
			promptLoader = createPromptLoaderFor({
				userDataDir: paths.userDataDir,
				...(host.bundledPromptsDir ? { bundledPromptsDir: host.bundledPromptsDir } : {}),
				...(host.moduleDirectory ? { moduleDirectory: host.moduleDirectory } : {}),
			});
			promptLoaderResolved = true;
		}
		return promptLoader;
	};

	const engine = createGroupChatEngine({
		store,
		events: sink,
		agents: directory,
		prompts: {
			// A prompt that does not load throws, as the desktop's does: the turn fails through the
			// engine's spawn-failure path instead of running without its system prompt.
			get: (id: GroupChatPromptId) => {
				const text = loaderFor()?.get(id);
				if (text === undefined) throw new Error(`The prompt "${id}" could not be loaded.`);
				return text;
			},
		},
		// No sleep to block on a host with no window.
		power: { block: () => {}, unblock: () => {} },
		metrics,
	});

	/** Where a group chat's process id belongs. */
	const chatIdOf = (processId: string): string | undefined =>
		parseModeratorSessionId(processId) ?? parseParticipantSessionId(processId)?.groupChatId;

	const launcher: GroupChatLauncher = {
		runner: background.groupChatRunner({
			chatIdOf,
			onActivity: (processId) => engine.noteActivity(processId),
			onOutput: (processId, chunk) => engine.liveOutput(processId, chunk),
			onSessionId: (processId, sessionId) => engine.sessionAnnounced(processId, sessionId),
			onUsage: (processId, usage) => engine.usageReported(processId, usage),
			onEnd: (processId, completed) => engine.turnEnded(turnEndOf(processId, completed), launcher),
		}),
		resolveAgent: (providerId) => background.resolveAgent(providerId),
	};

	const operations = createGroupChatOperations({
		store,
		engine,
		launcher: () => launcher,
		events: sink,
		chatState: stateOf,
	});

	// -----------------------------------------------------------------------
	// !autorun: a participant's Auto Run, run through the Phase 7 service (GD12)
	// -----------------------------------------------------------------------

	/** The agents whose Auto Run a chat started, so Stop reaches them. */
	const chatRuns = new Map<string, Set<string>>();

	/** Close the participant out of the round with what the run said, or why it could not start. */
	async function finishParticipantRun(
		chatId: string,
		participantName: string,
		summary: string
	): Promise<void> {
		try {
			await engine.autoRunCompleted(chatId, participantName, summary, launcher);
		} catch (error) {
			logger.error(
				`Closing out ${participantName}'s Auto Run failed: ${errorText(error)}`,
				LOG_CONTEXT
			);
		}
	}

	async function startParticipantAutoRun(
		chatId: string,
		participantName: string,
		filename: string | undefined
	): Promise<void> {
		const session = findSessionForParticipantName(participantName, directory.list());
		const agent = session ? repository.getAgent(session.id) : undefined;
		const folder = agent ? resolveAutoRunFolder(agent) : undefined;
		if (!session || !agent || !folder) {
			await finishParticipantRun(
				chatId,
				participantName,
				`Auto Run could not start: no agent named ${participantName} has an Auto Run folder.`
			);
			return;
		}

		let files: string[];
		if (filename) {
			files = [path.join(folder, /\.md$/i.test(filename) ? filename : `${filename}.md`)];
		} else {
			const listing = listAutoRunDocuments(folder);
			files =
				listing.status === 'ok'
					? listing.documents.filter((document) => document.unchecked > 0).map((d) => d.file)
					: [];
		}

		// Watch before launching, so a run that ends at once is still seen end.
		const figures: RunFigures = {
			completedTasks: 0,
			totalTasks: 0,
			documentsProcessed: 0,
			wasStopped: false,
		};
		let ended: () => void = () => {};
		const unsubscribe = bus.subscribe(
			(event) => {
				if (event.type !== 'autorun' || event.event.kind !== 'state') return;
				const progress = event.event.state;
				if (progress === null) {
					ended();
					return;
				}
				figures.completedTasks = progress.tasksDone;
				figures.totalTasks = progress.tasksTotal;
				figures.documentsProcessed = progress.documents.length;
				if (progress.isStopping) figures.wasStopped = true;
			},
			{ types: ['autorun'], agentId: agent.id }
		);
		const finished = new Promise<void>((resolve) => {
			ended = resolve;
		});

		const launched =
			files.length === 0
				? ({
						ok: false,
						error: {
							code: 'rejected',
							message: 'There are no Auto Run documents with unchecked tasks.',
							method: 'autoRun.launch',
						},
					} satisfies ClientResult<never>)
				: await options.autoRun.api.launch(agent.id, {
						documents: files.map((file) => ({ file })),
					});
		if (!launched.ok) {
			unsubscribe();
			await finishParticipantRun(
				chatId,
				participantName,
				`Auto Run could not start for ${participantName}: ${launched.error.message}`
			);
			return;
		}

		const set = chatRuns.get(chatId) ?? new Set<string>();
		set.add(agent.id);
		chatRuns.set(chatId, set);
		await finished;
		unsubscribe();
		set.delete(agent.id);
		if (set.size === 0) chatRuns.delete(chatId);
		await finishParticipantRun(chatId, participantName, groupChatAutoRunSummary(figures));
	}

	// -----------------------------------------------------------------------
	// Reading a chat
	// -----------------------------------------------------------------------

	function recordOf(chat: GroupChat, lines: GroupChatLine[]): GroupChatRecord {
		return {
			id: chat.id,
			name: chat.name,
			moderatorProvider: chat.moderatorAgentId,
			participants: chat.participants.map((participant) => ({
				sessionId: participant.sessionId,
				name: participant.name,
				provider: participant.agentId,
			})),
			state: stateOf(chat.id),
			working: [...(working.get(chat.id) ?? [])],
			archived: chat.archived === true,
			lines,
		};
	}

	async function linesOf(chat: GroupChat): Promise<GroupChatLine[]> {
		const messages = await readLog(chat.logPath);
		return mergeGroupChatLines(
			[],
			messages
				.map((message) => parseGroupChatLine(message))
				.filter((line): line is GroupChatLine => line !== undefined)
		);
	}

	// -----------------------------------------------------------------------
	// The API
	// -----------------------------------------------------------------------

	const api: GroupChatsApi = {
		list: async () => {
			try {
				const chats = await store.listGroupChats();
				return ok(chats.map((chat) => recordOf(chat, [])));
			} catch (error) {
				return fail(
					'groupChats.list',
					'failed',
					`The chats could not be read: ${errorText(error)}`
				);
			}
		},

		get: async (chatId) => {
			try {
				const chat = await store.loadGroupChat(chatId);
				if (!chat) return fail('groupChats.get', 'not-found', `No group chat ${chatId}.`);
				return ok(recordOf(chat, await linesOf(chat)));
			} catch (error) {
				return fail('groupChats.get', 'failed', `The chat could not be read: ${errorText(error)}`);
			}
		},

		create: async (input) => {
			const method: ClientMethod = 'groupChats.create';
			const checked = validateGroupChatCreate(input);
			if (!checked.ok) return fail(method, 'invalid', checked.reason);
			const agents = repository.listAgents();
			// The host moderates with a provider: a named one wins, else the named agent's, else the first participant's.
			let moderatorProvider = input.moderatorProvider;
			if (!moderatorProvider && input.moderatorAgentId) {
				const moderator = agents.find((agent) => agent.id === input.moderatorAgentId);
				if (!moderator) return fail(method, 'not-found', `No agent ${input.moderatorAgentId}.`);
				moderatorProvider = moderator.toolType;
			}
			const plan = planGroupChatStart(checked.value.participantIds, agents, moderatorProvider);
			if (!plan.ok) {
				return fail(
					method,
					/^Unknown agent/.test(plan.error) ? 'not-found' : 'invalid',
					plan.error
				);
			}

			let chat: GroupChat;
			try {
				chat = await operations.createChat({
					name: checked.value.name,
					moderatorProvider: plan.moderatorProvider,
				});
			} catch (error) {
				return fail(method, 'failed', errorText(error));
			}

			// Participants join the way they do when a user types `@name`: the opening message
			// mentions each one and the engine adds them with their full agent config.
			const opening = withParticipantMentions(
				checked.value.message ?? checked.value.name,
				plan.participants.map((participant) => participant.name)
			);
			try {
				await operations.sendUserMessage(chat.id, opening);
			} catch (error) {
				return fail(
					method,
					'failed',
					`The chat was created, but the opening message failed: ${errorText(error)}`
				);
			}
			return ok({ chatId: chat.id });
		},

		send: async (chatId, message) => {
			const method: ClientMethod = 'groupChats.send';
			if (!message.trim()) return fail(method, 'invalid', 'The message is empty.');
			const chat = await store.loadGroupChat(chatId).catch(() => null);
			if (!chat) return fail(method, 'not-found', `No group chat ${chatId}.`);
			// One round at a time (B22). The message is not queued: a library client has no queue (GD14).
			if (stateOf(chatId) !== 'idle') {
				return fail(
					method,
					'rejected',
					'The chat is still working. Send again when it finishes, or stop it first.'
				);
			}
			try {
				await operations.sendUserMessage(chatId, message);
				return ok(undefined);
			} catch (error) {
				return fail(method, isMissingChat(error) ? 'not-found' : 'failed', errorText(error));
			}
		},

		stop: async (chatId) => {
			const method: ClientMethod = 'groupChats.stop';
			if (!(await store.loadGroupChat(chatId).catch(() => null))) {
				return fail(method, 'not-found', `No group chat ${chatId}.`);
			}
			try {
				await stopChat(chatId);
				return ok(undefined);
			} catch (error) {
				return fail(method, 'failed', errorText(error));
			}
		},

		rename: async (chatId, name) => {
			const method: ClientMethod = 'groupChats.rename';
			const trimmed = name.trim();
			if (!trimmed) return fail(method, 'invalid', 'The name cannot be empty.');
			if (trimmed.length > MAX_CHAT_NAME_LENGTH) {
				return fail(method, 'invalid', `Names are at most ${MAX_CHAT_NAME_LENGTH} characters.`);
			}
			try {
				await operations.renameChat(chatId, trimmed);
				return ok(undefined);
			} catch (error) {
				return fail(method, isMissingChat(error) ? 'not-found' : 'failed', errorText(error));
			}
		},

		remove: async (chatId) => {
			const method: ClientMethod = 'groupChats.remove';
			if (!(await store.loadGroupChat(chatId).catch(() => null))) {
				return fail(method, 'not-found', `No group chat ${chatId}.`);
			}
			try {
				await stopChat(chatId);
				await operations.deleteChat(chatId);
				states.delete(chatId);
				working.delete(chatId);
				return ok(undefined);
			} catch (error) {
				return fail(method, 'failed', errorText(error));
			}
		},
	};

	/** Everything a chat has running: its round, and any Auto Run it started in a participant. */
	async function stopChat(chatId: string): Promise<void> {
		for (const agentId of [...(chatRuns.get(chatId) ?? [])]) {
			await options.autoRun.api.stop(agentId);
		}
		await operations.stopAll(chatId);
	}

	return {
		api,
		roundsInFlight: () => [...states.values()].filter((state) => state !== 'idle').length,
		stopAll: async () => {
			for (const chatId of [...states.keys()]) {
				if (stateOf(chatId) === 'idle' && !chatRuns.has(chatId)) continue;
				await stopChat(chatId).catch((error) => {
					logger.warn(`Stopping chat ${chatId} failed: ${errorText(error)}`, LOG_CONTEXT);
				});
			}
		},
		drain: () => store.drain(),
		store,
	};
}
