# 슬라이스 B 스펙 심사 (구현 7~10단계 — P0 스킬 계층)

> **왜 이 문서가 있는가.** `plan_critic_findings.md`(round 6)가 스스로 적었듯,
> **구현 7~12단계는 6라운드 내내 정면 검사가 0회였다** — 지적 총 83건이 전부 구현 0~6단계에
> 집중됐다. 슬라이스 A는 스펙 심사 6라운드를 거친 뒤에도 앵커 없는 콜드 리뷰에서 Critical 5건이
> 나왔다. 그 영역보다 검사량이 적은 채로 슬라이스 B에 착수하면 같은 일이 더 나쁜 조건에서
> 반복된다. 그래서 코드를 쓰기 전에 스펙 쪽을 먼저 두들긴다.
>
> **심사 범위**: `spec.md`의 구현 7~10단계와 그것이 걸고 있는 AC-8·AC-9·AC-11·AC-12·AC-13·
> AC-14·AC-16·AC-18·AC-19·AC-20·AC-21·AC-22, 그리고 그 조항들이 전제하는 현재 코드베이스의
> 실제 능력(`schemas/*.json`, `scripts/lib/schema-validate.mjs`, `scripts/lib/store.mjs`,
> `scripts/validate-plugin.mjs`, `scripts/verify-evidence.mjs`, `tests/run-smoke.mjs`).
>
> **방법**: 스펙 조항을 읽고 "이 조항을 만족하는 구현이 존재할 수 있는가 / 만족하지 않는 구현이
> FAIL 하는가"를 물었다. 결정적인 3건은 문서 독해로 끝내지 않고 **실제로 실행해 관측**했다
> (아래 `실측` 표시). 검증 환경: Windows 11 / git 2.47 / Node v24.15.0. 원본 레포는 수정하지
> 않았고 재현은 전부 스크래치패드에서 수행했다.
>
> **이 심사가 보지 않은 것**(「검증됨」이 아니라 「미검사」다): 구현 11~12단계(prep-plan·공개
> 준비)는 슬라이스 C 소관이라 제외했다. CareerWriter/FactChecker/KnowledgeMapper **프롬프트
> 문안의 품질**은 아직 존재하지 않아 심사 대상이 아니다. 콜드 리뷰 T3·T4(미반영 약 20건)와의
> 중복 제거는 하지 않았다 — 겹치는 항목은 그 사실을 명시했다.

## Summary: Critical=4, Major=8, Minor=4

---

## 반영 현황 (2026-08-18, 이 문서 작성 직후 같은 세션)

게이트 A·B와 T3를 반영했다. **코드로 닫힌 것과 스펙에만 적힌 것을 구분해 적는다** — 이 구분을
흐리면 다음 세션이 "이미 방어가 있다"고 오해한다.

**코드로 닫혔고 관측됐다**(각 항목마다 위반을 넣어 실제로 FAIL이 나는 것을 확인):

| 항목 | 무엇이 들어갔나 | 관측 |
|---|---|---|
| M-7 | `validateInstance`가 최상위 `if/then/else`와 `anyOf`를 평가 | 수정 전 검증기로 되돌려 새 오라클 2건이 FAIL(201/2)하고 수정 후 PASS(203/0)임을 확인 |
| C-3 | 세 L1+ 스키마의 `nodes`에 `minItems: 1` | 케이스 (19) — 코드뿐 아니라 위반 메시지에 `minItems(1)`이 들어 있는지까지 단언 |
| C-4 | 노드에 `verification{status,attempts,reasonCode}` 필드(required) + 조건부 제약 | 케이스 (21) — `refuted`인데 `attempts=0`·`reasonCode=null`인 자기모순이 FAIL |
| M-2 | 언어 린트가 `origin: "user"` 노드를 제외(`getValuesAtPath`가 `{value, container}` 반환) | `origin` 값 **하나만** 다른 픽스처 쌍 — `fixtures-valid/gap-report.json`(exit 0) ↔ 케이스 (20)(exit 1) |
| T3 | 제외 커밋의 `authorEmail`·`subject`·`coAuthors`를 기록 시점에 축소 + 스키마 조건부 강제 | 케이스 (22)(유출 원장 FAIL) + 스모크 (E) 4건(수집기가 실제로 축소하고, 본인 커밋은 축소하지 않으며, 관측용 필드는 남고, 대상이 비공허함) |

4게이트: `npm run lint` exit 0 / 스모크 **207** / `--negative` **23** / `--golden` **11**.

**스펙에만 적혔고 코드는 슬라이스 B가 만든다**(선언과 집행이 아직 분리돼 있음을 명시한다):
C-1(오염 스위트 실행 모델 — AC-8·구현 9단계), C-2(`--secret-scan`·`ARTIFACT_SECRET_LEAK` 소유
파일을 구현 7단계로 지정), M-1(allow-list 집행을 `verify-evidence.mjs` 소유로 지정, 구현 8단계),
M-3(노드 `id` 재사용 규칙 — 구현 7단계 (b), AC-16에 재실행 안정성 기준), M-4(`.bak` 1세대 —
AC-16 + 테스트 전략 동시 반영), M-5(`store.mjs` state/config IO 계약 + `writeJsonAtomic` 공유
추출 — 구현 7단계 (c)(d), `slice_plan.md`에 슬라이스 A 파일 수정 예외 3건 기록), M-6(산출물 쓰기
직전 자기 스키마 검증 — 구현 7단계 (a)), m-2(verify 호출 시 상위 계층 동반 — 구현 8단계 (b)),
m-3(렌더 계약 — 구현 7단계 파일 목록), m-4(오염 스위트 기반 픽스처 — 구현 9단계).

**아직 열려 있다:**

- **M-8(b) 도그푸딩 대상 레포가 여전히 미확정이다.** 구현 10단계에 "착수 전 확정해 이 자리에
  기재한다 — 현재 미확정"으로 적어 두었을 뿐, 실제 레포는 정해지지 않았다. 추측으로 이름을 채우지
  않았다.
- **m-1 `state.artifacts.evidence` 항목을 쓰는 주체가 여전히 없다.** 수집기는 `state.json`을 쓰지
  않는다. 구현 7단계의 레지스트리 갱신 규정이 career 계층만 다룬다.
- **C-3의 나머지 절반** — `verify-evidence`의 "인용 0건 = PASS" fail-open(콜드 리뷰 B-1)은 손대지
  않았다. 게이트 C-5로 남아 있으며 T3의 나머지(T4 포함) 반영과 같은 회차에 처리하는 것이 싸다.
- **AC-11 deny-list 스캔**(레포에서 저자 목록을 재도출해 산출물을 스캔)은 채택하지 않고 §6에
  미해결 항목으로 남겼다 — 오탐 특성과 대형 레포 비용이 측정되지 않았다.

---

## 우선순위 요약 (먼저 볼 4건)

| # | 항목 | 왜 먼저인가 |
|---|---|---|
| 1 | C-1 오염 스위트 LLM 10건의 **실행 주체가 없다** | AC-8은 이 제품의 유일한 FactChecker 실효성 측정 수단인데, 그 측정을 누가 실행하는지가 스펙에 없다. 구현 9단계 착수 시점에 "돌릴 수가 없다"로 막힌다. |
| 2 | C-2 「마스킹 우회 시크릿」 10건의 **판정 주체가 없다** | "기계 검증 3종 3회 모두 100%"의 3분의 1이 REJECT를 낼 코드 없이 선언돼 있다. 채점기가 없으면 이 카테고리는 항상 0% 또는 항상 100%다. |
| 3 | C-3 **빈손 출력이 3게이트를 전부 녹색으로 통과한다**(실측) | AC-13이 금지한 바로 그 결과가 슬라이스 A가 만든 모든 게이트를 통과한다. 스킬이 아무것도 못 만들어도 파이프라인은 성공으로 보고한다. |
| 4 | C-4 강등 상태를 담을 **필드가 정본 JSON에 없다** | AC-13의 '근거 부족 — 미검증' 배지를 마크다운에만 넣으면 §1의 "정본은 JSON, 마크다운은 렌더 뷰"와 정면 충돌하고, 재실행이 "이미 2회 실패"를 알 수 없어 재시도 상한이 무의미해진다. |

---

# A. 착수 차단 — Critical (4건)

## C-1. `node tests/run-smoke.mjs --contamination`이 LLM 판정 10건을 실행할 방법이 스펙에 없다 — Critical

- **위치**: `spec.md` 구현 9단계, AC-8, 테스트 전략 [최우선] 오염 주입 테스트
- **관측**: `tests/run-smoke.mjs`는 3,300여 줄의 **의존성 0 순수 Node 스크립트**이고 LLM 호출
  경로가 0곳이다(`grep -rn 'contamination' tests/ scripts/ package.json` → 히트 1건, 그것도
  `scripts/lib/redact.mjs:11`의 주석 언급뿐). 현재 지원 플래그는 기본 / `--negative` /
  `--golden` 3종이다.
- **실패 시나리오**: 구현 9단계 착수 → `--contamination` 플래그를 만든다 → 40건 중 기계 검증
  30건은 `verify-evidence.mjs`를 호출해 채점할 수 있다 → **'근거 없는 주장' 10건은 FactChecker
  (LLM 2단)의 판정이 있어야 채점되는데, Node 스크립트가 LLM을 부를 수단이 스펙 어디에도 정의돼
  있지 않다.** 이 플러그인은 Claude Code 세션 안에서 사람이 슬래시 명령으로 부르는 구조이고,
  `package.json`은 의존성 0이며 API 키 취급 규약도 없다. 결과적으로 구현자는 세 갈래 중 하나를
  즉흥 선택하게 된다 — (a) LLM 카테고리를 조용히 빼고 30건으로 채점(분모 40 고정 규칙 위반),
  (b) 사람이 스킬을 3회 수동 실행해 산출물을 파일로 떨궈 두고 스크립트는 채점만 수행(스펙의
  "`--contamination`을 연속 3회 실행한다"와 다른 절차), (c) `claude -p` 류를 셸 아웃(의존성·
  재현성·비용 전제가 전부 바뀜). **어느 쪽이든 AC-8의 "3회 최저값 80%"는 절차가 다른 지표가
  되고, 그 지표가 이 제품의 유일한 FactChecker 실효성 측정 수단이다.**
- **수정안**: 구현 9단계에 **실행 모델을 명문화**한다. 권장은 (b)의 정형화다 — ① 스킬 실행과
  채점을 분리해 `--contamination`은 **채점기 전용**으로 정의하고, 입력은
  `tests/contamination/runs/<run-id>/`에 놓인 산출물 3세트임을 못 박는다. ② 산출물 생성은
  사람이 수행하는 절차로 기록하고(어떤 픽스처 레포·어떤 명령·몇 회), 그 절차 자체를
  `tests/contamination/README.md`에 고정한다. ③ 기계 검증 30건은 LLM 없이 `--contamination`
  단독으로 돌 수 있게 분리해 CI 가능 부분과 사람 개입 부분의 경계를 스펙에 적는다. ④ AC-8의
  "연속 3회 실행"이 **무엇의** 3회인지(스킬 실행 3회지 채점 3회가 아니다) 문장을 고친다.

## C-2. 「마스킹 우회 시크릿」 10건에 REJECT를 낼 기계 검증기가 존재하지 않는다 — Critical

- **위치**: `spec.md` 구현 9단계, AC-8("기계 검증 항목(가짜 해시, 타 저자 인용, 마스킹 우회)은
  결정적이므로 3회 모두 종당 100%"), AC-11
- **관측**: `grep -ni 'redact|secret|mask' scripts/verify-evidence.mjs` → **0건**. 인용 무결성
  검증기에 시크릿·마스킹 축이 없다. `scripts/lib/redact.mjs`는 **수집기(`collect-git-facts.mjs`)
  가 원장을 쓸 때** 적용하는 마스킹 함수이지, 산출물에서 시크릿을 **탐지해 REJECT를 내는**
  검사기가 아니다. AC-11이 요구하는 "어떤 산출물에도 포함되지 않는다"는 테스트 안의 문자열
  검색이지 프로덕션 게이트가 아니다.
- **실패 시나리오**: 구현 9단계에서 마스킹 우회 케이스 10건을 만든다 → 채점 규약은 "케이스별
  기대 REJECT 사유 문자열과의 일치"인데, **그 사유 문자열을 출력하는 코드가 없다.** 구현자는
  채점기 안에 즉석 문자열 검색을 넣게 되고, 그 순간 이 카테고리는 **테스트가 자기 자신을
  채점하는** 구조가 된다 — 프로덕션 경로에는 아무 방어도 추가되지 않았는데 게이트는 100%로
  녹색이 된다. 이 세션이 이미 세 번 겪은 자기충족 테스트의 네 번째 사례가 된다.
- **수정안**: ① 마스킹 우회 탐지를 **프로덕션 검사 지점**으로 승격한다 — `redact.mjs`의 패턴을
  재사용하는 `--secret-scan <artifact>` 모드를 `validate-plugin.mjs`(또는 `verify-evidence.mjs`)
  에 추가하고 위반 시 고유 오류 코드(`ARTIFACT_SECRET_LEAK`)로 exit 1을 낸다. ② 그 검사 지점을
  구현 9단계가 아니라 **구현 7단계(산출물을 처음 만드는 지점)의 파일 목록**에 넣는다 — 검사기가
  스위트보다 먼저 있어야 스위트가 검사기를 관측한다(슬라이스 A에서 배운 "하네스를 먼저" 순서와
  동일). ③ `redact.mjs`의 "40자 hex 커밋 SHA는 마스킹하지 않는다" 단언이 이 새 검사 지점에도
  적용됨을 negative + positive 양방향 픽스처로 고정한다 — 오탐 회귀는 정탐 테스트로 절대 잡히지
  않는다(`cold_review.md` A-10과 동일 근거).

## C-3. 「빈손 출력」이 슬라이스 A가 만든 3게이트를 전부 녹색으로 통과한다 — Critical · 실측

- **위치**: AC-13("빈손 출력이 발생하지 않고"), §3("아무것도 출력하지 않는 경로는 금지한다"),
  `schemas/career.schema.json`·`knowledge-map.schema.json`·`gap-report.schema.json`의
  `properties.nodes`
- **관측(실측)**: `tests/fixtures-valid/career.json`의 `nodes`를 `[]`로 바꾼 산출물 하나로 세
  게이트를 전부 통과시켰다.

  ```
  node scripts/validate-plugin.mjs --schema-check <caseA>/career.json   → [PASS] exit 0
  node scripts/validate-plugin.mjs --lang-check   <caseA>               → [PASS] exit 0
  node scripts/verify-evidence.mjs --repo . --evidence <ev>/evidence.json \
       --identity <me> --artifact career=<caseA>/career.json
      → citations: total=0 pass=0 fail=0 toolError=0
        layerRefs: unresolved=0 unverifiable=0
        [PASS] exit 0
  ```

  세 스키마 모두 최상위 `nodes` 배열에 `minItems`가 없다.
- **실패 시나리오**: FactChecker가 전 항목을 반증했거나, 스킬이 조용히 실패했거나, LLM이 빈
  배열을 냈을 때 — **AC-13이 금지한 정확히 그 결과가 모든 기계 게이트에서 성공으로 보고된다.**
  더 나쁜 조합은 인용 검증기의 "0건 검증 = PASS" 성질(`cold_review.md` B-1, 미반영)과 곱해질
  때다: 인용이 0건이면 검증할 것이 없어 `[PASS]`가 나오므로, **산출물이 비어 있을수록 파이프라인
  전체가 더 확실하게 녹색이 된다.** 게이트가 품질과 역상관인 구간이 존재한다.
- **수정안**: ① 세 스키마의 `nodes`에 `minItems: 1`을 넣는다(스키마 레벨 강제 — AC-12가 이미
  택한 방식과 동일). ② AC-13에 관측 가능한 기준을 추가한다: "FactChecker 2회 실패를 인위
  유발한 픽스처에서 산출물의 `nodes.length >= 1`이고, 그중 최소 1건이 강등 표시를 갖는다".
  ③ `verify-evidence.mjs`가 `citations.total === 0`인 산출물을 `[PASS]`가 아니라 명시적
  `INCONCLUSIVE`(exit 2)로 보고하도록 바꾼다 — 이는 콜드 리뷰 B-1의 fail-open 수정과 같은
  지점이므로 **T3 반영과 함께 처리하면 중복 작업이 없다.**

## C-4. FactChecker 강등 상태를 담을 필드가 정본 JSON에 없고, `additionalProperties: false`가 추가를 막는다 — Critical

- **위치**: AC-13, §1("정본은 JSON, 마크다운은 렌더된 뷰다"), §3(재생성 최대 2회 → 항목 단위
  강등), `schemas/career.schema.json` `$defs.careerNode`
- **관측**: `careerNode`의 프로퍼티는 `id`/`basis`/`evidence`/`origin`/`locked`/`text`/
  `period`/`skills` 8개가 전부이고 `additionalProperties: false`다. `basis` enum은
  `commit|inference|external|insufficient` 4종. **"FactChecker가 2회 반증해 강등됨"을 기록할
  자리가 없다.**
- **실패 시나리오**: 구현자는 두 갈래 중 하나를 즉흥 선택한다. (a) 강등을 `basis:
  "insufficient"`로 뭉갠다 → **애초에 근거가 없던 노드와 "검증을 시도했고 반증당한" 노드가
  구별되지 않는다.** 재실행 시 스킬은 그 노드가 이미 2회 실패했음을 알 수 없으므로 재시도
  상한이 실행 간에 리셋되고, §3이 막으려던 "재시도 루프에 갇혀 사용자가 빈손이 되는" 경로가
  실행 단위로 되살아난다. (b) 배지를 렌더 마크다운에만 넣는다 → **§1의 "정본은 JSON,
  마크다운은 렌더된 뷰"가 깨진다.** 마크다운에만 있는 정보는 재실행에서 소실되고, 스키마
  검증·언어 린트·인용 검증 어느 것도 그 배지를 보지 못한다.
- **수정안**: 구현 2단계 스키마를 **슬라이스 B 착수 전에** 개정한다. `careerNode`(및 knowledge/
  gap 노드)에 검증 상태 필드를 신설하고 값 계약을 description에 못 박는다 — 예:
  `verification: { status: "verified"|"refuted"|"not-attempted", attempts: integer,
  reasonCode: string|null }`. ① `status: "refuted"`가 렌더 배지 '근거 부족 — 미검증'의 **유일한
  정본 근거**가 되게 한다. ② AC-13에 "강등된 노드는 `verification.status == "refuted"`이고
  `attempts == 2`"를 관측 기준으로 넣는다. ③ `basis`와 `verification`의 관계를 명시한다 —
  강등이 `basis`를 바꾸는지(권장: 바꾸지 않는다, 두 축은 직교한다) 확정하지 않으면 AC-12의
  if/then과 충돌한다.

---

# B. Major (8건)

## M-1. `references/sources.json` allow-list를 집행할 코드의 소유 파일이 구현 8단계 파일 목록에 없다 — Major

- **위치**: `spec.md` 구현 8단계("basis 필드 강제와 allow-list 밖 URL 거부를 정적 린트로
  검증"), `schemas/knowledge-map.schema.json:136`
- **관측**: 스키마 description이 스스로 "allow-list 대조는 **스크립트가 런타임에 검사**하며 이
  스키마는 형식만 검사한다"고 선언한다. 그런데 `grep -rn 'sources.json|allow-list' scripts/` →
  **0건**이고, 구현 8단계의 파일 목록은 `SKILL.md` 2종 + 템플릿 2종 + `references/sources.json`
  + 스키마 3종이다 — **집행 코드가 들어갈 스크립트 파일이 한 개도 없다.**
- **왜 중요한가**: 이것은 `cold_review.md` A-9(「`redact.mjs`가 어디서도 import되지 않는 죽은
  코드인데 README·스키마는 마스킹이 적용된다고 약속한다」)와 **정확히 같은 형태**다. 그 결함은
  이미 한 번 이 레포에서 발생했고 T2에서 닫았다. 같은 형태가 스펙 단계에서 다시 예고돼 있다.
- **수정안**: 구현 8단계 파일 목록에 집행 지점을 명시한다 — `validate-plugin.mjs`에
  `--schema-check`와 같은 격의 CLI 모드(예: `--refs-check <artifact>`)를 추가하거나,
  `verify-evidence.mjs`의 검증 축에 `external` basis 노드의 URL allow-list 대조를 넣는다.
  후자가 낫다: 이미 산출물을 계층별로 읽고 있고 REJECT 사유 코드 체계를 갖고 있다. 어느 쪽이든
  **스키마 description의 "스크립트가 런타임에 검사한다"가 가리키는 파일 이름을 스펙에 적는다.**

## M-2. AC-19 언어 린트가 사용자 입력 필드에 무차별 적용된다 — 사용자가 영어로 쓰면 산출물이 FAIL 한다 — Major · 실측

- **위치**: AC-19, `schemas/gap-report.schema.json` `gapNode.selfAssessment`(`x-freeText: true`),
  `scripts/lib/lang-lint.mjs`
- **관측(실측)**: `origin: "user"` · `locked: true` 노드에 사용자가 영어로 쓴 자가진단을 넣고
  린트를 돌렸다.

  ```
  node scripts/validate-plugin.mjs --lang-check <caseB>
  → [FAIL] FREETEXT_ENGLISH_DETECTED: 필드 'nodes[].selfAssessment' 값이 한글 없이
    4토큰 이상 서술형입니다: "I have only used it from the consumer side and never
    tuned rebalancing." (gap-report.json)
    exit 1
  ```

- **실패 시나리오**: AC-19의 목적은 **LLM의 영어 누수**를 잡는 것이다(전역 규약: "언어 누수는
  스타일 문제가 아니라 버그다"). 그런데 `selfAssessment`는 스펙이 **사용자 입력으로 정의한
  필드**이고(구현 8단계 "GapAnalyzer가 사용자 자가진단과 대조해"), `origin: "user"` 노드의
  `text`도 사용자가 편집 루프에서 직접 쓰는 값이다. 영어로 자가진단을 쓴 사용자는 자기 산출물이
  게이트에서 떨어지는 것을 보게 되고, 회피 방법은 "게이트를 끄는 것"뿐이다 —
  리스크 절이 지목한 **"검증을 끄는 방향으로 우회한다"** 경로 그대로다.
- **수정안**: ① AC-19에 `origin: "user"` 노드 제외 규칙을 넣는다(판정 대상은 `origin:
  "generated"`인 노드의 free-text로 한정). ② 또는 `selfAssessment`의 마커를 `x-freeText`에서
  제외하고 그 근거를 description에 적는다. ③ 어느 쪽이든 **`tests/fixtures-valid/`에
  「사용자가 영어로 쓴 `origin: user` 노드」 positive 픽스처를 추가**해 이 오탐이 회귀로
  잡히게 한다 — 현재 positive 픽스처는 `x-termField` 오탐만 덮는다.

## M-3. L1+ 노드 `id`의 파생 규칙이 없어 재실행 간 id 안정성이 보장되지 않는다 — AC-16의 locked 보존이 그 위에 서 있다 — Major

- **위치**: AC-16, `schemas/career.schema.json` `careerNode.id`(`pattern: "^[A-Za-z0-9:_-]+$"`
  뿐), 구현 7단계("사용자 편집 병합(contentHash 편집 감지 + locked 노드 보존)")
- **실패 시나리오**: id를 만드는 주체는 CareerWriter(LLM)다. 스펙은 형식만 정하고 **도출
  규칙을 정하지 않았다.** 재실행에서 같은 사실 항목이 `career:001` → `career:003`으로 바뀌면
  병합 로직은 그것을 "옛 노드 삭제 + 새 노드 추가"로 본다 → **`locked: true`로 잠근 사용자
  편집분이 고아가 되거나 유실된다.** 리스크 절이 "사용자를 가장 확실하게 이탈시키는 데이터 유실
  사고"로 분류한 바로 그 경로이고, `locked` 필드는 그것을 막으려고 존재하는데 **그 필드의 결합
  키가 비결정적이다.**
- **수정안**: ① 병합 키를 `id`가 아니라 **결정적으로 재계산 가능한 값**으로 정한다 — 예:
  인용 원장 ID 집합 + 정규화한 topic의 해시. ② 그것이 어려우면 최소한 "재생성 시 기존
  `career.json`을 읽어 **기존 id를 우선 재사용**하고 신규 항목에만 새 id를 부여한다"를 구현
  7단계에 명문으로 넣고, 그 프롬프트 규약을 템플릿 상단에 고정한다. ③ AC-16에 관측 기준을
  추가한다: "같은 원장으로 2회 생성 시 동일 사실 항목의 id가 동일하다" — 없으면 이 성질은
  구현 후에도 아무도 확인하지 않는다.

## M-4. `.bak` 보존이 어떤 AC에도 없다 — 소유 조항 없는 요구 — Major

- **위치**: 테스트 전략 [데이터 보존]("강행 시 .bak 보존 확인"), 리스크 「사용자 수정분
  덮어쓰기」("강행 시 .bak 보존"), **AC-16 본문에는 없음**
- **실패 시나리오**: AC-16은 "확인 게이트가 뜨고 locked 노드는 재생성에서 보존된다"까지만
  요구한다. 구현자가 AC만 보고 만들면 `.bak`은 만들어지지 않고, 테스트 전략만 보고 만들면
  AC에 근거가 없어 게이트에서 빠진다. **두 문서가 서로 다른 완료 조건을 말하는 상태**이며,
  이 프로젝트가 round 1~6 내내 닫아 온 "선언과 집행의 드리프트"와 동종이다.
- **수정안**: AC-16 본문에 `.bak` 보존을 넣고(파일명 규약 포함 — 예 `career.json.bak`, 1세대만
  유지), 테스트 전략 [데이터 보존]과 문자열을 맞춘다. 또는 `.bak`을 P1로 내리고 **두 문서에서
  동시에 지운다.** 남겨 두되 한쪽에만 적는 상태만 금지한다.

## M-5. state.json·config.json의 IO 계약이 없고, 원자적 쓰기 헬퍼가 기본적으로 중복 구현된다 — Major

- **위치**: 구현 7단계("state.json 산출물 레지스트리 갱신 … temp→rename"), 구현 8단계
  ("state.json 레지스트리로 상위 산출물 파일 경로를 찾고"), AC-15·AC-16·AC-22,
  `scripts/lib/store.mjs`
- **관측**: `store.mjs`의 export는 `STATE_DIR_NAME` + 경로 해석 함수 7개가 전부다 —
  **state.json·config.json을 읽거나 쓰는 함수가 0개.** 원자적 쓰기 헬퍼 `writeJsonAtomic`은
  `scripts/collect-git-facts.mjs:539`에 **비-export 로컬 함수**로 있다.
- **실패 시나리오**: 구현 7단계 구현자는 `writeJsonAtomic`을 복사해 쓰거나 자기 버전을 새로
  만든다. 그 순간 temp→rename 규약이 두 곳에 구현되고, `cold_review.md` A-21(「§7 정본 git
  프리픽스와 3분류가 프로덕션에 두 곳 구현돼 있고 `store.mjs` 사본은 어떤 게이트도 밟지
  않는다」)이 스킬 계층에서 재현된다. 또한 config.json 스키마의 경로 필드는 "저장 루트 기준
  상대 경로"인데(AC-15), 그 상대화·역상대화를 수행하는 함수가 없으므로 각 스킬이 제각기
  `path.relative`를 부른다 — Windows 백슬래시 혼입이 여기서 들어온다.
- **수정안**: 구현 7단계 파일 목록의 `scripts/lib/store.mjs`에 **API 계약을 스펙에 적는다** —
  `readState()`/`writeState()`/`readConfig()`/`writeConfig()`와 `toStorageRelative(p)`/
  `fromStorageRelative(p)`, 그리고 `writeJsonAtomic`을 `collect-git-facts.mjs`에서
  `store.mjs`(또는 별도 `lib/atomic.mjs`)로 **끌어올려 단일 구현으로 공유**한다. 슬라이스 A의
  스크립트를 "소비만 하고 수정하지 않는다"는 슬라이스 경계와 충돌하므로, **이 헬퍼 추출은
  슬라이스 B의 명시적 예외로 `slice_plan.md`에 적어 둔다**(적지 않으면 구현자가 경계를 지키려고
  복사본을 만든다).

## M-6. `--schema-check`가 파일 1개 전용이고, 스킬이 그것을 언제 호출하는지 스펙에 없다 — Major

- **위치**: 구현 3단계(`--schema-check <path>`), 구현 7·8단계, AC-12
- **관측**: `validate-plugin.mjs --schema-check`는 단일 파일 경로를 받아 파일명으로 스키마를
  고른다. 반면 스킬 한 번의 실행은 career.json(7단계) 또는 knowledge-map.json + gap-report.json
  (8단계)을 만들고, 8단계는 추가로 state.json을 갱신한다.
- **실패 시나리오**: 스펙은 구현 7·8단계의 「검증 영향」에 "픽스처 레포로 엔드투엔드 실행 후
  verify-evidence 통과 확인"이라고만 적었을 뿐, **스킬이 자기 산출물을 스키마로 검증하는
  호출을 하라고 요구하지 않는다.** 그러면 스키마 위반 산출물이 디스크에 쓰인 뒤에야(또는
  영영) 발견된다 — AC-12의 "스키마 레벨 강제"가 프로덕션 경로에서 옵션이 된다.
- **수정안**: ① 구현 7·8단계 본문에 "산출물 쓰기 **직전** `validateInstance`로 자기 검증하고
  위반 시 쓰지 않는다"를 넣는다(파일이 아니라 메모리 객체를 검증하므로 `--schema-check` CLI가
  아니라 `scripts/lib/schema-validate.mjs`를 직접 import 하는 편이 맞다). ② `--schema-check`에
  디렉터리 인자를 허용해 한 실행의 산출물 전부를 한 번에 검증할 수 있게 한다(`--lang-check`가
  이미 디렉터리를 받는다 — 두 모드의 인자 형태가 다른 것 자체가 사용 시 혼선이다).

## M-7. 자작 스키마 검증기가 `anyOf`와 최상위 `if/then`을 평가하지 않아, 슬라이스 B가 새로 넣는 제약이 조용히 죽는다 — Major

- **위치**: `scripts/lib/schema-validate.mjs`(`KNOWN_SCHEMA_KEYWORDS`에 `anyOf`·`if`·`then`·
  `else`가 있으나 `validateInstance`는 `oneOf`와 `allOf[].if/then`만 평가한다),
  `cold_review.md` A-28(Minor, **T4 미반영**)
- **왜 슬라이스 B에서 승격되는가**: 콜드 리뷰 시점에는 "현재 스키마가 그 형태를 안 쓰므로
  실피해 없음"이라 Minor였다. 그러나 **슬라이스 B는 스키마에 새 제약을 넣는 슬라이스다** —
  C-4의 `verification` 필드, M-2의 `origin` 분기, C-3의 `minItems`가 전부 조건부 제약이다.
  구현자가 자연스럽게 최상위 `if/then`이나 `anyOf`로 쓰면 **경고도 오류도 없이 통과하고**,
  그 제약은 처음부터 존재하지 않은 것이 된다. "현재 형태를 안 쓰니 괜찮다"는 근거가
  슬라이스 B에서 소멸한다.
- **수정안**: ① 슬라이스 B 착수 전에 `validateInstance`에 최상위 `if/then/else`와 `anyOf`
  평가를 추가한다(T4에서 따로 하지 말고 **여기로 당긴다**). ② 그것을 미루려면 최소한
  `scanUnsupportedKeywords`가 "선언은 됐으나 평가되지 않는 키워드"를 별도 경고로 내도록 바꿔
  구현자가 즉시 알게 한다. ③ 새 제약을 넣을 때마다 **그 제약이 실제로 FAIL을 내는 것을
  관측**한다(negative 픽스처 1건) — 이 레포의 `Do NOT` 「자기충족 테스트를 만들지 마라」가
  요구하는 절차다.

## M-8. AC-20의 도그푸딩 대상 레포가 아직 확보되지 않았고, 그 실행이 T3(타인 커밋 PII)를 실제로 발생시킨다 — Major

- **위치**: AC-20, 구현 10단계, §8, 리스크 「도그푸딩 대상 빈약」, `cold_review.md` B-2
- **관측**: 리스크 절은 "200커밋 이상 다중 저자·실제 한글 커밋 메시지가 있는 외부 레포를 **지금
  확보**해"라고 적었으나 확보 여부를 기록한 문서가 없다. 후보로 거명된 두 레포는 각각 결격
  사유가 함께 적혀 있다(pass-migration은 문서 비중 과다, pass-api-be는 사용자 커밋 9개).
- **실패 시나리오**: 구현 10단계에 도달해서야 대상이 없음을 발견하면 단계가 통째로 막힌다.
  더 중요한 것은 **순서 문제**다 — 도그푸딩은 정의상 실제 동료가 커밋한 사내 레포에서 돌리는
  것이고, 콜드 리뷰 B-2가 지적한 "제외 커밋 전량 등재로 동료 이메일·커밋 제목·경로가 산출물에
  들어간다"가 **그 순간 픽스처가 아니라 실제 타인 PII로 발생한다.** 핸드오프의 Blockers도 T3를
  "스펙 위반이 아니라 스펙 구멍"으로 분류했다.
- **수정안**: ① 도그푸딩 대상 레포를 **슬라이스 B 착수 시점에 확정해 문서에 적는다**(이름·
  커밋 수·저자 수·공개 여부). ② **T3 설계 재검토를 구현 10단계보다 앞에 배치한다** — 핸드오프
  Next Steps 4번이 "슬라이스 B 스킬 설계와 함께 다루는 것이 자연스럽다"고 적은 것과 같은
  결론이고, 여기서는 더 강하게 **선행 조건**으로 둔다. ③ 그 재검토는 `spec.md` §6 개정을
  동반하므로(제외 커밋의 어떤 필드를 원장에 남기고 어떤 필드를 산출물·LLM 컨텍스트로 내보낼
  것인가), **`excluded` 커밋의 원장 전량 등재는 유지하되 "원장 → LLM 컨텍스트" 경계에서
  필드를 줄이는 방향**을 우선 검토한다 — AC-7·AC-9의 관측 가능성은 원장에 걸려 있지 산출물에
  걸려 있지 않다.

---

# C. Minor · 관찰 (4건)

## m-1. `state.artifacts.evidence` 항목을 쓰는 주체가 없다 — Minor

`schemas/state.schema.json`은 `artifacts.evidence`를 정의하지만, 원장을 만드는
`collect-git-facts.mjs`는 state.json을 쓰지 않는다(`grep` 실측: `state.json`을 쓰는 코드
0곳). 구현 7단계는 "career.json 저장 직후 레지스트리 갱신"만 규정한다. 원장 항목은 누가 언제
채우는지 정하거나, 필드를 지우거나, "career-from-git이 수집 직후 함께 기재한다"를 명시해야
한다. 지금 상태로는 AC-22의 스테일 판정이 evidence 계층에 대해서는 근거를 못 찾는다.

## m-2. skill-gap이 상위 산출물을 함께 넘기지 않으면 AC-14가 `unverifiable`로 빠진다 — Minor

`verify-evidence.mjs`의 `checkLayerRefs`는 상위 계층 산출물이 **이번 호출에 제공되지 않으면**
`LAYER_REF_PARENT_ARTIFACT_NOT_PROVIDED`로 분류해 검증을 건너뛴다. 구현 8단계가
knowledge-map만 넘기고 career를 빼면 AC-14("미해결 참조 0건")가 참이 아니라 **미검증**인데
리포트상으로는 위반 0건이다. 구현 8단계에 "verify 호출 시 career/knowledge-map/gap-report를
항상 함께 넘긴다"(또는 `--out-dir` 사용)를 명문으로 넣을 것.

## m-3. `render-markdown.mjs`의 내용 계약이 스펙에 0줄이다 — Minor

구현 7단계 파일 목록에 있을 뿐, 마크다운이 무엇을 반드시 포함해야 하는지 규정이 없다.
AC-10("모든 산출물 헤더에 커버리지 메타데이터 … 기재율 100%가 정적 린트로 검증된다")이
렌더 마크다운에도 적용되는지 불명확하고, C-4의 '근거 부족 — 미검증' 배지·§4의 절단 고지·
한계 고지가 사용자 눈에 닿는 유일한 표면이 바로 이 마크다운이다. 최소한 "커버리지 3수치 +
`truncated` + 노드별 근거 등급 배지를 반드시 렌더한다"를 구현 7단계에 적고, 렌더 결과에 대한
검사 1건(문자열 존재 확인)을 테스트 전략에 넣을 것.

## m-4. 오염 스위트 40건이 **어느 레포·어느 원장 위에** 주입되는지 미지정 — Minor

(17) 케이스는 "merge 픽스처 위에 인위 주입"이라고 명시했지만, 40건의 기반은 적혀 있지 않다.
가짜 해시 10건은 아무 원장에서나 되지만, "타 저자 커밋 인용" 10건은 **실제로 타 저자 커밋이
존재하는 원장**이 있어야 (a)축이 의미를 갖는다. 300커밋 픽스처(봇·타 저자·머지 포함)를 기반으로
지정하는 것이 자연스럽다 — 구현 9단계에 명시할 것.

---

# ■ 착수 전 게이트 체크리스트

`plan_critic_findings.md`의 관례를 따른다. **이 문서에서 가장 실행 가능한 부분이다.**

## □ 게이트 A — 스키마 개정 (구현 7단계 코드 작성 전)

- [ ] A-1. 세 L1+ 스키마의 `nodes`에 `minItems: 1` 추가 — **C-3**
- [ ] A-2. 노드에 `verification` 계열 필드 신설, `basis`와의 관계 명시 — **C-4**
- [ ] A-3. `validateInstance`에 최상위 `if/then/else`·`anyOf` 평가 추가(또는 미평가 경고) —
      **M-7**. A-1·A-2가 이 수정 없이 들어가면 새 제약이 조용히 죽을 수 있다. **A-3을 A-1·A-2보다
      먼저 한다.**
- [ ] A-4. AC-19의 `origin: "user"`/`selfAssessment` 제외 규칙 확정 + positive 픽스처 추가 —
      **M-2**
- [ ] A-5. 각 신규 제약이 **실제로 FAIL을 내는 것을 관측**(negative 픽스처 1건씩). 관측 없이
      다음 게이트로 넘어가지 않는다.

## □ 게이트 B — 라이브러리 계약 (구현 7단계 착수 시)

- [ ] B-1. `store.mjs`에 state/config IO + 상대경로 변환 API 확정 — **M-5**
- [ ] B-2. `writeJsonAtomic`을 공유 위치로 추출하고, 그 예외를 `slice_plan.md`에 기록 — **M-5**
- [ ] B-3. 노드 `id` 병합 키 규칙 확정 + AC-16에 재실행 안정성 관측 기준 추가 — **M-3**
- [ ] B-4. `.bak`을 AC-16에 넣거나 두 문서에서 동시에 삭제 — **M-4**
- [ ] B-5. 산출물 쓰기 직전 자기 스키마 검증을 구현 7·8단계 본문에 명문화 — **M-6**

## □ 게이트 C — 검사 지점 (구현 9단계 착수 **전**)

- [ ] C-1. 마스킹 우회 탐지를 프로덕션 검사 지점으로 승격하고 **구현 7단계 파일 목록**으로
      앞당긴다 — **C-2**. 검사기가 스위트보다 먼저 있어야 스위트가 검사기를 관측한다.
- [ ] C-2. allow-list 집행 코드의 소유 파일을 구현 8단계 파일 목록에 추가 — **M-1**
- [ ] C-3. `--contamination`의 실행 모델(스킬 실행 주체 / 채점 주체 / 3회의 대상)을 스펙에
      명문화 — **C-1**
- [ ] C-4. 40건의 기반 픽스처·원장 지정 — **m-4**
- [ ] C-5. `verify-evidence`의 `citations.total === 0` → `INCONCLUSIVE` 변경을 T3 반영과 함께
      처리 — **C-3**(콜드 리뷰 B-1과 동일 지점)

## □ 게이트 D — 도그푸딩 (구현 10단계 착수 전, 그러나 **결정은 지금**)

- [ ] D-1. 대상 레포 확정·기록(이름·커밋 수·저자 수·공개 여부) — **M-8**
- [ ] D-2. **T3(타인 커밋 PII) 설계 재검토를 구현 10단계보다 앞에 완료**하고 `spec.md` §6을
      개정 — **M-8**. 도그푸딩은 실제 동료 PII가 처음으로 실물로 흐르는 지점이다.

---

## 부록 — 이 심사가 확인했고 문제가 없었던 축

정직하게 남긴다 — "지적 0건"이 "안 봤음"인지 "보고 괜찮았음"인지 구분하기 위해서다.

- **AC-12의 스키마 레벨 강제는 실제로 작동한다.** `careerNode`/`knowledgeNode`/`gapNode` 모두
  `allOf[].if/then`으로 「`evidence` 빈 배열 → `basis: insufficient`」를 걸고 있고,
  `validateInstance`는 `allOf` 안의 `if/then`을 **평가한다**(소스 확인). M-7의 미평가 범위는
  최상위 `if/then`과 `anyOf`에 한정된다.
- **`parentRefs`의 비공허성은 스키마에 선언돼 있다** — knowledge-map·gap-report 모두
  `parentRefs`에 `minItems: 1`이 있어, 참조를 0개 달아 AC-14를 공허하게 통과하는 경로는 막혀
  있다. (같은 원리가 최상위 `nodes`에는 적용돼 있지 않다 — 그것이 C-3이다.)
  **정정(반영 작업 중 확인):** 처음 이 항목을 "이미 닫혀 있다"고 적었는데 그건 과대 진술이었다 —
  `parentRefs: []`를 넣어 그 제약이 실제로 FAIL을 내는지 확인하는 픽스처가 이 레포에 **0건**이다.
  즉 이 제약도 "선언은 됐으나 관측되지 않은" 상태이며, C-3이 `nodes.minItems`에 대해 지적한 것과
  같은 종류다. 관측 픽스처를 추가하는 것은 슬라이스 B로 남긴다.
- **계층별 `basis` 제약이 §3·리스크와 일치한다.** knowledge-map과 gap-report의 `basis` enum에
  `commit`이 없다(3종만). 「git에 존재하지 않는 사실에 커밋 근거를 달 수 없다」는 설계 결정이
  스키마로 집행되고 있다.
- **`state.schema.json`이 AC-22의 진실 원천 규약을 지키고 있다.** `artifactEntry`는
  `path`/`schemaVersion`/`generatedBySkill` 3필드뿐이고 `sourceRepoHead`·`contentHash`가
  없다 — 진실 원천을 산출물 파일 하나로 유지하라는 조항과 정확히 일치한다.
- **`careerNode.skills[]`는 `x-termField`로 표시돼 있다.** 기술 용어 배열이 언어 린트에서
  오탐되지 않는다(`tests/fixtures-valid/career.json`이 이 경로를 positive로 덮고 있다).
- **`config.schema.json`이 §4의 P0 예산 단일 축을 지키고 있다.** `budget`에 `maxCommits`
  하나뿐이고 샘플링 비율 상수가 파라미터로 노출돼 있지 않다.
