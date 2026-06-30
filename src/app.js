import express from 'express';
import { healthRouter } from './routes/health.js';
import { transactionRouter } from './routes/transaction.js';
import { deployRouter } from './routes/deploy.js';

export const app = express();

// Limit raised to 2mb to accommodate deploy requests, whose bodies carry
// contract creation bytecode + base64 ABI (can be hundreds of KB).
app.use(express.json({ limit: '2mb' }));

app.use(healthRouter);
app.use(transactionRouter);
app.use(deployRouter);


