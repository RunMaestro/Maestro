export function getFactPlainText(fact: string): string {
	return fact.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
}
