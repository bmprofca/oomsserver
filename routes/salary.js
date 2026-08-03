import express from 'express';
const router = express.Router();
import pool from "../db.js";
import { auth, validateBranch, checkSubscription, requireFeature } from "../middleware/auth.js";
import { UNIQUE_RANDOM_STRING, RANDOM_STRING, USER_DATA, ID_LENGTH, TODAY_DATE } from "../helpers/function.js";
import { buildProfileImageUrl } from "../helpers/mediaUrl.js";
import { buildPayslipPdfBuffer } from "../helpers/payslipPdf.js";

router.use(checkSubscription, requireFeature('salary-management'));

// Helper function to get table columns
async function getTableColumns(tableName) {
    const [rows] = await pool.query(`SHOW COLUMNS FROM \`${tableName}\``);
    return new Set(rows.map(r => r.Field));
}

// Helper function to insert row safely (UPDATED)
async function insertRow(tableName, data) {
    const columns = await getTableColumns(tableName);
    const entries = Object.entries(data).filter(([k]) => columns.has(k));

    if (entries.length === 0) {
        throw new Error(`No valid columns to insert into ${tableName}`);
    }

    const keys = entries.map(([k]) => `\`${k}\``).join(", ");
    const placeholders = entries.map(() => "?").join(", ");
    const values = entries.map(([, v]) => v);

    const [result] = await pool.query(
        `INSERT INTO \`${tableName}\` (${keys}) VALUES (${placeholders})`,
        values
    );

    return result;
}

function parseDateOnly(value) {
    const d = new Date(value);
    d.setHours(0, 0, 0, 0);
    return d;
}

function todayDateOnly() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return today;
}

function formatLocalYmd(date) {
    const d = date instanceof Date ? date : parseDateOnly(date);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/**
 * Prefer explicit minutes; else convert hours → minutes.
 */
function resolveMinutesFromBody({ minutes, hours, fallback = null }) {
    if (minutes != null && minutes !== '') {
        const m = parseInt(minutes, 10);
        if (Number.isFinite(m) && m >= 0) return m;
    }
    if (hours != null && hours !== '') {
        const h = parseFloat(hours);
        if (Number.isFinite(h) && h >= 0) return Math.round(h * 60);
    }
    return fallback;
}

/**
 * Validate salary type + amount + flexible monthly hours + effective_from assignment rules.
 * Only one assignment can be active per staff/branch; future dates are allowed as scheduled.
 */
async function validateSalaryAssignment({
    username,
    branch_id,
    effective_from,
    salary_type,
    amount,
    monthly_working_hours,
    monthly_working_minutes,
}) {
    const type = String(salary_type || 'fixed').toLowerCase();
    if (!['fixed', 'flexible'].includes(type)) {
        return { valid: false, message: "salary_type must be 'fixed' or 'flexible'" };
    }

    const salaryAmount = parseFloat(amount);
    if (!Number.isFinite(salaryAmount) || salaryAmount <= 0) {
        return { valid: false, message: 'amount / monthly_salary must be a positive number' };
    }

    let monthlyMinutes = null;
    if (type === 'flexible') {
        monthlyMinutes = resolveMinutesFromBody({
            minutes: monthly_working_minutes,
            hours: monthly_working_hours,
            fallback: null,
        });
        if (!Number.isFinite(monthlyMinutes) || monthlyMinutes <= 0) {
            return {
                valid: false,
                message: 'monthly working time is required for flexible salary and must be greater than 0',
            };
        }
    }

    const effectiveDate = parseDateOnly(effective_from);
    const today = todayDateOnly();

    if (Number.isNaN(effectiveDate.getTime())) {
        return { valid: false, message: 'Invalid effective_from date' };
    }

    if (effectiveDate < today) {
        return {
            valid: false,
            message: 'Cannot set salary for past dates. Effective from must be today or a future date',
        };
    }

    const [sameDate] = await pool.query(
        `SELECT salary_id FROM staff_salaries
         WHERE username = ? AND branch_id = ? AND effective_from = ? AND is_deleted = '0'`,
        [username, branch_id, effective_from]
    );
    if (sameDate.length > 0) {
        return {
            valid: false,
            message: `A salary assignment already exists for effective date ${effective_from}`,
        };
    }

    // Only one active assignment at a time (DB check before insert)
    if (effectiveDate.getTime() === today.getTime()) {
        const [activeRows] = await pool.query(
            `SELECT salary_id, effective_from FROM staff_salaries
             WHERE username = ? AND branch_id = ? AND is_active = '1' AND is_deleted = '0'`,
            [username, branch_id]
        );
        // Active rows are deactivated on insert; warn only if multiple already exist
        if (activeRows.length > 1) {
            return {
                valid: false,
                message: 'Multiple active salaries found for this staff. Fix existing records before assigning a new one.',
            };
        }
    }

    return {
        valid: true,
        salary_type: type,
        amount: salaryAmount,
        monthly_working_minutes: type === 'flexible' ? monthlyMinutes : null,
        effectiveDate,
        today,
        isActiveNow: effectiveDate.getTime() <= today.getTime(),
    };
}

/**
 * Ensure at most one active assignment: activate the latest due assignment, deactivate others.
 */
async function ensureSingleActiveAssignment(username, branch_id, modifyBy = 'system') {
    const today = formatLocalYmd(todayDateOnly());

    const [due] = await pool.query(
        `SELECT salary_id FROM staff_salaries
         WHERE username = ? AND branch_id = ? AND is_deleted = '0'
           AND effective_from <= ?
           AND (effective_to IS NULL OR effective_to >= ?)
         ORDER BY effective_from DESC
         LIMIT 1`,
        [username, branch_id, today, today]
    );

    if (!due.length) {
        await pool.query(
            `UPDATE staff_salaries
             SET is_active = '0', modify_by = ?, modify_date = NOW()
             WHERE username = ? AND branch_id = ? AND is_active = '1' AND is_deleted = '0'`,
            [modifyBy, username, branch_id]
        );
        return null;
    }

    const activeId = due[0].salary_id;

    await pool.query(
        `UPDATE staff_salaries
         SET is_active = '0',
             effective_to = CASE
               WHEN salary_id <> ? AND (effective_to IS NULL OR effective_to >= ?) THEN DATE_SUB(?, INTERVAL 1 DAY)
               ELSE effective_to
             END,
             modify_by = ?,
             modify_date = NOW()
         WHERE username = ? AND branch_id = ? AND is_deleted = '0' AND is_active = '1' AND salary_id <> ?`,
        [activeId, today, today, modifyBy, username, branch_id, activeId]
    );

    await pool.query(
        `UPDATE staff_salaries
         SET is_active = '1', effective_to = NULL, modify_by = ?, modify_date = NOW()
         WHERE salary_id = ? AND is_deleted = '0'`,
        [modifyBy, activeId]
    );

    return activeId;
}

// Helper function to get staff profile
async function getStaffProfile(username, branch_id) {
    const [profile] = await pool.query(
        `SELECT 
            p.name,
            p.email,
            p.mobile,
            p.country_code,
            p.image,
            p.care_of,
            p.guardian_name,
            p.date_of_birth,
            p.gender,
            p.address_line_1,
            p.address_line_2,
            p.city,
            p.state,
            p.country,
            p.pincode,
            bm.designation,
            bm.map_id,
            bm.status as mapping_status,
            bm.is_accepted
         FROM profile p
         INNER JOIN branch_mapping bm ON p.username = bm.username
         WHERE p.username = ? AND bm.branch_id = ? AND bm.is_deleted = '0'`,
        [username, branch_id]
    );

    return profile[0] || null;
}

// Helper function to calculate attendance status with grace period and respect settings
function calculateAttendanceStatus(punchIn, punchOut, expectedHours = 8, gracePeriodMinutes = 10) {
    if (!punchIn) return { status: 'absent', extraMinutes: 0, lessMinutes: 0, totalMinutes: 0, gracePeriodApplied: 0 };
    if (!punchOut) return { status: 'pending', extraMinutes: 0, lessMinutes: 0, totalMinutes: 0, gracePeriodApplied: 0 };

    const punchInTime = new Date(punchIn);
    const punchOutTime = new Date(punchOut);
    const totalMinutes = Math.round((punchOutTime - punchInTime) / (1000 * 60));

    const expectedMinutes = expectedHours * 60;
    const diffMinutes = totalMinutes - expectedMinutes;

    let status = 'pending';
    let extraMinutes = 0;
    let lessMinutes = 0;
    let gracePeriodApplied = 0;

    // Apply grace period
    if (Math.abs(diffMinutes) <= gracePeriodMinutes) {
        status = 'present';
        gracePeriodApplied = Math.abs(diffMinutes);
    } else if (diffMinutes > gracePeriodMinutes) {
        // Overtime after grace period
        status = 'bonus';
        extraMinutes = diffMinutes - gracePeriodMinutes;
        gracePeriodApplied = gracePeriodMinutes;
    } else {
        // Less time after grace period
        const lessTime = Math.abs(diffMinutes);
        const lessTimeAfterGrace = lessTime - gracePeriodMinutes;

        if (lessTimeAfterGrace <= 240) { // 4 hours
            status = 'half_day';
            lessMinutes = lessTimeAfterGrace;
            gracePeriodApplied = gracePeriodMinutes;
        } else {
            status = 'fine';
            lessMinutes = lessTimeAfterGrace;
            gracePeriodApplied = gracePeriodMinutes;
        }
    }

    return { status, extraMinutes, lessMinutes, totalMinutes, gracePeriodApplied };
}

const ATTENDANCE_TIMEZONE = process.env.ATTENDANCE_TIMEZONE || "Asia/Kolkata";

function getAttendanceLocalDateString(date = new Date(), timeZone = ATTENDANCE_TIMEZONE) {
    return new Intl.DateTimeFormat("en-CA", { timeZone }).format(date);
}

function getAttendanceLocalDayBounds(date = new Date(), timeZone = ATTENDANCE_TIMEZONE) {
    const startDate = getAttendanceLocalDateString(date, timeZone);
    const nextDay = new Date(date.getTime() + 24 * 60 * 60 * 1000);
    const endExclusive = getAttendanceLocalDateString(nextDay, timeZone);
    return {
        start: `${startDate} 00:00:00`,
        endExclusive: `${endExclusive} 00:00:00`,
    };
}

function isMappingAccepted(value) {
    return String(value) === "1";
}

// ==================== STAFF APIs (Username in BODY) ====================

/**
 * STAFF: Today's punch status for logged-in user (header profile quick actions)
 */

router.post('/admin/set-salary', auth, validateBranch, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const admin_username = req.headers["username"];
        const branch_id = req.branch_id;
        const {
            username,
            monthly_salary,
            amount,
            salary_type = 'fixed',
            monthly_working_hours = null,
            monthly_working_minutes = null,
            effective_from,
            working_hours_start = "10:00:00",
            working_hours_end = "18:00:00",
            expected_hours = 8,
            expected_minutes = null,
            grace_period_minutes = 10,
            overtime_enabled,
            fine_enabled,
            allowed_break_minutes = 30,
        } = req.body;

        const salaryAmount = amount ?? monthly_salary;

        if (!admin_username) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        if (!username || salaryAmount == null || salaryAmount === '' || !effective_from) {
            return res.status(400).json({
                success: false,
                message: 'Username, monthly_salary (or amount), and effective_from are required'
            });
        }

        const [mapping] = await connection.query(
            `SELECT map_id FROM branch_mapping 
             WHERE username = ? AND branch_id = ? AND type = 'staff' 
             AND is_deleted = '0'`,
            [username, branch_id]
        );

        if (!mapping.length) {
            return res.status(404).json({
                success: false,
                message: 'Staff not found in this branch'
            });
        }

        const validation = await validateSalaryAssignment({
            username,
            branch_id,
            effective_from,
            salary_type,
            amount: salaryAmount,
            monthly_working_hours,
            monthly_working_minutes,
        });

        if (!validation.valid) {
            return res.status(400).json({
                success: false,
                message: validation.message
            });
        }

        const {
            salary_type: resolvedType,
            amount: resolvedAmount,
            monthly_working_minutes: resolvedMonthlyMinutes,
            isActiveNow,
        } = validation;

        const isFlexible = resolvedType === 'flexible';
        // Flexible: monthly minutes only — no OT / fine / expected daily / grace
        const isOvertimeEnabled = isFlexible
            ? false
            : (overtime_enabled === true || overtime_enabled === 'true' || overtime_enabled === 1);
        const isFineEnabled = isFlexible
            ? false
            : (fine_enabled === true || fine_enabled === 'true' || fine_enabled === 1);
        const expectedMins = isFlexible
            ? null
            : resolveMinutesFromBody({
                minutes: expected_minutes,
                hours: expected_hours,
                fallback: 8 * 60,
            });
        const storeGraceMinutes = isFlexible
            ? null
            : (parseInt(grace_period_minutes, 10) || 10);
        const storeBreakMinutes = resolveMinutesFromBody({
            minutes: allowed_break_minutes,
            hours: null,
            fallback: 30,
        });

        await connection.beginTransaction();

        if (isActiveNow) {
            const [activeCount] = await connection.query(
                `SELECT COUNT(*) AS cnt FROM staff_salaries
                 WHERE username = ? AND branch_id = ? AND is_active = '1' AND is_deleted = '0'`,
                [username, branch_id]
            );
            if (Number(activeCount[0]?.cnt || 0) > 1) {
                await connection.rollback();
                return res.status(400).json({
                    success: false,
                    message: 'Only one salary can be active at a time. Multiple active records found — resolve them first.'
                });
            }

            await connection.query(
                `UPDATE staff_salaries
                 SET is_active = '0',
                     effective_to = DATE_SUB(?, INTERVAL 1 DAY),
                     modify_by = ?,
                     modify_date = NOW()
                 WHERE username = ? AND branch_id = ?
                   AND is_active = '1' AND is_deleted = '0'`,
                [effective_from, admin_username, username, branch_id]
            );
        }

        const salary_id = await UNIQUE_RANDOM_STRING("staff_salaries", "salary_id", {
            prefix: "SAL",
            length: ID_LENGTH,
        });

        await connection.query(
            `INSERT INTO staff_salaries (
                salary_id, map_id, username, branch_id,
                salary_type, amount, monthly_working_minutes,
                effective_from, effective_to, is_active,
                working_hours_start, working_hours_end, expected_minutes, grace_period_minutes,
                overtime_enabled, fine_enabled, allowed_break_minutes,
                create_by, modify_by, is_deleted
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0')`,
            [
                salary_id,
                mapping[0].map_id,
                username,
                branch_id,
                resolvedType,
                resolvedAmount,
                resolvedMonthlyMinutes,
                effective_from,
                isActiveNow ? '1' : '0',
                working_hours_start,
                working_hours_end,
                expectedMins,
                storeGraceMinutes,
                isOvertimeEnabled ? 1 : 0,
                isFineEnabled ? 1 : 0,
                storeBreakMinutes,
                admin_username,
                admin_username,
            ]
        );

        await connection.commit();

        const profile = await getStaffProfile(username, branch_id);
        const expectedHrs = expectedMins != null ? expectedMins / 60 : 8;
        const monthlyHours = resolvedMonthlyMinutes != null ? resolvedMonthlyMinutes / 60 : null;
        const perDaySalary = resolvedAmount / 30;
        const perMinuteSalary = perDaySalary / (expectedHrs * 60);
        const hourlyRate = isFlexible && monthlyHours
            ? resolvedAmount / monthlyHours
            : perDaySalary / expectedHrs;

        return res.status(200).json({
            success: true,
            message: isActiveNow ? 'Salary assigned successfully' : 'Salary scheduled for future date',
            data: {
                salary_id,
                assignment_id: salary_id,
                username,
                salary_type: resolvedType,
                monthly_salary: resolvedAmount,
                amount: resolvedAmount,
                monthly_working_minutes: resolvedMonthlyMinutes,
                monthly_working_hours: monthlyHours,
                effective_from,
                is_active: isActiveNow,
                status: isActiveNow ? 'active' : 'scheduled',
                working_hours: {
                    start: working_hours_start,
                    end: working_hours_end,
                    expected_hours: isFlexible ? null : expectedHrs,
                    expected_minutes: isFlexible ? null : expectedMins,
                    grace_period_minutes: isFlexible ? null : storeGraceMinutes,
                    monthly_working_hours: monthlyHours,
                    monthly_working_minutes: resolvedMonthlyMinutes,
                },
                overtime_settings: {
                    enabled: isOvertimeEnabled,
                },
                fine_settings: {
                    enabled: isFineEnabled,
                },
                break_settings: {
                    allowed_break_minutes: storeBreakMinutes,
                },
                calculation_rates: {
                    per_day: perDaySalary.toFixed(2),
                    per_hour: hourlyRate.toFixed(2),
                    per_minute: perMinuteSalary.toFixed(4)
                },
                profile: profile ? {
                    name: profile.name,
                    email: profile.email,
                    mobile: profile.mobile,
                    designation: profile.designation,
                    image: buildProfileImageUrl(profile.image)
                } : null
            }
        });
    } catch (error) {
        try {
            await connection.rollback();
        } catch (_) { /* ignore */ }
        console.error('Set salary error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to set salary',
            error: error.message
        });
    } finally {
        connection.release();
    }
});

/**
 * ADMIN: Update an existing salary assignment (active or scheduled)
 * Body: assignment_id, salary_type, monthly_salary/amount, monthly_working_hours,
 *       effective_from (scheduled only / or today+), attendance settings
 */
router.post('/admin/update-salary', auth, validateBranch, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const admin_username = req.headers["username"];
        const branch_id = req.branch_id;
        const {
            assignment_id,
            username,
            monthly_salary,
            amount,
            salary_type = 'fixed',
            monthly_working_hours = null,
            monthly_working_minutes = null,
            effective_from,
            working_hours_start = "10:00:00",
            working_hours_end = "18:00:00",
            expected_hours = 8,
            expected_minutes = null,
            grace_period_minutes = 10,
            overtime_enabled,
            fine_enabled,
            allowed_break_minutes = 30,
        } = req.body;

        if (!admin_username) {
            return res.status(400).json({ success: false, message: "Missing required header: username" });
        }
        const rowId = assignment_id || req.body.salary_id;
        if (!rowId) {
            return res.status(400).json({ success: false, message: "assignment_id or salary_id is required" });
        }

        const salaryAmount = amount ?? monthly_salary;
        const type = String(salary_type || 'fixed').toLowerCase();
        if (!['fixed', 'flexible'].includes(type)) {
            return res.status(400).json({ success: false, message: "salary_type must be 'fixed' or 'flexible'" });
        }
        const resolvedAmount = parseFloat(salaryAmount);
        if (!Number.isFinite(resolvedAmount) || resolvedAmount <= 0) {
            return res.status(400).json({ success: false, message: 'monthly_salary / amount must be a positive number' });
        }

        let resolvedMonthlyMinutes = null;
        if (type === 'flexible') {
            resolvedMonthlyMinutes = resolveMinutesFromBody({
                minutes: monthly_working_minutes,
                hours: monthly_working_hours,
                fallback: null,
            });
            if (!Number.isFinite(resolvedMonthlyMinutes) || resolvedMonthlyMinutes <= 0) {
                return res.status(400).json({
                    success: false,
                    message: 'monthly working time is required for flexible salary and must be greater than 0',
                });
            }
        }

        const [rows] = await connection.query(
            `SELECT * FROM staff_salaries
             WHERE salary_id = ? AND branch_id = ? AND is_deleted = '0'
             LIMIT 1`,
            [rowId, branch_id]
        );

        if (!rows.length) {
            return res.status(404).json({ success: false, message: 'Salary assignment not found' });
        }

        const existing = rows[0];
        if (username && existing.username !== username) {
            return res.status(400).json({ success: false, message: 'Username does not match this assignment' });
        }

        const today = todayDateOnly();
        const currentEffective = parseDateOnly(existing.effective_from);
        const isExpired = existing.effective_to && parseDateOnly(existing.effective_to) < today;

        if (isExpired) {
            return res.status(400).json({ success: false, message: 'Expired salary assignments cannot be edited' });
        }

        let nextEffectiveFrom = formatLocalYmd(parseDateOnly(existing.effective_from));
        if (effective_from) {
            const nextDate = parseDateOnly(effective_from);
            if (Number.isNaN(nextDate.getTime())) {
                return res.status(400).json({ success: false, message: 'Invalid effective_from date' });
            }
            const currentYmd = formatLocalYmd(currentEffective);
            const nextYmd = formatLocalYmd(nextDate);
            // Allow keeping the existing effective date even if it is in the past (active rows).
            // New dates must be today or future.
            if (nextYmd !== currentYmd && nextDate < today) {
                return res.status(400).json({
                    success: false,
                    message: 'Cannot set salary for past dates. Effective from must be today or a future date',
                });
            }
            if (nextYmd !== currentYmd) {
                const [dup] = await connection.query(
                    `SELECT salary_id FROM staff_salaries
                     WHERE username = ? AND branch_id = ? AND effective_from = ?
                       AND is_deleted = '0' AND salary_id <> ?`,
                    [existing.username, branch_id, nextYmd, rowId]
                );
                if (dup.length) {
                    return res.status(400).json({
                        success: false,
                        message: `A salary assignment already exists for effective date ${nextYmd}`,
                    });
                }
            }
            nextEffectiveFrom = nextYmd;
        }

        const nextEffectiveDate = parseDateOnly(nextEffectiveFrom);
        const shouldBeActive = nextEffectiveDate.getTime() <= today.getTime();
        const isFlexible = type === 'flexible';
        const isOvertimeEnabled = isFlexible
            ? false
            : (overtime_enabled === true || overtime_enabled === 'true' || overtime_enabled === 1);
        const isFineEnabled = isFlexible
            ? false
            : (fine_enabled === true || fine_enabled === 'true' || fine_enabled === 1);
        const expectedMins = isFlexible
            ? null
            : resolveMinutesFromBody({
                minutes: expected_minutes,
                hours: expected_hours,
                fallback: 8 * 60,
            });
        const storeGraceMinutes = isFlexible ? null : (parseInt(grace_period_minutes, 10) || 10);
        const storeBreakMinutes = resolveMinutesFromBody({
            minutes: allowed_break_minutes,
            hours: null,
            fallback: 30,
        });

        await connection.beginTransaction();

        if (shouldBeActive) {
            await connection.query(
                `UPDATE staff_salaries
                 SET is_active = '0',
                     effective_to = CASE
                       WHEN salary_id <> ? AND (effective_to IS NULL OR effective_to >= ?)
                         THEN DATE_SUB(?, INTERVAL 1 DAY)
                       ELSE effective_to
                     END,
                     modify_by = ?,
                     modify_date = NOW()
                 WHERE username = ? AND branch_id = ?
                   AND is_active = '1' AND is_deleted = '0' AND salary_id <> ?`,
                [
                    rowId,
                    nextEffectiveFrom,
                    nextEffectiveFrom,
                    admin_username,
                    existing.username,
                    branch_id,
                    rowId,
                ]
            );
        }

        await connection.query(
            `UPDATE staff_salaries
             SET salary_type = ?,
                 amount = ?,
                 monthly_working_minutes = ?,
                 effective_from = ?,
                 effective_to = CASE WHEN ? = '1' THEN NULL ELSE effective_to END,
                 is_active = ?,
                 working_hours_start = ?,
                 working_hours_end = ?,
                 expected_minutes = ?,
                 grace_period_minutes = ?,
                 overtime_enabled = ?,
                 fine_enabled = ?,
                 allowed_break_minutes = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE salary_id = ? AND is_deleted = '0'`,
            [
                type,
                resolvedAmount,
                resolvedMonthlyMinutes,
                nextEffectiveFrom,
                shouldBeActive ? '1' : '0',
                shouldBeActive ? '1' : '0',
                working_hours_start,
                working_hours_end,
                expectedMins,
                storeGraceMinutes,
                isOvertimeEnabled ? 1 : 0,
                isFineEnabled ? 1 : 0,
                storeBreakMinutes,
                admin_username,
                rowId,
            ]
        );

        await connection.commit();
        await ensureSingleActiveAssignment(existing.username, branch_id, admin_username);

        return res.status(200).json({
            success: true,
            message: 'Salary assignment updated successfully',
            data: {
                assignment_id: rowId,
                salary_id: rowId,
                username: existing.username,
                salary_type: type,
                monthly_salary: resolvedAmount,
                monthly_working_minutes: resolvedMonthlyMinutes,
                monthly_working_hours: resolvedMonthlyMinutes != null
                    ? resolvedMonthlyMinutes / 60
                    : null,
                effective_from: nextEffectiveFrom,
                is_active: shouldBeActive,
                status: shouldBeActive ? 'active' : 'scheduled',
            },
        });
    } catch (error) {
        try {
            await connection.rollback();
        } catch (_) { /* ignore */ }
        console.error('Update salary error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to update salary',
            error: error.message,
        });
    } finally {
        connection.release();
    }
});

/**
 * ADMIN: Get Daily Attendance
 * Headers: 
 *   - Authorization: Bearer {token}
 *   - username: {admin_username}
 * Query: date, staff_username (optional)
 */

router.get('/admin/salary-history', auth, validateBranch, async (req, res) => {
    try {
        const admin_username = req.headers["username"];
        const branch_id = req.branch_id;
        const { username } = req.query;

        if (!admin_username) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        if (!username) {
            return res.status(400).json({
                success: false,
                message: 'Username is required'
            });
        }

        // Activate any due scheduled assignment and keep a single active row
        await ensureSingleActiveAssignment(username, branch_id, admin_username);

        const [salary] = await pool.query(
            `SELECT 
                ss.id,
                ss.salary_id,
                ss.salary_id AS assignment_id,
                ss.map_id,
                ss.username,
                ss.branch_id,
                ss.salary_type,
                ss.amount AS monthly_salary,
                ss.monthly_working_minutes,
                ss.effective_from,
                ss.effective_to,
                ss.is_active,
                ss.create_by,
                ss.modify_by,
                ss.create_date,
                ss.modify_date,
                ss.working_hours_start,
                ss.working_hours_end,
                ss.expected_minutes,
                ss.grace_period_minutes,
                ss.overtime_enabled,
                ss.fine_enabled,
                ss.allowed_break_minutes,
                p.name as staff_name,
                p.email,
                p.mobile,
                p.image,
                bm.designation
             FROM staff_salaries ss
             INNER JOIN branch_mapping bm ON ss.map_id = bm.map_id
             INNER JOIN profile p ON ss.username = p.username
             WHERE ss.username = ? AND ss.branch_id = ? AND ss.is_deleted = '0'
             ORDER BY ss.effective_from DESC`,
            [username, branch_id]
        );

        const profile = await getStaffProfile(username, branch_id);
        const today = todayDateOnly();

        let activeSalary = null;
        const scheduledSalaries = [];
        const expiredSalaries = [];

        for (const s of salary) {
            const effectiveDate = parseDateOnly(s.effective_from);
            const isExpired = s.effective_to && parseDateOnly(s.effective_to) < today;
            const isFuture = effectiveDate > today;
            const isActiveInDb = s.is_active === '1' || s.is_active === 1;
            const isCurrentlyActive = effectiveDate <= today && !isExpired && isActiveInDb;

            const monthlySalary = parseFloat(s.monthly_salary);
            const perDaySalary = monthlySalary / 30;
            const salaryType = s.salary_type || 'fixed';
            const isFlexible = salaryType === 'flexible';
            const expectedMinutes = isFlexible
                ? null
                : (parseInt(s.expected_minutes, 10) || 8 * 60);
            const expectedHours = expectedMinutes != null ? expectedMinutes / 60 : null;
            const graceMinutes = isFlexible
                ? null
                : (parseInt(s.grace_period_minutes, 10) || 10);
            const hoursForRate = expectedHours || 8;
            const perMinuteSalary = perDaySalary / (hoursForRate * 60);
            const monthlyWorkingMinutes = s.monthly_working_minutes != null
                ? parseInt(s.monthly_working_minutes, 10)
                : null;
            const monthlyWorkingHours = monthlyWorkingMinutes != null
                ? monthlyWorkingMinutes / 60
                : null;

            const overtimeEnabled = isFlexible
                ? false
                : (s.overtime_enabled === '1' || s.overtime_enabled === 1 || s.overtime_enabled === true);
            const fineEnabled = isFlexible
                ? false
                : (s.fine_enabled === '1' || s.fine_enabled === 1 || s.fine_enabled === true);

            const salaryData = {
                id: s.id,
                assignment_id: s.assignment_id,
                salary_id: s.salary_id,
                username: s.username,
                salary_type: salaryType,
                monthly_salary: monthlySalary,
                amount: monthlySalary,
                monthly_working_hours: monthlyWorkingHours,
                monthly_working_minutes: monthlyWorkingMinutes,
                effective_from: s.effective_from,
                effective_to: s.effective_to,
                status: isCurrentlyActive ? 'active' : (isFuture ? 'scheduled' : 'expired'),

                working_hours: {
                    start: s.working_hours_start || '09:00:00',
                    end: s.working_hours_end || '18:00:00',
                    expected_hours: expectedHours,
                    expected_minutes: expectedMinutes,
                    grace_period_minutes: graceMinutes,
                    monthly_working_hours: monthlyWorkingHours,
                    monthly_working_minutes: monthlyWorkingMinutes,
                },

                overtime_settings: {
                    enabled: overtimeEnabled,
                },

                fine_settings: {
                    enabled: fineEnabled,
                },

                break_settings: {
                    allowed_break_minutes: parseInt(s.allowed_break_minutes, 10) || 30,
                },

                calculation_rates: {
                    per_day: perDaySalary.toFixed(2),
                    per_hour: (isFlexible && monthlyWorkingHours
                        ? (monthlySalary / monthlyWorkingHours)
                        : (perDaySalary / hoursForRate)).toFixed(2),
                    per_minute: perMinuteSalary.toFixed(4)
                },

                staff_name: s.staff_name,
                designation: s.designation
            };

            if (isCurrentlyActive) {
                activeSalary = salaryData;
            } else if (isFuture && !isExpired) {
                scheduledSalaries.push(salaryData);
            } else {
                expiredSalaries.push(salaryData);
            }
        }

        return res.status(200).json({
            success: true,
            message: 'Salary history retrieved successfully',
            data: {
                username,
                profile: profile ? {
                    name: profile.name,
                    email: profile.email,
                    mobile: profile.mobile,
                    image: buildProfileImageUrl(profile.image),
                    designation: profile.designation
                } : null,
                current: activeSalary,
                scheduled: scheduledSalaries,
                history: expiredSalaries,
                summary: {
                    has_active: !!activeSalary,
                    scheduled_count: scheduledSalaries.length,
                    history_count: expiredSalaries.length
                }
            }
        });

    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch salary history',
            error: error.message
        });
    }
});
/**
 * ADMIN: Get Monthly Attendance Report
 * Headers: 
 *   - Authorization: Bearer {token}
 *   - username: {admin_username}
 * Query: month, year, status (optional filter), department (optional filter), page, limit
 * 
 * This API provides a complete monthly attendance report with:
 * - Daily attendance matrix for all staff
 * - Summary statistics
 * - Filtering by status and department
 * - Pagination support
 */
/**
 * ADMIN: Get Monthly Attendance Report
 * Headers: 
 *   - Authorization: Bearer {token}
 *   - username: {admin_username}
 * Query: month, year, status (optional filter), department (optional filter), page, limit
 * 
 * This API provides a complete monthly attendance report with:
 * - Daily attendance matrix for all staff
 * - Summary statistics
 * - Filtering by status and department
 * - Pagination support
 */

const WEEKLY_OFF_DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

/**
 * Replace staff paid day-off weekdays with the given list (multi-select).
 */
async function syncEmployeeWeeklyOffDays({
    username,
    branch_id,
    map_id,
    days,
    admin_username,
    connection = pool,
}) {
    const selected = [...new Set((Array.isArray(days) ? days : []).filter((d) => WEEKLY_OFF_DAYS.includes(d)))];

    if (selected.length === 0) {
        await connection.query(
            `UPDATE employee_weekly_off
             SET is_deleted = '1',
                 deleted_by = ?,
                 modified_by = ?,
                 modified_date = NOW()
             WHERE username = ? AND branch_id = ? AND is_deleted = '0'`,
            [admin_username, admin_username, username, branch_id]
        );
        return selected;
    }

    const placeholders = selected.map(() => '?').join(', ');
    await connection.query(
        `UPDATE employee_weekly_off
         SET is_deleted = '1',
             deleted_by = ?,
             modified_by = ?,
             modified_date = NOW()
         WHERE username = ? AND branch_id = ? AND is_deleted = '0'
           AND weekly_off_day NOT IN (${placeholders})`,
        [admin_username, admin_username, username, branch_id, ...selected]
    );

    for (const day of selected) {
        const [active] = await connection.query(
            `SELECT id FROM employee_weekly_off
             WHERE username = ? AND branch_id = ? AND weekly_off_day = ?
               AND is_deleted = '0'
             LIMIT 1`,
            [username, branch_id, day]
        );
        if (active.length) {
            await connection.query(
                `UPDATE employee_weekly_off
                 SET is_active = '1',
                     modified_by = ?,
                     modified_date = NOW()
                 WHERE id = ?`,
                [admin_username, active[0].id]
            );
            continue;
        }

        const [soft] = await connection.query(
            `SELECT id FROM employee_weekly_off
             WHERE username = ? AND branch_id = ? AND weekly_off_day = ?
               AND is_deleted = '1'
             ORDER BY id DESC
             LIMIT 1`,
            [username, branch_id, day]
        );
        if (soft.length) {
            await connection.query(
                `UPDATE employee_weekly_off
                 SET is_deleted = '0',
                     deleted_by = NULL,
                     is_active = '1',
                     modified_by = ?,
                     modified_date = NOW()
                 WHERE id = ?`,
                [admin_username, soft[0].id]
            );
            continue;
        }

        const weekly_off_id = await UNIQUE_RANDOM_STRING("employee_weekly_off", "weekly_off_id", {
            prefix: "WOF",
            length: ID_LENGTH,
            conn: connection === pool ? null : connection,
        });

        await connection.query(
            `INSERT INTO employee_weekly_off (
                weekly_off_id, map_id, username, branch_id, weekly_off_day,
                is_active, created_by, modified_by, is_deleted
            ) VALUES (?, ?, ?, ?, ?, '1', ?, ?, '0')`,
            [weekly_off_id, map_id, username, branch_id, day, admin_username, admin_username]
        );
    }

    return selected;
}

router.post('/admin/set-weekly-off', auth, validateBranch, async (req, res) => {
    try {
        const admin_username = req.headers["username"];
        const branch_id = req.branch_id;
        const { username, days, weekly_off_day, is_active } = req.body;

        if (!admin_username) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        if (!username) {
            return res.status(400).json({
                success: false,
                message: 'Username is required'
            });
        }

        const [mapping] = await pool.query(
            `SELECT map_id FROM branch_mapping 
             WHERE username = ? AND branch_id = ? AND type = 'staff' 
             AND is_accepted = '1' AND is_deleted = '0'`,
            [username, branch_id]
        );

        if (!mapping.length) {
            return res.status(404).json({
                success: false,
                message: 'Staff not found in this branch'
            });
        }

        let selectedDays;
        if (Array.isArray(days)) {
            const invalid = days.filter((d) => !WEEKLY_OFF_DAYS.includes(d));
            if (invalid.length) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid day(s): ${invalid.join(', ')}. Valid: ${WEEKLY_OFF_DAYS.join(', ')}`,
                });
            }
            selectedDays = await syncEmployeeWeeklyOffDays({
                username,
                branch_id,
                map_id: mapping[0].map_id,
                days,
                admin_username,
            });
        } else {
            // Legacy single-day toggle
            if (!weekly_off_day || !WEEKLY_OFF_DAYS.includes(weekly_off_day)) {
                return res.status(400).json({
                    success: false,
                    message: `Invalid day. Valid days are: ${WEEKLY_OFF_DAYS.join(', ')}`,
                });
            }

            const [current] = await pool.query(
                `SELECT weekly_off_day FROM employee_weekly_off
                 WHERE username = ? AND branch_id = ? AND is_deleted = '0' AND is_active = '1'`,
                [username, branch_id]
            );
            let next = current.map((r) => r.weekly_off_day);
            const turnOn = is_active === true || is_active === '1' || is_active === 1 || is_active === undefined;
            if (turnOn) {
                if (!next.includes(weekly_off_day)) next.push(weekly_off_day);
            } else {
                next = next.filter((d) => d !== weekly_off_day);
            }
            selectedDays = await syncEmployeeWeeklyOffDays({
                username,
                branch_id,
                map_id: mapping[0].map_id,
                days: next,
                admin_username,
            });
        }

        const profile = await getStaffProfile(username, branch_id);

        return res.status(200).json({
            success: true,
            message: selectedDays.length
                ? `Day off set: ${selectedDays.join(', ')}`
                : 'All day offs cleared',
            data: {
                username,
                profile: profile ? {
                    name: profile.name,
                    email: profile.email,
                    mobile: profile.mobile,
                    designation: profile.designation,
                    image: buildProfileImageUrl(profile.image)
                } : null,
                days: selectedDays,
                weekly_off_days: selectedDays,
                weekly_off_day: selectedDays[0] || null,
                is_active: selectedDays.length ? '1' : '0',
            }
        });

    } catch (error) {
        console.error('Error setting weekly off:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to set weekly off day',
            error: error.message
        });
    }
});

/**
 * ADMIN: Get Employee Weekly Off
 * Headers: 
 *   - Authorization: Bearer {token}
 *   - username: {admin_username}
 * Query: username (staff username)
 */

router.get('/admin/get-weekly-off', auth, validateBranch, async (req, res) => {
    try {
        const admin_username = req.headers["username"];
        const branch_id = req.branch_id;
        const { username } = req.query;

        if (!admin_username) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        if (!username) {
            return res.status(400).json({
                success: false,
                message: 'Username is required'
            });
        }

        const [weeklyOff] = await pool.query(
            `SELECT weekly_off_day, is_active FROM employee_weekly_off 
             WHERE username = ? AND branch_id = ? AND is_deleted = '0'
             ORDER BY FIELD(weekly_off_day, 'Monday','Tuesday','Wednesday','Thursday','Friday','Saturday','Sunday')`,
            [username, branch_id]
        );

        const profile = await getStaffProfile(username, branch_id);
        const activeDays = weeklyOff
            .filter((r) => r.is_active === '1' || r.is_active === 1)
            .map((r) => r.weekly_off_day);

        return res.status(200).json({
            success: true,
            message: 'Weekly off retrieved successfully',
            data: {
                username,
                profile: profile ? {
                    name: profile.name,
                    email: profile.email,
                    mobile: profile.mobile,
                    designation: profile.designation,
                    image: buildProfileImageUrl(profile.image)
                } : null,
                days: activeDays,
                weekly_off_days: activeDays,
                weekly_off: activeDays.length > 0 ? {
                    weekly_off_day: activeDays[0],
                    weekly_off_days: activeDays,
                    is_active: true
                } : null
            }
        });

    } catch (error) {
        console.error('Error fetching weekly off:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch weekly off',
            error: error.message
        });
    }
});

//Employee login History 
/**
 * ADMIN: Get Specific Employee Login History by Date
 * Headers: 
 *   - Authorization: Bearer {token}
 *   - username: {admin_username}
 * Params: username (in URL)
 * Query: date (YYYY-MM-DD) - Required
 */

router.get('/admin/salary-calculation/:username', auth, validateBranch, async (req, res) => {
    try {
        const loggedInUser = req.headers["username"];
        const branch_id = req.branch_id;
        const staff_username = req.params.username;

        const { month, year } = req.query;
        const targetMonth = month ? parseInt(month) : new Date().getMonth() + 1;
        const targetYear = year ? parseInt(year) : new Date().getFullYear();

        if (!loggedInUser) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        if (!staff_username) {
            return res.status(400).json({
                success: false,
                message: "Staff username is required in URL params"
            });
        }

        const isAdmin = await checkIfAdmin(loggedInUser, branch_id);
        const isSelf = loggedInUser === staff_username;

        if (!isAdmin && !isSelf) {
            return res.status(403).json({
                success: false,
                message: "Access denied. You can only view your own salary information"
            });
        }

        if (targetMonth < 1 || targetMonth > 12) {
            return res.status(400).json({
                success: false,
                message: 'Invalid month. Month must be between 1 and 12'
            });
        }

        const startDate = `${targetYear}-${targetMonth.toString().padStart(2, '0')}-01`;
        const endDate = new Date(targetYear, targetMonth, 0).toISOString().split('T')[0];
        const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();

        const profile = await getStaffProfile(staff_username, branch_id);

        if (!profile) {
            return res.status(404).json({
                success: false,
                message: 'Staff not found in this branch'
            });
        }

        await ensureSingleActiveAssignment(staff_username, branch_id, loggedInUser);

        const [salaryData] = await pool.query(
            `SELECT amount AS monthly_salary, salary_type, monthly_working_minutes,
                    effective_from, salary_id, salary_id AS assignment_id
             FROM staff_salaries
             WHERE username = ? AND branch_id = ?
               AND is_active = '1' AND is_deleted = '0'
               AND effective_from <= ?
             ORDER BY effective_from DESC LIMIT 1`,
            [staff_username, branch_id, endDate]
        );

        const monthlySalary = salaryData.length > 0 ? parseFloat(salaryData[0].monthly_salary) : 0;
        const salaryType = salaryData.length > 0 ? (salaryData[0].salary_type || 'fixed') : 'fixed';
        const isFlexibleSalary = salaryType === 'flexible';
        const monthlyWorkingMinutes = salaryData.length > 0 && salaryData[0].monthly_working_minutes != null
            ? parseInt(salaryData[0].monthly_working_minutes, 10)
            : null;
        const monthlyWorkingHours = monthlyWorkingMinutes != null ? monthlyWorkingMinutes / 60 : null;
        const perDaySalary = monthlySalary / 30;
        const perMinuteSalary = perDaySalary / 480;

        const [weeklyOff] = await pool.query(
            `SELECT weekly_off_day 
             FROM employee_weekly_off 
             WHERE username = ? AND branch_id = ? AND is_active = '1' AND is_deleted = '0'`,
            [staff_username, branch_id]
        );

        // Flexible salary has no paid leave / weekly offs
        const weeklyOffDaysList = isFlexibleSalary ? [] : weeklyOff.map((r) => r.weekly_off_day);
        const weeklyOffDaySet = new Set(weeklyOffDaysList);
        const weeklyOffDay = weeklyOffDaysList[0] || null;

        // Attendance tables were dropped for rebuild — salary calc uses empty punch history.
        let attendance = [];
        try {
            const [attendanceRows] = await pool.query(
                `SELECT 
                    DATE(punch_in_time) as date,
                    DAY(punch_in_time) as day,
                    attendance_status,
                    is_verified,
                    total_minutes,
                    extra_minutes,
                    less_minutes,
                    punch_in_time,
                    punch_out_time,
                    calculated_amount,
                    per_day_salary as recorded_per_day_salary,
                    admin_remarks,
                    total_break_minutes,
                    excess_break_minutes,
                    break_penalty_amount,
                    travel_allowance_amount,
                    other_deduction_amount,
                    net_adjustment_amount,
                    final_calculated_amount
                 FROM attendance 
                 WHERE username = ? 
                    AND branch_id = ? 
                    AND DATE(punch_in_time) BETWEEN ? AND ?
                    AND is_deleted = '0'
                 ORDER BY punch_in_time`,
                [staff_username, branch_id, startDate, endDate]
            );
            attendance = attendanceRows;
        } catch (error) {
            const code = error?.code || error?.errno;
            if (code !== "ER_NO_SUCH_TABLE" && code !== 1146) {
                throw error;
            }
            attendance = [];
        }

        const attendanceMap = {};
        attendance.forEach(record => {
            attendanceMap[record.day] = record;
        });

        const today = new Date();
        const currentDay = today.getDate();
        const currentMonth = today.getMonth() + 1;
        const currentYear = today.getFullYear();

        const isCurrentMonth = (targetYear === currentYear && targetMonth === currentMonth);
        const lastDayToCalculate = isCurrentMonth ? currentDay : daysInMonth;

        // Initialize counters
        let present = 0, absent = 0, halfDay = 0, paidLeave = 0, fine = 0, bonus = 0, pending = 0, weeklyOffDays = 0;
        let totalExtraMinutes = 0, totalLessMinutes = 0, totalCalculatedAmount = 0;

        // NEW: Break & adjustment totals
        let totalBreakMinutes = 0, totalExcessBreakMinutes = 0, totalBreakPenalty = 0;
        let totalTravelAllowance = 0, totalOtherDeductions = 0, totalNetAdjustment = 0, totalFinalAmount = 0;

        let tillDatePresent = 0, tillDateAbsent = 0, tillDateHalfDay = 0, tillDatePaidLeave = 0, tillDateFine = 0, tillDateBonus = 0, tillDatePending = 0, tillDateWeeklyOffDays = 0;
        let tillDateTotalExtraMinutes = 0, tillDateTotalLessMinutes = 0, tillDateTotalCalculatedAmount = 0;

        const dayBreakdown = [];

        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${targetYear}-${targetMonth.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
            const dateObj = new Date(dateStr);
            const dayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'long' });

            const isWeeklyOff = weeklyOffDaySet.has(dayOfWeek);
            const isFutureDate = (targetYear > currentYear) || (targetYear === currentYear && targetMonth > currentMonth) || (targetYear === currentYear && targetMonth === currentMonth && day > currentDay);
            const isTillDate = day <= lastDayToCalculate && !isFutureDate;

            const attendanceRecord = attendanceMap[day];

            let status = '', calculatedDayAmount = 0, extraMinutes = 0, lessMinutes = 0, remarks = '', isVerified = false, punchIn = null, punchOut = null;
            let breakMinutes = 0, excessBreak = 0, breakPenalty = 0, travelAllowance = 0, otherDeduction = 0, netAdjustment = 0, finalAmount = 0;

            if (isWeeklyOff) {
                status = 'weekly_off';
                calculatedDayAmount = 0;
                weeklyOffDays++;
                if (isTillDate) tillDateWeeklyOffDays++;
            }
            else if (attendanceRecord) {
                status = attendanceRecord.attendance_status;
                extraMinutes = attendanceRecord.extra_minutes || 0;
                lessMinutes = attendanceRecord.less_minutes || 0;
                remarks = attendanceRecord.admin_remarks || '';
                isVerified = attendanceRecord.is_verified === '1';
                punchIn = attendanceRecord.punch_in_time;
                punchOut = attendanceRecord.punch_out_time;

                // NEW: Get break & adjustment values
                breakMinutes = parseInt(attendanceRecord.total_break_minutes) || 0;
                excessBreak = parseInt(attendanceRecord.excess_break_minutes) || 0;
                breakPenalty = parseFloat(attendanceRecord.break_penalty_amount) || 0;
                travelAllowance = parseFloat(attendanceRecord.travel_allowance_amount) || 0;
                otherDeduction = parseFloat(attendanceRecord.other_deduction_amount) || 0;
                netAdjustment = parseFloat(attendanceRecord.net_adjustment_amount) || 0;
                finalAmount = parseFloat(attendanceRecord.final_calculated_amount) || 0;

                // Update break & adjustment totals
                totalBreakMinutes += breakMinutes;
                totalExcessBreakMinutes += excessBreak;
                totalBreakPenalty += breakPenalty;
                totalTravelAllowance += travelAllowance;
                totalOtherDeductions += otherDeduction;
                totalNetAdjustment += netAdjustment;
                totalFinalAmount += finalAmount;

                if (attendanceRecord.calculated_amount && attendanceRecord.calculated_amount > 0) {
                    calculatedDayAmount = parseFloat(attendanceRecord.calculated_amount);
                } else {
                    switch (status) {
                        case 'present':
                            calculatedDayAmount = perDaySalary;
                            present++;
                            if (isTillDate) tillDatePresent++;
                            break;
                        case 'bonus':
                            calculatedDayAmount = perDaySalary + (extraMinutes * perMinuteSalary);
                            bonus++;
                            if (isTillDate) tillDateBonus++;
                            break;
                        case 'half_day':
                            calculatedDayAmount = perDaySalary * 0.5;
                            halfDay++;
                            if (isTillDate) tillDateHalfDay++;
                            break;
                        case 'fine':
                            calculatedDayAmount = Math.max(0, perDaySalary - (lessMinutes * perMinuteSalary));
                            fine++;
                            if (isTillDate) tillDateFine++;
                            break;
                        case 'leave':
                        case 'paid_leave':
                            calculatedDayAmount = perDaySalary;
                            paidLeave++;
                            if (isTillDate) tillDatePaidLeave++;
                            break;
                        case 'pending':
                            calculatedDayAmount = 0;
                            pending++;
                            if (isTillDate) tillDatePending++;
                            break;
                        default:
                            calculatedDayAmount = 0;
                            absent++;
                            if (isTillDate) tillDateAbsent++;
                    }
                }

                totalCalculatedAmount += calculatedDayAmount;
                totalExtraMinutes += extraMinutes;
                totalLessMinutes += lessMinutes;

                if (isTillDate) {
                    tillDateTotalCalculatedAmount += calculatedDayAmount;
                    tillDateTotalExtraMinutes += extraMinutes;
                    tillDateTotalLessMinutes += lessMinutes;
                }
            }
            else if (isFutureDate) {
                status = 'future';
                calculatedDayAmount = 0;
            }
            else {
                status = 'absent';
                calculatedDayAmount = 0;
                absent++;
                if (isTillDate) tillDateAbsent++;
            }

            dayBreakdown.push({
                day: day,
                date: dateStr,
                day_of_week: dayOfWeek,
                is_weekly_off: isWeeklyOff,
                is_future: isFutureDate,
                is_till_date: isTillDate,
                status: status,
                status_display: getStatusDisplay(status),
                calculated_amount: calculatedDayAmount,
                extra_minutes: extraMinutes,
                less_minutes: lessMinutes,
                extra_hours: (extraMinutes / 60).toFixed(1),
                less_hours: (lessMinutes / 60).toFixed(1),
                punch_in: punchIn,
                punch_out: punchOut,
                is_verified: isVerified,
                remarks: remarks,
                // NEW: Break & adjustment details
                break_details: {
                    total_break_minutes: breakMinutes,
                    excess_break_minutes: excessBreak,
                    break_penalty: breakPenalty
                },
                adjustment_details: {
                    travel_allowance: travelAllowance,
                    other_deductions: otherDeduction,
                    net_adjustment: netAdjustment,
                    final_amount: finalAmount
                }
            });
        }

        // Calculate totals (existing code remains the same)
        const totalWorkedDays = present + bonus + fine + halfDay + paidLeave;
        const totalWorkingDays = daysInMonth - weeklyOffDays;
        const totalEarned = totalCalculatedAmount;

        const bonusAmount = totalExtraMinutes * perMinuteSalary;
        const fineAmount = totalLessMinutes * perMinuteSalary;
        const halfDayDeduction = (halfDay * perDaySalary * 0.5);

        const tillDateTotalWorkedDays = tillDatePresent + tillDateBonus + tillDateFine + tillDateHalfDay + tillDatePaidLeave;
        const tillDateTotalWorkingDays = lastDayToCalculate - tillDateWeeklyOffDays;
        const tillDateTotalEarned = tillDateTotalCalculatedAmount;

        const tillDateBonusAmount = tillDateTotalExtraMinutes * perMinuteSalary;
        const tillDateFineAmount = tillDateTotalLessMinutes * perMinuteSalary;
        const tillDateHalfDayDeduction = (tillDateHalfDay * perDaySalary * 0.5);
        const tillDateExpectedSalary = perDaySalary * tillDateTotalWorkingDays;

        const formatMinutes = (minutes) => {
            const hours = Math.floor(minutes / 60);
            const mins = minutes % 60;
            return `${hours}h ${mins}m`;
        };

        const totalMarkedDays = present + halfDay + bonus + fine + paidLeave;
        const totalMarkedDaysWithPending = totalMarkedDays + pending;
        const tillDateTotalMarkedDays = tillDatePresent + tillDateHalfDay + tillDateBonus + tillDateFine + tillDatePaidLeave;
        const tillDateTotalMarkedDaysWithPending = tillDateTotalMarkedDays + tillDatePending;

        let salaryStatus = 'ready';
        let salaryMessage = 'Salary calculation completed';

        if (pending > 0) {
            salaryStatus = 'pending_verification';
            salaryMessage = `Salary calculation pending: ${pending} day(s) require verification`;
        } else if (targetYear === currentYear && targetMonth === currentMonth) {
            salaryStatus = 'in_progress';
            salaryMessage = 'Current month salary calculation (subject to change until month end)';
        }

        let tillDateSalaryStatus = 'calculated';
        let tillDateSalaryMessage = `Salary calculated for ${tillDateTotalWorkedDays} working days out of ${tillDateTotalWorkingDays} days till ${new Date(targetYear, targetMonth - 1, lastDayToCalculate).toLocaleDateString()}`;

        if (tillDatePending > 0) {
            tillDateSalaryStatus = 'pending_verification';
            tillDateSalaryMessage = `Salary calculation pending: ${tillDatePending} day(s) require verification`;
        }

        const [salaryHistory] = await pool.query(
            `SELECT 
                salary_id AS assignment_id,
                salary_id,
                salary_type,
                amount AS monthly_salary,
                monthly_working_minutes,
                effective_from,
                effective_to,
                is_active
             FROM staff_salaries
             WHERE username = ? AND branch_id = ? AND is_deleted = '0'
               AND effective_from <= ?
             ORDER BY effective_from DESC`,
            [staff_username, branch_id, endDate]
        );

        return res.status(200).json({
            success: true,
            message: `Salary calculation for ${profile.name} (${targetMonth}/${targetYear})`,
            data: {
                staff_info: {
                    username: staff_username,
                    name: profile.name,
                    email: profile.email,
                    mobile: profile.mobile,
                    designation: profile.designation,
                    image: buildProfileImageUrl(profile.image),
                    weekly_off_day: weeklyOffDay || 'Not Set',
                    weekly_off_days: weeklyOffDaysList,
                },
                period: {
                    month: targetMonth,
                    month_name: new Date(targetYear, targetMonth - 1).toLocaleString('default', { month: 'long' }),
                    year: targetYear,
                    start_date: startDate,
                    end_date: endDate,
                    total_days: daysInMonth,
                    working_days_excluding_weekly_off: totalWorkingDays,
                    till_date: {
                        date: isCurrentMonth ? new Date().toISOString().split('T')[0] : endDate,
                        day: lastDayToCalculate,
                        is_current_month: isCurrentMonth
                    }
                },
                salary_configuration: {
                    monthly_salary: monthlySalary,
                    salary_type: salaryData.length > 0 ? (salaryData[0].salary_type || 'fixed') : null,
                    monthly_working_minutes: monthlyWorkingMinutes,
                    monthly_working_hours: monthlyWorkingHours,
                    per_day_salary: perDaySalary.toFixed(2),
                    per_hour_salary: (isFlexibleSalary && monthlyWorkingHours
                        ? (monthlySalary / monthlyWorkingHours)
                        : (perDaySalary / 8)).toFixed(2),
                    per_minute_salary: perMinuteSalary.toFixed(4),
                    salary_applied_from: salaryData.length > 0 ? salaryData[0].effective_from : null,
                    salary_history: salaryHistory
                },

                // ============ NEW: BREAK & ADJUSTMENT SUMMARY ============
                break_adjustment_summary: {
                    break_summary: {
                        total_break_minutes: totalBreakMinutes,
                        total_excess_break_minutes: totalExcessBreakMinutes,
                        total_break_penalty: totalBreakPenalty.toFixed(2),
                        formatted_break_time: formatMinutes(totalBreakMinutes),
                        formatted_excess_time: formatMinutes(totalExcessBreakMinutes)
                    },
                    adjustment_summary: {
                        total_travel_allowance: totalTravelAllowance.toFixed(2),
                        total_other_deductions: totalOtherDeductions.toFixed(2),
                        total_net_adjustment: totalNetAdjustment.toFixed(2),
                        total_final_amount: totalFinalAmount.toFixed(2)
                    }
                },

                // FULL MONTH SUMMARY (existing)
                monthly_summary: {
                    attendance_summary: {
                        present: present,
                        bonus: bonus,
                        fine: fine,
                        half_day: halfDay,
                        paid_leave: paidLeave,
                        absent: absent,
                        pending: pending,
                        weekly_off: weeklyOffDays,
                        total_days_worked: totalWorkedDays,
                        total_days_marked: totalMarkedDays,
                        total_days_with_pending: totalMarkedDaysWithPending,
                        attendance_percentage: totalWorkingDays > 0 ? ((totalWorkedDays / totalWorkingDays) * 100).toFixed(1) : '0.0',
                        extra_time: {
                            minutes: totalExtraMinutes,
                            hours: (totalExtraMinutes / 60).toFixed(1),
                            formatted: formatMinutes(totalExtraMinutes),
                            amount: bonusAmount.toFixed(2)
                        },
                        less_time: {
                            minutes: totalLessMinutes,
                            hours: (totalLessMinutes / 60).toFixed(1),
                            formatted: formatMinutes(totalLessMinutes),
                            amount: fineAmount.toFixed(2)
                        }
                    },
                    salary_calculation: {
                        base_salary_potential: (perDaySalary * totalWorkingDays).toFixed(2),
                        base_salary_earned: (perDaySalary * totalWorkedDays).toFixed(2),
                        bonus_adjustment: bonusAmount.toFixed(2),
                        fine_adjustment: (-fineAmount).toFixed(2),
                        half_day_adjustment: (-halfDayDeduction).toFixed(2),
                        total_earned: totalEarned.toFixed(2),
                        total_deducted: (totalEarned < monthlySalary ? (monthlySalary - totalEarned).toFixed(2) : '0.00'),
                        total_added: (totalEarned > monthlySalary ? (totalEarned - monthlySalary).toFixed(2) : '0.00'),
                        salary_status: salaryStatus,
                        salary_message: salaryMessage,
                        formula: {
                            monthly_salary: monthlySalary,
                            per_day: perDaySalary,
                            present_days: present,
                            present_amount: (present * perDaySalary).toFixed(2),
                            bonus_days: bonus,
                            bonus_amount: (bonus * perDaySalary).toFixed(2),
                            fine_days: fine,
                            fine_adjustment: (-fineAmount).toFixed(2),
                            half_day_days: halfDay,
                            half_day_amount: halfDayDeduction.toFixed(2),
                            paid_leave_days: paidLeave,
                            paid_leave_amount: (paidLeave * perDaySalary).toFixed(2),
                            extra_minutes_bonus: bonusAmount.toFixed(2),
                            less_minutes_fine: (-fineAmount).toFixed(2)
                        }
                    }
                },

                // TILL DATE SUMMARY (existing)
                till_date_summary: {
                    calculated_upto: {
                        date: isCurrentMonth ? new Date().toISOString().split('T')[0] : endDate,
                        day: lastDayToCalculate,
                        is_current_month: isCurrentMonth
                    },
                    attendance_summary: {
                        present: tillDatePresent,
                        bonus: tillDateBonus,
                        fine: tillDateFine,
                        half_day: tillDateHalfDay,
                        paid_leave: tillDatePaidLeave,
                        absent: tillDateAbsent,
                        pending: tillDatePending,
                        weekly_off: tillDateWeeklyOffDays,
                        total_days_worked: tillDateTotalWorkedDays,
                        total_days_marked: tillDateTotalMarkedDays,
                        total_days_with_pending: tillDateTotalMarkedDaysWithPending,
                        attendance_percentage: tillDateTotalWorkingDays > 0 ? ((tillDateTotalWorkedDays / tillDateTotalWorkingDays) * 100).toFixed(1) : '0.0',
                        extra_time: {
                            minutes: tillDateTotalExtraMinutes,
                            hours: (tillDateTotalExtraMinutes / 60).toFixed(1),
                            formatted: formatMinutes(tillDateTotalExtraMinutes),
                            amount: tillDateBonusAmount.toFixed(2)
                        },
                        less_time: {
                            minutes: tillDateTotalLessMinutes,
                            hours: (tillDateTotalLessMinutes / 60).toFixed(1),
                            formatted: formatMinutes(tillDateTotalLessMinutes),
                            amount: tillDateFineAmount.toFixed(2)
                        }
                    },
                    salary_calculation: {
                        expected_salary_till_date: tillDateExpectedSalary.toFixed(2),
                        actual_earned_till_date: tillDateTotalEarned.toFixed(2),
                        difference: (tillDateTotalEarned - tillDateExpectedSalary).toFixed(2),
                        base_salary_earned: (perDaySalary * tillDateTotalWorkedDays).toFixed(2),
                        bonus_adjustment: tillDateBonusAmount.toFixed(2),
                        fine_adjustment: (-tillDateFineAmount).toFixed(2),
                        half_day_adjustment: (-tillDateHalfDayDeduction).toFixed(2),
                        salary_status: tillDateSalaryStatus,
                        salary_message: tillDateSalaryMessage,
                        formula: {
                            per_day: perDaySalary,
                            working_days_considered: tillDateTotalWorkingDays,
                            worked_days: tillDateTotalWorkedDays,
                            present_days: tillDatePresent,
                            present_amount: (tillDatePresent * perDaySalary).toFixed(2),
                            bonus_days: tillDateBonus,
                            bonus_amount: (tillDateBonus * perDaySalary).toFixed(2),
                            fine_days: tillDateFine,
                            fine_adjustment: (-tillDateFineAmount).toFixed(2),
                            half_day_days: tillDateHalfDay,
                            half_day_amount: tillDateHalfDayDeduction.toFixed(2),
                            paid_leave_days: tillDatePaidLeave,
                            paid_leave_amount: (tillDatePaidLeave * perDaySalary).toFixed(2),
                            extra_minutes_bonus: tillDateBonusAmount.toFixed(2),
                            less_minutes_fine: (-tillDateFineAmount).toFixed(2)
                        }
                    },
                    projection: isCurrentMonth ? {
                        estimated_month_end_salary: ((tillDateTotalEarned / lastDayToCalculate) * daysInMonth).toFixed(2),
                        estimated_extra_hours: ((tillDateTotalExtraMinutes / lastDayToCalculate) * daysInMonth).toFixed(0),
                        estimated_less_hours: ((tillDateTotalLessMinutes / lastDayToCalculate) * daysInMonth).toFixed(0),
                        note: "Projection based on current month's performance till date"
                    } : null
                },
                day_wise_breakdown: dayBreakdown,
                verification_status: {
                    is_fully_verified: pending === 0,
                    pending_verification_days: pending,
                    verified_days: totalMarkedDays - pending,
                    can_be_paid: pending === 0 && (targetYear !== currentYear || targetMonth !== currentMonth)
                }
            },
            meta: {
                generated_by: loggedInUser,
                generated_at: new Date().toISOString(),
                is_admin_view: isAdmin,
                is_self_view: isSelf,
                calculation_type: "full_month_and_till_date_with_breaks"
            }
        });

    } catch (error) {
        console.error('Error calculating salary:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to calculate salary',
            error: error.message
        });
    }
});

// ==================== BREAK MANAGEMENT APIs (FIXED) ====================

router.post('/admin/add-adjustment', auth, validateBranch, async (req, res) => {
    try {
        const admin_username = req.headers["username"];
        const branch_id = req.branch_id;
        const {
            username,
            adjustment_type,
            adjustment_name,
            calculation_type,
            amount,
            applied_on = 'per_day',
            reference_id = null,
            reference_type = 'manual',
            effective_from,
            effective_to = null,
            is_recurring = false,
            remarks = null
        } = req.body;

        if (!admin_username) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        // Check if user is admin
        const isAdmin = await checkIfAdmin(admin_username, branch_id);
        if (!isAdmin) {
            return res.status(403).json({
                success: false,
                message: "Only admins can add salary adjustments"
            });
        }

        // Validate required fields
        if (!username || !adjustment_type || !adjustment_name || !amount || !effective_from) {
            return res.status(400).json({
                success: false,
                message: "Missing required fields: username, adjustment_type, adjustment_name, amount, effective_from"
            });
        }

        if (!['allowance', 'deduction'].includes(adjustment_type)) {
            return res.status(400).json({
                success: false,
                message: "adjustment_type must be 'allowance' or 'deduction'"
            });
        }

        if (!['fixed', 'percentage'].includes(calculation_type)) {
            return res.status(400).json({
                success: false,
                message: "calculation_type must be 'fixed' or 'percentage'"
            });
        }

        // Get staff mapping
        const [mapping] = await pool.query(
            `SELECT map_id FROM branch_mapping 
             WHERE username = ? AND branch_id = ? AND type = 'staff' 
             AND is_deleted = '0'`,
            [username, branch_id]
        );

        if (!mapping.length) {
            return res.status(404).json({
                success: false,
                message: 'Staff not found in this branch'
            });
        }

        // Generate adjustment ID
        const adjustment_id = await UNIQUE_RANDOM_STRING("salary_adjustments", "adjustment_id", {
            prefix: "ADJ",
            length: ID_LENGTH,
        });

        await insertRow("salary_adjustments", {
            adjustment_id,
            map_id: mapping[0].map_id,
            username,
            branch_id,
            adjustment_type,
            adjustment_name,
            calculation_type,
            amount,
            applied_on_amount: applied_on,
            reference_id,
            reference_type,
            is_recurring: is_recurring ? 1 : 0,
            effective_from,
            effective_to,
            remarks,
            create_by: admin_username,
            modify_by: admin_username,
            create_date: new Date(),
            is_deleted: '0'
        });

        const profile = await getStaffProfile(username, branch_id);

        return res.status(200).json({
            success: true,
            message: `${adjustment_type === 'allowance' ? 'Allowance' : 'Deduction'} added successfully`,
            data: {
                adjustment_id,
                username,
                profile: profile ? {
                    name: profile.name,
                    email: profile.email,
                    designation: profile.designation
                } : null,
                adjustment_type,
                adjustment_name,
                calculation_type,
                amount,
                applied_on,
                effective_from,
                effective_to,
                is_recurring,
                remarks
            }
        });

    } catch (error) {
        console.error('Add adjustment error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to add adjustment',
            error: error.message
        });
    }
});

/**
 * ADMIN: Get Staff Adjustments
 * Headers: 
 *   - Authorization: Bearer {token}
 *   - username: {admin_username}
 * Query: username, adjustment_type (optional), from_date (optional), to_date (optional)
 */

router.get('/admin/adjustments', auth, validateBranch, async (req, res) => {
    try {
        const admin_username = req.headers["username"];
        const branch_id = req.branch_id;
        const { username, adjustment_type, from_date, to_date } = req.query;

        if (!admin_username) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        if (!username) {
            return res.status(400).json({
                success: false,
                message: "username is required"
            });
        }

        let query = `
            SELECT * FROM salary_adjustments
            WHERE username = ? AND branch_id = ? AND is_deleted = '0'
        `;
        const params = [username, branch_id];

        if (adjustment_type) {
            query += ` AND adjustment_type = ?`;
            params.push(adjustment_type);
        }

        if (from_date) {
            query += ` AND effective_from >= ?`;
            params.push(from_date);
        }

        if (to_date) {
            query += ` AND effective_to <= ?`;
            params.push(to_date);
        }

        query += ` ORDER BY create_date DESC`;

        const [adjustments] = await pool.query(query, params);

        const summary = {
            total_allowances: adjustments.filter(a => a.adjustment_type === 'allowance')
                .reduce((sum, a) => sum + parseFloat(a.amount), 0),
            total_deductions: adjustments.filter(a => a.adjustment_type === 'deduction')
                .reduce((sum, a) => sum + parseFloat(a.amount), 0),
            net_adjustment: adjustments.filter(a => a.adjustment_type === 'allowance')
                .reduce((sum, a) => sum + parseFloat(a.amount), 0) -
                adjustments.filter(a => a.adjustment_type === 'deduction')
                    .reduce((sum, a) => sum + parseFloat(a.amount), 0)
        };

        const profile = await getStaffProfile(username, branch_id);

        return res.status(200).json({
            success: true,
            message: "Adjustments retrieved successfully",
            data: {
                username,
                profile: profile ? {
                    name: profile.name,
                    email: profile.email,
                    designation: profile.designation
                } : null,
                summary,
                adjustments: adjustments.map(a => ({
                    id: a.id,
                    adjustment_id: a.adjustment_id,
                    adjustment_type: a.adjustment_type,
                    adjustment_name: a.adjustment_name,
                    calculation_type: a.calculation_type,
                    amount: parseFloat(a.amount),
                    applied_on: a.applied_on_amount,
                    effective_from: a.effective_from,
                    effective_to: a.effective_to,
                    is_recurring: a.is_recurring === 1,
                    remarks: a.remarks,
                    created_at: a.create_date,
                    created_by: a.create_by
                }))
            }
        });

    } catch (error) {
        console.error('Get adjustments error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch adjustments',
            error: error.message
        });
    }
});

/**
 * ADMIN: Verify Attendance (With Break Consideration Toggle & Auto-Create for Missing)
 * Headers: 
 *   - Authorization: Bearer {token}
 *   - username: {admin_username}
 * Body: { 
 *   attendance_id (optional if create_if_missing=true),
 *   username (required if create_if_missing=true),
 *   attendance_date (required if create_if_missing=true),
 *   verify_status, 
 *   admin_remarks, 
 *   manual_punch_in, 
 *   manual_punch_out,
 *   consider_break = true,
 *   apply_travel_allowance = true,
 *   apply_other_deductions = true,
 *   create_if_missing = false
 * }
 */

const SALARY_RESERVED_ITEM_NAME = "Salary";
const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
];

function parseMonthYear(month, year) {
    const monthNum = parseInt(month, 10);
    const yearNum = parseInt(year, 10);
    if (!Number.isFinite(monthNum) || monthNum < 1 || monthNum > 12) {
        return { valid: false, message: "Month must be between 1 and 12" };
    }
    if (!Number.isFinite(yearNum) || yearNum < 2000 || yearNum > 2100) {
        return { valid: false, message: "Invalid year" };
    }
    const startDate = `${yearNum}-${String(monthNum).padStart(2, "0")}-01`;
    const lastDay = new Date(yearNum, monthNum, 0).getDate();
    const endDate = `${yearNum}-${String(monthNum).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    return { valid: true, monthNum, yearNum, startDate, endDate, lastDay };
}

/** Transaction date = month end, or today when month end is still in the future. */
function resolvePayslipTransactionDate(endDate) {
    const today = TODAY_DATE();
    return endDate > today ? today : endDate;
}

async function ensureSalaryExpenseItem(connection, branch_id, username) {
    const [rows] = await connection.query(
        `SELECT item_id FROM expense_items
         WHERE name = ? AND is_reserved = '1' AND is_deleted = '0'
           AND (branch_id IS NULL OR branch_id = ?)
         ORDER BY CASE WHEN branch_id IS NULL THEN 0 ELSE 1 END
         LIMIT 1`,
        [SALARY_RESERVED_ITEM_NAME, branch_id]
    );
    if (rows?.length) return rows[0].item_id;

    const item_id = await UNIQUE_RANDOM_STRING("expense_items", "item_id", {
        length: ID_LENGTH,
        conn: connection,
    });
    await connection.query(
        `INSERT INTO expense_items
           (branch_id, item_id, create_by, modify_by, name, type, remark, is_reserved, is_deleted)
         VALUES (NULL, ?, ?, ?, ?, 'indirect', ?, '1', '0')`,
        [
            item_id,
            username,
            username,
            SALARY_RESERVED_ITEM_NAME,
            "Reserved system item for staff salary payslips",
        ]
    );
    return item_id;
}

async function assertStaffOnBranch(branch_id, username) {
    const [rows] = await pool.query(
        `SELECT map_id FROM branch_mapping
         WHERE branch_id = ? AND username = ? AND type = 'staff' AND is_deleted = '0'
         LIMIT 1`,
        [branch_id, username]
    );
    return rows.length > 0;
}

function toAttendanceYmd(value) {
    if (value == null) return null;
    if (value instanceof Date && !Number.isNaN(value.getTime())) {
        return formatLocalYmd(value);
    }
    const s = String(value);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    const d = parseDateOnly(value);
    return Number.isNaN(d.getTime()) ? null : formatLocalYmd(d);
}

function daysInMonthFromYmd(ymd) {
    const s = String(ymd || "").slice(0, 10);
    const [y, m] = s.split("-").map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return 0;
    return new Date(y, m, 0).getDate();
}

/** Calendar-day wage from monthly amount (same base as attendance mark). */
function fullDayWageFromAmount(monthlyAmount, dateYmd) {
    const amount = Number(monthlyAmount);
    const days = daysInMonthFromYmd(dateYmd);
    if (!Number.isFinite(amount) || amount <= 0 || !days) return 0;
    return Number((amount / days).toFixed(4));
}

/**
 * Salary covering a date by effective range (historical — not only is_active).
 * Rows should be ordered effective_from DESC.
 */
function pickSalaryForDate(salaries, dateYmd) {
    for (const s of salaries || []) {
        const from = toAttendanceYmd(s.effective_from);
        const to = s.effective_to != null ? toAttendanceYmd(s.effective_to) : null;
        if (from && from <= dateYmd && (to == null || to >= dateYmd)) {
            return s;
        }
    }
    return null;
}

/**
 * Month attendance wage for payslip.
 * Leave always pays full day wage (recomputes from salary when stored net is missing/wrong).
 * Optional persistFixes writes corrected leave wages back to attendance (used on generate).
 */
async function computeMonthAttendanceWage(
    connection,
    { branch_id, username, startDate, endDate, persistFixes = false, includeDays = false }
) {
    const db = connection || pool;
    const [attRows] = await db.query(
        `SELECT id, date, status, daily_wage, overtime_amount, fine_amount, net_day_amount
         FROM attendance
         WHERE branch_id = ?
           AND username = ?
           AND date >= ?
           AND date <= ?
         ORDER BY date ASC`,
        [branch_id, username, startDate, endDate]
    );

    const [salaries] = await db.query(
        `SELECT amount, effective_from, effective_to
         FROM staff_salaries
         WHERE branch_id = ?
           AND username = ?
           AND is_deleted = '0'
           AND effective_from <= ?
           AND (effective_to IS NULL OR effective_to >= ?)
         ORDER BY effective_from DESC`,
        [branch_id, username, endDate, startDate]
    );

    let present_days = 0;
    let half_days = 0;
    let leave_days = 0;
    let absent_days = 0;
    let total_daily_wage = 0;
    let total_overtime = 0;
    let total_fine = 0;
    let net_amount = 0;
    const days = [];
    const leaveFixes = [];

    for (const row of attRows) {
        const dateYmd = toAttendanceYmd(row.date);
        const status = String(row.status || "").toLowerCase().trim();
        let daily_wage = Number(row.daily_wage);
        if (!Number.isFinite(daily_wage)) daily_wage = 0;
        let overtime_amount = Number(row.overtime_amount);
        if (!Number.isFinite(overtime_amount)) overtime_amount = 0;
        let fine_amount = Number(row.fine_amount);
        if (!Number.isFinite(fine_amount)) fine_amount = 0;
        let net_day_amount = Number(row.net_day_amount);
        if (!Number.isFinite(net_day_amount)) net_day_amount = 0;

        if (status === "present") {
            present_days += 1;
        } else if (status === "half day") {
            half_days += 1;
        } else if (status === "leave") {
            leave_days += 1;
            const salary = pickSalaryForDate(salaries, dateYmd);
            const fullDay = fullDayWageFromAmount(salary?.amount, dateYmd);
            if (fullDay > 0) {
                const needsFix = Math.abs(net_day_amount - fullDay) > 0.009
                    || Math.abs(daily_wage - fullDay) > 0.009
                    || overtime_amount !== 0
                    || fine_amount !== 0;
                if (needsFix) {
                    daily_wage = fullDay;
                    overtime_amount = 0;
                    fine_amount = 0;
                    net_day_amount = fullDay;
                    if (persistFixes && row.id != null) {
                        leaveFixes.push({
                            id: row.id,
                            daily_wage,
                            overtime_amount,
                            fine_amount,
                            net_day_amount,
                        });
                    }
                }
            }
        } else if (status === "absent") {
            absent_days += 1;
        }

        total_daily_wage += daily_wage;
        total_overtime += overtime_amount;
        total_fine += fine_amount;
        net_amount += net_day_amount;

        if (includeDays) {
            days.push({
                date: dateYmd,
                status: row.status,
                daily_wage: Number(daily_wage.toFixed(4)),
                overtime_amount: Number(overtime_amount.toFixed(4)),
                fine_amount: Number(fine_amount.toFixed(4)),
                net_day_amount: Number(net_day_amount.toFixed(4)),
            });
        }
    }

    if (persistFixes && leaveFixes.length > 0) {
        for (const fix of leaveFixes) {
            await db.query(
                `UPDATE attendance
                 SET daily_wage = ?,
                     overtime_amount = ?,
                     fine_amount = ?,
                     net_day_amount = ?,
                     expected_hours = NULL,
                     worked_minutes = NULL,
                     extra_minutes = 0,
                     less_minutes = 0,
                     overtime_enabled = 0,
                     fine_enabled = 0
                 WHERE id = ?`,
                [
                    fix.daily_wage,
                    fix.overtime_amount,
                    fix.fine_amount,
                    fix.net_day_amount,
                    fix.id,
                ]
            );
        }
    }

    const result = {
        marked_days: attRows.length,
        present_days,
        half_days,
        leave_days,
        absent_days,
        total_daily_wage: Number(total_daily_wage.toFixed(2)),
        total_overtime: Number(total_overtime.toFixed(2)),
        total_fine: Number(total_fine.toFixed(2)),
        net_amount: Number(net_amount.toFixed(2)),
        leave_wages_fixed: leaveFixes.length,
    };
    if (includeDays) result.days = days;
    return result;
}

/**
 * Sum month-scoped staff bonus / fine entries for payslip.
 * Optional includeItems returns individual rows for preview/PDF.
 */
async function sumMonthBonusFine(
    connection,
    { branch_id, username, year, month, includeItems = false }
) {
    const db = connection || pool;
    const [agg] = await db.query(
        `SELECT
            COALESCE(SUM(CASE WHEN type = 'bonus' THEN amount ELSE 0 END), 0) AS total_bonus,
            COALESCE(SUM(CASE WHEN type = 'fine' THEN amount ELSE 0 END), 0) AS total_fine,
            COUNT(*) AS entry_count
         FROM staff_bonus_fine
         WHERE branch_id = ?
           AND username = ?
           AND year = ?
           AND month = ?
           AND is_deleted = '0'`,
        [branch_id, username, year, month]
    );
    const total_bonus = Number(Number(agg[0]?.total_bonus || 0).toFixed(2));
    const total_fine = Number(Number(agg[0]?.total_fine || 0).toFixed(2));
    let items = [];
    if (includeItems) {
        const [rows] = await db.query(
            `SELECT entry_id, type, year, month, amount, remark, create_date
             FROM staff_bonus_fine
             WHERE branch_id = ?
               AND username = ?
               AND year = ?
               AND month = ?
               AND is_deleted = '0'
             ORDER BY type ASC, create_date ASC`,
            [branch_id, username, year, month]
        );
        items = rows.map(mapBonusFineRow);
    }
    return {
        total_bonus,
        total_fine,
        entry_count: Number(agg[0]?.entry_count) || 0,
        items,
    };
}

/** Payslip payable = attendance net + month bonuses − month fines. */
function computePayslipPayable(wage, bonusFine) {
    const attendance_net = Number(wage?.net_amount) || 0;
    const total_bonus = Number(bonusFine?.total_bonus) || 0;
    const total_fine = Number(bonusFine?.total_fine) || 0;
    return Number((attendance_net + total_bonus - total_fine).toFixed(2));
}

function mapBonusFineRow(row) {
    return {
        entry_id: row.entry_id,
        username: row.username,
        type: row.type,
        year: Number(row.year),
        month: Number(row.month),
        month_name: MONTH_NAMES[Number(row.month) - 1] || null,
        amount: Number(row.amount) || 0,
        remark: row.remark || "",
        create_date: row.create_date,
        modify_date: row.modify_date,
        create_by: row.create_by,
        create_by_name: row.create_by_name || null,
        create_by_mobile: row.create_by_mobile || null,
        create_by_country_code: row.create_by_country_code || null,
        modify_by: row.modify_by,
    };
}

function amountsDiffer(a, b) {
    return Math.abs(Number(a || 0) - Number(b || 0)) > 0.009;
}

function mapPayslipRow(row, wage = null) {
    const amount = Number(row.amount) || 0;
    const payableRaw =
        row.payable_amount != null
            ? Number(row.payable_amount)
            : wage != null
              ? wage.net_amount
              : null;
    const payable_amount =
        payableRaw == null || Number.isNaN(payableRaw)
            ? null
            : Number(Number(payableRaw).toFixed(2));
    return {
        payslip_id: row.payslip_id,
        username: row.username,
        year: Number(row.year),
        month: Number(row.month),
        month_name: MONTH_NAMES[Number(row.month) - 1] || null,
        amount,
        payable_amount,
        needs_regenerate:
            payable_amount != null ? amountsDiffer(amount, payable_amount) : false,
        payslip_date: row.payslip_date,
        invoice_id: row.invoice_id,
        invoice_no: row.invoice_no,
        transaction_id: row.transaction_id,
        expense_id: row.expense_id,
        remark: row.remark,
        create_date: row.create_date,
        modify_date: row.modify_date,
        status: "generated",
        ...(wage
            ? {
                attendance_summary: {
                    marked_days: wage.marked_days,
                    present_days: wage.present_days,
                    half_days: wage.half_days,
                    leave_days: wage.leave_days,
                    absent_days: wage.absent_days,
                    total_daily_wage: wage.total_daily_wage,
                    total_overtime: wage.total_overtime,
                    total_fine: wage.total_fine,
                },
            }
            : {}),
    };
}

/**
 * GET /salary/payslip/list?username=
 * All posted payslips for staff (newest first). Optional year= still supported.
 * Includes payable_amount / needs_regenerate vs current attendance totals.
 */
router.get("/payslip/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = String(req.query.username || "").trim();
        const yearFilter = req.query.year != null && String(req.query.year).trim() !== ""
            ? parseInt(req.query.year, 10)
            : null;

        if (!username) {
            return res.status(400).json({ success: false, message: "username is required" });
        }
        if (yearFilter != null && (yearFilter < 2000 || yearFilter > 2100 || Number.isNaN(yearFilter))) {
            return res.status(400).json({ success: false, message: "Invalid year" });
        }

        const okStaff = await assertStaffOnBranch(branch_id, username);
        if (!okStaff) {
            return res.status(404).json({ success: false, message: "Staff not found in this branch" });
        }

        const params = [branch_id, username];
        let yearClause = "";
        if (yearFilter != null) {
            yearClause = " AND pe.year = ?";
            params.push(yearFilter);
        }

        const [rows] = await pool.query(
            `SELECT pe.*
             FROM payslip_entries pe
             WHERE pe.branch_id = ? AND pe.username = ? AND pe.is_deleted = '0'${yearClause}
             ORDER BY pe.year DESC, pe.month DESC`,
            params
        );

        // Recompute payable (leave = full day wage) so list matches preview/generate/PDF
        const payslips = [];
        for (const r of rows) {
            const parsed = parseMonthYear(r.month, r.year);
            let payable_amount = null;
            if (parsed.valid) {
                const wage = await computeMonthAttendanceWage(pool, {
                    branch_id,
                    username,
                    startDate: parsed.startDate,
                    endDate: parsed.endDate,
                });
                const bonusFine = await sumMonthBonusFine(pool, {
                    branch_id,
                    username,
                    year: parsed.yearNum,
                    month: parsed.monthNum,
                    includeItems: false,
                });
                payable_amount = computePayslipPayable(wage, bonusFine);
            }
            payslips.push(mapPayslipRow({ ...r, payable_amount }));
        }

        return res.status(200).json({
            success: true,
            message: "Payslip list retrieved",
            data: {
                username,
                year: yearFilter,
                payslips,
                summary: {
                    count: payslips.length,
                    total_amount: payslips.reduce((s, r) => s + (Number(r.amount) || 0), 0),
                },
            },
        });
    } catch (error) {
        console.error("Payslip list error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to list payslips",
            error: error.message,
        });
    }
});

/**
 * POST /salary/payslip/preview
 * Body: { username, month, year }
 * Returns attendance wage sum for the month without posting to ledger.
 */
router.post("/payslip/preview", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = String(req.body?.username || "").trim();
        const parsed = parseMonthYear(req.body?.month, req.body?.year);
        if (!username) {
            return res.status(400).json({ success: false, message: "username is required" });
        }
        if (!parsed.valid) {
            return res.status(400).json({ success: false, message: parsed.message });
        }

        const okStaff = await assertStaffOnBranch(branch_id, username);
        if (!okStaff) {
            return res.status(404).json({ success: false, message: "Staff not found in this branch" });
        }

        const { monthNum, yearNum, startDate, endDate } = parsed;
        const wage = await computeMonthAttendanceWage(pool, {
            branch_id,
            username,
            startDate,
            endDate,
        });
        const bonusFine = await sumMonthBonusFine(pool, {
            branch_id,
            username,
            year: yearNum,
            month: monthNum,
            includeItems: true,
        });
        const amount = computePayslipPayable(wage, bonusFine);
        const txnDate = resolvePayslipTransactionDate(endDate);

        const [existing] = await pool.query(
            `SELECT payslip_id, amount, payslip_date, invoice_no, transaction_id
             FROM payslip_entries
             WHERE branch_id = ? AND username = ? AND year = ? AND month = ? AND is_deleted = '0'
             LIMIT 1`,
            [branch_id, username, yearNum, monthNum]
        );

        return res.status(200).json({
            success: true,
            data: {
                username,
                year: yearNum,
                month: monthNum,
                month_name: MONTH_NAMES[monthNum - 1],
                start_date: startDate,
                end_date: endDate,
                transaction_date: txnDate,
                amount,
                already_generated: existing.length > 0,
                previous_amount: existing.length ? Number(existing[0].amount) || 0 : null,
                amount_delta: existing.length
                    ? Number((amount - (Number(existing[0].amount) || 0)).toFixed(2))
                    : null,
                existing: existing.length ? mapPayslipRow(existing[0]) : null,
                attendance_summary: {
                    marked_days: wage.marked_days,
                    present_days: wage.present_days,
                    half_days: wage.half_days,
                    leave_days: wage.leave_days,
                    absent_days: wage.absent_days,
                    total_daily_wage: wage.total_daily_wage,
                    total_overtime: wage.total_overtime,
                    total_fine: wage.total_fine,
                    attendance_net: wage.net_amount,
                },
                bonus_fine: {
                    total_bonus: bonusFine.total_bonus,
                    total_fine: bonusFine.total_fine,
                    items: bonusFine.items,
                },
            },
        });
    } catch (error) {
        console.error("Payslip preview error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to preview payslip",
            error: error.message,
        });
    }
});

/**
 * POST /salary/payslip/generate
 * Body: { username, month, year, remark? }
 * Posts monthly salary to staff ledger via reserved Salary expense (discount-style).
 * Registry key: username + month + year (not salary_id).
 */
router.post("/payslip/generate", auth, validateBranch, async (req, res) => {
    const connection = await pool.getConnection();
    try {
        const actor = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;
        const username = String(req.body?.username || "").trim();
        const remarkVal =
            req.body?.remark != null
                ? String(req.body.remark).trim()
                : null;
        const parsed = parseMonthYear(req.body?.month, req.body?.year);

        if (!actor) {
            return res.status(400).json({ success: false, message: "Missing required header: username" });
        }
        if (!username) {
            return res.status(400).json({ success: false, message: "username is required" });
        }
        if (!parsed.valid) {
            return res.status(400).json({ success: false, message: parsed.message });
        }

        const okStaff = await assertStaffOnBranch(branch_id, username);
        if (!okStaff) {
            return res.status(404).json({ success: false, message: "Staff not found in this branch" });
        }

        const { monthNum, yearNum, startDate, endDate } = parsed;
        const txnDate = resolvePayslipTransactionDate(endDate);
        const monthLabel = `${MONTH_NAMES[monthNum - 1]} ${yearNum}`;
        const defaultRemark = remarkVal || `Salary for ${monthLabel}`;

        await connection.beginTransaction();

        const [existingRows] = await connection.query(
            `SELECT *
             FROM payslip_entries
             WHERE branch_id = ? AND username = ? AND year = ? AND month = ? AND is_deleted = '0'
             LIMIT 1
             FOR UPDATE`,
            [branch_id, username, yearNum, monthNum]
        );
        const existing = existingRows[0] || null;

        // Persist leave full-day wages so attendance + ledger stay consistent
        const wage = await computeMonthAttendanceWage(connection, {
            branch_id,
            username,
            startDate,
            endDate,
            persistFixes: true,
        });
        const bonusFine = await sumMonthBonusFine(connection, {
            branch_id,
            username,
            year: yearNum,
            month: monthNum,
            includeItems: false,
        });
        const amountNum = Math.abs(computePayslipPayable(wage, bonusFine));
        if (!(amountNum > 0)) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "No payable salary for this month (net amount is zero)",
                data: {
                    attendance_summary: wage,
                    bonus_fine: {
                        total_bonus: bonusFine.total_bonus,
                        total_fine: bonusFine.total_fine,
                    },
                },
            });
        }

        const itemIdVal = await ensureSalaryExpenseItem(connection, branch_id, actor);

        // Regenerate: update existing invoice / transaction / expense / payslip amounts
        if (existing) {
            const previousAmount = Number(existing.amount) || 0;
            await connection.query(
                `UPDATE invoice
                 SET subtotal = ?, total = ?, grand_total = ?, modify_by = ?
                 WHERE invoice_id = ? AND branch_id = ?`,
                [amountNum, amountNum, amountNum, actor, existing.invoice_id, branch_id]
            );
            await connection.query(
                `UPDATE transactions
                 SET amount = ?, transaction_date = ?, remark = ?, modify_by = ?
                 WHERE transaction_id = ? AND branch_id = ?`,
                [amountNum, txnDate, defaultRemark, actor, existing.transaction_id, branch_id]
            );
            await connection.query(
                `UPDATE expense_entries
                 SET amount = ?, expense_date = ?, remark = ?, modify_by = ?
                 WHERE expense_id = ? AND branch_id = ?`,
                [
                    amountNum,
                    txnDate,
                    defaultRemark,
                    actor,
                    existing.expense_id,
                    branch_id,
                ]
            );
            await connection.query(
                `UPDATE expense_entries_items
                 SET amount = ?, remark = ?, item_id = ?
                 WHERE expense_id = ? AND branch_id = ?`,
                [amountNum, defaultRemark, itemIdVal, existing.expense_id, branch_id]
            );
            await connection.query(
                `UPDATE payslip_entries
                 SET amount = ?, payslip_date = ?, remark = ?, modify_by = ?, modify_date = NOW()
                 WHERE payslip_id = ? AND branch_id = ? AND is_deleted = '0'`,
                [amountNum, txnDate, defaultRemark, actor, existing.payslip_id, branch_id]
            );

            await connection.commit();

            return res.status(200).json({
                success: true,
                message: `Salary regenerated for ${monthLabel}`,
                data: {
                    ...mapPayslipRow(
                        {
                            ...existing,
                            amount: amountNum,
                            payable_amount: amountNum,
                            payslip_date: txnDate,
                            remark: defaultRemark,
                        },
                        wage
                    ),
                    regenerated: true,
                    previous_amount: previousAmount,
                    amount_delta: Number((amountNum - previousAmount).toFixed(2)),
                },
            });
        }

        const [invoicePrefixRows] = await connection.query(
            "SELECT * FROM `invoice_prefix` WHERE `branch_id` = ? AND `type` = ? AND `is_deleted` = ? AND `issue_date` <= ? AND `expire_date` >= ?",
            [branch_id, "expense", "0", TODAY_DATE(), TODAY_DATE()]
        );
        if (!invoicePrefixRows?.length) {
            await connection.rollback();
            return res.status(400).json({
                success: false,
                message: "Invoice prefix not set for expense.",
            });
        }

        const invoiceData = invoicePrefixRows[0];
        const invoicePrimaryId = invoiceData?.id;
        const serial = Number(invoiceData?.current || 0) + 1;
        const invoice_no = `${invoiceData?.prefix}${serial}`;

        const transaction_id = await UNIQUE_RANDOM_STRING("transactions", "transaction_id", {
            length: ID_LENGTH,
            conn: connection,
        });
        const invoice_id = await UNIQUE_RANDOM_STRING("invoice", "invoice_id", {
            length: ID_LENGTH,
            conn: connection,
        });
        const expense_id = await UNIQUE_RANDOM_STRING("expense_entries", "expense_id", {
            length: ID_LENGTH,
            conn: connection,
        });
        const payslip_id = await UNIQUE_RANDOM_STRING("payslip_entries", "payslip_id", {
            length: ID_LENGTH,
            conn: connection,
            prefix: "PSL",
        });

        await connection.query(
            `INSERT INTO invoice (
                invoice_id, branch_id, invoice_no, create_by, modify_by, type, transaction_id,
                subtotal, discount_type, discount_perc_rate, discount_value,
                additional_charge, total, round_off, grand_total
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
                invoice_id,
                branch_id,
                invoice_no,
                actor,
                actor,
                "expense",
                transaction_id,
                amountNum,
                "not applicable",
                0,
                0,
                0,
                amountNum,
                0,
                amountNum,
            ]
        );

        await connection.query(
            `INSERT INTO transactions (
                branch_id, transaction_id, create_by, modify_by, transaction_date,
                amount, transaction_type, invoice_id, invoice_no,
                party1_type, party1_id, remark
             )
             VALUES (?, ?, ?, ?, ?, ?, 'expense', ?, ?, 'staff', ?, ?)`,
            [
                branch_id,
                transaction_id,
                actor,
                actor,
                txnDate,
                amountNum,
                invoice_id,
                invoice_no,
                username,
                defaultRemark,
            ]
        );

        await connection.query(
            `INSERT INTO expense_entries (
                branch_id, expense_id, create_by, modify_by, expense_date,
                party_type, party_id, amount, invoice_id, invoice_no, transaction_id, remark
             )
             VALUES (?, ?, ?, ?, ?, 'staff', ?, ?, ?, ?, ?, ?)`,
            [
                branch_id,
                expense_id,
                actor,
                actor,
                txnDate,
                username,
                amountNum,
                invoice_id,
                invoice_no,
                transaction_id,
                defaultRemark,
            ]
        );

        await connection.query(
            `INSERT INTO expense_entries_items (
                branch_id, item_id, expense_id, invoice_id, amount, remark
             )
             VALUES (?, ?, ?, ?, ?, ?)`,
            [branch_id, itemIdVal, expense_id, invoice_id, amountNum, defaultRemark]
        );

        await connection.query(
            `INSERT INTO payslip_entries (
                branch_id, payslip_id, create_by, modify_by,
                username, year, month, amount, payslip_date,
                invoice_id, invoice_no, transaction_id, expense_id, remark, is_deleted
             )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0')`,
            [
                branch_id,
                payslip_id,
                actor,
                actor,
                username,
                yearNum,
                monthNum,
                amountNum,
                txnDate,
                invoice_id,
                invoice_no,
                transaction_id,
                expense_id,
                defaultRemark,
            ]
        );

        await connection.query(
            "UPDATE `invoice_prefix` SET `current` = ? WHERE `id` = ?",
            [serial, invoicePrimaryId]
        );

        await connection.commit();

        return res.status(200).json({
            success: true,
            message: `Salary generated for ${monthLabel}`,
            data: {
                ...mapPayslipRow(
                    {
                        payslip_id,
                        username,
                        year: yearNum,
                        month: monthNum,
                        amount: amountNum,
                        payable_amount: amountNum,
                        payslip_date: txnDate,
                        invoice_id,
                        invoice_no,
                        transaction_id,
                        expense_id,
                        remark: defaultRemark,
                        create_date: null,
                        modify_date: null,
                    },
                    wage
                ),
                regenerated: false,
            },
        });
    } catch (error) {
        try {
            await connection.rollback();
        } catch (_) { /* ignore */ }
        console.error("Payslip generate error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to generate payslip",
            error: error.message,
        });
    } finally {
        connection.release();
    }
});

/**
 * GET /salary/payslip/download?payslip_id=
 * Streams a PDF payslip for a generated entry.
 */
router.get("/payslip/download", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const payslip_id = String(req.query.payslip_id || "").trim();
        if (!payslip_id) {
            return res.status(400).json({ success: false, message: "payslip_id is required" });
        }

        const [rows] = await pool.query(
            `SELECT *
             FROM payslip_entries
             WHERE branch_id = ? AND payslip_id = ? AND is_deleted = '0'
             LIMIT 1`,
            [branch_id, payslip_id]
        );
        const pe = rows[0];
        if (!pe) {
            return res.status(404).json({ success: false, message: "Payslip not found" });
        }

        const okStaff = await assertStaffOnBranch(branch_id, pe.username);
        if (!okStaff) {
            return res.status(404).json({ success: false, message: "Staff not found in this branch" });
        }

        const parsed = parseMonthYear(pe.month, pe.year);
        if (!parsed.valid) {
            return res.status(400).json({ success: false, message: parsed.message });
        }
        const { monthNum, yearNum, startDate, endDate } = parsed;

        const [staffProfile, branchRows, wage, bonusFine] = await Promise.all([
            getStaffProfile(pe.username, branch_id),
            pool.query(
                `SELECT
                    bl.name AS branch_name,
                    bl.invoice_address,
                    bl.mobile_1,
                    bl.email_1,
                    bl.address_line_1,
                    bl.address_line_2,
                    bl.city,
                    bl.state,
                    bl.country,
                    bl.pincode
                 FROM branch_list bl
                 WHERE bl.branch_id = ?
                 ORDER BY bl.id ASC
                 LIMIT 1`,
                [branch_id]
            ),
            // Recompute leave as full day wage for PDF day table + summary
            computeMonthAttendanceWage(pool, {
                branch_id,
                username: pe.username,
                startDate,
                endDate,
                includeDays: true,
            }),
            sumMonthBonusFine(pool, {
                branch_id,
                username: pe.username,
                year: yearNum,
                month: monthNum,
                includeItems: true,
            }),
        ]);

        const branchRow = branchRows[0]?.[0] || {};
        const address = [
            branchRow.invoice_address || null,
            branchRow.address_line_1,
            branchRow.address_line_2,
            branchRow.city,
            branchRow.state,
            branchRow.country,
            branchRow.pincode,
        ]
            .filter((x) => x != null && String(x).trim() !== "")
            .join(", ");

        const pdfBuffer = await buildPayslipPdfBuffer({
            branch: {
                name: branchRow.branch_name || "Organization",
                address,
                mobile: branchRow.mobile_1 || null,
                email: branchRow.email_1 || null,
            },
            staff: {
                name: staffProfile?.name || pe.username,
                designation: staffProfile?.designation || null,
                mobile: staffProfile?.mobile || null,
                country_code: staffProfile?.country_code || null,
                email: staffProfile?.email || null,
            },
            payslip: {
                payslip_id: pe.payslip_id,
                username: pe.username,
                year: yearNum,
                month: monthNum,
                month_name: MONTH_NAMES[monthNum - 1],
                amount: Number(pe.amount) || 0,
                payslip_date: pe.payslip_date,
                invoice_no: pe.invoice_no,
                remark: pe.remark,
            },
            summary: {
                ...wage,
                total_bonus: bonusFine.total_bonus,
                month_fine: bonusFine.total_fine,
            },
            bonus_fine: bonusFine,
            days: wage.days || [],
        });

        const safeMonth = String(MONTH_NAMES[monthNum - 1] || monthNum).replace(/\s+/g, "-");
        const filename = `Payslip-${safeMonth}-${yearNum}.pdf`;
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
        res.setHeader("Content-Length", pdfBuffer.length);
        res.setHeader("Cache-Control", "no-store");
        return res.send(pdfBuffer);
    } catch (error) {
        console.error("Payslip download error:", error);
        if (!res.headersSent) {
            return res.status(500).json({
                success: false,
                message: "Failed to download payslip",
                error: error.message,
            });
        }
    }
});

// ==================== STAFF BONUS / FINE (month-scoped) ====================

/**
 * GET /salary/bonus-fine/list?username=&type?=
 */
router.get("/bonus-fine/list", auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const username = String(req.query.username || "").trim();
        const typeFilter = String(req.query.type || "").trim().toLowerCase();

        if (!username) {
            return res.status(400).json({ success: false, message: "username is required" });
        }
        if (typeFilter && !["bonus", "fine"].includes(typeFilter)) {
            return res.status(400).json({ success: false, message: "type must be bonus or fine" });
        }

        const okStaff = await assertStaffOnBranch(branch_id, username);
        if (!okStaff) {
            return res.status(404).json({ success: false, message: "Staff not found in this branch" });
        }

        const params = [branch_id, username];
        let typeClause = "";
        if (typeFilter) {
            typeClause = " AND bf.type = ?";
            params.push(typeFilter);
        }

        const [rows] = await pool.query(
            `SELECT
                bf.*,
                p.name AS create_by_name,
                p.mobile AS create_by_mobile,
                p.country_code AS create_by_country_code
             FROM staff_bonus_fine bf
             LEFT JOIN profile p
               ON p.username COLLATE utf8mb4_unicode_ci = bf.create_by COLLATE utf8mb4_unicode_ci
             WHERE bf.branch_id = ? AND bf.username = ? AND bf.is_deleted = '0'${typeClause}
             ORDER BY bf.year DESC, bf.month DESC, bf.create_date DESC`,
            params
        );

        const entries = rows.map(mapBonusFineRow);
        const total_bonus = entries
            .filter((e) => e.type === "bonus")
            .reduce((s, e) => s + e.amount, 0);
        const total_fine = entries
            .filter((e) => e.type === "fine")
            .reduce((s, e) => s + e.amount, 0);

        return res.status(200).json({
            success: true,
            message: "Bonus/fine list retrieved",
            data: {
                username,
                entries,
                summary: {
                    count: entries.length,
                    total_bonus: Number(total_bonus.toFixed(2)),
                    total_fine: Number(total_fine.toFixed(2)),
                    net: Number((total_bonus - total_fine).toFixed(2)),
                },
            },
        });
    } catch (error) {
        console.error("Bonus/fine list error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to list bonus/fine entries",
            error: error.message,
        });
    }
});

/**
 * POST /salary/bonus-fine/create
 * Body: { username, type: 'bonus'|'fine', month, year, amount, remark }
 */
router.post("/bonus-fine/create", auth, validateBranch, async (req, res) => {
    try {
        const actor = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;
        const username = String(req.body?.username || "").trim();
        const type = String(req.body?.type || "").trim().toLowerCase();
        const remark = String(req.body?.remark || "").trim();
        const amountNum = Math.abs(Number(req.body?.amount) || 0);
        const parsed = parseMonthYear(req.body?.month, req.body?.year);

        if (!actor) {
            return res.status(400).json({ success: false, message: "Missing required header: username" });
        }
        if (!username) {
            return res.status(400).json({ success: false, message: "username is required" });
        }
        if (!["bonus", "fine"].includes(type)) {
            return res.status(400).json({ success: false, message: "type must be bonus or fine" });
        }
        if (!parsed.valid) {
            return res.status(400).json({ success: false, message: parsed.message });
        }
        if (!(amountNum > 0)) {
            return res.status(400).json({ success: false, message: "amount must be greater than 0" });
        }
        if (!remark) {
            return res.status(400).json({ success: false, message: "remark is required" });
        }

        const okStaff = await assertStaffOnBranch(branch_id, username);
        if (!okStaff) {
            return res.status(404).json({ success: false, message: "Staff not found in this branch" });
        }

        const entry_id = await UNIQUE_RANDOM_STRING("staff_bonus_fine", "entry_id", {
            prefix: type === "bonus" ? "BNS" : "FNE",
            length: ID_LENGTH,
        });

        await insertRow("staff_bonus_fine", {
            branch_id,
            entry_id,
            create_by: actor,
            modify_by: actor,
            username,
            type,
            year: parsed.yearNum,
            month: parsed.monthNum,
            amount: amountNum,
            remark,
            is_deleted: "0",
        });

        const [rows] = await pool.query(
            `SELECT * FROM staff_bonus_fine WHERE entry_id = ? AND branch_id = ? LIMIT 1`,
            [entry_id, branch_id]
        );

        return res.status(200).json({
            success: true,
            message: `${type === "bonus" ? "Bonus" : "Fine"} added`,
            data: mapBonusFineRow(rows[0]),
        });
    } catch (error) {
        console.error("Bonus/fine create error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to create bonus/fine entry",
            error: error.message,
        });
    }
});

/**
 * POST /salary/bonus-fine/update
 * Body: { entry_id, type?, month?, year?, amount?, remark? }
 */
router.post("/bonus-fine/update", auth, validateBranch, async (req, res) => {
    try {
        const actor = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;
        const entry_id = String(req.body?.entry_id || "").trim();

        if (!actor) {
            return res.status(400).json({ success: false, message: "Missing required header: username" });
        }
        if (!entry_id) {
            return res.status(400).json({ success: false, message: "entry_id is required" });
        }

        const [existingRows] = await pool.query(
            `SELECT * FROM staff_bonus_fine
             WHERE entry_id = ? AND branch_id = ? AND is_deleted = '0'
             LIMIT 1`,
            [entry_id, branch_id]
        );
        const existing = existingRows[0];
        if (!existing) {
            return res.status(404).json({ success: false, message: "Entry not found" });
        }

        let type = existing.type;
        if (req.body?.type != null) {
            type = String(req.body.type).trim().toLowerCase();
            if (!["bonus", "fine"].includes(type)) {
                return res.status(400).json({ success: false, message: "type must be bonus or fine" });
            }
        }

        let yearNum = Number(existing.year);
        let monthNum = Number(existing.month);
        if (req.body?.month != null || req.body?.year != null) {
            const parsed = parseMonthYear(
                req.body?.month != null ? req.body.month : monthNum,
                req.body?.year != null ? req.body.year : yearNum
            );
            if (!parsed.valid) {
                return res.status(400).json({ success: false, message: parsed.message });
            }
            yearNum = parsed.yearNum;
            monthNum = parsed.monthNum;
        }

        let amountNum = Number(existing.amount) || 0;
        if (req.body?.amount != null) {
            amountNum = Math.abs(Number(req.body.amount) || 0);
            if (!(amountNum > 0)) {
                return res.status(400).json({ success: false, message: "amount must be greater than 0" });
            }
        }

        let remark = existing.remark;
        if (req.body?.remark != null) {
            remark = String(req.body.remark).trim();
            if (!remark) {
                return res.status(400).json({ success: false, message: "remark is required" });
            }
        }

        await pool.query(
            `UPDATE staff_bonus_fine
             SET type = ?, year = ?, month = ?, amount = ?, remark = ?, modify_by = ?
             WHERE entry_id = ? AND branch_id = ? AND is_deleted = '0'`,
            [type, yearNum, monthNum, amountNum, remark, actor, entry_id, branch_id]
        );

        const [rows] = await pool.query(
            `SELECT * FROM staff_bonus_fine WHERE entry_id = ? AND branch_id = ? LIMIT 1`,
            [entry_id, branch_id]
        );

        return res.status(200).json({
            success: true,
            message: "Entry updated",
            data: mapBonusFineRow(rows[0]),
        });
    } catch (error) {
        console.error("Bonus/fine update error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to update bonus/fine entry",
            error: error.message,
        });
    }
});

/**
 * POST /salary/bonus-fine/delete
 * Body: { entry_id }
 */
router.post("/bonus-fine/delete", auth, validateBranch, async (req, res) => {
    try {
        const actor = req.headers["username"] || req.headers["Username"] || "";
        const branch_id = req.branch_id;
        const entry_id = String(req.body?.entry_id || "").trim();

        if (!actor) {
            return res.status(400).json({ success: false, message: "Missing required header: username" });
        }
        if (!entry_id) {
            return res.status(400).json({ success: false, message: "entry_id is required" });
        }

        const [result] = await pool.query(
            `UPDATE staff_bonus_fine
             SET is_deleted = '1', deleted_by = ?, modify_by = ?
             WHERE entry_id = ? AND branch_id = ? AND is_deleted = '0'`,
            [actor, actor, entry_id, branch_id]
        );

        if (!result.affectedRows) {
            return res.status(404).json({ success: false, message: "Entry not found" });
        }

        return res.status(200).json({
            success: true,
            message: "Entry deleted",
            data: { entry_id },
        });
    } catch (error) {
        console.error("Bonus/fine delete error:", error);
        return res.status(500).json({
            success: false,
            message: "Failed to delete bonus/fine entry",
            error: error.message,
        });
    }
});

export default router;
