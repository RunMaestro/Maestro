import { Component, type ReactNode } from 'react';
import * as Sentry from '@sentry/electron/renderer';
import { logger } from '../utils/logger';
import type { Theme } from '../types';

interface Props {
	code: string;
	theme: Theme;
	children: ReactNode;
}

interface State {
	hasError: boolean;
}

// Scoped boundary around react-syntax-highlighter. The library's deeply
// nested token tree occasionally desyncs from React's fiber state during
// rapid streaming updates, surfacing as `removeChild` NotFoundError.
// Falling back to a plain <pre> here keeps the surrounding markdown view
// alive instead of bubbling the crash to the app-level boundary.
export class SyntaxHighlightBoundary extends Component<Props, State> {
	state: State = { hasError: false };

	static getDerivedStateFromError(): State {
		return { hasError: true };
	}

	componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
		logger.warn(
			`SyntaxHighlightBoundary: falling back to <pre> after ${error.message}`,
			'SyntaxHighlightBoundary',
			{ error: error.toString(), componentStack: errorInfo.componentStack }
		);
		Sentry.captureException(error, {
			level: 'warning',
			tags: { boundary: 'syntax-highlight' },
			extra: { componentStack: errorInfo.componentStack },
		});
	}

	render() {
		if (this.state.hasError) {
			const { code, theme } = this.props;
			return (
				<pre
					translate="no"
					style={{
						margin: '0.5em 0',
						padding: '1em',
						background: theme.colors.bgSidebar,
						color: theme.colors.textMain,
						fontSize: '0.9em',
						borderRadius: '6px',
						overflowX: 'auto',
						whiteSpace: 'pre-wrap',
						wordBreak: 'break-word',
					}}
				>
					<code>{code}</code>
				</pre>
			);
		}
		return this.props.children;
	}
}
