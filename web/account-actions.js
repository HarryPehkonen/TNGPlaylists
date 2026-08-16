/**
 * Account actions — self-service data controls, shared between the main app
 * (app.js imports these) and the static privacy page (loads this module and
 * calls initAccountActions()).
 *
 * Self-contained on purpose: static pages don't have app.js's helpers
 * (el/toast/api/state), so everything needed lives here.
 */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

/** Drop every tngplaylists.* key this site stores in the browser. */
export function clearLocalData() {
  Object.keys(localStorage)
    .filter((k) => k.startsWith("tngplaylists."))
    .forEach((k) => localStorage.removeItem(k));
}

function statusLine(host, msg, isError) {
  let s = host.querySelector(".account-actions-status");
  if (!s) {
    s = el("p", "account-actions-status");
    host.appendChild(s);
  }
  s.textContent = msg;
  s.classList.toggle("error", !!isError);
}

/** "Clear my local data" — guests only, never touches the server. */
export function clearLocalDataLink() {
  const link = el("button", "link-quiet", "Clear my local data");
  link.title = "Remove the watched list stored in this browser";
  link.addEventListener("click", () => {
    if (!confirm(
      "Clear the data this site keeps in your browser (your watched-episode " +
      "list)?\n\nNothing is sent to the server — this only affects this " +
      "browser, and cannot be undone.",
    )) return;
    clearLocalData();
    // Give the caller a chance to refresh its in-memory state.
    link.dispatchEvent(new CustomEvent("cleared", { bubbles: true }));
  });
  return link;
}

/** "Delete account" — signed-in users only. 409 (last admin) stays signed in. */
export function deleteAccountButton(host) {
  const btn = el("button", "btn btn-danger btn-sm", "Delete account");
  btn.addEventListener("click", async () => {
    if (!confirm(
      "Permanently delete your TNG Playlists account?\n\n" +
      "This removes your account, your sign-in sessions and your watched " +
      "episodes from our server, and clears the data this site keeps in your " +
      "browser. Playlists stay on the site (they are shared content), and " +
      "your Google account is not affected.\n\nThis cannot be undone.",
    )) return;

    try {
      const resp = await fetch("/api/auth/me", { method: "DELETE" });
      if (!resp.ok) {
        const data = await resp.json().catch(() => null);
        throw new Error(data?.error || `HTTP ${resp.status}`);
      }
      clearLocalData();
      location.reload();
    } catch (err) {
      // e.g. 409 "Cannot delete the last admin account" — stay signed in.
      if (host) statusLine(host, err.message, true);
      else alert(err.message);
    }
  });
  return btn;
}

/**
 * Fill a host element (typically <div id="account-actions"> on static pages)
 * with the controls that fit the visitor's state: guests get the local-data
 * link, signed-in users get the delete-account button.
 */
export async function initAccountActions(host) {
  if (!host) return;
  host.innerHTML = "";
  host.classList.add("account-actions");

  const guestLink = clearLocalDataLink();
  guestLink.addEventListener("cleared", () => {
    statusLine(host, "Local data cleared.");
  });
  host.appendChild(guestLink);

  try {
    const resp = await fetch("/api/auth/me");
    if (resp.ok) {
      const data = await resp.json().catch(() => null);
      if (data?.data?.user) {
        const del = deleteAccountButton(host);
        host.appendChild(del);
      }
    }
  } catch { /* not signed in — guests only */ }
}

// Auto-init on pages that carry the host element (privacy.html). Module
// scripts are deferred, so the DOM is parsed by the time this runs. On the
// main app page there is no #account-actions, so this is a no-op there.
if (typeof document !== "undefined") {
  const host = document.getElementById("account-actions");
  if (host) initAccountActions(host);
}
