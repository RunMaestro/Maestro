/**
 * DataviewJsTrustGate - the trust gate in front of one `dataviewjs` block (D3, DV-12).
 *
 * The block's renderer reads `useDataviewJsRunPolicy()` and handles `disabled` and `desktop-only` itself;
 * for `ask` and `run` it renders this gate with that state:
 * - `run` (a trusted vault) mounts `DataviewJsFrame`.
 * - `ask` shows the script's source as highlighted code, says that it would read the vault, and offers two
 *   buttons. "Run once" asks main for a grant that lasts this app session (`dataview:jsRunOnce`, without
 *   which main refuses the snapshot) and then runs this block only; editing the script asks again.
 *   "Always trust this vault" adds the root to `dataviewJsTrustedRoots` through main (`trustDataviewRoot()`),
 *   and the new policy mounts the guest in every block of the vault.
 * While main is still naming the note's vault root, the gate shows a placeholder, so a trusted vault never
 * flashes the prompt.
 */

import { useState } from 'react';
import type { Theme } from '../../../types';
import type { DataviewJsRunState } from '../../../hooks/file/useDataviewJsRunPolicy';
import { trustDataviewRoot } from '../../../services/dataviewTrust';
import { ipcErrorMessage } from '../../../utils/ipcErrorMessage';
import { AlertCallout } from './AlertCallout';
import { DataviewJsFrame } from './DataviewJsFrame';
import type { DataviewDocumentScope } from './DataviewDocumentContext';
import { PrismHighlightedCode } from './PrismCodeBlock';

/** Height of the placeholder while the root resolves, as `DataviewBlock` uses. */
const PLACEHOLDER_HEIGHT = '2.5em';

export interface DataviewJsTrustGateProps {
	/** The block's script. */
	code: string;
	theme: Theme;
	/** The note the block sits in. */
	doc: DataviewDocumentScope;
	/** `useDataviewJsRunPolicy(doc)`, with a policy of `ask` or `run`. */
	run: DataviewJsRunState;
}

/** A new note is a new gate: a "Run once" in one note never runs a block of another. */
export function DataviewJsTrustGate(props: DataviewJsTrustGateProps) {
	const { agentId, filePath } = props.doc;
	return <NoteTrustGate key={`${agentId}\0${filePath}`} {...props} />;
}

function NoteTrustGate({ code, theme, doc, run }: DataviewJsTrustGateProps) {
	// "Run once" covers the script as it was when the user chose it; an edit asks again.
	const [ranOnceFor, setRanOnceFor] = useState<string | null>(null);

	if (run.policy === 'run' || (run.policy === 'ask' && ranOnceFor === code)) {
		return <DataviewJsFrame code={code} theme={theme} doc={doc} />;
	}
	if (run.resolving) {
		return (
			<div
				className="dataview dataview-js"
				data-dataview-loading=""
				aria-busy="true"
				style={{ minHeight: PLACEHOLDER_HEIGHT, margin: '0.5em 0' }}
			/>
		);
	}
	return (
		<DataviewJsTrustPrompt
			code={code}
			theme={theme}
			doc={doc}
			root={run.root}
			rootError={run.error}
			onRunOnce={() => setRanOnceFor(code)}
		/>
	);
}

interface DataviewJsTrustPromptProps {
	code: string;
	theme: Theme;
	doc: DataviewDocumentScope;
	root: string | null;
	rootError: string | null;
	onRunOnce: () => void;
}

function DataviewJsTrustPrompt({
	code,
	theme,
	doc,
	root,
	rootError,
	onRunOnce,
}: DataviewJsTrustPromptProps) {
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const act = async (action: () => Promise<unknown>) => {
		setBusy(true);
		setError(null);
		try {
			await action();
		} catch (failure) {
			setError(ipcErrorMessage(failure));
		} finally {
			setBusy(false);
		}
	};

	const runOnce = () =>
		act(async () => {
			await window.maestro.dataview.jsRunOnce({ agentId: doc.agentId, filePath: doc.filePath });
			onRunOnce();
		});
	const alwaysTrust = () =>
		act(async () => {
			if (root !== null) await trustDataviewRoot(root);
		});

	const vault = root ?? 'this vault';
	const problem = error ?? rootError;
	const buttonStyle = {
		border: `1px solid ${theme.colors.border}`,
		color: theme.colors.textMain,
	};

	return (
		<div className="dataview dataview-js" data-dataview-js-trust="" style={{ margin: '0.5em 0' }}>
			<PrismHighlightedCode code={code} language="javascript" theme={theme} />
			<AlertCallout type="warning" theme={theme}>
				<div style={{ fontSize: '0.9em' }}>
					This DataviewJS script would read your vault ({vault}) when it runs. It runs in an
					isolated sandbox with no access to Maestro or to files outside the vault.
				</div>
				{problem && (
					<div
						data-dataview-error=""
						style={{ marginTop: '0.4em', fontSize: '0.85em', color: theme.colors.error }}
					>
						{problem}
					</div>
				)}
				<div className="flex gap-2 mt-2">
					<button
						type="button"
						onClick={runOnce}
						disabled={busy}
						className="px-2 py-0.5 rounded text-xs disabled:opacity-50"
						style={buttonStyle}
					>
						Run once
					</button>
					<button
						type="button"
						onClick={alwaysTrust}
						disabled={busy || root === null}
						title={root === null ? undefined : `Run every DataviewJS block in ${root}`}
						className="px-2 py-0.5 rounded text-xs disabled:opacity-50"
						style={buttonStyle}
					>
						Always trust this vault
					</button>
				</div>
			</AlertCallout>
		</div>
	);
}
