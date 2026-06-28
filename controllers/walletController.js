import {
    getOrCreateWallet,
    creditWallet,
    getTransactions
} from "../services/walletService.js";

function sendSuccess(res, message, data = {}, extra = {}) {
    return res.json({ success: true, message, data, ...extra });
}

function sendError(res, error, code = 400) {
    return res.status(code).json({
        success: false,
        message: error?.message || "Request failed"
    });
}

const walletController = {
    async getBalance(req, res) {
        try {
            const data = await getOrCreateWallet(req.branch_id);
            return sendSuccess(res, "Wallet balance fetched successfully", data);
        } catch (error) {
            return sendError(res, error);
        }
    },

    async addMoney(req, res) {
        try {
            const { amount, purpose, details } = req.body || {};
            if (!amount || Number(amount) <= 0) {
                throw new Error("Amount must be a positive number");
            }
            const data = await creditWallet({
                branch_id: req.branch_id,
                amount,
                purpose: purpose || "Add Money",
                details
            });
            return sendSuccess(res, "Money added to wallet successfully", data);
        } catch (error) {
            return sendError(res, error);
        }
    },

    async getTransactions(req, res) {
        try {
            const { page_no = 1, limit = 10 } = req.query;
            const result = await getTransactions({
                branch_id: req.branch_id,
                page_no,
                limit
            });
            return sendSuccess(res, "Transaction history fetched successfully", result.data, {
                pagination: result.pagination
            });
        } catch (error) {
            return sendError(res, error, 500);
        }
    }
};

export default walletController;
