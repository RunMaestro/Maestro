/** Fixed content-free errors; never retain peer bytes, credentials or causes. */
export const MAIL_ERROR_MESSAGES = {
	MAIL_DENIED: 'Mail access denied.',
	MAIL_INVALID: 'Invalid mail request.',
	MAIL_STALE: 'Mail reference is no longer valid.',
	MAIL_UNAVAILABLE: 'Mail service unavailable.',
	MAIL_TIMEOUT: 'Mail request timed out.',
	MAIL_CANCELED: 'Mail request canceled.',
	MAIL_PROTOCOL: 'Unsupported or invalid mail response.',
	MAIL_LIMIT: 'Mail request exceeds a limit.',
} as const;
export type MailErrorCode = keyof typeof MAIL_ERROR_MESSAGES;
export type MailResult<T> =
	| { readonly ok: true; readonly value: T }
	| {
			readonly ok: false;
			readonly error: { readonly code: MailErrorCode; readonly message: string };
	  };

export class ImapConnectionError extends Error {
	constructor(readonly code: MailErrorCode) {
		super(MAIL_ERROR_MESSAGES[code]);
		this.name = 'ImapConnectionError';
	}
}
