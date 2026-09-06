import express from "express";
import authRoutes from "./auth.js";
import profileRoutes from "./profile.js";
import taskRoutes from "./task.js";
import transactionRoutes from "./transaction.js";
import reportRoutes from "./report.js";
import firmRoutes from "./firm.js";
import documentRoutes from "./document.js";
import serviceRoutes from "./service.js";
import billingRoutes from "./billing.js";

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/profile", profileRoutes);
router.use("/task", taskRoutes);
router.use("/transaction", transactionRoutes);
router.use("/report", reportRoutes);
router.use("/firm", firmRoutes);
router.use("/document", documentRoutes);
router.use("/service", serviceRoutes);
router.use("/billing", billingRoutes);

export default router;
