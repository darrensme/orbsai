// GET /api/geo — which country is the visitor in, and roughly how many local dollars-worth is $1?
// Display only: the page shows "about £7.80" under the dollar price. Stripe works out the real price at checkout.
// Vercel sets the x-vercel-ip-country header itself, so a visitor can't fake it with a header (a VPN can still move them).
// The rates below are approximate. Nudge them now and then; nothing breaks if they drift a little.

export const RATES = {   // 1 US dollar = ...
  GBP: 0.78, EUR: 0.92, CAD: 1.38, AUD: 1.52, NZD: 1.66, JPY: 150, KRW: 1380, INR: 84, MXN: 18.5,
  BRL: 5.5, SGD: 1.33, CHF: 0.88, SEK: 10.5, NOK: 10.7, DKK: 6.9, PLN: 4.0, HKD: 7.8,
};

const EURO = "DE FR ES IT NL BE AT IE PT FI GR LU SK SI EE LV LT MT CY HR".split(" ");
const BY_COUNTRY = { GB: "GBP", CA: "CAD", AU: "AUD", NZ: "NZD", JP: "JPY", KR: "KRW", IN: "INR", MX: "MXN", BR: "BRL", SG: "SGD", CH: "CHF", SE: "SEK", NO: "NOK", DK: "DKK", PL: "PLN", HK: "HKD" };
for (const c of EURO) BY_COUNTRY[c] = "EUR";

// -> { country, currency, rate } ; currency is "USD" and rate 1 when we don't have a local one
export function geoFor(country) {
  const cc = /^[A-Za-z]{2}$/.test(String(country || "")) ? String(country).toUpperCase() : "";
  const currency = BY_COUNTRY[cc] || "USD";
  return { country: cc, currency, rate: currency === "USD" ? 1 : RATES[currency] };
}

export async function GET(request) {
  const g = geoFor(request.headers.get("x-vercel-ip-country"));
  return new Response(JSON.stringify(g), {
    // Different for every visitor, so the browser may keep it a little but the CDN must not share it
    headers: { "content-type": "application/json", "cache-control": "private, max-age=300", vary: "x-vercel-ip-country" },
  });
}
