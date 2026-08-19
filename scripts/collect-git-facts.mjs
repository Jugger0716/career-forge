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
//
// 콜드 리뷰 A-38 대응: CLI에는 `--include-diff`를 노출하지 않는다. diff
// 원문 인용 경로 자체가 P0에 아직 없다(evidence.schema.json이 diff 원문을
// 담지 않는다 — schemas/config.schema.json의 snippetQuoting 설명 참조).
// 켜도 관측 가능한 산출물 차이가 0인 플래그를 광고하면 사용자를 속이므로,
// 구현 7단계 이후 실제로 diff 원문을 수집하게 되는 시점에 플래그를 다시
// 노출한다. collectGitFacts()는 여전히 options.includeDiff를 프로그래밍
// API로 받되(향후 확장을 위한 자리표시자, 아래 void 처리) CLI 표면에는
// 올리지 않는다.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  hasAnyCommitOnHead,
  listCommitMetadata,
  getCommitFileChanges,
  runGit,
  isShallowRepository,
  getAbsoluteGitDir,
} from "./lib/git.mjs";
import {
  computeSampling,
  CANONICAL_SAMPLING_METHOD_LITERAL,
  NO_TRUNCATION_SAMPLING_METHOD_LITERAL,
} from "./lib/sampling.mjs";
import { getRepoToplevel, resolveStorageRoot, writeJsonAtomic } from "./lib/store.mjs";
import { computeEvidenceContentHash } from "./lib/content-hash.mjs";
import { redactSecrets } from "./lib/redact.mjs";

const SCHEMA_VERSION = "0.1.0";
const NULL_SHA = "0".repeat(40); // unborn branch(0커밋) 전용 정본 sentinel(git의 null-oid 관례).

// §5 기본 봇 패턴. 이메일 기준으로만 판정한다(픽스처의 봇 이메일이 패턴을
// 이미 포함하므로 이름 필드까지 볼 필요가 없다 — buildBotCommits 참조).
const DEFAULT_BOT_PATTERNS = [/\[bot\]/i, /dependabot/i, /github-actions/i];

// §5 기본 vendored 경로 패턴(집계 전용 — 커밋 제외 축이 아니다. 아래
// "vendored 경로는 집계에서만 제외한다" 설명 참조). 콜드 리뷰 M 대응 —
// `/\.lock$/`만으로는 `package-lock.json`·`go.sum`·`composer.lock`·
// `poetry.lock` 같은 흔한 락파일 확장자를 못 잡아 churn 표본·
// topChangedFiles가 lockfile 갱신 커밋으로 채워진다(실측: npm 프로젝트에서
// package-lock.json이 topChangedFiles[0]이 됨). 대표 언어별 락파일을
// 명시 패턴으로 추가한다.
const DEFAULT_VENDORED_PATH_PATTERNS = [
  /^node_modules\//,
  /^dist\//,
  /^vendor\//,
  /^migrations\//,
  /\.lock$/,
  /(^|\/)package-lock\.json$/,
  /(^|\/)pnpm-lock\.yaml$/,
  /(^|\/)go\.sum$/,
  /(^|\/)composer\.lock$/,
  /(^|\/)poetry\.lock$/,
];

// coverage.period.since/until 및 CLI --since/--until의 필수 형식(스키마
// evidence.schema.json coverage.period.{since,until}의 format:"date"와
// 일치). 콜드 리뷰 A-5 대응 — 검증 없이 임의 문자열을 Date.parse에
// 넘기면(git 상대 날짜 "2 years ago" 등) NaN이 조용히 만들어져 시간 균등
// 샘플링 버킷이 "가장 오래된 커밋 뽑기"로 퇴화한다. 이 정규식을 통과한
// 값만 Date.parse에 넘기므로 NaN이 원천적으로 발생하지 않는다.
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * since/until 문자열을 검증하고 UTC epoch(초)로 변환한다. null/undefined는
 * "미지정"으로 그대로 null을 반환한다. 형식이 어긋나면 명확한 오류를
 * 던진다(호출자가 이를 controlled exit로 변환한다 — 조용한 NaN 전파 금지).
 *
 * @param {string|null|undefined} value
 * @param {"since"|"until"} label
 * @returns {number|null}
 */
function parsePeriodBoundaryEpoch(value, label) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !DATE_ONLY_RE.test(value)) {
    throw new Error(
      `--${label} 값이 YYYY-MM-DD 형식이 아닙니다: ${JSON.stringify(value)} — ` +
      `schemas/evidence.schema.json coverage.period.${label}의 format:"date" 계약과 일치해야 합니다` +
      "(git 상대 날짜 표기 '2 years ago' 등은 지원하지 않습니다 — Date.parse가 조용히 NaN을 내는 것을 막기 위함)."
    );
  }
  const epoch = Math.floor(Date.parse(`${value}T00:00:00Z`) / 1000);
  if (!Number.isFinite(epoch)) {
    throw new Error(`--${label} 값을 파싱할 수 없습니다: ${value}`);
  }
  return epoch;
}

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
 * shallow 경계 > 기간(period) 밖 > 봇 > 저자 미선택 > 머지 제외 설정.
 * vendored 경로는 여기 관여하지 않는다(파일 경로 단위 성격이라 커밋
 * 전체를 제외하면 실사용 커밋을 통째로 지우게 되므로, 집계(git-facts.json)
 * 에서만 걸러낸다).
 *
 * shallow 경계(콜드 리뷰 C3)를 최우선으로 두는 이유: 이 판정은 정책이
 * 아니라 데이터 무결성 문제다 — 경계 커밋의 files[]는 빈 트리 대비 diff라
 * 애초에 신뢰할 수 없으므로, 저자가 선택 identity와 일치하더라도 population
 * 에 절대 들어가면 안 된다.
 *
 * 기간(period) 필터(콜드 리뷰 C2)를 그다음에 두는 이유: git log 자체에는
 * 더 이상 --since/--until을 넘기지 않고(committerDate 축·조기 중단 문제
 * 회피) 전량 순회 결과를 여기서 authorEpochSec 기준으로 걸러낸다. 이렇게
 * 하면 기간 밖 커밋도 봇/타 저자 커밋과 동일하게 원장에 excluded:true로
 * 전량 등재되어(AC-9 관측 가능성과 동일한 원칙) "기간 지정 시 원장이
 * dropped 0건을 거짓 단언"하는 문제가 원천적으로 사라진다 — 누락이 아니라
 * 가시적 제외가 되기 때문이다.
 */
function classifyExclusion(commit, {
  selectedIdentities, botsEnabled, customBotPatterns, mergeIncluded,
  shallowBoundaryHashes, sinceEpoch, untilEpochExclusive,
}) {
  if (shallowBoundaryHashes && shallowBoundaryHashes.has(commit.hash)) {
    return { excluded: true, exclusionReason: "shallow-boundary" };
  }
  if (sinceEpoch != null && commit.authorEpochSec < sinceEpoch) {
    return { excluded: true, exclusionReason: "period-out-of-range" };
  }
  if (untilEpochExclusive != null && commit.authorEpochSec >= untilEpochExclusive) {
    return { excluded: true, exclusionReason: "period-out-of-range" };
  }
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

/**
 * shallow clone 여부와(그렇다면) `.git/shallow`에 기록된 경계 커밋 해시
 * 집합을 조회한다(콜드 리뷰 C3). `.git/shallow`는 grafted(부모 잘림)
 * 커밋의 해시를 한 줄에 하나씩 담은 평문 파일이다 — 이 파일이 곧 "부모가
 * 없다고 보고되지만 진짜 루트가 아닌" 커밋 집합의 정본이다.
 *
 * @param {string} repoToplevel
 * @returns {{isShallow: boolean, boundaryHashes: Set<string>}}
 */
function detectShallowBoundary(repoToplevel) {
  if (!isShallowRepository(repoToplevel)) {
    return { isShallow: false, boundaryHashes: new Set() };
  }
  const gitDir = getAbsoluteGitDir(repoToplevel);
  if (!gitDir) return { isShallow: true, boundaryHashes: new Set() };
  const shallowFile = path.join(gitDir, "shallow");
  if (!fs.existsSync(shallowFile)) return { isShallow: true, boundaryHashes: new Set() };
  const lines = fs
    .readFileSync(shallowFile, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return { isShallow: true, boundaryHashes: new Set(lines) };
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

  // 콜드 리뷰 A-5/C2 대응: since/until을 여기서 한 번만 검증·변환한다.
  // 검증을 통과한 값만 존재하므로 이 시점 이후로는 NaN이 원리적으로
  // 발생할 수 없다(sampling.mjs의 시간 균등 버킷 range 계산에도 이 값을
  // 그대로 재사용 — 별도로 Date.parse를 다시 호출하지 않는다).
  const sinceEpoch = parsePeriodBoundaryEpoch(since, "since");
  const untilEpoch = parsePeriodBoundaryEpoch(until, "until");
  // until은 "그 날짜까지 포함"이므로 다음 날 00:00 UTC 미만까지가 상한이다.
  const untilEpochExclusive = untilEpoch != null ? untilEpoch + 86400 : null;

  // 콜드 리뷰 C3 대응: shallow clone이면 `.git/shallow`의 경계 커밋 해시를
  // 미리 조회해 population/집계에서 제외할 준비를 한다.
  const { isShallow, boundaryHashes: shallowBoundaryHashes } = detectShallowBoundary(repoToplevel);

  // 빈 레포/unborn branch: HEAD 모드에서 미리 확인해 git log 자체를 호출
  // 하지 않는다(예외 중단 방지 — HEAD가 unborn이면 `git log HEAD`는 fatal로
  // 종료하므로 이 사전 확인이 없으면 listCommitMetadata가 outcome!=='ok'를
  // 반환해 "알 수 없는 git 오류"로 오인될 수 있다). --all 모드는 unborn
  // 여부와 무관하게 항상 안전하게 빈 출력을 낸다(실측 확인).
  //
  // 콜드 리뷰 C2 대응: --since/--until을 listCommitMetadata에 더 이상
  // 넘기지 않는다(committerDate 축 불일치·조기 중단 회피) — 항상 기간
  // 무제한으로 전량 순회하고, 기간 필터는 아래 classifyExclusion에서
  // authorEpochSec 기준으로 적용한다.
  let rawCommits = [];
  if (ref === "HEAD") {
    if (hasAnyCommitOnHead(repoToplevel)) {
      const r = listCommitMetadata(repoToplevel, { ref: "HEAD" });
      if (!r.ok) {
        throw new Error(`git log(HEAD) 실패(outcome=${r.outcome}): ${r.stderr}`);
      }
      rawCommits = r.commits;
    }
  } else {
    const r = listCommitMetadata(repoToplevel, { ref: "--all" });
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
      shallowBoundaryHashes,
      sinceEpoch,
      untilEpochExclusive,
    });
    // --all-identities는 "저자 미선택" 축만 무력화한다(shallow/기간/봇/머지 축은 그대로 적용).
    const finalExclusion =
      allIdentities && exclusion.exclusionReason === "author-not-selected"
        ? { excluded: false, exclusionReason: null }
        : exclusion;

    // 콜드 리뷰 A-6 대응: churn "랭킹" 값은 evidence.json의 commit-level
    // insertions/deletions(AC-6 (i) 불변식의 대상 — vendored 포함 전체 합)
    // 와 별개다. 이 값은 스키마에 노출되지 않고 sampling.mjs의 churn 버킷
    // 입력으로만 쓰이므로, vendored/lockfile 경로를 랭킹에서 빼도 AC-6 (i)
    // 와 충돌하지 않는다 — "실제 작업"을 반영하지 못하는 자동 생성 lockfile
    // 갱신 커밋이 churn 표본을 독식하는 문제를 여기서 막는다.
    const nonVendoredChurn = diff.files.reduce((sum, f) => {
      if (f.viaMerge || f.binary) return sum;
      if (vendoredPathsEnabled && isVendoredPath(f.path, customVendoredPathPatterns)) return sum;
      return sum + f.insertions + f.deletions;
    }, 0);

    return {
      ...c,
      files: diff.files,
      insertions: diff.insertions,
      deletions: diff.deletions,
      churn: nonVendoredChurn,
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
    // sinceEpoch/untilEpoch는 이미 위에서 검증·계산된 값을 재사용한다(콜드
    // 리뷰 A-5 — 여기서 다시 Date.parse를 호출하지 않아 NaN이 재도입될
    // 여지가 없다). since ?? undefined 형태로 null→undefined 변환만 한다
    // (computeSampling/selectEvenBucket이 "미지정"을 undefined로 기대).
    const samplingInput = population.map((c) => ({
      hash: c.hash,
      authorEpochSec: c.authorEpochSec,
      churn: c.churn,
    }));
    const result = computeSampling(samplingInput, maxCommits, {
      since: sinceEpoch ?? undefined,
      until: untilEpoch ?? undefined,
    });
    selectedHashSet = new Set(result.selectedHashes);
    coverageAnalyzed = result.K;
    truncated = { reason: "budget_commits", dropped_commits: total - result.K };
    samplingMethod = CANONICAL_SAMPLING_METHOD_LITERAL;
  }

  // 콜드 리뷰 A-9/A-10 대응: subject·coAuthors는 diff 원문이 아니므로
  // `--no-diff` 기본값의 보호 범위 밖이다 — 원장에 등재되는 이 두 필드에
  // scripts/lib/redact.mjs를 여기서 실제로 배선해 커밋 제목·co-author
  // 트레일러의 시크릿/PII를 마스킹한다. hash/shortHash/authorEmail은
  // 구조화된 identity·인용 앵커 필드이므로(AC-7 (a)축·해시 할루시네이션
  // 차단) 대상에서 제외한다 — 특히 email 패턴을 authorEmail에 적용하면
  // required 필드가 통째로 사라진다(A-10 실패 시나리오).
  //
  // excluded:true 커밋은 마스킹보다 강한 처리를 받는다 — authorEmail·
  // subject·coAuthors를 **아예 기록하지 않는다**(각각 null·null·[]).
  // spec.md §6이 확정한 정책이며, 근거는 "제외 커밋의 이 세 필드를 읽는
  // 검사가 하나도 없다"는 것이다(verify-evidence.mjs는 excluded 체크에서
  // 먼저 return 하고, invariants.mjs와 (e)축 집합 동치는 files[]·parents·
  // insertions/deletions만 읽는다). 마스킹은 알려진 패턴만 가리지만 동료의
  // 이메일과 커밋 제목 자체는 알려진 패턴이 아니므로 그대로 남는다 —
  // 값이 애초에 파일에 닿지 않게 하는 것이 유일한 실효 방어다.
  // 따라서 아래 redactField는 excluded:false 경로에서만 호출되며,
  // redactionSummary 히트 수도 그만큼만 집계된다(기록하지 않는 값을
  // 마스킹했다고 보고하지 않는다).
  const redactionHits = new Map(); // name -> 누적 count(보고용)
  function accumulateHits(hits) {
    for (const { name, count } of hits) {
      redactionHits.set(name, (redactionHits.get(name) ?? 0) + count);
    }
  }
  function redactField(text) {
    const { text: masked, hits } = redactSecrets(text);
    accumulateHits(hits);
    return masked;
  }

  // 순회 순서를 보존한 채 "제외 커밋(전량)" ∪ "선택된 population 커밋"만 남긴다.
  const finalCommits = enriched
    .filter((c) => c.excluded || selectedHashSet.has(c.hash))
    .map((c) => ({
      id: `commit:${c.hash}`,
      hash: c.hash,
      shortHash: c.hash.slice(0, 12),
      authorEmail: c.excluded ? null : c.authorEmail,
      authorDate: c.authorDateIso,
      parents: c.parents,
      isMerge: c.isMerge,
      coAuthors: c.excluded ? [] : c.coAuthors.map(redactField),
      subject: c.excluded ? null : redactField(c.subject),
      insertions: c.insertions,
      deletions: c.deletions,
      files: c.files,
      excluded: c.excluded,
      exclusionReason: c.exclusionReason,
    }));

  const redactionSummary = {
    totalHits: [...redactionHits.values()].reduce((a, b) => a + b, 0),
    byPattern: Object.fromEntries([...redactionHits.entries()].sort(([a], [b]) => a.localeCompare(b))),
  };

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
    // 콜드 리뷰 C3 대응: shallow clone 감지 사실을 커버리지에 명시한다
    // (spec.md 엣지 케이스 원문 — "감지 후 커버리지에 명시"). true면
    // 경계 커밋들이 commits[]에서 excluded:true·exclusionReason:
    // "shallow-boundary"로 표시돼 population·집계에서 제외됐다는 뜻이다.
    isShallowClone: isShallow,
  };

  // 콜드 리뷰 A-7 대응: 해시 산식을 scripts/lib/content-hash.mjs의 단일
  // 함수로 뺐다 — 쓰기(여기)와 검증(verify-evidence.mjs, validate-plugin.mjs
  // --schema-check)이 같은 구현·같은 키 순서를 공유한다. generatedAt은
  // 해시 대상에서 제외되므로(computeEvidenceContentHash 자체가 그 필드를
  // 읽지 않는다) 같은 레포·같은 옵션의 두 번째 실행도 동일한 contentHash를
  // 낸다(결정성 게이트에 이 사실을 이용할 수 있다).
  const evidence = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    sourceRepoHead,
    contentHash: "", // 아래에서 본문 기준으로 재계산해 채운다.
    coverage,
    truncated,
    commits: finalCommits,
  };
  evidence.contentHash = computeEvidenceContentHash(evidence);

  const gitFacts = buildGitFacts(finalCommits, { vendoredPathsEnabled, customVendoredPathPatterns });

  void includeDiff; // P0에서는 diff 원문을 evidence.json 스키마가 담지 않는다(§4) —
  // 이 플래그는 향후 옵트인 스니펫 경로(구현 7단계 이후)를 위한 자리표시자다.

  // redactionSummary는 evidence.json 스키마에 없는 별도 반환값이다(스키마가
  // additionalProperties:false라 evidence 본문에 필드를 얹을 수 없다) —
  // CLI(main())가 "무엇이 가려졌는지" stderr에 보고하는 데만 쓴다. 순수
  // 함수 계약(디스크에 쓰지 않음)은 유지된다 — console 출력이 아니라
  // 반환값이므로 호출자가 보고 여부를 결정한다.
  return { evidence, gitFacts, redactionSummary };
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

// writeJsonAtomic은 이 파일의 비공개 함수였으나 scripts/lib/store.mjs로
// 끌어올렸다(구현 7단계 (d) — slice_plan.md의 슬라이스 A 파일 수정 예외 1번).
// state/config를 쓰는 주체가 생기면서 temp→rename 규약이 두 곳에 복사될
// 참이었기 때문이다. 사본을 여기 다시 만들지 마라 — 원자성 계약의 정본은
// store.mjs 하나이며, 이 파일은 그것을 import해 쓴다.

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

// 테스트 전용 export(단위 테스트에 필요 — 프로덕션 로직은 위 공개 함수를
// 통해서만 호출된다. git.mjs의 `_internal` 패턴과 동일).
export const _internal = { isVendoredPath, DEFAULT_VENDORED_PATH_PATTERNS, parsePeriodBoundaryEpoch };

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
    "[--until <date>] [--max-commits <n>] [--no-bots-exclude] " +
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
      botsEnabled: opts.botsEnabled,
      vendoredPathsEnabled: opts.vendoredPathsEnabled,
    });
  } catch (e) {
    console.error(`[오류] 수집 실패: ${e.message}`);
    process.exit(1);
  }

  const { evidence, gitFacts, redactionSummary } = result;

  if (redactionSummary.totalHits > 0) {
    const byPattern = Object.entries(redactionSummary.byPattern)
      .map(([name, count]) => `${name}=${count}`)
      .join(", ");
    console.error(
      `[마스킹] 커밋 제목·co-author 트레일러에서 시크릿/PII 패턴 ${redactionSummary.totalHits}건을 ` +
      `[REDACTED:*]로 치환했습니다 (${byPattern}).`
    );
  }

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
