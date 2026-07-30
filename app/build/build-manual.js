#!/usr/bin/env node
// Converts ../../MANUAL.md into a single self-contained HTML file (images
// inlined as base64 data URIs) so it can be bundled next to the CTTC
// executable (see package.json's `build.extraResources`) and opened without
// a network connection or a markdown viewer -- just a browser/webview.
// Not a general CommonMark implementation: handles exactly the subset of
// markdown MANUAL.md actually uses (headers, bold, inline code, links,
// images, tables, ordered/unordered lists, fenced code, hr, paragraphs).
"use strict";
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const SRC = path.join(ROOT, "MANUAL.md");
const OUT = path.join(__dirname, "CTTC-Manual.html");

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function slugify(s) {
  return s.toLowerCase().trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-");
}

// Inline images as base64 data URIs so the whole manual is one file with no
// external asset dependency -- it has to keep working if this file is moved
// or copied on its own, not just from its original install location.
function inlineImage(srcPath) {
  const abs = path.join(ROOT, srcPath);
  const data = fs.readFileSync(abs);
  const ext = path.extname(abs).slice(1);
  return `data:image/${ext};base64,${data.toString("base64")}`;
}

// Inline markdown -> HTML: bold, inline code, images (before links -- images
// are just links with a leading `!`), links.
function inline(text) {
  let html = escapeHtml(text);
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt, src) => {
    const url = /^https?:\/\//.test(src) ? src : inlineImage(src);
    return `<img alt="${escapeHtml(alt)}" src="${url}">`;
  });
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, href) => {
    // relative .md links (e.g. README.md) don't resolve inside a bundled
    // single-file manual -- keep the label as plain text instead of a dead link.
    if (/^[\w.-]+\.md(#.*)?$/.test(href)) return escapeHtml(label);
    return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/`([^`]+)`/g, "<code>$1</code>");
  return html;
}

function convert(md) {
  const lines = md.split("\n");
  const out = [];
  const usedSlugs = new Map();
  let i = 0;
  let inCodeFence = false, codeLines = [];
  let listStack = []; // stack of {type: 'ul'|'ol'}
  let inTable = false, tableRows = [];

  function closeLists() {
    while (listStack.length) out.push(`</${listStack.pop().type}>`);
  }
  function flushTable() {
    if (!inTable) return;
    const [header, , ...rows] = tableRows;
    out.push("<div class=\"table-wrap\"><table>");
    if (header) out.push("<thead><tr>" + header.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead>");
    out.push("<tbody>");
    for (const r of rows) out.push("<tr>" + r.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>");
    out.push("</tbody></table></div>");
    inTable = false;
    tableRows = [];
  }
  function uniqueSlug(text) {
    const base = slugify(text);
    const n = usedSlugs.get(base) || 0;
    usedSlugs.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  }

  for (; i < lines.length; i++) {
    const line = lines[i];

    if (line.trim().startsWith("```")) {
      if (!inCodeFence) { inCodeFence = true; codeLines = []; }
      else {
        closeLists();
        out.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        inCodeFence = false;
      }
      continue;
    }
    if (inCodeFence) { codeLines.push(line); continue; }

    // tables: a row of |cells|, immediately followed by a |---|---| separator
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split("|").map((c) => c.trim());
      if (!inTable) { inTable = true; tableRows = []; }
      tableRows.push(cells);
      continue;
    } else if (inTable) {
      flushTable();
    }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      closeLists();
      const level = h[1].length + 1; // MANUAL.md's single H1 becomes the page title, so shift one level down
      const text = h[2];
      const slug = uniqueSlug(text);
      out.push(`<h${level} id="${slug}">${inline(text)}</h${level}>`);
      continue;
    }

    if (/^\s*---\s*$/.test(line)) { closeLists(); out.push("<hr>"); continue; }

    const ol = /^(\s*)\d+\.\s+(.*)$/.exec(line);
    const ul = /^(\s*)-\s+(.*)$/.exec(line);
    if (ol || ul) {
      const type = ol ? "ol" : "ul";
      const text = (ol || ul)[2];
      if (!listStack.length || listStack[listStack.length - 1].type !== type) {
        closeLists();
        out.push(`<${type}>`);
        listStack.push({ type });
      }
      out.push(`<li>${inline(text)}</li>`);
      continue;
    } else if (listStack.length && line.trim() !== "") {
      // a non-list line breaks the list unless it's blank (blank lines
      // between list items are common in MANUAL.md and shouldn't split them)
      closeLists();
    }

    if (line.trim() === "") continue;

    out.push(`<p>${inline(line)}</p>`);
  }
  closeLists();
  flushTable();
  return out.join("\n");
}

let md = fs.readFileSync(SRC, "utf8");
// MANUAL.md wraps long image alt text across multiple lines -- collapse each
// ![...](...) span onto one line first so the line-based parser below (which
// matches "![" at the start of a line) can see it as a single paragraph line.
md = md.replace(/!\[[\s\S]*?\]\([^)]*\)/g, (m) => m.replace(/\s*\n\s*/g, " "));
const body = convert(md);
const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>CTTC — User Manual</title>
<style>
  :root { color-scheme: light dark; }
  body { max-width: 860px; margin: 0 auto; padding: 2rem 1.5rem 6rem; font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  h1, h2, h3, h4 { line-height: 1.25; margin-top: 2.2em; }
  h1 { font-size: 1.9rem; margin-top: 0; }
  h2 { font-size: 1.4rem; border-bottom: 1px solid rgba(128,128,128,0.3); padding-bottom: 0.3em; }
  h3 { font-size: 1.15rem; }
  h4 { font-size: 1rem; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: rgba(128,128,128,0.15); padding: 0.1em 0.35em; border-radius: 4px; font-size: 0.9em; }
  pre { background: rgba(128,128,128,0.12); padding: 1em; border-radius: 8px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  img { max-width: 100%; border-radius: 8px; border: 1px solid rgba(128,128,128,0.3); margin: 0.5em 0; }
  a { color: #2b7fd6; }
  .table-wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { border: 1px solid rgba(128,128,128,0.3); padding: 0.4em 0.7em; text-align: left; font-size: 0.95em; }
  th { background: rgba(128,128,128,0.12); }
  hr { border: none; border-top: 1px solid rgba(128,128,128,0.3); margin: 2em 0; }
</style>
</head>
<body>
${body}
</body>
</html>
`;
fs.writeFileSync(OUT, html);
console.log(`[build-manual] wrote ${OUT} (${(html.length / 1024 / 1024).toFixed(1)} MB)`);
