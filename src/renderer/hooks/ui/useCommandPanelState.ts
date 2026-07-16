import { useCallback, useState } from 'react';

interface IdentifiedCommand {
	id: string;
}

export interface UseCommandPanelStateOptions<Command extends IdentifiedCommand, Metadata> {
	commands: Command[];
	metadata?: Metadata | null;
}

export interface UseCommandPanelStateReturn<
	Command extends IdentifiedCommand,
	Metadata,
	EditingCommand extends IdentifiedCommand,
> {
	commands: Command[];
	setCommands: React.Dispatch<React.SetStateAction<Command[]>>;
	metadata: Metadata | null;
	setMetadata: React.Dispatch<React.SetStateAction<Metadata | null>>;
	editingCommand: EditingCommand | null;
	setEditingCommand: React.Dispatch<React.SetStateAction<EditingCommand | null>>;
	expandedCommands: Set<string>;
	isLoading: boolean;
	setIsLoading: React.Dispatch<React.SetStateAction<boolean>>;
	toggleExpanded: (id: string) => void;
	replaceCommand: (id: string, changes: Partial<Command>) => void;
	cancelEditing: () => void;
}

/**
 * Owns UI-only state shared by command panels.
 *
 * Callers retain command loading, persistence, refresh, telemetry, and command
 * shapes; this hook only applies the local state transitions after those domain
 * actions complete.
 */
export function useCommandPanelState<
	Command extends IdentifiedCommand,
	Metadata,
	EditingCommand extends IdentifiedCommand,
>({
	commands: initialCommands,
	metadata: initialMetadata = null,
}: UseCommandPanelStateOptions<Command, Metadata>): UseCommandPanelStateReturn<
	Command,
	Metadata,
	EditingCommand
> {
	const [commands, setCommands] = useState(initialCommands);
	const [metadata, setMetadata] = useState<Metadata | null>(initialMetadata);
	const [editingCommand, setEditingCommand] = useState<EditingCommand | null>(null);
	const [expandedCommands, setExpandedCommands] = useState<Set<string>>(new Set());
	const [isLoading, setIsLoading] = useState(true);

	const toggleExpanded = useCallback((id: string) => {
		setExpandedCommands((current) => {
			const next = new Set(current);
			if (next.has(id)) {
				next.delete(id);
			} else {
				next.add(id);
			}
			return next;
		});
	}, []);

	const replaceCommand = useCallback((id: string, changes: Partial<Command>) => {
		setCommands((current) =>
			current.map((command) => (command.id === id ? { ...command, ...changes } : command))
		);
	}, []);

	const cancelEditing = useCallback(() => setEditingCommand(null), []);

	return {
		commands,
		setCommands,
		metadata,
		setMetadata,
		editingCommand,
		setEditingCommand,
		expandedCommands,
		isLoading,
		setIsLoading,
		toggleExpanded,
		replaceCommand,
		cancelEditing,
	};
}
