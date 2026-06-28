import express from "express";
import authRoutes from "./auth.js";
import profileRoutes from "./profile.js";
import taskRoutes from "./task.js";
import serviceRoutes from "./service.js";
import transactionRoutes from "./transaction.js";
import branchRoutes from "./branch.js";
import reportRoutes from "./report.js";
import clientRoutes from "./client.js";

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/profile", profileRoutes);
router.use("/task", taskRoutes);
router.use("/service", serviceRoutes);
router.use("/transaction", transactionRoutes);
router.use("/branch", branchRoutes);
router.use("/report", reportRoutes);
router.use("/client", clientRoutes);

export default router;
