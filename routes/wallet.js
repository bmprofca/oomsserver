import express from "express";
import { auth, validateBranch } from "../middleware/auth.js";
import walletController from "../controllers/walletController.js";

const router = express.Router();

router.get("/balance", auth, validateBranch, walletController.getBalance);
router.post("/add-money", auth, validateBranch, walletController.addMoney);
router.get("/transactions", auth, validateBranch, walletController.getTransactions);

export default router;