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
// **범위(사용자 확정): career 계층만.** 다만 본체(renderArtifactMarkdown)는
// 계층 중립이다 — knowledge-map·gap-report는 구현 8단계에서 진입점만 늘리면
// 되고 배지·커버리지·절단 로직을 다시 쓰지 않는다. 지금 세 계층을 다 렌더하지
// 않는 이유는 그 두 계층의 인스턴스가 아직 픽스처 밖에 존재하지 않아, 검사가
// "내가 만든 픽스처를 내가 렌더했다"는 자기충족이 되기 때문이다.
//
// **이 렌더러는 게이트가 아니다.** 산출물을 만드는 쪽이며, 출력이 계약을
// 만족하는지는 tests/run-smoke.mjs의 렌더 계약 오라클이 본다.
//
// 사용법(CLI):
//   node scripts/render-markdown.mjs --layer career --in <career.json> [--out <career.md>]
//     --out 생략 시 stdout으로 출력한다.
//
// 종료 코드: 0 = 렌더 성공 / 2 = 입력 오류(파일 부재·JSON 파싱 실패·미지원
// 계층). verify-evidence.mjs의 "입력 오류는 결론을 낼 수 없음 계열"(콜드 리뷰
// A-32) 규약을 그대로 따른다.

import fs from "node:fs";
import { pathToFileURL } from "node:url";

import {
  badgeForNode,
  basisLabel,
  formatCoverage,
  formatTruncation,
} from "./lib/render-contract.mjs";

/** 지금 진입점이 있는 계층. 본체는 계층 중립이므로 늘리는 비용은 이 표 한 줄이다. */
const LAYER_TITLES = Object.freeze({
  career: "경력 기술서",
});

/**
 * 노드 하나를 렌더한다.
 *
 * 배지는 `badgeForNode`가 돌려준 것만 붙인다 — 이 함수 안에 basis를 보고
 * 배지를 만드는 분기를 넣으면 AC-13 (ii)를 어긴다.
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

  const meta = [`근거 등급: ${basisLabel(node?.basis)}`];
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
