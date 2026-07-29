import express from 'express';
const router = express.Router();
import PDFDocument from 'pdfkit';
import { Readable } from 'stream';
import pool from "../db.js";
import { auth, validateBranch, checkSubscription, requireFeature } from "../middleware/auth.js";
import { UNIQUE_RANDOM_STRING, RANDOM_STRING, USER_DATA, ID_LENGTH } from "../helpers/function.js";
import { buildProfileImageUrl } from "../helpers/mediaUrl.js";

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

// Helper function to validate effective date (prevent past month changes)
async function validateEffectiveDate(username, branch_id, effective_from) {
    const effectiveDate = new Date(effective_from);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    
    // Can't set salary for past dates
    if (effectiveDate < today) {
        return {
            valid: false,
            message: 'Cannot set salary for past dates. Effective from must be today or future date'
        };
    }
    
    // Check if there's already a salary for the current month
    const [existing] = await pool.query(
        `SELECT effective_from FROM staff_salary 
         WHERE username = ? AND branch_id = ? 
         AND YEAR(effective_from) = ? AND MONTH(effective_from) = ?
         AND is_deleted = '0'`,
        [username, branch_id, effectiveDate.getFullYear(), effectiveDate.getMonth() + 1]
    );
    
    if (existing.length > 0) {
        return {
            valid: false,
            message: `Salary already exists for ${effectiveDate.toLocaleString('default', { month: 'long' })} ${effectiveDate.getFullYear()}. Please update existing record.`
        };
    }
    
    return { valid: true };
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
    try {
        const admin_username = req.headers["username"];
        const branch_id = req.branch_id;
        const { 
            username, 
            monthly_salary, 
            effective_from,
            working_hours_start = "10:00:00",
            working_hours_end = "18:00:00",
            expected_hours = 8,
            grace_period_minutes = 10,
            overtime_rate_type = "daily",
            fine_rate_type = "daily",
            overtime_enabled,
            fine_enabled,
            // New break fields
            allowed_break_minutes = 30,
            break_excess_penalty_type = "fixed",
            break_excess_penalty_value = 0,
            // New adjustment fields
            travel_allowance_type = "fixed",
            travel_allowance_value = 0,
            other_deduction_type = "percentage",
            other_deduction_value = 0
        } = req.body;

        // Handle boolean values
        const isOvertimeEnabled = overtime_enabled === true || overtime_enabled === 'true' || overtime_enabled === 1;
        const isFineEnabled = fine_enabled === true || fine_enabled === 'true' || fine_enabled === 1;

        if (!admin_username) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        if (!username || !monthly_salary || !effective_from) {
            return res.status(400).json({
                success: false,
                message: 'Username, monthly_salary, and effective_from are required'
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

        // Check if effective date is today or future
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const effectiveDate = new Date(effective_from);
        effectiveDate.setHours(0, 0, 0, 0);
        
        // Check if date is in the past
        if (effectiveDate < today) {
            return res.status(400).json({
                success: false,
                message: 'Cannot set salary for past dates. Effective from must be today or future date'
            });
        }
        
        // Check if salary already exists for this month
        const [existing] = await pool.query(
            `SELECT * FROM staff_salary 
             WHERE username = ? AND branch_id = ? 
             AND YEAR(effective_from) = ? AND MONTH(effective_from) = ?
             AND is_deleted = '0'`,
            [username, branch_id, effectiveDate.getFullYear(), effectiveDate.getMonth() + 1]
        );

        if (existing.length > 0) {
            return res.status(400).json({
                success: false,
                message: `Salary already exists for ${effectiveDate.toLocaleString('default', { month: 'long' })} ${effectiveDate.getFullYear()}.`
            });
        }

        // Determine if this salary should be active now
        const isActiveNow = effectiveDate <= today;
        
        // If new salary is active now, deactivate current active salary
        if (isActiveNow) {
            await pool.query(
                `UPDATE staff_salary 
                 SET is_active = '0', 
                     effective_to = DATE_SUB(?, INTERVAL 1 DAY),
                     modify_by = ?,
                     modify_date = NOW()
                 WHERE username = ? AND branch_id = ? 
                 AND is_active = '1' AND is_deleted = '0'`,
                [effective_from, admin_username, username, branch_id]
            );
        }

        // Create new salary with all fields including break and adjustment settings
        const salary_id = await UNIQUE_RANDOM_STRING("staff_salary", "salary_id", {
            prefix: "SAL",
            length: ID_LENGTH,
        });
        
        await pool.query(
            `INSERT INTO staff_salary (
                salary_id, map_id, username, branch_id, monthly_salary, effective_from,
                working_hours_start, working_hours_end, expected_hours, grace_period_minutes,
                overtime_rate_type, fine_rate_type, overtime_enabled, fine_enabled,
                allowed_break_minutes, break_excess_penalty_type, break_excess_penalty_value,
                travel_allowance_type, travel_allowance_value,
                other_deduction_type, other_deduction_value,
                is_active, create_by, modify_by, is_deleted
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0')`,
            [
                salary_id,
                mapping[0].map_id,
                username,
                branch_id,
                monthly_salary,
                effective_from,
                working_hours_start,
                working_hours_end,
                expected_hours,
                grace_period_minutes,
                overtime_rate_type,
                fine_rate_type,
                isOvertimeEnabled ? '1' : '0',
                isFineEnabled ? '1' : '0',
                allowed_break_minutes,
                break_excess_penalty_type,
                break_excess_penalty_value,
                travel_allowance_type,
                travel_allowance_value,
                other_deduction_type,
                other_deduction_value,
                isActiveNow ? '1' : '0',
                admin_username,
                admin_username
            ]
        );

        // Get staff profile
        const profile = await getStaffProfile(username, branch_id);

        // Calculate derived values for response
        const perDaySalary = monthly_salary / 30;
        const perMinuteSalary = perDaySalary / (expected_hours * 60);

        return res.status(200).json({
            success: true,
            message: isActiveNow ? 'Salary set successfully' : 'Salary scheduled for future date',
            data: {
                salary_id,
                username,
                monthly_salary: parseFloat(monthly_salary),
                effective_from,
                is_active: isActiveNow,
                status: isActiveNow ? 'active' : 'scheduled',
                
                // Working hours configuration
                working_hours: {
                    start: working_hours_start,
                    end: working_hours_end,
                    expected_hours: parseFloat(expected_hours),
                    expected_minutes: expected_hours * 60,
                    grace_period_minutes: parseInt(grace_period_minutes)
                },
                
                // Overtime & Fine settings
                overtime_settings: {
                    enabled: isOvertimeEnabled,
                    rate_type: overtime_rate_type
                },
                fine_settings: {
                    enabled: isFineEnabled,
                    rate_type: fine_rate_type
                },
                
                // Break settings
                break_settings: {
                    allowed_break_minutes: parseInt(allowed_break_minutes),
                    excess_penalty_type: break_excess_penalty_type,
                    excess_penalty_value: parseFloat(break_excess_penalty_value),
                    penalty_per_minute: break_excess_penalty_type === 'fixed' 
                        ? parseFloat(break_excess_penalty_value)
                        : (parseFloat(break_excess_penalty_value) / 100) * perMinuteSalary
                },
                
                // Travel allowance settings
                travel_allowance: {
                    type: travel_allowance_type,
                    value: parseFloat(travel_allowance_value),
                    amount_per_day: travel_allowance_type === 'fixed' 
                        ? parseFloat(travel_allowance_value)
                        : (parseFloat(travel_allowance_value) / 100) * perDaySalary
                },
                
                // Other deductions settings
                other_deductions: {
                    type: other_deduction_type,
                    value: parseFloat(other_deduction_value),
                    amount_per_day: other_deduction_type === 'fixed' 
                        ? parseFloat(other_deduction_value)
                        : (parseFloat(other_deduction_value) / 100) * perDaySalary
                },
                
                // Salary calculation rates
                calculation_rates: {
                    per_day: perDaySalary.toFixed(2),
                    per_hour: (perDaySalary / expected_hours).toFixed(2),
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
        console.error('Set salary error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to set salary',
            error: error.message
        });
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

        const [salary] = await pool.query(
            `SELECT 
                ss.id,
                ss.salary_id,
                ss.map_id,
                ss.username,
                ss.branch_id,
                ss.monthly_salary,
                ss.effective_from,
                ss.effective_to,
                ss.is_active,
                ss.create_by,
                ss.modify_by,
                ss.create_date,
                ss.modify_date,
                ss.working_hours_start,
                ss.working_hours_end,
                ss.expected_hours,
                ss.grace_period_minutes,
                ss.overtime_rate_type,
                ss.fine_rate_type,
                ss.overtime_enabled,
                ss.fine_enabled,
                ss.allowed_break_minutes,
                ss.break_excess_penalty_type,
                ss.break_excess_penalty_value,
                ss.travel_allowance_type,
                ss.travel_allowance_value,
                ss.other_deduction_type,
                ss.other_deduction_value,
                p.name as staff_name,
                p.email,
                p.mobile,
                p.image,
                bm.designation
             FROM staff_salary ss
             INNER JOIN branch_mapping bm ON ss.map_id = bm.map_id
             INNER JOIN profile p ON ss.username = p.username
             WHERE ss.username = ? AND ss.branch_id = ? AND ss.is_deleted = '0'
             ORDER BY ss.effective_from DESC`,
            [username, branch_id]
        );

        const profile = await getStaffProfile(username, branch_id);

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        let activeSalary = null;
        const scheduledSalaries = [];
        const expiredSalaries = [];

        for (const s of salary) {
            const effectiveDate = new Date(s.effective_from);
            effectiveDate.setHours(0, 0, 0, 0);
            
            const isExpired = s.effective_to && new Date(s.effective_to) < today;
            const isFuture = effectiveDate > today;
            const isActiveInDb = s.is_active === '1' || s.is_active === 1;
            const isCurrentlyActive = effectiveDate <= today && !isExpired && isActiveInDb;
            
            const monthlySalary = parseFloat(s.monthly_salary);
            const perDaySalary = monthlySalary / 30;
            const expectedHours = parseFloat(s.expected_hours) || 8;
            const perMinuteSalary = perDaySalary / (expectedHours * 60);
            
            // FIX: Proper boolean conversion for overtime_enabled
            let overtimeEnabled = false;
            if (s.overtime_enabled === '1' || s.overtime_enabled === 1 || s.overtime_enabled === true) {
                overtimeEnabled = true;
            }
            
            // FIX: Proper boolean conversion for fine_enabled
            let fineEnabled = false;
            if (s.fine_enabled === '1' || s.fine_enabled === 1 || s.fine_enabled === true) {
                fineEnabled = true;
            }
            
            const salaryData = {
                id: s.id,
                salary_id: s.salary_id,
                username: s.username,
                monthly_salary: monthlySalary,
                effective_from: s.effective_from,
                effective_to: s.effective_to,
                status: isCurrentlyActive ? 'active' : (isFuture ? 'scheduled' : 'expired'),
                
                working_hours: {
                    start: s.working_hours_start || '09:00:00',
                    end: s.working_hours_end || '18:00:00',
                    expected_hours: expectedHours,
                    expected_minutes: expectedHours * 60,
                    grace_period_minutes: parseInt(s.grace_period_minutes) || 10
                },
                
                overtime_settings: {
                    enabled: overtimeEnabled,  // FIXED
                    rate_type: s.overtime_rate_type || 'daily'
                },
                
                fine_settings: {
                    enabled: fineEnabled,  // FIXED
                    rate_type: s.fine_rate_type || 'daily'
                },
                
                break_settings: {
                    allowed_break_minutes: parseInt(s.allowed_break_minutes) || 30,
                    excess_penalty_type: s.break_excess_penalty_type || 'fixed',
                    excess_penalty_value: parseFloat(s.break_excess_penalty_value || 0),
                    penalty_per_minute: s.break_excess_penalty_type === 'fixed' 
                        ? parseFloat(s.break_excess_penalty_value || 0)
                        : (parseFloat(s.break_excess_penalty_value || 0) / 100) * perMinuteSalary
                },
                
                travel_allowance: {
                    type: s.travel_allowance_type || 'fixed',
                    value: parseFloat(s.travel_allowance_value || 0),
                    amount_per_day: s.travel_allowance_type === 'fixed' 
                        ? parseFloat(s.travel_allowance_value || 0)
                        : (parseFloat(s.travel_allowance_value || 0) / 100) * perDaySalary
                },
                
                other_deductions: {
                    type: s.other_deduction_type || 'percentage',
                    value: parseFloat(s.other_deduction_value || 0),
                    amount_per_day: s.other_deduction_type === 'fixed' 
                        ? parseFloat(s.other_deduction_value || 0)
                        : (parseFloat(s.other_deduction_value || 0) / 100) * perDaySalary
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

router.post('/admin/set-weekly-off', auth, validateBranch, async (req, res) => {
    try {
        const admin_username = req.headers["username"];
        const branch_id = req.branch_id;
        const { username, weekly_off_day, is_active } = req.body;

        if (!admin_username) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        // Validate required fields
        if (!username) {
            return res.status(400).json({
                success: false,
                message: 'Username is required'
            });
        }

        if (!weekly_off_day) {
            return res.status(400).json({
                success: false,
                message: 'Weekly off day is required'
            });
        }

        // Validate weekly off day
        const validDays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
        if (!validDays.includes(weekly_off_day)) {
            return res.status(400).json({
                success: false,
                message: `Invalid day. Valid days are: ${validDays.join(', ')}`
            });
        }

        // Check if staff exists in branch
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

        // Check if weekly off already exists for this employee
        const [existing] = await pool.query(
            `SELECT * FROM employee_weekly_off 
             WHERE username = ? AND branch_id = ? AND is_deleted = '0'`,
            [username, branch_id]
        );

        let result;
        if (existing.length > 0) {
            // Update existing weekly off
            await pool.query(
                `UPDATE employee_weekly_off 
                 SET weekly_off_day = ?,
                     is_active = ?,
                     modified_by = ?,
                     modified_date = NOW()
                 WHERE username = ? AND branch_id = ? AND is_deleted = '0'`,
                [weekly_off_day, is_active || '1', admin_username, username, branch_id]
            );
        } else {
            // Create new weekly off
            const off_id = await UNIQUE_RANDOM_STRING("employee_weekly_off", "off_id", {
                prefix: "WOF",
                length: ID_LENGTH,
            });
            
            await insertRow("employee_weekly_off", {
                off_id,
                map_id: mapping[0].map_id,
                username,
                branch_id,
                weekly_off_day,
                is_active: is_active || '1',
                created_by: admin_username,
                modified_by: admin_username,
                created_date: new Date(),
                modified_date: new Date(),
                is_deleted: '0'
            });
        }

        // Get staff profile for response
        const profile = await getStaffProfile(username, branch_id);

        return res.status(200).json({
            success: true,
            message: `Weekly off day set to ${weekly_off_day} for ${username}`,
            data: {
                username,
                profile: profile ? {
                    name: profile.name,
                    email: profile.email,
                    mobile: profile.mobile,
                    designation: profile.designation,
                    image: buildProfileImageUrl(profile.image)
                } : null,
                weekly_off_day: weekly_off_day,
                is_active: is_active || '1'
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

        // Get weekly off for employee
        const [weeklyOff] = await pool.query(
            `SELECT * FROM employee_weekly_off 
             WHERE username = ? AND branch_id = ? AND is_deleted = '0'`,
            [username, branch_id]
        );

        const profile = await getStaffProfile(username, branch_id);

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
                weekly_off: weeklyOff.length > 0 ? {
                    weekly_off_day: weeklyOff[0].weekly_off_day,
                    is_active: weeklyOff[0].is_active === '1'
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

        const [salaryData] = await pool.query(
            `SELECT monthly_salary, effective_from, salary_id
             FROM staff_salary 
             WHERE username = ? AND branch_id = ? 
             AND is_active = '1' AND is_deleted = '0'
             AND effective_from <= ?
             ORDER BY effective_from DESC LIMIT 1`,
            [staff_username, branch_id, endDate]
        );

        const monthlySalary = salaryData.length > 0 ? parseFloat(salaryData[0].monthly_salary) : 0;
        const perDaySalary = monthlySalary / 30;
        const perMinuteSalary = perDaySalary / 480;

        const [weeklyOff] = await pool.query(
            `SELECT weekly_off_day 
             FROM employee_weekly_off 
             WHERE username = ? AND branch_id = ? AND is_active = '1' AND is_deleted = '0'`,
            [staff_username, branch_id]
        );

        const weeklyOffDay = weeklyOff.length > 0 ? weeklyOff[0].weekly_off_day : null;

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
            
            const isWeeklyOff = weeklyOffDay === dayOfWeek;
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
                    switch(status) {
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
                salary_id,
                monthly_salary,
                effective_from,
                effective_to,
                is_active
             FROM staff_salary 
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
                    weekly_off_day: weeklyOffDay || 'Not Set'
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
                    per_day_salary: perDaySalary.toFixed(2),
                    per_hour_salary: (perDaySalary / 8).toFixed(2),
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

router.post('/generate-payslip', auth, validateBranch, async (req, res) => {
    try {
        const loggedInUser = req.headers["username"];
        const branch_id = req.branch_id;
        const { username, month, year } = req.body;

        if (!loggedInUser) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        if (!username || !month || !year) {
            return res.status(400).json({
                success: false,
                message: "username, month, and year are required"
            });
        }

        const monthNum = parseInt(month);
        const yearNum = parseInt(year);
        
        if (monthNum < 1 || monthNum > 12) {
            return res.status(400).json({
                success: false,
                message: "Month must be between 1 and 12"
            });
        }
        
        if (yearNum < 2000 || yearNum > 2100) {
            return res.status(400).json({
                success: false,
                message: "Invalid year"
            });
        }

        const isAdmin = await checkIfAdmin(loggedInUser, branch_id);
        const isSelf = loggedInUser === username;
        
        if (!isAdmin && !isSelf) {
            return res.status(403).json({
                success: false,
                message: "Access denied. You can only generate your own payslip"
            });
        }

        const company = await getCompanyDetails(branch_id);
        const payslipData = await getPayslipDataWithBreaksAndAdjustments(username, branch_id, monthNum, yearNum);
        const pdfBuffer = await generateStandardPayslipPDF(payslipData, company);
        
        const filename = `Salary_Slip_${payslipData.staff.name.replace(/\s/g, '_')}_${payslipData.period.month_year}.pdf`;
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        return res.send(pdfBuffer);

    } catch (error) {
        console.error('Generate Payslip Error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to generate payslip',
            error: error.message
        });
    }
});

/**
 * Generate and Download Detailed Payslip PDF (with day-wise breakdown)
 * POST /api/attendance/detailed-payslip-pdf
 */

router.post('/detailed-payslip-pdf', auth, validateBranch, async (req, res) => {
    try {
        const loggedInUser = req.headers["username"];
        const branch_id = req.branch_id;
        const { username, month, year } = req.body;

        if (!loggedInUser) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        if (!username || !month || !year) {
            return res.status(400).json({
                success: false,
                message: "username, month, and year are required"
            });
        }

        const monthNum = parseInt(month);
        const yearNum = parseInt(year);
        
        if (monthNum < 1 || monthNum > 12) {
            return res.status(400).json({
                success: false,
                message: "Month must be between 1 and 12"
            });
        }
        
        if (yearNum < 2000 || yearNum > 2100) {
            return res.status(400).json({
                success: false,
                message: "Invalid year"
            });
        }

        const isAdmin = await checkIfAdmin(loggedInUser, branch_id);
        const isSelf = loggedInUser === username;
        
        if (!isAdmin && !isSelf) {
            return res.status(403).json({
                success: false,
                message: "Access denied. You can only generate your own detailed payslip"
            });
        }

        const company = await getCompanyDetails(branch_id);
        const payslipData = await getPayslipDataWithBreaksAndAdjustments(username, branch_id, monthNum, yearNum);
        const dailyBreakdown = await getDailyBreakdownData(username, branch_id, monthNum, yearNum);
        
        const pdfBuffer = await generateDetailedPayslipPDF(payslipData, company, dailyBreakdown);
        
        const filename = `Detailed_Salary_Slip_${payslipData.staff.name.replace(/\s/g, '_')}_${payslipData.period.month_year}.pdf`;
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Length', pdfBuffer.length);
        return res.send(pdfBuffer);

    } catch (error) {
        console.error('Generate Detailed Payslip PDF Error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to generate detailed payslip PDF',
            error: error.message
        });
    }
});

export default router;
