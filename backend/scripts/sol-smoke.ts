// End-to-end on devnet, against the real Postgres and the live deps:
//   1. for each tier: mint mUSD → open a position → close it → check on-chain
//   2. swap leg: open a High position, push the pool price down into it with a
//      treasury SOL→mUSD swap so the position holds SOL, then close it — the
//      close must swap that SOL back and pay what actually arrived.
// Inserts a throwaway "smoke-…" account into the DB it runs against.
//   cd backend && npm run sol:smoke
import { Keypair, PublicKey, type ParsedTransactionWithMeta, type TokenBalance } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { pool, migrate } from "../src/db.js";
import { redis } from "../src/redis.js";
import { insertAccount, setSolanaWallet, createQueuedDeposit, markDepositSendingSol, markDepositConfirmed } from "../src/accounts.js";
import { openDepositSession } from "../src/history.js";
import { getPosition, markClosing, setSessionDestination, type SolPositionRow } from "../src/solana/store.js";
import { openForSession, closePosition } from "../src/solana/positions.js";
import { broadcast, confirm, connection, sendAndConfirm, solscanTx, treasury, treasurySol } from "../src/solana/client.js";
import { mintToTx, balanceRaw, fromRaw, musdMint } from "../src/solana/musd.js";
import { poolState, positionAmounts, positionExists, prepareSwapSolToMusd, swapMusdToSol, swapReceivedRaw } from "../src/solana/meteora.js";
import type { SolTier } from "../src/solana/tiers.js";

const DLMM_PROGRAM = "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo";
const MIN_SOL = 1;
const DEPOSIT_USD = 5;
const PRICE_MOVE_SOL = 0.15; // treasury SOL swapped in to push the price into the swap-leg position

const t = treasury().publicKey;
const startSol = await treasurySol();
console.log(`treasury ${t.toBase58()} start ${startSol.toFixed(6)} SOL`);

async function checkTreasury(step: string) {
  const sol = await treasurySol();
  console.log(`  [${step}] treasury ${sol.toFixed(6)} SOL`);
  if (sol < MIN_SOL) throw new Error(`treasury below ${MIN_SOL} SOL — stopping`);
}

function check(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`CHECK FAILED: ${msg}`);
}

/// Every program a transaction invoked (top level + inner), fetched independently.
async function txPrograms(sig: string): Promise<{ tx: ParsedTransactionWithMeta; programs: Set<string> }> {
  for (let i = 0; i < 5; i++) {
    const tx = await connection.getParsedTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    if (tx) {
      const programs = new Set(tx.transaction.message.instructions.map((ix) => ix.programId.toBase58()));
      for (const inner of tx.meta?.innerInstructions ?? []) for (const ix of inner.instructions) programs.add(ix.programId.toBase58());
      check(!tx.meta?.err, `${sig} has an error: ${JSON.stringify(tx.meta?.err)}`);
      return { tx, programs };
    }
    await new Promise((r) => setTimeout(r, 1_500));
  }
  throw new Error(`could not fetch ${sig}`);
}

/// mUSD delta of `owner` in a transaction (post - pre).
function musdDelta(tx: ParsedTransactionWithMeta, owner: PublicKey): bigint {
  const mint = musdMint().toBase58();
  const amt = (list: TokenBalance[] | null | undefined) =>
    BigInt(list?.find((b) => b.mint === mint && b.owner === owner.toBase58())?.uiTokenAmount.amount ?? "0");
  return amt(tx.meta?.postTokenBalances) - amt(tx.meta?.preTokenBalances);
}

await migrate();
const user = `smoke-${Date.now()}`;
const wallet = Keypair.generate().publicKey; // a throwaway devnet wallet stands in for the Privy one
await insertAccount({ privyUserId: user, email: `${user}@example.com`, privyWallet: `0x${"0".repeat(39)}1`, boundAddress: `0x${"0".repeat(39)}2`, ensName: null });
await setSolanaWallet(user, wallet.toBase58());
console.log(`account ${user}, customer wallet ${wallet.toBase58()}`);

/// What the deposit queue does for one Earn note: mint mUSD to the treasury, record the deposit.
async function depositAndOpen(tier: SolTier): Promise<SolPositionRow> {
  await checkTreasury(`${tier} start`);
  const s = await openDepositSession(user);
  check((await setSessionDestination(s.id, user, "sol_earn", tier)) === "ok", "set destination");
  const mintSig = await sendAndConfirm(mintToTx(t, DEPOSIT_USD));
  const d = await createQueuedDeposit({ privyUserId: user, currency: "USD", amount: DEPOSIT_USD, sessionId: s.id });
  check(await markDepositSendingSol(d.id, mintSig, DEPOSIT_USD, 0), "markDepositSendingSol stored");
  await markDepositConfirmed(d.id);
  const mintTx = await txPrograms(mintSig);
  check(mintTx.programs.has(TOKEN_2022_PROGRAM_ID.toBase58()), "mint tx calls Token-2022");
  console.log(`${tier}: minted ${DEPOSIT_USD} mUSD to treasury (+${fromRaw(musdDelta(mintTx.tx, t))}) ${solscanTx(mintSig)}`);

  const activeBefore = (await poolState()).activeId;
  const opened = await openForSession(s.id);
  check(opened?.status === "open" && opened.positionPubkey && opened.openSig, `${tier}: not opened (${opened?.status})`);
  const info = await connection.getAccountInfo(new PublicKey(opened.positionPubkey), "confirmed");
  check(info, `${tier}: position account missing on-chain`);
  check(info.owner.toBase58() === DLMM_PROGRAM, `${tier}: position owner ${info.owner.toBase58()} is not the DLMM program`);
  const openTx = await txPrograms(opened.openSig);
  check(openTx.programs.has(DLMM_PROGRAM), `${tier}: open tx doesn't call DLMM`);
  const deposited = -musdDelta(openTx.tx, t);
  check(deposited > 0n && deposited <= 5_000_000n, `${tier}: open tx moved ${deposited} treasury mUSD into the pair, expected (0, 5000000]`);
  const a = await positionAmounts(opened.positionPubkey);
  console.log(
    `${tier}: opened ${opened.positionPubkey} bins [${opened.minBinId}, ${opened.maxBinId}] (active ${activeBefore}) ` +
      `deposited ${fromRaw(deposited)}, holds ${fromRaw(a.musdRaw)} mUSD + ${Number(a.solRaw) / 1e9} SOL; owner=DLMM, programs=[${[...openTx.programs].join(", ")}] ${solscanTx(opened.openSig)}`,
  );
  return opened;
}

async function closeAndCheck(opened: SolPositionRow) {
  const tier = opened.tier;
  const before = await balanceRaw(wallet);
  check(await markClosing(opened.id, user), `${tier}: markClosing`);
  const closed = await closePosition(opened.id);
  check(closed?.status === "closed" && closed.payoutSig, `${tier}: not closed (${closed?.status})`);
  const after = await balanceRaw(wallet);
  check(!(await positionExists(opened.positionPubkey!)), `${tier}: position still exists after close`);
  const payoutRaw = BigInt(closed.musdOutRaw ?? "0") + BigInt(closed.swapOutRaw ?? "0");
  check(after - before === payoutRaw, `${tier}: wallet gained ${after - before}, row says ${payoutRaw}`);
  check(after - before > 0n, `${tier}: customer wallet received nothing`);
  const payTx = await txPrograms(closed.payoutSig);
  check(payTx.programs.has(TOKEN_2022_PROGRAM_ID.toBase58()), `${tier}: payout tx doesn't call Token-2022`);
  check(musdDelta(payTx.tx, wallet) === payoutRaw && musdDelta(payTx.tx, t) === -payoutRaw, `${tier}: payout tx deltas don't match`);
  const ata = await connection.getTokenAccountsByOwner(wallet, { mint: musdMint() }, "confirmed");
  check(ata.value.length === 1 && ata.value[0].account.owner.equals(TOKEN_2022_PROGRAM_ID), `${tier}: wallet ATA not a Token-2022 account`);
  console.log(
    `${tier}: closed → ${fromRaw(after - before)} mUSD to ${wallet.toBase58()} ` +
      `(removed ${fromRaw(BigInt(closed.musdOutRaw ?? "0"))} mUSD + ${Number(closed.solOutRaw ?? 0) / 1e9} SOL; ` +
      `swap ${closed.swapSig ?? "none"} → ${fromRaw(BigInt(closed.swapOutRaw ?? "0"))} mUSD; value_out ${closed.valueOut}) ` +
      `position account gone; payout programs=[${[...payTx.programs].join(", ")}] ${solscanTx(closed.payoutSig)}`,
  );
  return closed;
}

// 1. One open/close per tier (single-sided mUSD below the price: out of range, so no swap)
for (const tier of ["low", "medium", "high"] as const) {
  const opened = await depositAndOpen(tier);
  await closeAndCheck(opened);
}

// 2. Swap leg: push the price down into a fresh High position so it holds SOL.
console.log("--- swap leg ---");
const legOpened = await depositAndOpen("high");
await checkTreasury("price move");
const { signed, outRaw } = await prepareSwapSolToMusd(BigInt(Math.round(PRICE_MOVE_SOL * 1e9)));
await broadcast(signed.raw);
const moveOutcome = await confirm(signed.signature, signed.lastValidBlockHeight);
check(moveOutcome === "confirmed", `price-move swap ${signed.signature} ${moveOutcome}`);
const moveReceived = await swapReceivedRaw(signed.signature);
const stAfterMove = await poolState();
const legAmounts = await positionAmounts(legOpened.positionPubkey!);
console.log(
  `price move: swapped ${PRICE_MOVE_SOL} SOL → ${fromRaw(moveReceived ?? 0n)} mUSD (quoted ${fromRaw(outRaw)}) ${solscanTx(signed.signature)}; ` +
    `active bin now ${stAfterMove.activeId} (price ${stAfterMove.solPriceUsd.toFixed(4)}); ` +
    `position holds ${fromRaw(legAmounts.musdRaw)} mUSD + ${Number(legAmounts.solRaw) / 1e9} SOL`,
);
check(legAmounts.solRaw > 0n, "swap-leg position holds no SOL after the price move");

const legClosed = await closeAndCheck(legOpened);
check(legClosed.swapSig && legClosed.swapConfirmedAt, "swap leg: close did not swap SOL back");
const onChainReceived = musdDelta((await txPrograms(legClosed.swapSig)).tx, t);
check(BigInt(legClosed.swapOutRaw ?? "-1") === onChainReceived, `swapOutRaw ${legClosed.swapOutRaw} != on-chain received ${onChainReceived}`);
console.log(`swap leg: swapOutRaw ${legClosed.swapOutRaw} == on-chain treasury mUSD gain ${onChainReceived}; payout ${legClosed.valueOut} mUSD (in ${legClosed.musdIn})`);

// 3. Put the price back roughly where it was (sell the mUSD the price move bought).
if (moveReceived && moveReceived > 0n) {
  const restoreSig = await swapMusdToSol(moveReceived);
  console.log(`restore: swapped ${fromRaw(moveReceived)} mUSD → SOL, active bin ${(await poolState()).activeId} ${solscanTx(restoreSig)}`);
}

const endSol = await treasurySol();
const after = await getPosition(legOpened.id);
console.log(`treasury end ${endSol.toFixed(6)} SOL (spent ${(startSol - endSol).toFixed(6)}); last position ${after?.status}`);
console.log(`customer wallet total ${fromRaw(await balanceRaw(wallet))} mUSD`);
await pool.end();
redis.disconnect();
console.log("smoke OK");
