// HandsFree engine: started by the Mac app (or `npm run engine` for headless use).
import crypto from "node:crypto";
import { Orchestrator } from "./orchestrator";
import { startServer } from "./server";
import { loadLoginPath } from "./shell";
import { DATA_DIR } from "./store";

async function main() {
  await loadLoginPath();
  const port = Number(process.env.HF_PORT || 47821);
  const token = process.env.HF_TOKEN || crypto.randomBytes(16).toString("hex");
  const o = new Orchestrator();
  const server = startServer(o, port, token);
  o.start();
  console.log(`[handsfree] engine on http://127.0.0.1:${port} · data ${DATA_DIR}${process.env.HF_TOKEN ? "" : ` · token ${token}`}`);

  const bye = () => {
    o.shutdown();
    server.close();
    setTimeout(() => process.exit(0), 300);
  };
  process.on("SIGTERM", bye);
  process.on("SIGINT", bye);
  // If the app dies without signalling us, don't leave an orphan engine running.
  process.stdin.on("end", bye);
  process.stdin.resume();
}

main().catch((e) => {
  console.error("[handsfree] fatal:", e);
  process.exit(1);
});
