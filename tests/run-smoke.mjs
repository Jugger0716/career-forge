#!/usr/bin/env node
// tests/run-smoke.mjs
//
// validate-plugin.mjs를 위한 스모크 러너. 의존성 0.
//
// 사용법:
//   node tests/run-smoke.mjs              기본 스모크: 공통 섹션(스키마
//                                          검증기·verify-evidence·불변식·
//                                          회귀 등 19개, 아래) 전부 + 정상
//                                          레포에서 exit 0 확인.
//   node tests/run-smoke.mjs --negative    negative 스위트만: tests/
//                                          fixtures-invalid/의 각 케이스가
//                                          exit 1 + 케이스 고유 오류 코드를
//                                          내는지, tests/fixtures-valid/의
//                                          positive 픽스처가 exit 0을
//                                          내는지 확인. 공통 섹션은 기본
//                                          모드가 이미 실행했다는 전제로
//                                          여기서는 재실행하지 않는다
//                                          (A-36 대응 — 이전에는 여기서도
//                                          공통 섹션 전체를 다시 돌려 동일
//                                          단언 172건이 두 모드에서 문자열
//                                          단위로 중복 실행됐다). 이 모드를
//                                          단독으로 돌리면 negative 스위트
//                                          고유의 단언만 보이므로, 전체
//                                          커버리지를 확인하려면 플래그
//                                          없이 먼저 한 번 돌려야 한다 —
//                                          package.json의 `npm test`는
//                                          기본 모드 → --negative →
//                                          --golden 순서로 세 번 호출해
//                                          이 순서를 강제한다.
//   node tests/run-smoke.mjs --golden      AC-21 골든 게이트만 단독 실행
//                                          (300커밋 픽스처 생성/캐시 +
//                                          fixtures/golden/sampling-300.
//                                          expected.json 대조 — 최초 1회
//                                          ~1분, 이후 캐시 재사용). 다른
//                                          모드와 배타적.
//
// 기본 모드는 실행 전 runSchemaValidatorSmoke()를 호출한다 — AC-6/AC-12의
// 게이트인 scripts/lib/schema-validate.mjs validateInstance가 (a) 실제
// 픽스처를 실제 스키마로 검증하고, (b) required/enum/type 위반을 실제로
// 잡고, (c) 지원 범위 밖 키워드를 조용히 통과시키지 않는지 확인한다.
//
// validate-plugin.mjs를 서브프로세스로 스폰하지 않고 그 함수(runValidation/
// runLangCheck)를 직접 import해서 호출한다 — 오류 코드 문자열 대조만 필요할 뿐
// 별도 프로세스 경계가 필요하지 않고, 이 편이 더 빠르고 실패 시 스택트레이스도
// 더 명확하다.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runValidation, runLangCheck, runSchemaCheck, runSecretScan } from "../scripts/validate-plugin.mjs";
import { scanForSecrets, collectEmailFormatPaths, isSingleEmail } from "../scripts/lib/secret-scan.mjs";
import { walk, listFilesByExt } from "../scripts/lib/fs-walk.mjs";
import { validateInstance } from "../scripts/lib/schema-validate.mjs";
import {
  EVIDENCE_BADGE,
  TRUNCATION_NOTICE_PREFIX,
  NO_TRUNCATION_NOTICE,
  UNKNOWN_TRUNCATION_NOTICE,
  formatTruncation,
  RENDER_REQUIRED_ELEMENTS,
  LAYER_FIELD_ELEMENTS,
} from "../scripts/lib/render-contract.mjs";
import { renderLayer } from "../scripts/render-markdown.mjs";
import {
  ARTIFACT_LAYERS,
  ARTIFACT_PARENT_LAYER,
  AUTHORSHIP_STAGES,
  checkAuthorshipContract,
  checkParentRefs,
  classifySchemaErrorsByProvenance,
  computeArtifactContentHash,
  mergeArtifact,
  VERIFICATION_LAYERS,
} from "../scripts/lib/artifact-contract.mjs";
import { projectWithReport, EVIDENCE_FILE_NAME } from "../scripts/project-ledger.mjs";
import {
  inspectPreviousArtifact,
  updateRegistry,
  loadSchema,
  EMPTY_REGISTRY_ARTIFACTS,
  STATE_SCHEMA_VERSION,
} from "../scripts/write-artifact.mjs";
import { CONFIG_SCHEMA_VERSION } from "../scripts/write-config.mjs";
import { KNOWN_SKILLS, NON_SKILL_PRODUCERS, KNOWN_ARTIFACT_PRODUCERS } from "../scripts/lib/artifact-contract.mjs";
import { checkRenderInput } from "../scripts/render-markdown.mjs";
import { CONFIG_FILE_NAME } from "../scripts/lib/store.mjs";
import {
  computeRepoKeyForPath,
  getRepoToplevel,
  writeJsonAtomic,
  toStorageRelative,
  fromStorageRelative,
  readState,
  writeState,
  readConfig,
  writeConfig,
  projectLedgerForSkills,
  PROJECTION_OMITTABLE_KEYS,
  PROJECTION_REQUIRED_KEYS,
  checkStorageBoundary,
  STATE_DIR_NAME,
  STATE_FILE_NAME,
} from "../scripts/lib/store.mjs";
import { collectGitFacts, _internal as collectorInternal } from "../scripts/collect-git-facts.mjs";
import { computeSampling, CANONICAL_SAMPLING_METHOD_LITERAL } from "../scripts/lib/sampling.mjs";
import {
  KNOWN_LAYERS,
  verifyCitation,
  verifySnippetCitation,
  verifyMergeFileSetEquivalence,
  checkLayerRefs,
  verifyEvidence,
  createVerificationCache,
  verificationCacheKey,
  exitCodeForReport,
  loadSourceAllowlist,
  checkExternalSources,
} from "../scripts/verify-evidence.mjs";
import {
  catFileExists,
  getCommitFileChanges,
  getCommitAuthorAndParents,
  listCommitMetadata,
  isShallowRepository,
  isMergeCommit,
  runGit,
  GIT_FIXED_PREFIX_ARGS,
  _internal as gitInternal,
} from "../scripts/lib/git.mjs";
import {
  checkEvidenceInvariants,
  checkTruncatedDroppedCommitsInvariant,
  checkMergeNonVacuous,
  checkContentHashInvariant,
} from "../scripts/lib/invariants.mjs";
import { computeEvidenceContentHash } from "../scripts/lib/content-hash.mjs";
import {
  checkSamplingMethodLiteralDrift,
  EVIDENCE_SCHEMA_REL,
  GOLDEN_SCRIPT_REL,
  SPEC_MD_REL,
} from "../scripts/lib/sampling-literal-drift.mjs";
import {
  OWNER_EMAIL,
  ALICE_EMAIL,
  buildMerge,
  buildRename,
  buildDelete,
  buildMultiAuthor,
  buildBotCommits,
  buildToolErrorNonGit,
  buildToolErrorCorrupted,
  buildOptInSnippet,
  buildLarge300,
  buildChurnKeyDivergence,
  buildCase17MergeHashInjection,
  buildSecretsInCommitMetadata,
  buildCoAuthorTrailer,
  buildVendoredPaths,
  buildBinaryFile,
  buildEmptyRepo,
  buildSingleCommit,
  buildKorean,
  buildSpacePath,
  buildEmptyMessage,
  FAKE_COMMIT_HASH_IN_SUBJECT,
} from "../fixtures/make-fixture.mjs";
import { redactSecrets, containsSecretPattern } from "../scripts/lib/redact.mjs";
import {
  CASE_KINDS,
  MACHINE_KINDS,
  OUTCOME,
  checkCaseShape,
  resolveSelector,
  gradeCitationCase,
  gradeSecretCase,
  tally,
  evaluateGate,
} from "./contamination/grade.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, "..");

// ---------------------------------------------------------------------------
// 레포 파일 안전 판독 — 부재를 예외가 아니라 각 단언의 FAIL로
// ---------------------------------------------------------------------------
//
// **왜 헬퍼를 하나로 두는가.** 이 파일은 같은 요구(「파일을 읽되 예외를 던지지 않고 실패 사유를
// 각 단언에 귀속시킨다」)를 세 곳에서 **서로 다른 자료구조로** 구현하고 있었다 — `{schema,error}`
// 객체 / `Map`+문자열 배열 / `Map`+`blameFor` 클로저. 콜드 리뷰가 그 3중 재구현을 지적했고,
// 세 곳 다 `catch`에서 `e.code ?? e.message`를 사유로 남기는 핵심은 동일했다. 판독과 사유 포맷만
// 여기로 모으고, **실패 정책은 각 호출부에 남긴다** — 전용 전제 단언(DH-1d) / 단언별 귀책 분배
// (blameFor) / 절 단위 강등은 서로 다른 것이 옳다.
//
// **경로를 리터럴 상수로 만들지 않는 이유.** `CAREER_SCHEMA_REL` 같은 상수 4개를 두면
// `runSchemaValidatorSmoke`와 `runSchemaClauseOracleSmoke`가 계층명으로 경로를 **조립**하므로
// 그 상수를 쓸 수 없다 — 최대 표면이 여전히 손으로 세그먼트를 적는 절반짜리 상수화가 된다.
// 조립 함수를 정본으로 두면 `SCHEMA_REL("state")`와 `SCHEMA_REL(layer)`가 한 메커니즘에 수렴한다.
//
// `EVIDENCE_SCHEMA_REL`(sampling-literal-drift.mjs export)은 `checkSamplingMethodLiteralDrift`의
// 결과 키와 **바이트 일치**해야 하므로 드리프트 가드 사용처에서는 그 상수를 계속 쓴다.
// 두 값은 같은 문자열이며, 그 밖의 스모크 내부 판독은 `SCHEMA_REL("evidence")`로 통일한다.

/** `schemas/<layer>.schema.json` 상대 경로. */
const SCHEMA_REL = (layer) => `schemas/${layer}.schema.json`;
/** `tests/fixtures-valid/<layer>.json` 상대 경로. */
const FIXTURE_VALID_REL = (layer) => `tests/fixtures-valid/${layer}.json`;

/**
 * 레포 파일 텍스트를 판독한다. **예외를 던지지 않는다.**
 *
 * **`root`를 인자로 받는다(2026-08-25).** 콜드 리뷰가 「경로 인자를 받게 설계하라 —
 * `loadEvidenceSchema()`는 `REPO_ROOT`를 모듈 스코프에서 직접 참조해 가짜 루트 주입이
 * 불가능하다」고 지적했고, 그 지적이 옳았다는 것이 아래 형태 게이트의 회귀 단언을 쓰려는
 * 순간 드러났다 — 루트를 못 바꾸면 **레포 안에 고장난 파일을 실제로 만들어야만** 그 게이트를
 * 관측할 수 있다. 기본값이 `REPO_ROOT`이므로 기존 호출부 전량은 그대로다.
 *
 * @param {string} rel 판독 루트 기준 상대 경로
 * @param {string} [root] 판독 루트. 기본값 `REPO_ROOT`
 * @returns {{text: string|null, error: string|null}}
 */
function readRepoTextSafe(rel, root = REPO_ROOT) {
  try {
    return { text: fs.readFileSync(path.join(root, rel), "utf8"), error: null };
  } catch (e) {
    return { text: null, error: `${rel} 판독 실패(${e.code ?? e.message})` };
  }
}

/**
 * 레포 JSON 파일을 판독한다. **예외를 던지지 않는다.**
 *
 * 판독 실패와 파싱 실패를 **사유 문자열에서 구별한다** — 어느 경로로 실패했는지가 로그에
 * 고정되어야 한다. `JSON.parse`의 `SyntaxError`에는 `e.code`가 없으므로 `e.message`로 떨어진다.
 *
 * **파싱 성공은 판독 성공이 아니다(2026-08-25). 이것이 세 번째 실패 경로다.**
 * 내용이 `null`·`false`·스칼라·배열인 파일은 `JSON.parse`를 **통과하고**, 그 값이 그대로
 * `validateInstance`에 넘어가면 `schema-validate.mjs`의 falsy·비객체 fail-open이
 * **오류 0건**을 돌려준다(직접 실행 확인: `null`·`false`·`123`·`"abc"`·`[]` 전부 오류 0건,
 * 경고조차 0건). 그 파일은 슬라이스 A 수정 금지 대상이라 근본 비대칭은 그대로 두고,
 * **부재·파싱실패와 같은 등급의 판독 실패로 여기서 강등한다.**
 *
 * **실측(격리 사본, `git clone --no-hardlinks` 후 대상 파일만 덮어씀).**
 * `schemas/career.schema.json`을 `null`로 바꾸면 433 PASS / 17 FAIL이면서
 * 「기준 인스턴스가 스키마에 적합함」류 단언 3건이 **거짓 초록**이었고, 그중 하나가
 * 「이게 깨지면 아래 절 단언이 전부 공허해진다」고 스스로 적어 둔 **대조군 자신**이다.
 * `schemas/evidence.schema.json`을 `false`로 바꾸면 A-13 적합성 단언 6건이 전부 거짓 초록이었다 —
 * 그 지점의 유일한 게이트가 `EVIDENCE_SCHEMA === null`인데 **`false === null`은 false**다.
 *
 * **형태 검사를 호출부가 아니라 여기 한 곳에 두는 이유.** 이 헬퍼의 호출부 18곳은 전부
 * 사유 문자열(`error !== null`)로 게이트하므로, 비객체를 사유로 강등하는 순간 18곳이 함께
 * 닫힌다. 호출부마다 `typeof` 검사를 복제하면 다음에 생길 19번째 호출부가 그것을 빠뜨린다 —
 * 이 파일이 판독 헬퍼를 하나로 모은 이유와 같다.
 *
 * **한계(감추지 않는다)**: 이 계약은 「이 헬퍼가 읽는 레포 JSON은 전부 객체다」에 기댄다
 * (착수 시 실측: 스키마 6 + `fixtures-valid` 3 + 골든 전량이 객체). 배열이나 스칼라를 담은
 * JSON을 읽어야 하는 호출부가 생기면 이 헬퍼를 완화하지 말고 그 용도의 판독을 따로 두어라 —
 * 완화하는 순간 위 거짓 초록 3+6건이 그대로 돌아온다.
 *
 * @param {string} rel 판독 루트 기준 상대 경로
 * @param {string} [root] 판독 루트. 기본값 `REPO_ROOT`
 * @returns {{json: object|null, error: string|null}}
 */
function readRepoJsonSafe(rel, root = REPO_ROOT) {
  const { text, error } = readRepoTextSafe(rel, root);
  if (text === null) return { json: null, error };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return { json: null, error: `${rel} JSON 파싱 실패(${e.message})` };
  }
  const shape = jsonShapeViolation(parsed);
  if (shape !== null) {
    return { json: null, error: `${rel} 내용이 객체가 아님(${shape}) — 스키마·픽스처는 객체여야 한다` };
  }
  return { json: parsed, error: null };
}

/**
 * 파싱된 JSON 값이 **평범한 객체가 아니면** 그 형태 이름을, 객체면 `null`을 돌려준다.
 *
 * 술어를 따로 빼 두는 이유는 회귀 단언이 파일 IO 없이 **판정 자체**를 관측할 수 있게 하려는
 * 것이다. 배선(파일 → 사유 문자열)은 가짜 루트로 따로 관측한다 — 둘 중 하나만 보면
 * 「술어는 맞는데 배선이 빠진」 상태가 조용히 통과한다.
 *
 * @param {unknown} parsed
 * @returns {string|null} `"null"` · `"array"` · `typeof` 결과, 또는 위반 없으면 `null`
 */
function jsonShapeViolation(parsed) {
  if (parsed === null) return "null";
  if (Array.isArray(parsed)) return "array";
  if (typeof parsed !== "object") return typeof parsed;
  return null;
}

/**
 * 여러 파일을 읽고 **파일별로** 귀책해야 하는 섹션 전용 트래커.
 *
 * 사유를 그 섹션의 단언 전량에 싣지 않기 위한 장치다 — 전량에 실으면 어느 파일이 없었는지가
 * 다시 뭉뚱그려져 「어느 경로로 실패했는가를 고정하라」를 반대쪽에서 어긴다. `blameFor(rels)`는
 * **인자로 준 파일 중 실제로 실패한 것만** 사유로 엮으므로, 그 파일에 의존하는 단언에만 실린다.
 *
 * `note(rel, msg)`는 판독은 성공했으나 **내용이 기대 형태가 아닌** 경우(예: 특정 키가 문자열이
 * 아님)를 같은 귀책 경로에 얹기 위한 것이다 — 그 실패도 예외가 아니라 사유다.
 *
 * @returns {{readText: (rel: string) => string|null, readJson: (rel: string) => object|null,
 *            note: (rel: string, msg: string) => void, blameFor: (rels: string[]) => string,
 *            failed: (rel: string) => boolean}}
 */
function makeReadTracker() {
  const failures = new Map();
  return {
    readText: (rel) => {
      const r = readRepoTextSafe(rel);
      if (r.error !== null) failures.set(rel, r.error);
      return r.text;
    },
    readJson: (rel) => {
      const r = readRepoJsonSafe(rel);
      if (r.error !== null) failures.set(rel, r.error);
      return r.json;
    },
    note: (rel, msg) => failures.set(rel, `${rel} ${msg}`),
    blameFor: (rels) => rels.filter((r) => failures.has(r)).map((r) => failures.get(r)).join(", "),
    failed: (rel) => failures.has(rel),
  };
}

// AC-4: "CR 픽스처가 .gitattributes 정규화로 CR을 잃지 않음을 러너가
// 사전 확인한다"는 요구. negative 루프를 돌리기 전에 케이스 (5) CR 혼입
// 픽스처의 워킹 트리 바이트를 직접 읽어 CR(0x0D)이 실제로 존재하는지
// 확인하고, 없으면(= .gitattributes -text 규칙이 깨졌거나 체크아웃 과정에서
// 정규화로 CR이 소실된 상태) 케이스 실행 전에 명확한 오류로 즉시 중단한다.
// 이 확인이 없으면 CR_IN_WORKING_TREE 케이스가 "CR이 없어서 우연히
// exit 0"으로 조용히 무의미해질 수 있다.
function preflightCrFixtureBytes() {
  const crCaseDir = path.join(TESTS_DIR, "fixtures-invalid", "05-cr-in-text");
  const files = walk(crCaseDir);
  if (files.length === 0) {
    throw new Error(
      `AC-4 사전 확인 실패: CR negative 픽스처 디렉터리가 비어 있습니다(${crCaseDir}). ` +
      `케이스 (5)를 실행하기 전에 중단합니다.`
    );
  }
  const hasCrByte = files.some((f) => {
    try {
      return fs.readFileSync(f).includes(0x0d);
    } catch {
      return false;
    }
  });
  if (!hasCrByte) {
    throw new Error(
      `AC-4 사전 확인 실패: ${crCaseDir} 아래 어떤 파일에도 CR(0x0D) 바이트가 없습니다. ` +
      `.gitattributes의 'tests/fixtures-invalid/** -text' 정규화 예외가 깨졌거나 체크아웃 시 ` +
      `CR이 소실된 것으로 보입니다 — 이 상태로는 케이스 (5)가 CR 가드를 관측할 수 없으므로 ` +
      `negative 스위트 실행 전에 중단합니다.`
    );
  }
  console.log(`  [사전 확인] AC-4: CR 픽스처(${path.relative(TESTS_DIR, crCaseDir)})에 CR 바이트 존재 확인 — OK`);
}

// 각 negative 케이스 디렉터리 ↔ 기대 오류 코드 ↔ 검사 모드.
// mode: 'plugin' → runValidation(explicitRoot:true)을 그 케이스 디렉터리에 대해 실행.
// mode: 'lang'   → runLangCheck를 그 케이스 디렉터리(=<out>)에 대해 실행.
const NEGATIVE_CASES = [
  { n: 1, dir: "01-missing-required-field", mode: "plugin", code: "PLUGIN_JSON_MISSING_FIELD", label: "필수 필드 누락 plugin.json" },
  { n: 2, dir: "02-skill-name-mismatch", mode: "plugin", code: "SKILL_NAME_DIR_MISMATCH", label: "name≠디렉터리 SKILL.md" },
  { n: 3, dir: "03-first-person-description", mode: "plugin", code: "SKILL_DESCRIPTION_FIRST_PERSON", label: "1인칭 description" },
  { n: 4, dir: "04-broken-schema-json", mode: "plugin", code: "SCHEMA_JSON_PARSE_ERROR", label: "깨진 JSON 스키마" },
  { n: 5, dir: "05-cr-in-text", mode: "plugin", code: "CR_IN_WORKING_TREE", label: "CR 혼입 텍스트" },
  { n: 6, dir: "06-license-badge-mismatch", mode: "plugin", code: "README_BADGE_LICENSE_MISMATCH", label: "README 배지 라이선스 불일치" },
  { n: 7, dir: "07-english-freetext", mode: "lang", code: "FREETEXT_ENGLISH_DETECTED", label: "영문 서술형 free-text" },
  { n: 8, dir: "08-state-dir-mismatch", mode: "plugin", code: "STATE_DIR_NAME_INCONSISTENT", label: "상태 디렉터리 상수(.devcareer) 정의-참조 불일치" },
  { n: 9, dir: "09-non-mit-license-mismatch", mode: "plugin", code: "LICENSE_FILE_MISMATCH", label: "비-MIT 라이선스(Apache-2.0) 선언과 LICENSE 본문 불일치" },
  { n: 11, dir: "11-command-prefix-mismatch-in-docs", mode: "plugin", code: "COMMAND_PREFIX_MISMATCH", label: "docs/ 문서 내 슬래시 명령 접두사 불일치(AC-18 스캔 범위 확장)" },
  { n: 12, dir: "12-schema-insufficient-violation", mode: "schema", code: "SCHEMA_CHECK_VIOLATION", label: "AC-12: evidence=[]인데 basis≠insufficient (--schema-check)" },
  // AC-6 (i)~(iii) + T-1/T-2 교차 불변식(scripts/lib/invariants.mjs) —
  // 이월 게이트 A-1/A-2 + 임무 지침 배선 위치 C. schema-validate.mjs의
  // 구조 검증(필드 존재·타입)은 모두 통과하지만 필드 "사이의" 관계가
  // 깨진 evidence.json이라 이 4케이스는 새 교차 검사가 실제로 FAIL을
  // 내는지를 각 절 하나씩 격리해 관측한다(절대 규칙).
  { n: 13, dir: "13-evidence-viamerge-omitted", mode: "schema", file: "evidence.json", code: "EVIDENCE_INVARIANT_AC6_II_VIOLATION", label: "AC-6 (ii): 머지 커밋의 files[] viaMerge 부여 누락(임무 M-a 사고 실험)" },
  { n: 14, dir: "14-evidence-truncated-samplingmethod-mismatch", mode: "schema", file: "evidence.json", code: "EVIDENCE_INVARIANT_T2_VIOLATION", label: "T-2: reason==\"none\"인데 samplingMethod!=\"none:full-scan\"" },
  { n: 15, dir: "15-evidence-ismerge-parents-mismatch", mode: "schema", file: "evidence.json", code: "EVIDENCE_INVARIANT_AC6_III_VIOLATION", label: "AC-6 (iii): isMerge과 parents.length>=2 불일치(%P 누락 시뮬레이션)" },
  { n: 16, dir: "16-evidence-commitlevel-sum-mismatch", mode: "schema", file: "evidence.json", code: "EVIDENCE_INVARIANT_AC6_I_VIOLATION", label: "AC-6 (i): 커밋 레벨 합계가 files[] 필터 합과 불일치(임무 M-e 사고 실험의 축소판)" },
  // 임무 지침 배경 블로커 A(M-f): coverage.traversed에 total을 그대로
  // 복사해도 negative 픽스처(정적 JSON)만으로는 잡히지 않던 축을 여기서
  // 격리 관측한다 — commits[]의 excluded 건수(1)로 재계산한
  // 기대 traversed(2)와 기재된 traversed(1)가 다르다.
  { n: 17, dir: "17-evidence-coverage-traversed-copied-from-total", mode: "schema", file: "evidence.json", code: "EVIDENCE_INVARIANT_COVERAGE_TRAVERSED_VIOLATION", label: "M-f: coverage.traversed에 total을 그대로 복사(excluded 커밋 반영 누락)" },
  // 콜드 리뷰 A-7 대응: contentHash 필드는 본문(schemaVersion/sourceRepoHead/
  // coverage/truncated/commits)이 참이고 다른 모든 불변식을 만족해도,
  // 기록된 contentHash 한 글자만 실제 재계산값과 다르면 그 자체로 FAIL이어야
  // 한다 — 재계산·대조 코드가 없던 시절에는 이 케이스가 [PASS]를 냈다.
  { n: 18, dir: "18-evidence-content-hash-mismatch", mode: "schema", file: "evidence.json", code: "EVIDENCE_CONTENT_HASH_MISMATCH", label: "A-7: contentHash가 본문 재계산값과 1글자 다름(본문 자체는 참)" },
  // 슬라이스 B 스펙 심사 C-3 / 게이트 A-1: nodes가 빈 배열인 산출물은
  // AC-13이 금지한 "빈손 출력"인데, 개정 전에는 --schema-check ·
  // --lang-check · verify-evidence 세 게이트를 전부 exit 0으로 통과했다
  // (실측). nodes.minItems=1로 스키마 레벨에서 막고 여기서 관측한다.
  //
  // messageIncludes가 필요한 이유: SCHEMA_CHECK_VIOLATION은 모든 구조
  // 위반이 공유하는 범용 코드라(케이스 12·21도 같은 코드), 코드만 보면
  // "아무 이유로든 FAIL이면 통과"가 되어 minItems가 실제로 작동한다는
  // 증거가 되지 않는다 — 위반 메시지에 minItems(1)이 들어 있는지까지 본다.
  { n: 19, dir: "19-career-empty-nodes", mode: "schema", file: "career.json", code: "SCHEMA_CHECK_VIOLATION", messageIncludes: "minItems(1)", label: "C-3: nodes가 빈 배열(AC-13 '빈손 출력')" },
  // 게이트 A-4 / 심사 M-2: AC-19 언어 린트의 origin:"user" 제외가 정확히
  // 좁게 작동하는지를 tests/fixtures-valid/gap-report.json과 짝으로 관측한다
  // — 두 파일은 gap:001 노드의 origin 값 하나만 다르다. positive만 두면
  // "제외가 너무 넓어 전부 통과"와 구별되지 않고, negative만 두면 사용자
  // 입력 오탐(M-2가 실측한 것)이 회귀로 잡히지 않는다.
  { n: 20, dir: "20-gap-report-generated-english", mode: "lang", code: "FREETEXT_ENGLISH_DETECTED", label: "M-2 대조군: origin:\"generated\" 노드의 영문 free-text는 계속 FAIL" },
  // 케이스 24~29 — **`skills/`가 생기기 전까지 대상 0건이던 검사들.**
  // validate-plugin.mjs는 처음부터 SKILL.md frontmatter 4종·문서 경로 실재성·
  // 슬래시 명령 접두사를 검사했지만, 이 레포에 `skills/`가 없어 그중 상당수가
  // **한 번도 대상을 가져 본 적 없는 휴면 검사**였다(케이스 2·3·11만 최소
  // 픽스처로 관측되고 있었다). 프롬프트 계층이 서면서 이 검사들이 처음으로
  // 프로덕션 대상을 갖게 되므로, 각각이 실제로 FAIL을 내는 것을 여기 고정한다.
  // "대상이 없어 통과"와 "검사해서 통과"는 exit 0이라는 같은 얼굴을 하고 있다.
  { n: 24, dir: "24-skill-name-missing", mode: "plugin", code: "SKILL_NAME_MISSING", label: "SKILL.md frontmatter에 name 없음(name↔디렉터리 대조의 전제)" },
  { n: 25, dir: "25-skill-description-missing", mode: "plugin", code: "SKILL_DESCRIPTION_MISSING", label: "SKILL.md frontmatter에 description 없음(Claude 라우팅 값 부재)" },
  { n: 26, dir: "26-skill-frontmatter-missing", mode: "plugin", code: "SKILL_FRONTMATTER_MISSING", label: "SKILL.md에 frontmatter 블록 자체가 없음" },
  { n: 27, dir: "27-skill-md-not-found", mode: "plugin", code: "SKILL_MD_NOT_FOUND", label: "스킬 디렉터리에 SKILL.md가 없음(README.md만 있음)" },
  { n: 28, dir: "28-doc-path-not-found", mode: "plugin", code: "DOC_PATH_NOT_FOUND", label: "SKILL.md가 실재하지 않는 scripts/ 경로를 안내(프롬프트는 명령을 적으므로 경로 오타가 곧 실행 실패)" },
  { n: 29, dir: "29-command-prefix-mismatch-in-skill", mode: "plugin", code: "COMMAND_PREFIX_MISMATCH", label: "AC-18: SKILL.md 안의 슬래시 명령 접두사 불일치(케이스 11의 docs/ 갈래와 짝)" },
  // 게이트 A-2 / 심사 C-4: verification 필드의 조건부 제약이 실제로 FAIL을
  // 내는지. status가 refuted인데 attempts=0 · reasonCode=null인 자기모순
  // 노드다(다른 절과 겹치지 않도록 basis=commit + evidence 비공허로 격리).
  { n: 21, dir: "21-career-verification-refuted-contradiction", mode: "schema", file: "career.json", code: "SCHEMA_CHECK_VIOLATION", messageIncludes: "const 불일치(기대 2)", label: "C-4: verification.status=refuted인데 attempts=0·reasonCode=null" },
  // T3(spec.md §6): excluded 커밋의 PII 3필드 축소를 어긴 원장. 실제
  // 픽스처 레포에서 수집한 참인 원장을 기반으로 excluded 항목 하나에만
  // authorEmail·subject·coAuthors를 되살려 넣고 contentHash를 재계산했으므로,
  // 이 케이스의 위반은 PII 유출 3건으로 정확히 격리된다(다른 케이스처럼
  // 부수 위반이 섞여 있지 않다).
  { n: 22, dir: "22-evidence-excluded-commit-pii-leak", mode: "schema", file: "evidence.json", code: "SCHEMA_CHECK_VIOLATION", messageIncludes: "authorEmail", label: "T3: excluded 커밋에 authorEmail·subject·coAuthors가 남은 원장" },
  // 게이트 C-1 / 심사 C-2: 마스킹 우회 시크릿. 이 픽스처는 구조상 완전히
  // 유효해서 `--schema-check`도 `--lang-check`도 exit 0을 낸다(실측) —
  // AC-8의 「마스킹 우회」 카테고리가 REJECT를 낼 코드가 프로덕션에 0곳이던
  // 상태에서는 이 산출물이 모든 게이트를 통과했다는 뜻이다. 새 검사 지점만
  // 이것을 잡는다.
  //
  // messageIncludes로 패턴 이름까지 단언하는 이유는 케이스 19·21·22와 같다 —
  // ARTIFACT_SECRET_LEAK 코드만 보면 "아무 패턴으로든 FAIL이면 통과"가 되어
  // 겨냥한 패턴이 발화했다는 증거가 되지 않는다.
  { n: 23, dir: "23-career-secret-leak", mode: "secret", file: "career.json", code: "ARTIFACT_SECRET_LEAK", messageIncludes: "aws-access-key", label: "C-2: 마스킹 우회 — career 노드 free-text에 남은 AWS 액세스 키" },
];

// AC-3(b): 알 수 없는 SPDX 라이선스는 FAIL이 아니라 명시적 SKIP(경고)으로
// 보고되고 exit 0을 유지해야 한다 — NEGATIVE_CASES 루프(!ok 기대)와 형태가
// 반대라 별도로 확인한다.
const UNKNOWN_LICENSE_SKIP_CASE = {
  dir: "10-unknown-license-skip",
  warnCode: "LICENSE_CHECK_SKIPPED_UNKNOWN_SPDX",
  label: "알 수 없는 라이선스(Proprietary) → SKIP 경고 + exit 0",
};

let failed = 0;
let passed = 0;

/**
 * `runSection`/`runSectionAsync`가 예외를 잡아 중단시킨 섹션 수.
 *
 * 라벨 문자열을 나중에 grep하는 방식으로 세지 않는다 — 라벨 문구가 바뀌면 조용히 0이 되고,
 * 그것이 이 가드가 막으려는 실패와 정확히 같은 모양이다.
 */
let abortedSections = 0;

/**
 * 모드별 단언 수의 정본. **최종 가드 2건은 제외한 수다.**
 *
 * 가드가 자기 자신을 세면 순환이 된다(세는 시점에 아직 보고되지 않았다). 그래서 기준을
 * 가드 앞으로 잡고, 「결과:」 줄의 수는 **여기 적힌 값 + 2**가 된다.
 *
 * **파생 값을 여기 적지 않는다.** 초판은 「녹색일 때 447 / 35 / 13」이라고 실제 수를 함께 적었고,
 * 바로 그 커밋에서 default가 445 → 446으로 오르자 이 주석만 낡았다(콜드 리뷰가 실측으로 잡았다).
 * 총량 리터럴의 조용한 드리프트를 막으려고 만든 가드의 설명이 같은 방식으로 드리프트한 것이므로,
 * 갱신 지점을 아래 객체 **한 곳**으로 줄인다 — 관계식만 남기면 다시 낡을 값이 없다.
 *
 * **왜 하한이 아니라 정확 일치인가.** 하한(`>=`)은 「단언 3건을 추가하고 2건을 잃어 순증 +1」인
 * 변경을 통과시킨다. 이 레포에서 실제로 났던 사고가 그 형태에 가깝다 — 445에서 444로 줄었고
 * 아무도 보지 않았다. 정확 일치는 단언 수가 바뀔 때마다 이 값을 함께 고치게 만드는데, 그것은
 * 비용이 아니라 의도다: 이 레포는 이미 매 회차 총량 변화를 보고서에 적어 왔고(433 → 445 등),
 * 그 육안 대조가 실패한 것이 이 가드를 만든 이유다.
 *
 * **이 가드가 막지 못하는 것(감추지 않는다).** `main()` 밖으로 예외가 새면 `main().catch`가
 * `[중단]`을 찍고 exit 1로 죽으며 이 가드는 **아예 실행되지 않는다.** 즉 「프로세스가 죽는」
 * 실패는 여전히 프로세스 밖에서만 관측된다(종료 코드와 「결과:」 줄의 부재). 모듈 최상위 판독을
 * 지연 판독으로 바꾼 것이 그 부류를 줄이는 작업이었고, 여기서 더 좁힐 수단은 없다.
 */
const EXPECTED_ASSERTIONS_BEFORE_GUARDS = Object.freeze({
  // 이력: (DH-1d) 445 → 446. 7번 C2의 A-21 판독 전제 단언 446 → 447.
  //       7번 C9의 (SP-1b) 프롬프트 판독 전제 단언 447 → 448.
  //       8번 ⑪의 (SR-1)~(SR-11) 안전 판독 형태 오라클 448 → 459.
  //       8번 ②의 (SI-1)~(SI-4) 스키마 동형성 교차 가드 459 → 463.
  //       8번 ⑤의 (WA-29) PREV_ARTIFACT_HASH_MISSING CLI 관측 463 → 464.
  //       8번 ③④의 (AC-2b)(AC-2c) 계층 키·버전 드리프트 가드 464 → 466.
  //       9번의 (CH-1)~(CH-8) instance 부재 fail-closed 466 → 474.
  //       10번의 (AC-43)~(AC-45)·(WA-30)~(WA-32) prev 유래 스키마 위반 전용 HOLD 474 → 480.
  //       11번의 (WC-1)~(WC-6)·(AC-46) config 쓰기 주체(D3) 480 → 487.
  //       12번의 (RG-1)~(RG-3) 루트 CLAUDE.md 색인 가드 487 → 490.
  //       13번 (a)의 (RR-1)~(RR-9) 레지스트리 판독·AC-22 스테일 축 490 → 499.
  //       13번 (b)의 (RM-1)~(RM-8) knowledge-map·gap-report 렌더 진입점 499 → 509.
  //       13번 (c)의 (SG-1)~(SG-8) skill-gap 배선(0단계 스테일·D3·쓰기/렌더) 509 → 517.
  //       13번 (d)의 (SP-11) 프롬프트 명령의 cwd 상대경로 인자 517 → 518.
  //       14번 착수분의 (LN-1)~(LN-4) 소스 참조 형태 가드(A-37 재발 차단) 518 → 522.
  //       14번 (a)의 (CT-1)~(CT-14) 오염 채점 엔진 오라클(기계 3종 30건) 522 → 536.
  //       콜드 리뷰 라운드 2 처방 2·9의 (RT-1)(RT-2)(AP-1)~(AP-3) 승격 536 → 541.
  //       콜드 리뷰 라운드 2 처방 1의 (RV-1)~(RV-4) 렌더 입력 게이트 541 → 545.
  //       성능 콜드 리뷰 라운드 3 처방 2[A]의 (LP-12)~(LP-27) 투영 필드 삭감
  //       양방향 단언 + 완전성 게이트 + 스키마 사본 드리프트 가드 545 → 561.
  //       성능 콜드 리뷰 라운드 3 처방 3의 (LP-28) 투영 직렬화 폭 고정 561 → 562.
  //       콜드 리뷰 라운드 2 처방 3의 (AC-47)~(AC-55)·(WA-33) fact-checked 단계
  //       불변식 넷의 양방향 관측 + 계층 중립 + CLI 배선 562 → 572.
  //       콜드 리뷰 라운드 2 처방 8의 (RV-5) 정직한 렌더 루트 전제 +
  //       (RV-6)~(RV-8) 인용 재검증 게이트의 금지 방향 572 → 576.
  //       콜드 리뷰 라운드 2 처방 11의 (GP-1)~(GP-4)·(SA-1)~(SA-4) 절대 규칙 4·5
  //       관측(총량 가드 연산자 형태 축 + 슬라이스 A 내용 핀) 576 → 584.
  //       콜드 리뷰 라운드 2 처방 5·7의 (WC-7)~(WC-12)·(WA-34)~(WA-39)·(AC-1b)
  //       원장 대조와 상위 계층 참조 해소 584 → 597.
  default: 597,
  // 이력: 도입(`0a42457`) 이래 **변경 0회**. 「아직 안 적었다」가 아니라 「바뀐 적이 없다」이며,
  //       그 사실 자체가 정보다 — `main()`이 이 두 모드에서 `runCommonSections()`를 아예 돌리지
  //       않으므로 공통 섹션에 단언을 더하는 작업(4~8번이 전부 그랬다)은 구조적으로 여기 닿지
  //       않는다. **이 두 값이 움직이는 변경은 그래서 예외적이고, 움직였다면 negative 픽스처나
  //       골든 오라클 자체가 바뀐 것이다.** 그때 이 줄에 사유를 적어라.
  negative: 33,
  golden: 11,
  // 14번 (b)의 (CX-1)~(CX-8) 오염 스위트 실채점. 신설이며 이력의 시작점이다 —
  // 이 모드는 `runCommonSections()`를 부르지 않고 자기 절 하나만 돈다.
  contamination: 8,
});

function report(ok, label) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
  }
}

/**
 * 원장에서 "실제 저자가 <email>인 커밋"의 항목을 찾는다.
 *
 * T3(spec.md §6) 이후 `excluded: true` 커밋의 원장 `authorEmail`은 null이므로
 * `commits.find((c) => c.authorEmail === X)`로는 타 저자 커밋을 더 이상 찾을
 * 수 없다(찾으면 undefined가 되어 `.id` 접근에서 TypeError로 스위트가 크래시한다).
 *
 * 대신 git 오라클에 직접 묻는다. 이 방식이 원래 의도("이 항목이 실제로 Alice의
 * 커밋이다")에 더 가깝고, 원장 필드 조작에 영향받지 않는다 — 조작된 원장을
 * 입력으로 쓰는 케이스(3필드 편집 재현)에서도 대상 커밋을 정확히 집어낸다.
 */
function findEntryByRealAuthor(repoPath, evidence, email) {
  for (const c of evidence.commits) {
    const oracle = getCommitAuthorAndParents(repoPath, c.hash);
    if (oracle.outcome === "ok" && oracle.authorEmail === email) return c;
  }
  return undefined;
}

// AC-6 / AC-12: scripts/lib/schema-validate.mjs의 validateInstance는 지금까지
// 자기 자신(재귀 호출) 밖에서 호출된 적이 없는 죽은 코드였다. 이 함수가
// (1) 실제 픽스처 인스턴스를 실제 스키마로 검증하고, (2) required 누락 ·
// enum 불일치 · type 불일치를 실제로 잡아내며, (3) 지원 범위 밖 키워드를
// 조용히 통과시키지 않는지를 관측 가능한 형태로 확인한다.
function runSchemaValidatorSmoke() {
  console.log("[스키마 검증기 스모크] scripts/lib/schema-validate.mjs validateInstance 배선 확인");

  // (1) AC-6: tests/fixtures-valid/career.json이 schemas/career.schema.json에
  // 적합함을 확인한다. positive 픽스처를 실제 정본 스키마로 구조 검증하는
  // 유일한 경로 — 이전에는 이 대응 관계를 확인하는 코드가 어디에도 없었다.
  //
  // 계층별로 반복한다 — 예전에는 career 한 쌍만 확인했고, 그 결과
  // knowledge-map·gap-report 스키마에 넣은 제약은 positive 방향으로도
  // 관측되지 않았다(인스턴스가 레포에 아예 없었다). positive 픽스처가
  // 스키마와 갈려도 게이트가 침묵하는 상태를 여기서 닫는다.
  for (const layer of ["career", "knowledge-map", "gap-report"]) {
    // 이 단언은 **두 파일 모두**에 의존하므로 사유도 둘을 합쳐 싣는다 — 어느 쪽이 없었는지가
    // 한 줄에 남아야 한다. 경로는 조립 함수를 쓴다(초판은 세그먼트를 손으로 적었고, 그래서
    // 이 사이트가 「11곳」 집계에서 통째로 빠졌다 — 호출부에 경로 문자열이 없었기 때문이다).
    const { json: schema, error: schemaError } = readRepoJsonSafe(SCHEMA_REL(layer));
    const { json: instance, error: instError } = readRepoJsonSafe(FIXTURE_VALID_REL(layer));
    const readError = [schemaError, instError].filter((e) => e !== null).join(", ");
    const warnings = [];
    const errors = readError !== "" ? [readError] : validateInstance(schema, instance, schema, "$", warnings);
    if (errors.length > 0) {
      for (const e of errors) console.log(`    실제 오류: ${e}`);
    }
    for (const w of warnings) console.log(`    [WARN] ${w}`);
    report(
      errors.length === 0 && warnings.length === 0,
      `tests/fixtures-valid/${layer}.json이 schemas/${layer}.schema.json에 적합함(AC-6), 미지원 키워드 경고 0건`
    );
  }

  // (2) validateInstance가 실제로 위반을 잡는지 — 인메모리 negative 케이스
  // 3종(required 누락 / enum 불일치 / type 불일치). 픽스처 파일 없이 스키마
  // 조각과 인스턴스를 즉석에서 만들어 확인한다.
  {
    const schema = {
      type: "object",
      required: ["a", "b"],
      properties: { a: { type: "string" }, b: { type: "string" } },
    };
    const errors = validateInstance(schema, { a: "x" });
    const ok = errors.some((e) => e.includes("required") && e.includes("'b'"));
    if (!ok) for (const e of errors) console.log(`    실제 오류: ${e}`);
    report(ok, "validateInstance: required 필드 누락을 잡음");
  }
  {
    const schema = { type: "string", enum: ["x", "y"] };
    const errors = validateInstance(schema, "z");
    const ok = errors.some((e) => e.includes("enum 불일치"));
    if (!ok) for (const e of errors) console.log(`    실제 오류: ${e}`);
    report(ok, "validateInstance: enum 불일치를 잡음");
  }
  {
    const schema = { type: "number" };
    const errors = validateInstance(schema, "not-a-number");
    const ok = errors.some((e) => e.includes("type 불일치"));
    if (!ok) for (const e of errors) console.log(`    실제 오류: ${e}`);
    report(ok, "validateInstance: type 불일치를 잡음");
  }

  // (3) 지원 범위 밖 JSON Schema 키워드(예: minProperties)를 만나면 조용히
  // 통과시키지 않는지 확인한다. minProperties는 이 검증기가 강제하지
  // 않으므로 instance는 "구조적으로는" 통과(errors.length === 0)하지만,
  // warnings에 그 사실이 명시적으로 남아야 한다 — 남지 않으면 "검증되지
  // 않은 제약이 조용히 통과"하는 바로 그 실패 모드다.
  {
    const schema = { type: "object", minProperties: 1, properties: { a: { type: "string" } } };
    const warnings = [];
    const errors = validateInstance(schema, { a: "x" }, schema, "$", warnings);
    const ok = errors.length === 0 && warnings.some((w) => w.includes("minProperties"));
    if (!ok) {
      console.log(`    errors=${JSON.stringify(errors)} warnings=${JSON.stringify(warnings)}`);
    }
    report(ok, "validateInstance: 지원 범위 밖 키워드(minProperties)를 조용히 통과시키지 않고 경고함");
  }

  // (4) 최상위(allOf로 감싸지 않은) if/then 이 실제로 평가되는지. 이 형태는
  // 예전에 KNOWN_SCHEMA_KEYWORDS에 이름만 있고 한 번도 읽히지 않아 오류도
  // 경고도 없이 통과했다 — 즉 제약이 애초에 없는 것과 구별되지 않았다.
  // "위반을 넣으면 실제로 FAIL이 난다"를 여기서 관측한다. 대조군(위반이
  // 아닌 인스턴스)을 함께 두지 않으면 조건이 상시 참이어도 이 검사가
  // 통과하므로 두 방향을 모두 본다.
  {
    // `else` 분기도 함께 관측한다 — 스키마에 `else`를 쓰지 않으면
    // `resolved.else === undefined` 경로만 밟게 되어, `else` 평가가 통째로
    // 빠져 있어도 이 오라클이 통과한다(M-7이 지적한 "이름만 있고 평가되지
    // 않는 키워드"와 관측 가능성 면에서 같은 상태가 된다).
    const schema = {
      type: "object",
      properties: { kind: { type: "string" }, code: { type: ["string", "null"] } },
      if: { properties: { kind: { const: "refuted" } } },
      then: { properties: { code: { type: "string", minLength: 1 } } },
      else: { properties: { code: { type: "null" } } },
    };
    const violating = validateInstance(schema, { kind: "refuted", code: null });
    const conforming = validateInstance(schema, { kind: "refuted", code: "NO_SUPPORT" });
    const elseViolating = validateInstance(schema, { kind: "verified", code: "SHOULD_BE_NULL" });
    const elseConforming = validateInstance(schema, { kind: "verified", code: null });
    const ok =
      violating.some((e) => e.includes("type 불일치")) &&
      conforming.length === 0 &&
      elseViolating.some((e) => e.includes("type 불일치")) &&
      elseConforming.length === 0;
    if (!ok) {
      console.log(
        `    violating=${JSON.stringify(violating)} conforming=${JSON.stringify(conforming)} elseViolating=${JSON.stringify(elseViolating)} elseConforming=${JSON.stringify(elseConforming)}`
      );
    }
    report(
      ok,
      "validateInstance: 최상위 if/then/else를 실제로 평가함(then 위반 FAIL / then 준수 PASS / else 위반 FAIL / else 준수 PASS)"
    );
  }

  // (5) anyOf 가 실제로 평가되는지. 같은 이력이며, T3(제외 커밋 PII 축소)
  // 설계에서 authorEmail을 "이메일 또는 해시"로 넓히는 변형이 검토됐다가
  // 바로 이 미평가 때문에 기각됐다 — 쓰레기 값이 위반 0건으로 통과했기
  // 때문이다. 그 관측을 회귀로 고정한다.
  {
    const schema = {
      anyOf: [
        { type: "string", format: "email" },
        { type: "string", pattern: "^sha256:[0-9a-f]{16}$" },
      ],
    };
    const violating = validateInstance(schema, "!!!not-an-email-nor-hash!!!");
    const asEmail = validateInstance(schema, "dev@example.com");
    const asHash = validateInstance(schema, "sha256:0123456789abcdef");
    const ok =
      violating.some((e) => e.includes("anyOf")) && asEmail.length === 0 && asHash.length === 0;
    if (!ok) {
      console.log(
        `    violating=${JSON.stringify(violating)} asEmail=${JSON.stringify(asEmail)} asHash=${JSON.stringify(asHash)}`
      );
    }
    report(ok, "validateInstance: anyOf를 실제로 평가함(어느 분기도 못 맞추면 FAIL, 각 분기는 PASS)");
  }
}

// ---------------------------------------------------------------------------
// 슬라이스 B 게이트 A — 스키마 절 단위 오라클.
//
// 왜 필요한가: 게이트 A는 세 L1+ 스키마와 evidence 스키마에 조건절·제약을
// 여러 개 넣었는데, 파일 기반 negative 픽스처는 그중 극히 일부만 밟는다.
// 적대 검증에서 실측된 결과가 이것이다 — 새로 넣은 제약 약 35개 중 위반을
// 넣었을 때 실제로 4게이트를 빨갛게 만드는 것은 3개뿐이었고, 나머지를 전부
// 지워도 스모크/negative/골든이 모두 녹색이었다. "FAIL이 안 나면 그 검사는
// 없는 것"이라는 이 레포의 절대 규칙에 비추면 그 32개는 존재하지 않는 제약과
// 구별되지 않았다.
//
// 픽스처 디렉터리를 절마다 하나씩 만드는 대신, 기준 인스턴스에 절별 변이를
// 주입해 validateInstance를 직접 부른다 — 디스크 I/O가 없고 절과 기대 메시지가
// 한 줄로 붙어 있어 어느 절이 관측되는지가 코드에서 바로 읽힌다.
//
// 자기충족 방어 두 가지를 함께 둔다:
//   (1) 기준 인스턴스 자체가 위반 0건임을 먼저 단언한다 — 기준이 이미 FAIL이면
//       모든 변이 단언이 "원래부터 빨개서" 통과한다.
//   (2) 기대 메시지 조각을 절마다 다르게 잡는다 — 아무 오류나 나면 통과하는
//       판정은 이 파일이 messageIncludes를 도입한 이유와 정확히 같은 실패다.
// ---------------------------------------------------------------------------
/**
 * 안전 판독의 **세 번째 실패 경로**(파싱은 성공했는데 내용이 객체가 아님)를 관측한다.
 *
 * **왜 이 절이 있는가.** 이 아크는 「부재를 예외가 아니라 FAIL로」를 13곳에서 닫았지만,
 * 그 폐쇄는 **부재·파싱실패** 두 축만 덮었다. 「판독도 파싱도 성공했는데 값이 `null`」인
 * 축은 열려 있었고, `schema-validate.mjs`의 falsy·비객체 fail-open과 만나 **거짓 초록**이
 * 됐다(격리 사본 실측: career 스키마 `null` → 거짓 초록 3건, evidence 스키마 `false` →
 * A-13 적합성 6건). 그 폐쇄를 관측하는 단언이 **0건이었으므로** 여기 만든다 —
 * 이 레포의 절대 규칙은 「관측되지 않는 제약은 없는 것이다」이다.
 *
 * **가짜 루트로 관측한다.** `readRepoJsonSafe(rel, root)`·`loadSchema(layer, root)`가 루트를
 * 인자로 받게 바뀌었으므로 레포 안에 고장난 파일을 만들지 않고 os.tmpdir에서 전부 끝난다.
 * 루트 주입이 불가능했다면 이 절은 존재할 수 없었다 — 콜드 리뷰의 「경로 인자를 받게
 * 설계하라」가 값을 낸 지점이 여기다.
 *
 * **양방향으로 본다.** 금지 방향(비객체 5종이 사유로 강등)만 보면 게이트가 너무 넓어져
 * 정상 객체까지 막는 회귀를 놓친다. 그래서 (SR-1)이 허용 방향을 먼저 고정한다.
 */
function runSafeReadShapeOracleSmoke() {
  console.log("[안전 판독 형태 오라클] 판독·파싱 성공 뒤에도 내용이 객체가 아니면 판독 실패로 강등되는가");

  const fake = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-shape-"));
  try {
    fs.mkdirSync(path.join(fake, "schemas"), { recursive: true });
    const put = (rel, raw) => {
      const p = path.join(fake, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, raw, "utf8");
      return rel;
    };

    // 정상 스키마 1개 — 허용 방향의 대조군이자, 아래 금지 방향이 「전부 막는 게이트」가
    // 아님을 증명하는 짝이다.
    const okSchema = { type: "object", required: ["a"], properties: { a: { type: "string" } } };
    put("schemas/career.schema.json", JSON.stringify(okSchema));

    // ---- (SR-1) 허용 방향 ----
    {
      const { json, error } = readRepoJsonSafe("schemas/career.schema.json", fake);
      const ok = error === null && json !== null && json.type === "object";
      if (!ok) console.log(`    실제: json=${JSON.stringify(json)} error=${error}`);
      report(ok, "(SR-1) 허용 방향: 내용이 정상 객체인 JSON은 그대로 판독된다(형태 게이트가 과잉 차단하지 않는다)");
    }

    // ---- (SR-2)~(SR-6) 금지 방향: 파싱은 통과하지만 객체가 아닌 5종 ----
    for (const [raw, shape] of [
      ["null", "null"],
      ["false", "boolean"],
      ["123", "number"],
      ['"schema"', "string"],
      ["[]", "array"],
    ]) {
      const rel = put(`schemas/probe-${shape}.schema.json`, raw);
      const { json, error } = readRepoJsonSafe(rel, fake);
      // 사유에 **형태 이름**이 들어가야 한다 — 「객체가 아님」만으로는 어느 형태였는지가
      // 로그에서 사라지고, 그러면 「어느 경로로 실패했는가를 고정하라」를 반대쪽에서 어긴다.
      const ok = json === null && typeof error === "string" && error.includes("객체가 아님") && error.includes(shape);
      if (!ok) console.log(`    실제(${raw}): json=${JSON.stringify(json)} error=${error}`);
      report(ok, `(SR-${shape === "null" ? 2 : shape === "boolean" ? 3 : shape === "number" ? 4 : shape === "string" ? 5 : 6}) 금지 방향: 내용이 ${shape}인 JSON은 판독 실패 사유로 강등된다(형태 이름 포함)`);
    }

    // ---- (SR-7) 기존 두 실패 경로가 살아 있는가(회귀) ----
    {
      const relBroken = put("schemas/probe-broken.schema.json", "{ not json");
      const broken = readRepoJsonSafe(relBroken, fake);
      const missing = readRepoJsonSafe("schemas/does-not-exist.schema.json", fake);
      const ok =
        broken.json === null && broken.error !== null && broken.error.includes("JSON 파싱 실패") &&
        missing.json === null && missing.error !== null && missing.error.includes("판독 실패");
      if (!ok) console.log(`    실제: broken=${broken.error} missing=${missing.error}`);
      report(ok, "(SR-7) 형태 게이트를 넣어도 기존 두 실패 경로(파싱 실패·부재)의 사유가 서로 구별된 채 남는다");
    }

    // ---- (SR-8) 술어 자체 ----
    {
      const cases = [
        [null, "null"], [[], "array"], [false, "boolean"], [1, "number"], ["s", "string"],
        [{}, null], [{ a: 1 }, null],
      ];
      const bad = cases.filter(([v, want]) => jsonShapeViolation(v) !== want);
      if (bad.length > 0) console.log(`    실제: ${JSON.stringify(bad.map(([v]) => jsonShapeViolation(v)))}`);
      report(bad.length === 0, "(SR-8) jsonShapeViolation 술어가 7개 입력을 정확히 분류한다(객체만 위반 없음)");
    }

    // ---- (SR-9) 이 게이트가 **왜** 필요한지를 고정한다 ----
    {
      // 슬라이스 A 파일이라 고칠 수 없는 현행 동작을 여기 못 박는다. 이것이 바뀌면(즉
      // schema-validate.mjs가 fail-closed가 되면) 이 단언이 FAIL하고, 그때 이 우회로가
      // 아직 필요한지 다시 판단하게 된다. 「고칠 수 없는 것」과 「고칠 필요 없는 것」은 다르다.
      const w = [];
      const permissive = [null, false, 123, "abc", []].every(
        (s) => validateInstance(s, { anything: 1 }, s, "$", w).length === 0
      );
      const strict = validateInstance(okSchema, { b: 1 }, okSchema, "$", []).length > 0;
      const ok = permissive && strict && w.length === 0;
      if (!ok) console.log(`    실제: permissive=${permissive} strict=${strict} warnings=${JSON.stringify(w)}`);
      report(
        ok,
        "(SR-9) 전제 고정: validateInstance는 비객체 스키마에 오류 0건·경고 0건을 돌려준다" +
        "(schema-validate.mjs는 슬라이스 A 수정 금지라 이 비대칭은 판독 쪽에서 막는다)"
      );
    }

    // ---- (SR-10)(SR-11) 프로덕션 쓰기 경계 ----
    {
      let okObj = null;
      try { okObj = loadSchema("career", fake); } catch (e) { okObj = e; }
      const ok = okObj !== null && !(okObj instanceof Error) && okObj.type === "object";
      if (!ok) console.log(`    실제: ${okObj instanceof Error ? okObj.message : JSON.stringify(okObj)}`);
      report(ok, "(SR-10) 허용 방향: loadSchema가 정상 스키마를 그대로 돌려준다");
    }
    {
      put("schemas/knowledge-map.schema.json", "null");
      let threw = null;
      try { loadSchema("knowledge-map", fake); } catch (e) { threw = e; }
      // **던지는 것이 요점이다.** 여기서 null을 돌려주면 호출부의 validateInstance가
      // 오류 0건을 받아 검증되지 않은 산출물이 exit 0으로 기록된다(격리 사본 실측).
      const ok = threw !== null && threw.message.includes("객체가 아닙니다") && threw.message.includes("null");
      if (!ok) console.log(`    실제: ${threw === null ? "던지지 않았다" : threw.message}`);
      report(ok, "(SR-11) 금지 방향: loadSchema는 내용이 null인 스키마에 던진다(호출부의 LAYER_SCHEMA_UNREADABLE + exit 3 채널로 간다)");
    }
  } finally {
    fs.rmSync(fake, { recursive: true, force: true });
  }
}

/** `basis`/`externalUrl` 계약을 갖는 네 계층. 이 목록 자체가 가드의 대상 집합이다. */
const BASIS_LAYERS = Object.freeze(["career", "knowledge-map", "gap-report", "plan"]);

/**
 * 계층 스키마에서 노드 정의(`$defs`의 `*Node`)를 찾는다. 이름이 계층마다 다르므로
 * (`careerNode`·`knowledgeNode`·`gapNode`·`planNode`) 표를 두지 않고 접미사로 찾는다 —
 * 표를 두면 계층이 느는 13번에 그 표가 네 번째 사본이 된다.
 */
function nodeDefOf(schema) {
  const defs = schema?.$defs;
  if (defs === undefined || defs === null) return null;
  const key = Object.keys(defs).find((k) => k.endsWith("Node"));
  return key === undefined ? null : defs[key];
}

/** `{const: x}` 또는 `{enum: [...]}`을 **정렬된 허용값 배열**로 정규화한다. 둘 다 아니면 null. */
function allowedValuesOf(clause) {
  if (clause === undefined || clause === null || typeof clause !== "object") return null;
  if (typeof clause.const === "string") return [clause.const];
  if (Array.isArray(clause.enum)) return [...clause.enum].sort();
  return null;
}

/**
 * 네 계층 스키마의 `basis`/`externalUrl` 절이 **서로 동형인지**를 관측한다(8번 ②).
 *
 * **왜 필요한가.** `basis: "external"`을 표현 가능하게 만든 커밋(`5f71c32`)은 네 파일을 한꺼번에
 * 고쳤지만, 그 뒤 「`evidence`가 비면 `basis`는?」 절을 완화할 때 **plan 하나가 빠졌다** —
 * 나머지 셋은 `enum: ["insufficient","external"]`인데 plan만 `const: "insufficient"`로 남아
 * 다섯 달 가까이 아무도 보지 못했다(정정 5 / 결정 D4). 같은 계약이 네 파일에 손으로 복제되는
 * 한 이 종류의 드리프트는 반드시 재발하고, **계층이 2개 느는 13번이 그 회차다.**
 * 가드를 계층 추가 **전에** 넣어야 그 가드가 무언가를 관측한다.
 *
 * **원문 JSON을 대조하지 않는다 — 파싱된 구조를 본다.** `allOf` 항목 순서가 계층마다 다르다
 * (knowledge-map만 evidence-빔 절이 0번이고 나머지 셋은 1번). JSON Schema에서 `allOf`는
 * 순서 무관이므로 이것은 **무해한 복사 드리프트**이고, 텍스트 diff로 짜면 그 무해한 차이가
 * 오탐 FAIL이 된다. 그래서 절을 조건으로 **찾아서** 비교한다.
 *
 * **서로 비교하지 않고 정본 리터럴과 비교한다.** 「네 계층이 서로 같다」는 **두 미지값의 `===`**
 * 형태라, 추출이 전부 실패해 넷 다 `null`이 되면 **우연히 PASS**한다 — 이 아크가 반복해서
 * 닫아 온 바로 그 모양이다. 그래서 각 계층을 기대 리터럴에 대고 보고, 추출 실패는 그 자체로
 * 위반이다.
 *
 * **career의 `commit`은 초과분이 아니라 의도다.** career만 커밋을 직접 근거로 쓸 수 있고
 * 나머지 셋은 파생 추론이라 `commit`을 쓸 수 없다 — 각 스키마의 `basis` description이 그 이유를
 * 적고 있다. 그래서 (SI-4)는 「전부 동일」이 아니라 계층별 기대 집합과 대조한다.
 */
function runSchemaIsomorphismOracleSmoke() {
  console.log("[스키마 동형성 교차 가드] 네 계층의 basis/externalUrl 절이 손으로 복제된 채 갈라지지 않았는가(8번 ②)");

  const tracker = makeReadTracker();
  const nodes = {};
  const bases = {};
  for (const layer of BASIS_LAYERS) {
    const schema = tracker.readJson(SCHEMA_REL(layer));
    nodes[layer] = nodeDefOf(schema);
    bases[layer] = schema?.$defs?.basis ?? null;
    // 판독은 됐는데 구조가 기대와 다른 경우도 **사유**로 남긴다 — 예외가 아니다.
    if (schema !== null && nodes[layer] === null) tracker.note(SCHEMA_REL(layer), "$defs에 *Node 정의가 없음");
  }
  const blameAll = tracker.blameFor(BASIS_LAYERS.map((l) => SCHEMA_REL(l)));

  /** `allOf`에서 `pick`이 참을 돌려주는 첫 절을 찾는다. 순서에 기대지 않는다. */
  const clauseWhere = (layer, pick) => (nodes[layer]?.allOf ?? []).find(pick) ?? null;

  // ---- (SI-1) externalUrl 프로퍼티 ----
  {
    const missing = BASIS_LAYERS.filter((l) => nodes[l]?.properties?.externalUrl === undefined);
    const ok = blameAll === "" && missing.length === 0;
    if (!ok) console.log(`    실제: ${blameAll !== "" ? blameAll : `externalUrl 없는 계층 ${JSON.stringify(missing)}`}`);
    report(ok, "(SI-1) 네 계층 노드 정의가 전부 externalUrl 프로퍼티를 갖는다(basis:external을 담을 자리)");
  }

  // ---- (SI-2) basis:"external" → required:["externalUrl"] ----
  {
    const bad = BASIS_LAYERS.filter((l) => {
      const c = clauseWhere(l, (x) => x?.if?.properties?.basis?.const === "external");
      return !Array.isArray(c?.then?.required) || !c.then.required.includes("externalUrl");
    });
    const ok = blameAll === "" && bad.length === 0;
    if (!ok) console.log(`    실제: ${blameAll !== "" ? blameAll : `external→required 절이 없거나 어긋난 계층 ${JSON.stringify(bad)}`}`);
    report(ok, "(SI-2) 네 계층 전부 basis:\"external\"이면 externalUrl을 required로 만드는 조건절을 갖는다(allOf 순서 무관)");
  }

  // ---- (SI-3) evidence가 비면 basis 허용 집합 — 8번 ①의 회귀 가드 ----
  {
    const EXPECTED = ["external", "insufficient"]; // 정렬 기준. **정본 리터럴이지 서로 비교가 아니다.**
    const actual = Object.fromEntries(
      BASIS_LAYERS.map((l) => {
        const c = clauseWhere(l, (x) => x?.if?.properties?.evidence?.maxItems === 0);
        return [l, allowedValuesOf(c?.then?.properties?.basis)];
      })
    );
    const bad = BASIS_LAYERS.filter((l) => JSON.stringify(actual[l]) !== JSON.stringify(EXPECTED));
    const ok = blameAll === "" && bad.length === 0;
    if (!ok) console.log(`    실제: ${blameAll !== "" ? blameAll : JSON.stringify(actual)}`);
    report(
      ok,
      "(SI-3) 네 계층 전부 「evidence가 비면 basis는 insufficient 또는 external」이다" +
      "(plan만 const로 남아 있던 드리프트의 회귀 가드 — 예외 4번 ②의 집행 상태)"
    );
  }

  // ---- (SI-4) basis enum ----
  {
    // career만 commit을 쓸 수 있다 — 파생 추론 계층 셋은 쓸 수 없고, 각 스키마의
    // basis description이 그 이유를 적고 있다. 「전부 동일」로 짜면 그 의도를 지우게 된다.
    const EXPECTED = {
      career: ["commit", "external", "inference", "insufficient"],
      "knowledge-map": ["external", "inference", "insufficient"],
      "gap-report": ["external", "inference", "insufficient"],
      plan: ["external", "inference", "insufficient"],
    };
    const actual = Object.fromEntries(BASIS_LAYERS.map((l) => [l, allowedValuesOf(bases[l])]));
    const bad = BASIS_LAYERS.filter((l) => JSON.stringify(actual[l]) !== JSON.stringify(EXPECTED[l]));
    const ok = blameAll === "" && bad.length === 0;
    if (!ok) console.log(`    실제: ${blameAll !== "" ? blameAll : JSON.stringify(actual)}`);
    report(
      ok,
      "(SI-4) 네 계층의 $defs.basis enum이 정본과 일치한다(career만 commit을 갖는 것은 의도된 비대칭)"
    );
  }
}

function runSchemaClauseOracleSmoke() {
  console.log("[스키마 절 단위 오라클] 게이트 A가 넣은 조건절·제약이 각각 실제로 FAIL을 내는지(절대 규칙: 관측되지 않는 제약은 없는 것이다)");

  // **계층 단위로 귀책한다.** 이 섹션은 스키마 4개와 픽스처 3개를 읽고 단언 54건이 그 위에
  // 서므로, 사유를 섹션 전량에 실으면 어느 파일이 없었는지가 통째로 뭉개진다.
  //
  // `evidence` 계층만 다르다 — 그 기준 인스턴스는 파일이 아니라 아래에서 buildMultiAuthor +
  // collectGitFacts로 **런타임 합성**한 것이다. 그래서 evidence의 blame 대상은 스키마 하나뿐이고,
  // `tests/fixtures-valid/evidence.json`을 사유에 적으면 실재하지 않는 파일을 가리키게 된다.
  const tracker = makeReadTracker();
  const schemaOf = (layer) => tracker.readJson(SCHEMA_REL(layer));
  const blameOf = (layer) =>
    layer === "evidence"
      ? tracker.blameFor([SCHEMA_REL("evidence")])
      : tracker.blameFor([SCHEMA_REL(layer), FIXTURE_VALID_REL(layer)]);

  // evidence 기준 인스턴스는 손으로 쓰지 않고 실제 수집 결과를 쓴다 —
  // 프로덕션이 실제로 만드는 형태여야 절 검사에 의미가 있다.
  let evidenceBase;
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-clause-"));
  try {
    const dir = path.join(tmpBase, "repo");
    buildMultiAuthor(dir);
    evidenceBase = collectGitFacts({
      repoPath: dir,
      selectedIdentities: [OWNER_EMAIL],
      ref: "HEAD",
      maxCommits: 1000,
    }).evidence;
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }

  const bases = {
    career: tracker.readJson(FIXTURE_VALID_REL("career")),
    "knowledge-map": tracker.readJson(FIXTURE_VALID_REL("knowledge-map")),
    "gap-report": tracker.readJson(FIXTURE_VALID_REL("gap-report")),
    evidence: evidenceBase,
  };

  // (1) 대조군 — 기준 인스턴스가 위반 0건이어야 아래 변이 단언이 공허하지 않다.
  //     음수 방향이므로 판독 실패를 **사유 배열로 치환**한다. 빈 배열로 두면 「위반 0건」과
  //     구별되지 않아 대조군이 조용히 PASS하고, 그 순간 아래 절 단언 50건이 전부 공허해진다.
  for (const [layer, inst] of Object.entries(bases)) {
    const schema = schemaOf(layer);
    const blame = blameOf(layer);
    const errors = blame !== "" ? [blame] : validateInstance(schema, inst, schema, "$");
    if (errors.length > 0) for (const e of errors) console.log(`    실제 오류: ${e}`);
    report(errors.length === 0, `대조군: ${layer} 기준 인스턴스가 위반 0건(이게 깨지면 아래 절 단언이 전부 공허해진다)`);
  }

  const firstExcluded = (ev) => ev.commits.find((c) => c.excluded === true);
  const firstIncluded = (ev) => ev.commits.find((c) => c.excluded !== true);

  // 세 L1+ 계층에 공통으로 적용되는 절들. 계층마다 노드 형태가 달라도
  // verification 계약은 동일하므로 같은 표를 세 번 돌린다 — 한 계층의
  // 관측이 다른 계층을 대신하지 못한다(스키마가 세 파일로 복제돼 있다).
  const NODE_CASES = [
    { label: "nodes가 빈 배열", mutate: (i) => { i.nodes = []; }, expect: "minItems(1)" },
    { label: "verification 필드 누락", mutate: (i) => { delete i.nodes[0].verification; }, expect: "required 필드 'verification' 없음" },
    { label: "verification에 미지의 키", mutate: (i) => { i.nodes[0].verification.extra = 1; }, expect: "additionalProperties 위반" },
    { label: "status가 enum 밖", mutate: (i) => { i.nodes[0].verification.status = "bogus"; }, expect: "enum 불일치" },
    { label: "attempts가 상한 초과", mutate: (i) => { i.nodes[0].verification.attempts = 3; }, expect: "maximum(2)" },
    { label: "attempts가 음수", mutate: (i) => { i.nodes[0].verification.attempts = -1; }, expect: "minimum(0)" },
    { label: "reasonCode가 코드 형식이 아님(소문자)", mutate: (i) => { i.nodes[0].verification.reasonCode = "no_support"; }, expect: "pattern 불일치" },
    { label: "not-attempted인데 attempts>0", mutate: (i) => { i.nodes[0].verification = { status: "not-attempted", attempts: 1, reasonCode: null }; }, expect: "const 불일치(기대 0)" },
    { label: "not-attempted인데 reasonCode 있음", mutate: (i) => { i.nodes[0].verification = { status: "not-attempted", attempts: 0, reasonCode: "NO_SUPPORT" }; }, expect: "type 불일치(기대 null)" },
    { label: "refuted인데 attempts≠2", mutate: (i) => { i.nodes[0].verification = { status: "refuted", attempts: 0, reasonCode: "NO_SUPPORT" }; }, expect: "const 불일치(기대 2)" },
    { label: "refuted인데 reasonCode가 null", mutate: (i) => { i.nodes[0].verification = { status: "refuted", attempts: 2, reasonCode: null }; }, expect: "type 불일치(기대 string)" },
    { label: "verified인데 reasonCode 있음", mutate: (i) => { i.nodes[0].verification = { status: "verified", attempts: 0, reasonCode: "NO_SUPPORT" }; }, expect: "type 불일치(기대 null)" },
    // 게이트 C-2 후속 — basis:"external" 표현 가능성 수정(2026-08-19).
    // 세 계층 모두에 externalUrl 프로퍼티와 조건절이 들어갔으므로 세 계층
    // 각각에서 관측한다(한 계층의 관측이 다른 계층을 대신하지 못한다 —
    // 스키마가 네 파일로 복제돼 있다).
    { label: "basis:external인데 externalUrl 없음", mutate: (i) => { i.nodes[0].basis = "external"; delete i.nodes[0].externalUrl; }, expect: "required 필드 'externalUrl' 없음" },
    // evidence 비움 조건절을 external까지 넓혔다고 해서 아무 basis나
    // 통과하면 안 된다 — AC-12의 이빨이 남아 있는지 확인한다.
    { label: "evidence가 비었는데 basis가 inference", mutate: (i) => { i.nodes[0].evidence = []; i.nodes[0].basis = "inference"; }, expect: "enum 불일치" },
  ];

  const EVIDENCE_CASES = [
    { label: "excluded 커밋에 authorEmail 유출", mutate: (i) => { firstExcluded(i).authorEmail = "alice@example.test"; }, expect: "authorEmail: type 불일치(기대 null)" },
    { label: "excluded 커밋에 subject 유출", mutate: (i) => { firstExcluded(i).subject = "feat: alice adds b"; }, expect: "subject: type 불일치(기대 null)" },
    { label: "excluded 커밋에 coAuthors 유출", mutate: (i) => { firstExcluded(i).coAuthors = ["Co-authored-by: Carol <c@x.test>"]; }, expect: "coAuthors: maxItems(0)" },
    { label: "대칭 절: 비-excluded 커밋의 authorEmail이 null", mutate: (i) => { firstIncluded(i).authorEmail = null; }, expect: "authorEmail: type 불일치(기대 string)" },
    { label: "대칭 절: 비-excluded 커밋의 subject가 null", mutate: (i) => { firstIncluded(i).subject = null; }, expect: "subject: type 불일치(기대 string)" },
  ];

  const run = (layer, cases) => {
    const schema = schemaOf(layer);
    const blame = blameOf(layer);
    for (const c of cases) {
      // **판독에 실패하면 `c.mutate`를 부르지 않는다.** `structuredClone(null)`은 예외를 던지지
      // 않고 null을 돌려주므로, 그 뒤의 `i.nodes[0].verification = …` 같은 대입이 TypeError로
      // 터져 섹션 전체를 중단시킨다 — 이 회차가 닫으려는 바로 그 형태다. 루프는 그대로 돌려
      // **`report` 호출 횟수를 보존**한다(케이스 수만큼 FAIL이 남아야 총량이 유지된다).
      let errors;
      if (blame !== "") {
        errors = [blame];
      } else {
        const inst = structuredClone(bases[layer]);
        c.mutate(inst);
        errors = validateInstance(schema, inst, schema, "$");
      }
      // 양수 방향이라 별도 게이트가 필요 없다 — 사유 문자열에는 `c.expect`가 들어 있지 않으므로
      // `some(...)`이 false가 되어 자연히 FAIL한다.
      const ok = errors.some((e) => e.includes(c.expect));
      if (!ok) console.log(`    실제 오류: ${JSON.stringify(errors)}`);
      report(ok, `${layer}: ${c.label} → '${c.expect}' 발화`);
    }
  };

  for (const layer of ["career", "knowledge-map", "gap-report"]) run(layer, NODE_CASES);
  run("evidence", EVIDENCE_CASES);

  // --- 게이트 C-2 후속의 **허용 방향** 관측 -------------------------------
  // 위 변이 케이스들은 "금지된 것이 FAIL하는가"만 본다. 이번 수정의 핵심은
  // 오히려 **허용**이다 — 「URL 출처만 있고 커밋 근거는 없는 노드」가 이제
  // 표현 가능해야 한다. 수정 전에는 evidence 비움 조건절이 basis를
  // insufficient로 못 박아 이 인스턴스가 FAIL했다. 이 단언이 없으면
  // 조건절을 되돌려도 아무도 모른다(금지 방향만 관측하면 완화를 못 잡는다).
  for (const layer of ["career", "knowledge-map", "gap-report"]) {
    const schema = schemaOf(layer);
    const blame = blameOf(layer);
    let errors;
    if (blame !== "") {
      errors = [blame];
    } else {
      const inst = structuredClone(bases[layer]);
      inst.nodes[0].evidence = [];
      inst.nodes[0].basis = "external";
      inst.nodes[0].externalUrl = "https://developer.mozilla.org/en-US/docs/Web/HTTP";
      errors = validateInstance(schema, inst, schema, "$");
    }
    if (errors.length > 0) console.log(`    실제 오류: ${JSON.stringify(errors)}`);
    report(errors.length === 0, `${layer}: 커밋 근거 없이 URL 출처만 있는 external 노드가 스키마를 통과함(표현 가능성)`);
  }
}

// ---------------------------------------------------------------------------
// 시크릿 스캔 절 단위 오라클 — 게이트 C-1 / 심사 C-2 / 구현 7단계 (e)
//
// scripts/lib/secret-scan.mjs가 넣은 판정 규칙을 **절 하나씩 격리해** 관측한다.
// "영역당 한 번"으로는 부족하다는 것이 직전 세션에서 실측됐다(스키마 제약 35개
// 중 32개가 미관측인 채 "관측됐다"고 보고됐고 적대 검증이 반증했다).
//
// 이 오라클이 겨냥하는 회귀는 셋이고, 각각 다른 방향이다:
//   (1) **미탐** — redact.mjs의 패턴 6종이 각각 실제로 발화하는가.
//   (2) **오탐** — 40자 hex 커밋 SHA와 format:email 필드의 합법 이메일이
//       통과하는가. 오탐 회귀는 정탐 테스트로 절대 잡히지 않는다(A-10과 동일
//       근거). 오탐이 생기면 정상 산출물이 빨갛게 되고, 그러면 남는 선택지가
//       "게이트를 끄는 것"뿐이 된다.
//   (3) **과잉 면제** — 이게 가장 무섭고, 직전 세션에서 실제로 생존했던 변이의
//       형태다(언어 린트의 origin 제외를 "노드 하나가 user면 파일 전체 건너뜀"
//       으로 넓힌 변이가 픽스처 쌍의 배치 때문에 살아남았다). 여기서는 세
//       방향으로 닫는다 — format:email 필드에 AWS 키를 넣으면 여전히 FAIL,
//       합법 이메일에 시크릿을 덧붙이면 여전히 FAIL, 같은 이메일을 면제 대상이
//       아닌 경로에 넣으면 FAIL.
// ---------------------------------------------------------------------------
function runSecretScanOracleSmoke() {
  console.log("[시크릿 스캔 절 단위 오라클] scripts/lib/secret-scan.mjs — 패턴별 탐지 · 오탐 · 과잉 면제 3방향");

  // 세 판독을 **두 그룹으로 갈라 귀책한다.** career 그룹(스키마 + 픽스처)과 evidence 그룹은
  // 서로 독립이라 한쪽이 없어도 다른 쪽 단언은 영향받지 않아야 한다.
  //
  // **`evidenceBase`는 이 사이트가 읽는 파일이 아니다** — 아래에서 buildMultiAuthor +
  // collectGitFacts로 런타임에 합성한다. 그러므로 evidence 그룹의 실패 원인은 스키마 하나뿐이고,
  // 사유에 `fixtures-valid/evidence.json` 같은 실재하지 않는 파일을 적으면 오도가 된다.
  const tracker = makeReadTracker();
  const careerSchema = tracker.readJson(SCHEMA_REL("career"));
  const evidenceSchema = tracker.readJson(SCHEMA_REL("evidence"));
  const careerBase = tracker.readJson(FIXTURE_VALID_REL("career"));
  const careerBlame = tracker.blameFor([SCHEMA_REL("career"), FIXTURE_VALID_REL("career")]);
  const evidenceBlame = tracker.blameFor([SCHEMA_REL("evidence")]);
  const careerOk = careerBlame === "";
  const evidenceOk = evidenceBlame === "";

  /**
   * career 변이 케이스 1건. 판독 실패 시 **호출 자체를 건너뛰고 null**을 돌려준다.
   *
   * 골격 객체로 대체하지 않는 이유: 그 골격을 `scanForSecrets`에 넘기면 위반 0건이 나와
   * 「시크릿 없음」과 「관측하지 못함」이 같아진다 — 이 아크가 닫아 온 거짓 초록 그대로다.
   * `structuredClone(null)`은 예외를 던지지 않고 null을 돌려주므로, 뒤이은 필드 대입이
   * TypeError로 섹션을 중단시킨다. 그 대입을 아예 실행하지 않는 것이 요점이다.
   */
  const careerCase = (mutate) => {
    if (!careerOk) return null;
    const inst = structuredClone(careerBase);
    mutate(inst);
    return scanForSecrets(careerSchema, inst);
  };

  // evidence 기준 인스턴스는 손으로 쓰지 않고 실제 수집 결과를 쓴다 —
  // commits[].authorEmail 면제 경로가 "문자열 authorEmail이 실제로 존재하는"
  // 원장에서 관측돼야 공허하지 않다. selectedIdentities에 OWNER_EMAIL을 주면
  // 그 저자의 커밋이 excluded:false로 남아 authorEmail이 문자열이 된다.
  let evidenceBase;
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-secretscan-"));
  try {
    const dir = path.join(tmpBase, "repo");
    buildMultiAuthor(dir);
    evidenceBase = collectGitFacts({
      repoPath: dir,
      selectedIdentities: [OWNER_EMAIL],
      ref: "HEAD",
      maxCommits: 1000,
    }).evidence;
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }

  // --- 대조군 -------------------------------------------------------------
  // 기준 인스턴스가 위반 0건이어야 아래 변이 단언이 공허하지 않다.
  // **음수 방향이라 게이트가 필수다.** 판독에 실패하면 스캔을 못 돌리고, 그 결과를 「위반 0건」과
  // 구별하지 않으면 이 대조군이 조용히 PASS한다. 아래 양수 방향 단언들(`Boolean(hit)`)은
  // null에서 자동으로 false가 되므로 게이트가 필요 없다 — 그 비대칭이 이 회차의 반복 주제다.
  if (!careerOk) console.log(`    실제: ${careerBlame}`);
  report(
    careerOk && scanForSecrets(careerSchema, careerBase).length === 0,
    "대조군: career 기준 인스턴스가 위반 0건(40자 hex 해시 · format:email 이메일 포함)"
  );

  const evidenceIncluded = evidenceBase.commits.filter((c) => typeof c.authorEmail === "string");
  // 이 단언이 없으면 아래 evidence 대조군이 "authorEmail이 애초에 하나도
  // 없어서" 공허하게 참일 수 있다 — 직전 세션의 coAuthors 사고와 같은 형태다.
  report(
    evidenceIncluded.length >= 1,
    `선결: evidence 기준 인스턴스에 authorEmail이 문자열인 커밋이 최소 1건 존재(실제 ${evidenceIncluded.length}건) — 없으면 아래 면제 관측이 공허해진다`
  );
  // 바로 위 「선결」 단언은 `evidenceBase`의 **구조만** 보므로 스키마 판독과 무관하다 —
  // 두 전제를 묶지 않는다. 이 대조군만 evidence 그룹에 귀책한다.
  if (!evidenceOk) console.log(`    실제: ${evidenceBlame}`);
  report(
    evidenceOk && scanForSecrets(evidenceSchema, evidenceBase).length === 0,
    "대조군: 실제 수집한 evidence 기준 인스턴스가 위반 0건(commits[].authorEmail 면제 경로 실행됨)"
  );

  // --- (1) 패턴별 탐지 ----------------------------------------------------
  // redact.mjs의 PATTERNS 6종에 1:1 대응한다. 하나라도 빠지면 그 패턴은
  // 이 새 검사 경로에서 관측되지 않은 것이다.
  const PATTERN_CASES = [
    { name: "aws-access-key", payload: "AKIAIOSFODNN7EXAMPLE" },
    { name: "aws-secret-key", payload: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    { name: "private-key-block", payload: "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQ\n-----END RSA PRIVATE KEY-----" },
    { name: "jwt", payload: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.QWxpY2VTaWduYXR1cmU" },
    { name: "password-field", payload: "password=hunter2correcthorse" },
    { name: "email", payload: "colleague@example.com" },
  ];

  for (const c of PATTERN_CASES) {
    const violations = careerCase((i) => { i.nodes[0].text = `이 작업에서 설정값을 다뤘다: ${c.payload} 관련 처리.`; });
    const hit = violations?.find((v) => v.path === "nodes[0].text" && v.patterns.includes(c.name));
    if (!hit) console.log(`    실제 위반: ${careerBlame || JSON.stringify(violations)}`);
    report(Boolean(hit), `패턴 '${c.name}'이 nodes[0].text에서 발화`);
  }

  // --- (2) 오탐 방향 ------------------------------------------------------
  // A-10의 "40자 hex 커밋 SHA는 마스킹하지 않는다" 단언을 이 새 경로로
  // 이식한다. 이 도구의 산출물은 커밋 해시로 가득하므로, 이 예외가 깨지면
  // 정상 산출물 전부가 시크릿 유출로 판정된다.
  {
    const violations = careerCase((i) => { i.nodes[0].text = `근거 커밋 a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4 에서 처리했다.`; });
    // **겨냥한 경로의 위반만** 본다. 전체 위반 수(=== 0)로 판정하면 같은
    // 인스턴스의 selectedIdentities 이메일이 오염원으로 섞여, 면제 로직을
    // 건드리는 변이에서도 이 단언이 함께 깨진다(실측: M1에서 그렇게 깨졌다).
    // 그러면 이 단언이 무엇을 관측하는 것인지가 흐려진다.
    // 음수 방향 — `violations`가 null이면 `textViolation`도 undefined라 `!textViolation`이
    // **우연히 true**가 된다. `careerOk` 게이트가 그 거짓 초록을 막는다.
    const textViolation = violations?.find((v) => v.path === "nodes[0].text");
    if (textViolation || !careerOk) console.log(`    실제 위반: ${careerBlame || JSON.stringify(textViolation)}`);
    report(careerOk && !textViolation, "무오탐: free-text 안의 40자 hex 커밋 SHA는 위반이 아님(A-10 단언의 새 경로 이식)");
  }

  // --- (3) 과잉 면제 방지 — 이 셋이 핵심이다 ------------------------------
  // (3-a) 면제는 **필드 단위가 아니라 (필드 × 패턴) 단위**다. format:email
  //       경로에 AWS 키를 넣으면 email 패턴만 면제될 뿐 aws 패턴은 발화해야
  //       한다. 필드 단위로 면제하면 그 필드가 통째로 사각지대가 된다.
  {
    // 페이로드가 **값 전체로 단일 이메일이면서 동시에 AWS 키 패턴도 발화**해야
    // 한다. 그래야 면제 분기에 실제로 진입하고, 그 분기 안에서 email 히트만
    // 걸러지는지를 관측할 수 있다.
    //
    // 첫 판은 `["AKIAIOSFODNN7EXAMPLE"]`(이메일이 아닌 값)을 썼고, 그 값은
    // isSingleEmail이 false라 **면제 분기에 아예 들어가지 않았다** — 변이는
    // 분기 안에 있으므로 단언이 통과해 버렸다(실측: 면제를 필드 단위로 넓히는
    // 변이에서 FAIL 0건). 핸드오프가 금지한 자기충족 테스트의 형태 그대로였다.
    const violations = careerCase((i) => { i.coverage.exclusions.selectedIdentities = ["AKIAIOSFODNN7EXAMPLE@example.com"]; });
    const hit = violations?.find(
      (v) => v.path === "coverage.exclusions.selectedIdentities[0]" && v.patterns.includes("aws-access-key")
    );
    if (!hit) console.log(`    실제 위반: ${careerBlame || JSON.stringify(violations)}`);
    report(
      Boolean(hit),
      "과잉 면제 방지 (a): 값 전체가 단일 이메일이라 면제 분기에 진입해도 aws-access-key는 살아남음(면제는 email 패턴 한정)"
    );
  }

  // (3-b) 면제 조건은 "값 **전체**가 단일 이메일일 때"다. 합법 이메일에
  //       시크릿을 덧붙이는 회피를 막는다. 이 조건이 없으면 email 패턴이
  //       한 번이라도 맞는 값은 통째로 면제된다.
  {
    const violations = careerCase((i) => { i.coverage.exclusions.selectedIdentities = ["dev@example.com AKIAIOSFODNN7EXAMPLE"]; });
    const hit = violations?.find((v) => v.patterns.includes("email"));
    if (!hit) console.log(`    실제 위반: ${careerBlame || JSON.stringify(violations)}`);
    report(
      Boolean(hit),
      "과잉 면제 방지 (b): format:email 경로라도 값 전체가 단일 이메일이 아니면 email 면제가 적용되지 않음"
    );
  }

  // (3-c) 면제는 **경로 단위**다. 같은 이메일 문자열이라도 면제 대상이 아닌
  //       경로(nodes[].text)에 있으면 위반이다. 면제가 전역 값 집합으로
  //       구현되면 이 단언이 깨진다.
  {
    // (c-1) 값 **전체가 단일 이메일**인 경우. 이 형태라야 면제 분기의 진입
    //       조건 중 `isSingleEmail`은 만족하고 경로 조건만 불만족하게 되어,
    //       "경로 검사를 빼면 전역 면제가 된다"는 변이가 관측된다.
    //
    //       첫 판은 (c-2) 형태(산문에 이메일이 박힌 값)만 두었는데, 그 값은
    //       isSingleEmail이 false라 경로 조건을 지워도 여전히 면제되지 않아
    //       단언이 통과했다(실측: 면제를 전역으로 넓히는 변이에서 FAIL 0건).
    //       두 형태는 서로를 대신하지 못한다.
    const v1 = careerCase((i) => { i.nodes[0].text = "dev@example.com"; });
    const hit1 = v1?.find((v) => v.path === "nodes[0].text" && v.patterns.includes("email"));
    if (!hit1) console.log(`    실제 위반: ${careerBlame || JSON.stringify(v1)}`);
    report(
      Boolean(hit1),
      "과잉 면제 방지 (c-1): 값 전체가 단일 이메일이어도 format:email이 아닌 경로(nodes[].text)에서는 위반(면제는 경로 단위)"
    );

    // (c-2) 실제 유출이 나타날 법한 형태 — 산문 안에 동료 이메일이 박힌 경우.
    const v2 = careerCase((i) => { i.nodes[0].text = `동료 dev@example.com 와 함께 작업했다.`; });
    const hit2 = v2?.find((v) => v.path === "nodes[0].text" && v.patterns.includes("email"));
    if (!hit2) console.log(`    실제 위반: ${careerBlame || JSON.stringify(v2)}`);
    report(Boolean(hit2), "과잉 면제 방지 (c-2): 산문 안에 박힌 동료 이메일도 free-text 경로에서는 위반");
  }

  // --- 면제 경로 수집기가 allOf/then 안의 선언까지 보는가 -----------------
  // evidence.schema.json은 excluded:false 조건절의 then 안에서도 authorEmail을
  // 재선언한다. collectEmailFormatPaths가 properties/items만 순회하면 그 선언은
  // 수집되지 않는다. 현재 evidence 스키마는 base properties에도 같은 선언을
  // 두고 있어 실물로는 관측되지 않으므로, **그 분기만 격리한 합성 스키마**로
  // 관측한다 — 이렇게 하지 않으면 allOf/then 순회는 "선언만 되고 관측되지 않은"
  // 코드가 된다.
  {
    const synthetic = {
      type: "object",
      properties: { holder: { type: "object", properties: {} } },
      allOf: [
        {
          then: {
            properties: {
              holder: { type: "object", properties: { addr: { type: "string", format: "email" } } },
            },
          },
        },
      ],
    };
    const paths = collectEmailFormatPaths(synthetic).map((p) => p.join("."));
    report(
      paths.includes("holder.addr"),
      `면제 경로 수집기가 allOf[].then 안의 format:email까지 수집(실제: ${JSON.stringify(paths)})`
    );
    const inst = { holder: { addr: "dev@example.com" } };
    report(
      scanForSecrets(synthetic, inst).length === 0,
      "allOf[].then 안에서만 선언된 format:email 경로도 면제가 적용됨"
    );
  }

  // --- evidence 계층에서도 탐지가 작동하는가 ------------------------------
  // career 계층에서만 관측하면 "다른 계층은 스캔 대상에서 빠졌다"는 회귀를
  // 못 잡는다. 스캔은 스키마 비의존적으로 모든 문자열을 순회하므로 계층이
  // 늘어나도 자동으로 덮이지만, 그 성질 자체를 한 번은 관측한다.
  {
    const inst = structuredClone(evidenceBase);
    const target = inst.commits.find((c) => typeof c.subject === "string");
    report(Boolean(target), "선결: evidence 기준 인스턴스에 subject가 문자열인 커밋이 존재");
    if (target) {
      // 바로 위 「선결」은 `evidenceBase`의 구조만 보므로 손대지 않는다 — 스키마 판독과
      // 무관한 전제이고, 둘을 묶으면 어느 쪽이 무너졌는지가 뭉개진다.
      target.subject = `fix: rotate AKIAIOSFODNN7EXAMPLE`;
      const violations = evidenceOk ? scanForSecrets(evidenceSchema, inst) : null;
      const hit = violations?.find((v) => v.patterns.includes("aws-access-key"));
      if (!hit) console.log(`    실제 위반: ${evidenceBlame || JSON.stringify(violations)}`);
      report(Boolean(hit), "evidence 계층의 commits[].subject에 남은 AWS 키도 탐지됨");
    }
  }

  // --- 오류 메시지가 시크릿을 재유출하지 않는가 ---------------------------
  // 유출을 막겠다는 검사기가 자기 오류 메시지로 시크릿을 CI 로그에 다시
  // 흘리면 방어가 아니라 두 번째 유출 경로다.
  {
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const violations = careerCase((i) => { i.nodes[0].text = `키 ${secret} 를 사용했다.`; });
    const excerpts = (violations ?? []).map((v) => v.excerpt).join("\n");
    if (!careerOk) console.log(`    실제: ${careerBlame}`);
    report(
      careerOk && violations.length > 0 && !excerpts.includes(secret) && excerpts.includes("[REDACTED:aws-access-key]"),
      "위생: 위반 메시지의 excerpt가 원문 시크릿이 아니라 마스킹된 형태를 담음"
    );
  }

  // --- FULL_EMAIL_RE 복제본이 스키마 검증기와 갈리지 않는가 ---------------
  // secret-scan.mjs는 schema-validate.mjs의 FORMAT_CHECKERS.email 리터럴을
  // 복제해 갖고 있다(그 상수가 export되지 않았고, export 추가는 슬라이스 A
  // 파일 수정이라 slice_plan.md의 예외 3건 밖이다). 두 리터럴이 갈리면
  // "스키마는 이메일로 인정하는데 스캐너는 아니라 오탐" 또는 그 반대가
  // 생기므로, 경계값으로 두 판정이 일치하는지 관측한다.
  {
    const samples = [
      "dev@example.com",
      "76617183+Jugger0716@users.noreply.github.com",
      "not-an-email",
      "a@b.c",
      "two words@example.com",
      "no-at-sign.example.com",
    ];
    const schemaVerdicts = samples.map((s) => {
      const errs = validateInstance({ type: "string", format: "email" }, s, {}, "$");
      return errs.length === 0;
    });
    // 스캐너 쪽은 술어를 **직접** 부른다. 간접 관측("format:email 경로에 넣고
    // 위반이 나는지")은 쓰지 않는다 — redact.mjs의 email 패턴이 애초에
    // 발화하지 않는 값(`a@b.c`: 그 패턴은 TLD를 `[A-Za-z]{2,}`로 요구한다)에서
    // "면제되지 않음"과 "면제할 것이 없음"이 구별되지 않아 거짓 FAIL이 난다.
    // 이 오라클의 첫 판이 정확히 그렇게 실패했고, 그건 스캐너가 아니라 측정
    // 방법의 결함이었다.
    const scannerVerdicts = samples.map((s) => isSingleEmail(s));
    const agree = samples.every((s, i) => schemaVerdicts[i] === scannerVerdicts[i]);
    if (!agree) {
      console.log(`    schema : ${JSON.stringify(schemaVerdicts)}`);
      console.log(`    scanner: ${JSON.stringify(scannerVerdicts)}`);
    }
    report(agree, `이메일 판정 드리프트 없음: schema-validate.mjs와 secret-scan.mjs가 경계값 ${samples.length}종에서 동일 판정`);
  }
}

// ---------------------------------------------------------------------------
// (f)축 allow-list 절 단위 오라클 — 게이트 C-2 / 심사 M-1 / 구현 8단계 (a)
//
// knowledge-map.schema.json의 externalUrl description은 "allow-list 대조는
// 스크립트가 런타임에 검사한다"고 **선언**해 놓고 그 코드가 레포에 0곳이었다.
// 이 오라클은 그 집행이 실재하며, 특히 **문자열 prefix 대조였다면 통과했을
// 호스트 연장 우회**를 막는지를 관측한다.
//
// checkExternalSources는 nodes[].basis/id/externalUrl만 읽으므로 인스턴스를
// 손으로 최소 형태로 만든다(스키마 유효성은 이 함수의 관심사가 아니다).
// 다만 그것만 두면 "함수는 맞는데 verifyEvidence에 배선되지 않은" 회귀를
// 못 잡으므로, 마지막에 실제 verifyEvidence 경로로 한 번 더 관측한다.
// ---------------------------------------------------------------------------
function runExternalSourceOracleSmoke() {
  console.log("[allow-list 절 단위 오라클] verify-evidence (f)축 — 호스트 연장 우회 · 다운그레이드 · 경로 prefix · fail-closed");

  const SOURCES = path.join(REPO_ROOT, "references", "sources.json");
  const real = loadSourceAllowlist(SOURCES);

  // 정본 allow-list 파일 자체가 유효해야 아래 단언들이 의미를 갖는다.
  report(real.ok && real.entries.length >= 1, `선결: references/sources.json이 로드됨(ok=${real.ok}, 항목 ${real.entries.length}개)`);

  const nodeOf = (basis, externalUrl) => ({
    nodes: [{ id: "km:001", basis, ...(externalUrl === undefined ? {} : { externalUrl }) }],
  });
  const run = (inst, allowlist = real) => checkExternalSources({ "knowledge-map": inst }, allowlist);

  const CASES = [
    { label: "allow-list 안의 URL", url: "https://developer.mozilla.org/en-US/docs/Web/HTTP", expect: null },
    { label: "경로 prefix 안쪽(nodejs.org/docs/)", url: "https://nodejs.org/docs/latest/api/fs.html", expect: null },
    // origin 정규화 — 대소문자와 기본 포트가 달라도 같은 origin이다. 문자열
    // 대조였다면 여기서 오탐이 났을 것이다.
    { label: "origin 정규화(대소문자·기본 포트)", url: "https://Developer.Mozilla.ORG:443/en-US/docs/", expect: null },
    // 이 케이스가 이 축의 핵심이다. 문자열 prefix 대조라면
    // "https://developer.mozilla.org"로 시작하므로 **통과했을** 값이다.
    { label: "호스트 연장 우회(.evil.com)", url: "https://developer.mozilla.org.evil.com/en-US/docs/", expect: "EXTERNAL_URL_NOT_IN_ALLOWLIST" },
    { label: "allow-list 밖 도메인", url: "https://random-blog.example.com/post/1", expect: "EXTERNAL_URL_NOT_IN_ALLOWLIST" },
    { label: "같은 호스트지만 경로 prefix 밖(nodejs.org/blog/)", url: "https://nodejs.org/blog/release/v24", expect: "EXTERNAL_URL_NOT_IN_ALLOWLIST" },
    { label: "http 다운그레이드", url: "http://developer.mozilla.org/en-US/docs/", expect: "EXTERNAL_URL_MALFORMED" },
    { label: "URL이 아닌 문자열", url: "MDN 어딘가에서 봤음", expect: "EXTERNAL_URL_MALFORMED" },
    { label: "file: 스킴", url: "file:///etc/passwd", expect: "EXTERNAL_URL_MALFORMED" },
  ];

  for (const c of CASES) {
    const { violations, checked } = run(nodeOf("external", c.url));
    const gotCode = violations[0]?.code ?? null;
    const ok = checked === 1 && gotCode === c.expect;
    if (!ok) console.log(`    실제: checked=${checked} violations=${JSON.stringify(violations)}`);
    report(ok, `(f)축 ${c.label} → ${c.expect ?? "위반 없음"}`);
  }

  // basis:"external"인데 externalUrl 자체가 없는 경우. career/gap-report/plan
  // 노드에는 externalUrl 프로퍼티가 아예 없고 additionalProperties:false라
  // 담을 자리조차 없으므로, 그 계층에서 external을 선언하면 여기서 잡힌다.
  {
    const { violations, checked } = run(nodeOf("external", undefined));
    const ok = checked === 1 && violations[0]?.code === "EXTERNAL_URL_MISSING";
    if (!ok) console.log(`    실제: checked=${checked} violations=${JSON.stringify(violations)}`);
    report(ok, "(f)축 basis:external인데 externalUrl 없음 → EXTERNAL_URL_MISSING");
  }

  // 검사 대상 한정: basis가 external이 아닌 노드는 URL이 무엇이든 보지 않는다.
  // checked===0으로 그것을 관측한다 — 이 카운터가 없으면 "위반 0건"이
  // "통과"인지 "검사 안 함"인지 구별되지 않는다.
  {
    const inst = { nodes: [{ id: "km:001", basis: "inference", externalUrl: "https://random-blog.example.com/x" }] };
    const { violations, checked } = run(inst);
    report(checked === 0 && violations.length === 0, "(f)축 basis가 external이 아닌 노드는 대조 대상이 아님(checked=0)");
  }

  // fail-closed 양방향. allow-list를 못 읽었을 때:
  //   - external 노드가 0건이면 무해해야 한다(external을 안 쓰는 산출물까지
  //     막으면 게이트를 끄게 만든다).
  //   - external 노드가 1건이라도 있으면 위반이어야 한다("검증할 수 없음"을
  //     "통과"로 바꾸지 않는다).
  {
    const broken = loadSourceAllowlist(path.join(REPO_ROOT, "references", "__does-not-exist__.json"));
    report(!broken.ok && broken.code === "EXTERNAL_ALLOWLIST_UNREADABLE", "allow-list 부재 → loadSourceAllowlist가 ok=false");

    const noExternal = checkExternalSources({ "knowledge-map": nodeOf("inference", undefined) }, broken);
    report(
      noExternal.violations.length === 0,
      "fail-closed (a): allow-list를 못 읽어도 external 노드가 0건이면 위반 아님"
    );

    const withExternal = checkExternalSources(
      { "knowledge-map": nodeOf("external", "https://developer.mozilla.org/en-US/docs/") },
      broken
    );
    report(
      withExternal.violations.length === 1 && withExternal.violations[0].code === "EXTERNAL_ALLOWLIST_UNREADABLE",
      "fail-closed (b): allow-list를 못 읽었는데 external 노드가 있으면 위반(허용 목록에 있을 URL이어도)"
    );
  }

  // --- 배선 관측 — verifyEvidence 경로에서도 실제로 FAIL이 되는가 ----------
  // 위 단언들은 checkExternalSources를 직접 부른다. 그것만으로는 이 축이
  // verifyEvidence의 hasFailures 산식과 리포트에 실제로 연결됐는지 알 수
  // 없다(구현 6단계의 fail-open 사고가 정확히 그 형태였다 — 검사는 있는데
  // status 산식이 그것을 보지 않았다).
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-allowlist-"));
  try {
    const dir = path.join(tmpBase, "repo");
    buildMultiAuthor(dir);
    const evidence = collectGitFacts({
      repoPath: dir,
      selectedIdentities: [OWNER_EMAIL],
      ref: "HEAD",
      maxCommits: 1000,
    }).evidence;

    const mk = (url) => ({ nodes: [{ id: "km:001", basis: "external", externalUrl: url, evidence: [] }] });

    const bad = verifyEvidence({
      repoPath: dir,
      evidence,
      selectedIdentities: [OWNER_EMAIL],
      artifactsByLayer: { "knowledge-map": mk("https://random-blog.example.com/x") },
      sourcesPath: SOURCES,
    });
    const badOk =
      bad.ok === false &&
      bad.status === "FAIL" &&
      bad.summary.externalSourceViolations === 1 &&
      bad.summary.externalSourcesChecked === 1 &&
      exitCodeForReport(bad) === 1;
    if (!badOk) console.log(`    실제: ok=${bad.ok} status=${bad.status} summary=${JSON.stringify(bad.summary)}`);
    report(badOk, "배선: allow-list 밖 URL이 verifyEvidence를 status=FAIL·exit 1로 만든다");

    const good = verifyEvidence({
      repoPath: dir,
      evidence,
      selectedIdentities: [OWNER_EMAIL],
      artifactsByLayer: { "knowledge-map": mk("https://developer.mozilla.org/en-US/docs/Web/HTTP") },
      sourcesPath: SOURCES,
    });
    const goodOk = good.ok === true && good.summary.externalSourcesChecked === 1 && good.summary.externalSourceViolations === 0;
    if (!goodOk) console.log(`    실제: ok=${good.ok} status=${good.status} summary=${JSON.stringify(good.summary)}`);
    report(goodOk, "배선 대조군: allow-list 안 URL은 통과하고 checked=1로 집계된다(공허하지 않음)");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// store.mjs IO 계약 오라클 — 게이트 B-1·B-2 / 심사 M-5 / 구현 7단계 (c)(d)
//
// 이 계약이 존재하는 이유는 두 가지이고, 둘 다 "없으면 조용히 깨지는" 종류다:
//   (1) `writeJsonAtomic`이 두 곳에 복사되면 AC-16의 원자성 계약이 갈린다.
//       추출이 실제로 일어났는지(= collect-git-facts.mjs가 사본을 갖고 있지
//       않은지)를 소스 스캔으로 관측한다 — 함수 동작만 보면 사본이 남아
//       있어도 전부 통과한다.
//   (2) 각 스킬이 제각기 path.relative를 부르면 Windows에서 백슬래시가
//       산출물에 섞인다. 이건 Windows에서만 나타나는 결함이라 리눅스 CI만
//       도는 프로젝트였다면 영영 안 보였을 것이다 — 이 레포는 Windows가
//       주 개발 환경이므로 여기서 고정한다.
// ---------------------------------------------------------------------------
function runStoreIoContractSmoke() {
  console.log("[store IO 계약 오라클] writeJsonAtomic 단일 구현 · 상대경로 POSIX 고정 · 부재/손상 무예외");

  // (1) 추출이 실제로 일어났는가 — 소스 스캔.
  {
    // **판독 실패를 그대로 흘리면 거짓 초록이 난다.** `collector`가 null이면 `hasOwnDefinition`이
    // false로 평가되어 `!hasOwnDefinition`이 **우연히 true**가 된다 — 「사본이 없다」와 「파일을
    // 못 읽었다」의 결과가 같아지는, 이 레포가 실측한 거짓 초록의 정확한 형태다. 그래서 부정형
    // 단언에는 판독 성공을 **게이트로 앞세운다**. 긍정형(`importsShared`)은 null에서 이미 false다.
    const { text: collector, error: collectorError } = readRepoTextSafe("scripts/collect-git-facts.mjs");
    if (collectorError !== null) console.log(`    실제: ${collectorError}`);
    const hasOwnDefinition = collector !== null && /^function writeJsonAtomic\(/m.test(collector);
    const importsShared = collector !== null && /import \{[^}]*\bwriteJsonAtomic\b[^}]*\} from "\.\/lib\/store\.mjs";/.test(collector);
    report(collector !== null && !hasOwnDefinition, "collect-git-facts.mjs에 writeJsonAtomic 자체 정의가 남아 있지 않음(사본 금지)");
    report(importsShared, "collect-git-facts.mjs가 store.mjs의 writeJsonAtomic을 import해 쓴다");
  }

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-storeio-"));
  try {
    // (2) 원자적 쓰기 — 최종 파일만 남고 temp 잔여물이 없어야 한다.
    {
      const dir = path.join(tmpRoot, "atomic");
      const p = writeJsonAtomic(dir, "state.json", { a: 1 });
      const entries = fs.readdirSync(dir);
      report(fs.existsSync(p) && entries.length === 1 && entries[0] === "state.json",
        `writeJsonAtomic이 최종 파일만 남긴다(temp 잔여물 0건, 실제: ${JSON.stringify(entries)})`);
      report(fs.readFileSync(p, "utf8").endsWith("}\n"), "writeJsonAtomic 출력이 개행으로 끝난다(기존 산출물 규약 유지)");
    }

    // (3) 상대경로는 **항상** POSIX 구분자다. 이 단언이 이 계약의 존재 이유다 —
    //     path.relative를 그대로 쓰면 Windows에서 백슬래시가 나온다.
    {
      const root = path.join(tmpRoot, "root");
      const target = path.join(root, "sub", "career.json");
      const rel = toStorageRelative(root, target);
      report(rel === "sub/career.json", `toStorageRelative가 POSIX 구분자를 쓴다(실제: ${JSON.stringify(rel)})`);
      report(!rel.includes("\\"), "toStorageRelative 결과에 백슬래시가 없다(Windows 혼입 방지)");
      const back = fromStorageRelative(root, rel);
      report(path.resolve(back) === path.resolve(target), "fromStorageRelative가 원래 절대경로로 되돌린다(왕복 동치)");
    }

    // (4) 루트 밖 탈출은 막는다 — 조용히 기록하면 다른 기계에서 해석 불가능한
    //     경로가 state.json에 남는다.
    {
      const root = path.join(tmpRoot, "root");
      let threwOut = false;
      try { toStorageRelative(root, path.join(tmpRoot, "outside.json")); } catch { threwOut = true; }
      report(threwOut, "toStorageRelative가 저장 루트 밖 경로를 거부한다");

      let threwBack = false;
      try { fromStorageRelative(root, "../outside.json"); } catch { threwBack = true; }
      report(threwBack, "fromStorageRelative가 '..' 탈출을 거부한다");
    }

    // (5) 부재·손상은 **예외를 던지지 않는다**. 구현 8단계가 "state.json
    //     부재·스키마 부적합이면 예외 중단 없이 재수집 안내 후 정상 종료"를
    //     요구하므로, 던지면 그 요구를 만족시킬 수 없다.
    {
      const root = path.join(tmpRoot, "io");
      fs.mkdirSync(root, { recursive: true });

      // 「예외를 던지지 않는다」를 **겨냥 단언**으로 관측한다. 반환값만 보면
      // 던지는 구현에서는 이 섹션이 통째로 중단되고, 그러면 나머지 단언이
      // 아예 실행되지 않아 무엇이 깨졌는지가 흐려진다(실측: 던지게 만드는
      // 변이에서 섹션 abort 1건만 남았다). try/catch로 감싸 계약 위반을
      // 그 자리에서 이름 붙인다.
      let missing = null, missingThrew = null;
      try { missing = readState(root); } catch (e) { missingThrew = e; }
      report(missingThrew === null, `readState: 파일이 없어도 던지지 않는다(실제: ${missingThrew ? missingThrew.message : "던지지 않음"})`);
      report(missingThrew === null && missing.found === false && missing.error === null,
        "readState: 파일 부재는 found=false·error=null");

      fs.writeFileSync(path.join(root, "state.json"), "{ broken", "utf8");
      let broken = null, brokenThrew = null;
      try { broken = readState(root); } catch (e) { brokenThrew = e; }
      report(brokenThrew === null, `readState: 손상된 JSON에도 던지지 않는다(실제: ${brokenThrew ? brokenThrew.message : "던지지 않음"})`);
      report(brokenThrew === null && broken.found === true && broken.value === null && typeof broken.error === "string",
        "readState: 손상된 JSON은 found=true·value=null·error 문자열");

      const state = {
        schemaVersion: "0.1.0",
        updatedAt: "2026-08-19T00:00:00Z",
        artifacts: { evidence: null, career: null, knowledgeMap: null, gapReport: null, plan: null },
      };
      writeState(root, state);
      const round = readState(root);
      report(round.found === true && round.error === null && JSON.stringify(round.value) === JSON.stringify(state),
        "writeState → readState 왕복이 값을 보존한다");

      // 쓴 state가 실제 스키마를 만족하는지까지 본다 — 계약이 스키마와
      // 어긋나면 이 IO 계층을 쓰는 스킬이 곧바로 부적합 산출물을 만든다.
      const { json: stateSchema, error: stateError } = readRepoJsonSafe(SCHEMA_REL("state"));
      if (stateError !== null) console.log(`    실제: ${stateError}`);
      const errs = stateError !== null ? [stateError] : validateInstance(stateSchema, round.value, stateSchema, "$");
      if (errs.length > 0) console.log(`    실제 오류: ${JSON.stringify(errs)}`);
      report(errs.length === 0, "writeState가 쓴 state.json이 state.schema.json을 만족한다");

      const cfgMissing = readConfig(root);
      report(cfgMissing.found === false, "readConfig: 파일 부재는 found=false(예외 아님)");
      writeConfig(root, { schemaVersion: "0.1.0" });
      report(readConfig(root).value.schemaVersion === "0.1.0", "writeConfig → readConfig 왕복이 값을 보존한다");
    }

    // ---- 저장 경계 판정(콜드 리뷰 Security #11) ----
    {
      const inside = path.join(tmpRoot, STATE_DIR_NAME, "career.json");
      report(checkStorageBoundary(inside) === null, `checkStorageBoundary: ${STATE_DIR_NAME} 세그먼트가 있으면 위반 없음(허용 방향)`);

      const outside = path.join(tmpRoot, "somewhere", "career.json");
      const v = checkStorageBoundary(outside);
      report(typeof v === "string" && v.includes(STATE_DIR_NAME), "checkStorageBoundary: 경계 밖 경로는 위반 메시지를 낸다(금지 방향)");

      // **부분 일치를 통과시키지 않는가.** 문자열 포함으로 구현하면
      // `.devcareer-old`·`my.devcareerX` 같은 이름이 통과한다 — allow-list 대조를
      // 문자열 prefix로 쓰지 말라는 이 레포의 규약과 같은 형태의 실수다.
      const lookalike = path.join(tmpRoot, `${STATE_DIR_NAME}-old`, "career.json");
      report(checkStorageBoundary(lookalike) !== null, "checkStorageBoundary: 이름이 비슷한 세그먼트(.devcareer-old)는 통과시키지 않는다(세그먼트 정확 일치)");
    }
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// AC-15: "같은 레포를 표기만 다른 절대경로(백슬래시/슬래시 혼용·드라이브
// 문자 대소문자·후행 슬래시·레포 하위 디렉터리 지정)로 지정해도 동일한
// <repo-key>가 나온다"는 §6 규칙의 유일한 오라클. 이 오라클이 없으면 §6이
// 문서상으로만 닫힌다(5라운드 연속 미해결이던 항목 — plan_critic_findings.md
// 게이트 A-4/AC-15). 실제 git 레포(임시 디렉터리)를 만들어
// scripts/lib/store.mjs의 computeRepoKeyForPath를 직접 4가지 표기로 호출한다.
function runStoreKeySmoke() {
  console.log("[repo-key 스모크] scripts/lib/store.mjs — AC-15 4표기 동일 키 확인");

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-ac15-repo-"));
  const homeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-ac15-home-"));

  try {
    // 실제 git 레포 최상위(대소문자·구분자는 OS가 mkdtempSync로 돌려준
    // 원래 표기 그대로 — 이후 이걸 4가지로 표기만 바꿔 호출한다).
    execFileSync("git", ["init", "--quiet", tmpBase], { encoding: "utf8" });

    const subDir = path.join(tmpBase, "sub", "dir");
    fs.mkdirSync(subDir, { recursive: true });

    // 표기 1: 모든 백슬래시를 슬래시로 바꾼 형태(백슬래시/슬래시 혼용).
    const notationSlash = tmpBase.replace(/\\/g, "/");

    // 표기 2: 드라이브 문자 대소문자를 뒤집은 형태(Windows에서만 의미가
    // 있다 — POSIX에는 드라이브 문자가 없으므로 원본과 같은 표기가 된다).
    const notationDriveCase = /^[A-Za-z]:/.test(tmpBase)
      ? (tmpBase[0] === tmpBase[0].toLowerCase() ? tmpBase[0].toUpperCase() : tmpBase[0].toLowerCase()) + tmpBase.slice(1)
      : tmpBase;

    // 표기 3: 후행 슬래시를 붙인 형태.
    const notationTrailingSlash = tmpBase.endsWith(path.sep) ? tmpBase : tmpBase + "/";

    // 표기 4: 레포 하위 디렉터리를 지정한 형태(git -C가 상위 toplevel로
    // 스스로 정본화해야 한다).
    const notationSubdir = subDir;

    const notations = {
      원본: tmpBase,
      "백슬래시-슬래시 혼용": notationSlash,
      "드라이브 문자 대소문자": notationDriveCase,
      "후행 슬래시": notationTrailingSlash,
      "레포 하위 디렉터리": notationSubdir,
    };

    const keys = {};
    for (const [label, input] of Object.entries(notations)) {
      const { repoKey } = computeRepoKeyForPath(input, { homeRoot });
      keys[label] = repoKey;
    }

    const uniqueKeys = new Set(Object.values(keys));
    const ok = uniqueKeys.size === 1;
    if (!ok) {
      for (const [label, key] of Object.entries(keys)) {
        console.log(`    ${label}: ${key}`);
      }
    }
    report(ok, "AC-15: 4가지 경로 표기(+레포 하위 디렉터리)가 동일한 <repo-key>로 수렴함");

    // ---- 콜드 리뷰 A-21 대응: store.mjs의 getRepoToplevel이 이제
    // scripts/lib/git.mjs의 runGit()을 통해서만 git을 호출한다. 정상
    // 레포에서 실제 `git rev-parse --show-toplevel`과 같은 값을 내는지,
    // 그리고 비-git 디렉터리에서는 조용히 죽지 않고 명확한 한국어 오류로
    // throw하는지를 관측한다(예전에는 execFileSync 직접 호출이라
    // "Command failed: ..." 영어 원문만 노출됐다). ----
    {
      const expected = execFileSync("git", ["-C", tmpBase, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
      const actual = getRepoToplevel(tmpBase);
      report(actual === expected, `A-21: store.mjs의 getRepoToplevel()이 git.mjs의 runGit() 경유로도 실제 git 출력과 동일(실제: '${actual}')`);
    }
    {
      const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-a21-nongit-"));
      try {
        let threw = null;
        try {
          getRepoToplevel(nonGitDir);
        } catch (e) {
          threw = e;
        }
        const ok2 = threw !== null && /outcome=/.test(threw.message) && /git 레포 최상위 경로를 확인할 수 없습니다/.test(threw.message);
        if (!ok2) console.log(`    실제: threw=${threw ? threw.message : "없음"}`);
        report(ok2, "A-21: 비-git 디렉터리에서 getRepoToplevel()이 3분류(outcome) 정보를 담은 한국어 오류로 throw함");
      } finally {
        fs.rmSync(nonGitDir, { recursive: true, force: true });
      }
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
    fs.rmSync(homeRoot, { recursive: true, force: true });
  }
}

// 콜드 리뷰 A-21 대응: §7 정본 git 프리픽스와 (exit code, stderr) 3분류가
// 예전에는 scripts/lib/git.mjs와 scripts/lib/store.mjs 두 곳에 독립
// 구현돼 있었다(store.mjs는 자체 GIT_FIXED_PREFIX_ARGS + execFileSync
// 직접 호출) — git.mjs만 고쳐도(예: diff.renames 고정 추가) store.mjs
// 사본은 따라가지 않아 4개 게이트가 전부 녹색으로 남았다. store.mjs가
// 이제 git.mjs의 runGit()을 import해서 쓰도록 고쳤으므로(위 repo-key
// 스모크가 동작을 확인한다), 이 스모크는 "프로덕션 코드에 git 프로세스를
// 직접 스폰하는 지점이 scripts/lib/git.mjs 한 곳뿐"이라는 구조적 사실을
// 텍스트 스캔으로 고정한다 — 새 스크립트가 또 다시 자체 git 호출을
// 추가하는 회귀를 잡는다. fixtures/make-fixture.mjs·fixtures/golden/
// compute-sampling-golden.mjs는 "독립 재구현" 의도가 파일 상단에 명시된
// 별도 사본이므로 이 검사 범위 밖이다(A-21 원문이 그렇게 트리아지했다).
function runProductionGitCallSiteSmoke() {
  console.log("[프로덕션 git 호출지 단일화 스모크] A-21 — scripts/*.mjs·scripts/lib/*.mjs 중 git.mjs 자신 외에 직접 git을 스폰하는 곳이 없는지 확인");

  const SPAWN_GIT_RE = /\b(?:execFileSync|spawnSync|execSync|spawn)\s*\(\s*["']git["']/;
  const targets = [
    ...listFilesByExt(path.join(REPO_ROOT, "scripts"), ".mjs"),
    ...listFilesByExt(path.join(REPO_ROOT, "scripts", "lib"), ".mjs"),
  ];
  const uniqueTargets = [...new Set(targets)].filter((f) => path.resolve(f) !== path.resolve(REPO_ROOT, "scripts", "lib", "git.mjs"));

  report(uniqueTargets.length > 0, `사전 확인: scripts/·scripts/lib/ 아래 git.mjs를 제외한 .mjs 파일이 최소 1개 존재함(스캔 대상 확보, 실제 ${uniqueTargets.length}개)`);

  // **판독 실패를 「위반 0건」으로 집계하면 이 스캔은 조용히 통과한다.** 읽지 못한 파일은
  // `SPAWN_GIT_RE`에 걸릴 기회 자체가 없으므로 offenders가 비고, 「직접 스폰 0개」가 참처럼
  // 보인다 — DH-1b가 실측으로 당한 것과 같은 형태다. 그래서 **판독 성공을 별도 전제 단언으로
  // 세운다**(DH-1a/DH-1d의 선례). 두 전제를 한 단언에 묶지 않는 이유는 「어느 경로로
  // 실패했는가」를 로그가 아니라 **라벨**에 고정하기 위해서다.
  const offenders = [];
  const scanReadFailures = [];
  for (const f of uniqueTargets) {
    const { text, error } = readRepoTextSafe(path.relative(REPO_ROOT, f));
    if (error !== null) {
      scanReadFailures.push(error);
      continue;
    }
    if (SPAWN_GIT_RE.test(text)) offenders.push(path.relative(REPO_ROOT, f));
  }
  if (scanReadFailures.length > 0) console.log(`    실제: 판독 실패 ${JSON.stringify(scanReadFailures)}`);
  report(
    scanReadFailures.length === 0,
    `사전 확인: 스캔 대상 ${uniqueTargets.length}건을 전부 판독했다(판독 실패를 '위반 0건'으로 집계하지 않는다)`
  );
  if (offenders.length > 0) console.log(`    직접 git 스폰 발견: ${offenders.join(", ")}`);
  report(offenders.length === 0, "A-21: scripts/lib/git.mjs 외에는 프로덕션 코드에 git 프로세스 직접 스폰 지점이 0개(store.mjs가 runGit()을 재사용)");
}

// ---------------------------------------------------------------------------
// 콜드 리뷰 A-9/A-10 대응: scripts/lib/redact.mjs가 더 이상 import 0건인
// 죽은 코드가 아님을 (1) 순수 함수 단위 정탐/오탐 오라클로, (2) 실제
// collectGitFacts() 산출물에 배선됐는지로 이중 확인한다. 절대 규칙 —
// 「시크릿이 마스킹된다」와 「40자 커밋 SHA는 마스킹되지 않는다」 둘 다
// 이 함수 안에서 단언으로 고정한다.
// ---------------------------------------------------------------------------
function runRedactSmoke() {
  console.log("[redact.mjs 마스킹 스모크] A-9/A-10 — 패턴 정탐/오탐 단위 오라클 + collectGitFacts() 실배선 관측");

  // ---- (A) 순수 함수 단위: 정탐(마스킹돼야 함) ----
  const mustRedact = [
    ["AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE", "aws-access-key"],
    ["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "aws-secret-key"],
    ["DB_PASSWORD=hunter2horse", "password-field(콜드 리뷰 미탐 사례 — 언더스코어 키)"],
    ["db_password=hunter2horse", "password-field(콜드 리뷰 미탐 사례 — 선행 밑줄 \\b 미성립)"],
    ["password: hunter2horse", "password-field(콜드 리뷰 미탐 사례 — 콜론 구분자)"],
    ['"password": "hunter2horse"', "password-field(콜드 리뷰 미탐 사례 — JSON 따옴표 키/값)"],
    ["MYSQL_PWD=hunter2horse", "password-field(콜드 리뷰 미탐 사례 — pwd 변형)"],
    ["-----BEGIN RSA PRIVATE KEY-----\nMIIBOwIBAAJBAKfakekey==", "private-key-block(콜드 리뷰 미탐 사례 — END 마커 없는 잘린 PEM)"],
    ["-----begin rsa private key-----\nabc\n-----end rsa private key-----", "private-key-block(소문자 헤더)"],
    ["token=eyJhbGciOiJIUzI1NiJ9.eyA.sig", "jwt(콜드 리뷰 미탐 사례 — payload가 eyA로 시작)"],
    ["token=eyJhbGciOiJub25lIn0.eyJzdWIiOiIxIn0.", "jwt(콜드 리뷰 미탐 사례 — alg:none 빈 서명)"],
    ["contact: leaked-person@example.test", "email"],
  ];
  for (const [input, label] of mustRedact) {
    const { text, hits } = redactSecrets(input);
    report(hits.length > 0, `정탐: "${input}" → 마스킹 히트 발생(${label}, 실제 hits=${JSON.stringify(hits)}, 결과="${text}")`);
    report(containsSecretPattern(input), `정탐: containsSecretPattern("${input}")===true(${label})`);
  }

  // ---- (B) 순수 함수 단위: 오탐 금지(절대 규칙 — 40자 커밋 SHA는 시크릿이 아니다) ----
  const mustNotRedact = [
    `commit ${FAKE_COMMIT_HASH_IN_SUBJECT} in scripts/lib/git.mjs`,
    `commit:${FAKE_COMMIT_HASH_IN_SUBJECT}`,
    FAKE_COMMIT_HASH_IN_SUBJECT,
    FAKE_COMMIT_HASH_IN_SUBJECT.slice(0, 12), // shortHash 형태
  ];
  for (const input of mustNotRedact) {
    const { text, hits } = redactSecrets(input);
    const ok = hits.length === 0 && text === input;
    if (!ok) console.log(`    실제: hits=${JSON.stringify(hits)} text="${text}"`);
    report(ok, `오탐 금지(절대 규칙): 40자 hex 커밋 SHA "${input}"는 마스킹되지 않고 원문 그대로 보존됨`);
  }

  // ---- (C) 실배선: collectGitFacts()가 실제로 subject/coAuthors를 마스킹하는지 ----
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-redact-"));
  try {
    const dir = path.join(tmpBase, "repo");
    buildSecretsInCommitMetadata(dir);

    const { evidence, redactionSummary } = collectGitFacts({
      repoPath: dir,
      selectedIdentities: [OWNER_EMAIL],
      ref: "HEAD",
      maxCommits: 1000,
    });

    const c = evidence.commits[0];

    report(
      !c.subject.includes("AKIAIOSFODNN7EXAMPLE") && !c.subject.includes("Sup3rSecret!"),
      `배선: collect-git-facts.mjs가 원장 subject에서 AWS 키·password= 값을 실제로 마스킹함(실제 subject="${c.subject}")`
    );
    report(
      c.subject.includes("[REDACTED:aws-access-key]") && c.subject.includes("[REDACTED:password-field]"),
      "배선: subject에 [REDACTED:aws-access-key]·[REDACTED:password-field] 마커가 남음(사용자가 무엇이 가려졌는지 확인 가능)"
    );
    report(
      c.subject.includes(FAKE_COMMIT_HASH_IN_SUBJECT),
      `절대 규칙(배선 경로에서도 재확인): subject 안의 40자 hex 커밋 SHA 리터럴 "${FAKE_COMMIT_HASH_IN_SUBJECT}"은 마스킹되지 않고 원문 보존됨(실제 subject="${c.subject}")`
    );
    report(
      c.coAuthors.length === 1 &&
        c.coAuthors[0].includes("[REDACTED:email]") &&
        !c.coAuthors[0].includes("carol.park@corp.example") &&
        c.coAuthors[0].includes("Carol Park"),
      `배선: coAuthors[0]의 동료 이메일이 마스킹되고 이름은 보존됨(실제: ${JSON.stringify(c.coAuthors)})`
    );
    report(
      /^[0-9a-f]{40}$/.test(c.hash) && c.authorEmail === OWNER_EMAIL,
      `무오탐: 구조화 필드 hash(40자 hex 그대로)·authorEmail(${OWNER_EMAIL} 원문)은 마스킹 대상에서 제외됨(실제: hash=${c.hash}, authorEmail=${c.authorEmail})`
    );
    report(
      redactionSummary.totalHits >= 3 &&
        redactionSummary.byPattern["aws-access-key"] === 1 &&
        redactionSummary.byPattern["password-field"] === 1 &&
        redactionSummary.byPattern["email"] === 1,
      `배선: collectGitFacts()가 히트 수를 반환함(사용자 보고용, 실제 redactionSummary=${JSON.stringify(redactionSummary)})`
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }

  // ---- (D) 회귀 방지: 표준 픽스처(시크릿이 없는 정상 레포)는 마스킹 히트가 0건이어야 한다 ----
  {
    const tmpBase2 = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-redact-noop-"));
    try {
      const dir = path.join(tmpBase2, "repo");
      buildMultiAuthor(dir);
      const { redactionSummary } = collectGitFacts({
        repoPath: dir,
        selectedIdentities: [OWNER_EMAIL],
        allIdentities: true,
        ref: "HEAD",
        maxCommits: 1000,
      });
      report(
        redactionSummary.totalHits === 0,
        `무오탐 회귀: 시크릿 없는 표준 픽스처(buildMultiAuthor, 커밋 SHA·저자 이메일 필드만 존재)는 마스킹 히트 0건(실제: ${redactionSummary.totalHits})`
      );
    } finally {
      fs.rmSync(tmpBase2, { recursive: true, force: true });
    }
  }

  // ---- (E) T3(spec.md §6): 제외 커밋의 PII 3필드를 수집기가 실제로
  // 기록하지 않는지. 스키마 조건절(tests/fixtures-invalid/22-…)은 "유출된
  // 원장이 FAIL 한다"를 관측하지만, 그것만으로는 **수집기가 애초에 그런
  // 원장을 만들지 않는다**는 것이 관측되지 않는다 — 두 관측은 서로를
  // 대신하지 못한다.
  //
  // 대조군을 같은 단언에 묶는다: 본인(비-excluded) 커밋의 authorEmail·
  // subject는 그대로 남아야 한다. 대조군 없이 "제외 커밋이 null이다"만
  // 보면, 모든 커밋의 필드를 통째로 비우는 구현도 통과한다.
  {
    const tmpBase3 = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-t3-"));
    try {
      const dir = path.join(tmpBase3, "repo");
      buildMultiAuthor(dir);
      const { evidence } = collectGitFacts({
        repoPath: dir,
        selectedIdentities: [OWNER_EMAIL],
        ref: "HEAD",
        maxCommits: 1000,
      });
      const excluded = evidence.commits.filter((c) => c.excluded === true);
      const included = evidence.commits.filter((c) => c.excluded !== true);

      report(
        excluded.length >= 1,
        `T3 비공허성: buildMultiAuthor + identity=OWNER 수집에 excluded 커밋이 존재함(실제 ${excluded.length}건) — 0건이면 아래 단언들이 공허하게 통과한다`
      );
      report(
        excluded.every((c) => c.authorEmail === null && c.subject === null && c.coAuthors.length === 0),
        `T3: excluded 커밋의 authorEmail·subject는 null이고 coAuthors는 빈 배열(실제: ${JSON.stringify(excluded.map((c) => ({ authorEmail: c.authorEmail, subject: c.subject, coAuthors: c.coAuthors })))})`
      );
      report(
        excluded.every(
          (c) => typeof c.hash === "string" && Array.isArray(c.files) && typeof c.exclusionReason === "string"
        ) && excluded.some((c) => c.files.length >= 1),
        `T3 무오탐: 관측 가능성이 실제로 요구하는 필드(hash·files[]·exclusionReason)는 excluded 커밋에도 그대로 남음 — files[]는 비어 있지 않은 것까지 확인한다(Array.isArray만 보면 files를 통째로 비우는 구현도 통과한다). AC-7 (a)축·AC-9·머지 집합 동치 검사가 여기 걸려 있다(실제 files 길이=${JSON.stringify(excluded.map((c) => c.files.length))})`
      );
      report(
        included.length >= 1 && included.every((c) => c.authorEmail === OWNER_EMAIL && typeof c.subject === "string"),
        `T3 대조군: 본인(비-excluded) 커밋의 authorEmail·subject는 축소되지 않음(실제 ${included.length}건, authorEmail=${JSON.stringify(included.map((c) => c.authorEmail))}) — 이 대조군이 없으면 전 커밋을 비우는 구현도 통과한다`
      );
    } finally {
      fs.rmSync(tmpBase3, { recursive: true, force: true });
    }
  }

  // ---- (F) T3의 coAuthors 축소는 (E)로 관측되지 않는다. buildMultiAuthor의
  // 세 커밋 중 Co-authored-by 트레일러를 가진 것이 0건이라 `coAuthors.length
  // === 0`이 축소 여부와 무관하게 항상 참이기 때문이다 — 즉 (E)만 두면
  // 수집기의 coAuthors 삼항을 통째로 되돌려도 4게이트가 전부 녹색이다(적대
  // 검증에서 실측된 변이 생존). 트레일러가 실제로 있는 커밋이 excluded가
  // 되는 조합을 따로 만들어 관측한다.
  //
  // buildCoAuthorTrailer의 커밋은 전부 OWNER 작성이므로, 선택 identity를
  // 다른 사람으로 주면 세 커밋 모두 author-not-selected로 excluded가 된다.
  // 같은 픽스처를 OWNER로도 수집해 대조군을 만든다 — 대조군이 없으면
  // "coAuthors를 항상 비우는 구현"도 통과한다.
  {
    const tmpBase4 = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-t3-coauthor-"));
    try {
      const dir = path.join(tmpBase4, "repo");
      buildCoAuthorTrailer(dir);

      const control = collectGitFacts({
        repoPath: dir,
        selectedIdentities: [OWNER_EMAIL],
        ref: "HEAD",
        maxCommits: 1000,
      }).evidence;
      const controlWithTrailer = control.commits.filter((c) => c.coAuthors.length >= 1);
      // 트레일러의 이메일은 redact.mjs가 마스킹하는 것이 정상이다(A-9) —
      // 픽스처가 선언한 원문과 바이트 비교하면 마스킹 계약과 충돌한다.
      // 여기서 볼 것은 "축소되지 않고 기록됐다"이므로 이름 보존 + 마스킹
      // 마커 존재로 확인한다.
      report(
        controlWithTrailer.length === 1 &&
          controlWithTrailer[0].excluded === false &&
          controlWithTrailer[0].coAuthors[0].includes("Alice Kim") &&
          controlWithTrailer[0].coAuthors[0].includes("[REDACTED:email]"),
        `T3 coAuthors 대조군: 선택된 저자의 커밋에서는 트레일러가 (마스킹된 형태로) 그대로 기록됨(실제: ${JSON.stringify(control.commits.map((c) => c.coAuthors))}) — 이 단언이 없으면 coAuthors를 항상 비우는 구현도 통과한다`
      );

      const reduced = collectGitFacts({
        repoPath: dir,
        selectedIdentities: [ALICE_EMAIL],
        ref: "HEAD",
        maxCommits: 1000,
      }).evidence;
      const reducedExcluded = reduced.commits.filter((c) => c.excluded === true);
      report(
        reducedExcluded.length === control.commits.length && reducedExcluded.length >= 1,
        `T3 coAuthors 비공허성: 같은 픽스처를 다른 identity로 수집하면 트레일러 보유 커밋을 포함해 전 커밋이 excluded가 됨(실제 ${reducedExcluded.length}/${reduced.commits.length}건)`
      );
      report(
        reducedExcluded.every((c) => c.coAuthors.length === 0),
        `T3 coAuthors 축소: excluded가 된 트레일러 보유 커밋의 coAuthors가 빈 배열(실제: ${JSON.stringify(reduced.commits.map((c) => c.coAuthors))}) — 같은 픽스처의 대조군에서는 트레일러가 1건 기록됐으므로 이 단언은 공허하지 않다`
      );
    } finally {
      fs.rmSync(tmpBase4, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// 임무 1(구현자 — 탐지 경로 최종 보강, 결함 1): computeSampling 직접 단위
// 오라클. 디스크 I/O 없는 합성 population으로 scripts/lib/sampling.mjs의
// computeSampling을 직접 import해 호출한다 — 이전에는 이 함수에 대한 참조가
// tests/run-smoke.mjs에 0건이었다. 비-골든 경로가 수집기를 호출하는 인자는
// maxCommits=1000(절단 미진입 — 전원 선택되어 버킷 정렬 자체가 무의미)이나
// maxCommits=1(K=1 → churnCount=0, churn 버킷 자체가 공허)뿐이라, churn
// 정렬 축(정본 키 insertions+deletions desc)에 --golden(~1분) 이외의
// 오라클이 전혀 없었다 — 그 빈틈을 여기서 디스크 I/O 없이 즉시 메운다.
//
// population을 의도적으로 설계해 정본 churn 키(insertions+deletions) 상위
// 4건(h05~h08 — insertions는 작지만 deletions가 커서 churn이 큼)과
// insertions 단독 상위 4건(h07~h10 — h09/h10은 insertions만 크고 deletions는
// 0)이 서로 다른 집합이 되게 한다. 두 population은 churn 필드 값만 다르고
// (하나는 insertions+deletions, 하나는 insertions 단독) 나머지(hash·
// authorEpochSec)는 완전히 동일하므로, 선택 집합의 차이는 오직 churn 키
// 정의 자체에서만 나온다.
function runSamplingUnitSmoke() {
  console.log("[computeSampling 단위 오라클] scripts/lib/sampling.mjs — 정본 churn 키 vs insertions 단독(M-g 대조), 디스크 I/O 없음");

  // 시간 축(recent 버킷용) — n이 작을수록 authorEpochSec이 크다(=더 최근).
  // churn/insertions 값과 완전히 독립이므로 recentSelected(top4)는 두
  // population 모두에서 항상 h01~h04로 동일하다.
  const BASE_EPOCH = 1_700_000_000;
  const hashOf = (n) => `commit-${String(n).padStart(2, "0")}`;
  const epochOf = (n) => BASE_EPOCH - n * 1000;

  // insertions/deletions 정의(afterRecent 풀 h05~h20, 16건):
  //   h05~h08: insertions 작음·deletions 큼 → 정본 키(ins+del)로 churn 상위.
  //   h09~h10: insertions 큼·deletions 0    → insertions 단독 키로 churn 상위.
  //   h11~h20: 전부 0(even 버킷 몫을 채우는 filler).
  const INS_DEL = {
    5: [1, 100], 6: [2, 90], 7: [3, 80], 8: [4, 70],
    9: [60, 0], 10: [55, 0],
  };
  const insertionsOnlyOf = (n) => (INS_DEL[n] ?? [0, 0])[0];
  const canonicalChurnOf = (n) => {
    const [ins, del] = INS_DEL[n] ?? [0, 0];
    return ins + del;
  };

  const ns = Array.from({ length: 20 }, (_, i) => i + 1); // h01~h20, total=20
  const canonicalPopulation = ns.map((n) => ({ hash: hashOf(n), authorEpochSec: epochOf(n), churn: canonicalChurnOf(n) }));
  // M-g 재현: churn 필드 자체를 insertions 단독으로 축소(collect-git-facts.mjs의
  // `churn: diff.insertions + diff.deletions` → `churn: diff.insertions` 변이와
  // 동형 — computeSampling은 population.churn을 그대로 신뢰하므로 이 필드
  // 하나만 바꿔도 M-g가 만드는 것과 같은 입력 형태를 재현할 수 있다).
  const insertionsOnlyPopulation = ns.map((n) => ({ hash: hashOf(n), authorEpochSec: epochOf(n), churn: insertionsOnlyOf(n) }));

  const maxCommits = 10; // total=20 > maxCommits=10 → K=10(실제 절단), recentCount=4/churnCount=4/evenCount=2 → churn 버킷이 실제로 채워짐

  const canonicalResult = computeSampling(canonicalPopulation, maxCommits);
  const mutantResult = computeSampling(insertionsOnlyPopulation, maxCommits);

  // computeSampling은 selectedHashes를 [recent...][churn...][even...] 순서로
  // 이어붙여 반환한다(scripts/lib/sampling.mjs 소스 — `selected = [...recentSelected,
  // ...churnSelected, ...evenSelected]`) — recentCount/churnCount로 churn
  // 버킷 구간만 슬라이스해 추출한다.
  const churnSliceOf = (result) => result.selectedHashes.slice(result.recentCount, result.recentCount + result.churnCount);
  const setsEqual = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

  const canonicalChurnSet = new Set(churnSliceOf(canonicalResult));
  const mutantChurnSet = new Set(churnSliceOf(mutantResult));
  const expectedCanonicalChurnSet = new Set([5, 6, 7, 8].map(hashOf));
  const expectedMutantChurnSet = new Set([7, 8, 9, 10].map(hashOf));

  const canonicalOk = setsEqual(canonicalChurnSet, expectedCanonicalChurnSet);
  if (!canonicalOk) {
    console.log(`    실제(정본 churn 키): ${JSON.stringify([...canonicalChurnSet])}`);
    console.log(`    기대: ${JSON.stringify([...expectedCanonicalChurnSet])}`);
  }
  report(
    canonicalOk,
    "computeSampling: 정본 churn 키(insertions+deletions desc)로 계산한 churn 버킷 선택 집합이 기대값(h05~h08)과 정확히 일치"
  );

  const mutantOk = setsEqual(mutantChurnSet, expectedMutantChurnSet);
  if (!mutantOk) {
    console.log(`    실제(insertions 단독 키): ${JSON.stringify([...mutantChurnSet])}`);
    console.log(`    기대: ${JSON.stringify([...expectedMutantChurnSet])}`);
  }
  report(
    mutantOk,
    "computeSampling: insertions 단독 churn 키로 계산하면 churn 버킷 선택 집합이 기대값(h07~h10)으로 다르게 나옴"
  );

  // ---- M-g를 잡는 핵심 절: 정본 키의 선택 집합과 insertions 단독 키의
  // 선택 집합이 서로 다르다(집합 동치가 아니다) — computeSampling을 직접
  // 호출하지 않던 이전 상태에는 이 대조를 낼 자리 자체가 없었다. ----
  const differ = !setsEqual(canonicalChurnSet, mutantChurnSet);
  if (!differ) {
    console.log(`    실제: 두 churn 키의 선택 집합이 동일함(${JSON.stringify([...canonicalChurnSet])}) — churn 키 축소를 탐지하지 못함`);
  }
  report(
    differ,
    "M-g 대조: 정본 churn 키(insertions+deletions) 선택 집합과 insertions 단독 선택 집합이 서로 다름(churn 정렬 키가 실제로 선택 결과를 좌우함을 확인)"
  );

  // ---- 무결성 회귀: K·총 선택 수·중복 없음(computeSampling 내부에서 이미
  // throw로 강제하지만, 명시적으로 한 번 더 관측한다). ----
  const integrityOk =
    canonicalResult.K === maxCommits &&
    canonicalResult.selectedHashes.length === maxCommits &&
    new Set(canonicalResult.selectedHashes).size === maxCommits;
  report(integrityOk, `computeSampling: K=${maxCommits}, 선택 수=${maxCommits}, 버킷 간 중복 0건(무결성 회귀)`);
}

// ---------------------------------------------------------------------------
// 임무 2(구현자 — churn 파생식의 수집기 경유 오라클, M-g 최종 보강): 위
// runSamplingUnitSmoke는 scripts/lib/sampling.mjs의 computeSampling 정렬
// 축만 직접 검증하고, M-g가 실제로 사는 scripts/collect-git-facts.mjs의
// `enriched` map 안 `nonVendoredChurn` **파생식**(vendored/binary/viaMerge
// 항목을 뺀 insertions+deletions 합) 자체는 코드 경로에 들어오지 않는다
// (합성 population을 테스트 안에서 직접 만들어 넘기므로). 이 함수는
// fixtures/make-fixture.mjs의 buildChurnKeyDivergence 픽스처(커밋 5개,
// 수 초 이내 — vendored 경로를 쓰지 않으므로 이 시나리오에서는
// nonVendoredChurn === insertions+deletions)를 통해 **collectGitFacts()를
// 실제로 호출**해 그 파생식을 비-golden 경로에서 관측한다.
//
// 기대 선택 집합은 buildChurnKeyDivergence의 declared에 하드코딩된 리터럴
// (expectedCanonicalSelectedHashes/expectedInsertionsOnlySelectedHashes —
// fixture 생성 시점의 수기 유도값, computeSampling을 재호출해 유도하지
// 않음)을 그대로 대조한다.
function runChurnDerivationOracleSmoke() {
  console.log("[churn 파생식 오라클(임무 2)] scripts/collect-git-facts.mjs의 nonVendoredChurn 파생식 — collectGitFacts() 실제 호출 경로에서 M-g 관측");

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-churn-derivation-"));
  try {
    const dir = path.join(tmpBase, "churnKeyDivergence");
    const { declared } = buildChurnKeyDivergence(dir);

    const evidence = collectGitFacts({
      repoPath: dir,
      selectedIdentities: [OWNER_EMAIL],
      ref: "HEAD",
      mergeIncluded: false,
      maxCommits: declared.maxCommits, // 4 — total(5) > maxCommits(4) → 실제 절단·샘플링 진입
    }).evidence;

    // ---- 사전 확인: 이 조합이 실제로 절단·샘플링에 진입했는가(전제 조건
    // total>K, K>=3이 실제로 성립하는지) — 성립하지 않으면 아래 단언들이
    // 아무것도 검증하지 못하는 자기충족이 된다. ----
    const preconditionOk =
      evidence.coverage.total === 5 &&
      evidence.coverage.analyzed === 4 &&
      evidence.truncated.reason === "budget_commits" &&
      evidence.truncated.dropped_commits === 1 &&
      evidence.coverage.samplingMethod === CANONICAL_SAMPLING_METHOD_LITERAL;
    if (!preconditionOk) {
      console.log(`    실제 coverage: ${JSON.stringify(evidence.coverage)}, truncated: ${JSON.stringify(evidence.truncated)}`);
    }
    report(
      preconditionOk,
      "사전 확인: buildChurnKeyDivergence + max-commits=4 조합이 실제로 절단·샘플링에 진입함(total=5>K=4, samplingMethod=정본 리터럴)"
    );

    const actualSelectedHashes = new Set(evidence.commits.filter((c) => c.excluded === false).map((c) => c.hash));
    const setsEqual = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

    const expectedCanonicalSet = new Set(declared.expectedCanonicalSelectedHashes);
    const canonicalOk = setsEqual(actualSelectedHashes, expectedCanonicalSet);
    if (!canonicalOk) {
      console.log(`    실제 선택 집합: ${JSON.stringify([...actualSelectedHashes])}`);
      console.log(`    기대(정본 churn 키, 하드코딩 리터럴): ${JSON.stringify([...expectedCanonicalSet])}`);
    }
    report(
      canonicalOk,
      "collectGitFacts: 정본 churn 키(insertions+deletions)로 실제 선택된 커밋 집합이 하드코딩 기대 집합(churnCommit + recent×3)과 정확히 일치"
    );

    // ---- M-g를 잡는 핵심 절: 실제 선택 집합이 insertions 단독 키였다면
    // 나왔을 하드코딩 기대 집합(seed + recent×3)과 다르다. M-g가
    // (nonVendoredChurn을 insertions 단독으로 축소하는 변이가) collectGitFacts()에
    // 적용되면 실제 선택 집합이 이 대안 집합과 정확히 같아져 이 단언이
    // FAIL로 뒤집힌다. ----
    const expectedInsertionsOnlySet = new Set(declared.expectedInsertionsOnlySelectedHashes);
    const differsFromMutant = !setsEqual(actualSelectedHashes, expectedInsertionsOnlySet);
    if (!differsFromMutant) {
      console.log(`    실제: 선택 집합이 insertions 단독 키 기대 집합과 동일함(${JSON.stringify([...actualSelectedHashes])}) — churn 파생식 축소를 탐지하지 못함`);
    }
    report(
      differsFromMutant,
      "M-g 대조: collectGitFacts() 실제 선택 집합이 insertions 단독 키였다면 나올 하드코딩 기대 집합(seed + recent×3)과 다름(churn 파생식이 실제로 선택 결과를 좌우함을 collectGitFacts 경로에서 확인)"
    );

    // ---- 개별 멤버십 재확인(위 집합 비교의 보강 — 어느 쪽이 어떻게
    // 어긋나는지 사람이 바로 읽을 수 있게 분리). ----
    const churnCommitSelected = actualSelectedHashes.has(declared.churnCommitHash);
    const seedSelected = actualSelectedHashes.has(declared.seedHash);
    report(
      churnCommitSelected && !seedSelected,
      "churn 버킷 멤버십: churnCommit(ins=1,del=100,정본 churn=101)이 선택되고 seed(ins=100,del=0,정본 churn=100)는 evidence.commits에서 완전히 누락됨"
    );

    // ---- 무오탐 회귀: 참인 원장에는 AC-6/T-1/T-2/coverage 교차 불변식
    // 위반이 0건이어야 한다. ----
    const violations = checkEvidenceInvariants(evidence);
    if (violations.length > 0) {
      for (const v of violations) console.log(`    실제 위반: ${v.code}: ${v.message}`);
    }
    report(violations.length === 0, "무오탐: 실제 절단 발생 원장(churnKeyDivergence + max-commits=4)에 AC-6/T-1/T-2/coverage 불변식 위반 0건");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

// 구현 6단계: verify-evidence.mjs가 실제로 무언가를 잡는지 관측한다("검사만
// 있고 FAIL이 관측되지 않으면 결함"). 임무 지침 "반드시 실증하라" 5항목을
// 그대로 픽스처에 주입해 결과를 확인한다.

/** evidence.commits[commitHash].files[]에서 path가 일치하는 항목 1건을 찾는다. */
function findFileEntryByPath(evidence, commitHash, targetPath) {
  const c = evidence.commits.find((x) => x.hash === commitHash);
  if (!c) return null;
  return (c.files ?? []).find((f) => f.path === targetPath) ?? null;
}

/**
 * 이월 게이트 B-4 오라클: files[] 항목 하나(entry)가 fixtures/make-fixture.mjs
 * 가 선언한 기대값(declared: {path, oldPath?, changeType})과 changeType까지
 * 포함해 완전히 일치하는지 확인한다 — 골든이나 verify-evidence.mjs의 (c)축/
 * 집합 동치와 독립한 오라클(그 둘은 collect-git-facts.mjs·verify-evidence.mjs가
 * 공유하는 scripts/lib/git.mjs 자체의 파싱 버그를 원리적으로 못 잡는다).
 * 불일치 항목을 사람이 읽을 문자열 배열로 반환하고, 빈 배열이면 완전 일치.
 *
 * @param {object|null} entry
 * @param {{path: string, oldPath?: string|null, changeType: string}} declared
 * @returns {string[]}
 */
function declaredFileChangeMismatches(entry, declared) {
  if (!entry) return ["entry-not-found: files[]에서 declared.path와 일치하는 항목을 찾지 못함"];
  const mismatches = [];
  if (entry.changeType !== declared.changeType) {
    mismatches.push(`changeType: 실제=${JSON.stringify(entry.changeType)} 기대(declared)=${JSON.stringify(declared.changeType)}`);
  }
  if (entry.path !== declared.path) {
    mismatches.push(`path: 실제=${JSON.stringify(entry.path)} 기대(declared)=${JSON.stringify(declared.path)}`);
  }
  const declaredOldPath = declared.oldPath ?? null;
  const entryOldPath = entry.oldPath ?? null;
  if (entryOldPath !== declaredOldPath) {
    mismatches.push(`oldPath: 실제=${JSON.stringify(entryOldPath)} 기대(declared)=${JSON.stringify(declaredOldPath)}`);
  }
  return mismatches;
}

// ---------------------------------------------------------------------------
// 인용 커버리지 절 단위 오라클 — 게이트 C-5 / 심사 C-3 수정안 ③ /
// 콜드 리뷰 A-32·A-34 (슬라이스 A 파일 수정 예외 5번)
//
// **왜 절 단위인가.** 이 레포에서 이미 두 번 관측된 실패 형태가 있다:
// 영역당 한 번만 변이를 돌리면 "그 영역에 검사가 있다"까지만 확인되고
// **그 절이 실제로 FAIL을 내는지**는 확인되지 않는다. 그래서 아래는
// C-5가 넣은 조건 두 개(`artifactLayerCount > 0`, `allCitations.length === 0`)
// 를 **각각 따로** 겨냥한 단언을 둔다 — 한 조건만 지우는 변이가 다른
// 단언을 깨지 않아야 관측이 성립한다.
//
// **허용 방향도 본다.** C-5는 제약을 좁히는 변경이므로 금지 방향(빈손 →
// INCONCLUSIVE)만 보면 조건을 통째로 넓혀도(모든 0건을 INCONCLUSIVE로)
// 아무 단언이 깨지지 않는다. (C5-2)·(C5-3)이 그 방향을 잡는다.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 렌더 계약 오라클 — 구현 7단계 렌더 계약 / 심사 m-3 / AC-13 (ii)
//
// **왜 이 검사가 렌더러보다 먼저 서야 하는가.** 마크다운은 사용자 눈에 닿는
// 유일한 표면이다. 절단 고지와 강등 배지가 여기서 빠지면 JSON이 아무리
// 정확해도 사용자는 그것을 보지 못하고, 어떤 기계 게이트도 그 누락을 보지
// 못한다(마크다운을 읽는 검사가 하나도 없었다). 그래서 프롬프트 계층보다
// 먼저 이 오라클을 세운다 — "하네스를 먼저".
//
// **자기충족을 피한 방법.** 렌더러와 이 오라클이 **둘 다**
// scripts/lib/render-contract.mjs의 리터럴을 import한다. 오라클이 문자열을
// 자기 안에 다시 적으면 렌더러가 리터럴을 바꿔도 두 곳을 같이 고치면 되므로
// 검사가 사실상 없는 것이 된다. 대신 그 리터럴이 **스키마 description과
// 일치하는지**를 따로 단언한다 — 정본은 스키마이고 render-contract는 그것을
// 따르는 쪽이다.
//
// **허용 방향도 본다.** 배지 단언을 금지 방향(강등 노드가 있는데 배지가
// 없으면 FAIL)만 두면, 렌더러가 배지를 **항상** 붙여도 통과한다. 그러면
// 배지가 정보를 잃는다 — (R-5)가 그 방향을 잡는다.
// ---------------------------------------------------------------------------

function runRenderContractOracleSmoke() {
  console.log("[렌더 계약 오라클] 구현 7단계: 커버리지 3수치·절단 고지·AC-13 배지가 출력에 실재하는가");

  // 최소 인스턴스 — 스키마가 required로 두는 필드만 채운다. 여기서
  // 스키마 검증을 함께 돌려, 픽스처가 "렌더는 되지만 스키마는 어기는"
  // 물건이 아님을 확인한다(픽스처를 세계로 착각하지 않기 위해).
  const baseInstance = {
    schemaVersion: "1.0.0",
    generatedAt: "2026-08-19T00:00:00Z",
    sourceRepoHead: "a".repeat(40),
    contentHash: "b".repeat(64),
    coverage: {
      analyzed: 7,
      total: 9,
      traversed: 12,
      period: { since: "2026-01-01", until: "2026-08-01" },
      exclusions: { bots: true, vendoredPaths: true, mergeIncluded: false, selectedIdentities: ["owner@example.com"] },
      samplingMethod: "none:full-scan",
    },
    truncated: { reason: "none", dropped_commits: 0 },
    nodes: [
      {
        id: "car:001",
        basis: "commit",
        evidence: [{ ledgerId: `commit:${"c".repeat(40)}`, path: "a.txt" }],
        verification: { status: "verified", attempts: 1, reasonCode: null },
        origin: "generated",
        locked: false,
        text: "결제 모듈의 재시도 로직을 설계하고 구현했다.",
      },
    ],
  };

  const withRefuted = structuredClone(baseInstance);
  withRefuted.nodes.push({
    id: "car:002",
    basis: "inference",
    evidence: [{ ledgerId: `commit:${"c".repeat(40)}` }],
    verification: { status: "refuted", attempts: 2, reasonCode: "UNSUPPORTED_CLAIM" },
    origin: "generated",
    locked: false,
    text: "대규모 트래픽을 처리하는 아키텍처를 주도했다.",
  });

  // ---- (R-1) 계약 요소가 전부 출력에 실재하는가 ----
  //      RENDER_REQUIRED_ELEMENTS는 데이터다 — 요소가 늘면 이 루프가
  //      자동으로 그것을 검사한다(산문으로 적힌 계약은 검사가 못 읽는다).
  {
    const md = renderLayer("career", withRefuted);
    for (const el of RENDER_REQUIRED_ELEMENTS) {
      const ok = el.probe(md, withRefuted);
      if (!ok) console.log(`    실제 출력:\n${md}`);
      report(ok, `(R-1/${el.id}) 렌더 계약 요소가 출력에 실재: ${el.why}`);
    }
  }

  // ---- (R-2) 커버리지 3수치가 **값까지** 옮겨졌는가 ----
  //      라벨만 보면 렌더러가 라벨을 찍고 값을 0으로 채워도 통과한다.
  {
    const md = renderLayer("career", baseInstance);
    const ok = md.includes("7건") && md.includes("9건") && md.includes("12건") && md.includes("none:full-scan");
    if (!ok) console.log(`    실제 출력:\n${md}`);
    report(ok, "(R-2) 커버리지 3수치의 값(7/9/12)과 samplingMethod가 출력에 그대로 실린다(라벨만 찍고 넘어가지 않는다)");
  }

  // ---- (R-3) 절단이 있으면 사유와 건수를 고지하는가 ----
  {
    const truncatedInstance = structuredClone(baseInstance);
    truncatedInstance.truncated = { reason: "budget_commits", dropped_commits: 42 };
    const md = renderLayer("career", truncatedInstance);
    const ok = md.includes(TRUNCATION_NOTICE_PREFIX) && md.includes("budget_commits") && md.includes("42");
    if (!ok) console.log(`    실제 출력:\n${md}`);
    report(ok, "(R-3) 절단이 있으면 사유(budget_commits)와 건수(42)가 출력에 실린다");
  }

  // ---- (R-4) 강등 배지: 금지 방향 ----
  {
    const md = renderLayer("career", withRefuted);
    const ok = md.includes(EVIDENCE_BADGE) && md.includes("car:002");
    if (!ok) console.log(`    실제 출력:\n${md}`);
    report(ok, "(R-4) verification.status=refuted 노드가 있으면 '근거 부족 - 미검증' 배지가 출력에 실재한다(AC-13)");
  }

  // ---- (R-5) 강등 배지: 허용 방향 ----
  //      전 노드가 verified면 배지가 **없어야** 한다. 이 단언이 없으면
  //      "항상 배지를 붙이는" 렌더러가 (R-4)를 통과한다.
  {
    const md = renderLayer("career", baseInstance);
    const ok = !md.includes(EVIDENCE_BADGE);
    if (!ok) console.log(`    실제 출력:\n${md}`);
    report(ok, "(R-5) 허용 방향: 전 노드가 verified면 배지가 출력에 없다(렌더러가 스스로 강등을 만들지 않는다)");
  }

  // ---- (R-6) 배지는 basis가 아니라 verification에서만 파생한다 ----
  //      basis:insufficient이지만 verification.status=verified인 노드에
  //      배지가 붙으면, 렌더러가 basis를 보고 판단한 것이다(AC-13 (ii) 금지).
  {
    const basisOnly = structuredClone(baseInstance);
    basisOnly.nodes = [{
      id: "car:003",
      basis: "insufficient",
      evidence: [],
      verification: { status: "verified", attempts: 1, reasonCode: null },
      origin: "generated",
      locked: false,
      text: "근거 등급은 낮지만 반증 시도는 통과한 항목.",
    }];
    const md = renderLayer("career", basisOnly);
    const ok = !md.includes(EVIDENCE_BADGE) && md.includes("근거 등급: 근거 부족");
    if (!ok) console.log(`    실제 출력:\n${md}`);
    report(ok, "(R-6) 배지는 verification에서만 파생 — basis:insufficient + status:verified 노드에는 배지가 붙지 않는다");
  }

  // ---- (R-7) verification 필드 부재는 '검증됨'이 아니다(fail-closed) ----
  {
    const noVerification = structuredClone(baseInstance);
    delete noVerification.nodes[0].verification;
    const md = renderLayer("career", noVerification);
    const ok = md.includes(EVIDENCE_BADGE);
    if (!ok) console.log(`    실제 출력:\n${md}`);
    report(ok, "(R-7) verification 필드가 없으면 배지가 붙는다(부재를 '검증됨'으로 읽지 않는다 — fail-closed)");
  }

  // ---- (R-8) 배지 리터럴이 세 스키마 description과 일치하는가(드리프트 가드) ----
  //      정본은 스키마다. render-contract가 그것을 따르며, 갈리면 여기서 FAIL.
  {
    // 닻은 **render-contract 밖**에 있어야 한다. R-4도 배지 문자열을 보지만
    // R-4는 EVIDENCE_BADGE를 import하므로 리터럴을 바꾸면 단언도 함께
    // 움직인다 — 실측으로 확인했다(변이 RM6에서 R-8만 FAIL했다). 즉 이
    // 단언이 리터럴 드리프트를 잡는 유일한 지점이다.
    //
    // `samplingMethod` 정본 리터럴이 4곳으로 묶여 있는 것과 같은 형태로,
    // 세 스키마 description과 spec.md를 함께 닻으로 쓴다.
    const anchors = [
      ["schemas", "career.schema.json"],
      ["schemas", "knowledge-map.schema.json"],
      ["schemas", "gap-report.schema.json"],
      ["docs", "devcareer-prep-plugin", "spec.md"],
    ];
    const missing = [];
    for (const parts of anchors) {
      const rel = path.join(...parts);
      const full = path.join(REPO_ROOT, rel);
      if (!fs.existsSync(full)) {
        // 파일이 없으면 조용히 통과시키지 않는다 — 드리프트 가드가
        // "대상이 사라져서 통과"하는 것이 가장 조용한 실패다
        // (checkSamplingMethodLiteralDrift의 missing 처리와 같은 규약).
        missing.push(`${rel}(파일 없음)`);
        continue;
      }
      if (!fs.readFileSync(full, "utf8").includes(EVIDENCE_BADGE)) missing.push(rel);
    }
    const ok = missing.length === 0;
    if (!ok) console.log(`    실제: 배지 리터럴 '${EVIDENCE_BADGE}'이 없는 파일 = ${JSON.stringify(missing)}`);
    report(ok, "(R-8) 배지 리터럴이 세 스키마 description과 spec.md AC-13에 바이트 일치(드리프트 가드 4곳)");
  }

  // ---- (R-9) 픽스처가 실제로 스키마를 통과하는가 ----
  //      "렌더는 되지만 스키마는 어기는" 픽스처로 계약을 검사하면 그 검사는
  //      현실과 무관해진다.
  {
    // 판독 실패를 **빈 배열로 강등하지 않는다** — 빈 오류 배열은 「위반 0건」과 구별되지 않아
    // 이 단언이 조용히 PASS한다. 사유 하나를 오류 배열로 삼아 (R-9)만 FAIL시킨다.
    const { json: schema, error: schemaError } = readRepoJsonSafe(SCHEMA_REL("career"));
    if (schemaError !== null) console.log(`    실제: ${schemaError}`);
    // validateInstance는 오류 **문자열 배열**을 돌려준다(객체가 아니다).
    const e1 = schemaError !== null ? [schemaError] : validateInstance(schema, baseInstance);
    const e2 = schemaError !== null ? [schemaError] : validateInstance(schema, withRefuted);
    const ok = e1.length === 0 && e2.length === 0;
    if (!ok) console.log(`    실제: base=${JSON.stringify(e1)} refuted=${JSON.stringify(e2)}`);
    report(ok, "(R-9) 렌더 계약 픽스처 2종이 career.schema.json을 실제로 통과한다(픽스처가 스키마와 어긋나지 않는다)");
  }

  // ---- (R-10) 미지원 계층은 조용히 넘어가지 않는다 ----
  //
  //      **실재하는 계층 이름을 쓰지 않는다(2026-08-26, 순서 13번 (b)에서 고침).**
  //      초판은 `knowledge-map`을 「미지원」 예시로 하드코딩했고, (b)가 그 계층을
  //      등록하는 순간 이 단언이 FAIL했다 — 가드가 제 일을 한 것이지만, 계층이
  //      늘 때마다 여기가 낡는 결합은 남길 이유가 없다. 이 단언이 보는 것은
  //      **모르는 이름에 던지는가**라는 성질 하나이고, **등록된 집합이 무엇인가**는
  //      (RM-1)이 소유한다. 두 축을 한 단언에 묶으면 어느 쪽이 깨졌는지 알 수 없다.
  {
    let threw = false;
    try {
      renderLayer("no-such-layer", baseInstance);
    } catch {
      threw = true;
    }
    report(threw, "(R-10) 등록되지 않은 계층 이름은 조용히 넘어가지 않고 던진다(A-34와 같은 형태 — 등록 집합 자체는 (RM-1)이 본다)");
  }
}

// ---------------------------------------------------------------------------
// 구현 7단계 (a)(b)(f)(g) — 결정적 진입점 계약 오라클
// ---------------------------------------------------------------------------

/** career 계층의 최소 정상 인스턴스. R-9와 같은 이유로 스키마 통과를 함께 단언한다. */
function makeCareerInstance(nodes) {
  return {
    schemaVersion: "1.0.0",
    generatedAt: "2026-08-19T00:00:00Z",
    sourceRepoHead: "a".repeat(40),
    contentHash: "b".repeat(64),
    coverage: {
      analyzed: 7,
      total: 9,
      traversed: 12,
      period: { since: "2026-01-01", until: "2026-08-01" },
      exclusions: { bots: true, vendoredPaths: true, mergeIncluded: false, selectedIdentities: ["owner@example.com"] },
      samplingMethod: "none:full-scan",
    },
    truncated: { reason: "none", dropped_commits: 0 },
    nodes,
  };
}

function makeCareerNode(overrides = {}) {
  return {
    id: "car:001",
    basis: "commit",
    evidence: [{ ledgerId: `commit:${"c".repeat(40)}`, path: "a.txt" }],
    verification: { status: "not-attempted", attempts: 0, reasonCode: null },
    origin: "generated",
    locked: false,
    text: "결제 모듈의 재시도 로직을 설계하고 구현했다.",
    ...overrides,
  };
}

/**
 * **fact-checked 단계 출력** 노드 — `verification`은 담고 `locked`는 담지
 * 않는다(게이트 B-7).
 *
 * `makeCareerNode`와 갈라 두는 이유: 저 함수는 **저장된 노드**(스키마 완전 —
 * prev·병합 결과·스키마 픽스처)를 뜻하고, 이 함수는 **생성 주체가 내놓는
 * 출력**을 뜻한다. 초판은 둘을 한 함수로 겸했는데, 그 겸용이 「생성 출력이
 * locked를 담아도 되는가」라는 질문을 테스트가 한 번도 묻지 않게 만들었다 —
 * M-1이 숨어 있던 것과 같은 형태의 개념 뭉개기다.
 */
function makeFactCheckedNode(overrides = {}) {
  // **overrides로 locked를 넘기면 던진다.** 조용히 지우면 픽스처 작성자가
  // `locked: true`를 적어 놓고 그것이 반영됐다고 믿는다 — 이 회차에 실제로
  // WA-16에서 그 형태가 났다(잠긴 prev 노드를 심으려던 코드가 아무것도 심지
  // 못한 채 녹색으로 남았다). 잠금을 심으려면 산출물 파일을 직접 편집해야
  // 한다. 그것이 게이트 B-7 이후 남은 유일한 잠금 경로이기 때문이다.
  if ("locked" in overrides) {
    throw new Error(
      "생성 출력 픽스처에는 locked를 실을 수 없습니다(게이트 B-7) — 잠긴 prev를 만들려면 " +
      "산출물 파일을 직접 편집하십시오(사용자 편집 경로)."
    );
  }
  const n = makeCareerNode(overrides);
  delete n.locked;
  return n;
}

/**
 * draft 단계 노드 — `verification`도 `locked`도 담지 않는다(콜드 리뷰 M-1 /
 * 게이트 B-7). 두 값 모두 병합이 채우므로 생성 템플릿 출력에는 그 필드가
 * 없는 것이 정상이다.
 */
function makeDraftNode(overrides = {}) {
  const n = makeFactCheckedNode(overrides);
  delete n.verification;
  return n;
}

function runArtifactContractOracleSmoke() {
  console.log("[산출물 계약 오라클] 구현 7단계 (a)(b)(g): contentHash 정본·기입 주체·재생성 병합");

  // ---- (AC-1) 계층 표가 KNOWN_LAYERS와 어긋나지 않는가(드리프트 가드) ----
  //      닻은 artifact-contract.mjs **밖**이다 — verify-evidence.mjs가 export한
  //      KNOWN_LAYERS와 schemas/state.schema.json이 정본이고, 이 모듈은 그것을
  //      따른다. 같은 상수를 import하는 단언은 드리프트와 함께 움직여 아무것도
  //      잡지 못한다(렌더 계약 RM6에서 실측된 형태다).
  {
    const mine = Object.keys(ARTIFACT_LAYERS).sort();
    const theirs = [...KNOWN_LAYERS].sort();
    const ok = JSON.stringify(mine) === JSON.stringify(theirs);
    if (!ok) console.log(`    실제: artifact-contract=${JSON.stringify(mine)} verify-evidence=${JSON.stringify(theirs)}`);
    report(ok, "(AC-1) ARTIFACT_LAYERS의 계층 키 집합이 verify-evidence.mjs의 KNOWN_LAYERS와 일치(드리프트 가드)");
  }

  // ---- (AC-2) stateKey가 state.schema.json의 artifacts 프로퍼티와 일치하는가 ----
  {
    // **판독 실패와 형태 변화를 둘 다 막아야 하는 유일한 사이트다.** `properties.artifacts.properties`
    // 접근은 스키마가 null일 때뿐 아니라 스키마가 읽혔어도 그 경로가 사라졌을 때 터진다 — 후자는
    // 파일이 멀쩡한데도 섹션을 중단시키므로 옵셔널 체이닝이 필수다. `schemaKeys`가 null이면
    // 비교 자체가 성립하지 않으므로 `ok` 판정에 그 조건을 명시적으로 넣는다(빈 배열로 강등하면
    // `mine`도 비었을 때 우연히 일치해 조용히 PASS한다).
    const { json: stateSchema, error: stateError } = readRepoJsonSafe(SCHEMA_REL("state"));
    const props = stateSchema?.properties?.artifacts?.properties;
    const schemaKeys = props ? Object.keys(props).filter((k) => k !== "evidence").sort() : null;
    const mine = Object.values(ARTIFACT_LAYERS).map((v) => v.stateKey).sort();
    const ok = schemaKeys !== null && JSON.stringify(mine) === JSON.stringify(schemaKeys);
    if (!ok) {
      const why = stateError !== null ? stateError : (schemaKeys === null ? `${SCHEMA_REL("state")} properties.artifacts.properties 경로가 없음` : "");
      console.log(`    실제: ${why} stateKey=${JSON.stringify(mine)} schema=${JSON.stringify(schemaKeys)}`);
    }
    report(ok, "(AC-2) ARTIFACT_LAYERS의 stateKey 집합이 state.schema.json의 artifacts 키(evidence 제외)와 일치");
  }

  // ---- (AC-2b) EMPTY_REGISTRY_ARTIFACTS ↔ state.schema.json (8번 ③) ----
  //      **계층 키 집합의 세 번째 사본이다.** (AC-2)가 잡는 것은 `ARTIFACT_LAYERS`의
  //      stateKey이고, 스키마의 `artifacts.required`가 정본인데, `EMPTY_REGISTRY_ARTIFACTS`는
  //      **어느 쪽과도 대조되지 않은 채** `updateRegistry`가 새 레지스트리를 만들 때 쓰는
  //      골격이다(콜드 리뷰 f029375가 「참조는 자기 파일 한 곳뿐」이라고 지적했다).
  //      키가 하나 빠지면 required 위반으로 시끄럽게 깨지지만, 키가 **더 있으면**
  //      `additionalProperties`가 없는 한 조용히 통과한다.
  //
  //      **왜 지금인가**: 계층이 2개 느는 13번이 이 드리프트가 실제로 나는 회차다.
  //      가드를 계층 추가 **전에** 넣어야 그 가드가 무언가를 관측한다. 지금은 두 집합이
  //      정확히 일치하므로(실측) 이 단언은 오늘 아무것도 잡지 않는다 — 그것이 정상이다.
  //
  //      (AC-2)와 달리 evidence를 **제외하지 않는다.** `EMPTY_REGISTRY_ARTIFACTS`는
  //      evidence를 포함하고 스키마의 required도 포함하므로, 여기서 빼면 비교가 어긋난다.
  {
    const { json: stateSchema, error: stateError } = readRepoJsonSafe(SCHEMA_REL("state"));
    const required = stateSchema?.properties?.artifacts?.required;
    const schemaKeys = Array.isArray(required) ? [...required].sort() : null;
    const mine = Object.keys(EMPTY_REGISTRY_ARTIFACTS).sort();
    const ok = schemaKeys !== null && JSON.stringify(mine) === JSON.stringify(schemaKeys);
    if (!ok) {
      const why = stateError !== null ? stateError : (schemaKeys === null ? `${SCHEMA_REL("state")} properties.artifacts.required 경로가 없음` : "");
      console.log(`    실제: ${why} empty=${JSON.stringify(mine)} schema=${JSON.stringify(schemaKeys)}`);
    }
    report(ok, "(AC-2b) EMPTY_REGISTRY_ARTIFACTS의 키 집합이 state.schema.json의 artifacts.required와 일치(계층 키 세 번째 사본의 드리프트 가드)");
  }

  // ---- (AC-1b) ARTIFACT_PARENT_LAYER ↔ 슬라이스 A의 checkLayerRefs (라운드 2 처방 7) ----
  //      **철자가 아니라 거동으로 대조한다.** `verify-evidence.mjs`의 `LAYER_PARENT`는
  //      슬라이스 A CLI 안에 있어 import하면 의존 방향이 뒤집히고(=`ARTIFACT_LAYERS`와
  //      같은 판단), 소스에서 정규식으로 긁으면 리팩터링에 눈이 먼다.
  //
  //      대신 사본이 지목하는 부모로 **합성 쌍을 만들어 저쪽 함수에 넘긴다**. 사본에
  //      부모가 있는 계층에서는 미해소 참조 1건이 위반으로 잡히고 `unverifiable`은
  //      0건이어야 한다 — `unverifiable`이 나오면 저쪽이 다른 부모를 기대한다는 뜻이다.
  //      `career`는 사본에 항목이 없으므로 단독으로 넘겨도 위반·unverifiable 둘 다 0건이다.
  //
  //      행 삭제·행 추가·잘못된 부모 지목이 **전부** 이 한 단언에 걸린다.
  {
    const mk = (nodes) => ({ nodes });
    const problems = [];

    for (const layer of Object.keys(ARTIFACT_LAYERS)) {
      const parent = ARTIFACT_PARENT_LAYER[layer];
      // **부모 노드에는 `parentRefs` 키를 아예 두지 않는다.** 빈 배열을 두면
      // `checkLayerRefs`가 그 계층의 **조부모**가 이번 호출에 없다고 보고
      // `unverifiable` 1건을 낸다(실측) — 이번 축과 무관한 잡음이고, 키가 없으면
      // 저쪽이 그 노드를 건너뛴다. 시험 대상은 자식 계층의 참조 하나뿐이다.
      if (parent === undefined) {
        // 사본이 최상위라고 선언한 계층 — 단독으로 넘겨도 조용해야 한다.
        const r = checkLayerRefs({ [layer]: mk([{ id: "x:1", parentRefs: [] }]) });
        if (r.violations.length !== 0 || r.unverifiable.length !== 0) {
          problems.push(`${layer}: 최상위라고 선언했으나 저쪽은 부모를 기대한다(위반 ${r.violations.length} / 미검증 ${r.unverifiable.length})`);
        }
        continue;
      }
      if (ARTIFACT_LAYERS[parent] === undefined) {
        problems.push(`${layer}: 부모로 지목한 '${parent}'가 계층 표에 없다`);
        continue;
      }
      const r = checkLayerRefs({
        [parent]: mk([{ id: "p:1" }]),
        [layer]: mk([{ id: "c:1", parentRefs: ["없는-id"] }]),
      });
      if (r.violations.length !== 1 || r.unverifiable.length !== 0) {
        problems.push(
          `${layer}: 부모를 '${parent}'로 지목했으나 저쪽 판정이 다르다(위반 ${r.violations.length}(기대 1) / 미검증 ${r.unverifiable.length}(기대 0))`
        );
      }
    }

    // 사본이 계층 표 밖의 키를 담고 있으면 그 자체가 드리프트다.
    for (const key of Object.keys(ARTIFACT_PARENT_LAYER)) {
      if (ARTIFACT_LAYERS[key] === undefined) problems.push(`사본에 계층 표 밖의 키 '${key}'가 있다`);
    }

    const ok = problems.length === 0;
    if (!ok) console.log(`    실제: ${JSON.stringify(problems)}`);
    report(
      ok,
      "(AC-1b) ARTIFACT_PARENT_LAYER의 계층별 부모 지목이 verify-evidence의 checkLayerRefs와 거동으로 일치한다(철자 스캔이 아니라 합성 쌍 대조)"
    );
  }

  // ---- (AC-2c) STATE_SCHEMA_VERSION ↔ state.schema.json의 default (8번 ④) ----
  //      두 값이 갈리면 `updateRegistry`가 **스키마가 예시로 내건 것과 다른 버전**을
  //      새 state.json에 적는다. `schemaVersion`은 `pattern`만 강제하고 `const`가 아니라
  //      어떤 값이든 통과하므로 스키마 검증으로는 절대 드러나지 않는다 — 「검사해서
  //      통과」가 아니라 「검사 대상이 아니라 통과」다.
  {
    const { json: stateSchema, error: stateError } = readRepoJsonSafe(SCHEMA_REL("state"));
    const schemaDefault = stateSchema?.properties?.schemaVersion?.default;
    const ok = typeof schemaDefault === "string" && schemaDefault === STATE_SCHEMA_VERSION;
    if (!ok) {
      const why = stateError !== null ? stateError : (schemaDefault === undefined ? `${SCHEMA_REL("state")} properties.schemaVersion.default 경로가 없음` : "");
      console.log(`    실제: ${why} 코드=${JSON.stringify(STATE_SCHEMA_VERSION)} 스키마=${JSON.stringify(schemaDefault)}`);
    }
    report(ok, "(AC-2c) STATE_SCHEMA_VERSION이 state.schema.json의 schemaVersion default와 일치(pattern만 있고 const가 없어 스키마 검증으로는 안 잡히는 축)");
  }

  // ---- (AC-3) 해시 알고리즘의 닻이 모듈 밖에 있는가 ----
  //      같은 evidence 객체에 대해 content-hash.mjs의 정본 함수와 바이트
  //      동일한 값을 내야 한다. 이 단언이 없으면 새 모듈에서 해시 알고리즘·
  //      직렬화·제외 규칙을 바꿔도 "내가 해시해 내가 대조"하는 자기충족이라
  //      아무도 모른다.
  {
    const ev = {
      schemaVersion: "1.0.0",
      generatedAt: "2026-08-19T00:00:00Z",
      sourceRepoHead: "d".repeat(40),
      contentHash: "e".repeat(64),
      coverage: { analyzed: 1, total: 1, traversed: 1 },
      truncated: { reason: "none", dropped_commits: 0 },
      commits: [{ id: `commit:${"f".repeat(40)}` }],
    };
    const a = computeArtifactContentHash("evidence", ev);
    const b = computeEvidenceContentHash(ev);
    const ok = a === b;
    if (!ok) console.log(`    실제: artifact-contract=${a} content-hash=${b}`);
    report(ok, "(AC-3) computeArtifactContentHash('evidence')가 content-hash.mjs의 정본 함수와 바이트 동일(알고리즘 닻이 모듈 밖)");
  }

  // ---- (AC-4) generatedAt은 해시 대상에서 제외되는가 ----
  {
    const a = makeCareerInstance([makeCareerNode()]);
    const b = { ...a, generatedAt: "2099-01-01T00:00:00Z" };
    const ok = computeArtifactContentHash("career", a) === computeArtifactContentHash("career", b);
    report(ok, "(AC-4) generatedAt만 다른 두 산출물의 contentHash가 같다(같은 입력 → 같은 해시 결정성)");
  }

  // ---- (AC-5) 허용 방향: 본문이 바뀌면 해시가 바뀌는가 ----
  //      (AC-4)만 두면 "항상 상수를 돌려주는" 해시 함수가 통과한다.
  {
    const a = makeCareerInstance([makeCareerNode()]);
    const b = makeCareerInstance([makeCareerNode({ text: "다른 서술." })]);
    const ok = computeArtifactContentHash("career", a) !== computeArtifactContentHash("career", b);
    report(ok, "(AC-5) 허용 방향: nodes 본문이 바뀌면 contentHash가 바뀐다(상수 해시 함수 방어)");
  }

  // ---- (AC-6) 미지원 계층은 조용히 넘어가지 않는가 ----
  {
    let threw = false;
    try { computeArtifactContentHash("nope", {}); } catch { threw = true; }
    report(threw, "(AC-6) 미지원 계층의 contentHash 요청은 던진다(조용한 스킵 금지)");
  }

  // ---- (CH-1)~(CH-8) instance 부재 fail-closed (순서 9번) ----
  //
  //      **왜 이 절이 있는가.** `computeArtifactContentHash`는 `layer`가 지원 밖이면
  //      던지면서 `instance`에 대해서는 아무것도 보지 않았다 — `instance?.[key]`가 전부
  //      undefined를 대입하고 JSON.stringify가 undefined 값 프로퍼티를 생략하므로,
  //      **없는 본문에 대해 진짜처럼 보이는 64자 무결성 토큰**을 조용히 돌려줬다.
  //      실측(수정 전): null·undefined·false·123·"abc"·[]·[{}]·{} 여덟 입력이 전부
  //      같은 값 44136fa3…caaff8a(= `'{}'`의 SHA-256)였다.
  //
  //      **양방향으로 본다.** 금지 방향만 두면 게이트가 너무 넓어져 정상 객체까지 막는
  //      회귀를 놓친다. `(CH-1)`이 허용 방향을 **정본 리터럴 해시**에 대고 먼저 고정한다 —
  //      「수정 전후가 서로 같다」가 아니라 「기록된 값과 같다」여야 한다. 서로 비교는
  //      두 미지값의 `===`라 양쪽이 함께 틀어지면 우연히 PASS한다(8번 ②가 닫은 모양).
  const EMPTY_CANONICAL_SHA256 = "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a";

  // ---- (CH-1) 허용 방향: 정상 instance는 기존과 바이트 동일한 해시 ----
  //      픽스처 파일이 아니라 **자기완결 리터럴**을 쓴다. 픽스처가 바뀌면 이 앵커가
  //      함께 움직여 「가드가 해시를 바꾸지 않았다」를 더 이상 증명하지 못한다.
  //      아래 상수는 가드를 넣기 **전** 트리에서 측정한 값이다(2026-08-25).
  {
    const inst = {
      schemaVersion: "1.0.0",
      generatedAt: "2026-08-25T00:00:00Z",
      sourceRepoHead: "a".repeat(40),
      contentHash: "b".repeat(64),
      coverage: { analyzed: 2, total: 3, traversed: 3 },
      truncated: { reason: "none", dropped_commits: 0 },
      nodes: [{ id: "car:001", text: "고정 서술.", basis: "commit", evidence: [`commit:${"c".repeat(40)}`] }],
    };
    const EXPECTED = "f0d138b418c272ba738a7428cb55408714a5c0403d299e19c131e101cd0ffd23";
    const got = computeArtifactContentHash("career", inst);
    const ok = got === EXPECTED;
    if (!ok) console.log(`    실제: ${got} (기대 ${EXPECTED} — 가드가 해시 산식을 바꿨다)`);
    report(ok, "(CH-1) 허용 방향: 정상 instance의 contentHash가 가드 도입 전과 바이트 동일(정본 리터럴 대조)");
  }

  // ---- (CH-2)~(CH-6) 금지 방향: 객체가 아닌 스칼라 5종 ----
  //      사유에 **형태 이름**이 들어가야 한다 — 「객체가 아님」만으로는 어느 형태로
  //      들어왔는지가 로그에서 사라진다((SR-7)과 같은 규율).
  {
    const CASES = [
      ["CH-2", null, "null"],
      ["CH-3", undefined, "undefined"],
      ["CH-4", false, "boolean"],
      ["CH-5", 123, "number"],
      ["CH-6", "abc", "string"],
    ];
    for (const [label, value, shape] of CASES) {
      let msg = null;
      let returned;
      try { returned = computeArtifactContentHash("career", value); } catch (e) { msg = e.message; }
      const ok = msg !== null && msg.includes("객체가 아닙니다") && msg.includes(shape);
      if (!ok) console.log(`    실제(${shape}): ${msg === null ? `던지지 않고 ${returned}를 돌려줬다` : msg}`);
      report(ok, `(${label}) 금지 방향: instance가 ${shape}이면 던진다(형태 이름 포함 — '{}'의 해시로 강등하지 않는다)`);
    }
  }

  // ---- (CH-7) 금지 방향: 배열 ----
  //      **따로 두는 이유는 취향이 아니다.** `typeof [] === "object"`이고 `[] !== null`
  //      이라, 가드를 `instance === null || typeof instance !== "object"` 2분기로 짜면
  //      **배열만 조용히 통과한다** — 그리고 그 누수는 (CH-2)~(CH-6)을 하나도 깨지
  //      않으므로 게이트에 흔적이 남지 않는다. 즉 `Array.isArray` 팔을 지우는 변이를
  //      관측하는 단언은 이것 하나뿐이다. 빈 배열과 비지 않은 배열을 함께 본다 —
  //      `[{}]`는 「원소가 있으니 본문이 있다」는 착각이 가장 잘 드는 형태다.
  {
    const bad = [];
    for (const value of [[], [{}], [1, 2]]) {
      let msg = null;
      let returned;
      try { returned = computeArtifactContentHash("career", value); } catch (e) { msg = e.message; }
      if (!(msg !== null && msg.includes("객체가 아닙니다") && msg.includes("array"))) {
        bad.push(`${JSON.stringify(value)} → ${msg === null ? `${returned}` : msg}`);
      }
    }
    if (bad.length > 0) console.log(`    실제: ${bad.join(" / ")}`);
    report(bad.length === 0, "(CH-7) 금지 방향: instance가 배열이면 던진다(2분기 가드가 조용히 새는 유일한 형태 — Array.isArray 팔의 단독 관측점)");
  }

  // ---- (CH-8) 전제 고정: 병렬 재구현은 **여전히** fail-open이다 ----
  //      `content-hash.mjs`의 `computeEvidenceContentHash`는 같은 절차의 독립
  //      재구현인데 가드가 하나도 없다(layer 가드조차 없다). L0 프로덕션 쓰기
  //      (`collect-git-facts.mjs`)와 검증(`invariants.mjs`)이 쓰는 것은 **이쪽**이다.
  //
  //      **그런데 이 파일은 슬라이스 A라 고칠 수 없다**(`9e1cdd2`, 2026-08-18 생성 —
  //      `artifact-contract.mjs`·`write-artifact.mjs`는 `f029375`가 만든 슬라이스 B
  //      파일이라 달랐다). 예외 표에 행을 추가하는 조건은 「그 항목이 회차 작업을
  //      실제로 막을 때」인데 **막지 않는다** — 두 프로덕션 호출부가 모두 상위에서
  //      가드된다(`collect-git-facts.mjs`는 evidence를 지역에서 조립하고,
  //      `checkContentHashInvariant`는 `typeof evidence?.contentHash !== "string"`으로
  //      조기 반환한다. 둘 다 코드로 확인했다). 그래서 **고치지 않고 못 박는다.**
  //
  //      **이 단언이 PASS라는 것은 결함이 살아 있다는 뜻이다.** 누군가 저 함수를
  //      fail-closed로 고치면 여기가 FAIL하고, 그것은 회귀가 아니라 「이 우회로가
  //      아직 필요한지 다시 판단하라」는 신호다 — `(SR-9)`와 같은 성격이다.
  //      이 단언이 없으면 「computeArtifactContentHash가 fail-closed다」를 읽은
  //      다음 회차가 **이 부류가 통째로 닫혔다고 상속한다.**
  //      **던지는 호출을 try/catch 없이 적으면 안 된다 — 실측으로 배웠다.** 초판은
  //      `computeEvidenceContentHash(null)`을 맨몸으로 불렀고, 그 함수를 fail-closed로
  //      고치는 변이(M5)에서 **섹션이 통째로 중단돼** 이 절 뒤 38건이 함께 죽고 사유에
  //      라벨조차 남지 않았다(436 PASS / 3 FAIL — 중단 가드·총량 가드만 빨개졌다).
  //      트립와이어가 자기 이름으로 울리지 못하면 트립와이어가 아니다. `(AC-6)`의
  //      `try { … } catch` 형태를 따른다.
  {
    const hashOrThrow = (v) => {
      try { return computeEvidenceContentHash(v); } catch (e) { return `THREW:${e.message}`; }
    };
    const permissive = [null, undefined, false, 123, "abc", []].every(
      (v) => hashOrThrow(v) === EMPTY_CANONICAL_SHA256
    );
    const strict = hashOrThrow({ schemaVersion: "1.0.0" }) !== EMPTY_CANONICAL_SHA256;
    const ok = permissive && strict;
    if (!ok) {
      console.log(`    실제: permissive=${permissive} strict=${strict} — 비객체 응답 ${JSON.stringify([null, undefined, false, 123, "abc", []].map(hashOrThrow).map((s) => s.slice(0, 24)))}`);
      console.log("    이 단언의 FAIL은 회귀가 아닐 수 있다: content-hash.mjs가 fail-closed로 고쳐졌다면 이 우회로가 아직 필요한지 다시 판단하라((SR-9)와 같은 성격).");
    }
    report(
      ok,
      "(CH-8) 전제 고정: computeEvidenceContentHash는 비객체에 여전히 '{}'의 해시를 돌려준다" +
      "(content-hash.mjs는 슬라이스 A 수정 금지 — 이 비대칭은 닫힌 것이 아니라 못 박아 둔 것이다)"
    );
  }

  // ---- (AC-7) (g) 금지 방향: draft 단계가 verification을 기입하면 위반 ----
  {
    const inst = makeCareerInstance([makeFactCheckedNode({ verification: { status: "verified", attempts: 1, reasonCode: null } })]);
    const v = checkAuthorshipContract("career", inst, { stage: "draft" });
    const ok = v.some((x) => x.code === "VERIFICATION_SET_BY_TEMPLATE");
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(v)}`);
    report(ok, "(AC-7) draft 단계가 verification.status='verified'를 기입하면 VERIFICATION_SET_BY_TEMPLATE(구현 7단계 (g))");
  }

  // ---- (AC-8) 허용 방향: draft가 verification을 **담지 않으면** 통과 ----
  //      이것이 없으면 "무조건 위반을 내는" 검사가 (AC-7)을 통과한다.
  //      **콜드 리뷰 M-1로 계약이 바뀌었다**: 초판은 "draft는 not-attempted만
  //      기입할 수 있다"였고 이 단언도 그 값을 통과시켰다. 그 설계가 스키마의
  //      `not-attempted → attempts const 0`과 재시도 이어받기를 동시에
  //      만족시킬 수 없어 attempts>=1 노드의 draft 재작성을 전면 봉쇄했다
  //      (4갈래 전부 exit 1로 실측). 지금은 **필드 자체가 금지**이며 값은
  //      병합이 채운다. 이것은 "기존 단언을 고쳐 맞춘" 것이 아니라 **단언이
  //      기술하던 설계가 모순임이 밝혀져 설계를 바꾼 것**이다 — 그 구별을
  //      감추지 않으려고 여기 적는다.
  {
    const v = checkAuthorshipContract("career", makeCareerInstance([makeDraftNode()]), { stage: "draft" });
    const ok = v.length === 0;
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(v)}`);
    report(ok, "(AC-8) 허용 방향: draft가 verification을 담지 않으면 위반 0건(값은 병합이 채운다)");
  }

  // ---- (AC-8b) 금지 방향: draft가 not-attempted라도 **담으면** 위반 ----
  //      값이 아니라 필드의 존재가 판정 기준임을 고정한다. 이 단언이 없으면
  //      "verified만 막는" 초판 조건으로 되돌아가도 아무것도 깨지지 않는다.
  {
    const v = checkAuthorshipContract("career", makeCareerInstance([makeFactCheckedNode()]), { stage: "draft" });
    const ok = v.some((x) => x.code === "VERIFICATION_SET_BY_TEMPLATE");
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(v)}`);
    report(ok, "(AC-8b) draft가 not-attempted를 담아도 VERIFICATION_SET_BY_TEMPLATE(값이 아니라 필드 존재가 기준)");
  }

  // ---- (AC-9) 단계 구분이 실제로 작동하는가 ----
  {
    const inst = makeCareerInstance([makeFactCheckedNode({ verification: { status: "verified", attempts: 1, reasonCode: null } })]);
    const v = checkAuthorshipContract("career", inst, { stage: "fact-checked" });
    const ok = v.length === 0;
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(v)}`);
    report(ok, "(AC-9) fact-checked 단계는 verification 기입이 허용된다(단계 구분이 값을 가른다)");
  }

  // ---- (AC-10) origin 기입 주체 ----
  {
    const inst = makeCareerInstance([makeDraftNode({ origin: "user" })]);
    const v = checkAuthorshipContract("career", inst, { stage: "draft" });
    const ok = v.some((x) => x.code === "ORIGIN_SET_BY_TEMPLATE");
    report(ok, "(AC-10) 생성 출력이 origin:'user'를 기입하면 ORIGIN_SET_BY_TEMPLATE(AC-19 언어 린트 자기면제 통로 차단)");
  }

  // ---- (AC-11) origin 규칙은 단계로 완화되지 않는가 ----
  {
    const inst = makeCareerInstance([makeFactCheckedNode({ origin: "user", verification: { status: "verified", attempts: 1, reasonCode: null } })]);
    const v = checkAuthorshipContract("career", inst, { stage: "fact-checked" });
    const ok = v.some((x) => x.code === "ORIGIN_SET_BY_TEMPLATE");
    report(ok, "(AC-11) fact-checked 단계에서도 origin:'user' 기입은 위반이다(단계로 완화되지 않는다)");
  }

  // ---- (AC-12) verification 부재를 통과시키지 않는가(fail-closed) ----
  {
    const node = makeFactCheckedNode();
    delete node.verification;
    const v = checkAuthorshipContract("career", makeCareerInstance([node]), { stage: "fact-checked" });
    const ok = v.some((x) => x.code === "VERIFICATION_MISSING");
    report(ok, "(AC-12) fact-checked 단계의 verification 부재는 VERIFICATION_MISSING이다(부재를 '판정 대상 아님'으로 읽지 않는다)");
  }

  // ---- (AC-13) plan 계층에는 verification 축이 없다(허용 방향) ----
  //      plan 노드는 verificationStatus라는 **다른 축**을 갖는다. 이 구별이
  //      없으면 slice C에서 plan을 쓸 때 존재하지 않는 필드를 요구하게 된다.
  {
    const node = { id: "pln:001", type: "problem", basis: "inference", evidence: [], parentRefs: ["gap:001"], origin: "generated", title: "제목", text: "본문", verificationStatus: "unverified" };
    const v = checkAuthorshipContract("plan", { nodes: [node] }, { stage: "draft" });
    const ok = !v.some((x) => x.code === "VERIFICATION_MISSING" || x.code === "VERIFICATION_SET_BY_TEMPLATE");
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(v)}`);
    report(ok, "(AC-13) plan 계층에는 verification 축 검사를 적용하지 않는다(verificationStatus는 다른 축 — 통합 금지)");
  }

  // ---- (AC-14) 알 수 없는 stage는 던지는가 ----
  {
    let threw = false;
    try { checkAuthorshipContract("career", makeCareerInstance([makeCareerNode()]), { stage: "whatever" }); } catch { threw = true; }
    report(threw, "(AC-14) 알 수 없는 stage는 던진다(오타가 조용히 검사를 끄지 않는다)");
  }

  // ---- (AC-15) locked 노드는 draft에 없어도 살아남는가(AC-16) ----
  {
    const prev = makeCareerInstance([
      makeCareerNode({ id: "car:001" }),
      makeCareerNode({ id: "car:002", locked: true, text: "사용자가 손으로 고친 서술." }),
    ]);
    const draft = makeCareerInstance([makeCareerNode({ id: "car:001" })]);
    const { merged, violations } = mergeArtifact("career", prev, draft, { stage: "fact-checked" });
    const ok = violations.length === 0 && merged.nodes.some((n) => n.id === "car:002" && n.text === "사용자가 손으로 고친 서술.");
    if (!ok) console.log(`    실제: ${JSON.stringify(merged.nodes.map((n) => n.id))} 위반=${JSON.stringify(violations)}`);
    report(ok, "(AC-15) locked 노드는 draft에 없어도 병합 결과에 보존된다(AC-16 사용자 편집 보존)");
  }

  // ---- (AC-16) locked 노드는 같은 id의 draft가 덮어쓰지 못하는가 ----
  {
    const prev = makeCareerInstance([makeCareerNode({ id: "car:001", locked: true, text: "사용자 원문." })]);
    const draft = makeCareerInstance([makeCareerNode({ id: "car:001", text: "LLM이 새로 쓴 문장." })]);
    const { merged } = mergeArtifact("career", prev, draft, { stage: "fact-checked" });
    const ok = merged.nodes[0].text === "사용자 원문.";
    if (!ok) console.log(`    실제: ${merged.nodes[0].text}`);
    report(ok, "(AC-16) locked 노드는 같은 id의 draft가 덮어쓰지 못한다(prev가 이긴다)");
  }

  // ---- (AC-17) 허용 방향: locked가 아닌 prev 노드는 draft에 없으면 사라지는가 ----
  //      이것이 없으면 "prev를 전부 보존하는" 병합이 (AC-15)를 통과하고,
  //      재생성이 사실상 누적만 하는 동작이 된다.
  {
    const prev = makeCareerInstance([makeCareerNode({ id: "car:001" }), makeCareerNode({ id: "car:009", text: "낡은 서술." })]);
    const draft = makeCareerInstance([makeCareerNode({ id: "car:001" })]);
    const { merged } = mergeArtifact("career", prev, draft, { stage: "fact-checked" });
    const ok = !merged.nodes.some((n) => n.id === "car:009");
    if (!ok) console.log(`    실제: ${JSON.stringify(merged.nodes.map((n) => n.id))}`);
    report(ok, "(AC-17) 허용 방향: locked=false인 prev 노드는 draft에 없으면 사라진다(전량 보존 병합 방어)");
  }

  // ---- (AC-18) 동일 text가 새 id로 오면 churn 위반인가(구현 7단계 (b)) ----
  {
    const prev = makeCareerInstance([makeCareerNode({ id: "car:001" })]);
    const draft = makeCareerInstance([makeCareerNode({ id: "car:777" })]);
    const { violations } = mergeArtifact("career", prev, draft, { stage: "fact-checked" });
    const ok = violations.some((v) => v.code === "NODE_ID_CHURN" && v.message.includes("car:001"));
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(violations)}`);
    report(ok, "(AC-18) 동일 text가 새 id로 오면 NODE_ID_CHURN이고 메시지가 기존 id를 지목한다(AC-16 재실행 안정성)");
  }

  // ---- (AC-19) 허용 방향: 진짜 신규 항목의 새 id는 위반이 아닌가 ----
  {
    const prev = makeCareerInstance([makeCareerNode({ id: "car:001" })]);
    const draft = makeCareerInstance([makeCareerNode({ id: "car:001" }), makeCareerNode({ id: "car:002", text: "새로 발견한 사실." })]);
    const { violations } = mergeArtifact("career", prev, draft, { stage: "fact-checked" });
    const ok = violations.length === 0;
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(violations)}`);
    report(ok, "(AC-19) 허용 방향: 새 text의 새 id는 위반이 아니다(모든 신규 id를 막는 병합 방어)");
  }

  // ---- (AC-20) prev에 같은 text가 2건이면 churn 판정을 하지 않는가 ----
  //      대응이 모호한데 위반을 만들면 근거 없는 FAIL이 된다.
  {
    const prev = makeCareerInstance([makeCareerNode({ id: "car:001" }), makeCareerNode({ id: "car:002" })]);
    const draft = makeCareerInstance([makeCareerNode({ id: "car:777" })]);
    const { violations } = mergeArtifact("career", prev, draft, { stage: "fact-checked" });
    const ok = !violations.some((v) => v.code === "NODE_ID_CHURN");
    report(ok, "(AC-20) prev에 동일 text가 2건이면 대응이 모호하므로 churn 판정에서 뺀다");
  }

  // ---- (AC-21) 재시도 상한이 초기화되면 위반인가(AC-13 (iii)) ----
  {
    const prev = makeCareerInstance([makeCareerNode({ id: "car:001", verification: { status: "refuted", attempts: 2, reasonCode: "NO_SUPPORTING_DIFF" } })]);
    const draft = makeCareerInstance([makeCareerNode({ id: "car:001" })]);
    const { violations } = mergeArtifact("career", prev, draft, { stage: "fact-checked" });
    const ok = violations.some((v) => v.code === "VERIFICATION_ATTEMPTS_RESET");
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(violations)}`);
    report(ok, "(AC-21) verification.attempts가 2→0으로 줄면 VERIFICATION_ATTEMPTS_RESET(§3 재생성 상한 무력화 방어)");
  }

  // ---- (AC-22) 허용 방향: 유지·증가는 위반이 아닌가 ----
  {
    const prev = makeCareerInstance([makeCareerNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } })]);
    const draft = makeCareerInstance([makeCareerNode({ id: "car:001", verification: { status: "refuted", attempts: 2, reasonCode: "NO_SUPPORTING_DIFF" } })]);
    const { violations } = mergeArtifact("career", prev, draft, { stage: "fact-checked" });
    const ok = violations.length === 0;
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(violations)}`);
    report(ok, "(AC-22) 허용 방향: attempts 1→2 증가는 위반이 아니다(모든 변화를 막는 검사 방어)");
  }

  // ---- (AC-47)~(AC-54) fact-checked 단계 불변식 넷의 양방향 관측 ----
  //      콜드 리뷰 라운드 2 처방 3. 라운드 2 §1이 「판정 단계 이후는 전면 무집행」이라
  //      적었고, 이번 공격 실측은 그것이 무집행에 그치지 않는다는 것을 보였다 —
  //      **삭제가 다른 축의 집행을 지우는 도구가 된다**(레포에 없는 해시를 인용한
  //      노드를 지우자 verify-evidence가 [FAIL]에서 [PASS] exit 0으로 뒤집혔다).
  //
  //      네 불변식 각각에 **금지 방향과 허용 방향**을 짝으로 둔다. 허용 방향이 없으면
  //      「전부 거부하는」 구현이 금지 방향만 보고 통과한다.

  // ---- (AC-47) 금지: 승인 판정이 다른 문장에 따라붙는가 ----
  {
    const prev = makeCareerInstance([makeCareerNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } })]);
    const draft = makeCareerInstance([makeCareerNode({ id: "car:001", text: "나는 분산 트랜잭션 엔진을 단독 설계해 상용화했다." })]);
    const { violations } = mergeArtifact("career", prev, draft, { stage: "draft" });
    const ok = violations.some((v) => v.code === "VERIFIED_CLAIM_REWRITTEN");
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(violations)}`);
    report(ok, "(AC-47) 금지 방향: verified 판정을 이어받으면서 text가 바뀌면 VERIFIED_CLAIM_REWRITTEN(판정이 주장이 아니라 id에 붙는 것 차단)");
  }

  // ---- (AC-48) 허용: refuted 승계는 text가 바뀌어도 통과하는가 ----
  //      **이 단언이 (AC-47)의 경계를 정한다.** `(WA-17)`이 CLI 층에서 못 박은 것을
  //      함수 층에서 되비춘다 — 「text가 다르면 승계 금지」를 통째로 걸면 콜드 리뷰
  //      M-1의 막다른 길(재작성이 네 갈래 모두 exit 1)이 되살아난다.
  {
    const prev = makeCareerInstance([makeCareerNode({ id: "car:001", verification: { status: "refuted", attempts: 2, reasonCode: "NO_SUPPORTING_DIFF" } })]);
    const draft = makeCareerInstance([makeCareerNode({ id: "car:001", text: "표현을 다듬은 같은 사실." })]);
    const { violations } = mergeArtifact("career", prev, draft, { stage: "draft" });
    const ok = violations.length === 0;
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(violations)}`);
    report(ok, "(AC-48) 허용 방향: refuted 승계는 text가 바뀌어도 위반이 아니다(불리한 판정이 따라가는 것은 보수적 — (WA-17)의 함수 단위 거울)");
  }

  // ---- (AC-49) 금지: 반증 확정 노드가 조용히 사라지는가 ----
  {
    const prev = makeCareerInstance([
      makeCareerNode({ id: "car:001", verification: { status: "refuted", attempts: 2, reasonCode: "NO_SUPPORTING_DIFF" } }),
      makeCareerNode({ id: "car:002", text: "다른 사실." }),
    ]);
    const draft = makeCareerInstance([makeCareerNode({ id: "car:002", text: "다른 사실." })]);
    const { violations } = mergeArtifact("career", prev, draft, { stage: "fact-checked" });
    const ok = violations.some((v) => v.code === "REFUTED_NODE_DROPPED");
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(violations)}`);
    report(ok, "(AC-49) 금지 방향: 잠기지 않은 refuted 노드가 draft에서 빠지면 REFUTED_NODE_DROPPED(지워진 판정은 복구도 사후 판독도 불가능하다)");
  }

  // ---- (AC-50) 허용: 미판정 노드의 소실은 여전히 정상인가 ----
  //      `(AC-17)`이 「재생성이 대체한다」를 허용 방향으로 못 박았다. 그것까지
  //      막으면 병합이 누적만 하는 동작이 된다.
  {
    const prev = makeCareerInstance([makeCareerNode({ id: "car:001" }), makeCareerNode({ id: "car:002", text: "다른 사실." })]);
    const draft = makeCareerInstance([makeCareerNode({ id: "car:002", text: "다른 사실." })]);
    const { violations } = mergeArtifact("career", prev, draft, { stage: "fact-checked" });
    const ok = violations.length === 0;
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(violations)}`);
    report(ok, "(AC-50) 허용 방향: not-attempted 비잠금 노드의 소실은 위반이 아니다(전량 보존 병합 방어 — (AC-17)의 경계 유지)");
  }

  // ---- (AC-51) 금지: 상한을 소진한 강등이 승격으로 뒤집히는가 ----
  //      기존 VERIFICATION_ATTEMPTS_RESET과 **방향이 거꾸로 서 있었다**(실측):
  //      정직한 취소(refuted/2 → not-attempted/0)는 exit 1로 막히는데
  //      최고 등급 승격(refuted/2 → verified/2)은 exit 0으로 통과했다.
  {
    const prev = makeCareerInstance([makeCareerNode({ id: "car:001", verification: { status: "refuted", attempts: 2, reasonCode: "NO_SUPPORTING_DIFF" } })]);
    const draft = makeCareerInstance([makeCareerNode({ id: "car:001", verification: { status: "verified", attempts: 2, reasonCode: null } })]);
    const { violations } = mergeArtifact("career", prev, draft, { stage: "fact-checked" });
    const ok = violations.some((v) => v.code === "VERDICT_PROMOTED_AFTER_REFUTED");
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(violations)}`);
    report(ok, "(AC-51) 금지 방향: refuted → verified 승격은 VERDICT_PROMOTED_AFTER_REFUTED(상한 소진 후의 승인은 재판정이 아니라 날조다)");
  }

  // ---- (AC-52) 허용: 강등 방향은 열려 있는가 ----
  {
    const prev = makeCareerInstance([makeCareerNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } })]);
    const draft = makeCareerInstance([makeCareerNode({ id: "car:001", verification: { status: "refuted", attempts: 2, reasonCode: "NO_SUPPORTING_DIFF" } })]);
    const { violations } = mergeArtifact("career", prev, draft, { stage: "fact-checked" });
    const ok = !violations.some((v) => v.code === "VERDICT_PROMOTED_AFTER_REFUTED");
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(violations)}`);
    report(ok, "(AC-52) 허용 방향: verified → refuted 강등은 막지 않는다(불리해지는 변경은 보수적이다)");
  }

  // ---- (AC-53) 금지: 시도 0회의 승인이 통과하는가 ----
  //      스키마는 not-attempted ⇒ attempts 0, refuted ⇒ attempts 2를 못 박는데
  //      **verified만 attempts에 아무 조건이 없다.** 그 빈 칸을 런타임이 채운다.
  {
    const inst = makeCareerInstance([makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 0, reasonCode: null } })]);
    const violations = checkAuthorshipContract("career", inst, { stage: "fact-checked" });
    const ok = violations.some((v) => v.code === "VERIFIED_WITHOUT_ATTEMPT");
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(violations)}`);
    report(ok, "(AC-53) 금지 방향: fact-checked 출력의 verified + attempts 0은 VERIFIED_WITHOUT_ATTEMPT(FactChecker를 돌리지 않은 자칭 승인)");
  }

  // ---- (AC-54) 허용: 정상 판정 둘은 통과하는가 ----
  {
    const okInst = makeCareerInstance([
      makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } }),
      makeFactCheckedNode({ id: "car:002", text: "다른 사실.", verification: { status: "not-attempted", attempts: 0, reasonCode: null } }),
    ]);
    const violations = checkAuthorshipContract("career", okInst, { stage: "fact-checked" });
    const ok = !violations.some((v) => v.code === "VERIFIED_WITHOUT_ATTEMPT");
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(violations)}`);
    report(ok, "(AC-54) 허용 방향: verified + attempts 1과 not-attempted + attempts 0은 위반이 아니다(attempts 0을 통째로 막는 검사 방어)");
  }

  // ---- (AC-55) 계층 중립: 세 계층 전부에서 같은 불변식이 도는가 ----
  //      네 불변식은 `hasVerificationAxis` 아래에 있어 `VERIFICATION_LAYERS`의 세
  //      계층에 함께 걸린다. **그 중립성을 가정이 아니라 단언으로 만든다** —
  //      career 하나만 관측하면 다른 두 계층에서 빠져도 아무도 모른다.
  //      `plan`은 `verificationStatus`라는 **다른 축**이므로 사정권 밖이고,
  //      그 사실도 함께 관측한다(넓게 걸리는 것도 결함이다).
  {
    const selfDeclared = (layer) => ({
      nodes: [{ id: `${layer}:001`, text: "주장.", verification: { status: "verified", attempts: 0, reasonCode: null } }],
    });
    const covered = VERIFICATION_LAYERS.filter((layer) =>
      checkAuthorshipContract(layer, selfDeclared(layer), { stage: "fact-checked" })
        .some((v) => v.code === "VERIFIED_WITHOUT_ATTEMPT")
    );
    const planHit = checkAuthorshipContract("plan", selfDeclared("plan"), { stage: "fact-checked" })
      .some((v) => v.code === "VERIFIED_WITHOUT_ATTEMPT");
    const ok = covered.length === VERIFICATION_LAYERS.length && VERIFICATION_LAYERS.length === 3 && !planHit;
    if (!ok) console.log(`    실제: 걸린 계층 ${JSON.stringify(covered)} / plan에도 걸림=${planHit}`);
    report(ok, "(AC-55) 계층 중립: VERIFICATION_LAYERS 세 계층 전부가 VERIFIED_WITHOUT_ATTEMPT를 내고 plan은 내지 않는다(다른 축이다)");
  }

  // ---- (AC-23) origin은 prev를 이어받는가(구현 7단계 (g) 병합 몫) ----
  {
    const prev = makeCareerInstance([makeCareerNode({ id: "car:001", origin: "user" })]);
    const draft = makeCareerInstance([makeCareerNode({ id: "car:001" })]);
    const { merged } = mergeArtifact("career", prev, draft, { stage: "fact-checked" });
    const ok = merged.nodes[0].origin === "user";
    if (!ok) console.log(`    실제: origin=${merged.nodes[0].origin}`);
    report(ok, "(AC-23) 기존 노드의 origin은 prev를 이어받는다(사용자 수동 추가분이 재생성으로 generated가 되지 않는다)");
  }

  // ---- (AC-24) 신규 노드의 origin은 generated인가 ----
  {
    const draft = makeCareerInstance([makeCareerNode({ id: "car:001" })]);
    const { merged } = mergeArtifact("career", null, draft, { stage: "fact-checked" });
    const ok = merged.nodes[0].origin === "generated";
    report(ok, "(AC-24) 신규 노드의 origin은 병합이 'generated'로 정한다(템플릿 값이 정본이 아니다)");
  }

  // ---- (AC-25) 산출물 안의 id 중복은 잡히는가 ----
  {
    const draft = makeCareerInstance([makeCareerNode({ id: "car:001" }), makeCareerNode({ id: "car:001", text: "다른 서술." })]);
    const { violations } = mergeArtifact("career", null, draft, { stage: "fact-checked" });
    const ok = violations.some((v) => v.code === "NODE_ID_DUPLICATE");
    report(ok, "(AC-25) 산출물 안에 같은 id가 2건이면 NODE_ID_DUPLICATE(병합 키가 성립하지 않는다)");
  }

  // ---- (AC-26) 최초 실행(prev 없음)은 위반 0건인가 ----
  {
    const draft = makeCareerInstance([makeCareerNode()]);
    const { merged, violations } = mergeArtifact("career", null, draft, { stage: "fact-checked" });
    const ok = violations.length === 0 && merged.nodes.length === 1;
    report(ok, "(AC-26) prev가 없는 최초 실행은 위반 0건이고 draft 노드가 그대로 남는다");
  }

  // ---- (AC-27) 병합 픽스처가 실제로 스키마를 통과하는가 ----
  //      R-9와 같은 이유다 — 픽스처가 스키마를 어기면 위 26개 단언은 전부
  //      녹색인 채로 현실의 어떤 산출물과도 대응하지 않는 검사가 된다.
  {
    const { json: schema, error: schemaError } = readRepoJsonSafe(SCHEMA_REL("career"));
    if (schemaError !== null) console.log(`    실제: ${schemaError}`);
    const inst = makeCareerInstance([
      makeCareerNode({ id: "car:001" }),
      makeCareerNode({ id: "car:002", locked: true, verification: { status: "refuted", attempts: 2, reasonCode: "NO_SUPPORTING_DIFF" } }),
    ]);
    const errs = schemaError !== null ? [schemaError] : validateInstance(schema, inst);
    const ok = errs.length === 0;
    if (!ok) console.log(`    실제: ${JSON.stringify(errs)}`);
    report(ok, "(AC-27) 병합 오라클 픽스처가 career.schema.json을 실제로 통과한다(픽스처를 세계로 착각하지 않는다)");
  }

  // ---- (AC-28) draft 병합이 prev의 판정을 그대로 이어받는가(콜드 리뷰 M-1) ----
  //      M-1의 본체다. 초판에서는 prev에 attempts>=1인 비잠금 노드가 있으면
  //      그 노드를 draft로 재작성할 방법이 **하나도 없었다**(4갈래 전부 exit 1
  //      실측). 이제 draft는 그 필드를 담지 않고 병합이 prev 값을 옮기므로
  //      **attempts 초기화가 표현 자체로 불가능**하다.
  {
    const prev = makeCareerInstance([makeCareerNode({ id: "car:001", verification: { status: "refuted", attempts: 2, reasonCode: "NO_SUPPORTING_DIFF" } })]);
    const draft = makeCareerInstance([makeDraftNode({ id: "car:001" })]);
    const { merged, violations } = mergeArtifact("career", prev, draft, { stage: "draft" });
    // 판정을 안 채우는 변이에서 여기가 예외로 죽으면 섹션이 통째로 중단되어
    // 어떤 단언이 대응하는지 읽을 수 없다(변이 N2에서 실측) — 옵셔널로 읽는다.
    const v = merged.nodes[0]?.verification;
    const ok = violations.length === 0 && v?.status === "refuted" && v?.attempts === 2 && v?.reasonCode === "NO_SUPPORTING_DIFF";
    if (!ok) console.log(`    실제: 위반=${JSON.stringify(violations)} verification=${JSON.stringify(v)}`);
    report(ok, "(AC-28) draft 병합은 prev의 verification을 그대로 이어받는다(attempts 초기화가 표현 불가 — 콜드 리뷰 M-1)");
  }

  // ---- (AC-29) draft 병합의 신규 노드는 초기 판정을 받는가 ----
  {
    const { merged } = mergeArtifact("career", null, makeCareerInstance([makeDraftNode({ id: "car:001" })]), { stage: "draft" });
    const v = merged.nodes[0].verification;
    const ok = v?.status === "not-attempted" && v.attempts === 0 && v.reasonCode === null;
    if (!ok) console.log(`    실제: ${JSON.stringify(v)}`);
    report(ok, "(AC-29) draft 병합의 신규 노드는 {not-attempted, 0, null}을 받는다(스키마 required를 병합이 채운다)");
  }

  // ---- (AC-30) 허용 방향: fact-checked 병합은 판정을 덮어쓰지 않는가 ----
  //      이것이 없으면 "항상 prev를 이어받는" 병합이 (AC-28)을 통과하고
  //      FactChecker의 판정이 영원히 반영되지 않는다.
  {
    const prev = makeCareerInstance([makeCareerNode({ id: "car:001", verification: { status: "not-attempted", attempts: 0, reasonCode: null } })]);
    const draft = makeCareerInstance([makeCareerNode({ id: "car:001", verification: { status: "refuted", attempts: 2, reasonCode: "NO_SUPPORTING_DIFF" } })]);
    const { merged } = mergeArtifact("career", prev, draft, { stage: "fact-checked" });
    const ok = merged.nodes[0].verification.status === "refuted" && merged.nodes[0].verification.attempts === 2;
    if (!ok) console.log(`    실제: ${JSON.stringify(merged.nodes[0].verification)}`);
    report(ok, "(AC-30) 허용 방향: fact-checked 병합은 draft의 판정을 그대로 쓴다(항상 prev를 이어받는 병합 방어)");
  }

  // ---- (AC-31) nodes 비배열을 빈 배열로 강등하지 않는가(콜드 리뷰 M-3) ----
  //      실측: 강등하던 초판에서는 nodes 필드가 없는 draft가 **exit 0으로
  //      성공하면서** 잠기지 않은 prev 노드를 지웠다.
  {
    const inst = makeCareerInstance([]);
    delete inst.nodes;
    const v = checkAuthorshipContract("career", inst, { stage: "draft" });
    const ok = v.some((x) => x.code === "NODES_NOT_ARRAY");
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(v)}`);
    report(ok, "(AC-31) nodes가 배열이 아니면 NODES_NOT_ARRAY다(빈 배열 강등 금지 — 콜드 리뷰 M-3)");
  }

  // ---- (AC-32) 병합도 같은 입력을 거부하는가 ----
  //      기입 주체 검사만 막으면 mergeArtifact를 직접 부르는 호출자에게는
  //      같은 fail-open이 남는다.
  {
    const prev = makeCareerInstance([makeCareerNode({ id: "car:001" }), makeCareerNode({ id: "car:002", locked: true, text: "잠긴 서술." })]);
    const bad = makeCareerInstance([]);
    delete bad.nodes;
    const { violations } = mergeArtifact("career", prev, bad, { stage: "fact-checked" });
    const ok = violations.some((x) => x.code === "NODES_NOT_ARRAY");
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(violations)}`);
    report(ok, "(AC-32) mergeArtifact도 nodes 비배열을 NODES_NOT_ARRAY로 거부한다(잠기지 않은 prev 노드 조용한 삭제 차단)");
  }

  // ---- (AC-33) 병합이 stage 없이 불리면 던지는가 ----
  //      기본값을 두면 호출자가 빠뜨렸을 때 조용히 한쪽 의미로 돈다.
  {
    let threw = false;
    try { mergeArtifact("career", null, makeCareerInstance([makeCareerNode()])); } catch { threw = true; }
    report(threw, "(AC-33) mergeArtifact는 stage 없이 부르면 던진다(기본값으로 조용히 한쪽 의미가 되지 않는다)");
  }

  // ---- (AC-34) 금지 방향: draft가 locked를 담으면 위반인가(게이트 B-7) ----
  //      생성 템플릿이 자기 노드를 잠그면 그 노드는 이후 재생성에서 영원히
  //      보존되어 2단 팩트체크의 사정권 밖으로 나간다 — (g)가 닫으려는
  //      자기면제와 같은 구조다.
  {
    const inst = makeCareerInstance([{ ...makeDraftNode(), locked: true }]);
    const v = checkAuthorshipContract("career", inst, { stage: "draft" });
    const ok = v.some((x) => x.code === "LOCKED_SET_BY_TEMPLATE");
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(v)}`);
    report(ok, "(AC-34) draft가 locked를 담으면 LOCKED_SET_BY_TEMPLATE다(게이트 B-7)");
  }

  // ---- (AC-35) 값이 아니라 필드의 존재가 기준인가 ----
  //      `locked: false`만 허용하는 판으로 되돌아가도 (AC-34)는 그대로
  //      녹색이다 — M-1에서 배운 형태다. 이 단언이 그 회귀를 잡는다.
  {
    const inst = makeCareerInstance([{ ...makeDraftNode(), locked: false }]);
    const v = checkAuthorshipContract("career", inst, { stage: "draft" });
    const ok = v.some((x) => x.code === "LOCKED_SET_BY_TEMPLATE");
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(v)}`);
    report(ok, "(AC-35) locked:false를 담아도 LOCKED_SET_BY_TEMPLATE다(값이 아니라 필드 존재가 기준 — 게이트 B-7)");
  }

  // ---- (AC-36) 단계로 완화되지 않는가 ----
  //      fact-checked 출력을 조립하는 주체도 같은 오케스트레이션이다.
  //      한쪽 단계만 막으면 다른 쪽으로 새는 같은 구멍이 남는다(origin과 동형).
  {
    const inst = makeCareerInstance([{ ...makeFactCheckedNode(), locked: true }]);
    const v = checkAuthorshipContract("career", inst, { stage: "fact-checked" });
    const ok = v.some((x) => x.code === "LOCKED_SET_BY_TEMPLATE");
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(v)}`);
    report(ok, "(AC-36) fact-checked 단계에서도 locked 기입은 위반이다(단계로 완화되지 않는다 — 게이트 B-7)");
  }

  // ---- (AC-37) 계층 중립인가 — verification 축이 없는 plan에도 걸리는가 ----
  //      locked 보존은 모든 계층의 병합 규칙 1이므로 자기면제 통로도 모든
  //      계층에 있다. verification 축 안쪽에 두면 plan만 뚫린다.
  {
    const node = { id: "pln:001", type: "problem", basis: "inference", evidence: [], parentRefs: ["gap:001"], origin: "generated", locked: true, title: "제목", text: "본문", verificationStatus: "unverified" };
    const v = checkAuthorshipContract("plan", { nodes: [node] }, { stage: "draft" });
    const ok = v.some((x) => x.code === "LOCKED_SET_BY_TEMPLATE");
    if (!ok) console.log(`    실제 위반: ${JSON.stringify(v)}`);
    report(ok, "(AC-37) verification 축이 없는 plan 계층에서도 locked 기입은 위반이다(계층 중립 — 게이트 B-7)");
  }

  // ---- (AC-38) 허용 방향: locked를 담지 않으면 위반 0건인가 ----
  //      이것이 없으면 "무조건 LOCKED 위반을 내는" 검사가 위 넷을 통과하고
  //      정상 draft가 영원히 쓰이지 못한다.
  {
    const vd = checkAuthorshipContract("career", makeCareerInstance([makeDraftNode()]), { stage: "draft" });
    const vf = checkAuthorshipContract("career", makeCareerInstance([makeFactCheckedNode()]), { stage: "fact-checked" });
    const ok = vd.length === 0 && vf.length === 0;
    if (!ok) console.log(`    실제 위반: draft=${JSON.stringify(vd)} fact-checked=${JSON.stringify(vf)}`);
    report(ok, "(AC-38) 허용 방향: locked를 담지 않은 출력은 두 단계 모두 위반 0건이다(게이트 B-7)");
  }

  // ---- (AC-39) 병합이 prev의 잠금을 보존하고 비잠금은 false로 채우는가 ----
  //      스키마가 locked를 required로 두므로 **누군가는 채워야** 한다. 기입
  //      주체가 생성 출력이 아니라면 남는 것은 병합뿐이다(verification과 동형).
  //
  //      **초판 서술을 정정한다(콜드 리뷰 지적).** 이 단언을 「병합이 locked를
  //      prev에서 **이어받는다**」로 적었는데, 아래 (a) 서브케이스가 겨냥한
  //      `locked: prevNode.locked === true`는 그 자리에 도달하는 시점에 이미
  //      `prevNode.locked !== true`임이 규칙 1의 early-return으로 보장돼 있어
  //      **도달 가능한 모든 경로에서 리터럴 false와 동치**다. 그 줄을
  //      `locked: false`로 바꿔도 스위트 전체가 그대로 통과하는 것을 변이로
  //      실측했다. 즉 (a)는 「이어받기」를 관측하지 못한다 — 관측하는 것은
  //      「비잠금 노드는 false로 나온다」이고, 진짜 이어받기(true 보존)는
  //      규칙 1이 하며 (b) 서브케이스와 (AC-41)이 본다.
  //
  //      **그럼에도 프로덕션 쪽을 리터럴 false로 단순화하지 않는다.** 지금의
  //      중복 표현식은 규칙 1의 early-return이 나중에 옮겨지거나 사라져도
  //      올바르게 동작하는 방어적 중복이다. 리터럴로 바꾸면 그 리팩터링에서
  //      조용한 잠금 유실이 생긴다.
  {
    const prev = makeCareerInstance([makeCareerNode({ id: "car:001", locked: true, text: "사용자 원문." })]);
    // 잠긴 노드는 규칙 1이 prev를 통째로 이기므로, 이어받기는 **비잠금** 노드로 본다.
    const prevUnlocked = makeCareerInstance([makeCareerNode({ id: "car:001", locked: false })]);
    const draft = makeCareerInstance([makeFactCheckedNode({ id: "car:001" })]);
    const a = mergeArtifact("career", prevUnlocked, draft, { stage: "fact-checked" }).merged;
    const b = mergeArtifact("career", prev, makeCareerInstance([makeFactCheckedNode({ id: "car:001", text: "사용자 원문." })]), { stage: "fact-checked" }).merged;
    const ok = a.nodes[0].locked === false && b.nodes[0].locked === true;
    if (!ok) console.log(`    실제: 비잠금=${a.nodes[0].locked} 잠금=${b.nodes[0].locked}`);
    report(ok, "(AC-39) 병합은 prev의 잠금을 보존하고(b) 비잠금 노드는 false로 채운다(a) — 스키마 required를 병합이 채운다(게이트 B-7)");
  }

  // ---- (AC-40) 신규 노드는 locked:false를 받는가 ----
  {
    const { merged } = mergeArtifact("career", null, makeCareerInstance([makeFactCheckedNode({ id: "car:001" })]), { stage: "fact-checked" });
    const ok = merged.nodes[0].locked === false;
    if (!ok) console.log(`    실제: locked=${JSON.stringify(merged.nodes[0].locked)}`);
    report(ok, "(AC-40) 병합의 신규 노드는 locked:false를 받는다(갓 생성된 노드가 잠긴 상태일 수 없다)");
  }

  // ---- (AC-41) 병합도 draft의 locked를 덮어쓰는가(두 가드 독립) ----
  //      기입 주체 검사만 막으면 `mergeArtifact`를 직접 부르는 호출자에게는
  //      구멍이 남는다 — N5·N6에서 실측된 형태다. 여기서는 검사를 우회해
  //      병합만 부른다.
  {
    const prev = makeCareerInstance([makeCareerNode({ id: "car:001", locked: false })]);
    const sneaky = makeCareerInstance([{ ...makeFactCheckedNode({ id: "car:001" }), locked: true }]);
    const { merged } = mergeArtifact("career", prev, sneaky, { stage: "fact-checked" });
    const okExisting = merged.nodes[0].locked === false;
    const fresh = mergeArtifact("career", null, makeCareerInstance([{ ...makeFactCheckedNode({ id: "car:002" }), locked: true }]), { stage: "fact-checked" }).merged;
    const okFresh = fresh.nodes[0].locked === false;
    const ok = okExisting && okFresh;
    if (!ok) console.log(`    실제: 기존=${merged.nodes[0].locked} 신규=${fresh.nodes[0].locked}`);
    report(ok, "(AC-41) 병합은 draft가 실은 locked:true를 prev 값/false로 덮어쓴다(기입 주체 검사와 독립인 두 번째 가드)");
  }

  // ---- (AC-42) B-7 병합 결과가 실제로 스키마를 통과하는가 ----
  //      locked를 병합이 채우게 바꿨으니 **required를 정말 만족하는지**를
  //      함께 물어야 한다. 안 물으면 통과하지만 현실의 어떤 산출물과도
  //      대응하지 않는 검사가 된다(R-9에서 실측된 형태다).
  {
    // 이 절은 (AC-27)과 같은 파일을 읽지만 **변수를 공유하지 않는다.** 공유하면 앞 절을 지우는
    // 순간 이 절이 참조할 선언이 함께 사라지는 결합이 생긴다 — 이 레포는 절 단위 독립성을
    // 반복해서 우선해 왔고, 대가는 수 KB 재판독뿐이다.
    const { json: schema, error: schemaError } = readRepoJsonSafe(SCHEMA_REL("career"));
    if (schemaError !== null) console.log(`    실제: ${schemaError}`);
    const { merged } = mergeArtifact("career", null, makeCareerInstance([makeDraftNode({ id: "car:001" })]), { stage: "draft" });
    merged.contentHash = computeArtifactContentHash("career", merged);
    const errs = schemaError !== null ? [schemaError] : validateInstance(schema, merged);
    const ok = errs.length === 0;
    if (!ok) console.log(`    실제: ${JSON.stringify(errs)}`);
    report(ok, "(AC-42) locked·verification을 담지 않은 draft의 병합 결과가 career.schema.json을 통과한다(병합이 required를 실제로 채운다)");
  }

  // ---- (AC-43) prevDerived가 merged.nodes와 인덱스로 정렬되고 네 경로를 구별하는가 (10번) ----
  //      **인덱스 정렬이 이 기록의 전부다.** `mergedNodes`와 `prevDerived`에 push하는
  //      지점이 네 곳이고, 한 곳에서 빠뜨리면 이후 전량이 한 칸씩 밀려 **엉뚱한 노드를
  //      prev 유래로 판정한다** — 그리고 그 오판은 조용하다(exit 3이 나긴 나므로).
  //      그래서 길이 일치와 네 경로의 값을 **한 번의 병합**에서 함께 본다.
  //
  //      네 경로: ① prev의 locked 노드를 draft가 같은 id로 덮어쓰려 함(규칙 1, whole)
  //      ② prev에 있던 비잠금 노드를 draft가 갱신(부분 — origin·locked·verification)
  //      ③ 신규 노드(prev 기여 0) ④ draft에 없던 locked 생존자(규칙 1의 두 번째 경로, whole).
  {
    const prev = makeCareerInstance([
      makeCareerNode({ id: "car:001", locked: true, text: "잠긴 노드." }),
      makeCareerNode({ id: "car:002", locked: false, text: "갱신될 노드.", verification: { status: "verified", attempts: 2, reasonCode: null } }),
      makeCareerNode({ id: "car:009", locked: true, text: "draft에 없는 잠긴 생존자." }),
    ]);
    const draft = makeCareerInstance([
      makeDraftNode({ id: "car:001", text: "덮어쓰려는 시도." }),
      makeDraftNode({ id: "car:002", text: "갱신된 서술." }),
      makeDraftNode({ id: "car:003", text: "새로 생긴 노드." }),
    ]);
    const { merged, prevDerived } = mergeArtifact("career", prev, draft, { stage: "draft" });
    // 인덱스 정렬 — 길이가 같고, 각 자리의 판정이 그 자리 노드의 실제 출처와 맞는가.
    const aligned = Array.isArray(prevDerived) && prevDerived.length === merged.nodes.length;
    const shape = aligned
      ? merged.nodes.map((n, i) => `${n.id}:${prevDerived[i].whole ? "whole" : prevDerived[i].fields.join("+") || "none"}`)
      : null;
    const EXPECTED = [
      "car:001:whole",                          // ① 잠긴 노드는 draft를 이기고 통째로 보존된다
      "car:002:origin+locked+verification",     // ② draft 본문 + prev 유래 필드 3종
      "car:003:none",                           // ③ 신규 — prev 기여 0건
      "car:009:whole",                          // ④ draft에 없던 잠긴 생존자
    ];
    const ok = aligned && JSON.stringify(shape) === JSON.stringify(EXPECTED);
    if (!ok) console.log(`    실제: aligned=${aligned} ${JSON.stringify(shape)}`);
    // **이 픽스처의 car:002 조합(verified + text 변경)은 이제 프로덕션이 거부한다**
    // — `(AC-47)`의 `VERIFIED_CLAIM_REWRITTEN`이다. 그런데도 이 단언이 초록인 것은
    // 여기서 보는 것이 `violations`가 아니라 `prevDerived`의 **정렬**뿐이기 때문이다.
    // 픽스처를 고치지 않는 이유: 이 단언의 관측 대상은 병합 계약의 위반 여부가 아니라
    // 「어느 노드가 prev에서 무엇을 받았는가」의 인덱스 대응이고, 거부되는 조합에서도
    // 그 대응은 성립해야 한다. 다음 회차가 「위반인데 초록이다」로 오독하지 않도록 적는다.
    report(ok, "(AC-43) mergeArtifact의 prevDerived가 merged.nodes와 인덱스로 정렬되고 네 경로(whole 2종·부분·신규)를 구별한다");
  }

  // ---- (AC-44) prev에 verification이 없으면 verification은 prev 유래가 아니다 (10번) ----
  //      **경계를 좁게 잡은 것이 의도임을 못 박는다.** 그 경우 병합이 싣는 값은
  //      `FRESH_VERIFICATION`이고 그것은 이 함수가 만든 값이라 prev에 책임을 물을 수 없다.
  //      넓게 잡으면 **고칠 수 있는 위반이 사람 확인(exit 3)으로 넘어간다** — 그러면
  //      「exit 3은 사람이 결정해야 한다」는 신호가 희석된다.
  {
    const prevNode = makeCareerNode({ id: "car:001", locked: false });
    delete prevNode.verification;
    const { prevDerived } = mergeArtifact(
      "career",
      makeCareerInstance([prevNode]),
      makeCareerInstance([makeDraftNode({ id: "car:001" })]),
      { stage: "draft" }
    );
    const ok = prevDerived[0].whole === false && JSON.stringify(prevDerived[0].fields) === JSON.stringify(["origin", "locked"]);
    if (!ok) console.log(`    실제: ${JSON.stringify(prevDerived[0])}`);
    report(ok, "(AC-44) prev에 verification이 없으면 병합이 채운 초기값은 prev 유래로 세지 않는다(경계를 넓히면 고칠 수 있는 위반이 exit 3으로 샌다)");
  }

  // ---- (AC-45) classifySchemaErrorsByProvenance의 판별 규칙 (10번) ----
  //      **양방향이다.** prev 몫만 보면 「전부 prev 몫으로 보내는」 분류기가 통과하고,
  //      draft 몫만 보면 「전부 draft 몫으로 보내는」(= 지금의 결함 그대로인) 분류기가
  //      통과한다. 한 번의 호출에서 두 목록을 동시에 대조한다.
  {
    const prevDerived = [
      { whole: true, fields: [] },                             // 0 — 통째로 prev
      { whole: false, fields: ["origin", "locked"] },          // 1 — 부분
      { whole: false, fields: [] },                            // 2 — 신규
    ];
    const errors = [
      "$.nodes[0].basis: enum 불일치",                          // prev — whole 아래 전부
      "$.nodes[0]: required 필드 'text' 없음",                  // prev — whole은 노드 단위 오류도 포함
      "$.nodes[1].origin: enum 불일치",                         // prev — 부분 노드의 prev 유래 필드
      "$.nodes[1].text: minLength(1) 미만",                     // draft — 같은 노드지만 draft가 만든 필드
      "$.nodes[1]: additionalProperties 위반('x')",             // draft — 부분 노드의 노드 단위 오류
      "$.nodes[2].basis: enum 불일치",                          // draft — 신규 노드
      "$.nodes: minItems(1) 미만",                              // draft — 인덱스 없음
      "$: required 필드 'coverage' 없음",                       // draft — 최상위
      "$.nodes[9].basis: enum 불일치",                          // draft — 범위 밖 인덱스는 분류 실패 → draft 몫
    ];
    const { fromPrev, fromDraft } = classifySchemaErrorsByProvenance(errors, prevDerived);
    const ok =
      JSON.stringify(fromPrev) === JSON.stringify([errors[0], errors[1], errors[2]]) &&
      JSON.stringify(fromDraft) === JSON.stringify([errors[3], errors[4], errors[5], errors[6], errors[7], errors[8]]);
    if (!ok) console.log(`    실제: prev=${JSON.stringify(fromPrev)} draft=${JSON.stringify(fromDraft)}`);
    report(ok, "(AC-45) classifySchemaErrorsByProvenance가 whole·prev필드·draft필드·노드단위·인덱스없음·범위밖 6형태를 정확히 가른다(양방향)");
  }
}

// ---------------------------------------------------------------------------
// 원장 투영 진입점 — 구현 7단계 (f) / 게이트 E-3
// ---------------------------------------------------------------------------

function runLedgerProjectionOracleSmoke() {
  console.log("[원장 투영 오라클] 구현 7단계 (f)·게이트 E-3: projectLedgerForSkills의 소비 지점");

  const ledger = {
    schemaVersion: "1.0.0",
    generatedAt: "2026-08-19T00:00:00Z",
    sourceRepoHead: "a".repeat(40),
    contentHash: "b".repeat(64),
    coverage: { analyzed: 2, total: 2, traversed: 3 },
    truncated: { reason: "none", dropped_commits: 0 },
    commits: [
      { id: `commit:${"1".repeat(40)}`, excluded: false, authorEmail: "owner@example.com" },
      { id: `commit:${"2".repeat(40)}`, excluded: true, exclusionReason: "other-author", authorEmail: null },
      { id: `commit:${"3".repeat(40)}`, authorEmail: "owner@example.com" },
    ],
  };

  // ---- (LP-1) 소스 스캔: 투영 함수의 소비 지점이 store.mjs 밖에 실재하는가 ----
  //      게이트 E-3의 본체다. 함수만 있고 호출자가 0곳이면 §6의 보조 방어가
  //      선언으로만 남는다(심사 M-1이 지적한 형태). 닻은 store.mjs 밖에 둔다.
  {
    const callers = [];
    const scan = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) { scan(full); continue; }
        if (!entry.name.endsWith(".mjs")) continue;
        const rel = path.relative(REPO_ROOT, full).split(path.sep).join("/");
        if (rel === "scripts/lib/store.mjs") continue;
        // **문자열 존재가 아니라 호출 지점을 요구한다.** 변이 M17(투영 함수를
        // 쓰지 않고 필터를 손으로 복제하되 import는 남긴다)이 이름만 보는
        // 스캔을 통과했다 — 실측된 구멍이다. `projectLedgerForSkills(`까지
        // 요구하면 그 형태가 잡힌다(정의부를 가진 store.mjs는 위에서 제외한다).
        // 판정이 **양수 방향**(`callers.length >= 1`)이라 판독 실패는 통과를 더 어렵게만 만든다 —
        // 거짓 초록이 생기지 않으므로 별도 전제 단언을 세우지 않고 판독만 안전하게 바꾼다.
        const { text } = readRepoTextSafe(rel);
        if (text !== null && text.includes("projectLedgerForSkills(")) callers.push(rel);
      }
    };
    scan(path.join(REPO_ROOT, "scripts"));
    const ok = callers.length >= 1;
    if (!ok) console.log("    실제: scripts/ 안에 projectLedgerForSkills 소비 지점이 0곳이다(죽은 코드).");
    else console.log(`    소비 지점: ${JSON.stringify(callers)}`);
    report(ok, "(LP-1) projectLedgerForSkills의 **호출 지점**이 store.mjs 밖 scripts/에 1곳 이상 실재한다(게이트 E-3)");
  }

  // ---- (LP-2) 금지 방향: 제외 커밋이 투영에 남지 않는가 ----
  {
    // **누출 여부만 본다.** 초판은 여기서 건수(total/excluded)까지 함께
    // 단언했는데, 그러면 "전량 통과" 변이(M18)와 "전량 버림" 변이(M19)가
    // **둘 다** 이 단언과 (LP-3)을 동시에 깨서 방향 분리가 성립하지 않았다
    // — 실측이다. 건수 보고는 (LP-4)의 CLI 경로가 본다.
    const { projected } = projectWithReport(ledger);
    const leaked = projected.commits.filter((c) => c.excluded === true);
    if (leaked.length > 0) console.log(`    실제: 누출 ${leaked.length}건`);
    report(leaked.length === 0, "(LP-2) 금지 방향: 투영 결과에 excluded:true 커밋이 0건이다(§6 프라이버시 경계)");
  }

  // ---- (LP-3) 허용 방향: 제외가 아닌 커밋은 전부 남는가 ----
  //      이것이 없으면 "빈 배열을 돌려주는" 투영이 (LP-2)를 통과한다.
  {
    const { projected } = projectWithReport(ledger);
    // **잔존 여부만 본다**(개수는 세지 않는다) — 위와 같은 이유로 방향을
    // 섞지 않는다. 개수까지 보면 "전량 통과" 변이도 여기서 FAIL해 두 단언이
    // 같은 것을 말하게 된다.
    const ids = projected.commits.map((c) => c.id);
    const ok = ids.includes(`commit:${"1".repeat(40)}`) && ids.includes(`commit:${"3".repeat(40)}`);
    if (!ok) console.log(`    실제: ${JSON.stringify(ids)}`);
    report(ok, "(LP-3) 허용 방향: excluded !== true인 커밋은 전부 남는다(전량 필터 방어 — excluded 필드 부재 포함)");
  }

  // ---- (LP-6) 투영 결과가 store.mjs의 정본 함수와 갈리지 않는가 ----
  //      **(LP-1)의 한계를 여기서 좁힌다.** 소스 스캔은 "그 이름이 파일에
  //      등장하는가"만 본다 — import를 남겨 둔 채 필터를 손으로 다시 짜면
  //      (LP-1)은 그대로 녹색이다(변이로 실측했다). 이 단언은 그 형태를
  //      **결과 대조**로 잡는다. 다만 "호출했는가" 자체는 계측 없이는 관측할
  //      수 없으므로, 두 단언을 합쳐도 남는 구멍이 있다는 것을 감추지 않는다:
  //      정본 함수와 **바이트 동일한 로직**을 손으로 복제하면 둘 다 통과한다.
  {
    const viaEntry = projectWithReport(ledger).projected;
    const viaStore = projectLedgerForSkills(ledger);
    const ok = JSON.stringify(viaEntry) === JSON.stringify(viaStore);
    if (!ok) console.log(`    실제: entry=${JSON.stringify(viaEntry.commits?.length)} store=${JSON.stringify(viaStore.commits?.length)}`);
    report(ok, "(LP-6) 투영 진입점의 결과가 store.mjs의 projectLedgerForSkills 결과와 동일하다(사본 드리프트 방어)");
  }

  // ---- (LP-12)~(LP-27) 투영 필드 삭감의 양방향 관측 ----
  //      성능 콜드 리뷰 라운드 3 처방 2[A]. 투영이 다섯 키를 **값이 기본값일 때만**
  //      생략하게 됐고(-18.4% 실측), 그 조건 하나하나에 금지/허용 두 방향을 붙인다.
  //
  //      **기존 `ledger`를 확장하지 않고 픽스처를 새로 만든 이유**: 위 (LP-4)(LP-7)
  //      (LP-8)이 `commits.length === 2`와 "제외 1건"을 하드코딩한다. 커밋을 더하면
  //      필드 형태 축의 변경이 무관한 CLI 왕복 축을 붉게 만든다.
  //
  //      **그리고 기존 `ledger`의 커밋은 required 키가 없어 완전성 게이트에 막힌다** —
  //      즉 저 픽스처로는 삭감 분기가 한 번도 실행되지 않는다. 그것을 모르고 이 절을
  //      기존 픽스처 위에 세웠다면 단언 16건이 전부 대상 0건으로 초록이 됐을 것이다.
  const fieldLedger = (() => {
    const commit = (over) => ({
      id: `commit:${"9".repeat(40)}`,
      hash: "9".repeat(40),
      shortHash: "9".repeat(12),
      authorEmail: "owner@example.com",
      authorDate: "2026-08-19T00:00:00+09:00",
      parents: [],
      isMerge: false,
      coAuthors: [],
      subject: "feat: x",
      insertions: 1,
      deletions: 0,
      files: [],
      excluded: false,
      exclusionReason: null,
      ...over,
    });
    const file = (over) => ({
      path: "src/a.js", oldPath: null, changeType: "A",
      insertions: 5, deletions: 0, binary: false, viaMerge: false,
      ...over,
    });
    return {
      ...ledger,
      commits: [
        // ⓐ 전건 기본값 — 다섯 키가 모두 생략돼야 한다
        commit({ id: "commit:a", hash: "a".repeat(40), shortHash: "a".repeat(12), files: [file({})] }),
        // ⓑ shortHash 파생 불일치(7자) — 보존돼야 한다
        commit({ id: "commit:b", hash: "b".repeat(40), shortHash: "b".repeat(7) }),
        // ⓒ 정보를 담은 값들 — coAuthors·oldPath·binary가 보존돼야 한다
        commit({
          id: "commit:c", hash: "c".repeat(40), shortHash: "c".repeat(12),
          coAuthors: ["Co-authored-by: Bob <bob@example.com>"],
          files: [
            file({ path: "new/name.js", oldPath: "old/name.js", changeType: "R" }),
            file({ path: "assets/logo.png", binary: true, insertions: 0, deletions: 0 }),
          ],
        }),
        // ⓓ 머지 유입 — viaMerge:true가 보존돼야 한다
        commit({
          id: "commit:d", hash: "d".repeat(40), shortHash: "d".repeat(12), isMerge: true,
          parents: ["e".repeat(40), "f".repeat(40)],
          files: [file({ path: "merged.js", changeType: "M", viaMerge: true })],
        }),
        // ⓔ 커밋은 완전하나 **파일 항목이 불완전**(binary·viaMerge 없음) — 파일 레벨 게이트
        commit({
          id: "commit:e", hash: "e".repeat(40), shortHash: "e".repeat(12),
          files: [{ path: "damaged.js", oldPath: null, changeType: "A", insertions: 1, deletions: 0 }],
        }),
        // ⓕ **커밋이 불완전**(coAuthors 키 자체가 없다) — 커밋 레벨 게이트
        (() => { const c = commit({ id: "commit:f", hash: "0".repeat(40), shortHash: "0".repeat(12), files: [file({})] }); delete c.coAuthors; return c; })(),
      ],
    };
  })();

  {
    const proj = projectLedgerForSkills(fieldLedger);
    const byId = (id) => proj.commits.find((c) => c.id === id);
    const srcById = (id) => fieldLedger.commits.find((c) => c.id === id);
    const fileAt = (id, p) => (byId(id)?.files ?? []).find((f) => f.path === p);
    const has = (o, k) => o !== undefined && Object.prototype.hasOwnProperty.call(o, k);

    // shortHash — 금지/허용
    {
      const ok = byId("commit:a") !== undefined && !has(byId("commit:a"), "shortHash");
      if (!ok) console.log(`    실제: ${JSON.stringify(byId("commit:a"))}`);
      report(ok, "(LP-12) 금지 방향: shortHash가 hash 앞 12자와 같은 커밋에서는 투영에 그 키가 없다");
    }
    {
      const c = byId("commit:b");
      const ok = has(c, "shortHash") && c.shortHash === "b".repeat(7);
      if (!ok) console.log(`    실제: ${JSON.stringify(c)}`);
      report(ok, "(LP-13) 허용 방향: 파생 전제가 깨진 shortHash는 보존된다(무조건 생략이면 드리프트가 소실된다)");
    }

    // coAuthors — 금지/허용
    {
      const ok = !has(byId("commit:a"), "coAuthors");
      report(ok, "(LP-14) 금지 방향: 빈 coAuthors는 투영에서 생략된다");
    }
    {
      const c = byId("commit:c");
      const ok = has(c, "coAuthors") && JSON.stringify(c.coAuthors) === JSON.stringify(srcById("commit:c").coAuthors);
      if (!ok) console.log(`    실제: ${JSON.stringify(c?.coAuthors)}`);
      report(ok, "(LP-15) 허용 방향: 비어 있지 않은 coAuthors는 값까지 그대로 남는다(키만 남기고 비우는 형태도 잡는다)");
    }

    // oldPath — 금지/허용
    {
      const ok = fileAt("commit:a", "src/a.js") !== undefined && !has(fileAt("commit:a", "src/a.js"), "oldPath");
      report(ok, "(LP-16) 금지 방향: oldPath가 null인 파일 항목에서는 그 키가 없다");
    }
    {
      const f = fileAt("commit:c", "new/name.js");
      const ok = has(f, "oldPath") && f.oldPath === "old/name.js";
      if (!ok) console.log(`    실제: ${JSON.stringify(f)}`);
      report(ok, "(LP-17) 허용 방향: 리네임 항목의 oldPath는 값 그대로 남는다");
    }

    // binary — 금지/허용
    {
      const ok = !has(fileAt("commit:a", "src/a.js"), "binary");
      report(ok, "(LP-18) 금지 방향: binary가 false인 파일 항목에서는 그 키가 없다");
    }
    {
      const f = fileAt("commit:c", "assets/logo.png");
      const ok = has(f, "binary") && f.binary === true;
      if (!ok) console.log(`    실제: ${JSON.stringify(f)}`);
      report(ok, "(LP-19) 허용 방향: binary:true는 남는다(정보를 담은 값은 생략 대상이 아니다)");
    }

    // viaMerge — 금지/허용
    {
      const ok = !has(fileAt("commit:a", "src/a.js"), "viaMerge");
      report(ok, "(LP-20) 금지 방향: viaMerge가 false인 파일 항목에서는 그 키가 없다");
    }
    {
      const f = fileAt("commit:d", "merged.js");
      const ok = has(f, "viaMerge") && f.viaMerge === true;
      if (!ok) console.log(`    실제: ${JSON.stringify(f)}`);
      report(ok, "(LP-21) 허용 방향: 머지 유입 항목의 viaMerge:true는 남는다");
    }

    // ---- (LP-22) 레코드 온전성 ----
    //      **이 단언이 이 절에서 가장 중요하다.** 삭감 이전에는 투영이 커밋 객체를
    //      그대로 공유했으므로 (LP-3)의 "id가 남았다"가 "레코드가 원본 그대로"를
    //      구조적으로 보장했다. 재조립하는 순간 그 동치가 끊긴다 — subject·authorDate·
    //      insertions를 전부 버리는 투영도 (LP-2)(LP-3)(LP-4)(LP-6)을 전부 통과한다.
    //
    //      **화이트리스트 키를 양쪽에서 똑같이 지운 뒤 대조하는 것이 설계의 핵심이다.**
    //      지우지 않으면 위 (LP-13)(LP-15)(LP-17)(LP-19)(LP-21)의 변이가 이 단언까지
    //      함께 깨서 각 단언의 고유 관측점이 사라진다.
    {
      const strip = (c) => {
        if (c === null || typeof c !== "object") return c;
        const o = { ...c };
        for (const k of PROJECTION_OMITTABLE_KEYS.commit) delete o[k];
        if (Array.isArray(o.files)) {
          o.files = o.files.map((f) => {
            if (f === null || typeof f !== "object") return f;
            const g = { ...f };
            for (const k of PROJECTION_OMITTABLE_KEYS.fileChange) delete g[k];
            return g;
          });
        }
        return o;
      };
      const mismatched = proj.commits
        .map((c) => [c.id, JSON.stringify(strip(c)) === JSON.stringify(strip(srcById(c.id)))])
        .filter(([, same]) => !same)
        .map(([id]) => id);
      const ok = mismatched.length === 0 && proj.commits.length === fieldLedger.commits.length;
      if (!ok) console.log(`    실제: 어긋난 커밋 ${JSON.stringify(mismatched)} / 건수 ${proj.commits.length}`);
      report(ok, "(LP-22) 허용 방향: 화이트리스트 밖의 키는 하나도 사라지거나 변하지 않는다(재조립이 레코드를 갉아먹는 형태 방어)");
    }

    // ---- (LP-23) 화이트리스트 리터럴 드리프트 가드 ----
    //      excluded/exclusionReason이 이 집합에 들어오는 순간 (LP-2)가 공허해진다.
    //      그 확장을 상수 층에서 먼저 잡는다 — 동작이 바뀌기 전에 걸린다.
    {
      const expected = { commit: ["shortHash", "coAuthors"], fileChange: ["oldPath", "binary", "viaMerge"] };
      const actual = { commit: [...PROJECTION_OMITTABLE_KEYS.commit], fileChange: [...PROJECTION_OMITTABLE_KEYS.fileChange] };
      const ok = JSON.stringify(actual) === JSON.stringify(expected);
      if (!ok) console.log(`    실제: ${JSON.stringify(actual)}`);
      report(ok, "(LP-23) 전제: 생략 허용 키는 정확히 다섯이다(excluded/exclusionReason/id가 들어오면 FAIL — (LP-2)(LP-3)이 공허해지는 경로)");
    }

    // ---- (LP-24) 생략 규약이 산출물 자신에 선언되는가 ----
    {
      const ok = JSON.stringify(proj.projectionOmittedKeys) === JSON.stringify(PROJECTION_OMITTABLE_KEYS);
      if (!ok) console.log(`    실제: ${JSON.stringify(proj.projectionOmittedKeys)}`);
      report(ok, "(LP-24) 전제: 투영이 projectionOmittedKeys를 실어 「키 부재는 그 기본값이지 미상이 아니다」를 스스로 선언한다");
    }

    // ---- (LP-25)(LP-26) 완전성 게이트 — 절대 규칙 6 ----
    //      게이트가 없으면 required 키가 빠진 손상 레코드가 생략 후 정상 레코드와
    //      **바이트 동일**해져 「부재」와 「기본값」이 구별되지 않는다.
    {
      const c = byId("commit:f");
      const ok = c !== undefined && JSON.stringify(c) === JSON.stringify(srcById("commit:f"));
      if (!ok) console.log(`    실제: ${JSON.stringify(c)}`);
      report(ok, "(LP-25) 허용 방향: required 키가 빠진 **커밋**은 아무것도 생략되지 않는다(손상은 손상으로 보여야 한다)");
    }
    {
      const f = fileAt("commit:e", "damaged.js");
      const ok = has(f, "oldPath") && f.oldPath === null;
      if (!ok) console.log(`    실제: ${JSON.stringify(f)}`);
      report(ok, "(LP-26) 허용 방향: required 키가 빠진 **파일 항목**은 아무것도 생략되지 않는다");
    }

    // ---- (LP-27) required 키 사본이 스키마와 갈리지 않는가 ----
    //      store.mjs는 스키마를 읽지 않는다(라이브러리에 fs 의존을 더하지 않는다).
    //      그래서 사본이고, 사본은 드리프트한다. 양방향으로 대조한다 — 한쪽만
    //      보면 스키마에 필드를 더하고 상수를 안 고쳐도(또는 반대여도) 지나간다.
    {
      const { json: schema, error } = readRepoJsonSafe("schemas/evidence.schema.json");
      const cmp = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
      const ok = error === null
        && cmp(PROJECTION_REQUIRED_KEYS.commit, schema?.$defs?.commit?.required ?? [])
        && cmp(PROJECTION_REQUIRED_KEYS.fileChange, schema?.$defs?.fileChange?.required ?? []);
      if (!ok) {
        console.log(`    실제: ${error !== null ? error : `commit=${JSON.stringify(schema?.$defs?.commit?.required)} fileChange=${JSON.stringify(schema?.$defs?.fileChange?.required)}`}`);
      }
      report(ok, "(LP-27) 전제: PROJECTION_REQUIRED_KEYS가 evidence.schema.json의 required와 양방향 일치한다(완전성 게이트의 기준이 스키마와 갈리면 게이트가 헛돈다)");
    }
  }

  // ---- (LP-4) CLI가 실제로 도는가 ----
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-ledger-"));
    try {
      const inPath = path.join(tmp, "evidence.json");
      fs.writeFileSync(inPath, JSON.stringify(ledger), "utf8");
      const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "project-ledger.mjs"), "--in", inPath], { encoding: "utf8" });
      const out = JSON.parse(r.stdout);
      const ok = r.status === 0 && out.commits.length === 2 && r.stderr.includes("제외 1건");
      if (!ok) console.log(`    실제: status=${r.status} stderr=${r.stderr}`);
      report(ok, "(LP-4) CLI가 exit 0으로 투영을 stdout에 내고 제외 건수를 stderr로 보고한다");

      const bad = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "project-ledger.mjs"), "--in", path.join(tmp, "nope.json")], { encoding: "utf8" });
      const ok2 = bad.status === 2 && bad.stderr.includes("[INPUT_ERROR]");
      if (!ok2) console.log(`    실제: status=${bad.status} stderr=${bad.stderr}`);
      report(ok2, "(LP-5) 입력 파일 부재는 [INPUT_ERROR] + exit 2다(A-32 규약과 같은 계열)");

      // ---- (LP-7) --root 사용법이 실제로 도는가(콜드 리뷰 Testing #3) ----
      //      사용법 주석은 --in과 --root를 동등한 두 사용법으로 문서화하는데
      //      초판 스위트는 --in만 실행했다. --root는 `path.join(root,
      //      EVIDENCE_FILE_NAME)`이라는 **고유 결합 로직**을 갖고, 그 상수는
      //      생산자 collect-git-facts.mjs의 리터럴과 갈라져 있어 드리프트를
      //      잡을 오라클이 전혀 없었다. **프롬프트 계층이 이 경로를 쓰기
      //      시작하므로 이제 프로덕션 경로다.**
      const ledgerRoot = path.join(tmp, "root-mode", STATE_DIR_NAME);
      fs.mkdirSync(ledgerRoot, { recursive: true });
      fs.writeFileSync(path.join(ledgerRoot, "evidence.json"), JSON.stringify(ledger), "utf8");
      {
        const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "project-ledger.mjs"), "--root", ledgerRoot], { encoding: "utf8" });
        let out = null;
        try { out = JSON.parse(r.stdout); } catch { /* 파싱 실패는 아래에서 FAIL로 떨어진다 */ }
        const ok3 = r.status === 0 && out?.commits?.length === 2 && r.stderr.includes("제외 1건");
        if (!ok3) console.log(`    실제: status=${r.status} stdout길이=${r.stdout.length} stderr=${r.stderr}`);
        report(ok3, "(LP-7) --root 사용법이 저장 루트 밑 evidence.json을 찾아 투영한다(콜드 리뷰 Testing #3)");
      }

      // ---- (LP-8) --out이 실제로 파일을 쓰는가 ----
      {
        const outPath = path.join(ledgerRoot, "ledger-projection.json");
        const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "project-ledger.mjs"), "--root", ledgerRoot, "--out", outPath], { encoding: "utf8" });
        const written = fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, "utf8")) : null;
        const ok4 = r.status === 0 && written?.commits?.length === 2 && r.stdout === "" && r.stderr.includes(outPath);
        if (!ok4) console.log(`    실제: status=${r.status} 파일=${fs.existsSync(outPath)} stdout길이=${r.stdout.length}`);
        report(ok4, "(LP-8) --out은 지정 경로에 투영을 쓰고 stdout으로는 아무것도 내지 않는다(콜드 리뷰 Testing #3)");

        // ---- (LP-28) 직렬화 형태가 들여쓰기 폭 1로 고정돼 있는가 ----
        //      성능 콜드 리뷰 라운드 3 처방 3. 폭 1은 폭 2 대비 -12.1%(실측)이고
        //      「키당 한 줄」 형태는 유지한다.
        //
        //      **단언을 하나로 둔 이유.** 기록된 바이트를 `indent 1` 재직렬화와
        //      정확히 대조하므로 **양쪽 방향이 같은 관측점에 걸린다** — 폭 2로
        //      되돌려도, 최소화해도 어긋난다. 방향마다 단언을 따로 두면 최소화
        //      변이가 둘을 함께 깨서 각자의 고유 관측점이 사라진다.
        //
        //      **최소화를 금지 대상에 넣은 근거는 측정된 것이 아니다.** 최소화는
        //      -30.2%로 더 크고, 그것을 택하지 않은 이유는 「LLM이 읽기 어려울
        //      것」이라는 `unmeasured` 전제뿐이다(perf_review.md의 등급 어휘).
        //      재면 이 단언의 기대값이 뒤집힐 수 있고, 그때 고칠 곳은 여기다.
        {
          const text = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : null;
          let expected = null;
          if (text !== null) {
            try { expected = JSON.stringify(JSON.parse(text), null, 1) + "\n"; } catch { /* 아래에서 FAIL */ }
          }
          const ok5 = text !== null && expected !== null && text === expected;
          if (!ok5) {
            const head = (text ?? "").split("\n").slice(0, 3).map((l) => JSON.stringify(l)).join(" / ");
            console.log(`    실제: 기록 바이트 ${text === null ? "없음" : text.length} · 첫 줄들 ${head}`);
          }
          report(ok5, "(LP-28) 투영 파일이 들여쓰기 폭 1로 직렬화된다(폭 2 회귀와 최소화를 같은 관측점이 잡는다 — 처방 3)");
        }
      }

      // ---- (LP-9) 금지 방향: --root·--out이 저장 경계 밖이면 거부하는가 ----
      //      콜드 리뷰 Security #11. 이 스크립트도 원장을 읽고 투영을 쓰므로
      //      쓰기 경계 규약을 함께 진다.
      {
        const outsideRoot = path.join(tmp, "outside-root");
        fs.mkdirSync(outsideRoot, { recursive: true });
        fs.writeFileSync(path.join(outsideRoot, "evidence.json"), JSON.stringify(ledger), "utf8");
        const r1 = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "project-ledger.mjs"), "--root", outsideRoot], { encoding: "utf8" });
        const r2 = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "project-ledger.mjs"), "--in", inPath, "--out", path.join(outsideRoot, "p.json")], { encoding: "utf8" });
        const ok5 = r1.status === 2 && r1.stderr.includes("[INPUT_ERROR]") && r1.stderr.includes("--root") &&
          r2.status === 2 && r2.stderr.includes("--out") && !fs.existsSync(path.join(outsideRoot, "p.json"));
        if (!ok5) console.log(`    실제: root=${r1.status}/${r1.stderr.trim()} out=${r2.status}/${r2.stderr.trim()}`);
        report(ok5, "(LP-9) 저장 경계 밖 --root·--out은 [INPUT_ERROR] + exit 2이고 파일을 쓰지 않는다(콜드 리뷰 Security #11)");
      }

      // ---- (LP-10) 허용 방향: --in은 경계 밖이어도 통과하는가 ----
      //      금지 방향만 두면 "모든 경로를 막는" 검사가 (LP-9)를 통과하고,
      //      픽스처 원장을 --in으로 읽는 정당한 용법이 죽은 것을 아무도 모른다.
      //      경계가 지키는 것은 **쓰기와 저장 루트 해석**이지 임의 파일 읽기가
      //      아니라는 결정이 여기 고정된다.
      {
        const r = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "project-ledger.mjs"), "--in", inPath], { encoding: "utf8" });
        const ok6 = r.status === 0;
        if (!ok6) console.log(`    실제: status=${r.status} stderr=${r.stderr}`);
        report(ok6, "(LP-10) 허용 방향: --in은 저장 경계 밖(os.tmpdir 직하)이어도 exit 0이다(읽기까지 막지 않는다)");
      }

      // ---- (LP-11) --out 쓰기 실패가 종료 코드 계약 **안**에 있는가 ----
      //      이 파일이 문서화한 종료 코드는 0과 2 두 갈래뿐인데, --out 쓰기만
      //      try/catch 밖에 있어 경계 검사(LP-9)를 통과한 뒤 상위 디렉터리가 없으면
      //      원시 Node 스택과 함께 **exit 1**로 죽었다 — 계약에 없는 세 번째 코드이고,
      //      하필 write-artifact.mjs에서 exit 1은 「출력을 고쳐 다시 부른다」로 이미
      //      점유된 값이라 같은 오케스트레이션이 두 스크립트를 부를 때 의미가 갈린다.
      //      **경로를 경계 안에 두는 것이 핵심이다** — 경계 밖이면 LP-9가 먼저 잡아
      //      쓰기 실패를 관측할 수 없다.
      {
        const missingParent = path.join(ledgerRoot, "no-such-dir", "p.json");
        const r = spawnSync(
          process.execPath,
          [path.join(REPO_ROOT, "scripts", "project-ledger.mjs"), "--root", ledgerRoot, "--out", missingParent],
          { encoding: "utf8" }
        );
        const ok7 = r.status === 2 && r.stderr.includes("[INPUT_ERROR]") && r.stderr.includes("--out") &&
          !r.stderr.includes("    at ") && !fs.existsSync(missingParent);
        if (!ok7) console.log(`    실제: status=${r.status} stderr=${r.stderr.slice(0, 300)}`);
        report(ok7, "(LP-11) 쓸 수 없는 --out은 [INPUT_ERROR] + exit 2다(원시 스택도, 계약 밖 exit 1도 아니다)");
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// 쓰기 경계 — 구현 7단계 (a) / AC-16 / AC-22
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 프롬프트 계층 계약 — 구현 7단계 ③ / 게이트 E-3의 열린 절반
// ---------------------------------------------------------------------------

/**
 * **소스 스캔의 성격을 먼저 적는다 — 이 절의 단언은 전부 보조 방어다.**
 *
 * 프롬프트는 마크다운이라 계약을 어겨도 종료 코드가 나오지 않는다. 실제 집행은
 * `write-artifact.mjs`(기입 주체·병합·스키마)와 `verify-evidence.mjs`(인용
 * 무결성)가 하고, 여기서 보는 것은 **프롬프트가 그 집행 경로를 실제로 거치도록
 * 쓰였는가** 하나뿐이다.
 *
 * 그럼에도 이 절이 필요한 이유는 게이트 E-3이 열려 있던 이유와 같다. 집행 코드가
 * 있어도 프롬프트가 그것을 부르지 않으면 계약은 대상 0건이 된다 — 그리고 그
 * 상태는 **모든 게이트가 녹색인 채로** 성립한다.
 *
 * **남는 구멍(감추지 않는다):** 명령 문자열이 문서에 있는지만 보므로, 프롬프트가
 * 그 줄을 적어 두고 실행하지 말라고 덧붙여도 통과한다. 「실제로 호출했는가」는
 * 계측 없이는 관측할 수 없다 — LP-1에서 실측한 것과 같은 한계다.
 */
function runSkillPromptContractSmoke() {
  console.log("[프롬프트 계층 계약] 구현 7단계 ③ · 게이트 E-3: 스킬 프롬프트가 집행 경로를 거치는가");

  const skillsDir = path.join(REPO_ROOT, "skills");
  const promptFiles = [];
  const scan = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(full);
      else if (entry.name.endsWith(".md")) promptFiles.push(full);
    }
  };
  scan(skillsDir);

  const rel = (p) => path.relative(REPO_ROOT, p).split(path.sep).join("/");

  // DH-1과 같은 모양이다 — 전량을 **한 번만** 판독해 보관하고, 실패는 빈 문자열로 강등하지 않고
  // 목록에 남긴다. 아래 소비 지점이 12곳이라 각각을 게이트하는 대신 전용 전제 단언 (SP-1b)를
  // 세운다: 판독이 하나라도 실패하면 그것이 먼저 FAIL하므로, 소비 지점이 빈 문자열을 보고
  // 「위반 0건」을 내더라도 그 초록이 조용히 남지 않는다.
  const texts = new Map();
  const promptReadFailures = [];
  for (const p of promptFiles) {
    const { text, error } = readRepoTextSafe(rel(p));
    if (error !== null) promptReadFailures.push(error);
    else texts.set(p, text);
  }
  const read = (p) => texts.get(p) ?? "";
  const allText = [...texts.values()].join("\n");

  // ---- (SP-1) 대상이 0건이 아닌가 ----
  //      **이 단언이 먼저 와야 한다.** 아래 금지 방향 단언들은 파일이 하나도
  //      없으면 전부 공허하게 통과한다 — 게이트 E-3이 「대상 0건이라 열려 있다」고
  //      기록했던 것이 정확히 그 상태다.
  {
    const ok = promptFiles.length >= 1;
    if (!ok) console.log("    실제: skills/ 밑에 .md 프롬프트가 0건이다(아래 단언들이 전부 공허해진다).");
    else console.log(`    대상: ${JSON.stringify(promptFiles.map(rel))}`);
    report(ok, "(SP-1) skills/ 밑에 프롬프트 문서가 1건 이상 실재한다(금지 방향 단언들이 공허해지지 않는 전제)");
  }

  // ---- (SP-1b) 그 대상을 실제로 판독했는가 ----
  //      (SP-1)과 **같은 성격의 전제이되 다른 축**이다 — 대상이 존재하는가(SP-1)와 그 대상을
  //      실제로 읽었는가(SP-1b)가 둘 다 서야 아래 금지 방향이 비공허해진다. 두 전제를 한
  //      단언에 묶지 않는 이유는 「어느 경로로 실패했는가」를 로그가 아니라 **라벨**에
  //      고정하기 위해서다(DH-1a/DH-1d가 세운 선례).
  {
    const ok = promptReadFailures.length === 0;
    if (!ok) console.log(`    실제: 판독 실패 ${JSON.stringify(promptReadFailures)}`);
    report(ok, `(SP-1b) 프롬프트 ${promptFiles.length}건을 전부 판독했다(판독 실패를 '위반 0건'으로 집계하지 않는다)`);
  }

  // ---- (SP-2) 게이트 E-3 허용 방향: 투영 명령의 호출 지점이 있는가 ----
  //      **이름이 아니라 호출 지점을 요구한다.** 변이 M17이 실측한 형태다 —
  //      파일명만 등장하는지 보면 프롬프트가 그 명령을 설명만 하고 부르지
  //      않아도 통과한다. 프롬프트에서 「호출 지점」은 실행 가능한 명령
  //      문자열이므로 `node scripts/project-ledger.mjs`까지 요구한다.
  {
    const callers = promptFiles.filter((p) => read(p).includes("node scripts/project-ledger.mjs"));
    const ok = callers.length >= 1;
    if (!ok) console.log("    실제: 투영 명령의 호출 지점이 프롬프트에 0건이다.");
    report(ok, "(SP-2) 프롬프트가 `node scripts/project-ledger.mjs` 호출 지점을 담는다(게이트 E-3 허용 방향)");
  }

  // ---- (SP-3) 게이트 E-3 금지 방향: 원장 원본 파일명을 참조하지 않는가 ----
  //      **닻이 정본 상수다.** 테스트에 "evidence.json"을 하드코딩하면 상수가
  //      바뀔 때 스캔이 옛 이름을 계속 찾는다. 프롬프트가 원장 파일명을 직접
  //      들고 있으면 투영을 건너뛰고 원본을 열 수 있고, 그 순간 §6의
  //      프라이버시 경계가 프롬프트 조립 지점에서 무의미해진다.
  {
    const offenders = promptFiles.filter((p) => read(p).includes(EVIDENCE_FILE_NAME)).map(rel);
    const ok = offenders.length === 0;
    if (!ok) console.log(`    실제: 원장 파일명('${EVIDENCE_FILE_NAME}')을 담은 프롬프트 ${JSON.stringify(offenders)}`);
    report(ok, `(SP-3) 프롬프트 어디에도 원장 원본 파일명('${EVIDENCE_FILE_NAME}') 리터럴이 없다(게이트 E-3 금지 방향)`);
  }

  // ---- (SP-4) 쓰기 경계를 거치는가 ----
  //      프롬프트가 산출물을 직접 쓰라고 지시하면 (a) 자기 스키마 검증,
  //      (b) 재생성 병합, (g) 기입 주체 검사가 전부 건너뛰어진다.
  {
    const ok = allText.includes("node scripts/write-artifact.mjs");
    report(ok, "(SP-4) 프롬프트가 `node scripts/write-artifact.mjs` 호출 지점을 담는다(쓰기 경계를 거친다)");
  }

  // ---- (SP-5) 인용 무결성 검증을 강제하는가 — `--stage` 자기 선언 대응 ----
  //      `--stage fact-checked`는 호출자가 넘기는 **라벨**이다. 오케스트레이션이
  //      FactChecker를 띄우지 않고 그 값만 넘기면 쓰기 경계는 구별할 수 없다 —
  //      구조가 `origin:"user"` 자기면제와 같다. 그 자칭을 기계로 반증하는 것은
  //      인용 무결성 축뿐이므로, 프롬프트가 그것을 반드시 부르게 하고 그 사실을
  //      여기서 관측한다. **이것도 집행이 아니라 보조 방어다**(위 절 주석 참조).
  {
    const ok = allText.includes("node scripts/verify-evidence.mjs");
    if (!ok) console.log("    실제: 프롬프트에 인용 무결성 검증 호출이 없다 — --stage 자칭을 반증할 단계가 없다.");
    report(ok, "(SP-5) 프롬프트가 `node scripts/verify-evidence.mjs` 호출 지점을 담는다(--stage 자기 선언을 반증하는 유일한 축)");
  }

  // ---- (SP-6a·6b·6c) 템플릿 역할 선언과 역할별 요구 ----
  //      집행은 쓰기 경계가 한다. 그럼에도 템플릿에 같은 문장을 요구하는 이유는,
  //      금지를 모르는 템플릿은 매 실행마다 exit 1을 맞고 재작성 루프에 빠지기
  //      때문이다 — 계약이 지켜지는 것과 파이프라인이 도는 것은 다른 문제다.
  //
  //      **초판(SP-6)은 대상을 `career-writer` 파일명으로 하드코딩했다.** 그러면
  //      구현 8단계가 KnowledgeMapper·GapAnalyzer 템플릿을 들고 들어와도 이 절은
  //      그것들을 보지 않는다 — SP-1이 막으려던 「대상 0건이라 공허하게 통과」의
  //      **'새 대상만 조용히 빠지는' 변종**이다. 게다가 바로 위 (SP-3) 주석이
  //      「테스트에 파일명을 하드코딩하지 마라」고 적어 둔 원칙을 같은 함수 안에서
  //      스스로 어기고 있었다.
  //
  //      **그렇다고 `/templates/` 전체에 같은 요구를 걸 수는 없다.** 판정 템플릿의
  //      출력은 `verification`을 **실어야** 하므로 draft 금지 문구를 요구하면
  //      오탐이 된다. 그래서 템플릿이 **자기 역할을 선언**하게 하고 역할별로 다른
  //      것을 묻는다. 역할 문자열에 붙는 단계 이름의 닻은 이 파일이 아니라
  //      `artifact-contract.mjs`의 `AUTHORSHIP_STAGES`다 — 단계 이름이 바뀌면
  //      스캔이 따라간다.
  //
  //      **자기 선언이라는 점을 감추지 않는다.** 템플릿이 스스로 「판정」이라고
  //      적어 생성 쪽 요구를 피할 수 있다. 다만 그 거짓말의 대가는 즉시 나온다 —
  //      생성 출력이 `verification`·`locked`를 실으면 쓰기 경계가 exit 1로
  //      거부한다. 이 축은 여전히 **보조 방어**이고 집행은 write-artifact.mjs다.
  const [STAGE_DRAFT, STAGE_FACT_CHECKED] = AUTHORSHIP_STAGES;
  const ROLE_WRITER = "역할: 생성";
  const ROLE_CHECKER = "역할: 판정";
  const allTemplates = promptFiles.filter((p) => rel(p).includes("/templates/"));
  const roleOf = (p) => {
    const t = read(p);
    const w = t.includes(ROLE_WRITER);
    const c = t.includes(ROLE_CHECKER);
    if (w && !c) return "writer";
    if (c && !w) return "checker";
    return null; // 미선언 또는 양쪽 선언(모호) — 둘 다 분류 실패로 떨어뜨린다.
  };

  {
    const unclassified = allTemplates.filter((p) => roleOf(p) === null).map(rel);
    const ok = allTemplates.length >= 1 && unclassified.length === 0;
    if (!ok) console.log(`    실제: 템플릿 ${allTemplates.length}건 중 역할 미선언·중복선언 ${JSON.stringify(unclassified)}`);
    report(ok, `(SP-6a) 모든 템플릿이 '${ROLE_WRITER}'/'${ROLE_CHECKER}' 중 하나만 선언한다(역할별 요구를 걸기 위한 전제 — 대상 존재 포함)`);
  }

  {
    const writers = allTemplates.filter((p) => roleOf(p) === "writer");
    const missing = writers.filter((p) => !["verification", "locked"].every((f) => read(p).includes(f))).map(rel);
    const ok = writers.length >= 1 && missing.length === 0;
    if (!ok) console.log(`    실제: 생성 템플릿 ${writers.length}건 중 금지 필드 미명시 ${JSON.stringify(missing)}`);
    report(ok, "(SP-6b) 생성 역할 템플릿 **전부**가 draft 금지 필드(verification·locked)를 이름으로 명시한다(구현 7단계 (g)·게이트 B-7)");
  }

  {
    // 허용 방향 겸 오탐 방지. 두 역할이 **서로 다른 단계**를 적는지 본다 —
    // 양쪽 다 "verification을 언급하는가"만 물으면 두 역할이 구별되지 않는다
    // (변이 S6이 WA-22·WA-23에서 실측한 형태와 같다).
    const writers = allTemplates.filter((p) => roleOf(p) === "writer");
    const checkers = allTemplates.filter((p) => roleOf(p) === "checker");
    const badWriter = writers.filter((p) => !read(p).includes(`--stage ${STAGE_DRAFT}`)).map(rel);
    const badChecker = checkers.filter((p) => !read(p).includes(`--stage ${STAGE_FACT_CHECKED}`)).map(rel);
    const ok = writers.length >= 1 && checkers.length >= 1 && badWriter.length === 0 && badChecker.length === 0;
    if (!ok) console.log(`    실제: 생성(${writers.length})에서 '--stage ${STAGE_DRAFT}' 누락 ${JSON.stringify(badWriter)} / 판정(${checkers.length})에서 '--stage ${STAGE_FACT_CHECKED}' 누락 ${JSON.stringify(badChecker)}`);
    report(ok, `(SP-6c) 두 역할이 각자 쓰기 경계에 들어가는 단계(--stage ${STAGE_DRAFT} / --stage ${STAGE_FACT_CHECKED})를 명시한다(허용 방향 — 닻은 AUTHORSHIP_STAGES)`);
  }

  // ---- (SP-7) 각 템플릿이 의도 모델 티어를 명시하는가(전역 규약) ----
  //      세션 모델을 대량 서브에이전트에 그대로 상속시키지 않는다는 규약은
  //      스펙 산문에만 있었다. 템플릿마다 티어가 적혀 있지 않으면 그 규약은
  //      디스패치 시점에 아무 데도 없다.
  {
    const templates = promptFiles.filter((p) => rel(p).includes("/templates/"));
    const missing = templates.filter((p) => {
      const t = read(p);
      return !(t.includes("티어") && t.includes("세션 모델"));
    }).map(rel);
    const ok = templates.length >= 1 && missing.length === 0;
    if (!ok) console.log(`    실제: 템플릿 ${templates.length}건 중 티어·세션 모델 문구 누락 ${JSON.stringify(missing)}`);
    report(ok, "(SP-7) 모든 템플릿이 의도 모델 티어와 세션 모델 상속 금지를 명시한다(전역 규약)");
  }

  // ---- (SP-8) 각 템플릿이 출력 언어를 명시하는가 ----
  //      전역 규약: 영어 누수는 스타일 문제가 아니라 버그다. `--lang-check`가
  //      사후에 FAIL을 내지만, 그때는 이미 산출물이 만들어진 뒤다.
  {
    const templates = promptFiles.filter((p) => rel(p).includes("/templates/"));
    const missing = templates.filter((p) => !read(p).includes("한국어")).map(rel);
    const ok = templates.length >= 1 && missing.length === 0;
    if (!ok) console.log(`    실제: 출력 언어 미명시 ${JSON.stringify(missing)}`);
    report(ok, "(SP-8) 모든 템플릿이 출력 언어(한국어)를 명시한다(영어 누수는 버그다)");
  }

  // ---- (SP-9) 인용 검증 호출이 저자 지정 플래그를 동반하는가 ----
  //      **이 단언이 왜 생겼는지 적어 둔다.** (SP-5)는 `node scripts/verify-evidence.mjs`
  //      문자열이 프롬프트 어딘가에 있는지만 봤고, 그래서 SKILL.md 7단계가
  //      `--identity`도 `--config`도 없이 적혀 있던 것을 놓쳤다. 그 명령을 문자
  //      그대로 실행하면 verify-evidence.mjs는 인용 검증에 도달하기 **전에**
  //      `selectedIdentities가 비어 있습니다`로 exit 2한다 — 게이트 E-4가
  //      「자칭을 반증하는 유일한 축」이라고 못 박은 단계가 **한 번도 실행되지
  //      않은 채** 네 게이트가 모두 녹색이었다.
  //
  //      **호출 지점의 정의를 좁힌다.** (SP-5)는 "문자열이 있는가"였는데 여기서는
  //      "그 명령이 들어 있는 **코드 블록**이 저자 지정 플래그를 함께 담는가"를
  //      묻는다. 명령은 줄바꿈으로 이어지므로 줄 단위가 아니라 블록 단위여야 한다.
  const VERIFIER_CMD = "node scripts/verify-evidence.mjs";
  const fencedBlocks = (text) => {
    const blocks = [];
    let cur = null;
    for (const line of text.split("\n")) {
      if (/^\s*```/.test(line)) {
        if (cur === null) cur = [];
        else { blocks.push(cur.join("\n")); cur = null; }
        continue;
      }
      if (cur !== null) cur.push(line);
    }
    return blocks;
  };
  const verifierBlocks = promptFiles.flatMap((p) =>
    fencedBlocks(read(p)).filter((b) => b.includes(VERIFIER_CMD)).map((b) => ({ file: rel(p), block: b }))
  );
  {
    const offenders = verifierBlocks
      .filter(({ block }) => !(block.includes("--identity") || block.includes("--config")))
      .map(({ file }) => file);
    const ok = verifierBlocks.length >= 1 && offenders.length === 0;
    if (!ok) console.log(`    실제: 인용 검증 호출 블록 ${verifierBlocks.length}건 중 저자 지정 플래그 누락 ${JSON.stringify(offenders)}`);
    report(ok, "(SP-9) 인용 검증 호출 블록이 --identity 또는 --config를 동반한다(없으면 검증 축에 도달하기 전에 exit 2)");
  }

  // ---- (SP-10) 그 명령이 **실제로 인자 검증을 통과하는가** ----
  //      **SP 계열이 소스 스캔이라는 한계를 이 한 축에서만은 넘는다.** SP-9는
  //      여전히 "플래그가 적혀 있는가"까지만 보므로, 플래그 이름이 바뀌거나
  //      조합이 무효가 되면 다시 초록으로 통과한다. 여기서는 프롬프트에서 명령을
  //      **추출해 실제로 실행**하고, 검증 축이 돌았다는 증거(`citations:` 보고 줄)를
  //      확인한다. 인자가 모자라면 그 줄이 나오기 전에 죽는다.
  //
  //      **치환 규칙(둘 다 드리프트 가드다).** `<...>` 자리표시자는 아래 표로만
  //      치환하고, 표에 없는 자리표시자가 남으면 **FAIL**이다 — SKILL.md가
  //      자리표시자 이름을 바꾸면 조용히 통과하는 대신 여기서 터진다.
  //      `[...]`는 이 레포 명령 표기의 **선택 인자**이므로 통째로 버린다(1단계의
  //      `[--ref all]`과 같은 표기다).
  //
  //      **닫지 못한 것.** 이 축은 인용 검증 호출만 실행한다. 나머지 단계(1·2·4·6·8·9)를
  //      같은 방식으로 돌리려면 각 단계의 선행 상태가 필요하고, 그것은 사실상
  //      프롬프트에서 파생한 엔드투엔드 스위트다 — 별도 회차의 일로 남긴다.
  //      **그때까지 그 단계들의 인자 완비성은 미관측이다**(7단계와 같은 결함이
  //      다른 단계에 있어도 지금은 아무것도 빨개지지 않는다).
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-sp10-"));
    try {
      const rootDir = path.join(tmp, STATE_DIR_NAME);
      fs.mkdirSync(rootDir, { recursive: true });
      const evidencePath = path.join(rootDir, EVIDENCE_FILE_NAME);

      // **블록 실행과 양성 대조가 같은 cwd를 쓴다 — 변이 Q3가 강제했다.** 둘을 따로
      // 적으면 블록 실행만 레포 루트로 되돌려도 대조는 계속 무장 상태라, 상대경로가
      // 우연히 풀리는데 「감지할 수 있다」가 참으로 남는다. 한 변수로 묶으면 되돌리는
      // 순간 대조가 함께 눈이 멀고 (SP-11)이 그 사실을 FAIL로 낸다.
      const RUN_CWD = tmp;
      fs.writeFileSync(evidencePath, JSON.stringify({ schemaVersion: "0.1.0", commits: [] }), "utf8");
      // 계층별 산출물 자리를 **표에서 파생해** 만든다. 하드코딩하면 구현 8단계가
      // knowledge-map 호출 블록을 들고 들어올 때 이 절이 조용히 깨진다.
      //
      // **노드를 비워 두지 않는다(2026-08-26).** `nodes: []`이면 external 노드가 0건이라
      // allow-list 판독 실패가 위반이 되지 않고(`loadSourceAllowlist` JSDoc), 그러면 아래
      // (SP-11)이 공허하게 통과한다. allow-list 축이 하중을 받도록 노드 하나를 담는다.
      // URL은 `references/sources.json`에서 **뽑아 쓴다** — 리터럴을 적으면 allow-list가
      // 바뀔 때 이 픽스처만 낡아 (SP-11)이 엉뚱한 이유로 빨개진다. 노드가 실제로 실렸는지는
      // 이 변수가 아니라 (SP-11)의 **양성 대조**가 확인한다(변이 Q2가 그 구별을 강제했다).
      const { json: allowlistJson } = readRepoJsonSafe(path.join("references", "sources.json"));
      const allowedUrl = (allowlistJson?.sources ?? [])[0]?.url ?? null;
      for (const { fileName } of Object.values(ARTIFACT_LAYERS)) {
        fs.writeFileSync(path.join(rootDir, fileName), JSON.stringify({
          schemaVersion: "0.1.0",
          nodes: allowedUrl === null ? [] : [{
            id: "sp10:001", basis: "external", evidence: [], externalUrl: allowedUrl,
            origin: "generated", locked: false, text: "SP-10 하네스 노드",
          }],
        }), "utf8");
      }
      // **7단계가 `--config`로 저자를 넘기게 바뀌었다(순서 11번 / 결정 D3).** 그러면
      // 이 하네스도 그 파일을 놓아 줘야 한다 — 실제로 이 절이 그 변경을 먼저 잡았다
      // (문서화된 명령이 없는 파일을 가리켜 ENOENT + exit 2로 죽었다). 그것이 이 축의
      // 존재 이유이므로 하네스를 맞추는 것이지 가드를 무르는 것이 아니다.
      //
      // **파일명 상수를 쓴다.** 리터럴을 적으면 `store.mjs`가 이름을 바꿀 때 이 절이
      // 조용히 ENOENT로 돌아온다.
      //
      // 내용은 `verify-evidence`가 실제로 읽는 필드 하나(`identitySelection.selected`)만
      // 담는다 — **여기서 스키마 적합성까지 요구하지 않는다.** 이 절이 묻는 것은
      // 「문서화된 명령이 인자 검증을 통과하는가」이고, 진짜 쓰기 주체의 왕복은
      // `(WC-1)`이 따로 관측한다. 둘을 겹치면 한쪽이 바뀔 때 두 곳이 함께 빨개져
      // 어느 계약이 깨졌는지가 뭉개진다.
      fs.writeFileSync(
        path.join(rootDir, CONFIG_FILE_NAME),
        JSON.stringify({ identitySelection: { candidates: [], selected: ["sp10@example.com"] } }),
        "utf8"
      );

      const SUBST = {
        "<레포 경로>": REPO_ROOT,
        "<선택된 이메일>": "sp10@example.com",
        "<원장 경로>": evidencePath,
        "<저장 루트>": rootDir,
      };

      // **블록이 몇 개든 전부 돌린다.** 초판은 `verifierBlocks.length === 1`을
      // 요구했는데, 그러면 두 번째 스킬이 자기 검증 호출을 들고 오는 순간 이 절이
      // 「블록이 2개」라는 이유로 FAIL한다 — 새 호출을 검사하는 것이 아니라 검사
      // 자체가 고장 나는 형태다. (SP-6b)와 같은 「대상 전부」 모양으로 맞춘다.
      const failures = [];
      const outputs = [];
      for (const { file, block } of verifierBlocks) {
        let cmd = block.split("\\\n").join(" ").split("\n").join(" ");
        cmd = cmd.replace(/\[[^\]]*\]/g, " ");
        for (const [ph, val] of Object.entries(SUBST)) cmd = cmd.split(ph).join(val);
        const leftover = cmd.match(/<[^>]*>/g) ?? [];
        if (leftover.length > 0) {
          failures.push(`${file}: 치환표에 없는 자리표시자 ${JSON.stringify(leftover)}`);
          continue;
        }
        // 스크립트 경로 **뒤**부터가 인자다. 토큰 위치를 세지 않고 경로 토큰을
        // 찾아 자른다 — 앞에 `node` 말고 다른 것이 붙어도 따라간다.
        const tokens = cmd.trim().split(/\s+/);
        const argv = tokens.slice(tokens.indexOf("scripts/verify-evidence.mjs") + 1);
        // **cwd를 레포 루트로 두지 않는다(2026-08-26).** 이 스킬들은 **사용자의 레포**에서
        // 실행되므로 실제 cwd는 이 레포가 아니다. `cwd: REPO_ROOT`로 돌리면 프롬프트가 적은
        // **cwd 상대경로** 인자(`--sources references/sources.json` 같은)가 우연히 풀려
        // 통과하고, 그 명령은 실사용에서만 깨진다 — 이 절이 막으려던 「문서화된 명령이 실제로
        // 도는가」의 정확한 반대다. 임시 디렉터리에서 돌려 그 우연을 없앤다.
        //
        // **cwd만 바꿔서는 아무것도 FAIL하지 않는다 — 실측했다.** 이 절이 요구하는 것은
        // `citations:` 줄 하나이고, allow-list 판독 실패는 external 노드가 0건이면 위반이
        // 아니기 때문이다(`loadSourceAllowlist` JSDoc). 그래서 아래 (SP-11)이 external 노드를
        // 담은 픽스처로 그 축을 비공허하게 만든다. **cwd 변경은 (SP-11)의 전제이지 그 자체로
        // 관측이 아니다** — 초판 주석은 측정 전에 「즉시 FAIL했다」라고 적었고 그것은 거짓이었다.
        const ran = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "verify-evidence.mjs"), ...argv], {
          cwd: RUN_CWD,
          encoding: "utf8",
        });
        const out = `${ran.stdout ?? ""}${ran.stderr ?? ""}`;
        outputs.push({ file, out });
        if (!out.includes("[verify-evidence] citations:")) {
          failures.push(`${file}: 검증 축에 도달하지 못했다 — ${out.slice(0, 200).split("\n").join(" ")}`);
        }
      }
      const ok = verifierBlocks.length >= 1 && failures.length === 0;
      if (!ok) console.log(`    실제: 호출 블록 ${verifierBlocks.length}건 / 실패 ${JSON.stringify(failures)}`);
      report(ok, "(SP-10) 프롬프트에서 추출한 인용 검증 명령을 **전부** 실제로 실행하면 인자 검증을 통과해 검증 축까지 도달한다");

      // ---- (SP-11) 명령이 **자기 인자가 풀리지 않아** 실패하지는 않는가 ----
      //      **이 스킬들은 사용자의 레포에서 실행된다.** 프롬프트가 적은 인자에 cwd 상대경로가
      //      섞이면 이 레포 안에서는 우연히 풀리고 실사용에서만 깨진다. 위 실행이 임시 cwd에서
      //      도는 이유가 그것이고, 여기서 그 결과를 판정한다.
      //
      //      판정 대상을 `EXTERNAL_ALLOWLIST_UNREADABLE` 하나로 좁힌다 — 이 오류는 픽스처
      //      내용이 아니라 **명령 자신의 경로 인자**가 풀리지 않았다는 뜻이므로 프롬프트의
      //      결함과 일대일로 대응한다. 다른 FAIL(인용 부재 등)은 하네스 픽스처의 몫이라
      //      여기서 묻지 않는다.
      //
      //      **비공허성을 양성 대조로 확인한다 — 이 대목은 변이가 고쳐 준 것이다.** 초판은
      //      `allowedUrl !== null`(allow-list **파일**에 URL이 있는가)만 봤는데, 그것은
      //      **픽스처가 external 노드를 담았는가**와 다른 축이다. 변이 Q2가 픽스처의 노드만
      //      비웠을 때 이 단언은 그대로 PASS했다(실측 520/0) — 즉 비공허성 가드가 자기 몫을
      //      하지 못했다. 지금은 **일부러 깨뜨린 명령을 한 번 돌려** 하네스가 그 결함을 실제로
      //      감지하는지 확인한다. 감지하지 못하면 위 offenders가 0건인 것은 「결함이 없다」가
      //      아니라 「볼 수 없다」는 뜻이다.
      {
        const offenders = outputs.filter((o) => o.out.includes("EXTERNAL_ALLOWLIST_UNREADABLE")).map((o) => o.file);
        const control = spawnSync(process.execPath, [
          path.join(REPO_ROOT, "scripts", "verify-evidence.mjs"),
          "--repo", REPO_ROOT,
          "--evidence", evidencePath,
          "--out-dir", rootDir,
          "--config", path.join(rootDir, CONFIG_FILE_NAME),
          // **어디에도 없는 파일 이름을 쓰지 않는다 — 변이 Q3가 그것을 반증했다.**
          // 그런 이름은 cwd와 무관하게 항상 읽히지 않으므로 대조가 늘 무장 상태고,
          // `RUN_CWD`를 레포 루트로 되돌려도 이 단언이 그대로 PASS했다(실측 520/0).
          // 프롬프트가 실제로 쓸 법한 **레포 상대경로**를 그대로 쓴다: 이 cwd가 정말로
          // 레포 밖이면 읽히지 않고, 레포 안으로 되돌리면 읽혀서 대조가 눈이 먼 사실이
          // 즉시 FAIL로 드러난다.
          "--sources", path.join("references", "sources.json"),
        ], { cwd: RUN_CWD, encoding: "utf8" });
        const controlOut = `${control.stdout ?? ""}${control.stderr ?? ""}`;
        // 이 대조가 참이라는 것은 「이 cwd에서는 레포 상대경로가 풀리지 않는다」는 뜻이고,
        // 그래야 위 offenders가 0건인 것이 「결함이 없다」를 뜻한다.
        const nonVacuous = controlOut.includes("EXTERNAL_ALLOWLIST_UNREADABLE");
        const okSp11 = verifierBlocks.length >= 1 && nonVacuous && offenders.length === 0;
        if (!okSp11) console.log(`    실제: 양성 대조 감지=${nonVacuous} / allow-list 판독 실패를 낸 프롬프트 ${JSON.stringify(offenders)}`);
        report(
          okSp11,
          "(SP-11) 그 명령을 **레포 밖 cwd**에서 돌려도 자기 경로 인자가 풀리지 않아 실패하지 않는다 " +
          "(스킬은 사용자 레포에서 실행되므로 cwd 상대경로는 실사용에서만 깨진다)"
        );
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

// ---------------------------------------------------------------------------
// gitignore된 경로 참조 가드 — 새 클론에서만 드러나는 고장을 여기서 막는다
// ---------------------------------------------------------------------------

/**
 * **무시되는 산출물 디렉터리를 추적 코드가 참조하면 새 클론에서만 깨진다.**
 *
 * 이 가드가 왜 필요한지는 실제로 있었던 일이다. harness 산출물 디렉터리를
 * 무시하기로 하기 전, `scripts/lib/sampling-literal-drift.mjs`가 그 아래의
 * `spec.md`에서 정본 `samplingMethod` 리터럴을 추출하고 있었고 (R-8)도 같은
 * 파일에서 배지 리터럴을 읽었다. 그 경로를 무시 대상으로 두면 **개발자
 * 워킹 트리에는 파일이 남아 있어 네 게이트가 전부 녹색인데 새 클론에서는 두
 * 단언이 FAIL한다.** 로컬에서만 통과하는 검사는 검사가 아니다.
 *
 * **금지 접두사를 이 파일에 적지 않는다.** 여기에 리터럴을 쓰면 이 함수 자신이
 * 위반 대상이 되고, 그것을 피하려고 「이 파일만 예외」를 두는 순간 이 레포가
 * 계속 닫아 온 자기면제 통로가 하나 생긴다. 대신 **닻을 `.gitignore`에 둔다** —
 * 리터럴의 정본은 거기이고, 무시 목록이 바뀌면 이 가드가 따라간다.
 *
 * **스캔 범위를 「죽은 경로가 실제로 게이트를 깨는 표면」으로 좁힌다.**
 * `.mjs`(테스트·라이브러리가 파일을 연다), 루트 `README.md`와
 * `skills/**`(validate-plugin의 `DOC_PATH_NOT_FOUND`가 스캔한다 — 그 검사는
 * 로컬에 파일이 있으면 통과하므로 클론 전까지 침묵한다). `docs/` 아래 산문은
 * 대상이 아니다: 지난 회차의 핸드오프가 그때 그 경로를 적어 둔 것은 기록이지
 * 살아 있는 의존이 아니다.
 */
function runIgnoredPathReferenceSmoke() {
  console.log("[gitignore 경로 참조 가드] 무시되는 산출물 경로를 추적 코드가 참조하면 새 클론에서 깨진다");

  // 정본은 .gitignore다. `docs/` 아래를 무시하는 줄만 뽑는다.
  //
  // **판독 실패를 새 전제 단언으로 분리하지 않는다 — 여기서는 이미 시끄럽게 실패한다.**
  // `.gitignore`를 못 읽으면 접두사 집합이 비고, 그러면 아래 (DH-1a)가 `length >= 1`에서
  // 그대로 FAIL한다. 1285의 `scripts/**` 스캔은 판독이 전부 실패해도 어떤 단언도 울지 않아
  // 전제를 새로 세웠지만, 이 자리는 그 조건이 성립하지 않는다 — 남는 것은 라벨의 정밀도뿐이고
  // 사유는 (DH-1a)의 콘솔 로그가 싣는다.
  //
  // **다만 (DH-1b)는 반드시 게이트해야 한다.** 접두사가 비면 `offenders`가 항상 0건이 되어
  // 「어디에도 참조가 없다」가 **공허하게 PASS**한다 — 이 가드가 막으려던 결함과 정확히 같은
  // 형태다. 그 게이트는 타협 대상이 아니다.
  const { text: ignoreText, error: ignoreError } = readRepoTextSafe(".gitignore");
  const ignoreLines = ignoreText === null ? [] : ignoreText.split("\n");
  const ignoredDocPrefixes = ignoreLines
    .map((l) => l.trim())
    .filter((l) => !l.startsWith("#") && l.startsWith("docs" + "/") && l.endsWith("/"));
  const PROMOTED_PREFIX = "docs/devcareer-prep-plugin/";

  const ls = spawnSync("git", ["-C", REPO_ROOT, "ls-files"], { encoding: "utf8" });
  const tracked = ls.status === 0 ? ls.stdout.trim().split("\n").filter(Boolean) : [];

  // 스캔 대상: 죽은 경로가 게이트를 깨는 표면만.
  // **루트 `CLAUDE.md`를 스캔 집합에 넣는다(순서 12번).** 이 파일은 추적되고 **모든 세션이
  // 읽는다** — 그 안에서 추적되지 않는 도구 디렉터리를 가리키면 새 클론의 세션이 없는
  // 파일로 안내받는다. 이 가드가 막으려는 「워킹 트리는 녹색인데 새 클론에서만 깨진다」의
  // 가장 비싼 형태다(사람이 아니라 다음 세션 전체가 잘못된 곳을 본다).
  const scanned = tracked.filter(
    (f) => f.endsWith(".mjs") || f === "README.md" || f === "CLAUDE.md" || (f.startsWith("skills/") && f.endsWith(".md"))
  );
  // 스캔 대상을 **한 번만** 판독해 보관한다(초판은 DH-1b와 DH-1c가 각자 전량을 다시 읽어
  // 같은 파일을 두 번 열었다). 판독 실패는 **빈 문자열로 강등하지 않고** 목록에 남긴다 —
  // 그 강등이 아래 (DH-1d) 주석이 적은 거짓 초록의 원인이었다.
  //
  // **판독 원시함수만** 파일 상단의 `readRepoTextSafe`로 넘긴다(2026-08-24). 실패 **집계**는
  // 아래 (DH-1d)가 직접 단언하는 값이므로 지역 배열로 남긴다 — 여기서 통일할 것은 판독과
  // 사유 포맷뿐이고, 「어떻게 실패를 다루는가」는 이 섹션의 정책이다(부분 통일이 맞다).
  const texts = new Map();
  const readFailures = [];
  for (const f of scanned) {
    const { text, error } = readRepoTextSafe(f);
    if (error !== null) readFailures.push(error);
    else texts.set(f, text);
  }

  // ---- (DH-1a) 대상이 0건이 아닌가 ----
  //      아래 금지 방향은 **접두사 집합**이 비거나 **스캔 대상**이 비면 둘 다
  //      공허하게 통과한다. git이 없거나 ls-files가 실패해도 여기서 떨어진다 —
  //      조용히 건너뛰지 않는다.
  {
    const ok = ls.status === 0 && scanned.length >= 5 && ignoredDocPrefixes.length >= 1;
    if (!ok) console.log(`    실제: ${ignoreError ?? ""} git exit=${ls.status} 스캔 대상 ${scanned.length}건 무시 접두사 ${JSON.stringify(ignoredDocPrefixes)}`);
    report(ok, "(DH-1a) .gitignore가 docs 하위 무시 접두사를 갖고 추적되는 스캔 대상이 실재한다(금지 방향이 공허해지지 않는 전제)");
  }

  // ---- (DH-1d) 스캔 대상을 전부 판독했는가 ----
  //      **이 섹션의 거짓 초록이 여기 있었다.** 초판은 판독 실패를
  //      `catch { return "" }`로 빈 문자열로 강등했다. 그러면 읽히지 않은 추적 파일이
  //      아래 금지 방향 스캔에서 **위반 0건으로 집계**되어 조용히 PASS한다 — 「이 파일에는
  //      무시 경로 참조가 없다」와 「이 파일을 못 읽었다」의 결과가 같아진다.
  //      하필 이 가드는 「워킹 트리는 녹색인데 새 클론에서만 깨진다」를 막으려고 만든 것인데,
  //      **같은 방식으로 스스로 무력화되고 있었다.**
  //
  //      DH-1a와 같은 성격의 전제 단언이다 — 대상이 존재하는가(DH-1a)와 그 대상을 실제로
  //      읽었는가(DH-1d)가 둘 다 서야 금지 방향이 비공허해진다. 두 전제를 한 단언에 묶지
  //      않는 이유는 「어느 경로로 실패했는가」를 고정하기 위해서다.
  //
  //      **추적돼 있으나 워킹 트리에 없는 파일도 여기서 떨어진다.** 그 경우 DH-1b의 주장은
  //      그 파일에 대해 증명되지 않았으므로 fail-closed가 맞다 — 「없으니 깨끗하다」로 읽지 않는다.
  {
    const ok = readFailures.length === 0;
    if (!ok) console.log(`    실제: 판독 실패 ${JSON.stringify(readFailures)}`);
    report(
      ok,
      `(DH-1d) 스캔 대상 ${scanned.length}건을 전부 판독했다(판독 실패를 빈 문자열로 강등하지 않는다)`
    );
  }

  // ---- (DH-1b) 금지 방향: 무시되는 경로를 참조하지 않는가 ----
  {
    const offenders = [];
    for (const [f, text] of texts) {
      const hit = ignoredDocPrefixes.find((p) => text.includes(p));
      if (hit !== undefined) offenders.push(`${f} → ${hit}`);
    }
    // `ignoreError === null`은 **타협 불가**다. `.gitignore`를 못 읽으면 접두사가 비어
    // `offenders`가 항상 0건이 되고, 이 단언이 「참조가 없다」로 공허하게 통과한다 — 이 가드가
    // 막으려던 「워킹 트리는 녹색인데 새 클론에서만 깨진다」와 정확히 같은 형태의 자기 무력화다.
    const ok = ignoreError === null && offenders.length === 0;
    if (!ok) console.log(`    실제: ${ignoreError ?? ""} 무시되는 경로를 참조하는 추적 파일 ${JSON.stringify(offenders)}`);
    report(ok, `(DH-1b) 추적되는 코드·lint 스캔 대상 어디에도 무시 접두사(${ignoredDocPrefixes.join(", ")}) 참조가 없다(새 클론에서만 깨지는 고장 차단)`);
  }

  // ---- (DH-1c) 허용 방향: 승격된 경로는 참조해도 되는가 ----
  //      금지 방향만 두면 「`docs/` 전체를 금지」로 넓어져도 아무것도 깨지지
  //      않는다. 그러면 spec.md를 닻으로 쓰는 드리프트 가드를 아예 만들 수
  //      없게 된다 — 이 가드가 지키려는 것과 정반대다. 승격된 경로를 실제로
  //      참조하는 파일이 있고 그것이 위반으로 잡히지 않는 것을 함께 본다.
  {
    const users = [...texts.entries()].filter(([, t]) => t.includes(PROMOTED_PREFIX)).map(([f]) => f);
    const ok = users.length >= 1;
    if (!ok) console.log(`    실제: '${PROMOTED_PREFIX}'를 참조하는 추적 파일이 0건이다(spec.md 닻이 사라졌는가?)`);
    report(ok, `(DH-1c) 허용 방향: 승격된 '${PROMOTED_PREFIX}'를 참조하는 추적 파일이 1건 이상이고 위반이 아니다`);
  }
}

/**
 * 소스 참조 형태 가드 — 다른 파일을 **행 번호로** 가리키지 않는다(콜드 리뷰 A-37).
 *
 * **왜 이 절이 있는가 — 이것은 재발이다.** A-37은 「주석과 실행 로그가 절대 행 번호를
 * 하드코딩한다」를 지적하고 「검색 가능한 식별자로 참조하라」를 처방했다. 콜드 리뷰 ⑧이
 * 같은 처방을 한 번 더 적었다("행 번호를 재계산하지 말고 라벨로 바꿔라 — 재계산은 다음
 * 커밋에 또 낡는다"). **두 번 다 산문으로만 남았고**, 그래서 순서 13번 (a)가 새 파일
 * (`read-registry.mjs`)에 같은 형태를 다시 넣었다. 절대 규칙 3이 이것을 미리 설명한다:
 * **관측되지 않는 제약은 없는 것이다.** 인스턴스만 고치면 다음 회차가 세 번째를 낸다.
 *
 * **행 번호가 왜 나쁜지는 이 레포 안에 실물 증거가 있다.** `scripts/lib/git.mjs`가
 * `evidence.schema.json`의 한 행을 「committerDate는 리베이스로 값이 바뀌므로 쓰지
 * 않는다고 선언한 축」이라고 인용하는데, 그 선언은 그 사이 아래로 밀렸고 **인용이
 * 가리키는 행은 이제 다른 프로퍼티**다. 아무도 알려 주지 않았다 — 행 번호는 조용히
 * 엉뚱한 곳을 가리키기 때문이다. 라벨이었다면 grep 0건으로 드러났다.
 *
 * **그 실물 증거는 고치지 않고 못 박는다.** `git.mjs`는 슬라이스 A이고 예외 표에 없다
 * (절대 규칙 5). `(LN-3)`은 `(SR-9)`·`(CH-8)`과 같은 성격이다 — **PASS라는 것은 그 결함이
 * 살아 있다는 뜻이고**, 누가 고치면 FAIL하며 「이 예외가 아직 필요한가」를 되묻는다.
 * **그 FAIL은 회귀가 아니다.**
 *
 * **금지 방향만으로는 부족하다.** 참조를 통째로 지워도 `(LN-2)`는 통과한다. 그래서
 * `(LN-4)`가 허용 방향을 본다 — 라벨 참조는 위반이 아니며, **실제로 해소되어야 한다.**
 * 그것이 「사라지면 grep 0건으로 드러난다」를 산문에서 실행으로 옮기는 지점이다.
 */
function runSourceLineReferenceSmoke() {
  console.log("[소스 참조 형태 가드] 행 번호 참조는 다음 커밋에 조용히 엉뚱한 곳을 가리킨다(A-37)");

  // 스캔 집합은 DH-1과 같은 모양이다 — 추적되는 코드와 사람이 읽는 지침. 목록을 새로
  // 만들지 않는 이유는 두 가드가 같은 표면(새 클론에서 읽히는 것)을 지키기 때문이다.
  const ls = spawnSync("git", ["-C", REPO_ROOT, "ls-files"], { encoding: "utf8" });
  const tracked = ls.status === 0 ? ls.stdout.trim().split("\n").filter(Boolean) : [];
  const scanned = tracked.filter(
    (f) => f.endsWith(".mjs") || f === "README.md" || f === "CLAUDE.md" || (f.startsWith("skills/") && f.endsWith(".md"))
  );

  // 판독 실패를 빈 문자열로 강등하지 않는다 — 그 강등이 DH-1d가 기록한 거짓 초록의
  // 원인이었고, 여기서도 「못 읽었다」와 「위반이 없다」가 같은 결과가 된다.
  const texts = new Map();
  const readFailures = [];
  for (const f of scanned) {
    const { text, error } = readRepoTextSafe(f);
    if (error !== null) readFailures.push(error);
    else texts.set(f, text);
  }

  // `<경로>/<파일>.<확장자>:<행>` 형태. 경로 접두사는 선택이다 — 실물 두 사례가 각각
  // 붙은 형태와 안 붙은 형태였다.
  const lineRefRe = /(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.(?:mjs|json|md):\d+/g;

  // 슬라이스 A라 고칠 수 없는 알려진 1건. **집합이 아니라 단수로 둔다** — 예외가 목록이
  // 되는 순간 새 위반이 「예외에 한 줄 더」로 조용히 흡수된다.
  const FROZEN = "scripts/lib/git.mjs";

  // ---- (LN-1) 전제: 대상이 실재하고 전부 판독됐는가 ----
  //      아래 금지 방향은 스캔 대상이 비거나 판독이 실패하면 **공허하게 통과한다.**
  //      git이 없거나 ls-files가 실패해도 여기서 떨어진다.
  {
    const ok = ls.status === 0 && scanned.length >= 5 && readFailures.length === 0 && texts.has(FROZEN);
    if (!ok) {
      console.log(`    실제: git exit=${ls.status} 스캔 대상 ${scanned.length}건 판독 실패 ${JSON.stringify(readFailures)} FROZEN 판독=${texts.has(FROZEN)}`);
    }
    report(ok, `(LN-1) 스캔 대상 ${scanned.length}건이 실재하고 전부 판독됐다(금지 방향이 공허해지지 않는 전제)`);
  }

  // ---- (LN-2) 금지 방향: 고칠 수 있는 파일 어디에도 행 번호 참조가 없다 ----
  {
    const offenders = [];
    for (const [f, text] of texts) {
      if (f === FROZEN) continue;
      const hits = text.match(lineRefRe);
      if (hits !== null) offenders.push(`${f} → ${[...new Set(hits)].join(", ")}`);
    }
    const ok = offenders.length === 0;
    if (!ok) {
      console.log(`    실제: 행 번호 참조 ${JSON.stringify(offenders)}`);
      console.log("    처방: 행 번호를 지우고 검색 가능한 식별자로 참조하라 — 라벨은 행이 밀려도 살아남고 사라지면 grep 0건으로 드러난다(A-37 수정안).");
    }
    report(ok, `(LN-2) 금지 방향: 슬라이스 A 예외 1건을 뺀 스캔 대상에 행 번호 참조가 0건이다(A-37 재발 차단)`);
  }

  // ---- (LN-3) 전제 고정: 그 예외는 여전히 살아 있고, 이미 낡았다 ----
  //      **이 단언이 PASS라는 것은 결함이 살아 있다는 뜻이다.** 대상 행 번호를 여기
  //      리터럴로 적지 않는다 — 적는 순간 이 파일이 (LN-2)의 위반이 되고, 그것은
  //      「행 번호를 금지하는 가드가 스스로 행 번호를 쓴다」는 자기 반복이다.
  //      참조는 `git.mjs`에서 **추출**하고, 그것이 가리키는 행을 열어 대조한다.
  {
    const frozenText = texts.get(FROZEN) ?? "";
    const hits = [...new Set(frozenText.match(lineRefRe) ?? [])];
    // `git.mjs`가 그 인용으로 주장하는 내용의 유일 키워드. 이 문자열이 대상 파일에는
    // 있는데 **가리키는 행에는 없다**는 것이 「낡았다」의 정의다.
    const CLAIM = "리베이스";
    let stale = false;
    let detail = `추출 ${JSON.stringify(hits)}`;
    if (hits.length === 1) {
      const sep = hits[0].lastIndexOf(":");
      const rel = hits[0].slice(0, sep);
      const lineNo = Number(hits[0].slice(sep + 1));
      const { text: targetText, error } = readRepoTextSafe(rel);
      if (error !== null) detail = error;
      else {
        const pointed = targetText.split("\n")[lineNo - 1] ?? "";
        stale = !pointed.includes(CLAIM) && targetText.includes(CLAIM);
        detail = `가리키는 행 내용='${pointed.trim().slice(0, 48)}'`;
      }
    }
    const ok = hits.length === 1 && stale;
    if (!ok) {
      console.log(`    실제: ${detail}`);
      console.log("    이 단언의 FAIL은 회귀가 아닐 수 있다: git.mjs의 참조가 고쳐졌다면 이 예외가 아직 필요한지 다시 판단하라((SR-9)와 같은 성격).");
    }
    report(
      ok,
      "(LN-3) 전제 고정: 슬라이스 A의 행 번호 참조 1건이 여전히 살아 있고 이미 다른 행을 가리킨다" +
      "(git.mjs는 예외 표 밖이라 고칠 수 없다 — 닫은 것이 아니라 못 박은 것이다)"
    );
  }

  // ---- (LN-4) 허용 방향: 라벨 참조는 위반이 아니고, 실제로 해소된다 ----
  //      금지 방향만 두면 참조를 통째로 지우는 것으로도 통과한다. 그러면 이 가드는
  //      「다른 파일을 설명하지 마라」가 되어 지키려던 것과 정반대가 된다.
  //      프로덕션 스크립트가 인용한 단언 라벨이 `run-smoke.mjs`에 **실재**하는지 본다 —
  //      라벨의 값은 여기서 나온다(행 번호에는 이 검사에 해당하는 것이 아예 없다).
  {
    const { text: smokeText, error } = readRepoTextSafe("tests/run-smoke.mjs");
    const labelRefRe = /\([A-Z]{2,3}-\d+[a-z]?\)/g;
    const cited = new Set();
    for (const [f, text] of texts) {
      if (!f.startsWith("scripts/")) continue;
      for (const m of text.match(labelRefRe) ?? []) cited.add(m);
    }
    const unresolved = [...cited].filter((l) => smokeText === null || !smokeText.includes(l));
    const ok = error === null && cited.size >= 5 && unresolved.length === 0;
    if (!ok) {
      console.log(`    실제: ${error ?? ""} 인용 라벨 ${cited.size}종 미해소 ${JSON.stringify(unresolved)}`);
    }
    report(
      ok,
      `(LN-4) 허용 방향: 프로덕션 스크립트가 인용한 단언 라벨 ${cited.size}종이 전부 run-smoke.mjs에서 해소된다` +
      "(라벨은 사라지면 grep 0건으로 드러난다 — 그 grep을 실제로 돈다)"
    );
  }
}

/**
 * 슬라이스 A 완료(`97675e7`) 이후 **수정 이력이 0건인** 슬라이스 A 파일과 그 내용 핀.
 *
 * **왜 이 부분집합인가(사용자 결정, 2026-09-02).** 슬라이스 A 파일은 전부 27건이고 그중
 * 11건은 `slice_plan.md`의 예외 표가 **정당하게** 건드린 것들이다. 그 11건까지 핀하면
 * 앞으로 예외 작업을 할 때마다 핀 갱신이 강제되는데, 그 마찰은 「예외 표를 거쳤는가」를
 * 관측하지 못하면서 비용만 낸다. 여기 남는 16건은 **어떤 변경도 정의상 절대 규칙 5 위반**
 * 이므로 정당한 핀 갱신이 발생할 일이 없다 — 마찰이 0이면서 관측은 최대다.
 *
 * **`lib/store.mjs`·`render-markdown.mjs`는 여기 없다.** 둘 다 슬라이스 A 커밋에 이미
 * 존재했지만 `slice_plan.md`의 슬라이스 B `In scope` 열이 명시적으로 담고 있어 **슬라이스 B
 * 소유**다. 파일의 생성 시점이 아니라 계획의 소유 선언이 기준이며, `(SA-4)`가 그 경계를
 * 양방향으로 못 박는다.
 *
 * **CR을 지우고 해시한다 — 그러지 않으면 이 핀은 기계마다 다르게 FAIL한다.** 실측:
 * 이 워킹 트리에서 `package.json`(CR 21) · `.claude-plugin/marketplace.json`(CR 32) ·
 * `schemas/config.schema.json`(CR 155)이 CRLF이고 나머지 13건은 LF다. 세 파일은
 * `.gitattributes`의 `* text=auto`에 걸려 인덱스는 LF인데 `core.autocrlf=true`인
 * 체크아웃에서만 CRLF가 되고, `scripts/**` 아래 `.mjs`류는 `eol=lf`라 항상 LF다. 즉 **원시
 * 바이트 해시는 인덱스가 아니라 체크아웃 설정을 핀하는 것**이 되어 리눅스 CI에서 16건 중
 * 3건이 거짓 FAIL한다. CR 제거는 인덱스 표현과 일치시키는 정규화이며, 그래서 이 핀은
 * 워킹 트리가 아니라 커밋된 내용을 본다.
 *
 * **이 핀이 막지 못하는 것(감추지 않는다).** 슬라이스 A 파일을 고치고 **핀도 함께 고치는**
 * 편집은 통과한다. 그것을 막는 장치는 두지 않는다 — 핀 갱신은 diff에 리터럴로 드러나고,
 * 이 레포의 관례는 총량 가드(`EXPECTED_ASSERTIONS_BEFORE_GUARDS`)와 같이 **고치게 만들되
 * 고친 사실이 보이게** 하는 쪽이다. 조용한 변경을 막는 것이 목적이지 변경을 금지하는 것이
 * 목적이 아니다.
 */
const PINNED_SLICE_A_FILES = Object.freeze([
  [".claude-plugin/marketplace.json", "c953e70458b89af7624a7e0b46be039d07758dc4fb1cef53d0ca9ad9f3605a5e"],
  [".claude-plugin/plugin.json", "8ba73a47a07cd3e94d0c4b40d02b2eb50229f46a1ab318930f993cab719e7e86"],
  ["fixtures/golden/case-17-merge-hash-claim.json", "dad961a153c7fcef66f506ead8308df38001003b924bf8075e8a304b1e435214"],
  ["fixtures/golden/compute-sampling-golden.mjs", "5970159d6c960adf105672215dc0bfb24cab5cefe8547b15096f1aa47fd37ce9"],
  ["fixtures/golden/sampling-300.expected.json", "8b569152c38d5cbb6723603fc0564b8c7a796301fdaa8d34cb559f58f452bb4d"],
  ["fixtures/make-fixture.mjs", "f81c396a45d0e6d05bb9864756b900d1bdd4b98e9ea3e4fb6a24c95ede14b55d"],
  ["package.json", "1228b9b9cc30c9d27ce92937de45898a295069c7451747738fc6d46d60d179c0"],
  ["schemas/config.schema.json", "a30549372b7bbdfe296261bc3cc5b71005be3a43aca23312b79dccba1ce77af2"],
  ["schemas/state.schema.json", "a188019a792ddf271d4304800f7d4f7dd77fb1e40af5fd7b6ee73360b150d2f6"],
  ["scripts/lib/content-hash.mjs", "a66105060109228f20c3c1b57aa70cc0d21cdc8c4a811222b783315255248937"],
  ["scripts/lib/frontmatter.mjs", "ea3e85d75068717d61ac7f6653f7247f2b49780cde0966ca519f9c2841ef9f38"],
  ["scripts/lib/fs-walk.mjs", "82336e83b6fe52f408d7ffca440d677cba1ae3d15b55571a6295ffef691a8f11"],
  ["scripts/lib/git.mjs", "fee563a864e397b008e1446428cf74ccbc4c65a89aa3b6a441e0cc07ab92647a"],
  ["scripts/lib/invariants.mjs", "d19eb71038d979d1fedd32f52bd3e35ccab78be22abac3c496caa8f15cf7f92c"],
  ["scripts/lib/redact.mjs", "3761f4cba8b3e077792817709bfe1395839c0854956c2721308c4dce13b17d5e"],
  ["scripts/lib/sampling.mjs", "6db4a55feb31adad37112c8b8aaca89cb63d7a18260f044ac1edcefedfd9164d"],
]);

/**
 * 핀 목록의 정본 건수. **목록 길이를 여기서 한 번 더 못 박는 이유**는 총량 가드와 같다 —
 * 목록에서 한 줄을 지우는 변경은 `(SA-2)`를 여전히 PASS시키면서 관측 대상만 조용히
 * 줄인다(`(SA-2)`는 「목록의 전건이 일치하는가」이지 「목록이 온전한가」가 아니다).
 */
const EXPECTED_PIN_COUNT = 16;

/** 핀 해시 대상 정규화 — CR을 지워 인덱스 표현과 맞춘다(위 JSDoc의 실측 근거). */
function pinDigest(text) {
  return crypto.createHash("sha256").update(text.replace(/\r/g, ""), "utf8").digest("hex");
}

/**
 * 핀 대조기 — **순수 함수로 뽑아 둔 이유는 `(SA-3)`이 여기에 위조 입력을 먹여
 * 검출력을 실제로 관측하기 위해서다.** 실제 트리에서 「위반 0건」만 보는 검사는
 * 대조를 통째로 지워도 똑같이 초록이다(라운드 2가 `(RV-1)` 초판에서 실측한 형태).
 *
 * @param {ReadonlyArray<readonly [string, string]>} entries
 * @param {(rel: string) => string | null} readText `null`은 판독 실패이며 **위반으로 센다** —
 *   못 읽은 것을 「일치한다」로 강등하면 핀을 지우는 가장 싼 방법이 파일을 지우는 것이 된다
 *   (절대 규칙 6).
 * @returns {string[]} 위반 서술
 */
function checkPinnedContents(entries, readText) {
  const violations = [];
  for (const [rel, expected] of entries) {
    const text = readText(rel);
    if (text === null) {
      violations.push(`${rel}: 판독 실패(핀 대상이 사라졌거나 읽을 수 없다)`);
      continue;
    }
    const actual = pinDigest(text);
    if (actual !== expected) {
      violations.push(`${rel}: 기대 ${expected.slice(0, 12)}… 실제 ${actual.slice(0, 12)}…`);
    }
  }
  return violations;
}

/**
 * 절대 규칙 4·5 관측 오라클 — 콜드 리뷰 라운드 2 처방 11.
 *
 * **두 규칙이 지금까지 산문뿐이었다.** 규칙 4(총량 가드를 하한으로 완화하지 마라)와
 * 규칙 5(슬라이스 A 파일을 고치지 마라)는 `CLAUDE.md`와 핸드오프 Do NOT에만 있었고,
 * 그 둘을 어기는 편집을 관측하는 장치가 0건이었다.
 *
 * **규칙 4 쪽의 구멍은 이 파일이 스스로 실측해 적어 두었다.** `finishMode`의 JSDoc이
 * 「정확 일치를 하한(`>=`)으로 완화하는 변이는 무변이 트리에서 **아무것도 깨지 않는다**
 * (실측 447 PASS / 0 FAIL)」라고 기록했다. 즉 구멍이 명명된 채 메워지지 않은 상태였다.
 *
 * **같은 JSDoc이 「가드를 세는 가드를 두지 않는다」고도 적었다 — 그 결정과 충돌하지
 * 않는다.** 그쪽이 거절한 것은 **개수 축**이다(가드가 자기 개수를 세면 재귀한다).
 * 여기서 세우는 것은 **형태 축**이다 — 비교 연산자가 무엇인지를 소스에서 본다.
 * 형태 축은 재귀하지 않는다: 이 절의 단언들은 자기 자신의 형태를 보지 않고
 * `finishMode` 본문만 본다. 그리고 이 절을 통째로 지우는 변경은 단언 8건이 사라지므로
 * **총량 가드가 잡는다** — 두 축이 서로 다른 방향에서 받친다.
 *
 * **`(LN-4)`가 이미 `run-smoke.mjs` 자기 소스를 판독하는 선례다.** 자기 소스 판독 자체는
 * 이 레포에서 새 형태가 아니다.
 *
 * **이 절이 막지 못하는 것**: `finishMode` 본문 **밖**에서 총량을 무력화하는 변경
 * (예: `passed`/`failed` 카운터 자체를 조작). 그 축은 이 절의 범위가 아니고, 여기서
 * 넓히면 「전부를 보는 가드」가 되어 무엇을 보는지가 흐려진다.
 */
function runSliceRuleObservationSmoke() {
  console.log("[절대 규칙 4·5 관측] 총량 가드의 연산자 형태와 슬라이스 A 내용을 못 박는다(라운드 2 처방 11)");

  const { text: smokeText, error: smokeError } = readRepoTextSafe("tests/run-smoke.mjs");

  // `finishMode` **본문만** 잘라낸다. 파일 전체를 스캔하면 이 절의 코드 자신이 스캔
  // 대상이 되어 「가드가 스스로를 잡는」 오탐이 난다 — 라운드 3이 `includes("FAIL ")`
  // 오탐 20건으로 실측한 것과 같은 형태의 파서 사고다.
  const FN_ANCHOR = "\nfunction finishMode(mode) {";
  const CONST_ANCHOR = "\nconst EXPECTED_ASSERTIONS_BEFORE_GUARDS = Object.freeze({";
  let fnBody = null;
  let constBlock = null;
  if (smokeText !== null) {
    const fnStart = smokeText.indexOf(FN_ANCHOR);
    if (fnStart !== -1) {
      const rest = smokeText.slice(fnStart + FN_ANCHOR.length);
      const end = rest.indexOf("\n}\n");
      if (end !== -1) fnBody = rest.slice(0, end);
    }
    const cStart = smokeText.indexOf(CONST_ANCHOR);
    if (cStart !== -1) {
      const rest = smokeText.slice(cStart + CONST_ANCHOR.length);
      const end = rest.indexOf("\n});");
      if (end !== -1) constBlock = rest.slice(0, end);
    }
  }

  // ---- (GP-1) 전제: 관측 대상 둘을 실제로 잘라냈는가 ----
  //      아래 세 단언은 대상이 비면 **공허하게 통과한다**(빈 문자열에는 위반이 0건이다).
  //      `(SP-1)`·`(LN-1)`이 세운 것과 같은 전제이며, 두 대상을 한 단언에 묶는 이유는
  //      둘 중 하나만 실패해도 나머지 셋이 전부 무의미해지기 때문이다.
  {
    const ok =
      smokeError === null && fnBody !== null && constBlock !== null &&
      fnBody.length > 0 && constBlock.length > 0;
    if (!ok) {
      console.log(`    실제: ${smokeError ?? ""} finishMode 본문=${fnBody === null ? "미추출" : `${fnBody.length}자`} 상수 블록=${constBlock === null ? "미추출" : `${constBlock.length}자`}`);
      console.log("    처방: 두 닻(finishMode 선언 줄 / 정본 상수 선언 줄)이 개명됐다면 이 절의 닻 상수를 함께 고쳐라.");
    }
    report(ok, "(GP-1) 전제: finishMode 본문과 정본 상수 블록을 소스에서 잘라냈다(아래 세 단언이 공허해지지 않는 전제)");
  }

  // ---- (GP-2) 금지 방향: 총량 비교가 완화형이 아닌가 ----
  //      절대 규칙 4가 이름으로 금지한 하한을 포함해, `observed`와 `expected`를 잇는
  //      **부등호** 비교는 전부 위반이다. 한 방향만 보면 피연산자를 뒤집는 것으로
  //      빠져나가므로 양쪽 순서를 다 본다.
  //
  //      **`!==`는 금지 집합에서 뺐고, 그것은 초판의 오탐을 게이트가 잡아 준 결과다.**
  //      초판은 `!==`도 완화형으로 셌는데, 이 함수에는 진단 출력을 위한 정당한
  //      `if (observed !== expected)` 분기가 있어 무변이 트리에서 이 단언이 FAIL했다
  //      (실측 585 PASS / 1 FAIL). 대상을 좁히는 대신 「부등호만」으로 축을 바꾼 이유는
  //      **판정을 `!==`로 뒤집는 변이는 `(GP-3)`이 이미 잡기 때문**이다 — 그 변이는
  //      정확 일치 비교를 소멸시킨다. 두 단언이 같은 갈래를 두 번 보는 것보다
  //      각자 고유 관측점을 갖는 편이 낫다.
  {
    const relaxedRe = /(observed\s*(?:>=|<=|>|<)\s*expected|expected\s*(?:>=|<=|>|<)\s*observed)/g;
    const hits = fnBody === null ? [] : [...new Set(fnBody.match(relaxedRe) ?? [])];
    const ok = fnBody !== null && hits.length === 0;
    if (!ok) {
      console.log(`    실제: 완화형 비교 ${JSON.stringify(hits)}`);
      console.log("    처방: 총량 가드는 정확 일치여야 한다 — 하한은 「단언 3건을 늘리고 2건을 잃어 순증 +1」인 변경을 통과시킨다(절대 규칙 4).");
    }
    report(ok, "(GP-2) 금지 방향: finishMode에 observed/expected를 잇는 부등호 비교가 0건이다(절대 규칙 4)");
  }

  // ---- (GP-3) 허용 방향: 정확 일치 비교가 실제로 report()에 실려 있는가 ----
  //      금지 방향만 두면 **비교를 통째로 지우는** 변경이 통과한다. 그러면 이 가드는
  //      「완화하지 마라」가 아니라 「비교하지 마라」가 되어 정반대가 된다.
  {
    const exactRe = /report\(\s*observed === expected\s*,/g;
    const count = fnBody === null ? 0 : (fnBody.match(exactRe) ?? []).length;
    const ok = count === 1;
    if (!ok) {
      console.log(`    실제: 정확 일치 판정을 실은 report() 호출 ${count}건(기대 1건)`);
    }
    report(ok, "(GP-3) 허용 방향: 정확 일치 비교가 report()의 판정으로 정확히 1건 실려 있다");
  }

  // ---- (GP-4) 금지 방향: 정본 값이 리터럴인가, 그리고 런타임 값과 일치하는가 ----
  //      완화의 다른 갈래는 연산자가 아니라 **피연산자**를 건드리는 것이다. 모드 값을
  //      계산식으로 바꾸면 비교는 정확 일치인 채로 **항상 참**이 된다. 리터럴 강제 +
  //      런타임 대조를 함께 두는 이유는 소스만 보면 「적힌 값」과 「쓰이는 값」이
  //      갈릴 수 있기 때문이다.
  {
    const modes = ["default", "negative", "golden", "contamination"];
    const problems = [];
    if (constBlock === null) problems.push("상수 블록 미추출");
    else {
      for (const mode of modes) {
        const m = constBlock.match(new RegExp(`\\n\\s*${mode}:\\s*(\\d+),`));
        if (m === null) { problems.push(`${mode}: 정수 리터럴이 아니다`); continue; }
        if (Number(m[1]) !== EXPECTED_ASSERTIONS_BEFORE_GUARDS[mode]) {
          problems.push(`${mode}: 소스 리터럴 ${m[1]} 대 런타임 ${EXPECTED_ASSERTIONS_BEFORE_GUARDS[mode]}`);
        }
      }
    }
    const ok = problems.length === 0;
    if (!ok) console.log(`    실제: ${JSON.stringify(problems)}`);
    report(ok, `(GP-4) 금지 방향: 정본 상수 ${modes.length}개 모드가 전부 정수 리터럴이고 런타임 값과 일치한다(계산식 우회 차단)`);
  }

  // ---- (SA-1) 전제: 핀 목록이 온전한가 ----
  //      `(SA-2)`는 「목록의 전건이 일치하는가」만 본다 — 목록에서 한 줄을 지우면
  //      여전히 PASS하면서 관측 대상만 줄어든다. 그 갈래를 여기서 닫는다.
  {
    const rels = PINNED_SLICE_A_FILES.map(([rel]) => rel);
    const unique = new Set(rels);
    const ok = PINNED_SLICE_A_FILES.length === EXPECTED_PIN_COUNT && unique.size === EXPECTED_PIN_COUNT;
    if (!ok) {
      console.log(`    실제: 핀 ${PINNED_SLICE_A_FILES.length}건(기대 ${EXPECTED_PIN_COUNT}건) 고유 경로 ${unique.size}건`);
      console.log("    처방: 핀을 줄이려면 그 파일이 왜 더 이상 「수정 이력 0건」이 아닌지를 먼저 적어라 — 예외 표를 거치지 않은 수정이라면 그것이 곧 절대 규칙 5 위반이다.");
    }
    report(ok, `(SA-1) 전제: 슬라이스 A 내용 핀이 정확히 ${EXPECTED_PIN_COUNT}건이고 경로 중복이 없다`);
  }

  // ---- (SA-2) 금지 방향: 실제 트리가 핀과 일치하는가 ----
  {
    const violations = checkPinnedContents(PINNED_SLICE_A_FILES, (rel) => readRepoTextSafe(rel).text);
    const ok = violations.length === 0;
    if (!ok) {
      console.log(`    실제: ${JSON.stringify(violations)}`);
      console.log("    처방: 이 FAIL은 슬라이스 A 파일이 바뀌었다는 뜻이다. slice_plan.md의 예외 표에 그 행이 있는지 먼저 확인하라 — 없으면 되돌려라(절대 규칙 5).");
    }
    report(ok, `(SA-2) 금지 방향: 수정 이력 0건인 슬라이스 A 파일 ${PINNED_SLICE_A_FILES.length}건의 내용이 핀과 전부 일치한다(절대 규칙 5)`);
  }

  // ---- (SA-3) 검출력: 대조기가 실제로 발화하는가 ----
  //      실제 트리에서 「위반 0건」만 보는 검사는 대조를 통째로 지워도 똑같이 초록이다.
  //      두 갈래(내용 변조 · 판독 실패)를 각각 먹여 **자기 1건만 더** 보고하는지 본다.
  //
  //      **절대 수가 아니라 기준선 대비 증분으로 본다.** 「위반이 정확히 1건」으로 적으면
  //      `(SA-2)`가 이미 FAIL인 트리(= 슬라이스 A 파일이 실제로 바뀐 트리)에서 이 단언까지
  //      함께 FAIL한다. 그러면 변이 하나가 단언 둘을 깨서 각 단언의 고유 관측점이 사라진다 —
  //      라운드 2가 `(RV-1)` 초판에서, 라운드 3이 `(LP-22)` 설계에서 각각 겪은 형태다.
  {
    const [victimRel] = PINNED_SLICE_A_FILES[0];
    const realText = (rel) => readRepoTextSafe(rel).text;
    const base = checkPinnedContents(PINNED_SLICE_A_FILES, realText);
    const mutated = checkPinnedContents(
      PINNED_SLICE_A_FILES,
      (rel) => (rel === victimRel ? `${realText(rel) ?? ""}\n// 변이` : realText(rel))
    );
    const missing = checkPinnedContents(
      PINNED_SLICE_A_FILES,
      (rel) => (rel === victimRel ? null : realText(rel))
    );
    const addedBy = (after) => after.filter((v) => !base.includes(v));
    const mutatedAdded = addedBy(mutated);
    const missingAdded = addedBy(missing);
    const ok =
      mutatedAdded.length === 1 && mutatedAdded[0].startsWith(`${victimRel}: 기대 `) &&
      missingAdded.length === 1 && missingAdded[0].startsWith(`${victimRel}: 판독 실패`);
    if (!ok) {
      console.log(`    실제: 기준선 ${base.length}건 / 변조가 더한 것 ${JSON.stringify(mutatedAdded)} / 판독 실패가 더한 것 ${JSON.stringify(missingAdded)}`);
    }
    report(ok, "(SA-3) 검출력: 대조기가 내용 변조와 판독 실패에 대해 각각 기준선보다 자기 1건만 더 보고한다(판독 실패를 일치로 강등하지 않는다)");
  }

  // ---- (SA-4) 금지 방향(반대 축): 핀이 슬라이스 B 파일을 얼리지 않는가 ----
  //      이 가드의 사고 형태는 두 방향이다. 하나는 슬라이스 A가 조용히 바뀌는 것이고,
  //      다른 하나는 **슬라이스 B 파일이 핀 목록에 들어가 이번 회차 작업이 막히는 것**이다.
  //      후자를 두면 다음 세션이 「가드가 막으니 슬라이스 A인가 보다」로 오독한다.
  //      경계의 정본은 `slice_plan.md`의 슬라이스 B `In scope` 열이다 — 파일이 언제
  //      만들어졌는가가 아니라 계획이 누구 것이라 선언했는가가 기준이다.
  {
    const { text: planText, error: planError } = readRepoTextSafe("docs/devcareer-prep-plugin/slice_plan.md");
    const row = planText === null
      ? null
      : (planText.split("\n").find((l) => l.startsWith("| `slice-b-p0-skill-layer`")) ?? null);
    const declared = new Set();
    if (row !== null) {
      for (const m of row.match(/`([A-Za-z0-9_.\-/]+\.(?:mjs|json|md))`/g) ?? []) {
        declared.add(m.slice(1, -1));
      }
    }
    const trespass = PINNED_SLICE_A_FILES.map(([rel]) => rel).filter((rel) => declared.has(rel));
    const ok = planError === null && row !== null && declared.size >= 3 && trespass.length === 0;
    if (!ok) {
      console.log(`    실제: ${planError ?? ""} 슬라이스 B 행=${row === null ? "미발견" : "발견"} 선언 파일 ${declared.size}건 침범 ${JSON.stringify(trespass)}`);
    }
    report(
      ok,
      `(SA-4) 금지 방향: 핀 목록이 slice_plan.md의 슬라이스 B In scope 파일 ${declared.size}건 중 어느 것도 얼리지 않는다` +
      "(파일 생성 시점이 아니라 계획의 소유 선언이 경계다)"
    );
  }
}

/**
 * 오염 스위트 채점 엔진 오라클 — 구현 9단계(작업 순서 14번) 기계 3종.
 *
 * **왜 채점기를 순수 함수로 떼어 냈는가.** 이 절은 300커밋 픽스처도 서브프로세스도
 * 쓰지 않는다 — 합성 입력으로 채점 로직만 시험한다. 채점기가 IO와 붙어 있으면
 * 「분모를 채점된 건수로 바꾸기」 같은 변이 하나를 관측하는 데 픽스처 빌드가 통째로
 * 걸리고, 그러면 다음 회차가 변이를 안 돌린다. **비용은 「10분」이 아니라 109초다**
 * (전 시나리오 콜드 빌드 실측 — `docs/devcareer-prep-plugin/perf_review.md` §3).
 * 초판 주석의 「10분」은 측정된 값이 아니었다.
 *
 * **단언 개수를 케이스 수와 무관하게 유지한다.** 구현 9단계는 편차 20%p 초과 시 종당
 * 20건으로 1회 증설을 허용하는데, 케이스마다 단언을 세우면 **데이터를 바꿀 때마다
 * 정본 상수(소스 리터럴)를 함께 고쳐야 한다** — 절대 규칙 4가 의도한 마찰을 채점
 * 데이터에 매다는 형태다. 그래서 케이스는 집계 단언으로 관측한다.
 *
 * **경계 정본은 `tests/contamination/README.md`다.** 여기서 재서술하지 않는다.
 * 이 절이 관측하는 것은 채점 로직과 케이스 집합의 형태이고, 회차 산출물을 실제로
 * 읽어 채점하는 것은 `--contamination` 모드의 몫이다(아직 배선 전이다 — 그 사실을
 * 감추지 않는다).
 */
/**
 * 콜드 리뷰 라운드 2 처방 2·9 오라클 — 부재를 「없음」으로 강등하지 않는다 · 생산자 인증.
 *
 * **두 처방을 한 절에 두는 이유.** 둘 다 라운드 2가 같은 축에서 잡은 것이다 — 이 레포가
 * 「어길 수 없다」고 적어 둔 규칙이 실제로는 산문뿐이었고, 그 승격이 규모 S였다. 절을 나누면
 * 다음 회차가 「왜 이 둘이 같은 회차에 들어왔는가」를 잃는다.
 *
 * 경계 정본은 `docs/devcareer-prep-plugin/cold_review_round2.md`이며 여기서 재서술하지 않는다.
 */
/**
 * 콜드 리뷰 라운드 2 처방 1 오라클 — 렌더 입력 게이트.
 *
 * **왜 이 절이 있는가.** 이 게이트가 붙기 전 `render-markdown.mjs`는 아무 JSON이나 받아
 * exit 0으로 렌더했다. 그 CLI의 import는 `fs`·`node:url`·`render-contract.mjs`뿐이었고
 * `validateInstance`도 `computeArtifactContentHash`도 없었다. 라운드 2가 실측한 것:
 * 레포에 없는 해시를 인용하고 `verification.status`를 `"verified"`로 자칭하고
 * `contentHash`가 `"deadbeef"`이고 required `coverage`·`truncated`가 통째로 빠진 입력이
 * **exit 0으로 「근거 등급: 커밋 근거 · 검증: verified」가 붙은 문서**가 됐다.
 *
 * **그리고 위조본이 정직한 산출물보다 깨끗했다** — 배지가 `verification.status`에서만
 * 파생하므로 자칭 verified가 강등 배지를 껐다. 방어용 필드가 공격자 자산이 된 형태다.
 *
 * **이 표면이 특별한 이유**: 사용자가 보는 것은 그 `.md`뿐이고 **어떤 스크립트도 그것을
 * 다시 읽지 않는다**(`--secret-scan`조차 보지 않는다). 다른 미포착은 파일에 흔적이 남아
 * 사후 감사가 가능하지만 이것은 아니다.
 */
/**
 * **정직한 저장 루트를 실제로 만든다** — 라운드 2 처방 8의 허용 방향 픽스처.
 *
 * 렌더가 인용 재검증을 다시 돌리게 되면서, 「렌더가 성공한다」를 관측하려면 실제 레포로
 * 뒷받침되는 산출물이 필요해졌다. 이전에는 `(RV-3)`이 **오염 코퍼스**를 렌더해 exit 0을
 * 기대했는데, 그것이 바로 이 게이트가 닫으려는 상태다.
 *
 * **합성 인용으로는 안 된다.** 재검증이 실제 git 조회를 강제하므로 `commit:cccc…` 같은
 * 자리표시자는 통과할 수 없다 — 그 강제가 이 처방의 값 자체다.
 *
 * 세 계층이 서로 물려 있다: `knowledge-map.parentRefs`가 career 노드 id를,
 * `gap-report.parentRefs`가 knowledge-map 노드 id를 가리키고(둘 다 `minItems: 1`),
 * `layerRefUnverifiable`이 0이어야 하므로 셋을 함께 실어야 한다.
 *
 * 결과를 메모이즈한다 — 이 절과 `(RM-7)`이 함께 쓰고, 빌드는 프로세스 6~7개를 띄운다.
 *
 * @returns {{root: string, repo: string, careerIds: string[], kmIds: string[]}|null}
 *          만들지 못했으면 `null`(호출부가 FAIL로 떨어뜨린다 — 빈 값으로 강등하지 않는다).
 */
let HONEST_ROOT_CACHE;
function buildHonestRenderRoot() {
  if (HONEST_ROOT_CACHE !== undefined) return HONEST_ROOT_CACHE;
  const FIXED_AT = "2026-09-01T00:00:00Z";
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-honest-"));
    const repo = path.join(tmp, "repo");
    buildSingleCommit(repo);

    const root = path.join(tmp, "store", STATE_DIR_NAME);
    fs.mkdirSync(root, { recursive: true });

    const run = (script, args) => spawnSync(
      process.execPath, [path.join(REPO_ROOT, "scripts", script), ...args], { encoding: "utf8" }
    );

    const collected = run("collect-git-facts.mjs", ["--repo", repo, "--identity", OWNER_EMAIL, "--out", root]);
    if (collected.status !== 0) { HONEST_ROOT_CACHE = null; return null; }

    const cfgIn = path.join(tmp, "config-in.json");
    fs.writeFileSync(cfgIn, JSON.stringify({
      identitySelection: { candidates: [], selected: [OWNER_EMAIL] },
      scope: { ref: "HEAD", mergeIncluded: false, since: null, until: null },
      budget: { maxCommits: 50 },
      includeDiff: false,
      exclusions: { bots: true, vendoredPaths: true },
      storage: { root: "home", repoOptIn: false },
      snippetQuoting: false,
    }), "utf8");
    const cfg = run("write-config.mjs", ["--in", cfgIn, "--root", root, "--updated-at", FIXED_AT]);
    if (cfg.status !== 0) { HONEST_ROOT_CACHE = null; return null; }

    const ev = JSON.parse(fs.readFileSync(path.join(root, "evidence.json"), "utf8"));
    const commit = (ev.commits ?? []).find((c) => c.excluded !== true);
    const file = (commit?.files ?? [])[0];
    if (commit === undefined || file === undefined) { HONEST_ROOT_CACHE = null; return null; }

    // **`coverage`를 계층 스키마에 맞춰 좁힌다.** 세 계층의 `$defs.coverage`가 서로
    // 갈려 있다 — `career`는 원장의 `isShallowClone`을 허용하지만 `knowledge-map`·
    // `gap-report`는 `additionalProperties` 위반으로 거부한다(실측). 계층별 허용 키를
    // 스키마에서 읽어 맞춘다 — 여기서 키를 하드코딩하면 그 드리프트를 픽스처가 한 번 더
    // 복제하게 된다. (이 갈림 자체는 슬라이스 A 스키마의 문제이며 여기서 고치지 않는다.)
    const coverageFor = (layer) => {
      const { json: sch } = readRepoJsonSafe(`schemas/${layer}.schema.json`);
      const allowed = sch?.$defs?.coverage?.properties;
      if (allowed === undefined || allowed === null) return ev.coverage;
      const out = {};
      for (const k of Object.keys(ev.coverage ?? {})) {
        if (Object.prototype.hasOwnProperty.call(allowed, k)) out[k] = ev.coverage[k];
      }
      return out;
    };
    const headFor = (layer) => ({
      schemaVersion: "1.0.0", generatedAt: FIXED_AT, sourceRepoHead: ev.sourceRepoHead,
      coverage: coverageFor(layer), truncated: ev.truncated,
    });
    const cite = [{ ledgerId: commit.id, path: file.path }];
    const write = (layer, nodes) => {
      const draftPath = path.join(tmp, `${layer}-draft.json`);
      fs.writeFileSync(draftPath, JSON.stringify({ ...headFor(layer), contentHash: "0".repeat(64), nodes }), "utf8");
      return run("write-artifact.mjs", [
        "--layer", layer, "--draft", draftPath, "--root", root, "--stage", "fact-checked",
        "--skill", layer === "career" ? "career-from-git" : "skill-gap", "--generated-at", FIXED_AT,
      ]);
    };

    const careerIds = ["car:h01"];
    const w1 = write("career", [{
      id: careerIds[0], basis: "commit", evidence: cite,
      verification: { status: "verified", attempts: 1, reasonCode: null },
      origin: "generated",
      text: "픽스처 레포의 초기 커밋으로 README를 작성했다.",
    }]);
    if (w1.status !== 0) { HONEST_ROOT_CACHE = null; return null; }

    const kmIds = ["km:h01"];
    const w2 = write("knowledge-map", [{
      id: kmIds[0], basis: "inference", evidence: cite, parentRefs: careerIds,
      verification: { status: "verified", attempts: 1, reasonCode: null },
      origin: "generated", topic: "문서화",
      text: "저장소 문서를 스스로 작성해 본 경험이 있다.",
    }]);
    if (w2.status !== 0) { HONEST_ROOT_CACHE = null; return null; }

    const w3 = write("gap-report", [{
      id: "gap:h01", basis: "inference", evidence: cite, parentRefs: kmIds,
      verification: { status: "verified", attempts: 1, reasonCode: null },
      origin: "generated", topic: "문서화",
      text: "문서화 경험은 있으나 규모가 작다.",
      selfAssessment: "자가진단 원문 — 정직한 루트 픽스처.",
    }]);
    if (w3.status !== 0) { HONEST_ROOT_CACHE = null; return null; }

    HONEST_ROOT_CACHE = { root, repo, careerIds, kmIds };
    return HONEST_ROOT_CACHE;
  } catch {
    HONEST_ROOT_CACHE = null;
    return null;
  }
}

function runRenderGateSmoke() {
  console.log("[렌더 입력 게이트] 부적합한 산출물은 사용자 표면에 닿지 않는다(라운드 2 처방 1)");

  // **오염 코퍼스에서 정직한 루트로 갈아탔다(라운드 2 처방 8).** 렌더가 인용 재검증을
  // 다시 돌리게 되면서 `run-machine-01`은 이제 **정당하게 거부된다** — 그것이 이 게이트가
  // 닫으려는 상태다. 허용 방향을 관측하려면 실제 레포로 뒷받침되는 산출물이 있어야 한다.
  const HONEST = buildHonestRenderRoot();
  const R = HONEST?.root ?? path.join(REPO_ROOT, "tests", "contamination", "runs", "run-machine-01", ".devcareer");
  const REPO_FOR_RENDER = HONEST?.repo ?? REPO_ROOT;
  const realPath = path.join(R, "career.json");
  let real = null;
  try { real = JSON.parse(fs.readFileSync(realPath, "utf8")); } catch { /* (RV-3)이 잡는다 */ }

  // **`--root`·`--repo`는 이제 필수다.** 금지 방향 픽스처는 루트 밖 임시 파일을 `--in`으로
  // 주는데, 검사 순서가 `checkRenderInput` → 재검증이므로 스키마·해시 축이 먼저 발화해
  // 각 단언의 고유 관측점이 유지된다.
  const renderCli = (layer, obj, outPath) => {
    const inPath = path.join(os.tmpdir(), `devcareer-rv-${layer}-${crypto.createHash("sha256").update(JSON.stringify(obj)).digest("hex").slice(0, 12)}.json`);
    fs.writeFileSync(inPath, JSON.stringify(obj), "utf8");
    const r = spawnSync("node", [
      path.join(REPO_ROOT, "scripts", "render-markdown.mjs"),
      "--layer", layer, "--in", inPath, "--root", R, "--repo", REPO_FOR_RENDER,
      ...(outPath ? ["--out", outPath] : []),
    ], { cwd: REPO_ROOT, encoding: "utf8" });
    return { status: r.status, out: (r.stdout ?? "") + (r.stderr ?? "") };
  };

  // ---- (RV-5) 전제: 정직한 루트가 실제로 만들어졌는가 ----
  //      이것이 실패하면 아래 허용 방향 단언들은 공허하다.
  {
    const ok = HONEST !== null;
    if (!ok) console.log("    실제: buildHonestRenderRoot()가 null을 돌려줬다");
    report(ok, "(RV-5) 전제: 실제 레포·원장·설정으로 뒷받침되는 정직한 3계층 저장 루트가 만들어진다(허용 방향의 재료)");
  }

  // ---- (RV-1) 금지 방향: 스키마 부적합은 렌더되지 않고 파일도 생기지 않는다 ----
  //      「거부했다」와 「거부했지만 파일은 남겼다」는 다르다 — 후자면 사용자가 그 문서를
  //      읽는다.
  {
    const forged = {
      schemaVersion: "0.1.0",
      generatedAt: "2026-09-01T00:00:00.000Z",
      sourceRepoHead: "0".repeat(40),
      contentHash: "deadbeef",
      nodes: [{
        id: "forged-1", basis: "commit", origin: "generated", locked: false,
        evidence: [{ ledgerId: "commit:" + "1".repeat(40) }],
        verification: { status: "verified", attempts: 0, reasonCode: null },
        text: "근거 없이 검증 완료를 자칭하는 항목이다.",
      }],
    };
    // **해시를 올바르게 계산해 담는다 — 이 단언이 보는 것은 스키마 축이다.**
    // 자리표시자 해시를 두면 이 픽스처가 스키마·해시 **두 축 모두**에 걸려, 스키마 검증만
    // 무력화하는 변이에서 이 단언이 여전히 PASS한다(고유 관측점이 사라진다). 해시 축은
    // (RV-2)가 자기 픽스처로 따로 본다.
    const forgedHashed = { ...forged, contentHash: computeArtifactContentHash("career", forged) };
    const outPath = path.join(os.tmpdir(), `devcareer-rv1-${Date.now()}.md`);
    try { fs.rmSync(outPath, { force: true }); } catch { /* 없으면 그만 */ }
    const r = renderCli("career", forgedHashed, outPath);
    const wrote = fs.existsSync(outPath);
    const ok = r.status === 1 && !wrote && r.out.includes("[SCHEMA]");
    if (!ok) console.log(`    실제: exit=${r.status} 파일생성=${wrote} 출력=${JSON.stringify(r.out.slice(0, 160))}`);
    report(ok, "(RV-1) 금지 방향: 스키마 부적합 산출물은 exit 1이고 마크다운 파일이 생기지 않는다(required 부재·자칭 verified 포함)");
  }

  // ---- (RV-2) 금지 방향: contentHash 불일치는 렌더되지 않는다 ----
  //      스키마는 통과하지만 본문이 기록 이후 손으로 고쳐진 경우다. 키 없는 SHA-256이라
  //      의도적 위조는 못 막지만 **「임시 조립 JSON을 그대로 렌더」라는 가장 싼 경로**는
  //      닫힌다.
  {
    const tampered = real === null ? null : { ...real, contentHash: "0".repeat(64) };
    const r = tampered === null ? { status: null, out: "" } : renderCli("career", tampered, null);
    const ok = r.status === 1 && r.out.includes("contentHash");
    if (!ok) console.log(`    실제: exit=${r.status} 출력=${JSON.stringify(r.out.slice(0, 160))}`);
    report(ok, "(RV-2) 금지 방향: contentHash가 본문 재계산값과 다르면 exit 1이다(기록 이후 손으로 고친 본문 차단)");
  }

  // ---- (RV-3) 허용 방향: 실제 산출물 세 계층이 그대로 렌더된다 ----
  //      금지 방향만 두면 **전부 거부**해도 아무것도 깨지지 않는다 — 그러면 제품이 문서를
  //      만들 수 없게 되는데 게이트는 초록이다. `write-artifact.mjs`가 실제로 쓴 파일을
  //      쓴다(합성 입력이면 「쓰기와 렌더가 접합되는가」가 관측되지 않는다).
  {
    const bad = [];
    for (const layer of ["career", "knowledge-map", "gap-report"]) {
      const p = path.join(R, `${layer}.json`);
      const r = spawnSync("node", [
        path.join(REPO_ROOT, "scripts", "render-markdown.mjs"), "--layer", layer, "--in", p,
        "--root", R, "--repo", REPO_FOR_RENDER,
      ], { cwd: REPO_ROOT, encoding: "utf8" });
      if (r.status !== 0) bad.push(`${layer}=exit ${r.status}: ${((r.stderr ?? "") + (r.stdout ?? "")).slice(0, 120)}`);
    }
    const ok = real !== null && bad.length === 0;
    if (!ok) console.log(`    실제: 원본판독=${real !== null} 거부된 계층 ${JSON.stringify(bad)}`);
    report(ok, "(RV-3) 허용 방향: write-artifact가 실제로 기록한 세 계층이 전부 exit 0으로 렌더된다(전부 거부하는 퇴행 차단)");
  }

  // ---- (RV-4) 금지 방향: 스키마를 못 읽으면 「검사 생략」이 아니라 위반이다 ----
  //      판독 실패를 통과로 강등하면 **이 게이트를 없애는 가장 쉬운 방법이 스키마 파일을
  //      지우는 것**이 된다(절대 규칙 6). 모듈을 직접 불러 미지 계층으로 확인한다 —
  //      스키마 파일을 실제로 지우면 다른 절 전부가 함께 무너져 관측이 흐려진다.
  {
    const problems = checkRenderInput("no-such-layer", real ?? {});
    const ok = Array.isArray(problems) && problems.length >= 1 && problems[0].includes("계층 스키마");
    if (!ok) console.log(`    실제: ${JSON.stringify(problems)}`);
    report(ok, "(RV-4) 금지 방향: 계층 스키마를 읽지 못하면 위반으로 돌려준다(판독 실패를 검사 생략으로 강등 금지)");
  }

  // ---- (RV-6)~(RV-8) 인용 재검증 게이트 — 라운드 2 처방 8 ----
  //      **처방 8의 문면은 「영수증을 기록하고 렌더가 대조」였다.** 영수증 설계 셋을 전부
  //      위조 공격에 걸어 본 결과 셋 다 위조 비용을 올리지 못했다 — 영수증 값이 검사기
  //      실행의 함수가 아니라 **피검 산출물의 함수**라, 위조자가 알아야 할 값이 위조 대상
  //      파일 안에 이미 인쇄돼 있기 때문이다. 그래서 「대조」를 **「재계산」**으로 읽는다.
  //
  //      **닫는 격차는 실측된 것이다**: 추적되는 `run-machine-01`에 대해 verify-evidence는
  //      exit 1과 인용 위반을 냈는데 같은 `career.json`이 exit 0으로 111줄 사용자 문서가 됐다.

  // ---- (RV-6) 금지 방향: 검사기가 거부한 산출물은 렌더되지 않는다 ----
  {
    const CR = path.join(REPO_ROOT, "tests", "contamination", "runs", "run-machine-01", ".devcareer");
    let crEvidence = null;
    try { crEvidence = JSON.parse(fs.readFileSync(path.join(CR, "evidence.json"), "utf8")); } catch { /* 아래에서 전제 FAIL */ }
    const fx = crEvidence === null ? null : findFixtureRepoFor(crEvidence.sourceRepoHead);
    if (fx === null) {
      report(false, "(RV-6) 전제: 오염 코퍼스의 원장에 맞는 300커밋 픽스처를 찾지 못했다(--golden으로 캐시를 만든 뒤 다시 돌려라)");
    } else {
      const outPath = path.join(os.tmpdir(), "devcareer-rv6.md");
      try { fs.rmSync(outPath, { force: true }); } catch { /* 없으면 그만 */ }
      const r = spawnSync("node", [
        path.join(REPO_ROOT, "scripts", "render-markdown.mjs"), "--layer", "career",
        "--in", path.join(CR, "career.json"), "--root", CR, "--repo", fx, "--out", outPath,
      ], { cwd: REPO_ROOT, encoding: "utf8" });
      const out = (r.stdout ?? "") + (r.stderr ?? "");
      const wrote = fs.existsSync(outPath);
      const ok = r.status === 1 && !wrote && out.includes("[VERIFY]") && out.includes("재검증");
      if (!ok) console.log(`    실제: exit=${r.status} 파일생성=${wrote} 출력=${JSON.stringify(out.slice(0, 200))}`);
      report(ok, "(RV-6) 금지 방향: 인용 재검증이 FAIL인 산출물은 exit 1이고 마크다운이 생기지 않는다(검사기가 거부한 파일이 사용자 문서가 되던 격차)");
    }
  }

  // ---- (RV-7) 금지 방향: 루트 밖 --in으로 우회할 수 없다 ----
  //      깨끗한 루트를 검증해 놓고 루트 밖 다른 파일을 렌더하는 경로를 닫는다.
  //      이것이 없으면 (RV-6)은 `--root`만 정직한 것으로 바꿔 통과한다.
  {
    if (HONEST === null) {
      report(false, "(RV-7) 전제: 정직한 루트가 없어 관측할 수 없다");
    } else {
      const outside = path.join(os.tmpdir(), `devcareer-rv7-${crypto.randomBytes(6).toString("hex")}.json`);
      fs.copyFileSync(path.join(HONEST.root, "career.json"), outside);
      const r = spawnSync("node", [
        path.join(REPO_ROOT, "scripts", "render-markdown.mjs"), "--layer", "career",
        "--in", outside, "--root", HONEST.root, "--repo", HONEST.repo,
      ], { cwd: REPO_ROOT, encoding: "utf8" });
      const out = (r.stdout ?? "") + (r.stderr ?? "");
      const ok = r.status === 1 && out.includes("[VERIFY]") && out.includes("저장 루트");
      if (!ok) console.log(`    실제: exit=${r.status} 출력=${JSON.stringify(out.slice(0, 200))}`);
      report(ok, "(RV-7) 금지 방향: --in이 저장 루트의 그 계층 파일이 아니면 거부한다(깨끗한 루트로 위장하는 우회 차단)");
    }
  }

  // ---- (RV-8) 금지 방향: 인자 부재는 「검사 생략」이 아니다 ----
  //      `--root`·`--repo`를 선택으로 두면 그 부재가 곧 이 게이트를 끄는 플래그가 된다
  //      (절대 규칙 6). 처방 1이 우회 플래그를 두지 않은 것과 같은 규율이다.
  {
    if (HONEST === null) {
      report(false, "(RV-8) 전제: 정직한 루트가 없어 관측할 수 없다");
    } else {
      const inPath = path.join(HONEST.root, "career.json");
      const bare = spawnSync("node", [
        path.join(REPO_ROOT, "scripts", "render-markdown.mjs"), "--layer", "career", "--in", inPath,
      ], { cwd: REPO_ROOT, encoding: "utf8" });
      const noRepo = spawnSync("node", [
        path.join(REPO_ROOT, "scripts", "render-markdown.mjs"), "--layer", "career", "--in", inPath, "--root", HONEST.root,
      ], { cwd: REPO_ROOT, encoding: "utf8" });
      const ok = bare.status === 2 && noRepo.status === 2;
      if (!ok) console.log(`    실제: 둘다없음=${bare.status} repo없음=${noRepo.status}`);
      report(ok, "(RV-8) 금지 방향: --root·--repo 중 하나라도 없으면 exit 2다(부재를 검사 생략으로 강등 금지)");
    }
  }
}

function runRound2DeviceSmoke() {
  console.log("[라운드 2 승격 오라클] 절단 고지 부재 · 산출물 생산자 인증");

  // ---- (RT-1) 금지 방향: `truncated` 부재가 「절단 없음」이 되지 않는다 ----
  //      초판은 `reason === undefined`를 `"none"`과 같은 가지에 두어 **부재를 적극적
  //      주장으로 강등**했다. 사용자가 읽는 유일한 표면에서 절대 규칙 6이 깨져 있었다.
  {
    const absent = formatTruncation(undefined);
    const emptyObj = formatTruncation({});
    const ok =
      absent === UNKNOWN_TRUNCATION_NOTICE &&
      emptyObj === UNKNOWN_TRUNCATION_NOTICE &&
      absent !== NO_TRUNCATION_NOTICE &&
      !absent.includes(NO_TRUNCATION_NOTICE);
    if (!ok) console.log(`    실제: 부재=${JSON.stringify(absent)} 빈객체=${JSON.stringify(emptyObj)}`);
    report(ok, "(RT-1) 금지 방향: truncated 부재는 「절단 없음」이 아니라 「미기재」로 렌더된다(부재를 안심 문구로 강등 금지)");
  }

  // ---- (RT-2) 허용 방향: 실제 「없음」 선언과 실제 절단은 그대로 나온다 ----
  //      금지 방향만 두면 세 갈래를 전부 「미기재」로 뭉개도 아무것도 깨지지 않는다 —
  //      그러면 절단이 **있었던** 실행에서 고지가 사라진다.
  {
    const none = formatTruncation({ reason: "none", dropped_commits: 0 });
    const real = formatTruncation({ reason: "budget", dropped_commits: 7 });
    const ok =
      none === NO_TRUNCATION_NOTICE &&
      real.startsWith(TRUNCATION_NOTICE_PREFIX) &&
      real.includes("7") &&
      real !== UNKNOWN_TRUNCATION_NOTICE;
    if (!ok) console.log(`    실제: none=${JSON.stringify(none)} 절단=${JSON.stringify(real)}`);
    report(ok, "(RT-2) 허용 방향: reason이 none이면 「절단 없음」, 실제 절단이면 사유와 건수가 그대로 나온다(세 갈래가 뭉개지지 않는다)");
  }

  // ---- (AP-1) 전제: KNOWN_SKILLS가 `skills/` 디렉터리와 양방향으로 일치한다 ----
  //      상수는 사본이고 정본은 디렉터리다. 한쪽에만 있는 이름을 둘 다 잡는다 — 한 방향만
  //      보면 스킬을 새로 만들고 상수를 안 고쳐도(또는 그 반대여도) 조용히 지나간다.
  {
    let dirs = [];
    try {
      dirs = fs.readdirSync(path.join(REPO_ROOT, "skills"))
        .filter((n) => fs.existsSync(path.join(REPO_ROOT, "skills", n, "SKILL.md")))
        .sort();
    } catch { /* 아래에서 FAIL한다 */ }
    const consts = [...KNOWN_SKILLS].sort();
    const onlyConst = consts.filter((s) => !dirs.includes(s));
    const onlyDir = dirs.filter((s) => !consts.includes(s));
    const ok = dirs.length >= 2 && onlyConst.length === 0 && onlyDir.length === 0;
    if (!ok) console.log(`    실제: 디렉터리 ${JSON.stringify(dirs)} 상수 ${JSON.stringify(consts)} 상수만 ${JSON.stringify(onlyConst)} 디렉터리만 ${JSON.stringify(onlyDir)}`);
    report(ok, `(AP-1) KNOWN_SKILLS ${consts.length}건이 skills/ 디렉터리와 양방향으로 일치한다(상수는 사본, 정본은 디렉터리)`);
  }

  // ---- (AP-2) 금지 방향: 미지 생산자는 write-artifact가 거부한다 ----
  //      `state.schema.json`의 generatedBySkill은 minLength:1 자유 문자열이고 그 파일은
  //      슬라이스 A라 좁힐 수 없다 — 그래서 CLI에서 막는다. **CLI를 실제로 돌려 확인한다**
  //      (상수만 보면 「배선했는가」가 관측되지 않는다).
  {
    const r = spawnSync("node", [
      path.join(REPO_ROOT, "scripts", "write-artifact.mjs"),
      "--layer", "career", "--draft", "no-such.json",
      "--root", path.join(os.tmpdir(), ".devcareer"),
      "--stage", "draft", "--skill", "no-such-producer",
    ], { cwd: REPO_ROOT, encoding: "utf8" });
    const out = (r.stdout ?? "") + (r.stderr ?? "");
    const ok = r.status === 2 && out.includes("알 수 없는 산출물 생산자");
    if (!ok) console.log(`    실제: exit=${r.status} 출력=${JSON.stringify(out.slice(0, 200))}`);
    report(ok, "(AP-2) 금지 방향: 미지 생산자 이름은 write-artifact가 exit 2로 거부한다(지어낸 이름이 레지스트리에 박히지 않는다)");
  }

  // ---- (AP-3) 허용 방향: 실재 생산자는 이 검사에서 걸리지 않는다 ----
  //      금지 방향만 두면 집합을 비워도(전부 거부해도) 통과한다 — 그러면 스킬이 산출물을
  //      쓸 수 없게 되는데 아무 단언이 울지 않는다. 회차 산출물이 실제로 쓰는 이름까지
  //      포함해 확인한다.
  {
    const used = new Set();
    const runsDir = path.join(REPO_ROOT, "tests", "contamination", "runs");
    const collect = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) collect(full);
        else if (e.name === "state.json") {
          try {
            const s = JSON.parse(fs.readFileSync(full, "utf8"));
            for (const a of Object.values(s?.artifacts ?? {})) if (a?.generatedBySkill) used.add(a.generatedBySkill);
          } catch { /* (CX-1)이 잡는다 */ }
        }
      }
    };
    collect(runsDir);
    const unlisted = [...used].filter((s) => !KNOWN_ARTIFACT_PRODUCERS.includes(s));
    const producersCovered = KNOWN_ARTIFACT_PRODUCERS.length === KNOWN_SKILLS.length + NON_SKILL_PRODUCERS.length;
    const notRejected = KNOWN_ARTIFACT_PRODUCERS.every((s) => {
      const r = spawnSync("node", [
        path.join(REPO_ROOT, "scripts", "write-artifact.mjs"),
        "--layer", "career", "--draft", "no-such.json",
        "--root", path.join(os.tmpdir(), ".devcareer"),
        "--stage", "draft", "--skill", s,
      ], { cwd: REPO_ROOT, encoding: "utf8" });
      // 이 인자로는 draft 부재로 죽지만, **생산자 검사에서는 걸리지 않아야** 한다.
      return !((r.stdout ?? "") + (r.stderr ?? "")).includes("알 수 없는 산출물 생산자");
    });
    const ok = used.size >= 1 && unlisted.length === 0 && producersCovered && notRejected;
    if (!ok) console.log(`    실제: 회차가 쓴 생산자 ${JSON.stringify([...used])} 미등재 ${JSON.stringify(unlisted)} 합집합=${producersCovered} 통과=${notRejected}`);
    report(ok, `(AP-3) 허용 방향: 허용 집합 ${KNOWN_ARTIFACT_PRODUCERS.length}건이 전부 이 검사를 통과하고 회차가 실제로 쓴 이름도 등재돼 있다(집합을 비워 전부 막는 퇴행 차단)`);
  }
}

function runContaminationGraderSmoke() {
  console.log("[오염 채점 엔진 오라클] 기계 3종 30건과 채점 로직(구현 9단계·AC-8)");

  const casesRoot = path.join(REPO_ROOT, "tests", "contamination", "cases");
  const kindDirs = [CASE_KINDS.FAKE_HASH, CASE_KINDS.OTHER_AUTHOR, CASE_KINDS.SECRET_BYPASS];

  // 케이스를 한 번만 판독한다. 판독 실패는 빈 배열로 강등하지 않고 목록에 남긴다 —
  // 그 강등이 (DH-1d)가 기록한 거짓 초록의 원인이었다.
  const byKind = new Map();
  const readFailures = [];
  for (const kind of kindDirs) {
    const dir = path.join(casesRoot, kind);
    let names = [];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".json")).sort();
    } catch (e) {
      readFailures.push(`${kind}/ 판독 실패(${e.code ?? e.message})`);
    }
    const defs = [];
    for (const n of names) {
      const { text, error } = readRepoTextSafe(path.join("tests", "contamination", "cases", kind, n));
      if (error !== null) { readFailures.push(error); continue; }
      try { defs.push(JSON.parse(text)); }
      catch (e) { readFailures.push(`${kind}/${n} 파싱 실패(${e.message})`); }
    }
    byKind.set(kind, defs);
  }
  const allCases = kindDirs.flatMap((k) => byKind.get(k) ?? []);

  // ---- (CT-1) 전제: 고정 분모 40건 중 기계 3종 30건이 실재한다 ----
  //      아래 금지 방향은 케이스가 0건이면 전부 공허하게 통과한다.
  {
    const counts = kindDirs.map((k) => (byKind.get(k) ?? []).length);
    const ids = allCases.map((c) => c?.caseId);
    const unique = new Set(ids).size === ids.length;
    const ok = readFailures.length === 0 && counts.every((n) => n === 10) && allCases.length === 30 && unique;
    if (!ok) console.log(`    실제: 종별 ${JSON.stringify(counts)} 총 ${allCases.length}건 유일=${unique} 판독실패 ${JSON.stringify(readFailures)}`);
    report(ok, "(CT-1) 기계 3종 케이스가 종당 10건·총 30건이고 caseId가 유일하며 전부 판독됐다(고정 분모의 전제)");
  }

  // ---- (CT-2) 전제: 케이스 형태가 적합하고 축이 서로 다르다 ----
  //      「리터럴 10개는 같은 케이스의 10배다」를 형태로 막는다 — axis가 겹치면
  //      그 종은 10건을 채웠을 뿐 10가지를 관측하지 않는다.
  {
    const problems = allCases.flatMap((c, i) => checkCaseShape(c, c?.caseId ?? `#${i}`));
    const dupAxis = kindDirs.filter((k) => {
      const axes = (byKind.get(k) ?? []).map((c) => c?.axis);
      return new Set(axes).size !== axes.length;
    });
    const ok = problems.length === 0 && dupAxis.length === 0;
    if (!ok) console.log(`    실제: 형태 위반 ${JSON.stringify(problems)} 축 중복 종 ${JSON.stringify(dupAxis)}`);
    report(ok, "(CT-2) 전 케이스가 형태 검사를 통과하고 종 안에서 axis가 서로 다르다(같은 케이스의 10배 차단)");
  }

  // ---- (CT-3) 금지 방향: 채점 엔진이 REJECT 코드를 소유하지 않는다 ----
  //      자기가 심은 문자열을 자기가 찾는 구조를 **소스 스캔으로** 막는다. 기대 코드의
  //      주인은 케이스 파일이고 실제 코드의 주인은 프로덕션 CLI다.
  {
    const { text: graderSrc, error } = readRepoTextSafe(path.join("tests", "contamination", "grade.mjs"));
    const owned = graderSrc === null ? [] : [...new Set(allCases.map((c) => c?.expect?.code).filter(Boolean))].filter((code) => graderSrc.includes(code));
    const ok = error === null && owned.length === 0;
    if (!ok) console.log(`    실제: ${error ?? ""} 엔진이 소유한 코드 ${JSON.stringify(owned)}`);
    report(ok, "(CT-3) 금지 방향: 채점 엔진 소스에 케이스가 이름 댄 REJECT 코드가 0건이다(자기충족 게이트 차단)");
  }

  // ---- (CT-4) 허용 방향: 케이스가 이름 댄 코드는 프로덕션에 실재한다 ----
  //      금지 방향((CT-3))만 두면 케이스가 오타 코드를 적어도 아무도 모른다 — 그러면
  //      그 케이스는 영구 MISSED가 되고 「종당 100%」가 구조적으로 달성 불가해진다.
  {
    const sources = ["scripts/verify-evidence.mjs", "scripts/validate-plugin.mjs"]
      .map((rel) => readRepoTextSafe(rel));
    const joined = sources.every((s) => s.error === null) ? sources.map((s) => s.text).join("\n") : null;
    const wanted = [...new Set(allCases.map((c) => c?.expect?.code).filter(Boolean))];
    const missing = joined === null ? wanted : wanted.filter((code) => !joined.includes(`"${code}"`));
    const ok = joined !== null && wanted.length >= 3 && missing.length === 0;
    if (!ok) console.log(`    실제: 프로덕션에 없는 기대 코드 ${JSON.stringify(missing)} (요구 ${wanted.length}종)`);
    report(ok, `(CT-4) 허용 방향: 케이스가 이름 댄 기대 코드 ${wanted.length}종이 전부 프로덕션 소스에 실재한다(오타 케이스 차단)`);
  }

  // ---- (CT-5)~(CT-8) 인용 축 채점의 네 갈래 ----
  //      합성 입력이다. 각 갈래를 **따로** 단언하는 이유는 「어느 경로로 틀렸는가」를
  //      고정하기 위해서다 — 한 단언에 묶으면 강등 변이와 뭉개짐 변이가 구별되지 않는다.
  const sampleCase = { caseId: "X-1", expect: { code: "SOME_CODE" } };
  {
    const r = gradeCitationCase(sampleCase, "commit:abc", [{ ledgerId: "commit:abc", code: "SOME_CODE" }]);
    const ok = r.outcome === OUTCOME.DETECTED;
    if (!ok) console.log(`    실제: ${JSON.stringify(r)}`);
    report(ok, "(CT-5) 허용 방향: 기대 코드와 일치하는 위반은 DETECTED다");
  }
  {
    const r = gradeCitationCase(sampleCase, "commit:abc", []);
    const ok = r.outcome === OUTCOME.MISSED;
    if (!ok) console.log(`    실제: ${JSON.stringify(r)}`);
    report(ok, "(CT-6) 금지 방향: 위반이 0건이면 MISSED다(검사기가 놓친 것을 초록으로 강등하지 않는다)");
  }
  {
    const r = gradeCitationCase(sampleCase, "commit:abc", [{ ledgerId: "commit:abc", code: "OTHER_CODE" }]);
    const ok = r.outcome === OUTCOME.MISSED;
    if (!ok) console.log(`    실제: ${JSON.stringify(r)}`);
    report(ok, "(CT-7) 금지 방향: 다른 코드로 떨어지면 MISSED다(아무 REJECT나 탐지로 세지 않는다)");
  }
  {
    const noReport = gradeCitationCase(sampleCase, "commit:abc", null);
    const noTarget = gradeCitationCase(sampleCase, null, []);
    const ok = noReport.outcome === OUTCOME.INVALID && noTarget.outcome === OUTCOME.INVALID;
    if (!ok) console.log(`    실제: 리포트부재=${noReport.outcome} 대상미해소=${noTarget.outcome}`);
    report(ok, "(CT-8) 금지 방향: 리포트 부재·대상 미해소는 INVALID다(미제출은 0%가 아니다 — 절대 규칙 6)");
  }

  // ---- (CT-9) 금지 방향: 분모는 케이스 개수 고정 ----
  //      「분모를 채점된 건수로 바꾸기」가 이 게이트를 무력화하는 가장 싼 방법이다 —
  //      산출물을 하나도 안 낸 회차가 100%를 받는다.
  {
    const defs = [{ caseId: "A" }, { caseId: "B" }, { caseId: "C" }];
    const partial = tally(defs, [{ caseId: "A", outcome: OUTCOME.DETECTED }]);
    const empty = tally(defs, []);
    const ok =
      partial.denominator === 3 && partial.detected === 1 && partial.invalid === 2 && Math.abs(partial.ratio - 1 / 3) < 1e-9 &&
      empty.denominator === 3 && empty.ratio === 0;
    if (!ok) console.log(`    실제: 일부채점 ${JSON.stringify(partial)} 전무 ${JSON.stringify(empty)}`);
    report(ok, "(CT-9) 금지 방향: 분모는 케이스 파일 개수로 고정된다(채점된 건수로 바뀌면 미제출 회차가 100%를 받는다)");
  }

  // ---- (CT-10) 허용 방향: 재생성 해소는 탐지로 센다 ----
  //      「노드가 없다」를 미탐지로 읽으면 반증이 가장 잘 작동한 회차가 가장 낮은
  //      점수를 받는다.
  {
    const regen = { ...sampleCase, observed: { regenerated: true } };
    const r = gradeCitationCase(regen, "commit:abc", []);
    const t = tally([regen], [r]);
    const ok = r.outcome === OUTCOME.RESOLVED_BY_REGENERATION && t.detected === 1;
    if (!ok) console.log(`    실제: ${JSON.stringify(r)} / ${JSON.stringify(t)}`);
    report(ok, "(CT-10) 허용 방향: RESOLVED_BY_REGENERATION은 탐지로 센다(반증 성공의 정상적 귀결)");
  }

  // ---- (CT-11) 금지 방향: 봇/타 저자 갈래가 뭉개지지 않는다 ----
  //      두 갈래가 같은 코드로 떨어지므로 코드 단독 채점은 「봇을 잡았다」와
  //      「타 저자를 잡았다」를 같은 점수로 만든다. AC-9가 이 10건을 자기 관측자로
  //      지목했으므로 그 뭉개짐은 AC-9의 절반을 잃는 것과 같다.
  {
    const def = { caseId: "OA-x", expect: { code: "SOME_CODE", exclusionReason: "bot-pattern" } };
    const ev = { commits: [{ id: "commit:abc", exclusionReason: "author-not-selected" }] };
    const evOk = { commits: [{ id: "commit:abc", exclusionReason: "bot-pattern" }] };
    const v = [{ ledgerId: "commit:abc", code: "SOME_CODE" }];
    const wrong = gradeCitationCase(def, "commit:abc", v, ev);
    const right = gradeCitationCase(def, "commit:abc", v, evOk);
    const ok = wrong.outcome === OUTCOME.MISSED && right.outcome === OUTCOME.DETECTED;
    if (!ok) console.log(`    실제: 갈래불일치=${wrong.outcome} 갈래일치=${right.outcome}`);
    report(ok, "(CT-11) 금지 방향: 코드가 맞아도 exclusionReason 갈래가 다르면 MISSED다(봇/타 저자 뭉개짐 차단)");
  }

  // ---- (CT-12) 셀렉터가 원장에서 대상을 실제로 찾고, 못 찾으면 사유를 남긴다 ----
  //      해시를 하드코딩하지 않는 설계의 비공허성이다. 못 찾은 것을 null로 강등하면
  //      호출부가 「인용할 커밋이 없다」로 읽고 조용히 건너뛴다.
  {
    const ev = { commits: [{ id: "c0", exclusionReason: "bot-pattern" }, { id: "c1", exclusionReason: "bot-pattern" }] };
    const hit = resolveSelector({ exclusionReason: "bot-pattern", ordinal: 1 }, ev);
    const miss = resolveSelector({ exclusionReason: "no-such-reason" }, ev);
    const over = resolveSelector({ exclusionReason: "bot-pattern", ordinal: 9 }, ev);
    const ok = hit.ledgerId === "c1" && hit.reason === null &&
      miss.ledgerId === null && typeof miss.reason === "string" && miss.reason !== "" &&
      over.ledgerId === null && over.matched === 2;
    if (!ok) console.log(`    실제: ${JSON.stringify({ hit, miss, over })}`);
    report(ok, "(CT-12) 셀렉터가 원장에서 대상을 고르고, 못 찾으면 null이 아니라 사유를 돌려준다(판독 실패를 빈 값으로 강등 금지)");
  }

  // ---- (CT-13) 게이트: 기계 3종의 수용선은 100%다 ----
  {
    const perfect = evaluateGate({ kind: CASE_KINDS.FAKE_HASH, ratios: [1, 1, 1] });
    const oneShort = evaluateGate({ kind: CASE_KINDS.FAKE_HASH, ratios: [1, 0.9, 1] });
    const llmOk = evaluateGate({ kind: CASE_KINDS.UNSUPPORTED_CLAIM, ratios: [0.9, 0.8, 0.85] });
    const noRuns = evaluateGate({ kind: CASE_KINDS.FAKE_HASH, ratios: [] });
    const ok = perfect.pass === true && oneShort.pass === false && llmOk.pass === true && noRuns.pass === false &&
      MACHINE_KINDS.length === 3 && !MACHINE_KINDS.includes(CASE_KINDS.UNSUPPORTED_CLAIM);
    if (!ok) console.log(`    실제: ${JSON.stringify({ perfect, oneShort, llmOk, noRuns })}`);
    report(ok, "(CT-13) 게이트: 기계 3종은 3회 모두 100%, LLM 1종은 최저값 80% 이상, 회차 0건은 판정 불가다");
  }

  // ---- (CT-14) 게이트: 편차 20%p 초과는 경고이고, 증설 후에도 초과면 FAIL 확정 ----
  //      「증설을 근거로 재실행 최고값을 채택하는 경로」를 구조로 막는다 — 판정 입력이
  //      회차 배열이고 최저값·편차로만 이뤄지므로 최고값을 채택할 자리가 없다.
  {
    const first = evaluateGate({ kind: CASE_KINDS.UNSUPPORTED_CLAIM, ratios: [1, 0.7, 0.95] });
    const after = evaluateGate({ kind: CASE_KINDS.UNSUPPORTED_CLAIM, ratios: [1, 0.7, 0.95], expanded: true });
    const ok = first.pass === false && typeof first.warning === "string" && first.warning !== "" &&
      after.pass === false && after.warning === null && Math.abs(first.spread - 0.3) < 1e-9;
    if (!ok) console.log(`    실제: 초회 ${JSON.stringify(first)} 증설후 ${JSON.stringify(after)}`);
    report(ok, "(CT-14) 게이트: 편차 20%p 초과는 1회 증설 경고이고 증설 후에도 초과면 FAIL 확정이다(최고값 채택 경로 없음)");
  }
}

function runWriteArtifactOracleSmoke() {
  console.log("[쓰기 경계 오라클] 구현 7단계 (a)·AC-16·AC-22: 자기 검증·편집 감지·레지스트리");

  const WRITER = path.join(REPO_ROOT, "scripts", "write-artifact.mjs");
  const FIXED_AT = "2026-08-19T12:00:00Z";
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-writer-"));

  // 쓰기를 못 하게 만드는 변이에서는 후속 단언이 읽을 파일이 아예 없다.
  // 그때 예외를 던지면 **섹션 전체가 중단되어 어떤 단언이 대응하는지 읽을 수
  // 없다** — 변이 M5·M13에서 실측했다. 부재를 각 단언의 FAIL로 떨어뜨린다.
  const readJsonOrNull = (p) => (fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf8")) : null);
  const readTextOrNull = (p) => (fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null);

  // `layer`는 **뒤에 default 인자로 붙였다** — 기존 호출부 전부가 career를 쓰므로
  // 시그니처를 앞에서 바꾸면 이 절의 단언 수십 건이 한꺼번에 흔들린다(라운드 2 처방 7).
  const runWriter = (root, draftObj, extra = [], stage = "fact-checked", layer = "career") => {
    const draftPath = path.join(tmp, `draft-${crypto.randomBytes(6).toString("hex")}.json`);
    fs.writeFileSync(draftPath, JSON.stringify(draftObj), "utf8");
    return spawnSync(
      process.execPath,
      [WRITER, "--layer", layer, "--draft", draftPath, "--root", root, "--stage", stage,
       "--skill", layer === "career" ? "career-from-git" : "skill-gap", "--generated-at", FIXED_AT, ...extra],
      { encoding: "utf8" }
    );
  };
  // **저장 경계를 우회하지 않고 만족시킨다(콜드 리뷰 Security #11).**
  // 리뷰는 환경변수나 `--allow-root` 같은 테스트용 우회 수단을 함께 설계하라고
  // 제안했지만, 그 우회는 오케스트레이션이 조립할 수 있는 값이므로 이 프로젝트가
  // 계속 닫아 온 자기면제 통로와 같은 형태가 된다. 임시 루트가 진짜 불변식을
  // 만족하게 하면(`…/<tag>/.devcareer`) 우회 자체가 필요 없다.
  const freshRoot = (tag) => {
    const r = path.join(tmp, tag, STATE_DIR_NAME);
    fs.mkdirSync(r, { recursive: true });
    return r;
  };

  try {
    // ---- (WA-1) 정상 경로 ----
    const root1 = freshRoot("ok");
    const base = makeCareerInstance([makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } })]);
    {
      const r = runWriter(root1, base);
      const filePath = path.join(root1, "career.json");
      const written = readJsonOrNull(filePath);
      const ok = r.status === 0 && written !== null;
      if (!ok) console.log(`    실제: status=${r.status} stderr=${r.stderr}`);
      report(ok, "(WA-1) 정상 출력은 exit 0으로 career.json이 저장 루트에 기록된다");

      // 이 자리에는 이미 「부재를 사유 배열로」 관례가 있다(`written === null` 갈래). 스키마 판독
      // 실패를 **그 앞에** 합류시킨다 — 두 사유가 서로 다른 원인이므로 문자열로 구별된다.
      const { json: schema, error: schemaError } = readRepoJsonSafe(SCHEMA_REL("career"));
      if (schemaError !== null) console.log(`    실제: ${schemaError}`);
      const errs = schemaError !== null
        ? [schemaError]
        : written === null ? ["(파일이 기록되지 않았다)"] : validateInstance(schema, written);
      if (errs.length > 0) console.log(`    실제: ${JSON.stringify(errs)}`);
      report(errs.length === 0, "(WA-2) 기록된 산출물이 career.schema.json을 통과한다");

      const ok3 = written !== null && written.contentHash === computeArtifactContentHash("career", written) && written.generatedAt === FIXED_AT;
      if (!ok3 && written !== null) console.log(`    실제: 기록 ${written.contentHash} 재계산 ${computeArtifactContentHash("career", written)}`);
      report(ok3, "(WA-3) 기록된 contentHash가 본문 재계산값과 일치하고 generatedAt이 쓰기 시점 값이다(AC-16)");

      // ---- 레지스트리(AC-22) ----
      // 레지스트리 갱신이 실패하면(exit 4) state.json이 아예 없다 — 여기서도
      // 부재를 예외가 아니라 FAIL로 떨어뜨린다.
      const state = readJsonOrNull(path.join(root1, "state.json"));
      const entry = state?.artifacts?.career ?? null;
      const ok4 = entry !== null && written !== null && entry.path === "career.json" &&
        entry.schemaVersion === written.schemaVersion && entry.generatedBySkill === "career-from-git";
      if (!ok4) console.log(`    실제: ${JSON.stringify(entry)}`);
      report(ok4, "(WA-4) state.json 레지스트리에 경로·schemaVersion·생성 스킬이 기재된다(AC-22 쓰기 주체)");

      const ok5 = entry !== null && !("sourceRepoHead" in entry) && !("contentHash" in entry);
      report(ok5, "(WA-5) 레지스트리에 sourceRepoHead·contentHash를 두지 않는다(진실 원천은 산출물 파일 하나 — AC-22)");

      const ok6 = typeof entry?.path === "string" && !path.isAbsolute(entry.path) && !entry.path.includes("\\");
      if (!ok6) console.log(`    실제 path=${entry?.path}`);
      report(ok6, "(WA-6) 레지스트리 경로가 저장 루트 기준 상대 POSIX 경로다(AC-15 — 로컬 절대경로·백슬래시 유입 방어)");
    }

    // ---- (WA-7) (a) 본체: 스키마 위반이면 쓰지 않는다 ----
    {
      const root = freshRoot("schema-violation");
      const bad = makeCareerInstance([makeFactCheckedNode({ id: "car:001", evidence: [], basis: "inference", verification: { status: "verified", attempts: 1, reasonCode: null } })]);
      const r = runWriter(root, bad);
      const ok = r.status === 1 && !fs.existsSync(path.join(root, "career.json")) && r.stderr.includes("[SCHEMA]");
      if (!ok) console.log(`    실제: status=${r.status} exists=${fs.existsSync(path.join(root, "career.json"))} stderr=${r.stderr}`);
      report(ok, "(WA-7) 스키마 위반 출력은 exit 1이고 **파일이 생기지 않는다**(구현 7단계 (a) — 쓰기 직전 자기 검증)");
    }

    // ---- (WA-8) (g) 기입 주체 위반이면 쓰지 않는다 ----
    {
      const root = freshRoot("authorship-violation");
      const draftPath = path.join(tmp, "draft-stage.json");
      fs.writeFileSync(draftPath, JSON.stringify(makeCareerInstance([makeFactCheckedNode({ verification: { status: "verified", attempts: 1, reasonCode: null } })])), "utf8");
      const r = spawnSync(process.execPath, [WRITER, "--layer", "career", "--draft", draftPath, "--root", root, "--stage", "draft", "--skill", "career-from-git", "--generated-at", FIXED_AT], { encoding: "utf8" });
      const ok = r.status === 1 && !fs.existsSync(path.join(root, "career.json")) && r.stderr.includes("VERIFICATION_SET_BY_TEMPLATE");
      if (!ok) console.log(`    실제: status=${r.status} stderr=${r.stderr}`);
      report(ok, "(WA-8) draft 단계가 verification을 기입하면 exit 1이고 파일이 생기지 않는다(구현 7단계 (g))");
    }

    // ---- (WA-9~11) 사용자 편집 감지 → 보류 → 강행 + .bak (AC-16) ----
    {
      const root = freshRoot("edit-detect");
      runWriter(root, makeCareerInstance([
        makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } }),
        makeFactCheckedNode({ id: "car:002", text: "두 번째 서술.", verification: { status: "verified", attempts: 1, reasonCode: null } }),
      ]));
      const filePath = path.join(root, "career.json");
      const seeded = readJsonOrNull(filePath);

      if (seeded === null) {
        const why = "사전 조건 실패 — 최초 쓰기가 기록되지 않아 편집 감지를 관측할 수 없다";
        report(false, `(WA-9) ${why}`);
        report(false, `(WA-10) ${why}`);
        report(false, `(WA-11) ${why}`);
      } else {
        // 사용자가 손으로 편집: car:002를 고치고 locked로 잠근다(해시는 갱신하지 않는다).
        seeded.nodes[1].text = "사용자가 직접 고쳐 쓴 문장.";
        seeded.nodes[1].locked = true;
        fs.writeFileSync(filePath, JSON.stringify(seeded, null, 2), "utf8");
        const editedRaw = fs.readFileSync(filePath, "utf8");

        // 재생성: car:002가 빠진 출력.
        const v2 = makeCareerInstance([makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } })]);

        const held = runWriter(root, v2);
        const ok = held.status === 3 && held.stderr.includes("PREV_ARTIFACT_EDITED") && readTextOrNull(filePath) === editedRaw;
        if (!ok) console.log(`    실제: status=${held.status} stderr=${held.stderr}`);
        report(ok, "(WA-9) 사용자 편집(contentHash 불일치)이 감지되면 exit 3으로 보류하고 기존 파일을 건드리지 않는다(AC-16 확인 게이트)");

        const forced = runWriter(root, v2, ["--force"]);
        const bakPath = `${filePath}.bak`;
        const ok2 = forced.status === 0 && readTextOrNull(bakPath) === editedRaw && !fs.existsSync(`${bakPath}.bak`);
        if (!ok2) console.log(`    실제: status=${forced.status} bak=${fs.existsSync(bakPath)} stderr=${forced.stderr}`);
        report(ok2, "(WA-10) --force 강행은 덮어쓰기 직전 .bak 1세대를 남긴다(2세대는 두지 않는다 — AC-16)");

        const after = readJsonOrNull(filePath);
        const survivor = after?.nodes?.find((n) => n.id === "car:002");
        const ok3 = survivor !== undefined && survivor.text === "사용자가 직접 고쳐 쓴 문장." && survivor.locked === true;
        if (!ok3) console.log(`    실제: ${JSON.stringify(after?.nodes?.map((n) => n.id))}`);
        report(ok3, "(WA-11) 강행 후에도 locked 노드는 draft에서 빠졌음에도 사용자 편집 원문 그대로 보존된다(AC-16 엔드투엔드)");
      }
    }

    // ---- (WA-12) 병합 계약 위반이면 쓰지 않는다 ----
    {
      const root = freshRoot("churn");
      runWriter(root, makeCareerInstance([makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } })]));
      const filePath = path.join(root, "career.json");
      const before = readTextOrNull(filePath);
      const churned = makeCareerInstance([makeFactCheckedNode({ id: "car:999", verification: { status: "verified", attempts: 1, reasonCode: null } })]);
      const r = runWriter(root, churned);
      const ok = before !== null && r.status === 1 && r.stderr.includes("NODE_ID_CHURN") && readTextOrNull(filePath) === before;
      if (!ok) console.log(`    실제: status=${r.status} stderr=${r.stderr}`);
      report(ok, "(WA-12) 병합 계약 위반(NODE_ID_CHURN)은 exit 1이고 기존 파일을 덮어쓰지 않는다");
    }

    // ---- (WA-13) 입력 오류는 exit 2 ----
    {
      const root = freshRoot("input-error");
      const r = spawnSync(process.execPath, [WRITER, "--layer", "career", "--draft", path.join(tmp, "nope.json"), "--root", root, "--stage", "draft", "--skill", "x"], { encoding: "utf8" });
      const ok = r.status === 2 && r.stderr.includes("[INPUT_ERROR]");
      report(ok, "(WA-13) 입력 파일 부재는 [INPUT_ERROR] + exit 2다(계약 위반 exit 1과 구별된다)");
    }

    // ---- (WA-14) 쓰기 경계와 렌더 계약이 실제로 접합되는가 ----
    //      이 단언이 없으면 "쓰기는 되지만 사용자 표면에는 아무것도 안 나오는"
    //      상태를 아무도 보지 못한다. 렌더 계약(E-1)은 픽스처 위에서만 돌고
    //      있었고, 여기가 처음으로 **writer가 실제로 쓴 파일**을 렌더한다.
    {
      const root = freshRoot("render-join");
      runWriter(root, makeCareerInstance([
        makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } }),
        makeFactCheckedNode({ id: "car:002", text: "반증당한 서술.", verification: { status: "refuted", attempts: 2, reasonCode: "NO_SUPPORTING_DIFF" } }),
      ]));
      const written = readJsonOrNull(path.join(root, "career.json"));
      const md = written === null ? "" : renderLayer("career", written);
      const missing = written === null
        ? ["(파일이 기록되지 않았다)"]
        : RENDER_REQUIRED_ELEMENTS.filter((el) => !el.probe(md, written)).map((el) => el.id);
      const ok = missing.length === 0 && md.includes(EVIDENCE_BADGE);
      if (!ok) console.log(`    실제: 빠진 요소=${JSON.stringify(missing)}`);
      report(ok, "(WA-14) writer가 실제로 기록한 career.json이 렌더 계약 요소를 전부 만족한다(쓰기↔렌더 접합)");
    }

    // ---- (WA-15) exit 4: 산출물은 기록됐으나 레지스트리 갱신 실패 ----
    //      **콜드 리뷰 M-2.** 파일 헤더가 스스로 "'쓰지 않았다' 불변식을 깨는
    //      유일한 코드"라고 못 박은 분기인데 스위트 전체에 `status === 4`
    //      단언이 0건이었다(grep 실측). 함께 미검증이던 것이 updateRegistry의
    //      손상 레지스트리 거부라, 그 거부가 회귀해 손상 state.json을 새
    //      골격으로 덮어써도 전부 초록이었다.
    {
      const root = freshRoot("registry-broken");
      fs.writeFileSync(path.join(root, "state.json"), "{broken", "utf8");
      const r = runWriter(root, makeCareerInstance([makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } })]));
      const stateRaw = readTextOrNull(path.join(root, "state.json"));
      const ok = r.status === 4 && r.stderr.includes("[REGISTRY]") &&
        fs.existsSync(path.join(root, "career.json")) && stateRaw === "{broken";
      if (!ok) console.log(`    실제: status=${r.status} state=${JSON.stringify(stateRaw)} stderr=${r.stderr}`);
      report(ok, "(WA-15) 손상된 state.json에서 exit 4 — 산출물은 기록되고 레지스트리 원문은 덮어써지지 않는다(콜드 리뷰 M-2)");
    }

    // ---- (WA-16) nodes 없는 draft가 조용히 통과하지 않는가 ----
    //      **콜드 리뷰 M-3.** 초판 실측: exit 0으로 성공하면서 비잠금 노드
    //      car:001이 경고도 .bak도 없이 사라졌다(v1 [car:001, car:002] →
    //      결과 [car:002]).
    {
      const root = freshRoot("nodes-missing");
      runWriter(root, makeCareerInstance([
        makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } }),
        makeFactCheckedNode({ id: "car:002", text: "잠긴 서술.", verification: { status: "verified", attempts: 1, reasonCode: null } }),
      ]));
      const filePath = path.join(root, "career.json");
      // **잠금은 writer로 심을 수 없다(게이트 B-7).** 생성 출력이 locked를 담는
      // 순간 LOCKED_SET_BY_TEMPLATE로 거부되므로, 사용자 편집을 흉내 내 파일을
      // 직접 고친다 — 그것이 이 계약이 남긴 유일한 잠금 경로다. (여기서
      // contentHash는 어긋난 채로 두지만 기입 주체 검사가 편집 감지보다 **앞**에
      // 돌기 때문에 이 단언이 겨냥한 exit 1 NODES_NOT_ARRAY가 먼저 나온다.)
      {
        const seeded = readJsonOrNull(filePath);
        if (seeded !== null) {
          seeded.nodes[1].locked = true;
          fs.writeFileSync(filePath, JSON.stringify(seeded, null, 2), "utf8");
        }
      }
      const before = readTextOrNull(filePath);
      const bad = makeCareerInstance([]);
      delete bad.nodes;
      const r = runWriter(root, bad);
      const ok = before !== null && r.status === 1 && r.stderr.includes("NODES_NOT_ARRAY") && readTextOrNull(filePath) === before;
      if (!ok) console.log(`    실제: status=${r.status} 변경됨=${readTextOrNull(filePath) !== before} stderr=${r.stderr}`);
      report(ok, "(WA-16) nodes 필드가 없는 draft는 exit 1이고 기존 산출물이 그대로 남는다(조용한 노드 삭제 차단 — 콜드 리뷰 M-3)");
    }

    // ---- (WA-17) draft 단계 재작성이 실제로 성공하는가 ----
    //      **콜드 리뷰 M-1의 엔드투엔드.** 이전 계약에서는 prev에 attempts>=1인
    //      비잠금 노드가 있으면 draft 재작성이 네 갈래 모두 exit 1이었다.
    //      이제 draft는 verification을 담지 않고 병합이 이전 판정을 옮긴다.
    {
      const root = freshRoot("draft-rewrite");
      runWriter(root, makeCareerInstance([makeFactCheckedNode({ id: "car:001", verification: { status: "refuted", attempts: 2, reasonCode: "NO_SUPPORTING_DIFF" } })]));
      const draft = makeCareerInstance([makeDraftNode({ id: "car:001", text: "표현을 다듬은 같은 사실." })]);
      const r = runWriter(root, draft, [], "draft");
      const after = readJsonOrNull(path.join(root, "career.json"));
      const v = after?.nodes?.[0]?.verification;
      const ok = r.status === 0 && after?.nodes?.[0]?.text === "표현을 다듬은 같은 사실." &&
        v?.status === "refuted" && v.attempts === 2 && v.reasonCode === "NO_SUPPORTING_DIFF";
      if (!ok) console.log(`    실제: status=${r.status} verification=${JSON.stringify(v)} stderr=${r.stderr}`);
      report(ok, "(WA-17) attempts=2인 노드를 --stage draft로 재작성하면 exit 0이고 이전 판정이 보존된다(콜드 리뷰 M-1)");
    }

    // ---- (WA-33) CLI 배선: 반증 노드 삭제가 실제로 거부되고 파일이 그대로 남는가 ----
    //      **함수 단위 (AC-49)만 두면 배선이 빠져도 초록이다.** 그리고 「거부했다」와
    //      「거부했지만 파일은 고쳐 놨다」는 다르다 — 후자면 사용자가 그 문서를 읽는다.
    //      그래서 종료 코드와 **바이트 동일**을 함께 본다.
    {
      const root = freshRoot("refuted-drop");
      runWriter(root, makeCareerInstance([
        makeFactCheckedNode({ id: "car:001", verification: { status: "refuted", attempts: 2, reasonCode: "NO_SUPPORTING_DIFF" } }),
        makeFactCheckedNode({ id: "car:002", text: "다른 사실.", verification: { status: "verified", attempts: 1, reasonCode: null } }),
      ]));
      const filePath = path.join(root, "career.json");
      const before = readTextOrNull(filePath);
      const draft = makeCareerInstance([makeFactCheckedNode({ id: "car:002", text: "다른 사실.", verification: { status: "verified", attempts: 1, reasonCode: null } })]);
      const r = runWriter(root, draft);
      const ok = before !== null && r.status === 1 && r.stderr.includes("REFUTED_NODE_DROPPED") && readTextOrNull(filePath) === before;
      if (!ok) console.log(`    실제: status=${r.status} 변경됨=${readTextOrNull(filePath) !== before} stderr=${r.stderr}`);
      report(ok, "(WA-33) 반증 노드를 뺀 draft는 exit 1이고 기존 산출물이 바이트 동일하게 남는다(라운드 2 처방 3 배선)");
    }


    // ---- (WA-18) 템플릿의 자기 잠금이 쓰기 경계에서 막히는가(게이트 B-7) ----
    //      계약 함수 단위 관측(AC-34~AC-41)만 두면 CLI가 그 함수를 실제로
    //      부르는지는 아무도 묻지 않는다. 여기서 프로세스를 띄워 확인한다.
    {
      const root = freshRoot("self-lock");
      runWriter(root, makeCareerInstance([makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } })]));
      const filePath = path.join(root, "career.json");
      const before = readTextOrNull(filePath);
      const selfLocked = makeCareerInstance([
        { ...makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } }), locked: true },
      ]);
      const r = runWriter(root, selfLocked);
      const ok = before !== null && r.status === 1 && r.stderr.includes("LOCKED_SET_BY_TEMPLATE") &&
        readTextOrNull(filePath) === before;
      if (!ok) console.log(`    실제: status=${r.status} 변경됨=${readTextOrNull(filePath) !== before} stderr=${r.stderr}`);
      report(ok, "(WA-18) 생성 출력이 locked:true를 실으면 exit 1이고 기존 산출물이 그대로 남는다(게이트 B-7 엔드투엔드)");
    }

    // ---- (WA-19) 허용 방향: locked를 담지 않은 출력은 정상적으로 쓰이는가 ----
    //      금지 방향만 두면 "무조건 거부하는" 검사가 (WA-18)을 통과하고
    //      프로덕션 경로가 통째로 막힌 것을 아무도 모른다.
    {
      const root = freshRoot("no-lock-ok");
      const r = runWriter(root, makeCareerInstance([makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } })]));
      const written = readJsonOrNull(path.join(root, "career.json"));
      const ok = r.status === 0 && written?.nodes?.[0]?.locked === false;
      if (!ok) console.log(`    실제: status=${r.status} locked=${JSON.stringify(written?.nodes?.[0]?.locked)} stderr=${r.stderr}`);
      report(ok, "(WA-19) 허용 방향: locked를 담지 않은 출력은 exit 0으로 기록되고 병합이 locked:false를 채운다(게이트 B-7)");
    }

    // ---- (WA-20) 저장 경계 밖 --root를 거부하는가(콜드 리뷰 Security #11) ----
    //      이 파일이 유일한 쓰기 경계라고 선언해 두고 그 경계가 받는 --root만
    //      무검증이면 선언이 무의미하다. `tmp` 자체는 `.devcareer` 세그먼트가
    //      없으므로 그대로 경계 밖 루트다.
    {
      const outside = path.join(tmp, "outside-boundary");
      fs.mkdirSync(outside, { recursive: true });
      const r = runWriter(outside, makeCareerInstance([makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } })]));
      const ok = r.status === 2 && r.stderr.includes("[INPUT_ERROR]") && !fs.existsSync(path.join(outside, "career.json"));
      if (!ok) console.log(`    실제: status=${r.status} 파일생성=${fs.existsSync(path.join(outside, "career.json"))} stderr=${r.stderr}`);
      report(ok, "(WA-20) 저장 경계 밖 --root는 [INPUT_ERROR] + exit 2이고 산출물을 만들지 않는다(콜드 리뷰 Security #11)");
    }

    // ---- (WA-21) 깨진 prev의 보류 메시지가 --force 결과를 경고하는가 ----
    //      **콜드 리뷰 Correctness #7.** PREV_ARTIFACT_EDITED는 '.bak 1세대'까지
    //      안내하는데 UNREADABLE 쪽은 강행 결과를 한 줄도 언급하지 않았다 —
    //      더 파괴적인 쪽(병합할 prev가 없어 locked까지 전부 대체된다)이 경고가
    //      없는 비대칭이었다. 이 단언은 그 경로를 **실행**해 메시지를 읽는다
    //      (콜드 리뷰 Testing #8의 '깨진 JSON 경로 미검증'이 이 관측의 전제라
    //      함께 닫힌다 — 메시지를 보려면 그 경로를 돌려야 한다).
    {
      const root = freshRoot("unreadable-json");
      fs.writeFileSync(path.join(root, "career.json"), "{broken", "utf8");
      const r = runWriter(root, makeCareerInstance([makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } })]));
      const ok = r.status === 3 && r.stderr.includes("PREV_ARTIFACT_UNREADABLE") &&
        r.stderr.includes("--force") && r.stderr.includes("locked") &&
        readTextOrNull(path.join(root, "career.json")) === "{broken";
      if (!ok) console.log(`    실제: status=${r.status} stderr=${r.stderr}`);
      report(ok, "(WA-21) 깨진 prev는 exit 3이고 보류 메시지가 --force 강행 시 locked 전멸을 경고한다(콜드 리뷰 Correctness #7)");
    }

    // ---- (WA-22) 읽기 실패를 '존재 확인됨'으로 오분류하지 않는가 ----
    //      **콜드 리뷰 Correctness #9의 앞 절반.** career.json 자리에 디렉터리를
    //      두면 readFileSync가 EISDIR로 실패한다 — 파일이 있는지조차 확인하지
    //      못한 상태다. 초판은 이것을 found:true로 단정했다.
    {
      const root = freshRoot("unreadable-eisdir");
      fs.mkdirSync(path.join(root, "career.json"), { recursive: true });
      const r = runWriter(root, makeCareerInstance([makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } })]));
      const ok = r.status === 3 && r.stderr.includes("PREV_ARTIFACT_UNREADABLE") && r.stderr.includes("존재 여부");
      if (!ok) console.log(`    실제: status=${r.status} stderr=${r.stderr}`);
      report(ok, "(WA-22) 읽기 실패(EISDIR)는 '존재 여부 미확인'으로 보고되고 exit 3이다(콜드 리뷰 Correctness #9)");
    }

    // ---- (WA-23) 백업 실패가 exit 1로 위장되지 않는가 ----
    //      **콜드 리뷰 Correctness #9의 본체.** 읽기가 실패한 바로 그 이유로
    //      copyFileSync도 실패하는데 try/catch가 없어 미처리 예외로 죽었고,
    //      Node의 종료 코드가 1이라 그 크래시가 **문서화된 exit 1**('출력을
    //      고쳐 다시 부른다')로 위장돼 호출자를 무의미한 재시도로 유도했다.
    //      **status !== 1을 함께 단언하는 것이 이 관측의 핵심**이다 — exit 3만
    //      보면 위장이 되살아나도 그것이 3이 아니라는 사실만 알 뿐이다.
    {
      const root = freshRoot("backup-fail");
      fs.mkdirSync(path.join(root, "career.json"), { recursive: true });
      const r = runWriter(root, makeCareerInstance([makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } })]), ["--force"]);
      const ok = r.status === 3 && r.status !== 1 && r.stderr.includes("PREV_ARTIFACT_BACKUP_FAILED") &&
        !fs.existsSync(path.join(root, "career.json.bak"));
      if (!ok) console.log(`    실제: status=${r.status} stderr=${r.stderr}`);
      report(ok, "(WA-23) --force 백업 실패는 exit 3(사람 확인)이고 exit 1로 위장되지 않는다(콜드 리뷰 Correctness #9)");
    }

    // ---- (WA-24) existence 3상태가 실제로 갈리는가 ----
    //      **이 단언이 없으면 3상태가 사실상 2상태다.** WA-22·WA-23은 메시지와
    //      종료 코드만 보는데, "unknown"을 "present"로 되돌려도 둘 다 녹색이다
    //      (양쪽 다 `!== "absent"`라 강행 분기가 같기 때문이다). 반환값을 직접
    //      읽어 세 갈래를 고정한다 — export된 함수이므로 직접 부를 수 있다.
    {
      const root = freshRoot("existence-tri");
      const absent = inspectPreviousArtifact("career", path.join(root, "career.json"));

      runWriter(root, makeCareerInstance([makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } })]));
      const present = inspectPreviousArtifact("career", path.join(root, "career.json"));

      const unknownRoot = freshRoot("existence-unknown");
      fs.mkdirSync(path.join(unknownRoot, "career.json"), { recursive: true });
      const unknown = inspectPreviousArtifact("career", path.join(unknownRoot, "career.json"));

      const ok = absent.existence === "absent" && absent.hold === null &&
        present.existence === "present" && present.hold === null &&
        unknown.existence === "unknown" && unknown.hold?.code === "PREV_ARTIFACT_UNREADABLE";
      if (!ok) console.log(`    실제: absent=${absent.existence} present=${present.existence} unknown=${unknown.existence}`);
      report(ok, "(WA-24) inspectPreviousArtifact는 absent/present/unknown 세 상태를 구분한다(읽기 실패를 '있음'으로 단정하지 않는다)");
    }

    // ---- (WA-29) contentHash가 없는 prev를 CLI 레벨에서 관측한다(8번 ⑤) ----
    //      **f029375 Minor 8의 잔여분.** `inspectPreviousArtifact`의 세 보류 사유 중
    //      PREV_ARTIFACT_UNREADABLE은 (WA-21)이, PREV_ARTIFACT_EDITED는 (WA-20)이
    //      **실행해서** 봤는데 PREV_ARTIFACT_HASH_MISSING만 함수 계약으로만 짚여
    //      있었다 — 즉 그 분기가 실제 CLI에서 exit 3을 내는지, 그리고 그때 정말로
    //      아무것도 덮어쓰지 않는지는 한 번도 관측되지 않았다. 세 사유가 같은
    //      채널(exit 3 + [HOLD])을 쓰기로 한 계약이므로 셋 다 같은 깊이로 봐야 한다.
    //
    //      **prev를 손으로 조립하지 않고 진짜 산출물에서 파생시킨다.** 골격을 손으로
    //      쓰면 「contentHash가 없다」와 「그 밖의 필드도 스키마를 어긴다」가 뭉개져,
    //      exit 3이 정말 해시 부재 때문인지 다른 위반 때문인지 구별되지 않는다.
    //      정상 쓰기 → contentHash만 제거 → 재호출이면 바뀐 변수가 하나다.
    {
      const root = freshRoot("hash-missing");
      const first = runWriter(root, makeCareerInstance([makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } })]));
      const filePath = path.join(root, "career.json");
      const written = readJsonOrNull(filePath);
      let tampered = null;
      if (written !== null) {
        delete written.contentHash;
        tampered = JSON.stringify(written);
        fs.writeFileSync(filePath, tampered, "utf8");
      }
      const r = runWriter(root, makeCareerInstance([makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } })]));
      // 판정 방향이 전부 양수형이다 — 첫 쓰기가 실패하면 `written`이 null이 되고
      // `tampered`도 null이라 아래 세 조건이 스스로 false가 된다. 음수형(`!==`)을
      // 쓰면 두 미지값이 우연히 같아져 통과할 수 있다.
      const ok =
        first.status === 0 && tampered !== null &&
        r.status === 3 &&
        r.stderr.includes("[HOLD]") && r.stderr.includes("PREV_ARTIFACT_HASH_MISSING") &&
        readTextOrNull(filePath) === tampered;
      if (!ok) console.log(`    실제: first=${first.status} status=${r.status} stderr=${r.stderr}`);
      report(
        ok,
        "(WA-29) contentHash가 없는 prev는 CLI에서 [HOLD] PREV_ARTIFACT_HASH_MISSING + exit 3이고 " +
        "기존 파일을 한 바이트도 덮어쓰지 않는다(f029375 Minor 8 잔여 — 세 보류 사유가 같은 깊이로 관측된다)"
      );
    }

    // ---- (WA-30)~(WA-32) prev 유래 스키마 위반은 exit 1이 아니라 전용 HOLD다 (10번) ----
    //
    //      **f029375 Minor 12. 지금까지 열려 있던 유일한 비가역 데이터 손실 경로다.**
    //      쓰기 직전 자기 검증은 draft가 아니라 **병합 결과**를 보는데, 그 결과에는
    //      prev에서 온 것이 섞인다. 위반이 거기서 오면 exit 1(「출력을 고쳐 다시
    //      부른다」)은 **따라도 낫지 않는 안내**이고, 막다른 길에서 사용자가 산출물을
    //      지우고 새로 쓰면 잠가 둔 편집분이 사라진다.
    //
    //      **세 갈래를 각각 본다.** 하나만 보면 반대 방향의 잘못된 구현이 통과한다 —
    //      (WA-30)만 두면 「모든 스키마 위반을 exit 3으로 보내는」 구현이 통과하고,
    //      (WA-31)만 두면 지금의 결함이 그대로인 구현이 통과한다.

    // ---- (WA-30) 금지 방향: 잠긴 노드의 편집 + --force 강행 ----
    //      **prev를 손으로 조립하지 않고 진짜 산출물에서 파생시킨다**((WA-29)와 같은 규율) —
    //      골격을 손으로 쓰면 「prev 유래 위반」과 「그 밖의 위반」이 뭉개진다.
    //      `basis`를 enum 밖 값으로 바꾸고 `locked: true`를 함께 넣는 것이 리뷰가 적은
    //      구체 경로 그대로다(사용자가 노드를 손으로 고치며 둘을 함께 넣는다).
    {
      const root = freshRoot("prev-schema-violation");
      const node = () => makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } });
      const first = runWriter(root, makeCareerInstance([node()]));
      const filePath = path.join(root, "career.json");
      const written = readJsonOrNull(filePath);
      let tampered = null;
      if (written !== null && Array.isArray(written.nodes) && written.nodes.length > 0) {
        written.nodes[0].basis = "NOT_A_VALID_ENUM_VALUE";
        written.nodes[0].locked = true;
        tampered = JSON.stringify(written);
        fs.writeFileSync(filePath, tampered, "utf8");
      }
      // `--force`를 준다. 이 경로의 핵심은 **강행해도 넘어가지 못한다**는 것이다 —
      // 강행하면 스키마를 어기는 산출물이 기록되므로 이 HOLD에는 우회로가 없다.
      const r = runWriter(root, makeCareerInstance([node()]), ["--force"]);
      const ok =
        first.status === 0 && tampered !== null &&
        r.status === 3 &&
        r.stderr.includes("[HOLD]") && r.stderr.includes("PREV_ARTIFACT_SCHEMA_VIOLATION") &&
        r.stderr.includes("$.nodes[0].basis") &&
        readTextOrNull(filePath) === tampered &&
        readTextOrNull(`${filePath}.bak`) === null;
      if (!ok) console.log(`    실제: first=${first.status} status=${r.status} bak=${readTextOrNull(`${filePath}.bak`) !== null} stderr=${r.stderr}`);
      report(
        ok,
        "(WA-30) prev의 잠긴 노드에서 온 스키마 위반은 --force로도 [HOLD] PREV_ARTIFACT_SCHEMA_VIOLATION + exit 3이고 " +
        "산출물도 .bak도 만들지 않는다(f029375 Minor 12 — exit 1의 '출력을 고쳐라'가 거짓 안내이던 경로)"
      );
    }

    // ---- (WA-31) 허용 방향: draft 몫 위반은 여전히 exit 1이다 ----
    //      이것이 없으면 「스키마 위반을 전부 exit 3으로 보내는」 구현이 (WA-30)을
    //      통과한다. 그러면 5분기 계약이 반대 방향으로 무너진다 — 고칠 수 있는 오류가
    //      전부 사람 확인으로 넘어가 exit 3의 신호가 희석된다.
    {
      const root = freshRoot("draft-schema-violation");
      const bad = makeCareerInstance([{ ...makeFactCheckedNode({ id: "car:001" }), basis: "NOT_A_VALID_ENUM_VALUE" }]);
      const r = runWriter(root, bad);
      const ok =
        r.status === 1 &&
        r.stderr.includes("[SCHEMA]") &&
        !r.stderr.includes("PREV_ARTIFACT_SCHEMA_VIOLATION") &&
        readTextOrNull(path.join(root, "career.json")) === null;
      if (!ok) console.log(`    실제: status=${r.status} stderr=${r.stderr}`);
      report(
        ok,
        "(WA-31) 허용 방향: prev가 없는 draft 자신의 스키마 위반은 여전히 [SCHEMA] + exit 1이다(전부 exit 3으로 보내는 구현 방어)"
      );
    }

    // ---- (WA-32) 규칙 1의 두 번째 경로 — draft에 없던 잠긴 생존자 ----
    //      (WA-30)이 관측하는 것은 「draft가 같은 id로 덮어쓰려다 prev가 이긴」 경로다.
    //      잠긴 노드가 **draft에 아예 없어서** 뒤에 붙는 경로는 코드가 다르고(마지막
    //      루프) 인덱스도 draft 길이 뒤로 밀린다 — `prevDerived` 정렬이 어긋나면
    //      정확히 여기서 오판이 난다. 그래서 별도로 본다.
    {
      const root = freshRoot("prev-schema-orphan");
      const first = runWriter(root, makeCareerInstance([
        makeFactCheckedNode({ id: "car:001" }),
        makeFactCheckedNode({ id: "car:002", text: "잠글 노드." }),
      ]));
      const filePath = path.join(root, "career.json");
      const written = readJsonOrNull(filePath);
      let tampered = null;
      if (written !== null && Array.isArray(written.nodes) && written.nodes.length === 2) {
        written.nodes[1].basis = "NOT_A_VALID_ENUM_VALUE";
        written.nodes[1].locked = true;
        tampered = JSON.stringify(written);
        fs.writeFileSync(filePath, tampered, "utf8");
      }
      // draft는 car:001만 담는다 — car:002는 draft에 없는 잠긴 생존자로 뒤에 붙는다.
      const r = runWriter(root, makeCareerInstance([makeFactCheckedNode({ id: "car:001" })]), ["--force"]);
      const ok =
        first.status === 0 && tampered !== null &&
        r.status === 3 &&
        r.stderr.includes("PREV_ARTIFACT_SCHEMA_VIOLATION") &&
        r.stderr.includes("$.nodes[1].basis") &&
        readTextOrNull(filePath) === tampered;
      if (!ok) console.log(`    실제: first=${first.status} status=${r.status} stderr=${r.stderr}`);
      report(
        ok,
        "(WA-32) draft에 없던 잠긴 생존자에서 온 위반도 같은 HOLD로 잡히고 인덱스가 draft 길이 뒤로 밀린 자리를 정확히 가리킨다(규칙 1의 두 번째 경로)"
      );
    }

    // ---- (WA-25) updateRegistry가 실패를 예외가 아니라 반환값으로 보고하는가 ----
    //      **exit 4 위장 경로다.** main()은 산출물을 이미 쓴 **뒤** updateRegistry를
    //      부르고 `{ok}`로 분기한다. 그런데 그 안의 스키마 로드와 writeState가
    //      try/catch 밖에 있어서, 던지면 Node 기본 처리로 **exit 1**이 된다 —
    //      파일 헤더가 「'쓰지 않았다' 불변식을 깨는 유일한 코드」라고 못 박은 exit 4가
    //      「아무것도 쓰지 않았다」는 exit 1로 위장되는 것이다. 호출자는 존재하는
    //      산출물을 두고 draft를 고쳐 재시도하는 무의미한 루프에 들어간다.
    //      **이 회차가 writeBackup에서 닫은 것과 같은 형태다**(콜드 리뷰 Correctness #9).
    //
    //      **왜 CLI가 아니라 export된 함수로 관측하는가.** 이 경로를 CLI에서
    //      portable하게 유발할 방법이 없다 — 저장 루트 자체를 못 쓰게 만들면 산출물
    //      쓰기가 **먼저** 실패하고, state.json만 못 쓰게 만드는 수단(읽기 전용 파일·
    //      디렉터리 치환)은 OS마다 결과가 갈리거나 readState가 먼저 막아 이미 있는
    //      early-return으로 빠진다. 반면 「이 함수는 던지지 않는다」는 계약은 CLI
    //      보장을 **함의한다**: main()이 분기하는 값이 항상 `{ok, error}`이면 레지스트리
    //      단계에서 raw 예외가 샐 수 없다. 트리거는 이름이 지나치게 긴 경로
    //      세그먼트다(어느 OS에서든 mkdir이 던지고, readState는 ENOENT로 통과한다).
    {
      const bad = path.join(tmp, STATE_DIR_NAME, "n".repeat(300));
      let threw = null;
      let ret = null;
      try {
        ret = updateRegistry(bad, "career", path.join(bad, "career.json"), "0.1.0", "career-from-git", FIXED_AT);
      } catch (e) {
        threw = e.code ?? e.message;
      }
      // **사유 코드까지 단언하는 이유 — 이 단언이 공허해지는 유일한 길을 막는다.**
      // `{ok:false}`만 보면 `readState`가 non-ENOENT 오류를 받아 **기존
      // early-return**으로 빠져도 통과한다. 그러면 이번에 넣은 try/catch는 한 번도
      // 실행되지 않는다. OS·파일시스템에 따라 긴 경로 세그먼트가 ENOENT가 아니라
      // ENAMETOOLONG으로 먼저 보고될 수 있으므로 그 갈림은 실제로 가능하다.
      // 새 가드만 쓰는 코드를 요구해 「어느 경로로 왔는가」를 고정한다.
      const ok = threw === null && ret !== null && ret.ok === false &&
        typeof ret.error === "string" && ret.error.includes("REGISTRY_UNEXPECTED_ERROR");
      if (!ok) console.log(`    실제: threw=${threw} ret=${JSON.stringify(ret)}`);
      report(ok, "(WA-25) updateRegistry는 쓰기 실패에서 던지지 않고 REGISTRY_UNEXPECTED_ERROR를 담은 {ok:false}를 돌린다(exit 4가 exit 1로 위장되지 않는다)");
    }

    // ---- (WA-27) 산출물 쓰기 실패가 계약 안의 종료 코드로 나오는가 ----
    //      **이 파일이 스스로 「산출물이 디스크에 닿는 유일한 경로」라고 선언한
    //      바로 그 호출이 비보호였다.** 계약·스키마 검사를 전부 통과한 뒤이므로
    //      여기서의 실패는 draft 내용과 무관한 파일시스템 문제다(경계 안의 --root가
    //      일반 파일 하위를 가리켜 ENOTDIR, 디스크 가득 참, 권한, 잠금). 던지게 두면
    //      Node가 exit 1로 죽는데 이 파일의 exit 1은 「출력을 고쳐 다시 부른다」라서
    //      호출자는 draft를 아무리 고쳐도 같은 예외를 반복한다.
    //      실측: `.devcareer/<일반 파일>/nested`를 --root로 주면 store.mjs의
    //      mkdirSync가 ENOTDIR로 던지고 원시 스택과 함께 exit 1이 났다.
    {
      const blockerParent = path.join(tmp, "wa27", STATE_DIR_NAME);
      fs.mkdirSync(blockerParent, { recursive: true });
      const blocker = path.join(blockerParent, "blocker");
      fs.writeFileSync(blocker, "나는 디렉터리가 아니다", "utf8");
      const root = path.join(blocker, "nested"); // 경계 검사는 통과한다(.devcareer 세그먼트가 있다)
      const r = runWriter(root, makeCareerInstance([makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } })]));
      const ok = r.status === 3 && r.stderr.includes("ARTIFACT_WRITE_FAILED") &&
        !r.stderr.includes("    at ") && !fs.existsSync(path.join(root, "career.json"));
      if (!ok) console.log(`    실제: status=${r.status} stderr=${r.stderr.slice(0, 400)}`);
      report(ok, "(WA-27) 산출물 쓰기 실패는 [HOLD] ARTIFACT_WRITE_FAILED + exit 3이다(원시 스택도, 오도하는 exit 1도 아니다)");
    }

    // ---- (WA-28) 계층 스키마를 읽지 못하는 설치 손상도 계약 안인가 ----
    //      `loadSchema`의 readFileSync·JSON.parse가 비보호였다. **이번 회차가
    //      updateRegistry 주석에서 직접 지목한 시나리오**(플러그인 설치가 손상돼
    //      스키마 파일을 읽지 못함)가 같은 파일 안에 그대로 열려 있었다.
    //
    //      **왜 스크립트 사본을 만들어 관측하는가.** 이 경로를 유발하려면
    //      `schemas/`를 훼손해야 하는데 레포의 그 디렉터리를 테스트가 건드리면
    //      다른 단언이 오염된다. `scripts/`와 `schemas/`만 임시 디렉터리로 복사하면
    //      복사본의 REPO_ROOT가 그 임시 디렉터리가 되므로(SCRIPT_DIR의 상위) 레포는
    //      그대로 두고 손상된 설치를 재현할 수 있다.
    //
    //      **exit 4가 아니라 3인 이유.** 이 지점은 writeJsonAtomic보다 **앞**이라
    //      산출물이 기록되지 않았다. exit 4는 「기록됐다」를 뜻하므로 거짓 보고가 된다.
    {
      const fake = path.join(tmp, "wa28-install");
      fs.mkdirSync(fake, { recursive: true });
      fs.cpSync(path.join(REPO_ROOT, "scripts"), path.join(fake, "scripts"), { recursive: true });
      fs.cpSync(path.join(REPO_ROOT, "schemas"), path.join(fake, "schemas"), { recursive: true });
      fs.rmSync(path.join(fake, "schemas", "career.schema.json"), { force: true });

      const root = freshRoot("wa28-root");
      const draftPath = path.join(tmp, "wa28-draft.json");
      fs.writeFileSync(
        draftPath,
        JSON.stringify(makeCareerInstance([makeFactCheckedNode({ id: "car:001", verification: { status: "verified", attempts: 1, reasonCode: null } })])),
        "utf8"
      );
      const r = spawnSync(
        process.execPath,
        [path.join(fake, "scripts", "write-artifact.mjs"), "--layer", "career", "--draft", draftPath,
          "--root", root, "--stage", "fact-checked", "--skill", "career-from-git", "--generated-at", FIXED_AT],
        { encoding: "utf8" }
      );
      const stderr = r.stderr ?? "";
      const ok = r.status === 3 && stderr.includes("LAYER_SCHEMA_UNREADABLE") &&
        !stderr.includes("    at ") && !fs.existsSync(path.join(root, "career.json"));
      if (!ok) console.log(`    실제: status=${r.status} stderr=${stderr.slice(0, 400)}`);
      report(ok, "(WA-28) 계층 스키마를 읽지 못하면 [HOLD] LAYER_SCHEMA_UNREADABLE + exit 3이고 산출물을 만들지 않는다");
    }

    // ---- (WA-26) 허용 방향: 정상 경로에서 {ok:true}이고 항목이 실제로 기재되는가 ----
    //      금지 방향만 두면 "무조건 {ok:false}를 돌리는" 구현이 (WA-25)를 통과하고
    //      모든 정상 쓰기가 exit 4가 된 것을 아무도 모른다.
    {
      const root = freshRoot("registry-ok");
      const artifactPath = path.join(root, "career.json");
      fs.writeFileSync(artifactPath, JSON.stringify({ schemaVersion: "0.1.0" }), "utf8");
      const ret = updateRegistry(root, "career", artifactPath, "0.1.0", "career-from-git", FIXED_AT);
      const state = readJsonOrNull(path.join(root, "state.json"));
      const ok = ret.ok === true && ret.error === null && state?.artifacts?.career?.path === "career.json";
      if (!ok) console.log(`    실제: ret=${JSON.stringify(ret)} state=${JSON.stringify(state)}`);
      report(ok, "(WA-26) 허용 방향: 정상 루트에서는 {ok:true}이고 state.json 레지스트리에 항목이 기재된다");
    }

    // -----------------------------------------------------------------------
    // 상위 계층 참조 해소 — 라운드 2 처방 7
    //
    // **`buildHonestRenderRoot()`를 재사용하지 않는다.** 그 헬퍼는 (RV-5)(RV-7)(RV-8)
    // (RM-7)의 전제이고 career 노드가 1건이라 아래 「첫 노드만 본다」류 축소 구현을
    // 격리할 수 없다. 여기서는 신설 루트에 노드 2건짜리 부모를 직접 만든다.
    // -----------------------------------------------------------------------

    /** 이 절의 knowledge-map 노드 — 모양은 buildHonestRenderRoot의 km 노드를 따른다. */
    // `text`를 인자로 받는다 — 같은 루트에 두 번 쓰면서 서술이 같으면
    // `NODE_ID_CHURN`(같은 사실에 새 id)이 **먼저** 걸려 이번 축에 닿지 못한다((WA-38)에서 실측).
    const kmNode = (id, parentRefs, text = "상위 계층 참조 해소 픽스처의 지식맵 노드.") => ({
      id, basis: "insufficient", evidence: [], parentRefs,
      verification: { status: "not-attempted", attempts: 0, reasonCode: null },
      origin: "generated", topic: "문서화", text,
    });

    /** career 노드 두 건을 담은 부모를 실제 CLI로 기록한다. */
    const seedParent = (root) => runWriter(root, makeCareerInstance([
      makeFactCheckedNode({ id: "car:p01", text: "상위 계층 참조 픽스처의 첫 커리어 노드." }),
      makeFactCheckedNode({ id: "car:p02", text: "상위 계층 참조 픽스처의 둘째 커리어 노드." }),
    ]));

    // ---- (WA-34) 금지 방향: 부모 산출물이 없다 ----
    //      **`--force`로도 넘어갈 수 없다.** 강행하면 고아 참조를 담은 산출물이
    //      기록되므로, 한 단언 안에서 두 호출을 돌려 우회로 부재까지 함께 못 박는다.
    {
      const root = freshRoot("parent-missing");
      const draft = makeCareerInstance([kmNode("km:x01", ["car:p01"])]);
      const plain = runWriter(root, draft, [], "fact-checked", "knowledge-map");
      const forced = runWriter(root, draft, ["--force"], "fact-checked", "knowledge-map");
      const state = readJsonOrNull(path.join(root, "state.json"));
      const ok =
        plain.status === 2 && plain.stderr.includes("PARENT_ARTIFACT_MISSING") &&
        forced.status === 2 && forced.stderr.includes("PARENT_ARTIFACT_MISSING") &&
        readTextOrNull(path.join(root, "knowledge-map.json")) === null &&
        (state === null || state.artifacts?.knowledgeMap == null);
      if (!ok) {
        console.log(`    실제: plain=${plain.status} forced=${forced.status} stderr=${plain.stderr.slice(0, 250)}`);
      }
      report(
        ok,
        "(WA-34) 금지 방향: career.json이 없는 루트에 knowledge-map을 쓰면 exit 2 + PARENT_ARTIFACT_MISSING이고, --force로도 넘어가지 않으며 파일도 레지스트리 항목도 생기지 않는다"
      );
    }

    // ---- (WA-35) 금지 방향: 참조 0건이어도 부모 실재는 검사한다 ----
    //      **판정 순서를 못 박는 유일한 단언이다.** `plan`만 `nodes`에 `minItems`가
    //      없어(스키마 실측) 노드가 빈 draft를 만들 수 있고, 「참조 0건이면 통과」를
    //      부모 실재 검사보다 앞에 두면 **부모 없는 루트에 exit 0으로 기록된다.**
    //      참조 0건은 대조를 건너뛸 근거일 뿐 저장 루트 상태 검사를 건너뛸 근거가 아니다.
    {
      const root = freshRoot("plan-empty-nodes");
      const r = runWriter(root, makeCareerInstance([]), [], "draft", "plan");
      const ok =
        r.status === 2 &&
        r.stderr.includes("PARENT_ARTIFACT_MISSING") &&
        readTextOrNull(path.join(root, "plan.json")) === null;
      if (!ok) console.log(`    실제: exit=${r.status} stderr=${r.stderr.slice(0, 300)}`);
      report(
        ok,
        "(WA-35) 금지 방향: 해소할 참조가 0건인 plan draft도 gap-report.json이 없으면 exit 2 + PARENT_ARTIFACT_MISSING이다(부모 실재 검사가 참조 개수보다 먼저다)"
      );
    }

    // ---- (WA-36) 금지 방향: draft가 실재하지 않는 상위 id를 인용 ----
    //      draft를 고치면 해소되므로 **exit 1**이다. 전부 exit 3으로 보내는 구현이
    //      이 단언에 걸린다.
    {
      const root = freshRoot("ref-unresolved");
      const seeded = seedParent(root);
      const r = runWriter(root, makeCareerInstance([kmNode("km:x02", ["car:nonexistent"])]), [], "fact-checked", "knowledge-map");
      const ok =
        seeded.status === 0 &&
        r.status === 1 &&
        r.stderr.includes("[LAYER_REF]") &&
        r.stderr.includes("LAYER_REF_UNRESOLVED") &&
        readTextOrNull(path.join(root, "knowledge-map.json")) === null;
      if (!ok) console.log(`    실제: seed=${seeded.status} exit=${r.status} stderr=${r.stderr.slice(0, 300)}`);
      report(
        ok,
        "(WA-36) 금지 방향: draft가 career에 없는 id를 parentRefs로 인용하면 exit 1 + [LAYER_REF] LAYER_REF_UNRESOLVED이고 파일이 생기지 않는다"
      );
    }

    // ---- (WA-37) 금지 방향: 부모를 읽을 수 없다 ----
    //      부재의 exit 2와 **다른 코드·다른 채널**이다. 인자로도 draft로도 고칠 수
    //      없고 사람이 부모 파일을 봐야 하므로 exit 3이다 — 훼손을 부재로 강등하지 않는다.
    {
      const root = freshRoot("parent-unreadable");
      const seeded = seedParent(root);
      fs.writeFileSync(path.join(root, "career.json"), "{ 이것은 JSON이 아니다", "utf8");
      const r = runWriter(root, makeCareerInstance([kmNode("km:x03", ["car:p01"])]), [], "fact-checked", "knowledge-map");
      const ok =
        seeded.status === 0 &&
        r.status === 3 &&
        r.stderr.includes("[HOLD]") &&
        r.stderr.includes("PARENT_ARTIFACT_UNREADABLE") &&
        readTextOrNull(path.join(root, "knowledge-map.json")) === null;
      if (!ok) console.log(`    실제: seed=${seeded.status} exit=${r.status} stderr=${r.stderr.slice(0, 300)}`);
      report(
        ok,
        "(WA-37) 금지 방향: 부모 career.json이 깨진 JSON이면 exit 3 + [HOLD] PARENT_ARTIFACT_UNREADABLE이다(부재의 exit 2와 다른 코드다)"
      );
    }

    // ---- (WA-38) 금지 방향: 이전 산출물에서 병합된 미해소 참조 ----
    //      **draft를 고쳐도 해소되지 않는다** — 잠긴 생존자가 병합에 실려 온 참조다.
    //      exit 1(「출력을 고쳐 다시 부른다」)을 내면 거짓 안내가 되므로 exit 3이다.
    //      `.bak`이 생기지 않는 것은 **이 검사가 백업 블록보다 앞이기 때문**이다.
    {
      const root = freshRoot("prev-ref-unresolved");
      const seeded = seedParent(root);
      // **생존자는 부모의 첫 노드를 가리키고, 나중에 사라지는 것도 그 첫 노드다.**
      // 둘째 노드를 쓰면 「부모 id 집합을 첫 노드만으로 좁히는」 변이가 이 단언의
      // **셋업 단계**에서 먼저 죽어 (WA-39)와 함께 FAIL한다 — 실측으로 확인하고
      // 고유 관측점을 되찾으려고 순서를 뒤집었다.
      const w1 = runWriter(root, makeCareerInstance([kmNode("km:s01", ["car:p01"])]), [], "fact-checked", "knowledge-map");
      // CLI만으로는 `locked: true`를 만들 수 없다 — mergeArtifact가 신규 노드에
      // `locked: false`를 박는다. (WA-30)/(WA-32)가 쓰는 것과 같은 주입 레시피다.
      const kmPath = path.join(root, "knowledge-map.json");
      const km = readJsonOrNull(kmPath);
      if (km !== null) {
        km.nodes[0].locked = true;
        fs.writeFileSync(kmPath, JSON.stringify(km), "utf8");
      }
      // 부모에서 `car:p01`을 없앤다(career는 부모가 없어 새 검사에 걸리지 않는다).
      // 남는 `car:p02`가 이제 **유일한 = 첫** 노드라, 아래 새 draft는 좁히기 변이
      // 아래에서도 해소된다.
      const w2 = runWriter(root, makeCareerInstance([
        makeFactCheckedNode({ id: "car:p02", text: "상위 계층 참조 픽스처의 둘째 커리어 노드." }),
      ]), ["--force"]);
      // 잠긴 생존자를 언급하지 않는 draft — 생존자가 병합에 실려 온다.
      const r = runWriter(
        root,
        makeCareerInstance([kmNode("km:s02", ["car:p02"], "잠긴 생존자와 서술이 다른 새 지식맵 노드.")]),
        ["--force"], "fact-checked", "knowledge-map"
      );
      const ok =
        seeded.status === 0 && w1.status === 0 && w2.status === 0 &&
        r.status === 3 &&
        r.stderr.includes("PREV_ARTIFACT_LAYER_REF_UNRESOLVED") &&
        readTextOrNull(`${kmPath}.bak`) === null;
      if (!ok) {
        console.log(`    실제: seed=${seeded.status} w1=${w1.status} w2=${w2.status} exit=${r.status} stderr=${r.stderr.slice(0, 300)}`);
      }
      report(
        ok,
        "(WA-38) 금지 방향: 부모에서 사라진 id를 가리키는 잠긴 생존자가 병합되면 exit 3 + PREV_ARTIFACT_LAYER_REF_UNRESOLVED이고, --force로도 넘어가지 않으며 .bak도 생기지 않는다"
      );
    }

    // ---- (WA-39) 허용 방향: 정직한 참조는 기록된다 ----
    //      **두 번째 노드를 가리킨다** — 「첫 노드만 본다」류 축소 구현이 이 단언에만
    //      걸리게 하려는 것이다. 금지 방향만 두면 부모 id 집합을 통째로 좁히는 변경이
    //      통과한다.
    {
      const root = freshRoot("ref-resolved");
      const seeded = seedParent(root);
      const r = runWriter(root, makeCareerInstance([kmNode("km:x04", ["car:p02"])]), [], "fact-checked", "knowledge-map");
      const state = readJsonOrNull(path.join(root, "state.json"));
      const ok =
        seeded.status === 0 &&
        r.status === 0 &&
        readTextOrNull(path.join(root, "knowledge-map.json")) !== null &&
        state?.artifacts?.knowledgeMap != null;
      if (!ok) console.log(`    실제: seed=${seeded.status} exit=${r.status} stderr=${r.stderr.slice(0, 300)}`);
      report(
        ok,
        "(WA-39) 허용 방향: 부모의 **두 번째** 노드 id를 가리키는 knowledge-map draft는 exit 0으로 기록되고 레지스트리에 오른다"
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function runCitationCoverageOracleSmoke() {
  console.log("[인용 커버리지 오라클] C-5: 인용 0건 = PASS fail-open 제거 · A-32 입력 오류 · A-34 계층 enum 드리프트");

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-c5-"));
  try {
    // 실제 커밋 1건짜리 최소 레포 — (C5-2)의 허용 방향이 "인용이 실제로
    // 검증돼 PASS"임을 보이려면 진짜 커밋이 있어야 한다. 픽스처가 진입
    // 조건을 만족하지 않으면 그 단언은 공허하게 참이 된다.
    const repoDir = path.join(tmpBase, "repo");
    crInitRepo(repoDir);
    crWriteFile(repoDir, "a.txt", "hello\n");
    crGit(repoDir, ["add", "."]);
    crGit(repoDir, ["commit", "-q", "-m", "feat: 첫 커밋"]);
    const evidence = collectGitFacts({
      repoPath: repoDir,
      selectedIdentities: [OWNER_EMAIL],
      ref: "HEAD",
      mergeIncluded: false,
      maxCommits: 1000,
    }).evidence;
    const ownerEntry = evidence.commits.find((c) => c.excluded !== true);

    // 인용이 0건인 산출물 — 노드는 있지만(nodes.minItems:1을 만족한다)
    // 전부 evidence:[] + basis:insufficient라 인용 축이 볼 것이 없다.
    // 이것이 C-3이 말한 "빈손"의 nodes.minItems 이후 판이다.
    const emptyCitationCareer = {
      nodes: [{ id: "car:1", basis: "insufficient", evidence: [] }],
    };
    const citingCareer = {
      nodes: [{ id: "car:1", basis: "commit", evidence: [{ ledgerId: ownerEntry.id, path: "a.txt" }] }],
    };

    // ---- (C5-1) 금지 방향: 산출물 1계층 + 인용 0건 → INCONCLUSIVE ----
    {
      const r = verifyEvidence({
        repoPath: repoDir,
        evidence,
        selectedIdentities: [OWNER_EMAIL],
        artifactsByLayer: { career: emptyCitationCareer },
      });
      const codes = (r.inconclusiveReasons ?? []).map((x) => x.code);
      const ok =
        r.status === "INCONCLUSIVE" &&
        r.ok === false &&
        codes.includes("NO_CITATIONS_TO_VERIFY") &&
        r.summary.totalCitations === 0 &&
        r.summary.artifactLayers === 1 &&
        exitCodeForReport(r) === 2;
      if (!ok) console.log(`    실제: status=${r.status} codes=${JSON.stringify(codes)} summary=${JSON.stringify(r.summary)}`);
      report(ok, "(C5-1) 산출물 1계층 + 인용 0건 → INCONCLUSIVE(NO_CITATIONS_TO_VERIFY, exit 2) — 예전에는 [PASS] exit 0이었다");
    }

    // ---- (C5-2) 허용 방향: 산출물 1계층 + 인용 1건(정상) → PASS ----
    //      이 단언이 없으면 "인용 0건"이 아니라 "산출물이 있으면 무조건
    //      INCONCLUSIVE"로 넓혀도 (C5-1)이 그대로 통과한다.
    {
      const r = verifyEvidence({
        repoPath: repoDir,
        evidence,
        selectedIdentities: [OWNER_EMAIL],
        artifactsByLayer: { career: citingCareer },
      });
      const ok =
        r.status === "PASS" &&
        r.ok === true &&
        r.summary.passCitations === 1 &&
        (r.inconclusiveReasons ?? []).length === 0 &&
        exitCodeForReport(r) === 0;
      if (!ok) console.log(`    실제: status=${r.status} summary=${JSON.stringify(r.summary)} reasons=${JSON.stringify(r.inconclusiveReasons)}`);
      report(ok, "(C5-2) 허용 방향: 산출물 1계층 + 검증된 인용 1건 → PASS(exit 0) — 정상 산출물이 새 조건에 걸리지 않는다");
    }

    // ---- (C5-3) 경계: artifactsByLayer가 비면 인용 0건이어도 PASS ----
    //      (e)축·contentHash만 요구한 호출의 PASS는 공허하지 않다.
    //      `artifactLayerCount > 0` 조건을 지우는 변이가 여기서만 FAIL한다.
    {
      const r = verifyEvidence({
        repoPath: repoDir,
        evidence,
        selectedIdentities: [OWNER_EMAIL],
        artifactsByLayer: {},
      });
      const ok =
        r.status === "PASS" &&
        r.summary.totalCitations === 0 &&
        r.summary.artifactLayers === 0 &&
        (r.inconclusiveReasons ?? []).length === 0;
      if (!ok) console.log(`    실제: status=${r.status} summary=${JSON.stringify(r.summary)} reasons=${JSON.stringify(r.inconclusiveReasons)}`);
      report(ok, "(C5-3) 경계: artifactsByLayer:{} + 인용 0건 → PASS 유지(evidence 전용 호출을 INCONCLUSIVE로 만들지 않는다)");
    }

    // ---- (C5-4) 사유 구별: 도구 오류와 0건은 같은 exit 2지만 다른 코드다 ----
    //      비-git 디렉터리를 --repo로 주면 인용은 존재하되 전부 TOOL_ERROR가
    //      되므로 NO_CITATIONS_TO_VERIFY는 발화하지 않아야 한다. 두 사유가
    //      한 코드로 뭉개지면 호출자가 엉뚱한 곳을 고친다.
    {
      const nonGit = path.join(tmpBase, "nonGit");
      fs.mkdirSync(nonGit, { recursive: true });
      const r = verifyEvidence({
        repoPath: nonGit,
        evidence,
        selectedIdentities: [OWNER_EMAIL],
        artifactsByLayer: { career: citingCareer },
      });
      const codes = (r.inconclusiveReasons ?? []).map((x) => x.code);
      const ok =
        r.status === "INCONCLUSIVE" &&
        codes.includes("CITATION_TOOL_ERRORS") &&
        !codes.includes("NO_CITATIONS_TO_VERIFY") &&
        r.summary.totalCitations > 0;
      if (!ok) console.log(`    실제: status=${r.status} codes=${JSON.stringify(codes)} total=${r.summary.totalCitations}`);
      report(ok, "(C5-4) 사유 구별: 도구 오류 실행은 CITATION_TOOL_ERRORS만 내고 NO_CITATIONS_TO_VERIFY는 내지 않는다");
    }

    // ---- (C5-6) 경계 2: 인용 0건이어도 (f)축이 집행됐으면 PASS ----
    //      L2·L3의 basis enum에는 commit이 없으므로 external 노드만 있는
    //      knowledge-map은 인용이 0건인 것이 정상이다. 초판은 이 경우를
    //      INCONCLUSIVE로 뒤집었고 게이트 C-2의 대조군이 그것을 잡았다.
    //      이 단언은 그 좁힘(`externalSourcesChecked === 0` 조건)을
    //      직접 겨냥한다 — 조건을 지우면 여기서만 FAIL한다.
    {
      const externalOnly = {
        nodes: [{ id: "km:001", basis: "external", externalUrl: "https://developer.mozilla.org/en-US/docs/Web/HTTP", evidence: [] }],
      };
      const r = verifyEvidence({
        repoPath: repoDir,
        evidence,
        selectedIdentities: [OWNER_EMAIL],
        artifactsByLayer: { "knowledge-map": externalOnly },
      });
      const ok =
        r.status === "PASS" &&
        r.summary.totalCitations === 0 &&
        r.summary.externalSourcesChecked === 1 &&
        (r.inconclusiveReasons ?? []).length === 0;
      if (!ok) console.log(`    실제: status=${r.status} summary=${JSON.stringify(r.summary)} reasons=${JSON.stringify(r.inconclusiveReasons)}`);
      report(ok, "(C5-6) 경계: 인용 0건이지만 (f)축이 external 1건을 대조 → PASS 유지(집행된 축이 있는 산출물을 미집행으로 보고하지 않는다)");
    }

    // ---- (A32) 입력 파일 오류 → [INPUT_ERROR] + exit 2, 스택 없음 ----
    //      여기만 서브프로세스를 쓴다 — process.exit과 stderr 형태가 판정
    //      대상이라 함수 직접 호출로는 관측할 수 없다.
    {
      const evidencePath = path.join(tmpBase, "evidence.json");
      fs.writeFileSync(evidencePath, JSON.stringify(evidence), "utf8");
      const broken = path.join(tmpBase, "broken.json");
      fs.writeFileSync(broken, "{ not json", "utf8");
      const missing = path.join(tmpBase, "does-not-exist.json");
      const careerPath = path.join(tmpBase, "career.json");
      const verifier = path.join(REPO_ROOT, "scripts", "verify-evidence.mjs");

      const runCli = (args) => {
        const res = spawnSync(process.execPath, [verifier, ...args], { encoding: "utf8" });
        return { status: res.status, stderr: res.stderr ?? "", stdout: res.stdout ?? "" };
      };

      const rMissing = runCli(["--repo", repoDir, "--evidence", missing, "--identity", OWNER_EMAIL, "--artifact", `career=${careerPath}`]);
      const okMissing =
        rMissing.status === 2 &&
        rMissing.stderr.includes("[INPUT_ERROR]") &&
        rMissing.stderr.includes(missing) &&
        !rMissing.stderr.includes("at Object.readFileSync");
      if (!okMissing) console.log(`    실제(부재): exit=${rMissing.status} stderr=${rMissing.stderr.slice(0, 300)}`);
      report(okMissing, "(A32-1) 없는 입력 파일 → [INPUT_ERROR] + exit 2(파일명 포함, raw 스택 없음)");

      const rBroken = runCli(["--repo", repoDir, "--evidence", broken, "--identity", OWNER_EMAIL, "--artifact", `career=${broken}`]);
      const okBroken =
        rBroken.status === 2 &&
        rBroken.stderr.includes("[INPUT_ERROR]") &&
        rBroken.stderr.includes("JSON 파싱 실패") &&
        rBroken.stderr.includes(broken);
      if (!okBroken) console.log(`    실제(깨짐): exit=${rBroken.status} stderr=${rBroken.stderr.slice(0, 300)}`);
      report(okBroken, "(A32-2) 깨진 JSON → [INPUT_ERROR] JSON 파싱 실패 + exit 2(어느 파일인지 이름이 나온다)");

      // exit 1(확정된 위반)과 exit 2(입력 오류)가 구별되는지 — A-32가
      // 지적한 것은 "둘이 같은 코드라 호출자가 구별 못 한다"였다.
      fs.writeFileSync(careerPath, JSON.stringify({
        nodes: [{ id: "car:1", basis: "commit", evidence: [{ ledgerId: `commit:${"d".repeat(40)}`, path: "a.txt" }] }],
      }), "utf8");
      const rFail = runCli(["--repo", repoDir, "--evidence", evidencePath, "--identity", OWNER_EMAIL, "--artifact", `career=${careerPath}`]);
      const okSplit = rFail.status === 1 && !rFail.stderr.includes("[INPUT_ERROR]");
      if (!okSplit) console.log(`    실제(위반): exit=${rFail.status} stderr=${rFail.stderr.slice(0, 300)}`);
      report(okSplit, "(A32-3) 확정된 인용 위반은 여전히 exit 1 — 입력 오류(2)와 종료 코드가 구별된다");

      // C-5의 CLI 경로 관측 — 빈손 산출물이 exit 2로 나오는지.
      const emptyPath = path.join(tmpBase, "career-empty.json");
      fs.writeFileSync(emptyPath, JSON.stringify(emptyCitationCareer), "utf8");
      const rEmpty = runCli(["--repo", repoDir, "--evidence", evidencePath, "--identity", OWNER_EMAIL, "--artifact", `career=${emptyPath}`]);
      const okEmpty =
        rEmpty.status === 2 &&
        rEmpty.stderr.includes("NO_CITATIONS_TO_VERIFY") &&
        !rEmpty.stdout.includes("[PASS]");
      if (!okEmpty) console.log(`    실제(빈손 CLI): exit=${rEmpty.status} stdout=${rEmpty.stdout.slice(0, 300)} stderr=${rEmpty.stderr.slice(0, 300)}`);
      report(okEmpty, "(C5-5) CLI 경로: 빈손 산출물 → [PASS] 미출력 + NO_CITATIONS_TO_VERIFY + exit 2");
    }

    // ---- (A34) 계층 enum 사본 드리프트를 소스 스캔으로 관측 ----
    //      validate-plugin.mjs는 이번 예외 범위 밖이라 고치지 않는다.
    //      대신 두 리터럴이 갈리는 순간 이 단언이 FAIL한다.
    {
      //      판독 실패는 예외가 아니라 사유다. `copy`가 null이면 아래 `ok`가 이미 false이므로
      //      판정식은 손대지 않는다 — 이 사이트는 11곳 중 유일하게 판정식 수정이 필요 없다.
      const { text: src, error: srcError } = readRepoTextSafe("scripts/validate-plugin.mjs");
      if (srcError !== null) console.log(`    실제: ${srcError}`);
      const m = src === null ? null : src.match(/const layers = (\[[^\]]*\]);/);
      let copy = null;
      if (m) {
        try {
          copy = JSON.parse(m[1].replace(/'/g, '"'));
        } catch {
          copy = null;
        }
      }
      const ok = Array.isArray(copy) && JSON.stringify(copy) === JSON.stringify(KNOWN_LAYERS);
      if (!ok) console.log(`    실제: validate-plugin 사본=${JSON.stringify(copy)} verify-evidence 정본=${JSON.stringify(KNOWN_LAYERS)}`);
      report(ok, "(A34) validate-plugin.mjs의 계층 enum 하드코딩 사본이 verify-evidence.mjs의 KNOWN_LAYERS와 동일(드리프트 가드)");
    }
  } finally {
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      /* 정리 실패는 검사 결과에 영향을 주지 않는다 */
    }
  }
}

function runVerifyEvidenceSmoke() {
  console.log("[verify-evidence 스모크] scripts/verify-evidence.mjs — (a)(b)(c)축·머지 규칙·도구 오류·옵트인 스니펫·(d)축");

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-verify-"));
  try {
    const dirs = {
      multiAuthor: path.join(tmpBase, "multiAuthor"),
      botCommits: path.join(tmpBase, "botCommits"),
      merge: path.join(tmpBase, "merge"),
      rename: path.join(tmpBase, "rename"),
      del: path.join(tmpBase, "delete"),
      toolErrorNonGit: path.join(tmpBase, "toolErrorNonGit"),
      toolErrorCorrupted: path.join(tmpBase, "toolErrorCorrupted"),
      optInSnippet: path.join(tmpBase, "optInSnippet"),
    };

    const multiAuthorFx = buildMultiAuthor(dirs.multiAuthor);
    const botCommitsFx = buildBotCommits(dirs.botCommits);
    const mergeFx = buildMerge(dirs.merge);
    const renameFx = buildRename(dirs.rename);
    const deleteFx = buildDelete(dirs.del);
    buildToolErrorNonGit(dirs.toolErrorNonGit);
    const corruptedFx = buildToolErrorCorrupted(dirs.toolErrorCorrupted);
    const snippetFx = buildOptInSnippet(dirs.optInSnippet);

    const collect = (repoPath, opts = {}) =>
      collectGitFacts({
        repoPath,
        selectedIdentities: [OWNER_EMAIL],
        ref: "HEAD",
        mergeIncluded: false,
        maxCommits: 1000,
        ...opts,
      }).evidence;

    // ---- (1) 원장에 없는 가짜 40자 hex 인용 → 반드시 FAIL ----
    {
      const evidence = collect(dirs.multiAuthor);
      const fakeSha = "d".repeat(40);
      const r = verifyCitation({
        repoPath: dirs.multiAuthor,
        evidence,
        selectedIdentities: [OWNER_EMAIL],
        ledgerId: `commit:${fakeSha}`,
      });
      const ok = r.verdict === "FAIL" && r.code === "CITATION_COMMIT_NOT_FOUND_IN_REPO";
      if (!ok) console.log(`    실제: ${JSON.stringify(r)}`);
      report(ok, "(1) 원장에 없는 가짜 40자 hex 인용 → FAIL(CITATION_COMMIT_NOT_FOUND_IN_REPO, AC-8 100% 탐지)");
    }

    // ---- (2) 타 저자 커밋 인용(Alice) → (a)축 FAIL ----
    {
      const evidence = collect(dirs.multiAuthor);
      const aliceEntry = findEntryByRealAuthor(dirs.multiAuthor, evidence, ALICE_EMAIL);
      const r = verifyCitation({
        repoPath: dirs.multiAuthor,
        evidence,
        selectedIdentities: [OWNER_EMAIL],
        ledgerId: aliceEntry.id,
      });
      const ok = r.verdict === "FAIL" && r.code === "CITATION_EXCLUDED_COMMIT" && aliceEntry.excluded === true;
      if (!ok) console.log(`    실제: ${JSON.stringify(r)}, aliceEntry.excluded=${aliceEntry.excluded}`);
      report(ok, "(2a) 타 저자(Alice) 커밋 인용 → (a)축 FAIL(CITATION_EXCLUDED_COMMIT)");
    }

    // ---- (2) 봇 커밋 인용 → (a)축 FAIL ----
    {
      const evidence = collect(dirs.botCommits);
      const botEntry = evidence.commits.find((c) => c.exclusionReason === "bot-pattern");
      const r = verifyCitation({
        repoPath: dirs.botCommits,
        evidence,
        selectedIdentities: [OWNER_EMAIL],
        ledgerId: botEntry.id,
      });
      const ok = r.verdict === "FAIL" && r.code === "CITATION_EXCLUDED_COMMIT";
      if (!ok) console.log(`    실제: ${JSON.stringify(r)}`);
      report(ok, "(2b) 봇 커밋 인용 → (a)축 FAIL(CITATION_EXCLUDED_COMMIT, exclusionReason=bot-pattern)");
    }

    // ---- (3) 삭제된 파일 경로 인용 → 정상 통과(참인 주장의 과잉 거부 금지) ----
    {
      const evidence = collect(dirs.del);
      const delEntry = evidence.commits.find((c) => c.hash === deleteFx.declared.deleteCommitHash);
      const r = verifyCitation({
        repoPath: dirs.del,
        evidence,
        selectedIdentities: [OWNER_EMAIL],
        ledgerId: delEntry.id,
        citationPath: deleteFx.declared.path,
        nodeBasis: "commit",
      });
      const ok = r.verdict === "PASS";
      if (!ok) console.log(`    실제: ${JSON.stringify(r)}`);
      report(ok, "(3) 삭제 커밋의 삭제된 경로 인용 → PASS(c축이 트리가 아니라 diff 집합으로 판정)");
    }

    // ---- (3-부가) 리네임 커밋의 path/oldPath 양쪽 인용 → 둘 다 PASS ----
    {
      const evidence = collect(dirs.rename);
      const renEntry = evidence.commits.find((c) => c.hash === renameFx.declared.renameCommitHash);
      const rNew = verifyCitation({ repoPath: dirs.rename, evidence, selectedIdentities: [OWNER_EMAIL], ledgerId: renEntry.id, citationPath: renameFx.declared.path });
      const rOld = verifyCitation({ repoPath: dirs.rename, evidence, selectedIdentities: [OWNER_EMAIL], ledgerId: renEntry.id, citationPath: renameFx.declared.oldPath });
      const ok = rNew.verdict === "PASS" && rOld.verdict === "PASS";
      if (!ok) console.log(`    실제: new=${JSON.stringify(rNew)} old=${JSON.stringify(rOld)}`);
      report(ok, "(3-부가) 리네임 커밋의 새 경로·이전 경로(oldPath) 인용 → 둘 다 PASS");
    }

    // ---- (3-c) 이월 게이트 B-4: changeType 오라클. 임무 지침 3: "make-fixture.mjs
    // 선언값의 changeType을 리네임 R→A, 삭제 D→M으로 바꿔도 스모크가 통과한다
    // (경로 쪽 선언값 대조는 살아 있다). AC-17이 요구한 대조의 나머지 절을
    // 채워라." — (3-부가)는 path/oldPath의 "소속 여부"(verifyCitation PASS)만
    // 확인했을 뿐 changeType 필드 자체를 declared 값과 대조하지 않았다. 여기서
    // evidence.json의 files[] 항목을 make-fixture.mjs의 declared 값과 changeType
    // 까지 포함해 직접 대조하고(골든·AC-7 집합 동치와 독립한 유일한 오라클),
    // R→A·D→M 변이가 실제로 이 대조를 FAIL시키는지 관측한다.
    {
      const renEvidence = collect(dirs.rename);
      const renameEntry = findFileEntryByPath(renEvidence, renameFx.declared.renameCommitHash, renameFx.declared.path);
      const renameMismatches = declaredFileChangeMismatches(renameEntry, renameFx.declared);
      if (renameMismatches.length > 0) console.log(`    실제(rename): ${JSON.stringify(renameMismatches)}`);
      report(
        renameMismatches.length === 0,
        "(3-c-i) B-4: 리네임 커밋의 changeType/path/oldPath가 make-fixture.mjs declared 값(changeType=R)과 완전 일치"
      );

      const delEvidence2 = collect(dirs.del);
      const deleteEntry = findFileEntryByPath(delEvidence2, deleteFx.declared.deleteCommitHash, deleteFx.declared.path);
      const deleteMismatches = declaredFileChangeMismatches(deleteEntry, deleteFx.declared);
      if (deleteMismatches.length > 0) console.log(`    실제(delete): ${JSON.stringify(deleteMismatches)}`);
      report(
        deleteMismatches.length === 0,
        "(3-c-ii) B-4: 삭제 커밋의 changeType/path가 make-fixture.mjs declared 값(changeType=D)과 완전 일치"
      );

      // 변이 관측(임무 지침 3의 사고 실험을 그대로 재현): changeType만 바꾼
      // 사본을 만들어, 이 대조가 실제로 그 변이를 잡는지 확인한다 — 잡지
      // 못하면 "declared.changeType을 R→A/D→M으로 바꿔도 스모크가 통과한다"는
      // 지적이 그대로 남는다.
      const mutatedRename = { ...renameEntry, changeType: "A" }; // R→A
      const mutatedRenameMismatches = declaredFileChangeMismatches(mutatedRename, renameFx.declared);
      const okRenameMutation = mutatedRenameMismatches.some((m) => m.startsWith("changeType"));
      if (!okRenameMutation) console.log(`    실제(rename 변이 R→A): ${JSON.stringify(mutatedRenameMismatches)}`);
      report(
        okRenameMutation,
        "(3-c-iii) 변이 관측(임무 지침 3): 리네임 항목의 changeType을 R→A로 바꾸면 B-4 대조가 FAIL을 냄(이전에는 미탐지)"
      );

      const mutatedDelete = { ...deleteEntry, changeType: "M" }; // D→M
      const mutatedDeleteMismatches = declaredFileChangeMismatches(mutatedDelete, deleteFx.declared);
      const okDeleteMutation = mutatedDeleteMismatches.some((m) => m.startsWith("changeType"));
      if (!okDeleteMutation) console.log(`    실제(delete 변이 D→M): ${JSON.stringify(mutatedDeleteMismatches)}`);
      report(
        okDeleteMutation,
        "(3-c-iv) 변이 관측(임무 지침 3): 삭제 항목의 changeType을 D→M으로 바꾸면 B-4 대조가 FAIL을 냄(이전에는 미탐지)"
      );
    }

    // ---- (4) 머지 해시를 basis:commit 근거로 인용 → FAIL, 같은 해시를 inference로 인용 → PASS ----
    // 임무 지침 2: "머지 해시 basis 규칙이 좁게 집행된다 — nodeBasis==='commit'일
    // 때만 막는데, 스펙은 '머지 해시는 inference 근거로만 허용'이다." spec.md §2
    // 원문("basis: commit(정량 주장)의 근거로 쓸 수 없으며 inference만 허용한다")과
    // AC-7 원문("머지 해시는 inference 근거로만 허용된다")을 문언 그대로 읽으면
    // "inference만" = "inference 외 전부 금지"다 — commit 하나만 막으면
    // external·insufficient·미지정(basis 필드 누락)으로 우회하는 인용이 전부
    // 통과해 버리므로(실측됨), 아래 네 가지 basis(commit/external/insufficient/
    // 미지정)를 전부 FAIL로, inference 하나만 PASS로 관측한다(상보 조건 집행).
    {
      const evidence = collect(dirs.merge, { mergeIncluded: true });
      const mergeEntry = evidence.commits.find((c) => c.hash === mergeFx.declared.mergeCommitHash);
      const verify = (nodeBasis) =>
        verifyCitation({ repoPath: dirs.merge, evidence, selectedIdentities: [OWNER_EMAIL], ledgerId: mergeEntry.id, nodeBasis });

      const rCommitBasis = verify("commit");
      const rExternalBasis = verify("external");
      const rInsufficientBasis = verify("insufficient");
      const rUnspecifiedBasis = verify(null);
      const rInferenceBasis = verify("inference");

      const allNonInferenceFail = [rCommitBasis, rExternalBasis, rInsufficientBasis, rUnspecifiedBasis].every(
        (r) => r.verdict === "FAIL" && r.code === "CITATION_MERGE_HASH_NON_INFERENCE_BASIS_FORBIDDEN"
      );
      const ok = allNonInferenceFail && rInferenceBasis.verdict === "PASS";
      if (!ok) {
        console.log(
          `    실제: commit=${JSON.stringify(rCommitBasis)} external=${JSON.stringify(rExternalBasis)} ` +
          `insufficient=${JSON.stringify(rInsufficientBasis)} unspecified=${JSON.stringify(rUnspecifiedBasis)} ` +
          `inference=${JSON.stringify(rInferenceBasis)}`
        );
      }
      report(
        ok,
        "(4) 머지 해시 인용: basis가 commit/external/insufficient/미지정이면 전부 FAIL(NON_INFERENCE_BASIS_FORBIDDEN), " +
        "basis:inference만 PASS(임무 지침 2 — 문언 '…만 허용'을 상보 조건으로 집행)"
      );
    }

    // ---- (4-부가) 머지 제외 설정에서 머지 해시 인용 → (a)축 FAIL(제외 커밋) ----
    {
      const evidence = collect(dirs.merge, { mergeIncluded: false });
      const mergeEntry = evidence.commits.find((c) => c.hash === mergeFx.declared.mergeCommitHash);
      const r = verifyCitation({
        repoPath: dirs.merge,
        evidence,
        selectedIdentities: [OWNER_EMAIL],
        ledgerId: mergeEntry.id,
        nodeBasis: "inference",
      });
      const ok = r.verdict === "FAIL" && r.code === "CITATION_EXCLUDED_COMMIT" && mergeEntry.exclusionReason === "merge-excluded";
      if (!ok) console.log(`    실제: ${JSON.stringify(r)}`);
      report(ok, "(4-부가) 머지 제외 설정에서 머지 해시 인용 → (a)축 FAIL(exclusionReason=merge-excluded), basis 규칙과 다른 사유");
    }

    // ---- (4-b) AC-7 집합 동치 — 임무 지침 1: "verifyCitation은 인용된 경로
    // 1건의 소속 여부만 본다. 집합 비교를 구현하라." verifyMergeFileSetEquivalence가
    // 머지 커밋의 원장 files[] 집합과 git.mjs 재계산 diff 집합을 비교한다.
    // 머지 포함·제외 두 설정 모두에서 수행(AC-7 원문)해 참인 원장에 오탐
    // 0건임을 확인하고, 원장 files[]를 변이해(항목 1건 누락) 실제 FAIL을
    // 관측한다(절대 규칙).
    {
      const evidenceIncluded = collect(dirs.merge, { mergeIncluded: true });
      const evidenceExcluded = collect(dirs.merge, { mergeIncluded: false });

      const resultsIncluded = verifyMergeFileSetEquivalence({ repoPath: dirs.merge, evidence: evidenceIncluded });
      const resultsExcluded = verifyMergeFileSetEquivalence({ repoPath: dirs.merge, evidence: evidenceExcluded });

      const okRegression =
        resultsIncluded.length === 1 && resultsIncluded[0].verdict === "PASS" &&
        resultsExcluded.length === 1 && resultsExcluded[0].verdict === "PASS";
      if (!okRegression) {
        console.log(`    실제(included): ${JSON.stringify(resultsIncluded)}`);
        console.log(`    실제(excluded): ${JSON.stringify(resultsExcluded)}`);
      }
      report(
        okRegression,
        "(4-b-i) 무오탐: merge 픽스처의 실제 원장(머지 포함·제외 두 설정 모두) → 집합 동치 위반 0건"
      );

      // 변이: 머지 커밋의 files[]에서 항목 1건을 제거해(원장 직렬화 누락 재현)
      // 집합 동치 검사가 실제로 FAIL을 내는지 관측한다.
      const mutated = structuredClone(evidenceIncluded);
      const mergeCommitMutated = mutated.commits.find((c) => c.isMerge === true);
      const droppedFile = mergeCommitMutated.files.pop(); // 항목 1건 누락
      const mutatedResults = verifyMergeFileSetEquivalence({ repoPath: dirs.merge, evidence: mutated });
      const okMutation =
        mutatedResults.length === 1 &&
        mutatedResults[0].verdict === "FAIL" &&
        mutatedResults[0].code === "MERGE_FILESET_SET_MISMATCH" &&
        mutatedResults[0].missingInLedger.includes(droppedFile.path);
      if (!okMutation) console.log(`    실제(변이): ${JSON.stringify(mutatedResults)} droppedFile=${JSON.stringify(droppedFile)}`);
      report(
        okMutation,
        "(4-b-ii) 변이 관측: 머지 커밋 files[]에서 항목 1건 제거 → MERGE_FILESET_SET_MISMATCH FAIL(missingInLedger에 누락 경로 포함)"
      );

      // verifyEvidence() 오케스트레이션도 (e)축을 반영해 ok=false로 떨어지는지 확인.
      const orchestrated = verifyEvidence({
        repoPath: dirs.merge,
        evidence: mutated,
        selectedIdentities: [OWNER_EMAIL],
        artifactsByLayer: {},
      });
      const okOrchestration =
        orchestrated.ok === false &&
        orchestrated.summary.mergeFileSetViolations === 1 &&
        orchestrated.mergeFileSetViolations[0].code === "MERGE_FILESET_SET_MISMATCH";
      if (!okOrchestration) console.log(`    실제(오케스트레이션): ${JSON.stringify(orchestrated.summary)}`);
      report(okOrchestration, "(4-b-iii) verifyEvidence() 오케스트레이션이 (e)축 위반을 집계해 ok=false를 반환");
    }

    // ---- (5) 손상된 레포/비-git 디렉터리 → 도구 오류로 분류(인용 FAIL 미집계) ----
    {
      const fakeEvidence = { commits: [] };
      const anySha = "a".repeat(40);
      const r = verifyCitation({
        repoPath: dirs.toolErrorNonGit,
        evidence: fakeEvidence,
        selectedIdentities: [OWNER_EMAIL],
        ledgerId: `commit:${anySha}`,
      });
      const ok = r.verdict === "TOOL_ERROR" && r.code === "CITATION_GIT_TOOL_ERROR";
      if (!ok) console.log(`    실제: ${JSON.stringify(r)}`);
      report(ok, "(5a) 비-git 디렉터리 대상 인용 → TOOL_ERROR(인용 FAIL 미집계)");
    }
    // (5b) 손상된 loose object. 실측 확인(scratchpad): `git rev-parse --verify
    // --quiet <corrupted>^{commit}`는 exit 1("error: object file ... is
    // empty")을 낸다 — exit 1은 (exit code, stderr 패턴) 3분류상 stderr 패턴과
    // 무관하게 항상 lookup-failed이므로((b)축에 --quiet를 붙인 설계 의도 그대로),
    // 이 경로에서는 손상된 커밋도 "인용 FAIL"로 정상 분류된다(도구 오류가
    // 아니라 검증 불가능한 인용으로 안전하게 거부하는 쪽이 맞다). 반면
    // `git cat-file -e <corrupted>:<path>`는 exit 128 + "path ... exists on
    // disk, but not in '<sha>'"를 내는데, 이 메시지는 조회 실패 패턴 4종
    // (bad object / unknown revision / Needed a single revision / does not
    // exist in) 중 어느 것과도 일치하지 않아 도구 오류로 분류된다 — 옵트인
    // 스니펫 경로(verifySnippetCitation)가 실제로 도구 오류 분기를 낸다.
    {
      const rCitation = verifyCitation({
        repoPath: dirs.toolErrorCorrupted,
        evidence: { commits: [] },
        selectedIdentities: [OWNER_EMAIL],
        ledgerId: `commit:${corruptedFx.declared.corruptedCommitHash}`,
      });
      const okCitation = rCitation.verdict === "FAIL" && rCitation.code === "CITATION_COMMIT_NOT_FOUND_IN_REPO";
      if (!okCitation) console.log(`    실제(citation): ${JSON.stringify(rCitation)}`);
      report(okCitation, "(5b-i) 손상된 커밋 인용의 (b)축: --quiet 정규화로 exit 1 → FAIL(lookup-failed, 도구 오류 아님 — 설계대로)");

      const fakeEvidence = {
        commits: [
          {
            id: `commit:${corruptedFx.declared.corruptedCommitHash}`,
            hash: corruptedFx.declared.corruptedCommitHash,
            authorEmail: OWNER_EMAIL,
            parents: [],
            isMerge: false,
            excluded: false,
            exclusionReason: null,
            files: [{ path: "a.txt", oldPath: null, changeType: "A", insertions: 1, deletions: 0, binary: false, viaMerge: false }],
          },
        ],
      };
      const rSnippet = verifySnippetCitation({
        repoPath: dirs.toolErrorCorrupted,
        evidence: fakeEvidence,
        ledgerId: `commit:${corruptedFx.declared.corruptedCommitHash}`,
        snippetPath: "a.txt",
      });
      const okSnippet = rSnippet.verdict === "TOOL_ERROR" && rSnippet.code === "CITATION_SNIPPET_GIT_TOOL_ERROR";
      if (!okSnippet) console.log(`    실제(snippet): ${JSON.stringify(rSnippet)}`);
      report(okSnippet, "(5b-ii) 손상된 커밋에 대한 cat-file -e <sha>:<path> → TOOL_ERROR(128, 조회 실패 패턴 불일치, 인용 FAIL 미집계)");
    }

    // ---- (6) 콜드 리뷰 M(A-8) 대응: (a)축 저자 오라클 — 원장 authorEmail을
    // 조작해도 git 실측 저자와 대조돼 뚫리지 않는지 관측한다. 실패 시나리오
    // 재현: 동료(Alice) 커밋의 excluded를 false로, authorEmail을 본인
    // 이메일로 3필드 편집하면 예전에는 (a)축이 원장만 신뢰해 그대로 PASS
    // 했다(콜드 리뷰 실측). 이제는 git show가 돌려준 실제 저자(alice@…)와
    // 원장의 조작된 authorEmail이 달라 CITATION_LEDGER_AUTHOR_MISMATCH로
    // FAIL해야 한다.
    {
      const evidence = collect(dirs.multiAuthor);
      const aliceEntry = findEntryByRealAuthor(dirs.multiAuthor, evidence, ALICE_EMAIL);
      const tampered = structuredClone(evidence);
      const tamperedAlice = tampered.commits.find((c) => c.hash === aliceEntry.hash);
      tamperedAlice.excluded = false; // 실패 시나리오 3필드 편집 재현
      tamperedAlice.exclusionReason = null;
      tamperedAlice.authorEmail = OWNER_EMAIL; // 동료 커밋을 "본인 것"으로 위장

      const r = verifyCitation({
        repoPath: dirs.multiAuthor,
        evidence: tampered,
        selectedIdentities: [OWNER_EMAIL],
        ledgerId: tamperedAlice.id,
      });
      const ok = r.verdict === "FAIL" && r.code === "CITATION_LEDGER_AUTHOR_MISMATCH";
      if (!ok) console.log(`    실제: ${JSON.stringify(r)}`);
      report(
        ok,
        "(6) A-8: 원장 excluded/exclusionReason/authorEmail 3필드를 조작해(동료 커밋→본인 것으로 위장) " +
        "excluded 체크를 우회해도 git 실측 저자와 불일치해 CITATION_LEDGER_AUTHOR_MISMATCH로 FAIL(원장 조작 방어)"
      );

      // 대조군: git.mjs 오라클 자체가 실제로 Alice의 진짜 이메일을 돌려주는지
      // 직접 확인(위 FAIL이 우연이 아니라 오라클이 실제로 다른 값을 낸다는
      // 근거).
      const oracle = getCommitAuthorAndParents(dirs.multiAuthor, aliceEntry.hash);
      const okOracle = oracle.outcome === "ok" && oracle.authorEmail === ALICE_EMAIL;
      if (!okOracle) console.log(`    실제(oracle): ${JSON.stringify(oracle)}`);
      report(okOracle, "(6-부가) git.mjs getCommitAuthorAndParents가 Alice 커밋의 실제 저자(alice@…)를 정확히 반환");

      // 무오탐 대조군: 조작되지 않은 원장(authorEmail이 실제 저자와 일치)에서는
      // 여전히 정상 판정(EXCLUDED_COMMIT — excluded가 그대로 true)이 나야 한다.
      const rUntampered = verifyCitation({
        repoPath: dirs.multiAuthor,
        evidence,
        selectedIdentities: [OWNER_EMAIL],
        ledgerId: aliceEntry.id,
      });
      const okUntampered = rUntampered.verdict === "FAIL" && rUntampered.code === "CITATION_EXCLUDED_COMMIT";
      if (!okUntampered) console.log(`    실제(무오탐): ${JSON.stringify(rUntampered)}`);
      report(okUntampered, "(6-무오탐) 조작되지 않은 원장에서는 authorEmail 대조가 새 FAIL을 만들지 않음(EXCLUDED_COMMIT 그대로)");
    }

    // ---- (7) 콜드 리뷰 M(A-20) 대응: 머지 판정 정본을 parents로 고정 —
    // 원장 isMerge 플래그 하나만 true→false로 바꿔도(parents는 그대로 2건)
    // 머지 해시 basis 규칙과 AC-7 집합 동치 검사가 더 이상 우회되지 않는지
    // 관측한다(콜드 리뷰 실측 재현: 예전에는 이 조작 하나로 두 검사가 동시에
    // 무력화됐다).
    {
      const evidence = collect(dirs.merge, { mergeIncluded: true });
      const mergeEntry = evidence.commits.find((c) => c.hash === mergeFx.declared.mergeCommitHash);

      const tampered = structuredClone(evidence);
      const tamperedMerge = tampered.commits.find((c) => c.hash === mergeFx.declared.mergeCommitHash);
      tamperedMerge.isMerge = false; // parents는 그대로 2건 — 플래그만 조작

      // 조작 전제 확인: parents는 여전히 2건이므로 isMergeCommit(parents)의
      // 정본 판정으로는 여전히 머지다(플래그만 거짓말을 하고 있는 상태).
      const okPremise = tamperedMerge.parents.length === 2 && isMergeCommit(tamperedMerge.parents) === true && tamperedMerge.isMerge === false;
      if (!okPremise) console.log(`    실제(전제): parents=${JSON.stringify(tamperedMerge.parents)} isMerge=${tamperedMerge.isMerge}`);
      report(okPremise, "(7-전제) 조작 확인: parents는 2건 그대로(isMergeCommit(parents)===true)인데 isMerge 플래그만 false");

      // (7a) 머지 해시 basis:commit 규칙 — isMerge 플래그가 false여도 여전히 FAIL.
      const rBasisRule = verifyCitation({
        repoPath: dirs.merge,
        evidence: tampered,
        selectedIdentities: [OWNER_EMAIL],
        ledgerId: mergeEntry.id,
        nodeBasis: "commit",
      });
      const okBasisRule = rBasisRule.verdict === "FAIL" && rBasisRule.code === "CITATION_MERGE_HASH_NON_INFERENCE_BASIS_FORBIDDEN";
      if (!okBasisRule) console.log(`    실제(7a): ${JSON.stringify(rBasisRule)}`);
      report(
        okBasisRule,
        "(7a) A-20: 원장 isMerge:true→false로 조작해도(parents는 2건 그대로) 머지 해시 basis:commit 규칙이 " +
        "여전히 FAIL(isMergeCommit(parents)가 정본 — 플래그 단독 조작으로 우회 불가)"
      );

      // (7b) AC-7 집합 동치 검사 — isMerge:false로 조작하면 예전에는 검사 자체가
      // 스킵됐다(mergeFileSetChecked: 1→0). 이제는 parents 기준으로 여전히
      // 실행되는지 files[] 항목 1건을 추가로 제거해(원장 직렬화 누락 재현)
      // 실제로 MISMATCH를 잡는지까지 확인한다(스킵됐다면 결과가 아예 안 나온다).
      const droppedFile = tamperedMerge.files.pop();
      const mergeResults = verifyMergeFileSetEquivalence({ repoPath: dirs.merge, evidence: tampered });
      const okMergeCheck =
        mergeResults.length === 1 &&
        mergeResults[0].verdict === "FAIL" &&
        mergeResults[0].code === "MERGE_FILESET_SET_MISMATCH" &&
        mergeResults[0].missingInLedger.includes(droppedFile.path);
      if (!okMergeCheck) console.log(`    실제(7b): ${JSON.stringify(mergeResults)}`);
      report(
        okMergeCheck,
        "(7b) A-20: isMerge:false로 조작된 머지 커밋도 AC-7 집합 동치 검사가 여전히 실행됨(스킵되지 않음) — " +
        "isMergeCommit(parents) 기준이므로 files[] 누락을 그대로 잡는다(mergeFileSetChecked가 0으로 떨어지지 않음)"
      );
    }

    // ---- (8) 콜드 리뷰 M(A-15) 대응: 캐시 재사용 — 동일 (repoPath,sha) 인용을
    // 반복 검증해도 캐시 Map 크기가 늘지 않는지(=git 프로세스가 매번 새로
    // 스폰되지 않는지) 관측한다.
    {
      const evidence = collect(dirs.multiAuthor);
      const ownerEntry = evidence.commits.find((c) => c.authorEmail === OWNER_EMAIL);
      const cache = createVerificationCache();
      for (let i = 0; i < 5; i++) {
        verifyCitation({
          repoPath: dirs.multiAuthor,
          evidence,
          selectedIdentities: [OWNER_EMAIL],
          ledgerId: ownerEntry.id,
          citationPath: "a.txt",
          cache,
        });
      }
      const ok = cache.authorParents.size === 1 && cache.fileChanges.size === 1;
      if (!ok) console.log(`    실제: authorParents.size=${cache.authorParents.size} fileChanges.size=${cache.fileChanges.size}`);
      report(
        ok,
        "(8) A-15: 같은 (repoPath,sha) 인용을 캐시 공유로 5회 검증해도 " +
        "authorParents/fileChanges 캐시 Map 크기가 1로 유지됨(호출마다 새 git 프로세스를 스폰하지 않음)"
      );

      // verifyEvidence() 오케스트레이션도 내부에서 만든 캐시(또는 넘겨받은
      // 캐시)를 인용 루프 전체에 공유하는지 확인한다 — 같은 커밋·경로를
      // 3개 노드가 인용해도 캐시 크기는 1이어야 한다.
      const sharedCache = createVerificationCache();
      const career = {
        nodes: [
          { id: "car:1", basis: "commit", evidence: [{ ledgerId: ownerEntry.id, path: "a.txt" }] },
          { id: "car:2", basis: "commit", evidence: [{ ledgerId: ownerEntry.id, path: "a.txt" }] },
          { id: "car:3", basis: "commit", evidence: [{ ledgerId: ownerEntry.id, path: "a.txt" }] },
        ],
      };
      const orchestrated = verifyEvidence({
        repoPath: dirs.multiAuthor,
        evidence,
        selectedIdentities: [OWNER_EMAIL],
        artifactsByLayer: { career },
        cache: sharedCache,
      });
      const okShared =
        orchestrated.summary.passCitations === 3 &&
        sharedCache.authorParents.size === 1 &&
        sharedCache.fileChanges.size === 1;
      if (!okShared) {
        console.log(`    실제(공유): pass=${orchestrated.summary.passCitations} authorParents.size=${sharedCache.authorParents.size} fileChanges.size=${sharedCache.fileChanges.size}`);
      }
      report(
        okShared,
        "(8-부가) verifyEvidence()에 넘긴 캐시가 3개 노드의 동일 커밋·경로 인용 전체에 공유됨(캐시 Map 크기 1)"
      );
    }

    // ---- (9) 콜드 리뷰 M(A-22) 대응: case-17 골든이 실제로 의도한 코드로
    // FAIL하는지 확인한다 — 필드명이 evidenceId였을 때는 CITATION_MALFORMED_LEDGER_ID
    // (엉뚱한 이유)로 FAIL했다. ledgerId로 고친 뒤에는 basis:commit + 머지
    // 해시 규칙 위반 코드(CITATION_MERGE_HASH_NON_INFERENCE_BASIS_FORBIDDEN)로
    // FAIL해야 "탐지"로 채점된다(파일 자신의 expectedVerifierOutcome 문구 그대로).
    {
      const injection = buildCase17MergeHashInjection(mergeFx.declared);
      const evidence = collect(dirs.merge, { mergeIncluded: true }); // 실행 설정: mergeIncluded:true
      const citation = injection.node.evidence[0];
      const r = verifyCitation({
        repoPath: dirs.merge,
        evidence,
        selectedIdentities: [OWNER_EMAIL],
        ledgerId: citation.ledgerId,
        citationPath: citation.path ?? null,
        nodeBasis: injection.node.basis,
      });
      const ok = r.verdict === "FAIL" && r.code === "CITATION_MERGE_HASH_NON_INFERENCE_BASIS_FORBIDDEN";
      if (!ok) console.log(`    실제: ${JSON.stringify(r)}`);
      report(
        ok,
        "(9) A-22: case-17 주입 노드(evidence[].ledgerId 필드명 수정 후)가 CITATION_MALFORMED_LEDGER_ID가 아니라 " +
        "의도한 CITATION_MERGE_HASH_NON_INFERENCE_BASIS_FORBIDDEN으로 FAIL(AC-7 대표 재현 케이스가 올바른 이유로 탐지됨)"
      );

      // fixtures/golden/case-17-merge-hash-claim.json 골든 파일 자체도 같은
      // 결과를 내는지 확인한다(생성기와 커밋된 골든이 드리프트하지 않음).
      const GOLDEN_CASE17_REL = "fixtures/golden/case-17-merge-hash-claim.json";
      const { json: golden, error: goldenError } = readRepoJsonSafe(GOLDEN_CASE17_REL);
      if (goldenError !== null) console.log(`    실제: ${goldenError}`);
      // 판독 실패 시 `verifyCitation`을 부르지 않는다 — 골든이 null이면 `golden.node`가
      // TypeError로 터진다. 아래 판정은 양수 방향(`verdict === "FAIL" && code === …`)이라
      // `rGolden`이 null이면 자연히 false가 된다.
      const goldenCitation = golden?.node?.evidence?.[0];
      const rGolden = goldenCitation === undefined ? null : verifyCitation({
        repoPath: dirs.merge,
        evidence,
        selectedIdentities: [OWNER_EMAIL],
        ledgerId: goldenCitation.ledgerId,
        nodeBasis: golden.node.basis,
      });
      const okGolden = rGolden?.verdict === "FAIL" && rGolden?.code === "CITATION_MERGE_HASH_NON_INFERENCE_BASIS_FORBIDDEN";
      if (!okGolden) console.log(`    실제(골든 파일): ${JSON.stringify(rGolden)}`);
      report(okGolden, "(9-부가) 커밋된 fixtures/golden/case-17-merge-hash-claim.json 자체도 같은 결과로 FAIL(생성기-골든 드리프트 없음)");
    }

    // ---- (10) 콜드 리뷰 C4(Critical) 대응: fail-open 제거 — 인용 100%가
    // TOOL_ERROR(도구 오류)뿐이고 확정 위반이 0건이어도 status가 "PASS"가
    // 되지 않는지, exit 코드가 0이 아닌지 관측한다(실패 시나리오 재현:
    // --repo 오타/비-git 디렉터리 → 예전에는 [PASS] + exit 0).
    {
      const anySha = "a".repeat(40);
      const career = {
        nodes: [{ id: "car:only", basis: "commit", evidence: [{ ledgerId: `commit:${anySha}` }] }],
      };
      const report_ = verifyEvidence({
        repoPath: dirs.toolErrorNonGit,
        evidence: { commits: [] },
        selectedIdentities: [OWNER_EMAIL],
        artifactsByLayer: { career },
      });
      const ok =
        report_.status === "INCONCLUSIVE" &&
        report_.ok === false &&
        report_.summary.totalCitations === 1 &&
        report_.summary.passCitations === 0 &&
        report_.summary.failCitations === 0 &&
        report_.summary.toolErrorCitations === 1 &&
        report_.summary.unverifiedCitations === 1 &&
        exitCodeForReport(report_) === 2;
      if (!ok) console.log(`    실제: status=${report_.status} ok=${report_.ok} summary=${JSON.stringify(report_.summary)} exit=${exitCodeForReport(report_)}`);
      report(
        ok,
        "(10) C4: 인용 전량이 도구 오류(비-git 디렉터리)뿐이면 status=INCONCLUSIVE·ok=false·exit=2 " +
        "(예전에는 violations.length===0이라는 이유만으로 [PASS]+exit 0이 나왔다 — 가짜 해시가 그대로 통과)"
      );

      // (10-부가) 도구 오류와 확정 FAIL이 같은 검증 실행에 섞이면 FAIL이
      // 우선한다(더 강한 신호를 숨기지 않는다) — exit 1. 실제 git 프로세스가
      // "tool-error"를 내는 경로는 (5a)/(10)에서 이미 별도로 실증했으므로,
      // 여기서는 그 결과 형태를 캐시에 직접 심어(createVerificationCache()가
      // 노출하는 공개 확장점 — verifyCitation은 캐시 히트 여부만 보고 그
      // 값이 실제 git 호출에서 왔는지 구분하지 않는다) 실제 repo(dirs.
      // multiAuthor)에서 Alice 인용이 진짜 FAIL을 내는 것과 동시에 발생하는
      // 상황을 재현한다 — verifyEvidence()의 상태 "우선순위 집계 로직" 자체를
      // 검증하는 것이 목적이다(도구 오류 재현 자체는 이미 다른 절에서 실증됨).
      const evidenceForMixed = collect(dirs.multiAuthor);
      const aliceEntry = findEntryByRealAuthor(dirs.multiAuthor, evidenceForMixed, ALICE_EMAIL);
      const fakeToolErrorSha = "b".repeat(40);
      const mixedCache = createVerificationCache();
      mixedCache.authorParents.set(verificationCacheKey(dirs.multiAuthor, fakeToolErrorSha), {
        outcome: "tool-error",
        status: -1,
        stderr: "synthetic tool error for (10-부가) priority test",
        authorEmail: null,
        parents: null,
      });
      const mixedCareer = {
        nodes: [
          { id: "car:toolerr", basis: "commit", evidence: [{ ledgerId: `commit:${fakeToolErrorSha}` }] },
          { id: "car:realfail", basis: "commit", evidence: [{ ledgerId: aliceEntry.id }] },
        ],
      };
      const mixedReport = verifyEvidence({
        repoPath: dirs.multiAuthor,
        evidence: evidenceForMixed,
        selectedIdentities: [OWNER_EMAIL],
        artifactsByLayer: { career: mixedCareer },
        cache: mixedCache,
      });
      const okMixed =
        mixedReport.status === "FAIL" &&
        exitCodeForReport(mixedReport) === 1 &&
        mixedReport.summary.toolErrorCitations === 1 &&
        mixedReport.summary.failCitations === 1;
      if (!okMixed) console.log(`    실제(혼합): status=${mixedReport.status} exit=${exitCodeForReport(mixedReport)} summary=${JSON.stringify(mixedReport.summary)}`);
      report(okMixed, "(10-부가) 도구 오류 1건 + 확정 FAIL 1건이 같이 있으면 INCONCLUSIVE가 아니라 FAIL이 우선(exit 1)");

      // (10-무오탐) 도구 오류 0건 + 위반 0건이면 여전히 PASS/exit 0(회귀 없음).
      const cleanReport = verifyEvidence({
        repoPath: dirs.multiAuthor,
        evidence: collect(dirs.multiAuthor),
        selectedIdentities: [OWNER_EMAIL],
        artifactsByLayer: {},
      });
      const okClean = cleanReport.status === "PASS" && cleanReport.ok === true && exitCodeForReport(cleanReport) === 0;
      if (!okClean) console.log(`    실제(무오탐): status=${cleanReport.status} ok=${cleanReport.ok} exit=${exitCodeForReport(cleanReport)}`);
      report(okClean, "(10-무오탐) 도구 오류·위반 둘 다 0건이면 여전히 status=PASS·exit=0(회귀 없음)");
    }

    // ---- (16) 옵트인 스니펫: git.mjs catFileExists 원시 동작 양쪽 분기 관측 ----
    {
      const existsR = catFileExists(dirs.optInSnippet, snippetFx.declared.existsAtCommit, snippetFx.declared.path);
      const deletedR = catFileExists(dirs.optInSnippet, snippetFx.declared.deletedAtCommit, snippetFx.declared.path);
      const ok = existsR.outcome === "ok" && deletedR.outcome === "lookup-failed";
      if (!ok) console.log(`    실제: exists=${JSON.stringify(existsR)} deleted=${JSON.stringify(deletedR)}`);
      report(ok, "(16) git.mjs catFileExists: 존재 시점 exit 0(ok) / 삭제 이후 exit 128 'does not exist in'→lookup-failed(도구 오류 아님)");
    }
    // ---- (16-부가) verifySnippetCitation 래퍼: 존재 시점 PASS, changeType:D 시점은 SKIPPED(스펙 명시 규칙) ----
    {
      const evidence = collect(dirs.optInSnippet);
      const existsEntry = evidence.commits.find((c) => c.hash === snippetFx.declared.existsAtCommit);
      const deletedEntry = evidence.commits.find((c) => c.hash === snippetFx.declared.deletedAtCommit);
      const rExists = verifySnippetCitation({ repoPath: dirs.optInSnippet, evidence, ledgerId: existsEntry.id, snippetPath: snippetFx.declared.path });
      const rDeleted = verifySnippetCitation({ repoPath: dirs.optInSnippet, evidence, ledgerId: deletedEntry.id, snippetPath: snippetFx.declared.path });
      const ok =
        rExists.verdict === "PASS" &&
        rDeleted.verdict === "SKIPPED" &&
        rDeleted.code === "CITATION_SNIPPET_SKIPPED_DELETED_OR_OLDPATH";
      if (!ok) console.log(`    실제: exists=${JSON.stringify(rExists)} deleted=${JSON.stringify(rDeleted)}`);
      report(ok, "(16-부가) verifySnippetCitation: 존재 시점 PASS, changeType:D 항목은 cat-file 호출 없이 SKIPPED");
    }

    // ---- (d)축: 계층 ID 참조 무결성(unresolved / unverifiable) ----
    {
      const career = { nodes: [{ id: "car:1" }, { id: "car:2" }] };
      const km = {
        nodes: [
          { id: "km:1", parentRefs: ["car:1"] },
          { id: "km:2", parentRefs: ["car:BOGUS"] },
        ],
      };
      const { violations, unverifiable } = checkLayerRefs({ career, "knowledge-map": km });
      const ok = violations.length === 1 && violations[0].code === "LAYER_REF_UNRESOLVED" && unverifiable.length === 0;
      if (!ok) console.log(`    실제: violations=${JSON.stringify(violations)} unverifiable=${JSON.stringify(unverifiable)}`);
      report(ok, "(d축) knowledge-map→career 미해결 parentRefs 1건 탐지, 해결된 참조는 위반 미집계");
    }
    {
      const km = { nodes: [{ id: "km:1", parentRefs: ["car:1"] }] };
      const { violations, unverifiable } = checkLayerRefs({ "knowledge-map": km });
      const ok = violations.length === 0 && unverifiable.length === 1 && unverifiable[0].code === "LAYER_REF_PARENT_ARTIFACT_NOT_PROVIDED";
      if (!ok) console.log(`    실제: violations=${JSON.stringify(violations)} unverifiable=${JSON.stringify(unverifiable)}`);
      report(ok, "(d축) 상위 계층 산출물 미제공 시 위반이 아니라 unverifiable로 분리 집계");
    }

    // ---- 전체 오케스트레이션: verifyEvidence()가 PASS/FAIL을 섞어 정확히 집계하는지 ----
    {
      const evidence = collect(dirs.multiAuthor);
      const ownerEntry = evidence.commits.find((c) => c.authorEmail === OWNER_EMAIL);
      const aliceEntry = findEntryByRealAuthor(dirs.multiAuthor, evidence, ALICE_EMAIL);
      const career = {
        nodes: [
          { id: "car:ok", basis: "commit", evidence: [{ ledgerId: ownerEntry.id }] },
          { id: "car:bad", basis: "commit", evidence: [{ ledgerId: aliceEntry.id }] },
        ],
      };
      const r = verifyEvidence({
        repoPath: dirs.multiAuthor,
        evidence,
        selectedIdentities: [OWNER_EMAIL],
        artifactsByLayer: { career },
      });
      const ok =
        r.ok === false &&
        r.summary.totalCitations === 2 &&
        r.summary.passCitations === 1 &&
        r.summary.failCitations === 1 &&
        r.violations[0].nodeId === "car:bad";
      if (!ok) console.log(`    실제: ${JSON.stringify(r.summary)}`);
      report(ok, "(오케스트레이션) verifyEvidence()가 PASS 1건/FAIL 1건을 정확히 집계하고 ok=false를 반환");
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

// AC-6/T-1/T-2: scripts/lib/invariants.mjs가 실제로 무언가를 잡는지, 그리고
// 참인 원장(실제 fixtures/make-fixture.mjs 산출물)에는 거짓 FAIL을 내지
// 않는지 관측한다(절대 규칙 — "새 검사마다 그것이 실제로 FAIL을 내는지
// 관측하는 테스트를 함께 만들어라"). tests/fixtures-invalid/13~16은
// --schema-check CLI 경로를 통해 각 절을 이미 격리 관측했으므로, 여기서는
// (1) CLI 경로에서는 구조 위반과 항상 동시 발생해 격리 관측이 불가능한
// T-1을 함수 직접 호출로, (2) 임의 evidence.json에는 적용할 수 없는
// AC-6 (iv) 비공허성을, (3) 실제 수집기 출력(merge/rename/delete/
// multiAuthor/botCommits 픽스처)에는 위반 0건임(회귀 방지 — 새 검사가
// 참인 원장을 오탐하면 이 프로젝트에서는 그 자체가 결함이다)을,
// (4) 임무 지침 사고 실험 M-a·M-e를 실제 수집 결과에 대한 변이로
// 재현했을 때 각각 (ii)·(i)가 잡는지를 확인한다.
function runEvidenceInvariantSmoke() {
  console.log("[AC-6/T-1/T-2 불변식 스모크] scripts/lib/invariants.mjs — 실제 FAIL 관측 + 참인 원장 무오탐");

  // ---- T-1: --schema-check 경로에서는 스키마 if/then 구조 위반과 항상
  // 동시 발생해(enum이 none|budget_commits 두 값뿐이므로) 격리 관측이
  // 불가능하다 — 함수를 직접 호출해 위반 시 실제로 FAIL을 내는지 확인한다.
  {
    const violating = { truncated: { reason: "none", dropped_commits: 5 } };
    const vViolations = checkTruncatedDroppedCommitsInvariant(violating);
    const okViolating = vViolations.length === 1 && vViolations[0].code === "EVIDENCE_INVARIANT_T1_VIOLATION";
    if (!okViolating) console.log(`    실제: ${JSON.stringify(vViolations)}`);
    report(okViolating, "T-1: reason=\"none\"인데 dropped_commits>0 → checkTruncatedDroppedCommitsInvariant가 FAIL을 냄");

    const clean = { truncated: { reason: "budget_commits", dropped_commits: 5 } };
    const cViolations = checkTruncatedDroppedCommitsInvariant(clean);
    report(cViolations.length === 0, "T-1: 정합적 값(reason=\"budget_commits\", dropped_commits>0)에는 위반 0건");
  }

  // ---- AC-6 (iv) 비공허성: 머지 없는 원장에는 VACUOUS로 FAIL, 머지가
  // 실재하는 원장에는 위반 0건. ----
  {
    const noMerge = { commits: [{ hash: "a".repeat(40), isMerge: false, parents: [] }] };
    const v = checkMergeNonVacuous(noMerge);
    const ok = v.length === 1 && v[0].code === "EVIDENCE_INVARIANT_AC6_IV_VACUOUS";
    if (!ok) console.log(`    실제: ${JSON.stringify(v)}`);
    report(ok, "AC-6 (iv): isMerge===true 커밋이 0건인 원장 → VACUOUS FAIL(비공허성 검사가 실제로 작동함)");
  }

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-invariants-"));
  try {
    const dirs = {
      merge: path.join(tmpBase, "merge"),
      rename: path.join(tmpBase, "rename"),
      del: path.join(tmpBase, "delete"),
      multiAuthor: path.join(tmpBase, "multiAuthor"),
      botCommits: path.join(tmpBase, "botCommits"),
    };
    buildMerge(dirs.merge);
    buildRename(dirs.rename);
    buildDelete(dirs.del);
    buildMultiAuthor(dirs.multiAuthor);
    buildBotCommits(dirs.botCommits);

    const collect = (repoPath, opts = {}) =>
      collectGitFacts({
        repoPath,
        selectedIdentities: [OWNER_EMAIL],
        allIdentities: true, // 회귀 검사 목적 — 타 저자/봇 커밋도 원장에 채워 넣어 다양한 형태를 본다
        ref: "HEAD",
        mergeIncluded: false,
        maxCommits: 1000,
        ...opts,
      }).evidence;

    // ---- (iv) 비공허성: merge 픽스처(머지 포함 설정)는 위반 0건. ----
    {
      const mergeEvidence = collect(dirs.merge, { mergeIncluded: true });
      const v = checkMergeNonVacuous(mergeEvidence);
      if (v.length > 0) console.log(`    실제: ${JSON.stringify(v)}`);
      report(v.length === 0, "AC-6 (iv): merge 픽스처(머지 포함 설정)의 실제 원장 → 비공허성 위반 0건");
    }

    // ---- 회귀: 참인 원장(실제 수집기 출력)에는 checkEvidenceInvariants가
    // 위반 0건이어야 한다 — 새 검사가 참을 오탐하면 그 자체가 결함이다. ----
    for (const [label, dir, opts] of [
      ["merge(머지 포함)", dirs.merge, { mergeIncluded: true }],
      ["merge(머지 제외)", dirs.merge, { mergeIncluded: false }],
      ["rename", dirs.rename, {}],
      ["delete", dirs.del, {}],
      ["multiAuthor", dirs.multiAuthor, {}],
      ["botCommits", dirs.botCommits, {}],
    ]) {
      const evidence = collect(dir, opts);
      const violations = checkEvidenceInvariants(evidence);
      if (violations.length > 0) {
        for (const v of violations) console.log(`    실제 위반: ${v.code}: ${v.message}`);
      }
      report(violations.length === 0, `무오탐: 실제 수집기 출력(${label})에 checkEvidenceInvariants 위반 0건`);
    }

    // ---- 임무 지침 사고 실험 M-a 재현: 실제 merge 픽스처 원장을 변이해
    // viaMerge:true 부여를 통째로 누락시키면 (ii)가 FAIL을 내는가. ----
    {
      const evidence = structuredClone(collect(dirs.merge, { mergeIncluded: true }));
      const mergeCommit = evidence.commits.find((c) => c.isMerge === true);
      for (const f of mergeCommit.files) f.viaMerge = false; // M-a: viaMerge 부여 누락
      const violations = checkEvidenceInvariants(evidence);
      const ok = violations.some((v) => v.code === "EVIDENCE_INVARIANT_AC6_II_VIOLATION");
      if (!ok) console.log(`    실제: ${JSON.stringify(violations)}`);
      report(ok, "M-a 재현: 실제 merge 원장에서 viaMerge:true 부여를 전량 제거 → (ii) FAIL 관측");
    }

    // ---- 임무 지침 사고 실험 M-e 재현: 커밋 레벨 합계를 viaMerge 필터
    // 없이(files[] 전량 합) 재계산하면 (i)가 FAIL을 내는가. ----
    {
      const evidence = structuredClone(collect(dirs.merge, { mergeIncluded: true }));
      const mergeCommit = evidence.commits.find((c) => c.isMerge === true);
      const unfilteredSum = (key) => mergeCommit.files.reduce((s, f) => s + (f.binary ? 0 : f[key]), 0);
      mergeCommit.insertions = unfilteredSum("insertions"); // M-e: viaMerge 필터 제거
      mergeCommit.deletions = unfilteredSum("deletions");
      const violations = checkEvidenceInvariants(evidence);
      const ok = violations.some((v) => v.code === "EVIDENCE_INVARIANT_AC6_I_VIOLATION");
      if (!ok) console.log(`    실제: ${JSON.stringify(violations)}`);
      report(ok, "M-e 재현: 실제 merge 원장의 커밋 레벨 합계에서 viaMerge 필터를 제거 → (i) FAIL 관측");
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// T2(구현자 — 테스트 공백 메우기, A-13): 수집기가 만든 evidence.json을
// evidence.schema.json으로 검증하는 테스트가 한 건도 없었다 — 구조 위반
// 산출물이 4개 게이트를 전부 통과했다(콜드 리뷰 실측: 스키마 밖 필드 추가 +
// required 필드 삭제를 동시에 한 evidence.json으로도 71/88/11 PASS + lint
// exit 0). 여기서는 (a) 실제 수집기 출력 여러 형태(머지/리네임/삭제/다중
// 저자/봇/300커밋 절단)가 evidence.schema.json에 전부 적합함을 확인하고,
// (b) 그 검사 자체가 실제로 FAIL을 낼 수 있음을 같은 스모크 안에서
// 증명한다 — required 필드(shortHash) 삭제와 additionalProperties:false
// 위반(스키마 밖 필드 추가)을 각각 실제로 재현해 validateInstance가 잡는지
// 관측한다(자기충족 검사 금지 — 절대 규칙).
// ---------------------------------------------------------------------------

/**
 * `schemas/evidence.schema.json`을 판독한다.
 *
 * **최상위에서 즉시 판독하지 않는 이유.** 초판은 이 자리에서 바로
 * `JSON.parse(fs.readFileSync(...))`를 했고, 그러면 파일이 없거나 깨졌을 때 예외가
 * **import 시점**에 터져 프로세스가 죽는다 — 스위트가 「결과:」 줄도 없이 **단언 0건**으로
 * 끝난다. 섹션이 예외로 중단되는 것보다 **한 단계 더 나쁘다**: 중단은 최소한
 * `runSection`이 FAIL 1건으로 집계해 로그에 남지만, 이쪽은 아무 흔적도 남지 않는다.
 *
 * 실측(2026-08-21): 이 스키마를 지운 격리 사본에서 스모크가 raw Node 스택과 함께 exit 1로
 * 죽었고 445개 단언 중 아무것도 실행되지 않았다. 이 레포의 완료 조건이 「파일·필드 부재를
 * 예외가 아니라 각 단언의 FAIL로 떨어뜨려라」를 요구하므로 규칙 위반이었다.
 *
 * 경로는 정본 상수 `EVIDENCE_SCHEMA_REL`로 조립한다 — 세그먼트를 손으로 적으면 스키마가
 * 옮겨질 때 이 판독만 조용히 옛 경로를 본다(같은 회차에 드리프트 가드 쪽에서 고친 것과 같은 형태).
 *
 * **판독 자체는 파일 상단의 `readRepoJsonSafe`가 한다**(2026-08-24). 초판은 여기에 try/catch를
 * 손으로 두었고, 그 결과 같은 아이디어가 이 파일에 3벌로 늘어났다 — 콜드 리뷰가 그것을 지적했다.
 * 이 함수는 **이름·계약·사유 문자열 형태를 그대로 유지**하면서 판독만 공유 헬퍼로 넘긴다.
 * 반환 필드명이 `{schema}`인 것은 이 함수의 기존 계약이므로 호출부를 건드리지 않기 위해 유지하고,
 * 헬퍼의 중립적인 `{json}`을 여기서 개명 구조분해한다.
 *
 * @returns {{schema: object|null, error: string|null}} **예외를 던지지 않는다.**
 */
function loadEvidenceSchema() {
  const { json: schema, error } = readRepoJsonSafe(EVIDENCE_SCHEMA_REL);
  return { schema, error };
}

function runEvidenceSchemaCheckSmoke() {
  console.log("[evidence.schema.json 구조 검증 스모크(A-13)] 실제 수집기 출력 → 실제 스키마로 구조 검증");

  // 스키마 판독 실패를 예외로 두지 않고 **이 섹션의 단언 8건 각각을 FAIL로** 떨어뜨린다.
  // **단언 총량이 변하지 않는 것이 요점이다** — 총량이 줄면 「무엇이 사라졌는가」를 아무도
  // 보지 않는다(총량 바닥 가드가 아직 없다). 아래 세 판독 지점은 스키마가 null이면
  // `validateInstance`를 부르지 않고 사유 문자열 하나를 오류 목록으로 삼아, 각 단언이
  // **자기 라벨을 달고** FAIL하게 한다. 라벨을 실패 경로에 복제하지 않는 이유는 그것이
  // 곧 드리프트가 되기 때문이다 — 라벨의 정본은 각 단언 한 곳뿐이다.
  const { schema: EVIDENCE_SCHEMA, error: schemaError } = loadEvidenceSchema();
  if (schemaError) console.log(`    실제: ${schemaError}`);

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-evidence-schema-"));
  try {
    const dirs = {
      merge: path.join(tmpBase, "merge"),
      rename: path.join(tmpBase, "rename"),
      del: path.join(tmpBase, "delete"),
      multiAuthor: path.join(tmpBase, "multiAuthor"),
      botCommits: path.join(tmpBase, "botCommits"),
    };
    buildMerge(dirs.merge);
    buildRename(dirs.rename);
    buildDelete(dirs.del);
    buildMultiAuthor(dirs.multiAuthor);
    buildBotCommits(dirs.botCommits);

    const collect = (repoPath, opts = {}) =>
      collectGitFacts({
        repoPath,
        selectedIdentities: [OWNER_EMAIL],
        allIdentities: true,
        ref: "HEAD",
        mergeIncluded: false,
        maxCommits: 1000,
        ...opts,
      }).evidence;

    // ---- (a) 실제 수집기 출력이 evidence.schema.json에 적합함(무오탐). ----
    for (const [label, dir, opts] of [
      ["merge(머지 포함)", dirs.merge, { mergeIncluded: true }],
      ["rename", dirs.rename, {}],
      ["delete", dirs.del, {}],
      ["multiAuthor", dirs.multiAuthor, {}],
      ["botCommits(절단 없음)", dirs.botCommits, {}],
      // maxCommits로 실제 절단을 강제해 truncated.reason="budget_commits"
      // 분기(if/then 스키마 조건부 required 포함)도 구조 검증한다.
      ["botCommits(max-commits=1 절단)", dirs.botCommits, { maxCommits: 1 }],
    ]) {
      const evidence = collect(dir, opts);
      const warnings = [];
      const errors = EVIDENCE_SCHEMA === null
        ? [schemaError]
        : validateInstance(EVIDENCE_SCHEMA, evidence, EVIDENCE_SCHEMA, "$", warnings);
      if (errors.length > 0) {
        for (const e of errors) console.log(`    실제 오류(${label}): ${e}`);
      }
      for (const w of warnings) console.log(`    [WARN](${label}) ${w}`);
      report(
        errors.length === 0 && warnings.length === 0,
        `실제 수집기 출력(${label})이 evidence.schema.json에 적합함(A-13), 미지원 키워드 경고 0건`
      );
    }

    // ---- (b) 판별력 증명: required 필드(shortHash) 삭제 → 실제로 FAIL. ----
    {
      const evidence = structuredClone(collect(dirs.multiAuthor, {}));
      delete evidence.commits[0].shortHash;
      const errors = EVIDENCE_SCHEMA === null
        ? [schemaError]
        : validateInstance(EVIDENCE_SCHEMA, evidence, EVIDENCE_SCHEMA, "$", []);
      const ok = errors.some((e) => e.includes("shortHash"));
      if (!ok) console.log(`    실제: ${JSON.stringify(errors)}`);
      report(ok, "판별력 증명: commits[0].shortHash 삭제 → validateInstance가 required 위반을 잡음(A-13)");
    }

    // ---- (b) 판별력 증명: 스키마 밖 최상위 필드 추가 → 실제로 FAIL. ----
    {
      const evidence = structuredClone(collect(dirs.multiAuthor, {}));
      evidence.strayFieldMutation = "unexpected";
      const errors = EVIDENCE_SCHEMA === null
        ? [schemaError]
        : validateInstance(EVIDENCE_SCHEMA, evidence, EVIDENCE_SCHEMA, "$", []);
      const ok = errors.some((e) => e.includes("strayFieldMutation"));
      if (!ok) console.log(`    실제: ${JSON.stringify(errors)}`);
      report(ok, "판별력 증명: 스키마 밖 최상위 필드 추가 → validateInstance가 additionalProperties 위반을 잡음(A-13)");
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// T2(구현자 — 테스트 공백 메우기, A-14): coAuthors 추출 · binary 판정 ·
// git-facts.json 집계 전체 · vendored 제외 4종에 단언이 0건이었고, 그 용도로
// 만들어진 픽스처(buildCoAuthorTrailer/buildBinaryFile/buildVendoredPaths)가
// 어떤 tests에서도 import되지 않은 채 방치돼 있었다(콜드 리뷰 실측: 이
// 4가지를 동시에 무력화하는 변이 — coAuthors 항상 []·binary 항상 false·
// buildGitFacts 항상 {}·isVendoredPath 항상 false — 를 적용해도 기존
// 스모크가 전부 무탐지였다). 아래는 그 픽스처들을 실제로 배선해 4종 각각에
// 대응하는 단언을 추가한다. 각 단언의 판별력은 이 스모크를 작성하는 과정에서
// 해당 프로덕션 코드 경로(parseCoAuthorTrailers/binary 판정/isVendoredPath)를
// 실제로 무력화해 FAIL로 뒤집히는 것을 직접 실행 관측한 뒤 되돌렸다(관측
// 결과는 이 작업의 notes에 기록했다 — 이 파일 자체에는 실제 프로덕션 코드를
// 되돌리는 임시 변이를 남기지 않는다. 자기충족 회귀는 아니지만, 대신 아래
// (c) 절에서 실제 evidence.json을 구조적으로 변이해 그 자리에서 FAIL을
// 관측하는 절만은 스모크 안에 남긴다).
// ---------------------------------------------------------------------------

function runCoAuthorsBinaryVendoredGitFactsSmoke() {
  console.log("[coAuthors·binary·vendored·git-facts 집계 스모크(A-14)] 배선되지 않은 채 방치된 4개 프로덕션 오라클을 실제로 연결");

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-a14-"));
  try {
    // ---- (a) coAuthors 추출: 트레일러 있는 커밋은 비공허, 없는 커밋은
    // 공허(빈 배열) — 양방향 모두 확인해야 "항상 []" 같은 퇴화를 잡는다. ----
    {
      const dir = path.join(tmpBase, "coAuthorTrailer");
      const built = buildCoAuthorTrailer(dir);
      const evidence = collectGitFacts({
        repoPath: dir,
        selectedIdentities: [OWNER_EMAIL],
        allIdentities: true,
        ref: "HEAD",
        mergeIncluded: false,
        maxCommits: 1000,
      }).evidence;

      const withTrailer = evidence.commits.find((c) => c.subject.startsWith("feat: pair-programmed change"));
      const withoutTrailer = evidence.commits.find((c) => c.subject.startsWith("chore: solo change"));
      if (!withTrailer || !withoutTrailer) {
        console.log(`    실제 subjects: ${JSON.stringify(evidence.commits.map((c) => c.subject))}`);
      }
      // 원장의 coAuthors는 A-9 마스킹(collect-git-facts.mjs가 redactSecrets를
      // subject/coAuthors 직렬화 지점에 배선)을 거치므로, 트레일러 원문의
      // 이메일이 [REDACTED:email]로 치환된 형태가 기대값이다 — 추출 자체
      // (git 트레일러 → coAuthors[])와 그 뒤에 걸리는 마스킹을 함께 확인한다.
      const expectedRedactedTrailer = redactSecrets(built.declared.expectedCoAuthorsTrailer).text;
      report(
        !!withTrailer && withTrailer.coAuthors.length === 1 &&
          withTrailer.coAuthors[0] === expectedRedactedTrailer,
        "coAuthors: 트레일러가 있는 커밋의 coAuthors[]가 원문(마스킹 적용분 포함)과 완전 일치(A-14)"
      );
      report(
        !!withoutTrailer && Array.isArray(withoutTrailer.coAuthors) && withoutTrailer.coAuthors.length === 0,
        "coAuthors: 트레일러가 없는 커밋은 coAuthors===[](비공허·공허 양방향 확인, \"항상 []\" 퇴화를 구분함)"
      );
    }

    // ---- (b) binary 판정: numstat이 '-'로 보고한 파일은 binary:true +
    // insertions/deletions===0으로 정규화되고, 이 값이 커밋 레벨 합계에도
    // 반영돼야 한다(0이 아니라 null/NaN이 새면 JSON 직렬화가 그 사실을
    // 숨긴다 — insertions/deletions가 정확히 0인지까지 확인). ----
    {
      const dir = path.join(tmpBase, "binaryFile");
      const built = buildBinaryFile(dir);
      const evidence = collectGitFacts({
        repoPath: dir,
        selectedIdentities: [OWNER_EMAIL],
        allIdentities: true,
        ref: "HEAD",
        mergeIncluded: false,
        maxCommits: 1000,
      }).evidence;

      const commit = evidence.commits.find((c) => c.files.some((f) => f.path === built.declared.path));
      const fileEntry = commit && commit.files.find((f) => f.path === built.declared.path);
      if (!fileEntry) console.log(`    실제 commits: ${JSON.stringify(evidence.commits)}`);
      report(
        !!fileEntry && fileEntry.binary === true && fileEntry.insertions === 0 && fileEntry.deletions === 0,
        "binary: numstat '-' 보고 파일이 files[].binary===true, insertions===0, deletions===0으로 정규화됨(A-14)"
      );
      report(
        !!commit && commit.insertions === 0 && commit.deletions === 0,
        "binary: 바이너리만 바뀐 커밋의 커밋 레벨 insertions/deletions도 0(binary 파일이 합계를 오염시키지 않음)"
      );
    }

    // ---- (c) vendored 제외: git-facts.json 집계(pathModuleMap/
    // extensionHistogram)에서는 vendored 경로가 빠지지만, evidence.json의
    // commits[].files[] 원장에서는 빠지지 않는다(수집기 주석의 명시 계약 —
    // "커밋 자체는 지우지 않는다"). 두 축을 모두 확인해야 "vendored를
    // 원장에서도 지워버림"(원장 훼손) 같은 반대 방향 회귀도 잡는다. ----
    {
      const dir = path.join(tmpBase, "vendoredPaths");
      const built = buildVendoredPaths(dir);
      const { evidence, gitFacts } = collectGitFacts({
        repoPath: dir,
        selectedIdentities: [OWNER_EMAIL],
        allIdentities: true,
        ref: "HEAD",
        mergeIncluded: false,
        maxCommits: 1000,
      });

      const commit = evidence.commits[0];
      const ledgerPaths = new Set(commit.files.map((f) => f.path));
      const allDeclaredPresent = [...built.declared.vendoredPaths, built.declared.nonVendoredControlPath].every(
        (p) => ledgerPaths.has(p)
      );
      if (!allDeclaredPresent) console.log(`    실제 ledgerPaths: ${JSON.stringify([...ledgerPaths])}`);
      report(
        allDeclaredPresent,
        "vendored: evidence.json 원장(files[])에는 vendored 경로도 전량 등재됨(커밋 자체는 지우지 않는다는 계약, A-14)"
      );

      const vendoredTopDirs = ["node_modules", "dist", "vendor", "migrations"];
      const noVendoredInPathModuleMap = vendoredTopDirs.every((d) => !(d in gitFacts.pathModuleMap));
      const controlModulePresent = gitFacts.pathModuleMap.src === 1;
      if (!noVendoredInPathModuleMap || !controlModulePresent) {
        console.log(`    실제 pathModuleMap: ${JSON.stringify(gitFacts.pathModuleMap)}`);
      }
      report(
        noVendoredInPathModuleMap && controlModulePresent,
        "vendored: git-facts.json pathModuleMap에는 vendored 최상위 디렉터리가 없고 비-vendored 디렉터리(src)만 집계됨(A-14)"
      );

      const noVendoredExt = !(".lock" in gitFacts.extensionHistogram) && gitFacts.extensionHistogram[".js"] === 1;
      if (!noVendoredExt) console.log(`    실제 extensionHistogram: ${JSON.stringify(gitFacts.extensionHistogram)}`);
      report(
        noVendoredExt,
        "vendored: git-facts.json extensionHistogram에 vendored 파일(.lock 등)의 확장자가 섞이지 않음(비-vendored .js 1건만 집계, A-14)"
      );
    }

    // ---- (d) git-facts.json 집계 전체: topChangedFiles·
    // conventionalCommitTypeDistribution이 실제 커밋 내용을 반영함(botCommits
    // 픽스처 — owner 2커밋 "chore:"/"feat:", bot 2커밋은 identity 필터로
    // excluded되어 집계에서 빠져야 한다). ----
    {
      const dir = path.join(tmpBase, "botCommitsForGitFacts");
      buildBotCommits(dir);
      const { gitFacts } = collectGitFacts({
        repoPath: dir,
        selectedIdentities: [OWNER_EMAIL],
        allIdentities: false, // 봇 커밋을 실제로 제외시켜야 아래 분포가 owner 2건만 반영한다
        ref: "HEAD",
        mergeIncluded: false,
        maxCommits: 1000,
      });

      // dist.chore는 owner의 "chore: init app" 1건만 반영해야 한다 — 만약
      // 봇의 "chore(deps): bump ..." 커밋(exclusionReason=bot)이 실수로
      // analyzed에 새면 정규식이 scope를 무시하고 앞의 "chore"만 보므로
      // 같은 버킷에 합산돼 dist.chore가 2로 뒤집힌다(판별력 있는 축).
      // dist.ci는 ghactions 봇 커밋("ci: ...")이 정상적으로 제외됐다면
      // 아예 나타나지 않아야 한다.
      const dist = gitFacts.conventionalCommitTypeDistribution;
      const ok = dist.chore === 1 && dist.feat === 1 && dist.ci === undefined;
      if (!ok) console.log(`    실제 conventionalCommitTypeDistribution: ${JSON.stringify(dist)}`);
      report(
        ok,
        "git-facts 집계: conventionalCommitTypeDistribution이 excluded 커밋(봇 2건)을 빼고 owner 커밋(chore 1·feat 1)만 반영(A-14)"
      );

      const topPath = gitFacts.topChangedFiles[0] && gitFacts.topChangedFiles[0].path;
      report(
        topPath === "app.txt",
        `git-facts 집계: topChangedFiles[0]이 실제로 가장 많이 바뀐 owner 파일(app.txt)을 가리킴(실제: ${topPath})`
      );
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// T3(구현자 — 픽스처 커버리지 정직화, 콜드 리뷰 A-14 잔여): buildEmptyRepo·
// buildSingleCommit·buildKorean·buildSpacePath·buildEmptyMessage 5종이
// fixtures/README.md 표에는 AC-6/AC-17 "오라클 대상"으로 광고돼 있었지만
// tests/·scripts/ 어디에서도 import되지 않아 자동 검증이 0이었다(grep 0건).
// 아래 5개 절 각각이 그 픽스처를 실제로 collectGitFacts()에 먹여 해당 AC가
// 요구하는 프로덕션 동작을 단언한다. 판별력은 이 스모크를 작성하는 과정에서
// 대응하는 프로덕션 코드 경로를 직접 무력화해 FAIL로 뒤집히는 것을 실행
// 관측한 뒤 원복했다(관측 결과는 이 작업의 notes에 기록 — 이 파일 자체에는
// 되돌리는 임시 변이를 남기지 않는다):
//   (a) buildEmptyRepo    : hasAnyCommitOnHead 사전 확인을 제거하면
//                           `git log HEAD`가 unborn branch에서 fatal로 죽어
//                           collectGitFacts()가 예외를 던지는 것을 관측.
//   (b) buildSingleCommit : classifyExclusion의 shallow-boundary 판정을
//                           "shallowBoundaryHashes 대조"에서 "parents.length
//                           ===0"으로 바꾸면(콜드 리뷰 A-3이 실제로 겪은
//                           클래스의 버그) 진짜 루트 커밋이 shallow-boundary로
//                           오분류되어 excluded:true·total:0이 되는 것을 관측.
//   (c) buildKorean       : runGit의 spawnSync encoding을 "utf8"→"latin1"로
//                           바꾸면 한글 경로·subject가 깨진 멀티바이트 문자열로
//                           나오는 것을 관측(ASCII 픽스처로는 이 결함이
//                           원리적으로 드러나지 않는다 — latin1/utf8이 ASCII
//                           바이트에서는 동일하므로 이 축은 한글 픽스처만
//                           변별력을 가진다).
//   (d) buildSpacePath    : getCommitFileChanges의 numstat/name-status 호출에서
//                           `-z`를 제거하면 tokenizeZ의 NUL 부재 가드가
//                           throw하는 것을 관측(공백 포함 경로가 실제로 이
//                           가드를 실경로로 통과하는 유일한 픽스처).
//   (e) buildEmptyMessage : conventionalCommitTypeDistribution 계산에서
//                           `m ? m[1].toLowerCase() : "other"`의 null 가드를
//                           제거하면 빈 subject(정규식 미매치)에서
//                           TypeError로 죽는 것을 관측.
// ---------------------------------------------------------------------------

function runFixtureCoverageHonestySmoke() {
  console.log("[픽스처 커버리지 정직화 스모크(A-14 잔여)] buildEmptyRepo·buildSingleCommit·buildKorean·buildSpacePath·buildEmptyMessage 실배선");

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-a14b-"));
  try {
    // ---- (a) buildEmptyRepo: AC-6 — 0커밋/unborn branch에서 예외 없이
    // 정상 종료하고 빈 원장을 낸다. ----
    {
      const dir = path.join(tmpBase, "emptyRepo");
      buildEmptyRepo(dir);
      let evidence;
      let threw = null;
      try {
        evidence = collectGitFacts({
          repoPath: dir,
          selectedIdentities: [OWNER_EMAIL],
          allIdentities: true,
          ref: "HEAD",
          maxCommits: 1000,
        }).evidence;
      } catch (e) {
        threw = e;
      }
      if (threw) console.log(`    예외 발생: ${threw.message}`);
      report(
        threw === null,
        "buildEmptyRepo: 빈 레포/unborn branch에서 collectGitFacts()가 예외 없이 정상 종료함(AC-6)"
      );
      report(
        !!evidence &&
          evidence.commits.length === 0 &&
          evidence.coverage.traversed === 0 &&
          evidence.coverage.total === 0 &&
          evidence.coverage.analyzed === 0 &&
          evidence.sourceRepoHead === "0".repeat(40) &&
          evidence.truncated.reason === "none" &&
          evidence.truncated.dropped_commits === 0 &&
          evidence.coverage.samplingMethod === "none:full-scan",
        `buildEmptyRepo: 빈 원장(commits=[], traversed=total=analyzed=0, sourceRepoHead=null-sha, samplingMethod="none:full-scan")이 정확히 기재됨(실제: ${JSON.stringify(evidence?.coverage)}, sourceRepoHead=${evidence?.sourceRepoHead})`
      );
    }

    // ---- (b) buildSingleCommit: AC-5/AC-6 — 부모 없는 루트 커밋의 diff
    // base가 빈 트리가 되어 신규 작성분이 정확히 집계되고, shallow-boundary로
    // 오탐되지 않는다(콜드 리뷰 A-3 클래스 회귀 방지). ----
    {
      const dir = path.join(tmpBase, "singleCommit");
      buildSingleCommit(dir);
      const { evidence } = collectGitFacts({
        repoPath: dir,
        selectedIdentities: [OWNER_EMAIL],
        allIdentities: true,
        ref: "HEAD",
        maxCommits: 1000,
      });
      const c = evidence.commits[0];
      report(
        evidence.commits.length === 1 &&
          c.parents.length === 0 &&
          c.excluded === false &&
          c.exclusionReason === null &&
          evidence.coverage.isShallowClone === false &&
          evidence.coverage.total === 1,
        `buildSingleCommit: 진짜 단일 루트 커밋이 shallow-boundary로 오탐되지 않고 population에 정상 포함됨(실제: excluded=${c?.excluded}, reason=${c?.exclusionReason}, isShallowClone=${evidence.coverage.isShallowClone}, total=${evidence.coverage.total})`
      );
      report(
        c.files.length === 1 &&
          c.files[0].path === "README.md" &&
          c.files[0].changeType === "A" &&
          c.files[0].oldPath === null &&
          c.insertions === c.files[0].insertions &&
          c.deletions === 0,
        `buildSingleCommit: 빈 트리 대비 diff로 README.md가 changeType=A로 신규 작성 집계되고 커밋 레벨 합계와 일치함(실제: ${JSON.stringify(c.files)}, 커밋레벨=${c.insertions}/${c.deletions})`
      );
    }

    // ---- (c) buildKorean: AC-17 — 한글 파일명·한글 커밋 메시지가 옥탈
    // 이스케이프나 인코딩 깨짐 없이 UTF-8 그대로 원장에 들어간다. ----
    {
      const dir = path.join(tmpBase, "korean");
      const built = buildKorean(dir);
      const { evidence } = collectGitFacts({
        repoPath: dir,
        selectedIdentities: [OWNER_EMAIL],
        allIdentities: true,
        ref: "HEAD",
        maxCommits: 1000,
      });
      const allPaths = new Set(evidence.commits.flatMap((c) => c.files.map((f) => f.path)));
      const allSubjects = new Set(evidence.commits.map((c) => c.subject));
      const pathsOk = built.declared.paths.every((p) => allPaths.has(p));
      const noOctalEscape = [...allPaths, ...allSubjects].every((s) => !/\\\d{3}/.test(s));
      if (!pathsOk || !noOctalEscape) {
        console.log(`    실제 paths: ${JSON.stringify([...allPaths])}, subjects: ${JSON.stringify([...allSubjects])}`);
      }
      report(
        pathsOk,
        `buildKorean: 한글 파일명 2건(하위 디렉터리 포함)이 원장 files[].path에 원문 그대로 등재됨(선언값: ${JSON.stringify(built.declared.paths)})`
      );
      report(
        noOctalEscape,
        "buildKorean: 경로·subject 어디에도 옥탈 이스케이프 패턴(\\\\NNN)이 남지 않음(core.quotepath=false + -z 계약 확인, AC-17)"
      );
      report(
        [...allSubjects].some((s) => s.startsWith("한글 커밋 메시지")) &&
          [...allSubjects].some((s) => s.startsWith("두 번째 한글 커밋")),
        `buildKorean: 한글 커밋 메시지 2건이 subject에 원문 그대로 보존됨(실제: ${JSON.stringify([...allSubjects])})`
      );
    }

    // ---- (d) buildSpacePath: AC-17 — 공백 포함 경로가 `-z` 파싱에서
    // 잘리거나 깨지지 않는다. ----
    {
      const dir = path.join(tmpBase, "spacePath");
      const built = buildSpacePath(dir);
      const { evidence } = collectGitFacts({
        repoPath: dir,
        selectedIdentities: [OWNER_EMAIL],
        allIdentities: true,
        ref: "HEAD",
        maxCommits: 1000,
      });
      const c = evidence.commits[0];
      report(
        c?.files.length === 1 && c.files[0].path === built.declared.path,
        `buildSpacePath: 공백 포함 경로("${built.declared.path}")가 잘리거나 변형되지 않고 files[0].path에 완전 일치함(실제: ${JSON.stringify(c?.files)})`
      );
    }

    // ---- (e) buildEmptyMessage: AC-6 — 빈 커밋 메시지에서 subject 처리·
    // conventional-commit 분류가 예외 없이 "other"로 정상 처리된다. ----
    {
      const dir = path.join(tmpBase, "emptyMessage");
      buildEmptyMessage(dir);
      let result;
      let threw = null;
      try {
        result = collectGitFacts({
          repoPath: dir,
          selectedIdentities: [OWNER_EMAIL],
          allIdentities: true,
          ref: "HEAD",
          maxCommits: 1000,
        });
      } catch (e) {
        threw = e;
      }
      if (threw) console.log(`    예외 발생: ${threw.message}`);
      report(threw === null, "buildEmptyMessage: 빈 커밋 메시지에서 collectGitFacts()가 예외 없이 정상 종료함(AC-6)");
      const emptyMsgCommit = result?.evidence.commits.find((c) => c.subject === "");
      report(
        !!emptyMsgCommit,
        `buildEmptyMessage: 빈 메시지 커밋의 subject가 빈 문자열로 정확히 기록됨(실제 subjects: ${JSON.stringify(result?.evidence.commits.map((c) => c.subject))})`
      );
      report(
        (result?.gitFacts.conventionalCommitTypeDistribution.other ?? 0) >= 1,
        `buildEmptyMessage: conventional-commit 분류가 빈 subject를 예외 없이 "other" 버킷으로 처리함(실제: ${JSON.stringify(result?.gitFacts.conventionalCommitTypeDistribution)})`
      );
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 임무 A(구현자 — 탐지 경로 보강, 블로커 A): 골든 게이트(--golden, ~1분) 없이도
// M-f(coverage.traversed에 total 복사)·M-h(절단인데 reason="none")·
// M-i(절단인데 samplingMethod="none:full-scan")가 **기본 스모크**에서 잡히게
// 한다. negative 픽스처는 정적 JSON이라 수집기를 거치지 않는데 이 세 변이는
// 수집기 안에 있으므로, 「수집기가 실제로 만든 evidence.json」에 절단이
// 실제로 발생하도록 강제해야 한다 — buildBotCommits(총 4커밋: owner 2 +
// dependabot/github-actions 2)를 max-commits=1로 돌리면 owner population
// (total=2)에서 K=min(1,2)=1로 절단이 실제로 걸려 traversed(4) > total(2) >
// analyzed(1)이 서로 다른 세 값이 되고, traversed-total(2)이 실제 excluded
// 커밋 수(2)와 일치한다 — 이미 있는 소형 시나리오를 재사용하므로 픽스처
// 생성이 수 초 이내로 끝난다(golden의 300커밋/~1분과 대비).
// ---------------------------------------------------------------------------

function runFastTruncationInvariantSmoke() {
  console.log("[빠른 절단 불변식 스모크] 실제 수집기 산출물(소형 픽스처 + 낮은 max-commits) — M-f/M-h/M-i를 기본 스모크에서 관측");

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-fast-truncation-"));
  try {
    const dir = path.join(tmpBase, "botCommits");
    buildBotCommits(dir);

    const evidence = collectGitFacts({
      repoPath: dir,
      selectedIdentities: [OWNER_EMAIL],
      ref: "HEAD",
      mergeIncluded: false,
      maxCommits: 1, // owner population(total=2) > max-commits(1) → 절단 강제
    }).evidence;

    const { coverage, truncated } = evidence;
    const excludedCount = evidence.commits.filter((c) => c.excluded === true).length;

    report(
      truncated.reason === "budget_commits" && truncated.dropped_commits > 0,
      "사전 확인: buildBotCommits + max-commits=1 조합이 실제로 절단을 발생시킴(truncated.reason=budget_commits, 골든의 300커밋 없이도 재현)"
    );

    // ---- M-f 겨냥 단언: traversed(4) > total(2) > analyzed(1) — 세 값이
    // 서로 다르고, traversed-total이 실제 excluded 커밋 수(봇 2건)와 같다. ----
    const distinctOk =
      coverage.traversed === 4 && coverage.total === 2 && coverage.analyzed === 1 &&
      coverage.analyzed < coverage.total && coverage.total < coverage.traversed;
    if (!distinctOk) console.log(`    실제 coverage: ${JSON.stringify(coverage)}`);
    report(distinctOk, "M-f 겨냥: coverage.traversed(4) > total(2) > analyzed(1) — 세 값이 서로 다름(전부 동일값이 되는 자기충족 회피)");

    const excludedMatchOk = excludedCount === 2 && coverage.traversed - coverage.total === excludedCount;
    if (!excludedMatchOk) console.log(`    실제: traversed-total=${coverage.traversed - coverage.total}, excludedCount=${excludedCount}`);
    report(excludedMatchOk, "M-f 겨냥: traversed-total(2) == commits[]의 excluded===true 건수(2, 봇 커밋)");

    // ---- 참인 원장에는 AC-6 (i)(ii)(iii) + T-1 + T-2 + coverage 3수치
    // 교차 검사 전부 위반 0건이어야 한다(무오탐 회귀). ----
    const violations = checkEvidenceInvariants(evidence);
    if (violations.length > 0) {
      for (const v of violations) console.log(`    실제 위반: ${v.code}: ${v.message}`);
    }
    report(violations.length === 0, "무오탐: 실제 절단 발생 원장(botCommits + max-commits=1)에 AC-6/T-1/T-2/coverage 불변식 위반 0건");

    // ---- M-f 변이 관측: coverage.traversed에 total을 그대로 복사(사고
    // 실험이 서술한 정확한 버그 형태) → 새 coverage 불변식이 FAIL을 내는가. ----
    {
      const mutated = structuredClone(evidence);
      mutated.coverage.traversed = mutated.coverage.total; // M-f 재현
      const v = checkEvidenceInvariants(mutated);
      const ok = v.some((x) => x.code === "EVIDENCE_INVARIANT_COVERAGE_TRAVERSED_VIOLATION");
      if (!ok) console.log(`    실제: ${JSON.stringify(v)}`);
      report(ok, "M-f 재현: 실제 절단 원장에서 coverage.traversed에 total을 그대로 복사 → EVIDENCE_INVARIANT_COVERAGE_TRAVERSED_VIOLATION FAIL 관측");
    }

    // ---- M-h 변이 관측: 절단이 실제로 발생했는데 reason만 "none"으로
    // 거짓 기재(dropped_commits는 그대로 양수) → T-1 FAIL. ----
    {
      const mutated = structuredClone(evidence);
      mutated.truncated.reason = "none"; // M-h 재현(절단인데 reason="none")
      const v = checkEvidenceInvariants(mutated);
      const ok = v.some((x) => x.code === "EVIDENCE_INVARIANT_T1_VIOLATION");
      if (!ok) console.log(`    실제: ${JSON.stringify(v)}`);
      report(ok, "M-h 재현: 실제 절단 원장에서 truncated.reason만 \"none\"으로 거짓 기재(dropped_commits는 그대로 양수) → T-1 FAIL 관측");
    }

    // ---- M-i 변이 관측: 절단이 실제로 발생했는데 samplingMethod만
    // "none:full-scan"으로 거짓 기재 → T-2 FAIL. ----
    {
      const mutated = structuredClone(evidence);
      mutated.coverage.samplingMethod = "none:full-scan"; // M-i 재현
      const v = checkEvidenceInvariants(mutated);
      const ok = v.some((x) => x.code === "EVIDENCE_INVARIANT_T2_VIOLATION");
      if (!ok) console.log(`    실제: ${JSON.stringify(v)}`);
      report(ok, "M-i 재현: 실제 절단 원장에서 coverage.samplingMethod만 \"none:full-scan\"으로 거짓 기재 → T-2 FAIL 관측");
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 임무 2(구현자 — 탐지 경로 최종 보강, 결함 2): 실제 레포에 대해
// getCommitFileChanges를 호출하는 명명된 성공 기대 테스트. 아래
// runGitZGuardSmoke()의 8개 단언은 스스로 만든 합성 페이로드를 tokenizeZ/
// parseNumstatTokens/parseNameStatusTokens에 직접 먹이는 자기충족 테스트라서
// scripts/lib/git.mjs가 실제로 내는 -z 인자 유무와 무관하게 항상 PASS한다
// — M-b(--numstat에서 -z 제거)/M-d(--name-status에서 -z 제거)/M-bd(양쪽
// 동시 제거) 같은 git.mjs 소스 변이를 원리적으로 탐지할 수 없다(파서 자체의
// 방어 회귀 테스트로서는 유효하지만 그 이상을 주장하면 안 된다). 이 함수가
// 그 빈틈을 메운다 — git.mjs가 실제로 실행한 git 호출의 산출물을 판정하므로
// 소스 변이가 그대로 관측된다. buildRename의 renameCommitHash는 리네임
// 파일과 companionPath 두 파일을 함께 바꾸는 다중 파일 커밋이라 -z 계약이
// 실제로 관측 가능하다.
//
// -z가 제거되면 getCommitFileChanges 내부의 numstat/name-status 건수 가드
// (또는 tokenizeZ의 NUL 부재 가드)가 throw한다 — 그 예외를 잡아 스위트를
// 죽이지 않고 report()로 명명된 FAIL로 기록한다(임무 지침 — "스위트를
// 죽이지 말고 report로 기록").
function runGitZRealPathSmoke() {
  console.log("[git.mjs -z 실경로 스모크] getCommitFileChanges 실제 호출 — 결함 2(자기충족 회피, 실경로 명명 단언)");

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-zrealpath-"));
  try {
    const dir = path.join(tmpBase, "rename");
    const renameFx = buildRename(dir);
    const { renameCommitHash, path: expectedNewPath, oldPath: expectedOldPath, companionPath } = renameFx.declared;

    try {
      const parentHash = execFileSync(
        "git", ["-C", dir, ...GIT_FIXED_PREFIX_ARGS, "rev-parse", `${renameCommitHash}^`],
        { encoding: "utf8" }
      ).trim();

      const result = getCommitFileChanges(dir, renameCommitHash, [parentHash], false);
      const paths = new Set(result.files.map((f) => f.path));
      const renamedEntry = result.files.find((f) => f.path === expectedNewPath);

      const ok =
        result.ok === true &&
        result.files.length === 2 &&
        paths.size === 2 &&
        paths.has(expectedNewPath) &&
        paths.has(companionPath) &&
        renamedEntry?.oldPath === expectedOldPath;

      if (!ok) console.log(`    실제: ${JSON.stringify(result)}`);
      report(
        ok,
        `getCommitFileChanges 실경로 호출(rename 픽스처, 다중 파일 커밋): 파일 수=2, 경로 집합={${expectedNewPath}, ${companionPath}} 정확히 일치, 리네임 oldPath 보존`
      );
    } catch (e) {
      report(
        false,
        `getCommitFileChanges 실경로 호출이 예외로 중단됨(${e.message}) — -z 제거 변이(M-b/M-d/M-bd)가 여기서 탐지됨`
      );
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 임무 C(구현자 — 탐지 경로 보강, 블로커 B): `-z` 탐지를 "건수 불일치 시
// 우연히 발생하는 uncaught exception"에서 "명명된 단위 회귀"로 승격한다.
// M-b(--numstat에서 -z 제거)·M-d(--name-status에서 -z 제거) 둘 다 실제
// git 호출(고정 프리픽스, -z만 뺀)로 재현하고, scripts/lib/git.mjs의
// tokenizeZ(1차 방어 — NUL 부재 감지)와 _internal.parseNumstatTokens/
// parseNameStatusTokens(2차 방어 — 개행/탭 혼입·리네임 축약형 잔존 감지)
// 양쪽이 실제로 FAIL(throw)을 내는지 관측한다. 두 방어가 서로 다른
// 계층(원시 텍스트 vs 이미 토큰화된 배열)에 있으므로 "양쪽 -z를 함께
// 제거해도(건수 비교 가드만으로는 우회 가능한 변형) 잡힌다"도 여기서
// 함께 확인한다 — tokenizeZ는 두 호출을 서로 비교하지 않고 각각 독립적으로
// 판정하기 때문이다. M-d가 기존에 "진단 정보 없는 TypeError"로 먼저 죽던
// 문제도 이 가드들이 더 이른 지점에서 명확한 메시지로 대체한다.
//
// 결함 2 보강 노트(임무 2): 아래 8개 단언은 이 함수가 직접 합성한 원시
// 텍스트(rawNumstatNoZ/rawNameStatusNoZ — 실제 git 호출로 만들지만, 그
// "-z 없는" 원시 출력을 tokenizeZ/parseNumstatTokens/parseNameStatusTokens에
// 곧바로 먹이는 것 자체가 이 테스트가 스스로 준비한 입력이다)를 파서에
// 직접 먹이는 자기충족(self-fulfilling) 테스트다 — git.mjs의 실제 -z 인자
// 유무(소스 변이)와 무관하게 이 파서 함수들 자체는 항상 같은 동작을 하므로
// 항상 PASS한다. 즉 이 8건은 "파서가 비-`-z` 페이로드를 받으면 방어적으로
// throw하는가"라는 파서 자체의 방어 회귀만 검증할 뿐, git.mjs 소스에서
// -z 인자가 실제로 빠지는 변이(M-b/M-d/M-bd)는 원리적으로 탐지하지
// 못한다 — 그 역할은 위 runGitZRealPathSmoke()(실제 git.mjs 호출 경로)가
// 담당한다. 착각하지 말 것.
// ---------------------------------------------------------------------------

function runGitZGuardSmoke() {
  console.log("[git.mjs -z 가드 회귀] tokenizeZ/parseNumstatTokens/parseNameStatusTokens — 비-`-z` 페이로드 방어(임무 지침 C, M-b/M-d)");

  const { tokenizeZ, parseNumstatTokens, parseNameStatusTokens } = gitInternal;

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-zguard-"));
  try {
    const dir = path.join(tmpBase, "rename");
    const renameFx = buildRename(dir);
    const renameCommitHash = renameFx.declared.renameCommitHash;
    const base = execFileSync(
      "git", ["-C", dir, ...GIT_FIXED_PREFIX_ARGS, "rev-parse", `${renameCommitHash}^`],
      { encoding: "utf8" }
    ).trim();

    // 실제 git 호출로 만든 -z 없는 원시 출력(다중 파일 커밋 — companionPath도
    // 함께 수정되므로 -z 계약이 실제로 관측 가능하다). 리네임 축약형
    // (`src/{legacy => current}/module.txt`)이 실제로 등장한다(스펙 배경 실측).
    const rawNumstatNoZ = execFileSync(
      "git", ["-C", dir, ...GIT_FIXED_PREFIX_ARGS, "diff", "--numstat", base, renameCommitHash],
      { encoding: "utf8" }
    );
    const rawNameStatusNoZ = execFileSync(
      "git", ["-C", dir, ...GIT_FIXED_PREFIX_ARGS, "diff", "--name-status", base, renameCommitHash],
      { encoding: "utf8" }
    );

    report(
      rawNumstatNoZ.includes(" => ") && !rawNumstatNoZ.includes("\0"),
      "사전 확인: -z 없는 --numstat 원시 출력이 리네임 축약형('=>')을 실제로 포함하고 NUL은 없음(재현 전제 성립)"
    );

    // ---- M-b 재현: -z 없는 numstat 원시 출력을 tokenizeZ에 먹이면 NUL
    // 부재를 감지해 즉시 throw(1차 방어선). ----
    {
      let threw = null;
      try { tokenizeZ(rawNumstatNoZ, "numstat"); } catch (e) { threw = e; }
      const ok = threw !== null && /NUL/.test(threw.message);
      if (!ok) console.log(`    실제: ${threw ? threw.message : "(던지지 않음 — BUG)"}`);
      report(ok, "M-b 재현: -z 없는 --numstat 원시 출력을 tokenizeZ에 먹이면 NUL 부재를 감지해 즉시 throw");
    }

    // ---- M-d 재현: -z 없는 name-status 원시 출력을 tokenizeZ에 먹이면
    // 마찬가지로 즉시 throw(이전에는 다중 파일 커밋에서 건수가 우연히
    // 일치해 가드를 통과, 단일 파일 커밋에서는 진단 없는 TypeError로 먼저
    // 죽었다 — 이제는 어느 경우든 이 지점에서 먼저, 명확한 메시지로 죽는다). ----
    {
      let threw = null;
      try { tokenizeZ(rawNameStatusNoZ, "name-status"); } catch (e) { threw = e; }
      const ok = threw !== null && /NUL/.test(threw.message);
      if (!ok) console.log(`    실제: ${threw ? threw.message : "(던지지 않음 — BUG)"}`);
      report(ok, "M-d 재현: -z 없는 --name-status 원시 출력을 tokenizeZ에 먹이면 NUL 부재를 감지해 즉시 throw(진단 없는 TypeError 대체)");
    }

    // ---- 임무 지침 배경 미시험 변형: 양쪽 -z를 함께 제거해도(건수 비교
    // 가드만으로는 우회 가능) tokenizeZ가 두 호출을 독립적으로 각각 잡는다. ----
    {
      const numstatThrows = (() => { try { tokenizeZ(rawNumstatNoZ, "numstat"); return false; } catch { return true; } })();
      const nameStatusThrows = (() => { try { tokenizeZ(rawNameStatusNoZ, "name-status"); return false; } catch { return true; } })();
      report(
        numstatThrows && nameStatusThrows,
        "미시험 변형 재현: 양쪽 -z를 함께 제거해도(건수가 우연히 일치해 비교 가드를 우회할 수 있는 변형) tokenizeZ가 양쪽에서 독립적으로 FAIL"
      );
    }

    // ---- 명명된 단위 회귀(임무 지침 3 원문): _internal.parseNumstatTokens/
    // parseNameStatusTokens에 비-`-z` 페이로드(개행 구분, 리네임 축약형
    // 포함)를 tokenizeZ 가드를 우회한 형태(원시 텍스트 전체가 NUL 분리 없이
    // 단일 토큰이 되는 실제 상황)로 직접 먹인다 — 조용히 받아들이면(=
    // 예외 없이 그럴듯한 값을 반환하면) 이 항목이 FAIL해야 한다. ----
    {
      let threw = null;
      let result = null;
      try { result = parseNumstatTokens([rawNumstatNoZ]); } catch (e) { threw = e; }
      const ok = threw !== null;
      if (!ok) console.log(`    실제(조용히 받아들임 — BUG): ${JSON.stringify(result)}`);
      report(ok, "parseNumstatTokens: 비-`-z` 페이로드(개행 구분, 리네임 축약형 d/{a => b}/f 포함)를 직접 먹여도 조용히 받아들이지 않고 throw");
    }
    {
      let threw = null;
      let result = null;
      try { result = parseNameStatusTokens([rawNameStatusNoZ]); } catch (e) { threw = e; }
      const ok = threw !== null;
      if (!ok) console.log(`    실제(조용히 받아들임 — BUG): ${JSON.stringify(result)}`);
      report(ok, "parseNameStatusTokens: 비-`-z` 페이로드(개행 구분)를 직접 먹여도 조용히 받아들이지 않고 throw");
    }

    // ---- 무오탐 회귀: 정상 -z 출력(같은 리네임+다중 파일 커밋)은 새 가드
    // 아래에서도 여전히 문제없이 파싱되고 oldPath/path가 declared 값과
    // 정확히 일치한다 — 방어 코드가 참을 오탐하지 않는지 확인. ----
    {
      const rawNumstatZ = execFileSync(
        "git", ["-C", dir, ...GIT_FIXED_PREFIX_ARGS, "diff", "--numstat", "-z", base, renameCommitHash],
        { encoding: "utf8" }
      );
      const rawNameStatusZ = execFileSync(
        "git", ["-C", dir, ...GIT_FIXED_PREFIX_ARGS, "diff", "--name-status", "-z", base, renameCommitHash],
        { encoding: "utf8" }
      );
      let numstatEntries = null;
      let nameStatusEntries = null;
      let threw = null;
      try {
        numstatEntries = parseNumstatTokens(tokenizeZ(rawNumstatZ, "numstat"));
        nameStatusEntries = parseNameStatusTokens(tokenizeZ(rawNameStatusZ, "name-status"));
      } catch (e) {
        threw = e;
      }
      const renameEntry = nameStatusEntries?.find((e) => e.changeType === "R");
      const ok =
        threw === null &&
        numstatEntries?.length === 2 &&
        renameEntry?.oldPath === renameFx.declared.oldPath &&
        renameEntry?.path === renameFx.declared.path;
      if (!ok) {
        console.log(
          `    실제: threw=${threw ? threw.message : null} numstatEntries=${JSON.stringify(numstatEntries)} ` +
          `nameStatusEntries=${JSON.stringify(nameStatusEntries)}`
        );
      }
      report(ok, "무오탐: 정상 -z 출력(리네임+다중 파일 커밋)은 새 가드 아래에서도 여전히 문제없이 파싱되고 oldPath/path가 declared 값과 일치");
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 콜드 리뷰 회귀 스모크 — C1(typechange 파서 throw)·C2(--since/--until
// committerDate 축·조기 중단)·C3(shallow clone 경계 커밋 오인)·
// M(diff.renames 미고정)·M(--ref all의 refs/stash 유입)·M(churn 버킷
// vendored/lockfile 오염). 각 항목은 "현재 픽스처에서 문제가 안 난다"가
// 아니라 실제 git이 낼 수 있는 조건을 플럼빙으로 재현해 관측한다 —
// 오케스트레이터 지침(이전 라운드가 "픽스처에 그 코드가 없었을 뿐인데
// 회귀 없음으로 결론지은" 것과 같은 실수를 반복하지 않기 위함).
// ---------------------------------------------------------------------------

function crInitRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["-C", dir, ...GIT_FIXED_PREFIX_ARGS, "init", "-q", "."], { encoding: "utf8" });
  execFileSync("git", ["-C", dir, ...GIT_FIXED_PREFIX_ARGS, "config", "user.email", OWNER_EMAIL], { encoding: "utf8" });
  execFileSync("git", ["-C", dir, ...GIT_FIXED_PREFIX_ARGS, "config", "user.name", "owner"], { encoding: "utf8" });
  execFileSync("git", ["-C", dir, ...GIT_FIXED_PREFIX_ARGS, "config", "commit.gpgsign", "false"], { encoding: "utf8" });
}

function crGit(dir, args, env) {
  return execFileSync("git", ["-C", dir, ...GIT_FIXED_PREFIX_ARGS, ...args], {
    encoding: "utf8",
    env: env ? { ...process.env, ...env } : process.env,
  });
}

function crWriteFile(dir, relPath, content) {
  const full = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content, "utf8");
}

function crCommitWithDates(dir, message, authorIso, committerIso) {
  crGit(dir, ["commit", "-q", "-m", message], { GIT_AUTHOR_DATE: authorIso, GIT_COMMITTER_DATE: committerIso });
  return crGit(dir, ["rev-parse", "HEAD"]).trim();
}

/**
 * C1(Critical) — `git diff --name-status`의 T(typechange) 코드에서
 * parseNameStatusTokens가 예외를 던져 수집기·검증기가 통째로 죽던 회귀.
 * 오케스트레이터가 실측 확인한 재현 레시피(symlink 모드 엔트리 → 일반
 * 파일로 교체, Windows에서 symlink 생성 권한 없이 플럼빙만으로 가능)를
 * 그대로 쓴다.
 */
function runTypeChangeSmoke() {
  console.log("[C1: typechange(T) 회귀] parseNameStatusTokens가 T 코드에서 더 이상 throw하지 않음을 실제 git 호출로 확인");
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-typechange-"));
  try {
    const dir = path.join(tmpBase, "repo");
    crInitRepo(dir);

    fs.writeFileSync(path.join(dir, "blob.tmp"), "target.txt", "utf8");
    const h1 = crGit(dir, ["hash-object", "-w", "blob.tmp"]).trim();
    crGit(dir, ["update-index", "--add", "--cacheinfo", `120000,${h1},link`]);
    crWriteFile(dir, "target.txt", "hello\n");
    crGit(dir, ["add", "target.txt"]);
    const c1 = crCommitWithDates(dir, "one", "2020-01-01T00:00:00", "2020-01-01T00:00:00");

    const h2 = execFileSync(
      "git", ["-C", dir, ...GIT_FIXED_PREFIX_ARGS, "hash-object", "-w", "--stdin"],
      { input: "regular\n", encoding: "utf8" }
    ).trim();
    crGit(dir, ["update-index", "--add", "--cacheinfo", `100644,${h2},link`]);
    const c2 = crCommitWithDates(dir, "two", "2020-01-02T00:00:00", "2020-01-02T00:00:00");

    // 사전 확인: 이 레포가 실제로 name-status="T"를 낸다(재현 전제 성립).
    const rawStatus = crGit(dir, ["diff", "--name-status", `${c1}`, `${c2}`]).trim();
    report(rawStatus === "T\tlink", `사전 확인: 실제 git diff --name-status가 'T'를 냄(재현 전제 성립, 실제: '${rawStatus}')`);

    let threw = null;
    let result = null;
    try {
      result = getCommitFileChanges(dir, c2, [c1], false);
    } catch (e) {
      threw = e;
    }
    const okNoThrow = threw === null && result?.ok === true;
    if (!okNoThrow) console.log(`    실제: threw=${threw ? threw.message : null} result=${JSON.stringify(result)}`);
    report(okNoThrow, "C1: getCommitFileChanges가 typechange(T) 커밋에서 throw하지 않고 ok:true 반환(이전에는 여기서 예외로 죽었다)");

    const entry = result?.files?.[0];
    report(
      entry?.changeType === "M" && entry?.rawChangeType === "T" && entry?.path === "link",
      `C1: T가 changeType:"M"으로 정규화되고 rawChangeType:"T"로 원본이 보존됨(실제: changeType=${entry?.changeType}, rawChangeType=${entry?.rawChangeType})`
    );

    let collectThrew = null;
    let evidence = null;
    try {
      evidence = collectGitFacts({ repoPath: dir, selectedIdentities: [OWNER_EMAIL], ref: "HEAD", maxCommits: 1000 }).evidence;
    } catch (e) {
      collectThrew = e;
    }
    report(
      collectThrew === null,
      `C1: collectGitFacts()가 typechange 커밋이 있는 레포에서 예외 없이 완료됨(실측 재현 레시피 — 이전에는 '수집 실패' + exit 1이었다; 실제: ${collectThrew ? collectThrew.message : "OK"})`
    );
    if (evidence) {
      const c2Entry = evidence.commits.find((c) => c.hash === c2);
      const c2File = c2Entry?.files?.find((f) => f.path === "link");
      report(c2File?.rawChangeType === "T", "C1: collectGitFacts 산출 evidence.json에도 rawChangeType:'T'가 그대로 보존됨");
    }

    // verify-evidence 경로(오케스트레이터 지침이 지목한 더 심각한 쪽 —
    // 이전에는 try/catch가 전혀 없어 미처리 예외 스택 트레이스로 죽었다).
    let vThrew = null;
    let vResult = null;
    try {
      vResult = verifyCitation({
        repoPath: dir,
        evidence,
        selectedIdentities: [OWNER_EMAIL],
        ledgerId: `commit:${c2}`,
        citationPath: "link",
        nodeBasis: "commit",
      });
    } catch (e) {
      vThrew = e;
    }
    report(
      vThrew === null && vResult?.verdict === "PASS",
      `C1: verifyCitation이 typechange 커밋 인용을 미처리 예외 없이 PASS 처리(실제: threw=${vThrew ? vThrew.message : null}, verdict=${vResult?.verdict})`
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

/**
 * C2(Critical) — `--since`/`--until`이 committerDate 기준으로 필터되고
 * 순회를 조기 중단해 원장이 "누락 0건"을 거짓 단언하던 회귀. authorDate/
 * committerDate가 서로 다른 커밋 4건(양방향 축 불일치 + 비단조 순서)으로
 * 재현한다.
 */
function runSinceUntilAuthorDateSmoke() {
  console.log("[C2: --since/--until authorDate 축 회귀] committerDate 축 불일치·조기 중단·거짓 dropped:0 단언이 사라졌음을 확인");
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-sinceuntil-"));
  try {
    const dir = path.join(tmpBase, "repo");
    crInitRepo(dir);

    crWriteFile(dir, "c1.txt", "c1\n");
    crGit(dir, ["add", "c1.txt"]);
    const c1 = crCommitWithDates(dir, "feat: c1 (author in-range, committer out-of-range)", "2025-06-15T00:00:00", "2019-01-01T00:00:00");

    crWriteFile(dir, "c2.txt", "c2\n");
    crGit(dir, ["add", "c2.txt"]);
    const c2 = crCommitWithDates(dir, "feat: c2 (author out-of-range, committer in-range)", "2019-01-01T00:00:00", "2025-06-15T00:00:00");

    crWriteFile(dir, "c3.txt", "c3\n");
    crGit(dir, ["add", "c3.txt"]);
    const c3 = crCommitWithDates(dir, "feat: c3 (both out-of-range)", "2019-06-01T00:00:00", "2019-06-01T00:00:00");

    crWriteFile(dir, "c4.txt", "c4\n");
    crGit(dir, ["add", "c4.txt"]);
    const c4 = crCommitWithDates(dir, "feat: c4 (both in-range)", "2025-07-01T00:00:00", "2025-07-01T00:00:00");

    const { evidence } = collectGitFacts({
      repoPath: dir,
      selectedIdentities: [OWNER_EMAIL],
      ref: "HEAD",
      since: "2025-01-01",
      until: "2025-12-31",
      maxCommits: 1000,
    });

    report(evidence.coverage.traversed === 4, `C2: 전량 순회(조기 중단 없음) — traversed===4(실제 ${evidence.coverage.traversed})`);

    const byHash = Object.fromEntries(evidence.commits.map((c) => [c.hash, c]));
    report(
      byHash[c1]?.excluded === false,
      "C2: authorDate가 범위 안인 c1이 committerDate가 범위 밖임에도 population에 포함됨(committerDate가 아니라 authorDate 축임을 확인)"
    );
    report(
      byHash[c2]?.excluded === true && byHash[c2]?.exclusionReason === "period-out-of-range",
      `C2: authorDate가 범위 밖인 c2가 committerDate 범위 안임에도 제외됨(실제: excluded=${byHash[c2]?.excluded}, reason=${byHash[c2]?.exclusionReason})`
    );
    report(
      byHash[c3]?.excluded === true && byHash[c3]?.exclusionReason === "period-out-of-range",
      "C2: 양쪽 다 범위 밖인 c3도 period-out-of-range로 제외"
    );
    report(byHash[c4]?.excluded === false, "C2: 양쪽 다 범위 안인 c4는 population에 포함");
    report(
      evidence.truncated.reason === "none" && evidence.truncated.dropped_commits === 0,
      "C2: 기간 제외는 truncated(예산 절단) 축과 별개이므로 truncated는 그대로 {none,0} — excluded 가시성으로 처리된다"
    );
    report(evidence.commits.length === 4, "C2: 기간 밖 커밋도 원장에 전량 등재됨(누락 없음 — '거짓 dropped:0 단언' 문제가 가시성으로 해소됨)");

    let badThrew = null;
    try {
      collectGitFacts({ repoPath: dir, selectedIdentities: [OWNER_EMAIL], ref: "HEAD", since: "2 years ago", maxCommits: 1000 });
    } catch (e) {
      badThrew = e;
    }
    report(
      badThrew !== null && /YYYY-MM-DD/.test(badThrew.message),
      `A-5: git 상대 날짜('2 years ago')처럼 검증되지 않은 --since 값이 Date.parse NaN으로 조용히 흐르지 않고 즉시 거부됨(실제: ${badThrew?.message})`
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }

  {
    let threw = null;
    try {
      computeSampling([{ hash: "a".repeat(40), authorEpochSec: 100, churn: 1 }], 1, { since: NaN });
    } catch (e) {
      threw = e;
    }
    report(threw !== null && /NaN/.test(threw.message), "A-5: computeSampling이 range.since로 NaN을 받으면 조용히 진행하지 않고 즉시 거부(2차 방어선)");
  }
}

/**
 * C3(Critical) — shallow clone의 경계 커밋을 루트 커밋으로 오인해 빈
 * 트리와 diff, 코드베이스 전체를 그 커밋 1건의 신규 작성분(A)으로
 * 집계하던 회귀. `git clone --depth`(`file://` 스킴 — 로컬 clone에서는
 * `--depth`가 무시된다는 git 경고를 피하기 위함, 실측 확인)로 진짜
 * shallow 레포를 만들어 재현한다.
 */
function runShallowCloneSmoke() {
  console.log("[C3: shallow clone 경계 커밋 회귀] 경계 커밋이 루트로 오인되지 않고 excluded:'shallow-boundary'로 제외됨을 실제 --depth clone으로 확인");
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-shallow-"));
  try {
    const srcDir = path.join(tmpBase, "src");
    crInitRepo(srcDir);
    crWriteFile(srcDir, "a.txt", "a\n".repeat(50));
    crGit(srcDir, ["add", "a.txt"]);
    crCommitWithDates(srcDir, "feat: c1 (would-be shallow boundary)", "2024-01-01T00:00:00", "2024-01-01T00:00:00");
    crWriteFile(srcDir, "b.txt", "b\n");
    crGit(srcDir, ["add", "b.txt"]);
    const c2 = crCommitWithDates(srcDir, "feat: c2", "2024-02-01T00:00:00", "2024-02-01T00:00:00");
    crWriteFile(srcDir, "c.txt", "c\n");
    crGit(srcDir, ["add", "c.txt"]);
    const c3 = crCommitWithDates(srcDir, "feat: c3", "2024-03-01T00:00:00", "2024-03-01T00:00:00");

    const shallowDir = path.join(tmpBase, "shallow");
    const srcUrl = pathToFileURL(srcDir).href;
    execFileSync("git", [...GIT_FIXED_PREFIX_ARGS, "clone", "-q", "--depth", "2", srcUrl, shallowDir], { encoding: "utf8" });

    report(isShallowRepository(shallowDir) === true, "사전 확인: file:// --depth 2 clone이 실제로 shallow repository로 감지됨(재현 전제 성립)");

    const { evidence } = collectGitFacts({
      repoPath: shallowDir,
      selectedIdentities: [OWNER_EMAIL],
      ref: "HEAD",
      maxCommits: 1000,
    });

    report(evidence.coverage.isShallowClone === true, "C3: coverage.isShallowClone===true로 명시 기록됨(spec.md 엣지 케이스 원문 '감지 후 커버리지에 명시')");

    const boundaryEntry = evidence.commits.find((c) => c.hash === c2);
    report(
      boundaryEntry?.excluded === true && boundaryEntry?.exclusionReason === "shallow-boundary",
      `C3: shallow 경계 커밋(c2)이 excluded:true·exclusionReason:'shallow-boundary'로 제외됨(실제: excluded=${boundaryEntry?.excluded}, reason=${boundaryEntry?.exclusionReason})`
    );

    const c3Entry = evidence.commits.find((c) => c.hash === c3);
    report(c3Entry?.excluded === false, "C3: 진짜 최신 커밋(c3)은 정상적으로 population에 남음(무오탐)");

    report(
      evidence.coverage.total === 1,
      `C3: coverage.total이 shallow 경계 커밋을 빼고 진짜 신규 작성분(c3)만 센다(실제 total=${evidence.coverage.total}) — 4.2배 부풀림 방지 확인`
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

/**
 * M — 고정 git 프리픽스가 `diff.renames`를 고정하지 않아 사용자
 * gitconfig에 따라 같은 레포·같은 인자가 다른 원장을 내던 회귀.
 * `GIT_CONFIG_GLOBAL`(git 2.32+)로 실제 전역 gitconfig 파일을 격리해
 * `diff.renames=false`를 주입한 뒤에도 고정 프리픽스가 이를 덮어써
 * 리네임이 여전히 R로 감지되는지 실제 git 호출로 확인한다.
 */
function runDiffRenamesFixedSmoke() {
  console.log("[M: diff.renames 고정 회귀] 사용자 gitconfig의 diff.renames=false를 고정 프리픽스가 덮어씀을 실제 GIT_CONFIG_GLOBAL로 확인");
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-renamescfg-"));
  const prevGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
  try {
    const dir = path.join(tmpBase, "repo");
    crInitRepo(dir);
    crWriteFile(dir, "a.txt", "line1\nline2\nline3\n");
    crGit(dir, ["add", "a.txt"]);
    const c1 = crCommitWithDates(dir, "one", "2020-01-01T00:00:00", "2020-01-01T00:00:00");
    crGit(dir, ["mv", "a.txt", "b.txt"]);
    fs.appendFileSync(path.join(dir, "b.txt"), "line4\n", "utf8");
    crGit(dir, ["add", "-A"]);
    const c2 = crCommitWithDates(dir, "two", "2020-01-02T00:00:00", "2020-01-02T00:00:00");

    const globalCfgPath = path.join(tmpBase, "global.gitconfig");
    fs.writeFileSync(globalCfgPath, "[diff]\n\trenames = false\n", "utf8");
    process.env.GIT_CONFIG_GLOBAL = globalCfgPath;

    // 사전 확인: 격리된 전역 config가 실제로 적용되는 상태에서 -c 없이
    // 호출하면 리네임이 D+A로 갈라짐(재현 전제 성립).
    const rawNumstat = execFileSync(
      "git", ["-C", dir, "--no-pager", "diff", "--numstat", c1, c2],
      { encoding: "utf8", env: process.env }
    ).trim();
    const preconditionLines = rawNumstat.split("\n").filter(Boolean);
    report(
      preconditionLines.length === 2,
      `사전 확인: 격리된 GIT_CONFIG_GLOBAL(diff.renames=false)이 실제로 적용되어 -c 없는 호출은 리네임을 D+A(2줄)로 감지함(재현 전제, 실제:\n${rawNumstat})`
    );

    const result = getCommitFileChanges(dir, c2, [c1], false);
    const ok = result.ok === true && result.files.length === 1 && result.files[0].changeType === "R" && result.files[0].oldPath === "a.txt";
    if (!ok) console.log(`    실제: ${JSON.stringify(result)}`);
    report(
      ok,
      "M: getCommitFileChanges(고정 프리픽스 사용)는 GIT_CONFIG_GLOBAL의 diff.renames=false와 무관하게 여전히 리네임 1건(R)으로 감지함"
    );
  } finally {
    if (prevGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = prevGitConfigGlobal;
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

/**
 * M — `--ref all`이 `refs/stash`를 진짜 커밋으로 원장에 넣어 untracked
 * 파일 경로(개인 스크래치·시크릿일 수 있음)까지 evidence.json에 실리던
 * 회귀. 실제 `git stash push -u`로 재현한다.
 */
function runRefAllExcludesStashSmoke() {
  console.log("[M: --ref all의 refs/stash 유입 회귀] git stash push -u 이후에도 --ref all 순회에 stash 엔트리가 섞이지 않음을 확인");
  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-stash-"));
  try {
    const dir = path.join(tmpBase, "repo");
    crInitRepo(dir);
    crWriteFile(dir, "a.txt", "hello\n");
    crGit(dir, ["add", "a.txt"]);
    crCommitWithDates(dir, "feat: one", "2020-01-01T00:00:00", "2020-01-01T00:00:00");

    fs.writeFileSync(path.join(dir, "a.txt"), "hello2\n", "utf8");
    fs.writeFileSync(path.join(dir, "untracked-secret.txt"), "should-never-appear\n", "utf8");
    crGit(dir, ["stash", "push", "-u", "-m", "wip"]);

    const stashList = crGit(dir, ["stash", "list"]).trim();
    report(stashList.length > 0, `사전 확인: git stash push -u가 실제로 stash 엔트리를 만듦(재현 전제 성립, 실제: '${stashList}')`);

    const r = listCommitMetadata(dir, { ref: "--all" });
    report(r.ok === true, "M: --all 순회가 stash 존재 상태에서도 정상 완료(ok:true)");
    report(r.commits.length === 1, `M: --all 순회 결과가 stash 유령 커밋 없이 실제 커밋 1건만 반환(실제: ${r.commits.length}건)`);
    const hasStashLikeSubject = r.commits.some((c) => /^(On |index on |untracked files on )/.test(c.subject ?? ""));
    report(!hasStashLikeSubject, "M: stash 특유의 커밋 메시지 패턴('On <branch>: ...' 등)이 결과에 전혀 없음");
    const hasUntrackedSecretPath = r.commits.some((c) => (c.subject ?? "").includes("untracked-secret"));
    report(!hasUntrackedSecretPath, "M: untracked 파일 경로가 원장(커밋 메타데이터)에 유입되지 않음");
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

/**
 * M — churn 버킷(표본의 40%)이 vendored/lockfile 커밋으로 채워지고
 * `/\.lock$/`가 `package-lock.json`을 놓쳐 lockfile 갱신 커밋이 실제
 * 작업 커밋을 churn 표본에서 밀어내던 회귀. buildChurnKeyDivergence와
 * 동일한 K=4(recent3/churn1/even0) 구도를 만들되, churn 경쟁자를
 * "실제 작업"(seed, 100줄) vs "package-lock.json만 500줄 갱신"으로
 * 구성해 nonVendoredChurn 정의가 실제 선택 결과를 좌우함을 확인한다.
 */
function runChurnVendoredExclusionSmoke() {
  console.log("[M: churn 버킷 vendored/lockfile 오염 회귀] package-lock.json 등 락파일 갱신 커밋이 churn 표본을 독식하지 않음을 확인");

  // 패턴 자체의 정탐(콜드 리뷰가 지목한 5개 락파일 확장자).
  const { isVendoredPath } = collectorInternal;
  for (const p of ["package-lock.json", "sub/package-lock.json", "pnpm-lock.yaml", "go.sum", "composer.lock", "poetry.lock"]) {
    report(isVendoredPath(p, []) === true, `M: 기본 vendored 패턴이 '${p}'를 잡음(콜드 리뷰 실측 — 이전에는 package-lock.json 등이 누락돼 있었다)`);
  }
  report(isVendoredPath("src/app/real-feature.ts", []) === false, "M: 무오탐 — 일반 소스 경로는 vendored로 분류되지 않음");

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-churnvendored-"));
  try {
    const dir = path.join(tmpBase, "repo");
    crInitRepo(dir);

    crWriteFile(dir, "bigfile.txt", Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") + "\n");
    crGit(dir, ["add", "bigfile.txt"]);
    const seed = crCommitWithDates(dir, "chore: seed bigfile (real work)", "2024-01-01T00:00:01", "2024-01-01T00:00:01");

    crWriteFile(dir, "package-lock.json", Array.from({ length: 500 }, (_, i) => `"dep${i}": "1.0.${i}"`).join("\n") + "\n");
    crGit(dir, ["add", "package-lock.json"]);
    const lockCommit = crCommitWithDates(dir, "chore(deps): huge lockfile bump", "2024-01-01T00:00:02", "2024-01-01T00:00:02");

    const recentHashes = [];
    for (let i = 0; i < 3; i++) {
      crWriteFile(dir, `recent-${i}.txt`, `recent ${i}\n`);
      crGit(dir, ["add", `recent-${i}.txt`]);
      recentHashes.push(crCommitWithDates(dir, `feat: recent ${i}`, `2024-01-01T00:00:0${3 + i}`, `2024-01-01T00:00:0${3 + i}`));
    }

    const { evidence } = collectGitFacts({ repoPath: dir, selectedIdentities: [OWNER_EMAIL], ref: "HEAD", maxCommits: 4 });

    const preconditionOk = evidence.coverage.total === 5 && evidence.coverage.analyzed === 4;
    report(preconditionOk, `사전 확인: total=5>K=4 조합이 실제로 샘플링에 진입함(실제: total=${evidence.coverage.total}, analyzed=${evidence.coverage.analyzed})`);

    const selectedHashes = new Set(evidence.commits.filter((c) => !c.excluded).map((c) => c.hash));
    report(
      selectedHashes.has(seed) === true,
      "M: 실제 작업 커밋(seed, bigfile 100줄)이 churn 버킷에서 선택됨(nonVendoredChurn 기준)"
    );
    report(
      selectedHashes.has(lockCommit) === false,
      "M: package-lock.json만 500줄 바꾼 커밋은 churn 버킷에서 탈락함(vendored 제외 — raw churn(500)만 봤다면 seed(100)를 이기고 선택됐을 것이다)"
    );
    report(
      recentHashes.every((h) => selectedHashes.has(h)),
      "M: recent 버킷 3건은 그대로 선택됨(회귀 없음)"
    );
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// AC-21 골든 게이트(이월 게이트 A-3/B-1/B-2, 임무 지침 D) — 300커밋 픽스처를
// fixtures/golden/sampling-300.expected.json의 equivalentCollectorInvocation과
// 동일한 인자로 collectGitFacts에 통과시켜 선택 집합·커버리지 3수치·
// samplingMethod 리터럴·결정성을 대조한다. tests/run-smoke.mjs에 golden·
// large300·traversed 참조가 0건이던 것이 이 Run이 닫는 원인 ②다.
//
// 픽스처 생성이 ~85초 걸려(buildLarge300 단독 실측) 스모크 기본 모드를
// 과도하게 느리게 만들므로, os.tmpdir() 아래 결정적 고정 경로에 생성
// 결과를 캐시한다 — buildLarge300은 GIT_AUTHOR_DATE 등을 고정해 항상
// 같은 커밋 해시를 재현하므로(AC-5), "커밋 300개짜리 유효한 git 레포가
// 이미 그 경로에 있다"는 사실 자체가 캐시 적중 판정으로 충분하다. 이
// 게이트는 `--golden` 플래그로 분리하되 package.json의 `npm test`
// 경로(scripts.test)가 기본 스모크 다음에 이 플래그로 다시 실행해 반드시
// 함께 돌게 한다(분리는 속도 때문이지 게이트 이탈이 아니다).
//
// 임무 B(구현자 — 탐지 경로 보강): 캐시 판정이 지금까지 "커밋 수 300 +
// declared 파일 존재"만 봐서 fixtures/make-fixture.mjs 자체의 변경(픽스처
// 정의 드리프트)을 감지하지 못했다(실측: declared.changeType을 변조해도
// --golden이 11 PASS 0 FAIL로 녹색이었다). make-fixture.mjs의 내용
// SHA-256을 캐시 디렉터리 이름에 포함시켜, 그 파일이 한 글자라도 바뀌면
// 새 해시가 계산되어 이전 캐시 디렉터리가 존재하지 않는 것으로 취급되고
// (=캐시 미스) 픽스처가 그 새 코드로 다시 생성된다 — 이전 해시의 캐시는
// 그냥 버려진다(OS temp 정리에 맡긴다). 캐시 메타 파일에도 해시를 별도
// 기록해(cache.meta.json) 두 번째 방어선으로 삼는다.
const MAKE_FIXTURE_REL = "fixtures/make-fixture.mjs";
const MAKE_FIXTURE_PATH = path.join(REPO_ROOT, MAKE_FIXTURE_REL);

/**
 * `fixtures/make-fixture.mjs` 현재 내용의 SHA-256 hex(앞 16자). **예외를 던지지 않는다.**
 *
 * **이것이 이 파일에 남아 있던 마지막 A류였다.** 초판은 맨몸 `readFileSync`였고, 그 결과가
 * 아래에서 **모듈 최상위 `const`로 즉시 소비**되므로 파일을 읽지 못하면 예외가 import 시점에
 * 터져 **단언 0건**으로 프로세스가 끝났다 — 섹션 중단보다 한 단계 더 나쁜 부류다.
 * 이 파일의 기록은 오랫동안 「A류 0건」이라고 적어 왔는데, 그것이 사실이 아니었다(2026-08-24).
 *
 * **판독 위치를 옮기지 않고 「죽지 않게」만 만든다.** 이 값에서 파생되는 캐시 경로 상수가
 * 넷이고 참조 지점이 35곳이라, 지연 판독으로 바꾸면 그 전부를 함수 호출로 고쳐야 한다.
 * A류의 해악은 「최상위에서 읽는다」가 아니라 **「부재가 프로세스를 죽인다」**이므로, 예외를
 * 없애면 해악이 사라진다. 실패는 사유로 남고 아래 캐시 키 단언이 그것을 잡는다.
 *
 * **덧붙여, 이 파일이 없으면 어차피 `:150`의 정적 import가 먼저 죽는다.** 그러므로 이 판독이
 * 실제로 발현하는 경로는 「import는 성공했으나 이 판독만 실패」(권한·손상·레이스)뿐이다.
 * 그 좁은 경로가 이 수정이 닫는 전부이며, 그것을 부풀려 적지 않는다.
 *
 * 해시는 utf8 텍스트로 계산한다 — 이 값의 용도는 「내용이 바뀌면 달라진다」뿐이고,
 * 캐시 키 단언도 같은 함수로 재계산해 대조하므로 바이트 충실성이 요구되지 않는다.
 *
 * @returns {{hash: string|null, error: string|null}}
 */
function computeMakeFixtureContentHash() {
  const { text, error } = readRepoTextSafe(MAKE_FIXTURE_REL);
  if (error !== null) return { hash: null, error };
  return { hash: crypto.createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16), error: null };
}

const { hash: MAKE_FIXTURE_CONTENT_HASH, error: MAKE_FIXTURE_HASH_ERROR } = computeMakeFixtureContentHash();
const GOLDEN_CACHE_DIR = path.join(os.tmpdir(), `devcareer-golden-cache-v1-${MAKE_FIXTURE_CONTENT_HASH ?? "unreadable"}`);
const LARGE300_CACHE_DIR = path.join(GOLDEN_CACHE_DIR, "large300");
const LARGE300_DECLARED_CACHE_PATH = path.join(GOLDEN_CACHE_DIR, "large300.declared.json");
const CACHE_META_PATH = path.join(GOLDEN_CACHE_DIR, "cache.meta.json");

/**
 * 캐시 메타(cache.meta.json)가 지금 계산한 make-fixture.mjs 해시와
 * 일치하는지 판정하는 순수 함수(임무 B 오라클). git 레포 존재·커밋 수
 * 확인(디스크·프로세스 I/O)과 분리해 이 판정 자체만 빠르게 단위 테스트할
 * 수 있게 한다.
 *
 * @param {{makeFixtureContentHash?: string}|null} meta
 * @param {string} expectedHash
 * @returns {boolean}
 */
function isCacheMetaFresh(meta, expectedHash) {
  return !!meta && meta.makeFixtureContentHash === expectedHash;
}

/**
 * 캐시된 large300 픽스처가 있으면(유효한 git 레포 + 커밋 300개 + declared
 * 메타데이터 존재 + 캐시 메타의 make-fixture.mjs 해시가 현재 해시와 일치)
 * 재사용하고, 없거나 손상됐거나 해시가 다르면(=make-fixture.mjs가 바뀌어
 * 캐시 디렉터리 이름 자체가 달라진 경우 포함) 새로 만든다.
 * @returns {{dir: string, declared: object, cached: boolean}}
 */
function ensureLarge300Fixture() {
  try {
    if (
      fs.existsSync(path.join(LARGE300_CACHE_DIR, ".git")) &&
      fs.existsSync(LARGE300_DECLARED_CACHE_PATH) &&
      fs.existsSync(CACHE_META_PATH)
    ) {
      const meta = JSON.parse(fs.readFileSync(CACHE_META_PATH, "utf8"));
      const count = Number(
        execFileSync("git", ["-C", LARGE300_CACHE_DIR, "rev-list", "--all", "--count"], { encoding: "utf8" }).trim()
      );
      if (count === 300 && isCacheMetaFresh(meta, MAKE_FIXTURE_CONTENT_HASH)) {
        const declared = JSON.parse(fs.readFileSync(LARGE300_DECLARED_CACHE_PATH, "utf8"));
        return { dir: LARGE300_CACHE_DIR, declared, cached: true };
      }
    }
  } catch {
    // 캐시 판정 중 어떤 오류든(손상된 레포 등) 아래에서 새로 만든다.
  }

  fs.rmSync(LARGE300_CACHE_DIR, { recursive: true, force: true });
  fs.mkdirSync(GOLDEN_CACHE_DIR, { recursive: true });
  const { declared } = buildLarge300(LARGE300_CACHE_DIR);
  fs.writeFileSync(LARGE300_DECLARED_CACHE_PATH, JSON.stringify(declared, null, 2) + "\n", "utf8");
  fs.writeFileSync(
    CACHE_META_PATH,
    JSON.stringify({ makeFixtureContentHash: MAKE_FIXTURE_CONTENT_HASH, cachedAt: new Date().toISOString() }, null, 2) + "\n",
    "utf8"
  );
  return { dir: LARGE300_CACHE_DIR, declared, cached: false };
}

// 임무 B(구현자 — 탐지 경로 보강) 관측: 300커밋 픽스처를 실제로 다시 만들지
// 않고도(그건 ~85초가 걸려 골든 게이트 전용이다) 캐시 무효화 메커니즘
// 자체가 make-fixture.mjs 내용 변경에 반응하는지 빠르게(디스크 I/O 없이)
// 관측한다 — 기본/negative 스모크에 넣어 "picture-only" 회귀를 방지한다.
function runGoldenCacheKeySmoke() {
  console.log("[골든 캐시 키 스모크] 임무 B — make-fixture.mjs 내용 해시가 캐시 무효화에 실제로 반영되는지 관측");

  // 판독에 실패하면 `recomputed.hash`와 `MAKE_FIXTURE_CONTENT_HASH`가 **둘 다 null**이라
  // 등식이 우연히 참이 된다 — 「결정적이다」와 「둘 다 못 읽었다」가 같아지는 거짓 초록이다.
  // 그래서 판독 성공을 판정에 명시한다. 이 단언이 A류를 없앤 대가로 생긴 관측 지점이다.
  const recomputed = computeMakeFixtureContentHash();
  if (MAKE_FIXTURE_HASH_ERROR !== null || recomputed.error !== null) {
    console.log(`    실제: ${MAKE_FIXTURE_HASH_ERROR ?? recomputed.error}`);
  }
  report(
    recomputed.hash !== null && recomputed.hash === MAKE_FIXTURE_CONTENT_HASH,
    "make-fixture.mjs 내용 해시 재계산이 모듈 로드 시점 값과 일치(결정적)"
  );

  report(
    MAKE_FIXTURE_CONTENT_HASH !== null && GOLDEN_CACHE_DIR.includes(MAKE_FIXTURE_CONTENT_HASH),
    "GOLDEN_CACHE_DIR 경로 자체에 make-fixture.mjs 내용 해시가 포함됨(파일이 바뀌면 다른 캐시 디렉터리를 가리킨다)"
  );

  // 실측: make-fixture.mjs의 실제 내용에 1바이트라도 덧붙이면(디스크에는
  // 쓰지 않고 메모리에서만) 해시와 그로부터 계산되는 캐시 디렉터리 경로가
  // 둘 다 달라진다 — 즉 이전 캐시(GOLDEN_CACHE_DIR)는 새 경로에서는 아예
  // 존재하지 않는 디렉터리가 되어 자동으로 캐시 미스(재생성) 처리된다.
  // 이 Run의 배경이 실측한 버그("declared.changeType을 변조해도 --golden이
  // 녹색")는 정확히 이 경로가 없어서 발생했다.
  // 판독 실패 시 해시를 **계산하지 않는다** — `Buffer.concat([null, …])`은 TypeError로 터진다.
  // `mutatedHash`가 null이면 아래 `!==` 두 비교가 우연히 참이 될 수 있으므로(null은 어떤 해시와도
  // 다르다) 판정에 판독 성공을 명시적으로 넣는다. 음수 방향 비교의 전형적인 거짓 초록이다.
  const { text: realContent, error: fixtureError } = readRepoTextSafe(MAKE_FIXTURE_REL);
  const mutatedHash = realContent === null
    ? null
    : crypto.createHash("sha256").update(Buffer.concat([Buffer.from(realContent, "utf8"), Buffer.from("\n// 임무 B 캐시 무효화 관측용 — 실제 파일에는 쓰지 않음\n")])).digest("hex").slice(0, 16);
  const mutatedCacheDir = mutatedHash === null ? null : path.join(os.tmpdir(), `devcareer-golden-cache-v1-${mutatedHash}`);
  const invalidationOk = mutatedHash !== null && mutatedHash !== MAKE_FIXTURE_CONTENT_HASH && mutatedCacheDir !== GOLDEN_CACHE_DIR;
  if (!invalidationOk) console.log(`    실제: ${fixtureError ?? ""} mutatedHash=${mutatedHash} currentHash=${MAKE_FIXTURE_CONTENT_HASH}`);
  report(
    invalidationOk,
    "실측: make-fixture.mjs 내용을 1바이트라도 바꾸면 해시·캐시 디렉터리 경로가 모두 달라짐(변조된 정의로 만든 이전 캐시가 조용히 재사용될 수 없음)"
  );

  // isCacheMetaFresh() 자체의 FAIL 관측(절대 규칙) — 해시 불일치·메타 부재
  // 양쪽 모두 "신선하지 않음"으로, 해시 일치는 "신선함"으로 판정해야 한다.
  const staleOk = isCacheMetaFresh({ makeFixtureContentHash: "0000000000000000" }, MAKE_FIXTURE_CONTENT_HASH) === false;
  report(staleOk, "isCacheMetaFresh: 캐시 메타의 해시가 현재 해시와 다르면 신선하지 않음(캐시 미스)으로 판정 → FAIL 관측");
  const freshOk = isCacheMetaFresh({ makeFixtureContentHash: MAKE_FIXTURE_CONTENT_HASH }, MAKE_FIXTURE_CONTENT_HASH) === true;
  report(freshOk, "isCacheMetaFresh: 캐시 메타의 해시가 현재 해시와 같으면 신선함(캐시 히트)으로 판정");
  const missingMetaOk = isCacheMetaFresh(null, MAKE_FIXTURE_CONTENT_HASH) === false;
  report(missingMetaOk, "isCacheMetaFresh: 메타 파일 자체가 없으면 신선하지 않음(캐시 미스)으로 판정");
}

function runGoldenGate() {
  console.log("[골든 게이트] AC-21 — 300커밋 픽스처 vs fixtures/golden/sampling-300.expected.json");

  // **이 사이트는 다른 열여덟 곳과 성격이 다르다 — 골든 파일이 입력이 아니라 오라클 자체다.**
  // 없으면 수집 파라미터조차 만들 수 없어 이 게이트의 단언 11건이 **전부 관측 불가**가 된다.
  // 그래서 사유를 특정 단언에 귀속시키는 대신 게이트 전체를 `goldenOk`로 막는다.
  //
  // **균일한 게이트를 쓰는 이유.** 판정별로 null 안전성을 따지면 두 곳이 조용히 통과한다 —
  // 결정성 단언은 `JSON.stringify(null) === JSON.stringify(null)`로 참이 되고,
  // total/analyzed 대조는 `undefined === undefined`로 참이 된다. 오라클이 통째로 없는 상황에서
  // 「어느 판정이 null에 안전한가」를 하나씩 따지는 것은 실수를 부르는 방식이고, 여기서는
  // 답도 「전부 관측 불가」로 같다.
  const GOLDEN_SAMPLING_REL = "fixtures/golden/sampling-300.expected.json";
  const { json: golden, error: goldenError } = readRepoJsonSafe(GOLDEN_SAMPLING_REL);
  const goldenOk = goldenError === null;
  if (!goldenOk) console.log(`    실제: ${goldenError} — 이 게이트의 단언 11건이 전부 관측 불가다`);

  const { dir, declared, cached } = ensureLarge300Fixture();
  console.log(`  [준비] large300 픽스처 ${cached ? "캐시 재사용" : "새로 생성(최초 1회, ~1분 소요)"}: ${dir}`);

  // golden.parameters.equivalentCollectorInvocation과 동일한 인자
  // (identity/max-commits/merge-included, ref는 CLI 기본값 HEAD).
  const collectParams = {
    repoPath: dir,
    selectedIdentities: [golden?.parameters?.identity],
    ref: "HEAD",
    mergeIncluded: golden?.parameters?.mergeIncluded,
    maxCommits: golden?.parameters?.maxCommits,
    botsEnabled: golden?.parameters?.botsExcluded,
  };

  // 골든이 없으면 **수집을 아예 돌리지 않는다.** 잘못된 파라미터로 돌린 결과에 단언을
  // 걸면 그건 관측이 아니라 소음이고, 일부 단언이 우연히 통과해 거짓 초록이 된다.
  const run1 = goldenOk ? collectGitFacts(collectParams).evidence : null;
  const run2 = goldenOk ? collectGitFacts(collectParams).evidence : null;

  const selectedHashesSorted = (ev) => ev.commits.filter((c) => !c.excluded).map((c) => c.hash).sort();
  const sel1 = run1 === null ? null : selectedHashesSorted(run1);
  const sel2 = run2 === null ? null : selectedHashesSorted(run2);

  // ---- 결정성(AC-21): 동일 입력 2회 실행 시 선택 집합이 같아야 한다. ----
  report(
    goldenOk &&
    JSON.stringify(sel1) === JSON.stringify(sel2),
    "골든: 동일 인자로 collectGitFacts를 2회 실행해도 선택 집합이 동일함(샘플링 결정성)"
  );

  // ---- coverage 3수치(이월 게이트 A-3/B-2) — traversed==300, total은
  // 픽스처 선언값(ownerTotal)과 일치, analyzed==K==50, 부등식 성립. ----
  report(goldenOk && run1?.coverage?.traversed === 300, `골든: coverage.traversed === 300 (실제 ${run1?.coverage?.traversed})`);
  report(
    goldenOk &&
    run1?.coverage?.total === declared.ownerTotal,
    `골든: coverage.total === 픽스처 선언값 ownerTotal(${declared.ownerTotal}) (실제 ${run1?.coverage?.total}) — ` +
      "B-1/B-2 '250 하드코딩' 회귀 방지, 픽스처 구성값과 직접 대조"
  );
  report(
    goldenOk &&
    run1?.coverage?.total === golden?.coverage?.total && run1?.coverage?.analyzed === golden?.coverage?.analyzed,
    `골든: coverage.total/analyzed가 sampling-300.expected.json과 일치(total=${golden?.coverage?.total}, analyzed=${golden?.coverage?.analyzed})`
  );
  report(
    goldenOk &&
    run1?.coverage?.analyzed <= run1?.coverage?.total && run1?.coverage?.total < run1?.coverage?.traversed,
    `골든: analyzed(${run1?.coverage?.analyzed}) <= total(${run1?.coverage?.total}) < traversed(${run1?.coverage?.traversed}) 관계식 성립`
  );

  // ---- truncated: dropped_commits == total - K, reason == budget_commits. ----
  report(
    goldenOk &&
    run1?.truncated?.reason === "budget_commits" &&
      run1?.truncated?.dropped_commits === run1?.coverage?.total - run1?.coverage?.analyzed,
    `골든: truncated.reason==="budget_commits" 및 dropped_commits===total-analyzed(${run1?.truncated?.dropped_commits})`
  );

  // ---- samplingMethod 완전 일치(재서술 금지 — 리터럴 그대로). ----
  report(
    goldenOk &&
    run1?.coverage?.samplingMethod === golden?.samplingMethodLiteral,
    "골든: coverage.samplingMethod가 정본 samplingMethod 리터럴과 완전 일치"
  );

  // ---- 선택 커밋 집합이 골든 파일과 완전 일치(개수 항등식이 아니라
  // 원소 단위 대조 — slice(0,max)·dedup 누락·정렬 키 오구현을 모두 잡는다). ----
  const selMatches = sel1 !== null && JSON.stringify(sel1) === JSON.stringify(golden?.selectedCommitHashesSorted);
  if (!selMatches && sel1 !== null) {
    const goldenSet = new Set(golden?.selectedCommitHashesSorted);
    const actualSet = new Set(sel1);
    const missing = golden?.selectedCommitHashesSorted.filter((h) => !actualSet.has(h));
    const extra = sel1.filter((h) => !goldenSet.has(h));
    console.log(`    개수: 기대 ${golden?.selectedCommitHashesSorted?.length} / 실제 ${sel1.length}`);
    console.log(`    골든에는 있으나 실제엔 없음(최대 5건): ${missing.slice(0, 5).join(", ")}`);
    console.log(`    실제엔 있으나 골든엔 없음(최대 5건): ${extra.slice(0, 5).join(", ")}`);
  }
  report(goldenOk && selMatches, "골든: 선택 커밋 집합(정렬됨)이 fixtures/golden/sampling-300.expected.json과 완전 일치");

  // ---- excluded 커밋 전량 등재(AC-7 (a)축·AC-9가 절단 상태에서도 관측
  // 가능해야 한다는 구현 5단계 요구) — traversed - total과 정확히 같아야 한다. ----
  const excludedCount = run1 === null ? null : run1.commits.filter((c) => c.excluded).length;
  report(
    goldenOk &&
    excludedCount === run1?.coverage?.traversed - run1?.coverage?.total,
    `골든: excluded 커밋이 원장에 전량 등재됨(excluded=${excludedCount} === traversed-total=${run1?.coverage?.traversed - run1?.coverage?.total})`
  );

  // ---- AC-6 회귀: 300커밋 규모(실제 머지 5건 포함)의 실제 수집 결과에도
  // 새 교차 불변식이 위반 0건이어야 한다(무오탐 재확인, 더 큰 표본). ----
  // `run1`이 null이면 불변식 검사를 부르지 않는다 — 위 게이트가 이미 FAIL을 보장하므로
  // 빈 배열이어도 초록이 되지 않지만, 호출 자체가 터지면 섹션이 중단된다.
  const invariantViolations = run1 === null ? [] : checkEvidenceInvariants(run1);
  if (invariantViolations.length > 0) {
    for (const v of invariantViolations) console.log(`    실제 위반: ${v.code}: ${v.message}`);
  }
  report(goldenOk && invariantViolations.length === 0, "골든: 300커밋 실제 수집 결과(머지 5건 포함)에 AC-6 교차 불변식 위반 0건");
  const nonVacuous = run1 === null ? [] : checkMergeNonVacuous(run1);
  report(goldenOk && nonVacuous.length === 0, "골든: 300커밋 픽스처의 실제 원장에 머지 5건이 (iv) 비공허성을 만족함");
}

// ---------------------------------------------------------------------------
// 콜드 리뷰 A-7 대응: contentHash 재계산·대조 + sourceRepoHead 스테일 경고가
// 실제로 배선됐는지 실제 collectGitFacts() 산출물로 관측한다. "정본만
// 선언되고 코드는 0곳" 상태였던 계약을 collect-git-facts.mjs(쓰기)·
// verify-evidence.mjs(검증)·validate-plugin.mjs --schema-check(검증) 세
// 지점 모두에서 실제로 잡는지 확인한다.
// ---------------------------------------------------------------------------
function runContentHashAndStalenessSmoke() {
  console.log("[contentHash·스테일 경고 스모크] A-7 — 재계산·대조가 collect-git-facts/verify-evidence/schema-check 세 지점 모두에 배선됐는지 관측");

  const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-contenthash-"));
  try {
    const dir = path.join(tmpBase, "repo");
    buildMultiAuthor(dir);

    const collect = () =>
      collectGitFacts({
        repoPath: dir,
        selectedIdentities: [OWNER_EMAIL],
        ref: "HEAD",
        maxCommits: 1000,
      }).evidence;

    const evidence = collect();

    // ---- 결정성: generatedAt을 해시 대상에서 제외했으므로, 같은 레포·같은
    // 옵션의 두 번째 실행도 동일한 contentHash를 낸다. ----
    {
      const evidence2 = collect();
      report(
        evidence.contentHash === evidence2.contentHash,
        "A-7: 같은 레포·같은 옵션의 두 번째 실행도 동일한 contentHash를 냄(generatedAt 제외 결정성)"
      );
      report(
        computeEvidenceContentHash(evidence) === evidence.contentHash,
        "A-7: collect-git-facts.mjs가 기록한 contentHash가 scripts/lib/content-hash.mjs 재계산값과 일치(쓰기·검증 동일 구현 공유)"
      );
    }

    // ---- 무오탐: 실제 수집기 출력은 재계산·대조를 통과한다. ----
    {
      const v = checkContentHashInvariant(evidence);
      report(v.length === 0, "무오탐: 실제 수집기 출력의 contentHash가 재계산값과 일치(checkContentHashInvariant 위반 0건)");
    }

    // ---- FAIL 관측(순수 함수 단위): 본문 한 글자만 바꾸고 contentHash는
    // 그대로 두면 즉시 FAIL. ----
    {
      const mutated = structuredClone(evidence);
      mutated.coverage.total = mutated.coverage.total + 1; // 본문만 변조, contentHash는 그대로
      const v = checkContentHashInvariant(mutated);
      const ok = v.length === 1 && v[0].code === "EVIDENCE_CONTENT_HASH_MISMATCH";
      if (!ok) console.log(`    실제: ${JSON.stringify(v)}`);
      report(ok, "FAIL 관측: coverage.total만 변조하고 contentHash는 그대로 두면 EVIDENCE_CONTENT_HASH_MISMATCH(checkContentHashInvariant)");
    }

    // ---- FAIL 관측(checkEvidenceInvariants 집계 — --schema-check evidence
    // 경로의 정본과 동일 함수). ----
    {
      const mutated = structuredClone(evidence);
      mutated.contentHash = mutated.contentHash.slice(0, -1) + (mutated.contentHash.endsWith("0") ? "1" : "0");
      const v = checkEvidenceInvariants(mutated);
      const ok = v.some((x) => x.code === "EVIDENCE_CONTENT_HASH_MISMATCH");
      if (!ok) console.log(`    실제: ${JSON.stringify(v)}`);
      report(ok, "FAIL 관측: checkEvidenceInvariants(--schema-check evidence 경로가 실제로 호출하는 정본 집계)도 contentHash 1글자 변조를 잡음");
    }

    // ---- FAIL 관측(verify-evidence.mjs 오케스트레이션 — hasFailures에
    // 포함돼 exit 1로 이어지는지). ----
    {
      const mutated = structuredClone(evidence);
      mutated.commits[0].subject = mutated.commits[0].subject + " (A-7 변조 관측)";
      const r = verifyEvidence({
        repoPath: dir,
        evidence: mutated,
        selectedIdentities: [OWNER_EMAIL],
        artifactsByLayer: {},
      });
      const ok =
        r.status === "FAIL" &&
        r.ok === false &&
        r.contentHashViolations.length === 1 &&
        r.contentHashViolations[0].code === "EVIDENCE_CONTENT_HASH_MISMATCH" &&
        r.summary.contentHashViolations === 1 &&
        exitCodeForReport(r) === 1;
      if (!ok) console.log(`    실제: status=${r.status} ok=${r.ok} contentHashViolations=${JSON.stringify(r.contentHashViolations)} exit=${exitCodeForReport(r)}`);
      report(ok, "FAIL 관측: verify-evidence.mjs의 verifyEvidence()도 본문 변조(contentHash 불일치)를 FAIL로 집계(exit 1)");
    }

    // ---- sourceRepoHead 스테일 경고: 수집 직후에는 stale===false(무오탐). ----
    {
      const r = verifyEvidence({
        repoPath: dir,
        evidence,
        selectedIdentities: [OWNER_EMAIL],
        artifactsByLayer: {},
      });
      const ok = r.sourceRepoHeadStaleness.checked === true && r.sourceRepoHeadStaleness.stale === false && r.status === "PASS";
      if (!ok) console.log(`    실제: ${JSON.stringify(r.sourceRepoHeadStaleness)}, status=${r.status}`);
      report(ok, "무오탐: 수집 직후 재검증하면 sourceRepoHeadStaleness.stale===false(레포에 새 커밋 없음), status=PASS");
    }

    // ---- sourceRepoHead 스테일 경고: 레포에 새 커밋을 추가한 뒤 옛
    // evidence.json으로 재검증하면 stale===true이지만 FAIL은 아니다(정보성
    // 경고 — B-1의 fail-open과 정반대 방향 회귀도 만들지 않는다: "경고
    // 하나 늘었다고 exit 1로 만들지 않는다"). ----
    {
      crWriteFile(dir, "after-collection.txt", "new commit after evidence collection\n");
      crGit(dir, ["add", "after-collection.txt"]);
      crGit(dir, ["commit", "-q", "-m", "chore: commit after evidence collection"], {
        GIT_AUTHOR_NAME: "owner", GIT_AUTHOR_EMAIL: OWNER_EMAIL, GIT_AUTHOR_DATE: "2030-01-01T00:00:00",
        GIT_COMMITTER_NAME: "owner", GIT_COMMITTER_EMAIL: OWNER_EMAIL, GIT_COMMITTER_DATE: "2030-01-01T00:00:00",
      });

      const currentHead = runGit(dir, ["rev-parse", "HEAD"]).stdout.trim();
      const r = verifyEvidence({
        repoPath: dir,
        evidence, // 아직 재수집 전 — sourceRepoHead가 옛 HEAD를 가리킨다
        selectedIdentities: [OWNER_EMAIL],
        artifactsByLayer: {},
      });
      const ok =
        r.sourceRepoHeadStaleness.checked === true &&
        r.sourceRepoHeadStaleness.stale === true &&
        r.sourceRepoHeadStaleness.currentHead === currentHead &&
        r.sourceRepoHeadStaleness.sourceRepoHead === evidence.sourceRepoHead &&
        currentHead !== evidence.sourceRepoHead &&
        r.status === "PASS"; // 스테일은 FAIL이 아니다 — status에 영향 없음(정보성 경고)
      if (!ok) console.log(`    실제: ${JSON.stringify(r.sourceRepoHeadStaleness)}, status=${r.status}, currentHead=${currentHead}`);
      report(
        ok,
        "경고 관측(FAIL 아님): 레포에 새 커밋을 추가한 뒤 옛 evidence.json으로 재검증하면 " +
        "sourceRepoHeadStaleness.stale===true이지만 status는 여전히 PASS(정보성 경고, AC-22)"
      );
    }
  } finally {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 콜드 리뷰 A-19 대응: 정본 samplingMethod 리터럴 드리프트 가드가 실제로
// 드리프트를 잡는지, 그리고 이 레포의 현재 네 곳(spec.md·스키마·
// sampling.mjs·골든 스크립트)이 지금 실제로 동기화돼 있는지를 관측한다.
// 이전에는 이 대조(assertNoLiteralDrift)가 fixtures/golden/compute-
// sampling-golden.mjs 안에만 있었고 그 스크립트를 호출하는 게이트가 없어
// 정본(스키마)만 고쳐도 4개 게이트가 전부 녹색으로 남았다 — 이제는
// scripts/validate-plugin.mjs의 기본 검사(npm run lint)가 매 실행 이
// 함수를 호출한다(항진명제 없음, 위 npm run lint 실측이 그 증거다).
// ---------------------------------------------------------------------------
function runSamplingLiteralDriftSmoke() {
  console.log("[samplingMethod 리터럴 드리프트 스모크] A-19 — spec.md·스키마·sampling.mjs·골든 스크립트 네 곳 동기화 + 드리프트 실제 탐지 관측");

  // ---- 무오탐: 이 레포의 현재 네 곳은 실제로 동기화돼 있다(npm run lint가
  // 통과한다는 사실과 동일한 검사를 여기서 직접 재확인한다). ----
  {
    const result = checkSamplingMethodLiteralDrift(REPO_ROOT);
    if (!result.ok) {
      console.log(`    missing=${JSON.stringify(result.missing)} mismatches=${JSON.stringify(result.mismatches)}`);
    }
    report(result.ok, "무오탐: 이 레포의 spec.md·스키마·sampling.mjs·골든 스크립트 리터럴 네 곳이 현재 완전히 동기화됨");
  }

  // ---- FAIL 관측: 스키마 description의 리터럴만 한 글자 바꾼 임시 사본을
  // 만들어(실제 레포 파일은 건드리지 않는다), 골든 스크립트·spec.md는
  // 원문 그대로 둔 채 대조하면 드리프트가 잡히는지 확인한다. sampling.mjs
  // 상수는 실제 import(라이브 코드)라서 파일 단위로 몰래 바꿔치기할 수
  // 없으므로, "정본(스키마)만 고치고 사본을 잊는" 콜드 리뷰 A-19의 정확한
  // 실패 시나리오(스키마만 드리프트, 나머지 세 곳은 실제 값)를 그대로
  // 재현한다. ----
  {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-sampling-drift-"));
    try {
      // **재현 전제의 부재를 예외로 두지 않는다 — 각 단언의 FAIL로 떨어뜨린다.**
      // 이 블록은 실제 레포 파일 세 개(스키마·골든 스크립트·spec.md)를 읽어
      // 임시 사본을 조립한다. 초판은 그 읽기를 맨몸 `readFileSync`·
      // `copyFileSync`로 했고, 그중 하나라도 없으면 예외가 `runSection`까지
      // 올라가 **섹션 전체가 [중단]**됐다 — 아래 두 단언이 각각 FAIL로 떨어지는
      // 대신 "섹션이 예외로 중단됨" 한 줄만 남아 **어느 축이 무너졌는지 읽을
      // 수 없다.** (실측: `spec.md`를 지운 격리 사본에서 이 섹션이 spec.md를
      // 복사하는 `copyFileSync`의 ENOENT로 중단됐다 — 그 회차의 FAIL 4건 중
      // 하나가 「섹션이 예외로 중단됨」이었다.) 이 레포의 완료 조건이 「파일·필드
      // 부재를 예외가 아니라 각 단언의 FAIL로 떨어뜨려라」를 요구하므로
      // 규칙 위반이었다.
      //
      // **사유를 두 단언 전량에 싣지 않고, 그 파일에 의존하는 단언에만 싣는다.**
      // 전량에 실으면 어느 파일이 없었는지가 다시 뭉뚱그려져 「어느 경로로
      // 실패했는가를 고정하라」를 반대쪽에서 어긴다. 사전 확인은 스키마
      // 하나에만 의존하고, 드리프트 대조는 세 파일 전부에 의존한다.
      //
      // **경로는 가드가 쓰는 정본 상수로 조립한다.** 세그먼트를 손으로 적으면
      // `spec.md`가 옮겨질 때 이 사본만 조용히 옛 경로를 보고, 가드는 새 경로를
      // 봐서 둘 다 값을 얻지 못하는데도 대조가 초록이 될 수 있다.
      // 판독·사유 포맷은 파일 상단의 `makeReadTracker()`가 담당한다(2026-08-24). 초판은 이 자리에
      // `readFailures` Map과 `readRepoText`·`blameFor`를 손으로 두었고, 그것이 이 파일의 3중
      // 재구현 중 하나였다 — 콜드 리뷰가 지적한 그 지점이다. **실패 정책(단언별 귀책 분배)은
      // 여기 남는다** — 통일하는 것은 판독과 사유 포맷뿐이다.
      const tracker = makeReadTracker();
      const { readText, note, blameFor } = tracker;

      const schemaText = readText(EVIDENCE_SCHEMA_REL);
      const goldenText = readText(GOLDEN_SCRIPT_REL);
      const specText = readText(SPEC_MD_REL);

      // 스키마의 파싱 실패·형태 변화도 예외가 아니라 사유다 — description이
      // 사라지거나 문자열이 아니게 되면 아래 `desc.replace`가 TypeError로 터진다.
      // 이 두 갈래는 「판독 실패」와 성격이 달라(파일은 읽혔다) `note()`로 같은 귀책 경로에 얹는다.
      let schema = null;
      let desc = null;
      if (schemaText !== null) {
        try {
          schema = JSON.parse(schemaText);
        } catch (e) {
          note(EVIDENCE_SCHEMA_REL, `JSON 파싱 실패: ${e.message}`);
        }
        if (schema !== null) {
          const raw = schema?.$defs?.coverage?.properties?.samplingMethod?.description;
          if (typeof raw === "string") desc = raw;
          else note(EVIDENCE_SCHEMA_REL, "coverage.samplingMethod.description이 문자열이 아님");
        }
      }

      // 정본 리터럴의 마지막 글자 하나만 바꾼다(예: "bucket" → "buckeu") —
      // 사람이 실수로 오타를 낸 것과 같은 형태의 드리프트.
      const mutatedDesc = desc === null ? null : desc.replace("carry-to-next-bucket`", "carry-to-next-buckeu`");
      const schemaBlame = blameFor([EVIDENCE_SCHEMA_REL]);
      if (schemaBlame) console.log(`    실제: 스키마 판독 실패 — ${schemaBlame}`);
      report(
        mutatedDesc !== null && mutatedDesc !== desc,
        "사전 확인: 임시 스키마 사본의 samplingMethod description이 실제로 1글자 변조됨(재현 전제 성립)"
      );

      // 세 파일 중 하나라도 판독하지 못했으면 드리프트 대조는 **성립하지 않는다.**
      // 그 상태에서 그냥 대조하면 결함이 있는 사본으로도 `ok`가 참이 될 수 있다
      // (예: spec.md만 없으면 present 세 곳 중 스키마가 여전히 어긋나 mismatches에
      // 잡힌다) — 즉 불완전한 픽스처 위에서 통과하는 검사가 된다.
      let driftOk = false;
      const fixtureBlame = blameFor([EVIDENCE_SCHEMA_REL, GOLDEN_SCRIPT_REL, SPEC_MD_REL]);
      if (fixtureBlame) {
        console.log(`    실제: 재현 전제 불성립 — 레포 파일 판독 실패: ${fixtureBlame}`);
      } else {
        // 스키마만 변조본으로 쓰고, 골든 스크립트·spec.md는 원문 그대로 쓴다.
        schema.$defs.coverage.properties.samplingMethod.description = mutatedDesc;
        for (const [rel, text] of [
          [EVIDENCE_SCHEMA_REL, JSON.stringify(schema, null, 2)],
          [GOLDEN_SCRIPT_REL, goldenText],
          [SPEC_MD_REL, specText],
        ]) {
          const dest = path.join(tmpRoot, rel);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.writeFileSync(dest, text, "utf8");
        }

        const result = checkSamplingMethodLiteralDrift(tmpRoot);
        driftOk = result.ok === false && result.mismatches.includes(EVIDENCE_SCHEMA_REL);
        if (!driftOk) console.log(`    실제: ok=${result.ok} mismatches=${JSON.stringify(result.mismatches)} missing=${JSON.stringify(result.missing)}`);
      }
      report(
        driftOk,
        "FAIL 관측: 스키마 description의 정본 리터럴만 1글자 바꾸면(sampling.mjs·골든 스크립트·spec.md는 그대로) " +
        "checkSamplingMethodLiteralDrift가 'schemas/evidence.schema.json'을 드리프트로 지목함"
      );
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }

  // ---- FAIL 관측(missing): 네 파일 중 하나가 아예 없으면(예: 리터럴이
  // 통째로 삭제되거나 파일이 옮겨짐) "조용히 건너뛰지" 않고 missing으로
  // 보고한다. ----
  {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-sampling-missing-"));
    try {
      // schemas/, fixtures/golden/, docs/ 어느 것도 만들지 않는다 — 완전히 빈 루트.
      const result = checkSamplingMethodLiteralDrift(tmpRoot);
      const ok =
        result.ok === false &&
        result.missing.includes("schemas/evidence.schema.json") &&
        result.missing.includes("fixtures/golden/compute-sampling-golden.mjs") &&
        result.missing.includes("docs/devcareer-prep-plugin/spec.md");
      if (!ok) console.log(`    실제: ${JSON.stringify(result)}`);
      report(ok, "FAIL 관측(missing): 스키마·골든 스크립트·spec.md 세 파일이 모두 없으면(빈 루트) 조용히 통과하지 않고 missing으로 보고");
    } finally {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  }
}

async function runDefaultSmoke() {
  console.log("[기본 스모크] 정상 레포(레포 루트)에서 validate-plugin이 exit 0을 내는지 확인");
  const result = await runValidation({ root: REPO_ROOT, explicitRoot: false });
  if (!result.ok) {
    for (const e of result.errors) {
      console.log(`    [FAIL] ${e.code}: ${e.message}${e.file ? ` (${e.file})` : ""}`);
    }
  }
  for (const w of result.warnings) {
    console.log(`    [WARN] ${w.code}: ${w.message}${w.file ? ` (${w.file})` : ""}`);
  }
  report(result.ok, "정상 레포 → exit 0 (AC-1)");
}

async function runNegativeSuite() {
  console.log("[negative 스위트] tests/fixtures-invalid/ 케이스 + tests/fixtures-valid/ positive 픽스처");

  preflightCrFixtureBytes();

  for (const c of NEGATIVE_CASES) {
    const caseDir = path.join(TESTS_DIR, "fixtures-invalid", c.dir);
    let result;
    if (c.mode === "plugin") {
      result = await runValidation({ root: caseDir, explicitRoot: true });
    } else if (c.mode === "schema") {
      result = await runSchemaCheck({ instancePath: path.join(caseDir, c.file ?? "career.json") });
    } else if (c.mode === "secret") {
      result = await runSecretScan({ artifactPath: path.join(caseDir, c.file ?? "career.json") });
    } else {
      result = await runLangCheck({ outDir: caseDir });
    }
    const hasCode = result.errors.some((e) => e.code === c.code);
    // 범용 오류 코드(SCHEMA_CHECK_VIOLATION 등)를 쓰는 케이스는 코드 일치만
    // 보면 "다른 이유로 FAIL해도 통과"하는 자기충족 검사가 된다 —
    // messageIncludes가 있는 케이스는 위반 메시지에 그 문자열이 실제로
    // 들어 있는지까지 확인해 겨냥한 절이 발화했음을 관측한다.
    const hasMessage = c.messageIncludes
      ? result.errors.some((e) => e.code === c.code && String(e.message).includes(c.messageIncludes))
      : true;
    const ok = !result.ok && hasCode && hasMessage;
    if (!ok) {
      console.log(`    케이스 (${c.n}) ${c.label}: ok=${result.ok} 기대 코드 '${c.code}' 존재=${hasCode} 기대 메시지 조각=${c.messageIncludes ?? "(없음)"} 존재=${hasMessage}`);
      for (const e of result.errors) console.log(`      실제 오류: ${e.code}: ${e.message}`);
    }
    report(
      ok,
      `케이스 (${c.n}) ${c.label} → exit 1 + ${c.code}${c.messageIncludes ? ` (메시지에 '${c.messageIncludes}' 포함)` : ""}`
    );
  }

  const positiveDir = path.join(TESTS_DIR, "fixtures-valid");
  const positiveResult = await runLangCheck({ outDir: positiveDir });
  if (!positiveResult.ok) {
    for (const e of positiveResult.errors) console.log(`    실제 오류: ${e.code}: ${e.message}`);
  }
  report(positiveResult.ok, "tests/fixtures-valid/ positive 픽스처 → exit 0 (AC-19 오탐 없음)");

  // 게이트 C-1의 오탐 방향을 CLI 경로(runSecretScan)로도 관측한다. 라이브러리
  // 수준 오라클(runSecretScanOracleSmoke)이 이미 같은 성질을 보지만, 그것은
  // scanForSecrets를 직접 부른다 — 스키마 해석·파일 읽기·오류 코드 부착을
  // 담당하는 runSecretScan 자체가 정상 산출물에서 조용히 빨갛게 되는 회귀는
  // 그 오라클로 잡히지 않는다. 세 계층 전부를 도는 이유도 같다: 한 계층만
  // 보면 "다른 계층의 스키마에서 면제 경로 수집이 깨졌다"를 놓친다.
  for (const layer of ["career", "knowledge-map", "gap-report"]) {
    const artifactPath = path.join(positiveDir, `${layer}.json`);
    if (!fs.existsSync(artifactPath)) {
      report(false, `positive 픽스처 ${layer}.json이 없어 시크릿 스캔 오탐 관측이 공허해짐`);
      continue;
    }
    const r = await runSecretScan({ artifactPath });
    if (!r.ok) for (const e of r.errors) console.log(`    실제 오류: ${e.code}: ${e.message}`);
    report(r.ok, `tests/fixtures-valid/${layer}.json → --secret-scan exit 0 (게이트 C-1 오탐 없음)`);
  }

  // AC-3(b): 알 수 없는 SPDX 라이선스는 FAIL이 아니라 SKIP 경고여야 한다.
  const skipCaseDir = path.join(TESTS_DIR, "fixtures-invalid", UNKNOWN_LICENSE_SKIP_CASE.dir);
  const skipResult = await runValidation({ root: skipCaseDir, explicitRoot: true });
  const hasSkipWarning = skipResult.warnings.some((w) => w.code === UNKNOWN_LICENSE_SKIP_CASE.warnCode);
  const skipOk = skipResult.ok && hasSkipWarning;
  if (!skipOk) {
    console.log(`    케이스 (10) ${UNKNOWN_LICENSE_SKIP_CASE.label}: ok=${skipResult.ok} 기대 경고 '${UNKNOWN_LICENSE_SKIP_CASE.warnCode}' 존재=${hasSkipWarning}`);
    for (const e of skipResult.errors) console.log(`      실제 오류: ${e.code}: ${e.message}`);
  }
  report(skipOk, `케이스 (10) ${UNKNOWN_LICENSE_SKIP_CASE.label}`);
}

// ---------------------------------------------------------------------------
// 임무 3(구현자 — 탐지 경로 최종 보강, 결함 3): 섹션 단위 예외 격리. 이전에는
// 한 섹션(runVerifyEvidenceSmoke 등)이 uncaught 예외로 죽으면 main().catch가
// 받아 "[중단] ..."만 출력하고 그 뒤의 모든 섹션 + 최종 "결과: N PASS /
// M FAIL" 요약 줄 자체가 통째로 사라졌다(M-b/M-d/M-bd 실측: 세 실행 모두
// "결과:" 줄 없음) — 진단 품질과 탐지 품질을 동시에 깎는 구조였다.
// runSection/runSectionAsync가 섹션 하나씩을 개별 try/catch로 감싸,
// 그 섹션이 예외로 죽어도 나머지 섹션과 요약 줄이 항상 출력되게 한다.
// 잡은 예외는 조용히 넘기지 않고 그 섹션의 FAIL 1건으로 집계한다(절대
// 규칙) — 최종 종료 코드는 FAIL이 1건이라도 있으면 여전히 1이다.
// ---------------------------------------------------------------------------

function runSection(label, fn) {
  try {
    fn();
  } catch (e) {
    abortedSections += 1;
    console.log(`  [중단] 섹션 "${label}" 실행 중 예외 발생: ${e.stack ?? e.message}`);
    report(false, `섹션 "${label}"이 예외로 중단됨(${e.message})`);
  }
}

async function runSectionAsync(label, fn) {
  try {
    await fn();
  } catch (e) {
    abortedSections += 1;
    console.log(`  [중단] 섹션 "${label}" 실행 중 예외 발생: ${e.stack ?? e.message}`);
    report(false, `섹션 "${label}"이 예외로 중단됨(${e.message})`);
  }
}

/**
 * 모드의 마지막에 스위트 자체의 성질 2건을 단언하고 「결과:」를 찍은 뒤 종료한다.
 *
 * **왜 이 둘이 필요한가.** 지금까지 총량은 `console.log`로 출력만 됐고 어디서도 단언되지
 * 않았다(실측: 이 파일에 기대 총량 리터럴이 0건이었다). 그래서 섹션이 예외로 중단돼 단언
 * 여러 건이 **실행조차 되지 않아도** 「결과: N PASS / 0 FAIL」이 초록으로 보였고, 줄어든
 * 총량을 사람이 눈으로 대조해야만 알아챌 수 있었다. 그 육안 대조는 실제로 실패했다.
 *
 * **아래 실측치 3건은 전부 `default = 445` 기준이다(2026-08-21 측정).** 정본 상수가 그 뒤로
 * 445 → 448 → 459 → 463으로 올랐으므로 **지금 트리에서 재현하면 수치가 그만큼 어긋난다** —
 * 회귀로 오독하지 마라. 여기 남는 것은 절대 수치가 아니라 **관계**다(가드가 FAIL했는가 아닌가,
 * 몇 건이 사라졌는가). 수치를 갱신하지 않는 이유는 그것이 이 주석을 다음 커밋에 또 낡게 만드는
 * 바로 그 습관이기 때문이다 — 정본은 아래 `EXPECTED_ASSERTIONS_BEFORE_GUARDS` 한 곳뿐이다.
 *
 * **두 가드의 관계 — 실측으로 좁힌 것이다. 「서로를 감시한다」고 읽지 마라.**
 * 초판 주석이 그렇게 적었는데 변이로 **반증됐다**(2026-08-21):
 *
 * - **총량 가드는 「카운터가 무력화된 중단 가드」를 받쳐 준다.** `abortedSections += 1`을 지우고
 *   섹션을 강제 중단시키면 중단 가드는 **공허하게 PASS**하지만, 그 섹션의 단언이 사라졌으므로
 *   총량 가드가 FAIL한다(실측 443 PASS / 2 FAIL). 이것이 둘 사이의 **실재하는** 안전망이다.
 * - **총량 가드는 「삭제된 중단 가드」를 보지 못한다.** 중단 가드 한 줄을 지우면 총량 가드는
 *   그대로 PASS한다(실측 446 PASS / **0 FAIL**). 아래에서 `observed`를 가드 실행 **전**에
 *   잡으므로 가드 자신의 개수는 `observed`에 들어가지 않는다 — 즉 가드를 지우는 변경은
 *   이 축이 아니라 리뷰가 잡아야 한다. 그 한계를 메우려고 「가드를 **세는** 가드」를 두지는
 *   않는다: 개수를 세는 메타 가드는 끝없이 재귀하고, 이 레포의 관례는 막지 못하는 것을
 *   정확히 적어 두는 쪽이다. **개수 축의 이야기이며, 형태 축은 아래에서 달라졌다.**
 *
 * **정정(2026-09-02, 라운드 2 처방 11).** 이 자리에 있던 서술 — 「정확 일치를 하한(`>=`)으로
 * 완화하는 변이는 무변이 트리에서 아무것도 깨지 않는다(실측 447 PASS / 0 FAIL)」 — 은
 * **더 이상 참이 아니다.** `runSliceRuleObservationSmoke`의 `(GP-2)`가 이 함수 본문을 소스
 * 스캔해 완화형 비교를 금지하고, `(GP-3)`이 정확 일치 비교의 실재를 허용 방향으로 못 박으며,
 * `(GP-4)`가 「연산자는 그대로 두고 피연산자를 계산식으로 바꾸는」 갈래를 막는다.
 * 그 절이 세우는 것은 **개수 축이 아니라 형태 축**이므로 바로 위 문단의 결정과 충돌하지
 * 않는다 — 그쪽은 자기 개수를 세지 말라는 것이고, 이쪽은 비교의 모양을 본다.
 * **여전히 남는 한계**: 하한의 약점 자체(「단언을 3건 늘리고 2건 잃어 순증 +1」)는 형태 축이
 * 아니라 정확 일치 그 자체가 막는 것이고, `(GP-2)`가 지키는 것은 그 정확 일치가 조용히
 * 완화되지 않는다는 사실뿐이다.
 *
 * @param {"default"|"negative"|"golden"} mode
 * @returns {never} `process.exit`으로 끝난다 — **돌아오지 않는다.** 세 호출부가 전부
 *   `return finishMode(...)` 형태인 것은 이 계약이 깨질 때(반환값을 돌려주게 바뀔 때)
 *   모드가 서로의 경로로 흘러내리지 않게 하려는 것이다.
 */
function finishMode(mode) {
  // 가드 자신을 세기 **전**의 총량. 아래 두 report() 호출이 이 수를 바꾸므로 먼저 잡는다.
  const observed = passed + failed;
  const expected = EXPECTED_ASSERTIONS_BEFORE_GUARDS[mode];

  if (abortedSections !== 0) {
    console.log(`    실제: 예외로 중단된 섹션 ${abortedSections}건 — 그 섹션의 단언은 실행되지 않았다`);
  }
  report(abortedSections === 0, `스위트 가드: 예외로 중단된 섹션 0건(모드 ${mode})`);

  if (observed !== expected) {
    const delta = observed - expected;
    console.log(
      `    실제: 단언 ${observed}건(기대 ${expected}건, ${delta > 0 ? "+" : ""}${delta}) — ` +
      (delta < 0
        ? "단언이 사라졌다. 섹션 중단이나 조기 return을 먼저 보라."
        : "단언이 늘었다. 의도한 추가라면 EXPECTED_ASSERTIONS_BEFORE_GUARDS를 함께 고쳐라.")
    );
  }
  report(observed === expected, `스위트 가드: 단언 총량 ${expected}건(모드 ${mode}, 가드 2건 제외)`);

  console.log(`\n결과: ${passed} PASS / ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

// A-36 대응: 아래 19개 runSection 호출("공통 섹션")은 이전에는 기본 모드와
// --negative 모드 양쪽에서 매번 다시 돌았다 — 동일 픽스처를 다시 만들고
// 동일 172개 단언을 문자열 단위로 그대로 반복해(실측: 두 실행의 PASS 라벨
// 교집합 172건) `npm test`의 실행 시간을 불필요하게 늘리고, 실패 시 같은
// 오류가 두 번 출력됐다. 이제 공통 섹션은 **기본 모드(플래그 없음)에서만**
// 돈다 — package.json의 `test` 스크립트가 플래그 없이 한 번 호출하므로
// `npm test` 경로에서 공통 섹션은 여전히 정확히 1회 실행되고 그 172개
// 단언은 하나도 사라지지 않는다(negative 전용 19개 단언은 negative 모드에서,
// 골든 11개 단언은 golden 모드에서 각각 그대로 실행된다 — 세 모드를 각각
// 단독으로 돌려도 그 모드 고유의 검사는 전부 유지된다). "python run-smoke.mjs
// --negative"를 단독으로 돌려 negative 픽스처 하나만 빠르게 확인하려는
// 개발자 워크플로도 이 변경으로 실제로 빨라진다(공통 섹션의 git 서브프로세스
// 수백 개를 더 이상 다시 스폰하지 않는다).
/**
 * `config.json` 쓰기 주체 오라클 — 순서 11번 / 결정 D3.
 *
 * **왜 이 절이 있는가.** `store.mjs`가 `readConfig`/`writeConfig` 계약을 갖고 있었지만
 * **프로덕션 호출자가 0건**이었다 — 스펙과 스키마가 정의한 `config.json`을 실제로
 * 만드는 주체가 레포에 없었고, 소비자(`verify-evidence --config`)만 있었다.
 * 그 비대칭 아래에서는 「설정이 잘못됐다」가 「인자를 빠뜨렸다」로 오진된다.
 *
 * **완료 조건이 왕복이다.** 새 CLI가 파일을 쓰고, 그 파일 **하나만으로**
 * `verify-evidence`가 `selectedIdentities`를 채워 exit 0에 도달하는 것을 본다.
 * `--identity`를 함께 주면 config가 실제로 쓰였는지 알 수 없으므로 **주지 않는다** —
 * 그리고 `(WC-2)`가 대조군으로 「config가 없으면 그 자리에서 죽는다」를 고정한다.
 * 둘이 짝일 때만 「config가 identity의 출처였다」가 증명된다.
 *
 * **금지 방향을 두 갈래로 나눈다.** default가 **없는** required(`budget`)와
 * default가 **있는** required(`snippetQuoting`)를 따로 본다 — 후자가 통과하면
 * 이 CLI가 스키마 default로 사용자 결정을 조용히 대신 채운다는 뜻이다.
 * 한 갈래만 보면 그 설계 결정이 관측되지 않는다.
 *
 * **`snippetQuoting`을 표본으로 쓰는 이유는 「위험해서」가 아니라 「default가 있어서」다.**
 * 그 필드는 오늘 아무 효과가 없는 P0 자리표시자다(스키마 description·콜드 리뷰 A-38).
 * 여기서 필요한 것은 **default가 선언된 required** 하나뿐이고, 그 조건을 만족하는 필드 중
 * 하나가 이것일 뿐이다 — 효과를 현재형으로 주장하지 않는다.
 */
function runConfigWriterSmoke() {
  console.log("[config 쓰기 주체 오라클] writeConfig를 감싸는 CLI가 실제로 쓰고, 그 파일만으로 검증기가 identity를 채우는가(D3)");

  const WRITE_CONFIG = path.join(REPO_ROOT, "scripts", "write-config.mjs");
  const VERIFIER = path.join(REPO_ROOT, "scripts", "verify-evidence.mjs");
  const COLLECTOR = path.join(REPO_ROOT, "scripts", "collect-git-facts.mjs");
  const FIXED_AT = "2026-08-25T00:00:00Z";

  // 이 절의 판독은 **절대 경로** 대상이라 파일 상단의 `readRepoTextSafe`(레포 루트
  // 기준 상대 경로)를 쓸 수 없다. 다른 절의 지역 헬퍼를 import해 오지도 않는다 —
  // 이 레포는 절 단위 독립성을 반복해 우선해 왔고, 대가는 두 줄뿐이다.
  const readTextAt = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
  const readJsonAt = (p) => { const t = readTextAt(p); if (t === null) return null; try { return JSON.parse(t); } catch { return null; } };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-config-"));
  try {
    const repoDir = path.join(tmp, "repo");
    buildSingleCommit(repoDir);

    const root = path.join(tmp, "store", STATE_DIR_NAME);
    fs.mkdirSync(root, { recursive: true });

    const collected = spawnSync(
      process.execPath,
      [COLLECTOR, "--repo", repoDir, "--identity", OWNER_EMAIL, "--out", root],
      { encoding: "utf8" }
    );
    const evPath = path.join(root, "evidence.json");

    /** 스키마를 만족하는 설정 입력. 키 하나를 빼는 변형으로 금지 방향을 만든다. */
    const baseInput = () => ({
      identitySelection: { candidates: [], selected: [OWNER_EMAIL] },
      scope: { ref: "HEAD", mergeIncluded: false, since: null, until: null },
      budget: { maxCommits: 50 },
      includeDiff: false,
      exclusions: { bots: true, vendoredPaths: true },
      storage: { root: "home", repoOptIn: false },
      snippetQuoting: false,
    });

    const runWriteConfig = (input, targetRoot, tag) => {
      const inPath = path.join(tmp, `in-${tag}.json`);
      fs.writeFileSync(inPath, JSON.stringify(input), "utf8");
      const res = spawnSync(
        process.execPath,
        [WRITE_CONFIG, "--in", inPath, "--root", targetRoot, "--updated-at", FIXED_AT],
        { encoding: "utf8" }
      );
      return { status: res.status, stderr: res.stderr ?? "" };
    };

    // ---- (WC-1) 허용 방향: 왕복이 실제로 성립하는가 ----
    //      `--identity`를 **주지 않는다.** 주면 config가 쓰였는지 알 수 없다.
    let cfgPath = null;
    {
      const w = runWriteConfig(baseInput(), root, "ok");
      cfgPath = path.join(root, "config.json");
      const written = readJsonAt(cfgPath);

      // 인용이 실제 커밋을 가리키는 산출물을 만들어 exit 0까지 간다 — 산출물이
      // 0건이면 게이트 C-5가 INCONCLUSIVE로 떨어뜨려 왕복이 성립하지 않는다.
      const ev = readJsonAt(evPath);
      const commit = (ev?.commits ?? []).find((c) => c.excluded !== true);
      const file = (commit?.files ?? [])[0];
      const careerPath = path.join(root, "career.json");
      if (ev !== null && commit !== undefined && file !== undefined) {
        fs.writeFileSync(careerPath, JSON.stringify({
          schemaVersion: "1.0.0",
          generatedAt: FIXED_AT,
          sourceRepoHead: ev.sourceRepoHead,
          contentHash: "b".repeat(64),
          coverage: ev.coverage,
          truncated: ev.truncated,
          nodes: [{
            id: "car:001",
            basis: "commit",
            evidence: [{ ledgerId: commit.id, path: file.path }],
            verification: { status: "verified", attempts: 1, reasonCode: null },
            origin: "generated",
            locked: false,
            text: "초기 커밋으로 픽스처 레포의 README를 작성했다.",
          }],
        }), "utf8");
      }

      const verified = spawnSync(
        process.execPath,
        [VERIFIER, "--repo", repoDir, "--evidence", evPath, "--config", cfgPath,
         "--artifact", `career=${careerPath}`, "--out-dir", root],
        { encoding: "utf8" }
      );

      const ok =
        collected.status === 0 &&
        w.status === 0 &&
        written !== null &&
        written.updatedAt === FIXED_AT &&
        typeof written.schemaVersion === "string" &&
        verified.status === 0;
      if (!ok) {
        console.log(`    실제: 수집=${collected.status} write-config=${w.status} 검증=${verified.status}`);
        console.log(`    stderr: ${(w.stderr + verified.stderr).slice(0, 400)}`);
      }
      report(
        ok,
        "(WC-1) 왕복: write-config.mjs가 config.json을 쓰고, --identity 없이 그 파일만으로 " +
        "verify-evidence가 selectedIdentities를 채워 exit 0에 도달한다(D3 완료 조건)"
      );
    }

    // ---- (WC-2) 대조군: config가 없으면 바로 그 자리에서 죽는가 ----
    //      이것이 없으면 (WC-1)의 exit 0이 「config 덕분」인지 「원래 identity가
    //      필요 없었던 것」인지 구별되지 않는다 — 두 미지값의 통과다.
    {
      const careerPath = path.join(root, "career.json");
      const without = spawnSync(
        process.execPath,
        [VERIFIER, "--repo", repoDir, "--evidence", evPath,
         "--artifact", `career=${careerPath}`, "--out-dir", root],
        { encoding: "utf8" }
      );
      const ok = without.status === 2 && (without.stderr ?? "").includes("selectedIdentities가 비어 있습니다");
      if (!ok) console.log(`    실제: exit=${without.status} stderr=${(without.stderr ?? "").slice(0, 250)}`);
      report(
        ok,
        "(WC-2) 대조군: 같은 호출에서 --config를 빼면 selectedIdentities가 비어 exit 2다" +
        "(WC-1의 exit 0이 config 덕분임을 고정한다)"
      );
    }

    // ---- (WC-3) 금지 방향: default가 **없는** required 누락 ----
    {
      const input = baseInput();
      delete input.budget;
      const target = path.join(tmp, "no-budget", STATE_DIR_NAME);
      fs.mkdirSync(target, { recursive: true });
      const r = runWriteConfig(input, target, "no-budget");
      const ok =
        r.status === 2 &&
        r.stderr.includes("[INPUT_ERROR]") &&
        r.stderr.includes("budget") &&
        readTextAt(path.join(target, "config.json")) === null;
      if (!ok) console.log(`    실제: exit=${r.status} stderr=${r.stderr.slice(0, 250)}`);
      report(
        ok,
        "(WC-3) 금지 방향: required 하나가 빠진 입력은 [INPUT_ERROR] + exit 2이고 **파일이 생기지 않는다**"
      );
    }

    // ---- (WC-4) 금지 방향: default가 **있는** required도 채우지 않는가 ----
    //      스키마가 `snippetQuoting`에 default:false를 두었지만 이 CLI는 쓰지 않는다.
    //      채우면 「스키마가 권하는 값」이 곧 「사용자가 확정한 값」으로 둔갑한다.
    {
      const input = baseInput();
      delete input.snippetQuoting;
      const target = path.join(tmp, "no-sq", STATE_DIR_NAME);
      fs.mkdirSync(target, { recursive: true });
      const r = runWriteConfig(input, target, "no-sq");
      const ok =
        r.status === 2 &&
        r.stderr.includes("snippetQuoting") &&
        readTextAt(path.join(target, "config.json")) === null;
      if (!ok) console.log(`    실제: exit=${r.status} stderr=${r.stderr.slice(0, 250)}`);
      report(
        ok,
        "(WC-4) 금지 방향: 스키마에 default가 있는 required(snippetQuoting)도 CLI가 채우지 않는다" +
        "(「스키마가 권하는 값」이 「사용자가 확정한 값」으로 둔갑하지 않는다)"
      );
    }

    // ---- (WC-5) 금지 방향: 저장 경계 밖 --root ----
    {
      const outside = path.join(tmp, "outside-boundary");
      fs.mkdirSync(outside, { recursive: true });
      const r = runWriteConfig(baseInput(), outside, "outside");
      const ok =
        r.status === 2 &&
        r.stderr.includes("[INPUT_ERROR]") &&
        r.stderr.includes(STATE_DIR_NAME) &&
        readTextAt(path.join(outside, "config.json")) === null;
      if (!ok) console.log(`    실제: exit=${r.status} stderr=${r.stderr.slice(0, 250)}`);
      report(
        ok,
        `(WC-5) 금지 방향: 경로에 ${STATE_DIR_NAME} 세그먼트가 없는 --root는 exit 2이고 쓰지 않는다(쓰기 경계)`
      );
    }

    // ---- (WC-6) 스탬프의 주인이 CLI인가 ----
    //      입력이 `updatedAt`을 실어 보내도 CLI 값이 이겨야 한다. 지면 호출자가
    //      「언제 확정한 설정인가」를 과거로 왜곡할 수 있다.
    {
      const input = baseInput();
      input.updatedAt = "1999-01-01T00:00:00Z";
      input.schemaVersion = "9.9.9";
      const target = path.join(tmp, "stamp", STATE_DIR_NAME);
      fs.mkdirSync(target, { recursive: true });
      // **원장을 복사한다(라운드 2 처방 5).** 이 루트는 수집기를 돌린 적이 없어
      // 원장 대조가 `LEDGER_MISSING`으로 죽는다 — 이 단언의 관측점은 스탬프의
      // 주인이지 원장이 아니므로, 재료를 갖춰 그 축을 그대로 살린다.
      fs.copyFileSync(evPath, path.join(target, "evidence.json"));
      const r = runWriteConfig(input, target, "stamp");
      const written = readJsonAt(path.join(target, "config.json"));
      const ok =
        r.status === 0 &&
        written !== null &&
        written.updatedAt === FIXED_AT &&
        written.schemaVersion === CONFIG_SCHEMA_VERSION;
      if (!ok) console.log(`    실제: exit=${r.status} written=${JSON.stringify(written)}`);
      report(
        ok,
        "(WC-6) 입력이 실은 updatedAt·schemaVersion을 CLI 값이 덮어쓴다(두 필드의 주인은 CLI다)"
      );
    }

    // -----------------------------------------------------------------------
    // 원장 대조 — 라운드 2 처방 5
    //
    // **전용 루트를 새로 만든다. 공용 `root`를 재사용하지 마라.** 그쪽에는 (WC-1)이
    // 이미 config.json을 써 두어 「미기록」이 어떤 변이에도 참이 된다 — 라벨이
    // 약속한 것이 공허해진다. (WC-3)(WC-4)(WC-5)가 신설 루트를 쓰는 것과 같은 모양이다.
    // -----------------------------------------------------------------------

    /** `.devcareer` 세그먼트를 가진 신설 루트를 만든다(원장은 호출자가 갖춘다). */
    const ledgerRoot = (tag) => {
      const p = path.join(tmp, `lg-${tag}`, STATE_DIR_NAME);
      fs.mkdirSync(p, { recursive: true });
      return p;
    };

    // ---- (WC-7) 금지 방향: 저자 게이트 미완료 ----
    {
      const target = ledgerRoot("empty-selected");
      fs.copyFileSync(evPath, path.join(target, "evidence.json"));
      const input = baseInput();
      input.identitySelection.selected = [];
      const r = runWriteConfig(input, target, "empty-selected");
      const ok =
        r.status === 2 &&
        r.stderr.includes("IDENTITY_GATE_INCOMPLETE") &&
        readTextAt(path.join(target, "config.json")) === null;
      if (!ok) console.log(`    실제: exit=${r.status} stderr=${r.stderr.slice(0, 250)}`);
      report(
        ok,
        "(WC-7) 금지 방향: identitySelection.selected가 빈 입력은 exit 2 + IDENTITY_GATE_INCOMPLETE이고 config.json이 생기지 않는다"
      );
    }

    // ---- (WC-8) 금지 방향: 원장에 없는 날조 저자 ----
    //      **이 갈래가 실제로 위조 비용을 올리는 유일한 지점이다.** 원장은 LLM이
    //      아니라 결정적 수집기가 git에서 만들므로, 거기 없는 이메일은 저자 게이트를
    //      실제로 수행하지 않았다는 증거다.
    {
      const target = ledgerRoot("fabricated");
      fs.copyFileSync(evPath, path.join(target, "evidence.json"));
      const FAKE = "fabricated@nowhere.invalid";
      const input = baseInput();
      input.identitySelection.selected = [OWNER_EMAIL, FAKE];
      const r = runWriteConfig(input, target, "fabricated");
      const ok =
        r.status === 2 &&
        r.stderr.includes("LEDGER_IDENTITY_SET_MISMATCH") &&
        r.stderr.includes(FAKE) &&
        readTextAt(path.join(target, "config.json")) === null;
      if (!ok) console.log(`    실제: exit=${r.status} stderr=${r.stderr.slice(0, 300)}`);
      report(
        ok,
        "(WC-8) 금지 방향: 원장에 없는 날조 저자를 담은 입력은 exit 2 + LEDGER_IDENTITY_SET_MISMATCH이고, 차집합이 그 이메일을 지목한다"
      );
    }

    // ---- (WC-9) 금지 방향: 원장이 없는 루트 ----
    //      **부재를 통과로 강등하지 않는다**(절대 규칙 6). 강등하면 이 검사를 없애는
    //      가장 싼 방법이 원장을 지우는 것이 된다.
    {
      const target = ledgerRoot("no-ledger");
      const r = runWriteConfig(baseInput(), target, "no-ledger");
      const ok =
        r.status === 2 &&
        r.stderr.includes("LEDGER_MISSING") &&
        readTextAt(path.join(target, "config.json")) === null;
      if (!ok) console.log(`    실제: exit=${r.status} stderr=${r.stderr.slice(0, 250)}`);
      report(
        ok,
        "(WC-9) 금지 방향: 경계는 통과하지만 원장이 없는 루트는 exit 2 + LEDGER_MISSING이고 config.json이 생기지 않는다"
      );
    }

    // ---- (WC-10) 허용 방향: 집합 동치이지 배열 동등이 아니다 ----
    //      **재료를 2저자로 바꾼 이유.** 공용 원장의 selectedIdentities는 원소가
    //      1건이라 「다른 순서」가 존재하지 않는다 — 그 재료로는 이 축이 공허하다.
    //      `buildMultiAuthor`는 `fixtures/make-fixture.mjs`가 export하고 이 파일이
    //      이미 import한다(슬라이스 A 제약은 「고치지 마라」이지 「쓰지 마라」가 아니다).
    {
      const multiRepo = path.join(tmp, "multi-repo");
      buildMultiAuthor(multiRepo);
      const target = ledgerRoot("set-equal");
      const c = spawnSync(
        process.execPath,
        [COLLECTOR, "--repo", multiRepo, "--identity", OWNER_EMAIL, "--identity", ALICE_EMAIL, "--out", target],
        { encoding: "utf8" }
      );
      const input = baseInput();
      // 원장과 **순서가 다르고 중복이 섞인** 정직한 입력.
      input.identitySelection.selected = [ALICE_EMAIL, OWNER_EMAIL, OWNER_EMAIL];
      const r = runWriteConfig(input, target, "set-equal");
      const written = readJsonAt(path.join(target, "config.json"));
      const ok = c.status === 0 && r.status === 0 && written !== null;
      if (!ok) console.log(`    실제: collect=${c.status} exit=${r.status} stderr=${r.stderr.slice(0, 250)}`);
      report(
        ok,
        "(WC-10) 허용 방향: 원장과 순서가 다르고 중복이 섞인 선택 저자는 exit 0으로 기록된다(비교가 배열이 아니라 집합이다)"
      );
    }

    // ---- (WC-11) 금지 방향: 원장 판독 실패는 부재와 다른 코드다 ----
    //      「--root를 확인하라」는 **손상된** 원장에 대해 거짓 안내다.
    {
      const target = ledgerRoot("broken-ledger");
      const broken = fs.readFileSync(evPath, "utf8").replace("{", "{{");
      fs.writeFileSync(path.join(target, "evidence.json"), broken, "utf8");
      const r = runWriteConfig(baseInput(), target, "broken-ledger");
      const ok =
        r.status === 2 &&
        r.stderr.includes("LEDGER_UNREADABLE") &&
        !r.stderr.includes("LEDGER_MISSING") &&
        readTextAt(path.join(target, "config.json")) === null;
      if (!ok) console.log(`    실제: exit=${r.status} stderr=${r.stderr.slice(0, 250)}`);
      report(
        ok,
        "(WC-11) 금지 방향: 원장이 있으나 파싱에 실패하면 exit 2 + LEDGER_UNREADABLE이다(부재와 같은 코드로 뭉개지 않는다)"
      );
    }

    // ---- (WC-12) 금지 방향: 선택 저자 기록의 부재 ----
    //      **빈 배열로 강등하지 않는다.** 강등하면 아래 집합 대조가 「원장에 아무도
    //      없다」로 읽어 엉뚱한 차집합을 보고하고, 부재가 불일치로 위장된다 —
    //      절대 규칙 6이 지목한 사고 형태 그 자체다.
    {
      const target = ledgerRoot("no-identity-record");
      const ev = readJsonAt(evPath);
      delete ev.coverage.exclusions.selectedIdentities;
      fs.writeFileSync(path.join(target, "evidence.json"), JSON.stringify(ev), "utf8");
      const r = runWriteConfig(baseInput(), target, "no-identity-record");
      const ok =
        r.status === 2 &&
        r.stderr.includes("LEDGER_IDENTITY_RECORD_MISSING") &&
        readTextAt(path.join(target, "config.json")) === null;
      if (!ok) console.log(`    실제: exit=${r.status} stderr=${r.stderr.slice(0, 250)}`);
      report(
        ok,
        "(WC-12) 금지 방향: 원장에 selectedIdentities 키가 없으면 exit 2 + LEDGER_IDENTITY_RECORD_MISSING이다(부재를 빈 배열로 메우지 않는다)"
      );
    }

    // ---- (AC-46) CONFIG_SCHEMA_VERSION ↔ config.schema.json의 default ----
    //      (AC-2c)와 같은 축이다. 그 필드는 `pattern`만 강제하고 `const`가 아니라
    //      **어떤 버전 문자열이든 스키마 검증을 통과한다** — 즉 「검사해서 통과」가
    //      아니라 「검사 대상이 아니라 통과」다. 갈려도 조용하다.
    {
      const { json: schema, error } = readRepoJsonSafe("schemas/config.schema.json");
      const schemaDefault = schema?.properties?.schemaVersion?.default;
      const ok = typeof schemaDefault === "string" && schemaDefault === CONFIG_SCHEMA_VERSION;
      if (!ok) {
        console.log(`    실제: ${error !== null ? error : ""} 코드=${JSON.stringify(CONFIG_SCHEMA_VERSION)} 스키마=${JSON.stringify(schemaDefault)}`);
      }
      report(ok, "(AC-46) CONFIG_SCHEMA_VERSION이 config.schema.json의 schemaVersion default와 일치(pattern만 있고 const가 없어 스키마 검증으로는 안 잡히는 축)");
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * 루트 `CLAUDE.md`의 문서 색인이 실재하는 경로를 가리키는가 — 순서 12번.
 *
 * **왜 이 절이 따로 있는가.** `validate-plugin.mjs`의 `checkDocPathReferences`가 같은 검사를
 * 하지만 대상이 `README.md`와 각 스킬의 `SKILL.md`뿐이라 루트 `CLAUDE.md`는 **그 집합 밖**이다.
 * 그 파일은 슬라이스 A이고 예외 표에도 없으므로 대상 목록을 넓히지 않았다 — 대신 같은
 * 검사를 슬라이스 B 파일인 여기 세운다.
 *
 * **추출 규칙을 일부러 좁게 잡았다.** `extractPathReferences`는 export돼 있지 않아 재사용할
 * 수 없고, 그 정교한 규칙(코드펜스 제거·URL 배제·접두사 표)을 여기 베끼면 **같은 판정의
 * 사본이 둘**이 된다. 그래서 흉내내지 않고, 백틱 안에서 레포 최상위 디렉터리로 시작하는
 * 토큰만 본다. 놓치는 형태가 있지만 **틀린 판정을 내지는 않는다** — 이 절이 잡으려는 것은
 * 「색인이 가리키는 문서가 사라졌다」 하나다.
 *
 * **이 파일이 왜 중요한가.** 모든 세션이 읽는 색인이라, 경로 하나가 썩으면 그 뒤의 모든
 * 세션이 없는 파일을 찾는다. 사람이 한 번 헤매는 것과 달리 **비용이 세션마다 반복된다.**
 */
function runRootGuideSmoke() {
  console.log("[루트 지침 오라클] CLAUDE.md의 문서 색인이 실재하는 경로를 가리키는가(순서 12번)");

  const REL = "CLAUDE.md";
  const { text, error } = readRepoTextSafe(REL);

  // ---- (RG-1) 전제: 파일이 실재하고 읽힌다 ----
  {
    const ok = error === null && typeof text === "string" && text.length > 0;
    if (!ok) console.log(`    실제: ${error ?? "내용이 비었다"}`);
    report(ok, `(RG-1) 전제: 루트 ${REL}이 실재하고 판독된다(이것이 실패하면 아래 단언은 공허하다)`);
  }

  // ---- (RG-2) 색인이 가리키는 레포 경로가 전부 실재하는가 ----
  {
    const TOP_DIRS = ["docs/", "scripts/", "schemas/", "skills/", "tests/", "fixtures/", "references/"];
    const body = text ?? "";
    const refs = [...new Set(
      [...body.matchAll(/`([^`\n]+)`/g)]
        .map((m) => m[1].trim())
        .filter((c) => TOP_DIRS.some((d) => c.startsWith(d)))
        .filter((c) => /^[\w.\-/]+$/.test(c))
    )];
    const missing = refs.filter((r) => !fs.existsSync(path.join(REPO_ROOT, r)));
    const ok = error === null && refs.length >= 1 && missing.length === 0;
    if (!ok) {
      console.log(`    실제: ${error !== null ? error : `참조 ${refs.length}건 / 부재 ${JSON.stringify(missing)}`}`);
    }
    report(
      ok,
      `(RG-2) ${REL}이 백틱으로 가리키는 레포 경로가 전부 실재한다(참조 0건이면 색인이 비었다는 뜻이므로 그것도 FAIL)`
    );
  }

  // ---- (RG-3) 전역 지침과 중복하지 않는가 ----
  //      12번의 완료 조건이 「전역 `CLAUDE.md`와 중복되는 언어·라우팅 규약은 넣지
  //      않는다」였다. 중복은 곧 드리프트다 — 두 곳에 적으면 한쪽만 고쳐진다.
  //      **금지 방향만 두면 빈 파일이 통과하므로** (RG-2)가 허용 방향을 받친다.
  {
    const body = text ?? "";
    const FORBIDDEN = [
      ["기계적 수집", "서브에이전트 모델 라우팅(전역 소관)"],
      ["sonnet", "모델 티어 지정(전역 소관)"],
      ["/handoff resume", "세션 연속성 절차(전역 소관)"],
    ];
    const hits = FORBIDDEN.filter(([needle]) => body.includes(needle)).map(([, why]) => why);
    const ok = error === null && hits.length === 0;
    if (!ok) console.log(`    실제: ${error !== null ? error : `전역 지침과 중복 ${JSON.stringify(hits)}`}`);
    report(ok, `(RG-3) ${REL}이 전역 지침 소관(모델 라우팅·세션 연속성)을 복제하지 않는다(두 곳에 적으면 갈린다)`);
  }
}

/**
 * state.json 레지스트리 판독과 AC-22 「오래된 근거」 경고 — 순서 13번 (a).
 *
 * **이 절이 관측하는 것은 「레지스트리를 읽는 주체가 실재하는가」다.**
 * `write-artifact.mjs`가 레지스트리를 쓰고 `state.schema.json`이 「스킬은
 * 레지스트리로 상위 산출물을 찾는다」를 계약으로 적어 뒀지만, **읽는 쪽
 * 프로덕션 호출자가 0건**이었다 — `write-config.mjs`가 닫은 갈래(소비자만
 * 있고 생산자가 없음)의 정확한 거울상이다.
 *
 * **(RR-1)은 손으로 조립한 state.json을 쓰지 않는다.** 실제 생산자
 * (`write-artifact.mjs`)가 쓴 것을 소비한다 — 하드코딩하면 「생산자와 소비자가
 * 같은 모양에 합의했는가」가 검사에서 통째로 빠지고, 한쪽만 바뀌어도 이 절은
 * 계속 녹색이다.
 *
 * **(RR-3)~(RR-7)이 이 절의 무게중심이다.** 판정 불가를 FRESH로 강등하지 않는
 * 다섯 경로이며, 각각 **자기 사유 코드를 달고** 나와야 한다. 사유 없이 exit 4만
 * 맞으면 「어느 경로로 판정을 포기했는가」를 구별할 수 없고, 그러면 한 분기가
 * 죽어도 다른 분기가 그 자리를 메워 관측이 통과한다.
 */
function runRegistryReaderSmoke() {
  console.log("[레지스트리 판독 오라클] state.json → 산출물 파일의 sourceRepoHead ↔ 현재 HEAD (구현 8단계·AC-22)");

  const READ_REGISTRY = path.join(REPO_ROOT, "scripts", "read-registry.mjs");
  const WRITE_ARTIFACT = path.join(REPO_ROOT, "scripts", "write-artifact.mjs");
  const COLLECTOR = path.join(REPO_ROOT, "scripts", "collect-git-facts.mjs");
  const VERIFIER = path.join(REPO_ROOT, "scripts", "verify-evidence.mjs");
  const ISO = "2026-08-26T00:00:00Z";

  // 이 절의 판독도 **절대 경로** 대상이라 파일 상단의 `readRepoTextSafe`(레포 루트
  // 기준 상대 경로)를 쓸 수 없다 — `runConfigWriterSmoke`와 같은 사정, 같은 대가다.
  const readJsonAt = (p) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } };

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-registry-"));
  try {
    // ---- 픽스처: 커밋 1개짜리 레포 + 저장 루트 ----
    const repoDir = path.join(tmp, "repo");
    crInitRepo(repoDir);
    crWriteFile(repoDir, "README.md", "# fixture\n");
    crGit(repoDir, ["add", "-A"]);
    const head1 = crCommitWithDates(repoDir, "chore: initial commit", ISO, ISO);

    const root = path.join(tmp, "store", STATE_DIR_NAME);
    fs.mkdirSync(root, { recursive: true });

    const collected = spawnSync(
      process.execPath,
      [COLLECTOR, "--repo", repoDir, "--identity", OWNER_EMAIL, "--out", root],
      { encoding: "utf8" }
    );
    const evidence = readJsonAt(path.join(root, "evidence.json"));

    // draft — `coverage.isShallowClone`은 원장에만 있는 필드라 떨어낸다(career
    // 스키마는 additionalProperties:false다). `verification`·`locked`의 기입 주체는
    // 병합이므로 draft에는 담지 않는다(담으면 AUTHORSHIP 위반으로 exit 1이다).
    const firstCommit = (evidence?.commits ?? []).find((c) => c.excluded !== true);
    const coverage = { ...(evidence?.coverage ?? {}) };
    delete coverage.isShallowClone;
    const draftPath = path.join(tmp, "draft.json");
    fs.writeFileSync(draftPath, JSON.stringify({
      schemaVersion: evidence?.schemaVersion,
      sourceRepoHead: evidence?.sourceRepoHead,
      coverage,
      truncated: evidence?.truncated,
      nodes: [{
        id: "car:001",
        basis: "commit",
        evidence: [{ ledgerId: firstCommit?.id, path: (firstCommit?.files ?? [])[0]?.path }],
        origin: "generated",
        text: "픽스처 레포의 README를 작성했다.",
      }],
    }), "utf8");

    const written = spawnSync(
      process.execPath,
      [WRITE_ARTIFACT, "--layer", "career", "--draft", draftPath, "--root", root,
       "--stage", "draft", "--skill", "career-from-git", "--generated-at", ISO],
      { encoding: "utf8" }
    );

    const run = (args) => {
      const r = spawnSync(process.execPath, [READ_REGISTRY, ...args], { encoding: "utf8" });
      return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
    };

    /** 원본 루트를 건드리지 않고 state.json·career.json 사본 루트를 만든다. */
    const cloneRoot = (tag) => {
      const dst = path.join(tmp, tag, STATE_DIR_NAME);
      fs.mkdirSync(dst, { recursive: true });
      for (const f of ["state.json", "career.json"]) {
        try {
          fs.copyFileSync(path.join(root, f), path.join(dst, f));
        } catch {
          // 없으면 그 부재 자체가 그 케이스의 입력이다.
        }
      }
      return dst;
    };

    // ---- (RR-1) 허용 방향: 생산자가 쓴 레지스트리를 소비자가 실제로 읽는가 ----
    {
      const r = run(["--root", root, "--repo", repoDir, "--layer", "career"]);
      const state = readJsonAt(path.join(root, "state.json"));
      const ok =
        collected.status === 0 &&
        written.status === 0 &&
        state?.artifacts?.career?.path === "career.json" &&
        r.status === 0 &&
        r.stdout.includes("[FRESH]") &&
        r.stdout.includes(head1);
      if (!ok) {
        console.log(`    실제: 수집=${collected.status} 쓰기=${written.status} 판독=${r.status}`);
        console.log(`    stderr: ${(written.stderr + r.stderr).slice(0, 400)}`);
      }
      report(
        ok,
        "(RR-1) 왕복: write-artifact.mjs가 갱신한 state.json만으로 read-registry.mjs가 career.json을 찾아 " +
        "현재 HEAD와 대조하고 [FRESH] exit 0에 도달한다(레지스트리 판독 주체가 실재한다)"
      );
    }

    // ---- (RR-7) 정본 축: 레지스트리는 sourceRepoHead를 **가질 수 없다** ----
    //      「레지스트리 값이 아니라 산출물 파일 값이 정본」(스펙 8단계·AC-16)이
    //      규약이 아니라 **구조**임을 관측한다. state.schema.json이
    //      additionalProperties:false이므로 그 값을 레지스트리에 넣는 순간
    //      스키마 위반이 되고, 이 CLI는 판정을 포기한다.
    {
      const dst = cloneRoot("head-in-registry");
      const s = readJsonAt(path.join(dst, "state.json"));
      s.artifacts.career.sourceRepoHead = head1;
      fs.writeFileSync(path.join(dst, "state.json"), JSON.stringify(s), "utf8");
      const r = run(["--root", dst, "--repo", repoDir, "--layer", "career"]);
      const ok = r.status === 4 && r.stderr.includes("STATE_SCHEMA_VIOLATION");
      if (!ok) console.log(`    실제: exit=${r.status} stderr=${r.stderr.slice(0, 300)}`);
      report(
        ok,
        "(RR-7) 정본 축: state.json에 sourceRepoHead를 넣으면 STATE_SCHEMA_VIOLATION + exit 4다 — " +
        "레지스트리는 그 값을 **구조적으로** 가질 수 없으므로 '파일이 정본'이 규약이 아니라 스키마다"
      );
    }

    // ---- (RR-6) 레지스트리 캐시가 파일과 갈리면 경로도 못 믿는다 ----
    {
      const dst = cloneRoot("version-drift");
      const s = readJsonAt(path.join(dst, "state.json"));
      s.artifacts.career.schemaVersion = "9.9.9";
      fs.writeFileSync(path.join(dst, "state.json"), JSON.stringify(s), "utf8");
      const r = run(["--root", dst, "--repo", repoDir, "--layer", "career"]);
      const ok = r.status === 4 && r.stderr.includes("REGISTRY_SCHEMA_VERSION_DRIFT");
      if (!ok) console.log(`    실제: exit=${r.status} stderr=${r.stderr.slice(0, 300)}`);
      report(
        ok,
        "(RR-6) 레지스트리 캐시 schemaVersion이 산출물 파일과 갈리면 REGISTRY_SCHEMA_VERSION_DRIFT + exit 4다" +
        "(state.schema.json이 '동일해야 한다'고 적고도 집행 코드가 없던 축)"
      );
    }

    // ---- (RR-5) 레지스트리는 멀쩡한데 가리킨 파일이 없다 ----
    {
      const dst = cloneRoot("artifact-gone");
      fs.rmSync(path.join(dst, "career.json"), { force: true });
      const r = run(["--root", dst, "--repo", repoDir, "--layer", "career"]);
      const ok = r.status === 4 && r.stderr.includes("ARTIFACT_UNREADABLE");
      if (!ok) console.log(`    실제: exit=${r.status} stderr=${r.stderr.slice(0, 300)}`);
      report(
        ok,
        "(RR-5) 레지스트리 항목은 있는데 그 경로의 산출물이 없으면 ARTIFACT_UNREADABLE + exit 4다" +
        "(레지스트리 항목의 존재를 파일의 존재로 읽지 않는다)"
      );
    }

    // ---- (RR-4) 아직 만들어지지 않은 계층 ----
    {
      const r = run(["--root", root, "--repo", repoDir, "--layer", "knowledge-map"]);
      const ok = r.status === 4 && r.stderr.includes("LAYER_NOT_REGISTERED");
      if (!ok) console.log(`    실제: exit=${r.status} stderr=${r.stderr.slice(0, 300)}`);
      report(
        ok,
        "(RR-4) 레지스트리 항목이 null인 계층은 LAYER_NOT_REGISTERED + exit 4다('아직 없음'을 '최신'으로 읽지 않는다)"
      );
    }

    // ---- (RR-3) state.json 부재 — 이 절의 핵심 ----
    //      스펙 8단계의 「예외 중단 없이 재수집 안내 후 정상 종료」를 exit 0으로
    //      구현하면 「최신임을 확인했다」와 「확인하지 못했다」가 같은 코드가 된다.
    {
      const empty = path.join(tmp, "no-state", STATE_DIR_NAME);
      fs.mkdirSync(empty, { recursive: true });
      const r = run(["--root", empty, "--repo", repoDir, "--layer", "career"]);
      const ok =
        r.status === 4 &&
        r.stderr.includes("STATE_MISSING") &&
        r.stdout.includes("[UNRESOLVED]") &&
        !r.stdout.includes("[FRESH]");
      if (!ok) console.log(`    실제: exit=${r.status} stdout=${r.stdout.slice(0, 200)} stderr=${r.stderr.slice(0, 200)}`);
      report(
        ok,
        "(RR-3) state.json 부재는 STATE_MISSING + exit 4이고 **[FRESH]를 출력하지 않는다** — " +
        "'확인하지 못함'을 '최신임'으로 강등하지 않는다(절대 규칙: 판독 실패를 빈 값·default로 강등 금지)"
      );
    }

    // ---- (RR-8) 저장 경계 밖 --root ----
    {
      const outside = path.join(tmp, "outside-boundary");
      fs.mkdirSync(outside, { recursive: true });
      const r = run(["--root", outside, "--repo", repoDir, "--layer", "career"]);
      const ok =
        r.status === 2 &&
        r.stderr.includes("[INPUT_ERROR]") &&
        r.stderr.includes(STATE_DIR_NAME) &&
        r.stderr.includes("판정을 시도하지 않았습니다");
      if (!ok) console.log(`    실제: exit=${r.status} stderr=${r.stderr.slice(0, 300)}`);
      report(
        ok,
        `(RR-8) 경로에 ${STATE_DIR_NAME} 세그먼트가 없는 --root는 exit 2이고 판정을 시도하지 않는다(입력 오류와 판정 불가를 가른다)`
      );
    }

    // ---- 커밋을 하나 더 쌓는다: 여기부터 산출물이 낡는다 ----
    crWriteFile(repoDir, "README.md", "# fixture\n\nsecond\n");
    crGit(repoDir, ["add", "-A"]);
    const head2 = crCommitWithDates(repoDir, "docs: second commit", ISO, ISO);

    // ---- (RR-2) 금지 방향: 낡은 산출물 ----
    {
      const r = run(["--root", root, "--repo", repoDir, "--layer", "career"]);
      const ok =
        r.status === 3 &&
        r.stdout.includes("[STALE]") &&
        r.stdout.includes(head1) &&
        r.stdout.includes(head2) &&
        r.stderr.includes("사용자의 결정");
      if (!ok) console.log(`    실제: exit=${r.status} stdout=${r.stdout.slice(0, 300)}`);
      report(
        ok,
        "(RR-2) 산출물의 sourceRepoHead가 현재 HEAD와 다르면 exit 3 + [STALE]이고 **두 해시를 모두 보고한다** " +
        "(계속/중단은 사용자 결정 — write-artifact.mjs의 exit 3과 같은 성격)"
      );
    }

    // ---- (RR-9) 두 스테일 축이 서로 다른 것을 본다 ----
    //      원장만 재수집하면 evidence는 신선해지고 산출물은 낡은 채로 남는다.
    //      그 상태에서 verify-evidence는 stale:false를, read-registry는 exit 3을
    //      낸다. **한쪽을 봤다고 다른 쪽을 본 것이 아니다** — read-registry.mjs
    //      헤더가 그렇게 주장하는데, 주장만 있고 관측이 없으면 다음 회차가
    //      「이미 verify-evidence가 본다」로 이 파일을 지운다.
    {
      const recollected = spawnSync(
        process.execPath,
        [COLLECTOR, "--repo", repoDir, "--identity", OWNER_EMAIL, "--out", root],
        { encoding: "utf8" }
      );
      const reportPath = path.join(tmp, "verify-report.json");
      const verified = spawnSync(
        process.execPath,
        [VERIFIER, "--repo", repoDir, "--evidence", path.join(root, "evidence.json"),
         "--identity", OWNER_EMAIL, "--artifact", `career=${path.join(root, "career.json")}`,
         "--out", reportPath],
        { encoding: "utf8" }
      );
      const vr = readJsonAt(reportPath);
      const rr = run(["--root", root, "--repo", repoDir, "--layer", "career"]);

      const ledgerFresh =
        vr?.sourceRepoHeadStaleness?.checked === true && vr?.sourceRepoHeadStaleness?.stale === false;
      const ok = recollected.status === 0 && ledgerFresh && rr.status === 3;
      if (!ok) {
        console.log(`    실제: 재수집=${recollected.status} 검증=${verified.status} read-registry=${rr.status}`);
        console.log(`    원장 스테일: ${JSON.stringify(vr?.sourceRepoHeadStaleness ?? null)}`);
      }
      report(
        ok,
        "(RR-9) 원장만 재수집한 상태에서 verify-evidence는 checked:true/stale:false(원장 신선)를, " +
        "read-registry는 exit 3(산출물 낡음)을 낸다 — 두 스테일 축은 서로 다른 것을 보므로 한쪽으로 대체할 수 없다"
      );
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * knowledge-map·gap-report 렌더 진입점 — 순서 13번 (b).
 *
 * **이 절은 내용의 정확성을 묻지 않는다 — 물을 수 없기 때문이다.** 두 계층의
 * 인스턴스는 아직 픽스처 밖에 존재하지 않으므로 「내가 만든 픽스처를 내가 렌더했다」는
 * 자기충족이 그대로 남아 있다(`render-markdown.mjs` 초판 헤더가 세 계층을 미루며 든
 * 근거가 정확히 그것이었다). 그래서 여기서 묻는 것은 둘뿐이다.
 *
 *   (i) **계약 요소**가 출력에 실재하는가 — 계약 목록의 정본은 이 파일이 아니라
 *       `render-contract.mjs`이므로 자기충족이 아니다.
 *   (ii) **계층 중립성** — 같은 인스턴스를 세 계층으로 렌더하면 제목 줄을 뺀 본문이
 *        **바이트 동일**한가. 이것은 픽스처 내용과 **무관하게** 성립해야 하는 구조
 *        성질이라, 픽스처를 아무리 잘못 만들어도 이 단언은 속지 않는다.
 *
 * 내용이 실제로 옳은지는 도그푸딩(AC-20)만 답할 수 있고, 그 사실을 감추지 않는다.
 */
function runLayerRenderSmoke() {
  console.log("[계층 렌더 진입점 오라클] knowledge-map·gap-report 렌더와 계층 중립성 (구현 8단계·순서 13번 (b))");

  const ISO = "2026-08-26T00:00:00Z";
  const baseHead = {
    schemaVersion: "1.0.0",
    generatedAt: ISO,
    sourceRepoHead: "a".repeat(40),
    contentHash: "b".repeat(64),
    coverage: {
      analyzed: 7,
      total: 9,
      traversed: 12,
      period: { since: "2026-01-01", until: "2026-08-01" },
      exclusions: { bots: true, vendoredPaths: true, mergeIncluded: false, selectedIdentities: ["owner@example.com"] },
      samplingMethod: "none:full-scan",
    },
    truncated: { reason: "none", dropped_commits: 0 },
  };

  const knowledgeMap = {
    ...structuredClone(baseHead),
    nodes: [{
      id: "km:001",
      basis: "inference",
      evidence: [{ ledgerId: `commit:${"c".repeat(40)}`, path: "src/retry.ts" }],
      parentRefs: ["car:001"],
      verification: { status: "refuted", attempts: 2, reasonCode: "UNSUPPORTED_CLAIM" },
      origin: "generated",
      locked: false,
      topic: "Exponential Backoff",
      text: "재시도 간격을 지수적으로 늘리는 설계를 적용한 흔적이 있다.",
    }],
  };

  const gapReport = {
    ...structuredClone(baseHead),
    nodes: [{
      id: "gap:001",
      basis: "inference",
      evidence: [{ ledgerId: `commit:${"c".repeat(40)}`, path: "src/retry.ts" }],
      parentRefs: ["km:001"],
      verification: { status: "verified", attempts: 1, reasonCode: null },
      origin: "generated",
      locked: false,
      topic: "Jitter",
      text: "백오프에 지터를 넣은 흔적이 없어 동시 재시도 몰림에 취약할 수 있다.",
      selfAssessment: "재시도는 써 봤지만 지터는 들어만 봤다.",
    }],
  };

  const LAYERS = [
    { layer: "knowledge-map", title: "지식맵", instance: knowledgeMap, schema: "knowledge-map" },
    { layer: "gap-report", title: "갭 리포트", instance: gapReport, schema: "gap-report" },
  ];

  // ---- (RM-8) 픽스처를 세계로 착각하지 않는다 ----
  //      "렌더는 되지만 스키마는 어기는" 물건으로 계약을 확인하면, 렌더러가 옳은지가
  //      아니라 내가 만든 물건이 렌더되는지만 보게 된다(기존 렌더 오라클의 규율).
  for (const { layer, instance, schema } of LAYERS) {
    const { json: layerSchema, error } = readRepoJsonSafe(path.join("schemas", `${schema}.schema.json`));
    const errors = layerSchema === null ? [`스키마 판독 실패: ${error}`] : validateInstance(layerSchema, instance);
    const ok = errors.length === 0;
    if (!ok) console.log(`    실제: ${JSON.stringify(errors.slice(0, 5))}`);
    report(ok, `(RM-8/${layer}) 이 절이 쓰는 픽스처가 ${schema}.schema.json에 적합하다(픽스처를 세계로 착각하지 않는다)`);
  }

  // ---- (RM-1) 등록된 계층 집합 — plan의 부재는 누락이 아니라 이연이다 ----
  //      `LAYER_TITLES`는 export되지 않으므로 `renderLayer`가 던지는 메시지가 그 집합을
  //      드러내는 유일한 표면이다. 거기서 읽는다 — 사본을 만들면 정본이 둘로 갈린다.
  //
  //      **CLI가 아니라 모듈을 부른다.** CLI는 `--in` 판독을 계층 검사보다 **먼저** 하므로
  //      존재하지 않는 파일을 주면 `ENOENT`가 먼저 나고 계층 메시지는 아예 도달하지 않는다
  //      (초판이 그렇게 써서 FAIL했고, 그 FAIL이 순서를 알려 줬다). CLI 쪽 exit 2는 아래
  //      (RM-7)의 왕복이 실재하는 파일로 따로 관측한다.
  {
    let message = null;
    try {
      renderLayer("plan", gapReport);
    } catch (e) {
      message = String(e.message ?? e);
    }
    const ok =
      message !== null &&
      message.includes("career") &&
      message.includes("knowledge-map") &&
      message.includes("gap-report") &&
      !message.includes("plan(") &&
      !/지원:.*plan/.test(message);
    if (!ok) console.log(`    실제: ${message === null ? "던지지 않았다(조용한 스킵)" : message}`);
    report(
      ok,
      "(RM-1) 등록 계층은 career·knowledge-map·gap-report 셋이고 plan은 조용히 넘어가지 않고 던진다 — " +
      "plan의 부재는 누락이 아니라 슬라이스 C 이연이며, LAYER_TITLES에 한 줄을 더하면 이 단언이 되묻는다"
    );
  }

  // ---- (RM-2) 계층 중립성: 제목 줄만 다르고 본문은 바이트 동일 ----
  //      이 절에서 자기충족을 피하는 축이다. 픽스처 내용이 무엇이든 성립해야 하며,
  //      renderNode가 계층을 보고 분기하는 순간 깨진다.
  {
    const bodyOf = (layer, instance) => renderLayer(layer, instance).split("\n").slice(1).join("\n");
    const bodies = ["career", "knowledge-map", "gap-report"].map((l) => bodyOf(l, gapReport));
    const titles = ["career", "knowledge-map", "gap-report"].map((l) => renderLayer(l, gapReport).split("\n")[0]);
    const bodiesIdentical = bodies[0] === bodies[1] && bodies[1] === bodies[2];
    const titlesDistinct = new Set(titles).size === 3;
    const ok = bodiesIdentical && titlesDistinct;
    if (!ok) console.log(`    실제: 본문 동일=${bodiesIdentical} 제목=${JSON.stringify(titles)}`);
    report(
      ok,
      "(RM-2) 계층 중립성: 같은 인스턴스를 세 계층으로 렌더하면 제목 줄만 다르고 본문은 바이트 동일하다 " +
      "(renderNode가 계층으로 분기하면 여기서 깨진다 — 픽스처 내용과 무관하게 성립해야 하는 구조 성질)"
    );
  }

  // ---- (RM-3) 두 계층이 공통 계약 요소를 전부 만족하는가 ----
  for (const { layer, instance } of LAYERS) {
    const md = renderLayer(layer, instance);
    const missing = RENDER_REQUIRED_ELEMENTS.filter((el) => !el.probe(md, instance)).map((el) => el.id);
    const ok = missing.length === 0;
    if (!ok) console.log(`    실제: 빠진 요소=${JSON.stringify(missing)}\n${md}`);
    report(
      ok,
      `(RM-3/${layer}) RENDER_REQUIRED_ELEMENTS ${RENDER_REQUIRED_ELEMENTS.length}건이 전부 출력에 실재한다` +
      "(계약 목록의 정본은 render-contract.mjs이므로 자기충족이 아니다)"
    );
  }

  // ---- (RM-4)~(RM-6) 계층 고유 필드 — 「진입점만 늘리면 된다」가 틀렸던 지점 ----
  //      표 두 줄만 늘렸다면 이 셋이 전부 출력에서 사라진 채 녹색이었다.
  //      `applies`가 거짓이면 **검사 대상이 아니므로 단언을 만들지 않는다** —
  //      공허 PASS를 라벨째 늘리지 않는다.
  {
    const LABELS = {
      "topic": "RM-4",
      "parent-refs": "RM-5",
      "self-assessment": "RM-6",
    };
    for (const el of LAYER_FIELD_ELEMENTS) {
      const targets = LAYERS.filter(({ instance }) => el.applies(instance));
      // 대상이 0건이면 이 절의 픽스처가 그 필드를 담지 않은 것이고, 그것은
      // 「통과」가 아니라 **관측 공백**이다. 조용히 넘기지 않고 FAIL시킨다.
      if (targets.length === 0) {
        report(false, `(${LABELS[el.id]}/${el.id}) 관측 공백: 이 절의 픽스처 어느 것도 '${el.id}'를 담지 않아 검사 대상이 0건이다`);
        continue;
      }
      const failed = targets.filter(({ layer, instance }) => !el.probe(renderLayer(layer, instance), instance)).map((t) => t.layer);
      const ok = failed.length === 0;
      if (!ok) console.log(`    실제: 빠진 계층=${JSON.stringify(failed)}`);
      report(
        ok,
        `(${LABELS[el.id]}/${el.id}) 대상 ${targets.length}계층(${targets.map((t) => t.layer).join("·")})의 출력에 실재: ${el.why}`
      );
    }
  }

  // ---- (RM-7) CLI 왕복 — 모듈만 통과하고 CLI가 막히는 상태를 만들지 않는다 ----
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-render-"));
    try {
      // **합성 인스턴스에서 정직한 루트로 갈아탔다(라운드 2 처방 8).** 렌더가 인용
      // 재검증을 다시 돌리므로 `contentHash`만 맞춘 합성 입력으로는 exit 0에 닿을 수
      // 없다 — 인용이 실제 레포의 커밋을 가리켜야 한다. 그 강제가 이 처방의 값이다.
      // (초판은 자리표시자 해시를 담았다가 처방 1의 게이트에 걸렸고, 그때도 결론은
      // 「게이트가 옳고 픽스처가 틀렸다」였다. 같은 판정을 한 칸 더 적용한다.)
      const HONEST = buildHonestRenderRoot();
      const inPath = HONEST === null ? path.join(tmp, "gap-report.json") : path.join(HONEST.root, "gap-report.json");
      const outPath = path.join(tmp, "gap-report.md");
      const r = HONEST === null ? { status: null, stderr: "정직한 루트를 만들지 못했다" } : spawnSync(
        process.execPath,
        [path.join(REPO_ROOT, "scripts", "render-markdown.mjs"), "--layer", "gap-report", "--in", inPath,
         "--root", HONEST.root, "--repo", HONEST.repo, "--out", outPath],
        { encoding: "utf8" }
      );
      let md = null;
      try { md = fs.readFileSync(outPath, "utf8"); } catch { /* 부재가 곧 FAIL이다 */ }
      const ok =
        r.status === 0 &&
        md !== null &&
        md.startsWith("# 갭 리포트") &&
        md.includes("자가진단 원문 — 정직한 루트 픽스처.");
      if (!ok) console.log(`    실제: exit=${r.status} stderr=${(r.stderr ?? "").slice(0, 250)} md=${String(md).slice(0, 200)}`);
      report(
        ok,
        "(RM-7) CLI 왕복: --layer gap-report가 exit 0으로 파일을 쓰고 그 안에 제목과 자가진단 원문이 실린다" +
        "(모듈만 통과하고 CLI 진입점이 막히는 상태를 만들지 않는다)"
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
}

/**
 * skill-gap 오케스트레이션 배선 — 순서 13번 (c).
 *
 * **왜 SP-* 절과 따로 있는가.** 저 절은 `skills/**` **전체**에 거는 공통 요구이고,
 * 여기는 skill-gap 하나에만 있는 배선(0단계 스테일 판정 · D3 · 두 계층 쓰기·렌더)을 본다.
 * 저기에 섞으면 career-from-git이 없는 요구를 받아 오탐이 난다.
 *
 * **이 절의 대부분은 소스 스캔이고, 그 한계를 감추지 않는다** — SP-* 계열과 같은
 * **보조 방어**다. 문서가 명령을 적었다고 오케스트레이션이 그것을 부른다는 보장은 없다.
 * 집행은 각 스크립트의 종료 코드가 하고, 그 종료 코드가 사용자 판단으로 이어지는지는
 * **사람이 도그푸딩(AC-20)에서만** 확인할 수 있다.
 *
 * **다만 (SG-3)은 그 한계를 한 축에서 넘는다** — SP-10과 같은 모양으로, 문서에서 명령을
 * 추출해 **실제로 실행**하고 판정에 도달하는지 본다. 인자가 모자라면 그 전에 죽는다.
 */
function runSkillGapWiringSmoke() {
  console.log("[skill-gap 배선 오라클] 0단계 스테일 판정·D3·두 계층 쓰기/렌더가 절차서에 배선됐는가 (순서 13번 (c))");

  const SKILL_REL = "skills/skill-gap/SKILL.md";
  const TEMPLATE_RELS = [
    "skills/skill-gap/templates/knowledge-mapper.md",
    "skills/skill-gap/templates/gap-analyzer.md",
    "skills/skill-gap/templates/gap-fact-checker.md",
  ];

  const tracker = makeReadTracker();
  const skillText = tracker.readText(SKILL_REL) ?? "";
  for (const rel of TEMPLATE_RELS) tracker.readText(rel);

  // ---- (SG-1) 전제: 대상이 실재하고 전부 판독됐는가 ----
  //      아래 금지·허용 방향은 텍스트가 빈 문자열이면 전부 공허해진다 —
  //      SP-1/SP-1b가 세운 선례를 그대로 따른다.
  {
    const rels = [SKILL_REL, ...TEMPLATE_RELS];
    const failed = rels.filter((r) => tracker.failed(r));
    const ok = failed.length === 0 && skillText.length > 0;
    if (!ok) console.log(`    실제: 판독 실패 ${JSON.stringify(tracker.blameFor(rels))}`);
    report(
      ok,
      `(SG-1) 전제: skill-gap 문서 ${rels.length}건(절차서 1 + 템플릿 3)이 실재하고 전부 판독됐다` +
      "(판독 실패를 '위반 0건'으로 집계하지 않는다)"
    );
  }

  /** 펜스 코드 블록만 뽑는다 — 명령은 줄바꿈으로 이어지므로 줄 단위로는 못 본다. */
  const fenced = (text) => {
    const blocks = [];
    let cur = null;
    for (const line of text.split("\n")) {
      if (/^\s*```/.test(line)) {
        if (cur === null) cur = [];
        else { blocks.push(cur.join("\n")); cur = null; }
        continue;
      }
      if (cur !== null) cur.push(line);
    }
    return blocks;
  };
  const skillBlocks = fenced(skillText);
  const blocksWith = (cmd) => skillBlocks.filter((b) => b.includes(cmd));

  const REGISTRY_CMD = "node scripts/read-registry.mjs";
  const registryBlocks = blocksWith(REGISTRY_CMD);

  // ---- (SG-2) 0단계 배선: 스테일 판정을 실제로 부르는가 ----
  //      **이것이 없으면 (a)가 만든 CLI는 아무도 부르지 않는 코드다.** AC-22가
  //      요구하는 「오래된 근거 경고」는 그 호출 지점에서만 생기고, 절차서가 그것을
  //      적지 않으면 스크립트가 있다는 사실만으로는 아무 일도 일어나지 않는다.
  {
    const withLayer = registryBlocks.filter((b) => b.includes("--layer career"));
    const ok = registryBlocks.length >= 1 && withLayer.length >= 1;
    if (!ok) console.log(`    실제: read-registry 호출 블록 ${registryBlocks.length}건 / --layer career 동반 ${withLayer.length}건`);
    report(
      ok,
      "(SG-2) 절차서가 `node scripts/read-registry.mjs --layer career` 호출 블록을 담는다 — " +
      "AC-22의 스테일 경고는 이 호출 지점에서만 생긴다(없으면 (a)의 CLI가 죽은 코드다)"
    );
  }

  // ---- (SG-3) 그 명령이 **실제로 판정에 도달하는가** ----
  //      SP-10과 같은 축이다. (SG-2)는 「적혀 있는가」까지만 보므로 인자 이름이
  //      바뀌거나 조합이 무효가 되면 다시 초록으로 통과한다. 여기서는 추출해 실행하고
  //      **판정 줄**을 요구한다 — 인자가 모자라면 exit 2로 그 전에 죽는다.
  //
  //      치환표에 없는 자리표시자가 남으면 FAIL이다(SP-10과 같은 드리프트 가드).
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "devcareer-sg3-"));
    try {
      const repoDir = path.join(tmp, "repo");
      crInitRepo(repoDir);
      crWriteFile(repoDir, "README.md", "# fixture\n");
      crGit(repoDir, ["add", "-A"]);
      const head = crCommitWithDates(repoDir, "chore: init", "2026-08-26T00:00:00Z", "2026-08-26T00:00:00Z");

      const rootDir = path.join(tmp, "store", STATE_DIR_NAME);
      fs.mkdirSync(rootDir, { recursive: true });
      const { fileName: careerFile } = ARTIFACT_LAYERS.career;
      fs.writeFileSync(path.join(rootDir, careerFile), JSON.stringify({ schemaVersion: "0.1.0", sourceRepoHead: head }), "utf8");
      fs.writeFileSync(path.join(rootDir, STATE_FILE_NAME), JSON.stringify({
        schemaVersion: STATE_SCHEMA_VERSION,
        updatedAt: "2026-08-26T00:00:00Z",
        artifacts: { ...EMPTY_REGISTRY_ARTIFACTS, career: { path: careerFile, schemaVersion: "0.1.0", generatedBySkill: "career-from-git" } },
      }), "utf8");

      const SUBST = { "<저장 루트>": rootDir, "<레포 경로>": repoDir };
      const failures = [];
      for (const block of registryBlocks) {
        let cmd = block.split("\\\n").join(" ").split("\n").join(" ");
        cmd = cmd.replace(/\[[^\]]*\]/g, " ");
        for (const [ph, val] of Object.entries(SUBST)) cmd = cmd.split(ph).join(val);
        const leftover = cmd.match(/<[^>]*>/g) ?? [];
        if (leftover.length > 0) {
          failures.push(`치환표에 없는 자리표시자 ${JSON.stringify(leftover)}`);
          continue;
        }
        const tokens = cmd.trim().split(/\s+/);
        const argv = tokens.slice(tokens.indexOf("scripts/read-registry.mjs") + 1);
        const ran = spawnSync(process.execPath, [path.join(REPO_ROOT, "scripts", "read-registry.mjs"), ...argv], {
          cwd: REPO_ROOT, encoding: "utf8",
        });
        const out = `${ran.stdout ?? ""}${ran.stderr ?? ""}`;
        // 신선한 픽스처를 놓았으므로 [FRESH] exit 0이 기대값이다. 인자가 모자라면
        // exit 2로 그 전에 죽고, 그때 나오는 것은 [INPUT_ERROR]다.
        if (ran.status !== 0 || !out.includes("[FRESH]")) {
          failures.push(`판정에 도달하지 못했다(exit=${ran.status}) — ${out.slice(0, 200).split("\n").join(" ")}`);
        }
      }
      const ok = registryBlocks.length >= 1 && failures.length === 0;
      if (!ok) console.log(`    실제: 호출 블록 ${registryBlocks.length}건 / 실패 ${JSON.stringify(failures)}`);
      report(
        ok,
        "(SG-3) 절차서에서 추출한 스테일 판정 명령을 **전부** 실제로 실행하면 인자 검증을 통과해 " +
        "[FRESH] exit 0까지 도달한다(적혀 있는가가 아니라 도는가)"
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  // ---- (SG-4) 네 종료 코드를 문서화하고 3과 4를 **다른 조치**로 가르는가 ----
  //      뭉뚱그리면 (a)가 코드를 나눈 이유가 절차서에서 사라진다. exit 3은 사용자
  //      판단이고 exit 4는 재수집 안내다 — 둘을 같은 칸에 적으면 스테일 경고가
  //      「그냥 계속」으로 소비된다.
  {
    const hasAllCodes = ["FRESH", "STALE", "UNRESOLVED"].every((k) => skillText.includes(k)) ||
      ["신선", "스테일", "판정 불가"].every((k) => skillText.includes(k));
    const separatesThreeAndFour =
      /exit 3/.test(skillText) && /exit 4/.test(skillText) &&
      skillText.includes("계속/중단") && skillText.includes("재수집");
    const ok = hasAllCodes && separatesThreeAndFour;
    if (!ok) console.log(`    실제: 코드 열거=${hasAllCodes} 3·4 구별=${separatesThreeAndFour}`);
    report(
      ok,
      "(SG-4) 절차서가 스테일 판정의 세 판정을 열거하고 exit 3(사용자 계속/중단 판단)과 " +
      "exit 4(재수집 안내)를 **다른 조치**로 가른다(뭉뚱그리면 (a)가 코드를 나눈 이유가 사라진다)"
    );
  }

  const VERIFIER_CMD = "node scripts/verify-evidence.mjs";
  const verifyBlocks = blocksWith(VERIFIER_CMD);

  // ---- (SG-5) D3 잔여 절반: 저자를 config에서 읽는가 ----
  //      (SP-9)는 `--identity`도 허용한다 — 단발 실행 경로가 있기 때문이다. 그러나
  //      결정 D3은 스킬 경로에서 **config를 정본으로 삼는다**고 정했고, 손으로 넘기면
  //      0단계에서 확정한 집합과 갈릴 수 있다. 그 갈림은 저자 대조 축을 조용히 약화시킨다.
  {
    const offenders = verifyBlocks.filter((b) => !b.includes("--config"));
    const ok = verifyBlocks.length >= 1 && offenders.length === 0;
    if (!ok) console.log(`    실제: 인용 검증 블록 ${verifyBlocks.length}건 중 --config 누락 ${offenders.length}건`);
    report(
      ok,
      "(SG-5) skill-gap의 인용 검증 호출이 --config로 저자를 읽는다(결정 D3의 잔여 절반 — " +
      "손으로 조립하면 0단계 확정 집합과 갈릴 수 있다)"
    );
  }

  // ---- (SG-6) 상위 계층을 함께 넘기는가 ----
  //      스펙 8단계 (b): 계층을 하나씩 넘기면 checkLayerRefs가 그 노드를 위반이 아니라
  //      `unverifiable`로 분류한다 — AC-14의 「미해결 참조 0건」이 참이 아니라 **미검증**
  //      인데도 리포트상 위반 0건으로 보인다. `--out-dir`이 그 갈래를 닫는다.
  {
    const offenders = verifyBlocks.filter((b) => !b.includes("--out-dir"));
    const ok = verifyBlocks.length >= 1 && offenders.length === 0;
    if (!ok) console.log(`    실제: 인용 검증 블록 ${verifyBlocks.length}건 중 --out-dir 누락 ${offenders.length}건`);
    report(
      ok,
      "(SG-6) 인용 검증 호출이 --out-dir로 전 계층을 함께 넘긴다(스펙 8단계 (b) — 상위 계층이 빠지면 " +
      "위반이 아니라 unverifiable로 새어 위반 0건처럼 보인다)"
    );
  }

  /** 절차서에서 `<명령> --layer X` 형태의 계층 이름을 뽑는다. */
  const layersOf = (cmd) => {
    const found = new Set();
    for (const b of blocksWith(cmd)) {
      for (const m of b.matchAll(/--layer\s+([a-z-]+)/g)) found.add(m[1]);
    }
    return found;
  };
  const writeLayers = layersOf("node scripts/write-artifact.mjs");
  const renderLayers = layersOf("node scripts/render-markdown.mjs");

  // ---- (SG-7) 쓰는 계층이 전부 유효한 계층 이름인가 ----
  //      **닻은 ARTIFACT_LAYERS다.** 절차서에 오타가 있으면 그 명령은 실행 시
  //      exit 2로 죽는데, 그 사실은 사람이 돌려 보기 전까지 드러나지 않는다.
  {
    const invalid = [...writeLayers].filter((l) => !ARTIFACT_LAYERS[l]);
    const ok = writeLayers.size >= 1 && invalid.length === 0;
    if (!ok) console.log(`    실제: 쓰기 계층 ${JSON.stringify([...writeLayers])} / 유효하지 않음 ${JSON.stringify(invalid)}`);
    report(
      ok,
      `(SG-7) 절차서의 쓰기 경계 호출이 다루는 계층 ${JSON.stringify([...writeLayers])}이 전부 ARTIFACT_LAYERS의 유효한 키다` +
      "(닻은 표이지 이 파일의 리터럴이 아니다)"
    );
  }

  // ---- (SG-8) 쓴 계층을 전부 사용자 표면에도 내는가 ----
  //      **집합을 문서에서 파생한다.** 리터럴로 두 계층을 적으면 세 번째 계층이 늘 때
  //      이 단언이 따라가지 않는다. 쓰기만 하고 렌더하지 않는 계층이 생기면 그 산출물은
  //      JSON에만 존재하고, 강등 배지·커버리지·절단 고지가 사용자에게 닿지 않는다.
  {
    const unrendered = [...writeLayers].filter((l) => !renderLayers.has(l));
    const ok = writeLayers.size >= 1 && renderLayers.size >= 1 && unrendered.length === 0;
    if (!ok) console.log(`    실제: 쓰기 ${JSON.stringify([...writeLayers])} / 렌더 ${JSON.stringify([...renderLayers])} / 렌더 누락 ${JSON.stringify(unrendered)}`);
    report(
      ok,
      "(SG-8) 절차서가 쓰는 계층은 전부 렌더 호출도 갖는다(쓰기만 하고 사용자 표면에 내지 않는 계층이 없다 — " +
      "배지·커버리지·절단 고지가 닿는 유일한 표면이다)"
    );
  }
}

function runCommonSections() {
  runSection("스키마 검증기 스모크", runSchemaValidatorSmoke);
  // 판독 헬퍼의 형태 게이트는 아래 절들이 **기대는 전제**다 — 그 전제가 깨지면
  // 아래 절의 「기준 인스턴스가 적합함」류 단언이 공허해지므로 먼저 관측한다.
  runSection("안전 판독 형태 오라클(비객체 스키마 fail-closed)", runSafeReadShapeOracleSmoke);
  runSection("스키마 동형성 교차 가드(8번 ②)", runSchemaIsomorphismOracleSmoke);
  runSection("스키마 절 단위 오라클(게이트 A-5)", runSchemaClauseOracleSmoke);
  runSection("시크릿 스캔 절 단위 오라클(게이트 C-1)", runSecretScanOracleSmoke);
  runSection("allow-list 절 단위 오라클(게이트 C-2)", runExternalSourceOracleSmoke);
  runSection("인용 커버리지 오라클(게이트 C-5·A-32·A-34)", runCitationCoverageOracleSmoke);
  runSection("렌더 계약 오라클(구현 7단계·AC-13)", runRenderContractOracleSmoke);
  runSection("산출물 계약 오라클(구현 7단계 (a)(b)(g))", runArtifactContractOracleSmoke);
  runSection("원장 투영 오라클(구현 7단계 (f)·게이트 E-3)", runLedgerProjectionOracleSmoke);
  runSection("프롬프트 계층 계약(구현 7단계 ③·게이트 E-3)", runSkillPromptContractSmoke);
  runSection("gitignore 경로 참조 가드(DH-1)", runIgnoredPathReferenceSmoke);
  runSection("소스 참조 형태 가드(A-37 재발 차단)", runSourceLineReferenceSmoke);
  runSection("절대 규칙 4·5 관측 오라클(라운드 2 처방 11)", runSliceRuleObservationSmoke);
  runSection("렌더 입력 게이트(라운드 2 처방 1)", runRenderGateSmoke);
  runSection("라운드 2 승격 오라클(절단 고지 부재·생산자 인증)", runRound2DeviceSmoke);
  runSection("오염 채점 엔진 오라클(구현 9단계·순서 14번)", runContaminationGraderSmoke);
  runSection("쓰기 경계 오라클(구현 7단계 (a)·AC-16·AC-22)", runWriteArtifactOracleSmoke);
  runSection("repo-key 스모크", runStoreKeySmoke);
  runSection("store IO 계약 오라클(게이트 B-1·B-2)", runStoreIoContractSmoke);
  runSection("config 쓰기 주체 오라클(결정 D3)", runConfigWriterSmoke);
  runSection("루트 지침 오라클(순서 12번)", runRootGuideSmoke);
  runSection("레지스트리 판독 오라클(구현 8단계·AC-22)", runRegistryReaderSmoke);
  runSection("계층 렌더 진입점 오라클(순서 13번 (b))", runLayerRenderSmoke);
  runSection("skill-gap 배선 오라클(순서 13번 (c))", runSkillGapWiringSmoke);
  runSection("computeSampling 단위 오라클(임무 1)", runSamplingUnitSmoke);
  runSection("churn 파생식 오라클(임무 2)", runChurnDerivationOracleSmoke);
  runSection("git.mjs -z 실경로 스모크(임무 2)", runGitZRealPathSmoke);
  runSection("verify-evidence 스모크", runVerifyEvidenceSmoke);
  runSection("AC-6/T-1/T-2 불변식 스모크", runEvidenceInvariantSmoke);
  runSection("빠른 절단 불변식 스모크", runFastTruncationInvariantSmoke);
  runSection("git.mjs -z 가드 회귀(파서 자기충족 방어 회귀)", runGitZGuardSmoke);
  runSection("골든 캐시 키 스모크", runGoldenCacheKeySmoke);
  runSection("C1: typechange(T) 파서 throw 회귀", runTypeChangeSmoke);
  runSection("C2: --since/--until authorDate 축 회귀", runSinceUntilAuthorDateSmoke);
  runSection("C3: shallow clone 경계 커밋 회귀", runShallowCloneSmoke);
  runSection("M: diff.renames 고정 회귀", runDiffRenamesFixedSmoke);
  runSection("M: --ref all의 refs/stash 유입 회귀", runRefAllExcludesStashSmoke);
  runSection("M: churn 버킷 vendored/lockfile 오염 회귀", runChurnVendoredExclusionSmoke);
  runSection("contentHash·스테일 경고 스모크(A-7)", runContentHashAndStalenessSmoke);
  runSection("samplingMethod 리터럴 드리프트 스모크(A-19)", runSamplingLiteralDriftSmoke);
  runSection("프로덕션 git 호출지 단일화 스모크(A-21)", runProductionGitCallSiteSmoke);
  runSection("redact.mjs 마스킹 스모크(A-9/A-10)", runRedactSmoke);
  runSection("evidence.schema.json 구조 검증 스모크(A-13)", runEvidenceSchemaCheckSmoke);
  runSection("coAuthors·binary·vendored·git-facts 집계 스모크(A-14)", runCoAuthorsBinaryVendoredGitFactsSmoke);
  runSection("픽스처 커버리지 정직화 스모크(A-14 잔여)", runFixtureCoverageHonestySmoke);
}

/**
 * `--contamination` — 기계 3종 30건을 **회차 산출물 위에서** 실제로 채점한다.
 *
 * **이 모드가 채점기 오라클과 다른 점.** `runContaminationGraderSmoke`는 합성 입력으로
 * 채점 **로직**만 본다. 여기서는 프로덕션 CLI(`verify-evidence`·`--secret-scan`)를 실제로
 * 돌려 그 출력으로 채점한다 — 기대 코드는 케이스 파일이, 실제 코드는 CLI가 소유한다.
 *
 * **`UC`는 이 모드의 범위 밖이다(D6).** 「미채점」이 아니라 대상이 아니다 — 부재를 강등하는
 * 형태를 만들지 않는다(절대 규칙 6). LLM 축은 `--contamination-llm`의 몫이다.
 *
 * **결과 파일은 `--results <path>`를 줄 때만 쓴다.** 스모크가 매 실행마다 레포에 파일을
 * 만들면 워킹 트리가 항상 더러워지고 새 클론 확인이 흐려진다. 경계는
 * `tests/contamination/README.md`가 정본이다.
 */
function runContaminationSuite() {
  console.log("[오염 스위트] 기계 3종 30건을 회차 산출물 위에서 채점한다(구현 9단계·AC-8)");

  const runsRel = path.join("tests", "contamination", "runs");
  const runsDir = path.join(REPO_ROOT, runsRel);
  const casesRoot = path.join(REPO_ROOT, "tests", "contamination", "cases");

  const kindDirs = [CASE_KINDS.FAKE_HASH, CASE_KINDS.OTHER_AUTHOR, CASE_KINDS.SECRET_BYPASS];
  const cases = new Map();
  for (const kind of kindDirs) {
    const defs = fs
      .readdirSync(path.join(casesRoot, kind))
      .filter((n) => n.endsWith(".json"))
      .sort()
      .map((n) => JSON.parse(fs.readFileSync(path.join(casesRoot, kind, n), "utf8")));
    cases.set(kind, defs);
  }

  let runIds = [];
  try {
    runIds = fs.readdirSync(runsDir).filter((n) => fs.statSync(path.join(runsDir, n)).isDirectory()).sort();
  } catch { /* (CX-1)이 잡는다 */ }

  // 회차마다 프로덕션 CLI를 실제로 돌린다. 판독 실패를 빈 값으로 강등하지 않는다 —
  // 리포트를 못 얻은 회차는 `null`로 남고 채점기가 그것을 INVALID로 판정한다.
  const perRun = [];
  const cliFailures = [];
  for (const runId of runIds) {
    const root = path.join(runsDir, runId, ".devcareer");
    const evPath = path.join(root, "evidence.json");
    let evidence = null;
    try { evidence = JSON.parse(fs.readFileSync(evPath, "utf8")); }
    catch (e) { cliFailures.push(`${runId}: 원장 판독 실패(${e.code ?? e.message})`); }

    const repoPath = evidence === null ? null : findFixtureRepoFor(evidence.sourceRepoHead);
    let report = null;
    if (repoPath === null) {
      cliFailures.push(`${runId}: sourceRepoHead와 맞는 픽스처 레포를 찾지 못했다(재료화 안내는 README §5)`);
    } else {
      const outPath = path.join(os.tmpdir(), `devcareer-ct-${runId}-report.json`);
      const r = spawnSync("node", [
        path.join(REPO_ROOT, "scripts", "verify-evidence.mjs"),
        "--repo", repoPath,
        "--config", path.join(root, "config.json"),
        "--evidence", evPath,
        "--out-dir", root,
        "--out", outPath,
      ], { cwd: REPO_ROOT, encoding: "utf8" });
      // exit 1은 위반이 있다는 뜻이고 이 스위트에서는 **정상**이다 — 오염을 주입했으므로.
      // exit 2(INPUT_ERROR/INCONCLUSIVE)만 CLI 실패다.
      if (r.status === 2 || !fs.existsSync(outPath)) {
        cliFailures.push(`${runId}: verify-evidence exit=${r.status} — 리포트를 얻지 못했다`);
      } else {
        try { report = JSON.parse(fs.readFileSync(outPath, "utf8")); }
        catch (e) { cliFailures.push(`${runId}: 리포트 파싱 실패(${e.message})`); }
      }
    }

    // 시크릿 축은 케이스마다 산출물 파일 하나다 — CLI 한 번의 결과가 그 케이스의 판정이다.
    const scans = new Map();
    for (const c of cases.get(CASE_KINDS.SECRET_BYPASS)) {
      const artifact = path.join(runsDir, runId, "secret", c.caseId, ".devcareer", `${c.layer}.json`);
      if (!fs.existsSync(artifact)) { scans.set(c.caseId, null); continue; }
      const r = spawnSync("node", [path.join(REPO_ROOT, "scripts", "validate-plugin.mjs"), "--secret-scan", artifact], { cwd: REPO_ROOT, encoding: "utf8" });
      // 코드는 CLI 출력에서 뽑는다 — 이 파일이 코드를 소유하지 않는다((CT-3)와 같은 규율).
      const codes = [...new Set((r.stdout + r.stderr).match(/\[FAIL\] ([A-Z][A-Z0-9_]+):/g) ?? [])].map((m) => m.slice(7, -1));
      scans.set(c.caseId, { ok: r.status === 0, codes });
    }
    perRun.push({ runId, evidence, report, scans });
  }

  // ---- (CX-1) 전제: 회차가 실재하고 잔여물이 갖춰졌다 ----
  //      회차가 0건이면 아래 비율이 전부 공허해진다. **미제출은 0%가 아니다.**
  {
    const missing = perRun.filter((r) => r.evidence === null || r.report === null).map((r) => r.runId);
    const ok = runIds.length >= 3 && missing.length === 0 && cliFailures.length === 0;
    if (!ok) console.log(`    실제: 회차 ${runIds.length}건 잔여물 결손 ${JSON.stringify(missing)} CLI 실패 ${JSON.stringify(cliFailures)}`);
    report(ok, `(CX-1) 회차 ${runIds.length}건이 실재하고 원장·설정·산출물이 갖춰졌다(AC-8의 연속 3회 — 미제출은 0%가 아니다)`);
  }

  // ---- (CX-2) 금지 방향: 도구 오류가 섞이면 채점이 성립하지 않는다 ----
  //      toolErrors가 있으면 「검사기가 놓쳤다」와 「검사기가 돌지 못했다」가 뭉개진다.
  {
    const tool = perRun.filter((r) => (r.report?.toolErrors?.length ?? 0) > 0).map((r) => r.runId);
    const layerRef = perRun.filter((r) => (r.report?.layerRefViolations?.length ?? 0) > 0).map((r) => r.runId);
    const ok = perRun.length > 0 && tool.length === 0 && layerRef.length === 0;
    if (!ok) console.log(`    실제: 도구 오류 회차 ${JSON.stringify(tool)} 계층 참조 위반 회차 ${JSON.stringify(layerRef)}`);
    report(ok, "(CX-2) 회차 어디에도 도구 오류·계층 참조 위반이 0건이다(주입한 오염만 위반으로 남는다)");
  }

  // ---- (CX-3) 음성 대조: 정상 인용은 위반으로 잡히지 않는다 ----
  //      이것이 없으면 「무조건 FAIL을 내는 검사기」가 100%를 받는다. 오염 케이스 수와
  //      실제 위반 수가 **정확히 같아야** 한다 — 하나라도 많으면 오탐이다.
  {
    const bad = perRun.filter((r) => (r.report?.violations?.length ?? -1) !== 20).map((r) => `${r.runId}=${r.report?.violations?.length}`);
    const ok = perRun.length > 0 && bad.length === 0;
    if (!ok) console.log(`    실제: 인용 위반 수가 20이 아닌 회차 ${JSON.stringify(bad)}`);
    report(ok, "(CX-3) 음성 대조: 인용 위반이 주입한 20건과 정확히 같다(정상 인용 오탐 0건 — 무조건 FAIL하는 검사기는 여기서 걸린다)");
  }

  // ---- (CX-4)~(CX-6) 종별 비율. 기계 3종은 3회 모두 100%가 수용선이다 ----
  const ratiosByKind = new Map();
  for (const kind of kindDirs) {
    const defs = cases.get(kind);
    const ratios = perRun.map((run) => {
      const outcomes = defs.map((c) => {
        if (kind === CASE_KINDS.SECRET_BYPASS) return gradeSecretCase(c, run.scans.get(c.caseId) ?? null);
        const ledgerId = c.inject.selector
          ? resolveSelector(c.inject.selector, run.evidence ?? {}).ledgerId
          : c.inject.ledgerId;
        return gradeCitationCase(c, ledgerId, run.report?.violations ?? null, run.evidence);
      });
      return { t: tally(defs, outcomes), outcomes };
    });
    ratiosByKind.set(kind, ratios);
    const gate = evaluateGate({ kind, ratios: ratios.map((r) => r.t.ratio) });
    const label = { [CASE_KINDS.FAKE_HASH]: "CX-4", [CASE_KINDS.OTHER_AUTHOR]: "CX-5", [CASE_KINDS.SECRET_BYPASS]: "CX-6" }[kind];
    const ok = gate.pass === true;
    if (!ok) {
      console.log(`    실제: ${gate.reason} / 회차별 ${JSON.stringify(ratios.map((r) => r.t))}`);
      for (const r of ratios) for (const o of r.outcomes) if (o.outcome !== OUTCOME.DETECTED) console.log(`      ${o.caseId}: ${o.outcome} — ${o.detail}`);
    }
    report(ok, `(${label}) ${kind} ${defs.length}건이 ${perRun.length}회 모두 100%다(분모는 케이스 파일 개수 고정)`);
  }

  // ---- (CX-7) 회차 간 산출물 결정성 ----
  //      기계 축은 결정적이므로 회차가 갈리면 그것은 변동이 아니라 결함이다. 원장은
  //      수집기가 자기 `generatedAt`을 찍으므로 그 한 필드만 갈린다.
  {
    const hashOf = (o) => crypto.createHash("sha256").update(JSON.stringify(o)).digest("hex");
    const artifactHashes = perRun.map((r) =>
      ["career", "knowledge-map", "gap-report"].map((l) => {
        try { return hashOf(JSON.parse(fs.readFileSync(path.join(runsDir, r.runId, ".devcareer", `${l}.json`), "utf8"))); }
        catch { return "판독실패"; }
      }).join("/")
    );
    const ledgerHashes = perRun.map((r) => (r.evidence === null ? "판독실패" : hashOf({ ...r.evidence, generatedAt: null })));
    const sameArtifacts = new Set(artifactHashes).size === 1;
    const sameLedgers = new Set(ledgerHashes).size === 1;
    const ok = perRun.length >= 2 && sameArtifacts && sameLedgers && !artifactHashes.includes("판독실패");
    if (!ok) console.log(`    실제: 산출물 해시 ${JSON.stringify(artifactHashes.map((h) => h.slice(0, 12)))} 원장 해시 ${JSON.stringify(ledgerHashes.map((h) => h.slice(0, 12)))}`);
    report(ok, "(CX-7) 회차 간 산출물이 바이트 동일하고 원장은 generatedAt 외에 동일하다(기계 축 결정성 — 갈리면 변동이 아니라 결함이다)");
  }

  // ---- (CX-8) 결과 기록에 네 수가 남는다 ----
  //      비율만 적으면 그것이 어떻게 나왔는지 사후에 재계산할 수 없다. 분모·탐지·미탐지·
  //      무효 네 수를 함께 적어야 「분모가 조용히 줄었는가」를 나중에 물을 수 있다.
  {
    const results = {
      generatedBy: "tests/run-smoke.mjs --contamination",
      runs: perRun.map((r) => r.runId),
      byKind: Object.fromEntries(kindDirs.map((k) => [k, ratiosByKind.get(k).map((r) => r.t)])),
      gates: Object.fromEntries(kindDirs.map((k) => [k, evaluateGate({ kind: k, ratios: ratiosByKind.get(k).map((r) => r.t.ratio) })])),
      outOfScope: { [CASE_KINDS.UNSUPPORTED_CLAIM]: "이 모드의 범위 밖이다(D6) — --contamination-llm의 몫이며 미채점이 아니다." },
    };
    const resultsIdx = process.argv.indexOf("--results");
    if (resultsIdx !== -1 && process.argv[resultsIdx + 1]) {
      fs.writeFileSync(process.argv[resultsIdx + 1], JSON.stringify(results, null, 2) + "\n", "utf8");
      console.log(`    결과 기록: ${process.argv[resultsIdx + 1]}`);
    }
    const shaped = kindDirs.every((k) =>
      results.byKind[k].every((t) => Number.isInteger(t.denominator) && Number.isInteger(t.detected) && Number.isInteger(t.missed) && Number.isInteger(t.invalid) && t.denominator === 10)
    );
    const ok = shaped && results.runs.length === perRun.length && perRun.length > 0;
    if (!ok) console.log(`    실제: ${JSON.stringify(results.byKind)}`);
    report(ok, "(CX-8) 결과 기록이 종·회차마다 분모·탐지·미탐지·무효 네 수를 담는다(비율만 적으면 사후 재계산이 불가능하다)");
  }
}

/**
 * 회차 원장의 `sourceRepoHead`와 맞는 픽스처 레포를 찾는다.
 *
 * **경로를 하드코딩하지 않는다.** 픽스처는 시스템 임시 디렉터리의 캐시에 살고 그 이름은
 * `make-fixture.mjs` 내용 해시로 정해지므로, 경로를 적어 두면 생성기가 바뀌는 순간 낡는다.
 * 대신 캐시 후보를 훑어 **HEAD가 일치하는** 레포를 고른다 — 못 찾으면 `null`이고 호출부가
 * FAIL시킨다(빈 값으로 강등하지 않는다).
 */
function findFixtureRepoFor(sourceRepoHead) {
  let entries = [];
  try { entries = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith("devcareer-golden-cache-")); }
  catch { return null; }
  for (const e of entries) {
    const candidate = path.join(os.tmpdir(), e, "large300");
    if (!fs.existsSync(path.join(candidate, ".git"))) continue;
    const r = spawnSync("git", ["-C", candidate, "rev-parse", "HEAD"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === sourceRepoHead) return candidate;
  }
  return null;
}

async function main() {
  const negative = process.argv.includes("--negative");
  const golden = process.argv.includes("--golden");
  const contamination = process.argv.includes("--contamination");

  if (contamination) {
    runSection("오염 스위트(기계 3종)", runContaminationSuite);
    return finishMode("contamination"); // 아래 golden 분기의 주석과 같은 이유.
  }

  // --golden은 나머지 모드와 배타적으로 분리한다 — 픽스처 생성이 최초
  // 1회 ~1분 걸려 기본/negative 스모크와 섞으면 그 두 모드가 항상
  // 느려진다(임무 지침 D: "스모크 기본 모드가 과도하게 느려지면 --golden
  // 같은 별도 플래그로 분리"). package.json의 `test` 스크립트가 기본
  // 스모크 실행 뒤 이 플래그로 다시 호출해 npm test 경로에서는 항상
  // 함께 돈다.
  if (golden) {
    runSection("골든 게이트", runGoldenGate);
    // **`return`이 붙어 있는 이유(2026-08-25).** `finishMode`는 지금 `process.exit`으로 끝나므로
    // `return`이 없어도 동작이 같다. 그러나 그 함수를 **테스트 가능하게** 만드는 압력(exit 대신
    // 종료 코드를 반환)이 이 파일에 이미 있고, 그 변경을 하는 순간 `return`이 없으면 golden 모드가
    // 아래 negative 분기와 default 경로로 **조용히 흘러내린다** — 그러면 총량 가드가 golden 11이
    // 아니라 default 기대값과 비교되며 엉뚱하게 FAIL한다. 제어 흐름을 지금 고정해 그 함정을 없앤다.
    return finishMode("golden");
  }

  if (negative) {
    // A-36: 공통 섹션은 기본 모드가 이미 실행하므로 여기서는 재실행하지
    // 않는다 — negative 스위트 고유의 단언만 돈다.
    await runSectionAsync("negative 스위트", runNegativeSuite);
    return finishMode("negative"); // 위 golden 분기의 주석과 같은 이유.
  }

  runCommonSections();
  await runSectionAsync("기본 스모크", runDefaultSmoke);

  return finishMode("default");
}

main().catch((e) => {
  console.error(`\n[중단] ${e.message}`);
  process.exit(1);
});
