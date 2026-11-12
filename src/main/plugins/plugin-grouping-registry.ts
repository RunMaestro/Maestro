export interface PluginPublishedGrouping {
	id: string;
	pluginId: string;
	localId: string;
	groups: Array<{ id: string; label: string; parentId?: string }>;
	assignments: Record<string, string>;
}

/** Process-local, presentation-only snapshots emitted by live plugin sandboxes. */
export class PluginGroupingRegistry {
	private readonly entries = new Map<string, PluginPublishedGrouping>();

	public constructor(private readonly onChanged: () => void = () => undefined) {}

	public publish(grouping: PluginPublishedGrouping): void {
		this.entries.set(`${grouping.pluginId}/${grouping.localId}`, structuredClone(grouping));
		this.onChanged();
	}

	public clear(pluginId: string, localId: string): void {
		if (this.entries.delete(`${pluginId}/${localId}`)) this.onChanged();
	}

	public removePlugin(pluginId: string): void {
		let changed = false;
		for (const [key, grouping] of this.entries) {
			if (grouping.pluginId !== pluginId) continue;
			this.entries.delete(key);
			changed = true;
		}
		if (changed) this.onChanged();
	}
	public clearAll(): void {
		if (this.entries.size === 0) return;
		this.entries.clear();
		this.onChanged();
	}

	public snapshot(): PluginPublishedGrouping[] {
		return Array.from(this.entries.values(), (grouping) => structuredClone(grouping));
	}
}

const MAX_GROUPS = 200;
const MAX_LABEL_LENGTH = 120;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const LOCAL_GROUP_ID = /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/;
const MAX_ASSIGNMENTS = 10_000;

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

export function validatePublishedGrouping(
	pluginId: string,
	localId: string,
	input: unknown
): PluginPublishedGrouping {
	if (!input || typeof input !== 'object' || Array.isArray(input))
		throw new Error('grouping payload required');
	const payload = input as Record<string, unknown>;
	if (!hasOnlyKeys(payload, ['id', 'groups', 'assignments']))
		throw new Error('invalid grouping payload');
	if (payload.id !== localId) throw new Error('grouping id must match the declared local id');
	if (!Array.isArray(payload.groups) || payload.groups.length > MAX_GROUPS)
		throw new Error('invalid groups');
	if (
		!payload.assignments ||
		typeof payload.assignments !== 'object' ||
		Array.isArray(payload.assignments)
	) {
		throw new Error('invalid assignments');
	}
	const assignmentEntries = Object.entries(payload.assignments);
	if (assignmentEntries.length > MAX_ASSIGNMENTS) throw new Error('too many assignments');
	let encodedPayload: string;
	try {
		encodedPayload = JSON.stringify(payload);
	} catch {
		throw new Error('grouping payload must be JSON serializable');
	}
	if (Buffer.byteLength(encodedPayload, 'utf8') > MAX_PAYLOAD_BYTES) {
		throw new Error('grouping payload exceeds size cap');
	}
	const groups = payload.groups.map((value) => {
		if (!value || typeof value !== 'object' || Array.isArray(value))
			throw new Error('invalid group');
		const group = value as Record<string, unknown>;
		if (
			!hasOnlyKeys(group, ['id', 'label', 'parentId']) ||
			typeof group.id !== 'string' ||
			!LOCAL_GROUP_ID.test(group.id) ||
			typeof group.label !== 'string' ||
			group.label.trim().length === 0 ||
			group.label.length > MAX_LABEL_LENGTH ||
			(group.parentId !== undefined &&
				(typeof group.parentId !== 'string' || !LOCAL_GROUP_ID.test(group.parentId)))
		) {
			throw new Error('invalid group');
		}
		return {
			id: group.id,
			label: group.label.trim(),
			...(group.parentId ? { parentId: group.parentId } : {}),
		};
	});
	const parentById = new Map(groups.map((group) => [group.id, group.parentId]));
	if (parentById.size !== groups.length) throw new Error('duplicate virtual group id');
	for (const group of groups) {
		if (group.parentId && !parentById.has(group.parentId)) throw new Error('unknown group parent');
		let depth = 0;
		let current = group.parentId;
		const seen = new Set<string>([group.id]);
		while (current) {
			if (seen.has(current)) throw new Error('virtual group hierarchy has a cycle');
			seen.add(current);
			depth += 1;
			if (depth > 1) throw new Error('virtual group depth exceeds two');
			current = parentById.get(current);
		}
	}
	const validGroups = new Set(groups.map((group) => group.id));
	const assignments: Record<string, string> = {};
	for (const [sessionId, groupId] of assignmentEntries) {
		// Preserve published ids: filtering by host sessions would let a grouping plugin
		// infer session existence from snapshot readback. Unknown ids simply render nowhere.
		if (typeof groupId === 'string' && validGroups.has(groupId)) assignments[sessionId] = groupId;
	}
	return { id: `${pluginId}/${localId}`, pluginId, localId, groups, assignments };
}
