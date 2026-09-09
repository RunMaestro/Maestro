/**
 * UI-independent catalog and validation for group appearance (icon + label
 * color).
 *
 * Lives in `shared/` because three consumers must agree on exactly one set of
 * ids: the renderer's picker (`components/ui/groupAppearanceOptions.ts`, which
 * adds the icon-id -> Lucide mapping on top of this), the WebSocket message
 * handlers that accept `create_group` / `update_group` from any client, and the
 * CLI's `create-group` / `update-group` commands. A second copy of the id list
 * would let the CLI accept an icon the picker cannot draw.
 *
 * Values are normalized rather than merely checked, so `#ef4444` and `#EF4444`
 * persist identically and a later readback comparison is a plain string equal.
 */

/** One built-in group icon. The renderer maps `id` to a Lucide component. */
export interface GroupIconCatalogEntry {
	id: string;
	label: string;
}

/** One built-in label color. `value` is the persisted `#RRGGBB` string. */
export interface GroupColorCatalogEntry {
	value: string;
	label: string;
}

export const GROUP_ICON_CATALOG: readonly GroupIconCatalogEntry[] = [
	{ id: 'folder', label: 'Folder' },
	{ id: 'briefcase', label: 'Briefcase' },
	{ id: 'rocket', label: 'Rocket' },
	{ id: 'code', label: 'Code' },
	{ id: 'star', label: 'Star' },
	{ id: 'heart', label: 'Heart' },
	{ id: 'lightbulb', label: 'Lightbulb' },
	{ id: 'target', label: 'Target' },
	{ id: 'calendar', label: 'Calendar' },
	{ id: 'book', label: 'Book' },
	{ id: 'layers', label: 'Layers' },
	{ id: 'shield', label: 'Shield' },
	{ id: 'wrench', label: 'Wrench' },
	{ id: 'palette', label: 'Palette' },
	{ id: 'archive', label: 'Archive' },
	{ id: 'zap', label: 'Zap' },
] as const;

export const GROUP_LABEL_COLORS: readonly GroupColorCatalogEntry[] = [
	{ value: '#EF4444', label: 'Red' },
	{ value: '#F97316', label: 'Orange' },
	{ value: '#EAB308', label: 'Yellow' },
	{ value: '#22C55E', label: 'Green' },
	{ value: '#14B8A6', label: 'Teal' },
	{ value: '#3B82F6', label: 'Blue' },
	{ value: '#EC4899', label: 'Pink' },
	{ value: '#A855F7', label: 'Purple' },
] as const;

/** Built-in icon ids, in picker order. */
export const GROUP_ICON_IDS: readonly string[] = GROUP_ICON_CATALOG.map((entry) => entry.id);

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * A plugin-contributed icon or color id: two or more `LOCAL_ID_PATTERN`
 * segments joined by `/` (`<pluginId>/<packId>/<localId>`). Kept in sync with
 * `LOCAL_ID_PATTERN` in `shared/plugins/contributions.ts` - a namespaced id the
 * CLI accepts but the contribution loader would reject can never resolve.
 */
const NAMESPACED_ID_PATTERN =
	/^[a-z][a-z0-9]*([._-][a-z0-9]+)*(\/[a-z][a-z0-9]*([._-][a-z0-9]+)*)+$/;

/**
 * Canonical form of an icon id, or `null` when it is neither a built-in nor a
 * plugin-namespaced id. Built-ins and namespaced ids are both lowercased so a
 * `--icon Rocket` and a `--icon rocket` persist the same value.
 */
export function normalizeGroupIconId(raw: string): string | null {
	const candidate = raw.trim().toLowerCase();
	if (!candidate) return null;
	if (GROUP_ICON_IDS.includes(candidate)) return candidate;
	if (NAMESPACED_ID_PATTERN.test(candidate)) return candidate;
	return null;
}

/**
 * Canonical form of a label color, or `null` when unrecognized. `#RRGGBB` is
 * uppercased (the built-in catalog is stored uppercase, so a user passing the
 * lowercase hex of a built-in color lands on the exact catalog entry rather
 * than a near-duplicate that the picker cannot highlight).
 */
export function normalizeGroupColor(raw: string): string | null {
	const candidate = raw.trim();
	if (!candidate) return null;
	if (HEX_COLOR_PATTERN.test(candidate)) return candidate.toUpperCase();
	const lowered = candidate.toLowerCase();
	if (NAMESPACED_ID_PATTERN.test(lowered)) return lowered;
	return null;
}

/** Appearance fields accepted on a create or update, before validation. */
export interface GroupAppearanceInput {
	emoji?: string;
	icon?: string;
	color?: string;
}

/** Appearance fields after normalization, ready to persist. */
export interface GroupAppearance {
	emoji?: string;
	icon?: string;
	color?: string;
}

export type GroupAppearanceValidation =
	| { ok: true; value: GroupAppearance }
	| { ok: false; error: string };

/** Human-readable list of built-in icon ids, for error messages. */
export function describeGroupIconIds(): string {
	return GROUP_ICON_IDS.join(', ');
}

/**
 * Validate and normalize an appearance request. Returns the normalized fields
 * (only the ones actually supplied) or a single error string.
 *
 * Callers must apply this BEFORE mutating any state: a request carrying a good
 * name and a bad color has to fail whole, not persist the name and drop the
 * color.
 */
export function validateGroupAppearance(input: GroupAppearanceInput): GroupAppearanceValidation {
	const emoji = input.emoji?.trim();
	const iconRaw = input.icon?.trim();
	const colorRaw = input.color?.trim();

	if (emoji && iconRaw) {
		return {
			ok: false,
			error: 'Use either --emoji or --icon, not both (a group shows one or the other)',
		};
	}

	const value: GroupAppearance = {};
	if (emoji) value.emoji = emoji;

	if (iconRaw) {
		const icon = normalizeGroupIconId(iconRaw);
		if (!icon) {
			return {
				ok: false,
				error: `Unknown icon "${iconRaw}". Built-in icons: ${describeGroupIconIds()}. Plugin icons use a namespaced id like my-plugin/my-pack/my-icon.`,
			};
		}
		value.icon = icon;
	}

	if (colorRaw) {
		const color = normalizeGroupColor(colorRaw);
		if (!color) {
			return {
				ok: false,
				error: `Invalid color "${colorRaw}". Use a #RRGGBB hex value (for example ${GROUP_LABEL_COLORS[0].value}) or a plugin color id like my-plugin/my-pack/my-color.`,
			};
		}
		value.color = color;
	}

	return { ok: true, value };
}

/** Appearance/hierarchy fields an `update_group` request may clear. */
export const GROUP_CLEARABLE_FIELDS = ['emoji', 'icon', 'color', 'parent'] as const;
export type GroupClearableField = (typeof GROUP_CLEARABLE_FIELDS)[number];

/**
 * The wire shape of an `update_group` request. Clearing is explicit via
 * `clear` rather than a `null` value, because JSON round-trips lose the
 * difference between "field absent" and "field set to undefined", and a group
 * update has to be able to say "leave the color alone" and "remove the color"
 * in the same message shape.
 */
export interface GroupUpdateRequest {
	name?: string;
	emoji?: string;
	icon?: string;
	color?: string;
	parentGroupId?: string;
	clear?: GroupClearableField[];
}

export function isGroupClearableField(value: unknown): value is GroupClearableField {
	return typeof value === 'string' && (GROUP_CLEARABLE_FIELDS as readonly string[]).includes(value);
}

export type GroupUpdateValidation =
	| { ok: true; value: GroupUpdateRequest }
	| { ok: false; error: string };

/**
 * Validate and normalize a whole update request: appearance rules above, plus
 * the clear list and the "an update must actually change something" rule. A
 * field cannot be both set and cleared in one call - that is a scripting bug,
 * and silently picking a winner would make the result depend on our internal
 * ordering.
 */
export function validateGroupUpdate(request: GroupUpdateRequest): GroupUpdateValidation {
	const clear = request.clear ?? [];
	for (const field of clear) {
		if (!isGroupClearableField(field)) {
			return { ok: false, error: `Unknown clear target "${String(field)}"` };
		}
	}

	const conflicts: Array<[GroupClearableField, string | undefined]> = [
		['emoji', request.emoji],
		['icon', request.icon],
		['color', request.color],
		['parent', request.parentGroupId],
	];
	for (const [field, supplied] of conflicts) {
		if (clear.includes(field) && supplied !== undefined) {
			return { ok: false, error: `Cannot both set and clear ${field}` };
		}
	}

	// An icon replaces an emoji and vice versa, so clearing one while setting
	// the other is coherent - only reject setting both at once.
	const appearance = validateGroupAppearance({
		emoji: request.emoji,
		icon: request.icon,
		color: request.color,
	});
	if (!appearance.ok) return appearance;

	const value: GroupUpdateRequest = {};
	const name = request.name?.trim();
	if (name) value.name = name;
	if (appearance.value.emoji) value.emoji = appearance.value.emoji;
	if (appearance.value.icon) value.icon = appearance.value.icon;
	if (appearance.value.color) value.color = appearance.value.color;
	const parentGroupId = request.parentGroupId?.trim();
	if (parentGroupId) value.parentGroupId = parentGroupId;
	if (clear.length > 0) value.clear = [...clear];

	if (request.name !== undefined && !name) {
		return { ok: false, error: 'Group name must not be empty' };
	}
	if (request.parentGroupId !== undefined && !parentGroupId) {
		return { ok: false, error: 'Parent group ID must not be empty' };
	}
	if (Object.keys(value).length === 0) {
		return { ok: false, error: 'Nothing to update' };
	}

	return { ok: true, value };
}
