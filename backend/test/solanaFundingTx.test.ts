import { test } from "node:test";
import assert from "node:assert/strict";
import { Keypair, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { buildFundingTx, checkSignedFunding, messageHash, unsignedBase64 } from "../src/solana/fundingTx.js";

const owner = Keypair.generate();
const treasury = Keypair.generate();
const mint = Keypair.generate().publicKey;
const blockhash = Keypair.generate().publicKey.toBase58(); // any 32 bytes in base58
const params = (amountRaw = 2_500_000n) => ({
  owner: owner.publicKey, treasury: treasury.publicKey, mint, amountRaw, blockhash, lastValidBlockHeight: 500, priorityMicroLamports: 10_000, memo: "takarabako:row-1",
});

/// What the browser does: decode, sign with the customer's key, re-encode.
function customerSigns(b64: string, signer = owner): string {
  const tx = Transaction.from(Buffer.from(b64, "base64"));
  tx.partialSign(signer);
  return tx.serialize({ requireAllSignatures: false }).toString("base64");
}

test("the treasury pays the fee and the customer is the only other signer", () => {
  const tx = buildFundingTx(params());
  assert.ok(tx.feePayer?.equals(treasury.publicKey));
  const signers = tx.compileMessage().accountKeys.slice(0, tx.compileMessage().header.numRequiredSignatures).map((k) => k.toBase58());
  assert.deepEqual(signers.sort(), [owner.publicKey.toBase58(), treasury.publicKey.toBase58()].sort());
});

test("a correctly signed transaction passes, and the treasury can co-sign it", () => {
  const tx = buildFundingTx(params());
  const res = checkSignedFunding(customerSigns(unsignedBase64(tx)), messageHash(tx), owner.publicKey);
  assert.equal(res.ok, true);
  if (!res.ok) return;
  res.tx.partialSign(treasury);
  assert.equal(res.tx.verifySignatures(true), true);
});

test("a different amount is refused", () => {
  const prepared = buildFundingTx(params());
  const other = buildFundingTx(params(9_000_000n));
  const res = checkSignedFunding(customerSigns(unsignedBase64(other)), messageHash(prepared), owner.publicKey);
  assert.deepEqual(res, { ok: false, reason: "transaction differs from the one prepared" });
});

test("an extra instruction is refused", () => {
  const prepared = buildFundingTx(params());
  const extra = buildFundingTx(params()).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }));
  const res = checkSignedFunding(customerSigns(unsignedBase64(extra)), messageHash(prepared), owner.publicKey);
  assert.equal(res.ok, false);
});

test("an unsigned transaction is refused", () => {
  const tx = buildFundingTx(params());
  assert.deepEqual(checkSignedFunding(unsignedBase64(tx), messageHash(tx), owner.publicKey), { ok: false, reason: "not signed by your Solana wallet" });
});

test("a forged signature is refused", () => {
  const tx = buildFundingTx(params());
  tx.addSignature(owner.publicKey, Buffer.alloc(64, 7));
  const forged = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString("base64");
  assert.deepEqual(checkSignedFunding(forged, messageHash(tx), owner.publicKey), { ok: false, reason: "bad signature" });
});

test("a transaction for someone else's wallet is refused", () => {
  const stranger = Keypair.generate();
  const tx = buildFundingTx({ ...params(), owner: stranger.publicKey });
  const signed = customerSigns(unsignedBase64(tx), stranger);
  assert.equal(checkSignedFunding(signed, messageHash(tx), owner.publicKey).ok, false);
});

test("garbage is refused", () => {
  assert.deepEqual(checkSignedFunding("bm90IGEgdHg=", "x", owner.publicKey), { ok: false, reason: "unreadable transaction" });
});

test("two transactions identical except the memo have different hashes", () => {
  const a = buildFundingTx(params());
  const b = buildFundingTx({ ...params(), memo: "takarabako:row-2" });
  assert.notEqual(messageHash(a), messageHash(b));
  assert.equal(checkSignedFunding(customerSigns(unsignedBase64(b)), messageHash(a), owner.publicKey).ok, false);
});
