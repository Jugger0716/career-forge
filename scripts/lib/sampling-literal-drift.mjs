// scripts/lib/sampling-literal-drift.mjs
//
// 콜드 리뷰 A-19 대응: 정본 `samplingMethod` 리터럴은 네 곳에 물리적으로
// 존재한다 — (1) docs/harness/devcareer-prep-plugin/spec.md 구현 5단계
// 본문, (2) schemas/evidence.schema.json의 coverage.samplingMethod
// description, (3) scripts/lib/sampling.mjs의
// CANONICAL_SAMPLING_METHOD_LITERAL, (4) fixtures/golden/compute-sampling-
// golden.mjs의 HARDCODED_LITERAL(정본 리터럴로부터 골든 스냅샷을 "독립
// 재계산"하기 위한 의도적 별도 사본 — PROVENANCE.md 참조).
//
// (2)↔(3) 대조(assertNoLiteralDrift)는 예전에도 fixtures/golden/compute-
// sampling-golden.mjs 안에 있었지만, 그 스크립트를 실행하는 코드가
// package.json(lint/test)에도 tests/run-smoke.mjs에도 없어 실질적으로
// 죽은 가드였다 — "정본(스키마)만 고치고 사본 세 곳을 잊는" 가장 흔한
// 실수 방향이 어떤 게이트에도 걸리지 않았다(실측: 스키마만 고쳐도 lint
// exit 0, 71/88/11 PASS). 이 모듈은 그 대조를 scripts/validate-plugin.mjs
// 의 기본 검사(npm run lint)에 항진명제 없이 배선하기 위한 정본이다 —
// (3)은 실제 프로덕션 모듈을 import해서 읽고, (1)(2)(4)는 파일 텍스트에서
// 정규식으로 리터럴을 추출한다(코드 실행이 아니라 텍스트 대조이므로
// fixtures/golden 쪽 파일을 scripts/lib이 "실행"하지 않는다 — 순수 조회).

import fs from "node:fs";
import path from "node:path";
import { CANONICAL_SAMPLING_METHOD_LITERAL } from "./sampling.mjs";

export const SPEC_MD_REL = "docs/harness/devcareer-prep-plugin/spec.md";
export const EVIDENCE_SCHEMA_REL = "schemas/evidence.schema.json";
export const GOLDEN_SCRIPT_REL = "fixtures/golden/compute-sampling-golden.mjs";
export const SAMPLING_LIB_REL = "scripts/lib/sampling.mjs";

const LITERAL_PREFIX = "K=min(max_commits,total)";

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 텍스트에서 백틱(`` ` ``)으로 감싸인, `K=min(max_commits,total)`로
 * 시작하는 리터럴 블록을 찾는다(spec.md·schema description 공용).
 * spec.md 본문은 정본 리터럴 전체를 기재하기 전에 그 접두부만 별도로
 * 짧게 인용하는 문장이 먼저 나온다(예: "`K=min(max_commits,total)`의
 * `total`은 …") — 첫 매치만 취하면 그 짧은 부분 인용을 정본으로 오인
 * 하므로, 이 접두부로 시작하는 모든 백틱 블록 중 **가장 긴 것**(=완전한
 * 리터럴)을 취한다.
 *
 * @param {string} text
 * @returns {string|null}
 */
function extractBacktickLiteral(text) {
  const re = new RegExp("`(" + escapeRegExp(LITERAL_PREFIX) + "[^`]*)`", "g");
  let longest = null;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (longest === null || m[1].length > longest.length) longest = m[1];
  }
  return longest;
}

/**
 * schemas/evidence.schema.json의 coverage.samplingMethod description에서
 * 정본 리터럴을 추출한다.
 *
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function extractLiteralFromSchema(repoRoot) {
  const schemaPath = path.join(repoRoot, EVIDENCE_SCHEMA_REL);
  if (!fs.existsSync(schemaPath)) return null;
  let schema;
  try {
    schema = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  } catch {
    return null;
  }
  const desc = schema?.$defs?.coverage?.properties?.samplingMethod?.description;
  if (typeof desc !== "string") return null;
  return extractBacktickLiteral(desc);
}

/**
 * docs/harness/devcareer-prep-plugin/spec.md 구현 5단계 본문에서 정본
 * 리터럴을 추출한다.
 *
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function extractLiteralFromSpecMd(repoRoot) {
  const specPath = path.join(repoRoot, SPEC_MD_REL);
  if (!fs.existsSync(specPath)) return null;
  const text = fs.readFileSync(specPath, "utf8");
  return extractBacktickLiteral(text);
}

/**
 * fixtures/golden/compute-sampling-golden.mjs의 `HARDCODED_LITERAL` 상수
 * 값을 텍스트에서 정규식으로 추출한다(그 파일을 import/실행하지 않는다 —
 * scripts/lib은 순수 텍스트 조회만 한다).
 *
 * @param {string} repoRoot
 * @returns {string|null}
 */
export function extractLiteralFromGoldenScript(repoRoot) {
  const goldenPath = path.join(repoRoot, GOLDEN_SCRIPT_REL);
  if (!fs.existsSync(goldenPath)) return null;
  const text = fs.readFileSync(goldenPath, "utf8");
  const m = /const HARDCODED_LITERAL\s*=\s*\n?\s*"([^"]+)"/.exec(text);
  return m ? m[1] : null;
}

/**
 * 정본 samplingMethod 리터럴이 네 곳(spec.md·스키마 description·
 * sampling.mjs 상수·골든 스크립트 하드코딩 사본) 모두에서 일치하는지
 * 검사한다. 하나라도 추출에 실패하면(파일이 없거나 형태가 바뀌어 정규식이
 * 더 이상 매치하지 않으면) "조용히 건너뛰지" 않고 missing으로 보고한다 —
 * 그래야 리터럴이 통째로 삭제되거나 형태가 바뀌어도 이 가드가 무력화되지
 * 않는다.
 *
 * @param {string} repoRoot
 * @returns {{ok: boolean, values: Record<string,string|null>, mismatches: string[], missing: string[]}}
 */
export function checkSamplingMethodLiteralDrift(repoRoot) {
  const values = {
    [SAMPLING_LIB_REL]: CANONICAL_SAMPLING_METHOD_LITERAL,
    [EVIDENCE_SCHEMA_REL]: extractLiteralFromSchema(repoRoot),
    [SPEC_MD_REL]: extractLiteralFromSpecMd(repoRoot),
    [GOLDEN_SCRIPT_REL]: extractLiteralFromGoldenScript(repoRoot),
  };

  const missing = Object.entries(values).filter(([, v]) => v == null).map(([k]) => k);
  const present = Object.entries(values).filter(([, v]) => v != null);

  const mismatches = [];
  if (present.length > 1) {
    const [, referenceValue] = present[0];
    for (const [k, v] of present.slice(1)) {
      if (v !== referenceValue) mismatches.push(k);
    }
  }

  return { ok: mismatches.length === 0 && missing.length === 0, values, mismatches, missing };
}
