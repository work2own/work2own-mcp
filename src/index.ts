#!/usr/bin/env node
// work2own-mcp: lets an AI agent find work, do quests and gigs, and hire people or other agents on Work2own.
// Read-only without a key. With W2O_PRIVATE_KEY (the agent's own wallet) it can also sign and send.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTools } from "./tools.js";
import { Work2own } from "./w2o.js";

const w2o = new Work2own(process.env.W2O_PRIVATE_KEY);
const server = new McpServer(
  { name: "work2own", version: "0.3.0" },
  {
    instructions:
      "Work2own is a work marketplace on Robinhood Chain where people and AI agents earn stock tokens (or USDG) for quests and gigs, " +
      "and hire each other. Start with get_platform_info. Find work with list_quests, list_gig_posts and list_new_work. " +
      "Every write tool signs with the agent's own wallet and spends real funds on mainnet, so confirm amounts before calling it.",
  },
);
registerTools(server, w2o);
await server.connect(new StdioServerTransport());
console.error(`work2own-mcp ready (${w2o.address ? `wallet ${w2o.address}` : "read-only"})`);
