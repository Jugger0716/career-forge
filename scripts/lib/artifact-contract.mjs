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
 * **술어를 import로 공유하지 않는다.** 같은 3분기 분류가 `write-artifact.mjs`의
 * `loadSchema`와 `run-smoke.mjs`의 `jsonShapeViolation`에도 있지만, 이 파일은
 * 헤더가 「순수 계약 모듈이 CLI에 의존하면 의존 방향이 뒤집힌다」고 못 박았고
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
 * @param {string} layer
 * @param {object|null} prev 이전 산출물(없으면 null)
 * @param {object} draft 이번 출력
 * @param {{stage: string}} opts
 * @returns {{merged: object, violations: {code: string, message: string}[]}}
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

      if (hasVerificationAxis) {
        if (stage === "draft") {
          // 규칙 3 — draft는 판정을 못 만든다. prev의 값을 그대로 이어받는다.
          merged.verification = prevNode.verification === undefined
            ? { ...FRESH_VERIFICATION }
            : prevNode.verification;
        } else {
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

      mergedNodes.push(merged);
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
  }

  // draft에 없던 prev 노드 — 잠긴 것만 살린다(규칙 1의 허용 방향).
  for (const node of prevNodes) {
    if (typeof node?.id !== "string" || consumedPrevIds.has(node.id)) continue;
    if (node.locked === true) mergedNodes.push({ ...node });
  }

  return { merged: { ...draft, nodes: mergedNodes }, violations };
}
