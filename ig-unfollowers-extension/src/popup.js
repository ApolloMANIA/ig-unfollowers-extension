function send(type, payload = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...payload }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Request failed"));
        return;
      }
      resolve(response.result);
    });
  });
}

function $(id) {
  return document.getElementById(id);
}

function renderList(el, usernames, emptyText) {
  if (!usernames?.length) {
    el.innerHTML = `<div class="list-item muted">${emptyText}</div>`;
    return;
  }
  el.innerHTML = usernames
    .slice(0, 100)
    .map(
      (u) => `
      <div class="list-item">
        <span>@${u}</span>
        <button class="secondary queue-one" data-username="${u}" style="padding:4px 6px">Queue</button>
      </div>`
    )
    .join("");
  if (usernames.length > 100) {
    el.innerHTML += `<div class="list-item muted">…and ${usernames.length - 100} more</div>`;
  }
}

function renderQueue(el, queue) {
  if (!queue?.length) {
    el.innerHTML = `<div class="list-item muted">Queue empty</div>`;
    return;
  }
  el.innerHTML = queue
    .slice(0, 50)
    .map((item) => {
      const badge =
        item.status === "done"
          ? "ok"
          : item.status === "error"
            ? "err"
            : item.status === "pending"
              ? "warn"
              : "info";
      return `
        <div class="list-item">
          <span>@${item.username}</span>
          <span class="badge ${badge}">${item.status}</span>
        </div>`;
    })
    .join("");
}

function setStatusLocal(message, level = "info") {
  const el = $("status");
  el.className = `status ${level}`;
  el.textContent = message;
}

async function refresh() {
  const state = await send("GET_STATE");
  const { comparison, snapshots, runner, queue, settings, status } = state;

  if (status?.message) {
    setStatusLocal(status.message, status.level || "info");
  }

  $("stats").innerHTML = `
    <div class="stat"><div class="label">Followers</div><div class="value">${comparison.counts.followers}</div></div>
    <div class="stat"><div class="label">Following</div><div class="value">${comparison.counts.following}</div></div>
    <div class="stat"><div class="label">Not following back</div><div class="value">${comparison.counts.notFollowingBack}</div></div>
    <div class="stat"><div class="label">Unfollowed you</div><div class="value">${comparison.counts.unfollowedYou}</div></div>
  `;

  const followersAt = snapshots.followers?.capturedAt
    ? new Date(snapshots.followers.capturedAt).toLocaleString()
    : "never";
  const followingAt = snapshots.following?.capturedAt
    ? new Date(snapshots.following.capturedAt).toLocaleString()
    : "never";

  $("runnerMeta").textContent = [
    `Queue: ${queue.filter((q) => q.status === "pending").length} pending / ${queue.length} total`,
    `Today: ${runner.unfollowsToday || 0}/${settings.dailyCap}`,
    runner.running ? (runner.paused ? "paused" : "running") : "stopped",
    runner.currentUsername ? `current @${runner.currentUsername}` : null,
    `followers scan: ${followersAt}`,
    `following scan: ${followingAt}`,
  ]
    .filter(Boolean)
    .join(" · ");

  renderList($("notFollowingBack"), comparison.notFollowingBack, "Scan both lists to populate");
  renderList($("unfollowedYou"), comparison.unfollowedYou, "No newly lost followers yet");
  renderQueue($("queueList"), queue);

  $("notFollowingBack").querySelectorAll(".queue-one").forEach((btn) => {
    btn.addEventListener("click", async () => {
      try {
        await send("QUEUE_USERNAMES", { usernames: [btn.dataset.username] });
        await refresh();
      } catch (e) {
        setStatusLocal(e.message, "error");
      }
    });
  });
}

async function withBusy(fn) {
  const buttons = [...document.querySelectorAll("button")];
  buttons.forEach((b) => (b.disabled = true));
  try {
    await fn();
  } finally {
    buttons.forEach((b) => (b.disabled = false));
    await refresh();
  }
}

$("scanFollowers").addEventListener("click", () =>
  withBusy(async () => {
    setStatusLocal("Scanning followers…", "info");
    await send("START_SCAN", { listType: "followers" });
  })
);

$("scanFollowing").addEventListener("click", () =>
  withBusy(async () => {
    setStatusLocal("Scanning following…", "info");
    await send("START_SCAN", { listType: "following" });
  })
);

$("refresh").addEventListener("click", () => refresh().catch((e) => setStatusLocal(e.message, "error")));

$("queueAll").addEventListener("click", () =>
  withBusy(async () => {
    await send("QUEUE_NOT_FOLLOWING_BACK");
  })
);

$("clearQueue").addEventListener("click", () =>
  withBusy(async () => {
    await send("CLEAR_QUEUE");
  })
);

$("startRunner").addEventListener("click", () =>
  withBusy(async () => {
    await send("START_RUNNER");
  })
);

$("pauseRunner").addEventListener("click", () =>
  withBusy(async () => {
    await send("PAUSE_RUNNER");
  })
);

$("resumeRunner").addEventListener("click", () =>
  withBusy(async () => {
    await send("RESUME_RUNNER");
  })
);

$("stopRunner").addEventListener("click", () =>
  withBusy(async () => {
    await send("STOP_RUNNER");
  })
);

refresh().catch((e) => setStatusLocal(e.message, "error"));

chrome.storage.onChanged.addListener(() => {
  refresh().catch(() => {});
});
