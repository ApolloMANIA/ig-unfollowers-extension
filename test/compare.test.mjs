/**
 * Lightweight verification for comparison + storage helpers (no Chrome required).
 * Run: node --test test/compare.test.mjs
 */
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Provide a minimal chrome.storage stub before importing the module under test.
globalThis.chrome = {
  storage: {
    local: {
      _data: {},
      async get(keys) {
        const list = Array.isArray(keys) ? keys : Object.keys(keys || {});
        const out = {};
        for (const k of list) out[k] = this._data[k];
        return out;
      },
      async set(data) {
        Object.assign(this._data, data);
      },
    },
  },
};

const {
  compareSnapshots,
  saveSnapshot,
  getSnapshots,
  DEFAULT_SETTINGS,
} = await import("../src/storage.js");

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

test("compareSnapshots finds not-following-back and unfollowed-you", () => {
  const previousFollowers = { usernames: ["alice", "bob", "carol"] };
  const followers = { usernames: ["alice", "bob"] };
  const following = { usernames: ["alice", "dave", "erin"] };

  const result = compareSnapshots(followers, following, previousFollowers);

  assert.deepEqual(result.notFollowingBack, ["dave", "erin"]);
  assert.deepEqual(result.unfollowedYou, ["carol"]);
  assert.deepEqual(result.mutual, ["alice"]);
  assert.equal(result.counts.notFollowingBack, 2);
  assert.equal(result.counts.unfollowedYou, 1);
});

test("compareSnapshots handles empty snapshots", () => {
  const result = compareSnapshots(null, null, null);
  assert.deepEqual(result.notFollowingBack, []);
  assert.deepEqual(result.unfollowedYou, []);
  assert.equal(result.counts.followers, 0);
});

test("saveSnapshot dedupes and lowercases usernames", async () => {
  chrome.storage.local._data = {};
  const snap = await saveSnapshot("followers", ["Alice", "alice", "Bob", ""], "me");
  assert.deepEqual(snap.usernames, ["alice", "bob"]);
  assert.equal(snap.count, 2);

  await saveSnapshot("followers", ["alice", "zoe"], "me");
  const all = await getSnapshots();
  assert.deepEqual(all.previousFollowers.usernames, ["alice", "bob"]);
  assert.deepEqual(all.followers.usernames, ["alice", "zoe"]);
});

test("default settings are conservative", () => {
  assert.equal(DEFAULT_SETTINGS.dailyCap, 20);
  assert.equal(DEFAULT_SETTINGS.minDelaySec, 15);
  assert.equal(DEFAULT_SETTINGS.maxDelaySec, 15);
  assert.equal(DEFAULT_SETTINGS.stopOnError, true);
});

test("manifest is valid JSON and MV3", async () => {
  const raw = await fs.readFile(path.join(root, "manifest.json"), "utf8");
  const manifest = JSON.parse(raw);
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, "src/background.js");
  assert.ok(manifest.host_permissions.includes("https://www.instagram.com/*"));
  assert.ok(manifest.content_scripts[0].js.includes("src/content/instagram.js"));
});

test("required files exist", async () => {
  const files = [
    "manifest.json",
    "README.md",
    "src/background.js",
    "src/storage.js",
    "src/content/instagram.js",
    "src/popup.html",
    "src/popup.js",
    "src/options.html",
    "src/options.js",
    "src/styles.css",
    "icons/icon16.png",
    "icons/icon48.png",
    "icons/icon128.png",
  ];
  for (const file of files) {
    await fs.access(path.join(root, file));
  }
});

test("queue one-item flow via storage helpers", async () => {
  chrome.storage.local._data = {};
  await saveSnapshot("followers", ["alice"], "me");
  await saveSnapshot("following", ["alice", "dave"], "me");
  const { followers, following } = await getSnapshots();
  const comparison = compareSnapshots(followers, following);
  assert.deepEqual(comparison.notFollowingBack, ["dave"]);

  const queue = comparison.notFollowingBack.map((username) => ({
    username,
    status: "pending",
    queuedAt: new Date().toISOString(),
    attempts: 0,
    lastError: null,
  }));
  assert.equal(queue.length, 1);
  assert.equal(queue[0].username, "dave");
  assert.equal(queue[0].status, "pending");
});
