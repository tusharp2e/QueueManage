import { logger } from "../lib/logger.js";

export async function sendEVMCall({
    functionSignature,
    args,
    contractAddress,
    chainId,
    smartWallet,
    queueId
}) {
    try {
        const evmURL = process.env.EVM_URL;
        const evmAuthToken = process.env.EVM_AUTH_TOKEN;
        const headers = {
            "Content-Type": "application/json",
            "Authorization": evmAuthToken
        };

        const data = {
            functionSignature,
            args,
            contractAddress,
            chainId,
            smartWallet,
            queueId
        }
        logger.info(`Initiating transaction with data: ${JSON.stringify(data)}`);

        const response = await fetch(`${evmURL}/transaction/smartWalletSend`, { method: "POST", headers, body: JSON.stringify(data) });
        const responseText = await response.text();
        if (!response.ok) {
            throw new Error(`Transaction write failed: ${responseText}`);
        }
        const parsed = JSON.parse(responseText);
        return {
            isSuccess: parsed?.success,
            transaction: parsed?.transaction
        };
    } catch (err) {
        logger.error(`Error in sendEVMCall: ${err.message}`);
        return { isSuccess: false, error: err.message };
    }
}
