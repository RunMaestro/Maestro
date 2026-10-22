/**
 * Which agent a `fan_out` entry names.
 *
 * The stable id (`fan_out_ids[i]`) wins when present, so a renamed agent still
 * resolves; otherwise the entry matches an agent by exact name or id, which is
 * how YAML written before `fan_out_ids` existed names its targets. The dispatch
 * service routes with this and the readiness check reports a target it cannot
 * find, so the two cannot disagree about which agent an entry means.
 */
export function findFanOutTarget<T extends { id: string; name: string }>(
	sessions: readonly T[],
	targetName: string,
	targetId?: string
): T | undefined {
	return (
		(targetId ? sessions.find((s) => s.id === targetId) : undefined) ??
		sessions.find((s) => s.name === targetName || s.id === targetName)
	);
}
