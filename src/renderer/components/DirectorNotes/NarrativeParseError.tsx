/**
 * NarrativeParseError
 *
 * The OVERT failure surface shared by BOTH reading modes. When the AI's
 * structured output cannot be parsed into a `DirectorNotesNarrative`, Rich and
 * Plain Mode must fail loudly instead of silently degrading: neither may dump
 * the raw JSON object into a markdown renderer and call it a report. This banner
 * makes the failure unmissable (colored border + background + alert icon, full
 * width) and keeps the raw output reachable behind a "View raw output"
 * disclosure with a Copy button.
 *
 * Two states:
 * - Failure (default): nothing usable survived; this banner is all there is.
 * - Recovered (`recovery` set): a salvaged narrative renders alongside it, so
 *   the banner takes the softer warning tone and says what was recovered rather
 *   than passing a partial report off as a complete one.
 *
 * The deterministic stat widgets are unaffected either way (their numbers never
 * come from the LLM); only the narrative area shows this banner.
 */

import { useState } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, Copy, Check } from 'lucide-react';
import type { Theme } from '../../types';
import { safeClipboardWrite } from '../../utils/clipboard';

interface NarrativeParseErrorProps {
	theme: Theme;
	/** The precise parse error from `parseDirectorNotesNarrative`. */
	error: string;
	/** The raw agent output, preserved verbatim and shown on disclosure. */
	rawOutput: string;
	/**
	 * Set when a narrative WAS salvaged from this output: the human-readable
	 * reason from `recoverDirectorNotesNarrative`. Switches the banner to the
	 * partial-recovery state.
	 */
	recovery?: string | null;
}

export function NarrativeParseError({
	theme,
	error,
	rawOutput,
	recovery,
}: NarrativeParseErrorProps) {
	const [showRaw, setShowRaw] = useState(false);
	const [copied, setCopied] = useState(false);

	const copyRaw = async () => {
		if (!rawOutput) return;
		const ok = await safeClipboardWrite(rawOutput);
		if (ok) {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		}
	};

	// A recovered run still produced a readable narrative, so it warns rather
	// than errors; a total failure keeps the full error treatment.
	const accent = recovery ? theme.colors.warning : theme.colors.error;

	return (
		<div
			className="w-full rounded-lg border overflow-hidden"
			style={{
				backgroundColor: accent + '14',
				borderColor: accent + '66',
			}}
			role="alert"
		>
			<div className="flex items-start gap-3 p-4">
				<AlertTriangle
					className="w-5 h-5 shrink-0 mt-0.5"
					style={{ color: accent }}
					aria-hidden="true"
				/>
				<div className="flex-1 min-w-0 select-text">
					<h3 className="text-sm font-bold" style={{ color: accent }}>
						{recovery
							? "Part of the AI's structured output could not be parsed"
							: "Maestro could not parse the AI's structured output"}
					</h3>
					<p className="text-xs mt-1" style={{ color: theme.colors.textMain }}>
						{recovery
							? `${recovery} The narrative shown was rebuilt from the readable part, so it may be incomplete.`
							: 'The activity stats are unaffected, but the narrative could not be built from this run. The raw output is preserved below, and Copy / Save export it verbatim.'}
					</p>
					<p className="text-xs mt-2 font-mono break-words" style={{ color: accent }}>
						{error}
					</p>

					{/* Raw-output disclosure - the unparsed text stays reachable. */}
					<button
						type="button"
						onClick={() => setShowRaw((v) => !v)}
						className="focus-ring rounded flex items-center gap-1.5 mt-3 text-xs font-medium transition-colors"
						style={{ color: theme.colors.textDim }}
						aria-expanded={showRaw}
					>
						{showRaw ? (
							<ChevronDown className="w-3.5 h-3.5" />
						) : (
							<ChevronRight className="w-3.5 h-3.5" />
						)}
						{showRaw ? 'Hide raw output' : 'View raw output'}
					</button>

					{showRaw && (
						<div className="mt-2">
							<div className="flex justify-end mb-1">
								<button
									type="button"
									onClick={copyRaw}
									className="focus-ring flex items-center gap-1.5 px-2 py-1 rounded text-xs font-medium transition-colors"
									style={{
										backgroundColor: theme.colors.bgActivity,
										color: copied ? theme.colors.accent : theme.colors.textMain,
										border: `1px solid ${copied ? theme.colors.accent : theme.colors.border}`,
									}}
								>
									{copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
									{copied ? 'Copied!' : 'Copy'}
								</button>
							</div>
							<pre
								className="text-xs p-3 rounded overflow-auto max-h-80 whitespace-pre-wrap break-words scrollbar-thin"
								style={{
									backgroundColor: theme.colors.bgMain,
									color: theme.colors.textMain,
									border: `1px solid ${theme.colors.border}`,
								}}
							>
								{rawOutput}
							</pre>
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

export default NarrativeParseError;
