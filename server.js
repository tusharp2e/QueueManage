import express from "express";
import cors from "cors";
import { initTables } from "./model/table.js";
import pool from "./connection.js";
import { v4 as uuidv4 } from 'uuid';
import cron from 'node-cron';
import { sendEVMCall } from "./services/evmService.js";

const app = express();

app.use(cors());
app.use(express.json());

app.use("/queue", (req, res) => {
    res.status(200).json({ message: `Task received` });
});

// Connect to the database
(async () => {
    await initTables(); // Runs on app start
})();

app.use("/sendTx", (req, res) => {
    const { functionSignature, args, rpcUrl, contractAddress, chainId } = req.body;
    if (!(functionSignature && args && contractAddress && chainId)) {
        return res.status(500).json({ success: false, error: "Required Key Value Missing!" });
    }
    const smartWallet =
        req.body.smartWallet && req.body.smartWallet !== ""
            ? req.body.smartWallet
            : process.env.DEFAULT_SMART_WALLET;

    const uuid = uuidv4();

    pool.query(
        `INSERT INTO wallet_transactions (uuid, functionSignature, args, contractAddress, chainId, smartWallet, status) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [uuid, functionSignature, args, contractAddress, chainId, smartWallet, "pending"],
        (err) => {
            if (err) {
                console.error("Error inserting transaction into database:", err);
                return res.status(500).json({ success: false, error: "Database insertion failed!" });
            }
        }
    );
    res.status(200).json({ message: `Transaction sent`, queueId: uuid, isSuccess: true });
});

const runEvery30Sec = async () => {
    console.log("Running task every 30 seconds...");
    // Fetch pending transactions from the database
    const query = `SELECT * FROM ( SELECT *,
                                    ROW_NUMBER() OVER (
                                        PARTITION BY smartwallet
                                        ORDER BY created_at ASC
                                    ) as rn FROM wallet_transactions WHERE status = 'pending'
                            ) t WHERE rn = 1 LIMIT 100;`
    pool.query(query, (err, result) => {
        if (err) {
            console.error("Error fetching transactions from database:", err);
            return;
        }
        const transactions = result.rows;
        console.log(`Fetched ${transactions.length} pending transactions.`);
        // Process each transaction (for demonstration, we just log them)
        transactions.forEach(async (tx)  => {
            console.log(`Processing transaction with UUID: ${tx.uuid}`);
            // Here you would add your logic to send the transaction to the blockchain
            const result = await sendEVMCall({
                functionSignature: tx.functionsignature,
                args: tx.args,
                contractAddress: tx.contractaddress,
                chainId: tx.chainid,
                smartWallet: tx.smartwallet
            });
            let pushed;
            // let result= {isSuccess: false}; // Simulating a successful transaction for demonstration
            (result.isSuccess) ? pushed = "Pushed" : pushed = "NotPushed";
            
            // After processing, you can update the transaction status in the database
            pool.query(`UPDATE wallet_transactions SET status = $1, updated_at = NOW() WHERE uuid = $2`, [pushed, tx.uuid], (err) => {
                if (err) {
                    console.error("Error updating transaction status in database:", err);
                } else {
                    console.log(`Transaction with UUID: ${tx.uuid} marked as processed.`);
                }
            });
        });
    });
};

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    cron.schedule('*/30 * * * * *', () => {
        runEvery30Sec();
    });
});
