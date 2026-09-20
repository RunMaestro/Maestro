/**
 * Who the agent is vs what the project is.
 *
 * The wizard used to have one string for both: the name typed into "Name your
 * agent" was also handed to the discovery prompt as `{{PROJECT_NAME}}`, so
 * naming an agent "Maestro" made the assistant open with "Hello Maestro" as if
 * that were the project, and typing the project name there put the project name
 * in the Left Bar. They are different things and are derived differently:
 *
 * - The PROJECT is the folder. Always derived from the path, never typed.
 * - The AGENT NAME is a label in the Left Bar. The user may type one; when they
 *   do not, the folder name is the best default, because that is what makes a
 *   row scannable next to nine other agents.
 */

import { getBasename } from '../../../../shared/formatters';

/** Used when the path yields no folder name at all (empty string, bare "/"). */
const FALLBACK_PROJECT_NAME = 'this project';

/** Highest suffix tried before giving up and returning the bare folder name. */
const MAX_NAME_SUFFIX = 100;

/**
 * The project's name, for prompts and copy. Always the folder, never the
 * agent's name.
 */
export function projectNameFromPath(directoryPath: string): string {
	return getBasename(directoryPath.trim()) || FALLBACK_PROJECT_NAME;
}

/**
 * A Left Bar name for an agent working in `directoryPath`, avoiding names
 * already in use - `validateNewSession` rejects a duplicate outright, and the
 * wizard fills this in for the user, so a collision here would be a dead end
 * they did not create.
 *
 * Returns '' when the path has no folder name, which the caller should treat as
 * "no default available" rather than as a name.
 */
export function defaultAgentNameForPath(
	directoryPath: string,
	takenNames: readonly string[]
): string {
	const base = getBasename(directoryPath.trim());
	if (!base) return '';

	const taken = new Set(takenNames.map((name) => name.trim().toLowerCase()));
	if (!taken.has(base.toLowerCase())) return base;

	for (let suffix = 2; suffix <= MAX_NAME_SUFFIX; suffix++) {
		const candidate = `${base} ${suffix}`;
		if (!taken.has(candidate.toLowerCase())) return candidate;
	}

	return base;
}
