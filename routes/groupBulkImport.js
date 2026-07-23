import express from "express";
import pool from "../db.js";
import { auth, validateBranch } from "../middleware/auth.js";
import {
  UNIQUE_RANDOM_STRING,
  ID_LENGTH,
} from "../helpers/function.js";

const router = express.Router();

const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

function normalizePan(value) {
  return String(value ?? "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "");
}

function normalizeName(value) {
  return String(value ?? "").trim();
}

async function assertGroupInBranch(conn, groupId, branchId) {
  const [rows] = await conn.query(
    `SELECT group_id, name
     FROM groups
     WHERE group_id = ?
       AND branch_id = ?
       AND is_deleted = '0'
     LIMIT 1`,
    [groupId, branchId],
  );
  return rows[0] || null;
}

/**
 * Lookup firms by PAN (firms.pan_no) for the branch.
 * Returns Map<pan, { firm_id, firm_name }>
 */
async function findFirmsByPans(conn, pans, branchId) {
  const unique = [...new Set(pans.filter(Boolean))];
  const map = new Map();
  if (unique.length === 0) return map;

  const [rows] = await conn.query(
    `SELECT firm_id, firm_name, UPPER(TRIM(pan_no)) AS pan
     FROM firms
     WHERE branch_id = ?
       AND is_deleted = '0'
       AND status = '1'
       AND pan_no IS NOT NULL
       AND TRIM(pan_no) != ''
       AND UPPER(TRIM(pan_no)) IN (?)
     ORDER BY id DESC`,
    [branchId, unique],
  );

  for (const row of rows) {
    const pan = normalizePan(row.pan);
    if (pan && !map.has(pan)) {
      map.set(pan, {
        firm_id: row.firm_id,
        firm_name: row.firm_name,
      });
    }
  }
  return map;
}

/**
 * Which firm_ids are already in the group.
 */
async function findExistingGroupFirmIds(conn, groupId, firmIds) {
  if (!firmIds.length) return new Set();
  const [rows] = await conn.query(
    `SELECT firm_id
     FROM group_firms
     WHERE group_id = ?
       AND firm_id IN (?)
       AND is_deleted = '0'`,
    [groupId, firmIds],
  );
  return new Set(rows.map((r) => r.firm_id));
}

/**
 * POST /groups/:groupId/bulk-import/validate
 * Body: { pans: string[] }
 */
router.post(
  "/:groupId/bulk-import/validate",
  auth,
  validateBranch,
  async (req, res) => {
    const conn = await pool.getConnection();
    try {
      const groupId = String(req.params.groupId || "").trim();
      const branchId = req.branch_id;
      const pansRaw = Array.isArray(req.body?.pans) ? req.body.pans : [];

      if (!groupId) {
        return res.status(400).json({
          success: false,
          message: "groupId is required",
        });
      }

      const group = await assertGroupInBranch(conn, groupId, branchId);
      if (!group) {
        return res.status(404).json({
          success: false,
          message: "Group not found",
        });
      }

      const pans = pansRaw.map(normalizePan).filter(Boolean);
      const uniquePans = [...new Set(pans)];

      // Format check on server (never trust frontend)
      const invalidFormat = uniquePans.filter((p) => !PAN_REGEX.test(p));
      if (invalidFormat.length > 0) {
        return res.status(400).json({
          success: false,
          message: `Invalid PAN format: ${invalidFormat.slice(0, 5).join(", ")}`,
        });
      }

      const firmMap = await findFirmsByPans(conn, uniquePans, branchId);
      const firmIds = [...firmMap.values()].map((f) => f.firm_id);
      const inGroup = await findExistingGroupFirmIds(conn, groupId, firmIds);

      const data = uniquePans.map((pan) => {
        const firm = firmMap.get(pan);
        if (!firm) {
          return {
            pan,
            exists: false,
            found: false,
            firm_id: null,
          };
        }
        const already = inGroup.has(firm.firm_id);
        return {
          pan,
          exists: already,
          found: true,
          firm_id: firm.firm_id,
        };
      });

      return res.status(200).json({
        success: true,
        message: "Validation complete",
        data,
      });
    } catch (error) {
      console.error("bulk-import validate error:", error);
      return res.status(500).json({
        success: false,
        message: "Validation failed",
        error: error.message,
      });
    } finally {
      conn.release();
    }
  },
);

/**
 * POST /groups/:groupId/bulk-import
 * Body: { firms: [{ pan, name }] }
 */
router.post(
  "/:groupId/bulk-import",
  auth,
  validateBranch,
  async (req, res) => {
    const conn = await pool.getConnection();
    try {
      const groupId = String(req.params.groupId || "").trim();
      const branchId = req.branch_id;
      const createdBy = req.headers["username"] || "";
      const firmsRaw = Array.isArray(req.body?.firms) ? req.body.firms : [];

      if (!groupId) {
        return res.status(400).json({
          success: false,
          message: "groupId is required",
        });
      }

      if (firmsRaw.length === 0) {
        return res.status(400).json({
          success: false,
          message: "firms array is required",
        });
      }

      const group = await assertGroupInBranch(conn, groupId, branchId);
      if (!group) {
        return res.status(404).json({
          success: false,
          message: "Group not found",
        });
      }

      // Normalize + collect request-level duplicates
      const entries = firmsRaw.map((f, idx) => ({
        idx,
        pan: normalizePan(f?.pan),
        name: normalizeName(f?.name),
      }));

      const panCounts = new Map();
      entries.forEach((e) => {
        if (!e.pan) return;
        panCounts.set(e.pan, (panCounts.get(e.pan) || 0) + 1);
      });

      const uniqueValidPans = [
        ...new Set(
          entries
            .filter(
              (e) =>
                e.pan &&
                PAN_REGEX.test(e.pan) &&
                e.name &&
                (panCounts.get(e.pan) || 0) === 1,
            )
            .map((e) => e.pan),
        ),
      ];

      const firmMap = await findFirmsByPans(conn, uniqueValidPans, branchId);
      const firmIds = [...firmMap.values()].map((f) => f.firm_id);
      const inGroup = await findExistingGroupFirmIds(conn, groupId, firmIds);

      await conn.beginTransaction();

      const result = [];
      const insertedFirmIds = new Set();

      for (const entry of entries) {
        const { pan, name } = entry;

        if (!pan || !name) {
          result.push({
            pan: pan || "",
            status: "Failed",
            message: !pan ? "PAN is required" : "Firm name is required",
          });
          continue;
        }

        if (!PAN_REGEX.test(pan)) {
          result.push({
            pan,
            status: "Failed",
            message: "PAN format invalid",
          });
          continue;
        }

        if ((panCounts.get(pan) || 0) > 1) {
          result.push({
            pan,
            status: "Failed",
            message: "Duplicate PAN in request",
          });
          continue;
        }

        const firm = firmMap.get(pan);
        if (!firm) {
          result.push({
            pan,
            status: "Firm Not Found",
            message: "Firm not found",
          });
          continue;
        }

        if (inGroup.has(firm.firm_id) || insertedFirmIds.has(firm.firm_id)) {
          result.push({
            pan,
            status: "Already Exists",
            message: "Already exists in group",
          });
          continue;
        }

        const unique_id = await UNIQUE_RANDOM_STRING(
          "group_firms",
          "unique_id",
          { conn, length: ID_LENGTH },
        );

        await conn.query(
          `INSERT INTO group_firms
           (unique_id, group_id, firm_id, create_by, modify_by, is_deleted, create_date, modify_date)
           VALUES (?, ?, ?, ?, ?, '0', NOW(), NOW())`,
          [unique_id, groupId, firm.firm_id, createdBy, createdBy],
        );

        insertedFirmIds.add(firm.firm_id);
        result.push({
          pan,
          status: "Imported",
          message: "Successfully imported",
          firm_id: firm.firm_id,
        });
      }

      await conn.commit();

      const imported = result.filter((r) => r.status === "Imported").length;

      return res.status(200).json({
        success: true,
        message:
          imported > 0
            ? `${imported} firm(s) imported`
            : "No firms were imported",
        result,
      });
    } catch (error) {
      try {
        await conn.rollback();
      } catch {
        /* ignore */
      }
      console.error("bulk-import error:", error);
      return res.status(500).json({
        success: false,
        message: "Import failed",
        error: error.message,
      });
    } finally {
      conn.release();
    }
  },
);

export default router;
