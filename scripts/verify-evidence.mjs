#!/usr/bin/env node
// scripts/verify-evidence.mjs
//
// 구현 6단계: 인용 무결성 검증기. LLM 호출 0회 — 이 제품의 할루시네이션
// 방지 규약("출처 인용 강제")을 실제로 집행하는 유일한 코드다.
//
// scripts/lib/git.mjs 의 (exit code, stderr 패턴) 3분류·머지 diff 산식을
// 그대로 import해서 쓴다(자체 구현 금지 — §2·구현 5·6단계).
//
// 검증 축(spec.md §2 · 구현 6단계 원문):
//   (a) 저자 대조 — 인용된 커밋이 원장에 존재하며 excluded !== true 이고,
//       원장 authorEmail이 git이 실제로 보고하는 저자와 일치하며(원장
//       변조·스테일 방어 — 콜드 리뷰 M 대응), 그 실측 저자가 config가
//       저장한 선택 identity 집합에 속하는가. excluded 플래그는 "수집
//       시점" 판정이고 selectedIdentities는 "검증 시점" 값이므로 둘을
//       독립적으로 검사한다(원장 스테일 방어).
//   (b) `git show -s --format=%ae<US>%P <sha>` 커밋 실존성 + 저자·부모
//       오라클(콜드 리뷰 M 대응 — 예전에는 `git rev-parse --verify
//       --quiet`로 실존성만 확인하고 (a)축이 원장 authorEmail을 그대로
//       신뢰했다. 이제 (a)축과 머지 판정 둘 다 이 오라클의 실측값을 쓴다
//       — 원장 필드 조작만으로는 뚫리지 않는다). (a)축 원장 조회와
//       무관하게 항상 독립 실행한다 — 원장 포맷을 흉내낸 가짜 해시(원장에
//       없는 40자 hex)를 이 축이 잡는다.
//   (c) 경로 실존성 — 커밋 트리(<sha>:<path>)가 아니라 그 커밋의 diff
//       (scripts/lib/git.mjs getCommitFileChanges, 수집기와 동일 구현)에
//       그 경로가 등장하는가. (b)를 통과한 인용에만 호출한다. diff base는
//       원장이 아니라 (b)축 오라클의 실측 parents로 계산한다.
//   머지 해시 규칙 — 판정 오라클은 원장 `isMerge` 필드가 아니라
//       `isMergeCommit(parents)`(정본은 항상 parents, git.mjs 단일 구현
//       — 콜드 리뷰 M 대응: `isMerge` 플래그 하나만 true→false로 바꿔도
//       parents가 그대로면 더 이상 규칙이 꺼지지 않는다), basis:inference
//       이외 전부(commit·external·insufficient·미지정 포함) FAIL —
//       "inference만 허용"의 문언대로 상보 조건으로 집행한다.
//   (e) AC-7 집합 동치 — 머지 커밋(정본은 동일하게 isMergeCommit(parents))에
//       대해 원장 files[] 집합과 검증기가 scripts/lib/git.mjs
//       getCommitFileChanges로 재계산한 diff 집합이 동일한가.
//       mergeIncluded 설정과 무관하게 evidence.json 하나로 성립한다
//       (files[]는 두 설정 모두 1부모 diff로 채워지므로) —
//       verifyMergeFileSetEquivalence()가 담당하며 verifyEvidence()가
//       artifactsByLayer와 무관하게 항상 함께 실행한다.
//   (d) 계층 ID 참조 무결성 — knowledge-map→career, gap-report→
//       knowledge-map, plan→gap-report 방향으로만 parentRefs를 확인한다
//       (역참조 없음, 단방향 6계층).
//   contentHash — evidence.json 본문을 scripts/lib/content-hash.mjs로
//       독립 재계산해 기록된 contentHash와 대조한다(콜드 리뷰 A-7 대응).
//       불일치는 hasFailures에 포함되는 정식 위반(EVIDENCE_CONTENT_HASH_
//       MISMATCH)이다. sourceRepoHead 스테일 경고는 별도로 --repo의 현재
//       HEAD와 evidence.sourceRepoHead를 대조해 report.sourceRepoHeadStaleness
//       에 담는다 — 이쪽은 FAIL이 아니라 정보성 경고다(레포에 새 커밋이
//       쌓이는 것 자체는 오류가 아니다).
//
// 도구·레포 오류(3분류의 "tool-error")는 인용 FAIL로 집계하지 않지만
// (spec.md §2 원문대로) PASS로도 집계하지 않는다 — 별도 섹션(toolErrors)에
// 보고하고 verifyEvidence()의 status를 INCONCLUSIVE로 떨어뜨린다(콜드
// 리뷰 C4 대응, 아래 종료 코드 참조). 옵트인 스니펫 인용(파일 내용 인용)은
// 메인 (a)(b)(c) 축과 별도로 verifySnippetCitation()이 담당하며,
// changeType:D 항목과 oldPath에는 적용하지 않는다(git cat-file -e가
// 삭제 경로에서 항상 128로 실패하는 자기모순 회피 — spec.md 배경 §).
//
// 인용마다 git 프로세스를 새로 스폰하지 않도록 createVerificationCache()가
// (repoPath,sha) 단위로 (b)축 오라클·(c)축 diff 결과를 메모이즈한다(콜드
// 리뷰 M 대응 — 동일 커밋·경로를 반복 인용하는 산출물에서 스폰 수가
// O(인용 수)에서 O(고유 (repoPath,sha) 수)로 준다). verifyEvidence()가
// 자동으로 캐시를 만들어 전체 인용·머지 집합 검사에 공유한다.
//
// 사용법(CLI):
//   node scripts/verify-evidence.mjs --repo <path> --evidence <evidence.json>
//     [--config <config.json>]              identitySelection.selected를
//                                            selectedIdentities로 사용
//     [--identity <email>]...               config 없이(또는 config에 더해)
//                                            selectedIdentities를 직접 지정
//     --artifact <layer>=<path>...          layer: career|knowledge-map|
//                                            gap-report|plan. 반복 가능,
//                                            최소 1개(또는 --out-dir).
//     [--out-dir <dir>]                     <dir>에서 career.json 등 4종
//                                            파일명을 자동 탐색해 로드
//     [--out <path>]                        JSON 리포트를 파일로도 기록
//
// 종료 코드(콜드 리뷰 C4 대응 — fail-open 제거, 3분기):
//   0 = PASS         인용 FAIL·미해결 parentRefs·(e)축 위반 0건이고
//                     도구 오류로 미검증된 인용도 0건이며, **산출물이
//                     로드됐다면 실제로 검증한 인용이 1건 이상**이다.
//   1 = FAIL          위 위반 중 하나라도 있음(도구 오류가 섞여 있어도
//                     확정된 위반이 우선한다).
//   2 = INCONCLUSIVE  확정된 위반은 0건이지만 검증을 완결하지 못함. 사유는
//                     report.inconclusiveReasons에 코드로 남는다:
//                       CITATION_TOOL_ERRORS   — 도구·레포 오류로 일부
//                         인용을 검증하지 못함(예: --repo 오타, git이
//                         PATH에 없는 셸).
//                       NO_CITATIONS_TO_VERIFY — 산출물이 1계층 이상
//                         로드됐는데 인용도 0건이고 (f)축 대조 대상도
//                         0건이라 **어떤 축도 집행되지 않음**(게이트 C-5 /
//                         심사 C-3 수정안 ③). 두 경우는 여기 걸리지
//                         않는다: artifactsByLayer가 비어 있는 호출
//                         ((e)축·contentHash만 요구한 것이므로 그 PASS는
//                         공허하지 않다)과, 인용은 0건이지만 (f)축이
//                         external 노드를 실제로 대조한 산출물.
//                     둘 다 "성공"이 아니므로 0을 반환하지 않는다. CLI 인자
//                     오류(usage)와 입력 파일 오류(A-32의 [INPUT_ERROR])도
//                     같은 exit 2를 쓴다(전부 "결론을 낼 수 없음" 계열).
// report.ok(boolean)는 status==="PASS"의 축약이다 — INCONCLUSIVE도
// ok===false다(더 이상 "도구 오류만 있으면 exit 0"이 성립하지 않는다).
//
// 프로그래밍 API: KNOWN_LAYERS / verifyCitation / verifySnippetCitation / verifyArtifactInstance /
// verifyMergeFileSetEquivalence / checkLayerRefs / verifyEvidence /
// exitCodeForReport / createVerificationCache — 순수 함수(디스크에 쓰지
// 않음). CLI는 이 함수들을 호출하고 결과를 출력·파일 기록만 담당한다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  getCommitAuthorAndParents,
  getCommitFileChanges,
  catFileExists,
  isMergeCommit,
  runGit,
} from "./lib/git.mjs";
import { checkContentHashInvariant } from "./lib/invariants.mjs";

const LEDGER_ID_RE = /^commit:([0-9a-f]{40})$/;
const RAW_HASH_RE = /^[0-9a-f]{40}$/;

const LAYER_PARENT = {
  "knowledge-map": "career",
  "gap-report": "knowledge-map",
  "plan": "gap-report",
};

// 콜드 리뷰 A-34 대응(이 파일 몫). 같은 리터럴이 scripts/validate-plugin.mjs
// 에도 하드코딩돼 있는데 그 파일은 이번 예외 범위 밖이므로 고치지 않는다.
// 대신 여기서 export 해 **드리프트를 tests/run-smoke.mjs의 소스 스캔
// 오라클이 관측**한다 — 한쪽만 계층을 추가하면 그 오라클이 FAIL한다.
// export 없이 두면 대조할 정본이 없어 두 사본이 갈려도 아무도 모른다.
export const KNOWN_LAYERS = ["career", "knowledge-map", "gap-report", "plan"];

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_SOURCES_PATH = path.join(REPO_ROOT, "references", "sources.json");

// ---------------------------------------------------------------------------
// 검증 캐시(콜드 리뷰 M 대응) — 동일 (repoPath, sha)에 대한 git 오라클
// 호출(저자/부모 조회, diff 조회)을 verifyEvidence() 스코프 안에서 재사용한다.
// verify-evidence.mjs가 인용마다 git 프로세스를 1~3회 새로 스폰하고
// 메모이제이션이 전혀 없어 동일 커밋·경로 인용 100건에 실측 21~60초가
// 걸리던 문제(A-8의 저자 오라클 도입으로 호출 수가 늘어날 수 있었던 지점을
// 정확히 상쇄한다 — 인용마다 새 git show를 스폰하는 대신 (repoPath,sha) 당
// 최대 1회만 스폰한다).
// ---------------------------------------------------------------------------

/**
 * verifyEvidence() 호출 하나의 스코프에 한정된 캐시를 만든다. 호출자가
 * 명시적으로 만들어 verifyEvidence()/verifyArtifactInstance()/verifyCitation()/
 * verifyMergeFileSetEquivalence()에 넘기면 그 스코프 안에서 (repoPath,sha)당
 * git 오라클 호출이 최대 1회로 줄어든다. 넘기지 않으면 각 함수가 자체
 * 1회용 캐시를 만들어 기존처럼 캐시 없이 동작한다(순수 함수 단위 테스트
 * 호환성 — 캐시는 성능 최적화일 뿐 판정 결과에는 영향을 주지 않는다).
 *
 * @returns {{authorParents: Map<string, object>, fileChanges: Map<string, object>}}
 */
export function createVerificationCache() {
  return { authorParents: new Map(), fileChanges: new Map() };
}

/**
 * (repoPath, sha) → 캐시 Map 키. 이 함수가 유일한 정본이므로 테스트가
 * 구분자를 따로 하드코딩하지 않아도 된다(캐시를 미리 심어 검증 로직만
 * 격리 테스트할 때 필요 — 예: tool-error 결과를 직접 주입해 status
 * 우선순위 집계를 재현). 구분자는 공백이며 repoPath에 공백이 섞여 있어도
 * (Windows 경로에서 흔함) sha는 항상 40자 hex 고정 길이이므로 문자열
 * 끝에서부터 파싱하면 항상 역산 가능하다 — 다만 이 함수는 조회용 키일
 * 뿐이라 역산은 필요하지 않다.
 *
 * @param {string} repoPath
 * @param {string} sha
 * @returns {string}
 */
export function verificationCacheKey(repoPath, sha) {
  return `${repoPath} ${sha}`;
}

function getCommitAuthorAndParentsCached(cache, repoPath, sha) {
  const key = verificationCacheKey(repoPath, sha);
  if (cache.authorParents.has(key)) return cache.authorParents.get(key);
  const result = getCommitAuthorAndParents(repoPath, sha);
  cache.authorParents.set(key, result);
  return result;
}

function getCommitFileChangesCached(cache, repoPath, sha, parents, isMerge) {
  const key = verificationCacheKey(repoPath, sha);
  if (cache.fileChanges.has(key)) return cache.fileChanges.get(key);
  const result = getCommitFileChanges(repoPath, sha, parents, isMerge);
  cache.fileChanges.set(key, result);
  return result;
}

// ---------------------------------------------------------------------------
// ledgerId → sha 추출 + 원장 조회
// ---------------------------------------------------------------------------

/**
 * ledgerId(정상적으로는 evidence.json commits[].id, 형식 "commit:<sha40>")
 * 에서 검증 대상 커밋 해시를 뽑는다. 원장 ID 포맷을 흉내내지 않은 "생짜"
 * 40자 hex 문자열도 방어적으로 sha 후보로 인정한다(할루시네이션이 ledgerId
 * 필드에 직접 해시를 써넣는 경로를 (b)축이 잡을 수 있도록 — evidenceCitation
 * 스키마의 ledgerId는 minLength:1일 뿐 포맷 pattern이 없다).
 *
 * @param {string} ledgerId
 * @returns {string|null}
 */
export function extractShaCandidate(ledgerId) {
  if (typeof ledgerId !== "string") return null;
  const m = LEDGER_ID_RE.exec(ledgerId);
  if (m) return m[1];
  if (RAW_HASH_RE.test(ledgerId)) return ledgerId;
  return null;
}

/**
 * evidence.json의 commits[]에서 ledgerId(우선) 또는 sha(대체)로 항목을
 * 찾는다. id로 못 찾으면 hash로 한 번 더 찾는다 — ledgerId가 "commit:"
 * 접두사 없이 생짜 해시로 주어졌지만 실제로 원장에 있는 커밋일 수 있는
 * 경우까지 놓치지 않는다.
 *
 * @param {object} evidence evidence.json 파싱 결과
 * @param {string} ledgerId
 * @param {string} sha
 * @returns {object|null}
 */
export function findLedgerEntry(evidence, ledgerId, sha) {
  const commits = evidence?.commits ?? [];
  return commits.find((c) => c.id === ledgerId) ?? commits.find((c) => c.hash === sha) ?? null;
}

// ---------------------------------------------------------------------------
// (a)(b)(c)축 + 머지 해시 규칙 — 인용 하나에 대한 판정
// ---------------------------------------------------------------------------

/**
 * 인용 하나(evidenceCitation: {ledgerId, path?})를 검증한다.
 *
 * @param {object} opts
 * @param {string} opts.repoPath (b)(c)축 git 호출 대상 레포
 * @param {object} opts.evidence evidence.json 파싱 결과
 * @param {string[]} opts.selectedIdentities config가 저장한 선택 identity 집합
 * @param {string} opts.ledgerId
 * @param {string|null} [opts.citationPath] (c)축 대조 대상 경로(선택)
 * @param {string} [opts.nodeBasis] 이 인용을 담은 노드의 basis(머지 해시 규칙에 필요)
 * @param {object} [opts.cache] createVerificationCache()의 반환값(선택 —
 *   verifyEvidence() 스코프에서 재사용하면 (repoPath,sha)당 git 호출이
 *   최대 1회로 줄어든다. 생략하면 이 호출 하나만을 위한 캐시를 새로 만든다).
 * @returns {{verdict: "PASS"|"FAIL"|"TOOL_ERROR", code: string, message: string,
 *   ledgerId: string, sha: string|null, path: string|null}}
 */
export function verifyCitation({ repoPath, evidence, selectedIdentities, ledgerId, citationPath = null, nodeBasis = null, cache = createVerificationCache() }) {
  const base = { ledgerId, path: citationPath, sha: null };

  const sha = extractShaCandidate(ledgerId);
  if (!sha) {
    return { ...base, verdict: "FAIL", code: "CITATION_MALFORMED_LEDGER_ID", message: `ledgerId '${ledgerId}'에서 커밋 해시를 추출할 수 없습니다.` };
  }
  base.sha = sha;

  // (b)축 + 저자·부모 오라클 — 원장 조회와 무관하게 항상 독립 실행한다
  // (가짜 해시를 여기서 잡는다). 콜드 리뷰 M 대응: 예전에는 (b)축이
  // 실존성만 확인하고 (a)축은 원장의 authorEmail을 그대로 신뢰했다 —
  // `git show -s --format=%ae\x1f%P`로 실존성·저자·부모를 한 번에 얻어
  // (a)축에도 (b)(c)축과 동일한 독립 오라클을 준다(호출 수는 늘지 않는다
  // — 이전에도 (b)축 1회 호출이 있었고 이번에도 1회다).
  const oracle = getCommitAuthorAndParentsCached(cache, repoPath, sha);
  if (oracle.outcome === "tool-error") {
    return { ...base, verdict: "TOOL_ERROR", code: "CITATION_GIT_TOOL_ERROR", message: `커밋 실존성/저자 확인 중 도구/레포 오류(status=${oracle.status}): ${oracle.stderr.trim()}` };
  }
  if (oracle.outcome !== "ok") {
    return { ...base, verdict: "FAIL", code: "CITATION_COMMIT_NOT_FOUND_IN_REPO", message: `git show 조회 실패 — 레포에 존재하지 않는 커밋 해시입니다(AC-8 가짜 해시 100% 탐지).` };
  }

  // (a)축 — 원장 존재 + excluded + authorEmail(원장 값이 아니라 위 오라클의
  // 실측 저자로 판정한다 — 원장 authorEmail을 3필드 편집으로 조작해도
  // 이 축은 뚫리지 않는다).
  const ledgerEntry = findLedgerEntry(evidence, ledgerId, sha);
  if (!ledgerEntry) {
    return { ...base, verdict: "FAIL", code: "CITATION_LEDGER_ENTRY_NOT_FOUND", message: "커밋은 레포에 실재하지만 원장(evidence.json)에는 없습니다(원장 외부 인용 또는 스테일 원장)." };
  }
  if (ledgerEntry.excluded === true) {
    return { ...base, verdict: "FAIL", code: "CITATION_EXCLUDED_COMMIT", message: `제외된 커밋을 인용했습니다(exclusionReason=${ledgerEntry.exclusionReason}).` };
  }
  if (ledgerEntry.authorEmail !== oracle.authorEmail) {
    return {
      ...base,
      verdict: "FAIL",
      code: "CITATION_LEDGER_AUTHOR_MISMATCH",
      message: `원장 authorEmail(${ledgerEntry.authorEmail})이 git이 보고하는 실제 저자(${oracle.authorEmail})와 다릅니다 — 원장이 편집되었거나 스테일합니다.`,
    };
  }
  if (!selectedIdentities.includes(oracle.authorEmail)) {
    return { ...base, verdict: "FAIL", code: "CITATION_AUTHOR_NOT_SELECTED", message: `저자(${oracle.authorEmail}, git 실측)가 현재 선택된 identity 집합에 없습니다(원장 excluded 플래그와 무관한 독립 검사 — 스테일 원장 방어).` };
  }

  // 머지 해시 규칙 — 판정 오라클은 원장 isMerge 플래그가 아니라 위에서
  // 얻은 실측 parents다(콜드 리뷰 M 대응 — isMerge 한 글자만 true→false로
  // 바꿔도 parents는 그대로 2건이면 예전에는 규칙이 통째로 꺼졌다.
  // isMergeCommit()이 scripts/lib/git.mjs의 유일한 정본 계산이므로 이제
  // 원장 isMerge 필드는 이 판정에 전혀 관여하지 않는다).
  // spec.md §2 원문: "머지 해시 인용은 basis: commit(정량 주장)의 근거로 쓸 수 없으며
  // inference만 허용한다"·AC-7: "머지 해시는 inference 근거로만 허용된다". "…만 허용한다"는
  // "commit만 금지"가 아니라 "inference 외 전부 금지"로 읽는 것이 문언과 일치한다 —
  // basis:commit만 막으면 nodeBasis가 external·insufficient·미지정(null)인 머지 해시 인용이
  // 전부 통과해 버리는데, 이 인용들도 여전히 "그 커밋이 뒷받침한다"는 근거 링크이고 스펙이
  // 허용을 예외적으로 열어준 것은 "추론"이라고 명시한 경우 하나뿐이다. 따라서 basis가
  // 정확히 "inference"일 때만 통과시키고 그 외 전부(commit·external·insufficient·null·
  // 오탈자 등)를 FAIL 처리한다.
  const isMergeReal = isMergeCommit(oracle.parents);
  if (isMergeReal && nodeBasis !== "inference") {
    return {
      ...base,
      verdict: "FAIL",
      code: "CITATION_MERGE_HASH_NON_INFERENCE_BASIS_FORBIDDEN",
      message: `머지 커밋 해시는 basis:inference 근거로만 인용할 수 있습니다(현재 basis='${nodeBasis}') — commit·external·insufficient·미지정을 포함한 inference 이외 전부 금지됩니다.`,
    };
  }

  // (c)축 — path가 있을 때만. (b)를 통과한 인용에만 호출(선검사 순서 고정).
  // parents/isMerge도 원장이 아니라 위 오라클 값을 쓴다(diff base가
  // 실측 parents에서 정확히 계산되게 한다).
  if (citationPath) {
    const diff = getCommitFileChangesCached(cache, repoPath, sha, oracle.parents, isMergeReal);
    if (diff.outcome === "tool-error") {
      return { ...base, verdict: "TOOL_ERROR", code: "CITATION_GIT_TOOL_ERROR", message: `경로 실존성(diff) 확인 중 도구/레포 오류(status 미상): ${diff.stderr.trim()}` };
    }
    if (diff.outcome !== "ok") {
      return { ...base, verdict: "FAIL", code: "CITATION_PATH_LOOKUP_FAILED", message: "커밋 diff 조회 실패로 경로 실존성을 확인할 수 없습니다." };
    }
    const found = diff.files.some((f) => f.path === citationPath || f.oldPath === citationPath);
    if (!found) {
      return { ...base, verdict: "FAIL", code: "CITATION_PATH_NOT_IN_DIFF", message: `경로 '${citationPath}'가 커밋 ${sha}의 diff(files[])에 등장하지 않습니다.` };
    }
  }

  return { ...base, verdict: "PASS", code: "CITATION_OK", message: "" };
}

// ---------------------------------------------------------------------------
// 옵트인 스니펫 인용 — changeType:D·oldPath에는 적용하지 않는다.
// ---------------------------------------------------------------------------

/**
 * 파일 내용 인용(옵트인 스니펫)의 경로 실존성을 `git cat-file -e <sha>:<path>`
 * 로 확인한다. 원장의 changeType이 D인 항목과 oldPath 계열에는 이 함수를
 * 적용하지 않는다(호출자 책임이 아니라 이 함수 자신이 판정한다 — 삭제 경로에
 * 대해 cat-file -e는 항상 128로 실패하는 자기모순이 있으므로).
 *
 * @param {object} opts
 * @param {string} opts.repoPath
 * @param {object} opts.evidence
 * @param {string} opts.ledgerId
 * @param {string} opts.snippetPath
 * @returns {{verdict: "PASS"|"FAIL"|"TOOL_ERROR"|"SKIPPED", code: string, message: string}}
 */
export function verifySnippetCitation({ repoPath, evidence, ledgerId, snippetPath }) {
  const sha = extractShaCandidate(ledgerId);
  if (!sha) {
    return { verdict: "FAIL", code: "CITATION_MALFORMED_LEDGER_ID", message: `ledgerId '${ledgerId}'에서 커밋 해시를 추출할 수 없습니다.` };
  }
  const ledgerEntry = findLedgerEntry(evidence, ledgerId, sha);
  if (!ledgerEntry) {
    return { verdict: "FAIL", code: "CITATION_LEDGER_ENTRY_NOT_FOUND", message: "커밋이 원장에 없습니다." };
  }

  const files = ledgerEntry.files ?? [];
  const isDeletedPath = files.some((f) => f.path === snippetPath && f.changeType === "D");
  const isOldPath = files.some((f) => f.oldPath === snippetPath);
  if (isDeletedPath || isOldPath) {
    return {
      verdict: "SKIPPED",
      code: "CITATION_SNIPPET_SKIPPED_DELETED_OR_OLDPATH",
      message: "changeType:D 항목 또는 oldPath에는 cat-file -e를 적용하지 않는다(스펙 명시 — 삭제 경로 자기모순 회피).",
    };
  }

  const result = catFileExists(repoPath, sha, snippetPath);
  if (result.outcome === "tool-error") {
    return { verdict: "TOOL_ERROR", code: "CITATION_SNIPPET_GIT_TOOL_ERROR", message: `cat-file -e 도구/레포 오류: ${result.stderr.trim()}` };
  }
  if (result.outcome !== "ok") {
    return { verdict: "FAIL", code: "CITATION_SNIPPET_PATH_NOT_FOUND", message: `경로 '${snippetPath}'가 커밋 ${sha}의 트리에 존재하지 않습니다(조회 실패 128 → 인용 FAIL 집계, 도구 오류 아님).` };
  }
  return { verdict: "PASS", code: "CITATION_OK", message: "" };
}

// ---------------------------------------------------------------------------
// 산출물 인스턴스 하나(career/knowledge-map/gap-report/plan) 순회
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.layer
 * @param {object} opts.instance 산출물 JSON(파싱됨)
 * @param {object} opts.evidence evidence.json 파싱 결과
 * @param {string} opts.repoPath
 * @param {string[]} opts.selectedIdentities
 * @param {object} [opts.cache] createVerificationCache()의 반환값(선택 —
 *   verifyEvidence()가 넘겨 여러 인용에 걸쳐 git 호출을 재사용한다).
 * @returns {{citations: object[]}} citations[]는 verifyCitation() 반환값 배열
 *   (layer/nodeId/citationIndex를 덧붙인 형태)
 */
export function verifyArtifactInstance({ layer, instance, evidence, repoPath, selectedIdentities, cache = createVerificationCache() }) {
  const citations = [];
  const nodes = instance?.nodes ?? [];
  for (const node of nodes) {
    const nodeEvidence = node.evidence ?? [];
    nodeEvidence.forEach((citation, idx) => {
      const result = verifyCitation({
        repoPath,
        evidence,
        selectedIdentities,
        ledgerId: citation.ledgerId,
        citationPath: citation.path ?? null,
        nodeBasis: node.basis ?? null,
        cache,
      });
      citations.push({ ...result, layer, nodeId: node.id, citationIndex: idx });
    });
  }
  return { citations };
}

// ---------------------------------------------------------------------------
// (e)축 — AC-7 집합 동치: 머지 커밋의 원장 files[] 집합 vs 검증기 diff 집합
// ---------------------------------------------------------------------------

/**
 * files[] 항목 하나를 식별하는 키. path/oldPath/changeType 3필드로 동일성을
 * 정의한다(insertions/deletions/binary/viaMerge는 이 3필드가 같으면 계약상
 * 항상 같은 값이 계산되므로 — scripts/lib/git.mjs getCommitFileChanges의
 * 단일 구현 — 집합 동치의 식별 키에는 넣지 않는다).
 *
 * @param {{path?: string, oldPath?: string|null, changeType?: string}} f
 * @returns {string}
 */
function fileChangeIdentityKey(f) {
  return JSON.stringify([f?.path ?? null, f?.oldPath ?? null, f?.changeType ?? null]);
}

/**
 * AC-7 「머지 커밋에 대해 원장 files[] 집합과 검증기 diff 집합이 동일함
 * (집합 동치)을 별도로 검사한다 — 불일치 시 FAIL. 이 검사는 머지 포함·
 * 제외 두 설정 모두에서 수행」의 구현. mergeIncluded 자체는 인자로 받지
 * 않는다 — collect-git-facts.mjs가 files[]를 mergeIncluded 값과 무관하게
 * 항상 1부모 diff로 채우므로(§2), 이 검사는 evidence.json 하나만으로
 * mergeIncluded 두 설정 모두에 대해 동일하게 성립해야 한다(호출자가
 * mergeIncluded:true/false로 각각 수집한 evidence.json을 이 함수에 따로
 * 넘겨 두 번 호출하면 두 설정 모두에서의 검사가 된다).
 *
 * 이 검사가 잡는 것: 원장 직렬화 누락·스테일 원장(원장의 files[]가 그
 * 커밋의 실제 diff와 어긋난 상태). 이 검사가 잡지 못하는 것: 원장과
 * 검증기가 scripts/lib/git.mjs를 공유하므로, 그 공유 구현 자체의 파싱
 * 버그(예: -z 리네임에서 oldPath를 버리는 버그)는 양쪽을 동일하게
 * 오염시켜 원리적으로 통과한다(이월 게이트 B-4/R6-Minor-2가 명시한
 * 한계) — 그 버그는 AC-17의 픽스처 선언값 직접 대조(골든·이 검사와
 * 독립한 오라클)가 담당한다.
 *
 * @param {object} opts
 * @param {string} opts.repoPath
 * @param {object} opts.evidence evidence.json 파싱 결과
 * @param {object} [opts.cache] createVerificationCache()의 반환값(선택 —
 *   verifyCitation()의 (c)축이 같은 머지 커밋 diff를 이미 계산했다면
 *   재사용해 낭비를 없앤다).
 * @returns {{hash: string, verdict: "PASS"|"FAIL"|"TOOL_ERROR", code: string,
 *   message: string, missingInLedger?: string[], extraInLedger?: string[]}[]}
 *   머지 커밋(정본은 `isMergeCommit(c.parents)` — 원장 `isMerge` 플래그
 *   단독으로는 이 판정을 우회할 수 없다. 콜드 리뷰 M 대응: `isMerge`만
 *   true→false로 바꿔도 `parents`가 그대로면 이 검사는 여전히 실행된다)
 *   마다 1건. 머지 커밋이 0건이면 빈 배열(공허 — 대다수 실행이 머지 없는
 *   정상 레포이므로 강제 FAIL로 만들지 않는다).
 */
export function verifyMergeFileSetEquivalence({ repoPath, evidence, cache = createVerificationCache() }) {
  const results = [];
  for (const c of evidence?.commits ?? []) {
    if (!isMergeCommit(c.parents ?? [])) continue;

    const diff = getCommitFileChangesCached(cache, repoPath, c.hash, c.parents ?? [], true);
    if (diff.outcome === "tool-error") {
      results.push({
        hash: c.hash,
        verdict: "TOOL_ERROR",
        code: "MERGE_FILESET_GIT_TOOL_ERROR",
        message: `머지 커밋 ${c.hash}의 diff 재계산 중 도구/레포 오류: ${diff.stderr.trim()}`,
      });
      continue;
    }
    if (diff.outcome !== "ok") {
      results.push({
        hash: c.hash,
        verdict: "FAIL",
        code: "MERGE_FILESET_DIFF_LOOKUP_FAILED",
        message: `머지 커밋 ${c.hash}의 diff 재계산 조회 실패 — 집합 동치를 확인할 수 없습니다.`,
      });
      continue;
    }

    const ledgerFiles = c.files ?? [];
    const ledgerKeys = new Set(ledgerFiles.map(fileChangeIdentityKey));
    const diffKeys = new Set(diff.files.map(fileChangeIdentityKey));
    const missingInLedger = diff.files
      .filter((f) => !ledgerKeys.has(fileChangeIdentityKey(f)))
      .map((f) => f.path);
    const extraInLedger = ledgerFiles
      .filter((f) => !diffKeys.has(fileChangeIdentityKey(f)))
      .map((f) => f.path);

    if (missingInLedger.length > 0 || extraInLedger.length > 0) {
      results.push({
        hash: c.hash,
        verdict: "FAIL",
        code: "MERGE_FILESET_SET_MISMATCH",
        missingInLedger,
        extraInLedger,
        message:
          `머지 커밋 ${c.hash}: 원장 files[](${ledgerFiles.length}건) 집합과 검증기 diff(${diff.files.length}건) 집합이 다릅니다 — ` +
          `검증기에는 있지만 원장에 없음: [${missingInLedger.join(", ")}], 원장에는 있지만 검증기 diff에 없음: [${extraInLedger.join(", ")}].`,
      });
    } else {
      results.push({ hash: c.hash, verdict: "PASS", code: "MERGE_FILESET_SET_EQUIVALENT", message: "" });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// (d)축 — 계층 ID 참조 무결성(단방향, 역참조 금지)
// ---------------------------------------------------------------------------

/**
 * @param {Record<string, object>} artifactsByLayer layer → 산출물 JSON(파싱됨)
 * @returns {{violations: object[], unverifiable: object[]}}
 *   violations: 상위 계층 산출물이 제공됐는데 parentRefs가 그 안에서
 *     해결되지 않는 경우(AC-14 "미해결 참조" — 인용 FAIL과 별도로 집계).
 *   unverifiable: 상위 계층 산출물 자체가 이번 호출에 제공되지 않아 검증할
 *     수 없는 경우(정보성 — 위반으로 세지 않는다. 단일 계층만 넘겨 검사하는
 *     정상적인 호출 패턴을 위반으로 오분류하지 않기 위함).
 */
export function checkLayerRefs(artifactsByLayer) {
  const violations = [];
  const unverifiable = [];
  const idSets = {};
  for (const [layer, instance] of Object.entries(artifactsByLayer)) {
    idSets[layer] = new Set((instance?.nodes ?? []).map((n) => n.id));
  }
  for (const [layer, instance] of Object.entries(artifactsByLayer)) {
    const parentLayer = LAYER_PARENT[layer];
    if (!parentLayer) continue;
    for (const node of instance?.nodes ?? []) {
      if (!Array.isArray(node.parentRefs)) continue;
      if (!(parentLayer in artifactsByLayer)) {
        unverifiable.push({ layer, nodeId: node.id, parentLayer, code: "LAYER_REF_PARENT_ARTIFACT_NOT_PROVIDED", message: `상위 계층(${parentLayer}) 산출물이 이번 호출에 제공되지 않아 parentRefs를 검증할 수 없습니다.` });
        continue;
      }
      for (const ref of node.parentRefs) {
        if (!idSets[parentLayer].has(ref)) {
          violations.push({ layer, nodeId: node.id, parentRef: ref, parentLayer, code: "LAYER_REF_UNRESOLVED", message: `parentRefs '${ref}'가 ${parentLayer}.json nodes[].id에 존재하지 않습니다.` });
        }
      }
    }
  }
  return { violations, unverifiable };
}

// ---------------------------------------------------------------------------
// 전체 오케스트레이션
// ---------------------------------------------------------------------------

/**
 * @param {object} opts
 * @param {string} opts.repoPath
 * @param {object} opts.evidence evidence.json 파싱 결과
 * @param {string[]} opts.selectedIdentities
 * @param {Record<string, object>} opts.artifactsByLayer layer → 산출물 JSON(파싱됨)
 * @param {object} [opts.cache] createVerificationCache()의 반환값(선택 —
 *   생략하면 이 호출 하나를 위한 캐시를 만들어 인용/머지 집합 검사가 같은
 *   (repoPath,sha)의 git 오라클 결과를 공유한다).
 * @returns {{
 *   ok: boolean,
 *   status: "PASS"|"FAIL"|"INCONCLUSIVE",
 *   summary: object,
 *   violations: object[],
 *   toolErrors: object[],
 *   layerRefViolations: object[],
 *   layerRefUnverifiable: object[],
 *   mergeFileSetViolations: object[],
 * }}
 */
/**
 * 콜드 리뷰 A-7 대응: evidence.json의 sourceRepoHead가 `--repo`의 현재
 * HEAD와 다르면 스테일 경고를 낸다. FAIL이 아니다 — 대상 레포에 새 커밋이
 * 쌓이는 것 자체는 정상이므로, 이 값은 "이 원장이 최신 HEAD를 반영하지
 * 않을 수 있다"는 정보일 뿐이다. git 조회가 실패하면(비-git 디렉터리 등)
 * checked:false로 보고하고 stale 여부를 판정하지 않는다 — verifyEvidence()의
 * hasFailures/hasUnverified(toolErrors) 집계에는 관여하지 않는 완전히
 * 별도의 정보성 필드다(toolErrorCitations 등 기존 카운트를 건드리지 않는다).
 *
 * @param {string} repoPath
 * @param {object} evidence
 * @returns {{checked: boolean, stale: boolean, currentHead: string|null, sourceRepoHead: string|null}}
 */
function checkSourceRepoHeadStale(repoPath, evidence) {
  const sourceRepoHead = evidence?.sourceRepoHead ?? null;
  const r = runGit(repoPath, ["rev-parse", "HEAD"]);
  if (r.outcome !== "ok") {
    return { checked: false, stale: false, currentHead: null, sourceRepoHead };
  }
  const currentHead = r.stdout.trim();
  return { checked: true, stale: sourceRepoHead !== currentHead, currentHead, sourceRepoHead };
}

// ---------------------------------------------------------------------------
// (f)축 — basis:"external" 노드의 출처 allow-list 대조
//   구현 8단계 (a) / 슬라이스 B 스펙 심사 M-1 / 착수 전 게이트 C-2
//
// **왜 이 축이 필요한가.** knowledge-map.schema.json의 `externalUrl`
// description은 "allow-list 대조는 스크립트가 런타임에 검사하며 이 스키마는
// 형식만 검사한다"고 **선언**하고 있었는데, 그 검사를 수행하는 코드가 레포
// 전체에 0곳이었다. 선언과 집행이 분리된 이 형태는 `redact.mjs`가 어디서도
// import되지 않는 죽은 코드였던 것(콜드 리뷰 A-9)과 같은 구조다 — 문서는
// 방어를 약속하는데 그 방어가 실재하지 않는다.
//
// 대조 규칙의 정본 서술은 `references/sources.json`의 `matchRule`에 있다.
// 아래 구현이 그 문장과 갈리면 코드가 아니라 그 문장을 먼저 고쳐라.
// ---------------------------------------------------------------------------

/**
 * allow-list 파일을 읽어 항목별 { origin, pathname } 목록으로 정규화한다.
 *
 * 반환의 `ok`가 false여도 **그 자체로는 위반이 아니다** — external 노드가
 * 0건이면 대조할 것이 없으므로 checkExternalSources가 이 실패를 무시한다.
 * external 노드가 1건이라도 있으면 그때 비로소 FAIL이 된다(fail-closed:
 * "검증할 수 없음"을 "통과"로 바꾸지 않는다).
 */
export function loadSourceAllowlist(sourcesPath = DEFAULT_SOURCES_PATH) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(sourcesPath, "utf8"));
  } catch (e) {
    return { ok: false, code: "EXTERNAL_ALLOWLIST_UNREADABLE", message: `allow-list를 읽을 수 없습니다(${sourcesPath}): ${e.message}`, entries: [] };
  }
  if (!Array.isArray(raw?.sources)) {
    return { ok: false, code: "EXTERNAL_ALLOWLIST_MALFORMED", message: `allow-list의 sources가 배열이 아닙니다(${sourcesPath}).`, entries: [] };
  }
  const entries = [];
  for (const s of raw.sources) {
    let u;
    try {
      u = new URL(s?.url);
    } catch {
      return { ok: false, code: "EXTERNAL_ALLOWLIST_MALFORMED", message: `allow-list 항목의 url이 URL로 파싱되지 않습니다: ${JSON.stringify(s?.url)}`, entries: [] };
    }
    if (u.protocol !== "https:") {
      return { ok: false, code: "EXTERNAL_ALLOWLIST_MALFORMED", message: `allow-list 항목이 https가 아닙니다: ${s.url}`, entries: [] };
    }
    entries.push({ origin: u.origin, pathname: u.pathname, url: s.url, label: s.label ?? null });
  }
  return { ok: true, code: null, message: "", entries };
}

/**
 * 후보 URL이 allow-list 항목 중 하나에 부합하는가.
 *
 * 규칙(references/sources.json의 matchRule과 동일해야 한다):
 *   (1) new URL()로 파싱될 것, (2) 프로토콜이 https:, (3) origin이 항목의
 *   origin과 **정확히 일치**, (4) pathname이 항목의 pathname으로 시작.
 *
 * 단순 문자열 prefix 대조를 쓰지 않는 이유는 호스트 연장 우회 때문이다 —
 * `https://developer.mozilla.org.evil.com/x`는 문자열로는
 * `https://developer.mozilla.org`로 시작하지만 origin이 다르다. origin 정확
 * 일치는 그 우회를 구조적으로 막는다(대소문자·기본 포트 정규화도 URL이
 * 처리한다).
 *
 * @returns {{allowed: boolean, code: string|null, message: string, matched: string|null}}
 */
export function matchesAllowlist(candidateUrl, entries) {
  let u;
  try {
    u = new URL(candidateUrl);
  } catch {
    return { allowed: false, code: "EXTERNAL_URL_MALFORMED", message: `externalUrl이 URL로 파싱되지 않습니다: ${JSON.stringify(candidateUrl)}`, matched: null };
  }
  if (u.protocol !== "https:") {
    return { allowed: false, code: "EXTERNAL_URL_MALFORMED", message: `externalUrl이 https가 아닙니다(${u.protocol} — 다운그레이드된 출처는 근거로 기록하지 않습니다): ${candidateUrl}`, matched: null };
  }
  for (const e of entries) {
    if (u.origin === e.origin && u.pathname.startsWith(e.pathname)) {
      return { allowed: true, code: null, message: "", matched: e.url };
    }
  }
  return {
    allowed: false,
    code: "EXTERNAL_URL_NOT_IN_ALLOWLIST",
    message: `externalUrl이 references/sources.json allow-list에 없습니다: ${candidateUrl}`,
    matched: null,
  };
}

/**
 * 모든 계층의 basis:"external" 노드에 대해 allow-list 대조를 수행한다.
 *
 * 반환: { violations, checked } — `checked`는 실제로 대조한 external 노드 수다.
 * 이 수치를 리포트에 내보내는 이유는 (e)축과 같다: external 노드가 0건이면
 * 위반도 0건인데, 그것이 "검사가 통과했다"인지 "검사할 것이 없었다"인지를
 * 숫자 없이는 구별할 수 없다.
 */
export function checkExternalSources(artifactsByLayer, allowlist) {
  const violations = [];
  let checked = 0;

  for (const [layer, instance] of Object.entries(artifactsByLayer)) {
    for (const node of instance?.nodes ?? []) {
      if (node?.basis !== "external") continue;
      checked += 1;

      // allow-list 자체를 못 읽었는데 대조 대상이 존재한다 — 여기서 비로소
      // 위반이 된다(external 노드가 0건이면 이 분기에 도달하지 않으므로
      // allow-list 부재가 무해한 경우와 구별된다).
      if (!allowlist.ok) {
        violations.push({ layer, nodeId: node.id, externalUrl: node.externalUrl ?? null, code: allowlist.code, message: allowlist.message });
        continue;
      }

      // externalUrl 자체가 없는 경우. knowledge-map 스키마는 조건절로
      // required를 걸지만, career/gap-report/plan 노드에는 externalUrl
      // 프로퍼티가 아예 없고 additionalProperties:false라 담을 자리조차
      // 없다 — 그 계층에서 basis:"external"을 선언하면 여기서 잡힌다.
      if (typeof node.externalUrl !== "string" || node.externalUrl === "") {
        violations.push({
          layer,
          nodeId: node.id,
          externalUrl: null,
          code: "EXTERNAL_URL_MISSING",
          message: `basis:"external"인데 externalUrl이 없습니다(이 계층 스키마에 externalUrl 프로퍼티가 존재하는지 확인하십시오).`,
        });
        continue;
      }

      const m = matchesAllowlist(node.externalUrl, allowlist.entries);
      if (!m.allowed) {
        violations.push({ layer, nodeId: node.id, externalUrl: node.externalUrl, code: m.code, message: m.message });
      }
    }
  }

  return { violations, checked };
}

export function verifyEvidence({ repoPath, evidence, selectedIdentities, artifactsByLayer, sourcesPath = DEFAULT_SOURCES_PATH, cache = createVerificationCache() }) {
  const allCitations = [];
  for (const [layer, instance] of Object.entries(artifactsByLayer)) {
    const { citations } = verifyArtifactInstance({ layer, instance, evidence, repoPath, selectedIdentities, cache });
    allCitations.push(...citations);
  }

  const violations = allCitations.filter((c) => c.verdict === "FAIL");
  const toolErrors = allCitations.filter((c) => c.verdict === "TOOL_ERROR");
  const passed = allCitations.filter((c) => c.verdict === "PASS");

  const { violations: layerRefViolations, unverifiable: layerRefUnverifiable } = checkLayerRefs(artifactsByLayer);

  // (e)축 — artifactsByLayer(인용)와 무관하게 evidence.json 자체에 대해
  // 항상 실행한다(머지 커밋이 0건이면 결과도 0건 — 공허하게 ok를 깨지
  // 않는다). mergeIncluded 두 설정 모두에서 수행하라는 AC-7 요구는
  // 호출자가 mergeIncluded:true/false 각각으로 수집한 evidence.json을
  // 넘겨 verifyEvidence를 두 번 호출하는 것으로 충족된다(files[]는 두
  // 설정 모두 동일하게 채워지므로 이 함수 자체는 mergeIncluded를 모른다).
  const mergeFileSetResults = verifyMergeFileSetEquivalence({ repoPath, evidence, cache });
  const mergeFileSetViolations = mergeFileSetResults.filter((r) => r.verdict === "FAIL");
  const mergeFileSetToolErrors = mergeFileSetResults.filter((r) => r.verdict === "TOOL_ERROR");

  const allToolErrors = [...toolErrors, ...mergeFileSetToolErrors];

  // 콜드 리뷰 A-7 대응: evidence.json 자체의 contentHash 재계산·대조는
  // artifactsByLayer(인용)와 무관하게 항상 실행한다((e)축과 같은 성격 —
  // evidence.json 하나만 있어도 성립하는 검사). sourceRepoHead 스테일
  // 여부는 별도로 계산해 정보성 필드로만 반환한다(hasFailures에 포함하지
  // 않는다 — 위 checkSourceRepoHeadStale 주석 참조).
  const contentHashViolations = checkContentHashInvariant(evidence);
  const sourceRepoHeadStaleness = checkSourceRepoHeadStale(repoPath, evidence);

  // (f)축 — allow-list 대조. allow-list 로드 실패는 external 노드가 1건이라도
  // 있을 때에만 위반이 된다(checkExternalSources 안에서 판단한다) — 여기서
  // 미리 실패시키면 external을 전혀 쓰지 않는 산출물까지 막힌다.
  const allowlist = loadSourceAllowlist(sourcesPath);
  const { violations: externalSourceViolations, checked: externalSourcesChecked } =
    checkExternalSources(artifactsByLayer, allowlist);

  // 콜드 리뷰 C4(Critical) 대응 — fail-open 제거. 이전에는 `ok`가
  // violations/layerRefViolations/mergeFileSetViolations 셋만 봤으므로
  // 인용 100%가 TOOL_ERROR(예: --repo 오타, git이 PATH에 없는 셸)여도
  // violations.length===0이라는 이유만으로 ok=true → "[PASS]" exit 0이
  // 나왔다(실측: 가짜 커밋 해시 인용이 도구 오류 뒤에 숨어 그대로 통과).
  // spec.md §2 "도구·레포 오류는 인용 FAIL로 집계하지 않는다"는 분류
  // 자체는 유지하되(hasFailures 산식에 toolErrors를 넣지 않는다), 검증되지
  // 않은 인용이 하나라도 있으면 PASS를 선언하지 않고 종료 코드도 성공이
  // 아니게 만든다 — status를 3분기로 나눈다:
  //   FAIL         — violations/layerRefViolations/mergeFileSetViolations 중
  //                  하나라도 있음(정본 판정 — 도구 오류가 섞여 있어도
  //                  우선한다. "검증 불가"보다 "확정된 위반 발견"이 더
  //                  강한 신호이므로 이걸 숨기지 않는다).
  //   INCONCLUSIVE — 정본 판정 위반은 0건이지만 toolErrors가 1건 이상 —
  //                  "검증 완료 못 함"을 PASS로 위장하지 않는다.
  //   PASS         — 위반 0건 + 도구 오류 0건(모든 인용·머지 집합 검사가
  //                  정상적으로 완결됨).
  const hasFailures =
    violations.length > 0 || layerRefViolations.length > 0 || mergeFileSetViolations.length > 0 ||
    contentHashViolations.length > 0 || externalSourceViolations.length > 0;

  // 게이트 C-5 / 심사 C-3 수정안 ③ — 「인용 0건 = PASS」 fail-open 제거.
  //
  // 위 C4 수정이 닫은 것은 "도구 오류로 검증을 못 했는데 PASS"였다. 남아
  // 있던 구멍은 그 이웃이다: **산출물이 로드됐는데 인용이 한 건도 없으면**
  // (a)(b)(c)축이 한 번도 집행되지 않았는데도 위반 0건·도구 오류 0건이
  // 성립해 PASS가 나왔다(실측: nodes를 []로 비운 career.json 하나로
  // `--schema-check`·`--lang-check`·이 검증기 3게이트를 모두 통과시켰다 —
  // 심사 C-3). nodes.minItems:1이 들어간 지금도 이 성질 자체는 남는다 —
  // 노드가 있어도 전부 evidence:[] + basis:insufficient면 인용은 0건이다.
  // 그 조합에서 "인용 무결성 검증 통과"를 선언하는 것은 거짓이 아니라
  // **공허**하고, 공허한 PASS는 호출자에게 참인 PASS와 구별되지 않는다.
  //
  // **경계를 좁게 잡는다** — 판정은 "인용 0건"이 아니라 "산출물이 1계층
  // 이상 로드됐는데 인용 0건"이다. artifactsByLayer가 비어 있는 호출은
  // (e)축·contentHash처럼 evidence.json 하나로 성립하는 검사만 요구한
  // 것이므로(이 함수는 그 두 검사를 artifactsByLayer와 무관하게 항상
  // 실행한다) 그 경우의 PASS는 공허하지 않다. 이 조건을 넓혀 무조건
  // "인용 0건 → INCONCLUSIVE"로 만들면 evidence 전용 호출이 전부
  // INCONCLUSIVE가 되어, 실제로는 완결된 검사가 미완결로 보고된다.
  //
  // **(f)축이 집행된 산출물은 여기 걸리지 않는다.** 초판은 조건을 "인용
  // 0건"으로만 썼는데, 그 판은 게이트 C-2의 대조군(노드 하나가
  // basis:"external" + 유효한 allow-list URL인 knowledge-map)을 즉시
  // INCONCLUSIVE로 뒤집었다 — 그 산출물에는 인용이 0건인 것이 정상이고
  // (L2·L3의 basis enum에는 commit이 없다) 대신 (f)축이 실제로 1건을
  // 대조했다. "집행된 검사가 있는데 없다고 보고"하는 것은 이 변경이
  // 없애려던 거짓 신호를 방향만 바꿔 재생산하는 것이므로, 조건에
  // externalSourcesChecked를 넣어 **어느 축도 집행되지 않았을 때만**
  // INCONCLUSIVE로 떨어뜨린다.
  //
  // **남은 약점(닫지 않았다).** 이 조건은 산출물 단위다 — 노드 100개 중
  // 99개가 evidence:[] + basis:insufficient이고 1개만 allow-list URL을
  // 가진 external이면 집행 1건이 성립해 PASS가 된다. 그 부분 커버리지는
  // summary의 totalCitations·externalSourcesChecked·artifactLayers 세
  // 수치로 노출되지만 종료 코드로는 구별되지 않는다. 노드 단위 커버리지
  // 판정은 AC-13의 '근거 부족 - 미검증' 배지(구현 7단계 렌더 계약)가
  // 담당할 영역이며 여기서 앞당기지 않는다.
  const artifactLayerCount = Object.keys(artifactsByLayer ?? {}).length;
  const noCitationsToVerify =
    artifactLayerCount > 0 && allCitations.length === 0 && externalSourcesChecked === 0;

  // INCONCLUSIVE의 사유를 코드로 남긴다 — 종료 코드 2 하나로는 "도구 오류로
  // 못 봤다"와 "볼 것이 없었다"가 구별되지 않고, 그 둘은 호출자가 취할
  // 조치가 다르다(전자는 --repo·git 환경, 후자는 산출물 생성 쪽 문제다).
  const inconclusiveReasons = [];
  if (allToolErrors.length > 0) {
    inconclusiveReasons.push({
      code: "CITATION_TOOL_ERRORS",
      message: `도구·레포 오류로 ${allToolErrors.length}건을 검증하지 못했습니다(인용 ${toolErrors.length}건 + 머지 집합 ${mergeFileSetToolErrors.length}건).`,
    });
  }
  if (noCitationsToVerify) {
    inconclusiveReasons.push({
      code: "NO_CITATIONS_TO_VERIFY",
      message: `산출물 ${artifactLayerCount}계층이 로드됐지만 검증할 인용이 0건이고 allow-list 대조 대상도 0건입니다 — 어떤 검증 축도 집행되지 않았으므로 PASS로 보고하지 않습니다.`,
    });
  }

  const hasUnverified = inconclusiveReasons.length > 0;
  const status = hasFailures ? "FAIL" : hasUnverified ? "INCONCLUSIVE" : "PASS";
  const ok = status === "PASS";

  return {
    ok,
    status,
    summary: {
      totalCitations: allCitations.length,
      // 게이트 C-5 — 인용 0건이 "통과"인지 "집행 대상이 없었음"인지를
      // 구별하려면 로드된 계층 수가 함께 있어야 한다((f)축의
      // externalSourcesChecked·(e)축의 mergeFileSetChecked와 같은 이유).
      artifactLayers: artifactLayerCount,
      passCitations: passed.length,
      failCitations: violations.length,
      toolErrorCitations: toolErrors.length,
      // 콜드 리뷰 C4 대응: "검증 완료 N건 / 미검증 M건"을 명시 보고한다.
      // verifiedCitations는 PASS 또는 FAIL로 확정 판정된 인용(=git 조회가
      // 실제로 완결된 것), unverifiedCitations는 도구 오류로 판정 자체를
      // 못 내린 인용이다.
      verifiedCitations: passed.length + violations.length,
      unverifiedCitations: toolErrors.length,
      layerRefTotal: layerRefViolations.length + layerRefUnverifiable.length,
      layerRefUnresolved: layerRefViolations.length,
      layerRefUnverifiable: layerRefUnverifiable.length,
      mergeFileSetChecked: mergeFileSetResults.length,
      mergeFileSetViolations: mergeFileSetViolations.length,
      mergeFileSetToolErrors: mergeFileSetToolErrors.length,
      // 콜드 리뷰 A-7 대응.
      contentHashViolations: contentHashViolations.length,
      // (f)축. checked를 함께 내보내는 이유는 (e)축과 같다 — 위반 0건이
      // "통과"인지 "검사 대상이 0건이었음"인지를 숫자 없이는 구별할 수 없다.
      externalSourcesChecked,
      externalSourceViolations: externalSourceViolations.length,
    },
    violations,
    inconclusiveReasons,
    toolErrors: allToolErrors,
    layerRefViolations,
    layerRefUnverifiable,
    mergeFileSetViolations,
    contentHashViolations,
    externalSourceViolations,
    sourceRepoHeadStaleness,
  };
}

/**
 * status → CLI 종료 코드(콜드 리뷰 C4 대응 — 3분기 계약을 한 곳에 고정한다).
 * PASS=0(검증 통과) / FAIL=1(확정된 위반 발견) / INCONCLUSIVE=2(도구·레포
 * 오류로 일부 인용을 검증하지 못함 — 성공도 실패도 아니므로 0을 반환하지
 * 않는다. --repo/--evidence 누락 등 CLI 인자 오류도 별도로 exit 2를 쓰므로
 * "결론을 낼 수 없음"이라는 같은 종료 코드 계열을 공유한다).
 *
 * @param {{status: "PASS"|"FAIL"|"INCONCLUSIVE"}} report
 * @returns {0|1|2}
 */
export function exitCodeForReport(report) {
  if (report.status === "FAIL") return 1;
  if (report.status === "INCONCLUSIVE") return 2;
  return 0;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/**
 * CLI 입력 JSON 하나를 읽는다. 콜드 리뷰 A-32 대응.
 *
 * 예전에는 `JSON.parse(fs.readFileSync(...))` 한 줄이라 파일이 없거나
 * JSON이 깨졌을 때 **raw Node 스택 트레이스 + exit 1**이 나왔다. 그 exit 1은
 * 이 도구의 정본 계약(1 = 확정된 인용 위반 발견)과 같은 코드여서, 호출자가
 * 종료 코드만 보면 "검증했더니 위반이 있었다"와 "입력 파일 경로를 잘못
 * 줬다"가 구별되지 않았다. 게다가 JSON 파싱 오류 메시지는 파일명을 담지
 * 않아 --artifact를 여러 개 넘긴 실행에서 어느 파일이 깨졌는지 알 수 없었다.
 *
 * 입력 오류는 "결론을 낼 수 없음" 계열이므로 usage 오류·INCONCLUSIVE와 같은
 * **exit 2**를 쓴다(exitCodeForReport의 3분기 계약과 통일).
 */
function readJson(p) {
  let text;
  try {
    text = fs.readFileSync(p, "utf8");
  } catch (e) {
    console.error(`[INPUT_ERROR] 입력 파일을 읽을 수 없습니다: ${p} (${e.code ?? e.message})`);
    process.exit(2);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    console.error(`[INPUT_ERROR] JSON 파싱 실패: ${p} — ${e.message}`);
    process.exit(2);
  }
}

function parseArgs(argv) {
  const opts = {
    repo: null,
    evidencePath: null,
    configPath: null,
    identities: [],
    artifactSpecs: [], // {layer, path}
    outDir: null,
    outPath: null,
    sourcesPath: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--repo":
        opts.repo = argv[++i];
        break;
      case "--evidence":
        opts.evidencePath = argv[++i];
        break;
      case "--config":
        opts.configPath = argv[++i];
        break;
      case "--identity":
        opts.identities.push(argv[++i]);
        break;
      case "--artifact": {
        const spec = argv[++i];
        const eq = spec.indexOf("=");
        if (eq === -1) {
          console.error(`[오류] --artifact는 <layer>=<path> 형태여야 합니다: '${spec}'`);
          process.exit(2);
        }
        const layer = spec.slice(0, eq);
        const p = spec.slice(eq + 1);
        if (!KNOWN_LAYERS.includes(layer)) {
          console.error(`[오류] 알 수 없는 layer '${layer}' (career|knowledge-map|gap-report|plan 중 하나여야 함)`);
          process.exit(2);
        }
        opts.artifactSpecs.push({ layer, path: p });
        break;
      }
      case "--out-dir":
        opts.outDir = argv[++i];
        break;
      case "--out":
        opts.outPath = argv[++i];
        break;
      case "--sources":
        opts.sourcesPath = argv[++i];
        break;
      default:
        console.error(`[경고] 알 수 없는 인자 무시: ${a}`);
    }
  }
  return opts;
}

function printUsage() {
  console.error(
    "사용법: node scripts/verify-evidence.mjs --repo <path> --evidence <evidence.json> " +
    "[--config <config.json>] [--identity <email>]... " +
    "(--artifact <layer>=<path>)... | --out-dir <dir> [--out <path>] [--sources <sources.json>]"
  );
}

function loadArtifactsByLayer(opts) {
  const artifactsByLayer = {};
  for (const { layer, path: p } of opts.artifactSpecs) {
    artifactsByLayer[layer] = readJson(p);
  }
  if (opts.outDir) {
    for (const layer of KNOWN_LAYERS) {
      if (layer in artifactsByLayer) continue;
      const p = path.join(opts.outDir, `${layer}.json`);
      if (fs.existsSync(p)) artifactsByLayer[layer] = readJson(p);
    }
  }
  return artifactsByLayer;
}

function printReport(report) {
  console.log(
    `[verify-evidence] citations: total=${report.summary.totalCitations} pass=${report.summary.passCitations} ` +
    `fail=${report.summary.failCitations} toolError=${report.summary.toolErrorCitations}`
  );
  // 콜드 리뷰 C4 대응: "검증 완료 N건 / 미검증 M건"을 항상 명시 출력한다
  // (M>0이면 아래 status 줄이 [PASS]가 아니라 [INCONCLUSIVE](또는
  // [FAIL])로 나오지만, 그 이유를 이 줄이 숫자로 먼저 보여준다).
  console.log(
    `[verify-evidence] 검증 완료: ${report.summary.verifiedCitations}건 / 미검증(도구 오류): ${report.summary.unverifiedCitations}건`
  );
  console.log(
    `[verify-evidence] layerRefs: unresolved=${report.summary.layerRefUnresolved} unverifiable=${report.summary.layerRefUnverifiable}`
  );
  console.log(
    `[verify-evidence] mergeFileSet: checked=${report.summary.mergeFileSetChecked} violations=${report.summary.mergeFileSetViolations} ` +
    `toolError=${report.summary.mergeFileSetToolErrors}`
  );
  console.log(
    `[verify-evidence] externalSources: checked=${report.summary.externalSourcesChecked} violations=${report.summary.externalSourceViolations}`
  );
  // 콜드 리뷰 A-7 대응.
  for (const v of report.contentHashViolations ?? []) {
    console.error(`[FAIL] ${v.code}: ${v.message}`);
  }
  for (const v of report.externalSourceViolations ?? []) {
    console.error(`[FAIL] ${v.code} (${v.layer}#${v.nodeId}): ${v.message}`);
  }
  const staleness = report.sourceRepoHeadStaleness;
  if (staleness?.checked && staleness.stale) {
    console.error(
      `[경고] sourceRepoHead 스테일: evidence.json은 ${staleness.sourceRepoHead}에서 생성됐지만 --repo의 현재 ` +
      `HEAD는 ${staleness.currentHead}입니다 — 원장이 최신 커밋을 반영하지 않을 수 있습니다(FAIL 아님, 재수집을 권장합니다).`
    );
  }
  for (const v of report.violations) {
    console.error(`[FAIL] ${v.code} (${v.layer}#${v.nodeId}[${v.citationIndex}] ledgerId=${v.ledgerId}): ${v.message}`);
  }
  for (const v of report.layerRefViolations) {
    console.error(`[FAIL] ${v.code} (${v.layer}#${v.nodeId} → ${v.parentLayer}): ${v.message}`);
  }
  for (const v of report.mergeFileSetViolations) {
    console.error(`[FAIL] ${v.code} (merge commit ${v.hash}): ${v.message}`);
  }
  if (report.toolErrors.length > 0) {
    console.error(`--- 도구·레포 오류(${report.toolErrors.length}건, 인용 FAIL 미집계) ---`);
    for (const e of report.toolErrors) {
      const label = "hash" in e ? `merge commit ${e.hash}` : `${e.layer}#${e.nodeId}[${e.citationIndex}] ledgerId=${e.ledgerId}`;
      console.error(`[TOOL_ERROR] ${e.code} (${label}): ${e.message}`);
    }
  }
  if (report.layerRefUnverifiable.length > 0) {
    console.error(`--- parentRefs 검증 불가(상위 산출물 미제공, ${report.layerRefUnverifiable.length}건) ---`);
    for (const e of report.layerRefUnverifiable) {
      console.error(`[UNVERIFIABLE] ${e.code} (${e.layer}#${e.nodeId} → ${e.parentLayer}): ${e.message}`);
    }
  }
  // 콜드 리뷰 C4(Critical) 대응 — fail-open 제거의 가시적 지점. 이전에는
  // report.ok가 violations 셋만 반영해 도구 오류로 100% 미검증인 경우도
  // "[PASS] verify-evidence" + exit 0이 나왔다. 이제 report.status가
  // INCONCLUSIVE이면 절대 [PASS]를 출력하지 않는다 — 위 "검증 완료 N건 /
  // 미검증 M건" 줄과 함께 호출자가 종료 코드만 보고 "통과"로 오인할 수
  // 없게 한다.
  if (report.status === "PASS") {
    console.log("[PASS] verify-evidence");
  } else if (report.status === "INCONCLUSIVE") {
    // 게이트 C-5 — 사유를 코드와 함께 찍는다. 예전에는 이 줄이 도구 오류
    // 하나만 가정하고 문구를 고정했는데, 이제 "볼 것이 없었다"
    // (NO_CITATIONS_TO_VERIFY)도 같은 exit 2로 오므로 그 둘이 출력에서
    // 구별되지 않으면 호출자가 엉뚱한 곳을 고치게 된다.
    console.log("[INCONCLUSIVE] verify-evidence — 확정된 위반은 없지만 검증을 완결하지 못했습니다(PASS 아님, exit 2).");
    for (const r of report.inconclusiveReasons ?? []) {
      console.error(`[INCONCLUSIVE] ${r.code}: ${r.message}`);
    }
  } else {
    console.log("[FAIL] verify-evidence");
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (!opts.repo || !opts.evidencePath) {
    printUsage();
    process.exit(2);
  }
  if (opts.artifactSpecs.length === 0 && !opts.outDir) {
    console.error("[오류] --artifact를 최소 1개 지정하거나 --out-dir을 지정하십시오.");
    printUsage();
    process.exit(2);
  }

  const evidence = readJson(opts.evidencePath);

  let selectedIdentities = [...opts.identities];
  if (opts.configPath) {
    const config = readJson(opts.configPath);
    selectedIdentities = [...new Set([...selectedIdentities, ...(config.identitySelection?.selected ?? [])])];
  }
  if (selectedIdentities.length === 0) {
    console.error("[오류] selectedIdentities가 비어 있습니다 — --config 또는 --identity로 지정하십시오.");
    process.exit(2);
  }

  const artifactsByLayer = loadArtifactsByLayer(opts);
  if (Object.keys(artifactsByLayer).length === 0) {
    console.error("[오류] 검증할 산출물이 하나도 로드되지 않았습니다.");
    process.exit(2);
  }

  // 콜드 리뷰 C1 대응(방어 4): getCommitFileChanges 자체는 이제 파싱
  // 예외를 삼켜 {outcome:"tool-error"}로 변환하므로(scripts/lib/git.mjs)
  // 이 경로로는 더 이상 예외가 올라오지 않지만, 예상치 못한 다른 런타임
  // 오류(예: evidence.json/artifact JSON의 형태가 극단적으로 어긋나
  // verifyArtifactInstance 내부에서 TypeError가 나는 경우)까지 미처리
  // 예외 스택 트레이스로 죽지 않도록 최상위에도 방어선을 둔다 — 이전에는
  // 이 지점에 어떤 try/catch도 없어 리포트 0줄·--out 파일 미기록으로
  // 죽었다. 여기서는 프로그램 버그로 취급해 exit 1을 쓴다(이 자리에서
  // "미처리 예외"와 "확정된 인용 FAIL"이 같은 exit 1을 공유하는 문제는
  // 이번 라운드 수정 대상이 아니다 — 콜드 리뷰 C4가 지목한 것은 fail-open
  // (도구 오류가 PASS로 위장되는 것)이며, 그 문제는 아래 exitCodeForReport의
  // status:"INCONCLUSIVE"→exit 2 분기로 닫힌다).
  let report;
  try {
    report = verifyEvidence({
      repoPath: opts.repo,
      evidence,
      selectedIdentities,
      artifactsByLayer,
      sourcesPath: opts.sourcesPath ?? DEFAULT_SOURCES_PATH,
    });
  } catch (e) {
    console.error(`[오류] 검증 실패(미처리 예외 — 버그로 취급): ${e.message}`);
    process.exit(1);
  }
  printReport(report);

  if (opts.outPath) {
    fs.writeFileSync(opts.outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(`[verify-evidence] 리포트 기록: ${opts.outPath}`);
  }

  process.exit(exitCodeForReport(report));
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
