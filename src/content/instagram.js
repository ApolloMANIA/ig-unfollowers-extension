/**
 * Instagram content script: list scanning + unfollow helpers.
 * Selectors are best-effort and may need updates when Instagram changes markup.
 */

if (globalThis.__igUnfollowersContentLoaded) {
  // Already injected (e.g. after navigation retry) — keep a single listener.
} else {
  globalThis.__igUnfollowersContentLoaded = true;
  bootContentScript();
}

function bootContentScript() {
const USERNAME_RE = /^[a-z0-9._]{1,30}$/i;
const RESERVED_PATHS = new Set([
  "accounts",
  "direct",
  "explore",
  "reels",
  "stories",
  "p",
  "tv",
  "reel",
  "about",
  "legal",
  "developer",
  "directory",
  "web",
  "graphql",
  "api",
  "privacy",
  "terms",
  "emails",
  "challenge",
  "session",
]);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) =>
      sendResponse({
        ok: false,
        error: error?.message || String(error),
      })
    );
  return true;
});

async function handleMessage(message) {
  switch (message?.type) {
    case "SCAN_LIST":
      return scanList(message.listType);
    case "UNFOLLOW_USER":
      return unfollowUser(message.username);
    case "PING":
      return { pong: true, href: location.href };
    default:
      throw new Error(`Unknown content message: ${message?.type}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getLoggedInHint() {
  const cookies = document.cookie || "";
  // Presence of sessionid is not readable from JS on Instagram (HttpOnly),
  // so we use UI heuristics instead.
  const hasNav = Boolean(
    document.querySelector('a[href="/"]') ||
      document.querySelector('svg[aria-label="Home"]') ||
      document.querySelector('a[href*="/direct/"]')
  );
  const loginForm = document.querySelector('input[name="username"]');
  return { hasNav, looksLoggedOut: Boolean(loginForm) && !hasNav };
}

function detectProfileUsername() {
  const path = location.pathname.replace(/\/+$/, "");
  const parts = path.split("/").filter(Boolean);
  if (parts.length >= 1 && !RESERVED_PATHS.has(parts[0].toLowerCase())) {
    return parts[0];
  }

  const profileLink = document.querySelector('a[href^="/"] img[alt$="\'s profile picture"]');
  if (profileLink) {
    const alt = profileLink.getAttribute("alt") || "";
    const match = alt.match(/^(.+?)'s profile picture$/i);
    if (match) return match[1];
  }

  return null;
}

function findDialog() {
  const dialogs = [...document.querySelectorAll('div[role="dialog"]')];
  return dialogs[dialogs.length - 1] || null;
}

function isScrollable(el) {
  if (!el || !(el instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(el);
  const overflowY = style.overflowY;
  const allowsScroll =
    overflowY === "auto" || overflowY === "scroll" || overflowY === "overlay";
  // Instagram sometimes uses overflow:hidden on parents; still treat tall boxes
  // with room to scroll as candidates when they actually overflow.
  return (
    (allowsScroll || el.scrollHeight > el.clientHeight + 20) &&
    el.clientHeight > 80 &&
    el.scrollHeight > el.clientHeight + 20
  );
}

/**
 * Find the real followers/following scroll box. Instagram nests several divs;
 * picking the wrong one is why scans stop around the first ~12 visible rows.
 */
function findScrollContainer(root) {
  if (!root) return null;

  const candidates = [root, ...root.querySelectorAll("div")];
  let best = null;
  let bestScore = -1;

  for (const el of candidates) {
    if (!isScrollable(el)) continue;
    // Prefer deeper, taller list panes over the dialog shell.
    const depth = (() => {
      let d = 0;
      let node = el;
      while (node && node !== root) {
        d += 1;
        node = node.parentElement;
      }
      return d;
    })();
    const score = el.scrollHeight * 2 + el.clientHeight + depth * 50;
    if (score > bestScore) {
      best = el;
      bestScore = score;
    }
  }

  if (best) return best;

  // Fallback: tallest overflowing descendant even if overflow CSS is odd.
  let fallback = null;
  let fallbackDelta = 0;
  for (const el of candidates) {
    if (!(el instanceof HTMLElement)) continue;
    if (el.clientHeight < 80) continue;
    const delta = el.scrollHeight - el.clientHeight;
    if (delta > fallbackDelta) {
      fallback = el;
      fallbackDelta = delta;
    }
  }
  return fallback || root;
}

function extractUsernamesFromRoot(root) {
  const found = new Set();
  if (!root) return found;

  const anchors = root.querySelectorAll('a[href^="/"]');
  for (const a of anchors) {
    const href = a.getAttribute("href") || "";
    const match = href.match(/^\/([A-Za-z0-9._]+)\/?(?:\?.*)?$/);
    if (!match) continue;
    const username = match[1];
    if (!USERNAME_RE.test(username)) continue;
    if (RESERVED_PATHS.has(username.toLowerCase())) continue;
    // Skip tiny icon-only chrome links without a visible handle nearby.
    found.add(username.toLowerCase());
  }
  return found;
}

function getVisibleUsernameAnchors(root) {
  if (!root) return [];
  return [...root.querySelectorAll('a[href^="/"]')].filter((a) => {
    const href = a.getAttribute("href") || "";
    const match = href.match(/^\/([A-Za-z0-9._]+)\/?(?:\?.*)?$/);
    if (!match) return false;
    const username = match[1];
    if (!USERNAME_RE.test(username)) return false;
    if (RESERVED_PATHS.has(username.toLowerCase())) return false;
    return true;
  });
}

/** Nudge Instagram's lazy loader with several scroll strategies. */
async function forceListLoad(dialog, scroller) {
  const target = scroller || dialog;
  if (!target) return;

  const before = target.scrollTop;

  // 1) Jump near the bottom (most reliable when we have the right pane).
  target.scrollTop = target.scrollHeight;
  target.dispatchEvent(new Event("scroll", { bubbles: true }));

  // 2) Incremental page-downs in case a full jump is ignored.
  const page = Math.max(120, Math.floor(target.clientHeight * 0.85));
  target.scrollTop = Math.min(target.scrollHeight, before + page);
  target.dispatchEvent(new Event("scroll", { bubbles: true }));
  await sleep(120);
  target.scrollTop = target.scrollHeight;
  target.dispatchEvent(new Event("scroll", { bubbles: true }));

  // 3) scrollIntoView on the last visible row — works even with wrong parent.
  const anchors = getVisibleUsernameAnchors(dialog);
  const last = anchors[anchors.length - 1];
  if (last) {
    try {
      last.scrollIntoView({ block: "end", inline: "nearest" });
    } catch {
      // ignore
    }
  }

  // 4) Synthetic wheel event at the bottom of the pane.
  try {
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        deltaY: 900,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height - 8,
      })
    );
  } catch {
    // ignore
  }
}

function readExpectedCount(dialog, listType) {
  if (!dialog) return null;
  const text = (dialog.textContent || "").toLowerCase();
  // Titles like "Followers" / "Following" often sit near a count on the profile,
  // but inside the dialog Instagram usually only shows the word. Best-effort:
  const match = text.match(
    listType === "followers"
      ? /(\d[\d,]*)\s+followers?/
      : /(\d[\d,]*)\s+following/
  );
  if (!match) return null;
  const n = Number(String(match[1]).replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

async function ensureListDialog(listType) {
  let dialog = findDialog();
  if (dialog) return dialog;

  const profileUsername = detectProfileUsername();
  if (!profileUsername) {
    throw new Error("Open your Instagram profile page first (instagram.com/yourusername).");
  }

  const label = listType === "followers" ? "followers" : "following";
  const link =
    document.querySelector(`a[href="/${profileUsername}/${listType}/"]`) ||
    [...document.querySelectorAll("a")].find((a) => {
      const text = (a.textContent || "").toLowerCase();
      return text.includes(label);
    });

  if (!link) {
    throw new Error(
      `Could not find the ${listType} link. Open your profile and click ${listType}, then scan again.`
    );
  }

  link.click();
  for (let i = 0; i < 20; i++) {
    await sleep(250);
    dialog = findDialog();
    if (dialog) return dialog;
  }

  throw new Error(`Timed out waiting for the ${listType} dialog.`);
}

async function scanList(listType) {
  const auth = getLoggedInHint();
  if (auth.looksLoggedOut) {
    throw new Error("You appear logged out of Instagram. Log in and try again.");
  }

  const dialog = await ensureListDialog(listType);
  const profileUsername = detectProfileUsername();
  const profileLower = profileUsername ? profileUsername.toLowerCase() : null;
  const expected = readExpectedCount(dialog, listType);

  const usernames = new Set();
  let stableRounds = 0;
  let lastCount = 0;
  let lastScrollHeight = 0;
  let heightStableRounds = 0;

  // Instagram lazy-loads ~10–15 rows at a time. Keep scrolling until the list
  // truly stops growing (or we hit a generous safety limit).
  const maxRounds = 400;

  for (let i = 0; i < maxRounds; i++) {
    // Re-find scroller each round — IG remounts the pane while loading.
    const scroller = findScrollContainer(dialog);

    for (const u of extractUsernamesFromRoot(dialog)) {
      if (profileLower && u === profileLower) continue;
      usernames.add(u);
    }

    // Progress ping so the popup status can update if listening later.
    if (i === 0 || i % 5 === 0) {
      try {
        chrome.runtime.sendMessage({
          type: "SCAN_PROGRESS",
          listType,
          count: usernames.size,
          expected,
        });
      } catch {
        // popup may be closed
      }
    }

    const scrollHeight = scroller?.scrollHeight || 0;
    if (scrollHeight <= lastScrollHeight + 2) {
      heightStableRounds += 1;
    } else {
      heightStableRounds = 0;
      lastScrollHeight = scrollHeight;
    }

    if (usernames.size === lastCount) {
      stableRounds += 1;
    } else {
      stableRounds = 0;
      lastCount = usernames.size;
    }

    // Done when both username count and scroll height stop changing.
    // Require more patience than before (4 rounds was too aggressive).
    const atExpected =
      expected && expected > 0 && usernames.size >= Math.floor(expected * 0.98);
    if (atExpected && stableRounds >= 3) break;
    if (stableRounds >= 10 && heightStableRounds >= 6) break;

    await forceListLoad(dialog, scroller);

    // Longer wait when nothing new appeared — give GraphQL time to respond.
    const wait =
      stableRounds === 0
        ? 450 + Math.floor(Math.random() * 250)
        : 900 + Math.floor(Math.random() * 500) + stableRounds * 80;
    await sleep(wait);
  }

  if (usernames.size === 0) {
    throw new Error(
      `No usernames found in the ${listType} dialog. Make sure the list is open and Instagram UI is loaded.`
    );
  }

  if (usernames.size <= 15) {
    // Soft warning path: still return results, but surface likely incomplete scan.
    console.warn(
      `[IG Unfollowers] Only found ${usernames.size} ${listType}. Scroll container may still be wrong, or the list is tiny.`
    );
  }

  return {
    listType,
    usernames: [...usernames].sort(),
    profileUsername,
    expectedCount: expected,
    scannedAt: new Date().toISOString(),
  };
}

const FOLLOWING_LABELS = ["following", "requested"];
const FOLLOW_LABELS = ["follow", "follow back"];
const UNFOLLOW_LABELS = ["unfollow"];

function cleanLabel(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function elementLabels(el) {
  if (!el) return [];
  const labels = new Set();

  const aria = cleanLabel(el.getAttribute?.("aria-label"));
  if (aria) labels.add(aria);
  const title = cleanLabel(el.getAttribute?.("title"));
  if (title) labels.add(title);

  const svg = el.querySelector?.("svg[aria-label]");
  if (svg) labels.add(cleanLabel(svg.getAttribute("aria-label")));

  // Short textContent only — avoids huge wrappers matching incorrectly.
  const full = cleanLabel(el.textContent);
  if (full && full.length <= 48) labels.add(full);

  // Leaf children often hold the visible "Following" / "Unfollow" label.
  for (const child of el.querySelectorAll("span, div")) {
    if (child.children.length > 0) continue;
    const t = cleanLabel(child.textContent);
    if (t && t.length <= 48) labels.add(t);
  }

  return [...labels];
}

function labelIsExact(el, needles) {
  const labels = elementLabels(el);
  return labels.some((label) => needles.includes(label));
}

function labelIncludes(el, needles) {
  const labels = elementLabels(el);
  return labels.some((label) => needles.some((n) => label === n || label.includes(n)));
}

function clickableCandidates(root = document) {
  return [
    ...root.querySelectorAll(
      'button, div[role="button"], [role="menuitem"], a[role="button"]'
    ),
  ];
}

function findActionButton(root, needles, { exact = true } = {}) {
  if (!root) return null;
  const match = exact ? labelIsExact : labelIncludes;
  const nodes = clickableCandidates(root);
  const ranked = nodes
    .map((el) => ({ el, labels: elementLabels(el) }))
    .filter(({ el }) => match(el, needles))
    .sort((a, b) => {
      const aLen = Math.min(...a.labels.map((l) => l.length));
      const bLen = Math.min(...b.labels.map((l) => l.length));
      return aLen - bLen;
    });
  if (ranked[0]?.el) return ranked[0].el;

  // Fallback: leaf text node → nearest clickable ancestor.
  for (const el of root.querySelectorAll("span, div, button")) {
    const t = cleanLabel(el.textContent);
    if (!needles.includes(t)) continue;
    if (el.children.length > 3) continue;
    const clickable =
      el.closest('button, div[role="button"], [role="menuitem"], a[role="button"]') ||
      (el.matches?.('button, div[role="button"]') ? el : null);
    if (clickable) return clickable;
  }
  return null;
}

function findFollowingButtonNearby(anchor) {
  if (!anchor) return null;

  // Walk up a few ancestors and search each for a Following/Requested control.
  let node = anchor;
  for (let depth = 0; depth < 8 && node; depth += 1) {
    const btn = findActionButton(node, FOLLOWING_LABELS, { exact: true });
    if (btn) return btn;
    node = node.parentElement;
  }

  // Sibling-based search: row containers often put the button after the link.
  const row =
    anchor.closest("div > div > div") ||
    anchor.closest("div") ||
    anchor.parentElement;
  if (row) {
    const btn = findActionButton(row, FOLLOWING_LABELS, { exact: true });
    if (btn) return btn;
  }
  return null;
}

function isFollowingDialog(dialog) {
  if (!dialog) return false;
  const title = cleanLabel(dialog.textContent).slice(0, 400);
  // Avoid treating the Followers dialog as Following.
  if (/\bfollowers\b/.test(title) && !/\bfollowing\b/.test(title)) return false;
  return (
    /\bfollowing\b/.test(title) ||
    Boolean(dialog.querySelector('a[href$="/following/"], a[href*="/following/?"]'))
  );
}

async function waitForUnfollowConfirm(timeoutMs = 5000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const scopes = [
      findDialog(),
      document.querySelector('[role="dialog"]'),
      document.body,
    ].filter(Boolean);

    for (const scope of scopes) {
      const btn = findActionButton(scope, UNFOLLOW_LABELS, { exact: true });
      if (btn) return btn;
    }
    await sleep(200);
  }
  return null;
}

async function confirmUnfollowClick() {
  const confirm = await waitForUnfollowConfirm(5500);
  if (!confirm) {
    return { ok: false, reason: "confirm_missing" };
  }
  confirm.click();
  await sleep(900);
  return { ok: true };
}

async function unfollowFromFollowingDialog(username) {
  const dialog = findDialog();
  if (!dialog) return { ok: false, reason: "no_dialog" };
  if (!isFollowingDialog(dialog)) {
    return { ok: false, reason: "not_following_dialog" };
  }

  let link = null;
  for (let i = 0; i < 50; i++) {
    link =
      dialog.querySelector(`a[href="/${username}/"]`) ||
      dialog.querySelector(`a[href="/${username}"]`) ||
      dialog.querySelector(`a[href^="/${username}/?"]`);
    if (link) break;
    await forceListLoad(dialog, findScrollContainer(dialog));
    await sleep(400);
  }

  if (!link) return { ok: false, reason: "user_not_in_list" };

  const followingBtn = findFollowingButtonNearby(link);
  if (!followingBtn) return { ok: false, reason: "following_button_missing" };

  followingBtn.click();
  await sleep(400);
  const confirmed = await confirmUnfollowClick();
  if (!confirmed.ok) return confirmed;
  return { ok: true, method: "following_dialog" };
}

function isOnUserProfile(username) {
  const path = location.pathname.replace(/\/+$/, "") || "/";
  return path.toLowerCase() === `/${username.toLowerCase()}`;
}

async function unfollowOnCurrentProfile(username) {
  // Instagram's SPA often paints the shell before profile actions exist.
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(attempt === 0 ? 800 : 400);

    if (!isOnUserProfile(username)) {
      throw new Error(`Expected @${username}'s profile but page is ${location.pathname}`);
    }

    // Restricted / missing account
    const pageText = cleanLabel(document.body?.innerText || "").slice(0, 2000);
    if (
      pageText.includes("sorry, this page isn't available") ||
      pageText.includes("page isn't available")
    ) {
      throw new Error(`@${username}'s profile isn't available.`);
    }

    const scopes = [
      document.querySelector("header section"),
      document.querySelector("header"),
      document.querySelector("main"),
      document.body,
    ].filter(Boolean);

    let followingBtn = null;
    for (const scope of scopes) {
      followingBtn = findActionButton(scope, FOLLOWING_LABELS, { exact: true });
      if (followingBtn) break;
    }

    if (followingBtn) {
      followingBtn.click();
      await sleep(500);
      const confirmed = await confirmUnfollowClick();
      if (!confirmed.ok) {
        throw new Error(
          "Clicked Following, but the Unfollow confirmation button did not appear."
        );
      }
      return { ok: true, method: "profile_page" };
    }

    let followBtn = null;
    for (const scope of scopes) {
      followBtn = findActionButton(scope, FOLLOW_LABELS, { exact: true });
      if (followBtn) break;
    }
    if (followBtn) {
      // Already not following — treat as success so the queue can continue.
      return { ok: true, method: "already_not_following" };
    }
  }

  throw new Error(
    `Could not find Following/Requested on @${username}'s profile after waiting. Make sure the profile finished loading.`
  );
}

async function unfollowUser(username) {
  if (!username) throw new Error("username required");
  const auth = getLoggedInHint();
  if (auth.looksLoggedOut) {
    throw new Error("You appear logged out of Instagram.");
  }

  const normalized = String(username).toLowerCase();

  // Prefer profile page — more reliable than the virtualized Following dialog.
  if (isOnUserProfile(normalized)) {
    return unfollowOnCurrentProfile(normalized);
  }

  // Optional fast path if Following dialog is already open.
  const dialogAttempt = await unfollowFromFollowingDialog(normalized);
  if (dialogAttempt.ok) return dialogAttempt;

  return {
    ok: false,
    needsNavigation: true,
    profileUrl: `https://www.instagram.com/${normalized}/`,
    reason: dialogAttempt.reason || "not_on_profile",
  };
}

/** Human-readable mapping for runner logs. */
function describeUnfollowReason(reason) {
  switch (reason) {
    case "no_dialog":
      return "Following list dialog not open";
    case "not_following_dialog":
      return "Open the Following list (not Followers) or use profile unfollow";
    case "user_not_in_list":
      return "User not found in the visible Following list";
    case "following_button_missing":
      return "Found the user row, but no Following button next to it";
    case "confirm_missing":
      return "Unfollow confirmation popup did not appear";
    default:
      return reason || "Unfollow failed";
  }
}
} // end bootContentScript

