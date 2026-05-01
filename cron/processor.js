import pool from "../connection.js";
import { logger } from "../lib/logger.js";
import { sendEVMCall } from "../services/evmService.js";

export const runEvery30Sec = async () => {
    try {
        logger.info("Running task every 30 seconds...");
        // Fetch pending transactions from the database
        const query = `SELECT * FROM ( SELECT *,
                                    ROW_NUMBER() OVER (
                                        PARTITION BY smartwallet
                                        ORDER BY created_at ASC
                                    ) as rn FROM wallet_transactions WHERE status = 'pending'
                            ) t WHERE rn = 1 LIMIT 100;`
        pool.query(query, (err, result) => {
            if (err) {
                logger.error("Error fetching transactions from database:", err);
                return;
            }
            const transactions = result.rows;
            logger.info(`Fetched ${transactions.length} pending transactions.`);
            // Process each transaction (for demonstration, we just log them)
            transactions.forEach(async (tx) => {
                logger.info(`Processing transaction with UUID: ${tx.uuid}`);
                // Here you would add your logic to send the transaction to the blockchain
                const evmServiceResult = await sendEVMCall({
                    functionSignature: tx.functionsignature,
                    args: tx.args,
                    contractAddress: tx.contractaddress,
                    chainId: tx.chainid,
                    smartWallet: tx.smartwallet,
                    queueId: tx.uuid
                });
                let pushed;
                // let result= {isSuccess: false}; // Simulating a successful transaction for demonstration
                (evmServiceResult.isSuccess) ? pushed = "Pushed" : pushed = "NotPushed";

                // After processing, you can update the transaction status in the database
                pool.query(`UPDATE wallet_transactions SET status = $1, updated_at = NOW() WHERE uuid = $2`, [pushed, tx.uuid], (err) => {
                    if (err) {
                        logger.error("Error updating transaction status in database:", err);
                    } else {
                        logger.info(`Transaction with UUID: ${tx.uuid} marked as processed.`);
                    }
                });
            });
        });
    } catch (err) {
        logger.error("Error in runEvery30Sec function:", err);
    }
};
