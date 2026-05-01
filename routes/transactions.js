import express from "express";
import pool from "../connection.js";
import { v4 as uuidv4 } from 'uuid';
import { logger } from "../lib/logger.js";

const router = express.Router();

router.get("/queue", (req, res) => {
    res.status(200).json({ message: `Task received` });
});

router.post("/sendTx", async (req, res) => {
    try {
        const { functionSignature, args, rpcUrl, contractAddress, chainId } = req.body;
        if (!(functionSignature && args && contractAddress && chainId)) {
            return res.status(500).json({ success: false, error: "Required Key Value Missing!" });
        }
        const smartWallet =
            req.body.smartWallet && req.body.smartWallet !== ""
                ? req.body.smartWallet
                : process.env.DEFAULT_SMART_WALLET;

        const uuid = uuidv4();

        await pool.query(
            `INSERT INTO wallet_transactions (uuid, functionSignature, args, contractAddress, chainId, smartWallet, status) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [uuid, functionSignature, args, contractAddress, chainId, smartWallet, "pending"]
        );
        res.status(200).json({ message: `Transaction sent`, queueId: uuid, isSuccess: true });
    } catch (err) {
        logger.error(`Error in /sendTx route: failed with error: ${err.message}`);
        res.status(500).json({ success: false, error: "Internal server error!" });
    }
});

export default router;
