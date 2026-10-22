import express from "express";
import { auth, validateBranch } from "../middleware/auth.js";
import { requireBranchAdmin } from "../middleware/requireBranchAdmin.js";
import {
    buildRunPdf,
    buildExecutiveSummaryPdf,
    getExecutiveSummary,
    getExecutiveSummaryConfig,
    getExecutiveSummaryRun,
    listExecutiveSummaryRuns,
    runExecutiveSummary,
    updateExecutiveSummaryConfig,
    normalizePeriod,
} from "../services/executiveSummaryService.js";

const router = express.Router();
const guards = [auth, validateBranch, requireBranchAdmin];

function username(req) {
    return String(req.headers["username"] || req.headers["Username"] || "").trim();
}

function parseSections(value) {
    if (!value) return undefined;
    const values = Array.isArray(value) ? value : String(value).split(",");
    return values.map((item) => String(item).trim()).filter(Boolean);
}

function reportFilters(req) {
    const inactivityDays = req.query.inactivity_days === undefined
        ? undefined
        : Number(req.query.inactivity_days);
    if (inactivityDays !== undefined && (!Number.isInteger(inactivityDays) || inactivityDays < 0 || inactivityDays > 3650)) {
        const error = new Error("inactivity_days must be an integer from 0 to 3650");
        error.statusCode = 400;
        throw error;
    }
    return {
        inactivityDays,
        staffUsername: req.query.staff_username,
        search: req.query.search,
        sections: parseSections(req.query.sections),
    };
}

function periodFromRequest(req, config) {
    const fromDate = req.body?.from_date || req.query.from_date;
    const toDate = req.body?.to_date || req.query.to_date;
    return normalizePeriod({
        fromDate,
        toDate,
        scheduleType: config.schedule_type,
        timezone: config.timezone,
        weekStartsOn: config.week_starts_on,
    });
}

function sendPdf(res, pdf, filename) {
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", `attachment; filename="${String(filename).replace(/[^a-zA-Z0-9._-]/g, "_")}"`);
    return res.status(200).send(pdf);
}

function handleError(res, error, fallback = "Executive Summary request failed") {
    const status = Number(error?.statusCode) || 500;
    return res.status(status).json({
        success: false,
        code: error?.code || (status === 400 ? "VALIDATION_ERROR" : "EXECUTIVE_SUMMARY_ERROR"),
        message: status === 500 ? fallback : String(error?.message || fallback),
        run_id: error?.runId || undefined,
    });
}

router.get("/config", ...guards, async (req, res) => {
    try {
        const data = await getExecutiveSummaryConfig(req.branch_id, username(req));
        return res.json({ success: true, data });
    } catch (error) {
        return handleError(res, error, "Failed to load Executive Summary configuration");
    }
});

router.put("/config", ...guards, async (req, res) => {
    try {
        const data = await updateExecutiveSummaryConfig(req.branch_id, username(req), req.body || {});
        return res.json({ success: true, data, message: "Executive Summary configuration saved" });
    } catch (error) {
        return handleError(res, error, "Failed to save Executive Summary configuration");
    }
});

router.get("/", ...guards, async (req, res) => {
    try {
        const data = await getExecutiveSummary({
            branchId: req.branch_id,
            username: username(req),
            fromDate: req.query.from_date,
            toDate: req.query.to_date,
            filters: reportFilters(req),
        });
        return res.json({ success: true, data });
    } catch (error) {
        return handleError(res, error, "Failed to load Executive Summary");
    }
});

router.get("/pdf", ...guards, async (req, res) => {
    try {
        const data = await getExecutiveSummary({
            branchId: req.branch_id,
            username: username(req),
            fromDate: req.query.from_date,
            toDate: req.query.to_date,
            filters: reportFilters(req),
        });
        const pdf = await buildExecutiveSummaryPdf(data);
        return sendPdf(res, pdf, `executive-summary-${data.meta.period.from_date}-to-${data.meta.period.to_date}.pdf`);
    } catch (error) {
        return handleError(res, error, "Failed to generate Executive Summary PDF");
    }
});

router.post("/send", ...guards, async (req, res) => {
    try {
        const config = await getExecutiveSummaryConfig(req.branch_id, username(req));
        const period = periodFromRequest(req, config);
        const result = await runExecutiveSummary({
            branchId: req.branch_id,
            username: username(req),
            period,
            triggerType: "manual",
            sendEmail: true,
            config,
        });
        return res.json({
            success: true,
            message: "Executive Summary email sent",
            data: { run_id: result.run_id, status: result.status, filename: result.filename, period },
        });
    } catch (error) {
        return handleError(res, error, "Failed to send Executive Summary email");
    }
});

router.get("/runs", ...guards, async (req, res) => {
    try {
        const data = await listExecutiveSummaryRuns(req.branch_id, req.query);
        return res.json({ success: true, data });
    } catch (error) {
        return handleError(res, error, "Failed to load Executive Summary run history");
    }
});

router.get("/runs/:run_id/pdf", ...guards, async (req, res) => {
    try {
        const result = await buildRunPdf(req.branch_id, req.params.run_id);
        return sendPdf(res, result.pdf, result.filename);
    } catch (error) {
        return handleError(res, error, "Failed to generate Executive Summary run PDF");
    }
});

router.get("/runs/:run_id", ...guards, async (req, res) => {
    try {
        const data = await getExecutiveSummaryRun(req.branch_id, req.params.run_id);
        return res.json({ success: true, data });
    } catch (error) {
        return handleError(res, error, "Failed to load Executive Summary run");
    }
});

export default router;
