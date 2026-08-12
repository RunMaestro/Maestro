/** Shared URL contract for isolated Concerto HTML documents. */

export const CONCERTO_HTML_SCHEME = 'maestro-concerto';
export const CONCERTO_DESIGNER_CHANNEL = 'maestro-concerto-designer-v1';

export type ConcertoHtmlSurface = 'movement' | 'cadenza';

export interface ConcertoHtmlTarget {
	surface: ConcertoHtmlSurface;
	id: string;
}

export type ConcertoDesignerLogLevel = 'log' | 'info' | 'warn' | 'error';

export interface ConcertoDesignerLogEntry {
	level: ConcertoDesignerLogLevel;
	message: string;
	timestamp: number;
	line?: number;
	column?: number;
}

export interface ConcertoDesignerRect {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Renderer-owned state used by main to crop a live Concerto screenshot. */
export interface ConcertoDesignerFrameSnapshot {
	id: string;
	ready: boolean;
	revision: number;
	rect: ConcertoDesignerRect;
	viewport: { width: number; height: number };
	logs: ConcertoDesignerLogEntry[];
}

/** Agent-facing inspection result. The CLI strips imageDataUrl after saving it. */
export interface MovementDesignerInspection {
	id: string;
	ready: boolean;
	viewport: { width: number; height: number };
	image: { width: number; height: number; scaleFactor: number };
	logs: ConcertoDesignerLogEntry[];
	imageDataUrl: string;
}

export type ConcertoDesignerAction =
	| { kind: 'click'; selector: string }
	| { kind: 'type'; selector: string; value: string };

export interface ConcertoDesignerActionResult {
	ok: boolean;
	action: ConcertoDesignerAction['kind'];
	selector: string;
	message: string;
	element?: {
		tag: string;
		text: string;
		ariaLabel?: string;
	};
}

export function buildConcertoHtmlUrl(
	surface: ConcertoHtmlSurface,
	id: string,
	revision: number
): string {
	const params = new URLSearchParams({ surface, id, revision: String(revision) });
	return `${CONCERTO_HTML_SCHEME}://render/?${params.toString()}`;
}

export function parseConcertoHtmlUrl(value: string): ConcertoHtmlTarget | null {
	try {
		const url = new URL(value);
		if (url.protocol !== `${CONCERTO_HTML_SCHEME}:` || url.hostname !== 'render') return null;
		const surface = url.searchParams.get('surface');
		const id = url.searchParams.get('id');
		if ((surface !== 'movement' && surface !== 'cadenza') || !id) return null;
		return { surface, id };
	} catch {
		return null;
	}
}

export function isConcertoHtmlUrl(value: string | undefined | null): boolean {
	return !!value && value.startsWith(`${CONCERTO_HTML_SCHEME}://`);
}
