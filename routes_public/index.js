import express from "express";
import invitationRoutes from "./invitation.js";
import contactRoutes from "./contact.js";

const router = express.Router();

router.use(invitationRoutes);
router.use(contactRoutes);

export default router;
