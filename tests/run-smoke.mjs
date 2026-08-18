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
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runValidation, runLangCheck, runSchemaCheck } from "../scripts/validate-plugin.mjs";
import { walk, listFilesByExt } from "../scripts/lib/fs-walk.mjs";
import { validateInstance } from "../scripts/lib/schema-validate.mjs";
import { computeRepoKeyForPath, getRepoToplevel } from "../scripts/lib/store.mjs";
import { collectGitFacts, _internal as collectorInternal } from "../scripts/collect-git-facts.mjs";
import { computeSampling, CANONICAL_SAMPLING_METHOD_LITERAL } from "../scripts/lib/sampling.mjs";
import {
  verifyCitation,
  verifySnippetCitation,
  verifyMergeFileSetEquivalence,
  checkLayerRefs,
  verifyEvidence,
  createVerificationCache,
  verificationCacheKey,
  exitCodeForReport,
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
import { checkSamplingMethodLiteralDrift } from "../scripts/lib/sampling-literal-drift.mjs";
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
  FAKE_COMMIT_HASH_IN_SUBJECT,
} from "../fixtures/make-fixture.mjs";
import { redactSecrets, containsSecretPattern } from "../scripts/lib/redact.mjs";

const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TESTS_DIR, "..");

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

function report(ok, label) {
  if (ok) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL  ${label}`);
  }
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
  {
    const schemaPath = path.join(REPO_ROOT, "schemas", "career.schema.json");
    const instPath = path.join(TESTS_DIR, "fixtures-valid", "career.json");
    const schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
    const instance = JSON.parse(fs.readFileSync(instPath, "utf8"));
    const warnings = [];
    const errors = validateInstance(schema, instance, schema, "$", warnings);
    if (errors.length > 0) {
      for (const e of errors) console.log(`    실제 오류: ${e}`);
    }
    for (const w of warnings) console.log(`    [WARN] ${w}`);
    report(
      errors.length === 0 && warnings.length === 0,
      "tests/fixtures-valid/career.json이 schemas/career.schema.json에 적합함(AC-6), 미지원 키워드 경고 0건"
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

  const offenders = [];
  for (const f of uniqueTargets) {
    const text = fs.readFileSync(f, "utf8");
    if (SPAWN_GIT_RE.test(text)) offenders.push(path.relative(REPO_ROOT, f));
  }
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
      const aliceEntry = evidence.commits.find((c) => c.authorEmail === ALICE_EMAIL);
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
      const aliceEntry = evidence.commits.find((c) => c.authorEmail === ALICE_EMAIL);
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
      const goldenPath = path.join(REPO_ROOT, "fixtures", "golden", "case-17-merge-hash-claim.json");
      const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
      const goldenCitation = golden.node.evidence[0];
      const rGolden = verifyCitation({
        repoPath: dirs.merge,
        evidence,
        selectedIdentities: [OWNER_EMAIL],
        ledgerId: goldenCitation.ledgerId,
        nodeBasis: golden.node.basis,
      });
      const okGolden = rGolden.verdict === "FAIL" && rGolden.code === "CITATION_MERGE_HASH_NON_INFERENCE_BASIS_FORBIDDEN";
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
      const aliceEntry = evidenceForMixed.commits.find((c) => c.authorEmail === ALICE_EMAIL);
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
      const aliceEntry = evidence.commits.find((c) => c.authorEmail === ALICE_EMAIL);
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

const EVIDENCE_SCHEMA = JSON.parse(
  fs.readFileSync(path.join(REPO_ROOT, "schemas", "evidence.schema.json"), "utf8")
);

function runEvidenceSchemaCheckSmoke() {
  console.log("[evidence.schema.json 구조 검증 스모크(A-13)] 실제 수집기 출력 → 실제 스키마로 구조 검증");

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
      const errors = validateInstance(EVIDENCE_SCHEMA, evidence, EVIDENCE_SCHEMA, "$", warnings);
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
      const errors = validateInstance(EVIDENCE_SCHEMA, evidence, EVIDENCE_SCHEMA, "$", []);
      const ok = errors.some((e) => e.includes("shortHash"));
      if (!ok) console.log(`    실제: ${JSON.stringify(errors)}`);
      report(ok, "판별력 증명: commits[0].shortHash 삭제 → validateInstance가 required 위반을 잡음(A-13)");
    }

    // ---- (b) 판별력 증명: 스키마 밖 최상위 필드 추가 → 실제로 FAIL. ----
    {
      const evidence = structuredClone(collect(dirs.multiAuthor, {}));
      evidence.strayFieldMutation = "unexpected";
      const errors = validateInstance(EVIDENCE_SCHEMA, evidence, EVIDENCE_SCHEMA, "$", []);
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
const MAKE_FIXTURE_PATH = path.join(REPO_ROOT, "fixtures", "make-fixture.mjs");

/** fixtures/make-fixture.mjs 현재 내용의 SHA-256 hex(앞 16자). */
function computeMakeFixtureContentHash() {
  const content = fs.readFileSync(MAKE_FIXTURE_PATH);
  return crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
}

const MAKE_FIXTURE_CONTENT_HASH = computeMakeFixtureContentHash();
const GOLDEN_CACHE_DIR = path.join(os.tmpdir(), `devcareer-golden-cache-v1-${MAKE_FIXTURE_CONTENT_HASH}`);
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

  const recomputed = computeMakeFixtureContentHash();
  report(recomputed === MAKE_FIXTURE_CONTENT_HASH, "make-fixture.mjs 내용 해시 재계산이 모듈 로드 시점 값과 일치(결정적)");

  report(
    GOLDEN_CACHE_DIR.includes(MAKE_FIXTURE_CONTENT_HASH),
    "GOLDEN_CACHE_DIR 경로 자체에 make-fixture.mjs 내용 해시가 포함됨(파일이 바뀌면 다른 캐시 디렉터리를 가리킨다)"
  );

  // 실측: make-fixture.mjs의 실제 내용에 1바이트라도 덧붙이면(디스크에는
  // 쓰지 않고 메모리에서만) 해시와 그로부터 계산되는 캐시 디렉터리 경로가
  // 둘 다 달라진다 — 즉 이전 캐시(GOLDEN_CACHE_DIR)는 새 경로에서는 아예
  // 존재하지 않는 디렉터리가 되어 자동으로 캐시 미스(재생성) 처리된다.
  // 이 Run의 배경이 실측한 버그("declared.changeType을 변조해도 --golden이
  // 녹색")는 정확히 이 경로가 없어서 발생했다.
  const realContent = fs.readFileSync(MAKE_FIXTURE_PATH);
  const mutatedContent = Buffer.concat([realContent, Buffer.from("\n// 임무 B 캐시 무효화 관측용 — 실제 파일에는 쓰지 않음\n")]);
  const mutatedHash = crypto.createHash("sha256").update(mutatedContent).digest("hex").slice(0, 16);
  const mutatedCacheDir = path.join(os.tmpdir(), `devcareer-golden-cache-v1-${mutatedHash}`);
  const invalidationOk = mutatedHash !== MAKE_FIXTURE_CONTENT_HASH && mutatedCacheDir !== GOLDEN_CACHE_DIR;
  if (!invalidationOk) console.log(`    실제: mutatedHash=${mutatedHash} currentHash=${MAKE_FIXTURE_CONTENT_HASH}`);
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

  const goldenPath = path.join(REPO_ROOT, "fixtures", "golden", "sampling-300.expected.json");
  const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));

  const { dir, declared, cached } = ensureLarge300Fixture();
  console.log(`  [준비] large300 픽스처 ${cached ? "캐시 재사용" : "새로 생성(최초 1회, ~1분 소요)"}: ${dir}`);

  // golden.parameters.equivalentCollectorInvocation과 동일한 인자
  // (identity/max-commits/merge-included, ref는 CLI 기본값 HEAD).
  const collectParams = {
    repoPath: dir,
    selectedIdentities: [golden.parameters.identity],
    ref: "HEAD",
    mergeIncluded: golden.parameters.mergeIncluded,
    maxCommits: golden.parameters.maxCommits,
    botsEnabled: golden.parameters.botsExcluded,
  };

  const run1 = collectGitFacts(collectParams).evidence;
  const run2 = collectGitFacts(collectParams).evidence;

  const selectedHashesSorted = (ev) => ev.commits.filter((c) => !c.excluded).map((c) => c.hash).sort();
  const sel1 = selectedHashesSorted(run1);
  const sel2 = selectedHashesSorted(run2);

  // ---- 결정성(AC-21): 동일 입력 2회 실행 시 선택 집합이 같아야 한다. ----
  report(
    JSON.stringify(sel1) === JSON.stringify(sel2),
    "골든: 동일 인자로 collectGitFacts를 2회 실행해도 선택 집합이 동일함(샘플링 결정성)"
  );

  // ---- coverage 3수치(이월 게이트 A-3/B-2) — traversed==300, total은
  // 픽스처 선언값(ownerTotal)과 일치, analyzed==K==50, 부등식 성립. ----
  report(run1.coverage.traversed === 300, `골든: coverage.traversed === 300 (실제 ${run1.coverage.traversed})`);
  report(
    run1.coverage.total === declared.ownerTotal,
    `골든: coverage.total === 픽스처 선언값 ownerTotal(${declared.ownerTotal}) (실제 ${run1.coverage.total}) — ` +
      "B-1/B-2 '250 하드코딩' 회귀 방지, 픽스처 구성값과 직접 대조"
  );
  report(
    run1.coverage.total === golden.coverage.total && run1.coverage.analyzed === golden.coverage.analyzed,
    `골든: coverage.total/analyzed가 sampling-300.expected.json과 일치(total=${golden.coverage.total}, analyzed=${golden.coverage.analyzed})`
  );
  report(
    run1.coverage.analyzed <= run1.coverage.total && run1.coverage.total < run1.coverage.traversed,
    `골든: analyzed(${run1.coverage.analyzed}) <= total(${run1.coverage.total}) < traversed(${run1.coverage.traversed}) 관계식 성립`
  );

  // ---- truncated: dropped_commits == total - K, reason == budget_commits. ----
  report(
    run1.truncated.reason === "budget_commits" &&
      run1.truncated.dropped_commits === run1.coverage.total - run1.coverage.analyzed,
    `골든: truncated.reason==="budget_commits" 및 dropped_commits===total-analyzed(${run1.truncated.dropped_commits})`
  );

  // ---- samplingMethod 완전 일치(재서술 금지 — 리터럴 그대로). ----
  report(
    run1.coverage.samplingMethod === golden.samplingMethodLiteral,
    "골든: coverage.samplingMethod가 정본 samplingMethod 리터럴과 완전 일치"
  );

  // ---- 선택 커밋 집합이 골든 파일과 완전 일치(개수 항등식이 아니라
  // 원소 단위 대조 — slice(0,max)·dedup 누락·정렬 키 오구현을 모두 잡는다). ----
  const selMatches = JSON.stringify(sel1) === JSON.stringify(golden.selectedCommitHashesSorted);
  if (!selMatches) {
    const goldenSet = new Set(golden.selectedCommitHashesSorted);
    const actualSet = new Set(sel1);
    const missing = golden.selectedCommitHashesSorted.filter((h) => !actualSet.has(h));
    const extra = sel1.filter((h) => !goldenSet.has(h));
    console.log(`    개수: 기대 ${golden.selectedCommitHashesSorted.length} / 실제 ${sel1.length}`);
    console.log(`    골든에는 있으나 실제엔 없음(최대 5건): ${missing.slice(0, 5).join(", ")}`);
    console.log(`    실제엔 있으나 골든엔 없음(최대 5건): ${extra.slice(0, 5).join(", ")}`);
  }
  report(selMatches, "골든: 선택 커밋 집합(정렬됨)이 fixtures/golden/sampling-300.expected.json과 완전 일치");

  // ---- excluded 커밋 전량 등재(AC-7 (a)축·AC-9가 절단 상태에서도 관측
  // 가능해야 한다는 구현 5단계 요구) — traversed - total과 정확히 같아야 한다. ----
  const excludedCount = run1.commits.filter((c) => c.excluded).length;
  report(
    excludedCount === run1.coverage.traversed - run1.coverage.total,
    `골든: excluded 커밋이 원장에 전량 등재됨(excluded=${excludedCount} === traversed-total=${run1.coverage.traversed - run1.coverage.total})`
  );

  // ---- AC-6 회귀: 300커밋 규모(실제 머지 5건 포함)의 실제 수집 결과에도
  // 새 교차 불변식이 위반 0건이어야 한다(무오탐 재확인, 더 큰 표본). ----
  const invariantViolations = checkEvidenceInvariants(run1);
  if (invariantViolations.length > 0) {
    for (const v of invariantViolations) console.log(`    실제 위반: ${v.code}: ${v.message}`);
  }
  report(invariantViolations.length === 0, "골든: 300커밋 실제 수집 결과(머지 5건 포함)에 AC-6 교차 불변식 위반 0건");
  const nonVacuous = checkMergeNonVacuous(run1);
  report(nonVacuous.length === 0, "골든: 300커밋 픽스처의 실제 원장에 머지 5건이 (iv) 비공허성을 만족함");
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
      fs.mkdirSync(path.join(tmpRoot, "schemas"), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, "fixtures", "golden"), { recursive: true });
      fs.mkdirSync(path.join(tmpRoot, "docs", "harness", "devcareer-prep-plugin"), { recursive: true });

      const schema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "schemas", "evidence.schema.json"), "utf8"));
      const desc = schema.$defs.coverage.properties.samplingMethod.description;
      // 정본 리터럴의 마지막 글자 하나만 바꾼다(예: "bucket" → "buckeu") —
      // 사람이 실수로 오타를 낸 것과 같은 형태의 드리프트.
      schema.$defs.coverage.properties.samplingMethod.description = desc.replace(
        "carry-to-next-bucket`", "carry-to-next-buckeu`"
      );
      report(
        schema.$defs.coverage.properties.samplingMethod.description !== desc,
        "사전 확인: 임시 스키마 사본의 samplingMethod description이 실제로 1글자 변조됨(재현 전제 성립)"
      );
      fs.writeFileSync(path.join(tmpRoot, "schemas", "evidence.schema.json"), JSON.stringify(schema, null, 2), "utf8");

      // 골든 스크립트·spec.md는 실제 레포 파일을 그대로 복사한다(원본 값 유지).
      fs.copyFileSync(
        path.join(REPO_ROOT, "fixtures", "golden", "compute-sampling-golden.mjs"),
        path.join(tmpRoot, "fixtures", "golden", "compute-sampling-golden.mjs")
      );
      fs.copyFileSync(
        path.join(REPO_ROOT, "docs", "harness", "devcareer-prep-plugin", "spec.md"),
        path.join(tmpRoot, "docs", "harness", "devcareer-prep-plugin", "spec.md")
      );

      const result = checkSamplingMethodLiteralDrift(tmpRoot);
      const ok = result.ok === false && result.mismatches.includes("schemas/evidence.schema.json");
      if (!ok) console.log(`    실제: ok=${result.ok} mismatches=${JSON.stringify(result.mismatches)} missing=${JSON.stringify(result.missing)}`);
      report(
        ok,
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
        result.missing.includes("docs/harness/devcareer-prep-plugin/spec.md");
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
    } else {
      result = await runLangCheck({ outDir: caseDir });
    }
    const hasCode = result.errors.some((e) => e.code === c.code);
    const ok = !result.ok && hasCode;
    if (!ok) {
      console.log(`    케이스 (${c.n}) ${c.label}: ok=${result.ok} 기대 코드 '${c.code}' 존재=${hasCode}`);
      for (const e of result.errors) console.log(`      실제 오류: ${e.code}: ${e.message}`);
    }
    report(ok, `케이스 (${c.n}) ${c.label} → exit 1 + ${c.code}`);
  }

  const positiveDir = path.join(TESTS_DIR, "fixtures-valid");
  const positiveResult = await runLangCheck({ outDir: positiveDir });
  if (!positiveResult.ok) {
    for (const e of positiveResult.errors) console.log(`    실제 오류: ${e.code}: ${e.message}`);
  }
  report(positiveResult.ok, "tests/fixtures-valid/ positive 픽스처 → exit 0 (AC-19 오탐 없음)");

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
    console.log(`  [중단] 섹션 "${label}" 실행 중 예외 발생: ${e.stack ?? e.message}`);
    report(false, `섹션 "${label}"이 예외로 중단됨(${e.message})`);
  }
}

async function runSectionAsync(label, fn) {
  try {
    await fn();
  } catch (e) {
    console.log(`  [중단] 섹션 "${label}" 실행 중 예외 발생: ${e.stack ?? e.message}`);
    report(false, `섹션 "${label}"이 예외로 중단됨(${e.message})`);
  }
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
function runCommonSections() {
  runSection("스키마 검증기 스모크", runSchemaValidatorSmoke);
  runSection("repo-key 스모크", runStoreKeySmoke);
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
}

async function main() {
  const negative = process.argv.includes("--negative");
  const golden = process.argv.includes("--golden");

  // --golden은 나머지 모드와 배타적으로 분리한다 — 픽스처 생성이 최초
  // 1회 ~1분 걸려 기본/negative 스모크와 섞으면 그 두 모드가 항상
  // 느려진다(임무 지침 D: "스모크 기본 모드가 과도하게 느려지면 --golden
  // 같은 별도 플래그로 분리"). package.json의 `test` 스크립트가 기본
  // 스모크 실행 뒤 이 플래그로 다시 호출해 npm test 경로에서는 항상
  // 함께 돈다.
  if (golden) {
    runSection("골든 게이트", runGoldenGate);
    console.log(`\n결과: ${passed} PASS / ${failed} FAIL`);
    process.exit(failed === 0 ? 0 : 1);
  }

  if (negative) {
    // A-36: 공통 섹션은 기본 모드가 이미 실행하므로 여기서는 재실행하지
    // 않는다 — negative 스위트 고유의 단언만 돈다.
    await runSectionAsync("negative 스위트", runNegativeSuite);
    console.log(`\n결과: ${passed} PASS / ${failed} FAIL`);
    process.exit(failed === 0 ? 0 : 1);
  }

  runCommonSections();
  await runSectionAsync("기본 스모크", runDefaultSmoke);

  console.log(`\n결과: ${passed} PASS / ${failed} FAIL`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`\n[중단] ${e.message}`);
  process.exit(1);
});
