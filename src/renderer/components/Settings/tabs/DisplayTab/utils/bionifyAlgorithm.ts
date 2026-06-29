export const BIONIFY_ALGORITHM_PATTERN = /^[+-](\s+\d+){4}\s+(?:0(?:\.\d+)?|1(?:\.0+)?)$/;

export function normalizeBionifyAlgorithm(value: string): string {
	return value.trim();
}

export function isValidBionifyAlgorithm(value: string): boolean {
	return BIONIFY_ALGORITHM_PATTERN.test(normalizeBionifyAlgorithm(value));
}
