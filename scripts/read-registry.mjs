#!/usr/bin/env node
// scripts/read-registry.mjs
//
// 구현 8단계 — **state.json 레지스트리를 읽는 유일한 프로덕션 주체**이자
// AC-22 「오래된 근거」 경고의 집행 코드.
//
// **왜 이 파일이 필요한가.** `store.mjs`가 `readState`를 export 하고
// `state.schema.json`이 「스킬은 레지스트리로 상위 산출물을 찾는다」를 계약으로
// 적고 있었지만, **레지스트리를 읽는 프로덕션 호출자가 0건**이었다 — 쓰는 쪽
// (`write-artifact.mjs`의 `updateRegistry`)만 있고 읽는 쪽이 없었다.
// `write-config.mjs`가 닫은 갈래(소비자만 있고 생산자가 없음)의 정확한 거울상이다.
//
// **이미 있는 스테일 축과 다른 축이다 — 뭉뚱그리지 마라.**
// `verify-evidence.mjs`의 `checkSourceRepoHeadStale`은 **`evidence.json`의**
// `sourceRepoHead`를 본다(콜드 리뷰 A-7). 여기서 보는 것은 **레지스트리가 가리킨
// 산출물 파일(L1+)의** `sourceRepoHead`다. 원장은 신선한데 그 위에서 만든 경력
// 기술서가 낡아 있는 상태가 실재하므로, 한쪽을 봤다고 다른 쪽을 본 것이 아니다.
//
// **레지스트리 값이 아니라 산출물 파일 값이 정본이다(스펙 8단계·AC-16).**
// `state.schema.json`은 `sourceRepoHead`·`contentHash`를 **의도적으로 보관하지
// 않는다** — 파일 쓰기와 레지스트리 갱신 사이에 크래시가 나면 두 값이 갈리기
// 때문이다. 그래서 이 CLI는 레지스트리에서 **경로만** 얻고, 비교할 값은 반드시
// 그 경로가 가리키는 파일을 열어서 읽는다.
//
// 사용법(CLI):
//   node scripts/read-registry.mjs --root <저장 루트> --repo <레포 경로> --layer career
//
//   --root    저장 루트. 경로에 `.devcareer` 세그먼트가 있어야 한다.
//   --repo    대조할 레포. 현재 HEAD를 여기서 읽는다.
//   --layer   조회할 계층(`career`·`knowledge-map`·`gap-report`·`plan`).
//             **default를 두지 않는다** — 어느 상위 계층을 근거로 삼는가는
//             호출자의 결정이고, 기계가 대신 고르면 엉뚱한 계층의 신선도를
//             보고 「최신이다」라고 말하게 된다.
//
// 종료 코드(4분기):
//   0 FRESH      — 판독 성공, 산출물의 sourceRepoHead == 현재 HEAD. 진행해도 된다.
//   2 INPUT_ERROR— 인자·저장 경계·`--repo` 부재. **판정을 시도하지 않았다.**
//   3 STALE      — 판독 성공, 값이 다르다. **사용자에게 보여 주고 계속/중단 판단을
//                  받는다.** `write-artifact.mjs`의 exit 3과 같은 성격이며(「안전하게
//                  진행할 수 없음 — 기계가 대신 결정하지 않는다」), 같은 이유로
//                  자동 재시도·자동 무시 대상이 아니다.
//   4 UNRESOLVED — 판정할 수 없다(state.json 부재·손상·스키마 부적합, 계층 미등록,
//                  산출물 파일 판독 실패, git HEAD 조회 실패). 스펙 8단계가 요구한
//                  「예외 중단 없이 재수집 안내 후 정상 종료」의 기계 신호다.
//
// **왜 UNRESOLVED가 0이 아닌가 — 이것이 이 파일의 핵심 설계다.**
// 스펙의 「정상 종료」는 **프로세스가 스택 트레이스로 죽지 않는다**는 뜻이지
// 「신선하다고 보고한다」가 아니다. 판정 불가를 0에 합치면 「최신임을 확인했다」와
// 「확인하지 못했다」가 같은 코드가 되고, 그것이 이 레포가 반복해서 실측한 사고
// 형태(절대 규칙 — 판독 실패를 빈 값·default로 강등하지 마라)다. 4는 exit 1이
// 아니므로 **실패가 아니다** — 「모른다」를 「모른다」로 말하는 코드다.
//
// **`write-artifact.mjs`의 4와 뜻이 다르다(감추지 않는다).** 저쪽 4는 「산출물은
// 기록됐으나 레지스트리 갱신 실패」다. 두 CLI는 각자 헤더로 자기 코드를 선언하며
// 이 레포에 전역 코드 표는 없다 — 공유되는 규약은 **0=성공, 2=입력 오류(A-32)**
// 둘뿐이다. 호출자가 코드만 보고 파일을 가로질러 추론하지 않도록 여기 적어 둔다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runGit } from "./lib/git.mjs";
import { validateInstance } from "./lib/schema-validate.mjs";
import { ARTIFACT_LAYERS } from "./lib/artifact-contract.mjs";
import {
  checkStorageBoundary,
  fromStorageRelative,
  readState,
} from "./lib/store.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

/** exit 4로 가는 사유 코드. 각 분기가 **자기 코드를 달고** 나와야 구별된다. */
export const UNRESOLVED_CODES = Object.freeze([
  "STATE_MISSING",
  "STATE_UNREADABLE",
  "STATE_SCHEMA_VIOLATION",
  "LAYER_NOT_REGISTERED",
  "ARTIFACT_PATH_ESCAPES_ROOT",
  "ARTIFACT_UNREADABLE",
  "ARTIFACT_NOT_OBJECT",
  "ARTIFACT_HEAD_MISSING",
  "REGISTRY_SCHEMA_VERSION_DRIFT",
  "GIT_HEAD_UNRESOLVED",
]);

/**
 * `state.schema.json`을 읽는다.
 *
 * `write-config.mjs`의 `loadConfigSchema`·`write-artifact.mjs`의 `loadSchema`와
 * 같은 형태로 **비객체를 거부한다** — 내용이 `null`·배열·스칼라인 스키마를
 * `validateInstance`에 그대로 넘기면 `schema-validate.mjs:172`의 fail-open이
 * **오류 0건**을 돌려주고, 그러면 「부적합한 레지스트리를 걸러낸다」는 이 CLI의
 * 주장이 통째로 건너뛰어진다(순서 9번 ⑪이 실측한 형태 그대로다).
 */
export function loadStateSchema(root = REPO_ROOT) {
  const rel = path.join("schemas", "state.schema.json");
  const parsed = JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  const shape = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
  if (shape !== "object") {
    throw new Error(`${rel} 내용이 객체가 아닙니다(${shape}) — 스키마로 쓸 수 없습니다`);
  }
  return parsed;
}

/**
 * 판정 본체 — 디스크와 git을 읽지만 **프로세스를 죽이지 않는다.**
 *
 * 종료 코드로 갈라야 하는 것은 CLI의 일이고, 이 함수는 그 재료만 만든다.
 * 분리해 두는 이유는 스모크가 네 분기를 **프로세스 경계 없이도** 관측할 수
 * 있게 하기 위해서다(콜드 리뷰 「경로 인자를 받게 설계하라」와 같은 압력).
 *
 * @param {{root: string, repoPath: string, layer: string, stateSchema: object}} args
 * @returns {{verdict: "FRESH"|"STALE"|"UNRESOLVED", code: string|null, message: string|null,
 *            artifactPath: string|null, sourceRepoHead: string|null, currentHead: string|null}}
 */
export function inspectRegistryStaleness({ root, repoPath, layer, stateSchema }) {
  const unresolved = (code, message) => ({
    verdict: "UNRESOLVED", code, message,
    artifactPath: null, sourceRepoHead: null, currentHead: null,
  });

  const { stateKey } = ARTIFACT_LAYERS[layer];

  // ---- 1. 레지스트리 판독 ----
  const state = readState(root);
  if (!state.found) {
    return unresolved("STATE_MISSING", `저장 루트에 state.json이 없습니다: ${root}`);
  }
  if (state.error !== null) {
    return unresolved("STATE_UNREADABLE", `state.json을 읽을 수 없습니다 — ${state.error}`);
  }

  const schemaErrors = validateInstance(stateSchema, state.value);
  if (schemaErrors.length > 0) {
    return unresolved(
      "STATE_SCHEMA_VIOLATION",
      `state.json이 state.schema.json을 어깁니다: ${JSON.stringify(schemaErrors.slice(0, 5))}`
    );
  }

  // ---- 2. 계층 항목 ----
  const entry = state.value.artifacts?.[stateKey] ?? null;
  if (entry === null) {
    return unresolved(
      "LAYER_NOT_REGISTERED",
      `레지스트리에 '${layer}' 계층 항목이 없습니다(artifacts.${stateKey} === null) — 아직 생성되지 않았습니다.`
    );
  }

  let artifactAbs;
  try {
    artifactAbs = fromStorageRelative(root, entry.path);
  } catch (e) {
    return unresolved("ARTIFACT_PATH_ESCAPES_ROOT", `레지스트리 경로가 저장 루트 밖입니다 — ${e.message}`);
  }

  // ---- 3. 산출물 파일 — **여기가 정본이다** ----
  let artifact;
  try {
    artifact = JSON.parse(fs.readFileSync(artifactAbs, "utf8"));
  } catch (e) {
    return unresolved(
      "ARTIFACT_UNREADABLE",
      `레지스트리가 가리킨 산출물을 읽을 수 없습니다: ${entry.path} (${e.code ?? e.message})`
    );
  }
  const shape = artifact === null ? "null" : Array.isArray(artifact) ? "array" : typeof artifact;
  if (shape !== "object") {
    return unresolved("ARTIFACT_NOT_OBJECT", `산출물 내용이 객체가 아닙니다(${shape}): ${entry.path}`);
  }

  // **레지스트리 캐시가 파일과 갈리면 경로도 못 믿는다.** `state.schema.json`이
  // `artifactEntry.schemaVersion`을 「산출물 파일 자신의 값과 동일해야 한다」로
  // 적어 두고도 집행 코드가 없던 축이다. 갈렸다면 레지스트리가 낡았다는 뜻이고,
  // 그 낡음이 `path`에도 걸쳐 있을 수 있으므로 신선도를 판정하지 않는다 —
  // 「모른다」로 보고하고 재수집을 안내하는 것이 정직하다.
  if (artifact.schemaVersion !== entry.schemaVersion) {
    return unresolved(
      "REGISTRY_SCHEMA_VERSION_DRIFT",
      `레지스트리 캐시가 산출물 파일과 갈립니다: state.json=${JSON.stringify(entry.schemaVersion)} ` +
      `파일=${JSON.stringify(artifact.schemaVersion ?? null)} (${entry.path}) — 레지스트리가 낡았습니다.`
    );
  }

  const sourceRepoHead = artifact.sourceRepoHead;
  if (typeof sourceRepoHead !== "string" || sourceRepoHead === "") {
    return unresolved(
      "ARTIFACT_HEAD_MISSING",
      `산출물에 sourceRepoHead가 없습니다: ${entry.path} — 대조할 값이 없으므로 신선도를 판정하지 않습니다.`
    );
  }

  // ---- 4. 현재 HEAD ----
  const r = runGit(repoPath, ["rev-parse", "HEAD"]);
  if (r.outcome !== "ok") {
    return unresolved(
      "GIT_HEAD_UNRESOLVED",
      `현재 HEAD를 읽지 못했습니다(${r.outcome}): ${repoPath} — ${(r.stderr ?? "").trim().slice(0, 200)}`
    );
  }
  const currentHead = r.stdout.trim();

  const stale = sourceRepoHead !== currentHead;
  return {
    verdict: stale ? "STALE" : "FRESH",
    code: null,
    message: null,
    artifactPath: entry.path,
    sourceRepoHead,
    currentHead,
  };
}

function failInput(message) {
  console.error(`[INPUT_ERROR] ${message}`);
  console.error("[read-registry] 판정을 시도하지 않았습니다.");
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { root: null, repo: null, layer: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--root": opts.root = argv[++i]; break;
      case "--repo": opts.repo = argv[++i]; break;
      case "--layer": opts.layer = argv[++i]; break;
      default: console.error(`[경고] 알 수 없는 인자 무시: ${argv[i]}`);
    }
  }

  if (!opts.root || !opts.repo || !opts.layer) {
    failInput(
      "사용법: node scripts/read-registry.mjs --root <저장 루트> --repo <레포 경로> " +
      `--layer <${Object.keys(ARTIFACT_LAYERS).join("|")}>`
    );
  }
  if (!ARTIFACT_LAYERS[opts.layer]) {
    failInput(`지원하지 않는 계층입니다: '${opts.layer}' (지원: ${Object.keys(ARTIFACT_LAYERS).join(", ")})`);
  }

  const root = path.resolve(opts.root);
  const boundary = checkStorageBoundary(root);
  if (boundary !== null) failInput(`--root가 저장 경계 밖입니다 — ${boundary}`);

  const repoPath = path.resolve(opts.repo);
  if (!fs.existsSync(repoPath)) {
    failInput(`--repo 경로가 존재하지 않습니다: ${repoPath}`);
  }

  // 스키마 로드 실패를 미처리 예외로 두지 않는다 — 이 파일의 계약에 exit 1은
  // 없으므로 원시 스택과 함께 죽으면 호출자가 문서화되지 않은 코드를 받는다.
  let stateSchema;
  try {
    stateSchema = loadStateSchema();
  } catch (e) {
    failInput(
      `state 스키마를 읽을 수 없습니다: schemas/state.schema.json (${e.code ?? e.message}) — ` +
      "플러그인 설치가 손상됐을 수 있습니다."
    );
  }

  const r = inspectRegistryStaleness({ root, repoPath, layer: opts.layer, stateSchema });

  if (r.verdict === "FRESH") {
    console.log(
      `[FRESH] read-registry — ${opts.layer} 산출물이 현재 HEAD에서 생성됐습니다 ` +
      `(path=${r.artifactPath} head=${r.currentHead}).`
    );
    process.exit(0);
  }

  if (r.verdict === "STALE") {
    console.log(
      `[STALE] read-registry — ${opts.layer} 산출물의 근거가 현재 HEAD보다 오래됐습니다 ` +
      `(path=${r.artifactPath} sourceRepoHead=${r.sourceRepoHead} currentHead=${r.currentHead}).`
    );
    console.error(
      "[read-registry] 이 산출물이 인용한 커밋 범위는 현재 작업 트리를 반영하지 않습니다. " +
      "계속할지 중단하고 재수집할지는 **사용자의 결정**입니다 — 이 값을 자동으로 무시하지 마십시오."
    );
    process.exit(3);
  }

  console.log(`[UNRESOLVED] read-registry — ${opts.layer} 산출물의 신선도를 판정하지 못했습니다.`);
  console.error(`[UNRESOLVED] ${r.code}: ${r.message}`);
  console.error(
    "[read-registry] 이것은 '최신임'이 아니라 '확인하지 못함'입니다. " +
    `재수집을 안내하십시오: node scripts/collect-git-facts.mjs --repo ${repoPath} ...`
  );
  process.exit(4);
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
