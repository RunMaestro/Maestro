/**
 * RTL Icon Flip List
 *
 * Lucide icon names that should be horizontally mirrored when the UI
 * direction is RTL.  Only icons whose visual meaning is tied to a
 * left-to-right flow belong here (arrows, chevrons, external-link
 * indicators, etc.).  Symmetrical icons (e.g. Settings, Search) must
 * NOT be added.
 *
 * The list is consumed by the <DirIcon> wrapper component, which
 * conditionally applies the CSS class `rtl-flip` (defined in
 * index.css) to mirror the icon via `transform: scaleX(-1)`.
 */

/**
 * Set of Lucide icon component names that should flip horizontally
 * in RTL layouts.  Use the PascalCase display name that appears on
 * the Lucide React component (e.g. `ArrowRight`, not `arrow-right`).
 */
export const RTL_FLIP_ICONS: ReadonlySet<string> = new Set([
	// Arrows — directional flow
	'ArrowLeft',
	'ArrowRight',
	'ArrowUpRight',
	'ArrowUpLeft',
	'ArrowDownRight',
	'ArrowDownLeft',
	'ArrowLeftRight',
	'MoveLeft',
	'MoveRight',
	'MoveHorizontal',
	'Undo',
	'Undo2',
	'Redo',
	'Redo2',
	'CornerDownLeft',
	'CornerDownRight',
	'CornerUpLeft',
	'CornerUpRight',
	'CornerLeftDown',
	'CornerLeftUp',
	'CornerRightDown',
	'CornerRightUp',

	// Chevrons — navigation indicators
	'ChevronLeft',
	'ChevronRight',
	'ChevronsLeft',
	'ChevronsRight',
	'ChevronFirst',
	'ChevronLast',

	// External link / open indicators
	'ExternalLink',
	'SquareArrowOutUpRight',

	// Playback / media controls
	'SkipBack',
	'SkipForward',
	'StepBack',
	'StepForward',
	'Rewind',
	'FastForward',

	// Text & editing direction
	'TextCursorInput',
	'WrapText',
	'Indent',
	'Outdent',
	'AlignLeft',
	'AlignRight',
	'PilcrowLeft',
	'PilcrowRight',

	// Misc directional
	'LogIn',
	'LogOut',
	'Reply',
	'ReplyAll',
	'Forward',
	'Share',
	'Share2',
	'Shuffle',
	'Repeat',
	'Repeat1',
	'IterationCw',
	'IterationCcw',
]);

/**
 * Returns true when the given Lucide icon name should be flipped
 * horizontally in RTL layouts.
 */
export function shouldFlipIcon(iconName: string): boolean {
	return RTL_FLIP_ICONS.has(iconName);
}
