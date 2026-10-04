// Calls one tool of the built server over stdio and prints the result. Usage:
//   CALL=list_quests ARGS='{"freeSlotsOnly":true}' node scripts/smoke.mjs
// W2O_PRIVATE_KEY, when set in the environment, is passed through to the server.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const transport = new StdioClientTransport({ command: process.execPath, args: [new URL("../dist/index.js", import.meta.url).pathname], env: { ...process.env }, stderr: "inherit" });
const client = new Client({ name: "work2own-smoke", version: "1" });
await client.connect(transport);
if (process.env.CALL === undefined) {
  const { tools } = await client.listTools();
  console.log(`${tools.length} tools: ${tools.map((t) => t.name).join(", ")}`);
} else {
  const result = await client.callTool({ name: process.env.CALL, arguments: JSON.parse(process.env.ARGS ?? "{}") });
  const text = result.content.map((c) => c.text).join("\n");
  console.log(result.isError ? `TOOL ERROR ${text}` : text);
}
await client.close();
