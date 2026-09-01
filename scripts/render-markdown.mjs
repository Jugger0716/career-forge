#!/usr/bin/env node
// scripts/render-markdown.mjs
//
// 구현 7단계 — 정본 JSON 산출물을 사용자 대면 마크다운으로 렌더한다.
//
// **이 파일의 유일한 규칙: 마크다운은 JSON의 뷰다.** 렌더러는 자기 판단으로
// 값을 만들지 않는다. 강등 배지는 `verification`에서만 파생하고(AC-13 (ii)),
// 커버리지·절단 고지는 JSON의 필드를 그대로 옮긴다. 값이 없으면 지어내지
// 않고 `미기재`를 쓴다 — 없는 것을 0으로 채우면 "분석 0건"과 "기재 안 됨"이
// 같은 화면이 된다.
//
// 그 계약의 정본 리터럴·파생 규칙은 이 파일이 아니라
// scripts/lib/render-contract.mjs에 있다. 렌더러와 검사가 **둘 다** 그 모듈을
// import해야 검사가 자기충족이 되지 않는다(렌더러가 자기 리터럴을 자기가
// 확인하는 구조를 피한다).
//
// **범위: career · knowledge-map · gap-report 세 계층(2026-08-26, 순서 13번 (b)).**
// `plan`은 슬라이스 C 소관이라 **의도적으로 등록하지 않는다** — 조용한 누락이
// 아니고, 오라클이 그 미등록을 단언으로 고정한다.
//
// **초판의 「진입점만 늘리면 된다」는 틀렸다 — 고치면서 실측했다.** 본체
// (renderArtifactMarkdown)가 계층 중립인 것은 맞지만, `renderNode`가 두 새 계층에만
// 있는 필드(`topic`·`parentRefs`·`selfAssessment`)를 **하나도 렌더하지 않았다.**
// 표 두 줄만 늘렸다면 **자가진단이 사용자 눈에 닿지 않는 갭 리포트**와 상위 참조가
// 보이지 않는 지식맵이 나왔을 것이다 — AC-14의 계층 참조 무결성이 표면에서 사라지고,
// SKILL.md가 배지에 대해 적어 둔 「그 표면에서 빠지면 사용자에게는 없었던 일이 된다」가
// 그대로 재발한다. 그래서 세 필드를 **존재 시 렌더**로 더했다. `externalUrl`이 이미
// 쓰던 관례를 그대로 따르며, **계층별 분기는 넣지 않았다** — 넣는 순간 「계층 중립」이
// 거짓이 되고 오라클의 바이트 동일 단언이 FAIL한다.
//
// **자기충족 위험은 사라지지 않았다 — 우회했을 뿐이다.** 두 계층의 인스턴스는 아직
// 픽스처 밖에 없으므로 「내가 만든 픽스처를 내가 렌더했다」는 문제는 그대로다. 그래서
// 오라클은 **내용의 정확성**을 묻지 않는다: (i) 계약 요소 목록의 정본은
// render-contract.mjs이고, (ii) 「같은 인스턴스를 세 계층으로 렌더하면 제목 줄을 뺀
// 본문이 바이트 동일」은 픽스처 내용과 무관하게 성립해야 하는 **구조** 성질이다.
// 내용이 실제로 옳은지는 픽스처가 아니라 도그푸딩(AC-20)만 답할 수 있다.
//
// **이 렌더러는 게이트가 아니다.** 산출물을 만드는 쪽이며, 출력이 계약을
// 만족하는지는 tests/run-smoke.mjs의 렌더 계약 오라클이 본다.
//
// 사용법(CLI):
//   node scripts/render-markdown.mjs --layer career --in <career.json> [--out <career.md>]
//     --layer: career | knowledge-map | gap-report (미지원 계층은 exit 2)
//     --out 생략 시 stdout으로 출력한다.
//
// 종료 코드: 0 = 렌더 성공 / 2 = 입력 오류(파일 부재·JSON 파싱 실패·미지원
// 계층). verify-evidence.mjs의 "입력 오류는 결론을 낼 수 없음 계열"(콜드 리뷰
// A-32) 규약을 그대로 따른다.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { validateInstance } from "./lib/schema-validate.mjs";
import { computeArtifactContentHash } from "./lib/artifact-contract.mjs";

import {
  badgeForNode,
  basisLabel,
  formatCoverage,
  formatTruncation,
} from "./lib/render-contract.mjs";

/**
 * 진입점이 있는 계층. 본체는 계층 중립이므로 **이 표가 늘어나는 것 자체는** 한 줄이다 —
 * 다만 새 계층에만 있는 필드는 `renderNode`가 함께 알아야 한다(파일 헤더 참조).
 *
 * `plan`이 없는 것은 누락이 아니라 슬라이스 C 이연이다. 오라클이 그 사실을 단언으로
 * 고정하므로, 여기에 한 줄을 더하면 그 단언이 FAIL하며 「의도한 추가인가」를 되묻는다.
 */
const LAYER_TITLES = Object.freeze({
  "career": "경력 기술서",
  "knowledge-map": "지식맵",
  "gap-report": "갭 리포트",
});

/**
 * 노드 하나를 렌더한다.
 *
 * 배지는 `badgeForNode`가 돌려준 것만 붙인다 — 이 함수 안에 basis를 보고
 * 배지를 만드는 분기를 넣으면 AC-13 (ii)를 어긴다.
 *
 * **계층을 인자로 받지 않는다 — 의도다.** 계층에 따라 다른 필드를 내야 하는
 * 경우에도 「계층이 무엇인가」가 아니라 「그 필드가 있는가」로 분기한다
 * (`externalUrl`이 처음부터 그렇게 돼 있었고, `topic`·`parentRefs`·
 * `selfAssessment`도 같다). 계층 인자를 받는 순간 세 계층의 출력이 갈릴 수
 * 있고, 오라클의 「제목 줄을 뺀 본문이 바이트 동일」 단언이 그것을 FAIL시킨다.
 */
function renderNode(node) {
  const lines = [];
  const badge = badgeForNode(node);
  const heading = badge ? `### ${node?.id ?? "(id 없음)"} \`${badge}\`` : `### ${node?.id ?? "(id 없음)"}`;
  lines.push(heading);
  lines.push("");

  // 본문. career 노드는 `text`가 required다. 없으면 감추지 않고 그 사실을 적는다.
  lines.push(typeof node?.text === "string" && node.text !== "" ? node.text : "_(본문 미기재)_");
  lines.push("");

  const meta = [];
  // `topic`은 knowledge-map·gap-report에만 있다. **계층으로 분기하지 않고 존재로 분기한다** —
  // 계층을 보는 순간 이 함수가 계층 중립이 아니게 되고, 오라클의 바이트 동일 단언이 FAIL한다.
  if (typeof node?.topic === "string" && node.topic !== "") meta.push(`주제: ${node.topic}`);
  meta.push(`근거 등급: ${basisLabel(node?.basis)}`);
  const status = node?.verification?.status;
  const attempts = node?.verification?.attempts;
  meta.push(
    `검증: ${typeof status === "string" ? status : "미기재"}` +
    (typeof attempts === "number" ? ` (시도 ${attempts}회)` : "")
  );
  if (typeof node?.externalUrl === "string" && node.externalUrl !== "") {
    meta.push(`외부 출처: ${node.externalUrl}`);
  }
  lines.push(`- ${meta.join(" · ")}`);

  const evidence = Array.isArray(node?.evidence) ? node.evidence : [];
  if (evidence.length > 0) {
    const ids = evidence
      .map((e) => (e?.path ? `${e?.ledgerId} (${e.path})` : String(e?.ledgerId)))
      .join(", ");
    lines.push(`- 근거 커밋: ${ids}`);
  } else {
    // 인용 0건인 노드를 조용히 넘기지 않는다 — 그것이 심사 C-3이 지목한
    // "빈손이 가장 조용한" 형태다. 검증기는 이제 그 산출물을 INCONCLUSIVE로
    // 보고하고(게이트 C-5), 사용자 표면에서도 같은 사실이 보여야 한다.
    lines.push("- 근거 커밋: 없음");
  }

  // 상위 계층 참조. **이것이 빠지면 AC-14가 검사하는 계층 참조 무결성이 사용자
  // 표면에서 통째로 사라진다** — 검증은 돌았는데 무엇을 근거로 삼았는지가 보이지
  // 않는 상태이고, SKILL.md가 배지에 대해 적어 둔 실패와 같은 형태다.
  const parentRefs = Array.isArray(node?.parentRefs) ? node.parentRefs : [];
  if (parentRefs.length > 0) lines.push(`- 상위 참조: ${parentRefs.join(", ")}`);

  // 자가진단 원문. 갭 리포트에서 이 값이 표면에 없으면 「무엇과 대조한 갭인가」가
  // 사라져 리포트가 근거 없는 지적 목록이 된다.
  if (typeof node?.selfAssessment === "string" && node.selfAssessment !== "") {
    lines.push(`- 자가진단: ${node.selfAssessment}`);
  }

  lines.push("");
  return lines;
}

/**
 * 계층 중립 본체. 인스턴스를 마크다운 문자열로 바꾼다(디스크에 쓰지 않는다).
 *
 * @param {object} instance 산출물 JSON
 * @param {{title: string}} opts
 * @returns {string}
 */
export function renderArtifactMarkdown(instance, { title }) {
  const lines = [];
  lines.push(`# ${title}`);
  lines.push("");

  // 머리말 — 커버리지 3수치와 절단 고지는 **항상** 렌더한다(구현 7단계
  // 렌더 계약). 절단이 없을 때에도 "절단 없음"을 적는 이유는, 침묵이
  // "절단 없음"과 "고지를 빠뜨림"을 구별해 주지 않기 때문이다.
  lines.push(`- 생성 시각: ${instance?.generatedAt ?? "미기재"}`);
  lines.push(`- 원본 HEAD: ${instance?.sourceRepoHead ?? "미기재"}`);
  lines.push(`- ${formatCoverage(instance?.coverage)}`);
  lines.push(`- ${formatTruncation(instance?.truncated)}`);
  lines.push("");

  const nodes = Array.isArray(instance?.nodes) ? instance.nodes : [];
  if (nodes.length === 0) {
    // 스키마의 minItems:1이 이미 막지만, 렌더러가 손 편집 파일도 받으므로
    // 빈손을 빈 화면으로 내보내지 않는다.
    lines.push("_(항목이 하나도 없습니다 — 이 산출물은 빈손입니다.)_");
    lines.push("");
  }
  for (const node of nodes) {
    lines.push(...renderNode(node));
  }

  return lines.join("\n");
}

/**
 * 계층 이름으로 렌더한다. 미지원 계층은 조용히 넘기지 않고 던진다 —
 * 조용한 스킵은 콜드 리뷰 A-34가 지목한 형태다.
 *
 * @param {string} layer
 * @param {object} instance
 * @returns {string}
 */
export function renderLayer(layer, instance) {
  const title = LAYER_TITLES[layer];
  if (!title) {
    throw new Error(
      `지원하지 않는 계층입니다: '${layer}' (현재 지원: ${Object.keys(LAYER_TITLES).join(", ")})`
    );
  }
  return renderArtifactMarkdown(instance, { title });
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function readJsonOrExit(p) {
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

/**
 * 계층 스키마를 읽는다. **비객체를 거부한다** — 내용이 `null`·배열·스칼라인 스키마를
 * `validateInstance`에 그대로 넘기면 오류 0건이 돌아오고, 그러면 이 게이트가 통째로
 * 건너뛰어진다. `read-registry.mjs`의 `loadStateSchema`와 같은 형태이며 그 비대칭의
 * 정본 관측점은 `(SR-9)`다.
 *
 * @returns {{schema: object|null, error: string|null}}
 */
function loadLayerSchema(layer) {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const rel = path.join(here, "..", "schemas", `${layer}.schema.json`);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(rel, "utf8"));
  } catch (e) {
    return { schema: null, error: `계층 스키마를 읽지 못했습니다(${layer}): ${e.code ?? e.message}` };
  }
  const shape = parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed;
  if (shape !== "object") {
    return { schema: null, error: `계층 스키마가 객체가 아닙니다(${layer}, 실제: ${shape})` };
  }
  return { schema: parsed, error: null };
}

/**
 * 렌더 직전 입력 게이트. **위반 사유 목록을 돌려주고, 빈 배열이면 적합하다.**
 *
 * 두 축을 본다:
 *
 * 1. **계층 스키마 적합성** — required·additionalProperties·enum·조건절 전부. 이것이
 *    없으면 `coverage`·`truncated`가 통째로 빠진 입력도 렌더된다(실측했다).
 * 2. **`contentHash` 재계산 일치** — 본문이 기록 이후 손으로 고쳐졌는지 본다. 키 없는
 *    SHA-256이라 의도적 위조를 막지는 못하지만, **위조하려면 정상 알고리즘을 돌려야 하므로
 *    「임시로 조립한 JSON을 그대로 렌더」라는 가장 싼 경로는 닫힌다.** 그 한계는
 *    `tests/contamination/README.md` §9가 이미 적어 뒀다.
 *
 * **판독 실패를 「검사 생략」으로 강등하지 않는다(절대 규칙 6).** 스키마를 못 읽으면
 * 그것이 곧 위반이다 — 못 읽었다는 이유로 통과시키면 이 게이트를 없애는 가장 쉬운 방법이
 * 스키마 파일을 지우는 것이 된다.
 *
 * @param {string} layer
 * @param {unknown} instance
 * @returns {string[]}
 */
export function checkRenderInput(layer, instance) {
  const { schema, error } = loadLayerSchema(layer);
  if (error !== null) return [error];

  const problems = validateInstance(schema, instance, schema, "$", []);
  if (problems.length > 0) return problems;

  // 스키마를 통과한 뒤에만 해시를 본다 — 형태가 깨진 입력에서 해시 계산은 의미가 없고,
  // `computeArtifactContentHash`가 비객체에 던지므로 순서를 뒤집으면 예외가 샌다.
  let recomputed;
  try {
    recomputed = computeArtifactContentHash(layer, instance);
  } catch (e) {
    return [`contentHash를 재계산하지 못했습니다: ${e.message}`];
  }
  if (instance?.contentHash !== recomputed) {
    return [
      `$.contentHash가 본문 재계산값과 다릅니다(기록: ${String(instance?.contentHash).slice(0, 16)}…, ` +
      `재계산: ${recomputed.slice(0, 16)}…) — 기록 이후 본문이 손으로 수정됐거나 ` +
      `write-artifact.mjs를 거치지 않았습니다.`,
    ];
  }
  return [];
}

function main() {
  const argv = process.argv.slice(2);
  const opts = { layer: null, inPath: null, outPath: null };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--layer":
        opts.layer = argv[++i];
        break;
      case "--in":
        opts.inPath = argv[++i];
        break;
      case "--out":
        opts.outPath = argv[++i];
        break;
      default:
        console.error(`[경고] 알 수 없는 인자 무시: ${argv[i]}`);
    }
  }

  if (!opts.layer || !opts.inPath) {
    console.error("사용법: node scripts/render-markdown.mjs --layer career --in <career.json> [--out <career.md>]");
    process.exit(2);
  }

  const instance = readJsonOrExit(opts.inPath);

  // **입력 게이트(콜드 리뷰 라운드 2 처방 1).** 이 검사가 붙기 전 이 CLI는 아무 JSON이나
  // 받아 exit 0으로 렌더했다 — 레포에 없는 해시를 인용하고 `verification.status`를
  // `"verified"`로 자칭하고 `contentHash`가 위조되고 required `coverage`·`truncated`가
  // 통째로 빠진 입력이 그대로 문서가 됐다. **그리고 위조본이 정직한 산출물보다 깨끗해
  // 보였다** — 배지가 `verification.status`에서만 파생하므로 자칭 verified가 강등 배지를
  // 껐다. 사용자가 읽는 유일한 표면이고, 어떤 스크립트도 그 `.md`를 다시 읽지 않는다.
  //
  // **우회 플래그를 두지 않는다.** 정상 경로는 `write-artifact.mjs`가 쓴 파일을 렌더하므로
  // 이 게이트에 걸릴 수 없다 — 걸렸다면 그것은 쓰기 경계를 우회했다는 뜻이다.
  const problems = checkRenderInput(opts.layer, instance);
  if (problems.length > 0) {
    for (const p of problems) console.error(`[SCHEMA] ${p}`);
    console.error(
      "[render-markdown] 부적합한 산출물은 렌더하지 않습니다. 마크다운은 JSON의 뷰이고, " +
      "검증을 통과하지 않은 JSON을 렌더하면 사용자가 읽는 유일한 표면이 근거 없는 주장을 " +
      "「검증 완료」로 제시하게 됩니다. 산출물은 scripts/write-artifact.mjs로 기록하십시오."
    );
    process.exit(1);
  }

  let md;
  try {
    md = renderLayer(opts.layer, instance);
  } catch (e) {
    console.error(`[INPUT_ERROR] ${e.message}`);
    process.exit(2);
  }

  if (opts.outPath) {
    fs.writeFileSync(opts.outPath, md.endsWith("\n") ? md : md + "\n", "utf8");
    console.log(`[render-markdown] 기록: ${opts.outPath}`);
  } else {
    process.stdout.write(md.endsWith("\n") ? md : md + "\n");
  }
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
