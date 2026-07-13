import {
	encodeBase64,
	MAX_OMP_IMAGE_BYTES,
	MAX_OMP_PROMPT_ATTACHMENT_BYTES,
	sha256Hex,
} from './byte-codec';
import type {
	InteractiveRuntimeHandle,
	JsonValue,
	MaestroInteractivePanelOwnerApi,
	MaestroSdk,
	MaestroWorkspaceApi,
	PanelRequest,
} from '@maestro/plugin-sdk';
import { OmpProtocolError, OmpRpcClient } from './rpc-client';
import { OmpWorkspaceController } from './workspace-controller';
import type { OmpRpcCommand, OmpRpcEvent, OmpRpcTransport, OmpSessionState } from './types';

const SHA256_HEX = /^[a-f0-9]{64}$/;

type ActivationSdk = Pick<MaestroSdk, 'workspace' | 'interactivePanel' | 'interactiveRuntime'>;
type ExternalSessionStatus =
	| 'starting'
	| 'idle'
	| 'working'
	| 'waiting_for_input'
	| 'waiting_for_approval'
	| 'retrying'
	| 'completed'
	| 'aborted'
	| 'failed'
	| 'offline';

const OMP_IMAGE_MEDIA_TYPES: Readonly<Record<string, true>> = {
	'image/gif': true,
	'image/jpeg': true,
	'image/png': true,
	'image/webp': true,
};

interface ActiveRuntime {
	readonly handle: InteractiveRuntimeHandle;
	readonly client: OmpRpcClient;
	readonly controller: OmpWorkspaceController;
	unsubscribe: () => void;
	unsubscribeMessages: () => void;
	unsubscribeEvents: () => void;
	unsubscribeProjection: () => void;
	unsubscribeCallbacks: () => void;
	unsubscribeFailure: () => void;
	readonly generation: bigint;
	status: ExternalSessionStatus;
	pendingApproval: boolean;
	composerMode: 'build' | 'plan' | 'ask';
}

interface ActivePlugin {
	readonly sdk: ActivationSdk;
	readonly workspace: MaestroWorkspaceApi;
	unsubscribePanel: () => void;
	readonly panel: MaestroInteractivePanelOwnerApi;
	generation: number;
	panelSequence: bigint;
	starting?: Promise<boolean>;
	runtime?: ActiveRuntime;
}

let active: ActivePlugin | undefined;

/** Registers only a setup projection; filesystem-root consent is deferred to an explicit panel action. */
export async function activate(sdk: ActivationSdk): Promise<void> {
	if (active) throw new Error('OMP plugin is already active');
	if (!sdk.interactiveRuntime || !sdk.workspace || !sdk.interactivePanel) {
		throw new Error('OMP workspace, panel, or interactive runtime capability is unavailable');
	}
	const candidate: ActivePlugin = {
		sdk,
		workspace: sdk.workspace,
		panel: sdk.interactivePanel,
		unsubscribePanel: () => undefined,
		generation: 0,
		panelSequence: 0n,
	};
	try {
		await candidate.workspace.publishExternalSessions(1, []);
		await candidate.workspace.setStatus({ state: 'offline', label: 'OMP setup required' });
		await candidate.workspace.setBadge(null);
		candidate.unsubscribePanel = candidate.panel.onRequest((request) => {
			void handlePanelRequest(candidate, request);
		});
		active = candidate;
	} catch (error) {
		await candidate.workspace.publishExternalSessions(2, []).catch(() => undefined);
		await candidate.workspace
			.setStatus({ state: 'error', label: 'OMP activation failed' })
			.catch(() => undefined);
		throw error;
	}
}

/** Called by the transport-owned panel endpoint for first explicit start/create action only. */
export async function startFromExplicitPanelAction(): Promise<boolean> {
	const current = active;
	if (!current) throw new Error('OMP plugin is not active');
	if (current.runtime) return true;
	if (current.starting) return current.starting;
	const runtime = current.sdk.interactiveRuntime;
	if (!runtime) throw new Error('OMP interactive runtime capability is unavailable');
	const attempt = startRuntime(current, runtime);
	current.starting = attempt;
	try {
		return await attempt;
	} finally {
		if (active === current) current.starting = undefined;
	}
}

export async function deactivate(): Promise<void> {
	const current = active;
	if (!current) return;
	active = undefined;
	current.unsubscribePanel();
	await disposeRuntime(current, 'workspace-deactivated');
	await current.workspace.publishExternalSessions(++current.generation, []).catch(() => undefined);
	await current.workspace
		.setStatus({ state: 'offline', label: 'OMP offline' })
		.catch(() => undefined);
	await current.workspace.setBadge(null).catch(() => undefined);
}

async function startRuntime(
	current: ActivePlugin,
	runtimeApi: NonNullable<ActivationSdk['interactiveRuntime']>
): Promise<boolean> {
	const workspaceRoot = await runtimeApi.requestWorkspaceRoot();
	if (!workspaceRoot) return false;
	if (active !== current) return false;
	await current.workspace.setStatus({ state: 'connecting', label: 'OMP starting' });
	const handle = await runtimeApi.startOmpRuntime({ workspaceRoot, options: { restore: false } });
	if (active !== current) {
		await handle.stop('revoked').catch(() => undefined);
		return false;
	}
	const startedGeneration = handle.generation;
	const frameListeners = new Set<(frame: string) => void>();
	const diagnosticListeners = new Set<(diagnostic: string) => void>();
	const closedListeners = new Set<(reason?: string) => void>();
	let lastMessageSequence = -1;
	let closed = false;
	const closeTransport = (reason?: string) => {
		if (closed) return;
		closed = true;
		for (const listener of closedListeners) listener(reason);
	};
	const transport: OmpRpcTransport = {
		send: async (frame) => {
			const value = parseCanonicalFrame(frame);
			await handle.writeCanonicalJson(value);
		},
		onFrame: (listener) => {
			frameListeners.add(listener);
			return () => frameListeners.delete(listener);
		},
		onDiagnostic: (listener) => {
			diagnosticListeners.add(listener);
			return () => diagnosticListeners.delete(listener);
		},
		onClosed: (listener) => {
			closedListeners.add(listener);
			return () => closedListeners.delete(listener);
		},
	};
	const client = new OmpRpcClient(transport);
	const tools = await handle.hostTools.catalog(handle.runtimeId);
	const controller = new OmpWorkspaceController(
		`omp:${handle.runtimeId}:${handle.generation}`,
		client,
		{
			tools,
			uriSchemes: [],
			brokers: {
				tools: {
					call: ({ id, toolName, arguments: argumentsValue }) =>
						handle.hostTools.call(handle.runtimeId, {
							id,
							name: toolName,
							arguments: argumentsValue,
						}),
					cancel: (callbackId) => {
						void handle.hostTools.cancel(handle.runtimeId, callbackId).catch(() => undefined);
					},
				},
			},
		}
	);
	const activeRuntime: ActiveRuntime = {
		handle,
		client,
		controller,
		unsubscribe: () => undefined,
		unsubscribeMessages: () => undefined,
		unsubscribeEvents: () => undefined,
		unsubscribeProjection: () => undefined,
		unsubscribeCallbacks: () => undefined,
		unsubscribeFailure: () => undefined,
		generation: startedGeneration,
		status: 'starting',
		pendingApproval: false,
		composerMode: 'build',
	};
	current.runtime = activeRuntime;
	activeRuntime.unsubscribeProjection = controller.onEvent((event) => {
		void projectOmpEvent(current, activeRuntime, event);
	});
	activeRuntime.unsubscribeCallbacks = controller.onCallback((callback) => {
		void projectOmpCallback(current, activeRuntime, callback);
	});
	activeRuntime.unsubscribeFailure = client.onFailure(() => {
		void endRuntime(current, activeRuntime, 'failed');
	});
	activeRuntime.unsubscribeMessages = handle.onMessage((message) => {
		if (
			active !== current ||
			current.runtime !== activeRuntime ||
			handle.generation !== startedGeneration ||
			!Number.isSafeInteger(message.sequence) ||
			message.sequence <= lastMessageSequence
		) {
			return;
		}
		lastMessageSequence = message.sequence;
		const frame = JSON.stringify(message.value);
		for (const listener of frameListeners) listener(`${frame}\n`);
	});
	activeRuntime.unsubscribeEvents = handle.onEvent((event) => {
		if (
			active !== current ||
			current.runtime !== activeRuntime ||
			handle.generation !== startedGeneration
		)
			return;
		if (event.kind === 'exit') {
			closeTransport(event.code === null ? 'runtime exited' : `runtime exited (${event.code})`);
			void endRuntime(current, activeRuntime, event.code === 0 ? 'offline' : 'failed');
			return;
		}
		if (event.kind === 'safe_error') {
			for (const listener of diagnosticListeners) listener(`runtime safe error: ${event.class}`);
			void endRuntime(current, activeRuntime, 'failed');
		}
	});
	activeRuntime.unsubscribe = () => closeTransport('runtime detached');
	try {
		await controller.initialize();
		if (active !== current || current.runtime !== activeRuntime) {
			await disposeRuntime(current, 'revoked');
			return false;
		}
		activeRuntime.status = 'idle';
		await projectRuntime(current, activeRuntime, 'idle');
		return true;
	} catch (error) {
		await disposeRuntime(current, 'revoked');
		if (active === current) {
			await current.workspace
				.setStatus({ state: 'error', label: 'OMP protocol unavailable' })
				.catch(() => undefined);
		}
		throw error;
	}
}

async function disposeRuntime(
	current: ActivePlugin,
	reason: 'workspace-deactivated' | 'revoked'
): Promise<void> {
	const runtime = current.runtime;
	if (!runtime) return;
	current.runtime = undefined;
	runtime.controller.beginShutdown();
	runtime.unsubscribeCallbacks();
	runtime.unsubscribeProjection();
	runtime.unsubscribeEvents();
	runtime.unsubscribeMessages();
	runtime.unsubscribeFailure();
	runtime.unsubscribe();
	runtime.controller.markStopped();
	await runtime.handle.stop(reason).catch(() => undefined);
}

async function endRuntime(
	current: ActivePlugin,
	runtime: ActiveRuntime,
	status: 'offline' | 'failed'
): Promise<void> {
	if (active !== current || current.runtime !== runtime) return;
	await disposeRuntime(current, 'revoked');
	await current.workspace.publishExternalSessions(++current.generation, []).catch(() => undefined);
	await current.workspace.setStatus(workspaceStatus(status)).catch(() => undefined);
	await current.workspace.setBadge(null).catch(() => undefined);
}

async function projectOmpEvent(
	current: ActivePlugin,
	runtime: ActiveRuntime,
	event: OmpRpcEvent
): Promise<void> {
	if (active !== current || current.runtime !== runtime) return;
	switch (event.type) {
		case 'agent_start':
		case 'turn_start':
		case 'message_start':
		case 'tool_execution_start':
		case 'tool_execution_update':
		case 'auto_compaction_start':
			await projectRuntime(current, runtime, 'working');
			return;
		case 'auto_retry_start':
			await projectRuntime(current, runtime, 'retrying');
			return;
		case 'agent_end':
		case 'turn_end':
		case 'message_end':
		case 'tool_execution_end':
		case 'auto_compaction_end':
		case 'auto_retry_end':
			await projectRuntime(current, runtime, 'idle');
			return;
		case 'message_update': {
			const delta = textDelta(event);
			const sessionId = runtime.controller.selectedSessionId;
			if (sessionId && delta.length > 0)
				await emitPanel(current, 'omp.stream.delta', { sessionId, delta });
			return;
		}
		default:
			return;
	}
}

async function projectOmpCallback(
	current: ActivePlugin,
	runtime: ActiveRuntime,
	callback: { readonly type: string; readonly [key: string]: unknown }
): Promise<void> {
	if (active !== current || current.runtime !== runtime) return;
	if (callback.type !== 'extension_ui_request' || typeof callback.id !== 'string') return;
	const sessionId = runtime.controller.selectedSessionId;
	if (!sessionId) return;
	runtime.pendingApproval = true;
	await projectRuntime(current, runtime, 'waiting_for_approval');
	await emitPanel(current, 'omp.approval.required', { sessionId, requestId: callback.id });
}

function textDelta(event: OmpRpcEvent): string {
	if (typeof event.delta === 'string') return event.delta;
	if (typeof event.content === 'string') return event.content;
	const assistantEvent = event.assistantMessageEvent;
	if (!assistantEvent || typeof assistantEvent !== 'object' || Array.isArray(assistantEvent))
		return '';
	if (typeof assistantEvent.delta === 'string') return assistantEvent.delta;
	if (typeof assistantEvent.text === 'string') return assistantEvent.text;
	return typeof assistantEvent.content === 'string' ? assistantEvent.content : '';
}

async function handlePanelRequest(
	current: ActivePlugin,
	request: PanelRequest<string, JsonValue>
): Promise<void> {
	try {
		if (request.kind === 'omp.session.create' && !current.runtime) {
			const started = await startFromExplicitPanelAction();
			if (!started) {
				await current.panel.reject(request.requestId, 'cancelled');
				return;
			}
			await current.panel.resolve(request.requestId, request.kind, {});
			return;
		}
		const runtime = current.runtime;
		if (!runtime || active !== current || runtime.controller.state !== 'ready') {
			await current.panel.reject(request.requestId, 'runtime_stopped');
			return;
		}
		const outcome = await dispatchPanelRequest(current, runtime, request);
		await projectRuntime(current, runtime);
		await current.panel.resolve(request.requestId, request.kind, outcome);
	} catch (error) {
		await current.panel.reject(request.requestId, panelErrorCode(error));
	}
}

async function dispatchPanelRequest(
	current: ActivePlugin,
	runtime: ActiveRuntime,
	request: PanelRequest<string, JsonValue>
): Promise<JsonValue> {
	const payload = requireRecord(request.payload);
	const sessionId = readString(payload, 'sessionId');
	const command = await panelCommand(current.panel, request.kind, payload, sessionId);
	if (command) {
		const response = await runtime.controller.command(command);
		if (request.kind === 'omp.commands.refresh') return currentView(runtime);
		if (
			command.type === 'new_session' ||
			command.type === 'switch_session' ||
			command.type === 'branch' ||
			command.type === 'handoff' ||
			command.type === 'set_session_name' ||
			command.type === 'set_model' ||
			command.type === 'cycle_model' ||
			command.type === 'set_thinking_level' ||
			command.type === 'cycle_thinking_level' ||
			command.type === 'set_steering_mode' ||
			command.type === 'set_follow_up_mode' ||
			command.type === 'set_interrupt_mode' ||
			command.type === 'set_auto_compaction' ||
			command.type === 'set_auto_retry' ||
			command.type === 'set_todos'
		) {
			await runtime.controller.command({ type: 'get_state' });
		}
		return response.data === undefined ? {} : toJsonValue(response.data);
	}
	if (request.kind === 'omp.approval.resolve') {
		const requestId = readString(payload, 'requestId');
		const approved = payload.approved;
		if (!requestId || typeof approved !== 'boolean')
			throw new OmpProtocolError('invalid approval response');
		await runtime.controller.respond({
			type: 'extension_ui_response',
			id: requestId,
			confirmed: approved,
		});
		runtime.pendingApproval = false;
		return {};
	}
	if (request.kind === 'omp.composer.mode.set') {
		const mode = payload.mode;
		if (mode !== 'build' && mode !== 'plan' && mode !== 'ask')
			throw new OmpProtocolError('invalid composer mode');
		runtime.composerMode = mode;
		return {};
	}
	throw new OmpProtocolError(`unknown OMP panel request ${JSON.stringify(request.kind)}`);
}

async function panelCommand(
	panel: MaestroInteractivePanelOwnerApi,
	kind: string,
	payload: Record<string, JsonValue>,
	sessionId: string | undefined
): Promise<OmpRpcCommand | undefined> {
	const text = readString(payload, 'text');
	switch (kind) {
		case 'omp.session.create':
			return { type: 'new_session' };
		case 'omp.session.select':
			return sessionId ? { type: 'switch_session', sessionPath: sessionId } : undefined;
		case 'omp.prompt.send':
			return text
				? {
						type: 'prompt',
						message: text,
						images: await toOmpImages(
							panel,
							Array.isArray(payload.attachments) ? payload.attachments : undefined
						),
					}
				: undefined;
		case 'omp.steer.send':
			return text
				? {
						type: 'steer',
						message: text,
						images: await toOmpImages(
							panel,
							Array.isArray(payload.attachments) ? payload.attachments : undefined
						),
					}
				: undefined;
		case 'omp.followUp.send':
			return text
				? {
						type: 'follow_up',
						message: text,
						images: await toOmpImages(
							panel,
							Array.isArray(payload.attachments) ? payload.attachments : undefined
						),
					}
				: undefined;
		case 'omp.run.abort':
			return sessionId ? { type: 'abort' } : undefined;
		case 'omp.run.abortAndPrompt':
			return text
				? {
						type: 'abort_and_prompt',
						message: text,
						images: await toOmpImages(
							panel,
							Array.isArray(payload.attachments) ? payload.attachments : undefined
						),
					}
				: undefined;
		case 'omp.session.compact':
			return { type: 'compact', customInstructions: readString(payload, 'customInstructions') };
		case 'omp.session.branch':
			return readString(payload, 'entryId')
				? { type: 'branch', entryId: readString(payload, 'entryId')! }
				: undefined;
		case 'omp.session.handoff':
			return { type: 'handoff', customInstructions: readString(payload, 'customInstructions') };
		case 'omp.model.set':
			return readString(payload, 'provider') && readString(payload, 'modelId')
				? {
						type: 'set_model',
						provider: readString(payload, 'provider')!,
						modelId: readString(payload, 'modelId')!,
					}
				: undefined;
		case 'omp.model.cycle':
			return sessionId ? { type: 'cycle_model' } : undefined;
		case 'omp.thinking.set':
			return isThinkingLevel(payload.level)
				? { type: 'set_thinking_level', level: payload.level }
				: undefined;
		case 'omp.thinking.cycle':
			return sessionId ? { type: 'cycle_thinking_level' } : undefined;
		case 'omp.commands.refresh':
			return { type: 'get_state' };
		case 'omp.messages.load':
			return sessionId ? { type: 'get_messages' } : undefined;
		case 'omp.stats.load':
			return sessionId ? { type: 'get_session_stats' } : undefined;
		case 'omp.subagents.load':
			return readString(payload, 'subagentId')
				? { type: 'get_subagent_messages', subagentId: readString(payload, 'subagentId')! }
				: undefined;
		case 'omp.auth.providers':
			return { type: 'get_login_providers' };
		case 'omp.auth.login':
			return readString(payload, 'providerId')
				? { type: 'login', providerId: readString(payload, 'providerId')! }
				: undefined;
		case 'omp.export.request':
			return sessionId ? { type: 'export_html' } : undefined;
		case 'omp.settings.set':
			return settingCommand(payload, sessionId);
		default:
			return undefined;
	}
}

function settingCommand(
	payload: Record<string, JsonValue>,
	sessionId: string | undefined
): OmpRpcCommand | undefined {
	if (!sessionId || typeof payload.setting !== 'string') return undefined;
	switch (payload.setting) {
		case 'steeringMode':
			return payload.value === 'all' || payload.value === 'one-at-a-time'
				? { type: 'set_steering_mode', mode: payload.value }
				: undefined;
		case 'followUpMode':
			return payload.value === 'all' || payload.value === 'one-at-a-time'
				? { type: 'set_follow_up_mode', mode: payload.value }
				: undefined;
		case 'interruptMode':
			return payload.value === 'immediate' || payload.value === 'wait'
				? { type: 'set_interrupt_mode', mode: payload.value }
				: undefined;
		case 'autoCompaction':
			return typeof payload.value === 'boolean'
				? { type: 'set_auto_compaction', enabled: payload.value }
				: undefined;
		case 'autoRetry':
			return typeof payload.value === 'boolean'
				? { type: 'set_auto_retry', enabled: payload.value }
				: undefined;
		case 'subagentSubscription':
			return payload.value === 'off' || payload.value === 'progress' || payload.value === 'events'
				? { type: 'set_subagent_subscription', level: payload.value }
				: undefined;
		default:
			return undefined;
	}
}

async function projectRuntime(
	current: ActivePlugin,
	runtime: ActiveRuntime,
	nextStatus?: ExternalSessionStatus
): Promise<void> {
	if (active !== current || current.runtime !== runtime) return;
	if (nextStatus) runtime.status = nextStatus;
	const state = runtime.controller.getState();
	if (!state) return;
	const snapshot = externalSession(state, runtime);
	await current.workspace.publishExternalSessions(++current.generation, Object.freeze([snapshot]));
	await current.workspace.setStatus(workspaceStatus(runtime.status));
	await current.workspace.setBadge(runtime.pendingApproval ? 1 : null);
	await emitPanel(current, 'omp.view.replace', currentView(runtime));
}

function externalSession(state: OmpSessionState, runtime: ActiveRuntime) {
	return Object.freeze({
		externalSessionId: state.sessionId,
		title: state.sessionName ?? state.sessionId,
		status: runtime.status,
		unread: 0,
		pendingApproval: runtime.pendingApproval,
		updatedAt: Date.now(),
	});
}

function workspaceStatus(status: ExternalSessionStatus) {
	if (status === 'failed') return { state: 'error' as const, label: 'OMP failed' };
	if (status === 'offline') return { state: 'offline' as const, label: 'OMP offline' };
	if (status === 'starting') return { state: 'connecting' as const, label: 'OMP starting' };
	return { state: 'ready' as const, label: 'OMP ready' };
}

function currentView(runtime: ActiveRuntime): JsonValue {
	const state = runtime.controller.getState();
	if (!state) throw new OmpProtocolError('OMP workspace has no session state');
	return Object.freeze({
		sessionId: state.sessionId,
		sessionName: state.sessionName ?? state.sessionId,
		status: runtime.status,
		pendingApproval: runtime.pendingApproval,
		composerMode: runtime.composerMode,
		state: toJsonValue(state),
		availableCommands: Object.freeze([...runtime.controller.availableCommands]),
		availableModels: toJsonValue(runtime.controller.availableModels),
	});
}

async function emitPanel(current: ActivePlugin, kind: string, payload: JsonValue): Promise<void> {
	if (active !== current) return;
	await current.panel.emit(kind, payload, ++current.panelSequence);
}

function parseCanonicalFrame(frame: string): JsonValue {
	if (!frame.endsWith('\n')) throw new OmpProtocolError('OMP RPC write was not JSONL');
	try {
		return toJsonValue(JSON.parse(frame.slice(0, -1)));
	} catch {
		throw new OmpProtocolError('OMP RPC write was not canonical JSON');
	}
}

function requireRecord(value: JsonValue): Record<string, JsonValue> {
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new OmpProtocolError('invalid OMP panel payload');
	return value as Record<string, JsonValue>;
}

async function toOmpImages(
	panel: MaestroInteractivePanelOwnerApi,
	attachments: readonly JsonValue[] | undefined
): Promise<readonly unknown[] | undefined> {
	if (!attachments) return undefined;
	const imageAttachments: Array<{
		readonly ref: string;
		readonly name: string;
		readonly mediaType: string;
		readonly sha256: string;
		readonly size: number;
	}> = [];
	let totalBytes = 0;
	for (const attachment of attachments) {
		const value = requireRecord(attachment);
		const ref = readString(value, 'ref');
		const name = readString(value, 'name');
		const mediaType = readString(value, 'mediaType');
		const sha256 = readString(value, 'sha256');
		const size = value.size;
		if (
			!ref ||
			!name ||
			!mediaType ||
			!sha256 ||
			!SHA256_HEX.test(sha256) ||
			typeof size !== 'number' ||
			!Number.isSafeInteger(size) ||
			size < 1 ||
			size > MAX_OMP_IMAGE_BYTES ||
			!Object.prototype.hasOwnProperty.call(OMP_IMAGE_MEDIA_TYPES, mediaType)
		)
			throw new OmpProtocolError('invalid OMP image attachment');
		totalBytes += size;
		if (totalBytes > MAX_OMP_PROMPT_ATTACHMENT_BYTES)
			throw new OmpProtocolError('OMP image attachments exceed aggregate byte limit');
		imageAttachments.push({ ref, name, mediaType, sha256, size });
	}
	const images: unknown[] = [];
	for (const attachment of imageAttachments) {
		const resource = await panel.consumeResource(attachment.ref);
		try {
			if (
				resource.ref !== attachment.ref ||
				resource.name !== attachment.name ||
				resource.mediaType !== attachment.mediaType ||
				resource.size !== attachment.size ||
				resource.sha256 !== attachment.sha256 ||
				resource.bytes.byteLength !== attachment.size ||
				sha256Hex(resource.bytes) !== attachment.sha256
			)
				throw new OmpProtocolError('invalid OMP image attachment');
			images.push(
				Object.freeze({
					type: 'image',
					data: encodeBase64(resource.bytes),
					mimeType: attachment.mediaType,
				})
			);
		} finally {
			resource.bytes.fill(0);
		}
	}
	return Object.freeze(images);
}

function readString(value: Record<string, JsonValue>, key: string): string | undefined {
	const candidate = value[key];
	return typeof candidate === 'string' ? candidate : undefined;
}

function isThinkingLevel(
	value: JsonValue | undefined
): value is NonNullable<OmpSessionState['thinkingLevel']> {
	return (
		value === 'off' ||
		value === 'minimal' ||
		value === 'low' ||
		value === 'medium' ||
		value === 'high' ||
		value === 'xhigh' ||
		value === 'max'
	);
}

function panelErrorCode(error: unknown) {
	if (error instanceof OmpProtocolError) return 'invalid_request' as const;
	return 'runtime_stopped' as const;
}

function toJsonValue(value: unknown): JsonValue {
	if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
	if (typeof value === 'number') return Number.isFinite(value) ? value : null;
	if (Array.isArray(value)) return Object.freeze(value.map((entry) => toJsonValue(entry)));
	if (typeof value === 'object') {
		const object: Record<string, JsonValue> = {};
		for (const [key, entry] of Object.entries(value)) object[key] = toJsonValue(entry);
		return Object.freeze(object);
	}
	return null;
}
