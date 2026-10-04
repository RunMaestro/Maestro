import { useEffect, useState } from 'react';
import { useStdout } from 'ink';
import { MIN_COLUMNS, MIN_ROWS, type TerminalSize } from './layout';

/**
 * The terminal's current size, following resizes. A stream with no size (a
 * pipe, a test harness) reports the minimum so the full layout is drawn.
 */
export function useTerminalSize(): TerminalSize {
	const { stdout } = useStdout();
	const read = (): TerminalSize => ({
		columns: stdout.columns || MIN_COLUMNS,
		rows: stdout.rows || MIN_ROWS,
	});
	const [size, setSize] = useState<TerminalSize>(read);

	useEffect(() => {
		const onResize = () => setSize(read());
		stdout.on('resize', onResize);
		return () => {
			stdout.off('resize', onResize);
		};
	}, [stdout]);

	return size;
}
