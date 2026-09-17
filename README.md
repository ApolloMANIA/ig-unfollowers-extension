# IG Unfollowers

A local-first Chrome Manifest V3 extension that snapshots Instagram followers/following lists, detects accounts that do not follow you back, and can unfollow them with conservative rate limits and an audit log.

## Install (unpacked)

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder: `ig-unfollowers-extension`.
5. Open [instagram.com](https://www.instagram.com) and log in.
6. Click the extension icon to open the popup.

## How to use

1. Open your Instagram profile in a normal tab.
2. In the popup, click **Scan followers** (or open your Followers dialog first, then scan).
3. Click **Scan following**.
4. Review **Not following back**.
5. Click **Queue all not following back**, then **Start auto-unfollow**.
6. Leave Instagram open while the queue runs. Progress and results appear in the popup and options audit log.

## Settings

Open the options page from the popup or `chrome://extensions` → IG Unfollowers → Details → Extension options.

Defaults are intentionally conservative:

- Daily unfollow cap: `20`
- Delay between actions: `15` seconds
- Stop on error: enabled

You can export/import snapshots as JSON from options.

## Risk notes

- Instagram may change page markup, which can break scanning or unfollow actions.
- Aggressive automation can trigger rate limits or account restrictions. Keep limits low.
- This extension does **not** store passwords, bypass login, solve CAPTCHAs, or call unofficial private APIs.
- Use at your own risk. Prefer reviewing the queue before enabling auto-unfollow.

## Development

Plain HTML/CSS/JS — no build step. After editing files, click **Reload** on `chrome://extensions`.
