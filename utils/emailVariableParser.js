const VARIABLE_REGEX = /{{\s*([a-zA-Z0-9_]+)\s*}}/g;

function toStringSafe(value) {
    if (value === null || value === undefined) return "";
    return String(value);
}

function parseTemplateVariables(...parts) {
    const variableSet = new Set();

    for (const part of parts) {
        const content = toStringSafe(part);
        let match = VARIABLE_REGEX.exec(content);
        while (match) {
            if (match[1]) {
                variableSet.add(match[1]);
            }
            match = VARIABLE_REGEX.exec(content);
        }
        VARIABLE_REGEX.lastIndex = 0;
    }

    return Array.from(variableSet);
}

function detectMissingVariables(templateText, variables = {}) {
    const required = parseTemplateVariables(templateText);
    return required.filter((key) => !(key in (variables || {})));
}

export {
    VARIABLE_REGEX,
    parseTemplateVariables,
    detectMissingVariables
};
