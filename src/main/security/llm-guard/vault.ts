import type { LlmGuardVaultEntry, LlmGuardVaultSnapshot } from './types';

export class PiiVault {
	private readonly entries: LlmGuardVaultEntry[] = [];

	add(entry: LlmGuardVaultEntry): void {
		this.entries.push(entry);
	}

	toJSON(): LlmGuardVaultSnapshot {
		return { entries: [...this.entries] };
	}

	static deanonymize(text: string, vault?: LlmGuardVaultSnapshot): string {
		if (!vault?.entries?.length) return text;

		return vault.entries.reduce(
			(current, entry) => current.split(entry.placeholder).join(entry.original),
			text
		);
	}
}
