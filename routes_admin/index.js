import express from "express";
import authRoutes from "./auth.js";
import userRoutes from "./user.js";
import branchRoutes from "./branch.js";
import serviceRoutes from "./service.js";
import mailRoutes from "./mail.js";
import wpSystemTemplatesRoutes from "./wpSystemTemplates.js";
import smsSystemRoutes from "./smsSystem.js";
import callSystemRoutes from "./callSystem.js";
import razorpayRoutes from "./razorpay.js";
import walletRoutes from "./wallet.js";
import helpSupportRoutes from "./helpSupport.js";
import websiteContactRoutes from "./websiteContact.js";
import websiteLegalRoutes from "./websiteLegal.js";

const router = express.Router();

router.use("/auth", authRoutes);
router.use("/user", userRoutes);
router.use("/branch", branchRoutes);
router.use("/service", serviceRoutes);
router.use("/mail", mailRoutes);
router.use("/wp-system-templates", wpSystemTemplatesRoutes);
router.use("/sms-system", smsSystemRoutes);
router.use("/call-system", callSystemRoutes);
router.use("/razorpay", razorpayRoutes);
router.use("/wallet", walletRoutes);
router.use("/help-support", helpSupportRoutes);
router.use("/website-contact", websiteContactRoutes);
router.use("/website-legal", websiteLegalRoutes);

export default router;
