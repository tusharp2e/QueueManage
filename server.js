import express from "express";
import cors from "cors";
import { initTables } from "./model/table.js";
import cron from 'node-cron';
import transactionsRouter from "./routes/transactions.js";
import { runEvery30Sec } from "./cron/processor.js";
import { logger } from "./lib/logger.js";

const app = express();

app.use(cors());
app.use(express.json());

app.use(transactionsRouter);

// Connect to the database
(async () => {
    await initTables();
})().catch((err) => {
    logger.error("Failed to initialize DB tables:", err);
    process.exit(1);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
    logger.info(`Server running on port ${PORT}`);
    cron.schedule('*/30 * * * * *', () => {
        runEvery30Sec();
    });
});
