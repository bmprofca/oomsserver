import express from "express";
import invitationRoutes from "./invitation.js";
import contactRoutes from "./contact.js";
import legalRoutes from "./legal.js";
import accountDeletionRoutes from "./accountDeletion.js";

const router = express.Router();

router.use(invitationRoutes);
router.use(contactRoutes);
router.use(legalRoutes);
router.use(accountDeletionRoutes);

export default router;
