import { VARIABLE_REGEX, detectMissingVariables } from "./emailVariableParser.js";

function renderTemplate(templateText, variables = {}) {
    const safeText = templateText === null || templateText === undefined ? "" : String(templateText);
    return safeText.replace(VARIABLE_REGEX, (_, key) => {
        const value = variables?.[key];
        if (value === null || value === undefined) return "";
        return String(value);
    });
}

function renderRecipientEmail({ subject, htmlBody, textBody, variables = {} }) {
    // Render subject with variables
    const renderedSubject = renderTemplate(subject, variables);
    
    // Use the provided htmlBody from database - DON'T override it
    const renderedHtmlBody = renderTemplate(htmlBody || "", variables);
    
    // Use the provided textBody from database
    const renderedTextBody = renderTemplate(textBody || "", variables);
    
    const missingVariables = [
        ...new Set([
            ...detectMissingVariables(subject, variables),
            ...detectMissingVariables(htmlBody, variables),
            ...detectMissingVariables(textBody, variables)
        ])
    ];

    return {
        subject: renderedSubject,
        htmlBody: renderedHtmlBody,
        textBody: renderedTextBody,
        missingVariables
    };
}

export {
    renderTemplate,
    renderRecipientEmail
};