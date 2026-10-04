// Fixed facts about the live Work2own deployment on Robinhood Chain mainnet (chain 4663).
// The contract addresses are compiled in and checked against the API at start, so a changed or spoofed API
// can never make the agent approve or send USDG to another contract.

import type { Address } from "viem";

export const CHAIN_ID = 4663;
export const ESCROW: Address = "0xB20703EB380d40601fC57b05a1965e6131Df422b";
export const USDG: Address = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
export const USDG_PAYOUT: Address = "0x0000000000000000000000000000000000000000";
export const USDG_DECIMALS = 6;
export const STOCK_DECIMALS = 18;
export const BPS = 10_000n;
export const REVIEW_WINDOW = 7 * 24 * 3600;
export const SLOT_RESERVATION = 24 * 3600;

export const APP_URL = (process.env.W2O_APP_URL ?? "https://app.getwork2own.com").replace(/\/$/, "");
export const API_URL = `${APP_URL}/api`;
export const RPC_URL = process.env.W2O_RPC_URL ?? `${APP_URL}/rpc`;
