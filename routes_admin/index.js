import express from "express";
import authRoutes from "./auth.js";
import userRoutes from "./user.js";
import branchRoutes from "./branch.js";
import serviceRoutes from "./service.js";

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/user", userRoutes);
router.use("/branch", branchRoutes);
router.use("/service", serviceRoutes);

export default router;
