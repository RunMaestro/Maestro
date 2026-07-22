// Shared, UI-independent catalog of group appearance options (built-in icon IDs
// and label colors) plus the normalization/validation used by both the CLI and
// the renderer. The renderer keeps its own icon-ID -> Lucide component mapping
// in `renderer/components/ui/groupAppearanceOptions.ts`; this module owns only
// the stringly-typed data so non-UI code (CLI, main process) can validate group
// appearance without importing React or lucide-react.

/** Default folder emoji applied to a group when no emoji is specified. */
export const DEFAULT_GROUP_EMOJI = '\u{1F4C2}';

/** Built-in group icon IDs. Kept in sync with the renderer Lucide mapping. */
export const GROUP_ICON_IDS = [
	'folder',
	'briefcase',
	'rocket',
	'code',
	'star',
	'heart',
	'lightbulb',
	'target',
	'calendar',
	'book',
	'layers',
	'shield',
	'wrench',
	'palette',
	'archive',
	'zap',
] as const;

export type BuiltInGroupIconId = (typeof GROUP_ICON_IDS)[number];

/** Built-in label colors. `value` is a normalized (uppercase) #RRGGBB hex. */
export const GROUP_LABEL_COLORS = [
	{ value: '#EF4444', label: 'Red' },
	{ value: '#F97316', label: 'Orange' },
	{ value: '#EAB308', label: 'Yellow' },
	{ value: '#22C55E', label: 'Green' },
	{ value: '#14B8A6', label: 'Teal' },
	{ value: '#3B82F6', label: 'Blue' },
	{ value: '#EC4899', label: 'Pink' },
	{ value: '#A855F7', label: 'Purple' },
] as const;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/** Whether an ID matches one of the built-in group icons. */
export function isBuiltInGroupIconId(id: string): boolean {
	return (GROUP_ICON_IDS as readonly string[]).includes(id);
}

/**
 * Whether an ID is plugin-namespaced. Plugin contribution IDs are namespaced
 * with a `/` (e.g. `com.acme/bright/bolt`); the renderer resolves them against
 * the active icon packs, so non-UI callers accept them without knowing the
 * catalog.
 */
export function isPluginNamespacedId(id: string): boolean {
	return id.includes('/');
}

/**
 * Normalize a group icon ID. Returns the canonical ID, or `null` if invalid.
 * Accepts built-in IDs and plugin-namespaced IDs.
 */
export function normalizeGroupIconId(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	if (isBuiltInGroupIconId(trimmed)) return trimmed;
	if (isPluginNamespacedId(trimmed)) return trimmed;
	return null;
}

/**
 * Normalize a group color. `#RRGGBB` hex is uppercased; plugin-namespaced color
 * IDs pass through unchanged. Returns `null` if invalid.
 */
export function normalizeGroupColor(input: string): string | null {
	const trimmed = input.trim();
	if (!trimmed) return null;
	if (HEX_COLOR.test(trimmed)) return trimmed.toUpperCase();
	if (isPluginNamespacedId(trimmed)) return trimmed;
	return null;
}

export interface GroupAppearanceInput {
	emoji?: string;
	icon?: string;
	color?: string;
}

export interface NormalizedGroupAppearance {
	emoji?: string;
	icon?: string;
	color?: string;
}

export type GroupAppearanceValidation =
	| { ok: true; value: NormalizedGroupAppearance }
	| { ok: false; error: string };

/**
 * Validate and normalize appearance flags shared by `create-group` and
 * `update-group`. Enforces emoji/icon mutual exclusivity and validates icon and
 * color so callers can reject invalid input before mutating any state (the "no
 * partial mutation" guarantee).
 */
export function validateGroupAppearanceInput(
	input: GroupAppearanceInput
): GroupAppearanceValidation {
	const { emoji, icon, color } = input;

	if (emoji !== undefined && icon !== undefined) {
		return { ok: false, error: '--emoji and --icon are mutually exclusive' };
	}

	const value: NormalizedGroupAppearance = {};

	if (emoji !== undefined) {
		const trimmed = emoji.trim();
		if (!trimmed) return { ok: false, error: 'Emoji must not be empty' };
		value.emoji = trimmed;
	}

	if (icon !== undefined) {
		const normalized = normalizeGroupIconId(icon);
		if (!normalized) {
			return {
				ok: false,
				error: `Invalid icon "${icon}". Use a built-in icon ID (${GROUP_ICON_IDS.join(
					', '
				)}) or a plugin-namespaced ID.`,
			};
		}
		value.icon = normalized;
	}

	if (color !== undefined) {
		const normalized = normalizeGroupColor(color);
		if (!normalized) {
			return {
				ok: false,
				error: `Invalid color "${color}". Use a #RRGGBB hex value or a plugin-namespaced color ID.`,
			};
		}
		value.color = normalized;
	}

	return { ok: true, value };
}
