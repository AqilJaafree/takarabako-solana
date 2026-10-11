"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { sepolia } from "viem/chains";

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

/// Privy only handles login in the browser (email code or Google). Wallets are
/// created by the backend (so kiosk and web users share one account), which
/// is why Privy is told not to create one on login.
export function PrivyShell({ children }: { children: React.ReactNode }) {
  if (!APP_ID) {
    return (
      <main className="shell">
        <div className="notice error">
          NEXT_PUBLIC_PRIVY_APP_ID is not set. Copy <code>frontend/.env.example</code> to{" "}
          <code>frontend/.env.local</code> and fill it in.
        </div>
      </main>
    );
  }
  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        loginMethods: ["email", "google"],
        appearance: { theme: "dark", accentColor: "#e3b36a" },
        // Both wallets are created by the backend; Privy only signs with them.
        embeddedWallets: { ethereum: { createOnLogin: "off" }, solana: { createOnLogin: "off" } },
        // Customers sign their own transfers (tkCASH, position deeds) on Sepolia.
        defaultChain: sepolia,
        supportedChains: [sepolia],
      }}
    >
      {children}
    </PrivyProvider>
  );
}
