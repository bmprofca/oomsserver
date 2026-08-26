/**
 * Force Indian Standard Time for the Node process.
 * Must be imported before moment / Date-dependent modules.
 * Hosting DB often runs UTC; we cannot change their global MySQL timezone.
 */
if (!process.env.TZ) {
    process.env.TZ = "Asia/Kolkata";
}

export const APP_TIMEZONE = "Asia/Kolkata";
export const MYSQL_SESSION_TIME_ZONE = "+05:30";
