import express from "express";
import { auth, validateBranch } from "../middleware/auth.js";
import walletController from "../controllers/walletController.js";

const router = express.Router();

router.get("/balance", auth, validateBranch, walletController.getBalance);
router.get("/transactions", auth, validateBranch, walletController.getTransactions);
router.post("/create-checkout", auth, validateBranch, walletController.createCheckout);
router.post("/verify-payment", auth, validateBranch, walletController.verifyPayment);
router.post("/add-money", auth, validateBranch, walletController.addMoney);

export default router;
