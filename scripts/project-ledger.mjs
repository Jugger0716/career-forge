#!/usr/bin/env node
// scripts/project-ledger.mjs
//
// 구현 7단계 (f) / 게이트 E-3 — **원장 → LLM 컨텍스트 투영 진입점.**
//
// `scripts/lib/store.mjs`의 `projectLedgerForSkills`는 이 파일이 생기기
// 전까지 **호출자가 0곳**이었다. 즉 §6의 제외 커밋 프라이버시 경계를 담당
// 한다고 스펙이 지정한 함수가 죽은 코드였고, 그 상태에서 소스 스캔 단언을
// 붙이면 대상 0건인 공허한 검사가 된다(게이트 E-3이 열려 있던 이유가 정확히
// 이것이다). 이 파일이 그 호출자다.
//
// **왜 라이브러리 함수만으로는 부족한가.** 스킬은 마크다운 프롬프트다 —
// 프롬프트는 JS 함수를 호출할 수 없다. 프롬프트가 "원장 원본이 아니라 투영을
// 거치게" 만들 수 있는 유일한 방법은 **투영된 결과를 만들어 주는 명령**을
// 두고, 프롬프트가 그 명령의 출력만 읽게 하는 것이다. 그래야 소스 스캔이
// 「SKILL.md·템플릿이 이 명령을 참조하는가」와 「원장 원본 경로를 참조하지
// 않는가」를 **양방향으로** 물을 수 있다. 함수 이름을 마크다운이 언급하는지만
// 보는 단언은 선언을 선언으로 확인하는 것이라 아무것도 막지 못한다.
//
// **이것은 여전히 보조 방어다(감추지 않는다).** 스킬이 evidence.json을 직접
// 읽는 것을 막을 결정적 수단은 없다 — 실제 방어는 §6의 **기록 시점 축소**
// (수집기가 제외 커밋의 authorEmail·subject·coAuthors를 애초에 쓰지 않는 것,
// T3)이다. 이 명령이 하는 일은 그 경계를 프롬프트 조립 지점에서 **관측
// 가능하게** 만드는 것뿐이다.
//
// 사용법(CLI):
//   node scripts/project-ledger.mjs --in <evidence.json> [--out <path>]
//   node scripts/project-ledger.mjs --root <저장 루트> [--out <path>]
//     --out 생략 시 stdout으로 출력한다. 제외 건수는 항상 stderr로 보고한다
//     (stdout을 파이프로 받는 호출자가 리포트 줄을 JSON으로 오해하지 않도록).
//
//     **`--root`와 `--out`은 저장 경계 안이어야 한다**(콜드 리뷰 Security #11):
//     경로에 `.devcareer` 세그먼트가 없으면 [INPUT_ERROR] + exit 2다.
//     `--in`은 검사하지 않는다 — 그것은 호출자가 지정한 **읽기** 대상이고
//     픽스처 원장을 가리키는 정당한 용법이 있다. 경계가 지키는 것은 쓰기와
//     저장 루트 해석이지 임의 파일 읽기가 아니다.
//
// 종료 코드: 0 = 투영 성공 / 2 = 입력 오류(파일 부재·JSON 파싱 실패·--out 쓰기 실패·인자
// 오류). render-markdown.mjs·verify-evidence.mjs와 같은 "입력 오류는 결론을
// 낼 수 없음 계열" 규약(콜드 리뷰 A-32)을 따른다.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { checkStorageBoundary, projectLedgerForSkills } from "./lib/store.mjs";

/** 원장 파일 이름 정본. 저장 루트 아래에 이 이름으로 놓인다(§9·AC-15). */
export const EVIDENCE_FILE_NAME = "evidence.json";

/**
 * 투영 결과와 함께 **무엇이 빠졌는지**를 돌려준다.
 *
 * 건수를 함께 내는 이유는 (e)축·(f)축의 `checked` 수치와 같다 — "제외 0건"이
 * 「제외할 것이 없었음」인지 「투영이 아무것도 안 했음」인지를 숫자 없이는
 * 구별할 수 없고, 그 둘은 프라이버시 경계에서 정반대 의미다.
 *
 * @param {object} evidence
 * @returns {{projected: object, totalCommits: number, excludedCommits: number}}
 */
export function projectWithReport(evidence) {
  const total = Array.isArray(evidence?.commits) ? evidence.commits.length : 0;
  const projected = projectLedgerForSkills(evidence);
  const kept = Array.isArray(projected?.commits) ? projected.commits.length : 0;
  return { projected, totalCommits: total, excludedCommits: total - kept };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function failInput(message) {
  console.error(`[INPUT_ERROR] ${message}`);
  process.exit(2);
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { inPath: null, root: null, outPath: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--in":
        opts.inPath = argv[++i];
        break;
      case "--root":
        opts.root = argv[++i];
        break;
      case "--out":
        opts.outPath = argv[++i];
        break;
      default:
        console.error(`[경고] 알 수 없는 인자 무시: ${argv[i]}`);
    }
  }

  if (!opts.inPath && !opts.root) {
    failInput("사용법: node scripts/project-ledger.mjs (--in <evidence.json> | --root <저장 루트>) [--out <path>]");
  }

  // 저장 경계(콜드 리뷰 Security #11). --in은 대상이 아니다 — 위 사용법 주석 참조.
  for (const [flag, value] of [["--root", opts.root], ["--out", opts.outPath]]) {
    if (!value) continue;
    const violation = checkStorageBoundary(value);
    if (violation !== null) failInput(`${flag}이(가) 저장 경계 밖입니다 — ${violation}`);
  }

  const target = opts.inPath ?? path.join(opts.root, EVIDENCE_FILE_NAME);

  let text;
  try {
    text = fs.readFileSync(target, "utf8");
  } catch (e) {
    failInput(`원장을 읽을 수 없습니다: ${target} (${e.code ?? e.message})`);
  }

  let evidence;
  try {
    evidence = JSON.parse(text);
  } catch (e) {
    failInput(`JSON 파싱 실패: ${target} — ${e.message}`);
  }

  const { projected, totalCommits, excludedCommits } = projectWithReport(evidence);
  const serialized = JSON.stringify(projected, null, 2) + "\n";

  if (opts.outPath) {
    // **쓰기 실패를 종료 코드 계약 안으로 들여놓는다(콜드 리뷰 Correctness).**
    // 이 파일의 다른 모든 I/O는 failInput()을 거쳐 [INPUT_ERROR] + exit 2로
    // 일관되게 실패하는데 이 한 줄만 감싸이지 않아, 상위 디렉터리가 없으면
    // 원시 Node 스택과 함께 **exit 1**로 죽었다 — 헤더가 문서화한 0/2 두 갈래에
    // 없는 값이고, 하필 write-artifact.mjs에서 exit 1은 「출력을 고쳐 다시
    // 부른다」로 이미 점유돼 있어 같은 오케스트레이션이 두 스크립트를 부를 때
    // 코드 1의 의미가 갈린다.
    //
    // **디렉터리를 대신 만들어 주지 않는다.** writeJsonAtomic은 저장 루트를
    // mkdir하지만 여기서 같은 일을 하면 오타 난 --out이 조용히 새 디렉터리를
    // 만들어 성공한 것처럼 보인다. 경계 검사가 통과시킨 경로라도 「없는 곳에
    // 쓰라」는 지시는 사용자 실수일 가능성이 높으므로 시끄럽게 멈춘다.
    try {
      fs.writeFileSync(opts.outPath, serialized, "utf8");
    } catch (e) {
      failInput(`--out 경로에 쓸 수 없습니다: ${opts.outPath} (${e.code ?? e.message})`);
    }
    console.error(`[project-ledger] 기록: ${opts.outPath}`);
  } else {
    process.stdout.write(serialized);
  }
  console.error(
    `[project-ledger] 커밋 ${totalCommits}건 중 제외 ${excludedCommits}건을 투영에서 뺐습니다 ` +
    "(§6 제외 커밋 프라이버시 경계 — 보조 방어이며, 실제 방어는 수집 시점 축소입니다)."
  );
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
