/**
 * DataviewJsBlock - the `dataviewjs` fence renderer of the document surfaces (D3, D7, DV-11, DV-12, DV-14).
 *
 * It keeps the `{ code, theme }` contract of `customLanguageRenderers`; the note comes from
 * `DataviewDocumentContext`. Outside a provider, with the Encore Feature off, or in an untitled buffer, the fence
 * is the ordinary code it always was. Inside, `useDataviewJsRunPolicy()` (`dataviewJsRunPolicy()` in
 * `src/shared/dataview/trust.ts`) decides:
 * - `disabled` (the DataviewJS setting off): ordinary code;
 * - `desktop-only` (the web-desktop build, `isWebDesktop()`): the script as code, plus a pill that says it runs
 *   in the desktop app;
 * - `ask` and `run`: `DataviewJsTrustGate`, which shows the trust prompt or mounts `DataviewJsFrame`.
 */

import type { Theme } from '../../../types';
import { useSettingsStore } from '../../../stores/settingsStore';
import { useDataviewJsRunPolicy } from '../../../hooks/file/useDataviewJsRunPolicy';
import { useDataviewDocument, type DataviewDocumentScope } from './DataviewDocumentContext';
import { DataviewJsTrustGate } from './DataviewJsTrustGate';
import { PrismHighlightedCode } from './PrismCodeBlock';

/** What the pill says in the browser build, which never runs a guest (DV-14). */
export const DATAVIEW_JS_DESKTOP_ONLY_TEXT = 'DataviewJS runs in the desktop app';

/** The "desktop only" pill: a themed inline chip, so it sits after a block or inside a line alike. */
export function DataviewJsDesktopOnlyPill({ theme }: { theme: Theme }) {
	return (
		<span
			data-dataview-js-desktop-only-pill=""
			className="inline-block rounded-full px-2 py-0.5"
			style={{
				border: `1px solid ${theme.colors.border}`,
				color: theme.colors.textDim,
				fontSize: '0.75em',
				lineHeight: 1.4,
				whiteSpace: 'nowrap',
			}}
		>
			{DATAVIEW_JS_DESKTOP_ONLY_TEXT}
		</span>
	);
}

export function DataviewJsBlock({ code, theme }: { code: string; theme: Theme }) {
	const doc = useDataviewDocument();
	const enabled = useSettingsStore((s) => s.encoreFeatures?.dataview === true);
	if (!doc || !enabled || !doc.filePath) {
		return <PrismHighlightedCode code={code} language="dataviewjs" theme={theme} />;
	}
	return <PolicyBlock code={code} theme={theme} doc={doc} />;
}

function PolicyBlock({
	code,
	theme,
	doc,
}: {
	code: string;
	theme: Theme;
	doc: DataviewDocumentScope;
}) {
	const run = useDataviewJsRunPolicy(doc);
	switch (run.policy) {
		case 'disabled':
			return <PrismHighlightedCode code={code} language="dataviewjs" theme={theme} />;
		case 'desktop-only':
			return (
				<div className="dataview dataview-js" data-dataview-js-desktop-only="">
					<PrismHighlightedCode code={code} language="javascript" theme={theme} />
					<DataviewJsDesktopOnlyPill theme={theme} />
				</div>
			);
		case 'ask':
		case 'run':
			return <DataviewJsTrustGate code={code} theme={theme} doc={doc} run={run} />;
	}
}
