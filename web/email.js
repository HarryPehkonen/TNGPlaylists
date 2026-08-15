/**
 * TNGPlaylists — email obfuscation
 *
 * Builds mailto links at runtime so the raw HTML never contains a scrapable
 * email address. The address parts live in data-* attributes and are joined
 * in JS, which defeats regex-based email harvesters (they never run scripts).
 *
 * Usage:
 *   <a class="email" data-user="harry.pehkonen" data-tag="+tngplaylists"
 *      data-domain="gmail.com">email us</a>
 *
 * If `data-text` is present its value becomes the link text; otherwise the
 * assembled address is shown. No-JS visitors just see the fallback text
 * without a link.
 */
document.querySelectorAll("a.email[data-user][data-domain]").forEach((a) => {
  const user = a.dataset.user;
  const tag = a.dataset.tag ?? "";
  const domain = a.dataset.domain;
  const address = `${user}${tag}@${domain}`;
  a.href = `mailto:${address}`;
  a.textContent = a.dataset.text ?? address;
});
