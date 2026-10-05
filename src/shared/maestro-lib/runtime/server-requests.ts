/**
 * The requests a detached host answers: the desktop bridge's typed messages, run against a
 * `MaestroClient`.
 *
 * `createWsMaestroClient` turns each client method into one of these messages; this turns each
 * message back into the method. The two are written against the same table (section 5 of
 * `Plans/maestro-tui-client-api.md`), so a request here is spelled the way that client sends it and
 * a reply carries the keys that client reads (`success`, `error`, the `*_result` type).
 *
 * It takes any `MaestroClient`, never the runtime: the transport adds the request id, the pushes,
 * and the host's own control messages. A message it does not know returns `undefined`, which the
 * transport answers with the bridge's `echo`, the signal a client reads as "unsupported".
 */

import type { AgentRecord } from '../store/records';
import { parseProcessId } from '../client/bridge-frames';
import type {
	AgentPatch,
	ClientResult,
	MaestroClient,
	ProviderInfo,
	TabPatch,
} from '../client/types';
import { groupChatToWire, type Frame } from './server-frames';

type Request = Record<string, unknown>;

const str = (value: unknown): string | undefined =>
	typeof value === 'string' && value !== '' ? value : undefined;
const bool = (value: unknown): boolean | undefined =>
	typeof value === 'boolean' ? value : undefined;
const num = (value: unknown): number | undefined =>
	typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const obj = (value: unknown): Record<string, unknown> | undefined =>
	typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;

/** The error text a reply carries. A missing thing says "not found", which is how a client tells it from a failure. */
function errorText(result: Extract<ClientResult<unknown>, { ok: false }>): string {
	const { code, message } = result.error;
	return code === 'not-found' && !/not found/i.test(message) ? `Not found: ${message}` : message;
}

/** A `{ success }` reply for any result, with `extra` merged in on success. */
function outcome<T>(
	type: string,
	result: ClientResult<T>,
	extra: (value: T) => Frame = () => ({})
): Frame {
	return result.ok
		? { type, success: true, ...extra(result.value) }
		: { type, success: false, error: errorText(result) };
}

// ---------------------------------------------------------------------------
// Wire patches back to the client's patches
// ---------------------------------------------------------------------------

/** The inverse of `buildAgentConfigPatch`: the record-keyed config keys back to an `AgentPatch`. */
export function agentPatchFromConfig(config: Record<string, unknown>): AgentPatch {
	const patch: Record<string, unknown> = {};
	const take = (from: string, to: keyof AgentPatch): void => {
		if (from in config) patch[to] = config[from];
	};
	take('toolType', 'provider');
	take('customModel', 'model');
	take('customEffort', 'effort');
	take('customContextWindow', 'contextWindow');
	take('customPath', 'customPath');
	take('customArgs', 'customArgs');
	take('customEnvVars', 'env');
	take('nudgeMessage', 'nudgeMessage');
	take('newSessionMessage', 'newSessionMessage');
	take('bookmarked', 'bookmarked');
	// DG6: what the desktop's Edit Agent writes beyond the CLI's fields.
	take('customProviderPath', 'customProviderPath');
	take('customEnvVarsDisabled', 'envDisabled');
	take('additionalDirectories', 'additionalDirectories');
	take('retryOnAvailabilityErrors', 'retryOnAvailabilityErrors');
	take('retryOnTokenExhaustion', 'retryOnTokenExhaustion');
	take('codexAutoResetOnExhaustion', 'codexAutoResetOnExhaustion');
	take('enableMaestroP', 'enableMaestroP');
	take('maestroPPath', 'maestroPPath');
	take('maestroPMode', 'maestroPMode');
	return patch as AgentPatch;
}

/** The inverse of `buildTabConfigPatch`. */
export function tabPatchFromConfig(config: Record<string, unknown>): TabPatch {
	const patch: Record<string, unknown> = {};
	const take = (from: string, to: keyof TabPatch): void => {
		if (from in config) patch[to] = config[from];
	};
	take('readOnlyMode', 'readOnly');
	take('showThinking', 'thinking');
	take('customModel', 'model');
	take('customEffort', 'effort');
	take('saveToHistory', 'saveToHistory');
	take('enterToSend', 'enterToSend');
	return patch as TabPatch;
}

// ---------------------------------------------------------------------------
// The IPC channels a client invokes (`bridge.invoke`)
// ---------------------------------------------------------------------------

class UnhandledChannel extends Error {
	constructor(channel: string) {
		super(`No ipcMain handler registered for '${channel}'`);
	}
}

function orThrow<T>(result: ClientResult<T>): T {
	if (!result.ok) throw new Error(errorText(result));
	return result.value;
}

/** A desktop process id to the tab it names; the legacy `<agentId>-ai` id means the active tab. */
async function tabOfProcess(
	client: MaestroClient,
	processId: unknown
): Promise<{ agentId: string; tabId: string } | undefined> {
	const target = typeof processId === 'string' ? parseProcessId(processId) : null;
	if (!target) return undefined;
	if (target.kind === 'tab') return { agentId: target.agentId, tabId: target.tabId };
	const agent = await client.agents.get(target.agentId);
	const tabId = agent.ok ? str(agent.value.activeTabId) : undefined;
	return tabId ? { agentId: target.agentId, tabId } : undefined;
}

async function stopTab(client: MaestroClient, processId: unknown): Promise<boolean> {
	const tab = await tabOfProcess(client, processId);
	if (!tab) return false;
	const result = await client.turns.interrupt(tab.agentId, tab.tabId);
	return result.ok && result.value.stopped;
}

function detectionEntry(provider: ProviderInfo): Record<string, unknown> {
	return {
		id: provider.id,
		name: provider.name,
		available: provider.available,
		...(provider.path ? { path: provider.path } : {}),
		...(provider.unavailableReason ? { error: provider.unavailableReason } : {}),
		...(provider.version ? { snapshot: { version: provider.version } } : {}),
	};
}

async function invokeChannel(
	client: MaestroClient,
	channel: string,
	args: unknown[]
): Promise<unknown> {
	switch (channel) {
		case 'sessions:getBootstrap':
			return orThrow(await client.agents.list());
		case 'groups:getAll':
			return orThrow(await client.groups.list());
		case 'sessions:getDeferredContent': {
			const agentId = str(args[0]);
			const tabId = str(args[1]);
			if (!agentId || !tabId) throw new Error('An agent and a tab are required.');
			return { logs: orThrow(await client.tabs.transcript(agentId, tabId)) };
		}
		case 'process:interrupt':
		case 'process:kill':
			return stopTab(client, args[0]);
		case 'settings:get': {
			const key = str(args[0]);
			if (!key) throw new Error('A settings key is required.');
			return orThrow(await client.settings.get([key]))[key];
		}
		// The desktop's Left Bar rename and delete have no bridge message of their own (gap G15), so a
		// client reaches them through the IPC channels the desktop's own UI calls.
		case 'groupChat:rename': {
			const chatId = str(args[0]);
			const name = typeof args[1] === 'string' ? args[1] : '';
			if (!chatId) throw new Error('A chat is required.');
			orThrow(await client.groupChats.rename(chatId, name));
			return { id: chatId, name: name.trim() };
		}
		case 'groupChat:delete': {
			const chatId = str(args[0]);
			if (!chatId) throw new Error('A chat is required.');
			orThrow(await client.groupChats.remove(chatId));
			return true;
		}
		case 'ssh-remote:getConfigs':
			return { success: true, configs: orThrow(await client.settings.sshRemotes()) };
		case 'agents:detect': {
			const sshRemoteId = str(args[0]);
			return orThrow(await client.providers.list(sshRemoteId ? { sshRemoteId } : undefined)).map(
				detectionEntry
			);
		}
		case 'agents:getAllSnapshots':
			// Versions ride the detection entries; there is no persisted snapshot map to read here.
			return {};
		case 'agents:getModels': {
			const providerId = str(args[0]);
			if (!providerId) throw new Error('A provider is required.');
			const sshRemoteId = str(args[2]);
			return orThrow(
				await client.providers.models(providerId, {
					refresh: args[1] === true,
					...(sshRemoteId ? { sshRemoteId } : {}),
				})
			);
		}
		default:
			throw new UnhandledChannel(channel);
	}
}

// ---------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------

/** `get_sessions`' projection: what `reconcile` reads (`SessionData`, no config fields). */
async function projectSessions(client: MaestroClient): Promise<Frame[]> {
	const agents = await client.agents.list();
	if (!agents.ok) return [];
	return Promise.all(
		agents.value.map(async (agent: AgentRecord) => {
			const tabs = await client.tabs.list(agent.id);
			return {
				id: agent.id,
				name: agent.name,
				toolType: agent.toolType,
				...(agent.state ? { state: agent.state } : {}),
				...(typeof agent.inputMode === 'string' ? { inputMode: agent.inputMode } : {}),
				...(agent.cwd ? { cwd: agent.cwd } : {}),
				groupId: agent.groupId ?? null,
				...(agent.bookmarked !== undefined ? { bookmarked: agent.bookmarked } : {}),
				...(typeof agent.activeTabId === 'string' ? { activeTabId: agent.activeTabId } : {}),
				aiTabs: (tabs.ok ? tabs.value : []).map((tab) => ({
					id: tab.id,
					agentSessionId: tab.agentSessionId ?? null,
					name: tab.name ?? null,
					...(tab.starred !== undefined ? { starred: tab.starred } : {}),
					...(tab.state ? { state: tab.state } : {}),
					...(tab.hasUnread !== undefined ? { hasUnread: tab.hasUnread } : {}),
					...(tab.usageStats !== undefined ? { usageStats: tab.usageStats } : {}),
					...(tab.createdAt !== undefined ? { createdAt: tab.createdAt } : {}),
				})),
			};
		})
	);
}

export type RequestHandler = (message: Request) => Promise<Frame | undefined>;

/** Answer the desktop bridge's typed messages with `client`. */
export function createRequestHandler(client: MaestroClient): RequestHandler {
	const sessionId = (message: Request): string => str(message.sessionId) ?? '';

	return async (message) => {
		switch (message.type) {
			case 'ping':
				return { type: 'pong' };

			case 'get_sessions':
				return { type: 'sessions_list', sessions: await projectSessions(client) };

			case 'bridge.invoke': {
				const channel = str(message.channel) ?? '';
				const args = Array.isArray(message.args) ? message.args : [];
				try {
					return {
						type: 'bridge.response',
						ok: true,
						result: await invokeChannel(client, channel, args),
					};
				} catch (error) {
					return {
						type: 'bridge.response',
						ok: false,
						error: error instanceof Error ? error.message : String(error),
					};
				}
			}

			// -- agents -----------------------------------------------------
			case 'create_session': {
				const result = await client.agents.create({
					name: str(message.name) ?? '',
					provider: str(message.toolType) ?? '',
					cwd: str(message.cwd) ?? '',
					...(str(message.groupId) ? { groupId: str(message.groupId) } : {}),
					...(str(message.customModel) ? { model: str(message.customModel) } : {}),
					...(str(message.customEffort) ? { effort: str(message.customEffort) } : {}),
					...(num(message.customContextWindow) !== undefined
						? { contextWindow: num(message.customContextWindow) }
						: {}),
					...(str(message.customPath) ? { customPath: str(message.customPath) } : {}),
					...(str(message.customArgs) ? { customArgs: str(message.customArgs) } : {}),
					...(obj(message.customEnvVars)
						? { env: obj(message.customEnvVars) as Record<string, string> }
						: {}),
					...(obj(message.sessionSshRemoteConfig)
						? { ssh: obj(message.sessionSshRemoteConfig) as never }
						: {}),
					...(str(message.autoRunFolderPath)
						? { autoRunFolderPath: str(message.autoRunFolderPath) }
						: {}),
					...(str(message.nudgeMessage) ? { nudgeMessage: str(message.nudgeMessage) } : {}),
					...(str(message.newSessionMessage)
						? { newSessionMessage: str(message.newSessionMessage) }
						: {}),
				});
				return outcome('create_session_result', result, (value) => ({ sessionId: value.agentId }));
			}
			case 'rename_session':
				return outcome(
					'rename_session_result',
					await client.agents.rename(sessionId(message), str(message.newName) ?? '')
				);
			case 'delete_session':
				return outcome('delete_session_result', await client.agents.remove(sessionId(message)));
			case 'update_session_cwd':
				return outcome(
					'update_session_cwd_result',
					await client.agents.update(sessionId(message), { cwd: str(message.newCwd) ?? '' })
				);
			case 'update_session_ssh':
				return outcome(
					'update_session_ssh_result',
					await client.agents.update(sessionId(message), {
						ssh: (obj(message.sshPatch) ?? {}) as never,
					})
				);
			case 'update_session_config': {
				const config = obj(message.configPatch) ?? {};
				const tabId = str(config.tabId);
				if (tabId) {
					const { tabId: _tab, ...rest } = config;
					return outcome(
						'update_session_config_result',
						await client.tabs.update(sessionId(message), tabId, tabPatchFromConfig(rest))
					);
				}
				return outcome(
					'update_session_config_result',
					await client.agents.update(sessionId(message), agentPatchFromConfig(config)),
					(receipt) => (receipt.notices ? { notices: receipt.notices } : {})
				);
			}
			case 'set_auto_run_folder':
				return outcome(
					'set_auto_run_folder_result',
					await client.agents.update(sessionId(message), {
						autoRunFolderPath: str(message.folderPath) ?? '',
					})
				);
			case 'move_session_to_group':
				return outcome(
					'move_session_to_group_result',
					await client.groups.moveAgent(sessionId(message), str(message.groupId) ?? null)
				);

			// -- groups -----------------------------------------------------
			case 'create_group':
				return outcome(
					'create_group_result',
					await client.groups.create({
						name: str(message.name) ?? '',
						...(str(message.emoji) ? { emoji: str(message.emoji) } : {}),
						...(str(message.parentGroupId) ? { parentGroupId: str(message.parentGroupId) } : {}),
					}),
					(value) => ({ groupId: value.groupId })
				);
			case 'rename_group':
				return outcome(
					'rename_group_result',
					await client.groups.rename(str(message.groupId) ?? '', str(message.name) ?? '')
				);
			case 'delete_group':
				return outcome(
					'delete_group_result',
					await client.groups.remove(str(message.groupId) ?? '')
				);

			// -- tabs -------------------------------------------------------
			case 'new_tab':
				return outcome('new_tab_result', await client.tabs.create(sessionId(message)), (value) => ({
					tabId: value.tabId,
				}));
			case 'rename_tab':
				return outcome(
					'rename_tab_result',
					await client.tabs.rename(
						sessionId(message),
						str(message.tabId) ?? '',
						typeof message.newName === 'string' ? message.newName : ''
					)
				);
			case 'close_tab':
				return outcome(
					'close_tab_result',
					await client.tabs.close(sessionId(message), str(message.tabId) ?? '')
				);
			case 'star_tab':
				return outcome(
					'star_tab_result',
					await client.tabs.star(
						sessionId(message),
						str(message.tabId) ?? '',
						bool(message.starred) ?? false
					)
				);

			// -- turns ------------------------------------------------------
			case 'enqueue_command': {
				const tabId = str(message.tabId) ?? '';
				const images = Array.isArray(message.images)
					? message.images.filter((image): image is string => typeof image === 'string')
					: undefined;
				const result = await client.turns.send(sessionId(message), tabId, {
					text: typeof message.command === 'string' ? message.command : '',
					...(images && images.length > 0 ? { images } : {}),
				});
				if (!result.ok) {
					return {
						type: 'enqueue_command_result',
						success: false,
						error: errorText(result),
						...(result.error.code === 'not-found' ? { reason: 'session-not-found' } : {}),
					};
				}
				const receipt = result.value;
				return receipt.status === 'queued'
					? {
							type: 'enqueue_command_result',
							success: true,
							tabId,
							queued: true,
							itemId: receipt.itemId,
							queuePosition: receipt.position,
							queueLength: receipt.queueLength,
						}
					: { type: 'enqueue_command_result', success: true, tabId, queued: false };
			}
			case 'list_queue': {
				const agentId = sessionId(message);
				const result = await client.turns.queue.list(agentId);
				return outcome('list_queue_result', result, (items) => ({
					queues: [
						{
							sessionId: agentId,
							items: items.map((item) => ({
								id: item.itemId,
								timestamp: item.queuedAt,
								tabId: item.tabId,
								type: item.kind,
								text: item.text,
								paused: item.paused,
							})),
						},
					],
				}));
			}
			case 'remove_queue_item':
				return outcome(
					'remove_queue_item_result',
					await client.turns.queue.remove(sessionId(message), str(message.itemId) ?? ''),
					(value) => ({ removed: value.removed })
				);

			// -- Auto Run ---------------------------------------------------
			case 'configure_auto_run': {
				const documents = Array.isArray(message.documents) ? message.documents : [];
				return outcome(
					'configure_auto_run_result',
					await client.autoRun.launch(sessionId(message), {
						documents: documents.flatMap((entry) => {
							const document = obj(entry);
							const file = str(document?.filename);
							return file
								? [
										{
											file,
											...(document?.resetOnCompletion === true ? { resetOnCompletion: true } : {}),
										},
									]
								: [];
						}),
						...(message.loopEnabled === true ? { loop: true } : {}),
						...(num(message.maxLoops) !== undefined ? { maxLoops: num(message.maxLoops) } : {}),
						...(str(message.model) ? { model: str(message.model) } : {}),
						...(str(message.effort) ? { effort: str(message.effort) } : {}),
					})
				);
			}
			case 'launch_goal_run': {
				const result = await client.autoRun.launchGoal(sessionId(message), {
					goal: typeof message.goal === 'string' ? message.goal : '',
					...(str(message.exitCriteria) ? { exitCriteria: str(message.exitCriteria) } : {}),
					...(message.maxIterations === null || num(message.maxIterations) !== undefined
						? { maxIterations: message.maxIterations as number | null }
						: {}),
					...(str(message.model) ? { model: str(message.model) } : {}),
					...(str(message.effort) ? { effort: str(message.effort) } : {}),
				});
				return outcome('launch_goal_run_result', result, (value) =>
					value.tabId ? { tabId: value.tabId } : {}
				);
			}
			case 'stop_auto_run':
				return outcome('stop_auto_run_result', await client.autoRun.stop(sessionId(message)));
			case 'resume_auto_run_error':
				return outcome(
					'resume_auto_run_error_result',
					await client.autoRun.resume(sessionId(message))
				);
			case 'skip_auto_run_document':
				return outcome(
					'skip_auto_run_document_result',
					await client.autoRun.skip(sessionId(message))
				);
			case 'abort_auto_run_error':
				return outcome(
					'abort_auto_run_error_result',
					await client.autoRun.abort(sessionId(message))
				);

			// -- group chats ------------------------------------------------
			case 'get_group_chats': {
				const chats = await client.groupChats.list();
				return {
					type: 'group_chats_list',
					chats: chats.ok ? chats.value.map(groupChatToWire) : [],
				};
			}
			case 'get_group_chat_state': {
				const chat = await client.groupChats.get(str(message.chatId) ?? '');
				return { type: 'group_chat_state', state: chat.ok ? groupChatToWire(chat.value) : null };
			}
			case 'start_group_chat': {
				const participantIds = Array.isArray(message.participantIds)
					? message.participantIds.filter((id): id is string => typeof id === 'string')
					: [];
				const result = await client.groupChats.create({
					name: typeof message.topic === 'string' ? message.topic : '',
					participantIds,
					// The wire names the moderator by PROVIDER: the host moderates with a provider, not an agent.
					...(str(message.moderatorAgentId)
						? { moderatorProvider: str(message.moderatorAgentId) }
						: {}),
					...(str(message.message) ? { message: str(message.message) } : {}),
				});
				return outcome('start_group_chat_result', result, (value) => ({ chatId: value.chatId }));
			}
			case 'send_group_chat_message':
				return outcome(
					'send_group_chat_message_result',
					await client.groupChats.send(
						str(message.chatId) ?? '',
						typeof message.message === 'string' ? message.message : ''
					)
				);
			case 'stop_group_chat':
				return outcome(
					'stop_group_chat_result',
					await client.groupChats.stop(str(message.chatId) ?? '')
				);

			// -- consults ----------------------------------------------------
			// Waits as long as the answer takes: the caller's own timeout bounds it, not a delivery receipt.
			case 'cross_agent_ask': {
				const result = await client.consults.ask({
					targetAgentId: sessionId(message),
					question: typeof message.question === 'string' ? message.question : '',
					...(str(message.fromSessionId) ? { fromAgentId: str(message.fromSessionId) } : {}),
					...(str(message.fromTabId) ? { fromTabId: str(message.fromTabId) } : {}),
					withContext: message.withContext === true,
					...(num(message.timeoutMs) !== undefined ? { timeoutMs: num(message.timeoutMs) } : {}),
				});
				if (result.ok) {
					return {
						type: 'cross_agent_ask_result',
						success: true,
						answer: result.value.answer,
						...(result.value.agentName ? { targetAgentName: result.value.agentName } : {}),
					};
				}
				// A consult the caller's Stop ended is not the target failing to answer.
				const stopped =
					result.error.code === 'rejected' && /was stopped/i.test(result.error.message);
				return {
					type: 'cross_agent_ask_result',
					success: false,
					error: errorText(result),
					...(stopped ? { canceled: true } : {}),
				};
			}

			default:
				return undefined;
		}
	};
}
