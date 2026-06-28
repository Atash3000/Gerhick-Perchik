// Single source of truth for the scoring/derivation strategy version.
//
// Written into EVERY snapshot and outcome record. Outcome analysis must always
// filter by this value: win-rates from different versions are NOT comparable.
//
// Bump ONLY when the scoring formula or level/derivation logic changes, and ONLY
// on explicit human instruction — never silently (see CLAUDE.md).
export const STRATEGY_VERSION = "gp-momentum-1.0.0";
