import cron from "node-cron";
import { runWeeklyOffAutoMarkForToday } from "../helpers/attendanceWeeklyOffAutoMark.js";

const ATTENDANCE_TIMEZONE = process.env.ATTENDANCE_TIMEZONE || "Asia/Kolkata";

let cronTask = null;

/**
 * Daily job: mark today as paid leave for staff on fixed salary with a weekly day-off.
 */
function startAttendanceWeeklyOffCron() {
    if (cronTask) return cronTask;

    cronTask = cron.schedule(
        "10 0 * * *",
        async () => {
            try {
                const result = await runWeeklyOffAutoMarkForToday("system");
                if (result.marked > 0) {
                    console.log(
                        `Weekly off auto-mark (${result.date}): marked ${result.marked}, skipped ${result.skipped}`
                    );
                }
            } catch (error) {
                console.error("Weekly off auto-mark cron error:", error?.message || error);
            }
        },
        { timezone: ATTENDANCE_TIMEZONE }
    );

    return cronTask;
}

function stopAttendanceWeeklyOffCron() {
    if (cronTask) {
        cronTask.stop();
        cronTask = null;
    }
}

export { startAttendanceWeeklyOffCron, stopAttendanceWeeklyOffCron };
