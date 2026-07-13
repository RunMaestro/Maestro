const workspaceLocalIdBrand: unique symbol = Symbol('workspaceLocalId');
const panelLocalIdBrand: unique symbol = Symbol('panelLocalId');

const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/;
const LOCAL_ID_PATTERN = /^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/;
const WORKSPACE_ICONS = ['sparkles', 'bot', 'workflow'] as const;
const REQUIRED_CAPABILITIES = ['ui:workspace', 'ui:interactivePanel'] as const;

type WorkspaceIcon = (typeof WORKSPACE_ICONS)[number];
type ErrorEntry = { readonly path: string; readonly message: string; readonly order: number };

export type WorkspaceLocalId = string & { readonly [workspaceLocalIdBrand]: never };
export type PanelLocalId = string & { readonly [panelLocalIdBrand]: never };

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

	const validatedWorkspaces = workspaces
		? validateWorkspaces(workspaces, addError)
		: { items: [] as readonly (ValidWorkspace | null)[], complete: false };
	const validatedPanels = panels
		? validatePanels(panels, addError)
		: { items: [] as readonly (ValidPanel | null)[], complete: false };

	if (workspaces && workspaces.length !== 1) {
		addError('workspaces', 'workspaces must contain exactly one item');
	}
	if (panels && panels.length !== 1) {
		addError('interactivePanels', 'interactivePanels must contain exactly one item');
	}

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
	if (!PLUGIN_ID_PATTERN.test(ownerPluginId)) {
		addError('ownerPluginId', 'ownerPluginId must be a valid plugin ID');
		return null;
	}
	return ownerPluginId;
}

function validateWorkspaces(
	workspaces: readonly unknown[],
	addError: (path: string, message: string) => void
): { readonly items: readonly (ValidWorkspace | null)[]; readonly complete: boolean } {
	const items: (ValidWorkspace | null)[] = [];
	const firstIndexes = new Map<string, number>();
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
		} else if (!LOCAL_ID_PATTERN.test(localId)) {
			addError(`${path}.localId`, `${path}.localId must be a valid local ID`);
			valid = false;
		} else {
			const firstIndex = firstIndexes.get(localId);
			if (firstIndex === undefined) {
				firstIndexes.set(localId, index);
			} else {
				addError(`${path}.localId`, `${path}.localId duplicates workspaces[${firstIndex}].localId`);
			}
		}
		if (typeof title !== 'string') {
			addError(`${path}.title`, `${path}.title must be a string`);
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
						icon,
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
	const firstIndexes = new Map<string, number>();
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
		} else if (!LOCAL_ID_PATTERN.test(localId)) {
			addError(`${path}.localId`, `${path}.localId must be a valid local ID`);
			valid = false;
		} else {
			const firstIndex = firstIndexes.get(localId);
			if (firstIndex === undefined) {
				firstIndexes.set(localId, index);
			} else {
				addError(
					`${path}.localId`,
					`${path}.localId duplicates interactivePanels[${firstIndex}].localId`
				);
			}
		}
		if (typeof title !== 'string') {
			addError(`${path}.title`, `${path}.title must be a string`);
			valid = false;
		}
		if (typeof entry !== 'string') {
			addError(`${path}.entry`, `${path}.entry must be a string`);
			valid = false;
		} else if (!isSafeRelativeEntry(entry)) {
			addError(`${path}.entry`, `${path}.entry must be a safe relative path`);
			valid = false;
		}
		if (typeof workspaceLocalId !== 'string') {
			addError(`${path}.workspaceLocalId`, `${path}.workspaceLocalId must be a string`);
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
		validateClosedKeys(raw, ['capability'], path, addError);
		const capability = readDataProperty(raw, 'capability');
		if (typeof capability !== 'string') {
			addError(`${path}.capability`, `${path}.capability must be a string`);
			complete = false;
			continue;
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
	const segments = entry.split(/[\\/]+/);
	return !segments.includes('..') && !segments.includes('.') && !segments.includes('');
}

function sortErrors(errors: readonly ErrorEntry[]): readonly string[] {
	return [...errors]
		.sort((left, right) => {
			if (left.path < right.path) return -1;
			if (left.path > right.path) return 1;
			return left.order - right.order;
		})
		.map(({ message }) => message);
}
