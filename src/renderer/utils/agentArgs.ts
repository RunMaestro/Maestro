/**
 * Agent argument utilities for the renderer.
 *
 * Centralizes YOLO/permission-bypass flag filtering so that all spawn
 * locations use the same set of flags when applying read-only mode.
 */

/**
 * Known YOLO/permission-bypass flags that should be filtered from base args
 * when running in read-only mode. Safety net for agents that embed these
 * flags in their base args without defining yoloModeArgs.
 */
const KNOWN_YOLO_FLAGS = new Set([
	'--dangerously-skip-permissions',
	'--dangerously-bypass-approvals-and-sandbox',
	'--skip-permissions-unsafe',
	'-y',
]);

/**
 * Filters YOLO/permission-bypass flags from agent args for read-only mode.
 * Combines agent-specific yoloModeArgs with known static flags.
 */
export function filterYoloArgs(args: string[], agent: { yoloModeArgs?: string[] }): string[] {
	const yoloFlags = new Set(KNOWN_YOLO_FLAGS);
	if (agent.yoloModeArgs) {
		for (const flag of agent.yoloModeArgs) {
			yoloFlags.add(flag);
		}
	}
	return args.filter((arg) => !yoloFlags.has(arg));
}
