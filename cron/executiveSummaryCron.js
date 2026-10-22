import cron from "node-cron";
import { processDueExecutiveSummarySchedules } from "../services/executiveSummaryService.js";

const TIMEZONE = process.env.EXECUTIVE_SUMMARY_CRON_TZ || "Asia/Kolkata";
let cronTask = null;

export function startExecutiveSummaryCron() {
    if (cronTask) return cronTask;
    cronTask = cron.schedule(
        "* * * * *",
        async () => {
            try {
                await processDueExecutiveSummarySchedules();
            } catch (error) {
                console.error("Executive Summary cron error:", error?.message || error);
            }
        },
        { timezone: TIMEZONE }
    );
    return cronTask;
}

export function stopExecutiveSummaryCron() {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
    }
}
