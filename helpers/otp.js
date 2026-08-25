import { RANDOM_INTEGER } from "./function.js";

export function generateOtp(length = 6) {
    return String(RANDOM_INTEGER(length));
}
