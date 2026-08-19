// scripts/lib/artifact-contract.mjs
//
// 구현 7단계 (a)(b)(g)의 **결정적 계약**. 순수 함수만 두고 디스크에 닿지
// 않는다 — 쓰기·읽기·레지스트리 갱신은 scripts/write-artifact.mjs가 한다.
//
// **왜 프롬프트보다 먼저 이 파일인가.** 게이트 E-1이 렌더 계약에 적용한 것과
// 같은 순서다. 스킬 프롬프트(SKILL.md·템플릿)가 먼저 서면 (a)(b)(g)와 AC-16이
// 전부 "프롬프트 안의 산문 지시"로 내려앉는다 — 심사 M-1이 지적한 「문서는
// 약속하는데 집행 코드가 없다」와 같은 형태이며, 그 상태에서는 템플릿이
// 지시를 어겨도 어떤 게이트도 빨개지지 않는다. 계약이 먼저 서면 프롬프트는
// **이미 집행되는 계약** 위에 쓰이고, 위반은 exit 코드로 나온다.
//
// 이 파일이 소유하는 것:
//   - 산출물 contentHash 정본 계산(계층 중립) — AC-16의 파일 내 필드
//   - `verification`·`origin` **기입 주체** 집행 — 구현 7단계 (g)
//   - 재생성 병합(노드 id 재사용 · `locked` 보존 · 재시도 상한 이어받기)
//     — 구현 7단계 (b) / AC-16 / AC-13 (iii)
//
// 이 파일이 소유하지 **않는** 것: 스키마 검증(scripts/lib/schema-validate.mjs),
// 원자적 쓰기(scripts/lib/store.mjs), 렌더(scripts/lib/render-contract.mjs).
// 여기서 그것들을 재구현하면 정본이 둘로 갈린다.

import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// 계층 표
// ---------------------------------------------------------------------------

/**
 * L1+ 산출물 계층의 파일명·state.json 레지스트리 키·본문 필드.
 *
 * **왜 verify-evidence.mjs의 `KNOWN_LAYERS`를 import하지 않는가.** 그쪽은
 * 라이브러리가 아니라 CLI 스크립트이고 git.mjs 전체를 끌고 온다 — 순수 계약
 * 모듈이 CLI에 의존하면 의존 방향이 뒤집힌다. 대신 **드리프트를 관측한다**:
 * 이 표의 키 집합이 `KNOWN_LAYERS`와, `stateKey` 집합이
 * `schemas/state.schema.json`의 `artifacts` 프로퍼티와 어긋나면
 * tests/run-smoke.mjs의 단언이 FAIL한다. 닻이 이 모듈 **밖**에 있어야
 * 드리프트를 잡는다 — 같은 상수를 import하는 단언은 드리프트와 함께
 * 움직인다(렌더 계약 RM6에서 실측된 형태다).
 */
export const ARTIFACT_LAYERS = Object.freeze({
  "career": Object.freeze({ fileName: "career.json", stateKey: "career", bodyField: "nodes" }),
  "knowledge-map": Object.freeze({ fileName: "knowledge-map.json", stateKey: "knowledgeMap", bodyField: "nodes" }),
  "gap-report": Object.freeze({ fileName: "gap-report.json", stateKey: "gapReport", bodyField: "nodes" }),
  "plan": Object.freeze({ fileName: "plan.json", stateKey: "plan", bodyField: "nodes" }),
});

/**
 * 원장(L0)의 본문 필드. 산출물 계층과 파일명·레지스트리 키 규약이 다르므로
 * `ARTIFACT_LAYERS`에 섞지 않는다 — 원장은 수집기가 쓰고 이 모듈의 병합·
 * 기입 주체 규칙 대상이 아니다. 여기 두는 이유는 오직 하나, contentHash
 * 계산 규칙이 L0와 L1+에서 **같아야** 하기 때문이다(아래 참조).
 */
const EVIDENCE_BODY_FIELD = "commits";

/**
 * `verification` 축을 갖는 계층. 구현 7단계 (g)가 이름을 댄 세 템플릿
 * (CareerWriter · KnowledgeMapper · GapAnalyzer)의 산출 계층과 정확히 같다.
 *
 * `plan`은 여기 없다 — plan 노드는 `verificationStatus`(생성된 문제의 신뢰
 * 등급)를 갖고 이것은 `verification`(사실 주장의 반증 결과)과 **다른 축**이다.
 * 스키마 description이 "두 필드를 통합하지 마라"고 못 박고 있으므로 여기서
 * 통합하지 않는다.
 */
export const VERIFICATION_LAYERS = Object.freeze(["career", "knowledge-map", "gap-report"]);

// ---------------------------------------------------------------------------
// contentHash — AC-16
// ---------------------------------------------------------------------------

/**
 * 해시 대상 필드(고정 순서). 본문 필드 이름만 계층마다 다르고 나머지 규칙은
 * 동일하다 — `generatedAt`과 `contentHash` 자신을 제외한 본문 전부를 이름
 * 순서로 고정 조립해 SHA-256.
 *
 * **이 규칙의 닻은 이 모듈 밖에 있다.** `scripts/lib/content-hash.mjs`의
 * `computeEvidenceContentHash`가 L0에 대해 같은 규칙을 이미 구현하고 있고,
 * tests/run-smoke.mjs가 **같은 evidence 객체에 대해 두 함수가 바이트 동일한
 * 해시를 내는지**를 단언한다. 즉 이 함수의 해시 알고리즘·직렬화·제외 규칙을
 * 바꾸면 저쪽과 어긋나 FAIL한다. 그 단언이 없으면 여기서 알고리즘을 바꿔도
 * "내 산출물을 내가 해시해 내가 대조"하는 자기충족이라 아무도 모른다.
 */
function contentHashFields(bodyField) {
  return ["schemaVersion", "sourceRepoHead", "coverage", "truncated", bodyField];
}

/**
 * 산출물 본문의 contentHash를 계산한다(디스크에 쓰지 않는다).
 *
 * @param {string} layer `ARTIFACT_LAYERS`의 키 또는 `"evidence"`
 * @param {object} instance
 * @returns {string} 64자 SHA-256 hex
 */
export function computeArtifactContentHash(layer, instance) {
  const bodyField = layer === "evidence" ? EVIDENCE_BODY_FIELD : ARTIFACT_LAYERS[layer]?.bodyField;
  if (!bodyField) {
    throw new Error(
      `지원하지 않는 계층입니다: '${layer}' (지원: ${Object.keys(ARTIFACT_LAYERS).join(", ")}, evidence)`
    );
  }
  const canonical = {};
  for (const key of contentHashFields(bodyField)) {
    canonical[key] = instance?.[key];
  }
  return crypto.createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// 기입 주체 집행 — 구현 7단계 (g)
// ---------------------------------------------------------------------------

/**
 * 산출물이 어느 단계에서 나온 것인지. 이 값이 `verification` 허용 범위를
 * 가른다.
 *
 *   draft        — CareerWriter/KnowledgeMapper/GapAnalyzer 템플릿의 출력.
 *                  `verification`을 기입할 권한이 없다.
 *   fact-checked — FactChecker 디스패치를 **수행한 뒤** 스킬 오케스트레이션이
 *                  판정을 실은 출력. `verification`을 기입할 권한이 있다.
 */
export const AUTHORSHIP_STAGES = Object.freeze(["draft", "fact-checked"]);

/**
 * 기입 주체 규약 위반을 찾는다(구현 7단계 (g)).
 *
 * **왜 코드가 필요한가.** 이 규약은 지금까지 스키마 `description`과 AC 산문
 * 으로만 존재했다 — `origin`도 마찬가지다. 산문뿐인 규약은 템플릿이 어겨도
 * 어떤 게이트도 빨개지지 않는다. 템플릿이 스스로 `{status:"verified"}`를
 * 적을 수 있으면 2단 팩트체크가 **자기 선언으로 우회**되고, 그것은
 * `origin:"user"`가 AC-19 언어 린트를 자기면제하는 것과 같은 구조의 구멍이다.
 *
 * **집행 지점을 쓰기 경계에 둔 이유.** 산출물이 디스크에 닿는 경로는
 * write-artifact.mjs 하나뿐이므로, 거기서 거부하면 규약이 프로덕션 경로에서
 * 옵션이 아니게 된다. 프롬프트에 같은 문장을 적는 것은 **보조 방어**이지
 * 집행이 아니다.
 *
 * @param {string} layer
 * @param {object} instance 아직 병합 전인 원본 출력
 * @param {{stage: string}} opts
 * @returns {{code: string, message: string}[]}
 */
export function checkAuthorshipContract(layer, instance, { stage } = {}) {
  if (!AUTHORSHIP_STAGES.includes(stage)) {
    throw new Error(`알 수 없는 단계입니다: '${stage}' (지원: ${AUTHORSHIP_STAGES.join(", ")})`);
  }
  const violations = [];
  const nodes = Array.isArray(instance?.nodes) ? instance.nodes : [];
  const hasVerificationAxis = VERIFICATION_LAYERS.includes(layer);

  for (const node of nodes) {
    const id = node?.id ?? "(id 없음)";

    // `origin`은 **두 단계 모두** "generated"여야 한다. 생성 주체가 무엇을
    // 만들든 그것은 LLM 생성분이고, `user`로 바꾸는 것은 병합만 할 수 있다
    // (아래 mergeArtifact). 단계로 완화하지 않는 이유는, `origin:"user"`가
    // 언어 린트 제외 통로이기 때문에 어느 단계에서 새든 같은 구멍이 되기
    // 때문이다.
    if (node?.origin !== "generated") {
      violations.push({
        code: "ORIGIN_SET_BY_TEMPLATE",
        message:
          `노드 '${id}'의 origin이 '${node?.origin}'입니다 — 생성 출력의 origin은 항상 'generated'여야 하고 ` +
          "'user'는 병합·편집 감지 로직만 설정합니다(AC-19 언어 린트의 origin:user 제외가 자기면제 통로가 됩니다).",
      });
    }

    if (!hasVerificationAxis) continue;

    if (node?.verification === undefined || node?.verification === null) {
      // 부재를 통과시키지 않는다 — 스키마도 required로 잡지만, 이 검사가
      // 스키마 검증보다 **앞**에서 돌기 때문에 여기서 조용히 넘기면
      // "verification이 없으면 (g)를 어길 수 없다"는 fail-open이 된다.
      violations.push({
        code: "VERIFICATION_MISSING",
        message: `노드 '${id}'에 verification 필드가 없습니다 — 부재를 '판정 대상이 아님'으로 읽지 않습니다.`,
      });
      continue;
    }

    if (stage === "draft" && node.verification.status !== "not-attempted") {
      violations.push({
        code: "VERIFICATION_SET_BY_TEMPLATE",
        message:
          `노드 '${id}'의 verification.status가 '${node.verification.status}'입니다 — draft 단계(생성 템플릿 출력)는 ` +
          "'not-attempted'만 기입할 수 있습니다. 판정은 FactChecker 디스패치를 수행한 스킬 오케스트레이션만 실을 수 있습니다(구현 7단계 (g)).",
      });
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// 재생성 병합 — 구현 7단계 (b) / AC-16 / AC-13 (iii)
// ---------------------------------------------------------------------------

/**
 * 이전 산출물과 이번 출력을 병합한다(순수 — 디스크에 닿지 않는다).
 *
 * 규칙 네 가지. 각각 **양방향으로** 관측된다(금지 방향만 보면 "전부 보존"
 * 하는 병합이나 "전부 덮어쓰는" 병합이 통과한다).
 *
 *  1. **`locked` 보존(AC-16).** prev의 `locked:true` 노드는 draft가 같은 id로
 *     덮어써도 prev 내용이 이기고, draft에 아예 없어도 살아남는다.
 *     `locked:false` 노드는 draft에 없으면 사라진다 — 그것이 재생성이다.
 *  2. **노드 id 재사용(구현 7단계 (b)).** draft가 prev에 이미 있는 **동일
 *     text**를 새 id로 들고 오면 `NODE_ID_CHURN` 위반이다. id를 만드는 주체가
 *     LLM이므로 이 성질은 저절로 성립하지 않고, 깨지면 `locked`로 잠근 사용자
 *     편집분이 고아가 된다(리스크 절이 '가장 확실하게 이탈시키는 데이터 유실
 *     사고'로 분류한 경로).
 *  3. **재시도 상한 이어받기(AC-13 (iii)).** draft의 `verification.attempts`가
 *     prev보다 **작으면** `VERIFICATION_ATTEMPTS_RESET` 위반이다. 조용히
 *     `max()`로 고치지 않는다 — 고치면 §3의 상한 2회가 실행마다 초기화되는
 *     버그가 산출물에는 안 보이고 계속 재발한다. 시끄럽게 거부하는 쪽이
 *     이 레포의 관례다.
 *  4. **`origin`은 병합만 설정한다.** prev에 있던 노드는 prev의 `origin`을
 *     이어받고(사용자 수동 추가분 보존), 신규 노드는 `generated`다. 템플릿이
 *     기입하려 한 값은 `checkAuthorshipContract`가 별도로 고발하며, 여기서
 *     덮어쓰는 것은 그 고발을 대신하지 않는다 — 덮어쓰기만 있으면 템플릿의
 *     시도가 조용히 정상화되어 아무도 배우지 못한다.
 *
 * 노드 순서: draft 순서를 그대로 두고, draft에 없던 `locked` 생존자를 prev
 * 순서로 뒤에 붙인다. 순서를 섞으면 재실행 diff가 무의미해진다.
 *
 * @param {string} layer
 * @param {object|null} prev 이전 산출물(없으면 null)
 * @param {object} draft 이번 출력
 * @returns {{merged: object, violations: {code: string, message: string}[]}}
 */
export function mergeArtifact(layer, prev, draft) {
  const violations = [];
  const draftNodes = Array.isArray(draft?.nodes) ? draft.nodes : [];
  const prevNodes = Array.isArray(prev?.nodes) ? prev.nodes : [];
  const hasVerificationAxis = VERIFICATION_LAYERS.includes(layer);

  const prevById = new Map();
  for (const node of prevNodes) {
    if (typeof node?.id === "string") prevById.set(node.id, node);
  }

  // text → prev 노드 id. 같은 text가 prev에 2건 이상이면 대응이 모호하므로
  // 그 text는 churn 판정 대상에서 뺀다(모호한 근거로 위반을 만들지 않는다).
  const prevIdByText = new Map();
  const ambiguousTexts = new Set();
  for (const node of prevNodes) {
    const text = typeof node?.text === "string" ? node.text : null;
    if (text === null || text === "") continue;
    if (prevIdByText.has(text)) ambiguousTexts.add(text);
    else prevIdByText.set(text, node.id);
  }

  const mergedNodes = [];
  const consumedPrevIds = new Set();
  const seenDraftIds = new Set();

  for (const node of draftNodes) {
    const id = node?.id;
    if (typeof id === "string") {
      if (seenDraftIds.has(id)) {
        violations.push({
          code: "NODE_ID_DUPLICATE",
          message: `출력 안에 id '${id}'가 2건 이상입니다 — id는 산출물 안에서 유일해야 병합 키로 쓸 수 있습니다.`,
        });
      }
      seenDraftIds.add(id);
    }

    const prevNode = typeof id === "string" ? prevById.get(id) : undefined;

    if (prevNode !== undefined) {
      consumedPrevIds.add(id);

      if (prevNode.locked === true) {
        // 규칙 1 — 잠긴 노드는 draft가 같은 id로 덮어써도 prev가 이긴다.
        mergedNodes.push(prevNode);
        continue;
      }

      if (hasVerificationAxis) {
        const prevAttempts = prevNode?.verification?.attempts;
        const draftAttempts = node?.verification?.attempts;
        if (
          typeof prevAttempts === "number" &&
          typeof draftAttempts === "number" &&
          draftAttempts < prevAttempts
        ) {
          // 규칙 3 — 조용히 고치지 않는다.
          violations.push({
            code: "VERIFICATION_ATTEMPTS_RESET",
            message:
              `노드 '${id}'의 verification.attempts가 ${prevAttempts} → ${draftAttempts}로 줄었습니다 — ` +
              "재시도 횟수는 실행 간에 이어받아야 하며 초기화하면 §3의 재생성 상한 2회가 사실상 무한이 됩니다(AC-13 (iii)).",
          });
        }
      }

      // 규칙 4 — origin은 prev를 이어받는다.
      mergedNodes.push({ ...node, origin: prevNode.origin });
      continue;
    }

    // 신규 id.
    const text = typeof node?.text === "string" ? node.text : null;
    if (text !== null && text !== "" && !ambiguousTexts.has(text) && prevIdByText.has(text)) {
      // 규칙 2 — 같은 사실이 새 id를 달고 왔다.
      violations.push({
        code: "NODE_ID_CHURN",
        message:
          `노드 '${id ?? "(id 없음)"}'의 text가 이전 산출물의 노드 '${prevIdByText.get(text)}'와 동일한데 새 id를 ` +
          "받았습니다 — 동일 사실 항목에는 기존 id를 재사용해야 locked 편집분이 고아가 되지 않습니다(구현 7단계 (b) / AC-16).",
      });
    }
    mergedNodes.push({ ...node, origin: "generated" });
  }

  // draft에 없던 prev 노드 — 잠긴 것만 살린다(규칙 1의 허용 방향).
  for (const node of prevNodes) {
    if (typeof node?.id !== "string" || consumedPrevIds.has(node.id)) continue;
    if (node.locked === true) mergedNodes.push(node);
  }

  return { merged: { ...draft, nodes: mergedNodes }, violations };
}
