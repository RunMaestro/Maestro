/**
 * Renderer-side preparation state. This is only a building block: it cannot
 * authorize cleanup until every target producer consults it and Main binds an
 * acknowledgement to its own reservation and renderer lifetime.
 */
export class WorktreeRetirementFreeze {
	private readonly frozen = new Map<string, { token: string; revision: number }>();
	private revision = 0;

	/** Install the freeze synchronously before inspecting any live state. */
	prepare(
		target: string,
		token: string,
		inspect: () => string | undefined
	): { ok: true; token: string; revision: number } | { ok: false; reason: string } {
		if (!target || !token) return { ok: false, reason: 'missing target or token' };
		if (this.frozen.has(target)) return { ok: false, reason: 'target already frozen' };
		const entry = { token, revision: ++this.revision };
		this.frozen.set(target, entry);
		try {
			const reason = inspect();
			if (reason) {
				if (this.frozen.get(target) === entry) this.frozen.delete(target);
				return { ok: false, reason };
			}
			// Inspection must not acknowledge a freeze cancelled or invalidated by a
			// synchronous reentrant callback.
			if (this.frozen.get(target) !== entry)
				return { ok: false, reason: 'preparation invalidated' };
			return { ok: true, token, revision: entry.revision };
		} catch (error) {
			if (this.frozen.get(target) === entry) this.frozen.delete(target);
			throw error;
		}
	}

	isFrozen(target: string): boolean {
		return this.frozen.has(target);
	}

	isCurrent(target: string, token: string, revision: number): boolean {
		const entry = this.frozen.get(target);
		return !!entry && entry.token === token && entry.revision === revision;
	}

	cancel(target: string, token: string): boolean {
		if (this.frozen.get(target)?.token !== token) return false;
		this.frozen.delete(target);
		return true;
	}
}
