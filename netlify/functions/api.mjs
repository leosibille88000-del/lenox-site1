import { getStore } from "@netlify/blobs";
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from "node:crypto";

const OWNER = "LENOX";
const TIKTOK = "leonox05";
const YOUTUBE = "lenoxofficiel1";
const TARIFS = { perOption: 1, min: 5, fee: 1, iacMonth: 3, iacSite: 10, vip: 10, trialDays: 7, vipIacDays: 30 };

const store = () => getStore({ name: "lenox", consistency: "strong" });
const now = () => new Date().toISOString();
const r2 = n => Math.round(n * 100) / 100;
const euro = n => Number(n).toFixed(2).replace(".", ",") + " €";

class Oops extends Error { constructor(msg, status = 400) { super(msg); this.status = status; } }
const fail = (msg, status) => { throw new Oops(msg, status); };

async function loadDb() {
  const db = (await store().get("db", { type: "json" })) || {};
  db.users ||= {};
  db.orders ||= [];
  db.coupons ||= { BIENVENUE: { code: "BIENVENUE", type: "percent", value: 50, maxUses: null, uses: 0, usedBy: [], expires: null, active: true, created: now() } };
  db.tarifs = { ...TARIFS, ...(db.tarifs || {}) };
  db.secret ||= randomBytes(32).toString("hex");
  return db;
}
const saveDb = db => store().setJSON("db", db);

// mots de passe et jetons de connexion
const hashPass = pass => { const salt = randomBytes(16).toString("hex"); return salt + ":" + scryptSync(pass, salt, 32).toString("hex"); };
const checkPass = (pass, saved) => {
  if (!saved) return false;
  const [salt, hash] = saved.split(":");
  const a = scryptSync(pass || "", salt, 32), b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
};
const sign = (db, body) => createHmac("sha256", db.secret).update(body).digest("base64url");
const makeToken = (db, pseudo, admin) => {
  const body = Buffer.from(JSON.stringify({ p: pseudo, a: !!admin, e: Date.now() + 60 * 864e5 })).toString("base64url");
  return body + "." + sign(db, body);
};
function who(db, token) {
  if (!token || !token.includes(".")) return null;
  const [body, sig] = token.split(".");
  if (sign(db, body) !== sig) return null;
  const t = JSON.parse(Buffer.from(body, "base64url").toString());
  if (t.e < Date.now()) return null;
  if (t.a) return t.p === OWNER && db.ownerPass ? { pseudo: OWNER, admin: true } : null;
  const u = db.users[String(t.p).toLowerCase()];
  return u ? { pseudo: u.pseudo, discord: u.discord, admin: false } : null;
}
const need = (u, admin) => {
  if (!u) fail("Connecte-toi d'abord.", 401);
  if (admin && !u.admin) fail("Réservé à l'admin.", 403);
};
const publicUser = ({ pass, ...x }) => x;

// prix, codes promo
const priceOf = (db, kind, options) => {
  const tf = db.tarifs;
  if (kind === "vip") return tf.vip;
  if (kind === "iacolor") return tf.iacMonth;
  if (kind === "iacsite") return tf.iacSite;
  return r2(Math.max(tf.min, new Set(options || []).size * tf.perOption) + tf.fee);
};
const couponProblem = c => {
  if (!c) return "Ce code n'existe pas.";
  if (!c.active) return "Ce code n'est plus actif.";
  if (c.expires && Date.now() > new Date(c.expires + "T23:59:59").getTime()) return "Ce code a expiré.";
  if (c.maxUses && c.uses >= c.maxUses) return "Ce code est épuisé : il n'en reste plus.";
  return null;
};
const couponLabel = c => c.type === "percent" ? "-" + c.value + " %" : "-" + euro(c.value);
const priceWith = (c, base) => {
  if (!c) return base;
  const t = c.type === "percent" ? base * (1 - c.value / 100) : base - c.value;
  return Math.max(0, r2(t));
};

const findOrder = (db, u, id) => {
  const o = db.orders.find(x => x.id === id);
  if (!o || (!u.admin && o.user !== u.pseudo)) fail("Demande introuvable.");
  return o;
};
const iacOf = (db, pseudo) => {
  const x = db.users[String(pseudo).toLowerCase()];
  const iac = (x && x.iac) || {};
  const until = Math.max(iac.trialEnd ? Date.parse(iac.trialEnd) : 0, iac.paidUntil ? Date.parse(iac.paidUntil) : 0);
  return { active: until > Date.now(), until: until ? new Date(until).toISOString() : null, trialUsed: !!iac.trialEnd, trialEnd: iac.trialEnd || null, paidUntil: iac.paidUntil || null };
};
const iacAdd = (db, pseudo, days) => {
  const x = db.users[String(pseudo).toLowerCase()];
  if (!x) fail("Compte introuvable.");
  x.iac ||= {};
  const base = Math.max(Date.now(), x.iac.paidUntil ? Date.parse(x.iac.paidUntil) : 0);
  x.iac.paidUntil = new Date(Math.max(Date.now(), base + days * 864e5)).toISOString();
};
const markPaid = (db, o) => {
  if (!o.paidAt && (o.kind === "iacolor" || o.kind === "vip")) iacAdd(db, o.user, o.kind === "vip" ? db.tarifs.vipIacDays : 30);
  o.status = "payée";
  o.paidAt = now();
  const c = o.coupon && db.coupons[o.coupon];
  if (c) { c.uses++; c.usedBy = [...(c.usedBy || []), o.user.toLowerCase()]; }
};
// abonnés lus directement sur TikTok et YouTube (gardés 10 min)
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const getPage = async url => {
  const res = await fetch(url, { headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9", Cookie: "SOCS=CAI; CONSENT=YES+1" }, signal: AbortSignal.timeout(6000) });
  return res.ok ? res.text() : "";
};
export const readNumber = txt => {
  const m = String(txt).replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i);
  if (!m) return null;
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[(m[2] || "").toUpperCase()] || 1;
  return Math.round(parseFloat(m[1]) * mult);
};
export const parseTiktok = html => {
  const m = html.match(/"followerCount":\s*(\d+)/);
  return m ? Number(m[1]) : null;
};
export const parseYoutube = html => {
  const m = html.match(/"subscriberCountText":\{[^}]*?"simpleText":"([^"]+)"/) || html.match(/"content":"([\d.,]+[KMB]?) subscribers?"/i) || html.match(/([\d.,]+[KMB]?) subscribers?/i);
  return m ? readNumber(m[1]) : null;
};
async function liveStats(db) {
  const live = db.live || {};
  if (live.at && Date.now() - live.at < 10 * 60e3) return { live, fresh: false };
  const [tt, yt] = await Promise.all([
    getPage("https://www.tiktok.com/@" + TIKTOK).then(parseTiktok).catch(() => null),
    getPage("https://www.youtube.com/@" + YOUTUBE + "?hl=en").then(parseYoutube).catch(() => null)
  ]);
  db.live = { tiktok: tt ?? live.tiktok ?? null, youtube: yt ?? live.youtube ?? null, ttOk: tt != null, ytOk: yt != null, at: Date.now() };
  return { live: db.live, fresh: true };
}

const pushMsg = (o, m) =>{ o.messages = (o.messages || []).concat({ ...m, at: now() }); };

const READ_ONLY = new Set(["config", "me", "quote", "chatGet", "proofGet", "adminData", "iacStatus", "stats", "recent", "ownerState", "licences", "payCreate"]);

async function handle(action, d, db) {
  const u = who(db, d.token);
  switch (action) {
    case "config":
      return { dice: db.dice || [], sitesDone: db.orders.filter(o => o.status === "terminée" && o.siteUrl).length + (db.sitesBase || 0), adminAvatar: db.adminAvatar || null, paypalClientId: null, tarifs: db.tarifs, examples: db.examples || null, timer: db.timer && db.timer.active ? db.timer : null, google: null, apple: null, discord: null };

    case "ownerState": return { hasPassword: !!db.ownerPass };

    case "register": {
      const pseudo = String(d.pseudo || "").trim();
      if (!/^[\w.-]{3,20}$/.test(pseudo)) fail("Pseudo : 3 à 20 caractères (lettres, chiffres, _ . -).");
      if (pseudo.toLowerCase() === OWNER.toLowerCase()) fail("Ce pseudo est réservé.");
      if (db.users[pseudo.toLowerCase()]) fail("Ce pseudo est déjà pris.");
      if (!String(d.discord || "").trim()) fail("Mets ton pseudo Discord.");
      if (String(d.password || "").length < 6) fail("Mot de passe : 6 caractères minimum.");
      db.users[pseudo.toLowerCase()] = { pseudo, discord: d.discord.trim().slice(0, 40), pass: hashPass(d.password), created: now() };
      return { token: makeToken(db, pseudo, false), user: { pseudo, discord: d.discord.trim(), admin: false } };
    }

    case "login": {
      const pseudo = String(d.pseudo || "").trim();
      const pass = String(d.password || "");
      if (pseudo.toLowerCase() === OWNER.toLowerCase()) {
        if (!db.ownerPass) {
          // première connexion : le mot de passe tapé devient celui du compte owner
          if (pass.length < 6) fail("Première connexion : choisis un mot de passe de 6 caractères minimum.");
          db.ownerPass = hashPass(pass);
          return { token: makeToken(db, OWNER, true), user: { pseudo: OWNER, admin: true, avatar: db.adminAvatar || null }, firstLogin: true };
        }
        if (!checkPass(pass, db.ownerPass)) fail("Pseudo ou mot de passe incorrect.");
        return { token: makeToken(db, OWNER, true), user: { pseudo: OWNER, admin: true, avatar: db.adminAvatar || null } };
      }
      const x = db.users[pseudo.toLowerCase()];
      if (!x || !checkPass(pass, x.pass)) fail("Pseudo ou mot de passe incorrect.");
      return { token: makeToken(db, x.pseudo, false), user: { pseudo: x.pseudo, discord: x.discord, admin: false, avatar: x.avatar || null } };
    }

    case "social": fail("Cette connexion n'est pas encore activée. Crée un compte avec ton pseudo.");

    case "me": {
      need(u);
      const avatar = u.admin ? db.adminAvatar : db.users[u.pseudo.toLowerCase()].avatar;
      return { user: { ...u, avatar: avatar || null, iac: u.admin ? { active: true, admin: true } : iacOf(db, u.pseudo) }, orders: db.orders.filter(o => o.user === u.pseudo).slice().reverse() };
    }

    case "quote": {
      const c = db.coupons[String(d.code || "").trim().toUpperCase()];
      const p = couponProblem(c) || (u && (c.usedBy || []).includes(u.pseudo.toLowerCase()) ? "Tu as déjà utilisé ce code." : null);
      if (p) fail(p);
      const base = priceOf(db, d.kind, d.options);
      return { code: c.code, label: couponLabel(c), total: priceWith(c, base), price: base, left: c.maxUses ? c.maxUses - c.uses : null };
    }

    case "order": {
      need(u);
      let c = null;
      if (d.code) {
        c = db.coupons[String(d.code).trim().toUpperCase()];
        const p = couponProblem(c) || ((c.usedBy || []).includes(u.pseudo.toLowerCase()) ? "Tu as déjà utilisé ce code." : null);
        if (p) fail(p);
      }
      const id = randomBytes(6).toString("base64url").replace(/[-_]/g, "x").slice(0, 8).toLowerCase();
      const kind = ["site", "vip", "iacolor", "iacsite"].includes(d.kind) ? d.kind : "site";
      const options = [...new Set((d.options || []).map(String))].slice(0, 60);
      const base = priceOf(db, kind, options);
      const o = { id, ref: id.slice(0, 6).toUpperCase(), kind, options, user: u.pseudo, name: String(d.name || u.pseudo).slice(0, 60), discord: String(d.discord || "").slice(0, 60), message: String(d.message || "").slice(0, 8000), price: base, coupon: c ? c.code : null, total: priceWith(c, base), status: "en attente", created: now() };
      if (o.total === 0) markPaid(db, o);
      db.orders.push(o);
      return { order: o };
    }

    case "payCreate": need(u); findOrder(db, u, d.orderId); return { paypalId: null };
    case "payCapture": fail("Le paiement automatique n'est pas activé : envoie la capture de ton paiement.");

    case "payProof": {
      need(u);
      const o = findOrder(db, u, d.orderId);
      if (typeof d.img !== "string" || !d.img.startsWith("data:image/") || d.img.length > 3_000_000) fail("Ajoute une capture d'écran du paiement.");
      await store().set("proof-" + o.id, d.img);
      o.proof = { paypal: String(d.paypal || "").slice(0, 120), at: now() };
      o.status = "à vérifier";
      return { order: o };
    }
    case "proofGet": need(u, true); return { img: (await store().get("proof-" + d.orderId)) || null };
    case "payCancel": { need(u); const o = findOrder(db, u, d.orderId); if (o.status !== "payée") o.status = "annulée"; return { order: o }; }

    case "avatarSave": {
      need(u);
      const img = d.img && typeof d.img === "string" && d.img.startsWith("data:image/") && d.img.length < 400_000 ? d.img : null;
      if (u.admin) db.adminAvatar = img; else db.users[u.pseudo.toLowerCase()].avatar = img;
      return { avatar: img };
    }
    case "signatureSave": need(u, true); db.signature = d.sign; return { ok: true };

    case "quoteSave": {
      need(u, true);
      const o = findOrder(db, u, d.orderId);
      if (o.quote && o.quote.signedAt) fail("Ce devis est déjà signé par le client : il ne peut plus être modifié.");
      const items = (d.items || []).map(x => ({ label: String(x.label || "").slice(0, 200), price: Number(x.price) || 0 }));
      const total = r2(items.reduce((t, x) => t + x.price, 0));
      o.quote = { items, total, deadline: d.deadline, note: d.note, adminSign: d.sign || db.signature, number: "D-" + o.ref, createdAt: now() };
      pushMsg(o, { from: "system", text: "📝 Devis envoyé : " + euro(total) + ". Ouvre-le et signe-le pour valider ta commande.", quote: true });
      o.unreadClient = (o.unreadClient || 0) + 1;
      return { order: o };
    }
    case "quoteSign": {
      need(u);
      const o = findOrder(db, u, d.orderId);
      if (!o.quote) fail("Il n'y a pas encore de devis.");
      Object.assign(o.quote, { clientSign: d.sign, clientName: String(d.name || "").slice(0, 80), signedAt: now() });
      o.locked = true;
      if (o.status === "en attente") { o.total = o.quote.total; o.price = o.quote.total; }
      pushMsg(o, { from: "system", text: "✅ Devis signé par " + o.quote.clientName + ". La commande est validée et ne peut plus être modifiée." });
      return { order: o };
    }

    case "chatGet": { need(u); const o = findOrder(db, u, d.orderId); return { messages: o.messages || [], _markRead: true }; }
    case "chatSend": {
      need(u);
      const o = findOrder(db, u, d.orderId);
      const text = String(d.text || "").trim().slice(0, 2000);
      if (!text) fail("Écris un message.");
      if (!u.admin && d.kind === "modif" && o.locked && o.status !== "terminée") fail("Ton devis est signé : la commande ne peut plus être modifiée avant la livraison du site.");
      if (d.kind === "probleme") o.problem = true;
      pushMsg(o, { from: u.admin ? "admin" : "client", text, kind: d.kind });
      if (u.admin) o.unreadClient = (o.unreadClient || 0) + 1; else o.unreadAdmin = (o.unreadAdmin || 0) + 1;
      return { messages: o.messages };
    }

    case "adminData": {
      need(u, true);
      const users = Object.values(db.users).map(x => ({ ...publicUser(x), orders: db.orders.filter(o => o.user === x.pseudo).length, iac: iacOf(db, x.pseudo) }));
      return { orders: db.orders.slice().reverse(), coupons: Object.values(db.coupons), users, tarifs: db.tarifs, examples: db.examples || null, stats: db.stats || null, timer: db.timer || null, sitesBase: db.sitesBase || 0, signature: db.signature || null };
    }

    case "couponSave": {
      need(u, true);
      const code = String(d.code || "").trim().toUpperCase();
      if (!/^[A-Z0-9_-]{3,20}$/.test(code)) fail("Code : 3 à 20 caractères (lettres, chiffres, _ -).");
      const value = Number(d.value);
      if (!(value > 0)) fail("Mets une réduction plus grande que 0.");
      if (d.type === "percent" && value > 100) fail("Une réduction en % ne peut pas dépasser 100.");
      const old = db.coupons[code];
      db.coupons[code] = { code, type: d.type === "fixed" ? "fixed" : "percent", value, maxUses: d.maxUses ? Math.floor(d.maxUses) : null, expires: d.expires || null, active: d.active !== false, uses: old ? old.uses : 0, usedBy: old ? old.usedBy || [] : [], created: old ? old.created : now() };
      return { coupon: db.coupons[code] };
    }
    case "couponDelete": need(u, true); delete db.coupons[String(d.code || "").toUpperCase()]; return { ok: true };

    case "orderUpdate": {
      need(u, true);
      const o = findOrder(db, u, d.orderId);
      const allowed = ["en attente", "à vérifier", "payée", "annulée", "terminée"];
      if (!allowed.includes(d.status)) fail("Statut inconnu.");
      o.status = d.status;
      if ((d.status === "payée" || d.status === "terminée") && !o.paidAt) { markPaid(db, o); o.status = d.status; }
      if (d.status === "terminée" && d.siteUrl && d.siteUrl !== o.siteUrl) { pushMsg(o, { from: "system", text: "🎉 Voici votre site !", url: d.siteUrl }); o.unreadClient = (o.unreadClient || 0) + 1; }
      if (d.status === "terminée") { o.doneAt ||= now(); if (d.siteUrl !== undefined) o.siteUrl = d.siteUrl || null; }
      return { order: o };
    }
    case "orderDelete": need(u, true); db.orders = db.orders.filter(o => o.id !== d.orderId); await store().delete("proof-" + d.orderId); return { ok: true };
    case "userDelete": need(u, true); delete db.users[String(d.pseudo || "").toLowerCase()]; return { ok: true };

    case "tarifsSave": {
      need(u, true);
      const n = (v, min, max, label) => { const x = r2(Number(String(v ?? "").replace(",", "."))); if (!(x >= min && x <= max)) fail(label + " : entre " + min + " et " + max + "."); return x; };
      db.tarifs = { perOption: n(d.perOption, 0, 100, "Prix par option"), min: n(d.min, 0, 1000, "Prix minimum"), fee: n(d.fee, 0, 50, "Frais"), iacMonth: n(d.iacMonth, 0, 100, "IA Color par mois"), iacSite: n(d.iacSite, 0, 1000, "IA Color sur le site du client"), vip: n(d.vip, 0, 1000, "VIP"), trialDays: Math.round(n(d.trialDays, 0, 60, "Jours d'essai")), vipIacDays: Math.round(n(d.vipIacDays, 0, 3650, "Jours d'IA Color avec le VIP")) };
      return { tarifs: db.tarifs };
    }

    case "iacStatus": need(u); return { iac: u.admin ? { active: true, admin: true } : iacOf(db, u.pseudo) };
    case "licences": need(u, true); return { licences: [] };

    case "stats": {
      const { live, fresh } = await liveStats(db);
      const st = db.stats || {};
      // le chiffre lu en direct passe en premier, sinon celui mis dans l'admin
      return {
        tiktok: live.tiktok ?? st.tiktok ?? null,
        youtube: live.youtube ?? st.youtube ?? null,
        goal: st.goal || 7000,
        live: { tiktok: !!live.ttOk, youtube: !!live.ytOk },
        ...(fresh ? { _dirty: true } : {})
      };
    }
    case "statsSave": need(u, true); db.sitesBase = Number(d.sitesBase) || 0; db.stats = { tiktok: d.tiktok ? +d.tiktok : null, youtube: d.youtube ? +d.youtube : null, goal: +d.goal || 7000 }; return { stats: db.stats };
    case "recent": return { paid: db.orders.filter(o => o.paidAt).slice(-5).reverse().map(o => ({ name: o.name || o.user, at: o.paidAt })) };

    case "timerSave": {
      need(u, true);
      if (d.remove) { db.timer = null; return { timer: null }; }
      if (!String(d.title || "").trim()) fail("Mets un titre au minuteur.");
      db.timer = { title: d.title.trim().slice(0, 80), desc: String(d.desc || "").slice(0, 300), end: d.end, endText: String(d.endText || "").slice(0, 80), active: d.active !== false };
      return { timer: db.timer };
    }
    case "examplesSave": need(u, true); db.examples = Array.isArray(d.examples) ? d.examples.slice(0, 60) : []; return { examples: db.examples };
    case "diceSave": need(u, true); db.dice = d.creators; return { creators: d.creators };

    case "adminPassword":
      need(u, true);
      if (String(d.password || "").length < 6) fail("Mot de passe : 6 caractères minimum.");
      db.ownerPass = hashPass(d.password);
      return { ok: true };

    default: fail("Action inconnue.");
  }
}

export default async req => {
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (req.method !== "POST") return json({ error: "Utilise POST." }, 405);
  let d;
  try { d = await req.json(); } catch { return json({ error: "Requête illisible." }, 400); }
  try {
    const db = await loadDb();
    const action = String(d.action || "");
    const res = await handle(action, d, db);
    let dirty = !READ_ONLY.has(action) || !db.saved;
    if (res && res._markRead) {
      const u = who(db, d.token);
      const o = db.orders.find(x => x.id === d.orderId);
      if (o) { if (u.admin) o.unreadAdmin = 0; else o.unreadClient = 0; }
      delete res._markRead;
      dirty = true;
    }
    if (res && res._dirty) { delete res._dirty; dirty = true; }
    if (dirty) { db.saved = true; await saveDb(db); }
    return json(res);
  } catch (err) {
    if (err instanceof Oops) return json({ error: err.message }, err.status);
    console.error(err);
    return json({ error: "Erreur du serveur, réessaie dans un instant." }, 500);
  }
};
