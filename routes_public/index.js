import express from "express";
import invitationRoutes from "./invitation.js";
import contactRoutes from "./contact.js";
import legalRoutes from "./legal.js";

const router = express.Router();

router.use(invitationRoutes);
router.use(contactRoutes);
router.use(legalRoutes);

export default router;
