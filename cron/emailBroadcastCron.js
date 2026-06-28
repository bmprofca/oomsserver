import { processDueBroadcasts } from "../services/emailQueueService.js";

let cronTimer = null;

function startEmailBroadcastCron(intervalMs = 15000) {
    if (cronTimer) return cronTimer;

    cronTimer = setInterval(async () => {
        try {
            await processDueBroadcasts();
        } catch (error) {
            console.error("Email broadcast cron error:", error.message);
        }
    }, intervalMs);

    return cronTimer;
}

function stopEmailBroadcastCron() {
    if (cronTimer) {
        clearInterval(cronTimer);
        cronTimer = null;
    }
}

export {
    startEmailBroadcastCron,
    stopEmailBroadcastCron
};
