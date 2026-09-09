import cron from "node-cron";
import { processDueEmailBroadcastSchedules } from "../services/emailBroadcastScheduleService.js";

const TIMEZONE = process.env.EMAIL_BROADCAST_SCHEDULE_TZ || "Asia/Kolkata";
let cronTask = null;

function startEmailBroadcastScheduleCron() {
    if (cronTask) return cronTask;
    cronTask = cron.schedule(
        "* * * * *",
        async () => {
            try {
                await processDueEmailBroadcastSchedules();
            } catch (error) {
                console.error(
                    "Email broadcast schedule cron error:",
                    error?.message || error
                );
            }
        },
        { timezone: TIMEZONE }
    );
    setTimeout(() => {
        processDueEmailBroadcastSchedules().catch((error) => {
            console.error(
                "Email broadcast schedule cron warm-up error:",
                error?.message || error
            );
        });
    }, 10000);
    return cronTask;
}

function stopEmailBroadcastScheduleCron() {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
    }
}

export { startEmailBroadcastScheduleCron, stopEmailBroadcastScheduleCron };
