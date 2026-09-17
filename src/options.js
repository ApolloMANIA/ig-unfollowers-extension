import {
  STORAGE_KEYS,
  exportAllData,
  getLogs,
  getSettings,
  getSnapshots,
  importAllData,
  saveSettings,
  setStorage,
} from "./storage.js";

function $(id) {
  return document.getElementById(id);
}

async function loadSettings() {
  const settings = await getSettings();
  $("dailyCap").value = settings.dailyCap;
  $("minDelaySec").value = settings.minDelaySec;
  $("maxDelaySec").value = settings.maxDelaySec;
  $("stopOnError").checked = Boolean(settings.stopOnError);
}

async function loadSnapshots() {
  const snaps = await getSnapshots();
  $("snapshotSummary").textContent = JSON.stringify(
    {
      followers: snaps.followers
        ? {
            count: snaps.followers.count,
            capturedAt: snaps.followers.capturedAt,
            profileUsername: snaps.followers.profileUsername,
          }
        : null,
      following: snaps.following
        ? {
            count: snaps.following.count,
            capturedAt: snaps.following.capturedAt,
            profileUsername: snaps.following.profileUsername,
          }
        : null,
      previousFollowers: snaps.previousFollowers
        ? {
            count: snaps.previousFollowers.count,
            capturedAt: snaps.previousFollowers.capturedAt,
          }
        : null,
    },
    null,
    2
  );
}

async function loadLogs() {
  const logs = await getLogs();
  const body = $("logsBody");
  if (!logs.length) {
    body.innerHTML = `<tr><td colspan="3" class="muted">No log entries yet</td></tr>`;
    return;
  }
  body.innerHTML = logs
    .slice(0, 200)
    .map((entry) => {
      const { id, at, action, ...rest } = entry;
      return `
        <tr>
          <td>${at ? new Date(at).toLocaleString() : ""}</td>
          <td><span class="badge">${action || ""}</span></td>
          <td><code>${escapeHtml(JSON.stringify(rest))}</code></td>
        </tr>`;
    })
    .join("");
}

function escapeHtml(str) {
  return String(str)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

$("saveSettings").addEventListener("click", async () => {
  const dailyCap = Number($("dailyCap").value);
  const minDelaySec = Number($("minDelaySec").value);
  const maxDelaySec = Number($("maxDelaySec").value);
  if (!Number.isFinite(dailyCap) || dailyCap < 1) {
    $("settingsStatus").textContent = "Daily cap must be >= 1";
    return;
  }
  if (!Number.isFinite(minDelaySec) || minDelaySec < 5) {
    $("settingsStatus").textContent = "Min delay must be >= 5";
    return;
  }
  if (!Number.isFinite(maxDelaySec) || maxDelaySec < minDelaySec) {
    $("settingsStatus").textContent = "Max delay must be >= min delay";
    return;
  }

  await saveSettings({
    dailyCap,
    minDelaySec,
    maxDelaySec,
    stopOnError: $("stopOnError").checked,
  });
  $("settingsStatus").textContent = "Saved.";
});

$("exportData").addEventListener("click", async () => {
  const payload = await exportAllData();
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `ig-unfollowers-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

$("importData").addEventListener("click", () => $("importFile").click());

$("importFile").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const keys = await importAllData(payload);
    $("settingsStatus").textContent = `Imported ${keys.length} key(s).`;
    await loadSettings();
    await loadSnapshots();
    await loadLogs();
  } catch (error) {
    $("settingsStatus").textContent = error.message || String(error);
  } finally {
    event.target.value = "";
  }
});

$("refreshLogs").addEventListener("click", () => loadLogs());

$("clearLogs").addEventListener("click", async () => {
  await setStorage({ [STORAGE_KEYS.logs]: [] });
  await loadLogs();
});

await loadSettings();
await loadSnapshots();
await loadLogs();
