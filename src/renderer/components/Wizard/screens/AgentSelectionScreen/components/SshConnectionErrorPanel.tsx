import { AlertTriangle } from 'lucide-react';
import type { Theme } from '../../../../../types';

export function SshConnectionErrorPanel({
	theme,
	error,
}: {
	theme: Theme;
	error: string;
}): JSX.Element {
	return (
		<div className="flex flex-col items-center gap-4">
			<p className="text-sm" style={{ color: theme.colors.textDim }}>
				Select the provider that will power your agent.
			</p>
			<div
				className="flex flex-col items-center justify-center p-8 rounded-xl border-2 max-w-lg text-center"
				style={{
					backgroundColor: `${theme.colors.error}10`,
					borderColor: theme.colors.error,
				}}
			>
				<AlertTriangle className="w-12 h-12 mb-4" style={{ color: theme.colors.error }} />
				<h4 className="text-lg font-semibold mb-2" style={{ color: theme.colors.textMain }}>
					Unable to Connect
				</h4>
				<p className="text-sm mb-4" style={{ color: theme.colors.textDim }}>
					{error}
				</p>
				<p className="text-sm" style={{ color: theme.colors.textDim }}>
					Please select a different remote host or switch to Local Machine.
				</p>
			</div>
		</div>
	);
}
