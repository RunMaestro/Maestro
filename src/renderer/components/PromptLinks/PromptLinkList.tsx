/**
 * The left column of the Prompt Links window: a "New link" row, then every
 * link with a status dot, its name, and the agent it runs in. Used, expired,
 * and revoked links sit in a collapsed group under the active ones, so the list
 * answers "what can still run?" at a glance.
 */

import { ChevronRight, Info, Plus } from 'lucide-react';
import type { Theme } from '../../types';
import {
	describePromptLinkUses,
	promptLinkStatus,
	type PromptLinkPublic,
	type PromptLinkStatus,
} from '../../../shared/promptLinks';

/** Dot / badge color for a link's state, shared by the list and the detail pane. */
export function promptLinkStatusColor(theme: Theme, status: PromptLinkStatus): string {
	switch (status) {
		case 'active':
			return theme.colors.success;
		case 'expired':
			return theme.colors.warning;
		case 'revoked':
			return theme.colors.error;
		case 'spent':
			return theme.colors.textDim;
	}
}

/** What a link is called in a list: its label, else the first line of its prompt. */
export function promptLinkTitle(link: PromptLinkPublic, max = 60): string {
	if (link.label) return link.label;
	const line = link.prompt.trim().split('\n')[0] ?? '';
	return line.length > max ? `${line.slice(0, max - 3)}...` : line;
}

export type PromptLinkSelection = { kind: 'new' } | { kind: 'link'; id: string };

interface PromptLinkListProps {
	theme: Theme;
	links: PromptLinkPublic[] | null;
	loadError: string | null;
	agentNames: ReadonlyMap<string, string>;
	selection: PromptLinkSelection | null;
	onSelect: (selection: PromptLinkSelection) => void;
	showInactive: boolean;
	onToggleInactive: () => void;
	now: number;
}

export function PromptLinkList({
	theme,
	links,
	loadError,
	agentNames,
	selection,
	onSelect,
	showInactive,
	onToggleInactive,
	now,
}: PromptLinkListProps) {
	const active = (links ?? []).filter((l) => promptLinkStatus(l, now) === 'active');
	const inactive = (links ?? []).filter((l) => promptLinkStatus(l, now) !== 'active');
	const newSelected = selection?.kind === 'new';

	const row = (link: PromptLinkPublic) => {
		const status = promptLinkStatus(link, now);
		const selected = selection?.kind === 'link' && selection.id === link.id;
		const dim = status !== 'active';
		return (
			<button
				key={link.id}
				type="button"
				data-testid="prompt-link-row"
				data-link-id={link.id}
				aria-current={selected ? 'true' : undefined}
				onClick={() => onSelect({ kind: 'link', id: link.id })}
				className="w-full text-left flex items-start gap-2.5 px-2.5 py-2 rounded-md transition-colors hover:bg-white/5"
				style={{ backgroundColor: selected ? theme.colors.bgActivity : undefined }}
				title={link.prompt}
			>
				<span
					className="mt-1.5 w-2 h-2 rounded-full flex-shrink-0"
					style={{ backgroundColor: promptLinkStatusColor(theme, status) }}
					aria-label={status}
				/>
				<span className="min-w-0 flex-1">
					<span
						className="block text-xs font-medium truncate"
						style={{ color: dim ? theme.colors.textDim : theme.colors.textMain }}
					>
						{promptLinkTitle(link)}
					</span>
					<span className="block text-2xs truncate" style={{ color: theme.colors.textDim }}>
						{agentNames.get(link.agentId) ?? 'Deleted agent'} ·{' '}
						{status === 'active' ? describePromptLinkUses(link) : status}
					</span>
				</span>
			</button>
		);
	};

	return (
		<div className="flex flex-col min-h-0 h-full">
			<div className="p-2 flex-shrink-0">
				<button
					type="button"
					data-testid="prompt-links-new"
					aria-current={newSelected ? 'true' : undefined}
					onClick={() => onSelect({ kind: 'new' })}
					className="w-full flex items-center gap-2 px-2.5 py-2 rounded-md text-xs font-medium transition-colors"
					style={{
						backgroundColor: newSelected ? `${theme.colors.accent}26` : 'transparent',
						color: theme.colors.accent,
						border: `1px dashed ${newSelected ? theme.colors.accent : theme.colors.border}`,
					}}
				>
					<Plus className="w-3.5 h-3.5" /> New link
				</button>
			</div>

			<div className="flex-1 min-h-0 overflow-y-auto px-2 pb-2">
				{loadError && (
					<p
						className="text-xs px-2.5 py-1"
						data-testid="prompt-links-load-error"
						style={{ color: theme.colors.error }}
					>
						{loadError}
					</p>
				)}
				{links === null ? (
					<p className="text-xs px-2.5 py-2" style={{ color: theme.colors.textDim }}>
						Loading...
					</p>
				) : links.length === 0 ? (
					<p
						className="text-xs px-2.5 py-2"
						data-testid="prompt-links-empty"
						style={{ color: theme.colors.textDim }}
					>
						No prompt links yet.
					</p>
				) : (
					<>
						{active.length === 0 && (
							<p
								className="text-xs px-2.5 py-2"
								data-testid="prompt-links-empty"
								style={{ color: theme.colors.textDim }}
							>
								No active links.
							</p>
						)}
						{active.map(row)}
						{inactive.length > 0 && (
							<>
								<button
									type="button"
									data-testid="prompt-links-toggle-inactive"
									aria-expanded={showInactive}
									onClick={onToggleInactive}
									className="w-full flex items-center gap-1 px-2.5 pt-3 pb-1 text-2xs uppercase tracking-wide"
									style={{ color: theme.colors.textDim }}
								>
									<ChevronRight
										className="w-3 h-3 transition-transform"
										style={{ transform: showInactive ? 'rotate(90deg)' : undefined }}
									/>
									Used, expired, revoked ({inactive.length})
								</button>
								{showInactive && inactive.map(row)}
							</>
						)}
					</>
				)}
			</div>

			<div
				className="flex-shrink-0 flex items-start gap-1.5 px-3 py-2.5 border-t text-2xs leading-snug"
				data-testid="prompt-links-warning"
				style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
			>
				<Info className="w-3 h-3 flex-shrink-0 mt-px" />
				<span>
					A link is a key: anyone who has it can run its prompt here. Calendar events are copied to
					every attendee.
				</span>
			</div>
		</div>
	);
}
