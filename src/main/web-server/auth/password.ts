/**
 * Password hashing for Web Login accounts. scrypt from node:crypto - no new
 * dependency, memory-hard, and the parameters ride inside the stored string so
 * they can be raised later without invalidating existing hashes.
 *
 * Stored form: `scrypt$<N>$<r>$<p>$<salt b64>$<hash b64>`.
 */

import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

// `promisify` drops the options overload, so wrap by hand.
function scrypt(
	password: string,
	salt: Buffer,
	keyLength: number,
	options: ScryptOptions
): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		scryptCb(password, salt, keyLength, options, (err, derived) => {
			if (err) reject(err);
			else resolve(derived);
		});
	});
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 64;
const SALT_LENGTH = 16;

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(SALT_LENGTH);
	const derived = await scrypt(password, salt, KEY_LENGTH, {
		N: SCRYPT_N,
		r: SCRYPT_R,
		p: SCRYPT_P,
	});
	return [
		'scrypt',
		SCRYPT_N,
		SCRYPT_R,
		SCRYPT_P,
		salt.toString('base64'),
		derived.toString('base64'),
	].join('$');
}

/**
 * Constant-time compare against a stored hash. A malformed stored value
 * verifies false rather than throwing, so a corrupted record reads as a wrong
 * password instead of a 500.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
	const parts = stored.split('$');
	if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
	const N = Number(parts[1]);
	const r = Number(parts[2]);
	const p = Number(parts[3]);
	if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return false;
	let salt: Buffer;
	let expected: Buffer;
	try {
		salt = Buffer.from(parts[4], 'base64');
		expected = Buffer.from(parts[5], 'base64');
	} catch {
		return false;
	}
	if (salt.length === 0 || expected.length === 0) return false;
	const derived = await scrypt(password, salt, expected.length, { N, r, p });
	return derived.length === expected.length && timingSafeEqual(derived, expected);
}
