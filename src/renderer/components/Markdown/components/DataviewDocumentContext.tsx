/**
 * DataviewDocumentContext - the document a `dataview` block belongs to (D7).
 *
 * A `customLanguageRenderers` entry receives only `{ code, theme }`, so the note's
 * path, the owning agent, and the surface's own link and task handlers reach the
 * block through this context instead. File Preview (Rich and Fast tiers) and the
 * Auto Run preview each wrap their rendered markdown in a provider; every other
 * surface has none, and the block renders the fence as ordinary code there, which
 * is a structural guard for DV-10 on top of registering the renderer at those two
 * sites only.
 *
 * A context rather than a renderer closed over the path: Auto Run's component map
 * does not rebuild on a same-folder document switch, so a closed-over path would go
 * stale, while a context value change re-renders the blocks in place.
 */

import { createContext, useContext } from 'react';

export interface DataviewDocumentScope {
	/** Absolute path of the note on screen. It binds `this` for every block in it. */
	filePath: string;
	/** The agent that owns the note: its cwd is the fallback vault root, its SSH remote the host. */
	agentId: string;
	/** The agent's SSH remote, when the note lives on one. */
	sshRemoteId?: string | null;
	/** Open a file the way a clicked `[[link]]` in this surface opens it. Takes an ABSOLUTE path. */
	openLink: (absolutePath: string, options?: { openInNewTab?: boolean }) => void;
	/**
	 * Toggle a task in the note on screen through the surface's own checkbox path
	 * (its unsaved-edit guard and write queue). Takes the 1-based source line and
	 * resolves false when nothing was written.
	 */
	toggleOwnTask?: (sourceLine: number) => Promise<boolean>;
}

export const DataviewDocumentContext = createContext<DataviewDocumentScope | null>(null);

/** The surrounding document scope, or null outside a Dataview surface. */
export function useDataviewDocument(): DataviewDocumentScope | null {
	return useContext(DataviewDocumentContext);
}
