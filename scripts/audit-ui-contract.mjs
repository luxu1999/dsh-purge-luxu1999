#!/usr/bin/env node
/**
 * scripts/audit-ui-contract.mjs — R1–R8 静态 UI/契约审计（dsh-purge 0.2.1-rc.2）
 *
 * 用法（任意 cwd）：
 *   node scripts/audit-ui-contract.mjs [--repo <repo>] [--host <宿主解包目录>] [--json <out>]
 *
 * 规则（见 work/analysis/compat/同类Bug清单-与修复测试方案.md）：
 *   R1  client.js 不得对宿主文件做写操作；补丁不得再改宿主前端 bundle
 *   R2  ctx.slots.register/inject 的槽名 ⊆ 白名单
 *   R3  不得使用"单数槽"（单数槽黑名单）
 *   R4  document 上不得有 capture 阶段监听（pointerdown/click/keydown 等）
 *   R5  setInterval ≤ 4，且每个间隔 ≥ 1000ms
 *   R6  不得赋值 shell.actions.*；shell.submit 只允许包一层
 *   R7  仓库 cordis.patch.yml 与 presets/**\/*.yml 能用宿主 schema 解析、id 唯一
 *   R8  服务端注册路由 / 前端 fetch 路径 ⊆ { /dsh-purge/*, /redteam/api }
 *
 * 纯静态：不 import core.js、不执行 client.js、不写宿主/仓库。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SCHEMA_VERSION,
  flagStr,
  isDir,
  isFile,
  lineOfIndex,
  loadHostYaml,
  parseArgs,
  parseYamlWithHostSchema,
  readText,
  relPath,
  repoRootOf,
  resolveHost,
  scriptsDirOf,
  sha256,
  snippet,
  stripJsComments,
  timestamp,
  unique,
  walkFiles,
  writeJson,
} from "./lib/verify-util.mjs";

const TOOL = "audit-ui-contract";
const scriptsDir = scriptsDirOf(import.meta.url);
const repoRootDefault = repoRootOf(scriptsDir);

/* ---------------------------------------------------------------- */
/* 契约常量                                                          */
/* ---------------------------------------------------------------- */

/** 单数槽（每个会话/位置只应有一个实例）—— R3 黑名单。 */
const SINGLE_SLOTS = [
  "conversation.input.permission",
  "conversation.input.plan",
  "conversation.input.model",
  "conversation.input.activity",
  "conversation.input.attachments",
  "conversation.header",
  "conversation.hero.brand.mark",
  "conversation.hero.workspace",
  "conversation.hero.agentPreset",
];

/** 列表槽（可挂多个实例）—— R2 白名单的其余部分。 */
const LIST_SLOTS = [
  "conversation.input.right",
  "conversation.input.dock",
  "conversation.input.overlay",
  "conversation.input.left",
  "conversation.composer.dock",
  "conversation.hero.options",
  "shell.overlay",
];

const SLOT_WHITELIST = new Set([...LIST_SLOTS, ...SINGLE_SLOTS]);

/** 允许的插件服务端路由前缀（R8）。 */
const ROUTE_PREFIX_ALLOW = ["/dsh-purge/", "/redteam/api"];
/** 允许的前端 fetch 目标（R8）：插件路由 + 宿主根（存活探测）。 */
const FETCH_PREFIX_ALLOW = ["/dsh-purge/", "/redteam/api"];
const FETCH_EXACT_ALLOW = new Set(["/"]);

/** R4：需要关注的 capture 事件（document 级）。 */
const CAPTURE_EVENTS = new Set(["pointerdown", "pointerup", "pointermove", "click", "keydown", "keyup", "mousedown", "touchstart"]);

/* ---------------------------------------------------------------- */
/* 文本工具                                                          */
/* ---------------------------------------------------------------- */

function findMatchingBracket(source, openIndex) {
  const open = source[openIndex];
  const close = open === "(" ? ")" : open === "[" ? "]" : "}";
  let depth = 0;
  let i = openIndex;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === ch) break;
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return i;
    }
    i += 1;
  }
  return -1;
}

function splitTopLevel(source) {
  const args = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "\\") {
          j += 2;
          continue;
        }
        if (source[j] === ch) break;
        j += 1;
      }
      i = j + 1;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    else if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    else if (ch === "," && depth === 0) {
      args.push(source.slice(start, i));
      start = i + 1;
    }
    i += 1;
  }
  args.push(source.slice(start));
  return args.map((arg) => arg.trim()).filter((arg) => arg.length > 0);
}

/** 找出 `name(` 的调用点，返回 {index,line,args:[...]}。 */
function findCallSites(source, name) {
  const sites = [];
  const re = new RegExp(`(?<![\\w$])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(`, "g");
  let match;
  while ((match = re.exec(source)) !== null) {
    const open = match.index + match[0].length - 1;
    const close = findMatchingBracket(source, open);
    const inner = source.slice(open + 1, close === -1 ? Math.min(source.length, open + 4000) : close);
    sites.push({ index: match.index, line: lineOfIndex(source, match.index), args: splitTopLevel(inner) });
    if (sites.length > 2000) break;
  }
  return sites;
}

/** 从表达式里抽字符串字面量（单/双/反引号，去掉 ${...} 尾巴）。 */
function literalOf(expression) {
  const text = String(expression ?? "").trim();
  const match = /^["'`]([^"'`]*)/.exec(text);
  return match ? match[1] : null;
}

function numericArg(value) {
  const text = String(value ?? "").trim();
  const match = /^([0-9][0-9_]*)$/.exec(text);
  if (!match) return null;
  const number = Number(match[1].replace(/_/g, ""));
  return Number.isFinite(number) ? number : null;
}

/** 行内片段（保持单行，用于证据）。 */
function evidenceAt(source, index, max = 140) {
  const lineStart = source.lastIndexOf("\n", index) + 1;
  const lineEndRaw = source.indexOf("\n", index);
  const lineEnd = lineEndRaw === -1 ? source.length : lineEndRaw;
  return snippet(source.slice(lineStart, lineEnd), max);
}

/* ---------------------------------------------------------------- */
/* 审计主体                                                          */
/* ---------------------------------------------------------------- */

function readSource(file, label) {
  if (!isFile(file)) return { ok: false, error: `${label} 不存在：${file}`, source: "", code: "", lines: 0 };
  try {
    const source = readText(file);
    return { ok: true, source, code: stripJsComments(source), lines: source.split("\n").length };
  } catch (error) {
    return { ok: false, error: `读取 ${label} 失败：${error?.message ?? error}`, source: "", code: "", lines: 0 };
  }
}

function rule(id, title) {
  return { id, title, ok: true, summary: "", findings: [], warnings: [], data: null };
}

function fail(entry, file, line, message, kind = "violation") {
  entry.ok = false;
  entry.findings.push({ file, line, kind, message: snippet(message, 200), evidence: snippet(message, 200) });
}

function warn(entry, file, line, message) {
  entry.warnings.push({ file, line, message: snippet(message, 200) });
}

function finalize(entry, okSummary, failSummary) {
  const violations = entry.findings.length;
  entry.ok = violations === 0;
  entry.summary = entry.ok ? okSummary : failSummary.replace("{count}", String(violations));
  return entry;
}

/* ---------- R1 ---------- */
function auditR1(repoRoot, clientInfo) {
  const entry = rule("R1", "client.js 不得对宿主文件写操作 / 补丁不得再改宿主前端 bundle");
  const rel = "client.js";
  if (!clientInfo.ok) {
    fail(entry, rel, 0, clientInfo.error);
    return finalize(entry, "", clientInfo.error);
  }
  const { code } = clientInfo;
  const patterns = [
    { re: /\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|unlinkSync|unlink|rmSync|rmdirSync|copyFileSync|renameSync|mkdirSync|cpSync)\s*\(/g, label: "文件系统写 API" },
    { re: /\brequire\s*\(\s*["'](?:node:)?fs["']\s*\)/g, label: "require('fs')" },
    { re: /\bimport\s*\(\s*["'](?:node:)?fs["']\s*\)/g, label: "import('node:fs')" },
    { re: /\bfrom\s+["'](?:node:)?fs["']/g, label: "import from 'fs'" },
    { re: /\bfrom\s+["'](?:node:)?(?:fs\/promises|child_process|os)["']/g, label: "import 宿主模块" },
    { re: /\.dshpurge\b/g, label: ".dshpurge 备份路径" },
    { re: /\bdsh-client-ui-[a-z0-9-]+/g, label: "直接引用宿主前端包" },
  ];
  for (const { re, label } of patterns) {
    let match;
    while ((match = re.exec(code)) !== null) {
      fail(entry, rel, lineOfIndex(code, match.index), `${label}: ${evidenceAt(code, match.index)}`);
    }
  }

  // R1b：补丁数据里不得再有宿在前端 bundle 的目标
  const corePath = path.join(repoRoot, "lib", "core.js");
  if (isFile(corePath)) {
    const coreCode = stripJsComments(readText(corePath));
    const re = /file\s*:\s*\[([^\]]*)\]/g;
    let match;
    while ((match = re.exec(coreCode)) !== null) {
      if (/\bconversation-client\b/.test(match[1])) {
        const idMatch = /id\s*:\s*(\d+)/.exec(coreCode.slice(Math.max(0, match.index - 400), match.index));
        fail(entry, "lib/core.js", lineOfIndex(coreCode, match.index), `仍有补丁指向宿主前端 bundle：${snippet(match[0], 160)}`, "host_frontend_patch");
        entry.data = { ...(entry.data ?? {}), lastPatchId: idMatch ? Number(idMatch[1]) : null };
      }
    }
  } else {
    warn(entry, "lib/core.js", 0, "lib/core.js 不存在，跳过 R1b");
  }
  return finalize(entry, "client.js 无宿主文件写操作；补丁不再改宿主前端 bundle", "{count} 处违规");
}

/* ---------- R2 / R3 ---------- */
function collectSlots(clientInfo) {
  const slots = [];
  if (!clientInfo.ok) return slots;
  const { code } = clientInfo;
  const injectRe = /ctx\s*\.\s*slots\s*\.\s*inject\s*\(\s*["'`]([^"'`]+)["'`]/g;
  let match;
  while ((match = injectRe.exec(code)) !== null) {
    slots.push({ kind: "inject", name: match[1], line: lineOfIndex(code, match.index), index: match.index });
  }
  const registerRe = /ctx\s*\.\s*slots\s*\.\s*register\s*\(\s*\{[\s\S]{0,600}?name\s*:\s*["'`]([^"'`]+)["'`]/g;
  while ((match = registerRe.exec(code)) !== null) {
    slots.push({ kind: "register", name: match[1], line: lineOfIndex(code, match.index), index: match.index });
  }
  return slots;
}

function auditR2(clientInfo, slots) {
  const entry = rule("R2", "ctx.slots 槽名 ⊆ 白名单（Appendix A）");
  if (!clientInfo.ok) {
    fail(entry, "client.js", 0, clientInfo.error);
    return finalize(entry, "", clientInfo.error);
  }
  if (slots.length === 0) {
    fail(entry, "client.js", 0, "没有解析到任何 ctx.slots.inject/register 调用");
    return finalize(entry, "", "没有解析到任何槽位注册");
  }
  for (const slot of slots) {
    if (!SLOT_WHITELIST.has(slot.name)) {
      fail(entry, "client.js", slot.line, `${slot.kind} 使用了白名单之外的槽：${slot.name}`);
    }
  }
  entry.data = { slots };
  return finalize(entry, `${slots.length} 处槽位（${unique(slots.map((slot) => slot.name)).join(", ")}）全部在白名单内`, "{count} 处槽名越界");
}

function auditR3(clientInfo, slots) {
  const entry = rule("R3", "不得注册单数槽（单数槽只属于宿主）");
  if (!clientInfo.ok) {
    fail(entry, "client.js", 0, clientInfo.error);
    return finalize(entry, "", clientInfo.error);
  }
  for (const slot of slots) {
    if (slot.kind !== "register") continue;
    if (SINGLE_SLOTS.includes(slot.name)) {
      fail(entry, "client.js", slot.line, `注册了单数槽：${slot.name}（黑名单）`);
    }
  }
  return finalize(entry, "未注册任何单数槽", "{count} 处单数槽注册");
}

/* ---------- R4 ---------- */
function auditR4(clientInfo) {
  const entry = rule("R4", "document 上不得有 capture 阶段监听（pointerdown/click/keydown 等）");
  if (!clientInfo.ok) {
    fail(entry, "client.js", 0, clientInfo.error);
    return finalize(entry, "", clientInfo.error);
  }
  const { code } = clientInfo;
  const sites = findCallSites(code, "addEventListener");
  let documentSites = 0;
  for (const site of sites) {
    // 只看 document.addEventListener(...)：调用前面 40 字符内出现 document.
    const before = code.slice(Math.max(0, site.index - 40), site.index);
    if (!/document\s*\.\s*$/.test(before)) continue;
    documentSites += 1;
    const eventArg = site.args[0] ?? "";
    const eventName = literalOf(eventArg);
    const options = site.args[2] ?? "";
    const capture = /^\s*true\s*$/.test(options) || /capture\s*:\s*true/.test(options);
    const name = eventName ?? "?";
    if (capture && (CAPTURE_EVENTS.has(name) || eventName === null)) {
      fail(entry, "client.js", site.line, `document capture 监听：document.addEventListener(${snippet(eventArg, 40)}, …, ${snippet(options, 40)})`);
    } else if (capture) {
      warn(entry, "client.js", site.line, `document capture 监听（未列入重点事件）：${name}`);
    }
  }
  entry.data = { documentListeners: documentSites, totalListeners: sites.length };
  return finalize(entry, `document 级监听 ${documentSites} 处，均无 capture`, "{count} 处 document capture 监听");
}

/* ---------- R5 ---------- */
function auditR5(clientInfo) {
  const entry = rule("R5", "setInterval ≤ 4，且每个间隔 ≥ 1000ms");
  if (!clientInfo.ok) {
    fail(entry, "client.js", 0, clientInfo.error);
    return finalize(entry, "", clientInfo.error);
  }
  const { code } = clientInfo;
  const intervals = findCallSites(code, "setInterval").map((site) => ({
    line: site.line,
    delay: numericArg(site.args[site.args.length - 1]),
    text: evidenceAt(code, site.index),
  }));
  const timeouts = findCallSites(code, "setTimeout").map((site) => ({
    line: site.line,
    delay: numericArg(site.args[site.args.length - 1]),
  }));
  if (intervals.length > 4) {
    fail(entry, "client.js", intervals[4].line, `setInterval 共 ${intervals.length} 处（上限 4）`);
  }
  const unknown = intervals.filter((item) => item.delay === null);
  for (const item of unknown) fail(entry, "client.js", item.line, `setInterval 间隔不是数字字面量，无法静态判定：${item.text}`);
  const known = intervals.filter((item) => item.delay !== null);
  const tooSmall = known.filter((item) => item.delay < 1000);
  for (const item of tooSmall) fail(entry, "client.js", item.line, `setInterval 间隔 ${item.delay}ms < 1000ms：${item.text}`);
  const minInterval = known.length > 0 ? Math.min(...known.map((item) => item.delay)) : null;
  const minTimeout = timeouts.filter((item) => item.delay !== null);
  entry.data = {
    setInterval: intervals,
    setTimeout: timeouts,
    minIntervalMs: minInterval,
    minTimeoutMs: minTimeout.length > 0 ? Math.min(...minTimeout.map((item) => item.delay)) : null,
  };
  return finalize(
    entry,
    `setInterval ${intervals.length} 处（min ${minInterval ?? "-"}ms）；setTimeout ${timeouts.length} 处`,
    `setInterval 违规 ${"{count}"} 处（共 ${intervals.length}）`,
  );
}

/* ---------- R6 ---------- */
function auditR6(clientInfo) {
  const entry = rule("R6", "不得赋值 shell.actions.*；shell.submit 只允许包一层");
  if (!clientInfo.ok) {
    fail(entry, "client.js", 0, clientInfo.error);
    return finalize(entry, "", clientInfo.error);
  }
  const { code } = clientInfo;
  const actionsRe = /\bshell\s*\.\s*actions(?:\s*\.\s*([A-Za-z_$][\w$]*)|\[\s*["'`]([^"'`]+)["'`]\s*\])?\s*=(?!=)/g;
  let match;
  const actionAssignments = [];
  while ((match = actionsRe.exec(code)) !== null) {
    const target = match[1] ?? match[2] ?? "(整个对象)";
    actionAssignments.push({ line: lineOfIndex(code, match.index), target, text: evidenceAt(code, match.index) });
    fail(entry, "client.js", lineOfIndex(code, match.index), `赋值 shell.actions.${target}：${evidenceAt(code, match.index)}`);
  }

  const submitSites = [];
  const submitRe = /\bshell\s*\.\s*submit\s*=(?!=)\s*([\s\S]{0,200})/g;
  while ((match = submitRe.exec(code)) !== null) {
    const rhs = match[1].trim();
    const isWrapper = /^(?:async\s+)?(?:function\b|\(|(?:[A-Za-z_$][\w$]*)\s*=>)/.test(rhs);
    submitSites.push({ line: lineOfIndex(code, match.index), rhs, isWrapper, text: evidenceAt(code, match.index) });
  }
  const wrappers = submitSites.filter((site) => site.isWrapper);
  const restores = submitSites.filter((site) => !site.isWrapper);
  if (wrappers.length > 1) {
    fail(entry, "client.js", wrappers[1].line, `shell.submit 被包装 ${wrappers.length} 次（只允许包一层）`);
  }
  if (restores.length > 2) {
    fail(entry, "client.js", restores[2].line, `shell.submit 被恢复赋值 ${restores.length} 次（最多包装 1 次 + 恢复 1 次）`);
  }
  for (const site of wrappers) {
    const head = site.rhs;
    const paramsMatch = /^(?:async\s+)?function\b[^(]*\(\s*([^)]*)\)/.exec(head) ?? /^(?:async\s+)?(?:\(([^)]*)\)|([A-Za-z_$][\w$]*))\s*=>/.exec(head);
    const params = (paramsMatch?.[1] ?? paramsMatch?.[2] ?? "").trim();
    if (params && !params.includes("...") && !params.includes(",")) {
      warn(entry, "client.js", site.line, `shell.submit 包装层只声明了 1 个参数（${params}），宿主第二个参数 source 可能被丢弃`);
    }
  }

  // 宿主原始 submit 句柄只应捕获一次，且不得从 actions 代理
  const origCaptures = [];
  const origRe = /\b(?:origSubmit|originalSubmit|origActionsSubmit|hostSubmit)\b\s*=\s*([^;\n]{0,120})/g;
  while ((match = origRe.exec(code)) !== null) {
    origCaptures.push({ line: lineOfIndex(code, match.index), text: evidenceAt(code, match.index) });
    if (/shell\s*\.\s*actions/.test(match[1])) {
      fail(entry, "client.js", lineOfIndex(code, match.index), `从 shell.actions 取原始 submit：${evidenceAt(code, match.index)}`);
    }
  }
  entry.data = { actionAssignments, submitWrappers: wrappers.length, submitRestores: restores.length, submitSites, origCaptures };
  return finalize(
    entry,
    `无 shell.actions 赋值；shell.submit 包装 ${wrappers.length} 次 / 恢复 ${restores.length} 次`,
    `R6 违规 {count} 处（actions 赋值 ${actionAssignments.length}，submit 包装 ${wrappers.length}）`,
  );
}

/* ---------- R7 ---------- */
function collectYamlIds(doc) {
  const ids = [];
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (Array.isArray(node.patches)) visit(node.patches);
    if (typeof node.id === "string" || typeof node.id === "number") ids.push(String(node.id));
  };
  visit(doc);
  return ids;
}

function auditR7(repoRoot, host) {
  const entry = rule("R7", "仓库 cordis.patch.yml / presets/**/*.yml 用宿主 schema 解析且 id 唯一");
  const files = [];
  const cordis = path.join(repoRoot, "cordis.patch.yml");
  if (isFile(cordis)) files.push(cordis);
  const presetsDir = path.join(repoRoot, "presets");
  if (isDir(presetsDir)) {
    for (const fp of walkFiles(presetsDir)) {
      if (/\.ya?ml$/i.test(fp)) files.push(fp);
    }
  }
  if (files.length === 0) {
    fail(entry, "cordis.patch.yml", 0, "仓库里找不到 cordis.patch.yml，也找不到 presets/**/*.yml");
    return finalize(entry, "", "找不到可校验的 YAML");
  }

  const hostYaml = host.ok ? loadHostYaml(host.aiBase) : { ok: false, error: host.error };
  if (!hostYaml.ok) {
    fail(entry, "cordis.patch.yml", 0, `宿主 js-yaml/schema 不可用：${hostYaml.error}`);
    return finalize(entry, "", "宿主 schema 不可用，R7 无法校验");
  }

  const results = [];
  for (const fp of files) {
    const rel = relPath(repoRoot, fp);
    let text;
    try {
      text = readText(fp);
    } catch (error) {
      fail(entry, rel, 0, `读取失败：${error?.message ?? error}`);
      continue;
    }
    const parsed = parseYamlWithHostSchema(hostYaml.yaml, hostYaml.schema, text);
    if (!parsed.ok) {
      const lineMatch = /line (\d+)/.exec(String(parsed.error ?? ""));
      fail(entry, rel, lineMatch ? Number(lineMatch[1]) : 0, `YAML 解析失败：${snippet(parsed.error, 180)}`);
      results.push({ file: rel, ok: false, error: snippet(parsed.error, 200) });
      continue;
    }
    const ids = collectYamlIds(parsed.doc);
    const seen = new Map();
    let duplicates = 0;
    for (const id of ids) {
      if (seen.has(id)) {
        duplicates += 1;
        fail(entry, rel, 0, `重复 id：${id}（出现在同一文档多处）`);
      } else {
        seen.set(id, true);
      }
    }
    results.push({ file: rel, ok: duplicates === 0, ids: ids.length, duplicates, multi: parsed.multi });
  }
  entry.data = { host: hostYaml.probe ?? null, files: results };
  return finalize(entry, `${files.length} 个 YAML 全部解析通过（宿主 schema）`, "R7 违规 {count} 处");
}

/* ---------- R8 ---------- */
function scanRoutes(repoRoot) {
  const libDir = path.join(repoRoot, "lib");
  const files = isDir(libDir) ? walkFiles(libDir).filter((fp) => fp.endsWith(".js")) : [];
  const routes = [];
  const patterns = [
    /kind\s*:\s*["'](exact|prefix)["'][\s\S]{0,80}?path\s*:\s*["'`]([^"'`\n]+)["'`]/g,
    /path\s*:\s*["'`]([^"'`\n]+)["'`][\s\S]{0,80}?kind\s*:\s*["'](exact|prefix)["']/g,
    /(?:webServer|server|router)\s*\.\s*(?:get|post|put|patch|delete|all|route|use)\s*\(\s*["'`]([^"'`\n]+)["'`]/g,
  ];
  for (const fp of files) {
    const code = stripJsComments(readText(fp));
    for (const re of patterns) {
      re.lastIndex = 0;
      let match;
      while ((match = re.exec(code)) !== null) {
        const pathValue = re === patterns[1] ? match[1] : re === patterns[0] ? match[2] : match[1];
        routes.push({ file: relPath(repoRoot, fp), line: lineOfIndex(code, match.index), path: pathValue, text: evidenceAt(code, match.index) });
      }
    }
  }
  return routes;
}

function scanFetchTargets(repoRoot) {
  const files = [];
  const client = path.join(repoRoot, "client.js");
  if (isFile(client)) files.push(client);
  const libDir = path.join(repoRoot, "lib");
  const excluded = [];
  if (isDir(libDir)) {
    for (const fp of walkFiles(libDir).filter((file) => file.endsWith(".js"))) {
      // lib/core.js 是补丁数据库：里面的 fetch 片段是"要注入宿主的代码字符串"，
      // 不是插件自己的网络调用，不能当成 R8 的前端消费方。
      if (relPath(repoRoot, fp) === "lib/core.js") {
        excluded.push(relPath(repoRoot, fp));
        continue;
      }
      files.push(fp);
    }
  }
  const targets = [];
  for (const fp of files) {
    const code = stripJsComments(readText(fp));
    let match;
    const fetchRe = /\bfetch\s*\(/g;
    while ((match = fetchRe.exec(code)) !== null) {
      const open = match.index + match[0].length - 1;
      const close = findMatchingBracket(code, open);
      const args = splitTopLevel(code.slice(open + 1, close === -1 ? Math.min(code.length, open + 2000) : close));
      const first = args[0] ?? "";
      const literal = literalOf(first);
      const dynamic = literal === null || literal.includes("${") || /^[\s]*[A-Za-z_$]/.test(first);
      targets.push({
        file: relPath(repoRoot, fp),
        line: lineOfIndex(code, match.index),
        target: dynamic ? null : literal,
        unresolved: dynamic,
        text: evidenceAt(code, match.index),
      });
    }
    // apiUrl("/dsh-purge/x") 形式的封装
    const apiRe = /\bapiUrl\s*\(\s*([^)]{0,160})/g;
    while ((match = apiRe.exec(code)) !== null) {
      const literal = literalOf(match[1]);
      const dynamic = literal === null || literal.includes("${") || /^[\s]*[A-Za-z_$]/.test(match[1]);
      targets.push({
        file: relPath(repoRoot, fp),
        line: lineOfIndex(code, match.index),
        target: dynamic ? null : literal,
        unresolved: dynamic,
        text: evidenceAt(code, match.index),
      });
    }
    // fetch(`/dsh-purge/${x}`) 反引号模板：取前缀
    const tmplRe = /\bfetch\s*\(\s*`([^`$]*)/g;
    while ((match = tmplRe.exec(code)) !== null) {
      targets.push({ file: relPath(repoRoot, fp), line: lineOfIndex(code, match.index), target: match[1], unresolved: false, text: evidenceAt(code, match.index) });
    }
  }
  return { targets, excluded };
}

function allowedRoutePath(routePath, isPrefixKind) {
  if (routePath === "/") return true;
  return ROUTE_PREFIX_ALLOW.some((prefix) => routePath === prefix.replace(/\/$/, "") || routePath.startsWith(prefix));
}

function allowedFetchTarget(target) {
  if (target === null) return true; // 变量/动态拼接，静态不可判定
  if (FETCH_EXACT_ALLOW.has(target)) return true;
  if (/^[a-z]+:\/\//i.test(target)) return false; // 绝对 URL 出网
  return FETCH_PREFIX_ALLOW.some((prefix) => target.startsWith(prefix) || target === prefix.replace(/\/$/, ""));
}

function auditR8(repoRoot) {
  const entry = rule("R8", "服务端路由 / 前端 fetch 路径 ⊆ { /dsh-purge/*, /redteam/api }");
  const routes = scanRoutes(repoRoot);
  const { targets: fetchTargets, excluded } = scanFetchTargets(repoRoot);
  if (routes.length === 0) fail(entry, "lib/", 0, "没有解析到任何注册路由（lib/**/*.js）");
  for (const route of routes) {
    if (!allowedRoutePath(route.path, false)) {
      fail(entry, route.file, route.line, `注册了白名单之外的路由：${route.path}（${route.text}）`);
    }
  }
  const unresolved = fetchTargets.filter((target) => target.unresolved);
  for (const target of fetchTargets) {
    if (target.unresolved) {
      warn(entry, target.file, target.line, `fetch 目标无法静态解析：${target.text}`);
      continue;
    }
    if (!allowedFetchTarget(target.target)) {
      fail(entry, target.file, target.line, `fetch 目标越界：${target.target}`);
    }
  }
  entry.data = {
    routes: routes.map((route) => ({ file: route.file, line: route.line, path: route.path })),
    routePaths: unique(routes.map((route) => route.path)).sort(),
    fetchTargets: fetchTargets.map((target) => ({ file: target.file, line: target.line, target: target.target, unresolved: target.unresolved })),
    fetchPaths: unique(fetchTargets.filter((target) => !target.unresolved).map((target) => target.target)).sort(),
    unresolvedFetch: unresolved.length,
    excludedFromConsumerScan: excluded,
  };
  return finalize(
    entry,
    `路由 ${routes.length} 处 / fetch ${fetchTargets.length} 处，全部在允许集合内（动态目标 ${unresolved.length} 处仅告警）`,
    "R8 违规 {count} 处",
  );
}

/* ---------------------------------------------------------------- */
/* 入口                                                              */
/* ---------------------------------------------------------------- */

async function main() {
  const startedAt = new Date().toISOString();
  const { flags } = parseArgs(process.argv.slice(2));
  const repoRoot = path.resolve(flagStr(flags, "repo", repoRootDefault));
  const hostInput = flagStr(flags, "host", path.resolve(repoRoot, "..", "host", "app"));
  const jsonOut = path.resolve(
    flagStr(flags, "json") ?? path.join(repoRoot, "..", "out", "harness", `${TOOL}-${timestamp()}.json`),
  );

  const report = {
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL,
    generatedAt: startedAt,
    finishedAt: null,
    ok: false,
    exitCode: 1,
    args: { repo: repoRoot, host: hostInput, json: jsonOut },
    repo: { root: repoRoot },
    host: { input: hostInput, aiBase: null },
    rules: [],
    summary: { total: 0, pass: 0, fail: 0, failedRules: [] },
    fatal: null,
  };

  const finish = (exitCode) => {
    report.finishedAt = new Date().toISOString();
    report.exitCode = exitCode;
    report.ok = exitCode === 0;
    report.summary.failedRules = report.rules.filter((entry) => !entry.ok).map((entry) => entry.id);
    try {
      writeJson(jsonOut, report);
    } catch (error) {
      console.log(`[WARN] 写 JSON 失败：${error?.message ?? error}`);
    }
    return exitCode;
  };

  console.log(`\n=== dsh-purge ${TOOL} · R1–R8 ===`);
  console.log(`repo  : ${repoRoot}`);

  if (!isDir(repoRoot)) {
    report.fatal = { message: `repo 目录不存在：${repoRoot}` };
    console.log(`[FATAL] ${report.fatal.message}`);
    return finish(1);
  }

  const host = resolveHost(hostInput);
  report.host.aiBase = host.ok ? host.aiBase : null;
  console.log(`host  : ${host.ok ? host.aiBase : `(不可用：${host.error})`}`);

  const clientPath = path.join(repoRoot, "client.js");
  const clientInfo = readSource(clientPath, "client.js");
  report.repo.client = {
    path: clientPath,
    exists: clientInfo.ok,
    lines: clientInfo.lines,
    sha256: clientInfo.ok ? sha256(clientInfo.source) : null,
    bytes: clientInfo.ok ? Buffer.byteLength(clientInfo.source) : 0,
    error: clientInfo.ok ? null : clientInfo.error,
  };
  console.log(`client: ${clientInfo.ok ? `${clientInfo.lines} 行 / ${report.repo.client.bytes}B` : clientInfo.error}`);

  const slots = collectSlots(clientInfo);
  const rules = [
    () => auditR1(repoRoot, clientInfo),
    () => auditR2(clientInfo, slots),
    () => auditR3(clientInfo, slots),
    () => auditR4(clientInfo),
    () => auditR5(clientInfo),
    () => auditR6(clientInfo),
    () => auditR7(repoRoot, host),
    () => auditR8(repoRoot),
  ];

  for (const factory of rules) {
    let entry;
    try {
      entry = factory();
    } catch (error) {
      entry = rule("R?", "内部错误");
      entry.ok = false;
      entry.summary = `审计脚本内部异常：${error?.message ?? error}`;
      entry.findings.push({ file: "scripts/audit-ui-contract.mjs", line: 0, kind: "error", message: entry.summary });
    }
    report.rules.push(entry);
  }

  console.log("");
  for (const entry of report.rules) {
    console.log(`  ${entry.ok ? "PASS" : "FAIL"}  ${entry.id.padEnd(3)} ${entry.title}`);
    console.log(`        ${entry.summary}`);
    for (const finding of entry.findings.slice(0, 8)) {
      console.log(`        ✗ ${finding.file}:${finding.line}  ${finding.message}`);
    }
    if (entry.findings.length > 8) console.log(`        … 另有 ${entry.findings.length - 8} 处`);
    for (const warning of entry.warnings.slice(0, 4)) {
      console.log(`        ! ${warning.file}:${warning.line}  ${warning.message}`);
    }
    if (entry.warnings.length > 4) console.log(`        … 另有 ${entry.warnings.length - 4} 条 warning`);
  }

  const pass = report.rules.filter((entry) => entry.ok).length;
  const failCount = report.rules.length - pass;
  const failedIds = report.rules.filter((entry) => !entry.ok).map((entry) => entry.id);
  report.summary.total = report.rules.length;
  report.summary.pass = pass;
  report.summary.fail = failCount;
  report.summary.failedRules = failedIds;

  console.log(`\n=== RESULT ===`);
  console.log(`  rules   : ${report.rules.length} total, ${pass} PASS, ${failCount} FAIL${failCount > 0 ? ` (${failedIds.join(", ")})` : ""}`);
  console.log(`  verdict : ${failCount > 0 ? "FAIL" : "PASS"}`);
  console.log(`  json    : ${jsonOut}`);
  return finish(failCount > 0 ? 1 : 0);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.log(`\n[FATAL] audit-ui-contract 未捕获异常：${error?.message ?? error}`);
    console.log(String(error?.stack ?? ""));
    process.exitCode = 1;
  });
