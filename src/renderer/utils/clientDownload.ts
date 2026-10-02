import '../../shared/webClientConfig';

/** Explicit user-directed transfer; callers must not use this for workspace mirroring. */
export function downloadBlobToClient(blob: Blob, filename: string): void {
	const url = URL.createObjectURL(blob);
	const link = document.createElement('a');
	link.href = url;
	link.download = filename;
	document.body.appendChild(link);
	link.click();
	link.remove();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function downloadHostFile(
	filePath: string,
	filename: string,
	sshRemoteId?: string
): Promise<void> {
	const base = window.__MAESTRO_CONFIG__?.apiBase;
	if (!base) throw new Error('A connected host is required to download a host file');
	const url = new URL(`${base.replace(/\/$/, '')}/files/download`, window.location.href);
	if (url.origin !== window.location.origin)
		throw new Error('File downloads must use the connected host');
	url.searchParams.set('path', filePath);
	if (sshRemoteId) url.searchParams.set('sshRemoteId', sshRemoteId);
	const response = await fetch(url, { credentials: 'same-origin', redirect: 'error' });
	if (!response.ok) {
		const body = (await response.json().catch(() => null)) as { error?: string } | null;
		throw new Error(body?.error || `Host download failed (${response.status})`);
	}
	downloadBlobToClient(await response.blob(), filename);
}
