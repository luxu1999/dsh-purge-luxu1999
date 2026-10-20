/**
 * dsh-purge 0.2.1-rc.2 测试脚手架的共享工具。
 *
 * 设计约束（见 team task-3）：
 * - 纯 ESM，零第三方依赖；宿主 js-yaml 通过 createRequire 从宿主包目录借。
 * - 所有路径从 import.meta.url / CLI 参数推导，不依赖 cwd。
 * - 绝不写宿主目录：apply 只发生在 --apply-dir 的 shadow 副本里。
 * - 队友可能正在改 lib/core.js / client.js：所有调用都能优雅失败（返回 error 而不是抛栈）。
 *
 * 这里刻意复刻 lib/core.js 内部若干未导出的语义（asLf / isYamlPath /
 * patchReplacements / isBareIdentityNeedle / consideredReplacements），
 * 保证"验证器看到的锚点集合"和"引擎真正会用的替换集合"一致。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SCHEMA_VERSION = 1;
export const REQUIRED_CORE_EXPORTS = [
  "ALL_PATCHES",
  "targetFiles",
  "applyReplacementsToText",
  "patchStatus",
  "revertAll",
];

/* ------------------------------------------------------------------ */
/* 基础小工具                                                          */
/* ------------------------------------------------------------------ */

export function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export const isYamlPath = (fp) => typeof fp === "string" && /\.ya?ml$/i.test(fp);
export const isJsPath = (fp) => typeof fp === "string" && /\.(?:[cm]?js)$/i.test(fp);
export const isJsonPath = (fp) => typeof fp === "string" && /\.json$/i.test(fp);
export const asLf = (text) => (typeof text === "string" ? text.replace(/\r\n/g, "\n") : text);

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256File(fp) {
  return sha256(fs.readFileSync(fp));
}

export function byteLen(text) {
  return Buffer.byteLength(String(text ?? ""), "utf8");
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function readText(fp) {
  return fs.readFileSync(fp, "utf8");
}

export function writeText(fp, text) {
  ensureDir(path.dirname(fp));
  fs.writeFileSync(fp, text, "utf8");
}

export function writeJson(fp, value) {
  ensureDir(path.dirname(fp));
  fs.writeFileSync(fp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function rmrf(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    return true;
  } catch {
    return false;
  }
}

export function timestamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/** 取脚本所在目录（scripts/），用于从任意 cwd 定位仓库。 */
export function scriptsDirOf(metaUrl) {
  return path.dirname(fileURLToPath(metaUrl));
}

export function repoRootOf(scriptsDir) {
  return path.resolve(scriptsDir, "..");
}

export function snippet(value, max = 120) {
  const one = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

export function relPath(base, fp) {
  const rel = path.relative(base, fp);
  return rel.split(path.sep).join("/");
}

/** 绝对路径列表 → 去重、保持顺序。 */
export function unique(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const key = String(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* CLI 参数                                                            */
/* ------------------------------------------------------------------ */

/**
 * 极简参数解析：--key value、--key=value、裸布尔 flag、-- 之后原样保留。
 * 未声明的参数不报错（方便 Lead 临时加参数），调用方自己决定。
 */
export function parseArgs(argv) {
  const flags = Object.create(null);
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      positionals.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    let key = arg.slice(2);
    let value = true;
    const eq = key.indexOf("=");
    if (eq >= 0) {
      value = key.slice(eq + 1);
      key = key.slice(0, eq);
    } else {
      const next = argv[i + 1];
      if (next !== undefined && next !== "--" && !next.startsWith("--")) {
        value = next;
        i += 1;
      }
    }
    flags[key] = value;
  }
  return { flags, positionals };
}

export function flagBool(flags, key, fallback = false) {
  if (!(key in flags)) return fallback;
  const v = flags[key];
  if (v === true) return true;
  return !/^(?:false|0|no|off)$/i.test(String(v));
}

export function flagStr(flags, key, fallback = null) {
  const v = flags[key];
  if (v === undefined || v === null || v === true) return fallback;
  return String(v);
}

/* ------------------------------------------------------------------ */
/* 宿主 / DSH_HOME 解析                                                */
/* ------------------------------------------------------------------ */

/**
 * --host 可以给：桌面解包根（含 dsh/node_modules/@deepseek-ai）、
 * 宿主 app 根、node_modules、或直接 @deepseek-ai 目录。
 */
export function resolveHost(hostInput) {
  if (!hostInput) {
    return { ok: false, error: "缺少 --host <dir>（宿主解包目录）", tried: [] };
  }
  const raw = path.resolve(hostInput);
  const candidates = [];
  if (path.basename(raw) === "@deepseek-ai") candidates.push(raw);
  candidates.push(
    raw,
    path.join(raw, "dsh", "node_modules", "@deepseek-ai"),
    path.join(raw, "node_modules", "@deepseek-ai"),
    path.join(raw, "dsh", "node_modules", "@deepseek-ai", "dsh", "node_modules", "@deepseek-ai"),
  );
  const tried = [];
  for (const candidate of unique(candidates)) {
    tried.push(candidate);
    if (!isDir(candidate)) continue;
    const marker = ["dsh-base", "dsh-web-app", "dsh-app-boot", "dsh-settings"].find((pkg) =>
      isDir(path.join(candidate, pkg)),
    );
    if (!marker) continue;
    return {
      ok: true,
      aiBase: candidate,
      nodeModulesRoot: path.dirname(candidate),
      marker,
      tried,
    };
  }
  return {
    ok: false,
    error: `无法从 ${raw} 定位宿主的 @deepseek-ai 包目录（试过：${tried.join(" | ")}）`,
    tried,
  };
}

/**
 * 假 DSH_HOME：默认 <repo>/../sim/dshhome，不存在则创建（Lead 授权）。
 */
export function resolveDshHome(repoRoot, explicit) {
  const dir = explicit ? path.resolve(explicit) : path.resolve(repoRoot, "..", "sim", "dshhome");
  const existed = isDir(dir);
  if (!existed) ensureDir(dir);
  return { dshHome: dir, existed };
}

/**
 * 必须在 import lib/core.js 之前调用：surface / profile 都在模块初始化时读环境。
 */
export function setupHostEnv({ dshHome, surface = "desktop", profile = "desktop" }) {
  if (dshHome) process.env.DSH_HOME = dshHome;
  process.env.DSH_PROFILE = profile;
  process.env.DSH_SURFACE = surface;
  return {
    DSH_HOME: process.env.DSH_HOME ?? null,
    DSH_PROFILE: process.env.DSH_PROFILE,
    DSH_SURFACE: process.env.DSH_SURFACE,
  };
}

/* ------------------------------------------------------------------ */
/* 加载 lib/core.js（含中间态容错）                                     */
/* ------------------------------------------------------------------ */

export async function loadCore(repoRoot) {
  const corePath = path.join(repoRoot, "lib", "core.js");
  if (!isFile(corePath)) {
    return { ok: false, corePath, error: `找不到 ${corePath}` };
  }
  let mod;
  try {
    mod = await import(pathToFileURL(corePath).href);
  } catch (error) {
    return {
      ok: false,
      corePath,
      error: `导入 lib/core.js 失败（队友可能正在改）：${error?.message ?? error}`,
      stack: error?.stack ?? null,
    };
  }
  const missing = REQUIRED_CORE_EXPORTS.filter((name) => mod?.[name] == null);
  if (missing.length > 0) {
    return {
      ok: false,
      corePath,
      error: `lib/core.js 缺少导出：${missing.join(", ")}（队友可能正在改）`,
      missing,
    };
  }
  if (!Array.isArray(mod.ALL_PATCHES) || mod.ALL_PATCHES.length === 0) {
    return { ok: false, corePath, error: "lib/core.js 的 ALL_PATCHES 不是非空数组" };
  }
  return { ok: true, core: mod, corePath };
}

/* ------------------------------------------------------------------ */
/* 补丁 / 锚点语义（复刻 lib/core.js 内部实现）                          */
/* ------------------------------------------------------------------ */

export function patchReplacements(patch) {
  if (Array.isArray(patch?.replacements)) return patch.replacements;
  const patterns = Array.isArray(patch?.patterns) ? patch.patterns : [];
  return patterns.map((pattern) => ({ pattern, replace: patch?.replace }));
}

export function isBareIdentityNeedle(pattern) {
  const needle = asLf(pattern);
  if (!needle) return false;
  if (/^[ \t]/.test(needle)) return false;
  return /^You are a coding agent powered by\b/.test(needle);
}

/** 引擎真正会遍历的替换：跳过空 pattern / 非字符串 replace / YAML 裸 identity。 */
export function consideredReplacements(patch, fp) {
  const yaml = isYamlPath(fp);
  const out = [];
  patchReplacements(patch).forEach((replacement, index) => {
    if (!replacement || !replacement.pattern) return;
    if (typeof replacement.replace !== "string") return;
    if (yaml && isBareIdentityNeedle(replacement.pattern)) return;
    out.push({
      pattern: replacement.pattern,
      replace: replacement.replace,
      index,
      group: replacement.group,
    });
  });
  return out;
}

export function patternToString(pattern) {
  if (pattern instanceof RegExp) return String(pattern);
  return String(pattern ?? "");
}

export function patternMatches(hay, pattern) {
  const text = asLf(String(hay ?? ""));
  if (pattern instanceof RegExp) {
    const flags = String(pattern.flags || "").replace(/[gy]/g, "");
    try {
      return new RegExp(pattern.source, flags).test(text);
    } catch {
      return false;
    }
  }
  if (typeof pattern === "string") {
    if (pattern.length === 0) return false;
    return text.includes(asLf(pattern));
  }
  return false;
}

export function countPatternMatches(hay, pattern) {
  const text = asLf(String(hay ?? ""));
  if (pattern instanceof RegExp) {
    const flags = String(pattern.flags || "").replace(/[gy]/g, "") + "g";
    try {
      const found = text.match(new RegExp(pattern.source, flags));
      return found ? found.length : 0;
    } catch {
      return 0;
    }
  }
  if (typeof pattern === "string") {
    const needle = asLf(pattern);
    if (!needle) return 0;
    return text.split(needle).length - 1;
  }
  return 0;
}

export function normalizePatchFileKeys(patch) {
  const file = patch?.file;
  if (file == null) return [];
  const keys = Array.isArray(file) ? file : [file];
  return keys.filter((key) => typeof key === "string" && key.length > 0);
}

/** targetFiles() 的一个键 → 绝对路径数组（空值键返回 []）。 */
export function pathsOf(targetMap, key) {
  const value = targetMap?.[key];
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.filter((fp) => typeof fp === "string" && fp.length > 0);
}

/** 补丁 markers / marker（用于 D1「假已应用」判定）。 */
export function markerTexts(patch) {
  if (Array.isArray(patch?.markers) && patch.markers.length > 0) {
    return {
      markers: patch.markers.filter((m) => typeof m === "string" && m.length > 0),
      mode: patch.markersAny ? "some" : "every",
      from: "markers",
    };
  }
  if (typeof patch?.marker === "string" && patch.marker.length > 0) {
    return { markers: [patch.marker], mode: "every", from: "marker" };
  }
  return { markers: [], mode: "every", from: null };
}

export function markersPresent(patch, text) {
  const { markers, mode, from } = markerTexts(patch);
  if (markers.length === 0) return { total: 0, hit: 0, present: false, mode, from };
  const hay = asLf(String(text ?? ""));
  const hit = markers.filter((marker) => hay.includes(asLf(marker))).length;
  return {
    total: markers.length,
    hit,
    present: mode === "some" ? hit > 0 : hit === markers.length,
    mode,
    from,
  };
}

/* ------------------------------------------------------------------ */
/* 应用模拟（唯一真相来源：引擎 applyReplacementsToText）                 */
/* ------------------------------------------------------------------ */

/** 引擎会真正遍历的替换（按逻辑键 + YAML 裸 identity 过滤），仅用于报告证据。 */
export function replacementsForKey(patch, key = "", fp = "") {
  const yaml = isYamlPath(fp);
  return patchReplacements(patch).filter((replacement) => {
    if (!replacement || !replacement.pattern) return false;
    if (typeof replacement.replace !== "string") return false;
    if (Array.isArray(replacement.only) && key && !replacement.only.includes(key)) return false;
    if (yaml && isBareIdentityNeedle(replacement.pattern)) return false;
    return true;
  });
}

/** 0.2.1 引擎内部语义的复刻（core.js 未导出）：identity/审批句布局软补丁。 */
export function isLayoutSoftPatch(patch) {
  const id = Number(patch?.id);
  return (
    id === 4 || id === 25 || id === 26 || id === 5 || id === 11 || id === 12 || patch?.softSettle === true
  );
}

export function patchHasRemainingWork(text, patch, fp = "", key = "") {
  const hay = asLf(String(text ?? ""));
  return replacementsForKey(patch, key, fp).some(({ pattern }) => patternMatches(hay, pattern));
}

/**
 * 按 ALL_PATCHES 顺序逐补丁模拟应用，直接调用引擎的 applyReplacementsToText，
 * 与引擎行为保持一字不差；同时统计锚点覆盖（引擎不暴露该数据）。
 *
 * @param {object} opts
 * @param {object} opts.core       lib/core.js 模块
 * @param {Array}  opts.patches    ALL_PATCHES
 * @param {object} opts.targetMap  targetFiles(hostAiBase)
 * @param {object} opts.relBase    生成人类可读 rel 的基准（宿主 node_modules 根）
 * @param {Map<string,string>} opts.texts  宿主绝对路径 → 文本（会被就地更新）
 * @param {(patch:object)=>boolean} [opts.surfaceFilter] 额外过滤（默认全过）
 */
export function simulateApply({ core, patches, targetMap, relBase, texts, surfaceFilter, hostVersion }) {
  const records = [];
  const byId = new Map();
  const version = hostVersion ?? core?.DSH_TARGET_VERSION ?? "";
  const markerOf = (patch) =>
    typeof core.patchMarkerV2 === "function" ? core.patchMarkerV2(patch?.id) : `[dsh-purge:${patch?.id}:v2]`;
  const isApplied = (text, patch) => asLf(String(text ?? "")).includes(markerOf(patch));
  const sanitizeYaml = (text, fp) => {
    if (!isYamlPath(fp) || typeof core.sanitizeYamlPersonaScalars !== "function") return text;
    try {
      return core.sanitizeYamlPersonaScalars(text);
    } catch {
      return text;
    }
  };

  for (const patch of patches) {
    const id = String(patch?.id);
    const keys = normalizePatchFileKeys(patch);
    const strict = patch?.strictFiles !== false;
    const record = {
      id: patch?.id,
      name: patch?.name ?? "",
      fileKeys: keys,
      optional: patch?.optional === true,
      strictFiles: strict,
      softSettle: patch?.softSettle === true,
      layoutSoft: isLayoutSoftPatch(patch),
      removed: Boolean(patch?.removed),
      unsupported: false,
      na: false,
      missingKeys: [],
      patternsTotal: 0,
      entryMatched: 0,
      groupsTotal: 0,
      groupsMatched: 0,
      applied: false,
      changedFiles: 0,
      changedBytes: 0,
      writtenBytes: 0,
      markerInfo: { total: 0, hit: 0, present: false, mode: "every", from: "v2" },
      engineError: null,
      status: "pending",
      reason: "",
      unmatched: [],
      files: [],
      counts: { applied: 0, already: 0, notFound: 0, partial: 0, skipped: 0 },
    };
    const pushRecord = () => {
      records.push(record);
      byId.set(id, record);
    };

    // 0.2.1 迁移表：removed / unsupported 在宿主上一律 0 写入，不是失败（SKIP）。
    if (record.removed) {
      record.status = "removed";
      record.reason = typeof patch.removed === "string" ? patch.removed : "0.2.1 上已退出可应用集合";
      pushRecord();
      continue;
    }
    let unsupported = false;
    try {
      unsupported =
        typeof core.patchUnsupportedOnHost === "function" &&
        core.patchUnsupportedOnHost(patch, version) === true;
    } catch {
      unsupported = false;
    }
    if (unsupported) {
      record.unsupported = true;
      record.status = "unsupported";
      record.reason = `unsupported on host ${version}（unsupportedHosts: ${(patch.unsupportedHosts ?? []).join(", ")}）`;
      pushRecord();
      continue;
    }

    let applies = true;
    try {
      if (typeof core.patchAppliesHere === "function") applies = core.patchAppliesHere(patch) !== false;
    } catch {
      applies = true;
    }
    if (surfaceFilter && !surfaceFilter(patch)) applies = false;
    if (!applies) {
      record.status = "na";
      record.na = true;
      record.reason = "not applicable on this surface";
      pushRecord();
      continue;
    }

    const entries = [];
    for (const key of keys) {
      const fps = pathsOf(targetMap, key);
      if (fps.length === 0) {
        record.missingKeys.push(key);
        continue;
      }
      for (const fp of fps) entries.push({ key, fp });
    }
    if (entries.length === 0) {
      record.status = "missing_file";
      record.reason = `missing_target: ${record.missingKeys.join(",") || "(none)"}`;
      pushRecord();
      continue;
    }

    let markerHit = 0;
    for (const { key, fp } of entries) {
      const before = texts.get(fp) ?? readText(fp);
      const fileEntry = {
        key,
        file: fp,
        rel: relBase ? relPath(relBase, fp) : fp,
        patternsTotal: 0,
        entryMatched: 0,
        engineChanged: false,
        changed: false,
        bytesBefore: byteLen(before),
        bytesAfter: byteLen(before),
        outcome: "noop",
        error: null,
        unmatched: [],
      };
      let after = before;
      try {
        // 唯一真相来源：引擎的 applyReplacementsToText（含 only 作用域与 total/hit）。
        const result = core.applyReplacementsToText(before, patch, fp, key);
        const total = Number(result?.total) || 0;
        const hit = Number(result?.hit) || 0;
        const engineText = typeof result?.text === "string" ? result.text : before;
        fileEntry.patternsTotal = total;
        fileEntry.entryMatched = hit;

        if (strict && total > 0 && hit < total) {
          // 引擎 strictFiles 语义：只命中一部分 → 整个文件不写。
          fileEntry.outcome = "pattern_partial";
          record.counts.partial += 1;
          fileEntry.unmatched = replacementsForKey(patch, key, fp)
            .filter(({ pattern }) => !patternMatches(before, pattern))
            .slice(0, 5)
            .map(({ pattern }) => snippet(patternToString(pattern), 160));
        } else if (result?.changed === true) {
          after = sanitizeYaml(engineText, fp);
          texts.set(fp, after);
          fileEntry.outcome = "applied";
          record.counts.applied += 1;
        } else if (total > 0) {
          fileEntry.outcome = "already";
          record.counts.already += 1;
        } else if (isLayoutSoftPatch(patch) && !patchHasRemainingWork(before, patch, fp, key)) {
          // 官方副本布局不同（例如 0.2.1 的 standard.patch.yml 没有 personaPrefix 段）：
          // 没有残留 pattern 就算完成，引擎同样记 already。
          fileEntry.outcome = "already";
          record.counts.already += 1;
        } else if (isApplied(before, patch)) {
          fileEntry.outcome = "already";
          record.counts.already += 1;
        } else if (strict) {
          fileEntry.outcome = "not_found";
          record.counts.notFound += 1;
          fileEntry.unmatched = replacementsForKey(patch, key, fp)
            .slice(0, 5)
            .map(({ pattern }) => snippet(patternToString(pattern), 160));
        } else {
          fileEntry.outcome = "skipped";
          record.counts.skipped += 1;
        }
      } catch (error) {
        fileEntry.error = error?.message ?? String(error);
        if (!record.engineError) record.engineError = fileEntry.error;
      }
      fileEntry.changed = after !== before;
      fileEntry.engineChanged = fileEntry.changed;
      fileEntry.bytesAfter = byteLen(after);
      if (isApplied(after, patch)) markerHit += 1;

      record.patternsTotal += fileEntry.patternsTotal;
      record.entryMatched += fileEntry.entryMatched;
      if (fileEntry.changed) {
        record.changedFiles += 1;
        record.changedBytes += Math.abs(fileEntry.bytesAfter - fileEntry.bytesBefore);
        record.writtenBytes += fileEntry.bytesAfter;
      }
      for (const item of fileEntry.unmatched) {
        if (record.unmatched.length < 6) record.unmatched.push(item);
      }
      record.files.push(fileEntry);
    }

    record.applied = record.changedFiles > 0;
    record.markerInfo = {
      total: record.files.length,
      hit: markerHit,
      present: record.files.length > 0 && markerHit === record.files.length,
      mode: "every",
      from: "v2",
    };
    const { applied: appliedCount, already: alreadyCount, notFound: notFoundCount, partial: partialCount } =
      record.counts;
    if (record.engineError) {
      record.status = "engine_error";
      record.reason = `applyReplacementsToText 抛错：${snippet(record.engineError, 200)}`;
    } else if (partialCount > 0) {
      record.status = "pattern_partial";
      record.reason = `pattern_partial：${partialCount}/${record.files.length} 文件的适用锚点只命中一部分 → 引擎不写该文件`;
    } else if (strict && notFoundCount > 0) {
      record.status = "pattern_not_found";
      record.reason = `pattern_not_found：${notFoundCount}/${record.files.length} 文件在本宿主上找不到适用锚点`;
    } else if (appliedCount > 0) {
      record.status = "applied";
      record.reason = "";
    } else if (alreadyCount > 0 && (notFoundCount === 0 || record.layoutSoft)) {
      record.status = "already";
      record.reason = "适用锚点已全命中（v2 标记/布局软结算），0 写入";
    } else if (record.missingKeys.length === keys.length) {
      record.status = "missing_file";
      record.reason = `missing_target: ${record.missingKeys.join(",") || "(none)"}`;
    } else if (notFoundCount === 0) {
      record.status = "skipped";
      record.reason = "无可应用锚点且非 strict，引擎跳过";
    } else {
      record.status = "pattern_not_found";
      record.reason = `pattern_not_found：${notFoundCount}/${record.files.length} 文件找不到适用锚点`;
    }
    pushRecord();
  }

  return { records, byId };
}

export function cloneTextMap(texts) {
  return new Map(texts);
}

/**
 * 判定一个补丁记录是否失败（红基线/修复后都走同一套规则）。
 * 返回 string[]（空数组 = PASS）。
 */
export function failReasonsFor(record) {
  const fails = [];
  switch (record.status) {
    case "na":
    case "removed":
    case "unsupported":
    case "already":
    case "applied":
    case "skipped":
    case "missing_file":
      // removed/unsupported/na：0.2.1 迁移表明确不写文件；missing_file：目标在本宿主不存在，
      // 0 写入天然满足"要么全写、要么不写"，不算 T1 失败但会进 tolerated 清单。
      break;
    case "pattern_partial":
      fails.push(`pattern_partial(${record.entryMatched}/${record.patternsTotal})`);
      break;
    case "pattern_not_found":
      if (record.optional || record.layoutSoft) break;
      fails.push(`pattern_not_found(${record.entryMatched}/${record.patternsTotal})`);
      break;
    case "engine_error":
      fails.push(`engine_error: ${snippet(record.engineError, 120)}`);
      break;
    default:
      fails.push(`unknown_status(${record.status})`);
  }
  return fails;
}

/** 软状态（移除/不支持/不可应用/目标缺失）不算失败，但要在报告里标出来。 */
export function toleratedReason(record) {
  switch (record.status) {
    case "removed":
      return `0.2.1 已移除（0 写入）：${snippet(record.reason, 160)}`;
    case "unsupported":
      return `宿主不支持（0 写入）：${snippet(record.reason, 160)}`;
    case "na":
      return "本 surface / 宿主布局不可应用（0 写入）";
    case "missing_file":
      return `目标文件在本宿主不存在（${(record.missingKeys ?? []).join(",")}），0 写入 → 容忍`;
    case "pattern_not_found":
      if (record.optional || record.layoutSoft) {
        return "可选/布局软补丁在本宿主无适用锚点（0 写入）→ 容忍";
      }
      return "";
    default:
      return "";
  }
}

/* ------------------------------------------------------------------ */
/* Shadow 副本                                                         */
/* ------------------------------------------------------------------ */

/**
 * 把 targetFiles 解析出的文件原样复制到 <applyDir>/node_modules/<rel>。
 * 必须保留 node_modules 布局：pi-ai 在 aiBase/../@earendil-works 下。
 */
export function materializeShadow({ files, nodeModulesRoot, nodeModulesDest }) {
  const copies = [];
  for (const src of files) {
    const rel = path.relative(nodeModulesRoot, src);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`target file escapes node_modules root: ${src}`);
    }
    const dest = path.join(nodeModulesDest, rel);
    ensureDir(path.dirname(dest));
    fs.copyFileSync(src, dest);
    copies.push({ src, dest, rel: rel.split(path.sep).join("/"), sha256: sha256File(dest) });
  }
  return copies;
}

/**
 * shadow 里补一个最小宿主身份（@deepseek-ai/dsh/package.json）。
 * 0.2.1 引擎的 assertHostSupported() 读它判版本，缺了直接 host_not_found，
 * revertAll()/patchStatus() 会被闸门挡掉。只写 --apply-dir 临时副本，绝不碰真实宿主。
 */
export function ensureShadowHostIdentity({ shadowAi, version = "0.2.1-rc.2", name = "@deepseek-ai/dsh" }) {
  const stub = path.join(shadowAi, "dsh", "package.json");
  ensureDir(path.dirname(stub));
  writeText(stub, `${JSON.stringify({ name, version, type: "module" }, null, 2)}\n`);
  // 引擎把 "<aiBase>/../.." 当 runtime 根；补一个私有 package.json 更接近真实布局（可选）。
  const runtimeRoot = path.dirname(path.dirname(shadowAi));
  const runtimePkg = path.join(runtimeRoot, "package.json");
  let runtimeStub = null;
  if (!isFile(runtimePkg)) {
    writeText(
      runtimePkg,
      `${JSON.stringify({ name: "dsh-purge-shadow-runtime", private: true, type: "module" }, null, 2)}\n`,
    );
    runtimeStub = runtimePkg;
  }
  return { stub, runtimePackage: runtimePkg, runtimeStub };
}

/** shadow 里为闸门补的“身份文件”相对 node_modules 根的路径，比较树时排除。 */
export function shadowIdentityExtraRels({ shadowAi, nodeModulesDest }) {
  const rels = new Set();
  rels.add(relPath(nodeModulesDest, path.join(shadowAi, "dsh", "package.json")));
  rels.add(relPath(nodeModulesDest, path.join(path.dirname(path.dirname(shadowAi)), "package.json")));
  return rels;
}

/** 收集 shadow 内所有普通文件（用于不动点断言）。 */
export function walkFiles(root) {
  const out = [];
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fp = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(fp);
      else if (entry.isFile()) out.push(fp);
    }
  }
  out.sort();
  return out;
}

/** 整棵树的 sha256 快照：{ rel → sha256 }。 */
export function hashTree(root) {
  const out = {};
  for (const fp of walkFiles(root)) out[relPath(root, fp)] = sha256File(fp);
  return out;
}

/* ------------------------------------------------------------------ */
/* 语法 / YAML 校验                                                     */
/* ------------------------------------------------------------------ */

export function nodeCheck(fp) {
  const result = spawnSync(process.execPath, ["--check", fp], {
    encoding: "utf8",
    timeout: 60000,
    windowsHide: true,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    signal: result.signal ?? null,
    stderr: String(result.stderr ?? "").trim(),
    stdout: String(result.stdout ?? "").trim(),
  };
}

/**
 * 宿主 YAML schema：js-yaml JSON_SCHEMA + tag:yaml.org,2002:js。
 * 与 dsh-app-boot/lib/index.js 的 entryListSchema 完全一致。
 */
export function loadHostYaml(aiBase) {
  const probe = path.join(aiBase, "dsh-app-boot", "lib", "index.js");
  if (!isFile(probe)) {
    return { ok: false, error: `宿主缺少 dsh-app-boot/lib/index.js：${probe}`, probe };
  }
  try {
    const require = createRequire(probe);
    const yaml = require("js-yaml");
    if (!yaml || typeof yaml.load !== "function" || typeof yaml.Type !== "function") {
      return { ok: false, error: "宿主 js-yaml 不可用（load/Type 缺失）", probe };
    }
    const JsExpr = new yaml.Type("tag:yaml.org,2002:js", {
      kind: "scalar",
      resolve: (data) => typeof data === "string",
      construct: (data) => ({ __jsExpr: data }),
      predicate: (data) => Boolean(data && typeof data === "object" && "__jsExpr" in data),
      represent: (data) => data.__jsExpr,
    });
    const schema = yaml.JSON_SCHEMA.extend(JsExpr);
    return { ok: true, yaml, schema, probe, version: yaml.VERSION ?? yaml.version ?? null };
  } catch (error) {
    return { ok: false, error: `加载宿主 js-yaml 失败：${error?.message ?? error}`, probe };
  }
}

export function parseYamlWithHostSchema(yamlLib, schema, text) {
  const source = asLf(String(text ?? ""));
  try {
    return { ok: true, doc: yamlLib.load(source, { schema }), multi: false, error: null };
  } catch (error) {
    const message = String(error?.message ?? error);
    if (/expected a single document/i.test(message)) {
      try {
        return { ok: true, doc: yamlLib.loadAll(source, { schema }), multi: true, error: null };
      } catch (inner) {
        return { ok: false, doc: null, multi: true, error: String(inner?.message ?? inner) };
      }
    }
    return { ok: false, doc: null, multi: false, error: message };
  }
}

/* ------------------------------------------------------------------ */
/* JS 词法：去注释（保留行号/列宽），用于静态审计                          */
/* ------------------------------------------------------------------ */

const REGEX_PREV_CHARS = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "^", "~", "<", ">",
]);
const REGEX_PREV_WORDS = new Set(["return", "typeof", "instanceof", "in", "of", "new", "delete", "void", "case", "do", "else", "yield", "await"]);

function previousSignificant(code, index) {
  let i = index - 1;
  while (i >= 0 && /\s/.test(code[i])) i -= 1;
  if (i < 0) return { char: "", word: "" };
  const char = code[i];
  let word = "";
  if (/[\w$]/.test(char)) {
    let j = i;
    while (j >= 0 && /[\w$]/.test(code[j])) j -= 1;
    word = code.slice(j + 1, i + 1);
  }
  return { char, word };
}

function regexAllowedAt(code, index) {
  const { char, word } = previousSignificant(code, index);
  if (!char) return true;
  if (REGEX_PREV_CHARS.has(char)) return true;
  if (word && REGEX_PREV_WORDS.has(word)) return true;
  return false;
}

/**
 * 把 JS 注释替换成空格（换行保留，行列号不变），字符串/模板/正则字面量内容不动。
 * 已知限制：模板里的 ${...} 当作字符串处理（对静态审计足够保守）。
 */
export function stripJsComments(source) {
  const code = String(source ?? "");
  const out = code.split("");
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) {
      if (out[k] !== "\n" && out[k] !== "\r") out[k] = " ";
    }
  };
  let i = 0;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === "/" && next === "/") {
      let j = i + 2;
      while (j < n && code[j] !== "\n") j += 1;
      blank(i, j);
      i = j;
      continue;
    }
    if (ch === "/" && next === "*") {
      let j = i + 2;
      while (j < n && !(code[j] === "*" && code[j + 1] === "/")) j += 1;
      blank(i, Math.min(j + 2, n));
      i = Math.min(j + 2, n);
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    if (ch === "`") {
      let j = i + 1;
      while (j < n) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === "`") {
          j += 1;
          break;
        }
        j += 1;
      }
      i = j;
      continue;
    }
    if (ch === "/" && regexAllowedAt(code, i)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const c = code[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "\n") break;
        if (inClass) {
          if (c === "]") inClass = false;
        } else if (c === "[") {
          inClass = true;
        } else if (c === "/") {
          closed = true;
          j += 1;
          break;
        }
        j += 1;
      }
      if (closed) {
        while (j < n && /[a-z]/i.test(code[j])) j += 1;
        i = j;
        continue;
      }
    }
    i += 1;
  }
  return out.join("");
}

export function lineOfIndex(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

export function linesWithMatches(text, pattern, { flags = "g" } = {}) {
  const re = pattern instanceof RegExp ? new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g") : new RegExp(pattern, flags);
  const out = [];
  let match;
  while ((match = re.exec(text)) !== null) {
    const line = lineOfIndex(text, match.index);
    out.push({ line, index: match.index, text: snippet(text.slice(match.index, match.index + 200), 200), groups: match.slice(1) });
    if (match[0].length === 0) re.lastIndex += 1;
    if (out.length > 500) break;
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* 输出辅助                                                            */
/* ------------------------------------------------------------------ */

export function pad(value, width, align = "left") {
  const str = String(value ?? "");
  const padCount = Math.max(0, width - [...str].length);
  return align === "right" ? " ".repeat(padCount) + str : str + " ".repeat(padCount);
}

export function formatHeader(title) {
  return `\n=== ${title} ===`;
}

export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/** 生成一个临时 apply 目录（默认系统 temp）。 */
export function makeApplyDir(prefix, explicit) {
  if (explicit) {
    const dir = path.resolve(explicit);
    if (isDir(dir) && fs.readdirSync(dir).length > 0) {
      throw new Error(`--apply-dir 已存在且非空，拒绝覆盖：${dir}`);
    }
    ensureDir(dir);
    return { dir, temporary: false };
  }
  return { dir: fs.mkdtempSync(path.join(os.tmpdir(), prefix)), temporary: true };
}

export { fs, path, os, pathToFileURL, fileURLToPath, spawnSync };
