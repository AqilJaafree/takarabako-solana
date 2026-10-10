import { setSolanaWallet, type Account } from "../accounts.js";
import { ensureSolanaWallet } from "../privy.js";

/// The customer's Solana wallet address, from the account row or created
/// through Privy the first time (then stored).
export async function solanaWalletFor(account: Account): Promise<string> {
  if (account.solanaWallet) return account.solanaWallet;
  const address = await ensureSolanaWallet(account.privyUserId);
  await setSolanaWallet(account.privyUserId, address);
  return address;
}
