import express from 'express';
const router = express.Router();
import PDFDocument from 'pdfkit';
import { Readable } from 'stream';
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import { UNIQUE_RANDOM_STRING, RANDOM_STRING, USER_DATA, ID_LENGTH } from "../helpers/function.js";

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

// ==================== STAFF APIs (Username in BODY) ====================

/**
 * STAFF: Punch In
 * Headers: 
 *   - Authorization: Bearer {token}
 *   - username: {admin_username} (for auth, but staff username is in body)
 * Body: { username: "staff1", latitude, longitude }
 */
router.post('/punch-in', auth, validateBranch, async (req, res) => {
    try {
        const { username, latitude, longitude } = req.body;
        const branch_id = req.branch_id;
        const loggedInUser = req.headers["username"];

        if (!username) {
            return res.status(400).json({
                success: false,
                message: "Missing required field: username in body"
            });
        }

        // Get staff mapping to verify they belong to this branch
        const [mapping] = await pool.query(
            `SELECT map_id, is_accepted 
             FROM branch_mapping 
             WHERE username = ? AND branch_id = ? AND type = 'staff' AND is_deleted = '0'`,
            [username, branch_id]
        );

        if (!mapping.length) {
            return res.status(404).json({
                success: false,
                message: 'Staff mapping not found for this branch'
            });
        }

        if (mapping[0].is_accepted !== '1') {
            return res.status(403).json({
                success: false,
                message: 'Please accept the invitation first'
            });
        }

        // Check today's attendance
        const today = new Date().toISOString().split('T')[0];
        const [todayAttendance] = await pool.query(
            `SELECT * FROM attendance 
             WHERE username = ? AND branch_id = ? AND DATE(punch_in_time) = ? AND is_deleted = '0'`,
            [username, branch_id, today]
        );

        if (todayAttendance.length > 0) {
            if (!todayAttendance[0].punch_out_time) {
                return res.status(400).json({
                    success: false,
                    message: 'Already punched in. Please punch out first.',
                    data: todayAttendance[0]
                });
            }
            return res.status(400).json({
                success: false,
                message: 'Attendance already completed for today'
            });
        }

        // Create new attendance
        const attendance_id = await UNIQUE_RANDOM_STRING("attendance", "attendance_id", {
            prefix: "ATT",
            length: ID_LENGTH,
        });
        
        await insertRow("attendance", {
            attendance_id,
            map_id: mapping[0].map_id,
            username,
            branch_id,
            punch_in_time: new Date(),
            punch_in_latitude: latitude || null,
            punch_in_longitude: longitude || null,
            expected_minutes: 480,
            attendance_status: 'pending',
            is_verified: '0',
            is_manual: '0',
            create_by: loggedInUser || username,
            modify_by: loggedInUser || username,
            is_deleted: '0'
        });

        const profile = await getStaffProfile(username, branch_id);

        return res.status(200).json({
            success: true,
            message: 'Punch In successful',
            data: { 
                attendance_id, 
                username,
                punch_in_time: new Date(),
                profile: profile ? {
                    name: profile.name,
                    email: profile.email,
                    mobile: profile.mobile,
                    designation: profile.designation,
                    image: profile.image
                } : null
            }
        });

    } catch (error) {
        console.error('Punch In error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to punch in',
            error: error.message
        });
    }
});

/**
 * STAFF: Punch Out
 * Headers: 
 *   - Authorization: Bearer {token}
 *   - username: {admin_username} (for auth)
 * Body: { username: "staff1", latitude, longitude }
 */
router.post('/punch-out', auth, validateBranch, async (req, res) => {
    try {
        const { username, latitude, longitude } = req.body;
        const branch_id = req.branch_id;
        const loggedInUser = req.headers["username"];

        if (!username) {
            return res.status(400).json({
                success: false,
                message: "Missing required field: username in body"
            });
        }

        // Find active attendance
        const [active] = await pool.query(
            `SELECT * FROM attendance 
             WHERE username = ? AND branch_id = ? AND punch_out_time IS NULL 
             AND is_deleted = '0'
             ORDER BY punch_in_time DESC LIMIT 1`,
            [username, branch_id]
        );

        if (!active.length) {
            return res.status(404).json({
                success: false,
                message: 'No active punch in found'
            });
        }

        const attendance = active[0];
        
        const punchOutTime = new Date();

        const { status, extraMinutes, lessMinutes, totalMinutes } = 
            calculateAttendanceStatus(attendance.punch_in_time, punchOutTime);

        await pool.query(
            `UPDATE attendance 
             SET punch_out_time = ?,
                 punch_out_latitude = ?,
                 punch_out_longitude = ?,
                 total_minutes = ?,
                 extra_minutes = ?,
                 less_minutes = ?,
                 attendance_status = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE attendance_id = ? AND is_deleted = '0'`,
            [
                punchOutTime,
                latitude || null,
                longitude || null,
                totalMinutes,
                extraMinutes,
                lessMinutes,
                status,
                loggedInUser || username,
                attendance.attendance_id
            ]
        );

        const profile = await getStaffProfile(username, branch_id);

        return res.status(200).json({
            success: true,
            message: 'Punch Out successful',
            data: {
                attendance_id: attendance.attendance_id,
                username,
                punch_in: attendance.punch_in_time,
                punch_out: punchOutTime,
                total_hours: (totalMinutes / 60).toFixed(2),
                status: status,
                profile: profile ? {
                    name: profile.name,
                    email: profile.email,
                    mobile: profile.mobile,
                    designation: profile.designation,
                    image: profile.image
                } : null
            }
        });

    } catch (error) {
        console.error('Punch Out error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to punch out',
            error: error.message
        });
    }
});

/**
 * STAFF: Get My Attendance
 * Headers: 
 *   - Authorization: Bearer {token}
 *   - username: {admin_username} (for auth)
 * Query: username (staff username) as query param
 */
router.get('/my-attendance', auth, validateBranch, async (req, res) => {
    try {
        const { username, month, year, from_date, to_date, page = 1, limit = 30 } = req.query;
        const branch_id = req.branch_id;

        if (!username) {
            return res.status(400).json({
                success: false,
                message: "Missing required query parameter: username"
            });
        }

        let dateFilter = '';
        let params = [username, branch_id];

        if (month && year) {
            dateFilter = 'AND MONTH(punch_in_time) = ? AND YEAR(punch_in_time) = ?';
            params.push(month, year);
        } else if (from_date && to_date) {
            dateFilter = 'AND DATE(punch_in_time) BETWEEN ? AND ?';
            params.push(from_date, to_date);
        }

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 30;
        const offset = (pageNum - 1) * limitNum;

        const [attendance] = await pool.query(
            `SELECT SQL_CALC_FOUND_ROWS 
                attendance_id,
                DATE(punch_in_time) as date,
                TIME(punch_in_time) as punch_in,
                TIME(punch_out_time) as punch_out,
                total_minutes,
                attendance_status,
                is_verified,
                calculated_amount,
                admin_remarks,
                is_manual,
                manual_reason
             FROM attendance 
             WHERE username = ? AND branch_id = ? AND is_deleted = '0'
             ${dateFilter}
             ORDER BY punch_in_time DESC
             LIMIT ? OFFSET ?`,
            [...params, limitNum, offset]
        );

        const [total] = await pool.query('SELECT FOUND_ROWS() as total');

        // Get today's status
        const [today] = await pool.query(
            `SELECT * FROM attendance 
             WHERE username = ? AND branch_id = ? 
             AND DATE(punch_in_time) = CURDATE() AND is_deleted = '0'`,
            [username, branch_id]
        );

        // Get current salary
        const [salary] = await pool.query(
            `SELECT monthly_salary FROM staff_salary 
             WHERE username = ? AND branch_id = ? AND is_active = '1' AND is_deleted = '0'`,
            [username, branch_id]
        );

        // Get staff profile for response
        const profile = await getStaffProfile(username, branch_id);

        return res.status(200).json({
            success: true,
            message: 'Attendance retrieved successfully',
            data: {
                username,
                profile: profile ? {
                    name: profile.name,
                    email: profile.email,
                    mobile: profile.mobile,
                    designation: profile.designation,
                    image: profile.image
                } : null,
                current_salary: salary[0]?.monthly_salary || null,
                today: today[0] || null,
                history: attendance.map(a => ({
                    ...a,
                    total_hours: a.total_minutes ? (a.total_minutes / 60).toFixed(2) : null,
                    is_verified: a.is_verified === '1'
                }))
            },
            meta: {
                total: total[0].total,
                page: pageNum,
                limit: limitNum,
                total_pages: Math.ceil(total[0].total / limitNum)
            }
        });

    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch attendance',
            error: error.message
        });
    }
});

// ==================== ADMIN APIs (Admin Username in HEADER) ====================

/**
 * ADMIN: Set Staff Salary (UPDATED with break & adjustment fields)
 * Headers: 
 *   - Authorization: Bearer {token}
 *   - username: {admin_username} (admin who is performing action)
 * Body: { 
 *   username: "staff1", 
 *   monthly_salary, 
 *   effective_from,
 *   working_hours_start,
 *   working_hours_end,
 *   expected_hours,
 *   grace_period_minutes,
 *   overtime_rate_type,
 *   fine_rate_type,
 *   overtime_enabled,
 *   fine_enabled,
 *   allowed_break_minutes,
 *   break_excess_penalty_type,
 *   break_excess_penalty_value,
 *   travel_allowance_type,
 *   travel_allowance_value,
 *   other_deduction_type,
 *   other_deduction_value
 * }
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
                    image: profile.image
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
router.get('/admin/daily', auth, validateBranch, async (req, res) => {
    try {
        const admin_username = req.headers["username"];
        const branch_id = req.branch_id;
        const { date, staff_username, page = 1, limit = 50 } = req.query;

        if (!admin_username) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        if (!date) {
            return res.status(400).json({
                success: false,
                message: 'Date is required (YYYY-MM-DD)'
            });
        }

        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 50;
        const offset = (pageNum - 1) * limitNum;

        // Get attendance for the date
        let attendanceQuery = `
            SELECT 
                a.*,
                p.name as staff_name,
                p.email,
                p.mobile,
                p.image,
                bm.designation
            FROM attendance a
            INNER JOIN branch_mapping bm ON a.map_id = bm.map_id
            INNER JOIN profile p ON a.username = p.username
            WHERE a.branch_id = ? 
                AND DATE(a.punch_in_time) = ?
                AND a.is_deleted = '0'
        `;

        let countQuery = `
            SELECT COUNT(*) as total
            FROM attendance a
            WHERE a.branch_id = ? 
                AND DATE(a.punch_in_time) = ?
                AND a.is_deleted = '0'
        `;

        let params = [branch_id, date];
        let countParams = [branch_id, date];

        if (staff_username) {
            attendanceQuery += ' AND a.username = ?';
            params.push(staff_username);
            countQuery += ' AND a.username = ?';
            countParams.push(staff_username);
        }

        attendanceQuery += ' ORDER BY a.punch_in_time DESC LIMIT ? OFFSET ?';
        params.push(limitNum, offset);

        const [attendance] = await pool.query(attendanceQuery, params);
        const [totalCount] = await pool.query(countQuery, countParams);

        // Get staff without attendance
        const [absentStaff] = await pool.query(
            `SELECT 
                bm.username,
                p.name as staff_name,
                p.email,
                p.image,
                bm.designation
             FROM branch_mapping bm
             INNER JOIN profile p ON bm.username = p.username
             WHERE bm.branch_id = ? 
                AND bm.type = 'staff'
                AND bm.is_accepted = '1'
                AND bm.is_deleted = '0'
                AND bm.username NOT IN (
                    SELECT DISTINCT username 
                    FROM attendance 
                    WHERE branch_id = ? 
                        AND DATE(punch_in_time) = ?
                        AND is_deleted = '0'
                )`,
            [branch_id, branch_id, date]
        );

        const verified = attendance.filter(a => a.is_verified === '1');
        const pending = attendance.filter(a => a.is_verified === '0');

        return res.status(200).json({
            success: true,
            message: 'Daily attendance retrieved successfully',
            data: {
                date,
                summary: {
                    total_staff: attendance.length + absentStaff.length,
                    present: attendance.length,
                    absent: absentStaff.length,
                    verified: verified.length,
                    pending: pending.length
                },
                attendance: attendance.map(a => ({
                    ...a,
                    total_hours: a.total_minutes ? (a.total_minutes / 60).toFixed(2) : null,
                    is_verified: a.is_verified === '1',
                    profile: {
                        name: a.staff_name,
                        email: a.email,
                        mobile: a.mobile,
                        image: a.image,
                        designation: a.designation
                    }
                })),
                absent_staff: absentStaff.map(a => ({
                    username: a.username,
                    profile: {
                        name: a.staff_name,
                        email: a.email,
                        image: a.image,
                        designation: a.designation
                    }
                }))
            },
            meta: {
                total: totalCount[0].total,
                page: pageNum,
                limit: limitNum,
                total_pages: Math.ceil(totalCount[0].total / limitNum)
            }
        });

    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch daily attendance',
            error: error.message
        });
    }
});

/**
 * ADMIN: Verify Attendance
 * Headers: 
 *   - Authorization: Bearer {token}
 *   - username: {admin_username}
 * Body: { attendance_id, verify_status, admin_remarks, manual_punch_in, manual_punch_out }
 */
/**
 * ADMIN: Verify Attendance
 * Headers: 
 *   - Authorization: Bearer {token}
 *   - username: {admin_username}
 * Body: { attendance_id, verify_status, admin_remarks, manual_punch_in, manual_punch_out }
 */
router.post('/admin/verify', auth, validateBranch, async (req, res) => {
    try {
        const admin_username = req.headers["username"];
        const branch_id = req.branch_id;
        const { 
            attendance_id, 
            verify_status, 
            admin_remarks,
            manual_punch_in,
            manual_punch_out
        } = req.body;

        if (!admin_username) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        if (!attendance_id) {
            return res.status(400).json({
                success: false,
                message: 'Attendance ID is required'
            });
        }

        // Get attendance record with salary configuration
        const [attendance] = await pool.query(
            `SELECT a.*, 
                    s.monthly_salary, 
                    s.overtime_rate_type, 
                    s.fine_rate_type, 
                    s.expected_hours, 
                    s.grace_period_minutes,
                    s.overtime_enabled,
                    s.fine_enabled
             FROM attendance a
             LEFT JOIN staff_salary s ON a.username = s.username 
                 AND a.branch_id = s.branch_id 
                 AND s.is_active = '1' 
                 AND s.is_deleted = '0'
             WHERE a.attendance_id = ? AND a.branch_id = ? AND a.is_deleted = '0'`,
            [attendance_id, branch_id]
        );

        if (!attendance.length) {
            return res.status(404).json({
                success: false,
                message: 'Attendance record not found'
            });
        }

        const record = attendance[0];
        
        // Get expected hours and grace period from salary config or use defaults
        const expectedHours = record.expected_hours || 8;
        const gracePeriodMinutes = record.grace_period_minutes || 10;
        
        // CRITICAL: Check if overtime and fine are enabled
        const isOvertimeEnabled = record.overtime_enabled === '1' || record.overtime_enabled === 1 || record.overtime_enabled === true;
        const isFineEnabled = record.fine_enabled === '1' || record.fine_enabled === 1 || record.fine_enabled === true;
        
        const overtimeRateType = record.overtime_rate_type || 'daily';
        const fineRateType = record.fine_rate_type || 'daily';

        // Calculate based on manual times if provided
        let punchIn = manual_punch_in || record.punch_in_time;
        let punchOut = manual_punch_out || record.punch_out_time;
        
        // Calculate minutes from punch times with grace period
        const { status, extraMinutes, lessMinutes, totalMinutes, gracePeriodApplied } = 
            calculateAttendanceStatus(punchIn, punchOut, expectedHours, gracePeriodMinutes);

        // Get staff salary
        const monthlySalary = record.monthly_salary || 0;
        const perDaySalary = monthlySalary / 30;
        const perMinuteSalary = perDaySalary / (expectedHours * 60);
        
        // Calculate amounts based on rate type - ONLY if enabled
        let overtimeAmount = 0;
        let fineAmount = 0;
        let calculatedAmount = 0;
        
        // CRITICAL: Only calculate overtime if enabled AND there's extra time
        if (isOvertimeEnabled && extraMinutes > 0) {
            if (overtimeRateType === 'daily') {
                overtimeAmount = extraMinutes * perMinuteSalary;
            } else {
                // Monthly rate: overtime calculated as percentage of monthly salary
                const monthlyOvertimeRate = (extraMinutes / (expectedHours * 60 * 30)) * monthlySalary;
                overtimeAmount = monthlyOvertimeRate;
            }
        }
        
        // CRITICAL: Only calculate fine if enabled AND there's less time
        if (isFineEnabled && lessMinutes > 0) {
            if (fineRateType === 'daily') {
                fineAmount = lessMinutes * perMinuteSalary;
            } else {
                // Monthly rate: fine calculated as percentage of monthly salary
                const monthlyFineRate = (lessMinutes / (expectedHours * 60 * 30)) * monthlySalary;
                fineAmount = monthlyFineRate;
            }
        }
        
        // CRITICAL: Determine final status based on enabled settings
        let finalStatus = verify_status || status;
        
        // Override status if features are disabled
        if (finalStatus === 'fine' && !isFineEnabled) {
            finalStatus = 'present';
            fineAmount = 0;
        }
        
        if (finalStatus === 'bonus' && !isOvertimeEnabled) {
            finalStatus = 'present';
            overtimeAmount = 0;
        }
        
        // Calculate amount based on final status
        switch(finalStatus) {
            case 'present':
                calculatedAmount = perDaySalary;
                break;
            case 'paid_leave':
                calculatedAmount = perDaySalary;
                break;
            case 'half_day':
                calculatedAmount = perDaySalary * 0.5;
                break;
            case 'absent':
                calculatedAmount = 0;
                break;
            case 'fine':
                // This case will only execute if fine is enabled
                calculatedAmount = perDaySalary - fineAmount;
                break;
            case 'bonus':
                // This case will only execute if overtime is enabled
                calculatedAmount = perDaySalary + overtimeAmount;
                break;
            default:
                calculatedAmount = 0;
        }

        // Update attendance with all calculations
        await pool.query(
            `UPDATE attendance 
             SET attendance_status = ?,
                 is_verified = '1',
                 verified_by = ?,
                 verified_date = NOW(),
                 admin_remarks = ?,
                 per_day_salary = ?,
                 calculated_amount = ?,
                 total_minutes = ?,
                 extra_minutes = ?,
                 less_minutes = ?,
                 grace_period_applied = ?,
                 overtime_calculated_amount = ?,
                 fine_calculated_amount = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE attendance_id = ? AND is_deleted = '0'`,
            [
                finalStatus,
                admin_username,
                admin_remarks || record.admin_remarks,
                perDaySalary,
                calculatedAmount,
                totalMinutes,
                extraMinutes,
                lessMinutes,
                gracePeriodApplied,
                overtimeAmount,
                fineAmount,
                admin_username,
                attendance_id
            ]
        );

        // Get staff profile for response
        const profile = await getStaffProfile(record.username, branch_id);

        return res.status(200).json({
            success: true,
            message: 'Attendance verified successfully',
            data: {
                attendance_id,
                username: record.username,
                profile: profile ? {
                    name: profile.name,
                    email: profile.email,
                    mobile: profile.mobile,
                    designation: profile.designation,
                    image: profile.image
                } : null,
                status: finalStatus,
                amount: calculatedAmount,
                total_hours: (totalMinutes / 60).toFixed(2),
                extra_minutes_after_grace: extraMinutes,
                less_minutes_after_grace: lessMinutes,
                grace_period_applied: gracePeriodApplied,
                overtime_amount: overtimeAmount,
                fine_amount: fineAmount,
                settings_applied: {
                    overtime_enabled: isOvertimeEnabled,
                    fine_enabled: isFineEnabled,
                    overtime_rate_type: overtimeRateType,
                    fine_rate_type: fineRateType,
                    expected_hours: expectedHours,
                    grace_period_minutes: gracePeriodMinutes
                },
                per_day_salary: perDaySalary,
                calculation_breakdown: {
                    per_day: perDaySalary,
                    per_minute: perMinuteSalary,
                    expected_hours: expectedHours,
                    grace_period_minutes: gracePeriodMinutes,
                    total_minutes_worked: totalMinutes,
                    overtime_enabled: isOvertimeEnabled,
                    fine_enabled: isFineEnabled,
                    extra_minutes: extraMinutes,
                    less_minutes: lessMinutes,
                    overtime_amount: overtimeAmount,
                    fine_amount: fineAmount,
                    base_amount: finalStatus === 'half_day' ? perDaySalary * 0.5 : 
                                (finalStatus === 'present' || finalStatus === 'paid_leave') ? perDaySalary : 0
                }
            }
        });

    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to verify attendance',
            error: error.message
        });
    }
});

// bulk attendance Verify 

router.post('/admin/bulk-verify', auth, validateBranch, async (req, res) => {
    try {
        const admin_username = req.headers["username"];
        const branch_id = req.branch_id;
        const { 
            attendance_ids,  // Array of attendance IDs
            verify_status,   // Optional: override status for all (present/absent/half_day/etc)
            admin_remarks    // Optional: common remarks for all
        } = req.body;

        // Validation
        if (!admin_username) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        if (!attendance_ids || !Array.isArray(attendance_ids) || attendance_ids.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Attendance IDs array is required"
            });
        }

        // Limit batch size to prevent overload
        if (attendance_ids.length > 100) {
            return res.status(400).json({
                success: false,
                message: "Maximum 100 attendance records can be verified at once"
            });
        }

        // Get all attendance records
        const [attendanceRecords] = await pool.query(
            `SELECT a.*, 
                    s.monthly_salary
             FROM attendance a
             LEFT JOIN staff_salary s ON a.username = s.username 
                 AND a.branch_id = s.branch_id 
                 AND s.is_active = '1' 
                 AND s.is_deleted = '0'
             WHERE a.attendance_id IN (?) 
               AND a.branch_id = ? 
               AND a.is_deleted = '0'
               AND a.is_verified = '0'`,  // Only fetch unverified records
            [attendance_ids, branch_id]
        );

        if (!attendanceRecords.length) {
            return res.status(404).json({
                success: false,
                message: 'No unverified attendance records found'
            });
        }

        // Track results
        const verifiedRecords = [];
        const failedRecords = [];
        
        // Process each record
        for (const record of attendanceRecords) {
            try {
                // Calculate actual status based on punch times
                const { 
                    status: calculatedStatus, 
                    extraMinutes, 
                    lessMinutes, 
                    totalMinutes 
                } = calculateAttendanceStatus(record.punch_in_time, record.punch_out_time);
                
                // Use provided status or calculated status
                const finalStatus = verify_status || calculatedStatus;
                
                // Calculate amount
                let calculatedAmount = 0;
                let perDaySalary = 0;
                let perMinuteSalary = 0;
                
                if (record.monthly_salary) {
                    perDaySalary = record.monthly_salary / 30;
                    perMinuteSalary = perDaySalary / 480;
                    
                    // Calculate amount based on actual status
                    switch(finalStatus) {
                        case 'present':
                            calculatedAmount = perDaySalary;
                            break;
                        case 'paid_leave':
                            calculatedAmount = perDaySalary;
                            break;
                        case 'half_day':
                            calculatedAmount = perDaySalary * 0.5;
                            break;
                        case 'absent':
                            calculatedAmount = 0;
                            break;
                        case 'fine':
                            calculatedAmount = perDaySalary - (lessMinutes * perMinuteSalary);
                            break;
                        case 'bonus':
                            calculatedAmount = perDaySalary + (extraMinutes * perMinuteSalary);
                            break;
                        default:
                            calculatedAmount = 0;
                    }
                }
                
                // Update attendance record
                await pool.query(
                    `UPDATE attendance 
                     SET attendance_status = ?,
                         is_verified = '1',
                         verified_by = ?,
                         verified_date = NOW(),
                         admin_remarks = COALESCE(?, admin_remarks),
                         per_day_salary = ?,
                         calculated_amount = ?,
                         total_minutes = ?,
                         extra_minutes = ?,
                         less_minutes = ?,
                         modify_by = ?,
                         modify_date = NOW()
                     WHERE attendance_id = ? AND is_deleted = '0'`,
                    [
                        finalStatus,
                        admin_username,
                        admin_remarks,
                        perDaySalary,
                        calculatedAmount,
                        totalMinutes,
                        extraMinutes,
                        lessMinutes,
                        admin_username,
                        record.attendance_id
                    ]
                );
                
                // Get staff profile for response
                const profile = await getStaffProfile(record.username, branch_id);
                
                verifiedRecords.push({
                    attendance_id: record.attendance_id,
                    username: record.username,
                    profile: profile ? {
                        name: profile.name,
                        email: profile.email,
                        mobile: profile.mobile,
                        designation: profile.designation,
                        image: profile.image
                    } : null,
                    status: finalStatus,
                    original_status: calculatedStatus,
                    amount: calculatedAmount,
                    total_hours: (totalMinutes / 60).toFixed(2),
                    extra_minutes: extraMinutes,
                    less_minutes: lessMinutes,
                    per_day_salary: perDaySalary,
                    punch_in_time: record.punch_in_time,
                    punch_out_time: record.punch_out_time,
                    calculation_breakdown: {
                        per_day: perDaySalary,
                        per_minute: perMinuteSalary,
                        total_minutes: totalMinutes,
                        expected_minutes: 480,
                        actual_minutes: totalMinutes,
                        minutes_difference: totalMinutes - 480
                    }
                });
                
            } catch (err) {
                failedRecords.push({
                    attendance_id: record.attendance_id,
                    username: record.username,
                    error: err.message
                });
            }
        }
        
        return res.status(200).json({
            success: true,
            message: `Bulk verification completed: ${verifiedRecords.length} successful, ${failedRecords.length} failed`,
            data: {
                total_processed: attendanceRecords.length,
                total_verified: verifiedRecords.length,
                total_failed: failedRecords.length,
                verified_records: verifiedRecords,
                failed_records: failedRecords,
                summary: {
                    total_amount: verifiedRecords.reduce((sum, rec) => sum + rec.amount, 0),
                    by_status: verifiedRecords.reduce((acc, rec) => {
                        acc[rec.status] = (acc[rec.status] || 0) + 1;
                        return acc;
                    }, {})
                }
            }
        });
        
    } catch (error) {
        console.error('Bulk verification error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to process bulk verification',
            error: error.message
        });
    }
});

// Alternative: Get unverified attendance summary for bulk selection
router.get('/admin/unverified-attendance', auth, validateBranch, async (req, res) => {
    try {
        const branch_id = req.branch_id;
        const { date_from, date_to, username } = req.query;
        
        let query = `
            SELECT a.*,
                   p.name as staff_name,
                   p.designation,
                   s.monthly_salary
            FROM attendance a
            LEFT JOIN profile p ON a.username = p.username AND a.branch_id = p.branch_id
            LEFT JOIN staff_salary s ON a.username = s.username AND a.branch_id = s.branch_id 
                AND s.is_active = '1' AND s.is_deleted = '0'
            WHERE a.branch_id = ? 
              AND a.is_deleted = '0' 
              AND a.is_verified = '0'
        `;
        
        const queryParams = [branch_id];
        
        if (date_from) {
            query += ` AND DATE(a.attendance_date) >= ?`;
            queryParams.push(date_from);
        }
        
        if (date_to) {
            query += ` AND DATE(a.attendance_date) <= ?`;
            queryParams.push(date_to);
        }
        
        if (username) {
            query += ` AND a.username = ?`;
            queryParams.push(username);
        }
        
        query += ` ORDER BY a.attendance_date DESC, a.punch_in_time ASC`;
        
        const [records] = await pool.query(query, queryParams);
        
        // Calculate actual status for each record
        const processedRecords = records.map(record => {
            const { status, extraMinutes, lessMinutes, totalMinutes } = 
                calculateAttendanceStatus(record.punch_in_time, record.punch_out_time);
            
            return {
                attendance_id: record.attendance_id,
                username: record.username,
                staff_name: record.staff_name,
                designation: record.designation,
                attendance_date: record.attendance_date,
                punch_in_time: record.punch_in_time,
                punch_out_time: record.punch_out_time,
                calculated_status: status,
                total_hours: (totalMinutes / 60).toFixed(2),
                extra_minutes: extraMinutes,
                less_minutes: lessMinutes,
                monthly_salary: record.monthly_salary,
                admin_remarks: record.admin_remarks
            };
        });
        
        return res.status(200).json({
            success: true,
            data: {
                total_records: processedRecords.length,
                records: processedRecords,
                summary: {
                    by_status: processedRecords.reduce((acc, rec) => {
                        acc[rec.calculated_status] = (acc[rec.calculated_status] || 0) + 1;
                        return acc;
                    }, {})
                }
            }
        });
        
    } catch (error) {
        console.error('Error fetching unverified attendance:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch unverified attendance records',
            error: error.message
        });
    }
});

// Additional endpoint for bulk verification with custom status per record
router.post('/admin/bulk-verify-custom', auth, validateBranch, async (req, res) => {
    try {
        const admin_username = req.headers["username"];
        const branch_id = req.branch_id;
        const { verifications } = req.body; // Array of {attendance_id, verify_status, admin_remarks}
        
        if (!verifications || !Array.isArray(verifications) || verifications.length === 0) {
            return res.status(400).json({
                success: false,
                message: "Verifications array is required"
            });
        }
        
        if (verifications.length > 100) {
            return res.status(400).json({
                success: false,
                message: "Maximum 100 attendance records can be verified at once"
            });
        }
        
        const attendanceIds = verifications.map(v => v.attendance_id);
        
        // Get all attendance records
        const [attendanceRecords] = await pool.query(
            `SELECT a.*, s.monthly_salary
             FROM attendance a
             LEFT JOIN staff_salary s ON a.username = s.username 
                 AND a.branch_id = s.branch_id 
                 AND s.is_active = '1' 
                 AND s.is_deleted = '0'
             WHERE a.attendance_id IN (?) 
               AND a.branch_id = ? 
               AND a.is_deleted = '0'
               AND a.is_verified = '0'`,
            [attendanceIds, branch_id]
        );
        
        const verifiedRecords = [];
        const failedRecords = [];
        
        for (const record of attendanceRecords) {
            const verification = verifications.find(v => v.attendance_id === record.attendance_id);
            
            if (!verification) {
                failedRecords.push({
                    attendance_id: record.attendance_id,
                    error: 'No verification data provided for this record'
                });
                continue;
            }
            
            try {
                // Calculate actual status from punch times
                const { status: calculatedStatus, extraMinutes, lessMinutes, totalMinutes } = 
                    calculateAttendanceStatus(record.punch_in_time, record.punch_out_time);
                
                const finalStatus = verification.verify_status || calculatedStatus;
                
                // Calculate amount based on actual minutes
                let calculatedAmount = 0;
                let perDaySalary = 0;
                let perMinuteSalary = 0;
                
                if (record.monthly_salary) {
                    perDaySalary = record.monthly_salary / 30;
                    perMinuteSalary = perDaySalary / 480;
                    
                    switch(finalStatus) {
                        case 'present':
                            calculatedAmount = perDaySalary;
                            break;
                        case 'paid_leave':
                            calculatedAmount = perDaySalary;
                            break;
                        case 'half_day':
                            calculatedAmount = perDaySalary * 0.5;
                            break;
                        case 'absent':
                            calculatedAmount = 0;
                            break;
                        case 'fine':
                            calculatedAmount = perDaySalary - (lessMinutes * perMinuteSalary);
                            break;
                        case 'bonus':
                            calculatedAmount = perDaySalary + (extraMinutes * perMinuteSalary);
                            break;
                        default:
                            calculatedAmount = 0;
                    }
                }
                
                await pool.query(
                    `UPDATE attendance 
                     SET attendance_status = ?,
                         is_verified = '1',
                         verified_by = ?,
                         verified_date = NOW(),
                         admin_remarks = COALESCE(?, admin_remarks),
                         per_day_salary = ?,
                         calculated_amount = ?,
                         total_minutes = ?,
                         extra_minutes = ?,
                         less_minutes = ?,
                         modify_by = ?,
                         modify_date = NOW()
                     WHERE attendance_id = ? AND is_deleted = '0'`,
                    [
                        finalStatus,
                        admin_username,
                        verification.admin_remarks,
                        perDaySalary,
                        calculatedAmount,
                        totalMinutes,
                        extraMinutes,
                        lessMinutes,
                        admin_username,
                        record.attendance_id
                    ]
                );
                
                const profile = await getStaffProfile(record.username, branch_id);
                
                verifiedRecords.push({
                    attendance_id: record.attendance_id,
                    username: record.username,
                    profile: profile ? {
                        name: profile.name,
                        email: profile.email,
                        mobile: profile.mobile,
                        designation: profile.designation
                    } : null,
                    status: finalStatus,
                    original_status: calculatedStatus,
                    amount: calculatedAmount,
                    total_hours: (totalMinutes / 60).toFixed(2),
                    extra_minutes: extraMinutes,
                    less_minutes: lessMinutes
                });
                
            } catch (err) {
                failedRecords.push({
                    attendance_id: record.attendance_id,
                    error: err.message
                });
            }
        }
        
        return res.status(200).json({
            success: true,
            message: `Bulk verification completed: ${verifiedRecords.length} successful, ${failedRecords.length} failed`,
            data: {
                total_processed: attendanceRecords.length,
                verified_records: verifiedRecords,
                failed_records: failedRecords
            }
        });
        
    } catch (error) {
        console.error('Custom bulk verification error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to process bulk verification',
            error: error.message
        });
    }
});
/**
 * ADMIN: Get Attendance Summary
 * Headers: 
 *   - Authorization: Bearer {token}
 *   - username: {admin_username}
 * Query: month, year, username (optional staff filter)
 */
router.get('/admin/summary', auth, validateBranch, async (req, res) => {
    try {
        const admin_username = req.headers["username"];
        const branch_id = req.branch_id;
        const { month, year, username } = req.query;

        if (!admin_username) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        if (!month || !year) {
            return res.status(400).json({
                success: false,
                message: 'Month and year are required'
            });
        }

        let query = `
            SELECT 
                a.username,
                p.name as staff_name,
                p.email,
                p.mobile,
                p.image,
                bm.designation,
                ss.monthly_salary,
                COUNT(DISTINCT DATE(a.punch_in_time)) as total_days,
                SUM(CASE WHEN a.attendance_status = 'present' AND a.is_verified = '1' THEN 1 ELSE 0 END) as present_days,
                SUM(CASE WHEN a.attendance_status = 'absent' AND a.is_verified = '1' THEN 1 ELSE 0 END) as absent_days,
                SUM(CASE WHEN a.attendance_status = 'half_day' AND a.is_verified = '1' THEN 1 ELSE 0 END) as half_days,
                SUM(CASE WHEN a.attendance_status = 'paid_leave' AND a.is_verified = '1' THEN 1 ELSE 0 END) as paid_leaves,
                SUM(CASE WHEN a.attendance_status = 'fine' AND a.is_verified = '1' THEN 1 ELSE 0 END) as fine_days,
                SUM(CASE WHEN a.attendance_status = 'bonus' AND a.is_verified = '1' THEN 1 ELSE 0 END) as bonus_days,
                SUM(a.extra_minutes) as total_extra_minutes,
                SUM(a.less_minutes) as total_less_minutes,
                SUM(a.calculated_amount) as total_earned
            FROM attendance a
            INNER JOIN branch_mapping bm ON a.map_id = bm.map_id
            INNER JOIN profile p ON a.username = p.username
            LEFT JOIN staff_salary ss ON a.username = ss.username AND ss.is_active = '1' AND ss.is_deleted = '0'
            WHERE a.branch_id = ? 
                AND MONTH(a.punch_in_time) = ? 
                AND YEAR(a.punch_in_time) = ?
                AND a.is_deleted = '0'
        `;

        const params = [branch_id, month, year];

        if (username) {
            query += ' AND a.username = ?';
            params.push(username);
        }

        query += ' GROUP BY a.username, p.name, bm.designation, ss.monthly_salary';

        const [summary] = await pool.query(query, params);

        const result = summary.map(s => {
            const workingDays = s.present_days + (s.half_days * 0.5) + s.paid_leaves;
            
            return {
                username: s.username,
                profile: {
                    name: s.staff_name,
                    email: s.email,
                    mobile: s.mobile,
                    image: s.image,
                    designation: s.designation
                },
                salary_details: {
                    monthly_salary: s.monthly_salary || 0,
                    per_day: s.monthly_salary ? (s.monthly_salary / 30).toFixed(2) : 0,
                    per_hour: s.monthly_salary ? (s.monthly_salary / 30 / 8).toFixed(2) : 0,
                    per_minute: s.monthly_salary ? (s.monthly_salary / 30 / 480).toFixed(2) : 0
                },
                attendance_summary: {
                    total_days: s.total_days || 0,
                    present: s.present_days || 0,
                    absent: s.absent_days || 0,
                    half_day: s.half_days || 0,
                    paid_leave: s.paid_leaves || 0,
                    fine: s.fine_days || 0,
                    bonus: s.bonus_days || 0,
                    working_days: workingDays.toFixed(1)
                },
                extra_time: {
                    extra_minutes: s.total_extra_minutes || 0,
                    less_minutes: s.total_less_minutes || 0,
                    extra_hours: ((s.total_extra_minutes || 0) / 60).toFixed(1),
                    less_hours: ((s.total_less_minutes || 0) / 60).toFixed(1)
                },
                salary_calculation: {
                    earned: Math.round(s.total_earned || 0),
                    expected: s.monthly_salary ? Math.round(s.monthly_salary) : 0,
                    difference: s.monthly_salary ? Math.round((s.total_earned || 0) - s.monthly_salary) : 0
                }
            };
        });

        // Calculate totals
        const totals = result.reduce((acc, curr) => {
            acc.total_earned += curr.salary_calculation.earned;
            acc.total_expected += curr.salary_calculation.expected;
            acc.total_present += curr.attendance_summary.present;
            acc.total_absent += curr.attendance_summary.absent;
            acc.total_half_day += curr.attendance_summary.half_day;
            acc.total_paid_leave += curr.attendance_summary.paid_leave;
            acc.total_fine += curr.attendance_summary.fine;
            acc.total_bonus += curr.attendance_summary.bonus;
            return acc;
        }, { 
            total_earned: 0, 
            total_expected: 0, 
            total_present: 0, 
            total_absent: 0,
            total_half_day: 0,
            total_paid_leave: 0,
            total_fine: 0,
            total_bonus: 0
        });

        return res.status(200).json({
            success: true,
            message: username ? `Attendance summary for ${username} retrieved successfully` : 'Attendance summary retrieved successfully',
            data: {
                period: {
                    month: parseInt(month),
                    year: parseInt(year),
                    branch_id
                },
                summary: result,
                totals: {
                    staff_count: result.length,
                    attendance: {
                        present: totals.total_present,
                        absent: totals.total_absent,
                        half_day: totals.total_half_day,
                        paid_leave: totals.total_paid_leave,
                        fine: totals.total_fine,
                        bonus: totals.total_bonus
                    },
                    salary: {
                        earned: Math.round(totals.total_earned),
                        expected: Math.round(totals.total_expected),
                        difference: Math.round(totals.total_earned - totals.total_expected)
                    }
                }
            },
            meta: {
                month: parseInt(month),
                year: parseInt(year),
                branch_id,
                filtered_by_username: username || null
            }
        });

    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch summary',
            error: error.message
        });
    }
});

/**
 * Get Attendance by Date (UPDATED with Break & Adjustment fields)
 * Headers: 
 *   - Authorization: Bearer {token}
 *   - username: {admin_username}
 * Query: date (YYYY-MM-DD), staff_username (optional)
 */
router.get('/by-date', auth, validateBranch, async (req, res) => {
    try {
        const admin_username = req.headers["username"];
        const branch_id = req.branch_id;
        const { date, staff_username } = req.query;

        if (!admin_username) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        if (!date) {
            return res.status(400).json({
                success: false,
                message: 'Date is required (YYYY-MM-DD)'
            });
        }

        // Helper function to calculate time difference in minutes
        const calculateTimeDifference = (time1, time2) => {
            if (!time1 || !time2) return 0;
            const [hours1, minutes1] = time1.split(':').map(Number);
            const [hours2, minutes2] = time2.split(':').map(Number);
            
            const totalMinutes1 = hours1 * 60 + minutes1;
            const totalMinutes2 = hours2 * 60 + minutes2;
            
            return Math.abs(totalMinutes1 - totalMinutes2);
        };

        // Helper function to get available status options based on feature settings
        const getAvailableStatusOptions = (isOvertimeEnabled, isFineEnabled, currentStatus) => {
            const options = [
                { value: 'present', label: 'Present', selected: currentStatus === 'present' }
            ];
            
            if (isOvertimeEnabled) {
                options.push({ 
                    value: 'bonus', 
                    label: 'Bonus (OT)', 
                    selected: currentStatus === 'bonus',
                    enabled: true
                });
            } else {
                options.push({ 
                    value: 'bonus', 
                    label: 'Bonus (OT)', 
                    selected: false,
                    enabled: false,
                    disabled_reason: 'Overtime not enabled for this employee'
                });
            }
            
            options.push({ value: 'half_day', label: 'Half Day', selected: currentStatus === 'half_day' });
            options.push({ value: 'paid_leave', label: 'Paid Leave', selected: currentStatus === 'paid_leave' });
            options.push({ value: 'absent', label: 'Absent', selected: currentStatus === 'absent' });
            
            if (isFineEnabled) {
                options.push({ 
                    value: 'fine', 
                    label: 'Fine', 
                    selected: currentStatus === 'fine',
                    enabled: true
                });
            } else {
                options.push({ 
                    value: 'fine', 
                    label: 'Fine', 
                    selected: false,
                    enabled: false,
                    disabled_reason: 'Fine not enabled for this employee'
                });
            }
            
            return options;
        };

        // Get attendance for the date with salary configuration - ADDED NEW FIELDS
        let query = `
            SELECT 
                a.attendance_id,
                a.username,
                a.map_id,
                a.punch_in_time,
                a.punch_out_time,
                a.punch_in_latitude,
                a.punch_in_longitude,
                a.punch_out_latitude,
                a.punch_out_longitude,
                a.total_minutes,
                a.expected_minutes,
                a.extra_minutes,
                a.less_minutes,
                a.attendance_status,
                a.is_verified,
                a.verified_by,
                a.verified_date,
                a.admin_remarks,
                a.is_manual,
                a.manual_reason,
                a.per_day_salary,
                a.calculated_amount,
                a.grace_period_applied,
                a.overtime_calculated_amount,
                a.fine_calculated_amount,
                
                -- NEW BREAK & ADJUSTMENT FIELDS
                a.total_break_minutes,
                a.excess_break_minutes,
                a.break_penalty_amount,
                a.travel_allowance_amount,
                a.other_deduction_amount,
                a.net_adjustment_amount,
                a.final_calculated_amount,
                
                -- Profile details
                p.name as staff_name,
                p.email,
                p.mobile,
                p.country_code,
                p.image,
                
                -- Designation from branch_mapping
                bm.designation,
                
                -- Salary details with all settings - ADDED BREAK & ADJUSTMENT SETTINGS
                ss.monthly_salary,
                ss.expected_hours as salary_expected_hours,
                ss.grace_period_minutes as salary_grace_period_minutes,
                ss.overtime_enabled,
                ss.fine_enabled,
                ss.overtime_rate_type,
                ss.fine_rate_type,
                ss.working_hours_start,
                ss.working_hours_end,
                ss.allowed_break_minutes,
                ss.break_excess_penalty_type,
                ss.break_excess_penalty_value,
                ss.travel_allowance_type,
                ss.travel_allowance_value,
                ss.other_deduction_type,
                ss.other_deduction_value,
                
                -- Calculated fields
                TIME(a.punch_in_time) as punch_in_time_only,
                TIME(a.punch_out_time) as punch_out_time_only,
                DATE(a.punch_in_time) as attendance_date,
                
                -- Working hours calculation
                CASE 
                    WHEN a.total_minutes IS NOT NULL 
                    THEN CONCAT(
                        FLOOR(a.total_minutes / 60), 'h ',
                        MOD(a.total_minutes, 60), 'm'
                    )
                    ELSE NULL
                END as working_hours_formatted,
                
                -- Status badge
                CASE a.attendance_status
                    WHEN 'present' THEN '✅ Present'
                    WHEN 'absent' THEN '❌ Absent'
                    WHEN 'half_day' THEN '⚠️ Half Day'
                    WHEN 'paid_leave' THEN '💰 Paid Leave'
                    WHEN 'fine' THEN '💰 Fine'
                    WHEN 'bonus' THEN '✨ Bonus'
                    WHEN 'pending' THEN '⏳ Pending'
                END as status_display

            FROM attendance a
            INNER JOIN branch_mapping bm ON a.map_id = bm.map_id
            INNER JOIN profile p ON a.username = p.username
            LEFT JOIN staff_salary ss ON a.username = ss.username 
                AND ss.branch_id = a.branch_id 
                AND ss.is_active = '1' 
                AND ss.is_deleted = '0'
                AND ss.effective_from <= a.punch_in_time
            WHERE a.branch_id = ? 
                AND DATE(a.punch_in_time) = ?
                AND a.is_deleted = '0'
        `;

        const params = [branch_id, date];

        if (staff_username) {
            query += ' AND a.username = ?';
            params.push(staff_username);
        }

        query += ' ORDER BY a.punch_in_time DESC';

        const [attendance] = await pool.query(query, params);

        // Get staff who have NO attendance on this date - ADDED NEW FIELDS
        let absentStaffQuery = `
            SELECT 
                bm.username,
                bm.map_id,
                bm.designation,
                p.name as staff_name,
                p.email,
                p.mobile,
                p.image,
                ss.monthly_salary,
                ss.expected_hours as salary_expected_hours,
                ss.grace_period_minutes as salary_grace_period_minutes,
                ss.overtime_enabled,
                ss.fine_enabled,
                ss.overtime_rate_type,
                ss.fine_rate_type,
                ss.working_hours_start,
                ss.working_hours_end,
                ss.allowed_break_minutes,
                ss.break_excess_penalty_type,
                ss.break_excess_penalty_value,
                ss.travel_allowance_type,
                ss.travel_allowance_value,
                ss.other_deduction_type,
                ss.other_deduction_value
            FROM branch_mapping bm
            INNER JOIN profile p ON bm.username = p.username
            LEFT JOIN staff_salary ss ON bm.username = ss.username 
                AND ss.branch_id = bm.branch_id 
                AND ss.is_active = '1' 
                AND ss.is_deleted = '0'
                AND ss.effective_from <= ?
            WHERE bm.branch_id = ? 
                AND bm.type = 'staff'
                AND bm.is_accepted = '1'
                AND bm.is_deleted = '0'
        `;

        let absentParams = [date, branch_id];

        if (staff_username) {
            absentStaffQuery += ' AND bm.username = ?';
            absentParams.push(staff_username);
        }

        absentStaffQuery += ` AND bm.username NOT IN (
            SELECT DISTINCT username 
            FROM attendance 
            WHERE branch_id = ? 
                AND DATE(punch_in_time) = ?
                AND is_deleted = '0'
        )`;

        absentParams.push(branch_id, date);

        const [absentStaff] = await pool.query(absentStaffQuery, absentParams);

        // Calculate summary statistics
        const verified = attendance.filter(a => a.is_verified === '1');
        const pending = attendance.filter(a => a.is_verified === '0');
        
        const present = attendance.filter(a => a.attendance_status === 'present');
        const halfDay = attendance.filter(a => a.attendance_status === 'half_day');
        const paidLeave = attendance.filter(a => a.attendance_status === 'paid_leave');
        const fine = attendance.filter(a => a.attendance_status === 'fine');
        const bonus = attendance.filter(a => a.attendance_status === 'bonus');

        // Format attendance records - ADDED BREAK & ADJUSTMENT SECTIONS
        const formattedAttendance = attendance.map(a => {
            // Get duty time settings from salary
            const expectedHours = parseFloat(a.salary_expected_hours) || 8;
            const expectedMinutes = expectedHours * 60;
            const actualMinutes = a.total_minutes || 0;
            const differenceMinutes = actualMinutes - expectedMinutes;
            
            // Get working hours from salary
            const workingStart = a.working_hours_start || '09:00:00';
            const workingEnd = a.working_hours_end || '18:00:00';
            
            // Feature flags
            const isOvertimeEnabled = a.overtime_enabled === '1' || a.overtime_enabled === 1 || a.overtime_enabled === true;
            const isFineEnabled = a.fine_enabled === '1' || a.fine_enabled === 1 || a.fine_enabled === true;
            
            // Break settings
            const allowedBreakMinutes = parseInt(a.allowed_break_minutes) || 30;
            const breakPenaltyEnabled = parseFloat(a.break_excess_penalty_value || 0) > 0;
            const breakPenaltyAmount = parseFloat(a.break_penalty_amount || 0);
            const totalBreakMinutes = parseInt(a.total_break_minutes) || 0;
            const excessBreakMinutes = parseInt(a.excess_break_minutes) || 0;
            
            // Travel allowance & deductions
            const travelAllowanceAmount = parseFloat(a.travel_allowance_amount || 0);
            const otherDeductionAmount = parseFloat(a.other_deduction_amount || 0);
            const netAdjustmentAmount = parseFloat(a.net_adjustment_amount || 0);
            const finalCalculatedAmount = parseFloat(a.final_calculated_amount || 0);
            
            // Calculate punch status
            let punchInStatus = null;
            let punchOutStatus = null;
            
            if (a.punch_in_time_only && workingStart) {
                const punchInTime = a.punch_in_time_only;
                if (punchInTime > workingStart) {
                    const lateMinutes = calculateTimeDifference(punchInTime, workingStart);
                    punchInStatus = {
                        is_late: true,
                        minutes: lateMinutes,
                        formatted: `${Math.floor(lateMinutes / 60)}h ${lateMinutes % 60}m late`
                    };
                } else if (punchInTime < workingStart) {
                    const earlyMinutes = calculateTimeDifference(workingStart, punchInTime);
                    punchInStatus = {
                        is_early: true,
                        minutes: earlyMinutes,
                        formatted: `${Math.floor(earlyMinutes / 60)}h ${earlyMinutes % 60}m early`
                    };
                } else {
                    punchInStatus = {
                        is_on_time: true,
                        formatted: 'On time'
                    };
                }
            }
            
            if (a.punch_out_time_only && workingEnd) {
                const punchOutTime = a.punch_out_time_only;
                if (punchOutTime < workingEnd) {
                    const earlyMinutes = calculateTimeDifference(workingEnd, punchOutTime);
                    punchOutStatus = {
                        is_early: true,
                        minutes: earlyMinutes,
                        formatted: `${Math.floor(earlyMinutes / 60)}h ${earlyMinutes % 60}m early`
                    };
                } else if (punchOutTime > workingEnd) {
                    const lateMinutes = calculateTimeDifference(punchOutTime, workingEnd);
                    punchOutStatus = {
                        is_late: true,
                        minutes: lateMinutes,
                        formatted: `${Math.floor(lateMinutes / 60)}h ${lateMinutes % 60}m overtime`
                    };
                } else {
                    punchOutStatus = {
                        is_on_time: true,
                        formatted: 'On time'
                    };
                }
            }
            
            return {
                attendance_id: a.attendance_id,
                username: a.username,
                
                // Profile
                profile: {
                    name: a.staff_name,
                    email: a.email,
                    mobile: a.mobile,
                    image: a.image,
                    designation: a.designation
                },
                
                // Punch Details
                punch_details: {
                    punch_in: {
                        datetime: a.punch_in_time,
                        time: a.punch_in_time_only,
                        latitude: a.punch_in_latitude,
                        longitude: a.punch_in_longitude,
                        status: punchInStatus
                    },
                    punch_out: {
                        datetime: a.punch_out_time,
                        time: a.punch_out_time_only,
                        latitude: a.punch_out_latitude,
                        longitude: a.punch_out_longitude,
                        status: punchOutStatus
                    }
                },
                
                // Duty Time
                duty_time: {
                    expected: {
                        start_time: workingStart,
                        end_time: workingEnd,
                        schedule: `${workingStart} to ${workingEnd}`,
                        hours: expectedHours,
                        minutes: expectedMinutes,
                        formatted: `${Math.floor(expectedHours)}h ${Math.floor((expectedHours - Math.floor(expectedHours)) * 60)}m`
                    },
                    actual: {
                        minutes: actualMinutes,
                        hours: (actualMinutes / 60).toFixed(2),
                        formatted: a.working_hours_formatted
                    },
                    difference: {
                        minutes: differenceMinutes,
                        hours: (differenceMinutes / 60).toFixed(2),
                        type: differenceMinutes > 0 ? 'overtime' : (differenceMinutes < 0 ? 'undertime' : 'exact'),
                        formatted: differenceMinutes > 0 ? 
                            `+${Math.floor(differenceMinutes / 60)}h ${differenceMinutes % 60}m` :
                            differenceMinutes < 0 ?
                            `${Math.floor(differenceMinutes / 60)}h ${Math.abs(differenceMinutes % 60)}m` :
                            '0h 0m'
                    }
                },
                
                // NEW: Break Summary
                break_summary: {
                    total_breaks: 0, // You can fetch this from a separate query if needed
                    total_break_minutes: totalBreakMinutes,
                    allowed_break_minutes: allowedBreakMinutes,
                    excess_break_minutes: excessBreakMinutes,
                    break_penalty_amount: breakPenaltyAmount,
                    penalty_enabled: breakPenaltyEnabled,
                    penalty_rate: parseFloat(a.break_excess_penalty_value || 0),
                    penalty_type: a.break_excess_penalty_type || 'fixed',
                    message: breakPenaltyAmount > 0 ? 
                        `₹${breakPenaltyAmount} deducted for ${excessBreakMinutes} excess break minutes` : 
                        excessBreakMinutes > 0 ? 'Break penalty not enabled' : 'No excess break time'
                },
                
                // NEW: Adjustments Summary
                adjustments: {
                    travel_allowance: travelAllowanceAmount,
                    other_deductions: otherDeductionAmount,
                    net_adjustment: netAdjustmentAmount,
                    settings: {
                        travel_allowance_type: a.travel_allowance_type || 'fixed',
                        travel_allowance_value: parseFloat(a.travel_allowance_value || 0),
                        other_deduction_type: a.other_deduction_type || 'percentage',
                        other_deduction_value: parseFloat(a.other_deduction_value || 0)
                    }
                },
                
                // Feature Status
                feature_status: {
                    overtime: {
                        enabled: isOvertimeEnabled,
                        rate_type: a.overtime_rate_type || 'daily',
                        description: isOvertimeEnabled ? 'Overtime calculation enabled' : 'Overtime not enabled',
                        ui_state: isOvertimeEnabled ? 'active' : 'disabled',
                        can_select: isOvertimeEnabled
                    },
                    fine: {
                        enabled: isFineEnabled,
                        rate_type: a.fine_rate_type || 'daily',
                        description: isFineEnabled ? 'Fine calculation enabled' : 'Fine not enabled',
                        ui_state: isFineEnabled ? 'active' : 'disabled',
                        can_select: isFineEnabled
                    },
                    break_penalty: {
                        enabled: breakPenaltyEnabled,
                        description: breakPenaltyEnabled ? `₹${a.break_excess_penalty_value} per excess minute` : 'Break penalty not enabled',
                        ui_state: breakPenaltyEnabled ? 'active' : 'disabled'
                    }
                },
                
                // Working Hours Details
                working_hours: {
                    total_minutes: a.total_minutes,
                    total_hours: a.total_minutes ? (a.total_minutes / 60).toFixed(2) : null,
                    formatted: a.working_hours_formatted,
                    expected_minutes: expectedMinutes,
                    extra_minutes: a.extra_minutes,
                    less_minutes: a.less_minutes,
                    grace_period_applied: a.grace_period_applied
                },
                
                // Status
                status: {
                    code: a.attendance_status,
                    display: a.status_display,
                    is_verified: a.is_verified === '1',
                    verified_by: a.verified_by,
                    verified_date: a.verified_date,
                    remarks: a.admin_remarks,
                    available_options: getAvailableStatusOptions(isOvertimeEnabled, isFineEnabled, a.attendance_status)
                },
                
                // Manual Entry Info
                is_manual: a.is_manual === '1',
                manual_reason: a.manual_reason,
                
                // Salary Info with all calculations
                salary: {
                    monthly_salary: a.monthly_salary,
                    per_day: a.per_day_salary,
                    calculated_amount: a.calculated_amount,
                    overtime_amount: parseFloat(a.overtime_calculated_amount || 0),
                    fine_amount: parseFloat(a.fine_calculated_amount || 0),
                    break_penalty: breakPenaltyAmount,
                    travel_allowance: travelAllowanceAmount,
                    other_deductions: otherDeductionAmount,
                    net_adjustment: netAdjustmentAmount,
                    final_amount: finalCalculatedAmount,
                    settings: {
                        expected_hours: a.salary_expected_hours || 8,
                        grace_period_minutes: a.salary_grace_period_minutes || 10,
                        working_hours: {
                            start: workingStart,
                            end: workingEnd
                        },
                        overtime: {
                            enabled: isOvertimeEnabled,
                            rate_type: a.overtime_rate_type || 'daily'
                        },
                        fine: {
                            enabled: isFineEnabled,
                            rate_type: a.fine_rate_type || 'daily'
                        },
                        break_settings: {
                            allowed_minutes: allowedBreakMinutes,
                            penalty_type: a.break_excess_penalty_type || 'fixed',
                            penalty_value: parseFloat(a.break_excess_penalty_value || 0)
                        }
                    }
                }
            };
        });

        // Format absent staff - ADDED BREAK SETTINGS
        const formattedAbsent = absentStaff.map(a => {
            const expectedHours = a.salary_expected_hours || 8;
            const expectedMinutes = expectedHours * 60;
            const workingStart = a.working_hours_start || '09:00:00';
            const workingEnd = a.working_hours_end || '18:00:00';
            const isOvertimeEnabled = a.overtime_enabled === '1' || a.overtime_enabled === 1 || a.overtime_enabled === true;
            const isFineEnabled = a.fine_enabled === '1' || a.fine_enabled === 1 || a.fine_enabled === true;
            const breakPenaltyEnabled = parseFloat(a.break_excess_penalty_value || 0) > 0;
            
            return {
                username: a.username,
                profile: {
                    name: a.staff_name,
                    email: a.email,
                    mobile: a.mobile,
                    image: a.image,
                    designation: a.designation
                },
                status: {
                    code: 'absent',
                    display: '❌ Absent',
                    is_verified: false,
                    available_options: getAvailableStatusOptions(isOvertimeEnabled, isFineEnabled, 'absent')
                },
                duty_time: {
                    expected: {
                        start_time: workingStart,
                        end_time: workingEnd,
                        schedule: `${workingStart} to ${workingEnd}`,
                        hours: expectedHours,
                        minutes: expectedMinutes,
                        formatted: `${Math.floor(expectedHours)}h ${Math.floor((expectedHours - Math.floor(expectedHours)) * 60)}m`
                    },
                    actual: {
                        minutes: 0,
                        hours: '0.00',
                        formatted: '0h 0m'
                    },
                    difference: {
                        minutes: -expectedMinutes,
                        hours: (-expectedHours).toFixed(2),
                        type: 'undertime',
                        formatted: `-${Math.floor(expectedHours)}h ${Math.floor((expectedHours - Math.floor(expectedHours)) * 60)}m`
                    }
                },
                feature_status: {
                    overtime: {
                        enabled: isOvertimeEnabled,
                        rate_type: a.overtime_rate_type || 'daily',
                        description: isOvertimeEnabled ? 'Overtime calculation enabled' : 'Overtime not enabled',
                        ui_state: isOvertimeEnabled ? 'active' : 'disabled',
                        can_select: isOvertimeEnabled
                    },
                    fine: {
                        enabled: isFineEnabled,
                        rate_type: a.fine_rate_type || 'daily',
                        description: isFineEnabled ? 'Fine calculation enabled' : 'Fine not enabled',
                        ui_state: isFineEnabled ? 'active' : 'disabled',
                        can_select: isFineEnabled
                    },
                    break_penalty: {
                        enabled: breakPenaltyEnabled,
                        description: breakPenaltyEnabled ? `₹${a.break_excess_penalty_value} per excess minute` : 'Break penalty not enabled',
                        ui_state: breakPenaltyEnabled ? 'active' : 'disabled'
                    }
                },
                salary: {
                    monthly_salary: a.monthly_salary,
                    per_day: a.monthly_salary ? (a.monthly_salary / 30).toFixed(2) : 0,
                    deduction: a.monthly_salary ? (a.monthly_salary / 30) : 0,
                    settings: {
                        expected_hours: expectedHours,
                        working_hours: {
                            start: workingStart,
                            end: workingEnd
                        },
                        overtime: {
                            enabled: isOvertimeEnabled,
                            rate_type: a.overtime_rate_type || 'daily'
                        },
                        fine: {
                            enabled: isFineEnabled,
                            rate_type: a.fine_rate_type || 'daily'
                        },
                        break_settings: {
                            allowed_minutes: parseInt(a.allowed_break_minutes) || 30,
                            penalty_type: a.break_excess_penalty_type || 'fixed',
                            penalty_value: parseFloat(a.break_excess_penalty_value || 0)
                        }
                    }
                }
            };
        });

        // Calculate summary statistics
        const dutyTimeSummary = {
            total_expected_hours: attendance.reduce((sum, a) => sum + (a.salary_expected_hours || 8), 0),
            total_actual_hours: attendance.reduce((sum, a) => sum + ((a.total_minutes || 0) / 60), 0),
            total_overtime_hours: attendance.reduce((sum, a) => sum + ((a.extra_minutes || 0) / 60), 0),
            total_undertime_hours: attendance.reduce((sum, a) => sum + ((a.less_minutes || 0) / 60), 0),
            average_duty_hours: attendance.length > 0 ? 
                (attendance.reduce((sum, a) => sum + ((a.total_minutes || 0) / 60), 0) / attendance.length).toFixed(2) : 0
        };

        // NEW: Break summary for all attendance
        const breakSummary = {
            total_break_minutes: attendance.reduce((sum, a) => sum + (parseInt(a.total_break_minutes) || 0), 0),
            total_excess_break_minutes: attendance.reduce((sum, a) => sum + (parseInt(a.excess_break_minutes) || 0), 0),
            total_break_penalty: attendance.reduce((sum, a) => sum + (parseFloat(a.break_penalty_amount) || 0), 0),
            staff_with_excess_break: attendance.filter(a => (parseInt(a.excess_break_minutes) || 0) > 0).length
        };

        // NEW: Adjustments summary
        const adjustmentsSummary = {
            total_travel_allowance: attendance.reduce((sum, a) => sum + (parseFloat(a.travel_allowance_amount) || 0), 0),
            total_other_deductions: attendance.reduce((sum, a) => sum + (parseFloat(a.other_deduction_amount) || 0), 0),
            total_net_adjustment: attendance.reduce((sum, a) => sum + (parseFloat(a.net_adjustment_amount) || 0), 0),
            total_final_amount: attendance.reduce((sum, a) => sum + (parseFloat(a.final_calculated_amount) || 0), 0)
        };

        const featureSummary = {
            overtime_enabled_count: attendance.filter(a => {
                const enabled = a.overtime_enabled === '1' || a.overtime_enabled === 1 || a.overtime_enabled === true;
                return enabled;
            }).length,
            fine_enabled_count: attendance.filter(a => {
                const enabled = a.fine_enabled === '1' || a.fine_enabled === 1 || a.fine_enabled === true;
                return enabled;
            }).length,
            break_penalty_enabled_count: attendance.filter(a => {
                return parseFloat(a.break_excess_penalty_value || 0) > 0;
            }).length,
            total_with_overtime_feature: attendance.length,
            total_with_fine_feature: attendance.length,
            total_with_break_penalty: attendance.length
        };

        return res.status(200).json({
            success: true,
            message: `Attendance for date ${date} retrieved successfully`,
            data: {
                date: date,
                branch_id: branch_id,
                
                // Summary statistics
                summary: {
                    total_staff: attendance.length + absentStaff.length,
                    present: attendance.length,
                    absent: absentStaff.length,
                    
                    breakdown: {
                        present: present.length,
                        half_day: halfDay.length,
                        paid_leave: paidLeave.length,
                        fine: fine.length,
                        bonus: bonus.length,
                        pending: pending.length
                    },
                    
                    verification: {
                        verified: verified.length,
                        pending: pending.length
                    },
                    
                    // Duty time summary
                    duty_time: dutyTimeSummary,
                    
                    // NEW: Break summary
                    break_summary: breakSummary,
                    
                    // NEW: Adjustments summary
                    adjustments_summary: adjustmentsSummary,
                    
                    // Feature summary for UI
                    features: featureSummary
                },
                
                // UI Configuration
                ui_config: {
                    status_options: {
                        base_options: ['present', 'half_day', 'paid_leave', 'absent'],
                        conditional_options: {
                            overtime: {
                                enabled_field: 'overtime_enabled',
                                option_value: 'bonus',
                                display_name: 'Bonus (OT)'
                            },
                            fine: {
                                enabled_field: 'fine_enabled',
                                option_value: 'fine',
                                display_name: 'Fine'
                            }
                        }
                    },
                    break_settings: {
                        enabled_field: 'break_excess_penalty_value',
                        display_name: 'Break Penalty'
                    },
                    defaults: {
                        working_hours_start: '09:00:00',
                        working_hours_end: '18:00:00',
                        expected_hours: 8,
                        grace_period_minutes: 10,
                        allowed_break_minutes: 30
                    }
                },
                
                // Attendance records
                attendance: formattedAttendance,
                
                // Absent staff
                absent_staff: formattedAbsent
            },
            meta: {
                total_records: attendance.length,
                total_absent: absentStaff.length,
                date: date,
                branch_id: branch_id,
                filtered_by_staff: staff_username || null,
                duty_time_basis: "Based on salary configuration",
                feature_status: "OT, Fine, and Break Penalty status from staff_salary table"
            }
        });

    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch attendance by date',
            error: error.message
        });
    }
});

router.get('/showLoginTimes', auth, validateBranch, async (req, res) => {
    try {
        const loggedInUser = req.headers["username"];
        const branch_id = req.branch_id;
        const { username, from_date, to_date } = req.query;

        if (!loggedInUser) {
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

        // Check if user is admin or viewing own data
        const isAdmin = await checkIfAdmin(loggedInUser, branch_id);
        if (!isAdmin && username !== loggedInUser) {
            return res.status(403).json({
                success: false,
                message: "You can only view your own login times"
            });
        }

        // Get staff profile
        const [profile] = await pool.query(
            `SELECT 
                p.name,
                p.email,
                p.mobile,
                p.image,
                bm.designation,
                bm.map_id
             FROM profile p
             INNER JOIN branch_mapping bm ON p.username = bm.username
             WHERE p.username = ? AND bm.branch_id = ? AND bm.is_deleted = '0'`,
            [username, branch_id]
        );

        if (!profile.length) {
            return res.status(404).json({
                success: false,
                message: 'Staff not found'
            });
        }

        // Get active salary config for this employee (to know office timings)
        const [salaryConfig] = await pool.query(
            `SELECT working_hours_start, working_hours_end, expected_hours, grace_period_minutes
             FROM staff_salary 
             WHERE username = ? AND branch_id = ? AND is_active = '1' AND is_deleted = '0'`,
            [username, branch_id]
        );

        // Default office timings if no salary config found
        const officeStartTime = salaryConfig[0]?.working_hours_start || '10:00:00';
        const officeEndTime = salaryConfig[0]?.working_hours_end || '18:00:00';
        const gracePeriodMinutes = parseInt(salaryConfig[0]?.grace_period_minutes) || 10;

        // Build date filter
        let dateFilter = '';
        let params = [username, branch_id];

        if (from_date && to_date) {
            dateFilter = 'AND DATE(punch_in_time) BETWEEN ? AND ?';
            params.push(from_date, to_date);
        }

        // Get punch times with full details including attendance_id
        const [loginTimes] = await pool.query(
            `SELECT 
                attendance_id,
                DATE(punch_in_time) as login_date,
                TIME(punch_in_time) as punch_in_time,
                TIME(punch_out_time) as punch_out_time,
                attendance_status,
                total_minutes,
                is_verified,
                extra_minutes,
                less_minutes,
                grace_period_applied,
                is_manual
             FROM attendance 
             WHERE username = ? 
                AND branch_id = ? 
                AND is_deleted = '0'
                ${dateFilter}
             ORDER BY punch_in_time DESC`,
            params
        );

        // Process each login time with punctuality analysis
        const processedLoginTimes = [];
        let punctualityStats = {
            total_days: loginTimes.length,
            pre_entry: 0,      // Punched in BEFORE office start time
            on_time: 0,        // Punched in ON TIME (within grace period)
            late_entry: 0,     // Punched in LATE (after grace period)
            late_by_total_minutes: 0,
            early_by_total_minutes: 0,
            no_punch_in: 0,
            absent_days: 0
        };

        // Helper function to parse time string to minutes since midnight
        const timeToMinutes = (timeStr) => {
            if (!timeStr) return null;
            const parts = timeStr.split(':');
            return parseInt(parts[0]) * 60 + parseInt(parts[1]);
        };

        // Helper function to format minutes to HH:MM
        const minutesToTime = (minutes) => {
            if (minutes === null) return null;
            const hours = Math.floor(Math.abs(minutes) / 60);
            const mins = Math.abs(minutes) % 60;
            const sign = minutes < 0 ? '-' : '';
            return `${sign}${hours.toString().padStart(2, '0')}:${mins.toString().padStart(2, '0')}`;
        };

        const officeStartMinutes = timeToMinutes(officeStartTime);
        const graceMinutes = gracePeriodMinutes;

        for (const login of loginTimes) {
            const punchInTime = login.punch_in_time;
            let punctualityStatus = 'unknown';
            let timeDifferenceMinutes = 0;
            let timeDifferenceFormatted = null;
            let actualPunchInMinutes = null;
            
            if (punchInTime) {
                actualPunchInMinutes = timeToMinutes(punchInTime);
                timeDifferenceMinutes = actualPunchInMinutes - officeStartMinutes;
                timeDifferenceFormatted = minutesToTime(timeDifferenceMinutes);
                
                // Determine punctuality status
                if (actualPunchInMinutes < officeStartMinutes) {
                    // Punched in BEFORE office start time
                    punctualityStatus = 'pre_entry';
                    punctualityStats.pre_entry++;
                    punctualityStats.early_by_total_minutes += Math.abs(timeDifferenceMinutes);
                } 
                else if (actualPunchInMinutes <= officeStartMinutes + graceMinutes) {
                    // Punched in ON TIME (within grace period)
                    punctualityStatus = 'on_time';
                    punctualityStats.on_time++;
                } 
                else {
                    // Punched in LATE
                    punctualityStatus = 'late_entry';
                    punctualityStats.late_entry++;
                    punctualityStats.late_by_total_minutes += timeDifferenceMinutes;
                }
            } else {
                punctualityStatus = 'no_punch_in';
                punctualityStats.no_punch_in++;
            }

            processedLoginTimes.push({
                attendance_id: login.attendance_id,  // ADDED attendance_id
                date: login.login_date,
                office_time: officeStartTime,
                entry_time: punchInTime,
                exit_time: login.punch_out_time,
                punctuality_status: punctualityStatus,
                punctuality_label: punctualityStatus === 'pre_entry' ? 'Pre Entry' : 
                                 (punctualityStatus === 'on_time' ? 'On Time' : 
                                 (punctualityStatus === 'late_entry' ? 'Late Entry' : 'No Punch In')),
                time_difference: timeDifferenceFormatted,
                time_difference_minutes: timeDifferenceMinutes,
                status: login.attendance_status,
                status_display: getStatusDisplay(login.attendance_status),
                total_minutes: login.total_minutes,
                total_hours: login.total_minutes ? (login.total_minutes / 60).toFixed(2) : null,
                is_verified: login.is_verified === '1',
                is_manual: login.is_manual === '1',
                grace_period_applied: login.grace_period_applied,
                extra_minutes: login.extra_minutes,
                less_minutes: login.less_minutes
            });
        }

        // Calculate absent days separately (days with no attendance record)
        let absentDaysCount = 0;
        if (from_date && to_date) {
            const startDate = new Date(from_date);
            const endDate = new Date(to_date);
            const dateRange = [];
            for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
                dateRange.push(d.toISOString().split('T')[0]);
            }
            
            const existingDates = new Set(loginTimes.map(l => 
                new Date(l.login_date).toISOString().split('T')[0]
            ));
            
            for (const date of dateRange) {
                if (!existingDates.has(date)) {
                    absentDaysCount++;
                }
            }
            punctualityStats.absent_days = absentDaysCount;
            punctualityStats.total_days = loginTimes.length + absentDaysCount;
        }

        // Calculate punctuality percentages
        const totalDaysWithPunch = punctualityStats.pre_entry + punctualityStats.on_time + punctualityStats.late_entry;
        const punctualitySummary = {
            total_days_in_range: punctualityStats.total_days,
            days_with_punch_in: totalDaysWithPunch,
            absent_days: punctualityStats.absent_days,
            no_punch_in: punctualityStats.no_punch_in,
            
            pre_entry: {
                count: punctualityStats.pre_entry,
                percentage: totalDaysWithPunch > 0 ? ((punctualityStats.pre_entry / totalDaysWithPunch) * 100).toFixed(1) : '0.0',
                label: 'Pre Entry (Early)'
            },
            on_time: {
                count: punctualityStats.on_time,
                percentage: totalDaysWithPunch > 0 ? ((punctualityStats.on_time / totalDaysWithPunch) * 100).toFixed(1) : '0.0',
                label: 'On Time (Within Grace Period)'
            },
            late_entry: {
                count: punctualityStats.late_entry,
                percentage: totalDaysWithPunch > 0 ? ((punctualityStats.late_entry / totalDaysWithPunch) * 100).toFixed(1) : '0.0',
                label: 'Late Entry'
            }
        };

        // Calculate average lateness/earliness
        const averageLateMinutes = punctualityStats.late_entry > 0 ? 
            (punctualityStats.late_by_total_minutes / punctualityStats.late_entry) : 0;
        const averageEarlyMinutes = punctualityStats.pre_entry > 0 ? 
            (punctualityStats.early_by_total_minutes / punctualityStats.pre_entry) : 0;

        const overallPunctualityScore = totalDaysWithPunch > 0 ? 
            ((punctualityStats.on_time + punctualityStats.pre_entry) / totalDaysWithPunch * 100).toFixed(1) : '0.0';

        // Determine grade
        let grade = 'Needs Improvement';
        let rating = '2/5';
        if (parseFloat(overallPunctualityScore) >= 90) {
            grade = 'Excellent';
            rating = '5/5';
        } else if (parseFloat(overallPunctualityScore) >= 75) {
            grade = 'Good';
            rating = '4/5';
        } else if (parseFloat(overallPunctualityScore) >= 60) {
            grade = 'Average';
            rating = '3/5';
        }

        return res.status(200).json({
            success: true,
            message: 'Login times retrieved successfully with punctuality analysis',
            data: {
                staff: {
                    username: username,
                    name: profile[0].name,
                    email: profile[0].email,
                    mobile: profile[0].mobile,
                    image: profile[0].image,
                    designation: profile[0].designation,
                    map_id: profile[0].map_id
                },
                office_timing: {
                    start_time: officeStartTime,
                    end_time: officeEndTime,
                    grace_period_minutes: gracePeriodMinutes,
                    expected_hours: salaryConfig[0]?.expected_hours || 8,
                    on_time_window: `${officeStartTime} to ${minutesToTime(officeStartMinutes + graceMinutes)}`
                },
                punctuality_summary: {
                    total_days: punctualityStats.total_days,
                    analyzed_days: totalDaysWithPunch,
                    absent_days: punctualityStats.absent_days,
                    
                    counts: {
                        pre_entry: punctualityStats.pre_entry,
                        on_time: punctualityStats.on_time,
                        late_entry: punctualityStats.late_entry,
                        no_punch_in: punctualityStats.no_punch_in
                    },
                    
                    breakdown: punctualitySummary,
                    
                    averages: {
                        average_late_minutes: averageLateMinutes.toFixed(1),
                        average_late_formatted: minutesToTime(Math.round(averageLateMinutes)),
                        average_early_minutes: averageEarlyMinutes.toFixed(1),
                        average_early_formatted: minutesToTime(Math.round(averageEarlyMinutes)),
                        total_late_minutes: punctualityStats.late_by_total_minutes,
                        total_early_minutes: punctualityStats.early_by_total_minutes
                    },
                    
                    punctuality_score: {
                        score: parseFloat(overallPunctualityScore),
                        grade: grade,
                        rating: rating
                    },
                    
                    office_timing_note: `Office starts at ${officeStartTime}. Grace period of ${gracePeriodMinutes} minutes allowed.`
                },
                login_times: processedLoginTimes.map(login => ({
                    attendance_id: login.attendance_id,  // ADDED attendance_id at top level
                    date: login.date,
                    office_time: login.office_time,
                    entry_time: login.entry_time,
                    exit_time: login.exit_time,
                    punctuality: {
                        status: login.punctuality_status,
                        label: login.punctuality_label,
                        time_difference: login.time_difference,
                        time_difference_minutes: login.time_difference_minutes
                    },
                    attendance: {
                        status: login.status,
                        status_display: login.status_display,
                        total_hours: login.total_hours,
                        total_minutes: login.total_minutes,
                        is_verified: login.is_verified,
                        is_manual: login.is_manual
                    },
                    extra_details: {
                        extra_minutes: login.extra_minutes,
                        less_minutes: login.less_minutes,
                        grace_period_applied: login.grace_period_applied
                    }
                }))
            },
            meta: {
                filter: {
                    from_date: from_date || null,
                    to_date: to_date || null,
                    branch_id: branch_id
                },
                generated_at: new Date().toISOString(),
                punctuality_basis: "Based on office timing from salary configuration"
            }
        });

    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch login times',
            error: error.message
        });
    }
});

/**
 * ADMIN: Delete Attendance (Soft Delete)
 * Headers: 
 *   - Authorization: Bearer {token}
 *   - username: {admin_username}
 * Body: { attendance_id }
 */
router.post('/admin/delete', auth, validateBranch, async (req, res) => {
    try {
        const admin_username = req.headers["username"];
        const branch_id = req.branch_id;
        const { attendance_id } = req.body;

        if (!admin_username) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        if (!attendance_id) {
            return res.status(400).json({
                success: false,
                message: 'Attendance ID is required'
            });
        }

        // Get attendance record to know username
        const [attendance] = await pool.query(
            `SELECT username FROM attendance WHERE attendance_id = ? AND branch_id = ? AND is_deleted = '0'`,
            [attendance_id, branch_id]
        );

        if (!attendance.length) {
            return res.status(404).json({
                success: false,
                message: 'Attendance record not found'
            });
        }

        const [result] = await pool.query(
            `UPDATE attendance 
             SET is_deleted = '1', 
                 deleted_by = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE attendance_id = ? AND branch_id = ? AND is_deleted = '0'`,
            [admin_username, admin_username, attendance_id, branch_id]
        );

        // Get staff profile for response
        const profile = await getStaffProfile(attendance[0].username, branch_id);

        return res.status(200).json({
            success: true,
            message: 'Attendance record deleted successfully',
            data: {
                attendance_id,
                username: attendance[0].username,
                profile: profile ? {
                    name: profile.name,
                    email: profile.email,
                    designation: profile.designation
                } : null
            }
        });

    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to delete attendance',
            error: error.message
        });
    }
});

/**
 * ADMIN: Get Staff Salary History (FIXED - Proper boolean conversion)
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
                    image: profile.image,
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
router.get('/admin/monthly-attendance', auth, validateBranch, async (req, res) => {
    try {
        const admin_username = req.headers["username"];
        const branch_id = req.branch_id;
        const { 
            month, 
            year, 
            status,      // Optional: filter by status (present, absent, half_day, etc.)
            department,  // Optional: filter by department/designation
            page = 1, 
            limit = 50   // Number of staff per page
        } = req.query;

        if (!admin_username) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        if (!month || !year) {
            return res.status(400).json({
                success: false,
                message: 'Month and year are required'
            });
        }

        // Validate month
        const monthNum = parseInt(month);
        const yearNum = parseInt(year);
        
        if (monthNum < 1 || monthNum > 12) {
            return res.status(400).json({
                success: false,
                message: 'Invalid month. Month must be between 1 and 12'
            });
        }

        // Calculate date range for the month
        const startDate = `${yearNum}-${monthNum.toString().padStart(2, '0')}-01`;
        const endDate = new Date(yearNum, monthNum, 0).toISOString().split('T')[0]; // Last day of month
        
        // Get all days in the month
        const daysInMonth = new Date(yearNum, monthNum, 0).getDate();
        const monthDays = [];
        for (let i = 1; i <= daysInMonth; i++) {
            const date = `${yearNum}-${monthNum.toString().padStart(2, '0')}-${i.toString().padStart(2, '0')}`;
            const dayOfWeek = new Date(date).toLocaleDateString('en-US', { weekday: 'short' });
            monthDays.push({
                date,
                day: i,
                day_of_week: dayOfWeek,
                is_weekend: dayOfWeek === 'Sat' || dayOfWeek === 'Sun' // Adjust as per your weekend policy
            });
        }

        // Pagination
        const pageNum = Number(page) || 1;
        const limitNum = Number(limit) || 50;
        const offset = (pageNum - 1) * limitNum;

        // Base query to get all active staff in the branch
        // REMOVED: bm.joining_date (column doesn't exist)
        let staffQuery = `
            SELECT 
                bm.map_id,
                bm.username,
                bm.designation,
                p.name as staff_name,
                p.email,
                p.mobile,
                p.image,
                p.gender,
                p.date_of_birth,
                ss.monthly_salary,
                ss.effective_from as salary_effective_from
            FROM branch_mapping bm
            INNER JOIN profile p ON bm.username = p.username
            LEFT JOIN staff_salary ss ON bm.username = ss.username 
                AND ss.branch_id = ? 
                AND ss.is_active = '1' 
                AND ss.is_deleted = '0'
            WHERE bm.branch_id = ? 
                AND bm.type = 'staff'
                AND bm.is_accepted = '1'
                AND bm.is_deleted = '0'
        `;

        let countQuery = `
            SELECT COUNT(*) as total
            FROM branch_mapping bm
            WHERE bm.branch_id = ? 
                AND bm.type = 'staff'
                AND bm.is_accepted = '1'
                AND bm.is_deleted = '0'
        `;

        const staffParams = [branch_id, branch_id];
        const countParams = [branch_id];

        // Add department filter if provided
        if (department) {
            staffQuery += ' AND bm.designation = ?';
            staffParams.push(department);
            countQuery += ' AND bm.designation = ?';
            countParams.push(department);
        }

        // Get total count for pagination
        const [totalCount] = await pool.query(countQuery, countParams);

        // Add pagination to staff query
        staffQuery += ' ORDER BY p.name ASC LIMIT ? OFFSET ?';
        staffParams.push(limitNum, offset);

        // Get all staff
        const [staff] = await pool.query(staffQuery, staffParams);

        if (staff.length === 0) {
            return res.status(200).json({
                success: true,
                message: 'No staff found for this branch',
                data: {
                    month: monthNum,
                    year: yearNum,
                    total_staff: 0,
                    days: monthDays,
                    attendance: [],
                    summary: {}
                }
            });
        }

        // Get all attendance records for the month for these staff
        const usernames = staff.map(s => s.username);
        
        let attendanceQuery = `
            SELECT 
                a.username,
                a.map_id,
                DATE(a.punch_in_time) as attendance_date,
                a.punch_in_time,
                a.punch_out_time,
                a.total_minutes,
                a.attendance_status,
                a.is_verified,
                a.is_manual,
                a.manual_reason,
                a.calculated_amount,
                a.extra_minutes,
                a.less_minutes,
                TIME(a.punch_in_time) as punch_in_time_only,
                TIME(a.punch_out_time) as punch_out_time_only
            FROM attendance a
            WHERE a.branch_id = ? 
                AND a.username IN (${usernames.map(() => '?').join(',')})
                AND DATE(a.punch_in_time) BETWEEN ? AND ?
                AND a.is_deleted = '0'
        `;

        const attendanceParams = [branch_id, ...usernames, startDate, endDate];

        // Add status filter if provided
        if (status) {
            attendanceQuery += ' AND a.attendance_status = ?';
            attendanceParams.push(status);
        }

        attendanceQuery += ' ORDER BY a.punch_in_time DESC';

        const [attendance] = await pool.query(attendanceQuery, attendanceParams);

        // Organize attendance by staff and date
        const attendanceMap = {};
        attendance.forEach(record => {
            if (!attendanceMap[record.username]) {
                attendanceMap[record.username] = {};
            }
            attendanceMap[record.username][record.attendance_date] = record;
        });

        // Calculate summary statistics for each staff
        const staffAttendance = staff.map(staffMember => {
            const staffRecords = attendance.filter(a => a.username === staffMember.username);
            
            // Calculate monthly summary
            const summary = {
                total_days: daysInMonth,
                present_days: 0,
                absent_days: 0,
                half_days: 0,
                paid_leaves: 0,
                fine_days: 0,
                bonus_days: 0,
                pending_days: 0,
                total_extra_minutes: 0,
                total_less_minutes: 0,
                total_earned: 0,
                working_days: 0
            };

            staffRecords.forEach(record => {
                switch(record.attendance_status) {
                    case 'present':
                        summary.present_days++;
                        summary.working_days++;
                        break;
                    case 'half_day':
                        summary.half_days++;
                        summary.working_days += 0.5;
                        break;
                    case 'paid_leave':
                        summary.paid_leaves++;
                        summary.working_days++;
                        break;
                    case 'fine':
                        summary.fine_days++;
                        summary.working_days++;
                        break;
                    case 'bonus':
                        summary.bonus_days++;
                        summary.working_days++;
                        break;
                    case 'pending':
                        summary.pending_days++;
                        break;
                    default:
                        break;
                }

                summary.total_extra_minutes += record.extra_minutes || 0;
                summary.total_less_minutes += record.less_minutes || 0;
                summary.total_earned += record.calculated_amount || 0;
            });

            // Calculate absent days (days with no record)
            summary.absent_days = daysInMonth - staffRecords.length;

            // Calculate expected salary
            const expectedMonthlySalary = staffMember.monthly_salary || 0;
            const perDaySalary = expectedMonthlySalary / 30;

            // Build daily attendance matrix
            const dailyAttendance = monthDays.map(day => {
                const record = attendanceMap[staffMember.username]?.[day.date];
                
                if (record) {
                    return {
                        date: day.date,
                        day: day.day,
                        day_of_week: day.day_of_week,
                        status: record.attendance_status,
                        status_display: getStatusDisplay(record.attendance_status),
                        is_verified: record.is_verified === '1',
                        is_manual: record.is_manual === '1',
                        punch_in: record.punch_in_time_only,
                        punch_out: record.punch_out_time_only,
                        total_hours: record.total_minutes ? (record.total_minutes / 60).toFixed(2) : null,
                        extra_minutes: record.extra_minutes,
                        less_minutes: record.less_minutes,
                        calculated_amount: record.calculated_amount,
                        record_id: record.attendance_id
                    };
                } else {
                    // No record = absent
                    return {
                        date: day.date,
                        day: day.day,
                        day_of_week: day.day_of_week,
                        status: 'absent',
                        status_display: '❌ Absent',
                        is_verified: false,
                        is_manual: false,
                        punch_in: null,
                        punch_out: null,
                        total_hours: null,
                        extra_minutes: 0,
                        less_minutes: 0,
                        calculated_amount: 0
                    };
                }
            });

            return {
                staff_info: {
                    username: staffMember.username,
                    name: staffMember.staff_name,
                    email: staffMember.email,
                    mobile: staffMember.mobile,
                    image: staffMember.image,
                    gender: staffMember.gender,
                    date_of_birth: staffMember.date_of_birth,
                    designation: staffMember.designation,
                    map_id: staffMember.map_id
                },
                salary_info: {
                    monthly_salary: staffMember.monthly_salary || 0,
                    per_day: perDaySalary.toFixed(2),
                    per_hour: (perDaySalary / 8).toFixed(2),
                    per_minute: (perDaySalary / 480).toFixed(2)
                },
                summary: {
                    ...summary,
                    present_percentage: ((summary.present_days / daysInMonth) * 100).toFixed(1),
                    absent_percentage: ((summary.absent_days / daysInMonth) * 100).toFixed(1),
                    working_days: summary.working_days.toFixed(1),
                    expected_salary: expectedMonthlySalary,
                    earned_salary: Math.round(summary.total_earned),
                    difference: Math.round(summary.total_earned - expectedMonthlySalary),
                    extra_hours: (summary.total_extra_minutes / 60).toFixed(1),
                    less_hours: (summary.total_less_minutes / 60).toFixed(1)
                },
                daily_attendance: dailyAttendance
            };
        });

        // Apply status filter on staff level if needed
        let filteredStaffAttendance = staffAttendance;
        if (status) {
            filteredStaffAttendance = staffAttendance.filter(staff => 
                staff.daily_attendance.some(day => day.status === status)
            );
        }

        // Calculate overall summary
        const overallSummary = filteredStaffAttendance.reduce((acc, staff) => {
            acc.total_staff++;
            acc.total_present += staff.summary.present_days;
            acc.total_absent += staff.summary.absent_days;
            acc.total_half_days += staff.summary.half_days;
            acc.total_paid_leaves += staff.summary.paid_leaves;
            acc.total_fine_days += staff.summary.fine_days;
            acc.total_bonus_days += staff.summary.bonus_days;
            acc.total_pending_days += staff.summary.pending_days;
            acc.total_extra_minutes += staff.summary.total_extra_minutes;
            acc.total_less_minutes += staff.summary.total_less_minutes;
            acc.total_earned += staff.summary.total_earned;
            acc.total_expected += staff.salary_info.monthly_salary;
            return acc;
        }, {
            total_staff: 0,
            total_present: 0,
            total_absent: 0,
            total_half_days: 0,
            total_paid_leaves: 0,
            total_fine_days: 0,
            total_bonus_days: 0,
            total_pending_days: 0,
            total_extra_minutes: 0,
            total_less_minutes: 0,
            total_earned: 0,
            total_expected: 0
        });

        // Get department distribution
        const [departments] = await pool.query(
            `SELECT 
                designation,
                COUNT(*) as staff_count
             FROM branch_mapping
             WHERE branch_id = ? 
                AND type = 'staff'
                AND is_accepted = '1'
                AND is_deleted = '0'
             GROUP BY designation
             ORDER BY staff_count DESC`,
            [branch_id]
        );

        // Get status distribution for the month
        const [statusDistribution] = await pool.query(
            `SELECT 
                attendance_status,
                COUNT(*) as count
             FROM attendance
             WHERE branch_id = ? 
                AND DATE(punch_in_time) BETWEEN ? AND ?
                AND is_deleted = '0'
             GROUP BY attendance_status`,
            [branch_id, startDate, endDate]
        );

        return res.status(200).json({
            success: true,
            message: 'Monthly attendance report generated successfully',
            data: {
                period: {
                    month: monthNum,
                    month_name: new Date(yearNum, monthNum - 1).toLocaleString('default', { month: 'long' }),
                    year: yearNum,
                    start_date: startDate,
                    end_date: endDate,
                    days_in_month: daysInMonth
                },
                branch_id: branch_id,
                
                // Calendar days
                days: monthDays,
                
                // Overall summary
                overall_summary: {
                    total_staff: overallSummary.total_staff,
                    total_attendance_records: attendance.length,
                    
                    attendance_breakdown: {
                        present: overallSummary.total_present,
                        absent: overallSummary.total_absent,
                        half_day: overallSummary.total_half_days,
                        paid_leave: overallSummary.total_paid_leaves,
                        fine: overallSummary.total_fine_days,
                        bonus: overallSummary.total_bonus_days,
                        pending: overallSummary.total_pending_days
                    },
                    
                    time_breakdown: {
                        total_extra_hours: (overallSummary.total_extra_minutes / 60).toFixed(1),
                        total_less_hours: (overallSummary.total_less_minutes / 60).toFixed(1),
                        avg_extra_per_staff: overallSummary.total_staff > 0 ? 
                            ((overallSummary.total_extra_minutes / overallSummary.total_staff) / 60).toFixed(1) : '0.0',
                        avg_less_per_staff: overallSummary.total_staff > 0 ? 
                            ((overallSummary.total_less_minutes / overallSummary.total_staff) / 60).toFixed(1) : '0.0'
                    },
                    
                    salary_summary: {
                        total_expected: Math.round(overallSummary.total_expected),
                        total_earned: Math.round(overallSummary.total_earned),
                        total_difference: Math.round(overallSummary.total_earned - overallSummary.total_expected),
                        average_per_staff: overallSummary.total_staff > 0 ? 
                            Math.round(overallSummary.total_earned / overallSummary.total_staff) : 0
                    }
                },
                
                // Department distribution
                department_distribution: departments,
                
                // Status distribution
                status_distribution: statusDistribution.map(s => ({
                    status: s.attendance_status,
                    status_display: getStatusDisplay(s.attendance_status),
                    count: s.count
                })),
                
                // Staff attendance details
                staff_attendance: filteredStaffAttendance,
                
                // Pagination info
                pagination: {
                    current_page: pageNum,
                    per_page: limitNum,
                    total_staff: totalCount[0].total,
                    total_pages: Math.ceil(totalCount[0].total / limitNum),
                    showing_from: offset + 1,
                    showing_to: Math.min(offset + limitNum, totalCount[0].total)
                }
            },
            meta: {
                filters_applied: {
                    month: monthNum,
                    year: yearNum,
                    status: status || 'all',
                    department: department || 'all',
                    branch_id: branch_id
                },
                generated_by: admin_username,
                generated_at: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Error generating monthly attendance report:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to generate monthly attendance report',
            error: error.message
        });
    }
});

// Helper function to get status display
function getStatusDisplay(status) {
    const displays = {
        'present': '✅ Present',
        'absent': '❌ Absent',
        'half_day': '⚠️ Half Day',
        'paid_leave': '💰 Paid Leave',
        'fine': '💰 Fine',
        'bonus': '✨ Bonus',
        'pending': '⏳ Pending'
    };
    return displays[status] || status;
}


//Week Off Day API 

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
                    image: profile.image
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
                    image: profile.image
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
router.get('/admin/employee-login-history/:username/by-date', auth, validateBranch, async (req, res) => {
    try {
        const admin_username = req.headers["username"];
        const branch_id = req.branch_id;
        const { username } = req.params;
        const { date } = req.query;

        if (!admin_username) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        if (!date) {
            return res.status(400).json({
                success: false,
                message: "Date is required (YYYY-MM-DD)"
            });
        }

        // Validate date format
        const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
        if (!dateRegex.test(date)) {
            return res.status(400).json({
                success: false,
                message: "Invalid date format. Use YYYY-MM-DD"
            });
        }

        // Get employee profile
        const profile = await getStaffProfile(username, branch_id);
        
        if (!profile) {
            return res.status(404).json({
                success: false,
                message: 'Employee not found in this branch'
            });
        }

        // Get attendance record for specific date - Using only existing columns
        const [attendance] = await pool.query(
            `SELECT 
                a.attendance_id,
                a.map_id,
                a.username,
                a.branch_id,
                a.punch_in_time,
                a.punch_out_time,
                a.punch_in_latitude,
                a.punch_in_longitude,
                a.punch_out_latitude,
                a.punch_out_longitude,
                a.total_minutes,
                a.expected_minutes,
                a.extra_minutes,
                a.less_minutes,
                a.attendance_status,
                a.is_verified,
                a.verified_by,
                a.verified_date,
                a.admin_remarks,
                a.is_manual,
                a.manual_reason,
                a.per_day_salary,
                a.calculated_amount,
                a.create_by,
                a.modify_by,
                a.create_date,
                a.modify_date,
                
                -- Calculated fields
                DATE(a.punch_in_time) as attendance_date,
                TIME(a.punch_in_time) as punch_in_time_only,
                TIME(a.punch_out_time) as punch_out_time_only,
                
                -- Get verification details
                v.name as verified_by_name,
                v.email as verified_by_email,
                
                -- Determine if modified (based on create_date vs modify_date)
                CASE 
                    WHEN a.create_date != a.modify_date THEN 'Yes'
                    ELSE 'No'
                END as was_modified,
                
                -- Format modification info
                CONCAT(
                    'Created: ', DATE_FORMAT(a.create_date, '%Y-%m-%d %H:%i'), ' by ', a.create_by,
                    IF(a.modify_date != a.create_date, 
                       CONCAT(' | Modified: ', DATE_FORMAT(a.modify_date, '%Y-%m-%d %H:%i'), ' by ', a.modify_by), 
                       ''
                    )
                ) as modification_timeline,
                
                -- Calculate time differences for audit
                TIMESTAMPDIFF(MINUTE, a.create_date, a.modify_date) as modification_delay_minutes,
                
                -- Check if record was modified
                CASE 
                    WHEN a.is_manual = '1' THEN 'Manual Entry'
                    WHEN a.create_date != a.modify_date THEN 'Modified'
                    ELSE 'Original Entry'
                END as modification_type

            FROM attendance a
            LEFT JOIN profile v ON a.verified_by = v.username
            WHERE a.username = ? 
                AND a.branch_id = ? 
                AND DATE(a.punch_in_time) = ?
                AND a.is_deleted = '0'`,
            [username, branch_id, date]
        );

        // If no record found, return absent status
        if (attendance.length === 0) {
            return res.status(200).json({
                success: true,
                message: 'No login record found for this date',
                data: {
                    date: date,
                    employee: {
                        username: username,
                        profile: {
                            name: profile.name,
                            email: profile.email,
                            mobile: profile.mobile,
                            designation: profile.designation,
                            image: profile.image
                        }
                    },
                    status: 'absent',
                    attendance: null,
                    summary: {
                        has_record: false,
                        is_present: false,
                        is_modified: false,
                        is_manual: false,
                        is_verified: false
                    }
                }
            });
        }

        const record = attendance[0];

        // Calculate modifications based on available data
        const modifications = [];
        
        // Check for manual entry
        if (record.is_manual === '1') {
            modifications.push({
                type: 'manual_entry',
                reason: record.manual_reason,
                details: 'Record was manually created by admin',
                created_by: record.create_by,
                created_at: record.create_date
            });
        }
        
        // Check for modifications based on create/modify dates
        if (record.create_date !== record.modify_date) {
            modifications.push({
                type: 'edited',
                details: 'Record was modified after creation',
                modified_by: record.modify_by,
                modified_at: record.modify_date,
                delay_minutes: record.modification_delay_minutes
            });
        }
        
        // Check for verification
        if (record.is_verified === '1') {
            modifications.push({
                type: 'verified',
                details: 'Record was verified',
                verified_by: record.verified_by,
                verified_by_name: record.verified_by_name,
                verified_at: record.verified_date,
                remarks: record.admin_remarks
            });
        }

        // Calculate working hours
        const workingHours = {
            total_minutes: record.total_minutes,
            total_hours: record.total_minutes ? (record.total_minutes / 60).toFixed(2) : null,
            expected_minutes: record.expected_minutes,
            extra_minutes: record.extra_minutes,
            less_minutes: record.less_minutes,
            extra_hours: record.extra_minutes ? (record.extra_minutes / 60).toFixed(2) : null,
            less_hours: record.less_minutes ? (record.less_minutes / 60).toFixed(2) : null
        };

        // Format the response
        const loginHistory = {
            attendance_id: record.attendance_id,
            date: record.attendance_date,
            
            // Employee Info
            employee: {
                username: username,
                profile: {
                    name: profile.name,
                    email: profile.email,
                    mobile: profile.mobile,
                    designation: profile.designation,
                    image: profile.image
                }
            },
            
            // Login/Logout Times
            login_logout: {
                punch_in: {
                    datetime: record.punch_in_time,
                    time: record.punch_in_time_only,
                    timestamp: record.punch_in_time ? new Date(record.punch_in_time).getTime() : null,
                    location: {
                        latitude: record.punch_in_latitude,
                        longitude: record.punch_in_longitude,
                        has_location: !!(record.punch_in_latitude && record.punch_in_longitude)
                    }
                },
                punch_out: {
                    datetime: record.punch_out_time,
                    time: record.punch_out_time_only,
                    timestamp: record.punch_out_time ? new Date(record.punch_out_time).getTime() : null,
                    location: {
                        latitude: record.punch_out_latitude,
                        longitude: record.punch_out_longitude,
                        has_location: !!(record.punch_out_latitude && record.punch_out_longitude)
                    }
                }
            },
            
            // Working Hours
            working_hours: workingHours,
            
            // Status
            status: {
                code: record.attendance_status,
                display: getStatusDisplay(record.attendance_status),
                is_verified: record.is_verified === '1',
                verified_by: record.verified_by,
                verified_by_name: record.verified_by_name,
                verified_at: record.verified_date,
                remarks: record.admin_remarks
            },
            
            // Record Type
            record_type: {
                is_manual: record.is_manual === '1',
                is_modified: record.create_date !== record.modify_date,
                is_original: record.create_date === record.modify_date && record.is_manual === '0',
                modification_type: record.modification_type,
                manual_reason: record.manual_reason
            },
            
            // Modifications History
            modifications: modifications,
            has_modifications: modifications.length > 0,
            
            // Audit Trail
            audit: {
                created_by: record.create_by,
                created_at: record.create_date,
                last_modified_by: record.modify_by,
                last_modified_at: record.modify_date,
                modification_timeline: record.modification_timeline,
                modification_count: modifications.length
            },
            
            // Salary Info
            salary: {
                per_day_salary: record.per_day_salary,
                calculated_amount: record.calculated_amount,
                per_day: record.per_day_salary ? parseFloat(record.per_day_salary).toFixed(2) : null,
                earned: record.calculated_amount ? parseFloat(record.calculated_amount).toFixed(2) : null
            }
        };

        // Summary statistics for this date
        const summary = {
            date: date,
            has_record: true,
            is_present: record.attendance_status !== 'absent',
            is_modified: record.create_date !== record.modify_date,
            is_manual: record.is_manual === '1',
            is_verified: record.is_verified === '1',
            modification_count: modifications.length,
            working_hours: workingHours.total_hours
        };

        return res.status(200).json({
            success: true,
            message: `Login history for ${username} on ${date} retrieved successfully`,
            data: {
                query_info: {
                    username: username,
                    date: date,
                    branch_id: branch_id,
                    requested_by: admin_username
                },
                summary: summary,
                history: loginHistory
            }
        });

    } catch (error) {
        console.error('Error fetching employee login history by date:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch employee login history',
            error: error.message
        });
    }
});

//my monthly attendance report API for employee


/**
 * STAFF: Get Monthly Attendance Summary
 * Headers: 
 *   - Authorization: Bearer {token}
 *   - username: {admin_username OR staff_username}
 * Params: username (staff username)
 * Query: month, year (optional - defaults to current month)
 * 
 * Returns:
 * - Total Days: Total days in month
 * - Not Marked: Future dates or dates with no punch
 * - Present: Present + Bonus days
 * - Absent: Absent days (no record and not weekly off)
 * - Half day: Half day entries
 * - Over Time: Total overtime minutes/hours
 * - Fine Hours: Total fine hours (less minutes)
 * - Paid Leave: Weekly off days count
 */
router.get('/staff-monthly-summary/:username', auth, validateBranch, async (req, res) => {
    try {
        const loggedInUser = req.headers["username"];
        const branch_id = req.branch_id;
        const staff_username = req.params.username;
        
        // Get month and year from query params
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

        // Validate month and year
        if (targetMonth < 1 || targetMonth > 12) {
            return res.status(400).json({
                success: false,
                message: 'Invalid month. Month must be between 1 and 12'
            });
        }

        // Calculate date range for the month
        const startDate = `${targetYear}-${targetMonth.toString().padStart(2, '0')}-01`;
        const endDate = new Date(targetYear, targetMonth, 0).toISOString().split('T')[0];
        
        // Get total days in month
        const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();

        // Get staff profile
        const profile = await getStaffProfile(staff_username, branch_id);
        
        if (!profile) {
            return res.status(404).json({
                success: false,
                message: 'Staff not found in this branch'
            });
        }

        // Get all attendance records for the month
        const [attendance] = await pool.query(
            `SELECT 
                DATE(punch_in_time) as date,
                DAY(punch_in_time) as day,
                attendance_status,
                is_verified,
                total_minutes,
                extra_minutes,
                less_minutes,
                punch_in_time,
                punch_out_time
             FROM attendance 
             WHERE username = ? 
                AND branch_id = ? 
                AND DATE(punch_in_time) BETWEEN ? AND ?
                AND is_deleted = '0'
             ORDER BY punch_in_time`,
            [staff_username, branch_id, startDate, endDate]
        );

        // Get weekly off for staff
        const [weeklyOff] = await pool.query(
            `SELECT weekly_off_day 
             FROM employee_weekly_off 
             WHERE username = ? AND branch_id = ? AND is_active = '1' AND is_deleted = '0'`,
            [staff_username, branch_id]
        );

        // Create a map of attendance dates
        const attendanceMap = {};
        attendance.forEach(record => {
            attendanceMap[record.day] = record;
        });

        // Initialize counters for the exact fields you want
        let present = 0;        // Present + Bonus days
        let absent = 0;         // Days with no record and not weekly off
        let halfDay = 0;        // Half day entries
        let paidLeave = 0;      // Weekly off days
        let notMarked = 0;      // Future dates or dates with no punch
        
        let totalExtraMinutes = 0;  // For Over Time
        let totalLessMinutes = 0;    // For Fine Hours
        
        // Get current date for checking future dates
        const today = new Date();
        const currentDay = today.getDate();
        const currentMonth = today.getMonth() + 1;
        const currentYear = today.getFullYear();

        // Process each day of the month
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${targetYear}-${targetMonth.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
            const dateObj = new Date(dateStr);
            const dayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
            
            // Check if it's weekly off
            const isWeeklyOff = weeklyOff.length > 0 && weeklyOff[0].weekly_off_day === dayOfWeek;
            
            // Check if it's a future date
            const isFutureDate = (targetYear > currentYear) || 
                                (targetYear === currentYear && targetMonth > currentMonth) ||
                                (targetYear === currentYear && targetMonth === currentMonth && day > currentDay);
            
            const attendanceRecord = attendanceMap[day];

            if (isWeeklyOff) {
                // Weekly off day counts as Paid Leave
                paidLeave++;
            }
            else if (attendanceRecord) {
                // Has attendance record
                switch(attendanceRecord.attendance_status) {
                    case 'present':
                    case 'bonus':      // Bonus counts as Present
                        present++;
                        break;
                    case 'half_day':
                        halfDay++;
                        break;
                    case 'paid_leave':
                        present++;      // Paid leave counts as Present
                        break;
                    case 'fine':
                        present++;      // Fine day counts as Present (but with fine hours)
                        totalLessMinutes += attendanceRecord.less_minutes || 0;
                        break;
                    case 'pending':
                        present++;      // Pending counts as Present for now
                        break;
                    case 'absent':
                        absent++;
                        break;
                    default:
                        absent++;
                }

                // Add extra/less minutes for overtime/fine hours
                totalExtraMinutes += attendanceRecord.extra_minutes || 0;
                totalLessMinutes += attendanceRecord.less_minutes || 0;
            }
            else if (isFutureDate) {
                // Future dates are Not Marked
                notMarked++;
            }
            else {
                // Past date with no record = Absent
                absent++;
            }
        }

        // Calculate totals
        const totalDays = daysInMonth;
        
        // Format Over Time
        const overTimeHours = Math.floor(totalExtraMinutes / 60);
        const overTimeMinutes = totalExtraMinutes % 60;
        const overTimeFormatted = totalExtraMinutes > 0 ? 
            `${overTimeHours}h ${overTimeMinutes}m` : '0h 0m';
        
        // Format Fine Hours
        const fineHours = Math.floor(totalLessMinutes / 60);
        const fineMinutes = totalLessMinutes % 60;
        const fineHoursFormatted = totalLessMinutes > 0 ? 
            `${fineHours}h ${fineMinutes}m` : '0h 0m';

        // Get salary info
        const [salary] = await pool.query(
            `SELECT monthly_salary 
             FROM staff_salary 
             WHERE username = ? AND branch_id = ? AND is_active = '1' AND is_deleted = '0'`,
            [staff_username, branch_id]
        );

        return res.status(200).json({
            success: true,
            message: `Monthly attendance summary for ${staff_username} retrieved successfully`,
            data: {
                staff_info: {
                    username: staff_username,
                    name: profile.name,
                    email: profile.email,
                    mobile: profile.mobile,
                    designation: profile.designation,
                    image: profile.image
                },
                period: {
                    month: targetMonth,
                    month_name: new Date(targetYear, targetMonth - 1).toLocaleString('default', { month: 'long' }),
                    year: targetYear,
                    start_date: startDate,
                    end_date: endDate
                },
                salary: {
                    monthly_salary: salary[0]?.monthly_salary || 0,
                    per_day: salary[0]?.monthly_salary ? (salary[0].monthly_salary / 30).toFixed(2) : 0
                },
                summary: {
                    // EXACT FIELDS YOU REQUESTED
                    total_days: totalDays,
                    not_marked: notMarked,
                    present: present,
                    absent: absent,
                    half_day: halfDay,
                    over_time: {
                        minutes: totalExtraMinutes,
                        hours: overTimeHours,
                        minutes_remainder: overTimeMinutes,
                        formatted: overTimeFormatted
                    },
                    fine_hours: {
                        minutes: totalLessMinutes,
                        hours: fineHours,
                        minutes_remainder: fineMinutes,
                        formatted: fineHoursFormatted
                    },
                    paid_leave: paidLeave  // Weekly off days
                },
                weekly_off_day: weeklyOff.length > 0 ? weeklyOff[0].weekly_off_day : 'Not Set',
                
                // Detailed breakdown for reference
                detailed_breakdown: {
                    present_breakdown: {
                        regular_present: attendance.filter(a => a.attendance_status === 'present').length,
                        bonus_as_present: attendance.filter(a => a.attendance_status === 'bonus').length,
                        paid_leave_as_present: attendance.filter(a => a.attendance_status === 'paid_leave').length,
                        pending_as_present: attendance.filter(a => a.attendance_status === 'pending').length,
                        fine_as_present: attendance.filter(a => a.attendance_status === 'fine').length
                    },
                    weekly_off_days: paidLeave,
                    future_days: notMarked
                }
            }
        });

    } catch (error) {
        console.error('Error fetching monthly summary:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch monthly attendance summary',
            error: error.message
        });
    }
});
// Calendar API - Get attendance calendar view (No Icons)
router.get('/attendance-calendar/:username', auth, validateBranch, async (req, res) => {
    try {
        console.log('=== Calendar API Started ===');
        
        const loggedInUser = req.headers["username"];
        const branch_id = req.branch_id;
        const paramUsername = req.params.username;
        
        // Determine which username to use
        const targetUsername = paramUsername || loggedInUser;
        
        if (!targetUsername) {
            return res.status(400).json({
                success: false,
                message: "Username is required either in header or params"
            });
        }
        
        // Get month and year from query params
        const { month, year } = req.query;
        const targetMonth = month ? parseInt(month) : new Date().getMonth() + 1;
        const targetYear = year ? parseInt(year) : new Date().getFullYear();

        if (!loggedInUser) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        if (targetMonth < 1 || targetMonth > 12) {
            return res.status(400).json({
                success: false,
                message: 'Invalid month. Month must be between 1 and 12'
            });
        }

        // Calculate date range for the month
        const startDate = `${targetYear}-${targetMonth.toString().padStart(2, '0')}-01`;
        const endDate = new Date(targetYear, targetMonth, 0).toISOString().split('T')[0];
        
        // Get total days in month
        const daysInMonth = new Date(targetYear, targetMonth, 0).getDate();
        
        // Get first day of month (0 = Sunday, 1 = Monday, etc.)
        const firstDayOfMonth = new Date(targetYear, targetMonth - 1, 1).getDay();

        // Get staff profile
        let staffName = targetUsername;
        let staffDesignation = 'Staff';
        let staffEmail = '';
        let staffMobile = '';
        let staffImage = null;
        
        try {
            const profile = await getStaffProfile(targetUsername, branch_id);
            if (profile) {
                staffName = profile.name || targetUsername;
                staffEmail = profile.email || '';
                staffMobile = profile.mobile || '';
                staffDesignation = profile.designation || 'Staff';
                staffImage = profile.image || null;
            }
        } catch (profileError) {
            console.log('Profile fetch error:', profileError.message);
        }

        // Get weekly off for staff
        const [weeklyOffData] = await pool.query(
            `SELECT weekly_off_day 
             FROM employee_weekly_off 
             WHERE username = ? AND branch_id = ? AND is_active = '1' AND is_deleted = '0'`,
            [targetUsername, branch_id]
        );
        
        const weeklyOffDay = weeklyOffData.length > 0 ? weeklyOffData[0].weekly_off_day : null;

        // Get all attendance records for the month - INCLUDING attendance_id
        const [attendance] = await pool.query(
            `SELECT 
                attendance_id,
                DAY(punch_in_time) as day,
                attendance_status,
                is_verified,
                total_minutes,
                extra_minutes,
                less_minutes,
                TIME(punch_in_time) as punch_in_time,
                TIME(punch_out_time) as punch_out_time,
                is_manual,
                manual_reason,
                calculated_amount,
                verified_by,
                verified_date,
                admin_remarks
             FROM attendance 
             WHERE username = ? 
                AND branch_id = ? 
                AND DATE(punch_in_time) BETWEEN ? AND ?
                AND is_deleted = '0'
             ORDER BY punch_in_time`,
            [targetUsername, branch_id, startDate, endDate]
        );

        // Create a map of attendance for easy lookup
        const attendanceMap = {};
        attendance.forEach(record => {
            attendanceMap[record.day] = record;
        });

        // Get current date for checking future dates
        const today = new Date();
        const currentDay = today.getDate();
        const currentMonth = today.getMonth() + 1;
        const currentYear = today.getFullYear();

        // Generate calendar days
        const calendarDays = [];
        const dayStatusCounts = {
            present: 0,
            absent: 0,
            half_day: 0,
            paid_leave: 0,
            fine: 0,
            bonus: 0,
            pending: 0,
            weekly_off: 0,
            future: 0
        };

        // Status configurations (without icons)
        const statusConfig = {
            present: { display: 'Present', color: '#4CAF50' },
            absent: { display: 'Absent', color: '#F44336' },
            half_day: { display: 'Half Day', color: '#FFC107' },
            paid_leave: { display: 'Paid Leave', color: '#2196F3' },
            fine: { display: 'Fine', color: '#FF5722' },
            bonus: { display: 'Bonus', color: '#9C27B0' },
            pending: { display: 'Pending', color: '#9E9E9E' },
            weekly_off: { display: 'Weekly Off', color: '#FF9800' },
            future: { display: 'Future', color: '#E0E0E0' }
        };

        // Generate all dates of the month
        for (let day = 1; day <= daysInMonth; day++) {
            const dateStr = `${targetYear}-${targetMonth.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
            const dateObj = new Date(dateStr);
            const dayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
            const dayOfWeekShort = dateObj.toLocaleDateString('en-US', { weekday: 'short' });
            
            const attendanceRecord = attendanceMap[day];
            
            // Check if it's weekly off
            const isWeeklyOff = weeklyOffDay === dayOfWeek;
            
            // Check if it's a future date
            const isFutureDate = (targetYear > currentYear) || 
                                (targetYear === currentYear && targetMonth > currentMonth) ||
                                (targetYear === currentYear && targetMonth === currentMonth && day > currentDay);
            
            // Check if it's today
            const isToday = (targetYear === currentYear && targetMonth === currentMonth && day === currentDay);

            // Determine status
            let status = 'absent';
            let details = {};
            let attendance_id = null;

            if (isWeeklyOff) {
                status = 'weekly_off';
                dayStatusCounts.weekly_off++;
            }
            else if (attendanceRecord) {
                status = attendanceRecord.attendance_status;
                attendance_id = attendanceRecord.attendance_id;
                details = {
                    attendance_id: attendanceRecord.attendance_id,
                    is_verified: attendanceRecord.is_verified === '1',
                    is_manual: attendanceRecord.is_manual === '1',
                    punch_in: attendanceRecord.punch_in_time,
                    punch_out: attendanceRecord.punch_out_time,
                    total_hours: attendanceRecord.total_minutes ? (attendanceRecord.total_minutes / 60).toFixed(2) : null,
                    extra_minutes: attendanceRecord.extra_minutes || 0,
                    less_minutes: attendanceRecord.less_minutes || 0,
                    calculated_amount: attendanceRecord.calculated_amount || 0,
                    manual_reason: attendanceRecord.manual_reason,
                    verified_by: attendanceRecord.verified_by,
                    verified_date: attendanceRecord.verified_date,
                    admin_remarks: attendanceRecord.admin_remarks
                };

                // Increment counter based on status
                switch(status) {
                    case 'present': dayStatusCounts.present++; break;
                    case 'half_day': dayStatusCounts.half_day++; break;
                    case 'paid_leave': dayStatusCounts.paid_leave++; break;
                    case 'fine': dayStatusCounts.fine++; break;
                    case 'bonus': dayStatusCounts.bonus++; break;
                    case 'pending': dayStatusCounts.pending++; break;
                    default: dayStatusCounts.absent++; break;
                }
            }
            else if (isFutureDate) {
                status = 'future';
                dayStatusCounts.future++;
            }
            else {
                status = 'absent';
                dayStatusCounts.absent++;
            }

            const config = statusConfig[status] || statusConfig.absent;

            calendarDays.push({
                day: day,
                date: dateStr,
                day_of_week: dayOfWeek,
                day_of_week_short: dayOfWeekShort,
                is_today: isToday,
                is_weekend: dayOfWeek === 'Saturday' || dayOfWeek === 'Sunday',
                is_future: isFutureDate,
                is_weekly_off: isWeeklyOff,
                status: status,
                status_display: config.display,
                color: config.color,
                attendance_id: attendance_id,
                details: details,
                has_attendance: !!attendanceRecord
            });
        }

        // Calculate summary statistics
        const workedDays = dayStatusCounts.present + 
                          (dayStatusCounts.half_day * 0.5) + 
                          dayStatusCounts.paid_leave + 
                          dayStatusCounts.bonus;

        const totalWorkingDays = daysInMonth - dayStatusCounts.weekly_off;
        
        const summary = {
            total_days: daysInMonth,
            working_days: totalWorkingDays,
            worked_days: parseFloat(workedDays.toFixed(1)),
            present: dayStatusCounts.present,
            absent: dayStatusCounts.absent,
            half_day: dayStatusCounts.half_day,
            paid_leave: dayStatusCounts.paid_leave,
            fine: dayStatusCounts.fine,
            bonus: dayStatusCounts.bonus,
            pending: dayStatusCounts.pending,
            weekly_off: dayStatusCounts.weekly_off,
            future: dayStatusCounts.future,
            attendance_percentage: totalWorkingDays > 0 ? 
                ((workedDays / totalWorkingDays) * 100).toFixed(1) : '0.0'
        };

        // Generate calendar weeks structure
        const calendarWeeks = [];
        let currentWeek = [];
        
        // Add empty cells for days before month starts
        for (let i = 0; i < firstDayOfMonth; i++) {
            currentWeek.push(null);
        }
        
        // Add all days of the month
        calendarDays.forEach(day => {
            currentWeek.push(day);
            if (currentWeek.length === 7) {
                calendarWeeks.push([...currentWeek]);
                currentWeek = [];
            }
        });
        
        // Add empty cells for days after month ends
        if (currentWeek.length > 0) {
            while (currentWeek.length < 7) {
                currentWeek.push(null);
            }
            calendarWeeks.push(currentWeek);
        }

        // Check if requester is admin
        let isAdmin = false;
        try {
            const [adminCheck] = await pool.query(
                `SELECT type FROM branch_mapping 
                 WHERE username = ? AND branch_id = ? AND type = 'admin' AND is_deleted = '0'`,
                [loggedInUser, branch_id]
            );
            isAdmin = adminCheck.length > 0;
        } catch (error) {
            console.log('Branch mapping check error:', error.message);
        }

        // Get salary info
        let monthlySalary = 0;
        try {
            const [salaryData] = await pool.query(
                `SELECT monthly_salary FROM staff_salary 
                 WHERE username = ? AND branch_id = ? AND is_active = '1' AND is_deleted = '0'`,
                [targetUsername, branch_id]
            );
            monthlySalary = salaryData.length > 0 ? salaryData[0].monthly_salary : 0;
        } catch (error) {
            console.log('Salary fetch error:', error.message);
        }

        return res.status(200).json({
            success: true,
            message: `Attendance calendar for ${targetUsername} retrieved successfully`,
            data: {
                staff_info: {
                    username: targetUsername,
                    name: staffName,
                    email: staffEmail,
                    mobile: staffMobile,
                    designation: staffDesignation,
                    image: staffImage
                },
                requester_info: {
                    username: loggedInUser,
                    is_admin: isAdmin,
                    is_self: loggedInUser === targetUsername
                },
                calendar_info: {
                    month: targetMonth,
                    month_name: new Date(targetYear, targetMonth - 1).toLocaleString('default', { month: 'long' }),
                    year: targetYear,
                    first_day: firstDayOfMonth,
                    days_in_month: daysInMonth,
                    weekly_off: weeklyOffDay || 'Not Set'
                },
                summary: summary,
                calendar_days: calendarDays,
                calendar_weeks: calendarWeeks,
                
                // Color legend for UI (without icons)
                legend: [
                    { status: 'present', label: 'Present', color: '#4CAF50' },
                    { status: 'absent', label: 'Absent', color: '#F44336' },
                    { status: 'half_day', label: 'Half Day', color: '#FFC107' },
                    { status: 'paid_leave', label: 'Paid Leave', color: '#2196F3' },
                    { status: 'fine', label: 'Fine', color: '#FF5722' },
                    { status: 'bonus', label: 'Bonus', color: '#9C27B0' },
                    { status: 'pending', label: 'Pending', color: '#9E9E9E' },
                    { status: 'weekly_off', label: 'Weekly Off', color: '#FF9800' },
                    { status: 'future', label: 'Future', color: '#E0E0E0' }
                ],
                
                salary: {
                    monthly_salary: monthlySalary,
                    per_day: monthlySalary ? (monthlySalary / 30).toFixed(2) : '0.00'
                }
            }
        });

    } catch (error) {
        console.error('Calendar API Error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch attendance calendar',
            error: error.message
        });
    }
});

//monthly salary view

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

        // ============ UPDATED QUERY WITH NEW FIELDS ============
        const [attendance] = await pool.query(
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
                -- NEW BREAK & ADJUSTMENT FIELDS
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
                    image: profile.image,
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
router.post('/break/start', auth, validateBranch, async (req, res) => {
    try {
        const loggedInUser = req.headers["username"];
        const branch_id = req.branch_id;
        const { username } = req.body;

        if (!loggedInUser) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        // Determine target username (admin can specify, staff uses their own)
        let targetUsername = username || loggedInUser;
        
        // Check if user is admin
        const isAdmin = await checkIfAdmin(loggedInUser, branch_id);
        
        if (!isAdmin && username && username !== loggedInUser) {
            return res.status(403).json({
                success: false,
                message: "You can only start breaks for yourself"
            });
        }

        // Get TODAY's active attendance record for this user
        const today = new Date().toISOString().split('T')[0];
        const [attendance] = await pool.query(
            `SELECT id, map_id, username, attendance_id 
             FROM attendance 
             WHERE username = ? 
               AND branch_id = ? 
               AND DATE(punch_in_time) = ?
               AND punch_out_time IS NULL 
               AND is_deleted = '0'`,
            [targetUsername, branch_id, today]
        );

        if (!attendance.length) {
            return res.status(404).json({
                success: false,
                message: "No active attendance found for today. Please punch in first.",
                data: {
                    username: targetUsername,
                    today: today,
                    action_required: "Please punch in before taking a break"
                }
            });
        }

        const record = attendance[0];

        // Check if there's already an ongoing break
        const [ongoingBreak] = await pool.query(
            `SELECT * FROM attendance_break 
             WHERE attendance_id = ? AND break_status = 'ongoing' AND is_deleted = '0'`,
            [record.id]
        );

        if (ongoingBreak.length > 0) {
            return res.status(400).json({
                success: false,
                message: "You already have an ongoing break. Please end your current break first.",
                data: {
                    break_id: ongoingBreak[0].id,
                    break_start_time: ongoingBreak[0].break_start_time,
                    break_duration: Math.round((new Date() - new Date(ongoingBreak[0].break_start_time)) / (1000 * 60)) + " minutes ongoing"
                }
            });
        }

        // Get staff salary settings for allowed break minutes
        const [salaryConfig] = await pool.query(
            `SELECT allowed_break_minutes, break_excess_penalty_type, break_excess_penalty_value
             FROM staff_salary 
             WHERE username = ? AND branch_id = ? AND is_active = '1' AND is_deleted = '0'`,
            [targetUsername, branch_id]
        );

        const allowedBreakMinutes = salaryConfig[0]?.allowed_break_minutes || 30;

        // Create break record
        await pool.query(
            `INSERT INTO attendance_break (
                attendance_id, map_id, username, branch_id, 
                break_start_time, allowed_break_minutes, break_status, 
                create_date, is_deleted
            ) VALUES (?, ?, ?, ?, ?, ?, 'ongoing', NOW(), '0')`,
            [
                record.id,
                record.map_id,
                targetUsername,
                branch_id,
                new Date(),
                allowedBreakMinutes
            ]
        );

        // Get the inserted break id
        const [newBreak] = await pool.query(
            `SELECT id FROM attendance_break 
             WHERE attendance_id = ? AND break_status = 'ongoing' 
             ORDER BY id DESC LIMIT 1`,
            [record.id]
        );

        const profile = await getStaffProfile(targetUsername, branch_id);

        return res.status(200).json({
            success: true,
            message: "Break started successfully",
            data: {
                break_id: newBreak[0].id,
                attendance_id: record.attendance_id,
                username: targetUsername,
                profile: profile ? {
                    name: profile.name,
                    email: profile.email,
                    designation: profile.designation
                } : null,
                break_start_time: new Date(),
                allowed_break_minutes: allowedBreakMinutes,
                status: "ongoing",
                message: `Break started. You have ${allowedBreakMinutes} minutes of allowed break time.`
            }
        });

    } catch (error) {
        console.error('Start break error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to start break',
            error: error.message
        });
    }
});

/**
 * STAFF/ADMIN: End Break (Using Username Only - Ends the most recent ongoing break)
 * Headers: 
 *   - Authorization: Bearer {token}
 *   - username: {logged_in_user}
 * Body: { username (optional for admin) }
 * 
 * The system automatically finds and ends the most recent ongoing break
 */
router.post('/break/end', auth, validateBranch, async (req, res) => {
    try {
        const loggedInUser = req.headers["username"];
        const branch_id = req.branch_id;
        const { username } = req.body;

        if (!loggedInUser) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        // Determine target username
        let targetUsername = username || loggedInUser;
        
        // Check if user is admin
        const isAdmin = await checkIfAdmin(loggedInUser, branch_id);
        
        if (!isAdmin && username && username !== loggedInUser) {
            return res.status(403).json({
                success: false,
                message: "You can only end your own breaks"
            });
        }

        // Get TODAY's active attendance
        const today = new Date().toISOString().split('T')[0];
        const [attendance] = await pool.query(
            `SELECT id, attendance_id, username, map_id 
             FROM attendance 
             WHERE username = ? 
               AND branch_id = ? 
               AND DATE(punch_in_time) = ?
               AND punch_out_time IS NULL 
               AND is_deleted = '0'`,
            [targetUsername, branch_id, today]
        );

        if (!attendance.length) {
            return res.status(404).json({
                success: false,
                message: "No active attendance found for today. Please punch in first."
            });
        }

        const record = attendance[0];

        // Get the most recent ongoing break
        const [ongoingBreak] = await pool.query(
            `SELECT * FROM attendance_break 
             WHERE attendance_id = ? AND break_status = 'ongoing' AND is_deleted = '0'
             ORDER BY break_start_time DESC LIMIT 1`,
            [record.id]
        );

        if (!ongoingBreak.length) {
            return res.status(404).json({
                success: false,
                message: "No ongoing break found. Please start a break first."
            });
        }

        const breakRecord = ongoingBreak[0];
        const breakEndTime = new Date();
        const breakStartTime = new Date(breakRecord.break_start_time);
        
        // Calculate break duration in minutes
        const breakDurationMinutes = Math.round((breakEndTime - breakStartTime) / (1000 * 60));
        const allowedBreakMinutes = breakRecord.allowed_break_minutes || 30;
        const excessBreakMinutes = Math.max(0, breakDurationMinutes - allowedBreakMinutes);

        // Calculate break penalty
        let breakPenaltyAmount = 0;
        
        if (excessBreakMinutes > 0) {
            const [salaryConfig] = await pool.query(
                `SELECT monthly_salary, break_excess_penalty_type, break_excess_penalty_value
                 FROM staff_salary 
                 WHERE username = ? AND branch_id = ? AND is_active = '1' AND is_deleted = '0'`,
                [targetUsername, branch_id]
            );

            if (salaryConfig.length > 0) {
                const config = salaryConfig[0];
                const perDaySalary = config.monthly_salary / 30;
                const perMinuteSalary = perDaySalary / 480;
                
                if (config.break_excess_penalty_type === 'fixed') {
                    breakPenaltyAmount = parseFloat(config.break_excess_penalty_value || 0) * excessBreakMinutes;
                } else {
                    breakPenaltyAmount = (parseFloat(config.break_excess_penalty_value || 0) / 100) * perMinuteSalary * excessBreakMinutes;
                }
            }
        }

        // Update break record
        await pool.query(
            `UPDATE attendance_break 
             SET break_end_time = ?,
                 break_duration_minutes = ?,
                 excess_break_minutes = ?,
                 break_status = 'completed',
                 modify_date = NOW()
             WHERE id = ? AND is_deleted = '0'`,
            [breakEndTime, breakDurationMinutes, excessBreakMinutes, breakRecord.id]
        );

        // Get all breaks for this attendance to update totals
        const [allBreaks] = await pool.query(
            `SELECT 
                COALESCE(SUM(break_duration_minutes), 0) as total_break_minutes,
                COALESCE(SUM(excess_break_minutes), 0) as total_excess_minutes,
                COALESCE(SUM(break_penalty_amount), 0) as total_penalty
             FROM attendance_break 
             WHERE attendance_id = ? AND break_status = 'completed' AND is_deleted = '0'`,
            [record.id]
        );

        // Update attendance table with cumulative break totals
        await pool.query(
            `UPDATE attendance 
             SET total_break_minutes = ?,
                 excess_break_minutes = ?,
                 break_penalty_amount = ?
             WHERE id = ? AND is_deleted = '0'`,
            [
                allBreaks[0].total_break_minutes,
                allBreaks[0].total_excess_minutes,
                allBreaks[0].total_penalty,
                record.id
            ]
        );

        const profile = await getStaffProfile(targetUsername, branch_id);

        // Get total breaks summary for the day
        const [breakHistory] = await pool.query(
            `SELECT COUNT(*) as total_breaks, 
                    COALESCE(SUM(break_duration_minutes), 0) as total_break_time,
                    COALESCE(SUM(excess_break_minutes), 0) as total_excess_time
             FROM attendance_break 
             WHERE attendance_id = ? AND break_status = 'completed' AND is_deleted = '0'`,
            [record.id]
        );

        return res.status(200).json({
            success: true,
            message: "Break ended successfully",
            data: {
                break_id: breakRecord.id,
                attendance_id: record.attendance_id,
                username: targetUsername,
                profile: profile ? {
                    name: profile.name,
                    email: profile.email,
                    designation: profile.designation
                } : null,
                current_break: {
                    break_start_time: breakStartTime,
                    break_end_time: breakEndTime,
                    break_duration_minutes: breakDurationMinutes,
                    allowed_break_minutes: allowedBreakMinutes,
                    excess_break_minutes: excessBreakMinutes,
                    break_penalty_amount: breakPenaltyAmount
                },
                today_summary: {
                    total_breaks_taken: breakHistory[0].total_breaks,
                    total_break_time_minutes: breakHistory[0].total_break_time,
                    total_excess_time_minutes: breakHistory[0].total_excess_time,
                    total_penalty_accumulated: allBreaks[0].total_penalty
                },
                status: "completed"
            }
        });

    } catch (error) {
        console.error('End break error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to end break',
            error: error.message
        });
    }
});

/**
 * GET: Simple Break Status Check - Returns only ongoing break status
 * Query param: username (optional for admin)
 */
router.get('/break/status', auth, validateBranch, async (req, res) => {
    try {
        const loggedInUser = req.headers["username"];
        const branch_id = req.branch_id;
        const { username } = req.query;

        // Determine who to check
        let targetUsername = username || loggedInUser;
        
        // Check if admin (can check others)
        const isAdmin = await checkIfAdmin(loggedInUser, branch_id);
        if (!isAdmin && username && username !== loggedInUser) {
            return res.status(403).json({
                success: false,
                message: "Access denied"
            });
        }

        // Get today's attendance
        const today = new Date().toISOString().split('T')[0];
        const [attendance] = await pool.query(
            `SELECT id FROM attendance 
             WHERE username = ? AND branch_id = ? 
             AND DATE(punch_in_time) = ? 
             AND punch_out_time IS NULL 
             AND is_deleted = '0'`,
            [targetUsername, branch_id, today]
        );

        if (!attendance.length) {
            return res.json({
                success: true,
                onBreak: false,
                message: "No active attendance"
            });
        }

        // Check for ongoing break
        const [ongoingBreak] = await pool.query(
            `SELECT id, break_start_time FROM attendance_break 
             WHERE attendance_id = ? AND break_status = 'ongoing' 
             AND is_deleted = '0'`,
            [attendance[0].id]
        );

        if (ongoingBreak.length > 0) {
            return res.json({
                success: true,
                onBreak: true,
                breakStartTime: ongoingBreak[0].break_start_time,
                message: "Staff is on break"
            });
        } else {
            return res.json({
                success: true,
                onBreak: false,
                message: "Staff is not on break"
            });
        }

    } catch (error) {
        console.error('Error:', error);
        return res.status(500).json({
            success: false,
            message: "Server error"
        });
    }
});
/**
 * GET: Get Breaks for an Attendance Record
 */
router.get('/breaks', auth, validateBranch, async (req, res) => {
    try {
        const loggedInUser = req.headers["username"];
        const branch_id = req.branch_id;
        const { attendance_id } = req.query;

        if (!loggedInUser) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        if (!attendance_id) {
            return res.status(400).json({
                success: false,
                message: "attendance_id is required"
            });
        }

        // Get attendance to check username and get numeric id
        const [attendance] = await pool.query(
            `SELECT id, username FROM attendance 
             WHERE attendance_id = ? AND branch_id = ? AND is_deleted = '0'`,
            [attendance_id, branch_id]
        );

        if (!attendance.length) {
            return res.status(404).json({
                success: false,
                message: "Attendance record not found"
            });
        }

        const targetUsername = attendance[0].username;
        const isAdmin = await checkIfAdmin(loggedInUser, branch_id);
        
        if (!isAdmin && targetUsername !== loggedInUser) {
            return res.status(403).json({
                success: false,
                message: "You can only view your own breaks"
            });
        }

        const [breaks] = await pool.query(
            `SELECT 
                id,
                break_start_time,
                break_end_time,
                break_duration_minutes,
                allowed_break_minutes,
                excess_break_minutes,
                break_status,
                create_date
             FROM attendance_break 
             WHERE attendance_id = ? AND is_deleted = '0'
             ORDER BY break_start_time ASC`,
            [attendance[0].id]
        );

        // Get total penalty from attendance table (since it's stored there)
        const [attendanceData] = await pool.query(
            `SELECT break_penalty_amount FROM attendance WHERE id = ?`,
            [attendance[0].id]
        );
        
        const totalPenalty = attendanceData[0]?.break_penalty_amount || 0;

        // Get break summary
        const summary = {
            total_breaks: breaks.length,
            total_break_minutes: breaks.reduce((sum, b) => sum + (b.break_duration_minutes || 0), 0),
            total_excess_minutes: breaks.reduce((sum, b) => sum + (b.excess_break_minutes || 0), 0),
            total_penalty: parseFloat(totalPenalty),
            ongoing_breaks: breaks.filter(b => b.break_status === 'ongoing').length,
            completed_breaks: breaks.filter(b => b.break_status === 'completed').length
        };

        return res.status(200).json({
            success: true,
            message: "Breaks retrieved successfully",
            data: {
                attendance_id: attendance_id,
                username: targetUsername,
                summary,
                breaks: breaks.map(b => ({
                    id: b.id,
                    break_start_time: b.break_start_time,
                    break_end_time: b.break_end_time,
                    break_duration_minutes: b.break_duration_minutes,
                    allowed_break_minutes: b.allowed_break_minutes,
                    excess_break_minutes: b.excess_break_minutes,
                    break_status: b.break_status,
                    created_at: b.create_date
                }))
            }
        });

    } catch (error) {
        console.error('Get breaks error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to fetch breaks',
            error: error.message
        });
    }
});

// ==================== SALARY ADJUSTMENTS APIs (Travel Allowance & Deductions) ====================

/**
 * ADMIN: Add Salary Adjustment (Allowance or Deduction)
 * Headers: 
 *   - Authorization: Bearer {token}
 *   - username: {admin_username}
 * Body: {
 *   username: "staff1",
 *   adjustment_type: "allowance" or "deduction",
 *   adjustment_name: "Travel Allowance",
 *   calculation_type: "fixed" or "percentage",
 *   amount: 500,
 *   applied_on: "per_day" or "monthly_salary",
 *   reference_id: "ATT123" (optional),
 *   reference_type: "attendance" (optional),
 *   effective_from: "2024-01-01",
 *   effective_to: "2024-12-31" (optional),
 *   is_recurring: true/false,
 *   remarks: "Monthly travel allowance"
 * }
 */
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
router.post('/admin/verify-v2', auth, validateBranch, async (req, res) => {
    try {
        const admin_username = req.headers["username"];
        const branch_id = req.branch_id;
        const { 
            attendance_id,
            username,
            attendance_date,
            verify_status, 
            admin_remarks,
            manual_punch_in,
            manual_punch_out,
            apply_travel_allowance = true,
            apply_other_deductions = true,
            consider_break = true,
            create_if_missing = false
        } = req.body;

        // Helper function to safely convert to number (prevents NaN)
        const safeNumber = (value, defaultValue = 0) => {
            const num = parseFloat(value);
            return isNaN(num) ? defaultValue : num;
        };

        // Helper function to safely format date for SQL
        const safeDate = (dateValue) => {
            if (!dateValue) return null;
            try {
                const d = new Date(dateValue);
                if (isNaN(d.getTime())) return null;
                return d.toISOString().slice(0, 19).replace('T', ' ');
            } catch (e) {
                return null;
            }
        };

        // Helper function to safely calculate minutes between dates
        const safeMinutesDiff = (start, end) => {
            if (!start || !end) return 0;
            try {
                const startDate = new Date(start);
                const endDate = new Date(end);
                if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) return 0;
                return Math.round((endDate - startDate) / (1000 * 60));
            } catch (e) {
                return 0;
            }
        };

        if (!admin_username) {
            return res.status(400).json({
                success: false,
                message: "Missing required header: username"
            });
        }

        let record;
        let isNewlyCreated = false;

        // ============ CASE 1: Attendance ID Provided (Existing Record) ============
        if (attendance_id) {
            const [attendance] = await pool.query(
                `SELECT a.*, 
                        s.monthly_salary, 
                        s.overtime_rate_type, 
                        s.fine_rate_type, 
                        s.expected_hours, 
                        s.grace_period_minutes,
                        s.overtime_enabled,
                        s.fine_enabled,
                        s.allowed_break_minutes,
                        s.break_excess_penalty_type,
                        s.break_excess_penalty_value,
                        s.travel_allowance_type,
                        s.travel_allowance_value,
                        s.other_deduction_type,
                        s.other_deduction_value
                 FROM attendance a
                 LEFT JOIN staff_salary s ON a.username = s.username 
                     AND a.branch_id = s.branch_id 
                     AND s.is_active = '1' 
                     AND s.is_deleted = '0'
                 WHERE a.attendance_id = ? AND a.branch_id = ? AND a.is_deleted = '0'`,
                [attendance_id, branch_id]
            );

            if (!attendance.length) {
                return res.status(404).json({
                    success: false,
                    message: 'Attendance record not found'
                });
            }
            record = attendance[0];
        }
        // ============ CASE 2: No Attendance ID - Create New Record ============
        else if (create_if_missing && username && attendance_date) {
            // Check if staff exists
            const [staffCheck] = await pool.query(
                `SELECT bm.map_id, bm.username, p.name as staff_name, p.email, p.mobile, p.image, bm.designation
                 FROM branch_mapping bm
                 INNER JOIN profile p ON bm.username = p.username
                 WHERE bm.username = ? AND bm.branch_id = ? 
                 AND bm.type = 'staff' AND bm.is_accepted = '1' AND bm.is_deleted = '0'`,
                [username, branch_id]
            );

            if (!staffCheck.length) {
                return res.status(404).json({
                    success: false,
                    message: 'Staff member not found in this branch'
                });
            }

            // Check if attendance already exists for this date
            const [existingAttendance] = await pool.query(
                `SELECT * FROM attendance 
                 WHERE username = ? AND branch_id = ? 
                 AND DATE(punch_in_time) = ?
                 AND is_deleted = '0'`,
                [username, branch_id, attendance_date]
            );

            if (existingAttendance.length > 0) {
                record = existingAttendance[0];
                isNewlyCreated = false;
            } else {
                // Create new attendance record
                const newAttendanceId = `ATT${Date.now()}${Math.random().toString(36).substring(2, 10)}`;
                
                const defaultPunchIn = manual_punch_in || '09:00:00';
                const defaultPunchOut = manual_punch_out || '18:00:00';
                
                const baseDate = new Date(attendance_date);
                baseDate.setHours(0, 0, 0, 0);
                
                const [inHours, inMinutes, inSeconds] = defaultPunchIn.split(':').map(Number);
                const [outHours, outMinutes, outSeconds] = defaultPunchOut.split(':').map(Number);
                
                const punchInTime = new Date(baseDate);
                punchInTime.setHours(inHours || 0, inMinutes || 0, inSeconds || 0);
                
                const punchOutTime = new Date(baseDate);
                punchOutTime.setHours(outHours || 0, outMinutes || 0, outSeconds || 0);
                
                const [salaryConfig] = await pool.query(
                    `SELECT s.* 
                     FROM staff_salary s
                     WHERE s.username = ? AND s.branch_id = ? 
                     AND s.is_active = '1' AND s.is_deleted = '0'
                     AND s.effective_from <= ?
                     ORDER BY s.effective_from DESC LIMIT 1`,
                    [username, branch_id, attendance_date]
                );
                
                const expectedHours = safeNumber(salaryConfig[0]?.expected_hours, 8);
                const expectedMinutes = expectedHours * 60;
                
                await pool.query(
                    `INSERT INTO attendance (
                        attendance_id, map_id, username, branch_id,
                        punch_in_time, punch_out_time, expected_minutes,
                        attendance_status, is_verified, is_manual, manual_reason,
                        create_by, modify_by, is_deleted
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '0')`,
                    [
                        newAttendanceId, staffCheck[0].map_id, username, branch_id,
                        punchInTime, punchOutTime, expectedMinutes,
                        verify_status || 'pending', '0', '1', 'Auto-created by verify API',
                        admin_username, admin_username
                    ]
                );
                
                const [newRecord] = await pool.query(
                    `SELECT a.*, 
                            s.monthly_salary, 
                            s.overtime_rate_type, 
                            s.fine_rate_type, 
                            s.expected_hours, 
                            s.grace_period_minutes,
                            s.overtime_enabled,
                            s.fine_enabled,
                            s.allowed_break_minutes,
                            s.break_excess_penalty_type,
                            s.break_excess_penalty_value,
                            s.travel_allowance_type,
                            s.travel_allowance_value,
                            s.other_deduction_type,
                            s.other_deduction_value
                     FROM attendance a
                     LEFT JOIN staff_salary s ON a.username = s.username 
                         AND a.branch_id = s.branch_id 
                         AND s.is_active = '1' 
                         AND s.is_deleted = '0'
                     WHERE a.attendance_id = ? AND a.branch_id = ? AND a.is_deleted = '0'`,
                    [newAttendanceId, branch_id]
                );
                
                record = newRecord[0];
                isNewlyCreated = true;
            }
        }
        else {
            return res.status(400).json({
                success: false,
                message: 'Either provide attendance_id OR (username + attendance_date + create_if_missing=true)'
            });
        }

        // ============ SAFELY EXTRACT VALUES (Prevent NaN) ============
        const monthlySalary = safeNumber(record.monthly_salary, 0);
        const perDaySalary = monthlySalary / 30;
        const expectedHours = safeNumber(record.expected_hours, 8);
        const perMinuteSalary = perDaySalary / (expectedHours * 60);
        const gracePeriodMinutes = safeNumber(record.grace_period_minutes, 10);
        const allowedBreakMinutes = safeNumber(record.allowed_break_minutes, 30);
        
        const isOvertimeEnabled = record.overtime_enabled === '1';
        const isFineEnabled = record.fine_enabled === '1';
        
        // Get breaks
        const [breaks] = await pool.query(
            `SELECT * FROM attendance_break 
             WHERE attendance_id = ? AND break_status = 'completed' AND is_deleted = '0'`,
            [record.id]
        );

        // Calculate break totals with safe numbers
        let totalBreakMinutes = 0;
        let totalExcessBreakMinutes = 0;
        
        for (const breakRecord of breaks) {
            totalBreakMinutes += safeNumber(breakRecord.break_duration_minutes, 0);
            totalExcessBreakMinutes += safeNumber(breakRecord.excess_break_minutes, 0);
        }
        
        if (totalExcessBreakMinutes === 0) {
            totalExcessBreakMinutes = safeNumber(record.excess_break_minutes, 0);
        }

        // Process punch times safely
        let punchIn = manual_punch_in || record.punch_in_time;
        let punchOut = manual_punch_out || record.punch_out_time;
        
        let rawTotalMinutes = safeMinutesDiff(punchIn, punchOut);
        
        // Apply break consideration
        let totalMinutes;
        if (consider_break) {
            totalMinutes = Math.max(0, rawTotalMinutes - totalBreakMinutes);
        } else {
            totalMinutes = rawTotalMinutes;
        }
        
        // Calculate status
        const expectedMinutes = expectedHours * 60;
        const diffMinutes = totalMinutes - expectedMinutes;
        
        let status = 'pending';
        let extraMinutes = 0;
        let lessMinutes = 0;
        let gracePeriodApplied = 0;
        
        if (Math.abs(diffMinutes) <= gracePeriodMinutes) {
            status = 'present';
            gracePeriodApplied = Math.abs(diffMinutes);
        } else if (diffMinutes > gracePeriodMinutes) {
            status = 'bonus';
            extraMinutes = diffMinutes - gracePeriodMinutes;
            gracePeriodApplied = gracePeriodMinutes;
        } else {
            const lessTimeAfterGrace = Math.abs(diffMinutes) - gracePeriodMinutes;
            if (lessTimeAfterGrace <= 240) {
                status = 'half_day';
                lessMinutes = lessTimeAfterGrace;
            } else {
                status = 'fine';
                lessMinutes = lessTimeAfterGrace;
            }
            gracePeriodApplied = gracePeriodMinutes;
        }

        const finalStatus = verify_status || status;

        // Calculate overtime and fine with safe numbers
        let overtimeAmount = 0;
        let fineAmount = 0;
        
        if (isOvertimeEnabled && extraMinutes > 0) {
            overtimeAmount = extraMinutes * perMinuteSalary;
        }
        
        if (isFineEnabled && lessMinutes > 0 && finalStatus === 'fine') {
            fineAmount = lessMinutes * perMinuteSalary;
        }

        // Calculate break penalty
        let breakPenaltyAmount = 0;
        if (consider_break && totalExcessBreakMinutes > 0) {
            const penaltyType = record.break_excess_penalty_type || 'fixed';
            const penaltyValue = safeNumber(record.break_excess_penalty_value, 0);
            
            if (penaltyType === 'fixed') {
                breakPenaltyAmount = penaltyValue * totalExcessBreakMinutes;
            } else if (penaltyType === 'percentage') {
                breakPenaltyAmount = (penaltyValue / 100) * perMinuteSalary * totalExcessBreakMinutes;
            }
        }

        // Base salary calculation
        let baseCalculatedAmount = 0;
        
        switch(finalStatus) {
            case 'present':
                baseCalculatedAmount = perDaySalary;
                break;
            case 'paid_leave':
                baseCalculatedAmount = perDaySalary;
                break;
            case 'half_day':
                baseCalculatedAmount = perDaySalary * 0.5;
                break;
            case 'absent':
                baseCalculatedAmount = 0;
                break;
            case 'fine':
                baseCalculatedAmount = Math.max(0, perDaySalary - fineAmount);
                break;
            case 'bonus':
                baseCalculatedAmount = perDaySalary + overtimeAmount;
                break;
            default:
                baseCalculatedAmount = 0;
        }

        // Travel allowance
        let travelAllowanceAmount = 0;
        if (apply_travel_allowance && record.travel_allowance_type) {
            const travelValue = safeNumber(record.travel_allowance_value, 0);
            if (record.travel_allowance_type === 'fixed') {
                travelAllowanceAmount = travelValue;
            } else if (record.travel_allowance_type === 'percentage') {
                travelAllowanceAmount = (travelValue / 100) * baseCalculatedAmount;
            }
        }

        // Other deductions
        let otherDeductionAmount = 0;
        if (apply_other_deductions && record.other_deduction_type) {
            const deductionValue = safeNumber(record.other_deduction_value, 0);
            if (record.other_deduction_type === 'fixed') {
                otherDeductionAmount = deductionValue;
            } else if (record.other_deduction_type === 'percentage') {
                otherDeductionAmount = (deductionValue / 100) * baseCalculatedAmount;
            }
        }

        // Final calculations (ensure no NaN)
        const netAdjustmentAmount = safeNumber(travelAllowanceAmount - breakPenaltyAmount - otherDeductionAmount, 0);
        const finalCalculatedAmount = safeNumber(baseCalculatedAmount + netAdjustmentAmount, 0);

        // Ensure ALL values are valid numbers before SQL update
        const updateValues = [
            finalStatus || 'pending',
            admin_username,
            admin_remarks || record.admin_remarks || null,
            safeNumber(perDaySalary, 0),
            safeNumber(baseCalculatedAmount, 0),
            safeNumber(totalMinutes, 0),
            safeNumber(extraMinutes, 0),
            safeNumber(lessMinutes, 0),
            safeNumber(gracePeriodApplied, 0),
            safeNumber(overtimeAmount, 0),
            safeNumber(fineAmount, 0),
            safeNumber(totalBreakMinutes, 0),
            safeNumber(totalExcessBreakMinutes, 0),
            safeNumber(breakPenaltyAmount, 0),
            safeNumber(travelAllowanceAmount, 0),
            safeNumber(otherDeductionAmount, 0),
            safeNumber(netAdjustmentAmount, 0),
            safeNumber(finalCalculatedAmount, 0),
            admin_username,
            record.id
        ];

        // Verify no NaN values exist
        for (let i = 0; i < updateValues.length; i++) {
            if (updateValues[i] !== null && typeof updateValues[i] === 'number' && isNaN(updateValues[i])) {
                console.error(`NaN detected at index ${i}:`, updateValues[i]);
                updateValues[i] = 0;
            }
        }

        // Update attendance record
        await pool.query(
            `UPDATE attendance 
             SET attendance_status = ?,
                 is_verified = '1',
                 verified_by = ?,
                 verified_date = NOW(),
                 admin_remarks = ?,
                 per_day_salary = ?,
                 calculated_amount = ?,
                 total_minutes = ?,
                 extra_minutes = ?,
                 less_minutes = ?,
                 grace_period_applied = ?,
                 overtime_calculated_amount = ?,
                 fine_calculated_amount = ?,
                 total_break_minutes = ?,
                 excess_break_minutes = ?,
                 break_penalty_amount = ?,
                 travel_allowance_amount = ?,
                 other_deduction_amount = ?,
                 net_adjustment_amount = ?,
                 final_calculated_amount = ?,
                 modify_by = ?,
                 modify_date = NOW()
             WHERE id = ? AND is_deleted = '0'`,
            updateValues
        );

        const profile = await getStaffProfile(record.username, branch_id);

        return res.status(200).json({
            success: true,
            message: isNewlyCreated ? 'Attendance record created and verified successfully' : 'Attendance verified successfully',
            data: {
                attendance_id: record.attendance_id,
                username: record.username,
                attendance_date: attendance_date || (record.punch_in_time ? new Date(record.punch_in_time).toISOString().split('T')[0] : null),
                is_new_record: isNewlyCreated,
                profile: profile ? {
                    name: profile.name,
                    email: profile.email,
                    mobile: profile.mobile,
                    designation: profile.designation,
                    image: profile.image
                } : null,
                status: finalStatus,
                calculated_amount: finalCalculatedAmount,
                verified_by: admin_username,
                verified_at: new Date().toISOString()
            }
        });

    } catch (error) {
        console.error('Verify attendance error:', error);
        return res.status(500).json({
            success: false,
            message: 'Failed to verify attendance',
            error: error.message
        });
    }
});


    // ==================== Payslip Generation ==================== --- IGNORE ---
// ==================== HELPER FUNCTIONS ====================

async function checkIfAdmin(username, branch_id) {
    try {
        const [result] = await pool.query(
            `SELECT type FROM branch_mapping 
             WHERE username = ? AND branch_id = ? AND type = 'admin' 
             AND is_deleted = '0'`,
            [username, branch_id]
        );
        return result.length > 0;
    } catch (error) {
        console.error('Error checking admin status:', error);
        return false;
    }
}

async function getCompanyDetails(branch_id) {
    const [company] = await pool.query(
        `SELECT 
            id,
            branch_id,
            name as company_name,
            logo,
            sign,
            address_line_1,
            address_line_2,
            city,
            state,
            country,
            pincode,
            invoice_address,
            pan,
            is_pan_verified,
            gst,
            gst_rate,
            is_gst_verified,
            mobile_1,
            mobile_2,
            email_1,
            email_2,
            status
         FROM branch_list 
         WHERE branch_id = ? AND is_deleted = '0'`,
        [branch_id]
    );
    return company[0] || null;
}

function formatCompanyAddress(company) {
    if (!company) return '';
    const parts = [];
    if (company.address_line_1) parts.push(company.address_line_1);
    if (company.address_line_2) parts.push(company.address_line_2);
    if (company.city) parts.push(company.city);
    if (company.state) parts.push(company.state);
    if (company.pincode) parts.push(company.pincode);
    if (company.country) parts.push(company.country);
    return parts.join(', ');
}



// Helper function to get payslip data
async function getPayslipData(username, branch_id, month, year) {
    const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];
    const daysInMonth = new Date(year, month, 0).getDate();

    const profile = await getStaffProfile(username, branch_id);
    if (!profile) {
        throw new Error('Staff not found in this branch');
    }

    // Get weekly off
    const [weeklyOffData] = await pool.query(
        `SELECT weekly_off_day 
         FROM employee_weekly_off 
         WHERE username = ? AND branch_id = ? AND is_active = '1' AND is_deleted = '0'`,
        [username, branch_id]
    );
    const weeklyOffDay = weeklyOffData.length > 0 ? weeklyOffData[0].weekly_off_day : null;

    // Get salary
    const [salaryData] = await pool.query(
        `SELECT monthly_salary FROM staff_salary 
         WHERE username = ? AND branch_id = ? AND is_active = '1' AND is_deleted = '0'`,
        [username, branch_id]
    );
    const monthlySalary = salaryData.length > 0 ? parseFloat(salaryData[0].monthly_salary) : 0;
    const perDaySalary = monthlySalary / 30;

    // Get attendance
    const [attendance] = await pool.query(
        `SELECT 
            DAY(punch_in_time) as day,
            attendance_status,
            calculated_amount,
            extra_minutes,
            less_minutes
         FROM attendance 
         WHERE username = ? AND branch_id = ? 
         AND DATE(punch_in_time) BETWEEN ? AND ?
         AND is_deleted = '0'`,
        [username, branch_id, startDate, endDate]
    );

    const attendanceMap = {};
    attendance.forEach(record => {
        attendanceMap[record.day] = record;
    });

    // Calculate totals
    let present = 0, halfDay = 0, paidLeave = 0, bonus = 0, absent = 0;
    let totalOvertimeAmount = 0, totalCalculatedAmount = 0;

    for (let day = 1; day <= daysInMonth; day++) {
        const dateObj = new Date(year, month - 1, day);
        const dayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
        const isWeeklyOff = weeklyOffDay === dayOfWeek;
        
        const record = attendanceMap[day];
        
        if (isWeeklyOff) {
            // Weekly off - no pay
            continue;
        } else if (record) {
            totalCalculatedAmount += record.calculated_amount || 0;
            
            switch(record.attendance_status) {
                case 'present':
                    present++;
                    break;
                case 'half_day':
                    halfDay++;
                    break;
                case 'paid_leave':
                    paidLeave++;
                    break;
                case 'bonus':
                    bonus++;
                    if (record.extra_minutes) {
                        const overtimePay = (record.extra_minutes / 60) * (perDaySalary / 8);
                        totalOvertimeAmount += overtimePay;
                    }
                    break;
                case 'fine':
                    present++;
                    break;
                default:
                    present++;
            }
        } else {
            absent++;
        }
    }

    // Calculate earnings
    const presentAmount = present * perDaySalary;
    const halfDayAmount = halfDay * (perDaySalary / 2);
    const paidLeaveAmount = paidLeave * perDaySalary;
    const totalEarnings = presentAmount + halfDayAmount + paidLeaveAmount + totalOvertimeAmount;
    const netSalary = totalEarnings;

    return {
        staff: profile,
        monthly_salary: monthlySalary,
        per_day_salary: perDaySalary,
        period: {
            month: month,
            month_name: new Date(year, month - 1).toLocaleString('default', { month: 'short' }),
            year: year,
            month_year: `${new Date(year, month - 1).toLocaleString('default', { month: 'short' })}-${year}`
        },
        attendance_summary: {
            present: present,
            absent: absent,
            half_day: halfDay,
            paid_leave: paidLeave,
            overtime_days: bonus,
            bonus: bonus
        },
        earnings: {
            present_amount: presentAmount.toFixed(2),
            half_day_amount: halfDayAmount.toFixed(2),
            paid_leave_amount: paidLeaveAmount.toFixed(2),
            overtime_amount: totalOvertimeAmount.toFixed(2),
            total_earnings: totalEarnings.toFixed(2)
        },
        deductions: {
            late_fine: '0.00',
            other_deduction: '0.00',
            total_deduction: '0.00'
        },
        net_salary: netSalary.toFixed(2)
    };
}

function numberToWords(num) {
    if (num === 0) return 'Zero Rupees Only';
    
    const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
                  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 
                  'Seventeen', 'Eighteen', 'Nineteen'];
    const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    
    function convert(n) {
        if (n < 20) return ones[n];
        return tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : '');
    }
    
    let rupeesAmount = Math.floor(num);
    const paise = Math.round((num - rupeesAmount) * 100);
    
    let words = '';
    
    if (rupeesAmount >= 10000000) {
        words += convert(Math.floor(rupeesAmount / 10000000)) + ' Crore ';
        rupeesAmount %= 10000000;
    }
    if (rupeesAmount >= 100000) {
        words += convert(Math.floor(rupeesAmount / 100000)) + ' Lakh ';
        rupeesAmount %= 100000;
    }
    if (rupeesAmount >= 1000) {
        words += convert(Math.floor(rupeesAmount / 1000)) + ' Thousand ';
        rupeesAmount %= 1000;
    }
    if (rupeesAmount >= 100) {
        words += convert(Math.floor(rupeesAmount / 100)) + ' Hundred ';
        rupeesAmount %= 100;
    }
    if (rupeesAmount > 0) {
        words += convert(rupeesAmount);
    }
    
    words = words.trim() + ' Rupees';
    
    if (paise > 0) {
        words += ' and ' + convert(paise) + ' Paise';
    }
    
    return words + ' Only';
}


// ==================== PAYSLIP HELPER FUNCTIONS (Add these BEFORE the route handlers) ====================

async function getPayslipDataWithBreaksAndAdjustments(username, branch_id, month, year) {
    const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];
    const daysInMonth = new Date(year, month, 0).getDate();

    const profile = await getStaffProfile(username, branch_id);
    if (!profile) {
        throw new Error('Staff not found in this branch');
    }

    // Get weekly off
    const [weeklyOffData] = await pool.query(
        `SELECT weekly_off_day 
         FROM employee_weekly_off 
         WHERE username = ? AND branch_id = ? AND is_active = '1' AND is_deleted = '0'`,
        [username, branch_id]
    );
    const weeklyOffDay = weeklyOffData.length > 0 ? weeklyOffData[0].weekly_off_day : null;

    // Get salary with break and adjustment settings
    const [salaryData] = await pool.query(
        `SELECT 
            monthly_salary,
            expected_hours,
            overtime_enabled,
            fine_enabled,
            allowed_break_minutes,
            break_excess_penalty_type,
            break_excess_penalty_value,
            travel_allowance_type,
            travel_allowance_value,
            other_deduction_type,
            other_deduction_value
         FROM staff_salary 
         WHERE username = ? AND branch_id = ? AND is_active = '1' AND is_deleted = '0'`,
        [username, branch_id]
    );
    
    const monthlySalary = salaryData.length > 0 ? parseFloat(salaryData[0].monthly_salary) : 0;
    const perDaySalary = monthlySalary / 30;
    const expectedHours = salaryData.length > 0 ? parseFloat(salaryData[0].expected_hours) || 8 : 8;
    const perMinuteSalary = perDaySalary / (expectedHours * 60);
    
    // Get settings
    const overtimeEnabled = salaryData.length > 0 && (salaryData[0].overtime_enabled === '1' || salaryData[0].overtime_enabled === 1);
    const fineEnabled = salaryData.length > 0 && (salaryData[0].fine_enabled === '1' || salaryData[0].fine_enabled === 1);

    // Get attendance with breaks and adjustments
    const [attendance] = await pool.query(
        `SELECT 
            DAY(punch_in_time) as day,
            attendance_status,
            calculated_amount,
            extra_minutes,
            less_minutes,
            total_break_minutes,
            excess_break_minutes,
            break_penalty_amount,
            travel_allowance_amount,
            other_deduction_amount,
            net_adjustment_amount,
            final_calculated_amount,
            is_verified
         FROM attendance 
         WHERE username = ? AND branch_id = ? 
         AND DATE(punch_in_time) BETWEEN ? AND ?
         AND is_deleted = '0'`,
        [username, branch_id, startDate, endDate]
    );

    const attendanceMap = {};
    attendance.forEach(record => {
        attendanceMap[record.day] = record;
    });

    // Initialize counters
    let present = 0, halfDay = 0, paidLeave = 0, bonus = 0, fine = 0, absent = 0, pending = 0;
    let totalOvertimeAmount = 0, totalFineAmount = 0;
    let totalBreakMinutes = 0, totalExcessBreakMinutes = 0, totalBreakPenalty = 0;
    let totalTravelAllowance = 0, totalOtherDeductions = 0, totalNetAdjustment = 0, totalFinalAmount = 0;

    for (let day = 1; day <= daysInMonth; day++) {
        const dateObj = new Date(year, month - 1, day);
        const dayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
        const isWeeklyOff = weeklyOffDay === dayOfWeek;
        
        const record = attendanceMap[day];
        
        if (isWeeklyOff) {
            continue;
        } else if (record) {
            // Add break and adjustment totals
            totalBreakMinutes += record.total_break_minutes || 0;
            totalExcessBreakMinutes += record.excess_break_minutes || 0;
            totalBreakPenalty += parseFloat(record.break_penalty_amount || 0);
            totalTravelAllowance += parseFloat(record.travel_allowance_amount || 0);
            totalOtherDeductions += parseFloat(record.other_deduction_amount || 0);
            totalNetAdjustment += parseFloat(record.net_adjustment_amount || 0);
            totalFinalAmount += parseFloat(record.final_calculated_amount || 0);
            
            // Calculate overtime and fine amounts
            const extraMins = record.extra_minutes || 0;
            const lessMins = record.less_minutes || 0;
            
            if (overtimeEnabled && extraMins > 0) {
                totalOvertimeAmount += extraMins * perMinuteSalary;
            }
            if (fineEnabled && lessMins > 0) {
                totalFineAmount += lessMins * perMinuteSalary;
            }
            
            switch(record.attendance_status) {
                case 'present':
                    present++;
                    break;
                case 'half_day':
                    halfDay++;
                    break;
                case 'paid_leave':
                    paidLeave++;
                    break;
                case 'bonus':
                    bonus++;
                    break;
                case 'fine':
                    fine++;
                    break;
                case 'pending':
                    pending++;
                    break;
                default:
                    present++;
            }
        } else {
            absent++;
        }
    }

    // Calculate earnings
    const presentAmount = present * perDaySalary;
    const halfDayAmount = halfDay * (perDaySalary / 2);
    const paidLeaveAmount = paidLeave * perDaySalary;
    const totalEarnings = presentAmount + halfDayAmount + paidLeaveAmount + totalOvertimeAmount;
    
    // Calculate deductions
    const totalDeductions = totalFineAmount + totalBreakPenalty + totalOtherDeductions;
    
    // Net salary calculation
    const netSalary = totalEarnings + totalTravelAllowance - totalDeductions;

    return {
        staff: profile,
        monthly_salary: monthlySalary,
        per_day_salary: perDaySalary,
        period: {
            month: month,
            month_name: new Date(year, month - 1).toLocaleString('default', { month: 'short' }),
            year: year,
            month_year: `${new Date(year, month - 1).toLocaleString('default', { month: 'short' })}-${year}`
        },
        attendance_summary: {
            present: present,
            absent: absent,
            half_day: halfDay,
            paid_leave: paidLeave,
            overtime_days: bonus,
            fine_days: fine,
            pending_days: pending,
            total_working_days: present + halfDay + paidLeave + bonus + fine,
            total_days_in_month: daysInMonth
        },
        earnings: {
            present_amount: presentAmount.toFixed(2),
            half_day_amount: halfDayAmount.toFixed(2),
            paid_leave_amount: paidLeaveAmount.toFixed(2),
            overtime_amount: totalOvertimeAmount.toFixed(2),
            total_earnings: totalEarnings.toFixed(2)
        },
        deductions: {
            fine_amount: totalFineAmount.toFixed(2),
            break_penalty: totalBreakPenalty.toFixed(2),
            other_deduction: totalOtherDeductions.toFixed(2),
            total_deduction: totalDeductions.toFixed(2)
        },
        break_adjustments: {
            total_break_minutes: totalBreakMinutes,
            total_excess_break_minutes: totalExcessBreakMinutes,
            total_break_penalty: totalBreakPenalty.toFixed(2),
            total_travel_allowance: totalTravelAllowance.toFixed(2),
            total_other_deductions: totalOtherDeductions.toFixed(2),
            total_net_adjustment: totalNetAdjustment.toFixed(2),
            total_final_amount: totalFinalAmount.toFixed(2)
        },
        net_salary: netSalary.toFixed(2)
    };
}

async function getDailyBreakdownData(username, branch_id, month, year) {
    const startDate = `${year}-${month.toString().padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().split('T')[0];
    
    const [dailyBreakdown] = await pool.query(
        `SELECT 
            DATE(a.punch_in_time) as date,
            DAY(a.punch_in_time) as day,
            DATE_FORMAT(a.punch_in_time, '%W') as day_name,
            TIME(a.punch_in_time) as punch_in,
            TIME(a.punch_out_time) as punch_out,
            a.attendance_status,
            a.total_minutes,
            a.extra_minutes,
            a.less_minutes,
            a.calculated_amount,
            a.total_break_minutes,
            a.excess_break_minutes,
            a.break_penalty_amount,
            a.travel_allowance_amount,
            a.other_deduction_amount,
            a.net_adjustment_amount,
            a.final_calculated_amount,
            a.is_verified
         FROM attendance a
         WHERE a.username = ? AND a.branch_id = ? 
         AND DATE(a.punch_in_time) BETWEEN ? AND ?
         AND a.is_deleted = '0'
         ORDER BY a.punch_in_time ASC`,
        [username, branch_id, startDate, endDate]
    );

    const daysInMonth = new Date(year, month, 0).getDate();
    const dailyMap = {};
    dailyBreakdown.forEach(record => {
        dailyMap[record.day] = record;
    });
    
    const [weeklyOffData] = await pool.query(
        `SELECT weekly_off_day 
         FROM employee_weekly_off 
         WHERE username = ? AND branch_id = ? AND is_active = '1' AND is_deleted = '0'`,
        [username, branch_id]
    );
    const weeklyOffDay = weeklyOffData.length > 0 ? weeklyOffData[0].weekly_off_day : null;
    
    const fullMonthBreakdown = [];
    
    for (let day = 1; day <= daysInMonth; day++) {
        const dateObj = new Date(year, month - 1, day);
        const dayOfWeek = dateObj.toLocaleDateString('en-US', { weekday: 'long' });
        const isWeeklyOff = weeklyOffDay === dayOfWeek;
        const record = dailyMap[day];
        
        if (record) {
            fullMonthBreakdown.push({
                date: record.date,
                day_of_week: record.day_name,
                punch_in: record.punch_in ? record.punch_in.substring(0, 5) : '-',
                punch_out: record.punch_out ? record.punch_out.substring(0, 5) : '-',
                status: record.attendance_status,
                total_hours: record.total_minutes ? (record.total_minutes / 60).toFixed(1) : '-',
                break_minutes: record.total_break_minutes || 0,
                excess_break: record.excess_break_minutes || 0,
                break_penalty: parseFloat(record.break_penalty_amount || 0),
                travel_allowance: parseFloat(record.travel_allowance_amount || 0),
                amount: parseFloat(record.calculated_amount || 0)
            });
        } else {
            fullMonthBreakdown.push({
                date: new Date(year, month - 1, day).toISOString().split('T')[0],
                day_of_week: dayOfWeek,
                punch_in: '-',
                punch_out: '-',
                status: isWeeklyOff ? 'Weekly Off' : 'Absent',
                total_hours: '-',
                break_minutes: 0,
                excess_break: 0,
                break_penalty: 0,
                travel_allowance: 0,
                amount: 0
            });
        }
    }
    
    return fullMonthBreakdown;
}

// Standard Payslip PDF (without day-wise breakdown)
async function generateStandardPayslipPDF(payslipData, company) {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const buffers = [];
    
    doc.on('data', buffers.push.bind(buffers));
    
    // Company Header
    doc.fontSize(20).font('Helvetica-Bold').fillColor('#000000');
    doc.text(company?.company_name || 'Company Name', { align: 'center' });
    
    doc.fontSize(9).font('Helvetica');
    let contactInfo = '';
    if (company?.mobile_1) contactInfo += `Mobile: ${company.mobile_1}`;
    if (company?.email_1) contactInfo += ` Email: ${company.email_1}`;
    doc.text(contactInfo || 'Mobile: N/A Email: N/A', { align: 'center' });
    
    doc.moveDown(1);
    
    // Title
    doc.fontSize(16).font('Helvetica-Bold').fillColor('#1a237e');
    doc.text('SALARY SLIP', { align: 'center' });
    
    doc.moveDown(0.5);
    
    doc.fontSize(11).font('Helvetica-Bold');
    doc.text(`Monthly Gross Salary: ₹${parseFloat(payslipData.monthly_salary).toLocaleString('en-IN')}`, { align: 'center' });
    
    doc.moveDown(1.5);
    
    // Employee Details
    doc.fontSize(10).font('Helvetica');
    let yPos = doc.y;
    doc.text(`Name: ${payslipData.staff.name || 'N/A'}`, 50, yPos);
    doc.text(`Mobile: ${payslipData.staff.mobile || 'N/A'}`, 50, yPos + 20);
    doc.text(`Email: ${payslipData.staff.email || 'N/A'}`, 50, yPos + 40);
    doc.text(`Designation: ${payslipData.staff.designation || 'EMPLOYEE'}`, 300, yPos);
    doc.text(`Month & Year: ${payslipData.period.month_year || 'N/A'}`, 300, yPos + 20);
    
    doc.moveDown(4);
    
    // Tables
    const tableTop = doc.y;
    const leftTableX = 50;
    const rightTableX = 300;
    
    // Headers
    doc.fillColor('#1a237e').rect(leftTableX, tableTop, 220, 25).fill();
    doc.fillColor('#ffffff').fontSize(10).font('Helvetica-Bold');
    doc.text('EARNINGS', leftTableX + 70, tableTop + 8);
    
    doc.fillColor('#1a237e').rect(rightTableX, tableTop, 220, 25).fill();
    doc.fillColor('#ffffff');
    doc.text('DEDUCTIONS', rightTableX + 65, tableTop + 8);
    
    const earningsData = [
        { label: 'Present Days', value: payslipData.earnings.present_amount },
        { label: 'Half Day', value: payslipData.earnings.half_day_amount },
        { label: 'Paid Leave', value: payslipData.earnings.paid_leave_amount },
        { label: 'Overtime', value: payslipData.earnings.overtime_amount }
    ];
    
    const deductionsData = [
        { label: 'Fine', value: payslipData.deductions.fine_amount },
        { label: 'Break Penalty', value: payslipData.deductions.break_penalty },
        { label: 'Other Deduction', value: payslipData.deductions.other_deduction }
    ];
    
    let currentY = tableTop + 30;
    const rowHeight = 22;
    
    for (let i = 0; i < earningsData.length; i++) {
        const bgColor = i % 2 === 0 ? '#ffffff' : '#f5f5f5';
        doc.fillColor(bgColor).rect(leftTableX, currentY + (i * rowHeight), 220, rowHeight).fill();
        doc.strokeColor('#cccccc').lineWidth(0.5).rect(leftTableX, currentY + (i * rowHeight), 220, rowHeight).stroke();
        doc.fillColor('#000000').fontSize(9).font('Helvetica');
        doc.text(earningsData[i].label, 55, currentY + (i * rowHeight) + 6);
        doc.text(`₹${parseFloat(earningsData[i].value).toLocaleString('en-IN')}`, 180, currentY + (i * rowHeight) + 6);
    }
    
    for (let i = 0; i < deductionsData.length; i++) {
        const bgColor = i % 2 === 0 ? '#ffffff' : '#f5f5f5';
        doc.fillColor(bgColor).rect(rightTableX, currentY + (i * rowHeight), 220, rowHeight).fill();
        doc.strokeColor('#cccccc').lineWidth(0.5).rect(rightTableX, currentY + (i * rowHeight), 220, rowHeight).stroke();
        doc.fillColor('#000000').fontSize(9).font('Helvetica');
        doc.text(deductionsData[i].label, 305, currentY + (i * rowHeight) + 6);
        doc.text(`₹${Math.abs(parseFloat(deductionsData[i].value)).toLocaleString('en-IN')}`, 430, currentY + (i * rowHeight) + 6);
    }
    
    const totalY = currentY + (Math.max(earningsData.length, deductionsData.length) * rowHeight);
    
    doc.fillColor('#e8eaf6').rect(leftTableX, totalY, 220, rowHeight).fill();
    doc.strokeColor('#cccccc').lineWidth(0.5).rect(leftTableX, totalY, 220, rowHeight).stroke();
    doc.fillColor('#000000').fontSize(9).font('Helvetica-Bold');
    doc.text('Total Earnings', 55, totalY + 6);
    doc.text(`₹${parseFloat(payslipData.earnings.total_earnings).toLocaleString('en-IN')}`, 180, totalY + 6);
    
    doc.fillColor('#e8eaf6').rect(rightTableX, totalY, 220, rowHeight).fill();
    doc.strokeColor('#cccccc').lineWidth(0.5).rect(rightTableX, totalY, 220, rowHeight).stroke();
    doc.text('Total Deductions', 305, totalY + 6);
    doc.text(`₹${Math.abs(parseFloat(payslipData.deductions.total_deduction)).toLocaleString('en-IN')}`, 430, totalY + 6);
    
    doc.moveDown(Math.max(earningsData.length, deductionsData.length) + 2);
    
    // Travel Allowance
    if (parseFloat(payslipData.break_adjustments.total_travel_allowance) > 0) {
        doc.fillColor('#2e7d32');
        doc.fontSize(9).font('Helvetica');
        doc.text(`+ Travel Allowance: ₹${parseFloat(payslipData.break_adjustments.total_travel_allowance).toLocaleString('en-IN')}`, 50, doc.y);
        doc.fillColor('#000000');
        doc.moveDown(0.8);
    }
    
    doc.moveDown(1);
    
    // Net Salary
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#1a237e');
    doc.text(`Net Salary: ₹${parseFloat(payslipData.net_salary).toLocaleString('en-IN')}`, { align: 'center' });
    
    doc.moveDown(0.8);
    
    doc.fontSize(9).font('Helvetica').fillColor('#555555');
    doc.text(`Amount in Words: ${numberToWords(parseFloat(payslipData.net_salary))}`, { align: 'center' });
    
    doc.moveDown(2);
    
    // Break Summary
    if (payslipData.break_adjustments.total_break_minutes > 0) {
        doc.fontSize(8).font('Helvetica').fillColor('#666666');
        const breakHours = Math.floor(payslipData.break_adjustments.total_break_minutes / 60);
        const breakMins = payslipData.break_adjustments.total_break_minutes % 60;
        doc.text(`Break Summary: Total Break Time: ${breakHours}h ${breakMins}m`, 50, doc.y);
        
        if (payslipData.break_adjustments.total_excess_break_minutes > 0) {
            const excessHours = Math.floor(payslipData.break_adjustments.total_excess_break_minutes / 60);
            const excessMins = payslipData.break_adjustments.total_excess_break_minutes % 60;
            doc.text(`Excess Break Time: ${excessHours}h ${excessMins}m`, 300, doc.y - 8);
        }
        doc.moveDown(1.5);
    }
    
    doc.strokeColor('#cccccc').lineWidth(0.5);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(1);
    
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#000000');
    doc.text('Authorized Signatory', { align: 'center' });
    
    doc.moveDown(0.5);
    
    doc.fontSize(8).font('Helvetica').fillColor('#999999');
    doc.text('This is a computer-generated document and does not require a signature.', { align: 'center' });
    doc.text(`Generated on: ${new Date().toLocaleDateString('en-IN')}`, { align: 'center' });
    
    doc.end();
    
    return new Promise((resolve) => {
        doc.on('end', () => {
            resolve(Buffer.concat(buffers));
        });
    });
}

// Detailed Payslip PDF (with day-wise breakdown table)
async function generateDetailedPayslipPDF(payslipData, company, dailyBreakdown) {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const buffers = [];
    
    doc.on('data', buffers.push.bind(buffers));
    
    // Company Header
    doc.fontSize(18).font('Helvetica-Bold').fillColor('#000000');
    doc.text(company?.company_name || 'Company Name', { align: 'center' });
    
    doc.fontSize(9).font('Helvetica');
    let contactInfo = '';
    if (company?.mobile_1) contactInfo += `Mobile: ${company.mobile_1}`;
    if (company?.email_1) contactInfo += ` Email: ${company.email_1}`;
    doc.text(contactInfo, { align: 'center' });
    
    doc.moveDown(0.5);
    
    // Title
    doc.fontSize(16).font('Helvetica-Bold').fillColor('#1a237e');
    doc.text('DETAILED SALARY SLIP', { align: 'center' });
    
    doc.moveDown(1);
    
    // Employee Details
    doc.fontSize(10).font('Helvetica');
    doc.text(`Name: ${payslipData.staff.name || 'N/A'}`, 50);
    doc.text(`Designation: ${payslipData.staff.designation || 'EMPLOYEE'}`, 50, doc.y + 5);
    doc.text(`Month & Year: ${payslipData.period.month_year || 'N/A'}`, 300, doc.y - 12);
    doc.text(`Per Day Salary: ₹${payslipData.per_day_salary.toFixed(2)}`, 300, doc.y - 5);
    
    doc.moveDown(3);
    
    // Day-wise Breakdown Table
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#1a237e');
    doc.text('DAY-WISE ATTENDANCE BREAKDOWN', 50, doc.y);
    doc.moveDown(0.8);
    
    // Table Headers
    const headers = ['Date', 'Day', 'Status', 'In', 'Out', 'Hrs', 'Break', 'Amount'];
    const colWidths = [70, 50, 85, 50, 50, 45, 55, 70];
    let tableY = doc.y;
    let startX = 50;
    
    doc.fillColor('#1a237e').rect(startX, tableY, 495, 22).fill();
    doc.fillColor('#ffffff').fontSize(7).font('Helvetica-Bold');
    
    let xPos = startX;
    headers.forEach((header, i) => {
        doc.text(header, xPos + 3, tableY + 7);
        xPos += colWidths[i];
    });
    
    tableY += 22;
    
    // Table Rows
    doc.fontSize(7).font('Helvetica');
    let rowCount = 0;
    let totalEarned = 0;
    
    for (const record of dailyBreakdown) {
        const fillColor = rowCount % 2 === 0 ? '#ffffff' : '#f5f5f5';
        doc.fillColor(fillColor).rect(startX, tableY, 495, 18).fill();
        doc.strokeColor('#e0e0e0').lineWidth(0.3).rect(startX, tableY, 495, 18).stroke();
        doc.fillColor('#000000');
        
        // Status color coding
        let statusColor = '#000000';
        if (record.status === 'present') statusColor = '#2e7d32';
        else if (record.status === 'absent') statusColor = '#c62828';
        else if (record.status === 'half_day') statusColor = '#ed6c02';
        else if (record.status === 'paid_leave') statusColor = '#0288d1';
        else if (record.status === 'Weekly Off') statusColor = '#757575';
        
        let x = startX;
        doc.text(record.date, x + 3, tableY + 5);
        x += colWidths[0];
        
        doc.text(record.day_of_week.substring(0, 3), x + 3, tableY + 5);
        x += colWidths[1];
        
        doc.fillColor(statusColor);
        let statusText = record.status;
        if (statusText === 'present') statusText = 'Present';
        else if (statusText === 'absent') statusText = 'Absent';
        else if (statusText === 'half_day') statusText = 'Half Day';
        else if (statusText === 'paid_leave') statusText = 'Paid Leave';
        else if (statusText === 'Weekly Off') statusText = 'Weekly Off';
        doc.text(statusText, x + 3, tableY + 5);
        doc.fillColor('#000000');
        x += colWidths[2];
        
        doc.text(record.punch_in, x + 3, tableY + 5);
        x += colWidths[3];
        
        doc.text(record.punch_out, x + 3, tableY + 5);
        x += colWidths[4];
        
        doc.text(record.total_hours.toString(), x + 3, tableY + 5);
        x += colWidths[5];
        
        // Break info (show if > 0)
        const breakText = record.break_minutes > 0 ? `${Math.floor(record.break_minutes / 60)}h${record.break_minutes % 60}m` : '-';
        doc.text(breakText, x + 3, tableY + 5);
        x += colWidths[6];
        
        const amount = record.amount;
        totalEarned += amount;
        doc.text(`₹${amount.toFixed(0)}`, x + 3, tableY + 5);
        
        tableY += 18;
        rowCount++;
        
        // Add new page if needed
        if (tableY > 700 && rowCount < dailyBreakdown.length) {
            doc.addPage();
            tableY = 50;
            
            // Redraw headers
            doc.fillColor('#1a237e').rect(startX, tableY, 495, 22).fill();
            doc.fillColor('#ffffff').fontSize(7).font('Helvetica-Bold');
            xPos = startX;
            headers.forEach((header, i) => {
                doc.text(header, xPos + 3, tableY + 7);
                xPos += colWidths[i];
            });
            tableY += 22;
            doc.fontSize(7).font('Helvetica');
        }
    }
    
    doc.moveDown(2);
    
    // Summary Section
    doc.strokeColor('#cccccc').lineWidth(0.5);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(1);
    
    // Summary Box
    const summaryY = doc.y;
    
    doc.fillColor('#e8eaf6').rect(50, summaryY, 495, 80).fill();
    doc.strokeColor('#cccccc').lineWidth(0.5).rect(50, summaryY, 495, 80).stroke();
    
    doc.fillColor('#000000').fontSize(9).font('Helvetica-Bold');
    doc.text('SUMMARY', 55, summaryY + 10);
    
    doc.fontSize(8).font('Helvetica');
    doc.text(`Present Days: ${payslipData.attendance_summary.present}`, 55, summaryY + 30);
    doc.text(`Half Days: ${payslipData.attendance_summary.half_day}`, 55, summaryY + 45);
    doc.text(`Paid Leaves: ${payslipData.attendance_summary.paid_leave}`, 55, summaryY + 60);
    
    doc.text(`Overtime Days: ${payslipData.attendance_summary.overtime_days}`, 200, summaryY + 30);
    doc.text(`Fine Days: ${payslipData.attendance_summary.fine_days}`, 200, summaryY + 45);
    doc.text(`Absent Days: ${payslipData.attendance_summary.absent}`, 200, summaryY + 60);
    
    doc.text(`Total Earnings: ₹${parseFloat(payslipData.earnings.total_earnings).toLocaleString('en-IN')}`, 350, summaryY + 30);
    doc.text(`Total Deductions: ₹${Math.abs(parseFloat(payslipData.deductions.total_deduction)).toLocaleString('en-IN')}`, 350, summaryY + 45);
    doc.text(`Travel Allowance: +₹${parseFloat(payslipData.break_adjustments.total_travel_allowance).toLocaleString('en-IN')}`, 350, summaryY + 60);
    
    doc.moveDown(6);
    
    // Break Summary
    if (payslipData.break_adjustments.total_break_minutes > 0) {
        doc.fontSize(8).font('Helvetica').fillColor('#666666');
        const breakHours = Math.floor(payslipData.break_adjustments.total_break_minutes / 60);
        const breakMins = payslipData.break_adjustments.total_break_minutes % 60;
        doc.text(`Total Break Time: ${breakHours}h ${breakMins}m`, 50, doc.y);
        
        if (payslipData.break_adjustments.total_excess_break_minutes > 0) {
            const excessHours = Math.floor(payslipData.break_adjustments.total_excess_break_minutes / 60);
            const excessMins = payslipData.break_adjustments.total_excess_break_minutes % 60;
            doc.text(`Excess Break Time: ${excessHours}h ${excessMins}m`, 250, doc.y - 12);
            doc.text(`Break Penalty: ₹${parseFloat(payslipData.deductions.break_penalty).toLocaleString('en-IN')}`, 450, doc.y - 12);
        }
        doc.moveDown(2);
    }
    
    doc.strokeColor('#cccccc').lineWidth(0.5);
    doc.moveTo(50, doc.y).lineTo(550, doc.y).stroke();
    doc.moveDown(1);
    
    // Net Salary
    doc.fontSize(14).font('Helvetica-Bold').fillColor('#1a237e');
    doc.text(`NET SALARY: ₹${parseFloat(payslipData.net_salary).toLocaleString('en-IN')}`, { align: 'center' });
    
    doc.moveDown(0.8);
    
    doc.fontSize(9).font('Helvetica').fillColor('#555555');
    doc.text(`Amount in Words: ${numberToWords(parseFloat(payslipData.net_salary))}`, { align: 'center' });
    
    doc.moveDown(1.5);
    
    // Footer
    doc.fontSize(10).font('Helvetica-Bold').fillColor('#000000');
    doc.text('Authorized Signatory', { align: 'center' });
    
    doc.moveDown(0.5);
    
    doc.fontSize(8).font('Helvetica').fillColor('#999999');
    doc.text('This is a computer-generated document and does not require a signature.', { align: 'center' });
    doc.text(`Generated on: ${new Date().toLocaleDateString('en-IN')}`, { align: 'center' });
    
    doc.end();
    
    return new Promise((resolve) => {
        doc.on('end', () => {
            resolve(Buffer.concat(buffers));
        });
    });
}

// ==================== PAYSLIP ROUTE HANDLERS ====================

/**
 * Generate and Download Standard Payslip PDF
 * POST /api/attendance/generate-payslip
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