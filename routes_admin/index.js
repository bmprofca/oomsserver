import express from "express";
import authRoutes from "./auth.js";
import userRoutes from "./user.js";
import branchRoutes from "./branch.js";
import serviceRoutes from "./service.js";
import mailRoutes from "./mail.js";
import wpSystemTemplatesRoutes from "./wpSystemTemplates.js";

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/user", userRoutes);
router.use("/branch", branchRoutes);
router.use("/service", serviceRoutes);
router.use("/mail", mailRoutes);
router.use("/wp-system-templates", wpSystemTemplatesRoutes);

export default router;
