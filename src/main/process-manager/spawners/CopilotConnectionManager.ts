import {
	CopilotClient,
	RuntimeConnection,
	type CopilotSession,
	type ElicitationContext,
	type PermissionHandler,
	type PermissionRequest,
	type ElicitationResult,
} from '@github/copilot-sdk';
import type { ProcessConfig } from '../types';
import { buildChildProcessEnv } from '../utils/envBuilder';
import { resolveCopilotRuntimeExecutable } from '../../../shared/maestro-lib/providers/copilot-runtime';
import { canonicalJson } from '../../../shared/canonicalJson';

export interface CopilotInteractionHandlers {
	onPermissionRequest: PermissionHandler;
	onUserInputRequest: (request: {
		question: string;
		choices?: string[];
		allowFreeform?: boolean;
	}) => Promise<{ answer: string; wasFreeform: boolean }>;
	onElicitationRequest: (request: ElicitationContext) => Promise<ElicitationResult>;
}

export interface CopilotConnectionLease {
	key: string;
	identity: string;
	client: CopilotClient;
	session: CopilotSession;
	handlers: CopilotInteractionHandlers;
	refs: number;
	initializing: boolean;
	closed: boolean;
	agentId: string;
	replacing: boolean;
}

function connectionIdentity(config: ProcessConfig): string {
	return canonicalJson({
		cwd: config.cwd,
		command: config.command,
		model: config.modelId,
		effort: config.effort,
		appendSystemPrompt: config.appendSystemPrompt,
		env: config.customEnvVars,
		shellEnv: config.shellEnvVars,
	});
}

/** One synchronously reserved runtime slot per owning tab. */
export class CopilotConnectionManager {
	private readonly leases = new Map<string, CopilotConnectionLease>();

	async acquire(
		config: ProcessConfig,
		handlers: CopilotInteractionHandlers
	): Promise<CopilotConnectionLease> {
		const owner = config.tabId ?? config.sessionId;
		const identity = connectionIdentity(config);
		const existing = this.leases.get(owner);
		if (existing) {
			if (existing.refs > 0 || existing.initializing || existing.replacing) {
				throw new Error('Copilot session is still running another turn');
			}
			if (
				existing.identity === identity &&
				(!config.agentSessionId || existing.session.sessionId === config.agentSessionId)
			) {
				existing.refs = 1;
				existing.handlers = handlers;
				return existing;
			}
			existing.replacing = true;
			await this.close(existing);
		}

		const client = new CopilotClient({
			connection: RuntimeConnection.forStdio({
				path: resolveCopilotRuntimeExecutable(config.command),
			}),
			workingDirectory: config.cwd,
			env: buildChildProcessEnv(config.customEnvVars, !!config.agentSessionId, config.shellEnvVars),
			logLevel: 'error',
		});
		const lease: CopilotConnectionLease = {
			key: owner,
			identity,
			client,
			session: undefined as unknown as CopilotSession,
			handlers,
			refs: 1,
			initializing: true,
			closed: false,
			agentId: config.sessionId.replace(/-ai(?:-.+)?$/, ''),
			replacing: false,
		};
		// Reserve before the first await. A second acquisition now fails instead of
		// initializing another runtime for the same owner.
		this.leases.set(owner, lease);
		try {
			await client.start();
			const sessionConfig = {
				model: config.modelId,
				reasoningEffort: config.effort as 'low' | 'medium' | 'high' | 'xhigh' | 'max' | undefined,
				workingDirectory: config.cwd,
				streaming: true,
				onPermissionRequest: (
					request: PermissionRequest,
					invocation: Parameters<PermissionHandler>[1]
				) => lease.handlers.onPermissionRequest(request, invocation),
				onUserInputRequest: (request: {
					question: string;
					choices?: string[];
					allowFreeform?: boolean;
				}) => lease.handlers.onUserInputRequest(request),
				onElicitationRequest: (request: ElicitationContext) =>
					lease.handlers.onElicitationRequest(request),
				systemMessage: config.appendSystemPrompt
					? { mode: 'append' as const, content: config.appendSystemPrompt }
					: undefined,
			};
			lease.session = config.agentSessionId
				? await client.resumeSession(config.agentSessionId, sessionConfig)
				: await client.createSession(sessionConfig);
			lease.initializing = false;
			return lease;
		} catch (error) {
			await this.close(lease);
			throw error;
		}
	}

	release(lease: CopilotConnectionLease): void {
		lease.refs = Math.max(0, lease.refs - 1);
	}

	async close(lease: CopilotConnectionLease): Promise<void> {
		if (lease.closed) return;
		lease.closed = true;
		lease.initializing = false;
		if (!lease.replacing && this.leases.get(lease.key) === lease) this.leases.delete(lease.key);
		await lease.client.forceStop();
	}

	async closeAll(): Promise<void> {
		await Promise.all([...this.leases.values()].map((lease) => this.close(lease)));
		this.leases.clear();
	}

	async closeAgent(agentId: string): Promise<void> {
		await Promise.all(
			[...this.leases.values()]
				.filter((lease) => lease.agentId === agentId)
				.map(async (lease) => {
					await this.close(lease);
					if (this.leases.get(lease.key) === lease) this.leases.delete(lease.key);
				})
		);
	}
}
