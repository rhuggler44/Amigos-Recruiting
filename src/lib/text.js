import { hash32 } from './crypto.js';

export const STATE_NAMES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut',
  DE: 'Delaware', DC: 'D.C.', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana',
  IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts',
  MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada',
  NH: 'New Hampshire', NJ: 'New Jersey', NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', PR: 'Puerto Rico', RI: 'Rhode Island',
  SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming', GU: 'Guam', VI: 'U.S. Virgin Islands',
};

const NAME_TO_CODE = Object.fromEntries(Object.entries(STATE_NAMES).map(([k, v]) => [v.toUpperCase(), k]));

export function normalizeState(s) {
  const v = String(s || '').trim().toUpperCase();
  if (!v) return '';
  if (STATE_NAMES[v]) return v;
  return NAME_TO_CODE[v] || v.slice(0, 20);
}

const SMALL_WORDS = new Set(['and', 'of', 'the', 'for', 'at', 'by', 'in', 'on', 'de', 'la', 'del', 'y']);
const KEEP_UPPER = new Set(['LLC', 'LLP', 'LP', 'USA', 'US', 'II', 'III', 'IV', 'BBQ', 'RV', 'KOA', 'DBA', 'JV']);

export function titleCase(s) {
  return String(s || '').trim().toLowerCase().split(/(\s+|-|\/)/).map((w, i) => {
    if (!w.trim() || w === '-' || w === '/') return w;
    const up = w.toUpperCase().replace(/[.,]/g, '');
    if (KEEP_UPPER.has(up)) return w.toUpperCase();
    if (i > 0 && SMALL_WORDS.has(w)) return w;
    if (/^mc[a-z]/.test(w)) return 'Mc' + w[2].toUpperCase() + w.slice(3);
    if (/^o'[a-z]/.test(w)) return "O'" + w[2].toUpperCase() + w.slice(3);
    return w.charAt(0).toUpperCase() + w.slice(1);
  }).join('');
}

/** Turn "GREEN ACRES LANDSCAPING, LLC" into "Green Acres Landscaping" for natural-sounding copy. */
export function friendlyCompany(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  s = s.replace(/\s+(d\/?b\/?a|dba)\s+.*$/i, '');
  s = s.replace(/[,.]?\s+(l\.?l\.?c\.?|inc\.?|incorporated|corp\.?|corporation|co\.?|company|ltd\.?|l\.?p\.?|llp|pllc|p\.?c\.?)\s*$/i, '');
  s = s.replace(/[,.]?\s+(l\.?l\.?c\.?|inc\.?|corp\.?)\s*$/i, '');
  s = s.replace(/[,\s]+$/, '');
  const isShouting = s === s.toUpperCase() || s === s.toLowerCase();
  return isShouting ? titleCase(s) : s;
}

export function friendlyFirstName(raw) {
  const s = String(raw || '').trim().split(/\s+/)[0] || '';
  if (!/^[a-zà-ÿ'.-]{2,}$/i.test(s)) return '';
  return titleCase(s);
}

// --- Industry classification (from NAICS code, SOC code/title, and job title) ---

// Order matters: NAICS prefixes are checked first (most reliable), then job-title keywords.
const INDUSTRY_RULES = [
  ['landscaping', /landscap|lawn|grounds ?keep|tree trim|arborist|irrigation|golf course|turf/i, ['56173']],
  ['hospitality', /hotel|motel|resort|housekeep|maid|cook|dishwash|server|waiter|waitress|food prep|restaurant|lodging|kitchen|bartend|front desk|\bski\b|amusement|recreation|carnival|concession|\bcamp\b|lifeguard/i, ['721', '722', '7131', '7139']],
  ['seafood', /seafood|crab|fish|shellfish|oyster|shrimp|crawfish|meat|poultry/i, ['3117', '3116']],
  ['agriculture', /farm|agricult|crop|harvest|orchard|greenhouse|livestock|dairy|ranch|nursery|vegetable|fruit|tobacco|sheep|cattle|beekeep|grain/i, ['111', '112', '115']],
  ['construction', /construct|carpent|concrete|mason|roof|framer|drywall|painter|cement|brick|pipelayer/i, ['23']],
  ['manufacturing', /manufactur|factory|assembl|machine|welder|production|forest|logger|tree planter|reforest|packer|packag/i, ['3', '113']],
];

export const INDUSTRY_LABELS = {
  landscaping: 'Landscaping & grounds',
  agriculture: 'Agriculture & farms',
  hospitality: 'Hospitality & food service',
  construction: 'Construction',
  manufacturing: 'Manufacturing & forestry',
  seafood: 'Seafood & food processing',
  other: 'Other / general labor',
};

export function classifyIndustry({ naics = '', soc = '', title = '', visaType = '' }) {
  const n = String(naics || '').replace(/\D/g, '');
  const text = `${soc} ${title}`;
  if (n) {
    for (const [key, , prefixes] of INDUSTRY_RULES) if (prefixes.some((p) => n.startsWith(p))) return key;
  }
  for (const [key, re] of INDUSTRY_RULES) if (re.test(text)) return key;
  if (/2a/i.test(visaType)) return 'agriculture';
  return 'other';
}

// --- Merge fields and spintax ---

/**
 * Replace {{field}} / {{field|fallback}} with contact/context values, then resolve {a|b|c} spintax.
 * `seed` keeps spintax choices stable for a given recipient so previews match what gets sent.
 */
export function renderTemplate(text, vars, seed = '') {
  if (!text) return '';
  let out = String(text).replace(/\{\{\s*([a-z_]+)\s*(?:\|([^}]*))?\}\}/gi, (_, name, fallback) => {
    const v = vars[name.toLowerCase()];
    return v != null && String(v).trim() !== '' ? String(v) : (fallback ?? '').trim();
  });
  let n = 0;
  // Innermost-first so nested spintax works.
  for (let guard = 0; guard < 20 && /\{[^{}]*\|[^{}]*\}/.test(out); guard++) {
    out = out.replace(/\{([^{}]*\|[^{}]*)\}/g, (_, body) => {
      const options = body.split('|');
      return options[hash32(`${seed}:${n++}:${body}`) % options.length];
    });
  }
  return out;
}

export function pickVariant(list, seed) {
  const items = list.filter((s) => s && s.trim());
  if (!items.length) return '';
  return items[hash32(seed) % items.length].trim();
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
