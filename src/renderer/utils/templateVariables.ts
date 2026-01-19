/**
 * Template Variables for Renderer
 *
 * Re-exports from shared module for backward compatibility.
 * The renderer's Session type is a superset of TemplateSessionInfo,
 * so it works seamlessly with the shared substituteTemplateVariables function.
 */

export {
	substituteTemplateVariables,
	TEMPLATE_VARIABLES,
	TEMPLATE_VARIABLES_GENERAL,
	type TemplateContext,
	type TemplateSessionInfo,
} from '../../shared/templateVariables';
