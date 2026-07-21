/**
 * Cadenza views - small, agent-openable panels that display or track what the
 * user is working on. Opened via `maestro-cli view` (a "Poke" primitive), they
 * ride the same CLI -> WebSocket -> main -> `remote:cadenza` -> renderer bridge
 * that `notify_toast` uses.
 *
 * This is the first, additive slice of the larger view-first "dynamic interface"
 * the widget library is scaffolded toward: the agent composes what the user
 * sees, and the app handles how it looks (no agent-authored CSS).
 *
 * Shared across the CLI command, the main-process bridge handler, the preload
 * bridge, and the renderer store so all four layers agree on one payload shape.
 */

/**
 * What a cadenza renders:
 *   tracker  - a live title + body line the agent updates in place
 *   file     - a pin to a file the user can expand into a File Preview tab
 *   markdown - rich content the agent wants to show (text, code, tables,
 *              lists), rendered through the app's Markdown renderer
 *   image    - a local image the agent wants to show, by path
 *   code     - a syntax-highlighted code snippet (from a file path or inline);
 *              pop several at once to show related code side by side
 *   view     - a custom view the agent composes from native building blocks
 *              (stat cards, sections, bars, donuts, ...) as a JSON spec in `body`
 *   html     - an isolated single-page HTML mockup with inline CSS/JavaScript
 *   decision - a prompt (`body`) plus `options` buttons; clicking one replies to
 *              the owning agent with that option's value (a live prompt inject)
 */
export type CadenzaViewType =
	| 'tracker'
	| 'file'
	| 'markdown'
	| 'image'
	| 'code'
	| 'view'
	| 'html'
	| 'decision';

/** One choice on a `decision` cadenza. Clicking sends `value` to the agent. */
export interface CadenzaDecisionOption {
	/** Button label shown to the user. */
	label: string;
	/** Message replied to the owning agent when this option is chosen. */
	value: string;
}

/** Same five-color language as Toast / Center Flash. `theme` matches the active theme. */
export type CadenzaColor = 'green' | 'yellow' | 'orange' | 'red' | 'theme';

export const CADENZA_COLORS: readonly CadenzaColor[] = [
	'green',
	'yellow',
	'orange',
	'red',
	'theme',
] as const;

export const CADENZA_VIEW_TYPES: readonly CadenzaViewType[] = [
	'tracker',
	'file',
	'markdown',
	'image',
	'code',
	'view',
	'html',
	'decision',
] as const;

/** open = create or replace by id; update = merge fields into an open cadenza
 *  (the "living" behavior); close = remove it. */
export type CadenzaOp = 'open' | 'update' | 'close';

export const CADENZA_OPS: readonly CadenzaOp[] = ['open', 'update', 'close'] as const;

/**
 * The payload sent across the bridge for every cadenza operation. `id` is a
 * stable, caller-chosen key so `update`/`close` can target an open cadenza.
 * On `open`, `viewType` is required; other fields are optional refinements.
 */
export interface CadenzaPayload {
	op: CadenzaOp;
	/** Stable id chosen by the agent; identifies the cadenza for update/close. */
	id: string;
	/** Required on `open`; ignored on `close`. */
	viewType?: CadenzaViewType;
	/** Header label. */
	title?: string;
	/** Tracker line, markdown source, JSON block spec, or HTML document. */
	body?: string;
	/** File path for the `file` type, or the image path for the `image` type. */
	path?: string;
	/** Accent color; defaults to `theme`. */
	color?: CadenzaColor;
	/** Choice buttons for the `decision` type. */
	options?: CadenzaDecisionOption[];
	/** Owning agent, so the user can expand the cadenza into that agent's tab. */
	sessionId?: string;
	/**
	 * Resolved display name of the owning agent, stamped by the main process when
	 * routing to the HUD window (which has no session store of its own to resolve
	 * `sessionId`). The in-app layer resolves this locally instead.
	 */
	sourceAgent?: string;
	/** Host-stamped plugin display name for a plugin-contributed view. */
	sourcePlugin?: string;
}
