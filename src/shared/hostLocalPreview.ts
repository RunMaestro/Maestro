/** Local preview addresses must execute on the Maestro host, not on a remote client. */
export function isHostLocalPreviewUrl(value: string): boolean {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return false;
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
	const hostname = url.hostname.toLowerCase();
	return (
		hostname === 'localhost' ||
		hostname.endsWith('.localhost') ||
		hostname === '[::1]' ||
		hostname === '0.0.0.0' ||
		/^127\.\d+\.\d+\.\d+$/.test(hostname)
	);
}
