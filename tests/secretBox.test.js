import assert from "node:assert/strict";
import test from "node:test";
import { decryptSecret, encryptSecret } from "../helpers/secretBox.js";

test("secretBox encrypts and decrypts credentials without configured environment keys", () => {
    const appKey = process.env.APP_ENCRYPTION_KEY;
    const smtpKey = process.env.SMTP_ENCRYPTION_KEY;
    delete process.env.APP_ENCRYPTION_KEY;
    delete process.env.SMTP_ENCRYPTION_KEY;

    try {
        const encrypted = encryptSecret("calendar-refresh-token");
        assert.equal(decryptSecret(encrypted), "calendar-refresh-token");
    } finally {
        if (appKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
        else process.env.APP_ENCRYPTION_KEY = appKey;
        if (smtpKey === undefined) delete process.env.SMTP_ENCRYPTION_KEY;
        else process.env.SMTP_ENCRYPTION_KEY = smtpKey;
    }
});
