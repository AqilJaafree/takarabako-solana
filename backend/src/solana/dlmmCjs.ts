import { createRequire } from "node:module";
import type * as DlmmTypes from "@meteora-ag/dlmm";

/// @meteora-ag/dlmm's ESM build (dist/index.mjs) cannot be loaded by Node:
/// it imports a directory from @coral-xyz/anchor and a named `BN` export
/// that CJS doesn't expose. Its CJS build loads fine, so load that, keeping
/// the package's types. The CJS module.exports IS the DLMM class itself,
/// with the named exports (StrategyType, ...) attached as properties; there
/// is no `.default` at runtime.
const mod = createRequire(import.meta.url)("@meteora-ag/dlmm");

export const DLMM = mod as typeof DlmmTypes.default;
export type DLMM = DlmmTypes.default;
export const StrategyType = (mod as typeof DlmmTypes).StrategyType;
export type StrategyType = DlmmTypes.StrategyType;
