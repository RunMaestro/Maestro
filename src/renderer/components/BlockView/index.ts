/**
 * BlockView - the surface-agnostic engine for rendering agent-authored,
 * theme-styled data views from a composable block tree. See ./types for the
 * schema (the vocabulary agents compose with) and ./BlockView for the renderer.
 */

export { BlockView } from './BlockView';
export type {
	Block,
	BlockSpec,
	BlockColor,
	BlockGap,
	BlockAlign,
	KeyValueItem,
	StatSpec,
	BarSpec,
	DonutSpec,
} from './types';
export { resolveBlockColor, resolveGap, resolveAlign, GAP_PX } from './tokens';
