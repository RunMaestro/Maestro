import { MAX_BUFFER_SIZE } from '../constants';

/**
 * Append to a buffer while enforcing max size limit.
 * If the buffer exceeds maxSize, keeps only the last maxSize bytes.
 */
export function appendToBuffer(
	buffer: string,
	data: string,
	maxSize: number = MAX_BUFFER_SIZE
): string {
	const combined = buffer + data;
	if (combined.length <= maxSize) {
		return combined;
	}
	return combined.slice(-maxSize);
}
