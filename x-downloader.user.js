// ==UserScript==
// @name         X Downloader
// @version      0.1.0
// @description  Adds a download button to posts on X that saves every photo (original size) and video (highest quality), and remembers what was downloaded.
// @match        https://x.com/*
// @match        https://twitter.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_deleteValue
// @grant        GM_listValues
// @grant        GM_registerMenuCommand
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @connect      twimg.com
// @sandbox      raw
// @inject-into  page
// @run-at       document-start
// @noframes
// ==/UserScript==
/*
 * X Downloader
 *
 * Adds a download button to the action bar of every post on x.com that has photos, videos or
 * GIFs (right after Share). One click saves every photo and video of
 * the post: photos at their original size, videos and GIFs as the MP4 with the highest bitrate.
 * A post without media of its own saves the media of the post it quotes.
 *
 * Downloads are remembered: a button whose post has been downloaded turns blue, and "Downloads"
 * in Tampermonkey's menu lists everything that was downloaded, newest first, with a search box.
 *
 * Data: X sends each post's details (with every version of its videos) in its API responses;
 * they are caught as they arrive (fetch and XMLHttpRequest are wrapped) and kept by post id. A
 * post that was loaded before that is looked up with X's embed API (cdn.syndication.twimg.com).
 *
 * Every comment is a block comment and every statement ends with a semicolon, so the code still
 * runs when collapsed onto a single line (as a bookmarklet).
 */
(() => {
  "use strict";

  const AUTO_START = true;
  /* Set by build.js to the userscript's version. */
  const VERSION = "0.1.0";
  const HOST_TAG = "x-downloader";
  const LOG = "[X Downloader]";
  /* X's blue, for buttons whose post has been downloaded. */
  const DONE_COLOUR = "rgb(29, 155, 240)";

  /* ---------- General helpers ---------- */

  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

  /* Text made safe for a file name: no links, no characters file systems refuse, at most `max`
     characters. */
  const cleanName = (text, max = 60) =>
    (text || "").replace(/https?:\/\/\S+/g, " ").replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ").replace(/#\S+/g, "")
      .replace(/\s+/g, " ").trim().slice(0, max).trim();

  const extensionOf = type =>
    ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "video/mp4": "mp4" })[type] || "";

  /* The page's own window: with Tampermonkey's GM_* functions granted, "window" can be
     Tampermonkey's wrapper, and the page's fetch and XMLHttpRequest are the ones to wrap. */
  const page = typeof unsafeWindow === "object" && unsafeWindow ? unsafeWindow : window;
  const shared = page.__xDownloaderShared || (page.__xDownloaderShared = {
    posts: new Map(),
    nativeFetch: page.fetch.bind(page),
    listening: false,
  });
  const posts = shared.posts;

  /* ---------- Catching X's data ---------- */

  /* One photo or video, as kept: its kind, the address to save it from (the original photo, or
     the MP4 versions of a video best first) and a small picture of it. */
  function normalizeMedia(media) {
    const preview = media.media_url_https || media.media_url || "";
    if (media.type === "photo") {
      const match = preview.match(/^(.*)\.(jpe?g|png|webp|gif)(?:\?.*)?$/i);
      const url = match ? match[1] + "?format=" + match[2].toLowerCase().replace("jpeg", "jpg") + "&name=orig" : preview;
      return preview ? { kind: "photo", urls: [url, preview], preview } : null;
    }
    if (media.type === "video" || media.type === "animated_gif") {
      const variants = (media.video_info?.variants || [])
        .filter(variant => variant.content_type === "video/mp4" && variant.url)
        .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
      return variants.length ? { kind: media.type === "video" ? "video" : "gif", urls: variants.map(variant => variant.url), preview } : null;
    }
    return null;
  }

  /* A post from X's API (GraphQL "Tweet", sometimes wrapped as "TweetWithVisibilityResults"),
     made into { id, user, name, text, posted, media, quoted }. */
  function fromApi(result) {
    if (result?.__typename === "TweetWithVisibilityResults" && result.tweet) result = result.tweet;
    const legacy = result?.legacy;
    if (!legacy || !/^\d+$/.test(result.rest_id || "")) return null;
    const user = result.core?.user_results?.result || {};
    const media = (legacy.extended_entities?.media || legacy.entities?.media || []).map(normalizeMedia).filter(Boolean);
    return {
      id: result.rest_id,
      user: user.core?.screen_name || user.legacy?.screen_name || "",
      name: user.core?.name || user.legacy?.name || "",
      text: result.note_tweet?.note_tweet_results?.result?.text || legacy.full_text || "",
      posted: Date.parse(legacy.created_at) || null,
      media,
      quoted: result.quoted_status_result?.result ? fromApi(result.quoted_status_result.result) : null,
    };
  }

  /* A post from X's embed API (cdn.syndication.twimg.com), made into the same. */
  function fromEmbed(data) {
    if (!data || !/^\d+$/.test(data.id_str || "")) return null;
    return {
      id: data.id_str,
      user: data.user?.screen_name || "",
      name: data.user?.name || "",
      text: data.text || "",
      posted: Date.parse(data.created_at) || null,
      media: (data.mediaDetails || []).map(normalizeMedia).filter(Boolean),
      quoted: data.quoted_tweet ? fromEmbed(data.quoted_tweet) : null,
    };
  }

  /* A copy with media replaces one without: a post shown in a list can come with fewer details. */
  function keep(post) {
    if (!post) return;
    const kept = posts.get(post.id);
    if (!kept || post.media.length >= kept.media.length) posts.set(post.id, post);
    if (post.quoted) keep(post.quoted);
  }

  /* Keeps every post found in a response, however deep it is. */
  function collectPosts(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 40) return;
    if (value.__typename === "Tweet" || value.__typename === "TweetWithVisibilityResults" || value.legacy && value.rest_id) {
      const post = fromApi(value);
      if (post) keep(post);
    }
    for (const key in value) collectPosts(value[key], depth + 1);
  }

  function collectText(text) {
    if (!text || text[0] !== "{" && text[0] !== "[") return;
    try {
      collectPosts(JSON.parse(text));
    } catch (ignored) {}
  }

  const isApiUrl = url => /\/i\/api\/|\/graphql\/|api\.(x|twitter)\.com/.test(String(url || ""));

  /* Wraps fetch and XMLHttpRequest once to read X's API responses, which are left untouched. */
  function startListening() {
    if (shared.listening) return;
    shared.listening = true;

    const pageFetch = page.fetch;
    page.fetch = function (input) {
      const result = pageFetch.apply(this, arguments);
      const url = typeof input === "string" ? input : input?.url;
      if (isApiUrl(url)) result.then(response => response.clone().text()).then(collectText).catch(() => {});
      return result;
    };

    const open = page.XMLHttpRequest.prototype.open;
    page.XMLHttpRequest.prototype.open = function (method, url) {
      if (isApiUrl(url)) {
        this.addEventListener("load", () => {
          try {
            if (this.responseType === "" || this.responseType === "text") collectText(this.responseText);
            else if (this.responseType === "json") collectPosts(this.response);
          } catch (ignored) {}
        });
      }
      return open.apply(this, arguments);
    };
  }

  /* The token X's embeds send with a post's id. */
  const embedToken = id => (Number(id) / 1e15 * Math.PI).toString(36).replace(/(0+|\.)/g, "");

  /* A post's details: the kept ones, or X's embed API. */
  async function postFor(id) {
    if (posts.get(id)?.media.length || posts.get(id)?.quoted?.media.length) return posts.get(id);
    const url = "https://cdn.syndication.twimg.com/tweet-result?id=" + id + "&lang=en&token=" + embedToken(id);
    try {
      const blob = await fetchFile(url, { kind: "json" });
      keep(fromEmbed(JSON.parse(await blob.text())));
    } catch (error) {
      console.warn(LOG, "embed API failed", error);
    }
    if (posts.has(id)) return posts.get(id);
    throw new Error("Couldn't find this post's details. Scroll it out of view and back, or reload the page, and try again.");
  }

  /* The photos and videos to save for a post: its own, or the quoted post's. */
  const mediaOf = post => post?.media.length ? { post, media: post.media } : post?.quoted?.media.length
    ? { post: post.quoted, media: post.quoted.media } : { post, media: [] };

  /* ---------- What was downloaded ---------- */

  /* "t:<post id>": every photo and video of the post was downloaded. Each key maps to null
     (kept for good); its details for the list of downloads are kept beside it as "i:<key>".
     Tampermonkey's storage is used when it is granted (it survives clearing x.com's site data),
     localStorage otherwise. */
  const gm = typeof GM_getValue === "function" && typeof GM_setValue === "function" &&
    typeof GM_listValues === "function" && typeof GM_deleteValue === "function";
  const LOCAL = "xDownloader.";
  const store = gm ? {
    get: name => GM_getValue(name, null),
    set: (name, value) => GM_setValue(name, value),
    remove: name => GM_deleteValue(name),
    names: () => GM_listValues(),
  } : {
    get: name => {
      try {
        return JSON.parse(localStorage.getItem(LOCAL + name));
      } catch (ignored) {
        return null;
      }
    },
    set: (name, value) => {
      try {
        localStorage.setItem(LOCAL + name, JSON.stringify(value));
      } catch (error) {
        console.warn(LOG, "couldn't remember the download", error);
      }
    },
    remove: name => localStorage.removeItem(LOCAL + name),
    names: () => Object.keys(localStorage).filter(name => name.startsWith(LOCAL)).map(name => name.slice(LOCAL.length)),
  };

  const downloaded = new Set();
  try {
    for (const name of store.names()) if (name.startsWith("d:")) downloaded.add(name.slice(2));
    for (const name of store.names()) if (name.startsWith("i:") && !downloaded.has(name.slice(2))) store.remove(name);
  } catch (error) {
    console.warn(LOG, "couldn't read the list of downloads", error);
  }
  const isDownloaded = key => !!key && downloaded.has(key);

  /* Buttons that show whether their post was downloaded, painted again when that changes. */
  const paintable = new Set();
  const repaintAll = () => {
    for (const button of paintable) {
      if (!button.isConnected && button.painted) paintable.delete(button);
      else button.repaint?.();
    }
  };

  function markDownloaded(key, details) {
    downloaded.add(key);
    store.set("d:" + key, null);
    const { picture, ...kept } = details;
    const record = { ...kept, at: Date.now() };
    store.set("i:" + key, record);
    repaintAll();
    if (!picture) return;
    fetchFile(picture.replace(/(\?.*)?$/, "?format=jpg&name=small"), { kind: "image" })
      .catch(() => fetchFile(picture, { kind: "image" }))
      .then(smallPicture)
      .then(thumb => {
        if (downloaded.has(key)) store.set("i:" + key, { ...record, thumb });
      })
      .catch(error => console.warn(LOG, "couldn't keep a small picture", error));
  }

  /* Forgets a download: its button is no longer blue, and it leaves the list of downloads. */
  function forgetDownload(key) {
    downloaded.delete(key);
    store.remove("d:" + key);
    store.remove("i:" + key);
    repaintAll();
  }

  /* A picture at most 128 px on its longer side, as a JPEG data address (a few kB). */
  async function smallPicture(blob) {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, 128 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    return canvas.toDataURL("image/jpeg", 0.7);
  }

  /* ---------- Downloading ---------- */

  /* Downloads a file with the browser's fetch (X's media servers allow it), or with
     Tampermonkey's GM_xmlhttpRequest when the browser refuses. Reports progress (0–1) when the
     size is known and checks what came back: an image for a photo, an MP4 file for a video. */
  async function fetchFile(url, { kind, onProgress } = {}) {
    let blob;
    try {
      const response = await shared.nativeFetch(url, { credentials: "omit", cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const total = Number(response.headers.get("content-length")) || 0;
      const type = (response.headers.get("content-type") || "").split(";")[0].trim();
      const chunks = [];
      let received = 0;
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.length;
        if (total && onProgress) onProgress(Math.min(received / total, 1));
      }
      if (total && received < total) throw new Error("Incomplete file (" + received + " of " + total + " bytes)");
      blob = new Blob(chunks, { type });
    } catch (error) {
      if (typeof GM_xmlhttpRequest !== "function") throw error;
      console.warn(LOG, "fetch failed, trying GM_xmlhttpRequest", error);
      blob = await new Promise((resolve, reject) => GM_xmlhttpRequest({
        method: "GET",
        url,
        responseType: "blob",
        anonymous: true,
        onprogress: event => {
          if (event.lengthComputable && onProgress) onProgress(event.loaded / event.total);
        },
        onload: response => response.status >= 200 && response.status < 300
          ? resolve(response.response) : reject(new Error("HTTP " + response.status)),
        onerror: () => reject(new Error("Network error")),
        ontimeout: () => reject(new Error("Timed out")),
      }));
    }
    if (kind === "image" && !blob.type.startsWith("image/")) throw new Error("Unexpected file type " + blob.type);
    if (kind === "video") {
      const head = new Uint8Array(await blob.slice(0, 8).arrayBuffer());
      if (String.fromCharCode(...head.slice(4, 8)) !== "ftyp") throw new Error("Not an MP4 file");
      if (blob.type !== "video/mp4") blob = new Blob([blob], { type: "video/mp4" });
    }
    return blob;
  }

  /* "username (Display Name)"; just the username when the display name is missing or the same. */
  function ownerName(user, name) {
    const clean = cleanName(name, 60);
    return clean && clean.toLowerCase() !== (user || "").toLowerCase() ? user + " (" + clean + ")" : user;
  }

  /* A file's name: "username (Display Name) - text - id". */
  function fileBase(post) {
    const parts = [ownerName(post.user || "x", post.name)];
    const text = cleanName(post.text, 60);
    if (text) parts.push(text);
    parts.push(post.id);
    return parts.join(" - ");
  }

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }

  /* One photo or video: the first of its addresses that downloads. */
  async function downloadMedia(media, onProgress) {
    const failures = [];
    for (const url of media.urls) {
      try {
        return await fetchFile(url, { kind: media.kind === "photo" ? "image" : "video", onProgress });
      } catch (error) {
        failures.push(new URL(url).pathname + ": " + error.message);
      }
    }
    console.warn(LOG, "every address failed", failures);
    throw new Error("Couldn't download this " + (media.kind === "photo" ? "photo" : "video") + ".");
  }

  /* Every photo and video of a post, each its own file ("… - 2.jpg" when there are several),
     with the progress of the whole. Returns what to remember about the post. */
  async function downloadPost(id, onProgress) {
    const { post, media } = mediaOf(await postFor(id));
    if (!media.length) throw new Error("This post has no photos or videos to download.");
    for (let index = 0; index < media.length; index++) {
      const blob = await downloadMedia(media[index], fraction => onProgress?.((index + fraction) / media.length));
      const number = media.length > 1 ? " - " + (index + 1) : "";
      const extension = extensionOf(blob.type) || (media[index].kind === "photo" ? "jpg" : "mp4");
      saveBlob(blob, fileBase(post) + number + "." + extension);
      onProgress?.((index + 1) / media.length);
      /* Browsers drop downloads started too close together. */
      if (index < media.length - 1) await wait(300);
    }
    const counts = ["photo", "video", "gif"].map(kind => [kind, media.filter(item => item.kind === kind).length]).filter(([, n]) => n);
    const label = { photo: ["Photo", "photos"], video: ["Video", "videos"], gif: ["GIF", "GIFs"] };
    return {
      owner: post.user,
      name: post.name,
      text: (post.text || "").replace(/\s*https:\/\/t\.co\/\w+\s*$/, ""),
      link: "https://x.com/" + (post.user || "i") + "/status/" + post.id,
      posted: post.posted,
      kind: counts.map(([kind, n]) => n === 1 ? label[kind][0] : n + " " + label[kind][1]).join(", "),
      picture: media[0].preview,
    };
  }

  /* ---------- Buttons ---------- */

  const ICONS = {
    /* X's own Share icon (a filled arrow out of a tray) with its arrow turned upside down: the
       tray is the same path, the arrow is mirrored about its middle (y 2.59–16). */
    download: { solid: [
      "M12 16l5.7-5.7-1.41-1.42L13 12.18V2.59h-2v9.59l-3.3-3.3-1.41 1.42L12 16z" +
      "M21 15l-.02 3.51c0 1.38-1.12 2.49-2.5 2.49H5.5C4.11 21 3 19.88 3 18.5V15h2v3.5c0 .28.22.5.5.5h12.98c.28 0 .5-.22.5-.5L19 15h2z",
    ] },
    busy: ["M12 3a9 9 0 1 0 9 9"],
    done: ["m5 12.5 4.5 4.5L19 7"],
  };

  /* An icon is a list of outline paths, or { solid: [...] } for a filled one. */
  function icon(name) {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const shape = ICONS[name];
    const solid = !Array.isArray(shape);
    if (solid) svg.classList.add("solid");
    for (const data of solid ? shape.solid : shape) {
      const path = document.createElementNS(namespace, "path");
      path.setAttribute("d", data);
      svg.append(path);
    }
    return svg;
  }

  /* Looks like X's own Bookmark and Share buttons: a bare icon in their grey, with a round
     background that spills around it on hover. The icon's size and colour, and the space before
     it, are copied from the Share button it follows. */
  const BUTTON_CSS = [
    ":host{all:initial;display:flex;align-items:center;flex:0 0 auto;margin-left:var(--gap,12px)}",
    "button{all:unset;box-sizing:border-box;position:relative;width:var(--icon,19px);height:var(--icon,19px);",
    "display:grid;place-items:center;cursor:pointer;color:var(--fg,rgb(113,118,123));transition:color .15s}",
    "button::before{content:'';position:absolute;inset:var(--halo,-8px);border-radius:999px;transition:background .15s}",
    "button:hover{color:" + DONE_COLOUR + "}",
    "button:hover::before{background:rgba(29,155,240,.1)}",
    "button:focus-visible::before{outline:2px solid " + DONE_COLOUR + "}",
    "svg{position:relative;width:100%;height:100%;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}",
    "button.downloaded{color:" + DONE_COLOUR + "}",
    "svg.solid{fill:currentColor;stroke:none}",
    "button.busy svg{animation:spin .8s linear infinite}",
    "@keyframes spin{to{transform:rotate(360deg)}}",
    ".percent{position:relative;font:700 9px/1 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;white-space:nowrap}",
  ].join("");

  /* The icon size and colour of X's Share button (the last in the bar), the space between it and
     Bookmark before it, and how far its hover circle spills around the icon. */
  function barStyle(bar) {
    const items = [...bar.children].filter(child => child.tagName !== HOST_TAG.toUpperCase());
    const share = items[items.length - 1];
    const before = items[items.length - 2];
    const svg = share?.querySelector("svg");
    const px = value => Math.round(value * 100) / 100 + "px";
    const style = {};
    if (svg) {
      style.fg = getComputedStyle(svg).color;
      const box = svg.getBoundingClientRect();
      if (box.width >= 12 && box.width <= 32) style.icon = px(box.width);
      const halo = [...share.querySelectorAll("div")].find(element => getComputedStyle(element).position === "absolute");
      if (halo && box.width) {
        const spill = (halo.getBoundingClientRect().width - box.width) / 2;
        if (spill > 0 && spill < 16) style.halo = px(-spill);
      }
    }
    if (share && before) {
      const gap = share.getBoundingClientRect().left - before.getBoundingClientRect().right;
      if (gap > 0 && gap < 40) style.gap = px(gap);
    }
    return style;
  }

  /* The button for one post: downloads every photo and video, and is blue once that's done. */
  function makeHost(id, bar) {
    const host = document.createElement(HOST_TAG);
    host.dataset.id = id;
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = BUTTON_CSS;
    const look = barStyle(bar);
    for (const [name, value] of Object.entries(look)) if (value) host.style.setProperty("--" + name, value);
    const button = document.createElement("button");
    button.type = "button";
    button.title = "Download every photo and video";
    root.append(style, button);
    wireButton(button, id);
    isolateEvents(host);
    return host;
  }

  /* Clicking downloads the post: a spinner, then the percentage, then a check mark; an error is
     shown. A downloaded post's button stays blue, and downloads again when clicked. */
  function wireButton(button, id) {
    const key = "t:" + id;
    const setIcon = name => button.replaceChildren(icon(name));
    paintable.add(button);
    button.repaint = () => {
      button.painted = true;
      if (button.classList.contains("busy") || button.querySelector(".percent")) return;
      const done = isDownloaded(key);
      setIcon("download");
      button.classList.toggle("downloaded", done);
      button.title = done ? "Downloaded · click to download every photo and video again" : "Download every photo and video";
      button.setAttribute("aria-label", button.title);
    };
    button.addEventListener("click", () => {
      if (button.classList.contains("busy") || button.querySelector(".percent")) return;
      button.classList.add("busy");
      setIcon("busy");
      const onProgress = fraction => {
        const text = document.createElement("span");
        text.className = "percent";
        text.textContent = Math.round(fraction * 100) + "%";
        button.classList.remove("busy");
        button.replaceChildren(text);
      };
      downloadPost(id, onProgress).then(
        details => {
          button.classList.remove("busy");
          button.replaceChildren();
          markDownloaded(key, details);
          button.replaceChildren(icon("done"));
          button.classList.add("downloaded");
          setTimeout(() => {
            button.replaceChildren();
            button.repaint();
          }, 1500);
        },
        error => {
          button.classList.remove("busy");
          button.replaceChildren();
          button.repaint();
          console.error(LOG, error);
          alert(error?.message || "Download failed.");
        });
    });
    button.repaint();
  }

  /* Clicks on the button don't reach X, which would open the post. */
  function isolateEvents(host) {
    for (const type of ["pointerdown", "pointerup", "mousedown", "mouseup", "touchstart", "touchend", "click", "dblclick", "contextmenu", "keydown"]) {
      host.addEventListener(type, event => {
        event.stopPropagation();
        if (type === "click" || type === "dblclick") event.preventDefault();
      });
    }
  }

  const MEDIA_IN_PAGE = '[data-testid="tweetPhoto"], [data-testid="videoPlayer"], [data-testid="videoComponent"], ' +
    '[data-testid="previewInterstitial"], [data-testid="tweetGif"]';

  /* The id of the post an article shows: the link around its time, outside the quoted post (a
     box with role "link"). On a post's own page the main post has no such link in some layouts,
     so the address names it. */
  function idOfArticle(article) {
    for (const time of article.querySelectorAll("time")) {
      if (time.closest("article") !== article || time.closest('div[role="link"]')) continue;
      const id = time.closest('a[href*="/status/"]')?.getAttribute("href")?.match(/\/status\/(\d+)/)?.[1];
      if (id) return id;
    }
    if (article.getAttribute("tabindex") === "-1") return location.pathname.match(/\/status\/(\d+)/)?.[1] || null;
    return null;
  }

  /* Whether a post has photos or videos to save: its kept details say so, or the page shows
     some (its own, or a quoted post's). */
  function hasMedia(article, id) {
    if (mediaOf(posts.get(id)).media.length) return true;
    return [...article.querySelectorAll(MEDIA_IN_PAGE)].some(element => element.closest("article") === article);
  }

  /* The action bar of a post: the group that holds its Reply and Like buttons. */
  function barOf(article) {
    const reply = [...article.querySelectorAll('[data-testid="reply"]')].find(element => element.closest("article") === article);
    return reply?.closest('[role="group"]') || null;
  }

  function startButtons() {
    const hosts = new Set();
    const scan = () => {
      for (const article of document.querySelectorAll('article[data-testid="tweet"], article[role="article"]')) {
        const bar = barOf(article);
        if (!bar) continue;
        const id = idOfArticle(article);
        const existing = bar.querySelector(":scope > " + HOST_TAG);
        if (existing && existing.dataset.id === id) continue;
        existing?.remove();
        if (!id || !hasMedia(article, id)) continue;
        /* Right after Share, the last item of the bar. */
        const host = makeHost(id, bar);
        bar.append(host);
        hosts.add(host);
      }
    };
    let queued = false;
    const queue = () => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => {
        queued = false;
        scan();
      });
    };
    const observer = new MutationObserver(queue);
    observer.observe(document.body, { childList: true, subtree: true });
    scan();
    return {
      stop() {
        observer.disconnect();
        for (const host of document.querySelectorAll(HOST_TAG)) if (!("panel" in host.dataset)) host.remove();
        hosts.clear();
      },
    };
  }

  function toast(message) {
    const note = document.createElement("div");
    note.textContent = message;
    note.style.cssText = "position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483647;padding:10px 16px;" +
      "border-radius:999px;background:rgba(22,22,22,.85);color:#fff;font:14px -apple-system,sans-serif;pointer-events:none";
    document.documentElement.append(note);
    setTimeout(() => note.remove(), 2500);
  }

  /* ---------- The list of downloads ---------- */

  /* A panel over the page (opened from Tampermonkey's menu) listing what was downloaded, newest
     first: a small picture, whose it is, what was saved, the text, when, a link to it and a
     button that forgets it (its button is no longer blue). A search box filters the list. */
  const PANEL_CSS = [
    ":host{all:initial;position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgba(0,0,0,.6);",
    "font:14px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#e7e9ea}",
    ".panel{width:min(880px,calc(100vw - 32px));height:min(82vh,920px);display:flex;flex-direction:column;background:#000;",
    "border-radius:16px;box-shadow:0 24px 70px rgba(0,0,0,.55),inset 0 0 0 1px #2f3336;overflow:hidden}",
    "header{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid #2f3336}",
    "h2{margin:0;font-size:17px;font-weight:700;color:#fff;white-space:nowrap}",
    ".count{color:#71767b;font-size:13px;white-space:nowrap}",
    "input{flex:1;min-width:0;box-sizing:border-box;background:#202327;border:1px solid transparent;border-radius:999px;padding:8px 14px;",
    "color:#e7e9ea;font:inherit;outline:none}",
    "input:focus{border-color:" + DONE_COLOUR + ";background:#000}",
    "button{all:unset;box-sizing:border-box;cursor:pointer;display:grid;place-items:center;border-radius:50%;flex:none}",
    "button:focus-visible{outline:2px solid currentColor;outline-offset:1px}",
    ".close{width:32px;height:32px;color:#aaa}",
    ".close:hover{background:#181818;color:#fff}",
    "svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}",
    ".list{flex:1;overflow:auto;padding:4px 8px 14px}",
    ".section{padding:16px 10px 6px;color:#71767b;font-size:12px;font-weight:700;letter-spacing:.03em}",
    ".row{display:flex;align-items:center;gap:12px;padding:8px 10px;border-radius:10px}",
    ".row:hover{background:#16181c}",
    ".thumb{width:56px;height:56px;flex:none;border-radius:8px;background:#202327 center/cover no-repeat;display:grid;place-items:center;color:#555}",
    ".main{flex:1;min-width:0}",
    ".top{display:flex;align-items:center;gap:8px;min-width:0}",
    ".owner{font-weight:700;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
    ".kind{flex:none;padding:1px 8px;border-radius:999px;font-size:12px;font-weight:600;color:" + DONE_COLOUR + ";background:rgba(29,155,240,.16)}",
    ".text{color:#71767b;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:3px}",
    ".when{flex:none;color:#71767b;font-size:12px;text-align:right;white-space:nowrap}",
    "a{flex:none;color:" + DONE_COLOUR + ";text-decoration:none;font-size:13px;white-space:nowrap}",
    "a:hover{text-decoration:underline}",
    ".remove{width:30px;height:30px;color:#71767b}",
    ".remove:hover{background:rgba(244,33,46,.1);color:#f4212e}",
    ".remove svg{width:16px;height:16px}",
    ".more{margin:12px auto 0;padding:8px 16px;border-radius:999px;background:#202327;color:#e7e9ea;display:block;width:max-content}",
    ".more:hover{background:#2f3336}",
    ".empty{padding:48px 16px;text-align:center;color:#71767b}",
  ].join("");

  const PANEL_ICONS = {
    close: ["M6 6l12 12", "M18 6 6 18"],
    remove: ["M4.5 7h15", "M9.5 7V5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v2", "M6.5 7l1 12a1.5 1.5 0 0 0 1.5 1.5h6a1.5 1.5 0 0 0 1.5-1.5l1-12"],
    picture: ["M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z", "m20 15-5-5L5 20"],
  };
  function panelIcon(name) {
    const namespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(namespace, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    for (const data of PANEL_ICONS[name]) {
      const path = document.createElementNS(namespace, "path");
      path.setAttribute("d", data);
      svg.append(path);
    }
    return svg;
  }

  const PAGE_SIZE = 150;

  /* Every remembered download, newest first, as the panel shows it. */
  function downloadLines() {
    return [...downloaded].map(key => {
      const info = store.get("i:" + key) || {};
      const id = key.split(":")[1];
      return {
        key,
        id,
        at: info.at || 0,
        owner: info.owner ? ownerName(info.owner, info.name) : "",
        text: info.text || "",
        kind: info.kind || "Post",
        link: info.link || "https://x.com/i/status/" + id,
        thumb: info.thumb || "",
      };
    }).sort((a, b) => b.at - a.at);
  }

  function openDownloads() {
    if (document.querySelector(HOST_TAG + "[data-panel]")) return;
    const lines = downloadLines();
    const host = document.createElement(HOST_TAG);
    host.dataset.panel = "";
    const root = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = PANEL_CSS;
    const panel = document.createElement("div");
    panel.className = "panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", "X downloads");
    const header = document.createElement("header");
    const title = document.createElement("h2");
    title.textContent = "X downloads";
    const count = document.createElement("span");
    count.className = "count";
    const search = document.createElement("input");
    search.type = "search";
    search.placeholder = "Search by account, text or kind";
    const close = document.createElement("button");
    close.className = "close";
    close.title = "Close (Esc)";
    close.setAttribute("aria-label", "Close");
    close.append(panelIcon("close"));
    header.append(title, count, search, close);
    const list = document.createElement("div");
    list.className = "list";
    panel.append(header, list);
    root.append(style, panel);

    let shown = PAGE_SIZE;
    const matching = () => {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      return lines.filter(line => {
        const text = (line.owner + " " + line.text + " " + line.kind + " " + line.id).toLowerCase();
        return words.every(word => text.includes(word));
      });
    };
    const showCount = found => {
      count.textContent = found === lines.length ? lines.length + "" : found + " of " + lines.length;
    };
    const render = () => {
      const found = matching();
      showCount(found.length);
      list.textContent = "";
      if (!found.length) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = lines.length ? "Nothing matches the search." : "Nothing has been downloaded yet.";
        list.append(empty);
        return;
      }
      let section = null;
      for (const line of found.slice(0, shown)) {
        const name = line.at ? new Date(line.at).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }) : "Earlier";
        if (name !== section) {
          section = name;
          const heading = document.createElement("div");
          heading.className = "section";
          heading.textContent = name;
          list.append(heading);
        }
        list.append(renderLine(line));
      }
      if (found.length > shown) {
        const more = document.createElement("button");
        more.className = "more";
        more.textContent = "Show " + Math.min(PAGE_SIZE, found.length - shown) + " more";
        more.addEventListener("click", () => {
          shown += PAGE_SIZE;
          render();
        });
        list.append(more);
      }
    };
    const renderLine = line => {
      const row = document.createElement("div");
      row.className = "row";
      const thumb = document.createElement("div");
      thumb.className = "thumb";
      if (line.thumb) thumb.style.backgroundImage = "url(\"" + line.thumb + "\")";
      else thumb.append(panelIcon("picture"));
      const main = document.createElement("div");
      main.className = "main";
      const top = document.createElement("div");
      top.className = "top";
      const owner = document.createElement("span");
      owner.className = "owner";
      owner.textContent = line.owner || line.id;
      const kind = document.createElement("span");
      kind.className = "kind";
      kind.textContent = line.kind;
      top.append(owner, kind);
      main.append(top);
      if (line.text) {
        const text = document.createElement("div");
        text.className = "text";
        text.textContent = line.text;
        text.title = line.text;
        main.append(text);
      }
      const when = document.createElement("span");
      when.className = "when";
      if (line.at) {
        when.textContent = new Date(line.at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
        when.title = new Date(line.at).toLocaleString();
      }
      const link = document.createElement("a");
      link.href = line.link;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = "Open ↗";
      const remove = document.createElement("button");
      remove.className = "remove";
      remove.title = "Forget this download (its button is no longer blue; the files stay)";
      remove.setAttribute("aria-label", remove.title);
      remove.append(panelIcon("remove"));
      remove.addEventListener("click", () => {
        forgetDownload(line.key);
        lines.splice(lines.indexOf(line), 1);
        row.remove();
        showCount(matching().length);
      });
      row.append(thumb, main, when, link, remove);
      return row;
    };

    const shut = () => {
      host.remove();
      document.removeEventListener("keydown", onKey, true);
    };
    const onKey = event => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        shut();
      }
    };
    document.addEventListener("keydown", onKey, true);
    close.addEventListener("click", shut);
    host.addEventListener("click", event => {
      if (event.composedPath()[0] === host) shut();
    });
    /* Keys typed in the search box don't reach X (its keyboard shortcuts). */
    for (const type of ["keydown", "keyup", "keypress"]) host.addEventListener(type, event => event.stopPropagation());
    search.addEventListener("input", () => {
      shown = PAGE_SIZE;
      render();
    });
    render();
    document.documentElement.append(host);
    search.focus();
  }

  /* ---------- Start ---------- */

  /* The listener starts at once (as a userscript, before X's own code); the buttons once the
     page has a body. Each bookmarklet click turns the buttons on or off. */
  function start() {
    if (!/(^|\.)(x|twitter)\.com$/.test(location.hostname)) {
      alert("X Downloader only works on x.com.");
      return;
    }
    startListening();
    console.info(LOG, "version " + VERSION);
    if (page.__xDownloader) {
      page.__xDownloader.stop();
      page.__xDownloader = null;
      toast("X Downloader is off.");
      return;
    }
    if (typeof GM_registerMenuCommand === "function") GM_registerMenuCommand("Downloads", openDownloads);
    const begin = () => {
      page.__xDownloader = startButtons();
      if (!AUTO_START) toast("X Downloader is on. Click the bookmarklet again to turn it off.");
    };
    if (document.body) begin();
    else document.addEventListener("DOMContentLoaded", begin, { once: true });
  }

  /* Exposed for smoke-test.js only. */
  if (page.__xDownloaderTest) page.__xDownloaderTest({ fromApi, fromEmbed, collectText, posts, mediaOf, fileBase, embedToken, idOfArticle });

  try {
    start();
  } catch (error) {
    console.error(LOG, error);
    alert("Something went wrong: " + error.message);
  }
})();
