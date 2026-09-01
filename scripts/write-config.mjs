#!/usr/bin/env node
// scripts/write-config.mjs
//
// 구현 7단계 — **`config.json`이 디스크에 닿는 유일한 경로**(결정 D3).
//
// **왜 이 파일이 필요한가.** `store.mjs`가 `readConfig`/`writeConfig` IO 계약을
// 갖고 있었지만 **프로덕션 호출자가 0건**이었다 — 즉 스펙과 스키마가 정의한
// `config.json`을 실제로 만드는 주체가 레포 어디에도 없었다. 그 상태에서
// `verify-evidence.mjs --config`는 이미 구현돼 있었으므로, 소비자만 있고
// 생산자가 없는 계약이었다. 결정 D3이 「`writeConfig`를 감싸는 얇은 CLI를
// 신설한다」로 이 갈래를 닫았다.
//
// **`writeConfig`를 직접 부르면 안 되는 이유.** 그 함수는 원자적 쓰기만 하고
// 내용을 보지 않는다 — 실제로 스모크의 IO 왕복 단언이
// `writeConfig(root, { schemaVersion: "0.1.0" })`로 **required 9개 중 8개가 빠진**
// 객체를 아무 저항 없이 기록한다. 그런 파일을 `verify-evidence --config`가 읽으면
// `identitySelection.selected`가 없어 「selectedIdentities가 비어 있습니다」로
// 죽는데, 그때 사람이 보는 것은 **설정 파일이 잘못됐다**가 아니라 **인자를
// 빠뜨렸다**는 메시지다. 검증을 쓰기 직전에 두면 그 오진이 없어진다.
//
// 사용법(CLI):
//   node scripts/write-config.mjs --in <config-input.json> --root <저장 루트> \
//        [--updated-at <ISO8601>]
//
//   --in           설정 내용 JSON. 스킬 0단계(범위 확정 대화)가 사용자에게
//                  확정받은 값을 조립해 임시 위치에 쓰고 이 인자로 넘긴다.
//                  **경계 검사를 하지 않는다** — 읽기 대상이고, 저장 루트 안에
//                  있어야 할 이유가 없다(`project-ledger.mjs --in`과 같은 규율).
//   --root         저장 루트. **경로에 `.devcareer` 세그먼트가 있어야 한다** —
//                  없으면 [INPUT_ERROR] + exit 2다. 경계가 지키는 것은 쓰기다.
//   --updated-at   `updatedAt`을 고정한다(픽스처 재현용). 생략 시 현재 시각.
//
// 종료 코드(2분기 — `project-ledger.mjs`·`verify-evidence.mjs`와 같은 A-32 규약):
//   0 config.json 기록 완료.
//   2 입력 오류 — **아무것도 쓰지 않았다.** 인자 오류·파일 부재·JSON 파싱 실패·
//     저장 경계 밖·**스키마 위반**·**원장 불일치**가 전부 여기로 온다.
//     사유는 [INPUT_ERROR] 줄에.
//
// **원장 대조(라운드 2 처방 5).** 스키마 검증을 통과한 뒤 쓰기 직전에
// `checkLedgerAgreement`가 저장 루트의 원장과 `identitySelection.selected`를
// 대조한다. 다섯 갈래에 각각 고유 코드가 붙으며 전부 exit 2다:
//
//   IDENTITY_GATE_INCOMPLETE       selected가 비었다 — 게이트 자체가 미완료.
//   LEDGER_MISSING                 저장 루트에 원장이 없다(부재를 통과로 강등하지 않는다).
//   LEDGER_UNREADABLE              원장이 있으나 판독·파싱 실패(부재와 다른 코드다).
//   LEDGER_IDENTITY_RECORD_MISSING 원장에 선택 저자 기록이 없다(빈 배열로 간주하지 않는다).
//   LEDGER_IDENTITY_SET_MISMATCH   설정과 원장의 선택 저자 집합이 다르다.
//
// **왜 원장인가.** 원장은 LLM이 아니라 결정적 수집기가 git에서 만든다. 이 대조가
// 없으면 「저자 게이트를 통과했다」는 기록이 그 게이트를 실제로 수행했는가와 무관해져,
// 레포에 존재한 적 없는 날조 이메일도 exit 0으로 박혔다.
//
// **왜 스키마 위반이 1이 아니라 2인가(결정 D3, 게이트 C-6/A-32 규약).**
// `write-artifact.mjs`의 exit 1은 「**LLM이 만든 출력**이 계약을 어겼다 — 출력을
// 고쳐 다시 부른다」는 뜻이다. 여기 들어오는 것은 생성 출력이 아니라 **사용자가
// 대화로 확정한 설정**이므로, 잘못됐다면 고칠 대상이 출력이 아니라 입력이다.
// 그래서 「결론을 낼 수 없음 계열」인 2에 합류시킨다 — exit 1은 이 파일에 없다.
//
// **이 CLI가 채우는 것은 둘뿐이고, 나머지 일곱은 채우지 않는다.**
// `schemaVersion`·`updatedAt`은 기계적인 값이라 여기서 찍는다. 그 밖의 required
// 일곱(`identitySelection`·`scope`·`budget`·`includeDiff`·`exclusions`·`storage`·
// `snippetQuoting`)은 **스키마에 default가 있어도 채우지 않는다.** 부재를 default로
// 조용히 메우면 이 플러그인이 막으려는 바로 그 형태 — **추측을 사실처럼 쓰는 것** —
// 이 설정 계층에서 재발하기 때문이다. 부재는 exit 2다.
//
// **근거는 「오늘 효과가 있는 값」에 둔다.** `identitySelection.selected`는 인용
// 검증의 저자 대조 축이 읽고, `scope`·`budget.maxCommits`·`exclusions`·`storage`는
// 수집기 CLI 플래그에 대응해 **무엇을 수집하고 어느 루트에 쓰는가**를 실제로 바꾼다.
// 기계가 대신 고르면 사용자가 확정하지 않은 범위 위에 모든 근거가 선다.
//
// **`includeDiff`·`snippetQuoting`은 오늘 아무 효과가 없다 — 감추지 않는다.**
// 둘 다 P0 자리표시자다(스키마 description이 그렇게 적고 있고, `collect-git-facts.mjs`
// 는 `void includeDiff;`로 명시적으로 버린다). 구현되면 diff 원문(시크릿·PII 표면)이
// 흐르는지를 가르게 될 값이지만 **지금은 아니다.** 콜드 리뷰 **A-38**이 「관측 가능한
// 효과가 0인 플래그를 광고하면 사용자를 속인다」로 판정해 수집기 CLI 표면에서 지운
// 것과 같은 대상이므로, 여기서도 **현재형으로 효과를 주장하지 않는다.** required라서
// 담아야 할 뿐이다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateInstance } from "./lib/schema-validate.mjs";
import { checkStorageBoundary, writeConfig, readEvidence, CONFIG_FILE_NAME } from "./lib/store.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

/**
 * 이 CLI가 찍는 `schemaVersion`. `config.schema.json`의
 * `properties.schemaVersion.default`와 같은 값이어야 한다.
 *
 * **두 값이 갈려도 스키마 검증은 통과한다** — 그 필드는 `pattern`만 강제하고
 * `const`가 아니라 어떤 버전 문자열이든 적합하기 때문이다. 즉 「검사해서 통과」가
 * 아니라 「검사 대상이 아니라 통과」다. `write-artifact.mjs`의
 * `STATE_SCHEMA_VERSION`이 같은 형태였고 `(AC-2c)`가 그 드리프트를 잡는다 —
 * 여기서는 `(AC-46)`이 같은 일을 한다.
 */
export const CONFIG_SCHEMA_VERSION = "0.1.0";

/** 이 CLI가 스스로 채우는 필드. 나머지 required는 입력이 담아야 한다. */
export const CONFIG_STAMPED_FIELDS = Object.freeze(["schemaVersion", "updatedAt"]);

/**
 * `config.schema.json`을 읽는다.
 *
 * `write-artifact.mjs`의 `loadSchema`와 같은 형태로 **비객체를 거부**한다 —
 * 내용이 `null`·배열·스칼라인 스키마를 그대로 `validateInstance`에 넘기면
 * `schema-validate.mjs`의 fail-open이 **오류 0건**을 돌려주고, 그러면 이 CLI가
 * 표방하는 「쓰기 직전 자기 검증」이 통째로 건너뛰어진다(순서 9번 ⑪이 실측한
 * 형태 그대로다). 파일명 규약은 하나뿐이라 표를 따로 두지 않는다.
 */
export function loadConfigSchema(root = REPO_ROOT) {
  const rel = path.join("schemas", "config.schema.json");
  const parsed = JSON.parse(fs.readFileSync(path.join(root, rel), "utf8"));
  const shape = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
  if (shape !== "object") {
    throw new Error(`${rel} 내용이 객체가 아닙니다(${shape}) — 스키마로 쓸 수 없습니다`);
  }
  return parsed;
}

/**
 * 입력 위에 기계적 필드 둘을 얹어 기록 대상 객체를 만든다(디스크에 닿지 않는다).
 *
 * **스탬프를 스프레드 뒤에 둔다.** 앞에 두면 입력이 실은 값이 이기고, 그러면
 * 호출자가 `updatedAt`을 과거로 적어 「언제 확정한 설정인가」를 왜곡할 수 있다.
 * 이 둘의 주인은 이 CLI다.
 *
 * @param {unknown} input `--in`이 담은 JSON
 * @param {string} nowIso `updatedAt`에 찍을 값
 * @returns {object}
 */
export function assembleConfig(input, nowIso) {
  const base = input === null || Array.isArray(input) || typeof input !== "object" ? {} : input;
  return { ...base, schemaVersion: CONFIG_SCHEMA_VERSION, updatedAt: nowIso };
}

/**
 * 저자 게이트가 실제로 수행됐는지를 **원장과 대조해** 판정한다(라운드 2 처방 5).
 *
 * **무엇이 열려 있었나.** 이 CLI는 `identitySelection.selected`가 스키마에
 * 적합하기만 하면 무엇이든 기록했다 — 빈 배열도, 레포에 존재한 적 없는 날조
 * 이메일도 exit 0이었다. 즉 「저자 게이트를 통과했다」는 기록이 **그 게이트를
 * 실제로 수행했는가와 무관**했다. 대조 상대를 원장으로 잡는 근거는 원장이 LLM이
 * 아니라 결정적 수집기가 git에서 만든 산물이라는 것 하나다.
 *
 * **집합 동치를 요구하고 부분집합으로 완화하지 않는다.** 수집기는 그 집합으로
 * 모든 커밋의 `excluded`/`exclusionReason`을 판정했으므로(`collect-git-facts.mjs`가
 * `selectedIdentities: opts.identities`로 인자를 그대로 기록한다), 수집 뒤
 * `selected`를 바꾸면 **원장 전체의 제외 판정이 조용히 낡는다.** 순서와 중복은
 * 무시한다 — 하류 소비자(`verify-evidence`)가 `includes`로 원소를 볼 뿐 배열
 * 순서를 읽지 않으므로, 순서에 민감하게 만들면 정직한 입력이 막힌다.
 *
 * **`commits[]`는 열지 않는다.** 원장의 커밋 목록에서 저자를 전수 스캔하는 설계도
 * 있었으나 뺐다 — (i) 기간 밖이라 커밋이 0건인 **정직한 본인 이메일**을 FAIL시키는
 * 오탐이 구조적으로 생기고, (ii) 선택되지 않은 **타인의 이메일**을 stderr로 흘리는
 * 유일한 경로가 됐을 것이다. 그 축의 방어는 `verify-evidence`의
 * `CITATION_AUTHOR_NOT_SELECTED`이며, 그것은 원장 플래그가 아니라 git이 실측한
 * 저자를 대조하는 **독립 검사**다.
 *
 * **다섯 갈래에 전부 고유 코드를 붙인다.** 전부 exit 2라 코드가 없으면 어느 분기로
 * 죽었는지 사람도 오라클도 구별하지 못하고, 한 갈래가 죽어도 다른 갈래가 그 자리를
 * 메워 관측이 조용히 통과한다.
 *
 * @param {object} config 스키마 검증을 이미 통과한 설정 객체
 * @param {{found: boolean, value: *, error: string|null}} evidenceRead `readEvidence`의 결과
 * @returns {{code: string, message: string}[]} 위반 목록(빈 배열이면 통과)
 */
export function checkLedgerAgreement(config, evidenceRead) {
  const selected = config?.identitySelection?.selected;

  // L1 — 게이트 자체가 미완료다. 원장이 실재하는 정상 루트에서는 아래 L3에
  //      흡수되지만(수집기가 `--identity` 없이는 exit 2로 죽으므로 원장의 선택
  //      집합은 비어 있지 않다), **그 상태에 정확한 이름을 붙이기 위해** 남긴다.
  //      즉 이 갈래가 닫는 구멍은 없고, 여는 것은 진단의 정확도다.
  if (!Array.isArray(selected) || selected.length === 0) {
    return [{
      code: "IDENTITY_GATE_INCOMPLETE",
      message:
        "저자 게이트가 완료되지 않았습니다 — identitySelection.selected가 비어 있습니다. " +
        "0단계에서 본인 identity를 확정한 뒤 다시 부르십시오.",
    }];
  }

  // L2a — 원장 부재. **통과로 강등하지 않는다**(절대 규칙 6): 강등하면 이 검사를
  //       없애는 가장 싼 방법이 원장을 지우는 것이 된다.
  if (evidenceRead.found === false) {
    return [{
      code: "LEDGER_MISSING",
      message:
        "저장 루트에 1단계가 만든 원장이 없습니다 — --root가 1단계가 보고한 저장 루트인지, " +
        "수집을 먼저 돌렸는지 확인하십시오.",
    }];
  }

  // L2b — 판독·파싱 실패. 부재와 **다른 코드**로 낸다. 「--root를 확인하라」는
  //       손상된 원장에 대해 거짓 안내다.
  if (evidenceRead.value === null || typeof evidenceRead.value !== "object" || Array.isArray(evidenceRead.value)) {
    return [{
      code: "LEDGER_UNREADABLE",
      message:
        `원장을 읽을 수 없습니다(${evidenceRead.error ?? "내용이 객체가 아닙니다"}) — ` +
        "1단계를 다시 돌려 원장을 새로 만드십시오.",
    }];
  }

  // L2c — 파싱은 됐으나 선택 저자 기록이 없다. **빈 배열로 간주하지 않는다** —
  //        그렇게 메우면 아래 L3가 「원장에 아무도 없다」로 읽어 엉뚱한 차집합을
  //        보고하고, 부재가 불일치로 위장된다.
  const recorded = evidenceRead.value?.coverage?.exclusions?.selectedIdentities;
  if (!Array.isArray(recorded)) {
    return [{
      code: "LEDGER_IDENTITY_RECORD_MISSING",
      message:
        "원장에 선택 저자 기록(coverage.exclusions.selectedIdentities)이 없습니다 — " +
        "빈 값으로 간주하지 않습니다. 1단계를 다시 돌려 원장을 새로 만드십시오.",
    }];
  }

  // L3 — 집합 동치. 여기가 실제로 위조 비용을 올리는 유일한 갈래다.
  const configSet = new Set(selected);
  const ledgerSet = new Set(recorded);
  const onlyConfig = [...configSet].filter((x) => !ledgerSet.has(x));
  const onlyLedger = [...ledgerSet].filter((x) => !configSet.has(x));
  if (onlyConfig.length > 0 || onlyLedger.length > 0) {
    const cut = (xs) => (xs.length <= 5 ? xs.join(", ") : `${xs.slice(0, 5).join(", ")} 외 ${xs.length - 5}건`);
    return [{
      code: "LEDGER_IDENTITY_SET_MISMATCH",
      message:
        "선택 저자가 원장의 기록과 다릅니다 — " +
        `설정에만: [${cut(onlyConfig)}] / 원장에만: [${cut(onlyLedger)}]. ` +
        "수집 뒤에 선택을 바꾸면 원장 전체의 제외 판정이 낡습니다 — 선택을 바꾸려면 수집을 다시 돌리십시오.",
    }];
  }

  return [];
}

function failInput(message) {
  console.error(`[INPUT_ERROR] ${message}`);
  console.error("[write-config] 아무것도 쓰지 않았습니다.");
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { in: null, root: null, updatedAt: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--in": opts.in = argv[++i]; break;
      case "--root": opts.root = argv[++i]; break;
      case "--updated-at": opts.updatedAt = argv[++i]; break;
      default: console.error(`[경고] 알 수 없는 인자 무시: ${argv[i]}`);
    }
  }

  if (!opts.in || !opts.root) {
    failInput(
      "사용법: node scripts/write-config.mjs --in <config-input.json> --root <저장 루트> " +
      "[--updated-at <ISO8601>]"
    );
  }

  const root = path.resolve(opts.root);
  const boundary = checkStorageBoundary(root);
  if (boundary !== null) failInput(`--root가 저장 경계 밖입니다 — ${boundary}`);

  let input;
  try {
    input = JSON.parse(fs.readFileSync(opts.in, "utf8"));
  } catch (e) {
    failInput(`설정 입력 파일을 읽을 수 없습니다: ${opts.in} (${e.code ?? e.message})`);
  }

  const config = assembleConfig(input, opts.updatedAt ?? new Date().toISOString());

  // **스키마 로드 실패를 미처리 예외로 두지 않는다.** 플러그인 설치가 손상되면
  // 원시 스택과 함께 Node 기본 처리로 exit 1이 나는데, 이 파일의 계약에 1은
  // 없다 — 호출자가 문서화되지 않은 코드를 받는다.
  let schema;
  try {
    schema = loadConfigSchema();
  } catch (e) {
    failInput(
      `설정 스키마를 읽을 수 없습니다: schemas/config.schema.json (${e.code ?? e.message}) — ` +
      "플러그인 설치가 손상됐을 수 있습니다."
    );
  }

  const errors = validateInstance(schema, config);
  if (errors.length > 0) {
    for (const e of errors) console.error(`[INPUT_ERROR] ${e}`);
    console.error(
      `[write-config] 아무것도 쓰지 않았습니다 — 설정이 config.schema.json을 어깁니다. ` +
      `이 CLI가 채우는 것은 ${CONFIG_STAMPED_FIELDS.join("·")} 둘뿐이고, ` +
      "나머지는 스키마에 default가 있더라도 채우지 않습니다 — 기계가 대신 고르면 사용자가 " +
      "확정하지 않은 범위 위에 모든 근거가 서기 때문입니다. 범위 확정 대화에서 빠진 항목을 " +
      "확정해 --in 파일에 담으십시오."
    );
    process.exit(2);
  }

  // **원장 대조는 스키마 검증 뒤, 쓰기 앞이다**(라운드 2 처방 5).
  // 앞에 두면 required가 빠진 입력이 스키마 사유 대신 원장 사유로 죽어
  // `(WC-3)`·`(WC-4)`가 관측하는 메시지가 바뀐다 — 그 두 루트에는 원장이 없다.
  // 뒤에 두면 `selected`가 이미 문자열 배열임이 스키마로 보장돼 판정 함수가
  // 형태 방어를 다시 하지 않는다. 그리고 `writeConfig` 앞이므로 **config.json이
  // 생기지 않고 기존 파일도 그대로 남는다.**
  const ledgerProblems = checkLedgerAgreement(config, readEvidence(root));
  if (ledgerProblems.length > 0) {
    for (const p of ledgerProblems) console.error(`[INPUT_ERROR] ${p.code}: ${p.message}`);
    console.error("[write-config] 아무것도 쓰지 않았습니다.");
    process.exit(2);
  }

  try {
    writeConfig(root, config);
  } catch (e) {
    failInput(
      `설정을 쓰지 못했습니다: ${path.join(root, CONFIG_FILE_NAME)} (${e.code ?? e.message}) — ` +
      "저장 루트의 경로·권한·잠금 상태와 남은 디스크 공간을 확인하십시오."
    );
  }

  console.error(`[write-config] 기록: ${path.join(root, CONFIG_FILE_NAME)}`);
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
