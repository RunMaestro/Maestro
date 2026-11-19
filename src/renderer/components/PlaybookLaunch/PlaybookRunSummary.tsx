/**
 * PlaybookRunSummary - the row above Run that says what one click starts:
 * how many documents, how many loops, and which agent on which model.
 *
 * When the manifest asked for unlimited loops, the import capped them
 * (`clampImportedMaxLoops`); the row says so and carries a slider to raise
 * the cap. A `scope: 'machine'` playbook adds one line saying it reaches past
 * the project.
 */

import { Bot, FileText, Monitor, Repeat } from 'lucide-react';
import { AUTO_MODEL_LABEL, isAutoModel } from '../../../shared/autoModel';
import { IMPORTED_MAX_LOOPS_CEILING } from '../../../shared/playbookRun';
import type { Playbook, Theme } from '../../types';
import { Slider } from '../widgets';

/** The highest loop count the raise slider offers. */
export const PLAYBOOK_RUN_MAX_LOOPS_LIMIT = 50;

export interface PlaybookRunSummaryProps {
	theme: Theme;
	playbook: Pick<Playbook, 'documents' | 'loopEnabled' | 'scope'>;
	/** The loop bound the run uses (the record's, or the user's raise). */
	maxLoops: number | null | undefined;
	/** The import replaced an unlimited loop with the ceiling; show the raise control. */
	capped: boolean;
	onMaxLoopsChange: (maxLoops: number) => void;
	agentName: string;
	/** The agent's configured model; absent means the provider's default. */
	model?: string | null;
}

export function describePlaybookRunModel(model: string | null | undefined): string {
	if (!model) return 'default model';
	return isAutoModel(model) ? AUTO_MODEL_LABEL : model;
}

export function describePlaybookRunLoops(
	loopEnabled: boolean,
	maxLoops: number | null | undefined
): string {
	if (!loopEnabled) return 'Runs once';
	if (typeof maxLoops !== 'number') return 'Loops until done';
	return `Up to ${maxLoops} ${maxLoops === 1 ? 'loop' : 'loops'}`;
}

export function PlaybookRunSummary({
	theme,
	playbook,
	maxLoops,
	capped,
	onMaxLoopsChange,
	agentName,
	model,
}: PlaybookRunSummaryProps) {
	const documentCount = playbook.documents.length;
	const iconClass = 'w-3.5 h-3.5 shrink-0';

	return (
		<div
			className="px-4 py-2.5 border-t space-y-2 text-xs shrink-0"
			style={{ borderColor: theme.colors.border, color: theme.colors.textMain }}
			data-testid="playbook-run-summary"
		>
			<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
				<span className="flex items-center gap-1.5" data-testid="playbook-run-summary-documents">
					<FileText className={iconClass} style={{ color: theme.colors.textDim }} aria-hidden />
					{documentCount} {documentCount === 1 ? 'document' : 'documents'}
				</span>
				<span className="flex items-center gap-1.5" data-testid="playbook-run-summary-loops">
					<Repeat className={iconClass} style={{ color: theme.colors.textDim }} aria-hidden />
					{describePlaybookRunLoops(playbook.loopEnabled, maxLoops)}
				</span>
				<span
					className="flex items-center gap-1.5 min-w-0 select-text"
					data-testid="playbook-run-summary-agent"
				>
					<Bot className={iconClass} style={{ color: theme.colors.textDim }} aria-hidden />
					<span className="truncate">
						on <strong>{agentName}</strong>
						<span style={{ color: theme.colors.textDim }}>
							{' '}
							({describePlaybookRunModel(model)})
						</span>
					</span>
				</span>
			</div>

			{capped && playbook.loopEnabled && typeof maxLoops === 'number' && (
				<div className="space-y-1" data-testid="playbook-run-summary-cap">
					<p style={{ color: theme.colors.warning }}>
						The playbook asks for unlimited loops. It is capped at {IMPORTED_MAX_LOOPS_CEILING} so
						one click cannot run forever; raise the cap here if it needs more.
					</p>
					<Slider
						theme={theme}
						label="Maximum loops"
						value={maxLoops}
						min={1}
						max={PLAYBOOK_RUN_MAX_LOOPS_LIMIT}
						onChange={onMaxLoopsChange}
					/>
				</div>
			)}

			{playbook.scope === 'machine' && (
				<p
					className="flex items-center gap-1.5"
					style={{ color: theme.colors.warning }}
					data-testid="playbook-run-summary-machine"
				>
					<Monitor className={iconClass} aria-hidden />
					This playbook configures your machine, not just this project.
				</p>
			)}
		</div>
	);
}
