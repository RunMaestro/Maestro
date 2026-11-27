/**
 * HostAgentPicker - the agents one Federation host runs that the Left Bar does
 * not show yet, as New Agent lists them once that host is its "Runs on" choice.
 *
 * It only picks. Adding is the modal's footer, which calls `addHostedAgent()`
 * (the same call as `maestro-cli federation add`). Arrow keys move the
 * selection from the filter box; Enter or a double-click adds. A pinned
 * "New agent on <host>" row above the list goes to the create form instead.
 */

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Plus } from 'lucide-react';
import type { Theme } from '../../types';
import type { HostedAgentListing } from '../../../shared/federationCommands';
import { getAgentDisplayName } from '../../../shared/agentMetadata';
import { FilterInput } from '../ui/FilterInput';
import { useListNavigation } from '../../hooks/keyboard';

export interface HostAgentPickerProps {
	theme: Theme;
	/** The host's addable agents, in host order. */
	listings: HostedAgentListing[];
	/** The host's name, for the copy. */
	hostName: string;
	/** The `ref` of the selected agent, or null. */
	selectedRef: string | null;
	onSelectedRefChange: (ref: string | null) => void;
	/** Add the agent `ref` names (Enter, double-click). */
	onAdd: (ref: string) => void;
	/** Leave the list for the create form, to make a new agent on this host. */
	onCreateNew: () => void;
	/** The Left Bar group field, shared with the General tab. */
	groupPicker?: ReactNode;
}

/** The secondary line of a row: provider, the host's group, and the folder. */
export function hostAgentDetail(listing: HostedAgentListing): string {
	return [getAgentDisplayName(listing.toolType), listing.hostGroupName, listing.cwd]
		.filter(Boolean)
		.join(' · ');
}

export function HostAgentPicker({
	theme,
	listings,
	hostName,
	selectedRef,
	onSelectedRefChange,
	onAdd,
	onCreateNew,
	groupPicker,
}: HostAgentPickerProps) {
	const [filter, setFilter] = useState('');
	const visible = useMemo(() => {
		const query = filter.trim().toLowerCase();
		if (!query) return listings;
		return listings.filter(
			(listing) =>
				listing.name.toLowerCase().includes(query) ||
				(listing.hostGroupName ?? '').toLowerCase().includes(query) ||
				(listing.cwd ?? '').toLowerCase().includes(query)
		);
	}, [listings, filter]);

	const selectedIndex = visible.findIndex((listing) => listing.ref === selectedRef);
	const navigation = useListNavigation({
		listLength: visible.length,
		initialIndex: Math.max(selectedIndex, 0),
		onSelect: (index) => {
			const listing = visible[index];
			if (listing) onAdd(listing.ref);
		},
	});

	// The selection follows the keyboard, and lands on the first row when the
	// filter leaves the selected agent out.
	const { selectedIndex: navIndex, setSelectedIndex } = navigation;
	useEffect(() => {
		const ref = visible[navIndex]?.ref ?? visible[0]?.ref ?? null;
		if (ref !== selectedRef) onSelectedRefChange(ref);
	}, [visible, navIndex, selectedRef, onSelectedRefChange]);

	return (
		<div className="space-y-5" data-testid="host-agent-picker">
			{groupPicker}
			<div className="space-y-2">
				<FilterInput
					theme={theme}
					value={filter}
					onChange={setFilter}
					placeholder="Filter by name, group, or folder..."
					resultLabel={`${visible.length} of ${listings.length}`}
					width="100%"
					autoFocus
					onKeyDown={navigation.handleKeyDown}
				/>
				<button
					type="button"
					onClick={onCreateNew}
					className="w-full flex items-center gap-2 px-3 py-2 rounded border border-dashed text-sm text-left row-hover"
					style={{ borderColor: theme.colors.accent, color: theme.colors.accent }}
					data-testid="host-agent-create-new"
				>
					<Plus className="w-4 h-4 shrink-0" />
					New agent on {hostName}
				</button>
				<div
					className="pt-2 text-2xs font-bold uppercase tracking-wider"
					style={{ color: theme.colors.textDim }}
					title="An added agent keeps running on its host. Its name and shared settings come from there."
				>
					On {hostName}, not in your Left Bar ({listings.length})
				</div>
				<div
					className="rounded border divide-y select-none"
					style={{ borderColor: theme.colors.border }}
					role="listbox"
					aria-label={`Agents on ${hostName}`}
				>
					{visible.length === 0 ? (
						<div className="px-3 py-2 text-xs" style={{ color: theme.colors.textDim }}>
							No agent matches the filter.
						</div>
					) : (
						visible.map((listing, index) => {
							const selected = listing.ref === selectedRef;
							return (
								<div
									key={listing.ref}
									role="option"
									aria-selected={selected}
									onClick={() => setSelectedIndex(index)}
									onDoubleClick={() => onAdd(listing.ref)}
									className="px-3 py-2 cursor-pointer"
									style={{
										borderColor: theme.colors.border,
										backgroundColor: selected ? theme.colors.accentDim : undefined,
										boxShadow: selected ? `inset 3px 0 0 ${theme.colors.accent}` : undefined,
									}}
									data-testid="host-agent-row"
								>
									<div className="text-sm truncate" style={{ color: theme.colors.textMain }}>
										{listing.name}
									</div>
									<div
										className="text-2xs truncate select-text"
										style={{ color: theme.colors.textDim }}
									>
										{hostAgentDetail(listing)}
									</div>
								</div>
							);
						})
					)}
				</div>
			</div>
		</div>
	);
}
