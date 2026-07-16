/**
 * Expand only the current user's home marker without resolving the resulting path.
 *
 * `~`, `~/`, and `~\\` refer to the supplied home directory. The marker must
 * lead the input; other-user forms such as `~alice` are intentionally unsupported
 * and remain unchanged. An absent home directory also leaves the input unchanged.
 * Both separator styles are accepted and the result uses the home directory's
 * separator style so local Windows and POSIX paths remain native-looking.
 */
export function expandHomePath(filePath: string, homeDir?: string): string {
	if (!filePath || !homeDir) return filePath;
	if (filePath === '~' || filePath === '~/' || filePath === '~\\') return homeDir;
	if (!filePath.startsWith('~/') && !filePath.startsWith('~\\')) return filePath;
	const nativeSeparator = homeDir.includes('\\') ? '\\' : '/';
	const separator = homeDir.endsWith('/') || homeDir.endsWith('\\') ? '' : nativeSeparator;
	const suffix = filePath.slice(2).replace(/[\\/]/g, nativeSeparator);
	return `${homeDir}${separator}${suffix}`;
}
