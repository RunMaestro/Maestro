/**
 * DispatchFilters — filter bar for the Agent Dispatch Kanban board.
 *
 * Supports: status, type, tag, owner, capability, claim holder, and project.
 */

import { memo, useCallback } from 'react';
import { Filter, X } from 'lucide-react';
import type { Theme, WorkItemStatus, WorkItemType } from '../../types';

// ---------------------------------------------------------------------------
// Public filter shape
// ---------------------------------------------------------------------------

export interface KanbanFilters {
	statuses: WorkItemStatus[];
	types: WorkItemType[];
	tags: string[];
	ownerIds: string[];
	capabilities: string[];
	claimHolderIds: string[];
	projectPaths: string[];
}

export const EMPTY_FILTERS: KanbanFilters = {
	statuses: [],
	types: [],
	tags: [],
	ownerIds: [],
	capabilities: [],
	claimHolderIds: [],
	projectPaths: [],
};

export function hasActiveFilters(f: KanbanFilters): boolean {
	return Object.values(f).some((arr) => (arr as string[]).length > 0);
}

// ---------------------------------------------------------------------------
// Filter option lists
// ---------------------------------------------------------------------------

const STATUS_OPTIONS: WorkItemStatus[] = [
	'discovered',
	'planned',
	'ready',
	'claimed',
	'in_progress',
	'blocked',
	'review',
	'done',
	'archived',
	'canceled',
];

const TYPE_OPTIONS: WorkItemType[] = [
	'task',
	'bug',
	'feature',
	'chore',
	'document',
	'decision',
	'milestone',
];

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface MultiSelectProps<T extends string> {
	label: string;
	options: T[];
	selected: T[];
	onChange: (next: T[]) => void;
	theme: Theme;
}

function MultiSelect<T extends string>({
	label,
	options,
	selected,
	onChange,
	theme,
}: MultiSelectProps<T>) {
	const toggle = useCallback(
		(v: T) => {
			onChange(selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v]);
		},
		[selected, onChange]
	);

	return (
		<div className="flex flex-col gap-1 min-w-0">
			<span className="text-[10px] uppercase font-bold" style={{ color: theme.colors.textDim }}>
				{label}
			</span>
			<div className="flex flex-wrap gap-1">
				{options.map((opt) => {
					const active = selected.includes(opt);
					return (
						<button
							key={opt}
							onClick={() => toggle(opt)}
							className="text-[10px] rounded px-1.5 py-0.5 border transition-colors"
							style={{
								borderColor: active ? theme.colors.accent : theme.colors.border,
								backgroundColor: active ? `${theme.colors.accent}20` : 'transparent',
								color: active ? theme.colors.accent : theme.colors.textDim,
							}}
						>
							{opt}
						</button>
					);
				})}
			</div>
		</div>
	);
}

interface TextChipsProps {
	label: string;
	values: string[];
	allValues: string[];
	onChange: (next: string[]) => void;
	theme: Theme;
}

function TextChips({ label, values, allValues, onChange, theme }: TextChipsProps) {
	const toggle = useCallback(
		(v: string) => {
			onChange(values.includes(v) ? values.filter((s) => s !== v) : [...values, v]);
		},
		[values, onChange]
	);

	if (allValues.length === 0) return null;

	return (
		<div className="flex flex-col gap-1 min-w-0">
			<span className="text-[10px] uppercase font-bold" style={{ color: theme.colors.textDim }}>
				{label}
			</span>
			<div className="flex flex-wrap gap-1">
				{allValues.map((v) => {
					const active = values.includes(v);
					return (
						<button
							key={v}
							onClick={() => toggle(v)}
							className="text-[10px] rounded px-1.5 py-0.5 border transition-colors"
							style={{
								borderColor: active ? theme.colors.accentText : theme.colors.border,
								backgroundColor: active ? `${theme.colors.accentText}20` : 'transparent',
								color: active ? theme.colors.accentText : theme.colors.textDim,
							}}
						>
							{v}
						</button>
					);
				})}
			</div>
		</div>
	);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface DispatchFiltersProps {
	filters: KanbanFilters;
	onChange: (next: KanbanFilters) => void;
	theme: Theme;
	/** Dynamic values derived from board items */
	availableTags?: string[];
	availableOwners?: Array<{ id: string; name: string }>;
	availableCapabilities?: string[];
	availableClaimHolders?: Array<{ id: string; name: string }>;
	availableProjects?: string[];
}

export const DispatchFilters = memo(function DispatchFilters({
	filters,
	onChange,
	theme,
	availableTags = [],
	availableOwners = [],
	availableCapabilities = [],
	availableClaimHolders = [],
	availableProjects = [],
}: DispatchFiltersProps) {
	const set = <K extends keyof KanbanFilters>(key: K, val: KanbanFilters[K]) =>
		onChange({ ...filters, [key]: val });

	const active = hasActiveFilters(filters);

	const ownerNames = availableOwners.map((o) => o.name ?? o.id);
	const claimHolderNames = availableClaimHolders.map((c) => c.name ?? c.id);

	const ownerNameToId = Object.fromEntries(availableOwners.map((o) => [o.name ?? o.id, o.id]));
	const claimNameToId = Object.fromEntries(
		availableClaimHolders.map((c) => [c.name ?? c.id, c.id])
	);

	const selectedOwnerNames = filters.ownerIds.map(
		(id) => availableOwners.find((o) => o.id === id)?.name ?? id
	);
	const selectedClaimNames = filters.claimHolderIds.map(
		(id) => availableClaimHolders.find((c) => c.id === id)?.name ?? id
	);

	return (
		<div
			className="px-4 py-3 border-b flex flex-col gap-3"
			style={{ borderColor: theme.colors.border, backgroundColor: theme.colors.bgSidebar }}
		>
			{/* Header */}
			<div className="flex items-center justify-between">
				<div
					className="flex items-center gap-1.5 text-xs font-bold"
					style={{ color: theme.colors.textMain }}
				>
					<Filter className="w-3.5 h-3.5" />
					Filters
				</div>
				{active && (
					<button
						onClick={() => onChange({ ...EMPTY_FILTERS })}
						className="flex items-center gap-1 text-[11px] hover:opacity-80 transition-opacity"
						style={{ color: theme.colors.textDim }}
					>
						<X className="w-3 h-3" />
						Clear all
					</button>
				)}
			</div>

			{/* Filter rows */}
			<div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
				<MultiSelect<WorkItemStatus>
					label="Status"
					options={STATUS_OPTIONS}
					selected={filters.statuses}
					onChange={(v) => set('statuses', v)}
					theme={theme}
				/>
				<MultiSelect<WorkItemType>
					label="Type"
					options={TYPE_OPTIONS}
					selected={filters.types}
					onChange={(v) => set('types', v)}
					theme={theme}
				/>
				{availableTags.length > 0 && (
					<TextChips
						label="Tag"
						values={filters.tags}
						allValues={availableTags}
						onChange={(v) => set('tags', v)}
						theme={theme}
					/>
				)}
				{availableCapabilities.length > 0 && (
					<TextChips
						label="Capability"
						values={filters.capabilities}
						allValues={availableCapabilities}
						onChange={(v) => set('capabilities', v)}
						theme={theme}
					/>
				)}
				{ownerNames.length > 0 && (
					<TextChips
						label="Owner"
						values={selectedOwnerNames}
						allValues={ownerNames}
						onChange={(names) =>
							set(
								'ownerIds',
								names.map((n) => ownerNameToId[n] ?? n)
							)
						}
						theme={theme}
					/>
				)}
				{claimHolderNames.length > 0 && (
					<TextChips
						label="Claim holder"
						values={selectedClaimNames}
						allValues={claimHolderNames}
						onChange={(names) =>
							set(
								'claimHolderIds',
								names.map((n) => claimNameToId[n] ?? n)
							)
						}
						theme={theme}
					/>
				)}
				{availableProjects.length > 0 && (
					<TextChips
						label="Project"
						values={filters.projectPaths}
						allValues={availableProjects}
						onChange={(v) => set('projectPaths', v)}
						theme={theme}
					/>
				)}
			</div>
		</div>
	);
});
