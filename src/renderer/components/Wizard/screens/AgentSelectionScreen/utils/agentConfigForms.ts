export function normalizeOptionalWizardString(value: string): string | undefined {
	return value || undefined;
}

export function normalizeWizardEnvVars(
	value: Record<string, string>
): Record<string, string> | undefined {
	return Object.keys(value).length > 0 ? value : undefined;
}

export function renameEnvVarKey(
	envVars: Record<string, string>,
	oldKey: string,
	newKey: string,
	value: string
): Record<string, string> {
	const next = { ...envVars };
	delete next[oldKey];
	next[newKey] = value;
	return next;
}

export function updateEnvVarValue(
	envVars: Record<string, string>,
	key: string,
	value: string
): Record<string, string> {
	return { ...envVars, [key]: value };
}

export function removeEnvVar(envVars: Record<string, string>, key: string): Record<string, string> {
	const next = { ...envVars };
	delete next[key];
	return next;
}

export function addEnvVar(envVars: Record<string, string>): Record<string, string> {
	let newKey = 'NEW_VAR';
	let counter = 1;
	while (envVars[newKey]) {
		newKey = `NEW_VAR_${counter}`;
		counter++;
	}
	return { ...envVars, [newKey]: '' };
}
