import { PLAYBOOKS_DIR } from '../../../../../../shared/maestro-paths';
import { captureException } from '../../../../../utils/sentry';

export interface ExistingDocsResult {
	exists: boolean;
	count: number;
}

const RECOVERABLE_DOCS_ERROR_PATTERNS = [
	/enoent/i,
	/enotdir/i,
	/eacces/i,
	/eperm/i,
	/not found/i,
	/no such file/i,
	/no such directory/i,
	/path is not a directory/i,
	/permission denied/i,
	/unreadable/i,
	/missing/i,
];

function getErrorCode(error: unknown): string | undefined {
	if (error && typeof error === 'object' && 'code' in error) {
		const code = (error as { code?: unknown }).code;
		return typeof code === 'string' ? code : undefined;
	}
	return undefined;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === 'string') return error;
	return String(error ?? '');
}

export function isRecoverableAutoRunDocsError(error: unknown): boolean {
	const code = getErrorCode(error);
	if (code && ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(code)) return true;

	const message = getErrorMessage(error);
	if (!message) return false;
	return RECOVERABLE_DOCS_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export async function checkForExistingAutoRunDocs(
	dirPath: string,
	sshRemoteId?: string
): Promise<ExistingDocsResult> {
	const autoRunPath = `${dirPath}/${PLAYBOOKS_DIR}`;
	let result: Awaited<ReturnType<typeof window.maestro.autorun.listDocs>>;

	try {
		result = await window.maestro.autorun.listDocs(autoRunPath, sshRemoteId);
	} catch (error) {
		if (isRecoverableAutoRunDocsError(error)) {
			return { exists: false, count: 0 };
		}

		captureException(error, {
			extra: {
				context: 'checkForExistingAutoRunDocs',
				dirPath,
				autoRunPath,
				sshRemoteId,
			},
		});
		throw error;
	}

	if (!result.success) {
		if (isRecoverableAutoRunDocsError(result.error)) {
			return { exists: false, count: 0 };
		}

		const error = new Error(`Auto Run docs lookup failed: ${result.error || 'unknown error'}`);
		captureException(error, {
			extra: {
				context: 'checkForExistingAutoRunDocs',
				dirPath,
				autoRunPath,
				sshRemoteId,
				listDocsError: result.error,
			},
		});
		throw error;
	}

	if (result.files && result.files.length > 0) {
		return { exists: true, count: result.files.length };
	}

	return { exists: false, count: 0 };
}
