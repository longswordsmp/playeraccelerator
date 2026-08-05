'use strict';

/**
 * Content analysis primitives.
 *
 * Pure functions with no Discord or database dependency: they take text and
 * return findings. That makes every rule independently testable and keeps the
 * hot message path free of I/O.
 */

const { compilePattern, escapeRegex } = require('../utils/validators');

// ── Word lists ───────────────────────────────────────────────────────────────

/**
 * Baseline profanity list. Deliberately short and mild: the goal is a sensible
 * default for a professional server, not an exhaustive censor. Studios extend
 * it through `/config automod words`.
 */
const PROFANITY = [
  'fuck', 'shit', 'bitch', 'bastard', 'asshole', 'dickhead', 'cunt',
  'wanker', 'motherfucker', 'prick', 'twat',
];

/**
 * Slurs are handled separately with a harsher default punishment. The list is
 * intentionally not spelled out in source; operators add the terms they want
 * blocked via configuration. The two entries below are unambiguous, widely
 * recognised hate terms with no legitimate use in a business server.
 */
const SLUR_PATTERNS = [
  /\bf[a4]gg?[o0]t?s?\b/i,
  /\bn[i1]gg[e3a4]r?s?\b/i,
  /\br[e3]t[a4]rd(?:ed|s)?\b/i,
  /\btr[a4]nn(?:y|ie)s?\b/i,
];

/** Known phishing / scam patterns seen in Discord campaigns. */
const SCAM_PATTERNS = [
  /free\s+(?:discord\s+)?nitro/i,
  /nitro\s+(?:gift|giveaway|generator)/i,
  /steam\s+(?:gift|community)\s+.{0,20}(?:free|giveaway)/i,
  /claim\s+your\s+(?:free\s+)?(?:nitro|gift|reward|prize)/i,
  /(?:airdrop|whitelist)\s+.{0,30}(?:connect|wallet|metamask)/i,
  /verify\s+your\s+(?:wallet|account)\s+.{0,20}(?:here|now|link)/i,
  /(?:i|we)\s+(?:will\s+)?(?:pay|give)\s+.{0,20}\$\d+.{0,20}(?:dm|message)\s+me/i,
  /crypto\s+(?:doubl|invest|profit)/i,
  /\b(?:seed|recovery)\s+phrase\b/i,
];

/** Domains that host credential-stealing or token-grabbing payloads. */
const MALICIOUS_DOMAIN_PATTERNS = [
  /disc[o0]rd(?:app)?[-.](?:gift|nitro|give|airdrop|claim|app-?login)/i,
  /(?:discordc|discrod|discordd|dlscord|discorcl|dicord|discord-)[a-z0-9-]*\.(?:com|net|org|ru|xyz|gift|info|top|cc)/i,
  /steamcommunity[-.](?:com|net)\.[a-z]{2,}/i,
  /\b(?:grabber|token-?log|nitro-?gen)\b/i,
  /\.(?:ru|tk|ml|ga|cf|gq|xyz|top|click|zip|mov)\/.*(?:token|login|verify|nitro|gift)/i,
];

/** URL shorteners — not malicious themselves, but they hide the destination. */
const SHORTENERS = new Set([
  'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'ow.ly', 'is.gd', 'buff.ly',
  'rebrand.ly', 'cutt.ly', 'shorturl.at', 'rb.gy', 'tiny.cc', 'lnkd.in',
  's.id', 'v.gd', 'shorte.st', 'adf.ly', 'bc.vc', 'clck.ru', 'gg.gg',
]);

/** Hosts that are always allowed, even when a whitelist is configured. */
const ALWAYS_ALLOWED = new Set([
  'discord.com', 'discordapp.com', 'discord.gg', 'cdn.discordapp.com', 'media.discordapp.net',
  'github.com', 'gitlab.com', 'raw.githubusercontent.com', 'gist.github.com',
  'youtube.com', 'youtu.be', 'imgur.com', 'i.imgur.com',
  'stackoverflow.com', 'developer.mozilla.org', 'npmjs.com',
]);

/** Discord invite detection, including every vanity host. */
const INVITE_PATTERN = /(?:https?:\/\/)?(?:www\.)?(?:discord(?:app)?\.com\/invite|discord\.gg|discord\.me|dsc\.gg|invite\.gg|disboard\.org\/server\/join)\/([a-z0-9-_]+)/gi;

/** Advertising language paired with a link is a strong self-promotion signal. */
const ADVERT_PATTERNS = [
  /\b(?:join|check\s+out|visit)\s+(?:my|our)\s+(?:server|discord|community|shop|store)\b/i,
  /\b(?:dm|pm)\s+me\s+(?:for|if)\b/i,
  /\bcheapest\s+(?:prices?|deals?)\b/i,
  /\b(?:selling|buying)\s+.{0,20}(?:accounts?|boosts?|followers?)\b/i,
  /\bpromo\s*code\b/i,
];

// ── Analysers ────────────────────────────────────────────────────────────────

/**
 * Normalise text to defeat simple filter evasion: lookalike characters, spaced
 * out letters, repeated characters.
 * @param {string} value
 */
function normalise(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining marks (accents, and the tail of zalgo).
    .replace(/[̀-ͯ]/g, '')
    // Common leetspeak substitutions.
    .replace(/[@4]/g, 'a')
    .replace(/[3]/g, 'e')
    .replace(/[1!|]/g, 'i')
    .replace(/[0]/g, 'o')
    .replace(/[$5]/g, 's')
    .replace(/[7]/g, 't')
    // Collapse separators used to break words up: f.u.c.k / f u c k / f-u-c-k
    .replace(/[\s._\-*~`]+/g, ' ')
    .trim();
}

/** Collapse a word split by separators, so "f u c k" reads as "fuck". */
function collapsed(value) {
  return normalise(value).replace(/\s+/g, '');
}

/** Percentage of alphabetic characters that are uppercase. */
function capsRatio(text) {
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length === 0) return 0;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return Math.round((upper / letters.length) * 100);
}

/** Percentage of characters that are neither letters, digits nor whitespace. */
function symbolRatio(text) {
  if (!text.length) return 0;
  const symbols = text.replace(/[\p{L}\p{N}\s]/gu, '').length;
  return Math.round((symbols / text.length) * 100);
}

/** Count custom and unicode emoji. */
function countEmoji(text) {
  const custom = (text.match(/<a?:\w+:\d+>/g) ?? []).length;
  const unicode = (text.match(/\p{Extended_Pictographic}/gu) ?? []).length;
  return custom + unicode;
}

/** Zalgo text is characterised by dense combining marks. */
function isZalgo(text) {
  const marks = (text.match(/[̀-ͯ҃-҉᪰-᫿᷀-᷿⃐-⃰]/g) ?? []).length;
  if (marks < 6) return false;
  const base = text.replace(/[̀-ͯ҃-҉᪰-᫿᷀-᷿⃐-⃰]/g, '').length || 1;
  return marks / base > 0.35;
}

/**
 * Ratio of characters outside the Latin/common ranges — flags text made of
 * mathematical alphanumerics or full-width lookalikes used to evade filters.
 */
function unicodeAbuseRatio(text) {
  if (!text.length) return 0;
  const suspicious = (text.match(/[ᴀ-ᵿᵀ0-ᵿf！-～℀-⅏]/gu) ?? []).length;
  return Math.round((suspicious / text.length) * 100);
}

/** Consecutive newline runs. */
function maxNewlineRun(text) {
  const runs = text.match(/\n+/g) ?? [];
  return runs.reduce((max, run) => Math.max(max, run.length), 0);
}

/**
 * Detect banned words.
 * @param {string} text
 * @param {{ words?: string[], patterns?: string[], allowed?: string[] }} lists
 * @returns {{ matched: string[] }}
 */
function findBannedWords(text, { words = [], patterns = [], allowed = [] } = {}) {
  const normalised = normalise(text);
  const squashed = collapsed(text);
  const allowSet = new Set(allowed.map((word) => normalise(word)));
  const matched = [];

  for (const word of words) {
    const needle = normalise(word);
    if (!needle || allowSet.has(needle)) continue;
    const boundary = new RegExp(`\\b${escapeRegex(needle)}\\b`, 'i');
    if (boundary.test(normalised) || squashed.includes(needle.replace(/\s+/g, ''))) {
      matched.push(word);
    }
  }

  for (const source of patterns) {
    const regex = compilePattern(source);
    if (regex?.test(text)) matched.push(source);
  }

  return { matched };
}

/** Detect slurs using the built-in patterns. */
function findSlurs(text) {
  const candidates = [text, normalise(text), collapsed(text)];
  return SLUR_PATTERNS.filter((pattern) => candidates.some((candidate) => pattern.test(candidate)));
}

/** Detect scam / phishing language. */
function findScamLanguage(text) {
  return SCAM_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
}

/** Detect advertising language. */
function findAdvertising(text) {
  return ADVERT_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => pattern.source);
}

/** Extract Discord invite codes. */
function findInvites(text) {
  return [...String(text ?? '').matchAll(INVITE_PATTERN)].map((match) => match[1]);
}

/**
 * Classify a URL.
 * @param {string} rawUrl
 * @param {{ whitelist?: string[], blacklist?: string[], blockShorteners?: boolean }} [options]
 * @returns {{ url: string, host: string, verdict: 'allowed'|'blocked'|'suspicious'|'malicious', reason: string }}
 */
function classifyUrl(rawUrl, { whitelist = [], blacklist = [], blockShorteners = false } = {}) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { url: rawUrl, host: '', verdict: 'suspicious', reason: 'Malformed URL' };
  }

  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  const matchesHost = (list) => list.some((entry) => {
    const clean = String(entry).toLowerCase().replace(/^\*?\.?/, '').replace(/^www\./, '');
    return host === clean || host.endsWith(`.${clean}`);
  });

  if (matchesHost(blacklist)) return { url: rawUrl, host, verdict: 'blocked', reason: 'Domain is blacklisted' };

  for (const pattern of MALICIOUS_DOMAIN_PATTERNS) {
    if (pattern.test(rawUrl)) return { url: rawUrl, host, verdict: 'malicious', reason: 'Matches a known malicious pattern' };
  }

  // Punycode homographs are a classic impersonation vector.
  if (host.includes('xn--')) return { url: rawUrl, host, verdict: 'suspicious', reason: 'Internationalised domain (possible homograph)' };

  if (blockShorteners && SHORTENERS.has(host)) {
    return { url: rawUrl, host, verdict: 'suspicious', reason: 'URL shortener hides the destination' };
  }

  if (ALWAYS_ALLOWED.has(host)) return { url: rawUrl, host, verdict: 'allowed', reason: 'Trusted domain' };

  if (whitelist.length && !matchesHost(whitelist)) {
    return { url: rawUrl, host, verdict: 'blocked', reason: 'Domain is not on the allow list' };
  }

  // Direct executable downloads have no place in a support server.
  if (/\.(?:exe|scr|bat|cmd|com|pif|vbs|js|jar|msi|apk|dll|ps1)(?:$|\?)/i.test(parsed.pathname)) {
    return { url: rawUrl, host, verdict: 'malicious', reason: 'Direct executable download' };
  }

  // An IP literal instead of a hostname is a strong malware signal.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return { url: rawUrl, host, verdict: 'suspicious', reason: 'Raw IP address instead of a domain' };
  }

  return { url: rawUrl, host, verdict: 'allowed', reason: '' };
}

/**
 * Fake-Nitro scam detection: a gift-flavoured message carrying a non-Discord
 * link is the canonical shape of this attack.
 * @param {string} text
 */
function isFakeNitro(text) {
  const giftLanguage = /(?:nitro|gift|giveaway|boost)/i.test(text);
  if (!giftLanguage) return false;
  const urls = String(text).match(/https?:\/\/[^\s]+/gi) ?? [];
  return urls.some((url) => {
    const classified = classifyUrl(url);
    return classified.verdict !== 'allowed' || !/discord(?:app)?\.(?:com|gg)$/.test(classified.host);
  });
}

module.exports = {
  PROFANITY,
  SLUR_PATTERNS,
  SCAM_PATTERNS,
  SHORTENERS,
  ALWAYS_ALLOWED,
  normalise,
  collapsed,
  capsRatio,
  symbolRatio,
  countEmoji,
  isZalgo,
  unicodeAbuseRatio,
  maxNewlineRun,
  findBannedWords,
  findSlurs,
  findScamLanguage,
  findAdvertising,
  findInvites,
  classifyUrl,
  isFakeNitro,
};
