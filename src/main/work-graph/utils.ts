export const LOG_CONTEXT = '[WorkGraphDB]';

export function mapMigrationRecordRow(row: MigrationRecordRowLike) {
	return {
		version: row.version,
		description: row.description,
		appliedAt: row.applied_at,
		status: row.status,
		errorMessage: row.error_message ?? undefined,
	};
}

interface MigrationRecordRowLike {
	version: number;
	description: string;
	applied_at: number;
	status: 'success' | 'failed';
	error_message: string | null;
}
