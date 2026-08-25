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
//   --root         저장 루트. **경로에 `.devcareer` 세그먼트가 있어야 한다**
//                  (콜드 리뷰 Security #11) — 없으면 [INPUT_ERROR] + exit 2다.
//                  `--draft`에는 이 제약이 없다(임시 위치의 읽기 대상이다).
//   --force        사용자 편집이 감지된 산출물을 덮어쓴다. 덮어쓰기 직전
//                  <파일명>.bak 1세대를 남긴다(AC-16). **백업에 실패하면
//                  강행하지 않고 exit 3으로 멈춘다** — 복구 수단 없는 덮어쓰기를
//                  하지 않기 위해서다(콜드 리뷰 Correctness #9).
//   --generated-at generatedAt을 고정한다(픽스처 재현용). 생략 시 현재 시각.
//
// 종료 코드(5분기 — 각각 호출자가 취할 조치가 다르다):
//   0 산출물 기록 + 레지스트리 갱신 완료.
//   1 계약·스키마 위반 — **아무것도 쓰지 않았다.** 출력을 고쳐 다시 부른다.
//   2 입력 오류(인자·파일 부재·JSON 파싱) — 쓰지 않았다.
//   3 안전하게 쓸 수 없다 — 산출물 파일을 기록하지 않았다. **사람 결정·확인이
//     필요하다**: 사용자 편집 감지(PREV_ARTIFACT_EDITED), 이전 산출물 판독 불가
//     (PREV_ARTIFACT_UNREADABLE / _HASH_MISSING), 백업 실패
//     (PREV_ARTIFACT_BACKUP_FAILED), 파일시스템 쓰기 실패(ARTIFACT_WRITE_FAILED),
//     플러그인 설치 손상(LAYER_SCHEMA_UNREADABLE), **이전 산출물에서 온 내용의 스키마
//     위반(PREV_ARTIFACT_SCHEMA_VIOLATION)**. 사유는 [HOLD] 줄의 코드로 나온다.
//     공통점은 「인자나 출력을 고쳐서 해소되지 않는다」이다 — 그래서 1·2가 아니다.
//
//     **PREV_ARTIFACT_SCHEMA_VIOLATION만 `--force`로 넘어갈 수 없다**(f029375 Minor 12).
//     다른 보류는 「덮어써도 되는가」를 사람에게 묻는 것이라 강행이 답이 될 수 있지만,
//     이것은 쓰기 직전 자기 검증이라 강행하면 스키마를 어기는 산출물이 기록된다.
//     사람이 고쳐야 하는 대상이 draft가 아니라 **이전 산출물**이라는 점도 다르다.
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
  classifySchemaErrorsByProvenance,
  computeArtifactContentHash,
  mergeArtifact,
} from "./lib/artifact-contract.mjs";
import { validateInstance } from "./lib/schema-validate.mjs";
import { checkStorageBoundary, readState, toStorageRelative, writeJsonAtomic, writeState } from "./lib/store.mjs";

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

/**
 * state.json 자신의 형식 버전(state.schema.json의 default와 같은 값).
 *
 * **export 하는 이유(2026-08-25)**: 「같은 값」이라는 이 주석이 유일한 집행 수단이었다 —
 * 스키마의 `schemaVersion`은 `pattern`만 강제하고 `const`가 아니라 두 값이 갈려도
 * 스키마 검증이 통과한다. `(AC-2c)`가 이 상수를 직접 읽어 대조한다.
 */
export const STATE_SCHEMA_VERSION = "0.1.0";

/**
 * 계층 스키마를 판독한다. **판독·파싱·형태 중 하나라도 실패하면 던진다.**
 *
 * **파싱 성공은 판독 성공이 아니다(2026-08-25) — 이것이 쓰기 경계의 fail-open이었다.**
 * 스키마 파일 내용이 `null`·`false`·스칼라·배열이면 `JSON.parse`는 통과하고, 그 값이
 * `validateInstance`에 넘어가면 `schema-validate.mjs`의 falsy·비객체 fail-open이
 * **오류 0건**을 돌려준다. 그러면 이 파일이 유일한 쓰기 경로라고 선언하며 세워 둔
 * 「쓰기 직전 자기 스키마 검증」(구현 7단계 (a))이 **통째로 건너뛰어진다.**
 *
 * **실측(격리 사본).** `schemas/career.schema.json`을 `null`로 두고 enum 위반 노드 2건을
 * 넘겼더니 `[write-artifact] 기록: …career.json (노드 2건)` + **exit 0**이었고, 기록된 파일에
 * `status: "NOT_A_VALID_ENUM_VALUE"`가 그대로 남았다. 같은 draft를 정상 스키마에 넘긴
 * 대조군은 `[SCHEMA] additionalProperties 위반` + **exit 1 + 미기록**이다.
 * 이 제품이 막으려는 실패의 원형이 쓰기 경계 자신에게 있었다.
 *
 * **던지는 것이 옳은 이유**: 호출부의 `try/catch`가 이미 `LAYER_SCHEMA_UNREADABLE` + exit 3
 * 으로 이 부류를 처리한다(「출력을 고쳐도 해소되지 않으므로 exit 1은 거짓 안내다」).
 * 비객체 스키마는 부재·훼손과 **같은 부류**(플러그인 설치 손상)이므로 같은 채널로 보낸다 —
 * 새 종료 코드를 만들면 그 구별을 아무도 쓰지 않는다.
 *
 * **`root`를 인자로 받는다.** 기본값이 `REPO_ROOT`라 기존 호출부는 그대로이고, 가짜 루트를
 * 주입할 수 있어야 위 형태 게이트를 **관측**할 수 있다(관측되지 않는 제약은 없는 것이다).
 *
 * @param {string} layer 계층 이름
 * @param {string} [root] 스키마 루트. 기본값 `REPO_ROOT`
 * @returns {object} 스키마 객체
 * @throws {Error} 판독 실패 · JSON 파싱 실패 · 내용이 객체가 아님
 */
export function loadSchema(layer, root = REPO_ROOT) {
  // 파일명 규약은 `<layer>.schema.json` 하나뿐이다 — 표를 따로 두면 계층을
  // 늘릴 때 두 곳을 고쳐야 하고, 한쪽만 고치면 조용히 다른 스키마로 검증한다.
  const rel = path.join("schemas", `${layer}.schema.json`);
  const parsed = JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  const shape = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
  if (shape !== "object") {
    throw new Error(`${rel} 내용이 객체가 아닙니다(${shape}) — 스키마로 쓸 수 없습니다`);
  }
  return parsed;
}

/**
 * 이전 산출물을 읽고 **안전하게 덮어쓸 수 있는지**를 판정한다.
 *
 * 세 가지 모두 보류 사유다. 셋 다 "덮어쓰면 사용자 데이터가 사라질 수
 * 있는데 그 여부를 기계가 알 수 없는" 상태이므로, 조용히 진행하지 않는다.
 *
 * **`existence`가 boolean이 아닌 이유(콜드 리뷰 Correctness #9).** 초판은
 * `found: boolean`이었고 ENOENT가 아닌 모든 읽기 오류(EACCES·EPERM·EISDIR)
 * 에서 `found: true`를 돌려줬다 — 실제로는 **파일이 있는지조차 확인하지
 * 못한** 상태인데 "있다"고 단정한 것이다. 그 거짓말이 `main()`으로 흘러
 * `--force` 강행 시 `writeBackup`을 부르고, 읽기가 실패한 바로 그 이유로
 * 복사도 실패해 미처리 예외로 죽었다. Node의 미처리 예외 종료 코드가 1이라
 * 그 크래시는 **문서화된 exit 1('출력을 고쳐 다시 부른다')로 위장**되어
 * 호출자를 무의미한 재시도 루프로 유도했다. 세 상태를 구분하면 강행 로직이
 * '읽힘'과 '읽기 실패'를 혼동하지 않는다.
 *
 * @returns {{existence: "absent"|"present"|"unknown", prev: object|null, hold: {code: string, message: string}|null}}
 */
export function inspectPreviousArtifact(layer, filePath) {
  // `--force` 강행이 어떤 결과를 낳는지는 두 UNREADABLE 경로에서만 비대칭
  // 하게 빠져 있었다(콜드 리뷰 Correctness #7). PREV_ARTIFACT_EDITED는
  // '.bak 1세대를 남긴다'까지 안내하는데, prev를 못 읽는 이쪽은 강행하면
  // **병합할 대상 자체가 없어** locked 노드까지 전부 draft로 대체된다 —
  // 더 파괴적인 쪽이 경고가 없었다.
  const FORCE_WARNING =
    " --force로 강행하면 병합할 이전 산출물이 없어 locked 노드를 포함한 기존 내용 전체가 이번 출력으로 대체되며, " +
    "복구 수단은 .bak 1세대뿐입니다.";

  let text;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return { existence: "absent", prev: null, hold: null };
    return {
      existence: "unknown",
      prev: null,
      hold: {
        code: "PREV_ARTIFACT_UNREADABLE",
        message:
          `기존 산출물을 읽을 수 없어 존재 여부조차 확인하지 못했습니다: ${filePath} (${e.code ?? e.message}).` +
          FORCE_WARNING,
      },
    };
  }

  let prev;
  try {
    prev = JSON.parse(text);
  } catch (e) {
    return {
      existence: "present",
      prev: null,
      hold: {
        code: "PREV_ARTIFACT_UNREADABLE",
        message: `기존 산출물의 JSON 파싱에 실패했습니다: ${filePath} — ${e.message}.` + FORCE_WARNING,
      },
    };
  }

  if (typeof prev?.contentHash !== "string" || prev.contentHash === "") {
    // 부재를 "편집 없음"으로 읽지 않는다(fail-closed) — 해시가 없으면
    // 편집 여부를 판정할 수단 자체가 없다.
    return {
      existence: "present",
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
      existence: "present",
      prev,
      hold: {
        code: "PREV_ARTIFACT_EDITED",
        message:
          `기존 산출물의 contentHash가 본문 재계산값과 다릅니다(기록 ${prev.contentHash} ≠ 재계산 ${recomputed}) — ` +
          "사용자가 손으로 편집했을 수 있습니다. 덮어쓰려면 --force를 주십시오(덮어쓰기 직전 .bak 1세대를 남깁니다).",
      },
    };
  }

  return { existence: "present", prev, hold: null };
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
 * **이 함수는 던지지 않는다 — 실패는 전부 반환값이다(콜드 리뷰 Correctness).**
 * 초판은 스키마 로드와 `writeState`가 try/catch 밖에 있었다. 그 둘이 던지면
 * (디스크·권한·파일 잠금, 또는 플러그인 설치가 손상돼 `schemas/state.schema.json`을
 * 읽지 못하는 경우) 예외가 `main()`까지 올라가 Node 기본 처리로 **exit 1**이 됐다.
 * 그런데 이 지점은 산출물을 **이미 쓴 뒤**이므로 계약상 exit **4**여야 한다 —
 * exit 1은 이 파일이 「아무것도 쓰지 않았다, 출력을 고쳐 다시 부른다」로 정의한
 * 값이라, 호출자는 존재하는 산출물을 두고 draft를 고쳐 재시도하는 무의미한 루프에
 * 들어간다. `--force` 백업 실패에서 닫은 것과 **같은 형태의 위장**이다.
 *
 * **집행을 호출 지점이 아니라 함수 안에 둔 이유.** 이 함수는 export돼 있고
 * `main()` 말고 다른 호출자가 생길 수 있다. 호출 지점만 감싸면 「어떤 실패는
 * `{ok:false}`, 어떤 실패는 예외」라는 두 얼굴의 계약이 남는다.
 *
 * @returns {{ok: boolean, error: string|null}} 예외를 던지지 않는다.
 */
export function updateRegistry(root, layer, artifactPath, schemaVersion, skillName, nowIso) {
  try {
    return updateRegistryOrThrow(root, layer, artifactPath, schemaVersion, skillName, nowIso);
  } catch (e) {
    return {
      ok: false,
      // **사유 코드를 붙인다.** 위쪽 early-return(손상된 state.json 거부)도
      // `{ok:false}`를 돌리므로, 코드가 없으면 「어느 경로로 실패했는가」를 호출자도
      // 오라클도 구별할 수 없다 — 그러면 이 가드가 한 번도 실행되지 않아도
      // 「{ok:false}가 나왔다」는 사실만으로 관측이 통과한다.
      error:
        `REGISTRY_UNEXPECTED_ERROR: 레지스트리 갱신 중 처리하지 못한 오류가 났습니다(${e.code ?? e.message}) — ` +
        "state.json 경로의 권한·잠금 상태와 플러그인 설치(schemas/state.schema.json)를 확인하십시오.",
    };
  }
}

/** `updateRegistry`의 본체. **직접 부르지 마라** — 던질 수 있다. */
function updateRegistryOrThrow(root, layer, artifactPath, schemaVersion, skillName, nowIso) {
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

  // **`loadSchema`를 거친다(2026-08-25).** 초판은 여기서 맨 `readFileSync` + `JSON.parse`를
  // 했고, 그래서 `state.schema.json` 내용이 `null`이면 아래 `validateInstance`가 오류 0건을
  // 돌려 **검증되지 않은 레지스트리가 기록됐다.** 경로 조립도 `loadSchema`와 이중이었다.
  // 던지는 경로는 `updateRegistry`의 try/catch가 `REGISTRY_UNEXPECTED_ERROR`로 받는다 —
  // 그 사유 문자열이 이미 「플러그인 설치(schemas/state.schema.json)를 확인하십시오」를 적고 있다.
  const stateSchema = loadSchema("state");
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

  // **쓰기 경계에 경계 검증이 없던 것을 닫는다(콜드 리뷰 Security #11).**
  // 이 파일이 유일한 쓰기 경로라고 선언해 두고 그 경로가 받는 --root만
  // 무검증이면 선언이 무의미하다. `--draft`는 검사하지 않는다 — 그것은
  // 오케스트레이션이 임시 위치에 만드는 **읽기** 대상이고, 저장 경계 안에
  // 있어야 할 이유가 없다. 경계가 지키는 것은 **쓰기 대상**이다.
  const boundary = checkStorageBoundary(root);
  if (boundary !== null) {
    console.error(`[INPUT_ERROR] --root가 저장 경계 밖입니다 — ${boundary}`);
    process.exit(2);
  }

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
  const { merged, violations, prevDerived } = mergeArtifact(opts.layer, inspected.prev, draft, { stage: opts.stage });
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
  //
  // **스키마 로드 실패를 미처리 예외로 두지 않는다.** `loadSchema`는
  // readFileSync·JSON.parse를 감싸지 않으므로 플러그인 설치가 손상되면(스키마
  // 파일 부재·훼손) 원시 스택과 함께 Node 기본 처리로 exit 1이 난다 —
  // `updateRegistry` 주석이 지목한 바로 그 시나리오가 같은 파일 안에 열려
  // 있었다. 출력을 고쳐도 해소되지 않으므로 exit 1은 거짓 안내다.
  // **exit 4가 아니라 3인 이유**: 이 지점은 `writeJsonAtomic`보다 앞이라 산출물이
  // 기록되지 않았고, exit 4는 「기록됐다」를 뜻한다.
  let layerSchema;
  try {
    layerSchema = loadSchema(opts.layer);
  } catch (e) {
    console.error(
      `[HOLD] LAYER_SCHEMA_UNREADABLE: 계층 스키마를 읽을 수 없습니다: schemas/${opts.layer}.schema.json ` +
      `(${e.code ?? e.message}) — 플러그인 설치가 손상됐을 수 있습니다.`
    );
    console.error("[write-artifact] 아무것도 쓰지 않았습니다 — 인자나 출력으로 고칠 수 있는 문제가 아니므로 설치 상태를 확인하십시오.");
    process.exit(3);
  }
  const schemaErrors = validateInstance(layerSchema, merged);
  if (schemaErrors.length > 0) {
    // **위반이 prev에서 왔으면 exit 1은 거짓 안내다(f029375 Minor 12).**
    // 이 검증의 대상은 draft가 아니라 **병합 결과**이고, 병합 결과에는 prev에서
    // 온 것이 섞인다 — 잠긴 생존자 노드 전체와, draft 노드에 얹힌 `origin`·
    // `verification`. 그 위반에 대고 exit 1의 계약(「출력을 고쳐 다시 부른다」)을
    // 내면 호출자는 draft를 아무리 고쳐도 **영원히 같은 위반**을 받는다.
    //
    // **여기가 지금 열려 있던 유일한 비가역 데이터 손실 경로였다.** 구체 경로:
    // 사용자가 노드를 손으로 고치며 잘못된 값과 `locked: true`를 함께 넣음 →
    // `PREV_ARTIFACT_EDITED` 보류 → `--force` 강행 → 병합이 그 노드를 싣는다 →
    // 스키마 위반 → exit 1. 그 막다른 길에서 「출력을 고쳐라」를 따르다 지친
    // 호출자가 산출물을 지우고 새로 쓰면 잠가 둔 편집분이 사라진다.
    //
    // **`--force`로 넘어갈 수 없다 — 의도다.** 이 검사는 (a)「쓰기 직전 자기
    // 검증」이므로 강행하면 스키마를 어기는 산출물이 기록된다. 그래서 이 HOLD는
    // 다른 보류들과 달리 우회로가 없고, 사람이 **이전 산출물 쪽**을 고쳐야 한다.
    const { fromPrev, fromDraft } = classifySchemaErrorsByProvenance(schemaErrors, prevDerived);
    if (fromPrev.length > 0) {
      console.error(
        `[HOLD] PREV_ARTIFACT_SCHEMA_VIOLATION: 병합 결과의 스키마 위반 ${fromPrev.length}건이 ` +
        `이전 산출물에서 온 내용입니다(${filePath}) — 출력(draft)을 고쳐도 해소되지 않습니다.`
      );
      for (const e of fromPrev) console.error(`[HOLD]   ${e}`);
      // draft 몫이 함께 있으면 **감추지 않는다.** 사람이 prev를 고친 뒤 재실행하면
      // 곧바로 이것들을 만나므로, 한 번에 보여 주는 편이 왕복을 줄인다.
      //
      // **라벨을 붙인다.** 붙이지 않으면 아래 「조치」 문단 바로 위에 그 조치로는
      // 해소되지 않는 줄이 섞여 나온다 — 이 커밋이 고친 결함(따라도 낫지 않는 안내)과
      // 같은 형태다. 적대 검증이 혼합 케이스를 실행해 지적했다.
      if (fromDraft.length > 0) {
        console.error(
          `[write-artifact] 아래 ${fromDraft.length}건은 성격이 다릅니다 — 출력(draft)을 고쳐야 해소되며, ` +
          "위 보류를 해결하고 다시 부르면 이번엔 exit 1로 만납니다."
        );
        for (const e of fromDraft) console.error(`[SCHEMA] ${e}`);
      }
      // **조치 목록은 실행으로 검증했다.** 초판은 (2)를 「잠금을 풀면 재생성이 대체한다」로
      // 조건 없이 적었는데, 실측에서 두 갈래가 틀렸다: 잠기지 않은 노드(origin·verification을
      // 이어받은 경우)에는 **아무 효과가 없고**(이미 false다), draft에 없는 잠긴 생존자의
      // 잠금을 풀면 대체가 아니라 **삭제된다**(draft가 그 id를 언급하지 않으므로 병합 규칙 1이
      // 살리지 않는다 — 실측: 노드 2건 → 1건). 통하지 않는 안내를 내보내는 것이 바로 이
      // 항목이 고친 결함이므로 조건을 명시한다.
      console.error(
        "[write-artifact] 아무것도 쓰지 않았습니다 — 사람 확인이 필요합니다. " +
        "(1) **어느 경우에나 통하는 조치**: 산출물 파일의 해당 노드를 직접 고친 뒤 --force와 함께 다시 부른다" +
        "(고치면 contentHash가 어긋나 PREV_ARTIFACT_EDITED로 보류되므로 --force가 필요하고, 덮어쓰기 직전 " +
        ".bak 1세대가 남습니다). " +
        "(2) **그 노드가 잠겨 있고 이번 출력이 같은 id를 다시 내놓는 경우에만**: locked를 false로 바꾸면 " +
        "재생성이 대체합니다 — 출력에 없는 노드의 잠금을 풀면 대체가 아니라 **삭제**되고, 애초에 잠기지 않은 " +
        "노드(origin·verification을 이어받아 위반이 난 경우)에는 효과가 없습니다. " +
        "(3) 이전에 --force 덮어쓰기가 성공한 적이 있어 .bak이 남아 있다면 그것으로 복원한다 — " +
        "**이번 실행은 .bak을 만들지 않았습니다**(이 검사가 백업보다 앞입니다). " +
        "**--force만으로는 이 지점을 넘을 수 없습니다** — 쓰기 직전 자기 검증이라 강행하면 스키마를 어기는 " +
        "산출물이 기록됩니다."
      );
      process.exit(3);
    }
    for (const e of schemaErrors) console.error(`[SCHEMA] ${e}`);
    console.error("[write-artifact] 스키마 위반으로 아무것도 쓰지 않았습니다(구현 7단계 (a)).");
    process.exit(1);
  }

  if (inspected.hold !== null && opts.force && inspected.existence !== "absent") {
    // **백업 실패를 미처리 예외로 두지 않는다(콜드 리뷰 Correctness #9).**
    // existence가 "unknown"인 경로는 애초에 읽기가 실패한 경우이고, 같은
    // 이유로 copyFileSync도 실패한다. 던지게 두면 Node가 exit 1로 죽어
    // 「출력을 고쳐 다시 부르라」는 exit 1 계약으로 위장되는데, 실제로 필요한
    // 조치는 사람의 확인이다. 이 지점은 writeJsonAtomic보다 **앞**이므로
    // 여기서 멈추면 "쓰지 않았다" 불변식이 그대로 유지된다.
    let bakPath;
    try {
      bakPath = writeBackup(filePath);
    } catch (e) {
      console.error(
        `[HOLD] PREV_ARTIFACT_BACKUP_FAILED: 덮어쓰기 직전 .bak을 남기지 못했습니다: ${filePath} (${e.code ?? e.message}) — ` +
        "백업 없이 강행하면 기존 내용의 복구 수단이 사라지므로 진행하지 않았습니다."
      );
      console.error("[write-artifact] 아무것도 쓰지 않았습니다 — 사람 확인이 필요합니다(파일 권한·잠금 상태를 확인하십시오).");
      process.exit(3);
    }
    console.error(`[write-artifact] 강행 — 덮어쓰기 직전 1세대를 보존했습니다: ${bakPath}`);
  }

  // **이 파일이 「산출물이 디스크에 닿는 유일한 경로」라고 선언한 바로 그 호출이
  // 비보호였다.** 여기까지 왔다면 계약·스키마 검사는 전부 통과했으므로 실패는
  // draft 내용과 무관한 파일시스템 문제다 — 경계 안의 `--root`가 일반 파일 하위를
  // 가리켜 ENOTDIR, 디스크 가득 참, 권한, 잠금. 던지게 두면 Node가 exit 1로 죽는데
  // 이 파일의 exit 1은 「출력을 고쳐 다시 부른다」라서 호출자는 draft를 아무리
  // 고쳐도 같은 예외를 반복한다(실측: `.devcareer/<일반 파일>/nested`를 --root로
  // 주면 mkdirSync ENOTDIR 원시 스택 + exit 1).
  //
  // **exit 3인 이유.** 기계가 대신 결정할 수 있는 것이 없다 — `--force` 백업
  // 실패를 같은 이유로 exit 3에 보냈다. **exit 4가 아니다**: 이 호출이 던졌다면
  // 산출물 파일은 기록되지 않았다.
  try {
    writeJsonAtomic(root, fileName, merged);
  } catch (e) {
    console.error(
      `[HOLD] ARTIFACT_WRITE_FAILED: 산출물을 쓰지 못했습니다: ${filePath} (${e.code ?? e.message}) — ` +
      "저장 루트의 경로·권한·잠금 상태와 남은 디스크 공간을 확인하십시오."
    );
    console.error(
      "[write-artifact] 산출물 파일은 기록되지 않았습니다(원자적 쓰기의 임시 파일이 남아 있을 수 있습니다) — " +
      "출력이 아니라 환경 문제이므로 draft를 고쳐 재시도해도 같은 실패가 반복됩니다."
    );
    process.exit(3);
  }
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
