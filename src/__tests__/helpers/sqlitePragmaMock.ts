/**
 * A mocked better-sqlite3 `pragma` that models a healthy database file.
 *
 * `StatsDB` opens its file with `pragma('integrity_check')` and moves the file
 * aside unless the answer is exactly `[{ integrity_check: 'ok' }]`. A stub that
 * returns `[{ user_version: 0 }]` for every pragma, or `undefined` for one it
 * does not know, therefore sent every test through corruption recovery without
 * saying so, and an unexpected throw there is no longer treated as corruption.
 *
 * Wrap the mock class's `pragma` with this: every call still reaches `pragma`
 * (so call assertions and per-test `mockImplementation` overrides keep
 * working), and only an `integrity_check` the stub did not answer is answered
 * `ok`. A test that returns its own integrity rows still drives the failure path.
 */
export function withHealthyIntegrityCheck(
	pragma: (...args: never[]) => unknown
): (sql: string, ...rest: unknown[]) => unknown {
	return (sql, ...rest) => {
		const result = (pragma as (...args: unknown[]) => unknown)(sql, ...rest);
		if (sql !== 'integrity_check') return result;
		const answered =
			Array.isArray(result) &&
			result.some((row) => typeof row === 'object' && row !== null && 'integrity_check' in row);
		return answered ? result : [{ integrity_check: 'ok' }];
	};
}
