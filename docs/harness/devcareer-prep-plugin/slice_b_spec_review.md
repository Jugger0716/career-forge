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

> **정정 — 이 절의 첫 판이 과대 진술이었다.** 처음에는 아래 표를 "각 항목마다 위반을 넣어 실제로
> FAIL이 나는 것을 확인"으로 적었다. 반영 직후 돌린 적대 검증이 그것을 반증했다: 게이트 A가 넣은
> 스키마 제약 약 35개 중 **위반을 넣었을 때 실제로 게이트를 빨갛게 만드는 것은 3개뿐**이었고
> (career의 `nodes.minItems`, career의 refuted 조건절, evidence의 excluded PII 절), 나머지 32개는
> 전부 지워도 4게이트가 녹색으로 남았다. 영역당 한 번씩 변이를 돌렸을 뿐 **절 단위로는 돌리지
> 않은** 것이 원인이다. 이 레포의 절대 규칙("FAIL이 안 나면 그 검사는 없는 것")과 이 문서 자신이
> 정한 게이트 A-5("관측 없이 다음 게이트로 넘어가지 않는다")를 내가 어겼다. 아래는 그 지적을
> 반영해 관측 공백을 메운 뒤의 상태다. 적대 검증이 찾아낸 것 중 특히 무서웠던 두 가지:
> **(1) T3의 `coAuthors` 축소는 수집기·스키마 양쪽이 모두 미관측이라 축소를 통째로 되돌려도
> 4게이트가 전부 녹색이었다**(유일한 관측 지점이 쓰던 픽스처에 Co-authored-by 트레일러를 가진
> 커밋이 0건이라 단언이 항상 공허하게 참이었다). **(2) 언어 린트의 `origin` 제외를 "노드 하나가
> user면 파일 전체를 건너뛴다"로 넓히는 변이가 그대로 생존했다** — 픽스처 쌍이 `origin` 값만
> 달랐지 두 값을 **한 파일 안에** 담지 않았기 때문이다.

**코드로 닫혔고 절 단위로 관측된다:**

| 항목 | 무엇이 들어갔나 | 관측 |
|---|---|---|
| M-7 | `validateInstance`가 최상위 `if/then/else`와 `anyOf`를 평가 | 수정 전 검증기로 되돌려 오라클이 FAIL(201/2)하고 수정 후 PASS임을 확인. `else` 분기도 위반/준수 양방향으로 관측 |
| C-3 | 세 L1+ 스키마의 `nodes`에 `minItems: 1` | 케이스 (19)(career, 메시지에 `minItems(1)`까지 단언) + 절 오라클이 세 계층 각각에 대해 관측 |
| C-4 | 노드에 `verification{status,attempts,reasonCode}`(required) + 조건절 3종 | 케이스 (21) + 절 오라클 12건 × 3계층 — `required`·`enum`·`minimum`·`maximum`·`pattern`·`additionalProperties`·조건절 3종을 각각 개별 변이로 관측 |
| M-2 | 언어 린트가 `origin: "user"` 노드를 제외 | 세 방향 — user 영문이 통과(career·gap-report positive), generated 영문은 FAIL(케이스 7·20), **한 파일에 둘을 함께 담은 케이스 (20)**이 파일 단위 과잉 제외를 잡는다 |
| T3 | 제외 커밋의 `authorEmail`·`subject`·`coAuthors` 기록 시점 축소 + 스키마 조건부 강제 | 케이스 (22) + 절 오라클 5건(excluded 3절 + `excluded:false` 대칭 2절) + 스모크 (E)(수집기 축소·대조군·`files[]` 비공허) + 스모크 (F)(**트레일러가 실제로 있는 커밋이 excluded가 되는 조합**으로 `coAuthors` 축소를 관측) |

관측 공백을 메우며 추가한 것: `tests/run-smoke.mjs`의 **절 단위 인메모리 오라클**(기준 인스턴스에
절별 변이를 주입해 기대 메시지 발화를 확인, 41건 + 대조군 4건), 계층별 positive 스키마 검증 루프,
`tests/fixtures-valid/knowledge-map.json`(이 계층은 인스턴스가 0건이라 positive·negative 어느
방향으로도 관측 불가였다), `tests/fixtures-valid/career.json`의 `origin: "user"` 영문 노드,
케이스 (20)의 세 번째 노드. 케이스 (21)의 `messageIncludes`도 고쳤다 — `"verification"`은 조건절이
아니라 `required 필드 'verification' 없음`에도 매칭돼, `messageIncludes`를 도입한 이유가 그
케이스에서 그대로 재현되고 있었다(지금은 `const 불일치(기대 2)`).

**4게이트: `npm run lint` exit 0 / 스모크 257 / `--negative` 23 / `--golden` 11.**

**스펙에만 적혔고 코드는 슬라이스 B가 만든다**(선언과 집행이 아직 분리돼 있음을 명시한다):
C-1(오염 스위트 실행 모델 — AC-8·구현 9단계), C-2(`--secret-scan`·`ARTIFACT_SECRET_LEAK`을 구현
7단계 (e)로 지정), M-1(allow-list 집행을 `verify-evidence.mjs` 소유로 지정 — 구현 8단계 (a)),
M-3(노드 `id` 재사용 규칙 — 구현 7단계 (b), AC-16에 재실행 안정성 기준), M-4(`.bak` 1세대 —
AC-16 + 테스트 전략 동시 반영), M-5(`store.mjs` state/config IO 계약 + `writeJsonAtomic` 공유
추출 — 구현 7단계 (c)(d), `slice_plan.md`에 슬라이스 A 파일 수정 예외 기록), M-6(쓰기 직전 자기
스키마 검증 — **구현 7단계 (a)와 8단계 (c) 양쪽**. 첫 판에서 7단계에만 넣어 체크리스트 B-5의
'7·8단계'를 조용히 좁혔던 것을 바로잡았다), m-2(verify 호출 시 상위 계층 동반 — 구현 8단계 (b)),
m-3(렌더 계약 — **2026-08-19 코드로 닫힘**, 아래 게이트 E 참조), m-4(오염 스위트 기반 픽스처 — 구현 9단계). 여기에 더해
적대 검증이 지적한 두 건을 스펙에 넣었다: 원장 투영 함수의 소유 파일(구현 7단계 (f) —
`projectLedgerForSkills`. §6이 "구현 7단계가 지정한 단일 함수"라고 확정형으로 적어 놓고 실제로는
어디에도 지정하지 않아, 이 커밋이 피하겠다고 선언한 'M-1과 같은 형태'가 같은 커밋 안에서
재발했었다), `verification` 기입 주체 규약(구현 7단계 (g) — `origin`에만 있던 자기면제 차단
조항이 `verification`에는 없었다), L2·L3에서 `verification`이 무엇을 반증하는지의 정의(구현
8단계 (d) — 그 두 계층엔 FactChecker 단계 자체가 스펙에 없는 채 필드만 required였다).

**아직 열려 있다:**

- **M-8(b) 도그푸딩 대상 레포가 여전히 미확정이다.** 구현 10단계에 "착수 전 확정 — 현재 미확정"
  으로 적어 두었을 뿐 실제 레포는 정해지지 않았다. 추측으로 이름을 채우지 않았다.
- **m-1 `state.artifacts.evidence` 항목을 쓰는 주체가 여전히 없다.** 수집기는 `state.json`을 쓰지
  않고, 구현 7단계의 레지스트리 갱신 규정은 career 계층만 다룬다.
- ~~**C-3의 나머지 절반** — `verify-evidence`의 "인용 0건 = PASS" fail-open(콜드 리뷰 B-1)~~
  **닫혔다(2026-08-19, 예외 5번).** 게이트 C-5 항목 참조. 콜드 리뷰 B-1의 **도구 오류** 쪽
  fail-open은 그보다 앞서 이미 닫혀 있었다(status 3분기 + exit 2) — B-1을 통째로 미반영으로
  읽으면 안 된다.
- **AC-11 deny-list 스캔**은 채택하지 않고 §6에 미해결로 남겼다 — 오탐 특성과 대형 레포 비용이
  미측정이다.
- **M-6의 두 번째 수정안(`--schema-check` 디렉터리 인자)은 슬라이스 C로 이연했다** — 쓰기 직전
  메모리 객체 검증이 게이트 실효성을 담당하므로 CLI 편의는 급하지 않다. 기각이 아니라 이연이다.
- **`origin`·`verification` 기입 주체 규약에 집행 코드가 없다** — 현재는 스키마 description과
  AC의 산문뿐이다. 슬라이스 B가 병합 로직을 만들 때 정적 린트(템플릿 본문에 그 필드명이 나오면
  FAIL)로 승격할지 판단해야 한다.
- **`.harness/`·핸드오프 문서는 이 작업 이후 갱신되지 않았다.** 핸드오프는 시점 기록이라 원래
  갱신하지 않는 문서이지만, 다음 세션이 `/handoff resume`으로 시작하면 그 문서의 HEAD·게이트
  수치·Blockers를 먼저 읽게 된다. 세션 경계에서 새 핸드오프를 발행해야 한다.

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

- [x] B-1. `store.mjs`에 state/config IO + 상대경로 변환 API 확정 — **M-5**
      **닫힘(2026-08-19)** — `readState`/`writeState`/`readConfig`/`writeConfig` +
      `toStorageRelative`/`fromStorageRelative` + `STATE_FILE_NAME`/`CONFIG_FILE_NAME`.
      상대경로는 **항상 POSIX 구분자**를 쓰고 루트 밖 탈출을 거부한다. 읽기는 부재·손상 모두
      **예외를 던지지 않고** `{found, value, error}`로 보고한다 — 구현 8단계의 "state.json
      부재·스키마 부적합이면 예외 중단 없이 재수집 안내 후 정상 종료" 요구를 만족시키려면
      던져서는 안 된다.
- [x] B-2. `writeJsonAtomic`을 공유 위치로 추출하고, 그 예외를 `slice_plan.md`에 기록 — **M-5**
      **닫힘(2026-08-19)** — `collect-git-facts.mjs`의 비공개 함수를 `store.mjs`로 옮기고
      수집기는 import해 쓴다. 예외는 `slice_plan.md` 표의 1번으로 이미 기록돼 있었다.
      **추출이 실제로 일어났는지를 소스 스캔으로 관측한다** — 함수 동작만 보면 사본이 남아
      있어도 전부 통과하기 때문이다(수집기에 사본을 되살리는 변이로 그 단언이 FAIL함을 실측).
- [x] B-3. 노드 `id` 병합 키 규칙 확정 + AC-16에 재실행 안정성 관측 기준 추가 — **M-3**
      **닫힘(2026-08-19).** 두 절반을 구별해 적는다 — AC-16의 재실행 안정성 관측 기준
      (「같은 원장으로 2회 생성했을 때 동일 사실 항목의 `id`가 동일함」)은 **이전 회차의 스펙
      개정에 이미 들어가 있었다**(이 세션이 쓴 문장이 아니다). 이 세션이 정한 것은 **병합 키
      그 자체**다: `scripts/lib/artifact-contract.mjs`의 `mergeArtifact`가 (i) `id`로 prev와
      대응시키고, (ii) prev에 **바이트 동일한 `text`**가 있는데 새 `id`를 달고 오면
      `NODE_ID_CHURN`으로 거부한다. 「동일 사실 항목」을 기계가 판정할 수단이 `text` 동일성
      말고 없기 때문이며, 그래서 **prev에 같은 `text`가 2건 이상이면 대응이 모호하므로 판정
      대상에서 뺀다**(모호한 근거로 위반을 만들지 않는다 — AC-20).
      관측 AC-18(금지 방향) · AC-19·AC-20(허용 방향) · WA-12(CLI 경로). 변이 M12(검사 제거)에서
      AC-18·WA-12만, M13(모든 신규 id를 churn으로)에서 AC-19·AC-20이 FAIL함을 실측했다.
- [x] B-4. `.bak`을 AC-16에 넣거나 두 문서에서 동시에 삭제 — **M-4**
      **닫힘(2026-08-19).** 문서 쪽 요구(AC-16과 테스트 전략 [데이터 보존]에 같은 문자열)는
      **이전 회차에 이미 충족돼 있었고 이 세션은 집행 코드와 관측을 붙였다.**
      `scripts/write-artifact.mjs`가 편집 감지 시 `--force` 없이는 **쓰지 않고 exit 3**으로
      보류하며(확인 게이트의 기계 쪽 몫), 강행 시 덮어쓰기 직전 `<파일명>.bak` **1세대**를
      남긴다(2세대를 두지 않음을 함께 단언한다). 관측 WA-9(보류·원본 무변경)·WA-10(.bak 1세대)·
      WA-11(강행 후에도 `locked` 편집분 보존). 변이 M22(보류 제거)·M23(.bak 미생성)에서
      대응 단언만 FAIL함을 실측했다.
- [x] B-5. 산출물 쓰기 직전 자기 스키마 검증을 구현 7·8단계 본문에 명문화 — **M-6**
      **닫힘(2026-08-19).** 본문 명문화(구현 7단계 (a)·8단계 (c))는 **이전 회차에 이미 있었다.**
      이 세션이 한 것은 그 문장을 **집행 코드로 바꾼 것**이다 — `write-artifact.mjs`가 병합 결과를
      `validateInstance`로 검증하고 위반이 있으면 **파일을 만들지 않는다**. 관측 WA-7이 exit 1과
      **파일 부재**를 함께 단언한다(exit 코드만 보면 "쓰고 나서 실패"와 구별되지 않는다).
      변이 M20(자기 검증 제거)에서 WA-7만 FAIL함을 실측했다.

- [x] B-7. **`locked`의 기입 주체 규약.**
      **닫힘(2026-08-20, 사용자 결정).** 생성 출력은 `locked`를 **아예 담지 않고** 병합이
      채운다 — `verification`을 M-1에서 닫은 것과 같은 형태다(금지가 값이 아니라 **필드의
      존재**). 기존 노드는 prev의 값을 이어받고 신규 노드는 `false`를 받는다.

      **왜 값 제약(`false`만 허용)이 아닌가.** 템플릿이 적을 수 있는 의미 있는 값이 애초에
      없고, 값 제약은 금지를 "검사로 막기"로 만들어 이후 제약과 곱해질 때 다시 모순이 날 수
      있다 — M-1이 정확히 그렇게 생겼다. 필드를 없애면 **표현 자체가 불가능**해진다.

      **단계로 완화하지 않는다.** fact-checked 출력을 조립하는 주체도 같은 오케스트레이션이라
      한쪽만 막으면 다른 쪽으로 새는 같은 구멍이 남는다(`origin`과 동형). **계층 중립이다** —
      `verification` 축이 없는 `plan`에도 걸린다. 병합 규칙 1(잠금 보존)이 모든 계층에 있으므로
      자기면제 통로도 모든 계층에 있기 때문이다.

      **그럼 누가 잠그는가 — 이 결정이 남긴 유일한 잠금 경로.** 사용자가 산출물 파일을 직접
      편집하는 것뿐이다. 편집하면 contentHash가 어긋나 `PREV_ARTIFACT_EDITED`로 보류되고,
      `--force`가 `.bak`을 남긴 뒤 병합이 그 노드를 보존한다. 즉 잠금은 **사람의 결정**이고
      그 결정이 파일에 남는다(AC-16의 설계 그대로). 테스트도 이 경로로만 잠금을 심는다.

      **관측 AC-34~AC-42 · WA-18 · WA-19.** 금지 방향 4건(필드 존재 / 값 무관 / 단계 무관 /
      계층 무관), 허용 방향 2건, 병합이 채우는 것 3건, 엔드투엔드 2건. **변이 6종으로 절 단위
      관측:** B1(절 무력화)→5건, B2(값 기준으로 좁힘)→AC-35만, B3(draft만 검사)→AC-36·WA-18,
      B4(verification 축 안쪽으로 이동)→AC-37만, B5(병합 이어받기 제거)→AC-39·AC-41·WA-10·WA-17,
      B6(신규 노드 채우기 제거)→19건. **B5·B6의 폭발 반경이 넓은 것은 관측 결함이 아니다** —
      스키마가 `locked`를 required로 두므로 병합이 안 채우면 모든 쓰기가 실제로 막힌다. 그것이
      AC-42(「병합 결과가 스키마를 실제로 통과하는가」)가 묻는 것이다.

      **이 회차에 관측이 잡아낸 것.** 픽스처 헬퍼가 `locked: true` 오버라이드를 **조용히 버리고
      있었다** — WA-16이 잠긴 prev 노드를 심으려 했는데 아무것도 심지 못한 채 녹색이었다.
      헬퍼가 그 오버라이드에 대해 **던지도록** 고쳤다. 잠금을 심으려면 파일을 직접 편집해야 한다.
      *(B-6은 `plan_critic_findings.md`의 「AC-1 '의존성 0' vs AC-12 '스키마 레벨 강제'의 긴장」이
      선점하고 있어 이 항목은 B-7을 쓴다.)*

## □ 게이트 C — 검사 지점 (구현 9단계 착수 **전**)

- [x] C-1. 마스킹 우회 탐지를 프로덕션 검사 지점으로 승격하고 **구현 7단계 파일 목록**으로
      앞당긴다 — **C-2**. 검사기가 스위트보다 먼저 있어야 스위트가 검사기를 관측한다.
      **닫힘(2026-08-19)** — `scripts/lib/secret-scan.mjs`(신규) + `scripts/validate-plugin.mjs`의
      `--secret-scan <artifact>` 모드(`ARTIFACT_SECRET_LEAK`). 면제는 (필드 × 패턴) 단위로
      좁게 준다: `format: email` 경로에서 **값 전체가 단일 이메일일 때만** `email` 히트를
      면제하고 나머지 패턴은 그대로 발화한다. 관측은 절 단위 오라클 20건 + negative 케이스
      (23) + positive 3계층이며, 변이 7종(M1~M5·M7·M9)을 각각 주입해 **대응하는 단언만**
      FAIL하는 것을 실측했다. 그 과정에서 내가 만든 단언 2건이 공허했음이 드러나 고쳤다
      (픽스처가 변이 지점이 있는 분기에 진입하지 않았다 — 상세는 그 오라클의 주석).
      4게이트: lint 0 / 스모크 277 / `--negative` 27 / `--golden` 11.
- [x] C-2. allow-list 집행 코드의 소유 파일을 구현 8단계 파일 목록에 추가 — **M-1**
      **닫힘(2026-08-19)** — `references/sources.json`(신규, 정본 allow-list) +
      `scripts/verify-evidence.mjs`의 **(f)축** `checkExternalSources`. 대조 규칙은 문자열
      prefix가 아니라 **origin 정확 일치 + pathname prefix + https 강제**다 — 문자열 prefix면
      `https://developer.mozilla.org.evil.com/`이 통과한다. 코드 `EXTERNAL_URL_NOT_IN_ALLOWLIST`
      / `EXTERNAL_URL_MISSING` / `EXTERNAL_URL_MALFORMED` / `EXTERNAL_ALLOWLIST_UNREADABLE`.
      allow-list를 못 읽어도 external 노드가 0건이면 무해하고 1건이라도 있으면 위반이다
      (fail-closed 양방향 관측). 관측 17건 + 변이 8종(A~H)에서 대응 단언만 FAIL 실측.
      4게이트: lint 0 / 스모크 294 / `--negative` 27 / `--golden` 11.

      **다만 이 축의 검사 대상은 아직 만들어질 수 없다 — 스키마 결정이 남아 있다.** 상세는
      아래 「게이트 C-2 후속 — external basis의 표현 불가 문제」 절.
- [ ] C-3. `--contamination`의 실행 모델(스킬 실행 주체 / 채점 주체 / 3회의 대상)을 스펙에
      명문화 — **C-1**
- [ ] C-4. 40건의 기반 픽스처·원장 지정 — **m-4**
- [x] C-5. `verify-evidence`의 `citations.total === 0` → `INCONCLUSIVE` 변경을 T3 반영과 함께
      처리 — **C-3**(콜드 리뷰 B-1과 동일 지점)
      **닫힘(2026-08-19)** — `slice_plan.md` 예외 5번. 판정은 `status`가 `INCONCLUSIVE`이고
      `inconclusiveReasons`에 `NO_CITATIONS_TO_VERIFY`가 실리며 exit 2다.
      **조건을 두 번 좁혔다.** ① `artifactsByLayer`가 비어 있는 호출((e)축·contentHash 전용)은
      제외한다 — 그 PASS는 공허하지 않다. ② **(f)축이 집행된 산출물도 제외한다** — 초판을
      "인용 0건"으로만 쓰자 게이트 C-2의 대조군(노드 하나가 `basis:"external"`인
      knowledge-map)이 즉시 INCONCLUSIVE로 뒤집혔다. L2·L3의 `basis` enum에는 `commit`이
      없으므로 그 산출물은 인용 0건이 정상이고 (f)축이 실제로 1건을 대조했다. **기존 단언을
      고쳐 맞추지 않고 조건을 좁혔다** — 대조군이 잡아낸 것이 이 축의 진짜 경계다.
      관측 6건(C5-1~C5-6) + CLI 경로 1건. 변이 3종(M1~M3)에서 **대응 단언만** FAIL함을 실측.
      **남은 약점(기록):** 조건이 산출물 단위라 노드 99개가 `insufficient`이고 1개만 external이면
      집행 1건으로 PASS가 된다. 노드 단위 커버리지는 AC-13 배지(구현 7단계 렌더 계약) 몫이다.

- [x] C-6. (예외 5번에 함께 실린 T4 2건) **닫힘(2026-08-19)** — A-32: 입력 파일 오류가 raw
      Node 스택 + exit 1로 나오던 것을 `[INPUT_ERROR]` + **exit 2**로 바꿨다(확정된 인용
      위반 exit 1과 구별된다 — 이것이 A-32의 본체다). A-34: 계층 enum 정본을 `KNOWN_LAYERS`로
      export 하고 `validate-plugin.mjs`의 하드코딩 사본과의 드리프트를 **소스 스캔 오라클로
      관측만** 한다(그 파일은 예외 범위 밖이라 고치지 않았다). 변이 2종(M4·M5)으로 관측.
      **나머지 T4 14건은 미반영이다** — `verify-evidence.mjs`와 겹치는 것이 16건 중 2건뿐이라
      사용자 확인을 받아 이 파일 하나로 범위를 좁혔다(근거는 `slice_plan.md` 예외 5번 절).

## 게이트 C-2 후속 — `basis: "external"`이 지금 스펙으로는 표현될 수 없다

(f)축을 구현하며 실측으로 드러난 두 건이다. 둘 다 `schemas/`를 고쳐야 하는데 그것은
`slice_plan.md`가 허용한 슬라이스 A 파일 수정 예외 3건 **밖**이므로 임의로 고치지 않고 기록만
남긴다.

**(1) `externalUrl`을 담을 자리가 세 계층에 없다.**

| 계층 | `basis` enum에 `external` | `externalUrl` 프로퍼티 | `additionalProperties` |
|---|---|---|---|
| career | 있음 | **없음** | `false` |
| knowledge-map | 있음 | 있음 | `false` |
| gap-report | 있음 | **없음** | `false` |
| plan | 있음 | **없음** | `false` |

career·gap-report·plan에서 `basis: "external"`을 선언하면 어떤 출처인지 기록할 자리가 없고
`additionalProperties: false`가 추가도 막는다. 심사 C-4가 「강등 상태를 담을 필드가 정본 JSON에
없다」로 지적한 것과 같은 형태다. (f)축은 이 경우를 `EXTERNAL_URL_MISSING`으로 잡지만, 탐지일
뿐 표현 수단을 주지는 못한다.

**(2) `basis: "external"` 노드가 커밋 인용을 강제당한다.**

`evidence`가 빈 배열이면 `basis`는 `insufficient`여야 한다는 조건절이 `external`을 예외로 두지
않는다. 따라서 `basis: "external"`인 노드는 커밋 인용을 함께 달아야 한다. 그런데 `evidence`의
스키마 description은 "basis:inference일 때의 근거 커밋 나열"이고 L2·L3는 `basis: commit`이 금지된
계층이다 — **"URL 출처만 있고 커밋 근거는 없는 노드"를 표현할 방법이 없다.** 없는 커밋을 달거나
`insufficient`로 강등되는 두 선택지뿐이다.

즉 (f)축은 계약을 검사하는 코드로서 완성됐지만, **검사 대상이 실제로 생성될 수 있으려면 위 두
건에 대한 결정이 선행돼야 한다.** 구현 8단계(KnowledgeMapper)가 `external` 노드를 만들기 시작하는
지점이 그 결정의 마감 시한이다.

## □ 게이트 E — 렌더 계약 (구현 7단계, 스킬 프롬프트보다 **먼저**)

- [x] E-1. 렌더 계약의 정본 리터럴·파생 규칙을 스킬 프롬프트보다 먼저 세운다 — **m-3**
      **닫힘(2026-08-19)** — `scripts/lib/render-contract.mjs`(신규) + `scripts/render-markdown.mjs`
      (신규, career 계층 진입점 + 계층 중립 본체). 배지는 **`verification`에서만** 파생하며
      렌더러에 `basis`를 보고 배지를 만드는 분기가 없다(AC-13 (ii)).
      **관측 R-1~R-10.** 계약 요소는 산문이 아니라 `RENDER_REQUIRED_ELEMENTS` **데이터**라서
      요소가 늘면 오라클이 자동으로 검사한다. 변이 7종(RM1~RM7)에서 대응 단언만 FAIL함을 실측.
      **허용 방향을 함께 관측한다** — RM3(배지를 항상 붙임)이 R-5·R-6을 깬다. 금지 방향만 두면
      "항상 배지를 붙이는" 렌더러가 통과하고 배지가 정보를 잃는다.
      **이 회차에 R-9가 잡아낸 것:** 렌더 계약 픽스처가 `coverage.period`를 `{earliest,latest}`,
      `exclusions`를 숫자 필드로 지어내 스키마를 9군데 어기고 있었고, `verification.reasonCode`도
      패턴(`^[A-Z][A-Z0-9_]*$`)에 맞지 않았다. **R-1~R-8은 그 픽스처 위에서 전부 통과하고
      있었다** — 계약 검사가 픽스처의 스키마 정합성을 함께 묻지 않으면, 통과하지만 현실의 어떤
      산출물과도 대응하지 않는 검사가 된다.
- [x] E-2. 배지 문자열의 정본 표기를 하나로 고정한다
      **닫힘(2026-08-19)** — 스키마 description이 이미 쓰던 `근거 부족 - 미검증`(하이픈)을
      정본으로 채택했다. em dash판으로 통일하려면 `schemas/` 3개를 고쳐야 하고 그것은 슬라이스 A
      파일 수정 예외를 새로 받는 일인데, 글리프 하나에 그 대가를 치를 이유가 없다. `spec.md`의
      em dash 5건을 하이픈으로 정규화했다. **드리프트 가드 4곳**(세 스키마 + spec.md)을
      (R-8)이 본다 — `samplingMethod` 정본 리터럴과 같은 형태다. **(R-8)이 유일한 닻이다**:
      R-4도 배지 문자열을 보지만 `EVIDENCE_BADGE`를 import하므로 리터럴과 함께 움직인다
      (변이 RM6에서 R-8만 FAIL한 것이 그 실측이다).
- [~] E-3. `projectLedgerForSkills`의 **소비 지점**을 소스 스캔으로 관측한다 — 구현 7단계 (f)
      **절반 닫힘(2026-08-19). 나머지 절반은 열려 있다 — 완료로 읽지 마라.**

      **닫힌 절반:** `scripts/project-ledger.mjs`(신규 CLI)가 그 함수의 **호출자**다. 이제
      함수는 죽은 코드가 아니고, 관측 LP-1이 「`store.mjs` 밖 `scripts/`에 호출 지점이 1곳
      이상 실재하는가」를 단언한다. 왜 라이브러리 함수만으로 부족한가: **프롬프트는 JS 함수를
      호출할 수 없다.** 프롬프트가 원장 원본이 아니라 투영을 거치게 만들 수 있는 유일한 수단은
      투영 결과를 만들어 주는 **명령**을 두고 프롬프트가 그 출력만 읽게 하는 것이다.

      **열린 절반:** 「프롬프트 조립 지점이 그 경로를 거치는가」는 `SKILL.md`·템플릿이 아직
      없어 대상 0건이다. 그것을 만드는 회차에 **양방향으로** 단언하라 — (i) 그 명령을 참조하는가,
      (ii) 원장 원본 경로(`evidence.json`)를 직접 참조하지 **않는가**.

      **소스 스캔의 한계를 실측했다(감추지 않는다).** 초판 LP-1은 「그 이름이 파일에 등장하는가」만
      보았고, 변이 M17(**import는 남긴 채 필터를 손으로 복제**)이 **FAIL 0건으로 통과**했다.
      그래서 LP-1을 **호출 지점**(`projectLedgerForSkills(`)까지 요구하도록 좁혔고, 재관측에서
      M17이 LP-1만 FAIL시키는 것을 확인했다. 결과 대조 단언 LP-6도 함께 두었다. **그럼에도 남는
      구멍:** 정본 함수와 **바이트 동일한 로직**을 다른 이름으로 복제하면 LP-6은 통과한다.
      「실제로 호출했는가」는 계측 없이는 관측할 수 없다.

      **이 축은 여전히 보조 방어다.** 스킬이 `evidence.json`을 직접 읽는 것을 막을 결정적 수단은
      없다 — 실제 방어는 §6의 기록 시점 축소(T3)다. 관측 LP-2(금지 방향: 제외 커밋 누출 0건)와
      LP-3(허용 방향: 제외 아닌 커밋 전량 잔존)은 **방향이 분리되도록 다시 썼다** — 초판은 둘 다
      건수를 세는 바람에 「전량 통과」 변이(M18)와 「전량 버림」 변이(M19)가 **둘 다 두 단언을
      동시에** 깨서 어느 방향이 무너졌는지 읽을 수 없었다.

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
