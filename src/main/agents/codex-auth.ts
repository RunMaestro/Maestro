/**
 * Reading a Codex account's OAuth credentials off disk.
 *
 * `CODEX_HOME/auth.json` is the one place a Codex account's identity lives, and
 * more than one main-process caller now needs it: the quota sampler
 * (`codex-usage-sampler.ts`) and the reset-credit primitives
 * (`codex-reset-credits.ts`). Both need the same access token, the same
 * `ChatGPT-Account-Id` header, and the same "which of the two ways can this
 * fail" split, so the read lives here rather than being written out twice - a
 * second copy drifts first on the header (a request without
 * `ChatGPT-Account-Id` answers for the WRONG account when the login has more
 * than one workspace) and on treating a missing file the same as a present file
 * with no token, which are different problems with different remedies.
 *
 * Auth-bearing values never leave the main process: callers pass the resolved
 * headers straight to `fetchWithTimeout` and return sanitized results.
 */

import fs from 'fs/promises';
import path from 'path';

interface CodexAuthFileShape {
	tokens?: {
		access_token?: string;
		account_id?: string;
		id_token?: string;
	};
}

/**
 * Why a read failed, kept apart because the remedies differ: `missing_auth`
 * means this CODEX_HOME was never logged in, `unauthenticated` means the file
 * is there but carries no usable token (a partial or revoked login).
 */
export type CodexAuthFailureKind = 'missing_auth' | 'unauthenticated';

export interface CodexAuthSuccess {
	ok: true;
	accessToken: string;
	accountId?: string;
	/** Best-effort account email, decoded from the id_token. */
	email?: string;
}

export interface CodexAuthFailure {
	ok: false;
	kind: CodexAuthFailureKind;
	/** Ready-to-render explanation naming the remedy. */
	error: string;
	/** Present when the id_token survived even though the access token did not. */
	email?: string;
}

export type CodexAuthResult = CodexAuthSuccess | CodexAuthFailure;

/** Read and classify `CODEX_HOME/auth.json`. Never throws. */
export async function readCodexAuth(codexHomeKey: string): Promise<CodexAuthResult> {
	const authPath = path.join(codexHomeKey, 'auth.json');

	let auth: CodexAuthFileShape;
	try {
		auth = JSON.parse(await fs.readFile(authPath, 'utf8')) as CodexAuthFileShape;
	} catch (err) {
		return {
			ok: false,
			kind: 'missing_auth',
			error:
				err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT'
					? `No auth.json at ${authPath}`
					: 'Failed to read Codex auth.json',
		};
	}

	const accessToken = auth.tokens?.access_token;
	const email = extractEmailFromJwt(auth.tokens?.id_token);
	if (!accessToken) {
		return {
			ok: false,
			kind: 'unauthenticated',
			error: 'No access_token in auth.json. Run `codex login` for this CODEX_HOME.',
			email,
		};
	}

	return { ok: true, accessToken, accountId: auth.tokens?.account_id, email };
}

/**
 * Request headers for a ChatGPT backend call as this account.
 *
 * `ChatGPT-Account-Id` is omitted rather than sent empty when the login has no
 * account id: an empty header is not the same as an absent one, and the backend
 * rejects it instead of falling back to the token's default workspace.
 */
export function codexAuthHeaders(auth: CodexAuthSuccess, extra?: Record<string, string>) {
	return {
		Authorization: `Bearer ${auth.accessToken}`,
		Accept: 'application/json',
		...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {}),
		...extra,
	};
}

/**
 * Pull `email` out of the OAuth id_token.
 *
 * The quota endpoint reports the email itself, but it is only reachable when
 * the network is up and the token is still good - which is exactly when we do
 * NOT need a fallback. Decoding the JWT is what lets an unauthenticated or
 * offline account still render under a name the user recognizes instead of a
 * bare directory path. Signature is deliberately not verified: this value is
 * used as a LABEL and nothing is authorized by it.
 */
export function extractEmailFromJwt(idToken: string | undefined): string | undefined {
	if (!idToken) return undefined;
	try {
		const payload = idToken.split('.')[1];
		if (!payload) return undefined;
		const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
		const decoded = JSON.parse(Buffer.from(padded, 'base64url').toString('utf8')) as {
			email?: unknown;
		};
		return typeof decoded.email === 'string' ? decoded.email : undefined;
	} catch {
		return undefined;
	}
}
