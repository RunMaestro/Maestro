export function syncResultErrorMessage(
	result: { errors?: string[]; error?: string },
	fallback: string
): string {
	return result.errors?.join(', ') || result.error || fallback;
}
