import cron from "node-cron";
import { processDueOneChattingCampaignSchedules } from "../services/oneChattingCampaignScheduleService.js";

const TIMEZONE = process.env.ONECHATTING_CAMPAIGN_TZ || "Asia/Kolkata";

let cronTask = null;

function startOneChattingCampaignCron() {
    if (cronTask) return cronTask;

    cronTask = cron.schedule(
        "* * * * *",
        async () => {
            try {
                await processDueOneChattingCampaignSchedules();
            } catch (error) {
                console.error(
                    "OneChatting campaign cron error:",
                    error?.message || error
                );
            }
        },
        { timezone: TIMEZONE }
    );

    // Warm pass shortly after boot in case we restart on the exact minute.
    setTimeout(() => {
        processDueOneChattingCampaignSchedules().catch((error) => {
            console.error(
                "OneChatting campaign cron warm-up error:",
                error?.message || error
            );
        });
    }, 8000);

    return cronTask;
}

function stopOneChattingCampaignCron() {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
    }
}

export { startOneChattingCampaignCron, stopOneChattingCampaignCron };
