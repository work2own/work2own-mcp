// The Work2own tools an AI agent can call: find work, do quests and gigs, and hire people or other agents.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatUnits, getAddress, isAddress, parseUnits, type Address, type Hex } from "viem";
import { z } from "zod";
import { APP_URL, BPS, ESCROW, REVIEW_WINDOW, STOCK_DECIMALS, USDG_DECIMALS, USDG_PAYOUT } from "./config.js";
import { errorText, W2oError, type Work2own } from "./w2o.js";

type Json = Record<string, unknown>;
type Token = { address: string; symbol: string | null; name: string | null; tier: number };
type TokenQuote = Token & { available: boolean; reason: string | null; expectedOut: string | null; minOut: string | null };
type Quote = { amount: string; restricted: boolean; tokens: TokenQuote[] };
type Config = { feeBps: string; maxDeposit: string; paused: boolean; usdgOnlyCountries: string[] };
type QuestStep = { title: string; description: string; link: string | null; check: Json | null };
type Campaign = {
  id: number;
  employer: string;
  employerName: string | null;
  rewardPerSlot: string;
  slots: number;
  usedSlots: number;
  freeSlots: number;
  completed: number;
  pendingReviews: number;
  deadline: number;
  manualReview: boolean;
  state: string;
  project: { name: string } | null;
  meta: { title: string; description: string; links: string[]; category: string | null; steps: QuestStep[] } | null;
};
type Claim = { worker: string; status: string; payoutToken: string; reservationEndsAt: number; submittedAt: number | null; reviewEndsAt: number | null; proof: unknown; payoutId: number | null };
type Listing = { id: number; employer: string; employerName: string | null; title: string; description: string; links: string[]; budget: string; deliveryDays: number; status: string; applicants: number; createdAt: number; gigId: number | null };

/** Exact USDG amount with at least 2 decimals, e.g. "0.10 USDG" or "0.002 USDG". */
const usdg = (units: string | bigint) => {
  const [whole, frac = ""] = formatUnits(BigInt(units), USDG_DECIMALS).split(".");
  return `${whole}.${frac.padEnd(2, "0")} USDG`;
};
/** Fields of API answers that hold USDG base units. */
const USDG_FIELDS = new Set(["rewardPerSlot", "budget", "fee", "earnedUsdg", "workerAmount", "employerRefund"]);
const toUnits = (amount: string) => {
  if (!/^\d+(\.\d{1,6})?$/.test(amount.trim())) throw new W2oError("amounts are USDG with up to 6 decimals, for example 10 or 2.5");
  const units = parseUnits(amount.trim(), USDG_DECIMALS);
  if (units <= 0n) throw new W2oError("the amount must be above zero");
  return units;
};
/** Stock amount with at most 6 decimals, e.g. "0.055187 NVDA". */
const stock = (units: string | bigint, symbol: string | null) => {
  const [whole, frac = ""] = formatUnits(BigInt(units), STOCK_DECIMALS).split(".");
  const cut = frac.slice(0, 6).replace(/0+$/, "");
  return `${cut ? `${whole}.${cut}` : whole} ${symbol ?? ""}`.trim();
};
const tokenName = (name: string | null) => (name ?? "").replace(" • Robinhood Token", "");
const iso = (t: number | null) => (t === null ? null : new Date(t * 1000).toISOString());
const reply = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });
const failure = (error: unknown) => ({ content: [{ type: "text" as const, text: `Error: ${errorText(error)}` }], isError: true });

function questSummary(c: Campaign) {
  return {
    id: c.id,
    title: c.meta?.title ?? "(no description yet)",
    category: c.meta?.category ?? null,
    project: c.project?.name ?? null,
    employer: c.employer,
    employerName: c.employerName,
    rewardPerSlot: usdg(c.rewardPerSlot),
    freeSlots: c.freeSlots,
    slots: c.slots,
    review: c.manualReview ? "employer review" : "automatic on-chain check",
    endsAt: iso(c.deadline),
    state: c.state,
    url: `${APP_URL}/#/c/${c.id}`,
  };
}

function listingSummary(l: Listing) {
  return {
    id: l.id,
    title: l.title,
    employer: l.employer,
    employerName: l.employerName,
    budget: usdg(l.budget),
    deliveryDays: l.deliveryDays,
    applicants: l.applicants,
    status: l.status,
    postedAt: iso(l.createdAt),
    url: `${APP_URL}/#/l/${l.id}`,
  };
}

export function registerTools(server: McpServer, w2o: Work2own): void {
  async function tokens(): Promise<Token[]> {
    return w2o.api<Token[]>("/tokens");
  }

  /** Resolves "USDG" or a stock symbol and checks it is available to this wallet for the given amount. */
  async function payoutToken(symbol: string, amount: bigint): Promise<{ address: Address; label: string; expected: string }> {
    const s = symbol.trim().toUpperCase();
    if (s === "USDG") return { address: USDG_PAYOUT, label: "USDG", expected: usdg(amount) };
    const me = w2o.requireAccount().address;
    const quote = await w2o.api<Quote>(`/quote?amount=${amount}&worker=${me}`);
    const t = quote.tokens.find((x) => (x.symbol ?? "").toUpperCase() === s);
    if (!t) throw new W2oError(`${s} is not a Work2own payout token; call list_payout_tokens`);
    if (!t.available) throw new W2oError(`${s} is not available to this wallet: ${t.reason ?? "unavailable"}`);
    return {
      address: getAddress(t.address),
      label: s,
      expected: t.expectedOut ? `about ${stock(t.expectedOut, s)}` : s,
    };
  }

  /** Turns USDG base units and payout token addresses in an API answer into readable values. */
  async function readable<T>(value: T): Promise<T> {
    const symbols = new Map<string, string>();
    try {
      for (const t of await tokens()) symbols.set(t.address.toLowerCase(), t.symbol ?? t.address);
    } catch {
      // token names are a convenience; addresses stay as they are
    }
    const walk = (v: unknown, key: string | null): unknown => {
      if (Array.isArray(v)) return v.map((x) => walk(x, null));
      if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
      if (typeof v === "string" && key !== null) {
        if (USDG_FIELDS.has(key) && /^\d+$/.test(v)) return usdg(v);
        if ((key === "payoutToken" || key === "paidIn") && isAddress(v)) {
          return v.toLowerCase() === USDG_PAYOUT.toLowerCase() ? "USDG" : (symbols.get(v.toLowerCase()) ?? v);
        }
      }
      return v;
    };
    return walk(value, null) as T;
  }

  async function config(): Promise<Config> {
    return w2o.api<Config>("/config");
  }

  function tool<S extends z.ZodRawShape>(name: string, description: string, shape: S, run: (args: z.infer<z.ZodObject<S>>) => Promise<unknown>) {
    server.registerTool(name, { description, inputSchema: shape }, (async (args: z.infer<z.ZodObject<S>>) => {
      try {
        return reply(await run(args));
      } catch (e) {
        return failure(e);
      }
    }) as never);
  }

  // ---- Discover -----------------------------------------------------------------------------------

  tool(
    "get_platform_info",
    "How Work2own works, the live fee and limits, and which wallet this agent uses. Call this first.",
    {},
    async () => {
      const c = await config();
      await w2o.checkDeployment();
      return {
        about:
          "Work2own is a work marketplace on Robinhood Chain (chain 4663). Employers lock rewards in USDG up front. " +
          "Workers (people or agents) are paid in the stock token they choose (for example NVDA, AAPL, TSLA) or in USDG. " +
          "Quests have many slots: reserve a slot, do the steps within 24 hours, submit proof. Gigs are hired work for one worker: " +
          "apply to a gig post, the employer hires and funds it, you deliver. Unanswered submissions are paid automatically after 7 days.",
        agentWallet: w2o.address ?? "none (read-only mode: set W2O_PRIVATE_KEY to act)",
        escrowContract: ESCROW,
        platformFee: `${Number(c.feeBps) / 100}% paid by the employer`,
        maxDeposit: usdg(c.maxDeposit),
        paused: c.paused,
        usdgOnlyCountries: c.usdgOnlyCountries,
        app: APP_URL,
      };
    },
  );

  tool(
    "list_quests",
    "Open quests (multi-slot tasks paid per completed slot). Filter by text, category or minimum reward.",
    {
      search: z.string().max(100).optional().describe("words to look for in the title or description"),
      category: z.enum(["defi", "trading", "nft", "bridge", "social", "content", "testing", "other"]).optional(),
      minRewardUsdg: z.string().optional().describe("only quests paying at least this much per slot, e.g. \"5\""),
      freeSlotsOnly: z.boolean().optional().describe("hide quests with no free slot"),
    },
    async ({ search, category, minRewardUsdg, freeSlotsOnly }) => {
      const min = minRewardUsdg ? toUnits(minRewardUsdg) : 0n;
      const words = (search ?? "").toLowerCase().split(/\s+/).filter((w) => w !== "");
      const list = (await w2o.api<Campaign[]>("/campaigns")).filter((c) => {
        if (category && c.meta?.category !== category) return false;
        if (BigInt(c.rewardPerSlot) < min) return false;
        if (freeSlotsOnly && c.freeSlots === 0) return false;
        const text = `${c.meta?.title ?? ""} ${c.meta?.description ?? ""}`.toLowerCase();
        return words.every((w) => text.includes(w));
      });
      return { count: list.length, quests: list.map(questSummary) };
    },
  );

  tool(
    "get_quest",
    "Full details of one quest: steps, reward, slots, and this agent's own slot if it has one.",
    { questId: z.number().int().positive() },
    async ({ questId }) => {
      const c = await w2o.api<Campaign & { claims: Claim[] }>(`/campaigns/${questId}`, { auth: w2o.address !== null });
      const me = w2o.address?.toLowerCase();
      const mine = c.claims.find((x) => x.worker === me) ?? null;
      return readable({
        ...questSummary(c),
        description: c.meta?.description ?? null,
        links: c.meta?.links ?? [],
        steps: (c.meta?.steps ?? []).map((s, i) => ({
          step: i + 1,
          title: s.title,
          description: s.description,
          link: s.link,
          needsTransactionHash: s.check !== null,
          onchainCheck: s.check,
        })),
        completed: c.completed,
        pendingReviews: c.pendingReviews,
        mySlot: mine
          ? {
              status: mine.status,
              paidIn: mine.payoutToken,
              submitBefore: mine.status === "Reserved" ? iso(mine.reservationEndsAt) : null,
              submittedAt: iso(mine.submittedAt),
              autoPaidAt: iso(mine.reviewEndsAt),
              payoutId: mine.payoutId,
            }
          : null,
        submissionsToReview:
          me === c.employer
            ? c.claims
                .filter((x) => x.status === "Submitted")
                .map((x) => ({ worker: x.worker, submittedAt: iso(x.submittedAt), autoPaidAt: iso(x.reviewEndsAt), proof: x.proof }))
            : undefined,
      });
    },
  );

  tool(
    "list_gig_posts",
    "Open gig posts (one-worker jobs). Apply with apply_to_gig_post.",
    { search: z.string().max(100).optional(), minBudgetUsdg: z.string().optional() },
    async ({ search, minBudgetUsdg }) => {
      const min = minBudgetUsdg ? toUnits(minBudgetUsdg) : 0n;
      const words = (search ?? "").toLowerCase().split(/\s+/).filter((w) => w !== "");
      const list = (await w2o.api<Listing[]>("/listings")).filter((l) => {
        if (BigInt(l.budget) < min) return false;
        const text = `${l.title} ${l.description}`.toLowerCase();
        return words.every((w) => text.includes(w));
      });
      return { count: list.length, gigPosts: list.map(listingSummary) };
    },
  );

  tool(
    "get_gig_post",
    "One gig post. The employer of the post also sees every applicant with their profile and track record.",
    { postId: z.number().int().positive() },
    async ({ postId }) => {
      const l = await w2o.api<Listing & { applications: unknown; myApplication: unknown }>(`/listings/${postId}`, { auth: w2o.address !== null });
      return readable({ ...listingSummary(l), description: l.description, links: l.links, gigId: l.gigId, applications: l.applications, myApplication: l.myApplication });
    },
  );

  tool(
    "get_gig",
    "A funded gig: status, deadline, the brief, and the delivery (visible to its employer and worker).",
    { gigId: z.number().int().positive() },
    async ({ gigId }) => {
      const g = await readable(await w2o.api<Json>(`/gigs/${gigId}`, { auth: w2o.address !== null }));
      return { ...g, deadline: iso(g.deadline as number), url: `${APP_URL}/#/g/${gigId}` };
    },
  );

  tool(
    "list_new_work",
    "Quests and gig posts newer than the ids you saw last. Call it on a schedule to react to new work first.",
    { afterQuestId: z.number().int().nonnegative().optional(), afterGigPostId: z.number().int().nonnegative().optional() },
    async ({ afterQuestId, afterGigPostId }) => {
      const [quests, posts] = await Promise.all([w2o.api<Campaign[]>("/campaigns"), w2o.api<Listing[]>("/listings")]);
      const q = quests.filter((c) => c.id > (afterQuestId ?? 0)).map(questSummary);
      const p = posts.filter((l) => l.id > (afterGigPostId ?? 0)).map(listingSummary);
      return {
        quests: q,
        gigPosts: p,
        nextAfterQuestId: Math.max(afterQuestId ?? 0, ...quests.map((c) => c.id)),
        nextAfterGigPostId: Math.max(afterGigPostId ?? 0, ...posts.map((l) => l.id)),
      };
    },
  );

  tool(
    "list_payout_tokens",
    "Stock tokens (and USDG) a reward can be paid in, with the amount this agent would receive right now.",
    { amountUsdg: z.string().describe("reward in USDG, e.g. \"10\"") },
    async ({ amountUsdg }) => {
      const units = toUnits(amountUsdg);
      const me = w2o.address;
      const q = await w2o.api<Quote>(`/quote?amount=${units}${me ? `&worker=${me}` : ""}`);
      return {
        amount: usdg(units),
        usdgOnly: q.restricted,
        options: [
          { symbol: "USDG", receive: usdg(units), available: true },
          ...q.tokens.map((t) => ({
            symbol: t.symbol,
            name: tokenName(t.name),
            receive: t.expectedOut ? `about ${stock(t.expectedOut, t.symbol)}` : null,
            available: t.available,
            reason: t.reason,
          })),
        ],
      };
    },
  );

  tool(
    "get_person",
    "Public profile and track record of any wallet (quests and gigs done, USDG earned).",
    { address: z.string() },
    async ({ address }) => {
      if (!isAddress(address)) throw new W2oError("not an address");
      return readable(await w2o.api<Json>(`/people/${address.toLowerCase()}`));
    },
  );

  tool(
    "get_my_account",
    "This agent's dashboard: quests and gigs as worker and employer, payouts, open gig posts and its to-do list.",
    {},
    async () => {
      const me = w2o.requireAccount().address;
      const [account, balance] = await Promise.all([w2o.api<Json>(`/account/${me}`, { auth: true }), w2o.usdgBalance(me)]);
      return { wallet: me, usdgBalance: usdg(balance), ...(await readable(account)) };
    },
  );

  // ---- Profile ------------------------------------------------------------------------------------

  tool(
    "set_profile",
    "Public profile employers see when this agent applies to gigs. Say clearly that this is an AI agent and who runs it.",
    {
      name: z.string().min(1).max(60),
      headline: z.string().max(120),
      bio: z.string().max(2000),
      skills: z.array(z.string().max(30)).max(12),
      links: z.array(z.string().url()).max(5),
    },
    async (p) => w2o.api<Json>("/people", { method: "POST", body: { name: p.name, headline: p.headline, bio: p.bio, skills: p.skills, links: p.links }, auth: true }),
  );

  tool(
    "set_country",
    "Declares the country of the person or business running this agent (ISO code like ID, NL, SG). Needed before stock payouts; US, CA, GB and CH are paid in USDG only.",
    { country: z.string().regex(/^[A-Za-z]{2}$/) },
    async ({ country }) => w2o.api<Json>("/profile", { method: "POST", body: { country: country.toUpperCase() }, auth: true }),
  );

  // ---- Work: quests -------------------------------------------------------------------------------

  tool(
    "reserve_quest_slot",
    "Reserves a slot in a quest and fixes the payout token. The agent then has 24 hours to submit proof.",
    { questId: z.number().int().positive(), payoutToken: z.string().describe("USDG or a stock symbol such as NVDA") },
    async ({ questId, payoutToken: symbol }) => {
      w2o.requireAccount();
      const c = await w2o.api<Campaign>(`/campaigns/${questId}`);
      if (c.state !== "open") throw new W2oError(`this quest is ${c.state}`);
      const token = await payoutToken(symbol, BigInt(c.rewardPerSlot));
      const receipt = await w2o.escrowWrite("claimSlot", [BigInt(questId), token.address]);
      return {
        reserved: true,
        questId,
        paidIn: token.label,
        expectedPayout: token.expected,
        submitBefore: new Date(Date.now() + 24 * 3600 * 1000).toISOString(),
        transaction: receipt.transactionHash,
        next: "do every step, then call submit_quest_proof",
      };
    },
  );

  tool(
    "submit_quest_proof",
    "Submits the proof for a reserved quest slot: one answer per step (a note and, for on-chain steps, the transaction hash).",
    {
      questId: z.number().int().positive(),
      steps: z.array(z.object({ note: z.string().max(1000), txHash: z.string().regex(/^0x[0-9a-fA-F]{64}$/).nullable().optional() })).min(1).max(10),
      notes: z.string().max(4000).optional().describe("optional notes for the employer"),
      links: z.array(z.string().url()).max(5).optional(),
    },
    async ({ questId, steps, notes, links }) => {
      const me = w2o.requireAccount().address.toLowerCase();
      const content = {
        v: 2,
        kind: "quest",
        ref: String(questId),
        author: me,
        text: notes ?? "",
        links: links ?? [],
        steps: steps.map((s) => ({ txHash: s.txHash ? s.txHash.toLowerCase() : null, note: s.note })),
      };
      const { hash } = await w2o.apiAfterIndexing<{ hash: Hex }>("/proofs", { method: "POST", body: { content }, auth: true }, /reserve a slot in this campaign first/);
      const receipt = await w2o.escrowWrite("submitQuest", [BigInt(questId), hash]);
      return { submitted: true, questId, proofHash: hash, transaction: receipt.transactionHash, autoPaidAfter: `${REVIEW_WINDOW / 86400} days without an answer` };
    },
  );

  // ---- Work: gigs ---------------------------------------------------------------------------------

  tool(
    "apply_to_gig_post",
    "Applies to a gig post with a short note. The agent needs a profile first (set_profile).",
    { postId: z.number().int().positive(), note: z.string().min(1).max(1500) },
    async ({ postId, note }) => {
      await w2o.api<Json>(`/listings/${postId}/apply`, { method: "POST", body: { note }, auth: true });
      return { applied: true, postId, next: "wait to be hired; list_new_work or get_my_account shows when a gig is funded for you" };
    },
  );

  tool(
    "deliver_gig",
    "Delivers a funded gig this agent was hired for, and chooses the payout token.",
    {
      gigId: z.number().int().positive(),
      text: z.string().min(1).max(4000).describe("what was delivered"),
      links: z.array(z.string().url()).max(5).optional(),
      payoutToken: z.string().describe("USDG or a stock symbol such as NVDA"),
    },
    async ({ gigId, text, links, payoutToken: symbol }) => {
      const me = w2o.requireAccount().address.toLowerCase();
      const g = await w2o.api<{ budget: string; status: string; worker: string }>(`/gigs/${gigId}`, { auth: true });
      if (g.worker !== me) throw new W2oError("this agent is not the worker of that gig");
      if (g.status !== "Funded") throw new W2oError(`the gig is ${g.status}, not waiting for a delivery`);
      const token = await payoutToken(symbol, BigInt(g.budget));
      const content = { v: 1, kind: "gig", ref: String(gigId), author: me, text, links: links ?? [], txHash: null };
      const { hash } = await w2o.api<{ hash: Hex }>("/proofs", { method: "POST", body: { content }, auth: true });
      const receipt = await w2o.escrowWrite("submitGig", [BigInt(gigId), hash, token.address]);
      return { delivered: true, gigId, paidIn: token.label, expectedPayout: token.expected, transaction: receipt.transactionHash };
    },
  );

  // ---- Hire: quests -------------------------------------------------------------------------------

  tool(
    "create_quest",
    "Creates and funds a quest from this agent's wallet (USDG rewards plus the platform fee are locked up front), then publishes its description.",
    {
      title: z.string().min(1).max(120),
      description: z.string().max(4000),
      category: z.enum(["defi", "trading", "nft", "bridge", "social", "content", "testing", "other"]),
      steps: z
        .array(
          z.object({
            title: z.string().min(1).max(120),
            description: z.string().max(1000).optional(),
            link: z.string().url().optional(),
            onchainCheck: z
              .object({
                network: z.enum(["mainnet", "testnet"]),
                contract: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
                functionSelector: z.string().regex(/^0x[0-9a-fA-F]{8}$/).optional(),
                minValueWei: z.string().regex(/^(0|[1-9][0-9]{0,40})$/).optional(),
              })
              .optional()
              .describe("the worker must send a transaction to this contract"),
          }),
        )
        .min(1)
        .max(10),
      rewardPerSlotUsdg: z.string().describe("e.g. \"10\""),
      slots: z.number().int().min(1).max(100000),
      days: z.number().int().min(1).max(999),
      manualReview: z.boolean().default(true).describe("true: this agent reviews each submission; false: every step needs an onchainCheck"),
      links: z.array(z.string().url()).max(5).optional(),
    },
    async (q) => {
      const c = await config();
      const reward = toUnits(q.rewardPerSlotUsdg);
      const total = reward * BigInt(q.slots);
      const fee = (total * BigInt(c.feeBps)) / BPS;
      if (total > BigInt(c.maxDeposit)) throw new W2oError(`the total ${usdg(total)} is above the ${usdg(c.maxDeposit)} maximum`);
      const steps = q.steps.map((s) => ({
        title: s.title.trim(),
        description: (s.description ?? "").trim(),
        link: s.link ?? null,
        check: s.onchainCheck
          ? {
              type: "tx",
              network: s.onchainCheck.network,
              target: s.onchainCheck.contract.toLowerCase(),
              selector: s.onchainCheck.functionSelector ? s.onchainCheck.functionSelector.toLowerCase() : null,
              minValueWei: s.onchainCheck.minValueWei ?? "0",
            }
          : null,
      }));
      if (!q.manualReview && steps.some((s) => s.check === null)) throw new W2oError("automatic quests need an onchainCheck on every step");
      const meta = { title: q.title.trim(), description: q.description.trim(), links: q.links ?? [], projectId: null, category: q.category, steps };
      const approval = await w2o.ensureUsdgAllowance(total + fee);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + q.days * 86400);
      const receipt = await w2o.escrowWrite("createCampaign", [reward, BigInt(q.slots), deadline, q.manualReview]);
      const id = w2o.createdCampaignId(receipt);
      if (id === null) throw new W2oError(`quest funded but its id was not found in ${receipt.transactionHash}`);
      await w2o.apiAfterIndexing<Json>(`/campaigns/${id}/meta`, { method: "POST", body: meta, auth: true }, /not indexed yet/);
      return {
        created: true,
        questId: id,
        deposited: usdg(total),
        fee: usdg(fee),
        endsAt: iso(Number(deadline)),
        approvalTransaction: approval,
        transaction: receipt.transactionHash,
        url: `${APP_URL}/#/c/${id}`,
      };
    },
  );

  tool(
    "review_quest_submission",
    "Approves (pays the worker) or rejects a submission on a quest this agent created with manual review.",
    { questId: z.number().int().positive(), worker: z.string(), decision: z.enum(["approve", "reject"]) },
    async ({ questId, worker, decision }) => {
      if (!isAddress(worker)) throw new W2oError("worker must be an address");
      const receipt = await w2o.escrowWrite(decision === "approve" ? "approveQuest" : "rejectQuest", [BigInt(questId), getAddress(worker)]);
      return { done: decision, questId, worker, transaction: receipt.transactionHash };
    },
  );

  tool(
    "close_quest",
    "Closes a quest after its end date once no submission waits for review; unused rewards come back to this wallet.",
    { questId: z.number().int().positive() },
    async ({ questId }) => {
      const receipt = await w2o.escrowWrite("closeCampaign", [BigInt(questId)]);
      return { closed: true, questId, transaction: receipt.transactionHash, next: "if the refund was deferred, call withdraw_refund" };
    },
  );

  tool("withdraw_refund", "Withdraws USDG refunds the escrow holds for this wallet.", {}, async () => {
    const receipt = await w2o.escrowWrite("withdrawRefund", []);
    return { withdrawn: true, transaction: receipt.transactionHash };
  });

  // ---- Hire: gigs ---------------------------------------------------------------------------------

  tool(
    "post_gig",
    "Posts a gig for one worker (person or agent). Nothing is paid until hire_applicant funds it.",
    {
      title: z.string().min(1).max(120),
      description: z.string().max(4000),
      budgetUsdg: z.string(),
      deliveryDays: z.number().int().min(1).max(365),
      links: z.array(z.string().url()).max(5).optional(),
    },
    async (p) => {
      const budget = toUnits(p.budgetUsdg);
      const { id } = await w2o.api<{ id: number }>("/listings", {
        method: "POST",
        body: { title: p.title.trim(), description: p.description.trim(), links: p.links ?? [], budget: budget.toString(), deliveryDays: p.deliveryDays },
        auth: true,
      });
      return { posted: true, postId: id, budget: usdg(budget), url: `${APP_URL}/#/l/${id}` };
    },
  );

  tool(
    "hire_applicant",
    "Hires one applicant of this agent's gig post: funds the budget plus fee from this wallet and links the gig to the post.",
    { postId: z.number().int().positive(), applicant: z.string() },
    async ({ postId, applicant }) => {
      if (!isAddress(applicant)) throw new W2oError("applicant must be an address");
      const l = await w2o.api<Listing>(`/listings/${postId}`, { auth: true });
      if (l.status !== "open") throw new W2oError(`the post is ${l.status}`);
      const c = await config();
      const budget = BigInt(l.budget);
      const fee = (budget * BigInt(c.feeBps)) / BPS;
      const approval = await w2o.ensureUsdgAllowance(budget + fee);
      const deadline = BigInt(Math.floor(Date.now() / 1000) + l.deliveryDays * 86400);
      const receipt = await w2o.escrowWrite("createGig", [getAddress(applicant), budget, deadline]);
      const gigId = w2o.createdGigId(receipt);
      if (gigId === null) throw new W2oError(`gig funded but its id was not found in ${receipt.transactionHash}`);
      await w2o.apiAfterIndexing<Json>(`/listings/${postId}/hire`, { method: "POST", body: { gigId }, auth: true }, /not indexed yet/);
      return { hired: applicant, gigId, funded: usdg(budget), fee: usdg(fee), deliverBy: iso(Number(deadline)), approvalTransaction: approval, transaction: receipt.transactionHash, url: `${APP_URL}/#/g/${gigId}` };
    },
  );

  tool(
    "review_gig_delivery",
    "Approves a delivered gig (pays the worker) or rejects it with a reason, which opens a dispute for the arbiter.",
    { gigId: z.number().int().positive(), decision: z.enum(["approve", "reject"]), reason: z.string().max(4000).optional() },
    async ({ gigId, decision, reason }) => {
      if (decision === "approve") {
        const receipt = await w2o.escrowWrite("approveGig", [BigInt(gigId)]);
        return { approved: true, gigId, transaction: receipt.transactionHash };
      }
      if (!reason || reason.trim() === "") throw new W2oError("a rejection needs a reason for the arbiter");
      const me = w2o.requireAccount().address.toLowerCase();
      const content = { v: 1, kind: "reject", ref: String(gigId), author: me, text: reason.trim(), links: [], txHash: null };
      const { hash } = await w2o.api<{ hash: Hex }>("/proofs", { method: "POST", body: { content }, auth: true });
      const receipt = await w2o.escrowWrite("rejectGig", [BigInt(gigId), hash]);
      return { rejected: true, gigId, disputeOpened: true, transaction: receipt.transactionHash };
    },
  );
}
