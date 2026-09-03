/**
 * Geography stripping is the single most dangerous step in normalization.
 * A generic "remove the words before the province code" rule is greedy enough
 * to reduce SQ *BLUE DOOR COFFEE TORONTO ON to BLUE. So cities come off by
 * name, from a list, and never reduce a merchant string to nothing.
 */
export const PROVINCE_CODES = [
  "ON", "QC", "BC", "AB", "MB", "SK", "NS", "NB", "NL", "PE", "YT", "NT", "NU",
] as const;

export const CITIES: readonly string[] = [
  // ON
  "TORONTO", "NORTH YORK", "SCARBOROUGH", "ETOBICOKE", "EAST YORK", "MISSISSAUGA",
  "BRAMPTON", "VAUGHAN", "CONCORD", "MARKHAM", "RICHMOND HILL", "OAKVILLE",
  "BURLINGTON", "MILTON", "PICKERING", "AJAX", "WHITBY", "OSHAWA", "NEWMARKET",
  "AURORA", "HAMILTON", "LONDON", "KITCHENER", "WATERLOO", "CAMBRIDGE", "GUELPH",
  "BARRIE", "KINGSTON", "WINDSOR", "SUDBURY", "THUNDER BAY", "OTTAWA", "NEPEAN",
  "KANATA", "NIAGARA FALLS", "ST CATHARINES", "BRANTFORD", "PETERBOROUGH", "SARNIA",
  // QC
  "MONTREAL", "LAVAL", "LONGUEUIL", "GATINEAU", "QUEBEC", "SHERBROOKE", "BROSSARD",
  "TROIS RIVIERES", "SAINT LAURENT", "VERDUN", "LEVIS",
  // BC
  "VANCOUVER", "BURNABY", "SURREY", "RICHMOND", "COQUITLAM", "LANGLEY", "DELTA",
  "ABBOTSFORD", "VICTORIA", "KELOWNA", "NANAIMO", "KAMLOOPS", "NORTH VANCOUVER",
  // Prairies
  "CALGARY", "EDMONTON", "RED DEER", "LETHBRIDGE", "AIRDRIE", "WINNIPEG",
  "SASKATOON", "REGINA",
  // Atlantic + North
  "HALIFAX", "DARTMOUTH", "MONCTON", "FREDERICTON", "SAINT JOHN", "ST JOHNS",
  "CHARLOTTETOWN", "WHITEHORSE", "YELLOWKNIFE", "IQALUIT",
];

const PROV_RE = new RegExp(`\\s+(${PROVINCE_CODES.join("|")})\\s*$`);
const CITY_RE = new RegExp(`\\s+(${CITIES.join("|")})\\s*$`);

/**
 * Remove trailing province then trailing city, up to two passes for two-word
 * names. Reverts if it would empty the string.
 */
export function stripGeography(input: string): string {
  const before = input.trim();
  let s = before.replace(PROV_RE, "");
  for (let pass = 0; pass < 2; pass++) {
    const next = s.replace(CITY_RE, "");
    if (next === s) break;
    if (!next.trim()) break;
    s = next;
  }
  s = s.trim();
  return s || before;
}
