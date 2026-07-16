import { spawn as spawnChild } from 'child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'child_process';
import type {
	AgentApprovalRequest,
	AgentApprovalResponse,
	AgentControl,
	AgentControlOption,
	AgentRuntimeFeatureState,
	AgentSubagent,
	AgentTodoPhase,
	AgentTreeNode,
} from '../../shared/agent-runtime-features';
import { OmpRpcClient } from './rpc-client';
import {
	OMP_IMAGE_MEDIA_TYPES,
	type OmpRpcCommand,
	type OmpRpcEvent,
	type OmpRpcImage,
	type OmpRpcTransport,
} from './types';
import { isRegisteredOmpControl } from '../../shared/omp-command-registry';
import { OMP_NATIVE_TURN_COMPLETION } from '../../shared/omp-native-session';

export type OmpNativeSend = (channel: string, ...args: unknown[]) => void;
export type OmpChildSpawner = (
	command: string,
	args: readonly string[],
	options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

export interface OmpNativeSessionOptions {
	sessionId: string;
	cwd: string;
	/** Resolver-authenticated runtime arguments, e.g. a verified entry script. */
	prefixArgs?: readonly string[];
	command: string;
	env?: NodeJS.ProcessEnv;
	agentSessionId?: string;
	/** Provider-qualified OMP model selector (`provider:modelId`). */
	model?: string;
	send: OmpNativeSend;
	spawn?: OmpChildSpawner;
}

const adapters = new Map<string, OmpNativeSessionAdapter>();

export class OmpNativeSessionAdapter {
	readonly ready: Promise<void>;
	private readonly initialized: Promise<void>;
	private readonly client: OmpRpcClient;
	private readonly child: ChildProcessWithoutNullStreams;
	private readonly approvals = new Map<string, OmpRpcEvent>();
	private readonly resolvedApprovals = new Set<string>();
	private readonly hostToolCalls = new Map<string, AbortController>();
	private readonly hostUriRequests = new Set<string>();
	private disposed = false;
	private turnInFlight = false;
	private turnEmittedAssistantText = false;
	private autoRetryEnabled = true;
	private appliedModel?: string;

	private constructor(private readonly options: OmpNativeSessionOptions) {
		const spawn = options.spawn ?? spawnChild;
		// Intentionally omit every managed-plugin sandbox flag. Native sessions run
		this.child = spawn(options.command, [...(options.prefixArgs ?? []), '--mode', 'rpc'], {
			cwd: options.cwd,
			env: options.env ?? process.env,
			windowsHide: true,
		});
		this.client = new OmpRpcClient(this.transport());
		this.client.onEvent((event) => this.handleEvent(event));
		this.client.onCallback((callback) => this.handleCallback(callback));
		this.client.onDiagnostic((message) =>
			this.options.send('process:stderr', this.options.sessionId, message)
		);
		this.child.once('close', (code, signal) => {
			if (this.disposed) return;
			this.disposed = true;
			adapters.delete(options.sessionId);
			this.options.send('process:exit', options.sessionId, code ?? 0, signal ? 1 : undefined);
		});
		this.client.onDiagnostic((message) =>
			this.options.send('process:stderr', options.sessionId, message)
		);
		this.ready = this.client.ready;
		this.initialized = this.ready.then(() => this.initialize());
		void this.initialized.catch((error: unknown) => {
			this.options.send(
				'process:stderr',
				options.sessionId,
				error instanceof Error ? error.message : String(error)
			);
		});
	}

	static create(options: OmpNativeSessionOptions): OmpNativeSessionAdapter {
		return new OmpNativeSessionAdapter(options);
	}

	static async acquire(options: OmpNativeSessionOptions): Promise<OmpNativeSessionAdapter> {
		const existing = adapters.get(options.sessionId);
		if (existing && !existing.disposed) {
			await existing.reconcileModel(options.model);
			return existing;
		}
		const adapter = OmpNativeSessionAdapter.create(options);
		adapters.set(options.sessionId, adapter);
		return adapter;
	}

	static forSession(sessionId: string): OmpNativeSessionAdapter | undefined {
		return adapters.get(sessionId);
	}

	get pid(): number {
		return this.child.pid ?? 0;
	}

	async prompt(message: string, images?: readonly string[]): Promise<void> {
		await this.initialized;
		this.turnEmittedAssistantText = false;
		this.turnInFlight = true;
		try {
			await this.client.command({
				type: 'prompt',
				message,
				streamingBehavior: 'steer',
				...(images?.length ? { images: toOmpImages(images) } : {}),
			});
		} catch (error) {
			this.turnInFlight = false;
			throw error;
		}
	}

	async interrupt(): Promise<void> {
		await this.ready;
		await this.client.command({ type: 'abort' });
	}

	async respondApproval(
		requestId: string,
		response: Omit<AgentApprovalResponse, 'sessionId' | 'requestId'>
	): Promise<boolean> {
		await this.initialized;
		const request = this.approvals.get(requestId);
		if (!request) return false;
		const method = stringAt(request, 'method');
		const frame = extensionResponse(requestId, method, response, request);
		if (!frame) return false;
		await this.client.send(frame);
		this.approvals.delete(requestId);
		this.resolvedApprovals.add(requestId);
		return true;
	}

	async setControl(controlId: string, value: string | boolean): Promise<boolean> {
		await this.initialized;
		const command = controlCommand(controlId, value);
		if (!command) return false;
		try {
			await this.client.command(command);
			if (controlId === 'model' && typeof value === 'string') this.appliedModel = value;
			if (controlId === 'auto-retry') this.autoRetryEnabled = value as boolean;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.options.send(
				'process:stderr',
				this.options.sessionId,
				`OMP control ${controlId} rejected: ${message}`
			);
			throw error;
		}
		await this.refreshFeatures();
		return true;
	}

	async branch(entryId: string): Promise<boolean> {
		await this.initialized;
		await this.client.command({ type: 'branch', entryId });
		await this.refreshFeatures();
		return true;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		adapters.delete(this.options.sessionId);
		this.child.kill();
	}

	private transport(): OmpRpcTransport {
		return {
			send: (frame) => {
				this.child.stdin.write(frame);
			},
			onFrame: (listener) => {
				this.child.stdout.on('data', listener);
				return () => this.child.stdout.off('data', listener);
			},
			onDiagnostic: (listener) => {
				this.child.stderr.on('data', listener);
				return () => this.child.stderr.off('data', listener);
			},
			onClosed: (listener) => {
				const close = (code: number | null, signal: NodeJS.Signals | null) =>
					listener(signal ?? String(code ?? 'unknown'));
				this.child.once('close', close);
				return () => this.child.off('close', close);
			},
		};
	}

	private async initialize(): Promise<void> {
		await this.client.ready;
		if (this.options.agentSessionId) {
			await this.client.command({
				type: 'switch_session',
				sessionPath: this.options.agentSessionId,
			});
		} else {
			await this.client.command({ type: 'new_session' });
		}
		if (this.options.model) await this.applyModel(this.options.model);
		await Promise.all([
			this.client.command({
				type: 'set_host_tools',
				tools: [
					{
						name: 'maestro.session.status',
						label: 'Maestro session status',
						description: 'Returns bounded metadata for the current Maestro session.',
						parameters: { type: 'object', properties: {}, additionalProperties: false },
					},
				],
			}),
			this.client.command({
				type: 'set_host_uri_schemes',
				schemes: [
					{
						scheme: 'maestro',
						description: 'Read-only Maestro session metadata',
						immutable: true,
					},
				],
			}),
			this.client.command({ type: 'set_subagent_subscription', level: 'events' }),
		]);
		await Promise.all([this.emitCommands(), this.refreshFeatures()]);
	}

	private async reconcileModel(model?: string): Promise<void> {
		if (!model) return;
		await this.initialized;
		if (model === this.appliedModel) return;
		await this.applyModel(model);
		await this.refreshFeatures();
	}

	private async applyModel(model: string): Promise<void> {
		await this.client.command(modelCommand(model));
		this.appliedModel = model;
	}

	private async emitCommands(): Promise<void> {
		const response = await this.client.command({ type: 'get_available_commands' });
		const commandsData = asRecord(response.data).commands;
		const commands = Array.isArray(commandsData)
			? commandsData.map(commandName).filter((command): command is string => Boolean(command))
			: [];
		this.options.send('process:slash-commands', this.options.sessionId, commands);
	}

	private async refreshFeatures(): Promise<void> {
		const [state, messages, subagents, stats, models] = await Promise.all([
			this.client.command({ type: 'get_state' }),
			this.client.command({ type: 'get_messages' }),
			this.client.command({ type: 'get_subagents' }),
			this.client.command({ type: 'get_session_stats' }),
			this.client.command({ type: 'get_available_models' }),
		]);
		const stateData = asRecord(state.data);
		const modelsData = asRecord(models.data).models;
		const modelOptions = Array.isArray(modelsData)
			? modelsData.map(modelOption).filter((option) => option.id.length > 0)
			: [];
		const statsProjection = statsFromData(stats.data);
		const features: AgentRuntimeFeatureState = {
			controls: controlsFromState(stateData, modelOptions, this.autoRetryEnabled),
			tree: treeFromMessages(asRecord(messages.data).messages),
			todos: todosFromState(stateData),
			subagents: subagentsFromData(asRecord(subagents.data).subagents),
			stats: statsProjection,
		};
		this.options.send('process:runtime-features', this.options.sessionId, features);
		const usage = usageFromStats(statsProjection);
		if (usage) this.options.send('process:usage', this.options.sessionId, usage);
		const sessionPath = stringAt(stateData, 'sessionFile') ?? stringAt(stateData, 'sessionId');
		if (sessionPath) this.options.send('process:session-id', this.options.sessionId, sessionPath);
	}

	private handleEvent(event: OmpRpcEvent): void {
		if (event.type === 'message_update') {
			const assistantMessageEvent = asRecord(event.assistantMessageEvent);
			const eventType = stringAt(assistantMessageEvent, 'type');
			const text = stringAt(assistantMessageEvent, 'delta') ?? textFrom(event);
			if ((eventType === 'text_delta' || !eventType) && text) {
				this.turnEmittedAssistantText = true;
				this.options.send('process:data', this.options.sessionId, text);
			}
			if (eventType === 'thinking_delta' && text)
				this.options.send('process:thinking-chunk', this.options.sessionId, text);
		}
		if (event.type.startsWith('tool_execution_')) {
			this.options.send('process:tool-execution', this.options.sessionId, {
				toolName: stringAt(event, 'toolName') ?? stringAt(event, 'name') ?? 'tool',
				state: event,
				timestamp: Date.now(),
				toolCallId: stringAt(event, 'id'),
			});
		}
		if (
			event.type === 'auto_compaction_start' ||
			event.type === 'auto_compaction_end' ||
			event.type === 'auto_retry_start' ||
			event.type === 'auto_retry_end' ||
			event.type === 'retry_fallback_applied' ||
			event.type === 'retry_fallback_succeeded' ||
			event.type === 'notice' ||
			event.type === 'extension_error'
		) {
			const detail =
				textFrom(event) ??
				stringAt(event, 'message') ??
				stringAt(event, 'error') ??
				event.type.replaceAll('_', ' ');
			this.options.send('process:stderr', this.options.sessionId, `OMP ${detail}`);
		}
		if (
			event.type === 'todo_reminder' ||
			event.type === 'todo_auto_clear' ||
			event.type === 'goal_updated' ||
			event.type === 'thinking_level_changed'
		) {
			void this.refreshFeatures();
		}
		if (event.type === 'turn_end' || event.type === 'agent_end') {
			this.completeTurn();
			void this.refreshFeatures();
		}
	}

	private handleCallback(callback: OmpRpcEvent): void {
		if (callback.type === 'prompt_result') {
			const text = textFrom(callback);
			if (text && !this.turnEmittedAssistantText)
				this.options.send('process:data', this.options.sessionId, text);
			return;
		}
		if (callback.type === 'available_commands_update') {
			const raw = Array.isArray(callback.commands) ? callback.commands : [];
			this.options.send(
				'process:slash-commands',
				this.options.sessionId,
				raw.map(commandName).filter((command): command is string => Boolean(command))
			);
			return;
		}
		if (callback.type === 'command_output') {
			const text = textFrom(callback);
			if (text) this.options.send('process:data', this.options.sessionId, text);
			return;
		}
		if (callback.type === 'host_tool_call') {
			void this.handleHostToolCall(callback);
			return;
		}
		if (callback.type === 'host_tool_cancel') {
			const targetId = stringAt(callback, 'targetId');
			this.hostToolCalls.get(targetId ?? '')?.abort();
			return;
		}
		if (callback.type === 'host_uri_request') {
			void this.handleHostUriRequest(callback);
			return;
		}
		if (callback.type === 'host_uri_cancel') {
			const targetId = stringAt(callback, 'targetId');
			if (targetId) this.hostUriRequests.delete(targetId);
			return;
		}
		if (callback.type === 'extension_ui_request') {
			const id = stringAt(callback, 'id');
			const method = stringAt(callback, 'method');
			if (!id || !method) {
				this.options.send(
					'process:stderr',
					this.options.sessionId,
					'OMP extension UI request is missing its response ID or method'
				);
				return;
			}
			if (method === 'cancel') {
				const targetId = stringAt(callback, 'targetId');
				if (targetId) {
					this.approvals.delete(targetId);
					this.resolvedApprovals.add(targetId);
					this.options.send('process:approval-cancelled', this.options.sessionId, targetId);
				}
				return;
			}
			if (method === 'open_url') {
				const url = stringAt(callback, 'launchUrl') ?? stringAt(callback, 'url');
				if (!url) {
					this.options.send(
						'process:stderr',
						this.options.sessionId,
						'OMP open_url request is missing a URL'
					);
				} else if (isExternalHttpUrl(url)) {
					this.options.send('process:open-external-url', this.options.sessionId, url);
				} else {
					this.options.send(
						'process:stderr',
						this.options.sessionId,
						'OMP open_url request has an invalid URL'
					);
				}
				return;
			}
			if (isNativeProjectionRequest(method)) {
				this.projectExtensionUi(callback);
				return;
			}
			if (this.resolvedApprovals.has(id)) return;
			if (
				(isChoiceRequest(method) && approvalOptions(callback).length > 0) ||
				isTextRequest(method)
			) {
				this.approvals.set(id, callback);
				this.options.send(
					'process:approval-request',
					approvalFrom(callback, this.options.sessionId)
				);
				return;
			}
			// OMP blocks the active turn until every extension UI request has an
			// explicit response. Unsupported interactive methods must therefore
			// fail closed rather than being silently ignored.
			this.rejectExtensionUiRequest(id, callback);
			return;
		}
		if (
			callback.type.startsWith('subagent_') ||
			callback.type === 'session_info_update' ||
			callback.type === 'config_update'
		)
			void this.refreshFeatures();
	}

	private async handleHostToolCall(callback: OmpRpcEvent): Promise<void> {
		const id = stringAt(callback, 'id');
		const toolName = stringAt(callback, 'toolName');
		const args = asRecord(callback.arguments);
		if (!id || !toolName || Buffer.byteLength(JSON.stringify(args), 'utf8') > 16 * 1024) return;
		const controller = new AbortController();
		this.hostToolCalls.set(id, controller);
		try {
			if (toolName !== 'maestro.session.status')
				throw new Error(`Unsupported Maestro host tool: ${toolName}`);
			if (Object.keys(args).length > 0)
				throw new Error('maestro.session.status accepts no arguments');
			const text = JSON.stringify(
				{ sessionId: this.options.sessionId, cwd: this.options.cwd },
				undefined,
				2
			);
			await this.client.send({
				type: 'host_tool_update',
				id,
				partialResult: { content: [{ type: 'text', text: 'Reading Maestro session status' }] },
			});
			if (controller.signal.aborted) return;
			await this.client.send({
				type: 'host_tool_result',
				id,
				result: { content: [{ type: 'text', text }] },
			});
		} catch (error) {
			await this.client.send({
				type: 'host_tool_result',
				id,
				isError: true,
				result: {
					content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
				},
			});
		} finally {
			this.hostToolCalls.delete(id);
		}
	}

	private async handleHostUriRequest(callback: OmpRpcEvent): Promise<void> {
		const id = stringAt(callback, 'id');
		const operation = stringAt(callback, 'operation');
		const url = stringAt(callback, 'url');
		if (!id || !operation || !url) return;
		this.hostUriRequests.add(id);
		try {
			if (operation !== 'read' || url !== 'maestro://session/status')
				throw new Error('Maestro only exposes the immutable maestro://session/status URI');
			const content = JSON.stringify({ sessionId: this.options.sessionId, cwd: this.options.cwd });
			if (Buffer.byteLength(content, 'utf8') > 16 * 1024)
				throw new Error('Host URI response exceeds limit');
			if (!this.hostUriRequests.has(id)) return;
			await this.client.send({
				type: 'host_uri_result',
				id,
				content,
				contentType: 'application/json',
				immutable: true,
			});
		} catch (error) {
			if (this.hostUriRequests.has(id))
				await this.client.send({
					type: 'host_uri_result',
					id,
					isError: true,
					error: error instanceof Error ? error.message : String(error),
				});
		} finally {
			this.hostUriRequests.delete(id);
		}
	}
	private projectExtensionUi(callback: OmpRpcEvent): void {
		const method = stringAt(callback, 'method');
		if (method === 'notify' || method === 'extension_ui.notify') {
			const message = stringAt(callback, 'message');
			if (message)
				this.options.send('remote:notifyToast', {
					title: 'OMP',
					message,
					color: notificationColor(stringAt(callback, 'notifyType')),
				});
			return;
		}
		if (method === 'set_editor_text' || method === 'extension_ui.set_editor_text') {
			const text = stringAt(callback, 'text');
			if (text !== undefined)
				this.options.send('process:composer-text', this.options.sessionId, text);
			return;
		}
		if (method === 'setTitle' || method === 'extension_ui.setTitle') {
			const title = stringAt(callback, 'title');
			if (title) this.options.send('process:session-title', this.options.sessionId, title);
			return;
		}
		const text =
			stringAt(callback, 'statusText') ??
			(Array.isArray(callback.widgetLines)
				? callback.widgetLines.filter((line): line is string => typeof line === 'string').join('\n')
				: undefined);
		if (text) this.options.send('process:data', this.options.sessionId, text);
	}

	private rejectExtensionUiRequest(id: string, callback: OmpRpcEvent): void {
		const method = stringAt(callback, 'method');
		if (method === 'notify' || method === 'extension_ui.notify') {
			const notification = stringAt(callback, 'message') ?? stringAt(callback, 'title');
			if (notification)
				this.options.send(
					'process:stderr',
					this.options.sessionId,
					`OMP notification: ${notification}`
				);
		}
		if (isRuntimeFeatureRequest(method)) void this.refreshFeatures();
		void this.client
			.send({ type: 'extension_ui_response', id, cancelled: true })
			.then(() => this.resolvedApprovals.add(id))
			.catch((error: unknown) => {
				this.options.send(
					'process:stderr',
					this.options.sessionId,
					error instanceof Error ? error.message : String(error)
				);
			});
	}

	private completeTurn(): void {
		if (!this.turnInFlight) return;
		this.turnInFlight = false;
		// A native OMP agent_end completes one turn, not the long-lived RPC child.
		// The process session id identifies the owning Maestro AI tab; the provider
		// session id is only continuity metadata and cannot route renderer state.
		this.options.send(
			'process:command-exit',
			this.options.sessionId,
			0,
			OMP_NATIVE_TURN_COMPLETION
		);
	}
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function stringAt(record: Record<string, unknown>, key: string): string | undefined {
	return typeof record[key] === 'string' ? (record[key] as string) : undefined;
}

function isExternalHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}
function textFrom(record: Record<string, unknown>): string | undefined {
	for (const key of ['delta', 'content', 'text', 'message', 'result']) {
		const value = record[key];
		if (typeof value === 'string') return value;
	}
	return undefined;
}

function toOmpImages(images: readonly string[]): OmpRpcImage[] {
	return images.map((dataUrl) => {
		const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/]+={0,2})$/i.exec(dataUrl);
		if (
			!match ||
			!OMP_IMAGE_MEDIA_TYPES.includes(match[1] as (typeof OMP_IMAGE_MEDIA_TYPES)[number])
		)
			throw new Error('OMP image attachments must be supported base64 image data URLs');
		return { image: { mimeType: match[1] as OmpRpcImage['image']['mimeType'], data: match[2] } };
	});
}

function modelCommand(selection: string): OmpRpcCommand {
	const separator = selection.indexOf(':');
	const provider = selection.slice(0, separator);
	const modelId = selection.slice(separator + 1);
	if (separator <= 0 || !modelId)
		throw new Error('OMP model selection must use the provider:modelId format');
	return { type: 'set_model', provider, modelId };
}

function commandName(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	return stringAt(asRecord(value), 'name');
}

function controlsFromState(
	state: Record<string, unknown>,
	modelOptions: AgentControl['options'],
	autoRetryEnabled: boolean
): AgentControl[] {
	const model = asRecord(state.model);
	const modelValue = stringAt(model, 'id');
	return [
		{ id: 'model', label: 'Model', kind: 'select', options: modelOptions, value: modelValue },
		{
			id: 'thinking-level',
			label: 'Thinking level',
			kind: 'select',
			options: ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((id) => ({
				id,
				label: id,
			})),
			value: stringAt(state, 'thinkingLevel') ?? 'off',
		},
		{ id: 'new-session', label: 'New session', kind: 'action' },
		{ id: 'compact', label: 'Compact', kind: 'action' },
		{ id: 'handoff', label: 'Handoff', kind: 'action' },
		{ id: 'export-html', label: 'Export HTML', kind: 'action' },
		{ id: 'cycle-model', label: 'Cycle model', kind: 'action' },
		{ id: 'cycle-thinking-level', label: 'Cycle thinking', kind: 'action' },
		{ id: 'abort-retry', label: 'Abort retry', kind: 'action' },
		{ id: 'abort-bash', label: 'Abort shell command', kind: 'action' },
		{
			id: 'steering-mode',
			label: 'Steering mode',
			kind: 'select',
			options: [
				{ id: 'all', label: 'All' },
				{ id: 'one-at-a-time', label: 'One at a time' },
			],
			value: stringAt(state, 'steeringMode') ?? 'all',
		},
		{
			id: 'follow-up-mode',
			label: 'Follow-up mode',
			kind: 'select',
			options: [
				{ id: 'all', label: 'All' },
				{ id: 'one-at-a-time', label: 'One at a time' },
			],
			value: stringAt(state, 'followUpMode') ?? 'all',
		},
		{
			id: 'interrupt-mode',
			label: 'Interrupt mode',
			kind: 'select',
			options: [
				{ id: 'immediate', label: 'Immediate' },
				{ id: 'wait', label: 'Wait' },
			],
			value: stringAt(state, 'interruptMode') ?? 'immediate',
		},
		{
			id: 'auto-compaction',
			label: 'Auto-compaction',
			kind: 'toggle',
			value: state.autoCompactionEnabled === true,
		},
		{
			id: 'auto-retry',
			label: 'Auto-retry',
			kind: 'toggle',
			value: autoRetryEnabled,
		},
	];
}

function modelOption(value: unknown): AgentControlOption {
	const model = asRecord(value);
	const provider = stringAt(model, 'provider');
	const id = stringAt(model, 'id') ?? stringAt(model, 'modelId') ?? '';
	return {
		id: provider && id ? `${provider}:${id}` : id,
		label: stringAt(model, 'label') ?? id,
	};
}
function todosFromState(state: Record<string, unknown>): AgentTodoPhase[] {
	const phases = Array.isArray(state.todoPhases) ? state.todoPhases : [];
	if (!phases.length) return [];
	return phases.flatMap((phase) => {
		const record = asRecord(phase);
		const name = stringAt(record, 'name') ?? stringAt(record, 'label') ?? stringAt(record, 'id');
		if (!name) return [];
		const items = Array.isArray(record.items)
			? record.items.flatMap((item) => {
					const entry = asRecord(item);
					const content = stringAt(entry, 'content');
					return content ? [{ content, state: todoState(stringAt(entry, 'state')) }] : [];
				})
			: [{ content: name, state: todoState(stringAt(record, 'status')) }];
		return [{ name, items }];
	});
}

function treeFromMessages(value: unknown): AgentTreeNode[] | null {
	if (!Array.isArray(value)) return null;
	return value.map((message, index) => {
		const record = asRecord(message);
		return {
			id: stringAt(record, 'id') ?? String(index),
			label:
				stringAt(record, 'summary') ??
				stringAt(record, 'text') ??
				stringAt(record, 'content') ??
				'Message',
		};
	});
}
function subagentsFromData(value: unknown): AgentSubagent[] {
	if (!Array.isArray(value)) return [];
	return value.map((subagent, index) => {
		const record = asRecord(subagent);
		const status = stringAt(record, 'status');
		return {
			id: stringAt(record, 'id') ?? String(index),
			label: stringAt(record, 'label') ?? stringAt(record, 'name') ?? 'Subagent',
			status:
				status === 'idle'
					? 'idle'
					: status === 'complete' || status === 'completed'
						? 'complete'
						: status === 'error'
							? 'error'
							: 'running',
		};
	});
}

function statsFromData(value: unknown): Record<string, number | string> | null {
	const response = asRecord(value);
	const nestedStats = asRecord(response.stats);
	const stats = Object.keys(nestedStats).length > 0 ? nestedStats : response;
	const values: Record<string, number | string> = Object.fromEntries(
		Object.entries(stats).filter(([, item]) => typeof item === 'number' || typeof item === 'string')
	) as Record<string, number | string>;
	const tokens = asRecord(stats.tokens);
	const contextUsage = asRecord(stats.contextUsage);
	copyNumber(values, 'inputTokens', tokens.input ?? stats.inputTokens);
	copyNumber(values, 'outputTokens', tokens.output ?? stats.outputTokens);
	copyNumber(values, 'reasoningTokens', tokens.reasoning ?? stats.reasoningTokens);
	copyNumber(values, 'cacheReadInputTokens', tokens.cacheRead ?? stats.cacheReadInputTokens);
	copyNumber(
		values,
		'cacheCreationInputTokens',
		tokens.cacheWrite ?? stats.cacheCreationInputTokens
	);
	copyNumber(values, 'totalTokens', tokens.total ?? stats.totalTokens);
	copyNumber(values, 'totalCostUsd', stats.cost ?? stats.totalCostUsd);
	copyNumber(values, 'contextWindow', contextUsage.contextWindow ?? stats.contextWindow);
	return Object.keys(values).length ? values : null;
}

function copyNumber(target: Record<string, number | string>, key: string, value: unknown): void {
	if (typeof value === 'number') target[key] = value;
}

function todoState(value: string | undefined): AgentTodoPhase['items'][number]['state'] {
	if (value === 'in_progress') return 'in_progress';
	if (value === 'done' || value === 'completed') return 'done';
	if (value === 'dropped' || value === 'abandoned') return 'dropped';
	return 'open';
}

function usageFromStats(stats: Record<string, number | string> | null): {
	inputTokens: number;
	outputTokens: number;
	cacheReadInputTokens: number;
	cacheCreationInputTokens: number;
	totalCostUsd: number;
	contextWindow: number;
	reasoningTokens?: number;
} | null {
	if (!stats) return null;
	const number = (key: string): number =>
		typeof stats[key] === 'number' ? (stats[key] as number) : 0;
	return {
		inputTokens: number('inputTokens'),
		outputTokens: number('outputTokens'),
		cacheReadInputTokens: number('cacheReadInputTokens'),
		cacheCreationInputTokens: number('cacheCreationInputTokens'),
		totalCostUsd: number('totalCostUsd'),
		contextWindow: number('contextWindow'),
		...(typeof stats.reasoningTokens === 'number'
			? { reasoningTokens: stats.reasoningTokens }
			: {}),
	};
}

function approvalOptions(callback: OmpRpcEvent): AgentApprovalRequest['options'] {
	const raw = Array.isArray(callback.options) ? callback.options : [];
	const options: AgentApprovalRequest['options'] = [];
	for (const item of raw) {
		const option = asRecord(item);
		const id = stringAt(option, 'id');
		if (id === undefined) continue;
		const kind = stringAt(option, 'kind');
		options.push({
			id,
			label: stringAt(option, 'label') ?? id,
			kind: kind === 'approve' || kind === 'deny' ? kind : 'custom',
		});
	}
	const method = stringAt(callback, 'method');
	if (options.length || (method !== 'confirm' && method !== 'extension_ui.confirm')) return options;
	return [
		{ id: 'approve', label: 'Approve', kind: 'approve' },
		{ id: 'deny', label: 'Deny', kind: 'deny' },
	];
}

function isChoiceRequest(method: string | undefined): boolean {
	return (
		method === 'select' ||
		method === 'extension_ui.select' ||
		method === 'confirm' ||
		method === 'extension_ui.confirm'
	);
}

function isTextRequest(method: string | undefined): boolean {
	return (
		method === 'input' ||
		method === 'editor' ||
		method === 'extension_ui.input' ||
		method === 'extension_ui.editor'
	);
}

function isNativeProjectionRequest(method: string | undefined): boolean {
	return (
		method === 'notify' ||
		method === 'setStatus' ||
		method === 'setWidget' ||
		method === 'setTitle' ||
		method === 'set_editor_text' ||
		method === 'extension_ui.notify' ||
		method === 'extension_ui.setStatus' ||
		method === 'extension_ui.setWidget' ||
		method === 'extension_ui.setTitle' ||
		method === 'extension_ui.set_editor_text'
	);
}

function notificationColor(type: string | undefined): 'theme' | 'yellow' | 'red' {
	if (type === 'warning') return 'yellow';
	if (type === 'error') return 'red';
	return 'theme';
}

function extensionResponse(
	id: string,
	method: string | undefined,
	response: Omit<AgentApprovalResponse, 'sessionId' | 'requestId'>,
	request: OmpRpcEvent
): OmpRpcCommand | null {
	if (response.cancelled === true) return { type: 'extension_ui_response', id, cancelled: true };
	if (isTextRequest(method)) {
		if (typeof response.value !== 'string') return null;
		return { type: 'extension_ui_response', id, value: response.value };
	}
	const optionId = response.optionId;
	if (typeof optionId !== 'string') return null;
	const selected = approvalOptions(request).find((option) => option.id === optionId);
	if (!selected) return null;
	return selected.kind === 'custom'
		? { type: 'extension_ui_response', id, value: selected.id }
		: { type: 'extension_ui_response', id, confirmed: selected.kind === 'approve' };
}

function isRuntimeFeatureRequest(method: string | undefined): boolean {
	return (
		method === 'setStatus' ||
		method === 'setWidget' ||
		method === 'setTitle' ||
		method === 'set_editor_text' ||
		method === 'extension_ui.setStatus' ||
		method === 'extension_ui.setWidget' ||
		method === 'extension_ui.setTitle' ||
		method === 'extension_ui.set_editor_text'
	);
}

function approvalFrom(callback: OmpRpcEvent, sessionId: string): AgentApprovalRequest {
	return {
		id: stringAt(callback, 'id') ?? '',
		sessionId,
		toolType: 'omp',
		title: stringAt(callback, 'title') ?? stringAt(callback, 'message') ?? 'OMP approval required',
		detail: stringAt(callback, 'detail'),
		options: approvalOptions(callback),
		...(isTextRequest(stringAt(callback, 'method'))
			? {
					textInput: {
						kind: stringAt(callback, 'method')?.endsWith('editor') ? 'editor' : 'input',
						placeholder: stringAt(callback, 'placeholder'),
						prefill: stringAt(callback, 'prefill'),
						promptStyle: callback.promptStyle === true,
					},
				}
			: {}),
		createdAt: new Date().toISOString(),
	};
}

function controlCommand(controlId: string, value: string | boolean): OmpRpcCommand | null {
	if (!isRegisteredOmpControl(controlId)) return null;
	if (controlId === 'model' && typeof value === 'string') return modelCommand(value);
	if (controlId === 'thinking-level' && typeof value === 'string')
		return { type: 'set_thinking_level', level: value };
	if (controlId === 'steering-mode' && typeof value === 'string')
		return { type: 'set_steering_mode', mode: value };
	if (controlId === 'follow-up-mode' && typeof value === 'string')
		return { type: 'set_follow_up_mode', mode: value };
	if (controlId === 'interrupt-mode' && typeof value === 'string')
		return { type: 'set_interrupt_mode', mode: value };
	if (controlId === 'session-name' && typeof value === 'string' && value.trim())
		return { type: 'set_session_name', name: value.trim() };
	if (controlId === 'switch-session' && typeof value === 'string' && value.trim())
		return { type: 'switch_session', sessionPath: value.trim() };
	if (controlId === 'bash' && typeof value === 'string' && value.trim())
		return { type: 'bash', command: value.trim() };
	if (controlId === 'login' && typeof value === 'string' && value.trim())
		return { type: 'login', providerId: value.trim() };
	if (controlId === 'auto-compaction' && typeof value === 'boolean')
		return { type: 'set_auto_compaction', enabled: value };
	if (controlId === 'auto-retry' && typeof value === 'boolean')
		return { type: 'set_auto_retry', enabled: value };
	if (value === true) {
		const actions: Record<string, OmpRpcCommand> = {
			'new-session': { type: 'new_session' },
			compact: { type: 'compact' },
			handoff: { type: 'handoff' },
			'export-html': { type: 'export_html' },
			'cycle-model': { type: 'cycle_model' },
			'cycle-thinking-level': { type: 'cycle_thinking_level' },
			'abort-retry': { type: 'abort_retry' },
			'abort-bash': { type: 'abort_bash' },
		};
		return actions[controlId] ?? null;
	}
	return null;
}
