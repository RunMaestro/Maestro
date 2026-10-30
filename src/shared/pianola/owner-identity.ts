/** Persisted provenance uses a closed vocabulary; legacy records keep their spelling. */
export type PianolaOwnerPrincipal = 'owner' | 'chris';

export function isPianolaOwnerPrincipal(value: unknown): value is PianolaOwnerPrincipal {
	return value === 'owner' || value === 'chris';
}

export interface PianolaOwnerIdentity {
	state: 'available' | 'confirmed' | 'restricted';
	desktopIsOwner: boolean;
	ownerWebUserId?: string;
}

/** Interpret settings without rewriting legacy bindings or inferring consent. */
export function readPianolaOwnerIdentity(raw: unknown): PianolaOwnerIdentity {
	const restricted: PianolaOwnerIdentity = { state: 'restricted', desktopIsOwner: false };
	if (raw === undefined) return { state: 'available', desktopIsOwner: true };
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return restricted;
	const identity = raw as Record<string, unknown>;
	const keys = Object.keys(identity);
	if (keys.length === 0) return { state: 'available', desktopIsOwner: true };
	const allowed = ['desktopIsOwner', 'ownerWebUserId', 'desktopOwnerIsChris', 'chrisWebUserId'];
	if (keys.some((key) => !allowed.includes(key))) return restricted;
	const has = (key: string) => Object.prototype.hasOwnProperty.call(identity, key);
	const neutral = has('desktopIsOwner') || has('ownerWebUserId');
	const legacy = has('desktopOwnerIsChris') || has('chrisWebUserId');
	if (
		(neutral &&
			legacy &&
			(has('desktopIsOwner') !== has('desktopOwnerIsChris') ||
				has('ownerWebUserId') !== has('chrisWebUserId') ||
				(has('desktopIsOwner') && identity.desktopIsOwner !== identity.desktopOwnerIsChris) ||
				(has('ownerWebUserId') && identity.ownerWebUserId !== identity.chrisWebUserId))) ||
		['desktopIsOwner', 'desktopOwnerIsChris'].some(
			(key) => has(key) && typeof identity[key] !== 'boolean'
		) ||
		['ownerWebUserId', 'chrisWebUserId'].some(
			(key) => has(key) && (typeof identity[key] !== 'string' || !(identity[key] as string).trim())
		)
	)
		return restricted;
	const desktopKey = neutral ? 'desktopIsOwner' : 'desktopOwnerIsChris';
	const webKey = neutral ? 'ownerWebUserId' : 'chrisWebUserId';
	const desktopIsOwner = has(desktopKey) && identity[desktopKey] === true;
	const ownerWebUserId = has(webKey) ? (identity[webKey] as string) : undefined;
	return {
		state: desktopIsOwner ? 'confirmed' : 'restricted',
		desktopIsOwner,
		...(ownerWebUserId !== undefined ? { ownerWebUserId } : {}),
	};
}
