/** Storage keys and helpers for IG Unfollowers. */

export const STORAGE_KEYS = {
  followers: "followersSnapshot",
  following: "followingSnapshot",
  previousFollowers: "previousFollowersSnapshot",
  settings: "settings",
  queue: "unfollowQueue",
  runner: "runnerState",
  logs: "auditLogs",
  status: "statusMessage",
};

export const DEFAULT_SETTINGS = {
  dailyCap: 20,
  minDelaySec: 15,
  maxDelaySec: 15,
  stopOnError: true,
  autoUnfollowEnabled: false,
};

export const DEFAULT_RUNNER = {
  running: false,
  paused: false,
  lastActionAt: null,
  unfollowsToday: 0,
  unfollowsDayKey: null,
  currentUsername: null,
  lastError: null,
  nextRunAt: null,
  scheduleId: 0,
};

/**
 * @returns {Promise<Record<string, unknown>>}
 */
export async function getStorage(keys) {
  return chrome.storage.local.get(keys);
}

/**
 * @param {Record<string, unknown>} data
 */
export async function setStorage(data) {
  await chrome.storage.local.set(data);
}

export async function getSettings() {
  const data = await getStorage([STORAGE_KEYS.settings]);
  const stored = data[STORAGE_KEYS.settings] || {};
  // One-time bump: older installs used 45–90s defaults.
  if (stored.minDelaySec === 45 && stored.maxDelaySec === 90) {
    stored.minDelaySec = 15;
    stored.maxDelaySec = 15;
    await setStorage({
      [STORAGE_KEYS.settings]: { ...DEFAULT_SETTINGS, ...stored },
    });
  }
  return { ...DEFAULT_SETTINGS, ...stored };
}

export async function saveSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await setStorage({ [STORAGE_KEYS.settings]: next });
  return next;
}

export async function getRunnerState() {
  const data = await getStorage([STORAGE_KEYS.runner]);
  return { ...DEFAULT_RUNNER, ...(data[STORAGE_KEYS.runner] || {}) };
}

export async function saveRunnerState(partial) {
  const current = await getRunnerState();
  const next = { ...current, ...partial };
  await setStorage({ [STORAGE_KEYS.runner]: next });
  return next;
}

export async function getQueue() {
  const data = await getStorage([STORAGE_KEYS.queue]);
  return Array.isArray(data[STORAGE_KEYS.queue]) ? data[STORAGE_KEYS.queue] : [];
}

export async function saveQueue(queue) {
  await setStorage({ [STORAGE_KEYS.queue]: queue });
  return queue;
}

export async function getLogs() {
  const data = await getStorage([STORAGE_KEYS.logs]);
  return Array.isArray(data[STORAGE_KEYS.logs]) ? data[STORAGE_KEYS.logs] : [];
}

export async function appendLog(entry) {
  const logs = await getLogs();
  const next = [
    {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      at: new Date().toISOString(),
      ...entry,
    },
    ...logs,
  ].slice(0, 500);
  await setStorage({ [STORAGE_KEYS.logs]: next });
  return next;
}

export async function setStatus(message, level = "info") {
  await setStorage({
    [STORAGE_KEYS.status]: {
      message,
      level,
      at: new Date().toISOString(),
    },
  });
}

/**
 * @param {string} type "followers" | "following"
 * @param {string[]} usernames
 * @param {string|null} profileUsername
 */
export async function saveSnapshot(type, usernames, profileUsername = null) {
  const unique = [...new Set(usernames.map((u) => u.toLowerCase()).filter(Boolean))].sort();
  const snapshot = {
    type,
    profileUsername,
    usernames: unique,
    count: unique.length,
    capturedAt: new Date().toISOString(),
  };

  if (type === "followers") {
    const data = await getStorage([STORAGE_KEYS.followers]);
    const previous = data[STORAGE_KEYS.followers] || null;
    await setStorage({
      [STORAGE_KEYS.previousFollowers]: previous,
      [STORAGE_KEYS.followers]: snapshot,
    });
  } else {
    await setStorage({ [STORAGE_KEYS.following]: snapshot });
  }

  return snapshot;
}

export async function getSnapshots() {
  const data = await getStorage([
    STORAGE_KEYS.followers,
    STORAGE_KEYS.following,
    STORAGE_KEYS.previousFollowers,
  ]);
  return {
    followers: data[STORAGE_KEYS.followers] || null,
    following: data[STORAGE_KEYS.following] || null,
    previousFollowers: data[STORAGE_KEYS.previousFollowers] || null,
  };
}

/**
 * Compare follower/following snapshots.
 * @param {{ usernames?: string[] }|null} followers
 * @param {{ usernames?: string[] }|null} following
 * @param {{ usernames?: string[] }|null} previousFollowers
 */
export function compareSnapshots(followers, following, previousFollowers = null) {
  const followerSet = new Set(followers?.usernames || []);
  const followingSet = new Set(following?.usernames || []);
  const previousSet = new Set(previousFollowers?.usernames || []);

  const notFollowingBack = [...followingSet].filter((u) => !followerSet.has(u)).sort();
  const fansYouDontFollow = [...followerSet].filter((u) => !followingSet.has(u)).sort();

  let unfollowedYou = [];
  if (previousFollowers?.usernames?.length) {
    unfollowedYou = [...previousSet].filter((u) => !followerSet.has(u)).sort();
  }

  return {
    notFollowingBack,
    fansYouDontFollow,
    unfollowedYou,
    mutual: [...followingSet].filter((u) => followerSet.has(u)).sort(),
    counts: {
      followers: followerSet.size,
      following: followingSet.size,
      notFollowingBack: notFollowingBack.length,
      fansYouDontFollow: fansYouDontFollow.length,
      unfollowedYou: unfollowedYou.length,
      mutual: [...followingSet].filter((u) => followerSet.has(u)).length,
    },
  };
}

export function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * Export all persisted data for backup.
 */
export async function exportAllData() {
  const data = await getStorage(Object.values(STORAGE_KEYS));
  return {
    exportedAt: new Date().toISOString(),
    version: 1,
    data,
  };
}

/**
 * Import snapshot/settings payload.
 * @param {{ data?: Record<string, unknown> }} payload
 */
export async function importAllData(payload) {
  if (!payload || typeof payload !== "object" || !payload.data) {
    throw new Error("Invalid import file: missing data");
  }
  const allowed = new Set(Object.values(STORAGE_KEYS));
  const next = {};
  for (const [key, value] of Object.entries(payload.data)) {
    if (allowed.has(key)) next[key] = value;
  }
  await setStorage(next);
  return Object.keys(next);
}
