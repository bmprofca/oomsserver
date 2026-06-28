import express from "express";
import authRoutes from "./auth.js";
import profileRoutes from "./profile.js";
import taskRoutes from "./task.js";
import firmRoutes from "./firm.js";
import serviceRoutes from "./service.js";
import transactionRoutes from "./transaction.js";
import reportRoutes from "./report.js";
import documentRoutes from "./document.js";
import branchRoutes from "./branch.js";

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/profile", profileRoutes);
router.use("/task", taskRoutes);
router.use("/firm", firmRoutes);
router.use("/service", serviceRoutes);
router.use("/transaction", transactionRoutes);
router.use("/report", reportRoutes);
router.use("/document", documentRoutes);
router.use("/branch", branchRoutes);

export default router;