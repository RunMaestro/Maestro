import { useEffect, useRef } from 'react';
import { useSessionStore } from '../../../../../stores/sessionStore';
import { defaultAgentNameForPath } from '../../../shared/projectIdentity';

interface UseAutoAgentNameParams {
	agentName: string;
	directoryPath: string;
	directoryError: string | null;
	setAgentName: (name: string) => void;
}

/**
 * Fill the agent name from the folder once a directory is chosen.
 *
 * Step 1 asks for a name before the user has told us anything a name could be
 * made from, which is why it is optional now. By the time the path is valid we
 * know the one thing that makes a Left Bar row scannable: the folder.
 *
 * Only two states are written: a blank name, and a name this hook wrote itself
 * and that the user has not touched since (so changing the folder moves the
 * default with it). Anything the user typed is left exactly as typed.
 */
export function useAutoAgentName({
	agentName,
	directoryPath,
	directoryError,
	setAgentName,
}: UseAutoAgentNameParams): void {
	const lastAutoNameRef = useRef<string | null>(null);

	useEffect(() => {
		if (!directoryPath.trim() || directoryError) return;

		const userTypedName = agentName.trim() !== '' && agentName !== lastAutoNameRef.current;
		if (userTypedName) return;

		const takenNames = useSessionStore.getState().sessions.map((session) => session.name);
		const suggestion = defaultAgentNameForPath(directoryPath, takenNames);
		if (!suggestion || suggestion === agentName) return;

		lastAutoNameRef.current = suggestion;
		setAgentName(suggestion);
	}, [agentName, directoryError, directoryPath, setAgentName]);
}
