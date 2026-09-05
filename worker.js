/*
 * BSE FASTEST JSON API – V1.1
 * Dedicated project for BSE corporate announcements via JSON API only.
 *
 * - Shows ALL recent announcements in the frontend
 * - Sends Telegram / ntfy alerts ONLY for watchlist matches
 *
 * KV binding: BSE_FASTEST_JSONAPIKV
 * Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID, NTFY_TOPIC
 */

const BSE_ANN_API =
  "https://api.bseindia.com/BseIndiaAPI/api/AnnSubCategoryGetData/w";

const MAX_RECENT_SEEN = 800;
const MAX_ALERTS = 500;
const MAX_RECENT_ANNOUNCEMENTS = 150;

const BURST_POLLS = 4;
const BURST_GAP_MS = 14000;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function getIstDateStr() {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const yyyy = ist.getUTCFullYear();
  const mm = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(ist.getUTCDate()).padStart(2, "0");
  return `${yyyy}${mm}${dd}`;
}

function normalizeBseLink(rawLink) {
  var clean = String(rawLink || "").trim();
  if (!clean) return "https://www.bseindia.com";
  if (clean.indexOf("AttachLive") !== -1 || clean.indexOf("AttachHis") !== -1) {
    var fileName = clean.split("/").pop();
    if (fileName) return "https://www.bseindia.com/xml-data/corpfiling/AttachLive/" + fileName;
  }
  if (clean.indexOf("http") !== 0) {
    return clean.indexOf("/") === 0 ? "https://www.bseindia.com" + clean : "https://www.bseindia.com/" + clean;
  }
  return clean;
}

function escapeTelegramHtml(text) {
  return String(text || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function sendTelegramAlert(title, body, scrip, link, fetchedAt, env) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  var pdfLink = normalizeBseLink(link);
  var targetLink =
    pdfLink && pdfLink !== "https://www.bseindia.com"
      ? pdfLink
      : scrip
        ? "https://www.bseindia.com/stock-share-price/" + scrip
        : "https://www.bseindia.com";
  const formattedFetchTime = fetchedAt
    ? new Date(fetchedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })
    : "N/A";
  const messageText = `🔔 <b>${escapeTelegramHtml(title)}</b>\n\n${escapeTelegramHtml(body)}\n\n⏱ <b>Fetched:</b> ${formattedFetchTime}\n📎 <a href="${targetLink}">View</a>`;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: messageText,
        parse_mode: "HTML",
        disable_web_page_preview: false,
      }),
    });
  } catch (err) {
    console.error("Telegram error:", err);
  }
}

async function sendNtfyAlert(title, body, scrip, link, fetchedAt, env) {
  if (!env.NTFY_TOPIC) return;
  var pdfLink = normalizeBseLink(link);
  var targetLink =
    pdfLink && pdfLink !== "https://www.bseindia.com"
      ? pdfLink
      : scrip
        ? "https://www.bseindia.com/stock-share-price/" + scrip
        : "https://www.bseindia.com";
  const formattedFetchTime = fetchedAt
    ? new Date(fetchedAt).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" })
    : "N/A";
  try {
    await fetch(`https://ntfy.sh/${env.NTFY_TOPIC}`, {
      method: "POST",
      headers: {
        Title: title,
        Click: targetLink,
        Tags: "chart_with_upwards_trend,warning",
      },
      body: `${body}\nFetched: ${formattedFetchTime}`,
    });
  } catch (err) {
    console.error("ntfy error:", err);
  }
}

function parsePubDate(row) {
  let pubDate = row.DissemDT || row.News_submission_dt || row.NEWS_DT || row.DT_TM || "";
  if (!pubDate) return "";
  pubDate = String(pubDate).trim();
  try {
    if (!pubDate.includes("Z") && !pubDate.includes("+") && pubDate.indexOf("-", 10) === -1) {
      pubDate = pubDate.replace(" ", "T") + "+05:30";
    }
    const d = new Date(pubDate);
    if (!isNaN(d.getTime())) return d.toISOString();
  } catch (e) {}
  return String(row.DissemDT || row.NEWS_DT || "");
}

function computeFingerprint(row) {
  const att = String(row.ATTACHMENTNAME || "").trim().toLowerCase();
  if (att) return `att:${att}`;
  const scrip = String(row.SCRIP_CD || "").trim();
  const title = String(row.HEADLINE || row.NEWSSUB || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  const day = String(row.DissemDT || row.NEWS_DT || "").slice(0, 10);
  return `st:${scrip}|${title}|${day}`;
}

function matchesWatchlist(row, watchlist) {
  if (!watchlist || !watchlist.length) return false;
  const itemScrip = String(row.SCRIP_CD || "").trim();
  const itemCompany = String(row.SLONGNAME || "").toLowerCase().trim();

  for (let i = 0; i < watchlist.length; i++) {
    const w = watchlist[i];
    const ws = String(w.scrip || "").trim();
    if (ws && itemScrip && ws === itemScrip) return true;
    const wn = String(w.name || "").toLowerCase().trim();
    if (wn.length >= 3 && itemCompany && itemCompany.indexOf(wn) !== -1) return true;
  }
  return false;
}

function rowToAnnouncement(row, fetchedAt, isAlert) {
  const company = String(row.SLONGNAME || "").trim() || "Scrip";
  const scrip = String(row.SCRIP_CD || "").trim();
  const title = String(row.HEADLINE || row.NEWSSUB || "New Announcement").trim();
  let link = "";
  if (row.ATTACHMENTNAME) {
    link = `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${row.ATTACHMENTNAME}`;
  } else if (row.NSURL) {
    link = row.NSURL;
  }
  return {
    company,
    scrip,
    title,
    link,
    fingerprint: computeFingerprint(row),
    pubDate: parsePubDate(row),
    fetchedAt,
    alert: !!isAlert,
  };
}

/* ---------- KV helpers ---------- */

async function getWatchlist(env) {
  if (!env.BSE_FASTEST_JSONAPIKV) return [];
  const data = await env.BSE_FASTEST_JSONAPIKV.get("watchlist", "json");
  return Array.isArray(data) ? data : [];
}

async function setWatchlist(env, watchlist) {
  if (!env.BSE_FASTEST_JSONAPIKV) throw new Error("BSE_FASTEST_JSONAPIKV is not bound.");
  await env.BSE_FASTEST_JSONAPIKV.put("watchlist", JSON.stringify(watchlist));
}

async function getNotificationSettings(env) {
  if (!env.BSE_FASTEST_JSONAPIKV) return { telegram: true, ntfy: true };
  const data = await env.BSE_FASTEST_JSONAPIKV.get("notificationSettings", "json");
  return data || { telegram: true, ntfy: true };
}

async function setNotificationSettings(env, settings) {
  if (!env.BSE_FASTEST_JSONAPIKV) throw new Error("BSE_FASTEST_JSONAPIKV is not bound.");
  await env.BSE_FASTEST_JSONAPIKV.put("notificationSettings", JSON.stringify(settings));
}

async function getRecentSeen(env) {
  if (!env.BSE_FASTEST_JSONAPIKV) return [];
  const data = await env.BSE_FASTEST_JSONAPIKV.get("recentSeen", "json");
  return Array.isArray(data) ? data : [];
}

async function saveRecentSeen(env, ids) {
  if (!env.BSE_FASTEST_JSONAPIKV) return;
  await env.BSE_FASTEST_JSONAPIKV.put("recentSeen", JSON.stringify(ids.slice(0, MAX_RECENT_SEEN)));
}

async function getAlertFingerprints(env) {
  if (!env.BSE_FASTEST_JSONAPIKV) return [];
  const data = await env.BSE_FASTEST_JSONAPIKV.get("alertFingerprints", "json");
  return Array.isArray(data) ? data : [];
}

async function saveAlertFingerprints(env, list) {
  if (!env.BSE_FASTEST_JSONAPIKV) return;
  await env.BSE_FASTEST_JSONAPIKV.put("alertFingerprints", JSON.stringify(list.slice(0, MAX_ALERTS * 2)));
}

async function getAlerts(env) {
  if (!env.BSE_FASTEST_JSONAPIKV) return [];
  const data = await env.BSE_FASTEST_JSONAPIKV.get("specialAlerts", "json");
  return Array.isArray(data) ? data : [];
}

async function saveAlerts(env, alerts) {
  if (!env.BSE_FASTEST_JSONAPIKV) return;
  await env.BSE_FASTEST_JSONAPIKV.put("specialAlerts", JSON.stringify(alerts.slice(0, MAX_ALERTS)));
}

async function getRecentAnnouncements(env) {
  if (!env.BSE_FASTEST_JSONAPIKV) return [];
  const data = await env.BSE_FASTEST_JSONAPIKV.get("recentAnnouncements", "json");
  return Array.isArray(data) ? data : [];
}

async function saveRecentAnnouncements(env, list) {
  if (!env.BSE_FASTEST_JSONAPIKV) return;
  await env.BSE_FASTEST_JSONAPIKV.put(
    "recentAnnouncements",
    JSON.stringify(list.slice(0, MAX_RECENT_ANNOUNCEMENTS))
  );
}

/* ---------- core logic ---------- */

async function fetchJsonPage1() {
  const dateStr = getIstDateStr();
  const url =
    `${BSE_ANN_API}?pageno=1` +
    `&strCat=-1&subcategory=-1` +
    `&strPrevDate=${dateStr}&strToDate=${dateStr}` +
    `&strSearch=P&strscrip=&strType=C`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      Accept: "application/json, text/plain, */*",
      Referer: "https://www.bseindia.com/",
      Origin: "https://www.bseindia.com",
      "Cache-Control": "no-cache",
    },
    cf: { cacheTtl: 0, cacheEverything: false },
  });

  if (!response.ok) throw new Error(`BSE JSON HTTP ${response.status}`);
  const data = await response.json();
  return data && Array.isArray(data.Table) ? data.Table : [];
}

async function pollOnce(env) {
  const fetchedAt = new Date().toISOString();
  let rows = [];
  try {
    rows = await fetchJsonPage1();
  } catch (err) {
    console.error("fetch failed:", err);
    return { ok: false, error: String(err), newAnnouncements: 0, newAlerts: 0 };
  }

  if (!rows.length) {
    return { ok: true, newAnnouncements: 0, newAlerts: 0, rows: 0 };
  }

  const page = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const fp = computeFingerprint(row);
    if (!fp) continue;
    page.push({ row, fp });
  }

  // Always keep the latest page available for the frontend (all announcements)
  const watchlist = await getWatchlist(env);
  const currentPageItems = page.map(({ row, fp }) => {
    const isAlert = matchesWatchlist(row, watchlist);
    return rowToAnnouncement(row, fetchedAt, isAlert);
  });

  // Merge with previously stored recent announcements (dedupe by fingerprint)
  const existing = await getRecentAnnouncements(env);
  const seenFp = new Set(currentPageItems.map((a) => a.fingerprint));
  const merged = [...currentPageItems];
  for (const item of existing) {
    if (merged.length >= MAX_RECENT_ANNOUNCEMENTS) break;
    if (!seenFp.has(item.fingerprint)) {
      seenFp.add(item.fingerprint);
      merged.push(item);
    }
  }
  await saveRecentAnnouncements(env, merged);

  // ---------- new detection for alerts ----------
  const recentSeen = await getRecentSeen(env);
  const seenSet = new Set(recentSeen);

  if (recentSeen.length === 0) {
    const fps = page.map((p) => p.fp);
    await saveRecentSeen(env, fps);
    return { ok: true, status: "baseline", newAnnouncements: 0, newAlerts: 0, rows: rows.length };
  }

  const newOnes = [];
  for (let i = 0; i < page.length; i++) {
    if (!seenSet.has(page[i].fp)) newOnes.push(page[i]);
  }

  if (newOnes.length === 0) {
    return { ok: true, newAnnouncements: 0, newAlerts: 0, rows: rows.length };
  }

  const settings = await getNotificationSettings(env);

  let newAlertCount = 0;
  let alerts = null;
  let alertFpSet = null;

  if (watchlist.length > 0) {
    for (let i = 0; i < newOnes.length; i++) {
      const { row, fp } = newOnes[i];
      if (!matchesWatchlist(row, watchlist)) continue;

      if (!alertFpSet) {
        alertFpSet = new Set(await getAlertFingerprints(env));
        alerts = await getAlerts(env);
      }
      if (alertFpSet.has(fp)) continue;

      const company = String(row.SLONGNAME || "").trim() || "Scrip";
      const scrip = String(row.SCRIP_CD || "").trim();
      const title = String(row.HEADLINE || row.NEWSSUB || "New Announcement").trim();
      let link = "";
      if (row.ATTACHMENTNAME) {
        link = `https://www.bseindia.com/xml-data/corpfiling/AttachLive/${row.ATTACHMENTNAME}`;
      } else if (row.NSURL) {
        link = row.NSURL;
      }

      if (settings.telegram !== false) {
        await sendTelegramAlert(`${company} (${scrip})`, title, scrip, link, fetchedAt, env);
      }
      if (settings.ntfy !== false) {
        await sendNtfyAlert(`${company} (${scrip})`, title, scrip, link, fetchedAt, env);
      }

      const pubDate = parsePubDate(row);

      alerts.unshift({
        company,
        scrip,
        title,
        link,
        fingerprint: fp,
        pubDate,
        fetchedAt,
        alert: true,
        alertCreatedAt: new Date().toISOString(),
      });
      alertFpSet.add(fp);
      newAlertCount++;
    }
  }

  // update recentSeen
  const updatedSeen = [];
  const addSet = new Set();
  for (let i = 0; i < newOnes.length; i++) {
    const fp = newOnes[i].fp;
    if (!addSet.has(fp)) {
      addSet.add(fp);
      updatedSeen.push(fp);
    }
  }
  for (let i = 0; i < recentSeen.length; i++) {
    if (updatedSeen.length >= MAX_RECENT_SEEN) break;
    if (!addSet.has(recentSeen[i])) {
      addSet.add(recentSeen[i]);
      updatedSeen.push(recentSeen[i]);
    }
  }
  await saveRecentSeen(env, updatedSeen);

  if (newAlertCount > 0 && alerts && alertFpSet) {
    await saveAlerts(env, alerts);
    await saveAlertFingerprints(env, Array.from(alertFpSet));
  }

  return {
    ok: true,
    newAnnouncements: newOnes.length,
    newAlerts: newAlertCount,
    rows: rows.length,
    totalSeen: updatedSeen.length,
  };
}

async function pollBurst(env) {
  const results = [];
  let totalNew = 0;
  let totalAlerts = 0;

  for (let i = 0; i < BURST_POLLS; i++) {
    const r = await pollOnce(env);
    results.push(r);
    totalNew += r.newAnnouncements || 0;
    totalAlerts += r.newAlerts || 0;
    if (i < BURST_POLLS - 1) await sleep(BURST_GAP_MS);
  }

  return {
    ok: true,
    mode: "burst",
    polls: BURST_POLLS,
    gapMs: BURST_GAP_MS,
    newAnnouncements: totalNew,
    newAlerts: totalAlerts,
    results,
  };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });

    try {
      if (url.pathname === "/") {
        return json({
          status: "running",
          app: "BSE Fastest JSON API",
          version: "1.1",
          note: "Shows all announcements. Alerts only for watchlist. /announcements + /alerts + /monitor",
        });
      }

      if (url.pathname === "/monitor") {
        const burst = url.searchParams.get("burst") === "1";
        if (burst) return json(await pollBurst(env));
        return json(await pollOnce(env));
      }

      if (url.pathname === "/watchlist") {
        if (request.method === "GET") return json({ ok: true, watchlist: await getWatchlist(env) });
        if (request.method === "POST") {
          const body = await request.json();
          await setWatchlist(env, body.watchlist || []);
          return json({ ok: true, watchlist: body.watchlist });
        }
      }

      if (url.pathname === "/notification-settings") {
        if (request.method === "GET") return json({ ok: true, settings: await getNotificationSettings(env) });
        if (request.method === "POST") {
          const body = await request.json();
          await setNotificationSettings(env, body);
          return json({ ok: true, settings: body });
        }
      }

      // All recent announcements (for frontend main feed)
      if (url.pathname === "/announcements") {
        const items = await getRecentAnnouncements(env);
        return json({ ok: true, count: items.length, items });
      }

      // Only watchlist-matched alerts
      if (url.pathname === "/alerts") {
        return json({ ok: true, items: await getAlerts(env) });
      }

      if (url.pathname === "/bse-announcements") {
        const items = await getRecentAnnouncements(env);
        return json({ ok: true, count: items.length, items });
      }

      if (url.pathname === "/categories") {
        return json({ ok: true, categories: [] });
      }

      return json({ error: "Not found" }, 404);
    } catch (err) {
      return json({ error: err.message }, 500);
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollBurst(env));
  },
};
