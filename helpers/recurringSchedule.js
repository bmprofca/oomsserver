const VALID_SCHEDULE_TYPES = ["daily", "weekly", "monthly"];

function parseJSON(value, fallback) {
    if (value == null || value === "") return fallback;
    if (typeof value === "object") return value;
    try {
        return JSON.parse(value);
    } catch {
        return fallback;
    }
}

function getOrdinalSuffix(n) {
    const s = ["th", "st", "nd", "rd"];
    const v = n % 100;
    return s[(v - 20) % 10] || s[v] || s[0];
}

function formatScheduleDisplay(schedule_type, scheduleConfig) {
    const config = scheduleConfig || {};
    if (schedule_type === "daily") {
        if (config.days?.length && config.days.length < 7) {
            const dayNames = [
                "Sunday",
                "Monday",
                "Tuesday",
                "Wednesday",
                "Thursday",
                "Friday",
                "Saturday",
            ];
            const days = config.days.map((d) => dayNames[d === 7 ? 0 : d]);
            return `Every ${days.join(", ")} at ${config.time}`;
        }
        return `Every day at ${config.time || "—"}`;
    }
    if (schedule_type === "weekly") {
        const dayNames = [
            "Sunday",
            "Monday",
            "Tuesday",
            "Wednesday",
            "Thursday",
            "Friday",
            "Saturday",
        ];
        const day = dayNames[config.day_of_week === 7 ? 0 : config.day_of_week];
        return `Every ${day || "—"} at ${config.time || "—"}`;
    }
    if (schedule_type === "monthly") {
        if (config.day_of_month) {
            return `Every ${config.day_of_month}${getOrdinalSuffix(
                config.day_of_month
            )} of month at ${config.time || "—"}`;
        }
        if (config.week_of_month && config.day_of_week !== undefined) {
            const weekNames = ["First", "Second", "Third", "Fourth"];
            const dayNames = [
                "Sunday",
                "Monday",
                "Tuesday",
                "Wednesday",
                "Thursday",
                "Friday",
                "Saturday",
            ];
            const weekText =
                config.week_of_month === "last"
                    ? "Last"
                    : weekNames[config.week_of_month - 1];
            return `${weekText} ${
                dayNames[config.day_of_week === 7 ? 0 : config.day_of_week]
            } of month at ${config.time || "—"}`;
        }
        if (config.last_day_of_month) {
            return `Last day of month at ${config.time || "—"}`;
        }
    }
    return "";
}

function validateScheduleConfig(schedule_type, schedule_config) {
    if (!VALID_SCHEDULE_TYPES.includes(schedule_type)) {
        return "schedule_type must be daily, weekly, or monthly";
    }
    if (!schedule_config || typeof schedule_config !== "object") {
        return "schedule_config is required";
    }
    if (!schedule_config.time || !/^\d{1,2}:\d{2}$/.test(String(schedule_config.time))) {
        return `${schedule_type} schedule requires time (HH:MM)`;
    }
    if (
        schedule_type === "weekly" &&
        (schedule_config.day_of_week === undefined ||
            schedule_config.day_of_week === null ||
            schedule_config.day_of_week === "")
    ) {
        return "weekly schedule requires day_of_week";
    }
    if (schedule_type === "monthly") {
        if (
            !schedule_config.day_of_month &&
            !schedule_config.week_of_month &&
            !schedule_config.last_day_of_month
        ) {
            return "monthly schedule requires day_of_month, week_of_month, or last_day_of_month";
        }
    }
    return null;
}

function isMatchingWeekdayOfMonth(year, month, day, scheduleConfig) {
    const date = new Date(year, month, day);
    const currentDayOfWeek = date.getDay();
    const weekOfMonth = Math.ceil(day / 7);
    const isLastWeek = day > new Date(year, month + 1, 0).getDate() - 7;
    const scheduledDayOfWeek =
        Number(scheduleConfig.day_of_week) === 7
            ? 0
            : Number(scheduleConfig.day_of_week);
    const scheduledWeekOfMonth = scheduleConfig.week_of_month;

    if (scheduledDayOfWeek !== currentDayOfWeek) return false;
    if (scheduledWeekOfMonth === "last") return isLastWeek;
    return weekOfMonth === Number(scheduledWeekOfMonth);
}

/**
 * Returns true when the current local (APP TZ / Asia/Kolkata) minute matches the schedule.
 */
function shouldRunNow(schedule_type, scheduleConfig, now = new Date()) {
    const currentHour = now.getHours();
    const currentMinute = now.getMinutes();
    const currentDayOfWeek = now.getDay();
    const currentDayOfMonth = now.getDate();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();

    const scheduledTime = scheduleConfig?.time;
    if (scheduledTime) {
        const [hour, minute] = String(scheduledTime).split(":").map(Number);
        if (currentHour !== hour || currentMinute !== minute) {
            return false;
        }
    } else {
        return false;
    }

    switch (schedule_type) {
        case "daily":
            if (
                scheduleConfig.days &&
                Array.isArray(scheduleConfig.days) &&
                scheduleConfig.days.length > 0
            ) {
                const normalizedDays = scheduleConfig.days.map((d) =>
                    d === 0 || d === 7 ? 0 : Number(d)
                );
                return normalizedDays.includes(currentDayOfWeek);
            }
            return true;
        case "weekly": {
            const scheduledDay = scheduleConfig.day_of_week;
            if (scheduledDay !== undefined && scheduledDay !== null) {
                const normalizedScheduledDay =
                    scheduledDay === 7 ? 0 : Number(scheduledDay);
                return currentDayOfWeek === normalizedScheduledDay;
            }
            return false;
        }
        case "monthly":
            if (scheduleConfig.day_of_month && scheduleConfig.day_of_month > 0) {
                return currentDayOfMonth === Number(scheduleConfig.day_of_month);
            }
            if (
                scheduleConfig.week_of_month &&
                scheduleConfig.day_of_week !== undefined
            ) {
                return isMatchingWeekdayOfMonth(
                    currentYear,
                    currentMonth,
                    currentDayOfMonth,
                    scheduleConfig
                );
            }
            if (scheduleConfig.last_day_of_month) {
                const lastDay = new Date(currentYear, currentMonth + 1, 0).getDate();
                return currentDayOfMonth === lastDay;
            }
            return false;
        default:
            return false;
    }
}

function makeRunKey(now = new Date()) {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, "0");
    const d = String(now.getDate()).padStart(2, "0");
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = String(now.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${d} ${hh}:${mm}`;
}

export {
    VALID_SCHEDULE_TYPES,
    parseJSON,
    formatScheduleDisplay,
    validateScheduleConfig,
    shouldRunNow,
    makeRunKey,
};
