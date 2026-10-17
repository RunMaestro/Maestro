/**
 * AgentCotExportSection - the one control of chain of thought export: the
 * body of the Edit Agent dialog's Audit Log tab, operated by a person at the
 * desktop app.
 *
 * NOTHING HERE GOES THROUGH THE DIALOG'S SAVE
 * The folder and the switch are saved the moment they change, through
 * `window.maestro.cotExport`, into the feature's own store in the main
 * process. None of it is state of the dialog, so none of it can reach the
 * agent (`Session`) object, which lands in a file the CLI reads.
 *
 * WHERE IT SHOWS
 * Only in the desktop app. The browser build runs the same preload through a
 * shim, so `window.maestro.cotExport` exists there as well, and the main
 * process refuses every call a browser makes. So the section asks which
 * runtime it is in, and does not go by the API alone.
 *
 * EVERY FAILURE STAYS IN THE SECTION
 * A rejected call is caught here and shown inline. One that escaped would be
 * reported as an unhandled rejection with the channel's name in its message,
 * and this feature reports nothing outside the person's own screen. For the
 * same reason this file writes no log line.
 *
 * This feature is hidden from agents on purpose. Read the header of
 * `src/shared/cotExport/types.ts` before you change or expose anything here.
 * It has no hotkey, no palette entry, no menu item, and no CLI verb, and it
 * must not get one.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Folder, ShieldCheck } from 'lucide-react';

import type { CotAgentStatus, CotChainVerifyResult } from '../../../shared/cotExport/types';
import { formatCount, formatRelativeTime } from '../../../shared/formatters';
import type { Theme } from '../../types';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';
import { isWebDesktop } from '../../utils/runtimeContext';

export interface AgentCotExportSectionProps {
	theme: Theme;
	/** The Maestro agent the section controls. */
	agentId: string;
	/** The name the person gave the agent. */
	agentName: string;
	/** Whether the agent's provider exposes its reasoning at all. */
	supportsReasoning: boolean;
	/** True for a Claude Code agent whose turns can run through the interactive token source. */
	usesInteractiveTokenSource: boolean;
}

type CotExportApi = Window['maestro']['cotExport'];

/** What the last Verify Log gave: one verdict per chain, or why it could not run. */
type Verification = { results: CotChainVerifyResult[] } | { error: string };

/** `12 records`, `1 file`: a count with its noun. */
function countOf(count: number, noun: string): string {
	return `${formatCount(count)} ${noun}${count === 1 ? '' : 's'}`;
}

const BUTTON_CLASS =
	'shrink-0 flex items-center gap-1.5 text-xs px-2 py-1.5 rounded border transition-colors hover:bg-white/5 disabled:opacity-40 disabled:cursor-not-allowed';

/** The API where the section shows (see WHERE IT SHOWS), `undefined` everywhere else. */
function cotExportApi(): CotExportApi | undefined {
	return isWebDesktop() ? undefined : window.maestro?.cotExport;
}

/**
 * Whether this runtime shows the section at all. Edit Agent asks before it
 * draws the tab that holds the section, so no runtime gets an empty tab.
 */
export function isCotExportAvailable(): boolean {
	return cotExportApi() !== undefined;
}

export function AgentCotExportSection(
	props: AgentCotExportSectionProps
): React.ReactElement | null {
	const api = cotExportApi();
	if (!api) return null;
	return <CotExportControls {...props} api={api} />;
}

function CotExportControls({
	theme,
	agentId,
	agentName,
	supportsReasoning,
	usesInteractiveTokenSource,
	api,
}: AgentCotExportSectionProps & { api: CotExportApi }): React.ReactElement {
	const [status, setStatus] = useState<CotAgentStatus | null>(null);
	const [loadError, setLoadError] = useState<string | null>(null);
	/** Why the last folder or switch change was refused. */
	const [changeError, setChangeError] = useState<string | null>(null);
	const [verification, setVerification] = useState<Verification | null>(null);
	const [busy, setBusy] = useState(false);

	// The agent this section shows right now. An answer for another agent, or
	// one that arrives after the dialog closed, is dropped.
	const shownAgentRef = useRef<string | null>(null);
	const isShown = useCallback(() => shownAgentRef.current === agentId, [agentId]);

	useEffect(() => {
		shownAgentRef.current = agentId;
		setStatus(null);
		setLoadError(null);
		setChangeError(null);
		setVerification(null);
		setBusy(false);
		api.status(agentId).then(
			(loaded) => {
				if (shownAgentRef.current === agentId) setStatus(loaded);
			},
			(error) => {
				if (shownAgentRef.current === agentId) setLoadError(ipcErrorMessage(error));
			}
		);
		return () => {
			shownAgentRef.current = null;
		};
	}, [api, agentId]);

	/**
	 * Saves a choice at once. A refusal changes nothing in the store, so the
	 * section keeps showing what is stored and says why.
	 */
	const saveChoice = useCallback(
		async (choice: { enabled: boolean; folder: string | null }) => {
			const result = await api.set(agentId, choice);
			if (!isShown()) return;
			if (result.ok) {
				setStatus(result.status);
				setChangeError(null);
			} else {
				setChangeError(result.reason);
			}
		},
		[api, agentId, isShown]
	);

	const handleChooseFolder = useCallback(async () => {
		if (!status) return;
		setBusy(true);
		try {
			const picked = await window.maestro.dialog.selectFolder();
			if (!picked || !isShown()) return;
			// Checked before it is saved: a folder that is refused is never
			// handed to `set`, and the stored folder stays as it is.
			const validation = await api.validateFolder(agentId, picked);
			if (!isShown()) return;
			if (!validation.ok) {
				setChangeError(validation.reason);
				return;
			}
			await saveChoice({ enabled: status.enabled, folder: validation.resolved });
		} catch (error) {
			if (isShown()) setChangeError(ipcErrorMessage(error));
		} finally {
			if (isShown()) setBusy(false);
		}
	}, [api, agentId, status, isShown, saveChoice]);

	const handleToggle = useCallback(
		async (enabled: boolean) => {
			if (!status || status.folder === null) return;
			setBusy(true);
			try {
				await saveChoice({ enabled, folder: status.folder });
			} catch (error) {
				if (isShown()) setChangeError(ipcErrorMessage(error));
			} finally {
				if (isShown()) setBusy(false);
			}
		},
		[status, isShown, saveChoice]
	);

	const handleVerify = useCallback(async () => {
		setBusy(true);
		setVerification(null);
		try {
			const results = await api.verify(agentId);
			if (isShown()) setVerification({ results });
		} catch (error) {
			if (isShown()) setVerification({ error: ipcErrorMessage(error) });
		}
		// A verify first checks the stored head against the disk, and a check
		// that fails is kept as the agent's last failure. Read the status again
		// so the line below shows it.
		try {
			const refreshed = await api.status(agentId);
			if (isShown()) setStatus(refreshed);
		} catch {
			// The status already shown stays. The verdict above is what was asked for.
		}
		if (isShown()) setBusy(false);
	}, [api, agentId, isShown]);

	const { colors } = theme;
	const folder = status?.folder ?? null;
	const held = busy || status === null;
	// Off is never held back by the folder: a folder that has gone bad must not
	// keep the person from stopping. On needs a folder first.
	const toggleDisabled = held || folder === null;

	return (
		<div data-testid="cot-export-section">
			<div
				className="block text-xs font-bold opacity-70 uppercase mb-2"
				style={{ color: colors.textMain }}
			>
				Audit Log
			</div>
			<p className="text-xs mb-2" style={{ color: colors.textDim }}>
				When this is on, Maestro records each turn of {agentName} into a folder you choose: the
				prompt, the reasoning, each tool call and its result, the replies, and the usage.
			</p>
			<p className="text-xs mb-2" style={{ color: colors.textDim }} data-testid="cot-export-scope">
				Recorded: messages sent in this app, Auto Run tasks, Group Chat replies, Cue runs, and
				answers to another agent's question. A turn started from the command line is recorded with
				its prompt and how it ended, without its output. Not recorded: anything a program the agent
				starts does on its own.
			</p>
			<p
				className="text-xs mb-2"
				style={{ color: colors.textDim }}
				data-testid="cot-export-reasoning"
			>
				Reasoning is recorded as far as the provider shows it. When a provider returns it encrypted,
				the log holds proof that a reasoning block existed (its size and hash), not its text.
			</p>

			{status?.unencrypted && (
				<div
					className="flex items-start gap-1.5 text-xs mb-2"
					style={{ color: colors.warning }}
					data-testid="cot-export-unencrypted"
				>
					<AlertTriangle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
					<span>
						This system has no key store, so the settings for this feature are obscured, not
						encrypted.
					</span>
				</div>
			)}

			<div
				className="flex items-center gap-2 px-2 py-1.5 rounded"
				style={{ backgroundColor: colors.bgActivity }}
			>
				<span
					className={`flex-1 min-w-0 text-xs break-all ${folder ? 'font-mono select-text' : ''}`}
					style={{ color: folder ? colors.textMain : colors.textDim }}
					data-testid="cot-export-folder"
				>
					{folder ?? 'No folder chosen'}
				</span>
				<button
					type="button"
					onClick={() => void handleChooseFolder()}
					disabled={held}
					className={BUTTON_CLASS}
					style={{ borderColor: colors.border, color: colors.textMain }}
				>
					<Folder className="w-3.5 h-3.5" />
					Choose Folder
				</button>
			</div>
			{changeError && (
				<p
					role="alert"
					className="mt-1 text-xs select-text"
					style={{ color: colors.error }}
					data-testid="cot-export-change-error"
				>
					{changeError}
				</p>
			)}

			<label
				className={`mt-2 flex items-start gap-2 px-2 py-1.5 rounded transition-colors ${
					toggleDisabled ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-white/5'
				}`}
				style={{ backgroundColor: colors.bgActivity }}
			>
				<input
					type="checkbox"
					checked={status?.enabled ?? false}
					disabled={toggleDisabled}
					onChange={(e) => void handleToggle(e.target.checked)}
					className="mt-0.5 accent-current"
					style={{ accentColor: colors.accent }}
					aria-label="Keep an audit log for this agent"
				/>
				<div className="flex flex-col min-w-0">
					<span
						className="text-xs font-medium"
						style={{ color: toggleDisabled ? colors.textDim : colors.textMain }}
					>
						Keep an audit log for this agent
					</span>
					<span className="text-2xs" style={{ color: colors.textDim }}>
						Applies from this agent's next message. Maestro never deletes these files. The folder
						must be outside every agent's working directory.
					</span>
				</div>
			</label>

			{!supportsReasoning && (
				<p className="mt-2 text-xs" style={{ color: colors.textDim }}>
					This provider does not expose its reasoning. Prompts are still recorded, and so are tool
					calls, results, replies, and usage when the provider reports them.
				</p>
			)}
			{usesInteractiveTokenSource && (
				<p className="mt-2 text-xs" style={{ color: colors.textDim }}>
					Reasoning may be missing while this agent runs through the interactive token source.
				</p>
			)}

			{loadError && (
				<p role="alert" className="mt-2 text-xs select-text" style={{ color: colors.error }}>
					Maestro could not read the audit log settings of this agent: {loadError}
				</p>
			)}
			{folder !== null && status && (
				<p
					className="mt-2 text-xs"
					style={{ color: colors.textDim }}
					data-testid="cot-export-status"
				>
					{status.lastWriteAt === undefined
						? 'No record written yet.'
						: `Last write ${formatRelativeTime(status.lastWriteAt)}.`}{' '}
					{countOf(status.turnsToday, 'turn')} recorded today.
				</p>
			)}
			{status?.lastError && (
				<p
					role="alert"
					className="mt-1 text-xs select-text"
					style={{ color: colors.error }}
					data-testid="cot-export-last-error"
				>
					Last failure, {formatRelativeTime(status.lastError.at)}: {status.lastError.message}
				</p>
			)}

			<button
				type="button"
				onClick={() => void handleVerify()}
				disabled={held || folder === null}
				className={`mt-2 ${BUTTON_CLASS}`}
				style={{ borderColor: colors.border, color: colors.textMain }}
			>
				<ShieldCheck className="w-3.5 h-3.5" />
				Verify Log
			</button>
			{verification && <VerificationOutput theme={theme} verification={verification} />}
		</div>
	);
}

/** What Verify Log found, one block per chain, the current folder first. */
function VerificationOutput({
	theme,
	verification,
}: {
	theme: Theme;
	verification: Verification;
}): React.ReactElement {
	const { colors } = theme;
	if ('error' in verification) {
		return (
			<p role="alert" className="mt-2 text-xs select-text" style={{ color: colors.error }}>
				Maestro could not verify the log: {verification.error}
			</p>
		);
	}
	if (verification.results.length === 0) {
		return (
			<p className="mt-2 text-xs" style={{ color: colors.textDim }}>
				There is no log to verify yet.
			</p>
		);
	}
	return (
		<ul className="mt-2 space-y-2 text-xs select-text" data-testid="cot-export-verification">
			{verification.results.map((result) => (
				<li key={result.folder}>
					<div className="font-mono break-all" style={{ color: colors.textDim }}>
						{result.folder}
					</div>
					{result.error ? (
						<div role="alert" style={{ color: colors.error }}>
							Maestro could not check this folder: {result.error}
						</div>
					) : result.ok ? (
						<div style={{ color: colors.success }}>
							Intact: {countOf(result.recordsChecked, 'record')} in{' '}
							{countOf(result.filesChecked, 'file')}
						</div>
					) : (
						<div style={{ color: colors.error }}>
							{result.firstBreak && (
								<>
									<div>
										Broken at position {formatCount(result.firstBreak.chainSeq)} in{' '}
										<span className="font-mono break-all">{result.firstBreak.file}</span>
									</div>
									<div>{result.firstBreak.reason}</div>
								</>
							)}
							{!result.headMatches && (
								<div>
									The newest record in this folder is not the last one Maestro wrote: records were
									removed from the end of the log, or added to it.
								</div>
							)}
							<div style={{ color: colors.textDim }}>
								Checked {countOf(result.recordsChecked, 'record')} in{' '}
								{countOf(result.filesChecked, 'file')}.
							</div>
						</div>
					)}
				</li>
			))}
		</ul>
	);
}
