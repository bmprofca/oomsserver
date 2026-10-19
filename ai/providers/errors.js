/** Provider-neutral error so the orchestrator / routes never depend on a vendor SDK's classes. */
export class ProviderError extends Error {
    /** @param {"NOT_CONFIGURED"|"INVALID_KEY"|"BILLING"|"MODEL_UNAVAILABLE"|"RATE_LIMITED"|"UNAVAILABLE"|"BAD_REQUEST"|"ABORTED"|"TIMEOUT"} code */
    constructor(code, message, cause) {
        super(message);
        this.code = code;
        if (cause) this.cause = cause;
    }
}

/** Provider messages that mean "valid key, but no credit / quota / billing set up". */
export function isBillingMessage(message) {
    return /credit balance|insufficient[_ ]balance|insufficient[_ ]quota|exceeded your current quota|billing|purchase credits|payment required/i.test(String(message || ""));
}
