#!/usr/bin/env node
// scripts/write-artifact.mjs
//
// 구현 7단계 — **산출물이 디스크에 닿는 유일한 경로.** LLM이 만든 JSON을
// 받아 (g) 기입 주체 검사 → (b)/AC-16 병합 → contentHash 기입 →
// (a) 자기 스키마 검증 → 원자적 쓰기 → AC-22 레지스트리 갱신 순으로 처리한다.
//
// **왜 스킬이 직접 파일을 쓰지 않는가.** 스펙 (a)는 "산출물 쓰기 직전
// validateInstance로 자기 검증하고 위반이 있으면 쓰지 않는다"고 못 박았다.
// 그 호출이 없으면 AC-12의 '스키마 레벨 강제'가 프로덕션 경로에서 옵션이
// 된다 — 스킬이 파일을 직접 쓰면 검증은 "프롬프트가 시켰으니 했겠지"가
// 되고, 안 했을 때 빨개지는 게이트가 없다. 쓰기 경계를 이 파일 하나로 좁혀야
// (a)(b)(g)와 AC-16·AC-22가 전부 **집행**된다.
//
// 마크다운 렌더는 여기서 하지 않는다 — scripts/render-markdown.mjs가 이미
// 그 계약의 소유 파일이고, 쓰기와 렌더를 한 프로세스에 묶으면 렌더 실패가
// 쓰기를 되돌려야 하는지 같은 질문이 생긴다. 스킬이 두 명령을 순서대로
// 부른다.
//
// 사용법(CLI):
//   node scripts/write-artifact.mjs --layer career --draft <draft.json> \
//        --root <저장 루트> --stage draft|fact-checked --skill career-from-git \
//        [--force] [--generated-at <ISO8601>]
//
//   --stage        생성 템플릿 출력이면 draft, FactChecker 판정을 실었으면
//                  fact-checked. verification의 **주인**을 가른다(구현 7단계 (g)):
//                  draft 출력은 그 필드를 아예 담지 않고 병합이 채우며(기존
//                  노드는 이전 판정을 이어받는다), fact-checked 출력만 판정을
//                  실을 수 있다. 콜드 리뷰 M-1 참조 — 초판은 draft가
//                  `not-attempted`를 기입하게 두었고, 그것이 스키마의
//                  `not-attempted → attempts const 0`과 재시도 이어받기 요구를
//                  동시에 만족시킬 수 없게 만들어 attempts>=1인 노드의 draft
//                  재작성을 네 갈래 모두 exit 1로 봉쇄했다.
//   --force        사용자 편집이 감지된 산출물을 덮어쓴다. 덮어쓰기 직전
//                  <파일명>.bak 1세대를 남긴다(AC-16).
//   --generated-at generatedAt을 고정한다(픽스처 재현용). 생략 시 현재 시각.
//
// 종료 코드(5분기 — 각각 호출자가 취할 조치가 다르다):
//   0 산출물 기록 + 레지스트리 갱신 완료.
//   1 계약·스키마 위반 — **아무것도 쓰지 않았다.** 출력을 고쳐 다시 부른다.
//   2 입력 오류(인자·파일 부재·JSON 파싱) — 쓰지 않았다.
//   3 기존 산출물을 안전하게 덮어쓸 수 없다 — 쓰지 않았다. **사람 결정이
//     필요하다**(사용자 편집 감지 등). 사유는 [HOLD] 줄의 코드로 나온다.
//   4 산출물은 기록됐으나 state.json 레지스트리 갱신에 실패했다.
//
// **왜 3과 4를 2·1에 합치지 않는가.** exit 1·2·3은 전부 "쓰지 않았다"는
// 불변식을 공유한다 — 그래서 호출자가 안전하게 재시도할 수 있다. 4는 그
// 불변식을 깨는 유일한 코드이므로 같은 값에 섞으면 재시도가 덮어쓰기가 된다.
// 3을 2에 섞으면 "고칠 수 있는 오류"와 "사람이 결정해야 하는 보류"가 같은
// 코드가 되어 스킬이 분기할 수 없다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ARTIFACT_LAYERS,
  AUTHORSHIP_STAGES,
  checkAuthorshipContract,
  computeArtifactContentHash,
  mergeArtifact,
} from "./lib/artifact-contract.mjs";
import { validateInstance } from "./lib/schema-validate.mjs";
import { readState, toStorageRelative, writeJsonAtomic, writeState } from "./lib/store.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

/** state.json 레지스트리의 초기 골격. 모든 계층 키가 존재해야 스키마를 통과한다. */
export const EMPTY_REGISTRY_ARTIFACTS = Object.freeze({
  evidence: null,
  career: null,
  knowledgeMap: null,
  gapReport: null,
  plan: null,
});

/** state.json 자신의 형식 버전(state.schema.json의 default와 같은 값). */
const STATE_SCHEMA_VERSION = "0.1.0";

function loadSchema(layer) {
  // 파일명 규약은 `<layer>.schema.json` 하나뿐이다 — 표를 따로 두면 계층을
  // 늘릴 때 두 곳을 고쳐야 하고, 한쪽만 고치면 조용히 다른 스키마로 검증한다.
  return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "schemas", `${layer}.schema.json`), "utf8"));
}

/**
 * 이전 산출물을 읽고 **안전하게 덮어쓸 수 있는지**를 판정한다.
 *
 * 세 가지 모두 보류 사유다. 셋 다 "덮어쓰면 사용자 데이터가 사라질 수
 * 있는데 그 여부를 기계가 알 수 없는" 상태이므로, 조용히 진행하지 않는다.
 *
 * @returns {{found: boolean, prev: object|null, hold: {code: string, message: string}|null}}
 */
export function inspectPreviousArtifact(layer, filePath) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { found: false, prev: null, hold: null };
    return {
      found: true,
      prev: null,
      hold: { code: "PREV_ARTIFACT_UNREADABLE", message: `기존 산출물을 읽을 수 없습니다: ${filePath} (${e.message})` },
    };
  }

  let prev;
  try {
    prev = JSON.parse(text);
  } catch (e) {
    return {
      found: true,
      prev: null,
      hold: { code: "PREV_ARTIFACT_UNREADABLE", message: `기존 산출물의 JSON 파싱에 실패했습니다: ${filePath} — ${e.message}` },
    };
  }

  if (typeof prev?.contentHash !== "string" || prev.contentHash === "") {
    // 부재를 "편집 없음"으로 읽지 않는다(fail-closed) — 해시가 없으면
    // 편집 여부를 판정할 수단 자체가 없다.
    return {
      found: true,
      prev,
      hold: {
        code: "PREV_ARTIFACT_HASH_MISSING",
        message: `기존 산출물에 contentHash가 없어 사용자 편집 여부를 판정할 수 없습니다: ${filePath}`,
      },
    };
  }

  const recomputed = computeArtifactContentHash(layer, prev);
  if (recomputed !== prev.contentHash) {
    return {
      found: true,
      prev,
      hold: {
        code: "PREV_ARTIFACT_EDITED",
        message:
          `기존 산출물의 contentHash가 본문 재계산값과 다릅니다(기록 ${prev.contentHash} ≠ 재계산 ${recomputed}) — ` +
          "사용자가 손으로 편집했을 수 있습니다. 덮어쓰려면 --force를 주십시오(덮어쓰기 직전 .bak 1세대를 남깁니다).",
      },
    };
  }

  return { found: true, prev, hold: null };
}

/**
 * 덮어쓰기 직전 `.bak` 1세대를 남긴다(AC-16 · 테스트 전략 [데이터 보존]).
 * **2세대 이상은 두지 않는다** — 기존 `.bak`은 그대로 덮어쓴다.
 */
export function writeBackup(filePath) {
  const bakPath = `${filePath}.bak`;
  fs.copyFileSync(filePath, bakPath);
  return bakPath;
}

/**
 * state.json 레지스트리에 이 산출물의 항목을 기입한다(AC-22 쓰기 주체).
 *
 * `sourceRepoHead`·`contentHash`는 **넣지 않는다** — 두 값의 진실 원천은
 * 산출물 파일 자신이며(AC-16), 레지스트리에 중복 보관하면 파일 쓰기와
 * 레지스트리 갱신 사이에 프로세스가 죽었을 때 두 값이 갈린다. 그 갈림은
 * AC-22의 스테일 판정을 오탐·미탐 양쪽으로 무너뜨린다.
 *
 * @returns {{ok: boolean, error: string|null}}
 */
export function updateRegistry(root, layer, artifactPath, schemaVersion, skillName, nowIso) {
  const { stateKey } = ARTIFACT_LAYERS[layer];
  const existing = readState(root);

  if (existing.found && existing.error !== null) {
    // 손상된 레지스트리를 덮어쓰면 다른 계층의 항목이 사라진다. 조용한
    // 데이터 유실보다 시끄러운 실패가 낫다.
    return { ok: false, error: `기존 state.json을 읽을 수 없어 갱신하지 않았습니다 — ${existing.error}` };
  }

  const base = existing.found && existing.value !== null ? existing.value : {};
  const state = {
    schemaVersion: typeof base.schemaVersion === "string" ? base.schemaVersion : STATE_SCHEMA_VERSION,
    updatedAt: nowIso,
    artifacts: { ...EMPTY_REGISTRY_ARTIFACTS, ...(base.artifacts ?? {}) },
  };

  let relPath;
  try {
    relPath = toStorageRelative(root, artifactPath);
  } catch (e) {
    return { ok: false, error: `산출물 경로를 저장 루트 기준 상대경로로 바꿀 수 없습니다 — ${e.message}` };
  }

  state.artifacts[stateKey] = { path: relPath, schemaVersion, generatedBySkill: skillName };

  const stateSchema = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "schemas", "state.schema.json"), "utf8"));
  const errors = validateInstance(stateSchema, state);
  if (errors.length > 0) {
    return { ok: false, error: `갱신된 state.json이 스키마를 위반합니다: ${JSON.stringify(errors)}` };
  }

  writeState(root, state);
  return { ok: true, error: null };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printViolations(kind, violations) {
  for (const v of violations) console.error(`[${kind}] ${v.code}: ${v.message}`);
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { layer: null, draft: null, root: null, stage: null, skill: null, force: false, generatedAt: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--layer": opts.layer = argv[++i]; break;
      case "--draft": opts.draft = argv[++i]; break;
      case "--root": opts.root = argv[++i]; break;
      case "--stage": opts.stage = argv[++i]; break;
      case "--skill": opts.skill = argv[++i]; break;
      case "--generated-at": opts.generatedAt = argv[++i]; break;
      case "--force": opts.force = true; break;
      default: console.error(`[경고] 알 수 없는 인자 무시: ${argv[i]}`);
    }
  }

  if (!opts.layer || !opts.draft || !opts.root || !opts.stage || !opts.skill) {
    console.error(
      "[INPUT_ERROR] 사용법: node scripts/write-artifact.mjs --layer <계층> --draft <draft.json> " +
      "--root <저장 루트> --stage draft|fact-checked --skill <스킬 이름> [--force] [--generated-at <ISO8601>]"
    );
    process.exit(2);
  }
  if (!ARTIFACT_LAYERS[opts.layer]) {
    console.error(`[INPUT_ERROR] 지원하지 않는 계층입니다: '${opts.layer}' (지원: ${Object.keys(ARTIFACT_LAYERS).join(", ")})`);
    process.exit(2);
  }
  if (!AUTHORSHIP_STAGES.includes(opts.stage)) {
    console.error(`[INPUT_ERROR] 지원하지 않는 단계입니다: '${opts.stage}' (지원: ${AUTHORSHIP_STAGES.join(", ")})`);
    process.exit(2);
  }

  let draft;
  try {
    draft = JSON.parse(fs.readFileSync(opts.draft, "utf8"));
  } catch (e) {
    console.error(`[INPUT_ERROR] 출력 파일을 읽을 수 없습니다: ${opts.draft} (${e.code ?? e.message})`);
    process.exit(2);
  }

  // (g) — 기입 주체. 병합보다 **먼저** 본다. 병합이 origin을 정상화하므로
  // 나중에 보면 템플릿의 시도가 이미 지워져 있다.
  const authorship = checkAuthorshipContract(opts.layer, draft, { stage: opts.stage });
  if (authorship.length > 0) {
    printViolations("AUTHORSHIP", authorship);
    console.error("[write-artifact] 기입 주체 규약 위반으로 아무것도 쓰지 않았습니다(구현 7단계 (g)).");
    process.exit(1);
  }

  const { fileName } = ARTIFACT_LAYERS[opts.layer];
  const root = path.resolve(opts.root);
  const filePath = path.join(root, fileName);

  const inspected = inspectPreviousArtifact(opts.layer, filePath);
  if (inspected.hold !== null && !opts.force) {
    console.error(`[HOLD] ${inspected.hold.code}: ${inspected.hold.message}`);
    console.error("[write-artifact] 기존 산출물을 안전하게 덮어쓸 수 없어 쓰지 않았습니다 — 사람 확인이 필요합니다(AC-16).");
    process.exit(3);
  }

  // (b)/AC-16 — 병합. prev를 읽지 못한 상태에서 --force로 강행하면 병합할
  // 대상이 없으므로 draft가 그대로 새 산출물이 된다(그때 .bak이 유일한
  // 복구 수단이다).
  const { merged, violations } = mergeArtifact(opts.layer, inspected.prev, draft, { stage: opts.stage });
  if (violations.length > 0) {
    printViolations("MERGE", violations);
    console.error("[write-artifact] 병합 계약 위반으로 아무것도 쓰지 않았습니다(구현 7단계 (b) / AC-16).");
    process.exit(1);
  }

  const nowIso = opts.generatedAt ?? new Date().toISOString();
  merged.generatedAt = nowIso;
  merged.contentHash = computeArtifactContentHash(opts.layer, merged);

  // (a) — 쓰기 직전 자기 검증. 파일이 아니라 메모리 객체를 검증하므로
  // `--schema-check` CLI가 아니라 모듈을 직접 부른다(스펙 원문).
  const schemaErrors = validateInstance(loadSchema(opts.layer), merged);
  if (schemaErrors.length > 0) {
    for (const e of schemaErrors) console.error(`[SCHEMA] ${e}`);
    console.error("[write-artifact] 스키마 위반으로 아무것도 쓰지 않았습니다(구현 7단계 (a)).");
    process.exit(1);
  }

  if (inspected.hold !== null && opts.force && inspected.found) {
    const bakPath = writeBackup(filePath);
    console.error(`[write-artifact] 강행 — 덮어쓰기 직전 1세대를 보존했습니다: ${bakPath}`);
  }

  writeJsonAtomic(root, fileName, merged);
  console.error(`[write-artifact] 기록: ${filePath} (노드 ${merged.nodes.length}건)`);

  const registry = updateRegistry(root, opts.layer, filePath, merged.schemaVersion, opts.skill, nowIso);
  if (!registry.ok) {
    console.error(`[REGISTRY] ${registry.error}`);
    console.error("[write-artifact] 산출물은 기록됐으나 레지스트리 갱신에 실패했습니다 — 재실행 전에 state.json을 확인하십시오.");
    process.exit(4);
  }

  console.error("[write-artifact] state.json 레지스트리 갱신 완료.");
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
