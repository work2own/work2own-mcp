// Work2own client used by the MCP tools: the public API, sign-in, and contract calls signed by the agent's own key.
// The private key stays in this process. Work2own only ever receives signatures and signed transactions.

import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  erc20Abi,
  getAddress,
  http,
  parseEventLogs,
  RawContractError,
  type Address,
  type Hex,
  type TransactionReceipt,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { robinhood } from "viem/chains";
import { createSiweMessage } from "viem/siwe";
import { escrowAbi } from "./abi.js";
import { API_URL, CHAIN_ID, ESCROW, RPC_URL, USDG } from "./config.js";

const USER_AGENT = "work2own-mcp/0.1.0";

export class W2oError extends Error {}

const FRIENDLY: Record<string, string> = {
  EmployerCannotClaim: "the employer cannot take their own quest",
  NoSlotsAvailable: "all slots are taken right now",
  InvalidClaimStatus: "the slot is not in the right state for that action",
  ReservationExpired: "the 24-hour reservation has ended",
  CampaignEnded: "the quest has ended",
  CampaignIsClosed: "the quest is closed",
  CampaignNotEnded: "the quest has not ended yet",
  PayoutTokenNotEnabled: "that token is not available for payouts",
  ReviewWindowOpen: "the 7-day review window is still open",
  ReviewWindowClosed: "the 7-day review window has closed",
  FallbackDelayActive: "the payout token can be switched 3 days after the payout was created",
  DepositAboveMax: "the amount is above the maximum deposit",
  InvalidDeadline: "the deadline must be in the future",
  EnforcedPause: "Work2own is paused for maintenance, try again later",
  GigDeadlinePassed: "the gig deadline has passed",
  GigDeadlineNotPassed: "the gig deadline has not passed yet",
  NotEmployer: "only the employer can do this",
  NotWorker: "only the worker can do this",
  NotAuthorized: "this wallet is not allowed to do this",
  ReviewsPending: "some submissions still wait for review",
  NoPendingRefund: "there is no refund to withdraw",
  WrongReviewMode: "this quest is not reviewed that way",
  ZeroAmount: "the amount must be above zero",
};

/** Short, readable reason for a failed call or transaction. */
export function errorText(error: unknown): string {
  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    let name = reverted instanceof ContractFunctionRevertedError ? (reverted.data?.errorName ?? null) : null;
    if (!name) {
      const raw = error.walk((e) => e instanceof RawContractError);
      if (raw instanceof RawContractError) {
        const data = typeof raw.data === "string" ? raw.data : raw.data?.data;
        if (data && data !== "0x") {
          try {
            name = decodeErrorResult({ abi: escrowAbi, data }).errorName;
          } catch {
            // not an escrow error
          }
        }
      }
    }
    if (name) return FRIENDLY[name] ?? `the contract refused: ${name}`;
    return error.shortMessage;
  }
  return error instanceof Error ? error.message : String(error);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Work2own {
  readonly account: PrivateKeyAccount | null;
  readonly publicClient = createPublicClient({ chain: robinhood, transport: http(RPC_URL, { retryCount: 2, timeout: 30_000 }) });
  private readonly walletClient;
  private session: { token: string; expiresAt: number } | null = null;
  private checked = false;

  constructor(privateKey: string | undefined) {
    if (privateKey !== undefined && privateKey.trim() !== "") {
      const key = privateKey.trim();
      if (!/^0x[0-9a-fA-F]{64}$/.test(key)) throw new W2oError("W2O_PRIVATE_KEY must be 0x followed by 64 hex characters");
      this.account = privateKeyToAccount(key as Hex);
      this.walletClient = createWalletClient({ account: this.account, chain: robinhood, transport: http(RPC_URL, { timeout: 60_000 }) });
    } else {
      this.account = null;
      this.walletClient = null;
    }
  }

  get address(): Address | null {
    return this.account ? this.account.address : null;
  }

  requireAccount(): PrivateKeyAccount {
    if (!this.account) throw new W2oError("this tool needs a wallet: start the server with W2O_PRIVATE_KEY set to the agent's own key");
    return this.account;
  }

  // ---- API ------------------------------------------------------------------------------------------

  async api<T>(path: string, options: { method?: "GET" | "POST"; body?: unknown; auth?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { "user-agent": USER_AGENT, accept: "application/json" };
    if (options.body !== undefined) headers["content-type"] = "application/json";
    if (options.auth) headers.authorization = `Bearer ${await this.sessionToken()}`;
    const response = await fetch(API_URL + path, {
      method: options.method ?? "GET",
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(30_000),
    });
    const type = response.headers.get("content-type") ?? "";
    if (!type.startsWith("application/json")) throw new W2oError(`the Work2own API is not reachable (${response.status})`);
    const data = (await response.json()) as { error?: string };
    if (!response.ok) throw new W2oError(data.error ?? `request failed (${response.status})`);
    return data as T;
  }

  /** Retries an API call while the indexer catches up with a transaction that was just mined. */
  async apiAfterIndexing<T>(path: string, options: { method?: "GET" | "POST"; body?: unknown; auth?: boolean }, waitFor: RegExp): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.api<T>(path, options);
      } catch (e) {
        if (!(e instanceof W2oError) || !waitFor.test(e.message) || attempt >= 30) throw e;
        await sleep(2000);
      }
    }
  }

  private async sessionToken(): Promise<string> {
    const account = this.requireAccount();
    if (this.session && this.session.expiresAt * 1000 > Date.now() + 60_000) return this.session.token;
    const { nonce, domain, chainId } = await this.api<{ nonce: string; domain: string; chainId: number }>("/auth/nonce", {
      method: "POST",
      body: {},
    });
    if (chainId !== CHAIN_ID) throw new W2oError(`the API is for chain ${chainId}, expected ${CHAIN_ID}`);
    const message = createSiweMessage({
      address: account.address,
      chainId: CHAIN_ID,
      domain,
      nonce,
      uri: `https://${domain}`,
      version: "1",
      statement: "Sign in to Work2own. This signature costs nothing and does not move funds.",
      issuedAt: new Date(),
    });
    const signature = await account.signMessage({ message });
    const result = await this.api<{ token: string; expiresAt: number }>("/auth/verify", { method: "POST", body: { message, signature } });
    this.session = { token: result.token, expiresAt: result.expiresAt };
    return result.token;
  }

  /** Confirms once that the API describes the same deployment as the addresses compiled into this server. */
  async checkDeployment(): Promise<void> {
    if (this.checked) return;
    const config = await this.api<{ chainId: number; escrow: string; usdg: string; paused: boolean }>("/config");
    if (config.chainId !== CHAIN_ID) throw new W2oError(`the API reports chain ${config.chainId}, expected ${CHAIN_ID}`);
    if (getAddress(config.escrow) !== getAddress(ESCROW) || getAddress(config.usdg) !== getAddress(USDG)) {
      throw new W2oError("the API reports other contract addresses than the ones built into work2own-mcp; refusing to continue");
    }
    const chainId = await this.publicClient.getChainId();
    if (chainId !== CHAIN_ID) throw new W2oError(`the RPC is for chain ${chainId}, expected ${CHAIN_ID}`);
    this.checked = true;
  }

  // ---- Contract calls ---------------------------------------------------------------------------------

  /** Simulates (so a revert shows its reason without spending gas), sends, and waits for the receipt. */
  async escrowWrite(functionName: string, args: readonly unknown[]): Promise<TransactionReceipt> {
    const account = this.requireAccount();
    await this.checkDeployment();
    try {
      const { request } = await this.publicClient.simulateContract({
        account,
        address: ESCROW,
        abi: escrowAbi,
        functionName: functionName as never,
        args: args as never,
      });
      const hash = await this.walletClient!.writeContract(request as never);
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") throw new W2oError(`transaction reverted: ${hash}`);
      return receipt;
    } catch (e) {
      if (e instanceof W2oError) throw e;
      throw new W2oError(errorText(e));
    }
  }

  async usdgBalance(owner: Address): Promise<bigint> {
    return this.publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
  }

  /** Makes sure the escrow may pull `amount` USDG from the agent's wallet; approves exactly that amount if needed. */
  async ensureUsdgAllowance(amount: bigint): Promise<Hex | null> {
    const account = this.requireAccount();
    await this.checkDeployment();
    const [allowance, balance] = await Promise.all([
      this.publicClient.readContract({ address: USDG, abi: erc20Abi, functionName: "allowance", args: [account.address, ESCROW] }),
      this.usdgBalance(account.address),
    ]);
    if (balance < amount) throw new W2oError(`not enough USDG: the wallet holds ${balance} base units, ${amount} are needed`);
    if (allowance >= amount) return null;
    try {
      const { request } = await this.publicClient.simulateContract({
        account,
        address: USDG,
        abi: erc20Abi,
        functionName: "approve",
        args: [ESCROW, amount],
      });
      const hash = await this.walletClient!.writeContract(request);
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 120_000 });
      if (receipt.status !== "success") throw new W2oError(`USDG approval reverted: ${hash}`);
      return hash;
    } catch (e) {
      if (e instanceof W2oError) throw e;
      throw new W2oError(errorText(e));
    }
  }

  /** Id of the quest created in this receipt, or null. */
  createdCampaignId(receipt: TransactionReceipt): number | null {
    const e = parseEventLogs({ abi: escrowAbi, logs: receipt.logs, eventName: "CampaignCreated" })[0];
    return e ? Number(e.args.campaignId) : null;
  }

  /** Id of the gig created in this receipt, or null. */
  createdGigId(receipt: TransactionReceipt): number | null {
    const e = parseEventLogs({ abi: escrowAbi, logs: receipt.logs, eventName: "GigCreated" })[0];
    return e ? Number(e.args.gigId) : null;
  }
}
