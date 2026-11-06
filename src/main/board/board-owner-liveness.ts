/** Native host evidence for Board owner recovery; never a wire-supplied death verdict. */
import {
	readCueEngineLock,
	isCueEngineLockOwnedByThisProcess,
	isLeftByEarlierHolderOfOurPid,
	type CueEngineLockInfo,
} from '../cue/cue-engine-lock';
import * as path from 'node:path';
import { execFileNoThrow } from '../utils/execFile';
import { createHash } from 'node:crypto';
import { isPidAlive } from '../../shared/maestro-lib/client/discovery';

export interface BoardOwnerEvidence {
	platform: NodeJS.Platform;
	hostIdentity?: string;
	current: CueEngineLockInfo | null;
	ownsCurrent(info: CueEngineLockInfo): boolean;
	isPidAlive(pid: number): boolean;
	earlierHolder(info: Pick<CueEngineLockInfo, 'pid' | 'token' | 'pidNsInode'>): boolean;
}
export function boardOwnerLiveness(
	identity: string,
	evidence: BoardOwnerEvidence = {
		platform: process.platform,
		current: readCueEngineLock(),
		ownsCurrent: isCueEngineLockOwnedByThisProcess,
		isPidAlive,
		earlierHolder: isLeftByEarlierHolderOfOurPid,
	}
): 'dead' | 'unknown' {
	let old: {
		pid?: number;
		bootTime?: number;
		token?: string;
		pidNsInode?: number;
		platform?: NodeJS.Platform;
		hostIdentity?: string;
	};
	try {
		old = JSON.parse(identity);
	} catch {
		return 'unknown';
	}
	const current = evidence.current;
	if (
		!current ||
		!evidence.ownsCurrent(current) ||
		!old ||
		!Number.isSafeInteger(old.pid) ||
		old.pid! <= 0 ||
		typeof old.token !== 'string' ||
		!old.token
	)
		return 'unknown';
	if (evidence.platform === 'linux') {
		if (!Number.isSafeInteger(old.pidNsInode) || old.pidNsInode !== current.pidNsInode)
			return 'unknown';
		if (evidence.earlierHolder({ ...old, pid: old.pid! })) return 'dead';
	} else if (evidence.platform === 'darwin' || evidence.platform === 'win32') {
		// PID probes on native macOS/Windows are host-wide. Bind the persisted
		// identity to the OS machine identity, not a hostname or a copied lock.
		if (
			old.platform !== evidence.platform ||
			!evidence.hostIdentity ||
			old.hostIdentity !== evidence.hostIdentity
		)
			return 'unknown';
	} else return 'unknown';
	// A dead PID is meaningful only in this same namespace and boot.
	if (
		typeof old.bootTime !== 'number' ||
		typeof current.bootTime !== 'number' ||
		!Number.isFinite(old.bootTime) ||
		!Number.isFinite(current.bootTime) ||
		Math.abs(old.bootTime - current.bootTime) > 60_000
	)
		return 'unknown';
	// A reused live PID remains uncertain. Our own PID under a different
	// random Cue token is the one incarnation we can disprove without probing.
	if (
		evidence.platform !== 'linux' &&
		old.pid === current.pid &&
		typeof current.token === 'string' &&
		current.token &&
		old.token !== current.token
	)
		return 'dead';
	return !evidence.isPidAlive(old.pid!) ? 'dead' : 'unknown';
}

/** Read once per desktop lifetime. Failure supplies no proof, never a guessed identity.
 * The OS-provided identifier is hashed before it reaches the Board ledger.
 * No provisioning, heartbeat takeover, or external supervisor is involved. */
export async function readBoardOwnerHostIdentity(
	platform: NodeJS.Platform = process.platform,
	read: typeof execFileNoThrow = execFileNoThrow
): Promise<string | undefined> {
	try {
		let result;
		if (platform === 'darwin') {
			result = await read('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], undefined, {
				timeout: 2000,
			});
		} else if (platform === 'win32') {
			const systemRoot = process.env.SystemRoot || 'C:\\Windows';
			if (!path.win32.isAbsolute(systemRoot)) return undefined;
			result = await read(
				path.win32.join(systemRoot, 'System32', 'reg.exe'),
				['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'],
				undefined,
				{ timeout: 2000 }
			);
		} else return undefined;
		if (result.exitCode !== 0) return undefined;
		const value =
			platform === 'darwin'
				? /"IOPlatformUUID"\s*=\s*"([0-9a-f-]{36})"/i.exec(result.stdout)?.[1]
				: /MachineGuid\s+REG_SZ\s+([0-9a-f-]{36})/i.exec(result.stdout)?.[1];
		if (
			!value ||
			!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value) ||
			/^0+$/.test(value.replaceAll('-', ''))
		)
			return undefined;
		return createHash('sha256').update(`${platform}:${value.toLowerCase()}`).digest('hex');
	} catch {
		return undefined;
	}
}
