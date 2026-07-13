import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { WorkspaceRootCapability } from '../../shared/plugins/interactive-runtime';
import type { RuntimeActivationContext } from './native-workspace-root-service';
import { NativeWorkspaceRootService } from './native-workspace-root-service';

const MAX_TOOL_INPUT_BYTES = 256 * 1024;
const MAX_TOOL_OUTPUT_BYTES = 256 * 1024;
const MAX_TOOL_FILE_BYTES = 1024 * 1024;
const TOOL_RATE_WINDOW_MS = 60_000;
const TOOL_RATE_MAX = 30;
const AUTH_TRANSACTION_TTL_MS = 15 * 60_000;
const BASH_TIMEOUT_MS = 30_000;
const BASH_OUTPUT_BYTES = 1024 * 1024;

export const OMP_WORKSPACE_TOOLS = [
	'maestro.workspace.read',
	'maestro.workspace.write',
	'maestro.workspace.edit',
] as const;

export type OmpWorkspaceToolName = (typeof OMP_WORKSPACE_TOOLS)[number];
export type OmpPanelPhase = 'pending' | 'completed' | 'cancelled' | 'failed';

export interface OmpPathStat {
	readonly dev: number;
	readonly ino: number;
	readonly size: number;
	isDirectory(): boolean;
	isFile(): boolean;
	isSymbolicLink(): boolean;
}

/** An opened descriptor; all content I/O happens only through this authority. */
export interface OmpToolFileHandle {
	stat(): Promise<OmpPathStat>;
	readFile(): Promise<Buffer>;
	write(
		buffer: Buffer,
		offset: number,
		length: number,
		position: number
	): Promise<{ readonly bytesWritten: number }>;
	truncate(length?: number): Promise<void>;
	sync(): Promise<void>;
	close(): Promise<void>;
}

/** Every method receives host-internal absolute paths only; no plugin receives one. */
export interface OmpToolFilesystem {
	readonly lstat: (value: string) => Promise<OmpPathStat>;
	readonly realpath: (value: string) => Promise<string>;
	readonly openExistingNoFollow: (value: string, writable: boolean) => Promise<OmpToolFileHandle>;
}

interface PathAuthorityEntry {
	readonly path: string;
	readonly canonical: string;
	readonly stat: OmpPathStat;
}

interface PathAuthority {
	readonly entries: readonly PathAuthorityEntry[];
}

function samePathIdentity(left: OmpPathStat | undefined, right: OmpPathStat): boolean {
	return (
		left !== undefined &&
		left.dev === right.dev &&
		left.ino === right.ino &&
		left.size === right.size &&
		left.isDirectory() === right.isDirectory() &&
		left.isFile() === right.isFile() &&
		left.isSymbolicLink() === right.isSymbolicLink()
	);
}

function samePathAuthority(left: PathAuthority, right: PathAuthority): boolean {
	return (
		left.entries.length === right.entries.length &&
		left.entries.every(
			(entry, index) =>
				samePath(entry.path, right.entries[index]?.path ?? '') &&
				samePath(entry.canonical, right.entries[index]?.canonical ?? '') &&
				samePathIdentity(entry.stat, right.entries[index]?.stat ?? entry.stat)
		)
	);
}

async function writeAll(file: OmpToolFileHandle, content: Buffer): Promise<void> {
	for (let offset = 0; offset < content.byteLength; ) {
		const { bytesWritten } = await file.write(content, offset, content.byteLength - offset, offset);
		if (bytesWritten <= 0) throw new Error('workspace file handle write failed');
		offset += bytesWritten;
	}
}

export interface OmpToolApprovalRequest {
	readonly tool: OmpWorkspaceToolName;
	readonly path: string;
}

export interface OmpRootToolPolicyBrokerDeps {
	readonly roots: NativeWorkspaceRootService;
	/** The capability is host-kept; callers cannot submit a replacement root. */
	readonly workspaceRoot: () => WorkspaceRootCapability | null;
	readonly activation: () => RuntimeActivationContext | null;
	readonly approve: (request: OmpToolApprovalRequest) => Promise<boolean>;
	readonly filesystem?: OmpToolFilesystem;
	readonly clock?: () => number;
}

export type OmpWorkspaceToolResult = { readonly text: string } | { readonly phase: 'completed' };

/**
 * A root-constrained, closed tool broker. Its public request format contains a
 * relative path only. Root resolution, no-follow checks, and approval happen in
 * the main process for every call, including calls already admitted earlier.
 */
export class OmpRootToolPolicyBroker {
	private readonly filesystem: OmpToolFilesystem;
	private readonly clock: () => number;
	private readonly calls: number[] = [];
	private inFlight = false;
	private revoked = false;
	private activeSignal: AbortSignal | undefined;

	constructor(private readonly deps: OmpRootToolPolicyBrokerDeps) {
		this.filesystem = deps.filesystem ?? defaultToolFilesystem;
		this.clock = deps.clock ?? Date.now;
	}

	async invoke(
		tool: unknown,
		params: unknown,
		signal?: AbortSignal
	): Promise<OmpWorkspaceToolResult> {
		if (!isWorkspaceTool(tool)) throw unavailable();
		if (this.revoked || this.inFlight || signal?.aborted) throw unavailable();
		const request = parseWorkspaceToolRequest(tool, params);
		this.assertRateLimit();
		this.inFlight = true;
		this.activeSignal = signal;
		try {
			if (!(await this.deps.approve({ tool, path: request.path }))) throw unavailable();
			this.assertCurrent();
			const root = this.resolveRoot();
			const absolute = this.resolveRelativePath(root, request.path);
			const result = await this.run(tool, root, absolute, request);
			this.assertCurrent();
			return result;
		} finally {
			this.inFlight = false;
			this.activeSignal = undefined;
		}
	}

	/** Rejects pending work at its next host boundary and forgets all rate state. */
	revoke(): void {
		this.revoked = true;
		this.calls.length = 0;
	}

	private async run(
		tool: OmpWorkspaceToolName,
		root: string,
		absolute: string,
		request: ParsedWorkspaceToolRequest
	): Promise<OmpWorkspaceToolResult> {
		if (tool === 'maestro.workspace.read') {
			const content = await this.withVerifiedExisting(root, request.path, absolute, false, (file) =>
				file.readFile()
			);
			if (content.byteLength > MAX_TOOL_FILE_BYTES || content.byteLength > MAX_TOOL_OUTPUT_BYTES) {
				throw new Error('workspace tool output exceeds limit');
			}
			this.assertCurrent();
			return { text: content.toString('utf8') };
		}

		if (tool === 'maestro.workspace.write') {
			const text = request.text;
			if (text === undefined) throw unavailable();
			const content = Buffer.from(text, 'utf8');
			if (content.byteLength > MAX_TOOL_INPUT_BYTES)
				throw new Error('workspace tool input exceeds limit');
			await this.replaceVerifiedExisting(root, request.path, absolute, async () => content);
			return { phase: 'completed' };
		}

		const expectedText = request.expectedText;
		const replacement = request.replacement;
		if (expectedText === undefined || replacement === undefined) throw unavailable();
		await this.replaceVerifiedExisting(root, request.path, absolute, async (file) => {
			const current = await file.readFile();
			if (current.byteLength > MAX_TOOL_FILE_BYTES)
				throw new Error('workspace tool input exceeds limit');
			const source = current.toString('utf8');
			const index = source.indexOf(expectedText);
			if (index < 0 || source.indexOf(expectedText, index + expectedText.length) >= 0) {
				throw unavailable();
			}
			return Buffer.from(
				`${source.slice(0, index)}${replacement}${source.slice(index + expectedText.length)}`,
				'utf8'
			);
		});
		return { phase: 'completed' };
	}

	private async replaceVerifiedExisting(
		root: string,
		relative: string,
		absolute: string,
		createContent: (file: OmpToolFileHandle) => Promise<Buffer>
	): Promise<void> {
		await this.withVerifiedExisting(root, relative, absolute, true, async (file) => {
			const content = await createContent(file);
			if (content.byteLength > MAX_TOOL_INPUT_BYTES)
				throw new Error('workspace tool input exceeds limit');
			this.assertCurrent();
			await file.truncate(0);
			await writeAll(file, content);
			await file.sync();
			this.assertCurrent();
		});
	}

	/**
	 * Node has no cross-platform openat-style ancestor descriptor API. Existing
	 * entries are therefore opened non-destructively, then the handle and every
	 * path component are compared before a single content operation is allowed.
	 * Missing targets deliberately fail closed instead of claiming safe creation.
	 */
	private async withVerifiedExisting<T>(
		root: string,
		relative: string,
		absolute: string,
		writable: boolean,
		operation: (file: OmpToolFileHandle) => Promise<T>
	): Promise<T> {
		const before = await this.capturePathAuthority(root, relative);
		this.assertCurrent();
		let file: OmpToolFileHandle;
		try {
			file = await this.filesystem.openExistingNoFollow(absolute, writable);
		} catch {
			throw unavailable();
		}
		try {
			const opened = await file.stat();
			if (opened.isDirectory() || !opened.isFile() || opened.isSymbolicLink()) throw unavailable();
			const after = await this.capturePathAuthority(root, relative);
			if (
				!samePathAuthority(before, after) ||
				!samePathIdentity(before.entries.at(-1)?.stat, opened) ||
				!samePathIdentity(after.entries.at(-1)?.stat, opened)
			) {
				throw unavailable();
			}
			this.assertCurrent();
			return await operation(file);
		} finally {
			await file.close().catch(() => undefined);
		}
	}

	private async capturePathAuthority(root: string, relative: string): Promise<PathAuthority> {
		try {
			const rootStat = await this.filesystem.lstat(root);
			if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw unavailable();
			const canonicalRoot = await this.filesystem.realpath(root);
			if (!samePath(canonicalRoot, root)) throw unavailable();
			const entries: PathAuthorityEntry[] = [
				{ path: root, canonical: canonicalRoot, stat: rootStat },
			];
			let current = root;
			for (const [index, segment] of relative.split(/[\\/]/u).entries()) {
				if (!segment) throw unavailable();
				current = path.join(current, segment);
				const stat = await this.filesystem.lstat(current);
				if (
					stat.isSymbolicLink() ||
					(index < relative.split(/[\\/]/u).length - 1 && !stat.isDirectory()) ||
					(index === relative.split(/[\\/]/u).length - 1 && !stat.isFile())
				) {
					throw unavailable();
				}
				const canonical = await this.filesystem.realpath(current);
				if (!samePath(canonical, current)) throw unavailable();
				entries.push({ path: current, canonical, stat });
			}
			return { entries };
		} catch {
			throw unavailable();
		}
	}

	private resolveRoot(): string {
		const activation = this.requireActivation();
		const capability = this.deps.workspaceRoot();
		if (!capability) throw unavailable();
		return this.deps.roots.resolveCurrent(
			capability,
			activation.ownerPluginId,
			activation.generation
		);
	}

	private resolveRelativePath(root: string, relative: string): string {
		const resolved = path.resolve(root, relative);
		const relativeToRoot = path.relative(root, resolved);
		if (
			relativeToRoot.length === 0 ||
			path.isAbsolute(relativeToRoot) ||
			relativeToRoot === '..' ||
			relativeToRoot.startsWith(`..${path.sep}`)
		) {
			throw unavailable();
		}
		return resolved;
	}

	private assertRateLimit(): void {
		const now = this.clock();
		while (this.calls.length > 0 && this.calls[0] <= now - TOOL_RATE_WINDOW_MS) this.calls.shift();
		if (this.calls.length >= TOOL_RATE_MAX) throw new Error('workspace tool rate limit exceeded');
		this.calls.push(now);
	}

	private assertCurrent(): void {
		if (this.revoked || this.activeSignal?.aborted) throw unavailable();
		this.requireActivation();
	}

	private requireActivation(): RuntimeActivationContext {
		const activation = this.deps.activation();
		if (!activation || activation.ownerPluginId !== 'com.maestro.omp') throw unavailable();
		return activation;
	}
}

export interface OmpProviderMetadata {
	readonly id: string;
	readonly authorizationEndpoint: string;
}

export interface OmpAuthCallbackPkceRouterDeps {
	readonly providers: readonly OmpProviderMetadata[];
	readonly allowedOrigins: ReadonlySet<string>;
	readonly openAuthorization: (url: string) => Promise<void>;
	/** Token exchange and credential storage are host-owned; no result crosses this seam. */
	readonly exchangeCode: (providerId: string, code: string, verifier: string) => Promise<void>;
	readonly random?: () => string;
	readonly clock?: () => number;
}

export interface OmpAuthPanelProjection {
	readonly transactionId: string;
	readonly phase: OmpPanelPhase;
}

interface AuthTransaction {
	readonly providerId: string;
	readonly state: string;
	readonly verifier: string;
	readonly expiresAt: number;
	readonly onPhase?: (phase: OmpPanelPhase) => void;
}

/** Host-only PKCE transaction router. Sandbox adapters project phase only; URLs and secrets stay host-private. */
export class OmpAuthCallbackPkceRouter {
	private readonly providers = new Map<string, OmpProviderMetadata>();
	private readonly transactions = new Map<string, AuthTransaction>();
	private readonly random: () => string;
	private readonly clock: () => number;
	private revoked = false;

	constructor(private readonly deps: OmpAuthCallbackPkceRouterDeps) {
		for (const provider of deps.providers) {
			validateProvider(provider, deps.allowedOrigins);
			if (this.providers.has(provider.id)) throw new Error('duplicate OMP auth provider');
			this.providers.set(provider.id, provider);
		}
		this.random = deps.random ?? randomOpaque;
		this.clock = deps.clock ?? Date.now;
	}

	async begin(
		providerId: unknown,
		onPhase?: (phase: OmpPanelPhase) => void
	): Promise<OmpAuthPanelProjection> {
		if (this.revoked || typeof providerId !== 'string') throw unavailable();
		const provider = this.providers.get(providerId);
		if (!provider) throw unavailable();
		const transactionId = this.nextOpaque();
		const state = this.nextOpaque();
		const verifier = this.nextOpaque();
		const endpoint = new URL(provider.authorizationEndpoint);
		endpoint.searchParams.set('response_type', 'code');
		endpoint.searchParams.set('state', state);
		endpoint.searchParams.set('code_challenge_method', 'S256');
		endpoint.searchParams.set('code_challenge', sha256Base64Url(verifier));
		this.transactions.set(transactionId, {
			providerId: provider.id,
			state,
			verifier,
			expiresAt: this.clock() + AUTH_TRANSACTION_TTL_MS,
			onPhase,
		});
		try {
			await this.deps.openAuthorization(endpoint.toString());
		} catch {
			this.transactions.delete(transactionId);
			throw unavailable();
		}
		if (this.revoked) {
			this.transactions.delete(transactionId);
			throw unavailable();
		}
		onPhase?.('pending');
		return { transactionId, phase: 'pending' };
	}

	async handleCallback(callback: unknown): Promise<OmpAuthPanelProjection> {
		if (this.revoked || typeof callback !== 'string') throw unavailable();
		const parsed = parseCallback(callback);
		const transaction = this.transactions.get(parsed.transactionId);
		if (!transaction) throw unavailable();
		if (transaction.expiresAt < this.clock()) {
			this.transactions.delete(parsed.transactionId);
			throw unavailable();
		}
		if (!timingSafeEqual(transaction.state, parsed.state)) throw unavailable();
		this.transactions.delete(parsed.transactionId);
		try {
			await this.deps.exchangeCode(transaction.providerId, parsed.code, transaction.verifier);
			if (this.revoked) throw unavailable();
			transaction.onPhase?.('completed');
			return { transactionId: parsed.transactionId, phase: 'completed' };
		} catch {
			if (this.revoked) throw unavailable();
			transaction.onPhase?.('failed');
			return { transactionId: parsed.transactionId, phase: 'failed' };
		}
	}

	providerIds(): readonly string[] {
		return Object.freeze([...this.providers.keys()]);
	}
	cancel(transactionId: unknown): void {
		if (typeof transactionId !== 'string') throw unavailable();
		const transaction = this.transactions.get(transactionId);
		if (!transaction) throw unavailable();
		this.transactions.delete(transactionId);
		transaction.onPhase?.('cancelled');
	}

	revoke(): void {
		this.revoked = true;
		this.transactions.clear();
	}

	private nextOpaque(): string {
		const value = this.random();
		if (!/^[A-Za-z0-9_-]{32,256}$/u.test(value)) throw new Error('opaque auth generator failed');
		return value;
	}
}

/** The protocol deliberately exposes no URI authority. */
export class OmpUriBroker {
	catalog(): readonly [] {
		return Object.freeze([]) as readonly [];
	}

	async resolve(_uri: unknown): Promise<never> {
		throw unavailable();
	}
}

export interface OmpExportFilesystem {
	readonly lstat: (value: string) => Promise<OmpPathStat>;
	readonly realpath: (value: string) => Promise<string>;
	/** Opens a new exclusive temporary file without writing any content. */
	readonly openTemporaryNoFollow: (value: string) => Promise<OmpToolFileHandle>;
	readonly link: (from: string, to: string) => Promise<void>;
	readonly unlink: (value: string) => Promise<void>;
}

export interface OmpNativeExportBrokerDeps {
	/** Native adapter receives no plugin-controlled path or filename. */
	readonly chooseDirectory: () => Promise<string | null>;
	readonly filesystem?: OmpExportFilesystem;
	readonly random?: () => string;
}

export type OmpHtmlExportHandle = object;

/** Holds generated HTML in a host WeakMap and exports it through a native directory picker only. */
export class OmpNativeExportBroker {
	private readonly records = new WeakMap<object, string>();
	private readonly filesystem: OmpExportFilesystem;
	private readonly random: () => string;
	private revoked = false;

	constructor(private readonly deps: OmpNativeExportBrokerDeps) {
		this.filesystem = deps.filesystem ?? defaultExportFilesystem;
		this.random = deps.random ?? randomOpaque;
	}

	registerHtml(html: unknown): OmpHtmlExportHandle {
		if (
			this.revoked ||
			typeof html !== 'string' ||
			Buffer.byteLength(html, 'utf8') > MAX_TOOL_FILE_BYTES
		) {
			throw unavailable();
		}
		const handle = Object.freeze(Object.create(null));
		this.records.set(handle, html);
		return handle;
	}

	async export(
		handle: unknown,
		suggestedName: unknown
	): Promise<{ readonly phase: OmpPanelPhase }> {
		if (this.revoked || typeof handle !== 'object' || handle === null) throw unavailable();
		const html = this.records.get(handle);
		if (html === undefined) throw unavailable();
		const directory = await this.deps.chooseDirectory();
		if (this.revoked) throw unavailable();
		if (directory === null) return { phase: 'cancelled' };
		try {
			await this.assertSafeDirectory(directory);
			const target = path.join(directory, `${safeExportBaseName(suggestedName)}.html`);
			const temporary = path.join(directory, `.${this.nextTemporaryName()}.tmp`);
			let file: OmpToolFileHandle | undefined;
			try {
				file = await this.filesystem.openTemporaryNoFollow(temporary);
				const opened = await file.stat();
				const current = await this.filesystem.lstat(temporary);
				if (
					opened.isDirectory() ||
					!opened.isFile() ||
					opened.isSymbolicLink() ||
					!samePathIdentity(current, opened) ||
					!samePath(await this.filesystem.realpath(temporary), temporary)
				) {
					throw unavailable();
				}
				await this.assertSafeDirectory(directory);
				await writeAll(file, Buffer.from(html, 'utf8'));
				await file.sync();
			} finally {
				await file?.close().catch(() => undefined);
			}
			await this.assertSafeDirectory(directory);
			try {
				await this.filesystem.link(temporary, target);
			} finally {
				await this.filesystem.unlink(temporary).catch(() => undefined);
			}
			if (this.revoked) throw unavailable();
			return { phase: 'completed' };
		} catch {
			if (this.revoked) throw unavailable();
			return { phase: 'failed' };
		}
	}

	revoke(): void {
		this.revoked = true;
	}

	private async assertSafeDirectory(directory: string): Promise<void> {
		if (!path.isAbsolute(directory)) throw unavailable();
		const stat = await this.filesystem.lstat(directory);
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw unavailable();
		const canonical = await this.filesystem.realpath(directory);
		if (!samePath(canonical, directory)) throw unavailable();
	}

	private nextTemporaryName(): string {
		const value = this.random();
		if (!/^[A-Za-z0-9_-]{1,256}$/u.test(value)) throw unavailable();
		return value;
	}
}

/** A stable, closed tool definition that exposes neither root capability nor host path. */
export interface OmpSandboxToolDefinition {
	readonly name: OmpWorkspaceToolName;
}

export interface OmpSandboxToolCall {
	readonly id: string;
	readonly name: unknown;
	readonly payload: unknown;
	readonly signal?: AbortSignal;
}

export interface OmpSandboxToolHandlers {
	catalog(): readonly OmpSandboxToolDefinition[];
	call(request: OmpSandboxToolCall): Promise<unknown>;
	cancel(id: unknown): void;
}

export interface OmpSandboxUriHandlers {
	catalog(): readonly [];
	call(request: unknown): Promise<never>;
	cancel(id: unknown): Promise<never>;
}
export interface OmpSandboxAuthBeginOptions {
	readonly signal?: AbortSignal;
	readonly onProgress: (phase: OmpPanelPhase) => void;
}

export interface OmpSandboxExportSaveRequest {
	readonly exportId: unknown;
	readonly html: unknown;
}

export interface OmpSandboxAuthHandlers {
	listProviders(): readonly { readonly id: string }[];
	begin(providerId: unknown, options: OmpSandboxAuthBeginOptions): Promise<void>;
}

/** This adapter is host-internal. `html` is never delivered to a plugin panel. */
export interface OmpSandboxExportHandlers {
	save(request: OmpSandboxExportSaveRequest): Promise<'saved' | 'cancelled'>;
}

/** Exact fixed handler seam consumed by OMP runtime adapters and injected by bootstrap. */
export interface OmpSandboxHostHandlerSeam {
	readonly tools: OmpSandboxToolHandlers;
	readonly uris: OmpSandboxUriHandlers;
	readonly auth: OmpSandboxAuthHandlers;
	readonly exports: OmpSandboxExportHandlers;
	revoke(): void;
}

/** Backwards-compatible name for the fixed handler seam. */
export type OmpSandboxHostHandlers = OmpSandboxHostHandlerSeam;

/** Bootstrap-only constructor input: each authority remains host-owned and opaque. */
export interface OmpSandboxHostHandlerDeps extends OmpRootToolPolicyBrokerDeps {
	readonly auth: OmpAuthCallbackPkceRouterDeps;
	readonly export: OmpNativeExportBrokerDeps;
}

export function createOmpSandboxHostHandlers(
	deps: OmpSandboxHostHandlerDeps
): OmpSandboxHostHandlerSeam {
	const toolBroker = new OmpRootToolPolicyBroker(deps);
	const uriBroker = new OmpUriBroker();
	const authRouter = new OmpAuthCallbackPkceRouter(deps.auth);
	const exportBroker = new OmpNativeExportBroker(deps.export);
	const activeTools = new Map<string, AbortController>();
	const toolDefinitions = Object.freeze(
		OMP_WORKSPACE_TOOLS.map((name) => Object.freeze({ name }))
	) as readonly OmpSandboxToolDefinition[];
	const providerList = Object.freeze(
		authRouter.providerIds().map((id) => Object.freeze({ id }))
	) as readonly { readonly id: string }[];

	return Object.freeze({
		tools: Object.freeze({
			catalog: () => toolDefinitions,
			call: async ({ id, name, payload, signal }: OmpSandboxToolCall): Promise<unknown> => {
				assertCallId(id);
				if (activeTools.has(id) || signal?.aborted) throw unavailable();
				const controller = new AbortController();
				const abort = () => controller.abort();
				signal?.addEventListener('abort', abort, { once: true });
				activeTools.set(id, controller);
				try {
					return await toolBroker.invoke(name, payload, controller.signal);
				} finally {
					activeTools.delete(id);
					signal?.removeEventListener('abort', abort);
				}
			},
			cancel: (id: unknown): void => {
				if (typeof id !== 'string') throw unavailable();
				const controller = activeTools.get(id);
				if (!controller) throw unavailable();
				controller.abort();
			},
		}),
		uris: Object.freeze({
			catalog: () => uriBroker.catalog(),
			call: (_request: unknown): Promise<never> => uriBroker.resolve(_request),
			cancel: async (_id: unknown): Promise<never> => {
				throw unavailable();
			},
		}),
		auth: Object.freeze({
			listProviders: () => providerList,
			begin: async (providerId: unknown, options: OmpSandboxAuthBeginOptions): Promise<void> => {
				if (options.signal?.aborted) throw unavailable();
				const started = await authRouter.begin(providerId, options.onProgress);
				if (options.signal?.aborted) {
					authRouter.cancel(started.transactionId);
					throw unavailable();
				}
				const abort = () => authRouter.cancel(started.transactionId);
				options.signal?.addEventListener('abort', abort, { once: true });
			},
		}),
		exports: Object.freeze({
			save: async ({
				exportId,
				html,
			}: OmpSandboxExportSaveRequest): Promise<'saved' | 'cancelled'> => {
				if (!isSafeExportId(exportId)) throw unavailable();
				const handle = exportBroker.registerHtml(html);
				const result = await exportBroker.export(handle, exportId);
				if (result.phase === 'completed') return 'saved';
				if (result.phase === 'cancelled') return 'cancelled';
				throw unavailable();
			},
		}),
		revoke: () => {
			for (const controller of activeTools.values()) controller.abort();
			activeTools.clear();
			toolBroker.revoke();
			authRouter.revoke();
			exportBroker.revoke();
		},
	});
}

interface ParsedWorkspaceToolRequest {
	readonly path: string;
	readonly text?: string;
	readonly expectedText?: string;
	readonly replacement?: string;
}

function parseWorkspaceToolRequest(
	tool: OmpWorkspaceToolName,
	params: unknown
): ParsedWorkspaceToolRequest {
	if (!isPlainObject(params)) throw unavailable();
	const allowed =
		tool === 'maestro.workspace.read'
			? ['path']
			: tool === 'maestro.workspace.write'
				? ['path', 'text']
				: ['path', 'expectedText', 'replacement'];
	if (Object.keys(params).some((key) => !allowed.includes(key))) throw unavailable();
	const relative = params.path;
	if (!isSafeRelativePath(relative)) throw unavailable();
	if (tool === 'maestro.workspace.read') return { path: relative };
	if (tool === 'maestro.workspace.write') {
		if (!isBoundedText(params.text)) throw unavailable();
		return { path: relative, text: params.text };
	}
	if (!isBoundedText(params.expectedText) || !isBoundedText(params.replacement))
		throw unavailable();
	return { path: relative, expectedText: params.expectedText, replacement: params.replacement };
}

function isWorkspaceTool(value: unknown): value is OmpWorkspaceToolName {
	return typeof value === 'string' && (OMP_WORKSPACE_TOOLS as readonly string[]).includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
	);
}

function isBoundedText(value: unknown): value is string {
	return typeof value === 'string' && Buffer.byteLength(value, 'utf8') <= MAX_TOOL_INPUT_BYTES;
}

function isSafeRelativePath(value: unknown): value is string {
	if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 4096)
		return false;
	if (value.includes('\0') || value.includes(':') || path.isAbsolute(value)) return false;
	return value
		.split(/[\\/]/u)
		.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function validateProvider(
	provider: OmpProviderMetadata,
	allowedOrigins: ReadonlySet<string>
): void {
	if (!/^[a-z0-9][a-z0-9_-]{0,63}$/u.test(provider.id))
		throw new Error('invalid OMP auth provider');
	let endpoint: URL;
	try {
		endpoint = new URL(provider.authorizationEndpoint);
	} catch {
		throw new Error('invalid OMP auth provider endpoint');
	}
	if (
		endpoint.protocol !== 'https:' ||
		endpoint.username ||
		endpoint.password ||
		!allowedOrigins.has(endpoint.origin)
	) {
		throw new Error('untrusted OMP auth provider endpoint');
	}
}

function parseCallback(value: string): { transactionId: string; state: string; code: string } {
	let callback: URL;
	try {
		callback = new URL(value);
	} catch {
		throw unavailable();
	}
	if (
		callback.protocol !== 'maestro:' ||
		callback.host !== 'omp-auth' ||
		callback.username ||
		callback.password
	) {
		throw unavailable();
	}
	const match = /^\/callback\/([A-Za-z0-9_-]{32,256})$/u.exec(callback.pathname);
	if (
		!match ||
		callback.hash ||
		[...callback.searchParams.keys()].some((key) => key !== 'state' && key !== 'code')
	) {
		throw unavailable();
	}
	const state = callback.searchParams.get('state');
	const code = callback.searchParams.get('code');
	if (
		callback.searchParams.getAll('state').length !== 1 ||
		callback.searchParams.getAll('code').length !== 1 ||
		!state ||
		!code ||
		state.length > 256 ||
		code.length > 4096
	) {
		throw unavailable();
	}
	return { transactionId: match[1], state, code };
}

function assertCallId(value: unknown): asserts value is string {
	if (
		typeof value !== 'string' ||
		!/^[A-Za-z0-9_-]{1,128}$/u.test(value) ||
		Buffer.byteLength(value, 'utf8') > 128
	) {
		throw unavailable();
	}
}

function isSafeExportId(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		value.length > 0 &&
		value.length <= 256 &&
		Buffer.byteLength(value, 'utf8') <= 256
	);
}

function safeExportBaseName(value: unknown): string {
	const source = typeof value === 'string' ? value : 'maestro-export';
	const normalized = source
		.normalize('NFKC')
		.replace(/[^A-Za-z0-9_-]+/gu, '-')
		.replace(/^-+|-+$/gu, '')
		.slice(0, 80);
	return normalized || 'maestro-export';
}

function randomOpaque(): string {
	return crypto.randomBytes(32).toString('base64url');
}

function sha256Base64Url(value: string): string {
	return crypto.createHash('sha256').update(value).digest('base64url');
}

function timingSafeEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return (
		leftBytes.byteLength === rightBytes.byteLength && crypto.timingSafeEqual(leftBytes, rightBytes)
	);
}

function samePath(left: string, right: string): boolean {
	return process.platform === 'win32'
		? left.toLocaleLowerCase() === right.toLocaleLowerCase()
		: left === right;
}

function unavailable(): Error {
	return new Error('OMP host capability is unavailable');
}

const defaultToolFilesystem: OmpToolFilesystem = {
	lstat: fs.lstat,
	realpath: fs.realpath,
	openExistingNoFollow: (value, writable) =>
		fs.open(
			value,
			(writable ? fs.constants.O_RDWR : fs.constants.O_RDONLY) | fs.constants.O_NOFOLLOW
		),
};

const defaultExportFilesystem: OmpExportFilesystem = {
	lstat: fs.lstat,
	realpath: fs.realpath,
	openTemporaryNoFollow: (value) =>
		fs.open(
			value,
			fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW,
			0o600
		),
	link: fs.link,
	unlink: fs.unlink,
};

/** Reserved limits for a separately approved future root-policy bash broker; this broker has no bash handler. */
export const OMP_SEPARATE_BASH_POLICY_LIMITS = Object.freeze({
	timeoutMs: BASH_TIMEOUT_MS,
	maxOutputBytes: BASH_OUTPUT_BYTES,
});
