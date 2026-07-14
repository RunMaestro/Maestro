import { spawn as spawnChild } from 'child_process';
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from 'child_process';
import type {
	AgentApprovalRequest,
	AgentControl,
	AgentControlOption,
	AgentRuntimeFeatureState,
	AgentSubagent,
	AgentTodoPhase,
	AgentTreeNode,
} from '../../shared/agent-runtime-features';
import { OmpRpcClient } from './rpc-client';
import type { OmpRpcCommand, OmpRpcEvent, OmpRpcTransport } from './types';

export type OmpNativeSend = (channel: string, ...args: unknown[]) => void;
export type OmpChildSpawner = (
	command: string,
	args: readonly string[],
	options: SpawnOptionsWithoutStdio
) => ChildProcessWithoutNullStreams;

export interface OmpNativeSessionOptions {
	sessionId: string;
	cwd: string;
	command: string;
	env?: NodeJS.ProcessEnv;
	agentSessionId?: string;
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
	private disposed = false;

	private constructor(private readonly options: OmpNativeSessionOptions) {
		const spawn = options.spawn ?? spawnChild;
		// Intentionally omit every managed-plugin sandbox flag. Native sessions run
		// with the user's OMP profile, sessions, extensions, tools, skills, and rules.
		this.child = spawn(options.command, ['--mode', 'rpc'], {
			cwd: options.cwd,
			env: options.env ?? process.env,
			windowsHide: true,
		});
		this.client = new OmpRpcClient(this.transport());
		this.client.onEvent((event) => this.handleEvent(event));
		this.client.onCallback((callback) => this.handleCallback(callback));
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
		if (existing && !existing.disposed) return existing;
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

	async prompt(message: string): Promise<void> {
		await this.initialized;
		await this.client.command({ type: 'prompt', message });
	}

	async interrupt(): Promise<void> {
		await this.ready;
		await this.client.command({ type: 'abort' });
	}

	async respondApproval(requestId: string, optionId: string): Promise<boolean> {
		await this.initialized;
		const request = this.approvals.get(requestId);
		if (!request) return false;
		this.approvals.delete(requestId);
		const options = approvalOptions(request);
		const selected = options.find((option) => option.id === optionId);
		if (!selected) return false;
		await this.client.send({
			type: 'extension_ui_response',
			id: requestId,
			confirmed: selected.kind === 'approve',
			cancelled: selected.kind === 'deny' ? true : undefined,
			value: selected.kind === 'custom' ? optionId : undefined,
		});
		return true;
	}

	async setControl(controlId: string, value: string | boolean): Promise<boolean> {
		await this.initialized;
		const command = controlCommand(controlId, value);
		if (!command) return false;
		await this.client.command(command);
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
		await Promise.all([this.emitCommands(), this.refreshFeatures()]);
	}

	private async emitCommands(): Promise<void> {
		const response = await this.client.command({ type: 'get_available_commands' });
		const commands = Array.isArray(response.data)
			? response.data.map(commandName).filter((command): command is string => Boolean(command))
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
		const modelOptions = Array.isArray(models.data)
			? models.data.map(modelOption).filter((option) => option.id.length > 0)
			: [];
		const statsProjection = statsFromData(stats.data);
		const features: AgentRuntimeFeatureState = {
			controls: controlsFromState(stateData, modelOptions),
			tree: treeFromMessages(messages.data),
			todos: todosFromState(stateData),
			subagents: subagentsFromData(subagents.data),
			stats: statsProjection,
		};
		this.options.send('process:runtime-features', this.options.sessionId, features);
		const usage = usageFromStats(statsProjection);
		if (usage) this.options.send('process:usage', this.options.sessionId, usage);
		const sessionId = stringAt(stateData, 'sessionId');
		if (sessionId) this.options.send('process:session-id', this.options.sessionId, sessionId);
	}

	private handleEvent(event: OmpRpcEvent): void {
		if (event.type === 'message_update') {
			const text = textFrom(event);
			if (text) this.options.send('process:data', this.options.sessionId, text);
		}
		if (event.type === 'message_update' && event.thinking === true) {
			const text = textFrom(event);
			if (text) this.options.send('process:thinking-chunk', this.options.sessionId, text);
		}
		if (event.type.startsWith('tool_execution_')) {
			this.options.send('process:tool-execution', this.options.sessionId, {
				toolName: stringAt(event, 'toolName') ?? stringAt(event, 'name') ?? 'tool',
				state: event,
				timestamp: Date.now(),
				toolCallId: stringAt(event, 'id'),
			});
		}
		if (event.type === 'turn_end' || event.type === 'agent_end') void this.refreshFeatures();
	}

	private handleCallback(callback: OmpRpcEvent): void {
		if (callback.type === 'prompt_result') {
			const text = textFrom(callback);
			if (text) this.options.send('process:data', this.options.sessionId, text);
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
		if (callback.type === 'extension_ui_request') {
			const id = stringAt(callback, 'id');
			if (!id) return;
			this.approvals.set(id, callback);
			this.options.send('process:approval-request', approvalFrom(callback, this.options.sessionId));
			return;
		}
		if (
			callback.type.startsWith('subagent_') ||
			callback.type === 'session_info_update' ||
			callback.type === 'config_update'
		)
			void this.refreshFeatures();
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

function textFrom(record: Record<string, unknown>): string | undefined {
	for (const key of ['delta', 'content', 'text', 'message', 'result']) {
		const value = record[key];
		if (typeof value === 'string') return value;
	}
	return undefined;
}

function commandName(value: unknown): string | undefined {
	if (typeof value === 'string') return value;
	return stringAt(asRecord(value), 'name');
}

function controlsFromState(
	state: Record<string, unknown>,
	modelOptions: AgentControl['options']
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
		{
			id: 'composer-mode',
			label: 'Composer mode',
			kind: 'select',
			options: ['build', 'plan', 'ask'].map((id) => ({ id, label: id })),
			value: stringAt(state, 'composerMode') ?? 'build',
		},
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
			id: 'auto-compaction',
			label: 'Auto-compaction',
			kind: 'toggle',
			value: state.autoCompactionEnabled === true,
		},
		{
			id: 'auto-retry',
			label: 'Auto-retry',
			kind: 'toggle',
			value: state.autoRetryEnabled === true,
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

function todosFromState(state: Record<string, unknown>): AgentTodoPhase[] | null {
	const phases = Array.isArray(state.todoPhases) ? state.todoPhases : null;
	if (!phases) return null;
	return phases.map((phase) => {
		const record = asRecord(phase);
		return {
			name: stringAt(record, 'name') ?? 'Tasks',
			items: Array.isArray(record.items)
				? record.items.map((item) => {
						const entry = asRecord(item);
						const rawState = stringAt(entry, 'state');
						return {
							content: stringAt(entry, 'content') ?? '',
							state:
								rawState === 'in_progress' || rawState === 'done' || rawState === 'dropped'
									? rawState
									: 'open',
						};
					})
				: [],
		};
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

function subagentsFromData(value: unknown): AgentSubagent[] | null {
	if (!Array.isArray(value)) return null;
	return value.map((subagent, index) => {
		const record = asRecord(subagent);
		const status = stringAt(record, 'status');
		return {
			id: stringAt(record, 'id') ?? String(index),
			label: stringAt(record, 'label') ?? stringAt(record, 'name') ?? 'Subagent',
			status: status === 'idle' || status === 'complete' || status === 'error' ? status : 'running',
			detail: stringAt(record, 'detail'),
		};
	});
}

function statsFromData(value: unknown): Record<string, number | string> | null {
	const record = asRecord(value);
	const entries = Object.entries(record).filter(
		([, item]) => typeof item === 'number' || typeof item === 'string'
	);
	return entries.length ? (Object.fromEntries(entries) as Record<string, number | string>) : null;
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
	const options: AgentApprovalRequest['options'] = raw.map((item, index) => {
		const option = asRecord(item);

		const id = stringAt(option, 'id') ?? String(index);
		const kind = stringAt(option, 'kind');
		return {
			id,
			label: stringAt(option, 'label') ?? id,
			kind: kind === 'approve' || kind === 'deny' ? kind : 'custom',
		};
	});
	return options.length
		? options
		: [
				{ id: 'approve', label: 'Approve', kind: 'approve' },
				{ id: 'deny', label: 'Deny', kind: 'deny' },
			];
}

function approvalFrom(callback: OmpRpcEvent, sessionId: string): AgentApprovalRequest {
	return {
		id: stringAt(callback, 'id') ?? '',
		sessionId,
		toolType: 'omp',
		title: stringAt(callback, 'title') ?? stringAt(callback, 'message') ?? 'OMP approval required',
		detail: stringAt(callback, 'detail'),
		options: approvalOptions(callback),
		createdAt: new Date().toISOString(),
	};
}

function controlCommand(controlId: string, value: string | boolean): OmpRpcCommand | null {
	if (controlId === 'model' && typeof value === 'string') {
		const [provider, modelId] = value.split(':', 2);
		return provider && modelId ? { type: 'set_model', provider, modelId } : null;
	}
	if (controlId === 'thinking-level' && typeof value === 'string')
		return { type: 'set_thinking_level', level: value };
	if (controlId === 'composer-mode' && typeof value === 'string')
		return { type: 'set_follow_up_mode', mode: value === 'plan' ? 'one-at-a-time' : 'all' };
	if (controlId === 'steering-mode' && typeof value === 'string')
		return { type: 'set_steering_mode', mode: value };
	if (controlId === 'auto-compaction' && typeof value === 'boolean')
		return { type: 'set_auto_compaction', enabled: value };
	if (controlId === 'auto-retry' && typeof value === 'boolean')
		return { type: 'set_auto_retry', enabled: value };
	return null;
}
