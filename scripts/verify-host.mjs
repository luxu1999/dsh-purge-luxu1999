#!/usr/bin/env node
/**
 * scripts/verify-host.mjs — T1 宿主打补丁验证器（dsh-purge 0.2.1-rc.2）
 *
 * 用法（任意 cwd 均可）：
 *   node scripts/verify-host.mjs --host <宿主解包目录> --json <out.json> [--apply-dir <空目录>]
 *
 * 做什么：
 *  1. 用仓库 lib/core.js 的 targetFiles() 解析当前宿主上的全部目标文件；
 *  2. 按 ALL_PATCHES 顺序、逐文件调用引擎 applyReplacementsToText() 做"预演"，
 *     同时统计每条补丁的锚点命中（引擎不暴露这个数据）；
 *  3. 断言"要么全命中并写入、要么 0 写入"（不许部分写）；
 *  4. 把补丁结果写进 --apply-dir 的 shadow 副本（绝不写宿主本体），然后：
 *     - 每个改动的 JS 跑 node --check；
 *     - 每个改动的 YAML 用宿主 js-yaml schema 解析；
 *     - 再套一次全部补丁 → 必须 0 写入（幂等）；
 *     - revertAll() → 每个文件字节与原始一致；
 *  5. 输出人类可读摘要 + JSON，退出码 0/1。
 *
 * 注意：本脚本不调用 core.applyPatches()（它会重写仓库自己的 cordis.patch.yml），
 *      只用 targetFiles / applyReplacementsToText / backupAll / revertAll 这些无副作用的
 *      （除 shadow 内）官方入口。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  SCHEMA_VERSION,
  byteLen,
  cloneTextMap,
  ensureDir,
  failReasonsFor,
  flagBool,
  flagStr,
  formatBytes,
  hashTree,
  isDir,
  isJsPath,
  isJsonPath,
  isYamlPath,
  loadCore,
  loadHostYaml,
  makeApplyDir,
  materializeShadow,
  ensureShadowHostIdentity,
  shadowIdentityExtraRels,
  nodeCheck,
  parseArgs,
  parseYamlWithHostSchema,
  pathsOf,
  readText,
  relPath,
  repoRootOf,
  resolveDshHome,
  resolveHost,
  rmrf,
  scriptsDirOf,
  sha256,
  sha256File,
  simulateApply,
  snippet,
  timestamp,
  toleratedReason,
  unique,
  walkFiles,
  writeJson,
  writeText,
  asLf,
} from "./lib/verify-util.mjs";

const TOOL = "verify-host";
const scriptsDir = scriptsDirOf(import.meta.url);
const repoRootDefault = repoRootOf(scriptsDir);

const STATUS_ORDER = [
  "applied",
  "already",
  "skipped",
  "pattern_partial",
  "pattern_not_found",
  "missing_file",
  "removed",
  "unsupported",
  "na",
  "engine_error",
];

function print(...args) {
  console.log(...args);
}

function printHeader(title) {
  print(`\n=== ${title} ===`);
}

async function main() {
  const startedAt = new Date().toISOString();
  const { flags } = parseArgs(process.argv.slice(2));

  const hostInput = flagStr(flags, "host");
  const repoRoot = path.resolve(flagStr(flags, "repo", repoRootDefault));
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
      json: jsonOut,
      applyDir: applyDirInput ?? null,
      surface,
      profile,
      dshHome: dshHomeInput ?? null,
      keepApply,
    },
    env: null,
    repo: { root: repoRoot, corePath: null, coreSha256: null },
    host: { input: hostInput ?? null, aiBase: null, nodeModulesRoot: null, marker: null, fileCount: 0, targetKeys: 0 },
    checks: [],
    summary: { patches: 0, replacements: 0, statusCounts: {}, patchFailures: 0, checkFailures: 0, tolerated: 0 },
    patches: [],
    warnings: [],
    apply: { dir: null, shadowAiBase: null, temporary: false, kept: false, changedFiles: 0, changedJs: [], changedYaml: [], changedJson: [], writtenBytes: 0 },
    engine: { statusAvailable: false, shape: null, counts: null },
    fatal: null,
  };

  const finish = (exitCode) => {
    report.finishedAt = new Date().toISOString();
    report.exitCode = exitCode;
    report.ok = exitCode === 0;
    try {
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

  const addCheck = (name, ok, detail = "", data = null) => {
    report.checks.push({ name, ok: ok === true, detail, data });
    return ok === true;
  };

  printHeader(`dsh-purge ${TOOL} · 0.2.1-rc.2 T1`);
  print(`repo      : ${repoRoot}`);
  print(`host      : ${hostInput ?? "(未提供)"}`);
  print(`json      : ${jsonOut}`);
  print(`surface   : ${surface}`);

  /* ---------- 0. 环境 ---------- */
  const host = resolveHost(hostInput);
  if (!host.ok) return fatal(host.error, { tried: host.tried });
  report.host.input = hostInput;
  report.host.aiBase = host.aiBase;
  report.host.nodeModulesRoot = host.nodeModulesRoot;
  report.host.marker = host.marker;
  print(`aiBase    : ${host.aiBase}`);

  const { dshHome, existed } = resolveDshHome(repoRoot, dshHomeInput);
  const env = (await import("./lib/verify-util.mjs")).setupHostEnv({ dshHome, surface, profile });
  report.env = env;
  report.args.dshHome = dshHome;
  print(`DSH_HOME  : ${dshHome}${existed ? "" : "（新建）"}  DSH_SURFACE=${env.DSH_SURFACE}`);

  /* ---------- 1. 加载 core.js ---------- */
  const loaded = await loadCore(repoRoot);
  report.repo.corePath = loaded.corePath;
  if (!loaded.ok) {
    addCheck("core_loaded", false, loaded.error);
    return fatal(loaded.error, { corePath: loaded.corePath, missing: loaded.missing ?? null, stack: loaded.stack ?? null });
  }
  report.repo.coreSha256 = sha256File(loaded.corePath);
  const core = loaded.core;
  addCheck("core_loaded", true, `${relPath(repoRoot, loaded.corePath)} sha256=${report.repo.coreSha256.slice(0, 12)}…`);

  /* ---------- 1.5 宿主版本闸门（0.2.1 引擎要求 <aiBase>/dsh/package.json） ---------- */
  let gate = null;
  try {
    gate = core.assertHostSupported(host.aiBase);
  } catch (error) {
    gate = { ok: false, code: "gate_threw", reason: error?.message ?? String(error), identity: null };
  }
  addCheck(
    "host_supported",
    gate.ok === true,
    gate.ok
      ? `dsh ${gate.identity.version}${gate.warnings?.length ? `（${gate.warnings.join("；")}）` : ""}`
      : gate.reason,
    { code: gate.code ?? null, identity: gate.identity ?? null },
  );
  if (!gate.ok) return fatal(`宿主版本闸门未通过：${gate.reason}`, { code: gate.code ?? null });

  /* ---------- 2. 目标文件 ---------- */
  let targetMap;
  try {
    targetMap = core.targetFiles(host.aiBase);
  } catch (error) {
    addCheck("target_files", false, `targetFiles() 抛错：${error?.message ?? error}`);
    return fatal(`targetFiles() 抛错：${error?.message ?? error}`, { stack: debug ? error?.stack : null });
  }
  if (!targetMap || typeof targetMap !== "object") {
    return fatal("targetFiles() 没有返回对象");
  }
  const targetKeys = Object.keys(targetMap).length;
  const entries = [];
  for (const key of Object.keys(targetMap)) {
    for (const fp of pathsOf(targetMap, key)) entries.push({ key, fp });
  }
  const hostFiles = unique(entries.map((entry) => entry.fp));
  report.host.targetKeys = targetKeys;
  report.host.fileCount = hostFiles.length;
  print(`targets   : ${targetKeys} 个键 / ${hostFiles.length} 个文件`);
  if (hostFiles.length === 0) {
    addCheck("target_files", false, "targetFiles() 在本宿主上没有解析出任何文件");
    return fatal("targetFiles() 在本宿主上没有解析出任何文件（--host 是否指对了解包目录？）");
  }
  addCheck("target_files", true, `${targetKeys} keys / ${hostFiles.length} files`);

  const missingPaths = hostFiles.filter((fp) => !fs.existsSync(fp));
  addCheck("target_files_exist", missingPaths.length === 0, missingPaths.length === 0 ? "" : `${missingPaths.length} 个目标文件不存在`, {
    missing: missingPaths.slice(0, 10).map((fp) => relPath(host.nodeModulesRoot, fp)),
  });

  /* ---------- 3. 宿主只读快照（结束时比对） ---------- */
  const hostSnapshot = new Map();
  for (const fp of hostFiles) hostSnapshot.set(fp, { sha256: sha256File(fp), bytes: fs.statSync(fp).size });
  report.host.snapshotFiles = hostSnapshot.size;

  /* ---------- 4. 初始文本 + 预演 ---------- */
  const originalTexts = new Map();
  for (const fp of hostFiles) originalTexts.set(fp, readText(fp));
  const texts = cloneTextMap(originalTexts);

  // 0.2.1 引擎：ALL_PATCHES(80) 是仍可应用的集合，ALL_PATCHES_WITH_REMOVED(82) 额外含
  // removed 记录（#56/#77）；removed/unsupported 都必须是 SKIP（0 写入），不是 FAIL。
  const patches = Array.isArray(core.ALL_PATCHES_WITH_REMOVED) ? core.ALL_PATCHES_WITH_REMOVED : core.ALL_PATCHES;
  const replacementsTotal = (core.ALL_PATCHES ?? patches).reduce(
    (sum, patch) => sum + (patch?.replacements ?? patch?.patterns ?? []).length,
    0,
  );
  report.summary.patches = patches.length;
  report.summary.replacements = replacementsTotal;
  report.summary.applicablePatches = (core.ALL_PATCHES ?? patches).length;

  const sim = simulateApply({
    core,
    patches,
    targetMap,
    relBase: host.nodeModulesRoot,
    texts,
    hostVersion: gate.identity?.version ?? null,
  });

  /* ---------- 5. 宿主静态 patchStatus（仅信息；真正复核在 shadow 写入后） ---------- */
  try {
    const raw = await Promise.resolve(core.patchStatus(host.aiBase, patches));
    const counts = {};
    for (const status of Object.values(raw ?? {})) counts[String(status)] = (counts[String(status)] ?? 0) + 1;
    report.engine.hostCounts = counts;
  } catch (error) {
    report.warnings.push(`宿主 patchStatus() 不可用：${error?.message ?? error}`);
  }

  /* ---------- 6. 分类 ---------- */
  const failures = [];
  const tolerated = [];
  const statusCounts = {};
  for (const record of sim.records) {
    record.engineStatus = null;
    statusCounts[record.status] = (statusCounts[record.status] ?? 0) + 1;
    const reasons = failReasonsFor(record);
    record.failReasons = reasons;
    if (reasons.length > 0) failures.push(record);
    else if (toleratedReason(record)) tolerated.push(record);
  }
  report.summary.statusCounts = statusCounts;
  report.summary.patchFailures = failures.length;
  report.summary.tolerated = tolerated.length;

  /* ---------- 7. shadow 副本 ---------- */
  let applyInfo;
  try {
    applyInfo = makeApplyDir("dsh-purge-verify-", applyDirInput);
  } catch (error) {
    return fatal(`无法创建 --apply-dir：${error?.message ?? error}`);
  }
  const applyDir = applyInfo.dir;
  const shadowNM = path.join(applyDir, "node_modules");
  let shadowAi = path.join(shadowNM, "@deepseek-ai");
  report.apply.dir = applyDir;
  report.apply.temporary = applyInfo.temporary;
  ensureDir(applyDir);
  print(`\napply dir : ${applyDir}${applyInfo.temporary ? " (临时)" : ""}`);

  let copies = [];
  try {
    copies = materializeShadow({ files: hostFiles, nodeModulesRoot: host.nodeModulesRoot, nodeModulesDest: shadowNM });
  } catch (error) {
    addCheck("shadow_materialize", false, `复制目标文件到 shadow 失败：${error?.message ?? error}`);
    cleanup(applyInfo, keepApply, report);
    return fatal(`复制目标文件到 shadow 失败：${error?.message ?? error}`);
  }
  const shadowFiles = copies.map((copy) => copy.dest);
  const destBySrc = new Map(copies.map((copy) => [copy.src, copy.dest]));
  const originalHashByDest = new Map(copies.map((copy) => [copy.dest, copy.sha256]));
  addCheck("shadow_materialize", true, `${copies.length} 个文件 → ${shadowNM}`);

  // 0.2.1 引擎会先过宿主版本闸门（读 <aiBase>/dsh/package.json）。
  // shadow 里必须补同版本 stub，否则 backupAll/revertAll/patchStatus 全被判 host_not_found。
  let identityStubs = null;
  try {
    identityStubs = ensureShadowHostIdentity({ shadowAi, version: gate.identity?.version ?? "0.2.1-rc.2" });
    report.apply.identityStub = identityStubs.stub;
  } catch (error) {
    addCheck("shadow_host_identity", false, `写 shadow 宿主身份 stub 失败：${error?.message ?? error}`);
    cleanup(applyInfo, keepApply, report);
    return fatal(`写 shadow 宿主身份 stub 失败：${error?.message ?? error}`);
  }
  addCheck(
    "shadow_host_identity",
    true,
    `dsh ${gate.identity?.version ?? "?"} → ${relPath(shadowNM, identityStubs.stub)}`,
  );

  /* ---------- 8. shadow 映射一致性 ---------- */
  let shadowMap = {};
  try {
    shadowMap = core.targetFiles(shadowAi);
  } catch (error) {
    report.warnings.push(`shadow targetFiles() 抛错：${error?.message ?? error}`);
  }
  const mapCompare = compareTargetMaps(targetMap, shadowMap, host.nodeModulesRoot, shadowNM);
  addCheck(
    "shadow_mapping",
    mapCompare.diffs.length === 0,
    mapCompare.diffs.length === 0
      ? `shadow targetFiles() 与宿主一致（${hostFiles.length} 文件）`
      : `${mapCompare.diffs.length} 个键的路径映射不一致`,
    mapCompare.diffs.slice(0, 12),
  );

  /* ---------- 9. backup → 写入补丁文本 ---------- */
  let backupMode = null;
  let backupReport = null;
  try {
    if (typeof core.backupAll === "function") {
      backupReport = await Promise.resolve(core.backupAll(shadowAi));
      const bakCount = walkFiles(shadowNM).filter((fp) => fp.endsWith(".dshpurge.bak")).length;
      backupMode = bakCount > 0 ? "core.backupAll" : "none";
      if (bakCount === 0) {
        backupMode = "manual";
        manualBackup(shadowFiles);
      }
    } else {
      backupMode = "manual";
      manualBackup(shadowFiles);
    }
  } catch (error) {
    backupMode = "manual";
    manualBackup(shadowFiles);
    report.warnings.push(`core.backupAll() 失败，改用脚本内备份：${error?.message ?? error}`);
  }
  addCheck("backup_created", backupMode !== null, `备份方式：${backupMode}`, { report: backupReport ?? null });

  const changedHostFiles = [];
  for (const fp of hostFiles) {
    const before = originalTexts.get(fp);
    const after = texts.get(fp);
    if (after === undefined || after === before) continue;
    changedHostFiles.push(fp);
    const dest = destBySrc.get(fp);
    writeText(dest, after);
    report.apply.changedFiles += 1;
    report.apply.writtenBytes += byteLen(after);
  }
  print(`\npreview   : ${sim.records.filter((r) => r.status === "applied").length} applied / ${changedHostFiles.length} 文件被改写（仅 shadow）`);

  /* ---------- 9.5 引擎复核：patchStatus(shadowAi)（写入后的真实状态） ---------- */
  let engineStatusById = null;
  try {
    const raw = await Promise.resolve(core.patchStatus(shadowAi, patches));
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      engineStatusById = raw;
      report.engine.statusAvailable = true;
      report.engine.shape = "map(id→status)";
      const counts = {};
      for (const status of Object.values(raw)) counts[String(status)] = (counts[String(status)] ?? 0) + 1;
      report.engine.counts = counts;
    } else if (Array.isArray(raw)) {
      engineStatusById = {};
      for (const row of raw) {
        const key = row?.patch_id ?? row?.id;
        if (key != null) engineStatusById[String(key)] = row?.status ?? null;
      }
      report.engine.statusAvailable = true;
      report.engine.shape = "array(rows)";
    }
  } catch (error) {
    report.warnings.push(`shadow patchStatus() 不可用：${error?.message ?? error}`);
  }
  if (engineStatusById) {
    for (const record of sim.records) record.engineStatus = engineStatusById[String(record.id)] ?? null;
  }

  const treeAfterApply = hashTree(shadowNM);

  /* ---------- 10. 语法 / 格式校验 ---------- */
  const changedJs = changedHostFiles.filter((fp) => isJsPath(fp));
  const changedYaml = changedHostFiles.filter((fp) => isYamlPath(fp));
  const changedJson = changedHostFiles.filter((fp) => isJsonPath(fp));
  const otherChanged = changedHostFiles.filter((fp) => !isJsPath(fp) && !isYamlPath(fp) && !isJsonPath(fp));
  report.apply.changedJs = changedJs.map((fp) => relPath(host.nodeModulesRoot, fp));
  report.apply.changedYaml = changedYaml.map((fp) => relPath(host.nodeModulesRoot, fp));
  report.apply.changedJson = changedJson.map((fp) => relPath(host.nodeModulesRoot, fp));

  const jsFailures = [];
  for (const fp of changedJs) {
    const dest = destBySrc.get(fp);
    const result = nodeCheck(dest);
    if (!result.ok) jsFailures.push({ file: relPath(host.nodeModulesRoot, fp), status: result.status, stderr: snippet(result.stderr, 600) });
  }
  addCheck(
    "syntax_js",
    jsFailures.length === 0,
    changedJs.length === 0 ? "没有改动的 JS" : `${changedJs.length} 个改动 JS，失败 ${jsFailures.length}`,
    jsFailures.slice(0, 10),
  );

  const hostYaml = loadHostYaml(host.aiBase);
  if (!hostYaml.ok) report.warnings.push(`宿主 YAML schema 不可用：${hostYaml.error}`);
  const yamlFailures = [];
  if (hostYaml.ok) {
    for (const fp of changedYaml) {
      const parsed = parseYamlWithHostSchema(hostYaml.yaml, hostYaml.schema, texts.get(fp) ?? readText(destBySrc.get(fp)));
      if (!parsed.ok) yamlFailures.push({ file: relPath(host.nodeModulesRoot, fp), error: snippet(parsed.error, 600) });
    }
  }
  addCheck(
    "syntax_yaml",
    hostYaml.ok && yamlFailures.length === 0,
    changedYaml.length === 0 ? "没有改动的 YAML" : `${changedYaml.length} 个改动 YAML，失败 ${yamlFailures.length}`,
    { failures: yamlFailures.slice(0, 10), schemaFrom: hostYaml.probe ?? null },
  );

  const jsonFailures = [];
  for (const fp of changedJson) {
    try {
      JSON.parse(texts.get(fp) ?? "{}");
    } catch (error) {
      jsonFailures.push({ file: relPath(host.nodeModulesRoot, fp), error: snippet(error?.message, 400) });
    }
  }
  addCheck(
    "syntax_json",
    jsonFailures.length === 0,
    changedJson.length === 0 ? "没有改动的 JSON" : `${changedJson.length} 个改动 JSON，失败 ${jsonFailures.length}`,
    jsonFailures,
  );
  addCheck("changed_extensions_known", otherChanged.length === 0, otherChanged.length === 0 ? "" : `${otherChanged.length} 个改动文件扩展名未知（未校验）`, {
    files: otherChanged.slice(0, 10).map((fp) => relPath(host.nodeModulesRoot, fp)),
  });

  /* ---------- 11. 幂等：再套一次 ---------- */
  const secondTexts = cloneTextMap(texts);
  const second = simulateApply({ core, patches, targetMap, relBase: host.nodeModulesRoot, texts: secondTexts });
  const secondChanged = second.records.filter((record) => record.applied);
  const textDiffs = [];
  for (const fp of hostFiles) {
    const first = texts.get(fp) ?? originalTexts.get(fp);
    const twice = secondTexts.get(fp) ?? first;
    if (twice !== first) textDiffs.push(relPath(host.nodeModulesRoot, fp));
  }
  addCheck(
    "idempotent",
    secondChanged.length === 0 && textDiffs.length === 0,
    secondChanged.length === 0 && textDiffs.length === 0
      ? "第二次 apply 0 写入，全树文本不变"
      : `第二次 apply 仍有 ${secondChanged.length} 个补丁写入 / ${textDiffs.length} 个文件文本变化`,
    {
      changedPatches: secondChanged.map((record) => ({ id: record.id, name: record.name, status: record.status })),
      changedFiles: textDiffs.slice(0, 12),
    },
  );

  /* ---------- 12. revert ---------- */
  let revertResult = null;
  let revertError = null;
  try {
    revertResult = await Promise.resolve(core.revertAll(shadowAi));
  } catch (error) {
    revertError = error?.message ?? String(error);
  }
  const revertMismatches = [];
  const revertMissing = [];
  for (const fp of hostFiles) {
    const dest = destBySrc.get(fp);
    if (!fs.existsSync(dest)) {
      revertMissing.push(relPath(host.nodeModulesRoot, fp));
      continue;
    }
    const actual = sha256File(dest);
    const expected = originalHashByDest.get(dest);
    if (actual !== expected) revertMismatches.push({ file: relPath(host.nodeModulesRoot, fp), expected, actual });
  }
  addCheck(
    "revert_restores_original",
    revertError === null && revertMismatches.length === 0 && revertMissing.length === 0,
    revertError
      ? `revertAll() 抛错：${revertError}`
      : revertMismatches.length === 0 && revertMissing.length === 0
        ? `${hostFiles.length} 个文件字节与原始一致`
        : `${revertMismatches.length} 个文件与原始不一致 / ${revertMissing.length} 个缺失`,
    {
      mismatches: revertMismatches.slice(0, 10),
      missing: revertMissing.slice(0, 10),
      revertReport: revertResult ?? null,
    },
  );

  /* ---------- 13. shadow 只含目标文件（不动点） ---------- */
  const finalShadowFiles = walkFiles(shadowNM).filter((fp) => !fp.endsWith(".dshpurge.bak"));
  const expectedRel = new Set(shadowFiles.map((fp) => relPath(shadowNM, fp)));
  for (const rel of shadowIdentityExtraRels({ shadowAi, nodeModulesDest: shadowNM })) expectedRel.add(rel);
  const extraWrites = finalShadowFiles.map((fp) => relPath(shadowNM, fp)).filter((rel) => !expectedRel.has(rel));
  addCheck(
    "fixed_point_files",
    extraWrites.length === 0,
    extraWrites.length === 0 ? `shadow 文件集合 = targetFiles() 解析集合（${shadowFiles.length}）` : `${extraWrites.length} 个未声明的文件被写入`,
    { extra: extraWrites.slice(0, 12) },
  );

  /* ---------- 14. 宿主未被写 ---------- */
  const hostMismatches = [];
  for (const fp of hostFiles) {
    const snap = hostSnapshot.get(fp);
    if (!fs.existsSync(fp)) {
      hostMismatches.push({ file: relPath(host.nodeModulesRoot, fp), error: "missing" });
      continue;
    }
    if (sha256File(fp) !== snap.sha256) hostMismatches.push({ file: relPath(host.nodeModulesRoot, fp), error: "sha256 changed" });
  }
  addCheck(
    "host_untouched",
    hostMismatches.length === 0,
    hostMismatches.length === 0 ? `${hostFiles.length} 个宿主目标文件未被修改` : `${hostMismatches.length} 个宿主文件被修改`,
    hostMismatches.slice(0, 10),
  );

  /* ---------- 15. 汇总 ---------- */
  const checkFailures = report.checks.filter((check) => !check.ok);
  report.summary.checkFailures = checkFailures.length;
  report.patches = sim.records;
  report.warnings.push(...collectWarnings(sim.records));

  printHeader("checks");
  for (const check of report.checks) {
    print(`  ${check.ok ? "PASS" : "FAIL"}  ${check.name.padEnd(24)} ${check.detail}`);
  }

  printHeader(`patches (${sim.records.length})`);
  const counts = STATUS_ORDER.filter((status) => statusCounts[status]).map((status) => `${status}=${statusCounts[status]}`);
  print(`  status: ${counts.join("  ")}`);

  if (tolerated.length > 0) {
    print(`\n  tolerated (0.2.1 迁移表 / 目标不存在): ${tolerated.length}`);
    for (const record of tolerated) print(`    - #${record.id} ${record.name} — ${toleratedReason(record)}`);
  }

  if (failures.length > 0) {
    printHeader(`FAIL · ${failures.length} 个补丁不满足 T1 契约`);
    for (const record of failures) {
      const flags = [];
      if (record.engineStatus) flags.push(`engine=${record.engineStatus}`);
      if (record.applied) flags.push(`write=${record.changedFiles}f/${formatBytes(record.changedBytes)}`);
      print(
        `  #${String(record.id).padEnd(4)} ${String(record.name).padEnd(34)} ${String(record.status).padEnd(16)} ` +
          `${record.entryMatched}/${record.patternsTotal} ${flags.length ? `[${flags.join(" ")}]` : ""} ${record.failReasons.join("; ")}`,
      );
      if (record.unmatched.length > 0) {
        print(`       unmatched: ${record.unmatched.slice(0, 2).map((item) => snippet(item, 110)).join(" || ")}`);
      }
    }
  }

  if (report.warnings.length > 0) {
    printHeader("warnings");
    for (const warning of unique(report.warnings)) print(`  - ${warning}`);
  }

  const failed = failures.length > 0 || checkFailures.length > 0;
  printHeader("RESULT");
  print(`  patches : ${sim.records.length}  total, ${failures.length} FAIL, ${tolerated.length} tolerated`);
  print(`  checks  : ${report.checks.length} total, ${checkFailures.length} FAIL`);
  print(`  verdict : ${failed ? "FAIL" : "PASS"}`);
  print(`  json    : ${jsonOut}`);
  print(`  apply   : ${applyDir}${keepApply ? "（保留）" : ""}`);

  cleanup(applyInfo, keepApply, report);
  return finish(failed ? 1 : 0);
}

function manualBackup(files) {
  for (const fp of files) {
    const bak = `${fp}.dshpurge.bak`;
    if (!fs.existsSync(bak)) fs.copyFileSync(fp, bak);
  }
}

function cleanup(applyInfo, keepApply, report) {
  if (!applyInfo) return;
  if (applyInfo.temporary && !keepApply) {
    const ok = rmrf(applyInfo.dir);
    report.apply.kept = !ok;
    if (!ok) report.warnings.push(`临时目录清理失败，请手工删除：${applyInfo.dir}`);
  } else {
    report.apply.kept = true;
  }
}

/** 把宿主 / shadow 的 targetFiles() 映射按各自的 node_modules 相对路径归一化后比较。 */
function compareTargetMaps(hostMap, shadowMap, hostNodeModulesRoot, shadowNodeModulesRoot) {
  const norm = (map, base) => {
    const out = {};
    for (const [key, value] of Object.entries(map ?? {})) {
      const list = Array.isArray(value) ? value : [value];
      out[key] = list.filter(Boolean).map((fp) => relPath(base, fp));
    }
    return out;
  };
  const hostNorm = norm(hostMap, hostNodeModulesRoot);
  const shadowNorm = norm(shadowMap, shadowNodeModulesRoot);
  const keys = unique([...Object.keys(hostNorm), ...Object.keys(shadowNorm)]);
  const diffs = [];
  for (const key of keys) {
    const left = hostNorm[key] ?? [];
    const right = shadowNorm[key] ?? [];
    if (JSON.stringify(left) !== JSON.stringify(right)) diffs.push({ key, host: left, shadow: right });
  }
  return { diffs };
}

function collectWarnings(records) {
  const warnings = [];
  const hostFrontend = records.filter(
    (record) => record.fileKeys.includes("conversation-client") && record.applied,
  );
  if (hostFrontend.length > 0) {
    warnings.push(
      `仍在改写宿主前端 bundle 的补丁：${hostFrontend.map((record) => `#${record.id}`).join(", ")}（适配方案 U2 要求移除）`,
    );
  }
  // 0.2.1 引擎复核：脚本预演与 patchStatus(shadowAi) 必须一致；不一致才是真问题。
  const engineOk = new Set(["applied", "already"]);
  const soft = new Set(["removed", "unsupported", "na", "missing_file"]);
  const engineAppliedScriptNot = records.filter(
    (record) => record.engineStatus && engineOk.has(record.engineStatus) && !engineOk.has(record.status) && !soft.has(record.status),
  );
  if (engineAppliedScriptNot.length > 0) {
    warnings.push(
      `脚本与引擎不一致（patchStatus=applied/already，预演判未完成）：` +
        engineAppliedScriptNot.map((record) => `#${record.id}(${record.status})`).join(", "),
    );
  }
  const scriptAppliedEngineNot = records.filter(
    (record) => record.applied && record.engineStatus && !engineOk.has(record.engineStatus),
  );
  if (scriptAppliedEngineNot.length > 0) {
    warnings.push(
      `脚本与引擎不一致（脚本写入成功，patchStatus 未判 applied）：` +
        scriptAppliedEngineNot.map((record) => `#${record.id}(engine=${record.engineStatus})`).join(", "),
    );
  }
  return warnings;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    print(`\n[FATAL] verify-host 未捕获异常：${error?.message ?? error}`);
    print(String(error?.stack ?? ""));
    process.exitCode = 1;
  });
