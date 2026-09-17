import {
  STORAGE_KEYS,
  appendLog,
  compareSnapshots,
  getQueue,
  getRunnerState,
  getSettings,
  getSnapshots,
  saveQueue,
  saveRunnerState,
  saveSnapshot,
  setStatus,
  todayKey,
} from "./storage.js";

const ALARM_NAME = "unfollow-tick";
const HEARTBEAT_ALARM = "unfollow-heartbeat";
let tickInProgress = false;
let localScheduleId = 0;

chrome.runtime.onInstalled.addListener(async () => {
  await setStatus("Extension ready. Open Instagram and scan your lists.", "info");
  await recoverRunnerScheduling();
});

chrome.runtime.onStartup.addListener(async () => {
  await recoverRunnerScheduling();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME || alarm.name === HEARTBEAT_ALARM) {
    await kickRunnerIfDue();
  }
});

// Service worker wake-up: resume a running queue if a tick is due.
recoverRunnerScheduling().catch(() => {});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SCAN_PROGRESS") {
    const expectedPart = message.expected ? ` / ~${message.expected}` : "";
    setStatus(
      `Scanning ${message.listType}… ${message.count || 0}${expectedPart} loaded. Keep the dialog open.`,
      "info"
    ).then(() => sendResponse({ ok: true }));
    return true;
  }

  handleMessage(message, sender)
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
    case "GET_STATE": {
      // Opening the popup also nudges a stuck runner forward.
      void kickRunnerIfDue();
      return getFullState();
    }
    case "START_SCAN":
      return startScan(message.listType);
    case "SAVE_SCAN_RESULT":
      return persistScanResult(message);
    case "QUEUE_NOT_FOLLOWING_BACK":
      return queueNotFollowingBack();
    case "QUEUE_USERNAMES":
      return queueUsernames(message.usernames || []);
    case "CLEAR_QUEUE":
      await saveQueue([]);
      await setStatus("Queue cleared.", "info");
      return { queue: [] };
    case "START_RUNNER":
      return startRunner();
    case "PAUSE_RUNNER":
      return pauseRunner();
    case "RESUME_RUNNER":
      return resumeRunner();
    case "STOP_RUNNER":
      return stopRunner();
    case "COMPARE":
      return getComparison();
    default:
      throw new Error(`Unknown message type: ${message?.type}`);
  }
}

async function getFullState() {
  const [settings, runner, queue, snapshots, statusData, comparison] = await Promise.all([
    getSettings(),
    getRunnerState(),
    getQueue(),
    getSnapshots(),
    chrome.storage.local.get([STORAGE_KEYS.status, STORAGE_KEYS.logs]),
    getComparison(),
  ]);

  return {
    settings,
    runner,
    queue,
    snapshots,
    comparison,
    status: statusData[STORAGE_KEYS.status] || null,
    logs: Array.isArray(statusData[STORAGE_KEYS.logs]) ? statusData[STORAGE_KEYS.logs] : [],
  };
}

async function getComparison() {
  const { followers, following, previousFollowers } = await getSnapshots();
  return compareSnapshots(followers, following, previousFollowers);
}

async function startScan(listType) {
  if (!["followers", "following"].includes(listType)) {
    throw new Error("listType must be followers or following");
  }

  const tab = await findInstagramTab();
  if (!tab?.id) {
    throw new Error("Open an Instagram tab and log in first.");
  }

  await setStatus(`Scanning ${listType}… keep the Instagram dialog open.`, "info");

  const response = await sendToTab(tab.id, {
    type: "SCAN_LIST",
    listType,
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Scan failed");
  }

  return persistScanResult({
    listType,
    usernames: response.result.usernames,
    profileUsername: response.result.profileUsername,
    expectedCount: response.result.expectedCount,
  });
}

async function persistScanResult({ listType, usernames, profileUsername, expectedCount }) {
  const snapshot = await saveSnapshot(listType, usernames || [], profileUsername || null);
  const comparison = await getComparison();
  const looksIncomplete =
    snapshot.count > 0 &&
    snapshot.count <= 15 &&
    (!expectedCount || snapshot.count < expectedCount * 0.5);

  await setStatus(
    looksIncomplete
      ? `Saved only ${snapshot.count} ${listType}. Leave the ${listType} dialog open and scan again — Instagram may still be lazy-loading.`
      : `Saved ${listType} snapshot (${snapshot.count} accounts).`,
    looksIncomplete ? "warn" : "success"
  );
  await appendLog({
    action: "scan",
    listType,
    count: snapshot.count,
    expectedCount: expectedCount || null,
    profileUsername: snapshot.profileUsername,
  });
  return { snapshot, comparison };
}

async function queueNotFollowingBack() {
  const comparison = await getComparison();
  return queueUsernames(comparison.notFollowingBack);
}

async function queueUsernames(usernames) {
  const unique = [...new Set((usernames || []).map((u) => String(u).toLowerCase()).filter(Boolean))];
  const existing = await getQueue();
  const existingSet = new Set(existing.map((item) => item.username));
  const added = [];

  for (const username of unique) {
    if (existingSet.has(username)) continue;
    added.push({
      username,
      status: "pending",
      queuedAt: new Date().toISOString(),
      attempts: 0,
      lastError: null,
    });
  }

  const queue = [...existing, ...added];
  await saveQueue(queue);
  await setStatus(`Queued ${added.length} account(s). Queue size: ${queue.length}.`, "info");
  return { added: added.length, queue };
}

async function startRunner() {
  let queue = await getQueue();
  // Re-queue previous failures so a fix can be retried.
  queue = queue.map((item) =>
    item.status === "error"
      ? { ...item, status: "pending", lastError: null }
      : item
  );
  await saveQueue(queue);

  const pending = queue.filter((item) => item.status === "pending");
  if (!pending.length) {
    throw new Error("Queue is empty. Queue accounts first.");
  }

  const tab = await findInstagramTab();
  if (!tab?.id) {
    throw new Error("Open an Instagram tab before starting auto-unfollow.");
  }

  const runner = await saveRunnerState({
    running: true,
    paused: false,
    lastError: null,
    nextRunAt: Date.now(),
  });
  await setStatus("Auto-unfollow started.", "success");
  await appendLog({ action: "runner_start", pending: pending.length });
  await scheduleNextTick(0.5);
  return runner;
}

async function pauseRunner() {
  localScheduleId += 1;
  const runner = await saveRunnerState({
    paused: true,
    nextRunAt: null,
    scheduleId: localScheduleId,
  });
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.clear(HEARTBEAT_ALARM);
  await setStatus("Auto-unfollow paused.", "info");
  await appendLog({ action: "runner_pause" });
  return runner;
}

async function resumeRunner() {
  const runner = await saveRunnerState({
    paused: false,
    running: true,
    nextRunAt: Date.now(),
  });
  await setStatus("Auto-unfollow resumed.", "info");
  await appendLog({ action: "runner_resume" });
  await scheduleNextTick(0.5);
  return runner;
}

async function stopRunner() {
  localScheduleId += 1;
  const runner = await saveRunnerState({
    running: false,
    paused: false,
    currentUsername: null,
    nextRunAt: null,
    scheduleId: localScheduleId,
  });
  await chrome.alarms.clear(ALARM_NAME);
  await chrome.alarms.clear(HEARTBEAT_ALARM);
  await setStatus("Auto-unfollow stopped.", "info");
  await appendLog({ action: "runner_stop" });
  return runner;
}

/**
 * Schedule the next queue tick.
 * Uses chrome.alarms (`when`) + setTimeout + a 1-minute heartbeat so the queue
 * keeps moving even after the MV3 service worker goes idle.
 */
async function scheduleNextTick(delaySeconds) {
  const delayMs = Math.max(0, Number(delaySeconds) || 0) * 1000;
  const nextRunAt = Date.now() + delayMs;
  localScheduleId += 1;
  const scheduleId = localScheduleId;

  await saveRunnerState({
    running: true,
    paused: false,
    nextRunAt,
    scheduleId,
  });

  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, { when: nextRunAt });

  // Heartbeat wakes the worker at least once a minute while the queue runs.
  const existing = await chrome.alarms.get(HEARTBEAT_ALARM);
  if (!existing) {
    chrome.alarms.create(HEARTBEAT_ALARM, {
      delayInMinutes: 1,
      periodInMinutes: 1,
    });
  }

  // In-memory timer while the worker is still alive (covers short delays).
  setTimeout(() => {
    if (scheduleId !== localScheduleId) return;
    kickRunnerIfDue().catch(() => {});
  }, delayMs + 25);

  if (delaySeconds >= 1) {
    await setStatus(
      `Waiting ~${Math.round(delaySeconds)}s before the next unfollow…`,
      "info"
    );
  }
}

async function kickRunnerIfDue() {
  const runner = await getRunnerState();
  if (!runner.running || runner.paused) return;
  if (runner.nextRunAt && Date.now() + 250 < runner.nextRunAt) {
    chrome.alarms.create(ALARM_NAME, { when: runner.nextRunAt });
    return;
  }
  await processQueueTick();
}

async function recoverRunnerScheduling() {
  const runner = await getRunnerState();
  if (!runner.running || runner.paused) return;
  if (runner.nextRunAt && Date.now() + 250 < runner.nextRunAt) {
    chrome.alarms.create(ALARM_NAME, { when: runner.nextRunAt });
    const waitSec = Math.max(0.5, (runner.nextRunAt - Date.now()) / 1000);
    localScheduleId = runner.scheduleId || localScheduleId;
    setTimeout(() => {
      processQueueTick().catch(() => {});
    }, waitSec * 1000);
    return;
  }
  await scheduleNextTick(1);
}

async function processQueueTick() {
  if (tickInProgress) return;
  tickInProgress = true;
  try {
    await processQueueTickLocked();
  } finally {
    tickInProgress = false;
  }
}

async function processQueueTickLocked() {
  const runner = await getRunnerState();
  if (!runner.running || runner.paused) return;

  const settings = await getSettings();
  const day = todayKey();
  let unfollowsToday = runner.unfollowsToday || 0;
  if (runner.unfollowsDayKey !== day) {
    unfollowsToday = 0;
  }

  if (unfollowsToday >= settings.dailyCap) {
    await saveRunnerState({
      running: false,
      paused: false,
      unfollowsToday,
      unfollowsDayKey: day,
      currentUsername: null,
      nextRunAt: null,
      lastError: "Daily cap reached",
    });
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.clear(HEARTBEAT_ALARM);
    await setStatus(`Daily cap of ${settings.dailyCap} reached. Stopped.`, "warn");
    await appendLog({ action: "daily_cap_reached", dailyCap: settings.dailyCap });
    return;
  }

  const queue = await getQueue();
  const index = queue.findIndex((item) => item.status === "pending");
  if (index === -1) {
    await saveRunnerState({
      running: false,
      paused: false,
      currentUsername: null,
      unfollowsToday,
      unfollowsDayKey: day,
      nextRunAt: null,
    });
    await chrome.alarms.clear(ALARM_NAME);
    await chrome.alarms.clear(HEARTBEAT_ALARM);
    await setStatus("Queue finished.", "success");
    await appendLog({ action: "queue_complete" });
    return;
  }

  // Continue with the existing tick body below — replaced up to queue item fetch.
  await runSingleUnfollow(queue, index, settings, day, unfollowsToday);
}

async function runSingleUnfollow(queue, index, settings, day, unfollowsToday) {
  const item = queue[index];
  await saveRunnerState({
    running: true,
    paused: false,
    currentUsername: item.username,
    unfollowsToday,
    unfollowsDayKey: day,
    lastError: null,
  });
  await setStatus(`Unfollowing @${item.username}…`, "info");

  try {
    const tab = await findInstagramTab();
    if (!tab?.id) throw new Error("Instagram tab not found. Open Instagram and resume.");

    // Always open the profile first — dialog unfollow is flaky with virtualized lists.
    const profileUrl = `https://www.instagram.com/${item.username}/`;
    const alreadyThere =
      typeof tab.url === "string" &&
      (tab.url.includes(`/${item.username}/`) || tab.url.endsWith(`/${item.username}`));

    if (!alreadyThere) {
      await setStatus(`Opening @${item.username} profile…`, "info");
      await navigateTab(tab.id, profileUrl);
      await sleep(3500);
    }

    let response = await sendToTab(tab.id, {
      type: "UNFOLLOW_USER",
      username: item.username,
    });

    // One more wait/retry if the profile shell loaded before actions appeared.
    if (
      !response?.ok ||
      response.result?.needsNavigation ||
      response.result?.ok === false ||
      /could not find following/i.test(response?.error || "")
    ) {
      await sleep(2500);
      response = await sendToTab(tab.id, {
        type: "UNFOLLOW_USER",
        username: item.username,
      });
    }

    if (
      response?.ok &&
      response.result?.needsNavigation &&
      response.result?.profileUrl
    ) {
      await setStatus(`Opening @${item.username} profile…`, "info");
      await navigateTab(tab.id, response.result.profileUrl);
      await sleep(4000);
      response = await sendToTab(tab.id, {
        type: "UNFOLLOW_USER",
        username: item.username,
      });
    }

    if (!response?.ok) {
      throw new Error(response?.error || "Unfollow failed");
    }
    if (response.result?.needsNavigation) {
      throw new Error("Could not open profile for unfollow");
    }
    if (response.result?.ok === false) {
      throw new Error(humanizeUnfollowReason(response.result.reason));
    }

    queue[index] = {
      ...item,
      status: "done",
      completedAt: new Date().toISOString(),
      attempts: (item.attempts || 0) + 1,
      lastError: null,
    };
    await saveQueue(queue);

    unfollowsToday += 1;
    await saveRunnerState({
      lastActionAt: new Date().toISOString(),
      unfollowsToday,
      unfollowsDayKey: day,
      currentUsername: null,
      lastError: null,
      running: true,
      paused: false,
    });
    await appendLog({
      action: "unfollow_success",
      username: item.username,
      method: response.result?.method || "unknown",
    });

    const delaySec = randomDelay(settings.minDelaySec, settings.maxDelaySec);
    await setStatus(
      `Unfollowed @${item.username}. Next in ~${delaySec}s (${unfollowsToday}/${settings.dailyCap} today).`,
      "success"
    );
    await scheduleNextTick(delaySec);
  } catch (error) {
    const message = error?.message || String(error);
    queue[index] = {
      ...item,
      status: settings.stopOnError ? "error" : "pending",
      attempts: (item.attempts || 0) + 1,
      lastError: message,
    };
    await saveQueue(queue);
    await appendLog({
      action: "unfollow_error",
      username: item.username,
      error: message,
    });

    if (settings.stopOnError) {
      localScheduleId += 1;
      await saveRunnerState({
        running: false,
        paused: false,
        currentUsername: null,
        lastError: message,
        unfollowsToday,
        unfollowsDayKey: day,
        nextRunAt: null,
      });
      await chrome.alarms.clear(ALARM_NAME);
      await chrome.alarms.clear(HEARTBEAT_ALARM);
      await setStatus(`Stopped on error for @${item.username}: ${message}`, "error");
      return;
    }

    await saveRunnerState({
      lastError: message,
      currentUsername: null,
      unfollowsToday,
      unfollowsDayKey: day,
      running: true,
      paused: false,
    });
    const delaySec = randomDelay(settings.minDelaySec, settings.maxDelaySec);
    await setStatus(`Error on @${item.username}. Retrying later (~${delaySec}s).`, "warn");
    await scheduleNextTick(delaySec);
  }
}

function humanizeUnfollowReason(reason) {
  switch (reason) {
    case "no_dialog":
      return "Following list dialog not open";
    case "not_following_dialog":
      return "Open the Following list (not Followers), or let profile unfollow run";
    case "user_not_in_list":
      return "User not found in the visible Following list";
    case "following_button_missing":
      return "Found the user row, but no Following button next to it";
    case "confirm_missing":
      return "Unfollow confirmation popup did not appear";
    case "not_on_profile":
      return "Not on the user profile yet";
    default:
      return reason || "Unfollow failed";
  }
}

function randomDelay(minSec, maxSec) {
  const min = Math.max(5, Number(minSec) || 15);
  const max = Math.max(min, Number(maxSec) || 15);
  return Math.floor(min + Math.random() * (max - min + 1));
}

async function findInstagramTab() {
  const tabs = await chrome.tabs.query({ url: ["https://www.instagram.com/*"] });
  if (!tabs.length) return null;
  const active = tabs.find((t) => t.active) || tabs[0];
  return active;
}

function sendToTab(tabId, message) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, async (response) => {
      if (chrome.runtime.lastError) {
        // Content script may not be ready after navigation — inject and retry once.
        try {
          await chrome.scripting.executeScript({
            target: { tabId },
            files: ["src/content/instagram.js"],
          });
          chrome.tabs.sendMessage(tabId, message, (retryResponse) => {
            if (chrome.runtime.lastError) {
              resolve({ ok: false, error: chrome.runtime.lastError.message });
              return;
            }
            resolve(retryResponse);
          });
        } catch (error) {
          resolve({
            ok: false,
            error: error?.message || chrome.runtime.lastError?.message || "Messaging failed",
          });
        }
        return;
      }
      resolve(response);
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function navigateTab(tabId, url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.update(tabId, { url, active: true }, (tab) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      const targetId = tab?.id ?? tabId;
      const onUpdated = (updatedTabId, info) => {
        if (updatedTabId !== targetId) return;
        if (info.status !== "complete") return;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(tab);
      };
      chrome.tabs.onUpdated.addListener(onUpdated);

      // Safety timeout if complete never fires
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(onUpdated);
        resolve(tab);
      }, 15000);
    });
  });
}
