// ==UserScript==
// @name         X Downloader
// @version      0.1.1
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
 * On a profile's media tab, "Download all videos" and "Download all photos" in the tab's menu
 * save every video and GIF, or every photo, of the account: into a folder named after it in a
 * folder chosen once (Chrome, Edge), or in ZIP files of about 500 MB each (other browsers):
 * the following pages of the tab are asked for as X's own page asks for them, posts already
 * downloaded are skipped, and a box in the corner shows the progress, with a Stop button.
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
  const VERSION = "0.1.1";
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
    /* Account ids by lower-case username, and X's last request for each media timeline. */
    userIds: new Map(),
    timelines: {},
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
    const screenName = user.core?.screen_name || user.legacy?.screen_name;
    if (screenName && /^\d+$/.test(user.rest_id || "")) shared.userIds.set(screenName.toLowerCase(), user.rest_id);
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

  /* Keeps every post found in a response, however deep it is. `found` (when given) gets the
     posts of the response itself, in order, without the posts they quote or repost. */
  function collectPosts(value, depth = 0, found = null) {
    if (!value || typeof value !== "object" || depth > 40) return;
    if (value.__typename === "Tweet" || value.__typename === "TweetWithVisibilityResults" || value.legacy && value.rest_id) {
      const post = fromApi(value);
      if (post) {
        keep(post);
        found?.push(post);
        found = null;
      }
    }
    for (const key in value) collectPosts(value[key], depth + 1, found);
  }

  function collectText(text) {
    if (!text || text[0] !== "{" && text[0] !== "[") return;
    try {
      collectPosts(JSON.parse(text));
    } catch (ignored) {}
  }

  const isApiUrl = url => /\/i\/api\/|\/graphql\/|api\.(x|twitter)\.com/.test(String(url || ""));

  /* The media tab of a profile loads its posts with one of these requests ("Photos" and "Videos"
     are its two choices; UserMedia was the single tab before them). */
  const TIMELINES = ["UserPhotoTimeline", "UserVideoTimeline", "UserMedia"];
  const timelineOf = url => String(url || "").match(/\/graphql\/[^/]+\/(UserPhotoTimeline|UserVideoTimeline|UserMedia)\b/)?.[1];

  /* Keeps X's own request for a media timeline (its address and headers: the session's token
     and CSRF token), so the following pages can be asked for the same way. */
  function rememberTimeline(url, headers) {
    const name = timelineOf(url);
    if (!name) return;
    const plain = {};
    if (headers instanceof page.Headers || headers instanceof Headers) headers.forEach((value, key) => { plain[key] = value; });
    else if (Array.isArray(headers)) for (const [key, value] of headers) plain[key] = value;
    else Object.assign(plain, headers || {});
    shared.timelines[name] = { url: new URL(url, location.href).href, headers: plain, at: Date.now() };
  }
  /* Wraps fetch and XMLHttpRequest once to read X's API responses, which are left untouched. */
  function startListening() {
    if (shared.listening) return;
    shared.listening = true;

    const pageFetch = page.fetch;
    page.fetch = function (input, init) {
      const result = pageFetch.apply(this, arguments);
      const url = typeof input === "string" ? input : input?.url;
      if (isApiUrl(url)) {
        try {
          if (timelineOf(url)) rememberTimeline(url, init?.headers || input?.headers);
        } catch (ignored) {}
        result.then(response => response.clone().text()).then(collectText).catch(() => {});
      }
      return result;
    };

    const open = page.XMLHttpRequest.prototype.open;
    const setRequestHeader = page.XMLHttpRequest.prototype.setRequestHeader;
    page.XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
      if (this.__xDownloaderHeaders) this.__xDownloaderHeaders[name] = value;
      return setRequestHeader.apply(this, arguments);
    };
    page.XMLHttpRequest.prototype.open = function (method, url) {
      if (timelineOf(url)) {
        const headers = this.__xDownloaderHeaders = {};
        this.addEventListener("load", () => {
          if (this.status === 200) rememberTimeline(url, headers);
        });
      }
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

  /* "t:<post id>": every photo and video of the post was downloaded (its button); "p:<post id>"
     its photos, "v:<post id>" its videos and GIFs (downloading all of a profile's photos or
     videos). Each key maps to null
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

  /* Whether all of a post's media was downloaded: with its button, or its photos and its videos
     each with "download all". */
  function postDone(id) {
    if (isDownloaded("t:" + id)) return true;
    const media = posts.get(id)?.media || [];
    if (!media.length) return false;
    const photos = media.some(item => item.kind === "photo");
    const videos = media.some(item => item.kind !== "photo");
    return (!photos || isDownloaded("p:" + id)) && (!videos || isDownloaded("v:" + id));
  }

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
    return saveMedia(post, media, onProgress);
  }

  /* Downloads some of a post's photos and videos, as { name, blob } files. A file is numbered
     by its place in the post ("… - 3.jpg" is the post's third), so its name is the same
     whichever button saved it. */
  async function fetchFiles(post, media, onProgress) {
    const files = [];
    for (let index = 0; index < media.length; index++) {
      const blob = await downloadMedia(media[index], fraction => onProgress?.((index + fraction) / media.length));
      const place = post.media.indexOf(media[index]);
      const number = post.media.length > 1 ? " - " + (place + 1) : "";
      const extension = extensionOf(blob.type) || (media[index].kind === "photo" ? "jpg" : "mp4");
      files.push({ name: fileBase(post) + number + "." + extension, blob });
      onProgress?.((index + 1) / media.length);
    }
    return files;
  }

  /* What to remember about a download, for the list of downloads. */
  function describePost(post, media) {
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

  /* Saves some of a post's photos and videos, each its own file. Returns what to remember. */
  async function saveMedia(post, media, onProgress) {
    const files = await fetchFiles(post, media, onProgress);
    for (let index = 0; index < files.length; index++) {
      saveBlob(files[index].blob, files[index].name);
      /* Browsers drop downloads started too close together. */
      if (index < files.length - 1) await wait(300);
    }
    return describePost(post, media);
  }

  /* ---------- ZIP files ---------- */

  /* A ZIP file without compression (photos and videos are compressed already), written by hand:
     a local header before each file, a central directory after them. Names are UTF-8. Each part
     stays far below 4 GB, so the plain (not ZIP64) format is enough. */
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ c >>> 1 : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (let index = 0; index < bytes.length; index++) crc = CRC_TABLE[(crc ^ bytes[index]) & 0xff] ^ crc >>> 8;
    return (crc ^ 0xffffffff) >>> 0;
  }

  /* Time and date in the format ZIP keeps them (local time, two-second steps). */
  function dosTime(date) {
    return {
      time: date.getHours() << 11 | date.getMinutes() << 5 | Math.floor(date.getSeconds() / 2),
      date: Math.max(0, date.getFullYear() - 1980) << 9 | date.getMonth() + 1 << 5 | date.getDate(),
    };
  }

  function makeZip() {
    const entries = [];
    let size = 0;
    const names = new Set();
    return {
      get size() {
        return size;
      },
      get count() {
        return entries.length;
      },
      /* Adds a file; a name already used gets " (2)", " (3)" … before its extension. */
      async add(name, blob, when = new Date()) {
        let unique = name;
        for (let n = 2; names.has(unique); n++) unique = name.replace(/(\.[^.]*)?$/, " (" + n + ")$1");
        names.add(unique);
        const bytes = new Uint8Array(await blob.arrayBuffer());
        entries.push({ name: new TextEncoder().encode(unique), blob, crc: crc32(bytes), length: bytes.length, ...dosTime(when) });
        size += bytes.length;
      },
      toBlob() {
        const parts = [];
        const central = [];
        let offset = 0;
        for (const entry of entries) {
          const local = new DataView(new ArrayBuffer(30));
          local.setUint32(0, 0x04034b50, true);
          local.setUint16(4, 20, true);
          local.setUint16(6, 0x0800, true);
          local.setUint16(8, 0, true);
          local.setUint16(10, entry.time, true);
          local.setUint16(12, entry.date, true);
          local.setUint32(14, entry.crc, true);
          local.setUint32(18, entry.length, true);
          local.setUint32(22, entry.length, true);
          local.setUint16(26, entry.name.length, true);
          local.setUint16(28, 0, true);
          parts.push(local.buffer, entry.name, entry.blob);
          const header = new DataView(new ArrayBuffer(46));
          header.setUint32(0, 0x02014b50, true);
          header.setUint16(4, 20, true);
          header.setUint16(6, 20, true);
          header.setUint16(8, 0x0800, true);
          header.setUint16(10, 0, true);
          header.setUint16(12, entry.time, true);
          header.setUint16(14, entry.date, true);
          header.setUint32(16, entry.crc, true);
          header.setUint32(20, entry.length, true);
          header.setUint32(24, entry.length, true);
          header.setUint16(28, entry.name.length, true);
          header.setUint32(42, offset, true);
          central.push(header.buffer, entry.name);
          offset += 30 + entry.name.length + entry.length;
        }
        const centralSize = central.reduce((total, part) => total + part.byteLength, 0);
        const end = new DataView(new ArrayBuffer(22));
        end.setUint32(0, 0x06054b50, true);
        end.setUint16(8, entries.length, true);
        end.setUint16(10, entries.length, true);
        end.setUint32(12, centralSize, true);
        end.setUint32(16, offset, true);
        return new Blob([...parts, ...central, end.buffer], { type: "application/zip" });
      },
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
      const done = postDone(id);
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

  /* ---------- Every photo or video of a profile ---------- */

  /* Which half of a profile's media tab is showing: "photo" (?filter=photo) or "video", and
     whose profile it is. */
  const mediaTabKind = () => new URLSearchParams(location.search).get("filter") === "photo" ? "photo" : "video";
  const mediaTabUser = () => location.pathname.match(/^\/(\w{1,15})\/media\/?$/)?.[1] || null;

  /* Where the next page of a timeline starts. */
  function bottomCursor(value, depth = 0) {
    if (!value || typeof value !== "object" || depth > 40) return null;
    if (value.cursorType === "Bottom" && typeof value.value === "string") return value.value;
    for (const key in value) {
      const found = bottomCursor(value[key], depth + 1);
      if (found) return found;
    }
    return null;
  }

  /* Waits, a second at a time, so a stopped run doesn't keep waiting. */
  async function waitUnlessStopped(ms, run) {
    for (const end = Date.now() + ms; Date.now() < end && !run.stopped;) await wait(Math.min(1000, end - Date.now()));
  }

  /* One page of a profile's photos or videos, asked for as X's own page asks for it (the same
     address and headers, with the next cursor). When X says to slow down (429), waits until it
     allows more. */
  async function timelinePage(run, cursor, update) {
    const template = shared.timelines[run.kind === "photo" ? "UserPhotoTimeline" : "UserVideoTimeline"] || shared.timelines.UserMedia;
    if (!template) throw new Error("Couldn't find X's list of posts. Reload the page and try again.");
    const url = new URL(template.url);
    const variables = JSON.parse(url.searchParams.get("variables") || "{}");
    const userId = shared.userIds.get(run.user.toLowerCase());
    if (userId) variables.userId = userId;
    if (!variables.userId) throw new Error("Couldn't find this account. Reload the page and try again.");
    if (cursor) variables.cursor = cursor;
    else delete variables.cursor;
    url.searchParams.set("variables", JSON.stringify(variables));
    /* A transaction id is made for each request: an old one is left out rather than sent again. */
    const headers = {};
    for (const [name, value] of Object.entries(template.headers)) if (!/^x-client-transaction-id$/i.test(name)) headers[name] = value;
    for (let attempt = 0; ; attempt++) {
      const response = await shared.nativeFetch(url.href, { headers, credentials: "include" });
      if (response.status === 429 && attempt < 6 && !run.stopped) {
        const reset = Number(response.headers.get("x-rate-limit-reset")) * 1000;
        const delay = reset > Date.now() ? Math.min(reset - Date.now() + 2000, 16 * 60 * 1000) : 60 * 1000;
        run.note = "X asks to slow down: carrying on in " + Math.ceil(delay / 60000) + " min.";
        update();
        await waitUnlessStopped(delay, run);
        run.note = "";
        update();
        continue;
      }
      if (!response.ok) throw new Error("X answered " + response.status + " when asked for the posts.");
      return response.json();
    }
  }

  /* A ZIP part is saved once its files reach this size, so a run never holds more than about
     this much in memory, and a stopped or failed run keeps what was saved before. */
  const PART_SIZE = 500 * 1024 * 1024;

  /* The run in progress: { user, kind, folder, saved, skipped, failed, part, partSize, stopped,
     done, note }. One at a time. */
  let bulk = null;

  /* The folder runs save into is chosen once (the chooser opens in Downloads) and remembered,
     as a handle kept in x.com's IndexedDB: Tampermonkey's storage can't hold one. */
  const FOLDER_DB = "xDownloader";
  async function folderStore(mode, action) {
    const open = indexedDB.open(FOLDER_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore("handles");
    const db = await new Promise((resolve, reject) => {
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      const request = action(db.transaction("handles", mode).objectStore("handles"));
      return await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  }
  const savedFolder = () => folderStore("readonly", store => store.get("folder")).catch(() => null);
  const saveFolder = handle => folderStore("readwrite", store => store.put(handle, "folder")).catch(error =>
    console.warn(LOG, "couldn't remember the folder", error));
  const forgetFolder = () => folderStore("readwrite", store => store.delete("folder")).catch(() => {});

  /* Where a run saves, when the browser can write to a folder (Chrome, Edge): in the folder
     chosen once (Downloads, say), a folder named after the account, "NASA". The browser asks
     again for leave to write there when it has forgotten it (it can be told to allow it on every
     visit). Returns null when the browser can't write to a folder, or the chooser couldn't
     open: then the run makes ZIP files. Throws an AbortError when the user says no. */
  async function chooseFolder(user, kind) {
    if (typeof page.showDirectoryPicker !== "function") return null;
    const noun = kind === "photo" ? "photo" : "video";
    let parent = await savedFolder();
    if (parent) {
      try {
        let state = await parent.queryPermission({ mode: "readwrite" });
        if (state !== "granted") state = await parent.requestPermission({ mode: "readwrite" });
        if (state !== "granted") parent = null;
      } catch (error) {
        console.warn(LOG, "couldn't use the remembered folder", error);
        parent = null;
      }
    }
    if (parent) {
      if (!confirm("Download every " + noun + " of @" + user + " into " + parent.name + "/" + user + "?\n\n" +
        "Posts you already downloaded are skipped. (Another folder: \"Change download folder\" in Tampermonkey's menu.)")) {
        throw new DOMException("Cancelled", "AbortError");
      }
    } else {
      try {
        parent = await page.showDirectoryPicker({ id: "x-downloader", mode: "readwrite", startIn: "downloads" });
      } catch (error) {
        if (error?.name === "AbortError") throw error;
        console.warn(LOG, "couldn't open the folder chooser, making ZIP files instead", error);
        return null;
      }
      await saveFolder(parent);
    }
    try {
      const folder = await parent.getDirectoryHandle(user, { create: true });
      folder.parentName = parent.name;
      return folder;
    } catch (error) {
      /* The remembered folder was moved or deleted: it is chosen again next time. */
      await forgetFolder();
      throw new Error("Couldn't write to the folder " + parent.name + " (" + error.message + "). Choose it again on the next try.");
    }
  }

  /* Writes a file into a folder, replacing one of the same name (the same photo or video, from
     an earlier run whose download was forgotten). */
  async function writeFile(folder, name, blob) {
    const handle = await folder.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(blob);
      await writable.close();
    } catch (error) {
      await writable.abort?.().catch(() => {});
      throw error;
    }
  }

  /* Saves the photos (kind "photo") or the videos and GIFs ("video") of every post in a
     profile's media tab, newest first, page by page: into `folder` when there is one, each
     file as it comes, otherwise in ZIP files of about PART_SIZE each ("NASA - photos -
     2026-11-23 - 1.zip"). A post whose photos or videos were already downloaded (or the whole
     post, with its button) is skipped; a post counts as downloaded once its files are in the
     folder, or once the ZIP part that holds them has been saved. */
  async function downloadAll(user, kind, update, folder = null) {
    const run = bulk = { user, kind, folder: folder ? folder.parentName + "/" + folder.name : "", saved: 0, skipped: 0, failed: 0, part: 1, partSize: 0,
      stopped: false, done: false, note: "" };
    update(run);
    const key = (kind === "photo" ? "p:" : "v:");
    const day = new Date().toISOString().slice(0, 10);
    const seen = new Set();
    let zip = makeZip();
    let pending = [];
    const flush = () => {
      if (!zip.count) return;
      saveBlob(zip.toBlob(), user + " - " + kind + "s - " + day + " - " + run.part + ".zip");
      for (const { id, details } of pending) markDownloaded(key + id, details);
      run.saved += pending.length;
      pending = [];
      zip = makeZip();
      run.part++;
      run.partSize = 0;
      update(run);
    };
    let cursor = null;
    let empty = 0;
    try {
      while (!run.stopped) {
        const found = [];
        const json = await timelinePage(run, cursor, update);
        collectPosts(json, 0, found);
        const fresh = found.filter(post => !seen.has(post.id));
        for (const post of fresh) seen.add(post.id);
        for (const post of fresh) {
          if (run.stopped) break;
          const media = post.media.filter(item => kind === "photo" ? item.kind === "photo" : item.kind !== "photo");
          if (!media.length) continue;
          if (isDownloaded("t:" + post.id) || isDownloaded(key + post.id)) {
            run.skipped++;
            update(run);
            continue;
          }
          try {
            const files = await fetchFiles(post, media);
            if (folder) {
              for (const file of files) await writeFile(folder, file.name, file.blob);
              markDownloaded(key + post.id, describePost(post, media));
              run.saved++;
            } else {
              const when = post.posted ? new Date(post.posted) : new Date();
              for (const file of files) await zip.add(file.name, file.blob, when);
              pending.push({ id: post.id, details: describePost(post, media) });
            }
          } catch (error) {
            run.failed++;
            console.warn(LOG, "couldn't download post " + post.id, error);
          }
          run.partSize = zip.size;
          update(run);
          if (zip.size >= PART_SIZE) flush();
        }
        /* The end: no next page, or pages with nothing new. */
        const next = bottomCursor(json);
        empty = fresh.length ? 0 : empty + 1;
        if (!next || next === cursor || empty >= 2) break;
        cursor = next;
      }
    } finally {
      /* Whatever was collected is saved, also when stopped or after an error. */
      flush();
      run.done = true;
      bulk = null;
      update(run);
    }
    return run;
  }

  /* Shows the state of the run in the media tab's menu and in the progress box. */
  function updateBulk(run = bulk) {
    for (const element of document.querySelectorAll("[data-x-downloader-item]")) element.render?.();
    if (run) showProgress(run);
  }

  /* Starts downloading every photo or video of an account, or stops it when it is running.
     `before` (when given) runs once the start is confirmed: the menu uses it to show that half
     of the tab first. */
  async function toggleBulk(user, kind, before = null) {
    const noun = kind === "photo" ? "photo" : "video";
    if (bulk) {
      if (bulk.user === user && bulk.kind === kind) {
        bulk.stopped = true;
        updateBulk();
      } else {
        alert("Already downloading every " + (bulk.kind === "photo" ? "photo" : "video") + " of @" + bulk.user + ". Stop that first.");
      }
      before?.(false);
      return;
    }
    /* Choosing the folder (or saying yes to the remembered one) is the go-ahead; without one
       (another browser), a question about ZIP files is. The folder comes first: the browser
       opens its chooser, or asks for leave to write, only right after the click. */
    let folder = null;
    try {
      folder = await chooseFolder(user, kind);
    } catch (error) {
      if (error?.name !== "AbortError") alert(error?.message || "Couldn't use that folder.");
      before?.(false);
      return;
    }
    if (!folder && !confirm("Download every " + noun + " of @" + user + "?\n\nThey are saved in ZIP files of about " +
      Math.round(PART_SIZE / 1024 / 1024) + " MB each. Posts you already downloaded are skipped.")) {
      before?.(false);
      return;
    }
    let run = null;
    try {
      await before?.(true);
      run = await downloadAll(user, kind, current => updateBulk(current || bulk), folder);
    } catch (error) {
      console.error(LOG, error);
      alert(error?.message || "Download failed.");
    } finally {
      updateBulk(run);
    }
  }

  /* ---------- The progress box ---------- */

  const PROGRESS_CSS = [
    ":host{all:initial;position:fixed;right:20px;bottom:84px;z-index:2147483646;",
    "font:14px/1.35 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#fff}",
    ".box{display:flex;align-items:center;gap:14px;min-width:260px;max-width:360px;padding:12px 12px 12px 16px;border-radius:16px;",
    "background:rgba(22,24,28,.92);-webkit-backdrop-filter:blur(14px);backdrop-filter:blur(14px);",
    "box-shadow:0 8px 28px rgba(0,0,0,.35),inset 0 0 0 1px rgba(255,255,255,.1)}",
    ".icon{flex:none;width:22px;height:22px;color:" + DONE_COLOUR + "}",
    ".icon svg{width:100%;height:100%;fill:currentColor}",
    ".running .icon{animation:pulse 1.2s ease-in-out infinite}",
    "@keyframes pulse{50%{opacity:.3}}",
    ".main{flex:1;min-width:0}",
    ".title{font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}",
    ".line{color:#a3aab2;font-size:13px}",
    ".note{color:#ffd400;font-size:13px}",
    "button{all:unset;box-sizing:border-box;flex:none;cursor:pointer;border-radius:999px;font-weight:700;font-size:14px}",
    "button:focus-visible{outline:2px solid " + DONE_COLOUR + ";outline-offset:2px}",
    ".stop{padding:7px 14px;background:#fff;color:#0f1419}",
    ".stop:hover{background:#e7e9ea}",
    ".close{width:30px;height:30px;display:grid;place-items:center;color:#a3aab2;font-size:18px}",
    ".close:hover{background:rgba(255,255,255,.1);color:#fff}",
  ].join("");

  const megabytes = bytes => (bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0) + " MB";

  /* A box in the corner while a run goes on (it stays when leaving the profile), with a Stop
     button; once the run ends it says what was saved, and goes away after a while. */
  function showProgress(run) {
    let host = document.querySelector(HOST_TAG + "[data-progress]");
    if (!host) {
      host = document.createElement(HOST_TAG);
      host.dataset.progress = "";
      const root = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = PROGRESS_CSS;
      root.append(style, document.createElement("div"));
      isolateEvents(host);
      document.documentElement.append(host);
    }
    clearTimeout(host.hideTimer);
    const box = host.shadowRoot.lastElementChild;
    box.className = "box" + (run.done ? "" : " running");
    const noun = run.kind === "photo" ? "photos" : "videos";
    const element = (tag, className, text) => {
      const node = document.createElement(tag);
      node.className = className;
      if (text) node.textContent = text;
      return node;
    };
    const iconBox = element("div", "icon");
    iconBox.append(icon("download"));
    const main = element("div", "main");
    main.append(element("div", "title", run.done
      ? (run.stopped ? "Stopped" : "Done") + ": " + noun + " of @" + run.user
      : (run.stopped ? "Stopping…" : "Downloading all " + noun + " of @" + run.user)));
    const counts = [run.saved + " posts saved"];
    if (run.skipped) counts.push(run.skipped + " already downloaded");
    if (run.failed) counts.push(run.failed + " failed");
    main.append(element("div", "line", counts.join(" · ")));
    if (run.folder) main.append(element("div", "line", "Into " + run.folder));
    else if (!run.done) main.append(element("div", "line", "ZIP part " + run.part + ": " + megabytes(run.partSize)));
    if (run.note) main.append(element("div", "note", run.note));
    const button = run.done ? element("button", "close", "×") : element("button", "stop", "Stop");
    button.type = "button";
    button.title = run.done ? "Close" : "Stop (what was collected is saved)";
    button.setAttribute("aria-label", button.title);
    button.addEventListener("click", () => {
      if (run.done) host.remove();
      else {
        run.stopped = true;
        showProgress(run);
        updateBulk();
      }
    });
    if (run.stopped && !run.done) button.disabled = true;
    box.replaceChildren(iconBox, main, button);
    if (run.done) host.hideTimer = setTimeout(() => host.remove(), 15000);
  }

  /* The media tab's menu (Videos, Photos) gets two more items: download every video, download
     every photo. They are copies of X's own items, so they look the same; X doesn't handle
     them (its handlers aren't copied). Choosing the half the tab isn't showing switches the tab
     to it first, which also has X ask for that list once (its request is the one repeated). */
  function addMenuItems() {
    const user = mediaTabUser();
    const tab = user && document.querySelector('[role="tablist"] a[role="tab"][aria-expanded="true"]');
    if (!tab || !/\/media\/?(\?|$)/i.test(tab.getAttribute("href") || "")) return;
    const menu = document.querySelector('[role="menu"]');
    const own = menu && [...menu.querySelectorAll('[role="menuitem"]')].filter(item => !item.hasAttribute("data-x-downloader-item"));
    if (!own || own.length !== 2) return;
    const added = [...menu.querySelectorAll("[data-x-downloader-item]")];
    if (added.length) {
      /* X redraws its menu (as a run starts) and can move its own items after ours. */
      if (own[own.length - 1].nextElementSibling !== added[0]) own[own.length - 1].after(...added);
      return;
    }
    const current = mediaTabKind();
    /* X marks the half showing with a check mark: that item is this kind, the other one the other. */
    const shown = own.find(item => item.querySelector("svg")) || own[current === "photo" ? 1 : 0];
    const other = own.find(item => item !== shown);
    const checkSvg = shown.querySelector("svg");
    const textColour = getComputedStyle(shown.querySelector("[dir]") || shown).color;
    const line = document.createElement("div");
    line.setAttribute("data-x-downloader-item", "");
    line.style.cssText = "height:1px;margin:4px 0;background:" + textColour + ";opacity:.15";
    const items = ["video", "photo"].map(kind => {
      const item = own[own.length - 1].cloneNode(true);
      item.setAttribute("data-x-downloader-item", "");
      item.removeAttribute("aria-checked");
      const label = item.querySelector("span") || item;
      const side = item.querySelector("svg")?.parentElement || item.lastElementChild;
      side?.replaceChildren();
      const mark = icon("download");
      if (checkSvg) mark.setAttribute("class", checkSvg.getAttribute("class") || "");
      mark.style.cssText = "fill:currentColor;color:" + textColour;
      side?.append(mark);
      item.render = () => {
        const run = bulk && bulk.user === user && bulk.kind === kind ? bulk : null;
        label.textContent = run ? (run.stopped ? "Stopping…" : "Stop downloading " + kind + "s")
          : "Download all " + kind + "s";
        mark.style.color = run ? DONE_COLOUR : textColour;
      };
      item.render();
      item.addEventListener("click", event => {
        event.stopPropagation();
        event.preventDefault();
        toggleBulk(user, kind, async go => {
          /* X's own item closes the menu: the other half's also shows it, when a run starts there. */
          (go && kind !== current ? other : shown).click();
          if (!go || kind === current) return;
          const name = kind === "photo" ? "UserPhotoTimeline" : "UserVideoTimeline";
          const since = Date.now();
          for (let waited = 0; waited < 10000 && !(shared.timelines[name]?.at >= since); waited += 200) await wait(200);
        });
      });
      return item;
    });
    own[own.length - 1].after(line, ...items);
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
      addMenuItems();
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

  function toast(message, duration = 2500) {
    const note = document.createElement("div");
    note.textContent = message;
    note.style.cssText = "position:fixed;left:50%;bottom:32px;transform:translateX(-50%);z-index:2147483647;padding:10px 16px;" +
      "border-radius:999px;background:rgba(22,22,22,.85);color:#fff;font:14px -apple-system,sans-serif;pointer-events:none";
    document.documentElement.append(note);
    setTimeout(() => note.remove(), duration);
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

  /* Every remembered download, newest first, as the panel shows it: one line per post, whether
     it was saved whole, or its photos and its videos each with "download all". */
  function downloadLines() {
    const groups = new Map();
    for (const key of downloaded) {
      const id = key.split(":")[1];
      const group = groups.get(id) || [];
      group.push({ key, info: store.get("i:" + key) || {} });
      groups.set(id, group);
    }
    return [...groups].map(([id, group]) => {
      group.sort((a, b) => (b.info.at || 0) - (a.info.at || 0));
      const info = group[0].info;
      return {
        keys: group.map(record => record.key),
        id,
        at: info.at || 0,
        owner: info.owner ? ownerName(info.owner, info.name) : "",
        text: info.text || "",
        kind: [...new Set(group.map(record => record.info.kind || "Post"))].join(", "),
        link: info.link || "https://x.com/i/status/" + id,
        thumb: group.map(record => record.info.thumb).find(Boolean) || "",
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
        for (const key of line.keys) forgetDownload(key);
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
    if (typeof GM_registerMenuCommand === "function") {
      GM_registerMenuCommand("Downloads", openDownloads);
      if (typeof page.showDirectoryPicker === "function") {
        GM_registerMenuCommand("Change download folder", () => forgetFolder().then(() =>
          toast("The next \"Download all\" asks where to save.", 4000)));
      }
    }
    const begin = () => {
      page.__xDownloader = startButtons();
      if (!AUTO_START) toast("X Downloader is on. Click the bookmarklet again to turn it off.");
    };
    if (document.body) begin();
    else document.addEventListener("DOMContentLoaded", begin, { once: true });
  }

  /* Exposed for smoke-test.js only. */
  if (page.__xDownloaderTest) page.__xDownloaderTest({ fromApi, fromEmbed, collectText, posts, mediaOf, fileBase, embedToken, idOfArticle,
    shared, downloadAll, postDone, bottomCursor, isDownloaded, markDownloaded, downloadLines, makeZip });

  try {
    start();
  } catch (error) {
    console.error(LOG, error);
    alert("Something went wrong: " + error.message);
  }
})();
