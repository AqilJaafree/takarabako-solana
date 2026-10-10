export const config = {
  port: Number(process.env.PORT ?? 4000),
  rpcUrl: process.env.RPC_URL ?? "https://ethereum-sepolia-rpc.publicnode.com",
  treasuryPrivateKey: process.env.TREASURY_PRIVATE_KEY ?? "",
  usdcAddress: process.env.USDC_ADDRESS ?? "",
  vaultAddress: process.env.VAULT_ADDRESS ?? "",
  // Privy is the identity layer: email in, real embedded wallet + a stable
  // user id out, no phone/QR/bridge needed.
  privy: {
    appId: process.env.PRIVY_APP_ID ?? "",
    appSecret: process.env.PRIVY_APP_SECRET ?? "",
  },
  // ENS v2 (official Sepolia deployment; scripts/ens-setup.ts). Our own
  // UserRegistry holds the subnames, our own PermissionedResolver the records.
  ens: {
    parentName: process.env.ENS_PARENT_NAME ?? "takarabako.eth",
    registryAddress: process.env.ENS_REGISTRY_ADDRESS ?? "",
    resolverAddress: process.env.ENS_RESOLVER_ADDRESS ?? "",
  },
  agent: {
    apiKey: process.env.ANTHROPIC_API_KEY ?? "",
    model: process.env.AGENT_MODEL ?? "claude-haiku-4-5-20251001",
  },
  withdrawFeeBps: Number(process.env.WITHDRAW_FEE_BPS ?? 200),
  databaseUrl: process.env.DATABASE_URL ?? "",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
  // Gmail SMTP with an App Password (myaccount.google.com/apppasswords).
  // Used for the QR email when set; otherwise Resend (needs a verified domain).
  gmail: {
    user: process.env.GMAIL_USER ?? "",
    appPassword: (process.env.GMAIL_APP_PASSWORD ?? "").replace(/\s+/g, ""),
  },
  resend: {
    apiKey: process.env.RESEND_API_KEY ?? "",
    from: process.env.RESEND_FROM ?? "",
  },
  // Curvegrid MultiBaas (multibaas.ts): contract calls, event indexing,
  // saved event queries and signed webhooks. Unset = everything that uses it
  // falls back (direct viem reads, no dashboard aggregates).
  multibaas: {
    url: (process.env.MULTIBAAS_URL ?? "").replace(/\/+$/, ""), // https://<id>.multibaas.com
    apiKey: process.env.MULTIBAAS_API_KEY ?? "", // admin key — backend only
    webhookSecret: process.env.MULTIBAAS_WEBHOOK_SECRET ?? "",
  },
  // Where MultiBaas can reach this backend (a tunnel in dev), for the webhook.
  publicBackendUrl: (process.env.PUBLIC_BACKEND_URL ?? "").replace(/\/+$/, ""),
  // tkCASH (contracts/src/TakarabakoCashReceipt.sol) and this kiosk's id in it.
  cashReceiptAddress: process.env.CASH_RECEIPT_ADDRESS ?? "",
  kioskId: process.env.KIOSK_ID ?? "tokyo-01",
  // Kiosks this backend used before (their tkCASH reserve is still redeemable).
  previousKioskIds: (process.env.KIOSK_PREVIOUS_IDS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
  // Treasury ops agent (opsAgent.ts): the model, and the token a human
  // sends to approve or reject its proposals.
  opsAgent: {
    model: process.env.OPS_AGENT_MODEL ?? "claude-opus-5",
    adminToken: process.env.OPS_ADMIN_TOKEN ?? "",
    // The agent's mandate (mandate.ts): "off" = every action waits for a human.
    autonomy: process.env.AGENT_AUTONOMY !== "off",
    // Daily signed treasury reports (report.ts): "off" = only on demand.
    dailyReports: process.env.AGENT_REPORTS !== "off",
  },
  // OpenAI-compatible chat API for both agents (llm.ts), e.g. OpenRouter.
  // Set = used instead of Anthropic; unset = the Anthropic key above.
  ai: {
    apiKey: process.env.AI_API_KEY ?? "",
    baseUrl: (process.env.AI_BASE_URL ?? "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
    model: process.env.AI_MODEL ?? "openai/gpt-5-mini",
  },
  // Every customer can move this much a day (deposits, withdrawals, yield,
  // sends — limits.ts). UNVERIFIED_DAILY_LIMIT_USD is the old name.
  dailyLimitUsd: Number(process.env.DAILY_LIMIT_USD ?? process.env.UNVERIFIED_DAILY_LIMIT_USD ?? 1000),
  // Verifiable kiosks (machine.ts): "required" rejects deposits that aren't
  // signed by a kiosk whose ENS name resolves to the signer; "optional"
  // credits them but marks them unverified.
  machineSignature: (process.env.MACHINE_SIGNATURE === "required" ? "required" : "optional") as "required" | "optional",
  // 1inch Aqua yield (aqua.ts). Aqua and its SwapVM router are deployed on
  // Sepolia at the same addresses as mainnet (the router at its previous
  // address; the SDK doesn't list Sepolia). mETH is our mock ETH.
  aqua: {
    address: process.env.AQUA_ADDRESS ?? "0x1111113ccf1426a8e30e2bff5e005d929bf6a90a",
    router: process.env.AQUA_ROUTER_ADDRESS ?? "0x1111113db0e0ef9d0e3a50d5f094a3a57a26c0de",
    methAddress: process.env.METH_ADDRESS ?? "0x5A9E9fF59AeBb96C14DFaB7C2a43d0C130ba9282",
    // Demo market maker (aquaSimulator.ts): trades against open strategies
    // so they earn fees and move through their ranges on a quiet testnet.
    simEnabled: process.env.AQUA_SIM === "1",
    simIntervalMs: Number(process.env.AQUA_SIM_INTERVAL_MS ?? 600_000),
  },
  // USD per 1 MYR. Unset or 0 = use the live rate (see fx.ts).
  fx: {
    myrUsdRate: Number(process.env.MYR_USD_RATE ?? 0),
  },
} as const;
