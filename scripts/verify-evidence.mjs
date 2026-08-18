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
//   (a) 저자 대조 — 인용된 커밋이 원장에 존재하며 excluded !== true 이고
//       authorEmail이 config가 저장한 선택 identity 집합에 속하는가.
//       excluded 플래그는 "수집 시점" 판정이고 selectedIdentities는
//       "검증 시점" 값이므로 둘을 독립적으로 검사한다(원장 스테일 방어).
//   (b) `git rev-parse --verify --quiet <sha>^{commit}` 커밋 실존성.
//       (a)축 원장 조회와 무관하게 항상 독립 실행한다 — 원장 포맷을
//       흉내낸 가짜 해시(원장에 없는 40자 hex)를 이 축이 잡는다.
//   (c) 경로 실존성 — 커밋 트리(<sha>:<path>)가 아니라 그 커밋의 diff
//       (scripts/lib/git.mjs getCommitFileChanges, 수집기와 동일 구현)에
//       그 경로가 등장하는가. (b)를 통과한 인용에만 호출한다.
//   머지 해시 규칙 — 판정은 원장의 isMerge 필드만으로 하며(추가 git 호출
//       없음 — 이월 게이트 C-3), basis:inference 이외 전부(commit·
//       external·insufficient·미지정 포함) FAIL — "inference만 허용"의
//       문언대로 상보 조건으로 집행한다.
//   (e) AC-7 집합 동치 — 머지 커밋에 대해 원장 files[] 집합과 검증기가
//       scripts/lib/git.mjs getCommitFileChanges로 재계산한 diff 집합이
//       동일한가. mergeIncluded 설정과 무관하게 evidence.json 하나로
//       성립한다(files[]는 두 설정 모두 1부모 diff로 채워지므로) —
//       verifyMergeFileSetEquivalence()가 담당하며 verifyEvidence()가
//       artifactsByLayer와 무관하게 항상 함께 실행한다.
//   (d) 계층 ID 참조 무결성 — knowledge-map→career, gap-report→
//       knowledge-map, plan→gap-report 방향으로만 parentRefs를 확인한다
//       (역참조 없음, 단방향 6계층).
//
// 도구·레포 오류(3분류의 "tool-error")는 인용 FAIL로 집계하지 않고
// 별도 섹션(toolErrors)에 보고한다. 옵트인 스니펫 인용(파일 내용 인용)은
// 메인 (a)(b)(c) 축과 별도로 verifySnippetCitation()이 담당하며,
// changeType:D 항목과 oldPath에는 적용하지 않는다(git cat-file -e가
// 삭제 경로에서 항상 128로 실패하는 자기모순 회피 — spec.md 배경 §).
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
// 종료 코드: 인용 FAIL, 미해결 parentRefs, (e)축 머지 집합 동치 위반 중
// 하나라도 있으면 exit 1, 없으면 exit 0(도구 오류만 있는 경우도 exit 0 —
// 그 사실은 출력/리포트에 남는다).
//
// 프로그래밍 API: verifyCitation / verifySnippetCitation / verifyArtifactInstance /
// verifyMergeFileSetEquivalence / checkLayerRefs / verifyEvidence — 순수
// 함수(디스크에 쓰지 않음). CLI는 이 함수들을 호출하고 결과를 출력·파일
// 기록만 담당한다.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  revParseVerifyCommit,
  getCommitFileChanges,
  catFileExists,
} from "./lib/git.mjs";

const LEDGER_ID_RE = /^commit:([0-9a-f]{40})$/;
const RAW_HASH_RE = /^[0-9a-f]{40}$/;

const LAYER_PARENT = {
  "knowledge-map": "career",
  "gap-report": "knowledge-map",
  "plan": "gap-report",
};

const KNOWN_LAYERS = ["career", "knowledge-map", "gap-report", "plan"];

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
 * @returns {{verdict: "PASS"|"FAIL"|"TOOL_ERROR", code: string, message: string,
 *   ledgerId: string, sha: string|null, path: string|null}}
 */
export function verifyCitation({ repoPath, evidence, selectedIdentities, ledgerId, citationPath = null, nodeBasis = null }) {
  const base = { ledgerId, path: citationPath, sha: null };

  const sha = extractShaCandidate(ledgerId);
  if (!sha) {
    return { ...base, verdict: "FAIL", code: "CITATION_MALFORMED_LEDGER_ID", message: `ledgerId '${ledgerId}'에서 커밋 해시를 추출할 수 없습니다.` };
  }
  base.sha = sha;

  // (b)축 — 원장 조회와 무관하게 항상 독립 실행(가짜 해시를 여기서 잡는다).
  const bResult = revParseVerifyCommit(repoPath, sha);
  if (bResult.outcome === "tool-error") {
    return { ...base, verdict: "TOOL_ERROR", code: "CITATION_GIT_TOOL_ERROR", message: `커밋 실존성 확인 중 도구/레포 오류(status=${bResult.status}): ${bResult.stderr.trim()}` };
  }
  if (bResult.outcome !== "ok") {
    return { ...base, verdict: "FAIL", code: "CITATION_COMMIT_NOT_FOUND_IN_REPO", message: `git rev-parse --verify --quiet 실패 — 레포에 존재하지 않는 커밋 해시입니다(AC-8 가짜 해시 100% 탐지).` };
  }

  // (a)축 — 원장 존재 + excluded + authorEmail.
  const ledgerEntry = findLedgerEntry(evidence, ledgerId, sha);
  if (!ledgerEntry) {
    return { ...base, verdict: "FAIL", code: "CITATION_LEDGER_ENTRY_NOT_FOUND", message: "커밋은 레포에 실재하지만 원장(evidence.json)에는 없습니다(원장 외부 인용 또는 스테일 원장)." };
  }
  if (ledgerEntry.excluded === true) {
    return { ...base, verdict: "FAIL", code: "CITATION_EXCLUDED_COMMIT", message: `제외된 커밋을 인용했습니다(exclusionReason=${ledgerEntry.exclusionReason}).` };
  }
  if (!selectedIdentities.includes(ledgerEntry.authorEmail)) {
    return { ...base, verdict: "FAIL", code: "CITATION_AUTHOR_NOT_SELECTED", message: `저자(${ledgerEntry.authorEmail})가 현재 선택된 identity 집합에 없습니다(원장 excluded 플래그와 무관한 독립 검사 — 스테일 원장 방어).` };
  }

  // 머지 해시 규칙 — 판정 오라클은 원장 isMerge 하나뿐(추가 git 호출 없음, 이월 게이트 C-3).
  // spec.md §2 원문: "머지 해시 인용은 basis: commit(정량 주장)의 근거로 쓸 수 없으며
  // inference만 허용한다"·AC-7: "머지 해시는 inference 근거로만 허용된다". "…만 허용한다"는
  // "commit만 금지"가 아니라 "inference 외 전부 금지"로 읽는 것이 문언과 일치한다 —
  // basis:commit만 막으면 nodeBasis가 external·insufficient·미지정(null)인 머지 해시 인용이
  // 전부 통과해 버리는데, 이 인용들도 여전히 "그 커밋이 뒷받침한다"는 근거 링크이고 스펙이
  // 허용을 예외적으로 열어준 것은 "추론"이라고 명시한 경우 하나뿐이다. 따라서 basis가
  // 정확히 "inference"일 때만 통과시키고 그 외 전부(commit·external·insufficient·null·
  // 오탈자 등)를 FAIL 처리한다.
  if (ledgerEntry.isMerge === true && nodeBasis !== "inference") {
    return {
      ...base,
      verdict: "FAIL",
      code: "CITATION_MERGE_HASH_NON_INFERENCE_BASIS_FORBIDDEN",
      message: `머지 커밋 해시는 basis:inference 근거로만 인용할 수 있습니다(현재 basis='${nodeBasis}') — commit·external·insufficient·미지정을 포함한 inference 이외 전부 금지됩니다.`,
    };
  }

  // (c)축 — path가 있을 때만. (b)를 통과한 인용에만 호출(선검사 순서 고정).
  if (citationPath) {
    const diff = getCommitFileChanges(repoPath, sha, ledgerEntry.parents, ledgerEntry.isMerge);
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
 * @returns {{citations: object[]}} citations[]는 verifyCitation() 반환값 배열
 *   (layer/nodeId/citationIndex를 덧붙인 형태)
 */
export function verifyArtifactInstance({ layer, instance, evidence, repoPath, selectedIdentities }) {
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
 * @returns {{hash: string, verdict: "PASS"|"FAIL"|"TOOL_ERROR", code: string,
 *   message: string, missingInLedger?: string[], extraInLedger?: string[]}[]}
 *   isMerge===true인 커밋마다 1건. 머지 커밋이 0건이면 빈 배열(공허 —
 *   대다수 실행이 머지 없는 정상 레포이므로 강제 FAIL로 만들지 않는다).
 */
export function verifyMergeFileSetEquivalence({ repoPath, evidence }) {
  const results = [];
  for (const c of evidence?.commits ?? []) {
    if (c.isMerge !== true) continue;

    const diff = getCommitFileChanges(repoPath, c.hash, c.parents ?? [], true);
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
 * @returns {{
 *   ok: boolean,
 *   summary: object,
 *   violations: object[],
 *   toolErrors: object[],
 *   layerRefViolations: object[],
 *   layerRefUnverifiable: object[],
 *   mergeFileSetViolations: object[],
 * }}
 */
export function verifyEvidence({ repoPath, evidence, selectedIdentities, artifactsByLayer }) {
  const allCitations = [];
  for (const [layer, instance] of Object.entries(artifactsByLayer)) {
    const { citations } = verifyArtifactInstance({ layer, instance, evidence, repoPath, selectedIdentities });
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
  const mergeFileSetResults = verifyMergeFileSetEquivalence({ repoPath, evidence });
  const mergeFileSetViolations = mergeFileSetResults.filter((r) => r.verdict === "FAIL");
  const mergeFileSetToolErrors = mergeFileSetResults.filter((r) => r.verdict === "TOOL_ERROR");

  const ok = violations.length === 0 && layerRefViolations.length === 0 && mergeFileSetViolations.length === 0;

  return {
    ok,
    summary: {
      totalCitations: allCitations.length,
      passCitations: passed.length,
      failCitations: violations.length,
      toolErrorCitations: toolErrors.length,
      layerRefTotal: layerRefViolations.length + layerRefUnverifiable.length,
      layerRefUnresolved: layerRefViolations.length,
      layerRefUnverifiable: layerRefUnverifiable.length,
      mergeFileSetChecked: mergeFileSetResults.length,
      mergeFileSetViolations: mergeFileSetViolations.length,
    },
    violations,
    toolErrors: [...toolErrors, ...mergeFileSetToolErrors],
    layerRefViolations,
    layerRefUnverifiable,
    mergeFileSetViolations,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
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
    "(--artifact <layer>=<path>)... | --out-dir <dir> [--out <path>]"
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
  console.log(
    `[verify-evidence] layerRefs: unresolved=${report.summary.layerRefUnresolved} unverifiable=${report.summary.layerRefUnverifiable}`
  );
  console.log(
    `[verify-evidence] mergeFileSet: checked=${report.summary.mergeFileSetChecked} violations=${report.summary.mergeFileSetViolations}`
  );
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
  console.log(report.ok ? "[PASS] verify-evidence" : "[FAIL] verify-evidence");
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

  const report = verifyEvidence({ repoPath: opts.repo, evidence, selectedIdentities, artifactsByLayer });
  printReport(report);

  if (opts.outPath) {
    fs.writeFileSync(opts.outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(`[verify-evidence] 리포트 기록: ${opts.outPath}`);
  }

  process.exit(report.ok ? 0 : 1);
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
