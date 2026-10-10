import express from "express";
import { config } from "./config.js";
import { verifyRouter } from "./routes/verify.js";
import { depositRouter } from "./routes/deposit.js";
import { agentRouter } from "./routes/agentRoutes.js";
import { withdrawRouter } from "./routes/withdraw.js";
import { positionRouter } from "./routes/position.js";
import { loginQrRouter } from "./routes/loginQr.js";
import { authPrivyRouter } from "./routes/authPrivy.js";
import { eventsRouter } from "./routes/events.js";
import { meRouter } from "./routes/me.js";
import { depositSessionsRouter } from "./routes/depositSessions.js";
import { webhooksRouter } from "./routes/webhooks.js";
import { opsRouter } from "./routes/ops.js";
import { dashboardRouter } from "./routes/dashboard.js";
import { yieldRouter } from "./routes/yieldRoutes.js";
import { ensRouter } from "./routes/ensRoutes.js";
import { startDeedWatcher } from "./ensTransfers.js";
import { startOpsMonitor } from "./opsMonitor.js";
import { startDailyReports } from "./report.js";
import { startAquaSimulator } from "./aquaSimulator.js";
import { migrate } from "./db.js";
import { solanaRouter } from "./routes/solanaRoutes.js";
import { startSolanaWorker } from "./solana/jobs.js";
import { startSolanaSimulator } from "./solana/simulator.js";
import { startDepositWorker } from "./depositQueue.js";

const app = express();
// Signed webhooks need the raw body, so they're mounted before the JSON parser.
app.use(webhooksRouter);
app.use(express.json());

// Dev-only convenience: the kiosk page (device-agent) fetches this API
// directly from the browser. Lock this down (or put both behind one origin)
// before this ever leaves a hackathon table.
app.use((_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.header("Access-Control-Allow-Methods", "GET,POST");
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.use(verifyRouter);
app.use(loginQrRouter);
app.use(authPrivyRouter);
app.use(eventsRouter);
app.use(meRouter);
app.use(depositSessionsRouter);
app.use(depositRouter);
app.use(agentRouter);
app.use(yieldRouter);
app.use(ensRouter);
app.use(withdrawRouter);
app.use(positionRouter);
app.use(opsRouter);
app.use(dashboardRouter);
app.use(solanaRouter);

// Catches anything asyncHandler forwards (chain calls, Privy, the agent) —
// without this, an unhandled rejection in an async route takes the whole
// process down instead of just failing that one request.
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = (err as { status?: number })?.status;
  if (!status) console.error(err);
  const message = err instanceof Error ? err.message : "internal error";
  res.status(status ?? 500).json({ error: message, code: (err as { code?: string })?.code });
});

try {
  await migrate();
} catch (err) {
  // Connection refusals arrive as an AggregateError with an empty message.
  const reason = (err as { code?: string })?.code ?? (err instanceof Error ? err.message : String(err));
  console.error(`[db] cannot reach Postgres (${reason}) — run: cd backend && docker compose up -d`);
  process.exit(1);
}
startDepositWorker();
startOpsMonitor();
startDailyReports();
startAquaSimulator();
startDeedWatcher();
startSolanaWorker();
startSolanaSimulator();

app.listen(config.port, () => {
  console.log(`takarabako backend listening on :${config.port}`);
});
