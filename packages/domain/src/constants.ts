import type { Paise } from './types';

/** Bump whenever a rule change would alter simulation outcomes. Persisted on plots/ticks. */
export const RULESET_VERSION = '2026.10.1';

export const DAYS_PER_MONTH = 30;
export const MONTHS_PER_YEAR = 12;
export const DAYS_PER_YEAR = 360;
/** Game day 0 is 1 June of Year 1. */
export const START_MONTH = 6;

export const SEASON_LENGTH_DAYS = 120;
/** Starting cash for a new human company: ₹5,00,000. */
export const STARTING_CASH_PAISE: Paise = 500_000_00;
/** Cash given instead of a starter plot if none remain: ₹1,50,000. */
export const NO_STARTER_PLOT_BONUS_PAISE: Paise = 150_000_00;
/** Fresh-start grant after bankruptcy: ₹2,00,000. */
export const BANKRUPTCY_RESTART_GRANT_PAISE: Paise = 200_000_00;

export const DISTRESS_GRACE_DAYS = 30;
/** Fraction of book/market value recovered when assets are liquidated in bankruptcy. */
export const LIQUIDATION_RECOVERY = 0.6;

/** Player-to-player trade fee (money sink), basis points, charged to the seller. */
export const P2P_TRADE_FEE_BPS = 200;
/** P2P listing/contract unit price must lie within these multiples of the best current mandi price. */
export const P2P_PRICE_FLOOR_MULTIPLIER = 0.25;
export const P2P_PRICE_CEILING_MULTIPLIER = 4;
/** Penalty a defaulting contract seller pays the buyer, basis points of contract value. */
export const CONTRACT_DEFAULT_PENALTY_BPS = 1000;

/** Land tax per hectare per 30-day month. */
export const LAND_TAX_PAISE_PER_HA_PER_MONTH: Paise = 150_00;
/** Corporate income tax on positive annual net profit, basis points. */
export const INCOME_TAX_BPS = 1000;

/** Base annual interest rate for loans, basis points. */
export const BASE_LOAN_RATE_BPS = 1100;
export const MAX_LOAN_TERM_MONTHS = 36;
/** A company may borrow up to this multiple of its net assets (min ₹2,00,000 cap). */
export const MAX_LOAN_TO_NET_ASSETS = 0.6;
export const MIN_LOAN_CAP_PAISE: Paise = 200_000_00;

/** Pest control protects a plot for this many days. */
export const PEST_CONTROL_PROTECTION_DAYS = 25;
/** Crops left past this many days after the harvest window fail entirely. */
export const OVERRIPE_FAIL_DAYS = 30;

/** Transport: paise per kg per km by hired lorry. */
export const TRANSPORT_PAISE_PER_KG_KM = 4;

/** Selling land back to the state (delisting not counted) recovers this fraction of base price. */
export const LAND_SELL_TO_STATE_FRACTION = 0.8;

/** Hard cap of commands an AI company may submit in one game day. */
export const AI_MAX_ACTIONS_PER_DAY = 4;
