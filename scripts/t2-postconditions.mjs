#!/usr/bin/env node
/**
 * scripts/t2-postconditions.mjs — T2 后置条件校验器（dsh-purge 0.2.1-rc.2）
 *
 * 用法（任意 cwd 均可）：
 *   node scripts/t2-postconditions.mjs --host <宿主解包目录> --json <out.json> \
 *        [--data scripts/postconditions/0.2.1.json] [--apply-dir <空目录>] [--keep-apply]
 *
 * 做什么：
 *  1. 用 lib/core.js 的 targetFiles() 解析宿主目标文件，按 ALL_PATCHES 顺序模拟应用；
 *  2. 把补丁结果写进 --apply-dir 的 shadow 副本（绝不写宿主本体）；
 *  3. 读取 --data（默认 scripts/postconditions/0.2.1.json），逐条断言：
 *     - must     ：补丁落地后这些字面量 / 正则必须出现；
 *     - mustNot  ：这些字面量 / 正则必须不存在；
 *     条件作用域：contains/regex 默认在条目 files 集合内累计，scope="all" 要求每个文件命中；
 *  4. 每补丁输出 PASS / FAIL / SKIP；补丁自身没完全落地（partial/noop/marker_only…）
 *     默认只记 coverage WARN（完整性由 verify-host.mjs 的 T1 契约负责）；
 *     但条目声明 requireCoverage:true 时，覆盖不完整直接判该条 FAIL
 *     （用于“行为已对、落地不全”会被 T1 判红的补丁，避免 T2 假绿）；
 *  5. 输出人类可读摘要 + JSON，退出码 0/1。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SCHEMA_VERSION,
  asLf,
  byteLen,
  ensureDir,
  flagBool,
  flagStr,
  formatBytes,
  isFile,
  lineOfIndex,
  loadCore,
  makeApplyDir,
  materializeShadow,
  parseArgs,
  pathsOf,
  readText,
  relPath,
  repoRootOf,
  resolveDshHome,
  resolveHost,
  rmrf,
  scriptsDirOf,
  setupHostEnv,
  sha256File,
  simulateApply,
  snippet,
  timestamp,
  unique,
  writeJson,
  writeText,
} from "./lib/verify-util.mjs";

const TOOL = "t2-postconditions";
const scriptsDir = scriptsDirOf(import.meta.url);
const repoRootDefault = repoRootOf(scriptsDir);
const dataPathDefault = path.join(scriptsDir, "postconditions", "0.2.1.json");
const COMPLETE_STATUSES = new Set(["applied", "already"]);
// 0.2.1 迁移：removed / unsupported / missing_file / skipped 的补丁本来就不该落地，后置条件跳过。
const SKIP_STATUSES = new Set(["na", "missing_target", "removed", "unsupported", "missing_file", "skipped"]);

function print(...args) {
  console.log(...args);
}

function printHeader(title) {
  print(`\n=== ${title} ===`);
}

/* ------------------------------------------------------------------ */
/* 条件求值                                                             */
/* ------------------------------------------------------------------ */

function compileCondition(cond) {
  if (!cond || typeof cond !== "object") throw new Error("条件必须是对象");
  if (typeof cond.contains === "string" && cond.contains.length > 0) {
    return { kind: "contains", needle: asLf(cond.contains) };
  }
  if (typeof cond.regex === "string" && cond.regex.length > 0) {
    const flags = typeof cond.flags === "string" ? cond.flags.replace(/[gy]/g, "") : "";
    return { kind: "regex", source: cond.regex, flags, re: new RegExp(cond.regex, `${flags}g`) };
  }
  throw new Error(`条件缺少 contains / regex：${snippet(JSON.stringify(cond), 120)}`);
}

function countMatches(text, compiled) {
  const hay = asLf(text);
  if (compiled.kind === "contains") {
    let count = 0;
    let index = 0;
    while (true) {
      index = hay.indexOf(compiled.needle, index);
      if (index === -1) break;
      count += 1;
      index += compiled.needle.length;
    }
    return count;
  }
  const re = new RegExp(compiled.source, compiled.re.flags);
  let count = 0;
  let match;
  while ((match = re.exec(hay)) !== null) {
    count += 1;
    if (match[0].length === 0) re.lastIndex += 1;
    if (count > 100000) break;
  }
  return count;
}

function collectEvidence(text, compiled, max = 2) {
  const hay = asLf(text);
  const evidence = [];
  if (compiled.kind === "contains") {
    let index = 0;
    while (evidence.length < max) {
      index = hay.indexOf(compiled.needle, index);
      if (index === -1) break;
      evidence.push({ line: lineOfIndex(hay, index), text: snippet(hay.slice(index, index + 160), 150) });
      index += compiled.needle.length;
    }
    return evidence;
  }
  const re = new RegExp(compiled.source, compiled.re.flags);
  let match;
  while ((match = re.exec(hay)) !== null && evidence.length < max) {
    evidence.push({ line: lineOfIndex(hay, match.index), text: snippet(match[0], 150) });
    if (match[0].length === 0) re.lastIndex += 1;
  }
  return evidence;
}

/**
 * @param {object} cond    数据文件里的条件
 * @param {Array}  files   [{key, rel, fp, text}]
 * @param {boolean} invert  mustNot 语义
 */
function evaluateCondition(cond, files, invert) {
  const compiled = compileCondition(cond);
  const scope = cond.scope === "all" ? "all" : "any";
  const minCount = Number.isInteger(cond.minCount) && cond.minCount >= 0 ? cond.minCount : 1;
  const rows = files.map((file) => {
    const count = countMatches(file.text, compiled);
    return {
      key: file.key,
      file: file.rel,
      count,
      evidence: count > 0 ? collectEvidence(file.text, compiled) : [],
    };
  });
  const total = rows.reduce((acc, row) => acc + row.count, 0);
  let ok;
  if (invert) ok = total === 0;
  else if (scope === "all") ok = rows.length > 0 && rows.every((row) => row.count >= minCount);
  else ok = total >= minCount;
  return {
    kind: compiled.kind,
    pattern: compiled.kind === "contains" ? snippet(compiled.needle, 200) : `/${compiled.source}/${compiled.flags}`,
    why: cond.why ?? "",
    scope,
    minCount: invert ? 0 : minCount,
    total,
    ok,
    rows,
    evidence: rows.flatMap((row) => row.evidence.map((item) => ({ ...item, file: row.file }))).slice(0, 4),
  };
}

/* ------------------------------------------------------------------ */
/* 主流程                                                               */
/* ------------------------------------------------------------------ */

async function main() {
  const startedAt = new Date().toISOString();
  const { flags } = parseArgs(process.argv.slice(2));

  const hostInput = flagStr(flags, "host");
  const repoRoot = path.resolve(flagStr(flags, "repo", repoRootDefault));
  const dataPath = path.resolve(flagStr(flags, "data", dataPathDefault));
  const surface = flagStr(flags, "surface", "desktop");
  const profile = flagStr(flags, "profile", "desktop");
  const dshHomeInput = flagStr(flags, "dsh-home");
  const applyDirInput = flagStr(flags, "apply-dir");
  const keepApply = flagBool(flags, "keep-apply");
  const debug = flagBool(flags, "debug");
  const jsonOut = path.resolve(
    flagStr(flags, "json") ?? path.join(os.tmpdir(), "dsh-purge-harness", `${TOOL}-${timestamp()}.json`),
  );

  const report = {
    schemaVersion: SCHEMA_VERSION,
    tool: TOOL,
    generatedAt: startedAt,
    finishedAt: null,
    ok: false,
    exitCode: 1,
    args: {
      host: hostInput ?? null,
      repo: repoRoot,
      data: dataPath,
      json: jsonOut,
      applyDir: applyDirInput ?? null,
      surface,
      profile,
      dshHome: dshHomeInput ?? null,
      keepApply,
    },
    env: null,
    repo: { root: repoRoot, corePath: null, coreSha256: null },
    host: { input: hostInput ?? null, aiBase: null, nodeModulesRoot: null, marker: null, targetKeys: 0, fileCount: 0 },
    data: { path: dataPath, sha256: null, target: null, entryCount: 0 },
    summary: { entries: 0, pass: 0, fail: 0, skip: 0, coverageWarn: 0 },
    postconditions: [],
    apply: { dir: null, shadowAiBase: null, temporary: false, kept: false, changedFiles: 0, writtenBytes: 0 },
    warnings: [],
    fatal: null,
  };

  const finish = (exitCode) => {
    report.finishedAt = new Date().toISOString();
    report.exitCode = exitCode;
    report.ok = exitCode === 0;
    try {
      ensureDir(path.dirname(jsonOut));
      writeJson(jsonOut, report);
    } catch (error) {
      print(`[WARN] 写 JSON 失败：${error?.message ?? error}`);
    }
    return exitCode;
  };

  const fatal = (message, extra = {}) => {
    report.fatal = { message, ...extra };
    print(`\n[FATAL] ${message}`);
    if (debug && extra.stack) print(extra.stack);
    return finish(1);
  };

  printHeader(`dsh-purge ${TOOL} · 0.2.1-rc.2 T2 后置条件`);
  print(`repo      : ${repoRoot}`);
  print(`host      : ${hostInput ?? "(未提供)"}`);
  print(`data      : ${dataPath}`);
  print(`json      : ${jsonOut}`);

  /* ---------- 0. 数据文件 ---------- */
  if (!isFile(dataPath)) return fatal(`找不到后置条件数据文件：${dataPath}`);
  let data;
  try {
    data = JSON.parse(readText(dataPath));
  } catch (error) {
    return fatal(`后置条件 JSON 解析失败：${error?.message ?? error}（${dataPath}）`);
  }
  if (!data || !Array.isArray(data.postconditions) || data.postconditions.length === 0) {
    return fatal(`后置条件 JSON 缺少非空 postconditions[]（${dataPath}）`);
  }
  report.data.sha256 = sha256File(dataPath);
  report.data.target = data.target ?? null;
  report.data.entryCount = data.postconditions.length;
  print(`target    : ${data.target ?? "(未标注)"}  entries=${data.postconditions.length}`);

  /* ---------- 1. 宿主 ---------- */
  const host = resolveHost(hostInput);
  if (!host.ok) return fatal(host.error, { tried: host.tried });
  report.host.input = hostInput;
  report.host.aiBase = host.aiBase;
  report.host.nodeModulesRoot = host.nodeModulesRoot;
  report.host.marker = host.marker;
  print(`aiBase    : ${host.aiBase}`);

  const { dshHome, existed } = resolveDshHome(repoRoot, dshHomeInput);
  report.env = setupHostEnv({ dshHome, surface, profile });
  report.args.dshHome = dshHome;
  print(`DSH_HOME  : ${dshHome}${existed ? "" : "（新建）"}  DSH_SURFACE=${report.env.DSH_SURFACE}`);

  /* ---------- 2. core.js ---------- */
  const loaded = await loadCore(repoRoot);
  report.repo.corePath = loaded.corePath;
  report.repo.coreSha256 = loaded.corePath && isFile(loaded.corePath) ? sha256File(loaded.corePath) : null;
  if (!loaded.ok) return fatal(loaded.error, { corePath: loaded.corePath, missing: loaded.missing ?? null, stack: loaded.stack ?? null });
  const core = loaded.core;

  /* ---------- 3. 目标文件 + 文本 ---------- */
  let targetMap;
  try {
    targetMap = core.targetFiles(host.aiBase);
  } catch (error) {
    return fatal(`targetFiles() 抛错：${error?.message ?? error}`, { stack: debug ? error?.stack : null });
  }
  if (!targetMap || typeof targetMap !== "object") return fatal("targetFiles() 没有返回对象");
  const hostEntries = [];
  for (const key of Object.keys(targetMap)) {
    for (const fp of pathsOf(targetMap, key)) hostEntries.push({ key, fp });
  }
  report.host.targetKeys = Object.keys(targetMap).length;
  report.host.fileCount = unique(hostEntries.map((entry) => entry.fp)).length;
  if (hostEntries.length === 0) return fatal("targetFiles() 在宿主上没有解析出任何目标文件");

  const originalTexts = new Map();
  for (const entry of hostEntries) if (!originalTexts.has(entry.fp)) originalTexts.set(entry.fp, readText(entry.fp));
  const texts = new Map(originalTexts);

  /* ---------- 4. 模拟应用 ---------- */
  const patches = core.ALL_PATCHES;
  const patchesById = new Map(patches.map((patch) => [String(patch?.id), patch]));
  let sim;
  try {
    sim = simulateApply({ core, patches, targetMap, relBase: host.nodeModulesRoot, texts });
  } catch (error) {
    return fatal(`预演补丁时抛错：${error?.message ?? error}`, { stack: debug ? error?.stack : null });
  }

  /* ---------- 5. shadow（补丁结果只写这里） ---------- */
  let applyInfo;
  try {
    applyInfo = makeApplyDir("dsh-purge-t2-", applyDirInput);
  } catch (error) {
    return fatal(`无法创建 --apply-dir：${error?.message ?? error}`);
  }
  const applyDir = applyInfo.dir;
  const shadowNM = path.join(applyDir, "node_modules");
  const shadowAi = path.join(shadowNM, "@deepseek-ai");
  report.apply.dir = applyDir;
  report.apply.shadowAiBase = shadowAi;
  report.apply.temporary = applyInfo.temporary;
  ensureDir(applyDir);
  print(`apply dir : ${applyDir}${applyInfo.temporary ? " (临时)" : ""}`);

  const hostFiles = unique(hostEntries.map((entry) => entry.fp));
  let copies;
  try {
    copies = materializeShadow({ files: hostFiles, nodeModulesRoot: host.nodeModulesRoot, nodeModulesDest: shadowNM });
  } catch (error) {
    return fatal(`复制目标文件到 shadow 失败：${error?.message ?? error}`);
  }
  const destBySrc = new Map(copies.map((copy) => [copy.src, copy.dest]));

  for (const fp of hostFiles) {
    const before = originalTexts.get(fp);
    const after = texts.get(fp);
    if (after === undefined || after === before) continue;
    writeText(destBySrc.get(fp), after);
    report.apply.changedFiles += 1;
    report.apply.writtenBytes += byteLen(after);
  }
  print(`shadow    : ${copies.length} 个文件，${report.apply.changedFiles} 个被补丁改写（${formatBytes(report.apply.writtenBytes)}）`);

  /* ---------- 6. 逐条后置条件 ---------- */
  const results = [];
  const fileCache = new Map();
  const shadowTextOf = (shadowFp) => {
    if (!fileCache.has(shadowFp)) fileCache.set(shadowFp, asLf(readText(shadowFp)));
    return fileCache.get(shadowFp);
  };

  for (const entry of data.postconditions) {
    const id = String(entry?.id ?? "");
    const result = {
      id,
      name: entry?.name ?? "",
      files: Array.isArray(entry?.files) ? entry.files : [],
      status: "SKIP",
      skipReason: null,
      reason: "",
      patchStatus: null,
      patternsTotal: 0,
      entryMatched: 0,
      coverageComplete: false,
      coverageWarning: null,
      requireCoverage: entry?.requireCoverage === true,
      coverageFailed: false,
      missingKeys: [],
      resolvedFiles: [],
      must: [],
      mustNot: [],
    };
    try {
      if (!id) throw new Error("条目缺少 id");
      const patch = patchesById.get(id);
      const record = sim.byId.get(id);
      result.patchStatus = record?.status ?? null;
      result.patternsTotal = record?.patternsTotal ?? 0;
      result.entryMatched = record?.entryMatched ?? 0;
      if (!patch || !record) {
        result.skipReason = "patch_absent";
        result.reason = `ALL_PATCHES 里没有 #${id}（适配方案可能已移除该补丁）`;
      } else if (SKIP_STATUSES.has(record.status)) {
        result.skipReason = record.status;
        result.reason = `补丁在宿主上不落地（${record.status}：${record.reason}），后置条件跳过`;
      } else {
        const seen = new Set();
        const resolved = [];
        for (const key of result.files) {
          const fps = pathsOf(targetMap, key);
          if (fps.length === 0) {
            result.missingKeys.push(key);
            continue;
          }
          for (const fp of fps) {
            const dest = destBySrc.get(fp);
            if (!dest) {
              result.missingKeys.push(key);
              continue;
            }
            const rel = relPath(host.nodeModulesRoot, fp);
            if (seen.has(rel)) continue;
            seen.add(rel);
            resolved.push({ key, rel, fp, text: shadowTextOf(dest) });
          }
        }
        result.resolvedFiles = resolved.map((file) => ({ key: file.key, file: file.rel }));
        if (resolved.length === 0) {
          result.skipReason = "no_target_file";
          result.reason = `files 键在宿主上一个都没解析到：${result.files.join(",")}`;
        } else {
          result.coverageComplete = COMPLETE_STATUSES.has(record.status);
          if (!result.coverageComplete) {
            result.coverageWarning = `补丁未完全落地（${record.status} ${record.entryMatched}/${record.patternsTotal}）→ 完整性由 verify-host.mjs 的 T1 负责`;
            result.coverageFailed = result.requireCoverage === true;
          }
          const must = (Array.isArray(entry.must) ? entry.must : []).map((cond) => evaluateCondition(cond, resolved, false));
          const mustNot = (Array.isArray(entry.mustNot) ? entry.mustNot : []).map((cond) => evaluateCondition(cond, resolved, true));
          result.must = must;
          result.mustNot = mustNot;
          const failed = [...must, ...mustNot].filter((cond) => !cond.ok);
          const reasons = [];
          if (failed.length > 0) reasons.push(`未满足：${failed.map((cond) => cond.pattern).join("; ")}`);
          if (result.coverageFailed) reasons.push(`coverage: ${result.coverageWarning}`);
          result.status = reasons.length === 0 ? "PASS" : "FAIL";
          result.reason = reasons.join(" | ");
        }
      }
    } catch (error) {
      result.status = "FAIL";
      result.reason = `求值抛错：${error?.message ?? error}`;
      if (debug) print(String(error?.stack ?? ""));
    }
    results.push(result);
  }

  /* ---------- 7. 汇总 ---------- */
  const pass = results.filter((r) => r.status === "PASS");
  const fail = results.filter((r) => r.status === "FAIL");
  const skip = results.filter((r) => r.status === "SKIP");
  const coverageWarn = results.filter((r) => r.coverageWarning);
  report.postconditions = results;
  report.summary = {
    entries: results.length,
    pass: pass.length,
    fail: fail.length,
    skip: skip.length,
    coverageWarn: coverageWarn.length,
  };
  for (const result of results) {
    if (result.missingKeys.length > 0) {
      report.warnings.push(`#${result.id} 的 files 键在宿主上解析不到：${unique(result.missingKeys).join(",")}（已跳过这些键）`);
    }
  }

  printHeader(`postconditions (${results.length})`);
  for (const result of results) {
    const tags = [];
    if (result.patchStatus) tags.push(`patch=${result.patchStatus}`);
    if (result.coverageFailed) tags.push("coverage=FAIL");
    else if (result.coverageWarning) tags.push("coverage=WARN");
    print(
      `  ${String(result.status).padEnd(4)} #${String(result.id).padEnd(3)} ${String(result.name).padEnd(34)} ` +
        `must ${result.must.filter((c) => c.ok).length}/${result.must.length}  ` +
        `mustNot ${result.mustNot.filter((c) => c.ok).length}/${result.mustNot.length}` +
        `${tags.length ? `  [${tags.join(" ")}]` : ""}${result.skipReason ? `  skip=${result.skipReason}` : ""}`,
    );
  }

  if (fail.length > 0) {
    printHeader(`FAIL · ${fail.length} 条后置条件不满足`);
    for (const result of fail) {
      print(`  #${result.id} ${result.name}  ${result.reason}`);
      for (const cond of [...result.must, ...result.mustNot].filter((item) => !item.ok)) {
        print(`     ${cond.kind === "contains" ? "must" : "mustNot"} ${cond.pattern}`);
        if (cond.why) print(`       why: ${cond.why}`);
        for (const evidence of cond.evidence.slice(0, 3)) print(`       ${evidence.file}:${evidence.line}  ${evidence.text}`);
      }
      if (result.coverageWarning) print(`     coverage: ${result.coverageWarning}`);
    }
  }

  if (coverageWarn.length > 0) {
    printHeader(`coverage warnings (${coverageWarn.length})`);
    for (const result of coverageWarn) {
      const counted = result.coverageFailed ? "（已计入 FAIL）" : "";
      print(`  #${result.id} ${result.name} — ${result.coverageWarning}${counted}`);
    }
  }

  if (report.warnings.length > 0) {
    printHeader("warnings");
    for (const warning of unique(report.warnings)) print(`  - ${warning}`);
  }

  const failed = fail.length > 0;
  printHeader("RESULT");
  print(`  entries : ${results.length} total, ${pass.length} PASS, ${fail.length} FAIL, ${skip.length} SKIP（coverage WARN ${coverageWarn.length}）`);
  print(`  verdict : ${failed ? "FAIL" : "PASS"}`);
  print(`  json    : ${jsonOut}`);
  print(`  apply   : ${applyDir}${keepApply ? "（保留）" : ""}`);

  if (applyInfo.temporary && !keepApply) {
    const cleaned = rmrf(applyDir);
    report.apply.kept = !cleaned;
    if (!cleaned) report.warnings.push(`临时目录清理失败，请手工删除：${applyDir}`);
  } else {
    report.apply.kept = true;
  }

  return finish(failed ? 1 : 0);
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    print(`\n[FATAL] t2-postconditions 未捕获异常：${error?.message ?? error}`);
    print(String(error?.stack ?? ""));
    process.exitCode = 1;
  });
