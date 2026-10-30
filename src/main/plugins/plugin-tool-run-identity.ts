/** Host-minted run proofs. A resolved proof confers no plugin domain policy. */
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { performance } from 'perf_hooks';
import { PLUGIN_ID_PATTERN } from '../../shared/plugins/plugin-manifest';
import { assertPluginAuthority } from './plugin-authority';
import { requirePluginAgentId } from './plugin-authority';
import { PluginAuthorityError } from './plugin-authority';

export const PLUGIN_TOOL_RUN_LIMITS = Object.freeze({
	runs: 512,
	invocations: 512,
	invocationsPerRun: 32,
	invocationsPerPlugin: 32,
	invocationTtlMs: 30_000,
	defaultTtlMs: 60 * 60 * 1000,
	maxTtlMs: 24 * 60 * 60 * 1000 + 60_000,
});

/** Supplied exclusively by the host's run lifecycle, never by tool arguments. */
export interface PluginToolRunAuthority {
	/** Host-stamped execution mode. Unspecified callers conservatively require unattended consent. */
	readonly unattended?: boolean;
	readonly signal: AbortSignal;
	assertActive(): void;
}

/** Keep this context host-private; a serialized agentId alone is never proof. */
export interface PluginToolCallerContext extends PluginToolRunAuthority {
	readonly callerAgentId: string;
}

/** A host-private result, never a serialized caller-ID proof. */
export interface PluginToolInvocationContext extends PluginToolCallerContext {
	readonly pluginId: string;
}

interface Invocation {
	readonly pluginId: string;
	readonly runToken: string;
	readonly run: RunProof;
	readonly expiresAt: number;
	readonly controller: AbortController;
	readonly source: AbortSignal;
	readonly checkPlugin: () => void;
	checking: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

interface PluginLifetime {
	readonly handles: Set<string>;
	readonly onAbort: () => void;
}

interface RunProof {
	readonly agentId: string;
	readonly unattended: boolean;
	readonly invocations: Set<string>;
	readonly expiresAt: number;
	readonly controller: AbortController;
	readonly source: AbortSignal;
	readonly checkRun: () => void;
	readonly onAbort: () => void;
	checking: boolean;
	timer?: ReturnType<typeof setTimeout>;
}

/** One registry per main host. No default membership check, singleton or disk delivery. */
export class PluginToolRunIdentity {
	private readonly runs = new Map<string, RunProof>();
	private readonly contexts = new WeakMap<object, { token: string; run: RunProof }>();
	private readonly invocations = new Map<string, Invocation>();
	private readonly pluginLifetimes = new Map<AbortSignal, PluginLifetime>();
	private readonly revokingAgents = new Set<string>();
	private assertAgentActive: (agentId: string) => void;
	private issuing?: { readonly controller: AbortController; agentId?: string };
	private issuingInvocation?: AbortController;
	private stopped = false;

	constructor(
		assertAgentActive: (agentId: string) => void = (agentId) => {
			requirePluginAgentId(agentId);
		}
	) {
		if (typeof assertAgentActive !== 'function') throw new PluginAuthorityError('PLUGIN_DENIED');
		this.assertAgentActive = assertAgentActive;
	}

	setAgentActiveAssertion(assertion: (agentId: string) => void): void {
		this.assertAgentActive = assertion;
	}

	/** Delete first: synchronous abort listeners must never resolve the revoked proof. */
	private remove(token: string, run: RunProof): void {
		if (this.runs.get(token) !== run) return;
		this.runs.delete(token);
		this.receiptRuns.delete(token);
		for (const handle of [...run.invocations]) this.releaseInvocation(handle);
		if (run.timer) clearTimeout(run.timer);
		run.source.removeEventListener('abort', run.onAbort);
		run.controller.abort();
	}

	private check(token: string, run: RunProof): void {
		const checking = run.checking;
		try {
			// Recursive host assertions invalidate the proof before any further callback.
			if (checking) throw new PluginAuthorityError('PLUGIN_DENIED');
			run.checking = true;
			const checkLifetime = () => {
				if (this.stopped || this.revokingAgents.has(run.agentId) || this.runs.get(token) !== run)
					throw new PluginAuthorityError('PLUGIN_DENIED');
				if (run.source.aborted || run.controller.signal.aborted)
					throw new PluginAuthorityError('PLUGIN_CANCELED');
				if (performance.now() >= run.expiresAt) throw new PluginAuthorityError('PLUGIN_TIMEOUT');
			};
			checkLifetime();
			assertPluginAuthority(run.checkRun);
			checkLifetime();
			assertPluginAuthority(() => this.assertAgentActive(run.agentId));
			checkLifetime();
		} catch (error) {
			this.remove(token, run);
			throw new PluginAuthorityError(
				error instanceof PluginAuthorityError ? error.code : 'PLUGIN_DENIED'
			);
		} finally {
			run.checking = checking;
		}
	}

	/** Mint only after host membership/run admission; the token is a private bearer secret. */
	private issueAuthorized(
		agentId: unknown,
		authority: PluginToolRunAuthority,
		ttlMs = PLUGIN_TOOL_RUN_LIMITS.defaultTtlMs
	): string {
		if (this.issuing) {
			// No proof exists yet to cancel recursive initial authority/membership checks.
			this.issuing.controller.abort();
			throw new PluginAuthorityError('PLUGIN_DENIED');
		}
		const admission = new AbortController();
		this.issuing = { controller: admission };
		const owner = this.issuing;
		let token: string | undefined;
		let run: RunProof | undefined;
		try {
			const agent = requirePluginAgentId(agentId);
			// Exact-agent revocation must also reach admission before a proof exists.
			owner.agentId = agent;
			const source = authority?.signal;
			const callback = authority?.assertActive;
			if (!(source instanceof AbortSignal) || typeof callback !== 'function')
				throw new PluginAuthorityError('PLUGIN_DENIED');
			const checkRun = callback.bind(authority);
			if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > PLUGIN_TOOL_RUN_LIMITS.maxTtlMs)
				throw new PluginAuthorityError('PLUGIN_INVALID');
			// The budget includes synchronous host admission work.
			const expiresAt = performance.now() + ttlMs;
			const checkAdmission = () => {
				if (admission.signal.aborted) throw new PluginAuthorityError('PLUGIN_CANCELED');
				if (this.stopped || this.revokingAgents.has(agent) || source.aborted)
					throw new PluginAuthorityError('PLUGIN_DENIED');
				if (performance.now() >= expiresAt) throw new PluginAuthorityError('PLUGIN_TIMEOUT');
			};
			checkAdmission();
			assertPluginAuthority(checkRun);
			checkAdmission();
			assertPluginAuthority(() => this.assertAgentActive(agent));
			checkAdmission();
			// Opportunistic pruning is bounded by the hard registry limit.
			for (const [oldToken, oldRun] of [...this.runs]) {
				if (performance.now() >= oldRun.expiresAt || oldRun.source.aborted)
					this.remove(oldToken, oldRun);
			}
			// Pruning can run reentrant abort handlers; check again before insertion.
			checkAdmission();
			if (this.runs.size >= PLUGIN_TOOL_RUN_LIMITS.runs)
				throw new PluginAuthorityError('PLUGIN_LIMIT');
			token = randomBytes(32).toString('hex');
			if (this.runs.has(token)) throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
			const proof = token;
			run = {
				agentId: agent,
				unattended: authority.unattended !== false,
				invocations: new Set(),
				expiresAt,
				controller: new AbortController(),
				source,
				checkRun,
				checking: false,
				onAbort: () => this.revoke(proof),
			};
			this.runs.set(proof, run);
			source.addEventListener('abort', run.onAbort, { once: true });
			checkAdmission();
			run.timer = setTimeout(() => this.revoke(proof), Math.ceil(expiresAt - performance.now()));
			run.timer.unref();
			this.check(proof, run);
			checkAdmission();
			return proof;
		} catch (error) {
			if (token && run) this.remove(token, run);
			throw new PluginAuthorityError(
				error instanceof PluginAuthorityError ? error.code : 'PLUGIN_DENIED'
			);
		} finally {
			// Failed proof removal/abort listeners cannot mint a replacement during cleanup.
			this.issuing = undefined;
		}
	}

	/** Canonical MCP callers supply the verified agent and revoke on exact-run teardown. */
	issue(
		agentId: unknown,
		authority?: PluginToolRunAuthority | number,
		ttlOrReceipt?: number | string,
		unattended = true
	): string {
		if (authority && typeof authority === 'object')
			return this.issueAuthorized(
				agentId,
				authority,
				typeof ttlOrReceipt === 'number' ? ttlOrReceipt : undefined
			);
		const controller = new AbortController();
		const token = this.issueAuthorized(
			agentId,
			{ signal: controller.signal, assertActive: () => {}, unattended },
			authority ?? PLUGIN_TOOL_RUN_LIMITS.defaultTtlMs
		);
		if (
			ttlOrReceipt !== undefined &&
			(typeof ttlOrReceipt !== 'string' || !ttlOrReceipt || ttlOrReceipt.length > 200)
		) {
			this.revoke(token);
			throw new Error('InvalidPluginReceiptTool');
		}
		this.receiptRuns.set(token, {
			runId: randomBytes(16).toString('hex'),
			toolId: ttlOrReceipt,
			receipts: [],
			overflow: false,
		});
		return token;
	}

	private readonly receiptRuns = new Map<
		string,
		{ runId: string; toolId?: string; receipts: PluginToolReceipt[]; overflow: boolean }
	>();
	resolve(token: unknown): { readonly callerAgentId: string | null } {
		try {
			return Object.freeze({ callerAgentId: this.resolveVerified(token).callerAgentId });
		} catch {
			return Object.freeze({ callerAgentId: null });
		}
	}
	recordReceipt(token: unknown, toolId: string, result: unknown): void {
		const agentId = this.resolve(token).callerAgentId;
		const run = typeof token === 'string' ? this.receiptRuns.get(token) : undefined;
		if (
			!agentId ||
			!run ||
			run.toolId !== toolId ||
			run.overflow ||
			!result ||
			typeof result !== 'object'
		)
			return;
		const record = result as Record<string, unknown>;
		if (record.success === false || record.ok === false || record.error != null) return;
		const ids = record.messageIds;
		if (
			!Array.isArray(ids) ||
			!ids.length ||
			ids.length > 20 ||
			!ids.every((id) => typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id))
		)
			return;
		if (run.receipts.length >= 16) {
			run.overflow = true;
			return;
		}
		run.receipts.push({ runId: run.runId, agentId, toolId, messageIds: [...ids] });
	}
	getReceipts(token: unknown): PluginToolReceipt[] {
		if (!this.resolve(token).callerAgentId || typeof token !== 'string') return [];
		return (
			this.receiptRuns.get(token)?.receipts.map((r) => ({ ...r, messageIds: [...r.messageIds] })) ??
			[]
		);
	}
	hasReceiptOverflowed(token: unknown): boolean {
		return (
			!!this.resolve(token).callerAgentId &&
			typeof token === 'string' &&
			this.receiptRuns.get(token)?.overflow === true
		);
	}

	/** Resolve exact proofs only. No anonymous fallback can be mistaken for verified authority. */
	resolveVerified(token: unknown): PluginToolCallerContext {
		if (typeof token !== 'string' || token.length !== 64 || !/^[0-9a-f]{64}$/.test(token))
			throw new PluginAuthorityError('PLUGIN_DENIED');
		const run = this.runs.get(token);
		if (!run) throw new PluginAuthorityError('PLUGIN_DENIED');
		this.check(token, run);
		const context = Object.freeze({
			callerAgentId: run.agentId,
			unattended: run.unattended,
			signal: run.controller.signal,
			assertActive: () => this.check(token, run),
		});
		this.contexts.set(context, { token, run });
		return context;
	}

	/** Forget first; abort callbacks cannot resolve or release a replacement entry. */
	private removeInvocation(handle: string, invocation: Invocation): void {
		if (this.invocations.get(handle) !== invocation) return;
		this.invocations.delete(handle);
		invocation.run.invocations.delete(handle);
		if (invocation.timer) clearTimeout(invocation.timer);
		const lifetime = this.pluginLifetimes.get(invocation.source);
		if (lifetime) {
			lifetime.handles.delete(handle);
			if (!lifetime.handles.size) {
				this.pluginLifetimes.delete(invocation.source);
				invocation.source.removeEventListener('abort', lifetime.onAbort);
			}
		}
		invocation.controller.abort();
	}

	private checkInvocation(handle: string, invocation: Invocation): void {
		const checking = invocation.checking;
		try {
			// Keep ordinary run checks sequential; recursive checks of this handle deny.
			if (checking) throw new PluginAuthorityError('PLUGIN_DENIED');
			invocation.checking = true;
			const checkLifetime = () => {
				if (this.stopped || this.invocations.get(handle) !== invocation)
					throw new PluginAuthorityError('PLUGIN_DENIED');
				if (invocation.source.aborted || invocation.controller.signal.aborted)
					throw new PluginAuthorityError('PLUGIN_CANCELED');
				if (performance.now() >= invocation.expiresAt)
					throw new PluginAuthorityError('PLUGIN_TIMEOUT');
			};
			checkLifetime();
			this.check(invocation.runToken, invocation.run);
			checkLifetime();
			assertPluginAuthority(invocation.checkPlugin);
			checkLifetime();
			// Plugin assertions may synchronously revoke/change the run.
			this.check(invocation.runToken, invocation.run);
			checkLifetime();
		} catch (error) {
			this.removeInvocation(handle, invocation);
			throw new PluginAuthorityError(
				error instanceof PluginAuthorityError ? error.code : 'PLUGIN_DENIED'
			);
		} finally {
			invocation.checking = checking;
		}
	}

	/** Host invocation admission only; authority must bind the exact plugin sandbox/identity. */
	issueInvocation(
		context: unknown,
		pluginId: unknown,
		authority: PluginToolRunAuthority,
		ttlMs = PLUGIN_TOOL_RUN_LIMITS.invocationTtlMs
	): string {
		if (this.issuingInvocation) {
			// Initial plugin assertions run before a retained handle can be invalidated.
			this.issuingInvocation.abort();
			throw new PluginAuthorityError('PLUGIN_DENIED');
		}
		const admission = new AbortController();
		this.issuingInvocation = admission;
		let handle: string | undefined;
		let invocation: Invocation | undefined;
		try {
			// Do not inspect untrusted fields or call a supplied context.assertActive.
			const binding = context && typeof context === 'object' ? this.contexts.get(context) : null;
			if (!binding) throw new PluginAuthorityError('PLUGIN_DENIED');
			if (
				typeof pluginId !== 'string' ||
				pluginId.length < 3 ||
				pluginId.length > 100 ||
				!PLUGIN_ID_PATTERN.test(pluginId)
			)
				throw new PluginAuthorityError('PLUGIN_INVALID');
			const source = authority?.signal;
			if (admission.signal.aborted) throw new PluginAuthorityError('PLUGIN_CANCELED');
			const callback = authority?.assertActive;
			if (admission.signal.aborted) throw new PluginAuthorityError('PLUGIN_CANCELED');
			if (!(source instanceof AbortSignal) || typeof callback !== 'function')
				throw new PluginAuthorityError('PLUGIN_DENIED');
			const checkPlugin = callback.bind(authority);
			if (
				!Number.isSafeInteger(ttlMs) ||
				ttlMs < 1 ||
				ttlMs > PLUGIN_TOOL_RUN_LIMITS.invocationTtlMs
			)
				throw new PluginAuthorityError('PLUGIN_INVALID');
			const expiresAt = Math.min(performance.now() + ttlMs, binding.run.expiresAt);
			const checkAdmission = () => {
				if (admission.signal.aborted) throw new PluginAuthorityError('PLUGIN_CANCELED');
				if (this.stopped || source.aborted) throw new PluginAuthorityError('PLUGIN_DENIED');
				this.check(binding.token, binding.run);
				if (admission.signal.aborted) throw new PluginAuthorityError('PLUGIN_CANCELED');
				if (this.stopped || source.aborted) throw new PluginAuthorityError('PLUGIN_DENIED');
				if (performance.now() >= expiresAt) throw new PluginAuthorityError('PLUGIN_TIMEOUT');
			};
			checkAdmission();
			assertPluginAuthority(checkPlugin);
			checkAdmission();
			// Snapshot bounds iteration even when expiry listeners mint more handles.
			for (const [oldHandle, old] of [...this.invocations]) {
				if (performance.now() >= old.expiresAt || old.source.aborted)
					this.removeInvocation(oldHandle, old);
			}
			checkAdmission();
			if (
				this.invocations.size >= PLUGIN_TOOL_RUN_LIMITS.invocations ||
				binding.run.invocations.size >= PLUGIN_TOOL_RUN_LIMITS.invocationsPerRun ||
				[...this.invocations.values()].filter((i) => i.pluginId === pluginId).length >=
					PLUGIN_TOOL_RUN_LIMITS.invocationsPerPlugin
			)
				throw new PluginAuthorityError('PLUGIN_LIMIT');
			handle = randomBytes(32).toString('hex');
			if (this.invocations.has(handle)) throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
			const id = handle;
			invocation = {
				pluginId,
				runToken: binding.token,
				run: binding.run,
				expiresAt,
				controller: new AbortController(),
				source,
				checkPlugin,
				checking: false,
			};
			this.invocations.set(id, invocation);
			binding.run.invocations.add(id);
			// One listener per supplied plugin lifetime, even with many nested handles.
			let lifetime = this.pluginLifetimes.get(source);
			if (!lifetime) {
				const handles = new Set<string>();
				lifetime = {
					handles,
					onAbort: () => {
						for (const nested of [...handles]) this.releaseInvocation(nested);
					},
				};
				this.pluginLifetimes.set(source, lifetime);
				source.addEventListener('abort', lifetime.onAbort, { once: true });
			}
			lifetime.handles.add(id);
			checkAdmission();
			invocation.timer = setTimeout(
				() => this.releaseInvocation(id),
				Math.ceil(expiresAt - performance.now())
			);
			invocation.timer.unref();
			this.checkInvocation(id, invocation);
			if (admission.signal.aborted) throw new PluginAuthorityError('PLUGIN_CANCELED');
			return id;
		} catch (error) {
			if (handle && invocation) this.removeInvocation(handle, invocation);
			throw new PluginAuthorityError(
				error instanceof PluginAuthorityError ? error.code : 'PLUGIN_DENIED'
			);
		} finally {
			// Keep admission fenced through failed-handle removal and abort callbacks.
			this.issuingInvocation = undefined;
		}
	}

	/** pluginId must come from the host's current child-process provenance, never request fields. */
	resolveInvocation(pluginId: string, handle: unknown): PluginToolInvocationContext {
		if (typeof handle !== 'string' || handle.length !== 64 || !/^[0-9a-f]{64}$/.test(handle))
			throw new PluginAuthorityError('PLUGIN_DENIED');
		const invocation = this.invocations.get(handle);
		// A different plugin cannot invalidate the owning plugin's handle by guessing it.
		if (!invocation || invocation.pluginId !== pluginId)
			throw new PluginAuthorityError('PLUGIN_DENIED');
		this.checkInvocation(handle, invocation);
		return Object.freeze({
			pluginId: invocation.pluginId,
			callerAgentId: invocation.run.agentId,
			unattended: invocation.run.unattended,
			signal: invocation.controller.signal,
			assertActive: () => this.checkInvocation(handle, invocation),
		});
	}

	/** Policy edits conservatively invalidate all current leases for this plugin. */
	revokePlugin(pluginId: string): void {
		for (const [handle, invocation] of [...this.invocations]) {
			if (invocation.pluginId === pluginId) this.removeInvocation(handle, invocation);
		}
	}

	/** Called by host tool settlement; this is not a child-callable RPC. */
	releaseInvocation(handle: string): void {
		const invocation = this.invocations.get(handle);
		if (invocation) this.removeInvocation(handle, invocation);
	}

	revoke(token: string): void {
		const run = this.runs.get(token);
		if (run) this.remove(token, run);
	}

	/** Host agent deletion/stop fan-out, including pending proof admission.
	 * Fence the exact agent before any abort
	 * callbacks: they cannot resolve remaining proofs or mint replacement runs.
	 * This is not a permanent agent tombstone; later issuance still needs live
	 * membership and a fresh host run lifetime. Production must supply both. */
	revokeAgent(agentId: unknown): void {
		const agent = requirePluginAgentId(agentId);
		if (this.revokingAgents.has(agent)) return;
		const runs = [...this.runs].filter(([, run]) => run.agentId === agent);
		const admission = this.issuing?.agentId === agent ? this.issuing : undefined;
		if (!runs.length && !admission) return;
		if (this.revokingAgents.size >= PLUGIN_TOOL_RUN_LIMITS.runs)
			throw new PluginAuthorityError('PLUGIN_LIMIT');
		this.revokingAgents.add(agent);
		try {
			// Cancel pending issuance before retained-proof abort listeners can reenter.
			admission?.controller.abort();
			for (const [token, run] of runs) this.remove(token, run);
		} finally {
			this.revokingAgents.delete(agent);
		}
	}

	/** Set the permanent stop before abort callbacks; no reentrant mint can survive. */
	stop(): void {
		this.stopped = true;
		for (const [token, run] of this.runs) this.remove(token, run);
	}
}

export interface PluginToolReceipt {
	runId: string;
	agentId: string;
	toolId: string;
	messageIds: string[];
}
export const pluginToolRunIdentity = new PluginToolRunIdentity();

const proofDirectories = new Set<string>();
/** Main-only broker exclusion, including proofs outside the user-data directory. */
export function getPluginRunProofProtectedPaths(): readonly string[] {
	return [...proofDirectories];
}

export function createPluginRunProofFile(
	token: string,
	ttlMs = PLUGIN_TOOL_RUN_LIMITS.defaultTtlMs
): string {
	if (proofDirectories.size >= PLUGIN_TOOL_RUN_LIMITS.runs)
		throw new PluginAuthorityError('PLUGIN_LIMIT');
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-plugin-run-'));
	proofDirectories.add(dir);
	if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
	const file = path.join(dir, 'proof');
	try {
		fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
	} catch {
		try {
			fs.rmSync(dir, { recursive: true, force: true });
			proofDirectories.delete(dir);
		} catch {
			/* retain protection after failed deletion */
		}
		throw new PluginAuthorityError('PLUGIN_UNAVAILABLE');
	}
	const timer = setTimeout(
		() => {
			try {
				removePluginRunProofFile(file);
			} catch {
				/* no native diagnostics */
			}
		},
		Math.min(ttlMs, PLUGIN_TOOL_RUN_LIMITS.maxTtlMs)
	);
	timer.unref();
	return file;
}
export function removePluginRunProofFile(file: string): void {
	const dir = path.dirname(file);
	if (
		path.basename(file) !== 'proof' ||
		!path.basename(dir).startsWith('maestro-plugin-run-') ||
		!proofDirectories.has(dir)
	)
		return;
	fs.rmSync(dir, { recursive: true, force: true });
	proofDirectories.delete(dir);
}
