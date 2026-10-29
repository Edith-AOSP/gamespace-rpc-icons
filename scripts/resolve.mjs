#!/usr/bin/env node
/*
 * Resolves Play Store icons for GameSpace Discord Rich Presence.
 *
 * The manifest stores a stable, versioned icon URL for each package. Images
 * are mirrored into this repository so Discord never depends on a Play Store
 * URL that can change or expire.
 */

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ICONS_DIR = path.join(ROOT, "icons");
const GAMES_FILE = path.join(ROOT, "games.json");
const OVERRIDES_FILE = path.join(ROOT, "overrides.json");
const INDEX_FILE = path.join(ROOT, "index.json");
const REPO = "Edith-AOSP/gamespace-rpc-icons";
const BRANCH = "main";
const ICON_SIZE = "w512-h512";
const MAX_PARALLEL = 3;
const REQUEST_DELAY_MS = 250;

const UA =
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtml(value) {
    return value
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">");
}

function metaContent(html, property) {
    const patterns = [
        new RegExp(
            `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']+)["']`,
            "i"
        ),
        new RegExp(
            `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${property}["']`,
            "i"
        ),
    ];
    for (const pattern of patterns) {
        const match = html.match(pattern);
        if (match) return decodeHtml(match[1]);
    }
    return null;
}

function normalizeIconUrl(raw) {
    if (!raw) return null;
    let url;
    try {
        url = new URL(raw);
    } catch {
        return null;
    }
    const allowed =
        url.hostname === "play-lh.googleusercontent.com" ||
        url.hostname === "lh3.googleusercontent.com";
    if (!allowed) return null;

    // Play image URLs end in a size directive: =w240-h480, =s0-br30, ...
    url.pathname = url.pathname.replace(/=[^/]*$/, `=${ICON_SIZE}`);
    if (!url.pathname.includes("=")) url.pathname += `=${ICON_SIZE}`;
    url.search = "";
    url.hash = "";
    return url.toString();
}

function cleanName(title, fallback) {
    if (!title) return fallback;
    return title
        .replace(/\s*[-–—]\s*Apps on Google Play\s*$/i, "")
        .trim() || fallback;
}

async function fetchText(url) {
    const response = await fetch(url, {
        headers: {
            "User-Agent": UA,
            "Accept-Language": "en-US,en;q=0.9",
            Accept: "text/html,application/xhtml+xml",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return response.text();
}

async function resolvePlay(pkg, fallbackName) {
    const base =
        `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}` +
        "&hl=en";
    let url = `${base}&gl=US`;
    let html;
    try {
        html = await fetchText(url);
    } catch (error) {
        if (!String(error.message).includes("HTTP 404")) throw error;
        // Some listings are region-locked for gl=US but still resolve globally.
        url = base;
        html = await fetchText(url);
    }
    const icon = normalizeIconUrl(metaContent(html, "og:image"));
    if (!icon) {
        throw new Error("no og:image icon found");
    }
    const name = fallbackName || cleanName(metaContent(html, "og:title"), pkg);
    return { name, icon, source: url };
}

async function mirrorIcon(pkg, iconUrl) {
    const response = await fetch(iconUrl, {
        headers: {
            "User-Agent": UA,
            Accept: "image/avif,image/webp,image/png,image/*;q=0.8",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${iconUrl}`);
    }
    const contentType = response.headers.get("content-type") || "image/png";
    if (!contentType.startsWith("image/")) {
        throw new Error(`unexpected content-type ${contentType}`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length < 512) {
        throw new Error(`icon too small (${bytes.length} bytes)`);
    }

    const ext = contentType.includes("webp")
        ? "webp"
        : contentType.includes("jpeg")
          ? "jpg"
          : "png";
    const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 8);
    const safe = pkg.replace(/[^a-zA-Z0-9._-]/g, "_");
    const filename = `${safe}-${hash}.${ext}`;

    await fs.mkdir(ICONS_DIR, { recursive: true });
    const target = path.join(ICONS_DIR, filename);
    try {
        await fs.access(target);
    } catch {
        await fs.writeFile(target, bytes);
    }

    return {
        filename,
        url: `https://cdn.jsdelivr.net/gh/${REPO}@${BRANCH}/icons/${filename}`,
    };
}

async function readJson(file, fallback) {
    try {
        return JSON.parse(await fs.readFile(file, "utf8"));
    } catch {
        return fallback;
    }
}

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (true) {
            const index = next++;
            if (index >= items.length) return;
            results[index] = await fn(items[index], index);
            await sleep(REQUEST_DELAY_MS);
        }
    }
    await Promise.all(
        Array.from({ length: Math.min(limit, items.length) }, () => worker())
    );
    return results;
}

async function main() {
    const games = await readJson(GAMES_FILE, []);
    const overrides = await readJson(OVERRIDES_FILE, {});
    const previous = await readJson(INDEX_FILE, { games: {} });
    const previousGames = previous.games && typeof previous.games === "object"
        ? previous.games
        : {};

    const entries = new Map();
    const usedFiles = new Set();

    for (const game of games) {
        if (!game || typeof game.package !== "string" || !game.package) {
            console.warn("Skipping invalid games.json entry:", game);
            continue;
        }
        const pkg = game.package;
        const override = overrides[pkg];

        if (override && typeof override.icon === "string") {
            entries.set(pkg, {
                name: override.name || game.name || pkg,
                icon: override.icon,
                source: override.source || "override",
                updated: new Date().toISOString(),
            });
            continue;
        }

        try {
            const resolved = await resolvePlay(pkg, override?.name || game.name);
            const mirrored = await mirrorIcon(pkg, resolved.icon);
            usedFiles.add(mirrored.filename);
            entries.set(pkg, {
                name: resolved.name,
                icon: mirrored.url,
                source: resolved.source,
                updated: new Date().toISOString(),
            });
            console.log(`ok   ${pkg} -> ${resolved.name}`);
        } catch (error) {
            const old = previousGames[pkg];
            if (old) {
                entries.set(pkg, old);
                if (old.icon) {
                    const file = old.icon.split("/").pop();
                    if (file) usedFiles.add(file);
                }
                console.warn(`keep ${pkg}: ${error.message}`);
            } else {
                console.warn(`fail ${pkg}: ${error.message}`);
            }
        }
    }

    const gamesObject = {};
    for (const pkg of [...entries.keys()].sort()) {
        gamesObject[pkg] = entries.get(pkg);
    }

    const index = {
        schema: 1,
        updated: new Date().toISOString(),
        games: gamesObject,
    };

    await fs.writeFile(INDEX_FILE, `${JSON.stringify(index, null, 2)}\n`);

    // Remove mirrored files that are no longer referenced.
    try {
        const files = await fs.readdir(ICONS_DIR);
        for (const file of files) {
            if (!file.endsWith(".png") && !file.endsWith(".webp") && !file.endsWith(".jpg")) {
                continue;
            }
            if (!usedFiles.has(file)) {
                await fs.unlink(path.join(ICONS_DIR, file));
                console.log(`removed unused ${file}`);
            }
        }
    } catch {
        // icons/ does not exist yet.
    }

    console.log(`wrote ${Object.keys(gamesObject).length} entries`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
