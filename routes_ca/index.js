import express from "express";
import authRoutes from "./auth.js";
import profileRoutes from "./profile.js";
import taskRoutes from "./task.js";
import transactionRoutes from "./transaction.js";
import branchRoutes from "./branch.js";
import reportRoutes from "./report.js";
import serviceRoutes from "./service.js";

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/profile", profileRoutes);
router.use("/task", taskRoutes);
router.use("/transaction", transactionRoutes);
router.use("/branch", branchRoutes);
router.use("/report", reportRoutes);
router.use("/service", serviceRoutes);

export default router;
