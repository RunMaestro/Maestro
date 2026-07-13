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
	active = candidate;
	try {
		candidate.unsubscribePanel = candidate.panel.onRequest((request) => {
			void handlePanelRequest(candidate, request);
		});
		await candidate.workspace.publishExternalSessions(1, []);
		await candidate.workspace.setStatus({ state: 'offline', label: 'OMP setup required' });
		await candidate.workspace.setBadge(null);
	} catch (error) {
		if (active === candidate) active = undefined;
		try {
			candidate.unsubscribePanel();
		} catch {
			// Listener removal is best-effort; authority has already been revoked.
		}
		await candidate.starting?.catch(() => undefined);
		await disposeRuntime(candidate, 'revoked');
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
	try {
		current.unsubscribePanel();
	} catch {
		// Authority has already been revoked; continue teardown if listener disposal fails.
	}
	await current.starting?.catch(() => undefined);
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
		if (request.kind === 'omp.commands.refresh' && !current.runtime && active === current) {
			await current.panel.resolve(request.requestId, request.kind, setupView());
			return;
		}

		if (request.kind === 'omp.session.create' && !current.runtime) {
			const started = await startFromExplicitPanelAction();
			if (!started) {
				await current.panel.reject(request.requestId, 'cancelled');
				return;
			}
			const runtime = current.runtime;
			if (!runtime || active !== current || runtime.controller.state !== 'ready') {
				await current.panel.reject(request.requestId, 'runtime_stopped');
				return;
			}
			await current.panel.resolve(request.requestId, request.kind, currentView(runtime));
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
		if (snapshotResult(request.kind)) {
			if (request.kind !== 'omp.commands.refresh')
				await runtime.controller.command({ type: 'get_state' });
			return currentView(runtime);
		}
		return projectCommandResult(request.kind, response.data, payload, runtime);
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
		return currentView(runtime);
	}
	throw new OmpProtocolError(`unknown OMP panel request ${JSON.stringify(request.kind)}`);
}

function snapshotResult(kind: string): boolean {
	switch (kind) {
		case 'omp.session.create':
		case 'omp.session.select':
		case 'omp.session.compact':
		case 'omp.session.branch':
		case 'omp.session.handoff':
		case 'omp.model.set':
		case 'omp.model.cycle':
		case 'omp.thinking.set':
		case 'omp.thinking.cycle':
		case 'omp.settings.set':
		case 'omp.commands.refresh':
			return true;
		default:
			return false;
	}
}

function projectCommandResult(
	kind: string,
	data: unknown,
	payload: Record<string, JsonValue>,
	runtime: ActiveRuntime
): JsonValue {
	switch (kind) {
		case 'omp.messages.load':
			return Object.freeze({ messages: messageSummaries(data) });
		case 'omp.stats.load': {
			const state = runtime.controller.getState();
			if (!state) throw new OmpProtocolError('OMP workspace has no session state');
			return Object.freeze({
				messageCount: boundedCount(state.messageCount),
				queuedMessageCount: boundedCount(state.queuedMessageCount),
			});
		}
		case 'omp.subagents.load':
			return subagentMessages(data);
		case 'omp.auth.providers':
			return Object.freeze({ providers: loginProviders(data) });
		case 'omp.auth.login':
			return Object.freeze({ providerId: resultString(data, 'providerId', payload.providerId) });
		case 'omp.export.request':
			return Object.freeze({ path: resultString(data, 'path') });
		default:
			return Object.freeze({});
	}
}

function messageSummaries(data: unknown): readonly JsonValue[] {
	const messages = isRecord(data) && Array.isArray(data.messages) ? data.messages : [];
	return Object.freeze(
		messages.slice(0, 500).map((message, index) => messageSummary(message, index))
	);
}

function messageSummary(value: unknown, index: number): JsonValue {
	if (!isRecord(value)) return Object.freeze({ id: `message-${index}`, role: 'other', text: '' });
	const rawRole = typeof value.role === 'string' ? value.role : 'other';
	const role =
		rawRole === 'user' || rawRole === 'assistant' || rawRole === 'system'
			? rawRole
			: rawRole === 'tool' || rawRole === 'toolResult'
				? 'tool'
				: 'other';
	const text =
		typeof value.text === 'string'
			? value.text
			: typeof value.content === 'string'
				? value.content
				: '';
	return Object.freeze({
		id: boundedString(typeof value.id === 'string' ? value.id : `message-${index}`, 256),
		role,
		text: boundedString(text, 65536),
	});
}

function subagentMessages(data: unknown): JsonValue {
	const result = isRecord(data) ? data : {};
	const entries = Array.isArray(result.entries) ? result.entries : [];
	return Object.freeze({
		sessionFile: boundedString(
			typeof result.sessionFile === 'string' ? result.sessionFile : '',
			4096
		),
		fromByte: boundedCount(result.fromByte),
		nextByte: boundedCount(result.nextByte),
		reset: result.reset === true,
		entries: Object.freeze(
			entries.slice(0, 500).map((entry, index) => {
				const value = isRecord(entry) ? entry : {};
				return Object.freeze({
					id: boundedString(typeof value.id === 'string' ? value.id : `entry-${index}`, 256),
					label: boundedString(
						typeof value.label === 'string'
							? value.label
							: typeof value.type === 'string'
								? value.type
								: '',
						65536
					),
					status: boundedString(typeof value.status === 'string' ? value.status : '', 128),
				});
			})
		),
		messages: messageSummaries(data),
	});
}

function loginProviders(data: unknown): readonly JsonValue[] {
	const providers = isRecord(data) && Array.isArray(data.providers) ? data.providers : [];
	return Object.freeze(
		providers.slice(0, 100).flatMap((provider) => {
			if (
				!isRecord(provider) ||
				typeof provider.id !== 'string' ||
				typeof provider.name !== 'string' ||
				typeof provider.available !== 'boolean' ||
				typeof provider.authenticated !== 'boolean'
			)
				return [];
			return [
				Object.freeze({
					id: boundedString(provider.id, 256),
					name: boundedString(provider.name, 256),
					available: provider.available,
					authenticated: provider.authenticated,
				}),
			];
		})
	);
}

function resultString(data: unknown, key: string, fallback?: JsonValue): string {
	const value = isRecord(data) ? data[key] : fallback;
	if (typeof value !== 'string' || value.length === 0)
		throw new OmpProtocolError(`OMP ${key} response was invalid`);
	return boundedString(value, 4096);
}

function boundedCount(value: unknown): number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
		? Math.min(value, Number.MAX_SAFE_INTEGER)
		: 0;
}

function boundedString(value: string, maximum: number): string {
	return value.slice(0, maximum);
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

function setupView(): JsonValue {
	return Object.freeze({
		connection: 'offline',
		models: Object.freeze([]),
		sessions: Object.freeze([]),
		activeSessionId: '',
		error: 'OMP setup required. Create a new session to start OMP.',
	});
}

function currentView(runtime: ActiveRuntime): JsonValue {
	const state = runtime.controller.getState();
	if (!state) throw new OmpProtocolError('OMP workspace has no session state');
	const selectedModel = modelLabel(state.model);
	const models = Object.freeze(
		[...runtime.controller.availableModels.map(modelLabel), selectedModel].filter(
			(value): value is string => value !== undefined
		)
	);
	return Object.freeze({
		connection: connectionState(runtime.status),
		models: Object.freeze([...new Set(models)].slice(0, 100)),
		sessions: Object.freeze([
			Object.freeze({
				id: boundedString(state.sessionId, 4096),
				title: boundedString(state.sessionName ?? state.sessionId, 4096),
				updatedAt: Date.now(),
				status: sessionStatus(runtime, state),
				model: boundedString(selectedModel ?? 'OMP default', 4096),
				mode: runtime.composerMode,
				events: Object.freeze([]),
				tree: Object.freeze([]),
				subagents: Object.freeze([]),
				usage: Object.freeze({ inputTokens: 0, outputTokens: 0 }),
				...(state.thinkingLevel === undefined ? {} : { thinkingLevel: state.thinkingLevel }),
				queuedMessageCount: boundedCount(state.queuedMessageCount),
				todoPhases: todoPhases(state.todoPhases),
			}),
		]),
		activeSessionId: boundedString(state.sessionId, 4096),
	});
}

function connectionState(status: ExternalSessionStatus): 'loading' | 'ready' | 'offline' | 'error' {
	if (status === 'starting') return 'loading';
	if (status === 'offline') return 'offline';
	if (status === 'failed') return 'error';
	return 'ready';
}

function sessionStatus(
	runtime: ActiveRuntime,
	state: OmpSessionState
): 'idle' | 'streaming' | 'queued' | 'waiting-approval' | 'error' {
	if (runtime.status === 'failed') return 'error';
	if (runtime.pendingApproval) return 'waiting-approval';
	if (state.isStreaming || runtime.status === 'working') return 'streaming';
	if (runtime.status === 'starting' || runtime.status === 'retrying') return 'queued';
	return 'idle';
}

function modelLabel(value: unknown): string | undefined {
	if (typeof value === 'string' && value.length > 0) return value;
	if (!isRecord(value)) return undefined;
	const provider = typeof value.provider === 'string' ? value.provider : undefined;
	const id =
		typeof value.id === 'string'
			? value.id
			: typeof value.modelId === 'string'
				? value.modelId
				: typeof value.name === 'string'
					? value.name
					: undefined;
	if (!id) return undefined;
	return provider ? `${provider}/${id}` : id;
}

function todoPhases(values: readonly unknown[]): readonly JsonValue[] {
	return Object.freeze(
		values.slice(0, 500).flatMap((value) => {
			if (!isRecord(value)) return [];
			const phase = Object.freeze({
				...(typeof value.id === 'string' ? { id: boundedString(value.id, 256) } : {}),
				...(typeof value.label === 'string' ? { label: boundedString(value.label, 65536) } : {}),
				...(typeof value.status === 'string' ? { status: boundedString(value.status, 128) } : {}),
			});
			return Object.keys(phase).length > 0 ? [phase] : [];
		})
	);
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

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
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
