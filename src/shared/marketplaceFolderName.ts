/**
 * Default Auto Run folder name for an imported marketplace playbook.
 *
 * Shared by the Playbook Exchange modal and `maestro-cli marketplace import`,
 * so a CLI import lands in the same folder the modal would have proposed.
 */
export function generateDefaultFolderName(title: string): string {
	return title
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/-+/g, '-')
		.replace(/^-|-$/g, '');
}
