import express from 'express';
import { healthRouter } from './routes/health.js';
import { transactionRouter } from './routes/transaction.js';

export const app = express();

app.use(express.json({ limit: '100kb' }));

app.use(healthRouter);
app.use(transactionRouter);


