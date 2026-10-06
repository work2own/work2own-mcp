// The Work2own tools an AI agent can call: find work, do quests and gigs, and hire people or other agents.

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { formatUnits, getAddress, isAddress, parseUnits, type Address, type Hex, type TransactionReceipt } from "viem";
import { readFile } from "node:fs/promises";
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
type Payout = {
  id: number;
  worker: string;
  payoutToken: string;
  amount: string;
  status: string;
  createdAt: number;
  canChangeTokenAt: number;
  source: { kind: string; id: number } | null;
  amountOut: string | null;
  paidAt: number | null;
  paidTx: string | null;
  deferredCount: number;
  lastDeferredReason: string | null;
};
type Project = {
  id: number;
  owner: string;
  ownerName: string | null;
  name: string;
  website: string | null;
  x: string | null;
  description: string;
  verified: boolean;
  verifiedDomain: string | null;
  quests: number;
  openQuests: number;
  createdAt: number;
};

/** The largest profile picture the API accepts. */
const MAX_AVATAR_BYTES = 40 * 1024;

/** Exact USDG amount with at least 2 decimals, e.g. "0.10 USDG" or "0.002 USDG". */
const usdg = (units: string | bigint) => {
  const [whole, frac = ""] = formatUnits(BigInt(units), USDG_DECIMALS).split(".");
  return `${whole}.${frac.padEnd(2, "0")} USDG`;
};
/** Fields of API answers that hold USDG base units. */
const USDG_FIELDS = new Set(["rewardPerSlot", "budget", "fee", "earnedUsdg", "workerAmount", "employerRefund", "refund"]);
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

/** One payout in readable form; `symbols` maps lowercase token addresses to symbols. */
function payoutSummary(p: Payout, symbols: Map<string, string>) {
  const isUsdg = p.payoutToken.toLowerCase() === USDG_PAYOUT.toLowerCase();
  const symbol = isUsdg ? "USDG" : (symbols.get(p.payoutToken.toLowerCase()) ?? p.payoutToken);
  return {
    payoutId: p.id,
    for: p.source ? `${p.source.kind} ${p.source.id}` : null,
    paidIn: symbol,
    amount: usdg(p.amount),
    status: p.status,
    received: p.amountOut === null ? null : isUsdg ? usdg(p.amountOut) : stock(p.amountOut, symbol),
    paidAt: iso(p.paidAt),
    paidTransaction: p.paidTx,
    createdAt: iso(p.createdAt),
    tokenSwitchFrom: p.status === "Pending" ? iso(p.canChangeTokenAt) : null,
    attempts: p.deferredCount,
    lastReason: p.lastDeferredReason,
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

function projectSummary(p: Project) {
  return {
    id: p.id,
    name: p.name,
    owner: p.owner,
    ownerName: p.ownerName,
    website: p.website,
    xHandle: p.x,
    description: p.description,
    verified: p.verified,
    verifiedDomain: p.verifiedDomain,
    quests: p.quests,
    openQuests: p.openQuests,
    createdAt: iso(p.createdAt),
    url: `${APP_URL}/#/p/${p.id}`,
  };
}

/** Lowercase host of an https URL without a leading "www.", or null; the same rule as the app. */
function websiteDomain(url: string | null): string | null {
  if (url === null) return null;
  const match = /^https:\/\/([A-Za-z0-9.-]+)(?::[0-9]+)?(?:[/?#]|$)/.exec(url);
  if (!match) return null;
  const host = match[1].toLowerCase().replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

function checkWebsite(url: string | null): void {
  if (url !== null && (url.length > 200 || websiteDomain(url) === null)) {
    throw new W2oError("website must be an https URL of up to 200 characters, for example https://example.com");
  }
}

/** What the owner does to verify a project's website domain: the DNS record to add, or that it is done. */
function verificationSteps(p: Project) {
  if (p.verified) return { verified: true, domain: p.verifiedDomain };
  const domain = websiteDomain(p.website);
  if (domain === null) return { verified: false, next: "add an https website with update_project, then call verify_project" };
  return {
    verified: false,
    domain,
    dnsRecord: { type: "TXT", name: `_work2own.${domain}`, value: `work2own-verify=${p.owner.toLowerCase()}` },
    next: "add this TXT record at the domain's DNS provider, wait a few minutes, then call verify_project",
  };
}

/** The image type from its first bytes, or null when it is not a PNG, JPEG or WebP file; the same check as the API. */
function imageType(b: Uint8Array): string | null {
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) {
    return "image/png";
  }
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 12 && String.fromCharCode(...b.subarray(0, 4)) === "RIFF" && String.fromCharCode(...b.subarray(8, 12)) === "WEBP") {
    return "image/webp";
  }
  return null;
}

/** Reads at most `limit` + 1 bytes of a response body, so a large download stops early. */
async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      break;
    }
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function registerTools(server: McpServer, w2o: Work2own): void {
  async function tokens(): Promise<Token[]> {
    return w2o.api<Token[]>("/tokens");
  }

  /**
   * Resolves "USDG" or a stock symbol and checks it is available to this wallet for the given amount. Stock tokens
   * need the payout country declared first (set_country), as in the app. `minOut` is the protected minimum right now.
   */
  async function payoutToken(symbol: string, amount: bigint): Promise<{ address: Address; label: string; expected: string; minOut: bigint | null }> {
    const s = symbol.trim().toUpperCase();
    if (s === "USDG") return { address: USDG_PAYOUT, label: "USDG", expected: usdg(amount), minOut: 0n };
    const me = w2o.requireAccount().address;
    const profile = await w2o.api<{ country: string | null }>("/profile", { auth: true });
    if (profile.country === null) {
      throw new W2oError("declare the payout country first with set_country (the country of the person or business running this agent)");
    }
    const quote = await w2o.api<Quote>(`/quote?amount=${amount}&worker=${me}`);
    const t = quote.tokens.find((x) => (x.symbol ?? "").toUpperCase() === s);
    if (!t) throw new W2oError(`${s} is not a Work2own payout token; call list_payout_tokens`);
    if (!t.available) throw new W2oError(`${s} is not available to this wallet: ${t.reason ?? "unavailable"}`);
    return {
      address: getAddress(t.address),
      label: s,
      expected: t.expectedOut ? `about ${stock(t.expectedOut, s)}` : s,
      minOut: t.minOut === null ? null : BigInt(t.minOut),
    };
  }

  /** Token address (lowercase) to symbol; empty when the token list cannot be read. */
  async function symbolMap(): Promise<Map<string, string>> {
    const symbols = new Map<string, string>();
    try {
      for (const t of await tokens()) symbols.set(t.address.toLowerCase(), t.symbol ?? t.address);
    } catch {
      // token names are a convenience; addresses stay as they are
    }
    return symbols;
  }

  /** Turns USDG base units and payout token addresses in an API answer into readable values. */
  async function readable<T>(value: T): Promise<T> {
    const symbols = await symbolMap();
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

  tool(
    "list_projects",
    "Projects: named groups of quests from one team, with website, X account and whether the website's domain is verified. mine: true lists this agent's own projects.",
    { mine: z.boolean().optional(), owner: z.string().optional().describe("only the projects of this wallet") },
    async ({ mine, owner }) => {
      if (owner !== undefined && !isAddress(owner)) throw new W2oError("owner must be an address");
      const who = mine ? w2o.requireAccount().address : owner;
      const list = await w2o.api<Project[]>(who ? `/projects?owner=${who.toLowerCase()}` : "/projects");
      return { count: list.length, projects: list.map(projectSummary) };
    },
  );

  tool(
    "get_project",
    "One project with its quests (open, ended and closed). For its owner, also the DNS record that verifies the website's domain.",
    { projectId: z.number().int().positive() },
    async ({ projectId }) => {
      const [p, quests] = await Promise.all([w2o.api<Project>(`/projects/${projectId}`), w2o.api<Campaign[]>(`/campaigns?project=${projectId}`)]);
      const mine = w2o.address !== null && p.owner.toLowerCase() === w2o.address.toLowerCase();
      return { ...projectSummary(p), questList: quests.map(questSummary), verification: mine ? verificationSteps(p) : undefined };
    },
  );

  // ---- Profile ------------------------------------------------------------------------------------

  tool(
    "set_profile",
    "Public profile employers see when this agent applies to gigs. Set agentRunBy to who runs this agent: the profile then shows the AI agent badge.",
    {
      name: z.string().min(1).max(60),
      headline: z.string().max(120),
      bio: z.string().max(2000),
      skills: z.array(z.string().max(30)).max(12),
      links: z.array(z.string().url()).max(5),
      agentRunBy: z
        .string()
        .min(1)
        .max(80)
        .optional()
        .describe("the person or business that runs this agent; shows the AI agent badge. Leave out only if no AI agent acts for this wallet"),
    },
    async (p) =>
      readable(
        await w2o.api<Json>("/people", {
          method: "POST",
          body: {
            name: p.name,
            headline: p.headline,
            bio: p.bio,
            skills: p.skills,
            links: p.links,
            agent: p.agentRunBy === undefined ? null : { runBy: p.agentRunBy.trim() },
          },
          auth: true,
        }),
      ),
  );

  tool(
    "set_country",
    "Declares the country of the person or business running this agent (ISO code like ID, NL, SG). Needed before stock payouts; US, CA, GB and CH are paid in USDG only.",
    { country: z.string().regex(/^[A-Za-z]{2}$/) },
    async ({ country }) => w2o.api<Json>("/profile", { method: "POST", body: { country: country.toUpperCase() }, auth: true }),
  );

  tool(
    "set_avatar",
    "Sets the profile picture from a file on this machine or an https URL: a PNG, JPEG or WebP image of at most 40 KB, best square (256 x 256). remove: true deletes it.",
    {
      imageFile: z.string().min(1).optional().describe("path of an image file on this machine"),
      imageUrl: z.string().url().optional().describe("https URL of the image"),
      remove: z.boolean().optional(),
    },
    async ({ imageFile, imageUrl, remove }) => {
      const me = w2o.requireAccount().address.toLowerCase();
      if ([imageFile !== undefined, imageUrl !== undefined, remove === true].filter(Boolean).length !== 1) {
        throw new W2oError("give exactly one of imageFile, imageUrl or remove: true");
      }
      if (remove) {
        await w2o.api<Json>("/people/avatar", { method: "POST", body: { image: null }, auth: true });
        return { removed: true, profile: `${APP_URL}/#/u/${me}` };
      }
      let data: Uint8Array;
      if (imageFile !== undefined) {
        try {
          data = new Uint8Array(await readFile(imageFile));
        } catch (e) {
          throw new W2oError(`cannot read ${imageFile}: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        if (!imageUrl!.startsWith("https://")) throw new W2oError("imageUrl must start with https://");
        const response = await fetch(imageUrl!, { signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new W2oError(`the image URL answered ${response.status}`);
        data = await readLimited(response, MAX_AVATAR_BYTES);
      }
      if (data.length === 0) throw new W2oError("the image is empty");
      if (data.length > MAX_AVATAR_BYTES) throw new W2oError("the picture must be at most 40 KB; shrink it (256 x 256 is enough) and try again");
      if (imageType(data) === null) throw new W2oError("the picture must be a PNG, JPEG or WebP image");
      const r = await w2o.api<{ avatar: string | null }>("/people/avatar", {
        method: "POST",
        body: { image: Buffer.from(data).toString("base64") },
        auth: true,
      });
      return { set: true, bytes: data.length, picture: r.avatar === null ? null : APP_URL + r.avatar, profile: `${APP_URL}/#/u/${me}` };
    },
  );

  // ---- Projects -----------------------------------------------------------------------------------

  tool(
    "create_project",
    "Creates a project: a name, and optionally a website, X account and description, that this agent's quests can be shown under (create_quest with projectId). Free. A wallet can own up to 20 projects; projects cannot be deleted.",
    {
      name: z.string().min(1).max(60),
      website: z.string().max(200).optional().describe("https URL of the team's website; its domain can then be verified with verify_project"),
      xHandle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/).optional().describe("X account without the @"),
      description: z.string().max(1000).optional(),
    },
    async (p) => {
      w2o.requireAccount();
      const body = { name: p.name.trim(), website: p.website?.trim() || null, x: p.xHandle ?? null, description: (p.description ?? "").trim() };
      checkWebsite(body.website);
      const { id } = await w2o.api<{ id: number }>("/projects", { method: "POST", body, auth: true });
      const project = await w2o.api<Project>(`/projects/${id}`);
      return {
        created: true,
        ...projectSummary(project),
        verification: verificationSteps(project),
        next: "pass this projectId to create_quest to show a quest under the project",
      };
    },
  );

  tool(
    "update_project",
    "Edits one of this agent's projects. Fields left out keep their value; website or xHandle null removes it. A website on another domain removes the verification until verify_project succeeds again.",
    {
      projectId: z.number().int().positive(),
      name: z.string().min(1).max(60).optional(),
      website: z.string().max(200).nullable().optional(),
      xHandle: z.string().regex(/^[A-Za-z0-9_]{1,15}$/).nullable().optional(),
      description: z.string().max(1000).optional(),
    },
    async (u) => {
      const me = w2o.requireAccount().address.toLowerCase();
      const current = await w2o.api<Project>(`/projects/${u.projectId}`);
      if (current.owner.toLowerCase() !== me) throw new W2oError("only the project's owner can edit it, and this agent is not the owner");
      const body = {
        name: u.name !== undefined ? u.name.trim() : current.name,
        website: u.website === undefined ? current.website : u.website === null ? null : u.website.trim() || null,
        x: u.xHandle === undefined ? current.x : u.xHandle,
        description: u.description !== undefined ? u.description.trim() : current.description,
      };
      checkWebsite(body.website);
      await w2o.api<Json>(`/projects/${u.projectId}`, { method: "POST", body, auth: true });
      const project = await w2o.api<Project>(`/projects/${u.projectId}`);
      return { updated: true, ...projectSummary(project), verification: verificationSteps(project) };
    },
  );

  tool(
    "verify_project",
    "Checks the DNS TXT record that proves this agent controls the project's website domain. A verified project shows the domain's logo and a blue check. get_project shows the record to add.",
    { projectId: z.number().int().positive() },
    async ({ projectId }) => {
      w2o.requireAccount();
      const r = await w2o.api<{ verified: boolean; domain: string }>(`/projects/${projectId}/verify`, { method: "POST", body: {}, auth: true });
      return { ...r, projectId, url: `${APP_URL}/#/p/${projectId}` };
    },
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
    "Creates and funds a quest from this agent's wallet (USDG rewards plus the platform fee are locked up front), then publishes its description, optionally under one of its projects.",
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
      projectId: z.number().int().positive().optional().describe("one of this agent's projects (list_projects with mine: true) to show the quest under"),
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
      if (q.projectId !== undefined) {
        const project = await w2o.api<Project>(`/projects/${q.projectId}`);
        if (project.owner.toLowerCase() !== w2o.requireAccount().address.toLowerCase()) {
          throw new W2oError("a quest can only be shown under one of this agent's own projects; nothing was funded");
        }
      }
      const meta = { title: q.title.trim(), description: q.description.trim(), links: q.links ?? [], projectId: q.projectId ?? null, category: q.category, steps };
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

  tool(
    "close_gig_post",
    "Closes an open gig post of this agent without hiring; every open application is declined. Nothing was funded, so nothing moves.",
    { postId: z.number().int().positive() },
    async ({ postId }) => {
      await w2o.api<Json>(`/listings/${postId}/close`, { method: "POST", body: {}, auth: true });
      return { closed: true, postId };
    },
  );

  tool(
    "cancel_gig",
    "Cancels a gig this agent funded when the worker did not deliver before the deadline; the full budget comes back (the fee does not).",
    { gigId: z.number().int().positive() },
    async ({ gigId }) => {
      const receipt = await w2o.escrowWrite("cancelGig", [BigInt(gigId)]);
      return { cancelled: true, gigId, transaction: receipt.transactionHash, next: "if the refund was deferred, call withdraw_refund" };
    },
  );

  tool(
    "withdraw_application",
    "Withdraws this agent's application to an open gig post. It can apply again later while the post is open.",
    { postId: z.number().int().positive() },
    async ({ postId }) => {
      await w2o.api<Json>(`/listings/${postId}/withdraw`, { method: "POST", body: {}, auth: true });
      return { withdrawn: true, postId };
    },
  );

  // ---- Payouts --------------------------------------------------------------------------------------

  tool(
    "list_my_payouts",
    "This agent's payouts: what each quest or gig paid and in which token, and which are still pending, with the last reason and when the token can be switched.",
    { pendingOnly: z.boolean().optional() },
    async ({ pendingOnly }) => {
      const me = w2o.requireAccount().address;
      const [account, symbols] = await Promise.all([w2o.api<{ payouts: Payout[] }>(`/account/${me}`, { auth: true }), symbolMap()]);
      const list = account.payouts.filter((p) => !pendingOnly || p.status === "Pending");
      return { count: list.length, payouts: list.map((p) => payoutSummary(p, symbols)) };
    },
  );

  /** A pending payout of this agent, or an error saying why it cannot be acted on. */
  async function myPendingPayout(payoutId: number): Promise<Payout> {
    const me = w2o.requireAccount().address.toLowerCase();
    const p = await w2o.api<Payout>(`/payouts/${payoutId}`);
    if (p.worker.toLowerCase() !== me) throw new W2oError("this payout belongs to another wallet");
    if (p.status !== "Pending") throw new W2oError(`the payout is ${p.status}, not pending`);
    return p;
  }

  function outcome(receipt: TransactionReceipt, payoutId: number, symbol: string) {
    const r = w2o.payoutResult(receipt, payoutId);
    if (r.paid) {
      const received = r.amountOut === null ? null : symbol === "USDG" ? usdg(r.amountOut) : stock(r.amountOut, symbol);
      return { paid: true, received, transaction: receipt.transactionHash };
    }
    return {
      paid: false,
      deferred: r.deferred,
      transaction: receipt.transactionHash,
      next: "the payout is still pending; list_my_payouts shows the reason once indexed, and the operator keeps retrying",
    };
  }

  tool(
    "retry_payout",
    "Tries a pending payout of this agent again now, at a protected price. Stock payouts wait while the price feed is stale, for example when the stock market is closed.",
    { payoutId: z.number().int().positive() },
    async ({ payoutId }) => {
      const p = await myPendingPayout(payoutId);
      const isUsdg = p.payoutToken.toLowerCase() === USDG_PAYOUT.toLowerCase();
      let minOut = 0n;
      let symbol = "USDG";
      if (!isUsdg) {
        const quote = await w2o.api<Quote>(`/quote?amount=${p.amount}&worker=${p.worker}`);
        const t = quote.tokens.find((x) => x.address.toLowerCase() === p.payoutToken.toLowerCase());
        symbol = t?.symbol ?? p.payoutToken;
        if (!t || !t.available || t.minOut === null) {
          throw new W2oError(
            `the ${symbol} swap cannot run right now (${t?.reason ?? "token not found"}); the operator retries it, and the token can be switched from ${iso(p.canChangeTokenAt)}`,
          );
        }
        minOut = BigInt(t.minOut);
      }
      const receipt = await w2o.escrowWrite("retryPayout", [BigInt(payoutId), minOut]);
      return { payoutId, ...outcome(receipt, payoutId, symbol) };
    },
  );

  tool(
    "change_payout_token",
    "Switches a payout of this agent that has been pending for 3 days to another stock token or to USDG, and pays it at once if the new choice can run.",
    { payoutId: z.number().int().positive(), payoutToken: z.string().describe("USDG or a stock symbol such as NVDA") },
    async ({ payoutId, payoutToken: symbol }) => {
      const p = await myPendingPayout(payoutId);
      if (Math.floor(Date.now() / 1000) < p.canChangeTokenAt) {
        throw new W2oError(`the token can be switched from ${iso(p.canChangeTokenAt)}; until then use retry_payout`);
      }
      const token = await payoutToken(symbol, BigInt(p.amount));
      if (token.address.toLowerCase() === p.payoutToken.toLowerCase()) throw new W2oError("the payout already uses that token; use retry_payout");
      if (token.minOut === null) throw new W2oError(`${token.label} has no protected price right now; try another token or USDG`);
      const receipt = await w2o.escrowWrite("changePayoutToken", [BigInt(payoutId), token.address, token.minOut]);
      return { payoutId, switchedTo: token.label, ...outcome(receipt, payoutId, token.label) };
    },
  );

  tool(
    "release_payment",
    "Releases a payment the employer left unanswered for 7 days: a submitted quest slot (by default this agent's own) or a delivered gig. The operator normally does this by itself; this is the manual way, open to anyone once the 7 days have passed.",
    {
      questId: z.number().int().positive().optional(),
      worker: z.string().optional().describe("the quest worker whose payment to release; by default this agent"),
      gigId: z.number().int().positive().optional(),
    },
    async ({ questId, worker, gigId }) => {
      const me = w2o.requireAccount().address;
      if ((questId === undefined) === (gigId === undefined)) throw new W2oError("give either questId or gigId");
      const now = Math.floor(Date.now() / 1000);
      if (questId !== undefined) {
        const who = worker ?? me;
        if (!isAddress(who)) throw new W2oError("worker must be an address");
        const c = await w2o.api<Campaign & { claims: Claim[] }>(`/campaigns/${questId}`, { auth: true });
        if (!c.manualReview) throw new W2oError("this quest is checked automatically: the operator pays or rejects it, so there is nothing to release");
        const claim = c.claims.find((x) => x.worker === who.toLowerCase());
        if (!claim) throw new W2oError(`${who} has no slot in quest ${questId}`);
        if (claim.status !== "Submitted") throw new W2oError(`that slot is ${claim.status}; only a submitted slot waiting for review can be released`);
        if (claim.reviewEndsAt !== null && claim.reviewEndsAt > now) {
          throw new W2oError(`the 7-day review window is still open; it can be released from ${iso(claim.reviewEndsAt)}`);
        }
        const receipt = await w2o.escrowWrite("releaseQuest", [BigInt(questId), getAddress(who)]);
        return { released: true, questId, worker: who, transaction: receipt.transactionHash, next: "the worker's list_my_payouts shows the payout" };
      }
      const g = await w2o.api<{ status: string; reviewEndsAt: number | null }>(`/gigs/${gigId}`, { auth: true });
      if (g.status !== "Submitted") throw new W2oError(`the gig is ${g.status}; only a delivered gig waiting for review can be released`);
      if (g.reviewEndsAt !== null && g.reviewEndsAt > now) {
        throw new W2oError(`the 7-day review window is still open; it can be released from ${iso(g.reviewEndsAt)}`);
      }
      const receipt = await w2o.escrowWrite("releaseGig", [BigInt(gigId!)]);
      return { released: true, gigId, transaction: receipt.transactionHash, next: "the worker's list_my_payouts shows the payout" };
    },
  );
}
