import express from "express";
import botController from "../controllers/botController.js";

const router = express.Router();

// Chatbot conversational endpoint
router.post("/chat", botController.chat);

router.post("/reset", botController.resetSession);

export default router;
