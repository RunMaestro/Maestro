/**
 * SqliteEditingSwitch - the "Enable editing" unlock in the viewer's summary
 * strip.
 *
 * Read-only is the default and the unlock is the safety model: one click, no
 * dialog, and it stays obvious while it is on. The grant itself lives in the
 * viewer (SqliteViewer) and is enforced by the main process
 * (src/main/sqlite/sqlite-editing.ts); this only draws the state and the two
 * actions.
 */

import { Lock, Unlock } from 'lucide-react';

import type { Theme } from '../../types';
import { MiniBadge } from '../ui/MiniBadge';
import { Spinner } from '../ui/Spinner';

interface SqliteEditingSwitchProps {
	/** Editing is on for this tab. */
	enabled: boolean;
	/** An enable request is in flight. */
	busy: boolean;
	/** Why the last enable was refused, if it was. */
	error: string | null;
	onEnable: () => void;
	onDisable: () => void;
	theme: Theme;
}

const ENABLE_TITLE =
	'Allow changes to this database from this tab only. Other tabs on the file stay read-only, and editing turns off again when this tab closes.';

export function SqliteEditingSwitch({
	enabled,
	busy,
	error,
	onEnable,
	onDisable,
	theme,
}: SqliteEditingSwitchProps): JSX.Element {
	const buttonClass =
		'flex items-center gap-1 px-1.5 py-0.5 rounded text-xs-plus hover:bg-white/10 disabled:opacity-50';

	if (enabled) {
		return (
			<span className="flex items-center gap-2 select-none" data-testid="sqlite-editing">
				<MiniBadge
					label="editing enabled"
					color={theme.colors.warning}
					title="This tab may change the database."
					theme={theme}
				/>
				<button
					type="button"
					className={buttonClass}
					style={{ color: theme.colors.textDim }}
					onClick={onDisable}
					title="Make this tab read-only again"
					data-testid="sqlite-editing-disable"
				>
					<Lock className="w-3 h-3" />
					Lock
				</button>
			</span>
		);
	}

	return (
		<span className="flex items-center gap-2 select-none" data-testid="sqlite-editing">
			<span className="text-xs-plus" style={{ color: theme.colors.textDim }}>
				read-only
			</span>
			<button
				type="button"
				className={buttonClass}
				style={{ color: theme.colors.accentText }}
				onClick={onEnable}
				disabled={busy}
				title={ENABLE_TITLE}
				data-testid="sqlite-editing-enable"
			>
				{busy ? <Spinner size={10} decorative /> : <Unlock className="w-3 h-3" />}
				Enable editing
			</button>
			{error && (
				<span
					className="text-xs-plus select-text"
					style={{ color: theme.colors.warning }}
					data-testid="sqlite-editing-error"
				>
					{error}
				</span>
			)}
		</span>
	);
}
