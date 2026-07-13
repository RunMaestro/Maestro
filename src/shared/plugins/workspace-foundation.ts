const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/;
const LOCAL_ID_PATTERN = /^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/;
const WORKSPACE_ICONS = ['sparkles', 'bot', 'workflow'] as const;
const REQUIRED_CAPABILITIES = ['ui:workspace', 'ui:interactivePanel'] as const;
const SNAPSHOT_TOKEN_PATTERN = /^[A-Za-z0-9_-]{22,86}$/;
const MAX_WORKSPACE_LINK_BYTES = 512;
export const MAX_WORKSPACE_TITLE_SCALARS = 160;
export const MAX_INTERACTIVE_PANEL_ENTRY_UTF8_BYTES = 1_024;
export const MAX_WORKSPACE_FOUNDATION_PERMISSIONS = 32;
export const MAX_OWNER_PLUGIN_ID_BYTES = 128;
export const MAX_FOUNDATION_LOCAL_ID_BYTES = 64;

type WorkspaceIcon = (typeof WORKSPACE_ICONS)[number];
type ErrorEntry = { readonly path: string; readonly message: string; readonly order: number };

export type WorkspaceLocalId = string & { readonly __workspaceLocalId: never };
export type PanelLocalId = string & { readonly __panelLocalId: never };
export type SnapshotToken = string & { readonly __snapshotToken: never };
export type HostIconKeyword = WorkspaceIcon;
export type LocalContributionId = string & { readonly __localContributionId: never };
export type RelativePanelEntry = string & { readonly __relativePanelEntry: never };

/** Plugin-authored declaration; the host derives its canonical contribution ID. */
export interface WorkspaceContribution {
	readonly localId: LocalContributionId;
	readonly title: string;
	readonly icon: HostIconKeyword;
	readonly interactivePanelLocalId: LocalContributionId;
	readonly order?: number;
}

/** Plugin-authored declaration for the one panel paired with a workspace. */
export interface InteractivePanelContribution {
	readonly localId: LocalContributionId;
	readonly title: string;
	readonly entry: RelativePanelEntry;
	readonly workspaceLocalId: LocalContributionId;
}
export const MAX_EXTERNAL_SESSIONS_PER_WORKSPACE = 500;

export type ExternalSessionStatus =
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

export interface ExternalSessionSnapshot {
	readonly externalSessionId: string;
	readonly title: string;
	readonly status: ExternalSessionStatus;
	readonly unread: number;
	readonly pendingApproval: boolean;
	readonly updatedAt: number;
}

export interface PublishedExternalSession extends ExternalSessionSnapshot {
	readonly snapshotToken: SnapshotToken;
}

export type WorkspaceContextChange =
	| {
			readonly kind: 'external-session-selected';
			readonly ownerPluginId: string;
			readonly workspaceLocalId: WorkspaceLocalId;
			readonly snapshotToken: SnapshotToken;
	  }
	| {
			readonly kind: 'selection-cleared';
			readonly ownerPluginId: string;
			readonly workspaceLocalId: WorkspaceLocalId;
	  };

/** Opaque host-minted authority for exactly one enabled workspace contribution. */
export type WorkspaceCapability = { readonly __hostIssuedWorkspace: never };

export interface WorkspaceStatusSnapshot {
	readonly state: 'ready' | 'connecting' | 'degraded' | 'offline' | 'error';
	readonly label: string;
}

/**
 * Capability-bound workspace surface. Plugin code cannot select an owner,
 * workspace, session, or deep-link token; those are all host-derived.
 */
export interface MaestroWorkspaceApi {
	publishExternalSessions(
		revision: number,
		sessions: readonly ExternalSessionSnapshot[]
	): Promise<void>;
	setStatus(status: WorkspaceStatusSnapshot): Promise<void>;
	setBadge(value: number | null): Promise<void>;
	reveal(snapshotToken: SnapshotToken): Promise<void>;
	onDidChangeContext(listener: () => void): () => void;
}

export interface RawWorkspaceContribution {
	readonly localId: string;
	readonly title: string;
	readonly icon: WorkspaceIcon;
	readonly interactivePanelLocalId: string;
	readonly order?: number;
}

export interface RawInteractivePanelContribution {
	readonly localId: string;
	readonly title: string;
	readonly entry: string;
	readonly workspaceLocalId: string;
}

export interface RawWorkspaceFoundationContributes {
	readonly workspaces: readonly RawWorkspaceContribution[];
	readonly interactivePanels: readonly RawInteractivePanelContribution[];
}

export interface RawWorkspaceFoundationPermission {
	readonly capability: string;
}

export type RawWorkspaceFoundationPermissions = readonly RawWorkspaceFoundationPermission[];

export interface CanonicalWorkspaceFoundation {
	readonly ownerPluginId: string;
	readonly workspace: {
		readonly localId: WorkspaceLocalId;
		readonly canonicalContributionId: string;
		readonly title: string;
		readonly icon: WorkspaceIcon;
		readonly panelLocalId: PanelLocalId;
		readonly order: number;
	};
	readonly panel: {
		readonly localId: PanelLocalId;
		readonly canonicalContributionId: string;
		readonly title: string;
		readonly entry: string;
	};
}

export type WorkspaceFoundationParseResult =
	| { readonly ok: true; readonly value: CanonicalWorkspaceFoundation }
	| { readonly ok: false; readonly errors: readonly string[] };

export interface ParsedWorkspaceLink {
	readonly pluginId: string;
	readonly workspaceLocalId: WorkspaceLocalId;
	readonly snapshotToken: SnapshotToken;
}
export type WorkspaceLinkResolution =
	| { readonly kind: 'syntax_invalid' }
	| { readonly kind: 'unknown_token' }
	| { readonly kind: 'foreign_owner' }
	| { readonly kind: 'expired' }
	| { readonly kind: 'revoked' }
	| { readonly kind: 'disabled_owner' }
	| {
			readonly kind: 'resolved';
			readonly ownerPluginId: string;
			readonly workspaceLocalId: WorkspaceLocalId;
			readonly externalSession: PublishedExternalSession;
	  };

interface ValidWorkspace {
	readonly localId: string;
	readonly title: string;
	readonly icon: WorkspaceIcon;
	readonly panelLocalId: string;
	readonly order: number;
}

interface ValidPanel {
	readonly localId: string;
	readonly title: string;
	readonly entry: string;
	readonly workspaceLocalId: string;
}

/**
 * Validates the isolated workspace/panel contribution shape before any registry
 * state or public plugin contract consumes it. Invalid untrusted values are
 * represented as stable errors rather than exceptions.
 */
export function parseWorkspaceFoundation(
	rawContributes: unknown,
	rawPermissions: unknown,
	ownerPluginId: string
): WorkspaceFoundationParseResult {
	try {
		return parseFoundation(rawContributes, rawPermissions, ownerPluginId);
	} catch {
		return { ok: false, errors: ['contributes must be a plain object'] };
	}
}

function parseFoundation(
	rawContributes: unknown,
	rawPermissions: unknown,
	ownerPluginId: unknown
): WorkspaceFoundationParseResult {
	const errors: ErrorEntry[] = [];
	let errorOrder = 0;
	const addError = (path: string, message: string): void => {
		errors.push({ path, message, order: errorOrder++ });
	};

	const validOwnerPluginId = validateOwnerPluginId(ownerPluginId, addError);
	const contributes = isPlainObject(rawContributes) ? rawContributes : null;
	if (!contributes) {
		addError('contributes', 'contributes must be a plain object');
	}

	let workspaces: readonly unknown[] | null = null;
	let panels: readonly unknown[] | null = null;
	if (contributes) {
		validateClosedKeys(contributes, ['workspaces', 'interactivePanels'], 'contributes', addError);
		const rawWorkspaces = readDataProperty(contributes, 'workspaces');
		const rawPanels = readDataProperty(contributes, 'interactivePanels');
		if (!Array.isArray(rawWorkspaces)) {
			addError('workspaces', 'workspaces must be an array');
		} else {
			workspaces = rawWorkspaces;
		}
		if (!Array.isArray(rawPanels)) {
			addError('interactivePanels', 'interactivePanels must be an array');
		} else {
			panels = rawPanels;
		}
	}

	if (workspaces && workspaces.length !== 1) {
		addError('workspaces', 'workspaces must contain exactly one item');
	}
	if (panels && panels.length !== 1) {
		addError('interactivePanels', 'interactivePanels must contain exactly one item');
	}
	if (workspaces?.length === 2) {
		validatePairDuplicateLocalIds(workspaces, 'workspaces', addError);
	}
	if (panels?.length === 2) {
		validatePairDuplicateLocalIds(panels, 'interactivePanels', addError);
	}

	const validatedWorkspaces =
		workspaces?.length === 1
			? validateWorkspaces(workspaces, addError)
			: { items: [] as readonly (ValidWorkspace | null)[], complete: false };
	const validatedPanels =
		panels?.length === 1
			? validatePanels(panels, addError)
			: { items: [] as readonly (ValidPanel | null)[], complete: false };

	const capabilities = validatePermissions(rawPermissions, addError);
	if (capabilities && !capabilities.has(REQUIRED_CAPABILITIES[0])) {
		addError('workspaces', 'workspaces requires ui:workspace');
	}
	if (capabilities && !capabilities.has(REQUIRED_CAPABILITIES[1])) {
		addError('interactivePanels', 'interactivePanels requires ui:interactivePanel');
	}

	const workspace = validatedWorkspaces.items[0];
	const panel = validatedPanels.items[0];
	if (
		workspaces?.length === 1 &&
		panels?.length === 1 &&
		validatedWorkspaces.complete &&
		validatedPanels.complete &&
		workspace &&
		panel
	) {
		if (workspace.panelLocalId !== panel.localId) {
			addError(
				'workspaces[0].interactivePanelLocalId',
				'workspaces[0].interactivePanelLocalId must reference interactivePanels[0].localId'
			);
		}
		if (panel.workspaceLocalId !== workspace.localId) {
			addError(
				'interactivePanels[0].workspaceLocalId',
				'interactivePanels[0].workspaceLocalId must reference workspaces[0].localId'
			);
		}
		if (workspace.localId === panel.localId) {
			addError(
				'workspaces[0].localId',
				'workspaces[0].localId must differ from interactivePanels[0].localId'
			);
		}
	}

	if (errors.length > 0) {
		return { ok: false, errors: sortErrors(errors) };
	}

	if (!validOwnerPluginId || !workspace || !panel) {
		return { ok: false, errors: ['contributes must be a plain object'] };
	}

	const foundation = Object.freeze({
		ownerPluginId: validOwnerPluginId,
		workspace: Object.freeze({
			localId: workspace.localId as WorkspaceLocalId,
			canonicalContributionId: `${validOwnerPluginId}/${workspace.localId}`,
			title: workspace.title,
			icon: workspace.icon,
			panelLocalId: workspace.panelLocalId as PanelLocalId,
			order: workspace.order,
		}),
		panel: Object.freeze({
			localId: panel.localId as PanelLocalId,
			canonicalContributionId: `${validOwnerPluginId}/${panel.localId}`,
			title: panel.title,
			entry: panel.entry,
		}),
	});
	return Object.freeze({ ok: true as const, value: foundation });
}

function validateOwnerPluginId(
	ownerPluginId: unknown,
	addError: (path: string, message: string) => void
): string | null {
	if (typeof ownerPluginId !== 'string') {
		addError('ownerPluginId', 'ownerPluginId must be a string');
		return null;
	}
	if (ownerPluginId === '') {
		addError('ownerPluginId', 'ownerPluginId must be a non-empty string');
		return null;
	}
	if (utf8ByteLength(ownerPluginId, MAX_OWNER_PLUGIN_ID_BYTES) > MAX_OWNER_PLUGIN_ID_BYTES) {
		addError(
			'ownerPluginId',
			`ownerPluginId must not exceed ${MAX_OWNER_PLUGIN_ID_BYTES} UTF-8 bytes`
		);
		return null;
	}
	if (!PLUGIN_ID_PATTERN.test(ownerPluginId)) {
		addError('ownerPluginId', 'ownerPluginId must be a valid plugin ID');
		return null;
	}
	return ownerPluginId;
}

function validatePairDuplicateLocalIds(
	items: readonly unknown[],
	listName: 'workspaces' | 'interactivePanels',
	addError: (path: string, message: string) => void
): void {
	const first = items[0];
	const second = items[1];
	const firstLocalId = isPlainObject(first) ? readDataProperty(first, 'localId') : undefined;
	const secondLocalId = isPlainObject(second) ? readDataProperty(second, 'localId') : undefined;
	if (typeof firstLocalId === 'string' && firstLocalId === secondLocalId) {
		addError(`${listName}[1].localId`, `${listName}[1].localId duplicates ${listName}[0].localId`);
	}
}

function validateWorkspaces(
	workspaces: readonly unknown[],
	addError: (path: string, message: string) => void
): { readonly items: readonly (ValidWorkspace | null)[]; readonly complete: boolean } {
	const items: (ValidWorkspace | null)[] = [];
	let complete = true;

	for (let index = 0; index < workspaces.length; index += 1) {
		const path = `workspaces[${index}]`;
		const raw = workspaces[index];
		if (!isPlainObject(raw)) {
			addError(path, `${path} must be a plain object`);
			items.push(null);
			complete = false;
			continue;
		}

		validateClosedKeys(
			raw,
			['localId', 'title', 'icon', 'interactivePanelLocalId', 'order'],
			path,
			addError
		);
		const localId = readDataProperty(raw, 'localId');
		const title = readDataProperty(raw, 'title');
		const icon = readDataProperty(raw, 'icon');
		const panelLocalId = readDataProperty(raw, 'interactivePanelLocalId');
		const hasOrder = Object.prototype.hasOwnProperty.call(raw, 'order');
		const rawOrder = readDataProperty(raw, 'order');
		let valid = true;

		if (typeof localId !== 'string') {
			addError(`${path}.localId`, `${path}.localId must be a string`);
			valid = false;
		} else if (
			utf8ByteLength(localId, MAX_FOUNDATION_LOCAL_ID_BYTES) > MAX_FOUNDATION_LOCAL_ID_BYTES
		) {
			addError(
				`${path}.localId`,
				`${path}.localId must not exceed ${MAX_FOUNDATION_LOCAL_ID_BYTES} UTF-8 bytes`
			);
			valid = false;
		} else if (!LOCAL_ID_PATTERN.test(localId)) {
			addError(`${path}.localId`, `${path}.localId must be a valid local ID`);
			valid = false;
		}
		if (typeof title !== 'string') {
			addError(`${path}.title`, `${path}.title must be a string`);
			valid = false;
		} else if (!hasAtMostUnicodeScalars(title, MAX_WORKSPACE_TITLE_SCALARS)) {
			addError(
				`${path}.title`,
				`${path}.title must contain at most ${MAX_WORKSPACE_TITLE_SCALARS} Unicode scalars`
			);
			valid = false;
		}
		if (typeof icon !== 'string') {
			addError(`${path}.icon`, `${path}.icon must be a string`);
			valid = false;
		} else if (!isWorkspaceIcon(icon)) {
			addError(`${path}.icon`, `${path}.icon must be one of ${WORKSPACE_ICONS.join(', ')}`);
			valid = false;
		}
		if (typeof panelLocalId !== 'string') {
			addError(
				`${path}.interactivePanelLocalId`,
				`${path}.interactivePanelLocalId must be a string`
			);
			valid = false;
		} else if (
			utf8ByteLength(panelLocalId, MAX_FOUNDATION_LOCAL_ID_BYTES) > MAX_FOUNDATION_LOCAL_ID_BYTES
		) {
			addError(
				`${path}.interactivePanelLocalId`,
				`${path}.interactivePanelLocalId must not exceed ${MAX_FOUNDATION_LOCAL_ID_BYTES} UTF-8 bytes`
			);
			valid = false;
		} else if (!LOCAL_ID_PATTERN.test(panelLocalId)) {
			addError(
				`${path}.interactivePanelLocalId`,
				`${path}.interactivePanelLocalId must be a valid local ID`
			);
			valid = false;
		}
		let order = 0;
		if (hasOrder) {
			if (typeof rawOrder !== 'number' || !Number.isFinite(rawOrder)) {
				addError(`${path}.order`, `${path}.order must be a finite number`);
				valid = false;
			} else {
				order = rawOrder;
			}
		}

		items.push(
			valid
				? {
						localId: localId as string,
						title: title as string,
						icon: icon as WorkspaceIcon,
						panelLocalId: panelLocalId as string,
						order,
					}
				: null
		);
		complete &&= valid;
	}
	return { items, complete };
}

function validatePanels(
	panels: readonly unknown[],
	addError: (path: string, message: string) => void
): { readonly items: readonly (ValidPanel | null)[]; readonly complete: boolean } {
	const items: (ValidPanel | null)[] = [];
	let complete = true;

	for (let index = 0; index < panels.length; index += 1) {
		const path = `interactivePanels[${index}]`;
		const raw = panels[index];
		if (!isPlainObject(raw)) {
			addError(path, `${path} must be a plain object`);
			items.push(null);
			complete = false;
			continue;
		}

		validateClosedKeys(raw, ['localId', 'title', 'entry', 'workspaceLocalId'], path, addError);
		const localId = readDataProperty(raw, 'localId');
		const title = readDataProperty(raw, 'title');
		const entry = readDataProperty(raw, 'entry');
		const workspaceLocalId = readDataProperty(raw, 'workspaceLocalId');
		let valid = true;

		if (typeof localId !== 'string') {
			addError(`${path}.localId`, `${path}.localId must be a string`);
			valid = false;
		} else if (
			utf8ByteLength(localId, MAX_FOUNDATION_LOCAL_ID_BYTES) > MAX_FOUNDATION_LOCAL_ID_BYTES
		) {
			addError(
				`${path}.localId`,
				`${path}.localId must not exceed ${MAX_FOUNDATION_LOCAL_ID_BYTES} UTF-8 bytes`
			);
			valid = false;
		} else if (!LOCAL_ID_PATTERN.test(localId)) {
			addError(`${path}.localId`, `${path}.localId must be a valid local ID`);
			valid = false;
		}
		if (typeof title !== 'string') {
			addError(`${path}.title`, `${path}.title must be a string`);
			valid = false;
		} else if (!hasAtMostUnicodeScalars(title, MAX_WORKSPACE_TITLE_SCALARS)) {
			addError(
				`${path}.title`,
				`${path}.title must contain at most ${MAX_WORKSPACE_TITLE_SCALARS} Unicode scalars`
			);
			valid = false;
		}
		if (typeof entry !== 'string') {
			addError(`${path}.entry`, `${path}.entry must be a string`);
			valid = false;
		} else if (
			utf8ByteLength(entry, MAX_INTERACTIVE_PANEL_ENTRY_UTF8_BYTES) >
			MAX_INTERACTIVE_PANEL_ENTRY_UTF8_BYTES
		) {
			addError(
				`${path}.entry`,
				`${path}.entry must not exceed ${MAX_INTERACTIVE_PANEL_ENTRY_UTF8_BYTES} UTF-8 bytes`
			);
			valid = false;
		} else if (!isSafeRelativeEntry(entry)) {
			addError(`${path}.entry`, `${path}.entry must be a safe relative path`);
			valid = false;
		}
		if (typeof workspaceLocalId !== 'string') {
			addError(`${path}.workspaceLocalId`, `${path}.workspaceLocalId must be a string`);
			valid = false;
		} else if (
			utf8ByteLength(workspaceLocalId, MAX_FOUNDATION_LOCAL_ID_BYTES) >
			MAX_FOUNDATION_LOCAL_ID_BYTES
		) {
			addError(
				`${path}.workspaceLocalId`,
				`${path}.workspaceLocalId must not exceed ${MAX_FOUNDATION_LOCAL_ID_BYTES} UTF-8 bytes`
			);
			valid = false;
		} else if (!LOCAL_ID_PATTERN.test(workspaceLocalId)) {
			addError(`${path}.workspaceLocalId`, `${path}.workspaceLocalId must be a valid local ID`);
			valid = false;
		}

		items.push(
			valid
				? {
						localId: localId as string,
						title: title as string,
						entry: entry as string,
						workspaceLocalId: workspaceLocalId as string,
					}
				: null
		);
		complete &&= valid;
	}
	return { items, complete };
}

function validatePermissions(
	rawPermissions: unknown,
	addError: (path: string, message: string) => void
): Set<string> | null {
	if (!Array.isArray(rawPermissions)) {
		addError('permissions', 'permissions must be an array');
		return null;
	}
	if (rawPermissions.length > MAX_WORKSPACE_FOUNDATION_PERMISSIONS) {
		addError(
			'permissions',
			`permissions must contain at most ${MAX_WORKSPACE_FOUNDATION_PERMISSIONS} items`
		);
		return null;
	}

	const capabilities = new Set<string>();
	let complete = true;
	for (let index = 0; index < rawPermissions.length; index += 1) {
		const path = `permissions[${index}]`;
		const raw = rawPermissions[index];
		if (!isPlainObject(raw)) {
			addError(path, `${path} must be a plain object`);
			complete = false;
			continue;
		}
		const capability = readDataProperty(raw, 'capability');
		if (typeof capability !== 'string') {
			validateClosedKeys(raw, ['capability'], path, addError);
			addError(`${path}.capability`, `${path}.capability must be a string`);
			complete = false;
			continue;
		}
		if (capability === 'process:interactive') {
			validateClosedKeys(raw, ['capability', 'scope'], path, addError);
			if (readDataProperty(raw, 'scope') !== 'omp') {
				addError(`${path}.scope`, `${path}.scope must equal "omp" for process:interactive`);
				complete = false;
				continue;
			}
		} else {
			validateClosedKeys(raw, ['capability'], path, addError);
		}
		capabilities.add(capability);
	}
	return complete ? capabilities : null;
}

function validateClosedKeys(
	raw: Record<string, unknown>,
	allowed: readonly string[],
	path: string,
	addError: (path: string, message: string) => void
): void {
	for (const key of Object.keys(raw)) {
		if (!allowed.includes(key)) {
			addError(`${path}.${key}`, `${path}.${key} is not allowed`);
		}
	}
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype
	);
}

function readDataProperty(raw: Record<string, unknown>, key: string): unknown {
	return Object.getOwnPropertyDescriptor(raw, key)?.value;
}

function isWorkspaceIcon(value: string): value is WorkspaceIcon {
	return (WORKSPACE_ICONS as readonly string[]).includes(value);
}

function isSafeRelativeEntry(entry: string): boolean {
	if (
		entry === '' ||
		entry.startsWith('~') ||
		entry.startsWith('/') ||
		entry.startsWith('\\') ||
		/^[A-Za-z]:/.test(entry)
	) {
		return false;
	}
	let segmentStart = 0;
	for (let index = 0; index <= entry.length; index += 1) {
		const isSeparator =
			index === entry.length || entry.charCodeAt(index) === 47 || entry.charCodeAt(index) === 92;
		if (!isSeparator) continue;
		const segmentLength = index - segmentStart;
		if (
			segmentLength === 0 ||
			(segmentLength === 1 && entry.charCodeAt(segmentStart) === 46) ||
			(segmentLength === 2 &&
				entry.charCodeAt(segmentStart) === 46 &&
				entry.charCodeAt(segmentStart + 1) === 46)
		) {
			return false;
		}
		segmentStart = index + 1;
	}
	return true;
}

function sortErrors(errors: ErrorEntry[]): readonly string[] {
	return errors
		.sort((left, right) => {
			if (left.path < right.path) return -1;
			if (left.path > right.path) return 1;
			return left.order - right.order;
		})
		.map(({ message }) => message);
}

/**
 * Parses only the wire syntax of a workspace snapshot link. Resolution and
 * authorization remain registry responsibilities.
 */
export function parseWorkspaceLink(url: string): ParsedWorkspaceLink | null {
	if (
		typeof url !== 'string' ||
		utf8ByteLength(url, MAX_WORKSPACE_LINK_BYTES) > MAX_WORKSPACE_LINK_BYTES ||
		!url.startsWith('maestro://workspace/') ||
		url.includes('%') ||
		url.includes('?') ||
		url.includes('#') ||
		/[\\\u0000-\u001F\u007F]/.test(url)
	) {
		return null;
	}

	const rawPathSegments = url.slice('maestro://workspace/'.length).split('/');
	if (rawPathSegments.includes('.') || rawPathSegments.includes('..')) {
		return null;
	}

	try {
		const parsed = new URL(url);
		if (
			parsed.protocol !== 'maestro:' ||
			parsed.hostname !== 'workspace' ||
			parsed.host !== 'workspace' ||
			parsed.username !== '' ||
			parsed.password !== '' ||
			parsed.port !== '' ||
			parsed.search !== '' ||
			parsed.hash !== '' ||
			parsed.pathname.includes('//')
		) {
			return null;
		}

		const segments = parsed.pathname.slice(1).split('/');
		if (
			segments.length !== 4 ||
			segments.some((segment) => segment === '') ||
			segments[2] !== 'session'
		) {
			return null;
		}

		const [pluginId, workspaceLocalId, , snapshotToken] = segments;
		if (
			!PLUGIN_ID_PATTERN.test(pluginId) ||
			!LOCAL_ID_PATTERN.test(workspaceLocalId) ||
			!SNAPSHOT_TOKEN_PATTERN.test(snapshotToken)
		) {
			return null;
		}
		return {
			pluginId,
			workspaceLocalId: workspaceLocalId as WorkspaceLocalId,
			snapshotToken: snapshotToken as SnapshotToken,
		};
	} catch {
		return null;
	}
}

function utf8ByteLength(value: string, limit = Number.POSITIVE_INFINITY): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit <= 0x7f) {
			bytes += 1;
		} else if (codeUnit <= 0x7ff) {
			bytes += 2;
		} else if (
			codeUnit >= 0xd800 &&
			codeUnit <= 0xdbff &&
			index + 1 < value.length &&
			value.charCodeAt(index + 1) >= 0xdc00 &&
			value.charCodeAt(index + 1) <= 0xdfff
		) {
			bytes += 4;
			index += 1;
		} else {
			bytes += 3;
		}
		if (bytes > limit) return bytes;
	}
	return bytes;
}

function hasAtMostUnicodeScalars(value: string, maximum: number): boolean {
	let scalars = 0;
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			if (
				index + 1 >= value.length ||
				value.charCodeAt(index + 1) < 0xdc00 ||
				value.charCodeAt(index + 1) > 0xdfff
			) {
				return false;
			}
			index += 1;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
		scalars += 1;
		if (scalars > maximum) return false;
	}
	return true;
}
