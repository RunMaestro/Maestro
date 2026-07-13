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
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

/** Every method receives host-internal absolute paths only; no plugin receives one. */
export interface OmpToolFilesystem {
	readonly lstat: (value: string) => Promise<OmpPathStat>;
	readonly realpath: (value: string) => Promise<string>;
	readonly readFileNoFollow: (value: string) => Promise<Buffer>;
	readonly writeFileNoFollow: (value: string, content: Buffer) => Promise<void>;
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
			await this.assertNoFollowPath(root, request.path, false);
			const content = await this.filesystem.readFileNoFollow(absolute);
			if (content.byteLength > MAX_TOOL_FILE_BYTES || content.byteLength > MAX_TOOL_OUTPUT_BYTES) {
				throw new Error('workspace tool output exceeds limit');
			}
			await this.assertNoFollowPath(root, request.path, false);
			this.assertCurrent();
			return { text: content.toString('utf8') };
		}

		const text = tool === 'maestro.workspace.write' ? request.text : undefined;
		const content = Buffer.from(
			text ??
				(await this.editContent(
					root,
					absolute,
					request.path,
					request.expectedText,
					request.replacement
				)),
			'utf8'
		);
		if (content.byteLength > MAX_TOOL_INPUT_BYTES)
			throw new Error('workspace tool input exceeds limit');
		await this.assertNoFollowPath(root, request.path, true);
		this.assertCurrent();
		await this.filesystem.writeFileNoFollow(absolute, content);
		await this.assertNoFollowPath(root, request.path, false);
		this.assertCurrent();
		return { phase: 'completed' };
	}

	private async editContent(
		root: string,
		absolute: string,
		relative: string,
		expectedText: string | undefined,
		replacement: string | undefined
	): Promise<string> {
		if (expectedText === undefined || replacement === undefined) throw unavailable();
		await this.assertNoFollowPath(root, relative, false);
		const current = await this.filesystem.readFileNoFollow(absolute);
		if (current.byteLength > MAX_TOOL_FILE_BYTES)
			throw new Error('workspace tool input exceeds limit');
		const source = current.toString('utf8');
		const index = source.indexOf(expectedText);
		if (index < 0 || source.indexOf(expectedText, index + expectedText.length) >= 0) {
			throw unavailable();
		}
		return `${source.slice(0, index)}${replacement}${source.slice(index + expectedText.length)}`;
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

	private async assertNoFollowPath(
		root: string,
		relative: string,
		allowMissingFinal: boolean
	): Promise<void> {
		const rootStat = await this.filesystem.lstat(root);
		if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw unavailable();
		const canonicalRoot = await this.filesystem.realpath(root);
		if (!samePath(canonicalRoot, root)) throw unavailable();
		const segments = relative.split(/[\\/]/u);
		let current = root;
		for (let index = 0; index < segments.length; index += 1) {
			const segment = segments[index];
			if (!segment) throw unavailable();
			current = path.join(current, segment);
			try {
				const entry = await this.filesystem.lstat(current);
				if (entry.isSymbolicLink() || (index < segments.length - 1 && !entry.isDirectory())) {
					throw unavailable();
				}
			} catch (error) {
				if (isMissing(error) && allowMissingFinal && index === segments.length - 1) return;
				throw error;
			}
		}
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
	readonly writeFile: (value: string, content: Buffer) => Promise<void>;
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
			await this.filesystem.writeFile(temporary, Buffer.from(html, 'utf8'));
			try {
				await this.filesystem.link(temporary, target);
			} finally {
				await this.filesystem.unlink(temporary).catch(() => undefined);
			}
			if (this.revoked) throw unavailable();
			return { phase: 'completed' };
		} catch (error) {
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

export function createOmpSandboxHostHandlers(
	deps: OmpRootToolPolicyBrokerDeps & {
		readonly auth: OmpAuthCallbackPkceRouterDeps;
		readonly export: OmpNativeExportBrokerDeps;
	}
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

function isMissing(value: unknown): boolean {
	return value instanceof Error && 'code' in value && value.code === 'ENOENT';
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
	readFileNoFollow: async (value) => {
		const file = await fs.open(value, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
		try {
			return await file.readFile();
		} finally {
			await file.close();
		}
	},
	writeFileNoFollow: async (value, content) => {
		const file = await fs.open(
			value,
			fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW,
			0o600
		);
		try {
			await file.writeFile(content);
		} finally {
			await file.close();
		}
	},
};

const defaultExportFilesystem: OmpExportFilesystem = {
	lstat: fs.lstat,
	realpath: fs.realpath,
	writeFile: (value, content) => fs.writeFile(value, content, { mode: 0o600, flag: 'wx' }),
	link: fs.link,
	unlink: fs.unlink,
};

/** Reserved limits for a separately approved future root-policy bash broker; this broker has no bash handler. */
export const OMP_SEPARATE_BASH_POLICY_LIMITS = Object.freeze({
	timeoutMs: BASH_TIMEOUT_MS,
	maxOutputBytes: BASH_OUTPUT_BYTES,
});
