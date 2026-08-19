# HANDOFF — 슬라이스 B: 게이트 C-5 종료 + 렌더 계약 착수 (구현 7단계 ①②)

**Date:** 2026-08-19  **Project:** career-forge (devcareer-prep 플러그인)
**Branch:** harness/devcareer-prep-plugin-2  **HEAD:** 2645ee944343a47de335e4a2fde27f47ddde4643 — feat(render): put the markdown contract under test before any prompt exists
**Dirty:** 1 file (`docs/harness/handoff/2026-08-19-slice-b-exceptions-closed.md` — 직전 핸드오프, untracked)  **Upstream:** 없음 (원격 `origin` = github.com/Jugger0716/career-forge. 이 브랜치가 원격 `main`보다 **22커밋** 앞섬 — 푸시하지 않음)

## Goal

개발자의 Git 히스토리를 분석해 경력 기술서 → 지식맵 → 갭 리포트 → 학습·코테 계획을 만드는
Claude Code 플러그인(`devcareer-prep`)을 구축한다. 핵심 가치는 **할루시네이션 방지** — 모든 사실적
주장이 실존하는 커밋 해시나 신뢰 가능한 출처로 뒷받침되어야 하고, 그 검증을 LLM 판단이 아니라
**결정적 스크립트**가 수행한다.

에픽은 `foundation-first` 3슬라이스다: ① 결정적 기반 → ② P0 스킬 계층(LLM) → ③ 확장·공개.
①은 완료됐다. ②는 진행 중이며, 직전 세션이 「슬라이스 A 파일 수정 예외」 전량을 닫았고
**이 세션은 남은 fail-open 하나를 닫고 구현 7단계의 결정적 부분(렌더 계약)을 세웠다.**
남은 것은 프롬프트 계층(스킬 2종)과 오염 스위트·도그푸딩이다.

## Current State (verified)

- **커밋 2개** — `13c48e6`(게이트 C-5 + A-32 + A-34) → `2645ee9`(렌더 계약). `git log --oneline
  fb1e32d..HEAD`로 확인. 워킹 트리에 직전 핸드오프 1건만 untracked, 원격 미푸시.
- **4게이트 녹색** — `npm run lint` exit 0 / 스모크 **345 PASS** / `--negative` **27 PASS** /
  `--golden` **11 PASS**. 오케스트레이터가 직접 실행해 확인(세션 시작 시점은 0/320/27/11이었다).
- **게이트 C-5 닫힘 — 「인용 0건 = PASS」 fail-open 제거.** `verifyEvidence`가 `status`를
  `INCONCLUSIVE`(exit 2)로 떨어뜨리고 `inconclusiveReasons`에 `NO_CITATIONS_TO_VERIFY`를 싣는다.
  사유를 배열로 둔 이유는 「검증을 못 했다」(`CITATION_TOOL_ERRORS`)와 「검증할 것이 없었다」가
  호출자에게 서로 다른 조치를 요구하는데 exit 2 하나로는 구별되지 않기 때문이다.
- **C-5의 조건을 두 번 좁혔고 두 번째는 기존 대조군이 반증해서 좁혔다.** ① `artifactsByLayer: {}`
  호출((e)축·contentHash 전용)은 제외 — 그 PASS는 공허하지 않다. ② **(f)축이 집행된 산출물도
  제외.** 스펙 문구 그대로 「인용 0건」으로만 쓴 초판이 게이트 C-2의 기존 대조군(노드 하나가
  `basis:"external"`인 knowledge-map)을 즉시 빨갛게 만들었다 — L2·L3의 `basis` enum에는 `commit`이
  없어 그 산출물은 인용 0건이 정상이고 (f)축이 실제로 1건을 대조했다. **기존 단언을 고쳐 맞추지
  않고 조건을 좁혔다.**
- **A-32 닫힘** — 입력 파일 오류가 raw Node 스택 + **exit 1**(= 확정된 인용 위반과 같은 코드)로
  나오던 것을 `[INPUT_ERROR]` + **exit 2**로 바꿨다. 파일명을 메시지에 담는다.
- **A-34(이 파일 몫) 닫힘** — `KNOWN_LAYERS`를 export하고 `validate-plugin.mjs`의 하드코딩 사본과의
  드리프트를 **소스 스캔 오라클로 관측만** 한다. 그 파일은 예외 범위 밖이라 고치지 않았다.
- **렌더 계약이 코드로 섰다(심사 m-3)** — `scripts/lib/render-contract.mjs`(신규, 정본 리터럴·파생
  규칙) + `scripts/render-markdown.mjs`(신규, career 진입점 + 계층 중립 본체). **렌더러와 오라클이
  둘 다 계약 모듈을 import**한다 — 오라클이 문자열을 자기 안에 다시 적으면 「렌더러가 자기 리터럴을
  자기가 확인하는」 자기충족이 된다.
- **배지는 `verification`에서만 파생한다(AC-13 (ii)).** 렌더러에 `basis`를 보고 배지를 만드는 분기가
  **없다**. `verification` 부재는 '검증됨'으로 읽지 않는다(fail-closed).
- **배지 리터럴 정본을 하이픈판 `근거 부족 - 미검증`으로 통일했다.** 스키마 3종이 이미 그 표기를
  쓰고 있었고, em dash로 통일하려면 `schemas/`를 고쳐야 하는데 그것은 슬라이스 A 예외를 하나 더
  받는 일이다. `spec.md`의 em dash 5건을 정규화했고 **드리프트 가드 4곳**(스키마 3 + spec.md)을
  (R-8)이 본다 — `samplingMethod` 리터럴과 같은 형태다.
- **`projectLedgerForSkills`를 `store.mjs`에 추가했다**(구현 7단계 (f), `excluded !== true`만 남긴
  얕은 사본). `store.mjs`는 `slice_plan.md`의 슬라이스 B **In scope**에 명시돼 있어 예외를 쓰지
  않았다.
- **변이 관측 12종, 전부 겨냥한 축의 단언만 깨졌다.** C-5/A-32/A-34 5종(M1~M5) + 렌더 계약 7종
  (RM1~RM7). 각 변이의 FAIL 목록을 실측해 대응 관계를 확인했다.

### 이 세션의 관측이 실제로 잡아낸 것 3건

1. **게이트 C-2의 기존 대조군이 내 C-5 초판을 반증했다.** 스펙 문구를 그대로 옮긴 조건이
   정상 산출물을 INCONCLUSIVE로 뒤집었다. 대조군이 없었다면 (f)축만 쓰는 산출물이 영원히
   "미집행"으로 보고됐을 것이다.
2. **렌더 계약 단언 R-1~R-8이 전부 녹색인 채로, 스키마를 9군데 어기는 픽스처 위에서 돌고 있었다.**
   `coverage.period`를 `{earliest,latest}`로, `exclusions`를 숫자 필드로 지어냈고
   `verification.reasonCode`도 패턴(`^[A-Z][A-Z0-9_]*$`)을 어겼다. **픽스처의 스키마 정합성을 함께
   묻는 단언(R-9)이 없었으면 통과하지만 현실의 어떤 산출물과도 대응하지 않는 검사가 됐다.**
3. **모듈 밖에 닻을 내린 단언은 R-8 하나뿐이다.** 변이 RM6(배지 리터럴 드리프트)에서 R-8만
   FAIL했다 — R-4도 배지 문자열을 보지만 `EVIDENCE_BADGE`를 import하므로 리터럴과 함께 움직인다.

## In Progress

**`.harness/state.json`이 없다 — 결함이 아니라 이전 세션의 결정이다.** 이 프로젝트는 `/harness`
상태 기계 밖에서 진행한다. 따라서 `Skill`/`Task`/`Phase`/`Mode`/`Docs` 고정 라벨 기록이 이 문서에
없고, `/handoff resume`의 Step 3.5는 축소 검사로 "legacy handoff — task state not
machine-verifiable"을 보고할 것이다. 그것이 정상이다.

이 세션에서 진행 중이던 것은 없다. 두 회차를 각각 커밋하고 4게이트 녹색 상태에서 정지했다.

## Blockers / Risks

- **C-5 판정이 산출물 단위다 — 부분 커버리지를 종료 코드로 구별하지 못한다.** 노드 100개 중 99개가
  `evidence: []` + `basis: insufficient`이고 1개만 allow-list URL을 가진 external이면 집행 1건이
  성립해 **PASS**가 된다. summary의 `totalCitations`·`externalSourcesChecked`·`artifactLayers`
  세 수치로 노출은 되지만 exit 코드는 0이다. **노드 단위 커버리지는 AC-13 배지가 담당할 영역으로
  넘겼다** — 그 판단이 맞는지는 구현 8단계에서 다시 봐야 한다.
- **`projectLedgerForSkills`에 소스 스캔 단언이 없다(게이트 E-3).** 호출자가 0곳이라 지금 넣으면
  대상 0건인 공허한 검사다. **`skills/career-from-git/`을 만들 때 「프롬프트 조립 지점이 원장
  원본이 아니라 이 함수를 거치는가」를 반드시 관측하라 — 잊으면 §6의 보조 방어가 선언만 남고,
  그것이 M-1이 지적한 바로 그 형태다.**
- **콜드 리뷰 T4 14건은 여전히 미반영이다.** 이번에 반영한 것은 `verify-evidence.mjs`와 겹치는
  2건(A-32·A-34)뿐이다. 나머지가 건드리는 파일: `collect-git-facts.mjs` 5건,
  `validate-plugin.mjs` 4건, `schema-validate.mjs` 3건, `run-smoke.mjs` 3건, `git.mjs` 2건,
  `make-fixture.mjs` 2건, 그 외 9개 파일에 각 1건. **전량 반영은 예외 표를 사실상 전면 허용으로
  바꾼다** — 범위를 넓히려면 그 대가를 먼저 인정해야 한다.
- **핸드오프의 시점 기록이 어긋나는 지점 1건(정정).** 직전 핸드오프는 콜드 리뷰 B-1을 통째로
  미반영으로 적었으나, **B-1의 도구 오류 쪽 fail-open은 이 세션 이전에 이미 닫혀 있었다**
  (status 3분기 + exit 2, `verify-evidence.mjs` 헤더가 그 계약을 적고 있다). 이번에 닫은 것은
  B-1의 나머지 절반인 「인용 0건」이다.
- **도그푸딩 대상 레포가 미확정이다 — 사용자 결정이 필요하다.** 200커밋 이상·다중 저자·한글 커밋
  메시지가 있는 실제 레포. **이 단계가 타인 PII가 픽스처가 아니라 실물로 처음 흐르는 지점**이다.
- **(f)축의 잔여 위험은 그대로다** — allow-list 대조는 URL이 **목록 소속인지만** 확인한다. 실재성과
  서술 뒷받침은 검사하지 않으며(AC-1 「의존성 0」·오프라인 전제), 막는 것은 2단 팩트체크뿐이다.
  **이 제품의 핵심 명제와 정면으로 긴장하는 지점이므로 감추지 마라.**
- **`origin`·`verification` 기입 주체 규약에 집행 코드가 없다** — 스키마 description과 AC의 산문뿐.
  **구현 7단계에서 병합 로직을 만들 때 정적 린트로 승격할지 판단해야 한다 — 그 시점이 마감이다.**
- **스펙에만 적히고 코드는 없는 항목** — C-1(오염 스위트 실행 모델), M-3(노드 id 재사용),
  M-4(`.bak`), M-6(쓰기 직전 자기 검증), m-1(`state.artifacts.evidence`를 쓰는 주체), m-2.
  **m-3(렌더 계약)은 이 세션에서 코드로 닫혔다.**
- **미검사로 남은 영역** — `plan_critic_findings.md`의 「미검사 영역」 표(구현 7~12단계는 6라운드
  내내 정면 검사 0회). **"결함 0건"이 "결함 없음"이 아니라 "보지 않았음"인 영역이 있다.**
- **원격 미푸시** — 로컬 22커밋. 사용자가 명시적으로 보류를 선택했다(public 레포, 슬라이스 B·C 미완).

## Next Steps

1. **구현 7단계 ③ — `skills/career-from-git/` 프롬프트 계층.** `SKILL.md` + `templates/career-writer.md`
   + `templates/fact-checker.md`. **착수와 동시에 게이트 E-3을 닫아라** — 프롬프트 조립 지점이
   `projectLedgerForSkills`를 거치는지를 소스 스캔 단언으로 관측한다(함수는 이미 `store.mjs`에
   있고 호출자만 없다). 템플릿 상단에 **의도 모델 티어 주석**과 **세션 모델 상속 금지**를 명문화하고
   (전역 CLAUDE.md 구속), `verification`은 스킬 오케스트레이션만 기입한다는 규약(구현 7단계 (g))을
   프롬프트에 반영하라. 렌더 계약은 이미 섰으므로 스킬이 만든 career.json을 `render-markdown.mjs`로
   렌더해 배지·커버리지·절단 고지가 실제로 나오는지 엔드투엔드로 확인할 수 있다.
2. **구현 7단계 (a)(b) 잔여** — 쓰기 직전 `validateInstance` 자기 검증(M-6)과 노드 `id` 재사용
   규칙(M-3). 둘 다 스펙에만 있고 코드가 없다. 병합 로직을 만드는 시점이 이 둘의 마감이다.
3. **구현 8단계** — `skills/skill-gap/`. **여기서 (f)축이 처음으로 대상을 갖는다.** 구현 8단계 (d)의
   「L2·L3에서 `verification`이 무엇을 반증하는가」 정의를 프롬프트에 실제로 반영해야 잔여 위험이
   줄어든다. 렌더러의 계층 중립 본체는 이미 있으므로 `LAYER_TITLES`에 두 줄을 더하면 된다.
4. **구현 9단계 착수 전에 C-1(오염 스위트 실행 모델)을 스펙에 명문화하라.** 스킬 실행 3회는 사람이
   수행해 산출물을 `tests/contamination/runs/<run-id>/`에 남기고 `--contamination`은 채점만 한다 —
   그 절차를 `tests/contamination/README.md`에 고정한다.
5. **구현 10단계 착수 전에 도그푸딩 대상 레포를 확정해 `spec.md` 구현 10단계에 기재하라.**
6. 콜드 리뷰 T4 14건의 처리 회차를 정하라 — 전량 반영은 슬라이스 A 경계를 사실상 없애므로,
   파일별로 예외를 받을지 슬라이스 C로 이연할지가 결정 대상이다.

## Definition of Done

**에픽 전체**: `slice_plan.md`의 3슬라이스가 모두 완료되고, 사용자 본인 Git 히스토리로 생성한 경력
기술서가 "이 정도면 실제로 쓸 수 있다" 수준이며, 갭 분석이 "공감되고 우선순위가 명확하다"고 느껴지고,
생성된 코테 문제가 실제 경력과 논리적으로 연결되며, 할루시네이션으로 인한 잘못된 지식 설명이 거의
없는 상태.

**슬라이스 B 단독**: `/devcareer-prep:career-from-git`과 `/devcareer-prep:skill-gap`이 동작하고,
오염 주입 스위트 40건이 `AC-8` 기준(기계 검증 3종은 3회 모두 100%, LLM 판정 1종은 3회 최저값 80%
이상)을 만족하며, 4게이트가 녹색인 상태.

**이 세션이 유지·추가한 완료 조건**:
- 새 제약을 넣을 때마다 **그 절이 실제로 FAIL을 내는 것을 절 단위로 관측한다**(영역당 한 번은
  부족하다는 것이 실측됐다).
- **완화(제약을 넓히는 변경)는 허용 방향도 관측한다.**
- **구조적 변경(추출·단일화)은 소스 스캔으로 관측한다.**
- **(신규) 계약 검사는 그 픽스처가 스키마를 실제로 통과하는지 함께 단언한다.** R-1~R-8이 전부
  녹색인 채로 9군데 위반 픽스처 위에서 돌고 있었다 — 픽스처를 세계로 착각하는 형태의 실측 사례다.
- **(신규) 리터럴 드리프트 가드의 닻은 그 리터럴을 정의한 모듈 **밖**에 둔다.** 같은 상수를
  import하는 단언은 드리프트와 함께 움직여 아무것도 잡지 못한다(RM6 실측).

## Reading Order

1. `docs/harness/handoff/2026-08-19-slice-b-c5-closed-render-contract.md` — 이 문서. 현재 위치와 남은 것.
2. `docs/harness/devcareer-prep-plugin/slice_b_spec_review.md` — 뒤쪽 **'착수 전 게이트 체크리스트'**가
   가장 실행 가능한 부분이다. B-1·B-2·C-1·C-2·**C-5·C-6·E-1·E-2**가 `[x]`이고 각각 무엇으로
   닫혔는지, **E-3이 왜 열려 있는지**가 적혀 있다.
3. `docs/harness/devcareer-prep-plugin/slice_plan.md` — 3슬라이스 분할과 **슬라이스 A 파일 수정
   예외 5건**(5번이 이 세션에서 추가됐고 T4 범위를 좁힌 근거가 함께 있다). **5건은 모두 소비됐다.**
4. `docs/harness/devcareer-prep-plugin/spec.md` — 실행 스펙 정본(22 AC / 12 구현단계). 다음 작업은
   구현 7단계 ③이며 (a)~(g) 중 (a)(b)(g)가 아직 코드가 없다. 이 파일은 131KB이므로 통독하지 말고
   `awk '/^\*\*7\. /,/^- 검증 영향/'` 같은 방식으로 필요한 단계만 잘라 읽어라.
5. `scripts/lib/render-contract.mjs` — 렌더 계약의 정본. `RENDER_REQUIRED_ELEMENTS`가 **데이터**라
   요소를 추가하면 오라클이 자동으로 검사한다. 새 계약 항목을 넣는 가장 싼 방법이다.
6. `scripts/render-markdown.mjs` — career 진입점 + 계층 중립 본체. 구현 8단계는 `LAYER_TITLES`에
   두 줄만 더하면 된다.
7. `scripts/verify-evidence.mjs`의 `verifyEvidence` 안 「게이트 C-5」 주석 블록 — 조건을 왜 두 번
   좁혔는지와 남은 약점이 적혀 있다. 파일 헤더의 종료 코드 3분기 계약도 함께 보라.
8. `tests/run-smoke.mjs`의 `runRenderContractOracleSmoke`·`runCitationCoverageOracleSmoke` —
   절 단위 오라클 패턴. **새 제약을 넣을 때 이 표들에 행을 추가하는 것이 가장 싼 관측 방법이다.**
   이 파일은 4300줄이 넘으므로 함수 단위로 잘라 읽어라.
9. `docs/harness/devcareer-prep-plugin/plan_critic_findings.md`의 「미검사 영역」 표(158행 부근) —
   구현 7~12단계가 6라운드 내내 정면 검사 0회였다는 기록.
10. `docs/harness/devcareer-prep-plugin/conventions.md` — 규약 문서(70줄). 이 레포엔 `CLAUDE.md`가
    없다 — 필요하면 레포 루트 `CLAUDE.md`로 승격을 검토하라.

## Do NOT

- **`/harness`를 쓰지 마라 — 이 프로젝트는 상태 기계 밖에서 진행한다(사용자 결정).** `.harness/`가
  없으므로 단계 진입은 `Run plan first`로 막히고, `slice_plan.md`의 `Command`를 그대로 실행하면
  **Plan 단계부터 새로 돌아 기존 `spec.md`와 별개의 스펙이 생긴다.**
- **`slice_plan.md`의 예외 5건 밖에서 슬라이스 A 파일을 수정하지 마라. 5건은 모두 소비됐다.**
  T4 나머지를 반영하려면 **먼저 예외를 받아라** — 조용히 넓히면 경계가 사라진다.
- **새 검사를 넣고 "영역당 한 번" 변이로 관측했다고 보고하지 마라.** 절 단위로 하나씩 지워보고
  **대응하는 단언만** FAIL하는지 확인하라.
- **계약 검사를 만들 때 그 픽스처가 스키마를 통과하는지 함께 단언하라.** 이 세션에서 R-1~R-8이
  9군데 위반 픽스처 위에서 전부 녹색이었다.
- **리터럴 드리프트 가드의 닻을 그 리터럴을 정의한 모듈 안에 두지 마라.** 같은 상수를 import하는
  단언은 드리프트와 함께 움직인다(RM6 실측 — R-8만 FAIL했다).
- **조건부 로직을 검사할 때 진입 조건을 만족하지 않는 픽스처를 쓰지 마라.**
- **단언을 전체 위반 수(`length === 0`)로 쓰지 마라.** 겨냥한 경로의 위반만 보라.
- **완화(제약을 넓히는 변경)를 금지 방향만 관측하고 넘어가지 마라.** 이 세션의 RM3(배지를 항상
  붙임)이 R-5·R-6을 깬 것이 그 방향의 실측이다.
- **기존 단언이 새 변경을 반증하면 그 단언을 고쳐 맞추지 마라 — 변경을 좁혀라.** 게이트 C-2
  대조군이 C-5 초판을 반증했을 때 그렇게 했다.
- **배지를 `basis`에서 파생시키지 마라.** AC-13 (ii)가 금지한다 — `verification`에서만 파생한다.
  `verification` 부재를 '검증됨'으로 읽지도 마라(fail-closed).
- **배지 리터럴을 한 곳만 고치지 마라** — 4곳(스키마 3 + `spec.md`)이 드리프트 가드로 묶여 있다.
- **`redact.mjs`·`schema-validate.mjs`·`lang-lint.mjs`를 수정하지 마라** — 예외 목록에 없다.
- **`--secret-scan`의 면제를 필드 단위로 넓히지 마라.** 값 전체가 단일 이메일일 때만 면제한다.
- **allow-list 대조를 문자열 prefix로 바꾸지 마라.** origin 정확 일치 + pathname prefix + https 강제.
- **조건부 제약을 최상위 `if/then`이나 `anyOf`로 쓰지 마라** — 이 레포의 관례는 `allOf` 원소다.
- **`excluded` 커밋의 원장 전량 등재를 되돌리지 마라. T3의 PII 3필드 축소도 되돌리지 마라.**
- **`samplingMethod` 정본 리터럴을 한 곳만 고치지 마라**(4곳이 드리프트 가드로 묶여 있다).
- **`fixtures/golden/sampling-300.expected.json`을 수집기 출력으로 덮어쓰지 마라.**
- **`redact.mjs` 패턴을 손댈 때 "40자 hex 커밋 SHA는 마스킹되지 않는다" 단언을 지우지 마라.**
- **"현재 픽스처에서 문제가 안 난다"를 회귀 없음의 근거로 쓰지 마라. 픽스처를 세계로 착각하지 마라.**
- **자기충족 테스트를 만들지 마라.** 범용 오류 코드를 쓰는 케이스는 위반 메시지 조각까지 단언하라.
- **도그푸딩 대상 레포 이름을 지어내지 마라.** 미확정이며 사용자가 정해야 한다.
- **원격에 푸시하지 마라** — 사용자가 명시적으로 보류를 선택했다.
- `LICENSE`(MIT)와 `.gitignore`를 수정하지 마라. `package.json`의 `npm test` 배선을 되돌리지 마라.
- **PowerShell here-string(`@'...'@`)을 Bash 도구에 쓰지 마라.** 긴 커밋 메시지는 파일에 쓰고
  `git commit -F <file>`로 넘겨라. **Python 스크립트를 콘솔로 돌릴 때는
  `sys.stdout.reconfigure(encoding="utf-8")`를 넣어라** — 이 세션에서 cp949가 em dash를 못 찍어
  변이 드라이버가 중간에 죽었다.

## Progress Ledger

| Epic | Slice | Status | Evidence | Notes |
|------|-------|--------|----------|-------|
| devcareer-prep-plugin | slice-a-deterministic-foundation | done | 97675e7b1a9204aa722584d9917d9cde07db89de | 구현 1~6단계 + 콜드 리뷰 T1·T2·P8 반영. 4게이트 녹색(lint 0 / 201 / 19 / 11). T3(설계 재검토 — 타인 커밋 PII, 성능 O(N))·T4(Minor 약 16건) 미반영. 원격 미푸시. |
| devcareer-prep-plugin | slice-b-gate-a-t3-prework | done | 299315b87a9cb827cb7861210debc0a3b4cc5750 | 슬라이스가 아니라 슬라이스 B **착수 전** 스펙·계약 개정. 심사 16건(C4/M8/m4) → 게이트 A·B + T3 반영 → 적대 검증 4렌즈 → 관측 공백 보강. 4게이트 녹색(lint 0 / 257 / 23 / 11). **위 slice-a 행의 Notes는 그 시점 기록이라 T3 미반영으로 남아 있으나, 이 행 이후 T3는 반영됐고 슬라이스 A 파일도 수정됐다** — slice-a 행의 근거 커밋만 보고 현재 트리를 판단하지 마라. |
| devcareer-prep-plugin | slice-b-p0-skill-layer | in-progress | 2645ee944343a47de335e4a2fde27f47ddde4643 | **구현 7단계의 결정적 부분까지 완료.** 이전 세션이 예외 1~4(게이트 B-1·B-2·C-1·C-2 + 스키마 external)를 닫았고, **이 세션이 예외 5번(게이트 C-5 「인용 0건 = PASS」 fail-open + T4의 A-32·A-34)과 렌더 계약(m-3, 게이트 E-1·E-2)을 닫았다.** 4게이트 녹색(lint 0 / **345** / 27 / 11). 변이 12종으로 절 단위 관측. **미착수: 구현 7단계 ③(스킬 프롬프트 2종)·7단계 (a)(b)(g)·8~10단계.** **게이트 E-3이 열려 있다** — `projectLedgerForSkills`는 호출자가 0곳이라 소스 스캔 단언이 없고, `skills/career-from-git/` 작성 시 반드시 넣어야 §6 보조 방어가 선언으로 남지 않는다. C-5는 산출물 단위 판정이라 부분 커버리지(99 insufficient + 1 external)를 PASS로 낸다. **T4 14건 미반영**, 도그푸딩 레포 미확정, (f)축 잔여 위험 그대로. 원격 미푸시(22커밋). |

## Resume
Run: `/handoff resume docs/harness/handoff/2026-08-19-slice-b-c5-closed-render-contract.md`
