#!/usr/bin/env node
// scripts/collect-git-facts.mjs
//
// 구현 5단계: L0 결정적 수집기. LLM 호출 0회 — 이 파일과 scripts/lib/git.mjs
// 만으로 evidence.json(증거 원장)과 git-facts.json(집계)을 만든다. 이후
// 모든 상위 계층(L1+)은 evidence.json의 commits[].id만 인용하고 커밋
// 해시를 직접 생성하지 않는다(§1의 핵심 규약).
//
// 사용법(CLI):
//   node scripts/collect-git-facts.mjs --repo <path>
//     [--ref HEAD|all]                      기본 HEAD
//     [--identity <email>]...               반복 가능, 최소 1개(또는 --all-identities)
//     [--all-identities]                    identity 필터를 통과 취급(탐색/테스트 전용
//                                            — §5의 "추측 금지" 게이트를 대신하지
//                                            않는다. 실서비스 경로는 항상 --identity
//                                            다중 지정으로 명시한다.)
//     [--merge-included]                    기본 false(머지 제외)
//     [--since <date>] [--until <date>]     기본 미지정(전체 기간)
//     [--max-commits <n>]                   기본 1000
//     [--include-diff]                      기본 false(--no-diff가 P0 기본값)
//     [--no-bots-exclude] [--no-vendored-exclude]
//     [--out <dir>]                         지정 시 store.mjs 저장 루트 해석을
//                                            건너뛰고 이 디렉터리에 직접 쓴다
//                                            (테스트·독립 실행 편의)
//     [--storage home|repo] [--repo-opt-in] --out 미지정 시 store.mjs로 저장
//                                            루트를 해석할 때 쓰는 옵션
//
// 프로그래밍 API: collectGitFacts(options) — 순수 함수(디스크에 쓰지 않음,
// {evidence, gitFacts} 반환). writeCollectorOutput()이 실제 파일 쓰기(원자적
// temp→rename)를 담당한다. 미래의 skills/career-from-git이 이 API를
// 직접 호출할 수 있도록 CLI와 로직을 분리했다.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

import {
  hasAnyCommitOnHead,
  listCommitMetadata,
  getCommitFileChanges,
  runGit,
} from "./lib/git.mjs";
import {
  computeSampling,
  CANONICAL_SAMPLING_METHOD_LITERAL,
  NO_TRUNCATION_SAMPLING_METHOD_LITERAL,
} from "./lib/sampling.mjs";
import { getRepoToplevel, resolveStorageRoot } from "./lib/store.mjs";

const SCHEMA_VERSION = "0.1.0";
const NULL_SHA = "0".repeat(40); // unborn branch(0커밋) 전용 정본 sentinel(git의 null-oid 관례).

// §5 기본 봇 패턴. 이메일 기준으로만 판정한다(픽스처의 봇 이메일이 패턴을
// 이미 포함하므로 이름 필드까지 볼 필요가 없다 — buildBotCommits 참조).
const DEFAULT_BOT_PATTERNS = [/\[bot\]/i, /dependabot/i, /github-actions/i];

// §5 기본 vendored 경로 패턴(집계 전용 — 커밋 제외 축이 아니다. 아래
// "vendored 경로는 집계에서만 제외한다" 설명 참조).
const DEFAULT_VENDORED_PATH_PATTERNS = [
  /^node_modules\//,
  /^dist\//,
  /^vendor\//,
  /^migrations\//,
  /\.lock$/,
];

// ---------------------------------------------------------------------------
// 저자 판정
// ---------------------------------------------------------------------------

function isBotAuthor(email, customPatterns) {
  if (DEFAULT_BOT_PATTERNS.some((re) => re.test(email))) return true;
  return (customPatterns ?? []).some((p) => new RegExp(p, "i").test(email));
}

function isVendoredPath(filePath, customPatterns) {
  if (DEFAULT_VENDORED_PATH_PATTERNS.some((re) => re.test(filePath))) return true;
  return (customPatterns ?? []).some((p) => new RegExp(p).test(filePath));
}

/**
 * 커밋 한 건의 excluded/exclusionReason을 판정한다. 우선순위:
 * 봇 > 저자 미선택 > 머지 제외 설정. vendored 경로는 여기 관여하지 않는다
 * (파일 경로 단위 성격이라 커밋 전체를 제외하면 실사용 커밋을 통째로
 * 지우게 되므로, 집계(git-facts.json)에서만 걸러낸다).
 */
function classifyExclusion(commit, { selectedIdentities, botsEnabled, customBotPatterns, mergeIncluded }) {
  if (botsEnabled && isBotAuthor(commit.authorEmail, customBotPatterns)) {
    return { excluded: true, exclusionReason: "bot-pattern" };
  }
  if (!selectedIdentities.includes(commit.authorEmail)) {
    return { excluded: true, exclusionReason: "author-not-selected" };
  }
  if (commit.isMerge && !mergeIncluded) {
    return { excluded: true, exclusionReason: "merge-excluded" };
  }
  return { excluded: false, exclusionReason: null };
}

// ---------------------------------------------------------------------------
// 핵심 수집 로직
// ---------------------------------------------------------------------------

/**
 * @param {object} options
 * @param {string} options.repoPath 대상 레포 경로(루트 또는 그 하위, 임의 표기)
 * @param {string[]} options.selectedIdentities §5 게이트가 확정한 본인 identity 이메일들
 * @param {boolean} [options.allIdentities] true면 selectedIdentities 필터를 통과
 *   취급(탐색/테스트 전용 — 프로덕션 경로에서는 쓰지 않는다)
 * @param {"HEAD"|"--all"} [options.ref]
 * @param {boolean} [options.mergeIncluded]
 * @param {string|null} [options.since] YYYY-MM-DD
 * @param {string|null} [options.until] YYYY-MM-DD
 * @param {number} [options.maxCommits]
 * @param {boolean} [options.includeDiff] P0 기본 false(--no-diff)
 * @param {boolean} [options.botsEnabled]
 * @param {boolean} [options.vendoredPathsEnabled]
 * @param {string[]} [options.customBotPatterns]
 * @param {string[]} [options.customVendoredPathPatterns]
 * @returns {{evidence: object, gitFacts: object}}
 */
export function collectGitFacts(options) {
  const {
    repoPath,
    selectedIdentities = [],
    allIdentities = false,
    ref = "HEAD",
    mergeIncluded = false,
    since = null,
    until = null,
    maxCommits = 1000,
    includeDiff = false,
    botsEnabled = true,
    vendoredPathsEnabled = true,
    customBotPatterns = [],
    customVendoredPathPatterns = [],
  } = options;

  const repoToplevel = getRepoToplevel(repoPath);

  // 빈 레포/unborn branch: HEAD 모드에서 미리 확인해 git log 자체를 호출
  // 하지 않는다(예외 중단 방지 — HEAD가 unborn이면 `git log HEAD`는 fatal로
  // 종료하므로 이 사전 확인이 없으면 listCommitMetadata가 outcome!=='ok'를
  // 반환해 "알 수 없는 git 오류"로 오인될 수 있다). --all 모드는 unborn
  // 여부와 무관하게 항상 안전하게 빈 출력을 낸다(실측 확인).
  let rawCommits = [];
  if (ref === "HEAD") {
    if (hasAnyCommitOnHead(repoToplevel)) {
      const r = listCommitMetadata(repoToplevel, { ref: "HEAD", since, until });
      if (!r.ok) {
        throw new Error(`git log(HEAD) 실패(outcome=${r.outcome}): ${r.stderr}`);
      }
      rawCommits = r.commits;
    }
  } else {
    const r = listCommitMetadata(repoToplevel, { ref: "--all", since, until });
    if (!r.ok) {
      throw new Error(`git log(--all) 실패(outcome=${r.outcome}): ${r.stderr}`);
    }
    rawCommits = r.commits;
  }

  const traversed = rawCommits.length;

  // 모든 순회 커밋에 대해 파일 변경 집합을 계산한다(제외 커밋도 files[]를
  // 포함해 원장에 전량 등재해야 하고, population 커밋은 churn 랭킹에
  // insertions+deletions 합이 필요하므로 — 구현 5단계).
  const enriched = rawCommits.map((c) => {
    const diff = getCommitFileChanges(repoToplevel, c.hash, c.parents, c.isMerge);
    if (!diff.ok) {
      throw new Error(
        `커밋 ${c.hash}의 파일 변경 집합 계산 실패(outcome=${diff.outcome}): ${diff.stderr}`
      );
    }
    const exclusion = classifyExclusion(c, {
      selectedIdentities,
      botsEnabled, // 봇 판정은 --all-identities 여부와 독립적으로 항상 적용된다
      customBotPatterns,
      mergeIncluded,
    });
    // --all-identities는 "저자 미선택" 축만 무력화한다(봇/머지 축은 그대로 적용).
    const finalExclusion =
      allIdentities && exclusion.exclusionReason === "author-not-selected"
        ? { excluded: false, exclusionReason: null }
        : exclusion;

    return {
      ...c,
      files: diff.files,
      insertions: diff.insertions,
      deletions: diff.deletions,
      churn: diff.insertions + diff.deletions,
      excluded: finalExclusion.excluded,
      exclusionReason: finalExclusion.exclusionReason,
    };
  });

  const population = enriched.filter((c) => !c.excluded);
  const excludedList = enriched.filter((c) => c.excluded);
  const total = population.length;

  let selectedHashSet;
  let coverageAnalyzed;
  let truncated;
  let samplingMethod;

  if (total <= maxCommits) {
    selectedHashSet = new Set(population.map((c) => c.hash));
    coverageAnalyzed = total;
    truncated = { reason: "none", dropped_commits: 0 };
    samplingMethod = NO_TRUNCATION_SAMPLING_METHOD_LITERAL;
  } else {
    const sinceEpoch = since ? Math.floor(Date.parse(since) / 1000) : undefined;
    const untilEpoch = until ? Math.floor(Date.parse(until) / 1000) : undefined;
    const samplingInput = population.map((c) => ({
      hash: c.hash,
      authorEpochSec: c.authorEpochSec,
      churn: c.churn,
    }));
    const result = computeSampling(samplingInput, maxCommits, { since: sinceEpoch, until: untilEpoch });
    selectedHashSet = new Set(result.selectedHashes);
    coverageAnalyzed = result.K;
    truncated = { reason: "budget_commits", dropped_commits: total - result.K };
    samplingMethod = CANONICAL_SAMPLING_METHOD_LITERAL;
  }

  // 순회 순서를 보존한 채 "제외 커밋(전량)" ∪ "선택된 population 커밋"만 남긴다.
  const finalCommits = enriched
    .filter((c) => c.excluded || selectedHashSet.has(c.hash))
    .map((c) => ({
      id: `commit:${c.hash}`,
      hash: c.hash,
      shortHash: c.hash.slice(0, 12),
      authorEmail: c.authorEmail,
      authorDate: c.authorDateIso,
      parents: c.parents,
      isMerge: c.isMerge,
      coAuthors: c.coAuthors,
      subject: c.subject,
      insertions: c.insertions,
      deletions: c.deletions,
      files: c.files,
      excluded: c.excluded,
      exclusionReason: c.exclusionReason,
    }));

  const sourceRepoHead = resolveSourceRepoHead(repoToplevel);

  const coverage = {
    analyzed: coverageAnalyzed,
    total,
    traversed,
    period: { since: since ?? null, until: until ?? null },
    exclusions: {
      bots: botsEnabled,
      vendoredPaths: vendoredPathsEnabled,
      mergeIncluded,
      selectedIdentities,
    },
    samplingMethod,
  };

  const evidenceWithoutHash = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceRepoHead,
    coverage,
    truncated,
    commits: finalCommits,
  };
  const contentHash = crypto
    .createHash("sha256")
    .update(JSON.stringify(evidenceWithoutHash), "utf8")
    .digest("hex");

  const evidence = {
    schemaVersion: evidenceWithoutHash.schemaVersion,
    generatedAt: evidenceWithoutHash.generatedAt,
    sourceRepoHead: evidenceWithoutHash.sourceRepoHead,
    contentHash,
    coverage: evidenceWithoutHash.coverage,
    truncated: evidenceWithoutHash.truncated,
    commits: evidenceWithoutHash.commits,
  };

  const gitFacts = buildGitFacts(finalCommits, { vendoredPathsEnabled, customVendoredPathPatterns });

  void includeDiff; // P0에서는 diff 원문을 evidence.json 스키마가 담지 않는다(§4) —
  // 이 플래그는 향후 옵트인 스니펫 경로(구현 7단계 이후)를 위한 자리표시자다.

  return { evidence, gitFacts };
}

function resolveSourceRepoHead(repoToplevel) {
  const r = runGit(repoToplevel, ["rev-parse", "HEAD"]);
  if (r.outcome === "ok") return r.stdout.trim();
  return NULL_SHA;
}

/**
 * git-facts.json 집계. 스키마 관리 대상이 아니다(evidence.json만 정본
 * 계약) — 경로→모듈 매핑, 확장자 히스토그램, 기간, 최다 변경 파일,
 * conventional-commit 타입 분포(구현 5단계 산문 요구). `excluded===false`
 * (분석 대상) 커밋만 집계하고, 그 안에서도 viaMerge:true 항목은 정량
 * 집계에서 제외한다(evidence.json의 insertions/deletions 정의와 일관).
 * vendored 경로는 여기서만 걸러낸다(커밋 자체는 지우지 않는다는 위 설명 참조).
 */
function buildGitFacts(finalCommits, { vendoredPathsEnabled, customVendoredPathPatterns }) {
  const analyzed = finalCommits.filter((c) => !c.excluded);

  const pathModuleMap = {};
  const extensionHistogram = {};
  const churnByPath = new Map();
  const conventionalCommitTypeDistribution = {};
  let earliest = null;
  let latest = null;

  const CONVENTIONAL_RE = /^([a-z]+)(\([^)]*\))?!?:\s/i;

  for (const c of analyzed) {
    if (!earliest || c.authorDate < earliest) earliest = c.authorDate;
    if (!latest || c.authorDate > latest) latest = c.authorDate;

    const m = CONVENTIONAL_RE.exec(c.subject ?? "");
    const type = m ? m[1].toLowerCase() : "other";
    conventionalCommitTypeDistribution[type] = (conventionalCommitTypeDistribution[type] ?? 0) + 1;

    for (const f of c.files) {
      if (f.viaMerge) continue; // 머지 유입분은 정량 집계에서 제외(evidence.json과 일관)
      if (vendoredPathsEnabled && isVendoredPath(f.path, customVendoredPathPatterns)) continue;

      const topDir = f.path.includes("/") ? f.path.split("/")[0] : "(root)";
      pathModuleMap[topDir] = (pathModuleMap[topDir] ?? 0) + 1;

      const ext = path.extname(f.path) || "(no-ext)";
      extensionHistogram[ext] = (extensionHistogram[ext] ?? 0) + 1;

      if (!f.binary) {
        const prev = churnByPath.get(f.path) ?? 0;
        churnByPath.set(f.path, prev + f.insertions + f.deletions);
      }
    }
  }

  const topChangedFiles = [...churnByPath.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([filePath, churn]) => ({ path: filePath, churn }));

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    pathModuleMap,
    extensionHistogram,
    period: { earliest, latest },
    topChangedFiles,
    conventionalCommitTypeDistribution,
  };
}

// ---------------------------------------------------------------------------
// 원자적 쓰기(temp → rename, AC-16) + 저장 루트 해석
// ---------------------------------------------------------------------------

function writeJsonAtomic(dir, filename, obj) {
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, filename);
  const tmpPath = path.join(dir, `.${filename}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmpPath, JSON.stringify(obj, null, 2) + "\n", "utf8");
  fs.renameSync(tmpPath, finalPath);
  return finalPath;
}

/**
 * evidence.json·git-facts.json을 저장 루트에 원자적으로 쓴다.
 *
 * @param {{evidence: object, gitFacts: object}} result collectGitFacts()의 반환값
 * @param {{outDir?: string, repoPath?: string, storage?: object}} target
 *   outDir이 있으면 store.mjs 해석을 건너뛰고 그 디렉터리에 직접 쓴다.
 *   없으면 repoPath + storage로 scripts/lib/store.mjs의 resolveStorageRoot를
 *   호출해 저장 루트를 얻는다(§6·§9·AC-15 정본 경로).
 * @returns {{evidencePath: string, gitFactsPath: string, outDir: string}}
 */
export function writeCollectorOutput({ evidence, gitFacts }, { outDir, repoPath, storage } = {}) {
  const resolvedOutDir = outDir
    ? path.resolve(outDir)
    : resolveStorageRoot({ repoPath, storage }).root;

  const evidencePath = writeJsonAtomic(resolvedOutDir, "evidence.json", evidence);
  const gitFactsPath = writeJsonAtomic(resolvedOutDir, "git-facts.json", gitFacts);
  return { evidencePath, gitFactsPath, outDir: resolvedOutDir };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = {
    identities: [],
    allIdentities: false,
    ref: "HEAD",
    mergeIncluded: false,
    since: null,
    until: null,
    maxCommits: 1000,
    includeDiff: false,
    botsEnabled: true,
    vendoredPathsEnabled: true,
    out: null,
    storage: "home",
    repoOptIn: false,
  };
  let repo = null;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--repo":
        repo = argv[++i];
        break;
      case "--ref": {
        const v = argv[++i];
        opts.ref = v === "all" || v === "--all" ? "--all" : "HEAD";
        break;
      }
      case "--identity":
        opts.identities.push(argv[++i]);
        break;
      case "--all-identities":
        opts.allIdentities = true;
        break;
      case "--merge-included":
        opts.mergeIncluded = true;
        break;
      case "--no-merge-included":
        opts.mergeIncluded = false;
        break;
      case "--since":
        opts.since = argv[++i];
        break;
      case "--until":
        opts.until = argv[++i];
        break;
      case "--max-commits":
        opts.maxCommits = Number(argv[++i]);
        break;
      case "--include-diff":
        opts.includeDiff = true;
        break;
      case "--no-bots-exclude":
        opts.botsEnabled = false;
        break;
      case "--no-vendored-exclude":
        opts.vendoredPathsEnabled = false;
        break;
      case "--out":
        opts.out = argv[++i];
        break;
      case "--storage":
        opts.storage = argv[++i];
        break;
      case "--repo-opt-in":
        opts.repoOptIn = true;
        break;
      default:
        console.error(`[경고] 알 수 없는 인자 무시: ${a}`);
    }
  }

  return { repo, opts };
}

function printUsage() {
  console.error(
    "사용법: node scripts/collect-git-facts.mjs --repo <path> [--ref HEAD|all] " +
    "[--identity <email>]... [--all-identities] [--merge-included] [--since <date>] " +
    "[--until <date>] [--max-commits <n>] [--include-diff] [--no-bots-exclude] " +
    "[--no-vendored-exclude] [--out <dir>] [--storage home|repo] [--repo-opt-in]"
  );
}

function main() {
  const { repo, opts } = parseArgs(process.argv.slice(2));

  if (!repo) {
    printUsage();
    process.exit(2);
  }
  if (opts.identities.length === 0 && !opts.allIdentities) {
    console.error("[오류] --identity를 최소 1개 지정하거나 --all-identities를 지정하십시오(§5 추측 금지 게이트).");
    printUsage();
    process.exit(2);
  }

  let result;
  try {
    result = collectGitFacts({
      repoPath: repo,
      selectedIdentities: opts.identities,
      allIdentities: opts.allIdentities,
      ref: opts.ref,
      mergeIncluded: opts.mergeIncluded,
      since: opts.since,
      until: opts.until,
      maxCommits: opts.maxCommits,
      includeDiff: opts.includeDiff,
      botsEnabled: opts.botsEnabled,
      vendoredPathsEnabled: opts.vendoredPathsEnabled,
    });
  } catch (e) {
    console.error(`[오류] 수집 실패: ${e.message}`);
    process.exit(1);
  }

  const { evidence, gitFacts } = result;

  if (evidence.commits.length === 0 && evidence.coverage.traversed === 0) {
    console.error(
      "[안내] 이 레포에는 커밋이 없습니다(빈 레포 또는 unborn branch) — " +
      "정상 상태로 간주해 빈 원장을 생성합니다."
    );
  }

  let written;
  try {
    written = writeCollectorOutput(
      { evidence, gitFacts },
      {
        outDir: opts.out,
        repoPath: repo,
        storage: opts.out ? undefined : { root: opts.storage, repoOptIn: opts.repoOptIn },
      }
    );
  } catch (e) {
    console.error(`[오류] 쓰기 실패: ${e.message}`);
    process.exit(1);
  }

  console.log(
    `[collect-git-facts] traversed=${evidence.coverage.traversed} total=${evidence.coverage.total} ` +
    `analyzed=${evidence.coverage.analyzed} dropped=${evidence.truncated.dropped_commits} ` +
    `reason=${evidence.truncated.reason} sourceRepoHead=${evidence.sourceRepoHead}`
  );
  console.log(`[collect-git-facts] evidence.json: ${written.evidencePath}`);
  console.log(`[collect-git-facts] git-facts.json: ${written.gitFactsPath}`);
  process.exit(0);
}

const isMainModule = (() => {
  try {
    return import.meta.url === pathToFileURL(process.argv[1]).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main();
}
