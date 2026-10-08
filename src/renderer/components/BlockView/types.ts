/**
 * BlockView schema - the composable, agent-authored "block tree" that the
 * BlockView engine renders into theme-styled UI. This is the vocabulary an agent
 * uses to architect a data view: it chooses *what* to show and *how it's
 * arranged* (layout), but never *how it looks* (the app owns all styling via the
 * theme + a fixed set of semantic options). No agent-authored CSS, ever.
 *
 * The tree has two families:
 * - **layout** blocks (`row`, `column`, `grid`, `group`) nest `children` and
 *   arrange them in 2D with a mandated spacing scale.
 * - **content** blocks (`stat`, `bars`, `text`, `table`, ...) are leaves that
 *   render one widget/primitive.
 *
 * Specs arrive as agent-authored JSON over the CLI/bridge, so every field is
 * optional at the type level and validated leniently at render time - a
 * malformed block is skipped, never crashes the view.
 */

/** Semantic color names an agent may pick. Mapped to theme colors at render. */
export type BlockColor = 'accent' | 'success' | 'warning' | 'error' | 'neutral' | 'orange';

/** Mandated spacing scale (px). Agents pick a name, not a pixel value. */
export type BlockGap = 'none' | 'sm' | 'md' | 'lg';

/** Cross-axis alignment for row/column layout. */
export type BlockAlign = 'start' | 'center' | 'end' | 'stretch';

/** A key/value row for the `keyValue` block. */
export interface KeyValueItem {
	label: string;
	value: string;
	color?: BlockColor;
}

/**
 * One node in a block tree. Discriminated by `kind`. Layout kinds carry
 * `children`; content kinds carry their own data. Kept loose (all data fields
 * optional) because it's agent-authored JSON validated at render time.
 */
export type Block =
	// ---- layout containers -------------------------------------------------
	| { kind: 'row'; gap?: BlockGap; align?: BlockAlign; wrap?: boolean; children?: Block[] }
	| { kind: 'column'; gap?: BlockGap; align?: BlockAlign; children?: Block[] }
	| {
			kind: 'grid';
			columns?: number;
			minColumnWidth?: number;
			gap?: BlockGap;
			children?: Block[];
	  }
	| { kind: 'group'; title?: string; color?: BlockColor; children?: Block[] }
	// ---- content leaves ----------------------------------------------------
	| { kind: 'heading'; text?: string; level?: 1 | 2 | 3 }
	| { kind: 'text'; content?: string }
	| { kind: 'code'; code?: string; language?: string; filename?: string }
	| { kind: 'divider' }
	| { kind: 'badge'; text?: string; color?: BlockColor }
	| { kind: 'callout'; text?: string; title?: string; color?: BlockColor }
	| { kind: 'progress'; value?: number; max?: number; label?: string; color?: BlockColor }
	| { kind: 'keyValue'; items?: KeyValueItem[] }
	| { kind: 'table'; columns?: string[]; rows?: string[][] }
	| {
			kind: 'stat';
			label?: string;
			value?: number;
			displayValue?: string;
			caption?: string;
			color?: BlockColor;
			trend?: number[];
	  }
	| { kind: 'stats'; cards?: StatSpec[]; minColumnWidth?: number }
	| { kind: 'section'; title?: string; text?: string }
	| { kind: 'bars'; data?: BarSpec[]; topN?: number; emptyLabel?: string }
	| { kind: 'donut'; slices?: DonutSpec[]; size?: number }
	| { kind: 'successFailure'; successCount?: number; failureCount?: number }
	| { kind: 'sparkline'; data?: number[]; color?: BlockColor; height?: number };

/** Stat datum inside a `stats` grid (semantic color rather than raw hex). */
export interface StatSpec {
	label: string;
	value: number;
	displayValue?: string;
	caption?: string;
	color?: BlockColor;
	trend?: number[];
}

/** Bar datum for the `bars` block. */
export interface BarSpec {
	label: string;
	value: number;
	color?: BlockColor;
}

/** Slice datum for the `donut` block. */
export interface DonutSpec {
	label: string;
	value: number;
	color?: BlockColor;
}

/** A whole view: either a bare block array or `{ blocks: [...] }`. */
export type BlockSpec = Block[] | { blocks?: Block[] };
