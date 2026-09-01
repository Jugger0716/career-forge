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
//   - `verification`·`origin`·`locked` **기입 주체** 집행 — 구현 7단계 (g),
//     `locked`는 게이트 B-7
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
 * 각 계층의 **상위 계층**. `parentRefs`가 가리켜야 할 곳이다(라운드 2 처방 7).
 *
 * **`ARTIFACT_LAYERS`에 키를 섞지 않고 별도 맵으로 둔다.** `career`는 여기 항목이
 * **없고**, 그것은 관대함이 아니라 계층 위상이다 — 최상위라 상위가 존재하지 않는다.
 * 별도 맵이면 `verify-evidence.mjs`의 `LAYER_PARENT`와 모양이 정확히 같아 거동 대조가
 * 1:1이 된다.
 *
 * **왜 그쪽을 import하지 않는가.** `ARTIFACT_LAYERS`와 같은 이유다 — 저쪽은 CLI이고
 * 순수 계약 모듈이 CLI에 의존하면 방향이 뒤집힌다. 대신 `(AC-1b)`가 **철자가 아니라
 * 거동**으로 대조한다: 이 사본이 지목하는 부모로 합성 쌍을 만들어 슬라이스 A의
 * `checkLayerRefs`에 넘겨 같은 판정이 나오는지 본다. 철자 스캔은 리팩터링에 눈이 멀지만
 * 거동 대조는 그렇지 않다.
 */
export const ARTIFACT_PARENT_LAYER = Object.freeze({
  "knowledge-map": "career",
  "gap-report": "knowledge-map",
  "plan": "gap-report",
});

/**
 * 이 계층의 `parentRefs`가 상위 계층 노드 id 집합 안에서 전부 해소되는지 본다.
 *
 * **부모 인스턴스가 아니라 id 집합을 받는다** — 이 모듈의 「디스크에 닿지 않는다」
 * 계약을 유지하기 위해서다. 파일을 여는 몫은 `write-artifact.mjs`에 있다.
 *
 * `index`를 함께 돌려주는 이유는 호출자가 위반을 `$.nodes[i].parentRefs` 형태
 * 문자열로 만들어 **기존 정본** `classifySchemaErrorsByProvenance`에 넘겨 출처(이전
 * 산출물 유래인가 draft 유래인가)를 판별하기 때문이다. 출처 규칙의 사본을 만들지
 * 않는 것이 이 설계의 전부다 — 병합 규칙이 바뀌면 판정이 자동으로 따라간다.
 *
 * @param {string} layer
 * @param {object} instance 병합까지 끝난 인스턴스
 * @param {Set<string>} parentIdSet 상위 계층 nodes[].id 전량
 * @returns {{index: number, nodeId: string, ref: string, code: string, message: string}[]}
 */
export function checkParentRefs(layer, instance, parentIdSet) {
  const parentLayer = ARTIFACT_PARENT_LAYER[layer];
  if (parentLayer === undefined) return [];
  const nodes = Array.isArray(instance?.nodes) ? instance.nodes : [];
  const out = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i];
    const refs = Array.isArray(node?.parentRefs) ? node.parentRefs : [];
    for (const ref of refs) {
      if (parentIdSet.has(ref)) continue;
      out.push({
        index: i,
        nodeId: node?.id ?? "(id 없음)",
        ref,
        code: "LAYER_REF_UNRESOLVED",
        message: `parentRefs '${ref}'가 상위 계층(${parentLayer})의 nodes[].id에 존재하지 않습니다.`,
      });
    }
  }
  return out;
}

/**
 * `skills/` 아래 실재하는 스킬 이름. **정본은 디렉터리이고 이 상수는 사본이다** —
 * 드리프트는 `(AP-1)`이 양방향으로 관측한다(상수에만 있는 것도, 디렉터리에만 있는 것도 FAIL).
 *
 * 여기 두는 이유: `write-artifact.mjs`가 `--skill` 값을 대조해야 하는데 그 CLI가 디렉터리를
 * 훑으면 「무엇이 산출물을 만들었는가」가 실행 시점의 파일 시스템 상태에 좌우된다.
 */
export const KNOWN_SKILLS = Object.freeze(["career-from-git", "skill-gap"]);

/**
 * 스킬이 아닌 산출물 생산자. **각 항목에 왜 스킬이 아닌지 적는다** — 근거 없이 늘어나면
 * 이 집합이 곧 「아무 이름이나」가 된다.
 *
 * - `contamination-fixture` — `tests/contamination`의 회차 재료화. 사람이 스킬을 돌린 것이
 *   아니라 스크립트가 오염 draft를 만들어 `write-artifact.mjs`로 통과시킨다. 기계 3종은
 *   채점에도 주입에도 LLM이 필요 없다(AC-8 (iv)). **실제로 그 이름을 쓰는 것이 정직하다** —
 *   `career-from-git`으로 적으면 레지스트리가 거짓을 말한다.
 */
export const NON_SKILL_PRODUCERS = Object.freeze(["contamination-fixture"]);

/**
 * `state.json`의 `generatedBySkill`에 들어갈 수 있는 값 전량.
 *
 * **콜드 리뷰 라운드 2 처방 9.** 그 필드는 `state.schema.json`에서 `minLength: 1` 자유
 * 문자열이라 지어낸 이름이 exit 0으로 박혔다. 지금은 소비자가 없어 피해가 없지만,
 * `read-registry.mjs`가 그랬듯 **소비자는 나중에 생기고 그때는 근거가 이미 오염돼 있다.**
 * 스키마를 좁히지 않고 CLI에서 막는 이유는 `state.schema.json`이 슬라이스 A라서다.
 */
export const KNOWN_ARTIFACT_PRODUCERS = Object.freeze([...KNOWN_SKILLS, ...NON_SKILL_PRODUCERS]);

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
 * **`instance`가 객체가 아니면 던진다(2026-08-25, 순서 9번).** 초판은 `layer`가
 * 지원 범위 밖이면 명시적으로 던지면서 `instance`에 대해서는 아무것도 보지 않았다 —
 * `instance?.[key]`가 전부 `undefined`를 대입하고 `JSON.stringify`가 undefined 값
 * 프로퍼티를 생략하므로, **없는 본문에 대해 진짜처럼 보이는 64자 무결성 토큰**
 * (`'{}'`의 SHA-256)을 조용히 돌려줬다. 이 제품이 막으려는 실패의 원형이고,
 * 이 모듈이 표방하는 fail-closed 원칙과의 비대칭이었다.
 *
 * **실측(수정 전)**: `null`·`undefined`·`false`·`123`·`"abc"`·`[]`·`[{}]`·`{}`
 * 여덟 입력이 **전부 같은 값** `44136fa3…caaff8a`를 돌려줬다.
 *
 * **배열이 별도 팔인 이유 — 취향이 아니다.** `typeof [] === "object"`이고
 * `[] !== null`이라, `instance === null || typeof instance !== "object"` 형태의
 * 2분기 가드로는 **배열만 조용히 통과한다**. 그리고 그 누수는 나머지 금지 방향
 * 단언을 하나도 깨지 않으므로 게이트에 흔적이 남지 않는다. `(CH-7)`이 이 팔
 * 하나만 관측한다.
 *
 * **형태 이름을 사유에 담는다.** 「객체가 아님」만으로는 어느 형태로 들어왔는지가
 * 로그에서 사라진다 — 이 레포는 판독 실패에서 같은 규율을 반복해 왔다(`(SR-7)`).
 *
 * **술어를 import로 공유하지 않는다.** 같은 3분기 분류는 JSON을 판독하는
 * 경계마다 되풀이된다 — **몇 벌인지 세지 않는다.** 초판이 「3벌」이라 적고 두
 * 지점을 열거해 뒀는데, 그 뒤 판독 경계가 늘어나는 동안 주석만 그 자리에
 * 남았다(순서 13번이 낸 드리프트). **수를 적으면 다음 판독 경계에서 또 낡는다.**
 * 현재 지점이 필요하면 세지 말고 찾아라 —
 * `rg 'Array\.isArray\(.+\) \? "array"' scripts`가 정본이다.
 *
 * 공유하지 않는 이유는 편의가 아니라 **의존 방향**이다: 이 파일의 헤더가
 * 「순수 계약 모듈이 CLI에 의존하면 의존 방향이 뒤집힌다」고 못 박았고
 * `write-artifact.mjs`가 이 파일을 import하는 방향이라 역방향은 순환이다.
 * 세 줄을 다시 쓰는 것이 옳다.
 *
 * **가드가 보지 못하는 것(감추지 않는다)**: `Object.create(null)`·`new Date()`·
 * 클래스 인스턴스는 `"object"`로 통과한다. 위 두 선례가 모두 여기까지만 보고
 * `(SR-8)`이 그 분류를 못 박아 뒀다 — 더 좁히려면 그 선례부터 바꿔야 한다.
 *
 * @param {string} layer `ARTIFACT_LAYERS`의 키 또는 `"evidence"`
 * @param {object} instance
 * @returns {string} 64자 SHA-256 hex
 * @throws {Error} `layer`가 지원 밖이거나 `instance`가 객체가 아닐 때
 */
export function computeArtifactContentHash(layer, instance) {
  const bodyField = layer === "evidence" ? EVIDENCE_BODY_FIELD : ARTIFACT_LAYERS[layer]?.bodyField;
  if (!bodyField) {
    throw new Error(
      `지원하지 않는 계층입니다: '${layer}' (지원: ${Object.keys(ARTIFACT_LAYERS).join(", ")}, evidence)`
    );
  }
  // layer 가드 **뒤**다. 둘 다 어긋난 호출은 계층 문제를 먼저 보고하는 기존
  // 우선순위를 보존한다 — `(AC-6)`이 `("nope", {})`로 그 축만 관측한다.
  const shape = instance === null ? "null" : Array.isArray(instance) ? "array" : typeof instance;
  if (shape !== "object") {
    throw new Error(
      `contentHash를 계산할 instance가 객체가 아닙니다(${shape}) — ` +
      "부재를 '{}'의 해시로 강등하면 없는 본문에 대해 진짜처럼 보이는 64자 무결성 토큰이 만들어집니다."
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
 *
 * `origin`과 `locked`는 **두 단계 모두** 기입할 수 없다 — 단계가 가르는 것은
 * `verification` 하나뿐이다(게이트 B-7).
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
  const hasVerificationAxis = VERIFICATION_LAYERS.includes(layer);

  // **nodes 비배열을 빈 배열로 강등하지 않는다(콜드 리뷰 M-3).** 초판은
  // `Array.isArray(...) ? ... : []`로 조용히 넘겼고, 그 결과 nodes 필드가 없는
  // draft가 위반 0건으로 통과한 뒤 병합이 `{...draft, nodes: mergedNodes}`를
  // 돌려주는 바람에 **기형 draft였다는 신호가 스키마 검증 앞에서 세탁**됐다.
  // 실측: prev `[car:001, car:002(locked)]`에 nodes 없는 draft를 넣자
  // **exit 0으로 성공하면서** car:001이 경고도 .bak도 없이 사라졌다.
  // 이 모듈이 VERIFICATION_MISSING·PREV_ARTIFACT_HASH_MISSING에서 내세운
  // fail-closed와 정면으로 어긋나던 유일한 통로다.
  if (!Array.isArray(instance?.nodes)) {
    violations.push({
      code: "NODES_NOT_ARRAY",
      message:
        `산출물의 nodes가 배열이 아닙니다(실제: ${instance?.nodes === undefined ? "필드 없음" : typeof instance.nodes}) — ` +
        "빈 배열로 강등하면 기형 출력이 '노드 0건'과 구별되지 않고, 잠기지 않은 이전 노드가 조용히 사라집니다.",
    });
    return violations;
  }

  for (const node of instance.nodes) {
    const id = node?.id ?? "(id 없음)";

    // `origin`은 **두 단계 모두** "generated"여야 한다. 생성 주체가 무엇을
    // 만들든 그것은 LLM 생성분이고, `user`로 바꾸는 것은 병합만 할 수 있다.
    // 단계로 완화하지 않는 이유는, `origin:"user"`가 언어 린트 제외 통로이기
    // 때문에 어느 단계에서 새든 같은 구멍이 되기 때문이다.
    if (node?.origin !== "generated") {
      violations.push({
        code: "ORIGIN_SET_BY_TEMPLATE",
        message:
          `노드 '${id}'의 origin이 '${node?.origin}'입니다 — 생성 출력의 origin은 항상 'generated'여야 하고 ` +
          "'user'는 병합·편집 감지 로직만 설정합니다(AC-19 언어 린트의 origin:user 제외가 자기면제 통로가 됩니다).",
      });
    }

    // **`locked`도 생성 출력이 담지 않는다 — 게이트 B-7.**
    //
    // 여기까지 `origin`과 `verification`에는 집행 코드가 생겼는데 `locked`만
    // 규약이 없었다. 그 상태에서 생성 템플릿이 자기 노드에 `locked: true`를
    // 적으면 아래 병합 규칙 1이 그 노드를 **영원히** 보존한다 — 이후 어떤
    // 재생성도 그 노드를 못 건드린다. (g)가 닫으려는 자기면제와 구조가 같다.
    //
    // **금지가 값이 아니라 필드의 존재인 이유**는 M-1에서 배운 것과 같다.
    // `locked: false`만 허용하면 금지가 "검사로 막기"가 되어 이후 제약과
    // 곱해질 때 다시 모순이 날 수 있고, 무엇보다 템플릿이 적을 수 있는
    // 의미 있는 값이 애초에 없다. 필드를 없애면 **표현 자체가 불가능**해진다.
    //
    // **단계로 완화하지 않는다.** `origin`과 같은 이유다 — fact-checked 출력을
    // 조립하는 주체도 같은 오케스트레이션이므로, 한쪽 단계만 막으면 다른 쪽으로
    // 새는 같은 구멍이 남는다.
    //
    // **그럼 누가 잠그는가.** 사용자가 산출물 파일을 직접 편집하는 경로 하나뿐
    // 이다 — 편집하면 contentHash가 어긋나 `PREV_ARTIFACT_EDITED`로 보류되고,
    // `--force` 강행이 `.bak`을 남긴 뒤 병합이 그 `locked` 노드를 보존한다.
    // 즉 잠금은 **사람의 결정**이며 그 결정이 파일에 남는다(AC-16의 설계 그대로).
    if (node?.locked !== undefined) {
      violations.push({
        code: "LOCKED_SET_BY_TEMPLATE",
        message:
          `노드 '${id}'에 locked가 실려 있습니다(값: ${JSON.stringify(node.locked)}) — 생성 출력은 이 필드를 ` +
          "**아예 담지 않습니다**. 값은 병합이 채우고(기존 노드는 이전 값을 이어받고 신규 노드는 false), " +
          "잠금은 사용자가 산출물을 직접 편집할 때만 생깁니다(게이트 B-7). 템플릿이 스스로 잠그면 그 노드는 " +
          "이후 재생성에서 영원히 보존되어 2단 팩트체크의 사정권 밖으로 나갑니다.",
      });
    }

    if (!hasVerificationAxis) continue;
    const hasVerification = node?.verification !== undefined && node?.verification !== null;

    if (stage === "draft") {
      // **draft는 `verification`을 담지 않는다 — 값이 아니라 필드 자체가 금지다.**
      //
      // 초판은 "draft는 not-attempted만 기입할 수 있다"였는데, 그 판이
      // 콜드 리뷰 M-1의 3중 자기모순을 만들었다: prev에 attempts>=1인 비잠금
      // 노드가 있으면 그 노드를 draft로 재작성할 방법이 **하나도 없었다**
      // (실측 4갈래 전부 exit 1 — ATTEMPTS_RESET / 스키마 const 0 /
      // SET_BY_TEMPLATE / NODE_ID_CHURN). 스키마의 `not-attempted → attempts
      // const 0`과 「재시도 상한 이어받기」가 동시에 성립할 수 없었기 때문이다.
      //
      // 필드 자체를 금지하고 **병합이 채우게** 하면 그 모순이 사라진다 —
      // 기존 노드는 prev의 verification을 그대로 이어받으므로 attempts가
      // 애초에 초기화될 수 없고(검사로 막는 것이 아니라 표현할 수 없다),
      // 신규 노드만 not-attempted/0/null을 받는다. 스키마 required와도
      // 부딪히지 않는다 — 검증 대상은 draft 파일이 아니라 병합 결과다.
      if (hasVerification) {
        violations.push({
          code: "VERIFICATION_SET_BY_TEMPLATE",
          message:
            `노드 '${id}'에 verification이 실려 있습니다 — draft 단계(생성 템플릿 출력)는 이 필드를 ` +
            "**아예 담지 않습니다**. 값은 병합이 채우고(기존 노드는 이전 판정을 이어받습니다), 판정은 " +
            "FactChecker 디스패치를 수행한 스킬 오케스트레이션만 실을 수 있습니다(구현 7단계 (g)).",
        });
      }
      continue;
    }

    // fact-checked — 이 단계는 판정을 실어야 하므로 부재가 위반이다.
    // 부재를 '판정 대상이 아님'으로 읽지 않는다(fail-closed). 이 검사가
    // 스키마 검증보다 **앞**에서 돌기 때문에 여기서 조용히 넘기면
    // "verification이 없으면 (g)를 어길 수 없다"는 fail-open이 된다.
    if (!hasVerification) {
      violations.push({
        code: "VERIFICATION_MISSING",
        message: `노드 '${id}'에 verification 필드가 없습니다 — fact-checked 단계는 판정을 실어야 합니다.`,
      });
      continue;
    }

    // **불변식 ④ — 승인 판정은 시도 1회 이상을 요구한다(라운드 2 처방 3).**
    // 스키마는 `not-attempted ⇒ attempts const 0`과 `refuted ⇒ attempts const 2`를
    // 못 박는데 **`verified`만 attempts에 아무 조건이 없다**(career.schema.json의
    // 조건절 셋을 세어 보면 그 칸이 비어 있다). 그래서 「한 번도 돌리지 않았는데
    // 승인」이 형태로 적법하고, 실제로 빈 저장 루트에 곧장
    // `--stage fact-checked`로 `{status:"verified", attempts:0}`을 쓰면 exit 0이었다(실측).
    //
    // **스키마를 고치지 않고 여기서 막는 이유**: 세 계층 스키마는 슬라이스 A 파일이고
    // 예외는 「그 항목이 회차 작업을 실제로 막을 때만」 추가한다(절대 규칙 5).
    // 이 검사는 런타임으로 온전히 달성되므로 막지 않는다.
    const status = node?.verification?.status;
    const attempts = node?.verification?.attempts;
    if (status === "verified" && attempts === 0) {
      violations.push({
        code: "VERIFIED_WITHOUT_ATTEMPT",
        message:
          `노드 '${id}'가 verification.attempts=0인 채 status="verified"입니다 — ` +
          "시도 0회의 승인은 FactChecker를 돌리지 않고 판정을 자칭한 것입니다(구현 7단계 (g)).",
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
 * `stage`는 **필수**다. 기본값을 두면 호출자가 빠뜨렸을 때 조용히 한쪽
 * 의미로 동작하고, 그 한쪽이 하필 verification을 덮어쓰는 쪽이다.
 *
 * 규칙 다섯 가지. 각각 **양방향으로** 관측된다(금지 방향만 보면 "전부 보존"
 * 하는 병합이나 "전부 덮어쓰는" 병합이 통과한다).
 *
 *  1. **`locked` 보존(AC-16).** prev의 `locked:true` 노드는 draft가 같은 id로
 *     덮어써도 prev 내용이 이기고, draft에 아예 없어도 살아남는다.
 *     `locked:false` 노드는 draft에 없으면 사라진다 — 그것이 재생성이다.
 *  2. **노드 id 재사용(구현 7단계 (b)).** draft가 prev에 이미 있는 **동일
 *     text**를 새 id로 들고 오면 `NODE_ID_CHURN` 위반이다. id를 만드는 주체가
 *     LLM이므로 이 성질은 저절로 성립하지 않고, 깨지면 `locked`로 잠근 사용자
 *     편집분이 고아가 된다.
 *  3. **`verification`의 주인은 단계가 정한다(구현 7단계 (g) / 콜드 리뷰 M-1).**
 *     - `draft`: draft는 이 필드를 담지 않는다(`checkAuthorshipContract`가
 *       고발한다). 여기서 **병합이 채운다** — 기존 노드는 prev의 값을 그대로
 *       이어받고, 신규 노드만 `{not-attempted, 0, null}`을 받는다. 그래서
 *       attempts 초기화가 **표현 자체로 불가능**하다(검사로 막는 것이 아니다).
 *     - `fact-checked`: draft가 판정을 싣는다. 이 단계에서만 attempts 감소를
 *       `VERIFICATION_ATTEMPTS_RESET`으로 거부한다 — 조용히 `max()`로 고치면
 *       §3의 상한 2회가 실행마다 초기화되는 버그가 산출물에는 안 보인다.
 *  4. **`origin`과 `locked`는 병합만 설정한다(게이트 B-7).** prev에 있던
 *     노드는 prev의 값을 이어받고, 신규 노드는 `generated`/`false`다.
 *     템플릿이 기입하려 한 값은 `checkAuthorshipContract`가 별도로 고발하며,
 *     여기서 덮어쓰는 것이 그 고발을 대신하지 않는다 — **두 가드는 독립이어야
 *     한다.** 한쪽만 되돌리면 CLI는 여전히 막히지만 `mergeArtifact`를 직접
 *     부르는 호출자에게는 구멍이 남는다(N5·N6에서 실측된 형태다).
 *  5. **`nodes` 비배열은 빈 배열로 강등하지 않는다(콜드 리뷰 M-3).**
 *     `NODES_NOT_ARRAY`로 거부한다 — 강등하면 기형 draft가 exit 0으로 통과하며
 *     잠기지 않은 prev 노드를 지운다(실측).
 *
 * 노드 순서: draft 순서를 그대로 두고, draft에 없던 `locked` 생존자를 prev
 * 순서로 뒤에 붙인다. 순서를 섞으면 재실행 diff가 무의미해진다.
 *
 * **`prevDerived` — 노드별 출처 기록(2026-08-25, 순서 10번 / f029375 Minor 12).**
 * `merged.nodes`와 **같은 순서·같은 길이**의 배열을 함께 돌려준다. 각 원소는
 * `{ whole: boolean, fields: string[] }`이며, `whole`이면 그 노드 **전체**가 prev에서
 * 왔고(규칙 1의 두 경로), 아니면 `fields`가 draft 노드 위에 얹힌 **prev 유래 필드**의
 * 이름 집합이다.
 *
 * **왜 병합이 이것을 돌려주는가.** 쓰기 직전 스키마 검증은 draft가 아니라 **병합 결과**를
 * 본다. 위반이 prev에서 온 내용이면 「출력을 고쳐 다시 부른다」(exit 1)는 **거짓 안내**이고,
 * 호출자는 draft를 아무리 고쳐도 같은 위반을 반복한다. 그 판별에 필요한 것은 병합이 방금
 * 내린 결정 그 자체이므로, 호출자가 id를 대조해 **재도출하면 정본이 둘로 갈린다** —
 * 규칙이 바뀔 때 한쪽만 따라가면 판별이 조용히 틀린다.
 *
 * **기존 호출자는 그대로다** — `const { merged, violations } = …` 구조분해는 이 필드를
 * 무시한다.
 *
 * @param {string} layer
 * @param {object|null} prev 이전 산출물(없으면 null)
 * @param {object} draft 이번 출력
 * @param {{stage: string}} opts
 * @returns {{merged: object, violations: {code: string, message: string}[],
 *            prevDerived: {whole: boolean, fields: string[]}[]}}
 */
export function mergeArtifact(layer, prev, draft, { stage } = {}) {
  if (!AUTHORSHIP_STAGES.includes(stage)) {
    throw new Error(`알 수 없는 단계입니다: '${stage}' (지원: ${AUTHORSHIP_STAGES.join(", ")})`);
  }
  const violations = [];
  const hasVerificationAxis = VERIFICATION_LAYERS.includes(layer);
  const prevNodes = Array.isArray(prev?.nodes) ? prev.nodes : [];

  if (!Array.isArray(draft?.nodes)) {
    // 규칙 5 — 강등하지 않는다. 여기서 통과시키면 아래 조립이 prev의
    // 비잠금 노드를 전부 버린 결과를 정상 산출물처럼 돌려준다.
    return {
      merged: draft,
      violations: [{
        code: "NODES_NOT_ARRAY",
        message: "병합 입력의 nodes가 배열이 아닙니다 — 빈 배열로 강등하면 잠기지 않은 이전 노드가 조용히 사라집니다.",
      }],
      // 조립을 하지 않았으므로 출처 기록도 없다. **빈 배열인 이유는 크래시 방어가
      // 아니다** — 소비자 `classifySchemaErrorsByProvenance`는 `prevDerived?.[i]`로
      // null-safe이고(실측: 두 번째 인자에 `null`을 줘도 예외 없이 전량 draft 몫으로
      // 돌아온다), CLI는 `violations`가 있어 이 값을 만지기 전에 exit 1로 나간다.
      // 빈 배열은 **반환 형태를 갈라 두지 않기 위한 것**이다: 어떤 경로로 돌아오든
      // `prevDerived`가 배열이면 호출자가 분기를 하나 덜 갖는다.
      prevDerived: [],
    };
  }
  const draftNodes = draft.nodes;

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

  /** draft 단계에서 신규 노드가 받는 초기 판정. */
  const FRESH_VERIFICATION = { status: "not-attempted", attempts: 0, reasonCode: null };

  const mergedNodes = [];
  // `mergedNodes`와 인덱스가 **정확히 대응**한다. 두 배열에 push하는 지점이
  // 네 곳이므로, 한 곳에서 빠뜨리면 이후 전부가 한 칸씩 밀려 **엉뚱한 노드를
  // prev 유래로 판정한다** — 조용한 오판이라 `(AC-43)`이 인덱스 정렬 자체를
  // 별도로 관측한다.
  const prevDerived = [];
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
        // 얕은 사본으로 넣어 호출자가 merged를 만져도 prev 객체가 오염되지
        // 않게 한다(콜드 리뷰: merged와 prev의 참조 공유).
        mergedNodes.push({ ...prevNode });
        // 내용이 **전부** prev에서 왔다 — draft는 이 노드에 한 글자도 기여하지 못한다.
        prevDerived.push({ whole: true, fields: [] });
        continue;
      }

      // 규칙 4 — `origin`은 prev의 값을 이어받는다. 스프레드 **뒤**에 두어야
      // draft가 실은 값이 덮어써진다(게이트 B-7의 병합 측 가드).
      //
      // **`locked`에 대한 서술을 정정한다(콜드 리뷰 지적).** 여기를 「locked도
      // prev에서 이어받는다」고 적었지만, 이 줄에 도달하는 시점에는 바로 위
      // 규칙 1의 early-return이 `prevNode.locked !== true`를 이미 보장하므로
      // `prevNode.locked === true`는 **도달 가능한 모든 경로에서 false와 동치**다.
      // 실제로 잠금을 이어받는(= true를 보존하는) 것은 규칙 1이다.
      //
      // **그래도 리터럴 false로 바꾸지 않는다.** 규칙 1의 early-return이 나중에
      // 옮겨지거나 사라지면 이 표현식이 곧바로 짐을 진다 — 방어적 중복이다.
      // 대신 「이 줄이 잠금을 이어받는다」고 읽지 않도록 여기 적어 둔다.
      const merged = { ...node, origin: prevNode.origin, locked: prevNode.locked === true };

      // 이 노드의 본문은 draft가 만들었지만 **아래 필드는 prev가 만들었다.**
      // `locked`는 `=== true` 정규화라 항상 boolean이므로 스키마를 어길 수 없지만,
      // 그래도 적는다 — 이 목록은 「값이 어디서 왔는가」의 기록이지 「무엇이 위험한가」의
      // 예측이 아니다. 규칙 4가 바뀌어 다른 값이 실리면 그때 이 목록이 이미 맞다.
      const derivedFields = ["origin", "locked"];

      if (hasVerificationAxis) {
        if (stage === "draft") {
          // 규칙 3 — draft는 판정을 못 만든다. prev의 값을 그대로 이어받는다.
          merged.verification = prevNode.verification === undefined
            ? { ...FRESH_VERIFICATION }
            : prevNode.verification;
          // **prev에 값이 있을 때만** prev 유래다. 없으면 위 `FRESH_VERIFICATION`이
          // 실리는데 그것은 이 함수가 만든 값이라 prev에 책임을 물을 수 없다 —
          // 「prev 유래」를 넓게 잡으면 고칠 수 있는 위반이 사람 확인으로 넘어간다.
          if (prevNode.verification !== undefined) derivedFields.push("verification");
        } else {
          // **불변식 ③ — 상한을 소진한 강등은 되돌릴 수 없다(라운드 2 처방 3).**
          // `refuted`는 스키마상 `attempts const 2`이므로 재생성 상한이 이미
          // 소진돼 있고, 추가 시도로 승인이 나올 경로가 구조적으로 없다 —
          // 따라서 `refuted → verified`는 재판정이 아니라 날조다.
          //
          // **아래 ATTEMPTS_RESET과 방향이 거꾸로 서 있었다**(실측): 정직한 판정
          // 취소(`refuted/2 → not-attempted/0`)는 exit 1로 막히는데, 최고 등급
          // 승격(`refuted/2 → verified/2`)은 exit 0으로 통과했다. 유일한 문턱이
          // attempts 비감소인데 2 → 2는 감소가 아니기 때문이다.
          //
          // **강등 방향(`verified → refuted`)은 열어 둔다** — `(AC-22)`가 그것을
          // 허용 방향으로 관측하고 있고, 불리해지는 변경은 보수적이다.
          if (prevNode?.verification?.status === "refuted" && node?.verification?.status === "verified") {
            violations.push({
              code: "VERDICT_PROMOTED_AFTER_REFUTED",
              message:
                `노드 '${id}'의 판정이 refuted → verified로 승격됐습니다 — refuted는 재생성 상한 2회를 ` +
                "이미 소진한 상태이므로 추가 시도로 승인이 나올 수 없습니다(AC-13 (iii)).",
            });
          }
          const prevAttempts = prevNode?.verification?.attempts;
          const draftAttempts = node?.verification?.attempts;
          if (
            typeof prevAttempts === "number" &&
            typeof draftAttempts === "number" &&
            draftAttempts < prevAttempts
          ) {
            violations.push({
              code: "VERIFICATION_ATTEMPTS_RESET",
              message:
                `노드 '${id}'의 verification.attempts가 ${prevAttempts} → ${draftAttempts}로 줄었습니다 — ` +
                "재시도 횟수는 실행 간에 이어받아야 하며 초기화하면 §3의 재생성 상한 2회가 사실상 무한이 됩니다(AC-13 (iii)).",
            });
          }
        }
      }

      // **불변식 ① — 승인 판정은 판정이 내려진 문장에만 붙는다(라운드 2 처방 3).**
      // 판정이 **주장이 아니라 id 문자열에 붙어 있다**는 것이 이 축의 전부다. 실측:
      // 같은 id를 `--stage draft`로 되돌리며 text를 전면 교체해도 exit 0이고
      // `verified`가 그대로 따라붙었으며, 들여쓰기 수정 커밋 하나를 인용한 채
      // 「일 3000만 건 트랜잭션」이 강등 배지 없이 사용자 문서에 실렸다.
      //
      // **단계로 분기하지 않는다.** draft에서는 승계로, fact-checked에서는 자칭으로
      // 같은 결과가 나오므로 조건 하나가 둘을 덮는다.
      //
      // **`verified`에만 건다 — `refuted` 승계는 열어 둔다.** 이것이 이 불변식의
      // 핵심 경계다. 「text가 다르면 승계 금지」를 통째로 걸면 `(WA-17)`이 깨진다:
      // 그 단언은 prev가 `refuted/2`인 노드를 draft에서 문장을 다듬어 재작성하면
      // exit 0이고 판정이 보존된다를 **허용 방향으로 못 박고 있다.** 그것을 막으면
      // 콜드 리뷰 M-1의 막다른 길(재작성이 네 갈래 모두 exit 1)이 되살아난다.
      // 불리한 판정이 개작된 문장을 따라가는 것은 보수적이므로 막을 이유가 없다.
      //
      // 빠져나갈 길이 둘 있고 둘 다 정직하다 — text를 되돌리거나, 바뀐 주장에 새
      // id를 주는 것이다(신규 노드는 아래에서 `not-attempted/0`을 받는다).
      if (
        hasVerificationAxis &&
        merged?.verification?.status === "verified" &&
        typeof prevNode.text === "string" &&
        typeof node?.text === "string" &&
        prevNode.text !== node.text
      ) {
        violations.push({
          code: "VERIFIED_CLAIM_REWRITTEN",
          message:
            `노드 '${id}'는 verification.status="verified"인데 서술이 이전 산출물과 다릅니다 — ` +
            "판정은 그 판정이 내려진 문장에만 붙습니다. 서술을 되돌리거나 바뀐 주장에 새 id를 주십시오.",
        });
      }

      mergedNodes.push(merged);
      prevDerived.push({ whole: false, fields: derivedFields });
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
    // 규칙 4 — 신규 노드는 `generated`이고 잠겨 있지 않다. 잠금은 사용자가
    // 파일을 직접 편집할 때만 생기므로 갓 생성된 노드가 잠긴 상태일 수 없다.
    const fresh = { ...node, origin: "generated", locked: false };
    if (hasVerificationAxis && stage === "draft") fresh.verification = { ...FRESH_VERIFICATION };
    mergedNodes.push(fresh);
    // 신규 노드에는 prev가 한 글자도 기여하지 않았다 — `origin`·`locked`·`verification`도
    // 전부 이 함수가 만든 리터럴이다.
    prevDerived.push({ whole: false, fields: [] });
  }

  // draft에 없던 prev 노드 — 잠긴 것만 살린다(규칙 1의 허용 방향).
  for (const node of prevNodes) {
    if (typeof node?.id !== "string" || consumedPrevIds.has(node.id)) continue;

    // **불변식 ② — 반증 확정 노드는 조용히 사라질 수 없다(라운드 2 처방 3).**
    // 실측: `[refuted/2, verified/1]`에서 refuted 노드만 뺀 draft가 exit 0으로
    // 통과하고 「(노드 1건)」 한 줄 외에 흔적이 없다. `state.json`은 경로·버전·
    // 생성 스킬 3필드뿐이라 이전 총량이 어디에도 남지 않고, 조용한 경로에는
    // `.bak`도 없으므로 **지워진 판정은 복구도 사후 판독도 불가능하다.**
    //
    // 그리고 이 삭제가 다른 축의 집행을 지우는 도구가 된다 — 레포에 없는 해시를
    // 인용한 노드를 지우자 `verify-evidence`가 `[FAIL]`에서 `[PASS]` exit 0으로
    // 뒤집혔다(검사기가 남은 노드의 인용만 세므로 위반 노드는 분자에서도
    // 분모에서도 사라진다). **측정된 세탁 경로가 전부 이 삭제로 시작한다.**
    //
    // **`refuted`에만 건다.** `not-attempted`·`verified` 노드의 소실은 `(AC-17)`이
    // 「재생성이 대체한다」로 허용 방향을 못 박은 동작이고, 그것까지 막으면 병합이
    // 누적만 하는 동작이 된다.
    //
    // 지워야 할 정당한 사유가 있으면 경로가 이미 있다 — 사용자가 산출물을 직접
    // 편집하면 `PREV_ARTIFACT_EDITED`(exit 3)가 사람 확인을 요구하고 `--force`가
    // `.bak` 1세대를 남긴다. 즉 삭제는 사람의 결정이 되고 그 결정이 파일에 남는다.
    if (node.locked !== true && node?.verification?.status === "refuted") {
      violations.push({
        code: "REFUTED_NODE_DROPPED",
        message:
          `이전 산출물의 노드 '${node.id}'(verification.status="refuted", ` +
          `reasonCode=${JSON.stringify(node?.verification?.reasonCode ?? null)})가 draft에 없습니다 — ` +
          "반증이 확정된 노드를 조용히 지우면 그 판정이 복구도 사후 판독도 불가능해집니다(AC-13 (iii)).",
      });
    }

    if (node.locked === true) {
      mergedNodes.push({ ...node });
      // 규칙 1의 두 번째 경로. 위 early-return과 마찬가지로 draft가 기여한 것이 없다 —
      // 오히려 이쪽은 draft가 이 노드를 **언급조차 하지 않았다.**
      prevDerived.push({ whole: true, fields: [] });
    }
  }

  return { merged: { ...draft, nodes: mergedNodes }, violations, prevDerived };
}

/**
 * 스키마 오류를 **prev 유래**와 **draft를 고쳐 해소되는 것**으로 가른다
 * (순서 10번 / f029375 Minor 12).
 *
 * **왜 필요한가.** 쓰기 직전 자기 검증은 병합 결과를 보므로, 위반이 이전 산출물에서
 * 온 내용일 수 있다. 그때 exit 1(「출력을 고쳐 다시 부른다」)을 내면 호출자는 draft를
 * 아무리 고쳐도 **영원히 같은 위반**을 받는다 — 5분기 종료 코드 계약이 이 경로에서
 * 무너지고, 막다른 길에서 `--force`로 강행하면 locked 노드가 전멸한다.
 *
 * **경로 문자열로 가른다.** `validateInstance`의 오류는 `` `${path}: ${사유}` `` 형태이고
 * `path`는 `$` · `[i]` · `.key`만으로 조립된다(`schema-validate.mjs`). 노드 단위 오류는
 * 반드시 `$.nodes[N]`으로 시작하므로 인덱스를 뽑아 `prevDerived[N]`과 대조한다.
 *
 * **판별 규칙 세 가지.**
 *  1. `$.nodes[N]…`이 아닌 오류(예: `$.nodes: minItems(1) 미만`, `$: required …`)는
 *     **draft 몫**이다 — 산출물 최상위 형태는 draft가 정한다.
 *  2. `prevDerived[N].whole`이면 그 노드 아래의 **모든** 오류가 prev 몫이다.
 *  3. 부분 노드는 인덱스 **바로 뒤 한 세그먼트**가 `fields`에 있을 때만 prev 몫이다.
 *
 * **규칙 3이 놓치는 것(감추지 않는다)**: 노드 **자체**를 가리키는 오류
 * (`$.nodes[N]: required 필드 'x' 없음` · `additionalProperties 위반('x')`)는 부분 노드에서
 * draft 몫으로 분류된다. 이것은 근사가 아니라 **판정**이고, 근거는 키마다 다르다:
 *  - `origin`·`locked` — 병합이 **항상 대입**한다(값이 `undefined`여도 키는 존재하므로
 *    `required` 위반을 낼 수 없다).
 *  - `verification` — **draft 단계에서만** 병합이 대입한다. fact-checked 단계에서는 값이
 *    draft에서 오므로, 그 키가 없어서 나는 `required` 위반은 **draft의 몫이 맞다**
 *    (분류가 우연히 맞는 것이 아니라 책임 소재가 실제로 draft에 있다).
 *  - `additionalProperties` 위반을 내는 여분 키는 `{ ...node }`로 들어온 draft의 것이다.
 *
 * 초판 주석은 셋을 뭉뚱그려 「항상 대입한다」고 적었는데 `verification`에 대해 거짓이었다 —
 * 결론은 같지만 근거가 틀린 주석은 다음 사람의 판단을 그르친다(적대 검증 지적).
 * 규칙 4가 바뀌어 병합이 `origin`·`locked`를 **조건부로** 대입하게 되면 첫 줄의 논거가
 * 무너지므로, 그때 이 문단과 함께 고쳐야 한다.
 *
 * **분류에 실패하면 draft 몫으로 떨어진다(보수적이지 않은 쪽).** 일부러 그렇게 뒀다 —
 * 반대로 기울이면 평범한 draft 오류가 사람 확인으로 넘어가 exit 3이 흔해지고, 그러면
 * 「exit 3은 사람이 결정해야 한다」는 신호 자체가 희석된다. 대신 호출자는 **두 목록을
 * 모두** 출력해야 한다.
 *
 * @param {string[]} errors `validateInstance`가 돌려준 오류 문자열
 * @param {{whole: boolean, fields: string[]}[]} prevDerived `mergeArtifact`의 출처 기록
 * @returns {{fromPrev: string[], fromDraft: string[]}}
 */
export function classifySchemaErrorsByProvenance(errors, prevDerived) {
  const NODE_PATH = /^\$\.nodes\[(\d+)\](?:\.([^.[:]+))?/;
  const fromPrev = [];
  const fromDraft = [];
  for (const error of errors) {
    const m = typeof error === "string" ? NODE_PATH.exec(error) : null;
    const record = m === null ? undefined : prevDerived?.[Number(m[1])];
    if (record === undefined) {
      fromDraft.push(error);
    } else if (record.whole === true) {
      fromPrev.push(error);
    } else if (m[2] !== undefined && Array.isArray(record.fields) && record.fields.includes(m[2])) {
      fromPrev.push(error);
    } else {
      fromDraft.push(error);
    }
  }
  return { fromPrev, fromDraft };
}
