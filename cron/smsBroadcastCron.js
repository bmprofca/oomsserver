import { processDueBroadcasts } from "../services/smsQueueService.js";

let cronTimer = null;

function startSmsBroadcastCron(intervalMs = 15000) {
    if (cronTimer) return cronTimer;

    cronTimer = setInterval(async () => {
        try {
            await processDueBroadcasts();
        } catch (error) {
            console.error("SMS broadcast cron error:", error.message);
        }
    }, intervalMs);

    return cronTimer;
}

function stopSmsBroadcastCron() {
    if (cronTimer) {
        clearInterval(cronTimer);
        cronTimer = null;
    }
}

export {
    startSmsBroadcastCron,
    stopSmsBroadcastCron
};
