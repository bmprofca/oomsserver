import cron from "node-cron";
import { processDueSmsSchedules } from "../services/smsFast2smsCampaignScheduleService.js";

const TIMEZONE = process.env.SMS_CAMPAIGN_TZ || "Asia/Kolkata";
let cronTask = null;

function startSmsCampaignCron() {
    if (cronTask) return cronTask;
    cronTask = cron.schedule(
        "* * * * *",
        async () => {
            try {
                await processDueSmsSchedules();
            } catch (error) {
                console.error("SMS campaign cron error:", error?.message || error);
            }
        },
        { timezone: TIMEZONE }
    );
    setTimeout(() => {
        processDueSmsSchedules().catch((error) => {
            console.error("SMS campaign cron warm-up error:", error?.message || error);
        });
    }, 9000);
    return cronTask;
}

function stopSmsCampaignCron() {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
    }
}

export { startSmsCampaignCron, stopSmsCampaignCron };
