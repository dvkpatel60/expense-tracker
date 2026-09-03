import type { CategoryId, CategoryRule } from "./types.js";

export const CATEGORIES: readonly CategoryId[] = [
  "Groceries", "Dining", "Coffee", "Alcohol", "Transport", "Fuel", "Housing",
  "Utilities", "Telecom", "Subscriptions", "Shopping", "Household", "Health",
  "Travel", "Entertainment", "Cash", "Fees", "Income", "Transfer",
  "Reimbursement", "Uncategorized",
];

/** Rules are data, not code. They serialize into the store, the user can edit
 *  and reorder them, and an override on a transaction writes a user rule that
 *  outranks the builtins forever after. */
function builtin(id: string, pattern: string, categoryId: CategoryId, priority = 100): CategoryRule {
  return { id: `builtin:${id}`, pattern, flags: "i", categoryId, source: "builtin", priority };
}

export const BUILTIN_RULES: readonly CategoryRule[] = [
  builtin("grocery-chains", "LOBLAW|NO FRILLS|\\bMETRO\\b|SOBEYS|FRESHCO|FARM BOY|LONGO|INDEPENDENT GROCER|\\bT&T\\b|SUPERSTORE|ZEHRS|\\bIGA\\b|PROVIGO|SAVE ON FOODS|WHOLE FOODS", "Groceries", 120),
  builtin("bigbox", "COSTCO|WALMART", "Groceries", 90),
  builtin("coffee", "TIM HORTONS|STARBUCKS|SECOND CUP|BALZAC|\\bCOFFEE\\b|\\bCAFE\\b|ESPRESSO|ROASTERS", "Coffee", 130),
  builtin("delivery", "UBER EATS|SKIPTHEDISHES|\\bSKIP\\b|DOORDASH|FOODORA|RITUAL", "Dining", 140),
  builtin("restaurants", "RESTAURANT|PIZZA|SUSHI|\\bBAR\\b|\\bPUB\\b|GRILL|KITCHEN|TAQUERIA|BISTRO|BIERHALLE|BREWERY|TAVERN|A&W|HARVEY|SWISS CHALET|MCDONALD|SUBWAY|CHIPOTLE|OSTERIA|TRATTORIA", "Dining", 110),
  builtin("alcohol", "\\bLCBO\\b|BEER STORE|\\bSAQ\\b|WINE RACK|LIQUOR|BC LIQUOR", "Alcohol", 130),
  builtin("transit", "PRESTO|\\bTTC\\b|GO TRANSIT|\\bSTM\\b|TRANSLINK|VIA RAIL|\\bOC TRANSPO\\b", "Transport", 130),
  builtin("rideshare", "\\bUBER\\b(?! EATS)|\\bLYFT\\b|BEECK TAXI|\\bTAXI\\b", "Transport", 100),
  builtin("parking", "GREEN P|IMPARK|PRECISE PARK|\\bPARKING\\b", "Transport", 120),
  builtin("fuel", "PETRO-?CAN|\\bESSO\\b|\\bSHELL\\b|HUSKY|ULTRAMAR|CHEVRON|MOBIL|CIRCLE K|CANADIAN TIRE GAS", "Fuel", 120),
  builtin("utilities", "HYDRO|ENBRIDGE|ENERGIR|\\bEPCOR\\b|\\bFORTIS\\b|UTILITIES", "Utilities", 120),
  builtin("telecom", "ROGERS|\\bBELL\\b|TELUS|FREEDOM MOBILE|KOODO|\\bFIDO\\b|VIRGIN PLUS|CHATR|TEKSAVVY|\\bLUCKY MOBILE\\b", "Telecom", 120),
  builtin("subscriptions", "NETFLIX|SPOTIFY|CRAVE|DISNEY|\\bAPPLE\\b|GOOGLE|ADOBE|OPENAI|ANTHROPIC|PATREON|AUDIBLE|SUBSCRIPTION", "Subscriptions", 110),
  builtin("shopping", "AMAZON|BEST BUY|INDIGO|WINNERS|MARSHALLS|SIMONS|HUDSONS BAY|UNIQLO|ARITZIA|ROOTS|LULULEMON|SPORT CHEK", "Shopping", 100),
  builtin("household", "CANADIAN TIRE|HOME DEPOT|\\bRONA\\b|\\bLOWE\\b|\\bIKEA\\b|HOME HARDWARE|STRUCTUBE|WAYFAIR", "Household", 105),
  builtin("health", "SHOPPERS DRUG|REXALL|PHARMA|DENTAL|CLINIC|PHYSIO|JEAN COUTU|MEDICAL|OPTOMETR", "Health", 120),
  builtin("travel", "AIR CANADA|WESTJET|PORTER|EXPEDIA|AIRBNB|BOOKING|\\bHOTEL\\b|MARRIOTT|HILTON|FLAIR AIR", "Travel", 120),
  builtin("entertainment", "CINEPLEX|LANDMARK|TICKETMASTER|\\bSTEAM\\b|NINTENDO|PLAYSTATION|CONCERT|MUSEUM|\\bAGO\\b|\\bROM\\b", "Entertainment", 110),
  builtin("bankfees", "MONTHLY (ACCOUNT|PLAN) FEE|SERVICE CHARGE|OVERDRAFT|\\bNSF\\b|INTEREST CHARGE|FOREIGN (CURRENCY|EXCHANGE)|\\bATM FEE\\b|TRANSACTION FEE", "Fees", 140),
  builtin("income", "PAYROLL|DIRECT DEPOSIT|DEPOSIT PAY|\\bCRA\\b|EMPLOYER|\\bGST\\b REFUND", "Income", 140),
  builtin("housing", "\\bRENT\\b|LANDLORD|PROPERTY MGMT|MORTGAGE", "Housing", 130),
  builtin("cash", "\\bABM\\b|ATM W/?D|CASH WITHDRAWAL|WITHDRAWAL BRANCH", "Cash", 130),
  builtin("cardpayment", "PAYMENT - THANK YOU|VISA PAYMENT|MASTERCARD PAYMENT|CREDIT CARD PAYMENT|PAYMENT RECEIVED", "Transfer", 150),
];

export interface CategorizeInput {
  readonly merchantKey: string;
  readonly amount: number;
}

/** Highest priority match wins; ties break on rule order for determinism. */
export function categorize(
  input: CategorizeInput,
  rules: readonly CategoryRule[] = BUILTIN_RULES
): { categoryId: CategoryId; ruleId: string | null } {
  let best: CategoryRule | undefined;
  for (const rule of rules) {
    let re: RegExp;
    try {
      re = new RegExp(rule.pattern, rule.flags ?? "i");
    } catch {
      continue; // A malformed user rule must not break categorization.
    }
    if (!re.test(input.merchantKey)) continue;
    if (best === undefined || rule.priority > best.priority) best = rule;
  }
  if (best !== undefined) return { categoryId: best.categoryId, ruleId: best.id };
  return { categoryId: input.amount > 0 ? "Income" : "Uncategorized", ruleId: null };
}
