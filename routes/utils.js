import express from "express";
import pool from "../db.js";
import { readFileSync } from "fs";
import { auth, validateBranch } from "../middleware/auth.js";

const router = express.Router();
const statesAndDistricts = JSON.parse(
    readFileSync(new URL("../media/utils/states-and-districts.json", import.meta.url), "utf8")
);


router.get("/assisment-years", auth, validateBranch, async (req, res) => {
    return res.status(200).json({
        success: true,
        data: [
            "2026-2027",
            "2025-2026",
            "2024-2025",
            "2023-2024",
            "2022-2023",
            "2021-2022",
            "2020-2021",
            "2019-2020",
            "2018-2019",
            "2017-2018",
            "2016-2017"
        ]
    });
});

router.get("/financial-years", auth, validateBranch, async (req, res) => {
    return res.status(200).json({
        success: true,
        data: [
            "2025-2026",
            "2024-2025",
            "2023-2024",
            "2022-2023",
            "2021-2022",
            "2020-2021",
            "2019-2020",
            "2018-2019",
            "2017-2018",
            "2016-2017"
        ]
    });
});

router.get("/states-and-districts", auth, validateBranch, async (req, res) => {
    return res.status(200).json({
        success: true,
        data: statesAndDistricts
    });
});

router.get("/care-of-types", auth, validateBranch, async (req, res) => {
    return res.status(200).json({
        success: true,
        data: [
            "S/O",
            "W/O",
            "D/O"
        ]
    });
});

export default router;