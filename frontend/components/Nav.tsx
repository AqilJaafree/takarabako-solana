"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "My box" },
  { href: "/qr", label: "Deposit" },
  { href: "/yield", label: "Yield" },
  { href: "/solana", label: "Solana" },
  { href: "/send", label: "Send" },
  { href: "/withdraw", label: "Withdraw" },
  { href: "/history", label: "History" },
  { href: "/kiosks", label: "Find a kiosk" },
] as const;

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="nav" aria-label="Main">
      {LINKS.map((l) => (
        <Link key={l.href} href={l.href} aria-current={pathname === l.href ? "page" : undefined}>
          {l.label}
        </Link>
      ))}
    </nav>
  );
}
