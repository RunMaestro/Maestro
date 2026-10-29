import {
	isMemoryCommandDraft,
	validateMemoryCommandSelection,
	type MemoryCommandDraft,
	type MemoryCommandDraftStatus,
	type MemoryCommandSelection,
	type SelectedMemoryCommandSnapshot,
} from '../../shared/memoryCommandDraft';
import { generateUUID } from '../../shared/uuid';
import { canonicalJson } from '../../shared/canonicalJson';
import type { CodexMemorySourceRef } from '../../shared/codexMemory';
import { resolveCodexMemorySourceRef, type CodexMemorySource } from '../agents/codex-memory';

/** Constructed by the authenticated host transport, never taken from plugin parameters. */
export interface MemoryCommandDraftOwner {
	hostClientId: string;
	viewerId: string;
	pluginId: string;
}

export interface MemoryCommandDraftBinding extends MemoryCommandDraftOwner {
	sourceAgentId: string;
	generatorAgentId: string;
}

export interface MemoryCommandDraftDeps {
	/** CLI previews are retrieved after reconnect; desktop previews are delivered immediately. */
	retainPreview?: (owner: Readonly<MemoryCommandDraftOwner>) => boolean;
	/** Resolve session/provider/global environment just as the existing memory IPC does. */
	getSource: (
		sourceAgentId: string
	) => CodexMemorySource | undefined | Promise<CodexMemorySource | undefined>;
	/** Read the stored agent configuration; renderer model/effort hints are never used. */
	getGenerator: (agentId: string) => MemoryCommandSelection['generator'] | undefined;
	/** Live active-command/sandbox, trust, grants, unattended and host-client checks. */
	isAllowed: (binding: Readonly<MemoryCommandDraftBinding>) => boolean;
}

type Status = MemoryCommandDraftStatus['status'];
interface Request {
	requestId: string;
	owner: MemoryCommandDraftOwner;
	generatorAgentId: string;
	status: Status;
	/** Loss of the viewer during an authorized write prevents retry, not its successful commit. */
	abandoned?: boolean;
	active?: {
		sourceRef: CodexMemorySourceRef;
		text?: string;
		dirty: boolean;
		registered: boolean;
		savePending?: boolean;
		controller?: AbortController;
		draft?: MemoryCommandDraft;
	};
}

/** Process-local state only. No runner, persistent store, timer, events or logging. */
export class MemoryCommandDraftService {
	private readonly requests = new Map<string, Request>();

	constructor(private readonly deps: MemoryCommandDraftDeps) {}

	private status(request: Request): MemoryCommandDraftStatus {
		return { requestId: request.requestId, status: request.status };
	}

	private owned(pluginId: string, requestId: string, generatorAgentId?: string): Request {
		const request = this.requests.get(requestId);
		if (
			!request ||
			request.owner.pluginId !== pluginId ||
			(generatorAgentId !== undefined && request.generatorAgentId !== generatorAgentId)
		) {
			throw new Error('MemoryCommandInvalid');
		}
		return request;
	}

	private hostOwned(owner: MemoryCommandDraftOwner, requestId: string): Request {
		const request = this.owned(owner.pluginId, requestId);
		if (
			request.owner.hostClientId !== owner.hostClientId ||
			request.owner.viewerId !== owner.viewerId
		) {
			throw new Error('MemoryCommandInvalid');
		}
		return request;
	}

	private current(request: Request, states: Status[]): NonNullable<Request['active']> {
		if (
			this.requests.get(request.requestId) !== request ||
			!request.active ||
			!states.includes(request.status)
		)
			throw new Error('MemoryCommandInvalid');
		return request.active;
	}

	private generator(request: Request): MemoryCommandSelection['generator'] {
		const generator = this.deps.getGenerator(request.generatorAgentId);
		if (
			!generator ||
			generator.agentId !== request.generatorAgentId ||
			generator.provider !== 'codex'
		) {
			throw new Error('MemoryCommandUnavailable');
		}
		return { ...generator };
	}

	private authorize(request: Request): void {
		const active = request.active!;
		this.generator(request);
		if (
			!this.deps.isAllowed({
				...request.owner,
				sourceAgentId: active.sourceRef.sourceAgentId,
				generatorAgentId: request.generatorAgentId,
			})
		)
			throw new Error('MemoryCommandDenied');
	}

	/** Recheck after asynchronous source resolution and before exposing text or changing state. */
	private async check(request: Request, states: Status[]): Promise<void> {
		const active = this.current(request, states);
		let resolved: CodexMemorySourceRef;
		let sourceIdentity: string;
		try {
			this.authorize(request);
			const source = await this.deps.getSource(active.sourceRef.sourceAgentId);
			this.current(request, states);
			this.authorize(request);
			if (!source || source.sourceAgentId !== active.sourceRef.sourceAgentId) {
				throw new Error('MemoryCommandUnavailable');
			}
			sourceIdentity = canonicalJson(source);
			resolved = await resolveCodexMemorySourceRef(source, active.sourceRef.relativePath);
		} catch {
			if (
				this.requests.get(request.requestId) === request &&
				request.active &&
				states.includes(request.status)
			)
				this.finish(request, 'error');
			throw new Error('MemoryCommandUnavailable');
		}
		let latestSource: CodexMemorySource | undefined;
		try {
			latestSource = await this.deps.getSource(active.sourceRef.sourceAgentId);
		} catch {
			if (
				this.requests.get(request.requestId) === request &&
				request.active &&
				states.includes(request.status)
			)
				this.finish(request, 'error');
			throw new Error('MemoryCommandUnavailable');
		}
		// A competing start/preview is a replay, not a failed live permission check.
		this.current(request, states);
		try {
			this.authorize(request);
			if (
				canonicalJson(resolved) !== canonicalJson(active.sourceRef) ||
				canonicalJson(latestSource) !== sourceIdentity
			)
				throw new Error('MemoryCommandUnavailable');
		} catch {
			if (
				this.requests.get(request.requestId) === request &&
				request.active &&
				states.includes(request.status)
			)
				this.finish(request, 'error');
			throw new Error('MemoryCommandUnavailable');
		}
	}

	/** Drop text and draft before firing abort listeners; retain only bounded cancellation metadata. */
	private finish(request: Request, status: 'saved' | 'cancelled' | 'error'): void {
		const controller = request.active?.controller;
		if (request.active) {
			delete request.active.text;
			delete request.active.draft;
		}
		delete request.active;
		request.status = status;
		this.requests.delete(request.requestId);
		this.requests.set(request.requestId, request);
		const terminal = [...this.requests.values()].filter(
			(entry) => entry.owner.pluginId === request.owner.pluginId && !entry.active
		);
		for (const entry of terminal.slice(0, Math.max(0, terminal.length - 64))) {
			this.requests.delete(entry.requestId);
		}
		controller?.abort();
	}

	/** Replace the viewer's cancellable request; an authorized write may finish independently. */
	async register(
		owner: MemoryCommandDraftOwner,
		value: unknown
	): Promise<MemoryCommandDraftStatus> {
		try {
			validateMemoryCommandSelection(value);
		} catch {
			throw new Error('MemoryCommandInvalid');
		}
		if (
			[owner.hostClientId, owner.viewerId, owner.pluginId].some(
				(id) => typeof id !== 'string' || !id.trim() || id.length > 4096
			)
		)
			throw new Error('MemoryCommandInvalid');
		for (const entry of this.requests.values()) {
			if (
				entry.active &&
				entry.owner.hostClientId === owner.hostClientId &&
				entry.owner.viewerId === owner.viewerId
			)
				this.cancelRequest(entry);
		}
		if ([...this.requests.values()].filter((entry) => entry.active).length >= 32) {
			throw new Error('MemoryCommandBusy');
		}
		const selection = value.selection;
		const request: Request = {
			requestId: generateUUID(),
			owner: { ...owner },
			generatorAgentId: value.generator.agentId,
			status: 'selected',
			active: {
				sourceRef: { ...value.sourceRef, location: { ...value.sourceRef.location } },
				text:
					selection && selection.start !== selection.end
						? value.textSnapshot.slice(selection.start, selection.end)
						: value.textSnapshot,
				dirty: value.dirty,
				registered: false,
			},
		};
		this.requests.set(request.requestId, request); // Reserve capacity across async validation.
		await this.check(request, ['selected']);
		this.current(request, ['selected']).registered = true;
		return this.status(request);
	}

	/** Text-free host status remains usable after revoke so the UI can explain cancellation. */
	getStatus(owner: MemoryCommandDraftOwner, requestId: string): MemoryCommandDraftStatus {
		return this.status(this.hostOwned(owner, requestId));
	}

	/** Owner-checked metadata for the handler's exact-agent authorization, never source text. */
	getGeneratorAgentId(pluginId: string, requestId: string, state?: Status): string {
		const request = this.owned(pluginId, requestId);
		if (state) this.current(request, [state]);
		return request.generatorAgentId;
	}

	/** Plugin can fetch only its own explicitly released selection before generation starts. */
	async get(pluginId: string, requestId: string): Promise<SelectedMemoryCommandSnapshot> {
		const request = this.owned(pluginId, requestId);
		if (!request.active?.registered) throw new Error('MemoryCommandInvalid');
		await this.check(request, ['selected']);
		const active = this.current(request, ['selected']);
		return {
			requestId,
			sourceRef: { ...active.sourceRef, location: { ...active.sourceRef.location } },
			text: active.text!,
			dirty: active.dirty,
			generatorAgentId: request.generatorAgentId,
		};
	}

	/** Return this controller to the existing runner and its cleanup set; no second controller or timer. */
	async start(pluginId: string, requestId: string, generatorAgentId: string) {
		const request = this.owned(pluginId, requestId, generatorAgentId);
		if (!request.active?.registered) throw new Error('MemoryCommandInvalid');
		await this.check(request, ['selected']);
		const active = this.current(request, ['selected']);
		const generator = this.generator(request);
		request.status = 'generating';
		const controller = new AbortController();
		active.controller = controller;
		controller.signal.addEventListener(
			'abort',
			() => {
				if (
					this.requests.get(requestId) === request &&
					request.active?.controller === controller &&
					request.status !== 'saving'
				) {
					this.finish(request, 'cancelled');
				}
			},
			{ once: true }
		);
		return { controller, generator };
	}

	/** Synchronous permission check for progress; completion also re-resolves the source. */
	checkRunning(pluginId: string, requestId: string, controller: AbortController): void {
		const request = this.owned(pluginId, requestId);
		if (this.current(request, ['generating']).controller !== controller)
			throw new Error('MemoryCommandInvalid');
		try {
			this.authorize(request);
		} catch {
			this.finish(request, 'error');
			throw new Error('MemoryCommandUnavailable');
		}
	}

	/** Only the handler that claimed this generation may terminalize a failed run. */
	failRun(pluginId: string, requestId: string, controller: AbortController): void {
		const request = this.requests.get(requestId);
		if (
			request?.owner.pluginId === pluginId &&
			request.active?.controller === controller &&
			request.status !== 'saving'
		)
			this.finish(request, 'error');
	}

	/** Only the host's own successful run may complete an ID; late results are discarded. */
	async complete(
		pluginId: string,
		requestId: string,
		controller: AbortController,
		draft: unknown
	): Promise<boolean> {
		const request = this.owned(pluginId, requestId);
		if (!request.active) return false;
		if (request.status !== 'generating' || request.active.controller !== controller) {
			throw new Error('MemoryCommandInvalid');
		}
		try {
			await this.check(request, ['generating']);
			this.current(request, ['generating']);
		} catch {
			return false;
		}
		if (!isMemoryCommandDraft(draft)) {
			this.finish(request, 'error');
			throw new Error('MemoryCommandInvalid');
		}
		delete request.active!.text;
		// Keep the request's cancellation signal through the asynchronous RPC reply/preview boundary.
		request.active!.draft = { ...draft };
		request.status = 'ready';
		return true;
	}

	/** Atomically claim the exact validated draft once; the host routes it to this owner only. */
	async preview(pluginId: string, requestId: string, draft: unknown) {
		const request = this.owned(pluginId, requestId);
		await this.check(request, ['ready']);
		this.current(request, ['ready']);
		if (
			!isMemoryCommandDraft(draft) ||
			canonicalJson(draft) !== canonicalJson(request.active!.draft)
		) {
			throw new Error('MemoryCommandInvalid');
		}
		request.status = 'preview';
		const result = { owner: { ...request.owner }, draft: { ...request.active!.draft! } };
		if (!this.deps.retainPreview?.(request.owner)) delete request.active!.draft;
		return result;
	}

	/** Re-read only the owner's validated preview, with the same live gates as delivery. */
	async getPreview(owner: MemoryCommandDraftOwner, requestId: string): Promise<MemoryCommandDraft> {
		const request = this.hostOwned(owner, requestId);
		await this.check(request, ['preview']);
		const draft = this.current(request, ['preview']).draft;
		if (!draft) throw new Error('MemoryCommandUnavailable');
		return { ...draft };
	}

	/** Revalidate the owning request before crossing the explicit persistence commit point. */
	async save(
		owner: MemoryCommandDraftOwner,
		requestId: string,
		persist: () => boolean | Promise<boolean>
	): Promise<boolean> {
		const request = this.hostOwned(owner, requestId);
		const active = this.current(request, ['preview']);
		if (active.savePending) throw new Error('MemoryCommandInvalid');
		active.savePending = true;
		try {
			await this.check(request, ['preview']);
			this.current(request, ['preview']);
			this.authorize(request);
			// No await between the last live check, claiming the write, and invoking persistence.
			request.status = 'saving';
			if ((await persist()) !== true) return false;
			this.saved(owner, requestId);
			return true;
		} finally {
			if (request.active === active) {
				delete active.savePending;
				if (request.status === 'saving') {
					if (request.abandoned) this.finish(request, 'cancelled');
					else request.status = 'preview';
				}
			}
		}
	}

	/** Only save() may acknowledge a write; renderer/plugin callbacks confer no authority. */
	private saved(owner: MemoryCommandDraftOwner, requestId: string): void {
		const request = this.hostOwned(owner, requestId);
		this.current(request, ['saving']);
		this.finish(request, 'saved');
	}

	/** Plugin cancellation also checks the exact generator. Foreign and absent IDs have one error. */
	cancel(pluginId: string, requestId: string, generatorAgentId: string): boolean {
		return this.cancelRequest(this.owned(pluginId, requestId, generatorAgentId));
	}

	/** Host cancellation must work even when plugin grants have already been revoked. */
	cancelForHost(owner: MemoryCommandDraftOwner, requestId: string): boolean {
		return this.cancelRequest(this.hostOwned(owner, requestId));
	}

	private cancelRequest(request: Request): boolean {
		if (!request.active) return false;
		if (request.status === 'saving') {
			request.abandoned = true;
			return false;
		}
		this.finish(request, 'cancelled');
		return true;
	}

	/** Timeout/dispatch/runner failure is a code-free terminal state; never accept provider error text. */
	fail(owner: MemoryCommandDraftOwner, requestId: string): void {
		const request = this.hostOwned(owner, requestId);
		if (request.active && request.status !== 'saving') this.finish(request, 'error');
	}

	closeViewer(hostClientId: string, viewerId: string): void {
		for (const request of this.requests.values()) {
			if (
				request.active &&
				request.owner.hostClientId === hostClientId &&
				request.owner.viewerId === viewerId
			) {
				this.cancelRequest(request);
			}
		}
	}

	/** Remove requests before abort callbacks; an already authorized write alone keeps its receipt. */
	private cleanup(matches: (request: Request) => boolean): void {
		const controllers: AbortController[] = [];
		for (const request of this.requests.values()) {
			if (!matches(request)) continue;
			if (request.status === 'saving') {
				request.abandoned = true;
				continue;
			}
			if (request.active?.controller) controllers.push(request.active.controller);
			if (request.active) {
				delete request.active.text;
				delete request.active.draft;
			}
			delete request.active;
			this.requests.delete(request.requestId);
		}
		for (const controller of controllers) controller.abort();
	}

	cleanupPlugin(pluginId: string): void {
		this.cleanup((request) => request.owner.pluginId === pluginId);
	}

	cleanupClient(hostClientId: string): void {
		this.cleanup((request) => request.owner.hostClientId === hostClientId);
	}
}
