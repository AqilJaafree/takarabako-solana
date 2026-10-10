import { PrivyClient, NotFoundError, verifyAccessToken, type LinkedAccount } from "@privy-io/node";
import { createRemoteJWKSet } from "jose";
import type { Address } from "viem";
import { config } from "./config.js";
import { chainReady, fundWalletWithEthOnChain } from "./chain.js";

/// Privy is the identity layer: email in, a real embedded wallet and a
/// stable user id out — no phone, no QR, no bridge. One email → one Privy
/// user (`getByEmailAddress` before `create`).
const privy = new PrivyClient({
  appId: config.privy.appId,
  appSecret: config.privy.appSecret,
});

// Real Sepolia ETH gifted to a brand-new embedded wallet so the user has
// gas for anything they do with it themselves later. First-time account
// creation only (not every login) — real capital, kept bounded.
const NEW_ACCOUNT_FUNDING_ETH = 0.001;

export interface PrivyUserWallet {
  userId: string;
  walletAddress: string;
  fundingTxHash?: string;
}

/// The user's email, whichever way they logged in: an email-code login stores
/// it as an `email` account, "Sign in with Google" as a `google_oauth` one.
function findEmail(linkedAccounts: LinkedAccount[]): string | undefined {
  for (const a of linkedAccounts) {
    if (a.type === "email" && "address" in a && a.address) return String(a.address).toLowerCase();
    if (a.type === "google_oauth" && "email" in a && a.email) return String(a.email).toLowerCase();
  }
  return undefined;
}

function findEthereumWallet(linkedAccounts: LinkedAccount[]): string | undefined {
  const wallet = linkedAccounts.find((a) => a.type === "wallet" && a.chain_type === "ethereum");
  return wallet && "address" in wallet ? wallet.address : undefined;
}

/// Looks up the Privy user for `email`, creating one (with a fresh embedded
/// Ethereum wallet, funded with real Sepolia ETH) if none exists yet. Both
/// branches are real API calls — no local stubbing.
export async function getOrCreateUserWallet(email: string): Promise<PrivyUserWallet> {
  let linkedAccounts: LinkedAccount[];
  let userId: string;
  let isNewUser = false;

  try {
    const user = await privy.users().getByEmailAddress({ address: email });
    userId = user.id;
    linkedAccounts = user.linked_accounts;
  } catch (err) {
    if (!(err instanceof NotFoundError)) throw err;

    const user = await privy.users().create({
      linked_accounts: [{ address: email, type: "email" }],
      wallets: [{ chain_type: "ethereum" }],
    });
    userId = user.id;
    linkedAccounts = user.linked_accounts;
    isNewUser = true;
  }

  const walletAddress = findEthereumWallet(linkedAccounts);
  if (!walletAddress) throw new Error(`Privy user ${userId} has no ethereum embedded wallet`);

  let fundingTxHash: string | undefined;
  if (isNewUser && chainReady) {
    try {
      const { txHash } = await fundWalletWithEthOnChain(walletAddress as Address, NEW_ACCOUNT_FUNDING_ETH);
      fundingTxHash = txHash;
    } catch (err) {
      // Don't fail account creation over a funding hiccup (e.g. treasury
      // low on ETH) — the user still has a real wallet, just no gas yet.
      console.error(`[privy] failed to fund new wallet ${walletAddress}:`, err);
    }
  }

  return { userId, walletAddress, fundingTxHash };
}

// Privy's public keys for this app, fetched once and cached by jose.
const privyJwks = createRemoteJWKSet(new URL(`https://auth.privy.io/api/v1/apps/${config.privy.appId}/jwks.json`));

/// Verifies a web app login (Privy email code) and returns the user's email
/// and Ethereum embedded wallet. Someone who registers on the web before ever
/// using the kiosk has no wallet yet: create one and fund it, as the kiosk
/// would. Throws InvalidAuthTokenError for a bad or expired token.
export async function userFromAccessToken(accessToken: string): Promise<PrivyUserWallet & { email: string }> {
  const { user_id: userId } = await verifyAccessToken({
    access_token: accessToken,
    app_id: config.privy.appId,
    verification_key: privyJwks,
  });

  let user = await privy.users()._get(userId);
  const email = findEmail(user.linked_accounts);
  if (!email) throw new Error(`Privy user ${userId} has no email`);

  let walletAddress = findEthereumWallet(user.linked_accounts);
  let fundingTxHash: string | undefined;
  if (!walletAddress) {
    user = await privy.users().pregenerateWallets(userId, { wallets: [{ chain_type: "ethereum" }] });
    walletAddress = findEthereumWallet(user.linked_accounts);
    if (walletAddress && chainReady) {
      try {
        ({ txHash: fundingTxHash } = await fundWalletWithEthOnChain(walletAddress as Address, NEW_ACCOUNT_FUNDING_ETH));
      } catch (err) {
        console.error(`[privy] failed to fund new wallet ${walletAddress}:`, err);
      }
    }
  }
  if (!walletAddress) throw new Error(`Privy user ${userId} has no ethereum embedded wallet`);

  return { userId, walletAddress, fundingTxHash, email };
}
