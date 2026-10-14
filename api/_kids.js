// /api/kids logic: the birthday question and the parent PIN for Kids Mode.
// The age group is worked out from the birthday every time, so people move up on their own when they turn 13 or 18.
//  - Under 13: can't use Orbs.
//  - 13 to 17: Kids Mode is on and locked (nobody can turn it off).
//  - 18+: Kids Mode is optional, and turning it off needs the PIN that was set when it was turned on.
import { scryptSync, randomBytes, timingSafeEqual } from "node:crypto";
import { allowance, publicPlan, testSub } from "./_plans.js";
import { isAdmin, usageState, publicUsage } from "./_limits.js";

const MAX_FAILS = 5, LOCK_MS = 15 * 60 * 1000;

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}
// A safe hint for why a sign-in token was refused (for setup problems)
function tokenProblem(e) {
  const c = String((e && (e.code || e.message)) || "");
  if (/project|aud/i.test(c)) return "the service account is from a different Firebase project";
  if (/expired/i.test(c)) return "sign-in expired, refresh the page";
  return "sign-in couldn't be checked";
}
const hashPin = (pin, salt) => scryptSync(pin, salt, 32).toString("hex");

// Accounts made before birthdays were asked count as born on these days.
const LEGACY_BDAY = { adult: "2008-01-01", teen: "2013-01-01" };
// "YYYY-MM-DD" -> { y, m, d }, or null if it isn't a real date
export function parseBday(s) {
  const x = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ""));
  if (!x) return null;
  const y = +x[1], m = +x[2], d = +x[3], t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? { y, m, d } : null;
}
export function yearsOld(b, nowMs) {
  const n = new Date(nowMs), nm = n.getUTCMonth() + 1;
  return n.getUTCFullYear() - b.y - (nm < b.m || (nm === b.m && n.getUTCDate() < b.d) ? 1 : 0);
}
const groupOf = (a) => (a >= 18 ? "adult" : a >= 13 ? "teen" : "under13");
// Adds the up-to-date age group (and, for under 13, the day they can come back)
export function withAge(k, nowMs = Date.now()) {
  if (!k) return k;
  const bday = k.bday || LEGACY_BDAY[k.age], b = parseBday(bday);
  if (!b) return k; // old under-13 accounts have no birthday, so they stay blocked
  const age = groupOf(yearsOld(b, nowMs)), out = { ...k, age, bday };
  if (k.age === "teen" && age === "adult" && !k.pinHash) out.on = false; // just turned 18: Kids Mode comes off
  if (age === "under13") out.unlock = new Date(Date.UTC(b.y + 13, b.m - 1, b.d)).toISOString().slice(0, 10);
  else delete out.unlock;
  return out;
}

export function publicState(raw, env = {}, nowMs = Date.now()) {
  const k = withAge(raw, nowMs);
  return {
    unlock: k?.unlock || null,
    age: k?.age || null,
    on: env.KIDS_MODE === "all" || !!k?.on || k?.age === "teen",
    locked: k?.age === "teen" || env.KIDS_MODE === "all",
    blocked: k?.age === "under13",
    forcedForAll: env.KIDS_MODE === "all",
  };
}

export function makeKidsHandler({ verifyToken, getKids, setKids, getConfig = async () => null, getUsage = async () => null, getSub = async () => null, env: baseEnv = process.env, now = () => Date.now() }) {
  return async function POST(request) {
    const m = (request.headers.get("authorization") || "").match(/^Bearer ([\w.-]+)$/);
    if (!m) return json(401, { error: "unauthenticated" });
    let user;
    try { user = await verifyToken(m[1]); } catch (e) { if (e && e.setup) throw e; return json(401, { error: "unauthenticated", why: tokenProblem(e) }); }
    if (!user?.uid) return json(401, { error: "unauthenticated" });
    let body;
    try { body = await request.json(); } catch { return json(400, { error: "bad_request" }); }
    const k = withAge((await getKids(user.uid)) || {}, now());
    const { action } = body || {};
    // "Kids Mode for everyone" can be switched on in the admin panel too
    let cfg = null; try { cfg = await getConfig(); } catch {}
    const env = cfg && cfg.kidsForAll === true ? { ...baseEnv, KIDS_MODE: "all" } : baseEnv;

    if (action === "status") {
      // Their plan and how much of today's and this week's usage is gone (percentages only), so the page can show it before the first message
      let sub = null; try { sub = await getSub(user.uid); } catch {}
      const owner = isAdmin(user, env), viewAs = owner ? (k.viewAs || "owner") : null;
      const a = allowance({ sub, cfg, env, user, viewAs });
      const shownSub = owner && viewAs !== "owner" ? testSub(viewAs) : sub;
      const limits = { day: a.day, week: a.week, dayKey: a.dayKey, weekKey: a.weekKey };
      let doc = null; try { doc = await getUsage(user.uid); } catch {}
      const usage = publicUsage(usageState(doc, limits, now()));
      const bdayChange = !!k.age && (owner || (k.age !== "under13" && !(k.bdayChanges >= 1)));
      return json(200, { ...publicState(k, env, now()), bday: k.bday || null, bdayChange, banned: !!k.banned, web: !(cfg && cfg.webSearch === false), webPerDay: a.searches, freeWebPerDay: cfg && Number.isInteger(cfg.searchesPerUser) ? cfg.searchesPerUser : 5, usage,
        plan: publicPlan(shownSub), billing: !!env.STRIPE_SECRET_KEY, owner, viewAs, memory: a.memory && !publicState(k, env).on });
    }

    if (action === "age") {
      // First time: anyone. After that: one change each (none if under 13), as many as the site owner likes.
      if (k.age && !isAdmin(user, env)) {
        if (k.age === "under13") return json(409, { error: "age_already_set", ...publicState(k, env, now()) });
        if (k.bdayChanges >= 1) return json(409, { error: "change_used", ...publicState(k, env, now()) });
      }
      const b = parseBday(body.bday), years = b ? yearsOld(b, now()) : -1;
      if (!b || years < 0 || years > 120) return json(400, { error: "bad_birthday" });
      const age = groupOf(years);
      const next = { ...k, age, bday: body.bday, on: age === "teen" || (!!k.on && !!k.pinHash), setAt: new Date(now()).toISOString() };
      delete next.unlock;
      if (k.age) next.bdayChanges = (k.bdayChanges || 0) + 1;
      await setKids(user.uid, next);
      return json(200, publicState(next, env, now()));
    }

    if (action === "on" || action === "off") {
      if (!k.age) return json(403, { error: "age_required" });
      if (k.age !== "adult") return json(403, { error: "locked", ...publicState(k, env) });
      const pin = String(body.pin || "");
      if (!/^\d{4,8}$/.test(pin)) return json(400, { error: "bad_pin" });
      if (action === "on") {
        if (k.on) return json(200, publicState(k, env));
        const salt = randomBytes(16).toString("hex");
        const next = { ...k, on: true, salt, pinHash: hashPin(pin, salt), fails: 0, lockUntil: 0 };
        await setKids(user.uid, next);
        return json(200, publicState(next, env));
      }
      if (!k.on) return json(200, publicState(k, env, now()));
      if (k.lockUntil && now() < k.lockUntil) return json(429, { error: "too_many_tries", retryAt: k.lockUntil });
      const good = k.pinHash && k.salt && timingSafeEqual(Buffer.from(hashPin(pin, k.salt), "hex"), Buffer.from(k.pinHash, "hex"));
      if (!good) {
        const fails = (k.fails || 0) + 1;
        const lockUntil = fails >= MAX_FAILS ? now() + LOCK_MS : 0;
        await setKids(user.uid, { ...k, fails: fails >= MAX_FAILS ? 0 : fails, lockUntil });
        return json(403, { error: lockUntil ? "too_many_tries" : "wrong_pin", triesLeft: lockUntil ? 0 : MAX_FAILS - fails });
      }
      const next = { ...k, on: false, pinHash: null, salt: null, fails: 0, lockUntil: 0 };
      await setKids(user.uid, next);
      return json(200, publicState(next, env));
    }
    return json(400, { error: "bad_request" });
  };
}
