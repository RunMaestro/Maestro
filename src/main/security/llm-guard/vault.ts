import type { LlmGuardVaultEntry, LlmGuardVaultSnapshot } from './types';

export class PiiVault {
	private readonly entries: LlmGuardVaultEntry[] = [];

	add(entry: LlmGuardVaultEntry): void {
		// Clone the entry to prevent external mutation
		this.entries.push({ ...entry });
	}

	toJSON(): LlmGuardVaultSnapshot {
		// Return deep copies to prevent external mutation of vault contents
		return {
			entries: this.entries.map((e) => ({ ...e })),
		};
	}

	static deanonymize(text: string, vault?: LlmGuardVaultSnapshot): string {
		if (!vault?.entries?.length) return text;

		return vault.entries.reduce(
			(current, entry) => current.split(entry.placeholder).join(entry.original),
			text
		);
	}
}
