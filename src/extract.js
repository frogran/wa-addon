// src/extract.js

function extractPhones(text) {
  // Capture candidates: optional leading +, then digit or (, then 5–14 chars of
  // digits/spaces/parens/dashes/dots, ending on a digit.
  const raw = text.match(/\+?[\d(][\d\s()\-.]{5,14}\d/g) || [];
  return [...new Set(
    raw
      .map(s => s.replace(/[\s()\-.]/g, ''))   // normalise: strip separators
      .filter(s => /^\+?\d{7,15}$/.test(s))    // 7–15 digits (with optional leading +)
  )];
}

function extractEmails(text) {
  const raw = text.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
  return [...new Set(raw.map(s => s.toLowerCase()))];
}

module.exports = { extractPhones, extractEmails };
