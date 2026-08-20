# HANDOFF — 슬라이스 B: 결정적 진입점 + 콜드 리뷰 3건 반영

**Date:** 2026-08-19  **Project:** career-forge (devcareer-prep 플러그인)
**Branch:** harness/devcareer-prep-plugin-2  **HEAD:** 7e88aa63cec13bcc6259768647f0b27094f28db7 — fix(step7): close the three defects a cold review found in the contract
**Dirty:** 2 files (`docs/handoff/2026-08-19-slice-b-c5-closed-render-contract.md`, `docs/handoff/2026-08-19-slice-b-exceptions-closed.md` — 이전 핸드오프 2건, untracked)  **Upstream:** 없음 (원격 `origin` = github.com/Jugger0716/career-forge. 이 브랜치가 원격 `main`보다 **25커밋** 앞섬 — 푸시하지 않음)

## Goal

개발자의 Git 히스토리를 분석해 경력 기술서 → 지식맵 → 갭 리포트 → 학습·코테 계획을 만드는
Claude Code 플러그인(`devcareer-prep`)을 구축한다. 핵심 가치는 **할루시네이션 방지** — 모든 사실적
주장이 실존하는 커밋 해시나 신뢰 가능한 출처로 뒷받침되어야 하고, 그 검증을 LLM 판단이 아니라
**결정적 스크립트**가 수행한다.

에픽은 `foundation-first` 3슬라이스다. ①은 완료됐고 ②가 진행 중이다. 직전 세션이 게이트 C-5와
렌더 계약을 닫았고, **이 세션은 구현 7단계의 결정적 진입점 3종을 세운 뒤 그 위에 콜드 리뷰를
돌려 확인된 결함 3건을 반영했다.** 남은 것은 프롬프트 계층(스킬 2종)과 오염 스위트·도그푸딩이다.

## Current State (verified)

- **커밋 3개** — `f029375`(결정적 진입점 3종) → `a228329`(T4 이연 결정 기록) →
  `7e88aa6`(콜드 리뷰 3건 반영). `git log --oneline 2645ee9..HEAD`로 확인. 워킹 트리에 이전
  핸드오프 2건만 untracked. 원격 미푸시.
- **4게이트 녹색** — `npm run lint` exit 0 / 스모크 **402 PASS** / `--negative` **27 PASS** /
  `--golden` **11 PASS**. 오케스트레이터가 직접 실행해 확인(세션 시작 시점은 0/345/27/11).
- **신규 파일 3개로 구현 7단계의 결정적 부분이 섰다.** `scripts/lib/artifact-contract.mjs`
  (contentHash 정본 · 기입 주체 (g) · 재생성 병합 (b)/AC-16, 순수 함수), `scripts/project-ledger.mjs`
  ((f) 원장 투영 진입점), `scripts/write-artifact.mjs`(산출물이 디스크에 닿는 유일한 경로 —
  (a) 자기 검증 · 편집 감지 보류 · `.bak` 1세대 · AC-22 레지스트리).
  **슬라이스 A 프로덕션 파일은 하나도 수정하지 않았다** — 새 예외를 받지 않았고,
  `tests/run-smoke.mjs`는 오라클 추가만 했다(C-1·C-2·C-5·E-1 회차와 같은 방식).
- **왜 프롬프트보다 이것이 먼저인가(설계 결정).** 스킬 프롬프트가 먼저 서면 (a)(b)(g)와 AC-16이
  전부 "프롬프트 안의 산문 지시"로 내려앉는다 — 심사 M-1이 지적한 「문서는 약속하는데 집행 코드가
  없다」와 같은 형태다. 게이트 E-1이 렌더 계약에 적용한 순서를 그대로 따랐다.
- **콜드 리뷰 1라운드를 돌렸다(thorough · frontier).** 리뷰어 3명 병렬 + 적대적 교차검증 →
  20건(critical 0 / major 2 / minor 13 / suggestion 5). 리포트는
  `docs/harness/f029375/review_report.md`. `--fix`는 쓰지 않았다.
- **major 2건과 위험한 minor 1건을 오케스트레이터가 직접 실행해 재현을 확인했고, 그 3건만 반영했다**
  (사용자 결정: "1번 진행 후 나머지는 핸드오프"). 나머지 15건은 아래 Blockers에 그대로 남긴다.
- **M-1(재현) — draft 단계 재작성이 3중 자기모순으로 봉쇄돼 있었다.** prev에 `attempts >= 1`인
  비잠금 노드가 있으면 그 노드를 `--stage draft`로 재작성할 방법이 **하나도 없었다.** 네 갈래를
  실행해 전부 exit 1임을 실측했다: `ATTEMPTS_RESET` / 스키마 `not-attempted → attempts const 0` /
  `VERIFICATION_SET_BY_TEMPLATE` / `NODE_ID_CHURN`.
- **M-1의 수정 방향은 오케스트레이터가 결정했다 — draft는 `verification`을 아예 담지 않고 병합이
  채운다.** 리뷰어가 낸 대안(①: draft에서 attempts 규칙을 끈다)은 기각했다 — draft가 `refuted/2`
  였던 노드에 `not-attempted/0`을 실어도 병합이 받아들여 다음 fact-checked 실행이 attempts 0에서
  시작하고, 규칙 3이 막으려던 재시도 상한 초기화가 그대로 되살아난다. 지금은 **금지가 값이 아니라
  필드의 존재**이고, 기존 노드는 prev의 판정을 그대로 이어받으므로 **초기화가 표현 자체로 불가능**
  하다. 스키마 `required`와 부딪히지 않는 이유는 검증 대상이 draft 파일이 아니라 병합 결과이고
  그 병합이 값을 채우기 때문이다. 실측: `refuted` + attempts 2인 노드를 draft로 재작성 → exit 0,
  text는 갱신되고 판정은 `{refuted, 2, NO_SUPPORTING_DIFF}` 그대로.
- **녹색이던 단언 2개가 바뀌었고 그것을 감추지 않았다.** AC-8은 「draft가 `not-attempted`를 기입해도
  된다」를 통과시키고 있었는데 이제 위반이며, AC-8b가 「값이 아니라 필드 존재가 기준」임을 고정한다.
  AC-12는 fact-checked 단계로 옮겼다(그쪽은 부재가 여전히 fail-closed). **이것은 「기존 단언을 고쳐
  맞춘」 것이 아니라 그 단언이 기술하던 설계가 모순임이 밝혀져 설계를 바꾼 것**이며, 두 지점의
  주석에 그 구별을 적어 뒀다.
- **M-3(재현, minor→major 승격) — 조용한 데이터 유실이 있었다.** `nodes` 필드가 없는 draft(LLM
  출력 절단의 실제 형태)가 **exit 0으로 성공하면서** 비잠금 노드를 삭제했다(실측: `[car:001,
  car:002]` → `[car:002]`, 경고도 `.bak`도 없음). `Array.isArray(x) ? x : []`가 fail-open이었고
  `{...draft, nodes: mergedNodes}`가 기형 draft라는 신호를 스키마 검증 앞에서 세탁했다. **기입
  주체 검사와 병합 양쪽**이 `NODES_NOT_ARRAY`로 거부한다. 리뷰어는 minor로 냈으나 성공 종료 코드를
  달고 나가는 유실이라 승격했다(M-1은 시끄럽게 막고 데이터를 지키는데 이쪽은 정반대다).
- **M-2 — exit 4는 코드 수정이 필요 없었고 관측만 없었다.** 깨진 `state.json` 하나로 결정적으로
  재현되는데 스위트 전체에 `status === 4` 단언이 **0건**이었다(grep 실측). 파일 헤더가 스스로
  "'쓰지 않았다' 불변식을 깨는 유일한 코드"라고 못 박은 분기만 관측 밖이었다. WA-15가 exit 4 ·
  산출물 기록됨 · 손상 레지스트리 원문 보존을 함께 단언한다.
- **콜드 리뷰 #10(참조 공유)이 부수적으로 닫혔다** — `mergedNodes.push` 4곳이 전부 얕은 사본을
  넣는다(`grep -n "mergedNodes.push"`로 확인). 다만 리뷰어가 함께 요구한 「노드는 얕은 사본이며
  중첩 객체는 입력과 공유한다」 불변식의 **함수 주석 명문화는 절반만** 됐다(잠금 분기에만 있다).
- **변이 관측 33종.** 1차 25종(진입점 3종) + 2차 8종(콜드 리뷰 반영분). 각 변이가 겨냥한 단언만
  깨지는 것을 실측했다.

### 이 세션의 관측이 실제로 잡아낸 것 5건

1. **변이 M17이 FAIL 0건으로 통과했다.** 「투영 함수를 쓰지 않고 필터를 손으로 복제하되 import는
   남긴다」가 LP-1(이름 존재 스캔)과 LP-6(결과 대조)을 **둘 다** 통과했다. LP-1을 **호출 지점**
   (`projectLedgerForSkills(`)까지 요구하도록 좁혀 재관측했더니 M17이 LP-1만 깼다. **그래도 남는
   구멍**: 바이트 동일한 로직을 다른 이름으로 복제하면 통과한다 — 「실제로 호출했는가」는 계측
   없이 관측할 수 없고, 그 사실을 오라클 주석과 게이트 문서에 적었다.
2. **LP-2/LP-3의 방향 분리가 성립하지 않았다.** 「전량 통과」(M18)와 「전량 버림」(M19)이 **둘 다**
   두 단언을 동시에 깼다 — 양쪽이 개수를 세고 있었기 때문이다. LP-2는 누출 여부만, LP-3은 잔존
   여부만 보게 다시 썼다.
3. **변이 M5·M13·N2에서 섹션이 예외로 중단됐다.** 쓰기가 전부 거부되니 후속 단언이 읽을 파일이
   없었다. **중단되면 어떤 단언이 대응하는지 읽을 수 없다** — 파일 부재·필드 부재를 각 단언의
   FAIL로 떨어뜨리도록 고쳤고, 그 뒤 M5/M13의 진짜 폭발 반경(14~15건)과 N2의 대응(AC-28+WA-17)이
   보이게 됐다.
4. **변이 M1에서 WA-3이 녹색으로 남았다.** writer가 쓴 해시와 재계산이 같은 함수를 쓰므로 규칙이
   무엇이든 자기와는 일치한다. 모듈 **밖**에 닻을 둔 AC-3(`content-hash.mjs` 대조)만이 그 변이를
   잡는다 — 배지 리터럴에 R-8이 유일한 닻이었던 것과 같은 형태다.
5. **변이 N5와 N6이 서로를 대신하지 못했다.** 기입 주체 검사의 강등을 되돌려도 병합 가드가 남아
   CLI는 여전히 exit 1이고, 반대도 같다. 두 가드가 실제로 독립임이 실측됐다.

## In Progress

**`.harness/state.json`이 없다 — 결함이 아니라 사용자 결정이다.** 이 프로젝트는 `/harness` 상태
기계 밖에서 진행한다. 따라서 `Skill`/`Task`/`Phase`/`Mode`/`Docs` 고정 라벨 기록이 이 문서에 없고,
`/handoff resume`의 Step 3.5는 축소 검사로 "legacy handoff — task state not machine-verifiable"을
보고한다. 그것이 정상이다.

이 세션에서 진행 중이던 것은 없다. 세 회차를 각각 커밋하고 4게이트 녹색 상태에서 정지했다.

## Blockers / Risks

- **콜드 리뷰 1라운드의 미반영 15건이 다음 회차의 입력이다.** 전량 리포트는
  `docs/harness/f029375/review_report.md`에 있다. 반영된 것은 M-1·M-2·M-3과 부수적으로 닫힌
  #10뿐이며, **suggestion #16(draft 성공 쓰기 오라클)은 WA-17로 함께 닫혔다.** 남은 것:
  - **(Security) `--root`/`--in`/`--out` 경로 경계 검증 없음** — 쓰기 경계를 이 파일 하나로 좁혀
    놓고 그 경계에만 검증이 없다. `store.mjs`에 `resolveStorageRoot`·`STATE_DIR_NAME`이 이미
    있어 대조는 싸다. **다만 현행 스모크가 `os.tmpdir` 밑 임의 루트로 CLI를 부르므로, 채택하면
    테스트용 우회 수단을 함께 설계해야 한다.**
  - **(Correctness) 읽기 권한 오류(EACCES 등)를 `found:true`로 오분류** → `--force` 시
    `writeBackup`의 `copyFileSync`가 같은 이유로 실패해 미처리 예외로 죽고, Node의 종료 코드가
    1이라 **문서화된 exit 1로 위장**된다(호출자를 무의미한 "출력 수정 후 재시도"로 유도).
  - **(Correctness) `PREV_ARTIFACT_UNREADABLE` 메시지가 `--force` 결과를 경고하지 않는다** —
    강행하면 병합할 prev가 없어 **locked 노드까지 전부** draft로 대체되고 `.bak` 1세대만 남는다.
    `PREV_ARTIFACT_EDITED` 메시지는 `.bak`을 안내하는데 이쪽만 비대칭이다.
  - **(Architecture) prev 유래 노드의 스키마 위반이 exit 1로 나가 잘못된 복구 절차를 지시한다** —
    "출력을 고쳐 다시 부르라"는데 그 위반은 이전 산출물의 locked 노드에서 왔으므로 출력 수정으로
    해소되지 않는다.
  - **(Architecture) `state.json` 레지스트리의 read-modify-write에 동시성 제어가 없다** —
    `writeJsonAtomic`은 개별 쓰기만 원자적이다. 4계층이 순차 의존이라 심각도는 낮게 조정됐다.
  - **(Maintainability) 드리프트 가드가 없는 사본 3건** — `EMPTY_REGISTRY_ARTIFACTS`(계층 키의
    세 번째 사본), `STATE_SCHEMA_VERSION`(스키마 default와 중복), `EVIDENCE_FILE_NAME`(정본이
    생산자가 아니라 소비자 CLI에 있다).
  - **(Maintainability) evidence contentHash가 `content-hash.mjs`와 이중 구현**이다 — 리뷰어는
    공통 하위 헬퍼 `canonicalHash(fields, instance)`로 절차를 단일화하고 필드 목록만 각자
    선언하라고 제안했다. 그러면 AC-3이 '필드 목록 드리프트'를 잡는 닻으로 남는다.
  - **(Testing) 미검증 경로 3건** — 보류 사유 `PREV_ARTIFACT_UNREADABLE`·`PREV_ARTIFACT_HASH_MISSING`,
    `project-ledger`의 `--root`·`--out` 두 사용법.
  - **(Maintainability) `project-ledger`의 `--out` 쓰기만 오류 처리 관례를 벗어난다** —
    `try/catch` 없이 계약 밖 종료 코드로 죽는다.
  - suggestion 잔여: `computeArtifactContentHash`의 `instance` 부재 fail-closed, 보류 사유의
    기계 판독 구조화(`--json`), CLI 상투구 공통화. 뒤 둘은 리뷰어가 "지금 당장은 불필요"로 적었다.
- **`--stage`가 호출자 인자다 — (g)의 자기 선언을 한 계층 위로 옮긴 것뿐이다.** 오케스트레이션이
  FactChecker를 실제로 띄우지 않고 `--stage fact-checked`만 넘기면 `verification: verified`가
  그대로 통과한다. 템플릿의 자기 선언은 막았지만 **오케스트레이션의 자기 선언은 못 막는다** —
  구조가 `origin:"user"` 자기면제와 같다. 리뷰 범위에서 중복 보고를 제외했으므로 리포트에 없다.
  **프롬프트 회차에서 결정해야 한다.**
- **게이트 B-7 신규 — `locked`에 기입 주체 규약이 없다.** 생성 템플릿이 자기 노드에 `locked: true`를
  적으면 그 노드는 이후 재생성에서 영원히 보존된다. (g)가 닫으려는 자기면제와 구조가 같지만
  **스펙이 그 필드의 기입 주체를 정한 적이 없어 이번 회차에 임의로 넓히지 않고 기록만 했다.**
- **게이트 E-3은 절반만 닫혔다.** 호출자는 생겼지만 「프롬프트가 그 경로를 거치는가」는 `SKILL.md`가
  없어 대상 0건이다. `slice_b_spec_review.md`에 `[~]`로 표시했고 열린 절반을 명시했다.
- **C-5 판정이 산출물 단위다** — 노드 99개가 `insufficient`이고 1개만 external이면 집행 1건으로
  PASS가 된다. 노드 단위 커버리지는 AC-13 배지 몫으로 넘겼고, 구현 8단계에서 다시 봐야 한다.
- **콜드 리뷰 T4 14건은 슬라이스 C로 이연 확정**(`a228329`, `slice_plan.md`에 기록). **예외를
  앞당겨 받는 유일한 조건은 그 항목이 그 회차의 작업을 실제로 막을 때**다.
- **도그푸딩 대상 레포가 미확정이다 — 사용자 결정이 필요하다.** 200커밋 이상·다중 저자·한글 커밋
  메시지가 있는 실제 레포. **이 단계가 타인 PII가 픽스처가 아니라 실물로 처음 흐르는 지점**이다.
- **(f)축의 잔여 위험은 그대로다** — allow-list 대조는 URL이 **목록 소속인지만** 확인한다. 실재성과
  서술 뒷받침은 검사하지 않으며(AC-1 「의존성 0」·오프라인 전제), 막는 것은 2단 팩트체크뿐이다.
- **스펙에만 적히고 코드는 없는 항목** — C-1(오염 스위트 실행 모델), M-6(쓰기 직전 자기 검증은
  이번에 코드로 섰다), m-1(`state.artifacts.evidence`를 쓰는 주체), m-2.
- **미검사로 남은 영역** — `plan_critic_findings.md`의 「미검사 영역」 표. **구현 7단계는 이번
  콜드 리뷰로 처음 정면 검사됐고 20건이 나왔다** — 8~12단계는 여전히 0회다.
- **원격 미푸시** — 로컬 25커밋. 사용자가 명시적으로 보류를 선택했다(public 레포, 슬라이스 B·C 미완).

## Next Steps

1. **구현 7단계 ③ — `skills/career-from-git/` 프롬프트 계층.** `SKILL.md` +
   `templates/career-writer.md` + `templates/fact-checker.md`. 이제 **이미 집행되는 계약 위에**
   쓴다. 착수와 동시에 처리할 것 셋: (i) **게이트 E-3의 남은 절반** — 프롬프트가
   `scripts/project-ledger.mjs`를 참조하고 원장 원본(`evidence.json`) 경로는 참조하지 않는지를
   **양방향** 소스 스캔으로 관측한다. (ii) **게이트 B-7 결정** — `locked`의 기입 주체를 정할지.
   (iii) **`--stage` 자기 선언** — 오케스트레이션이 FactChecker를 띄우지 않고 fact-checked를
   자칭하는 경로를 어떻게 다룰지. 템플릿 상단에 **의도 모델 티어 주석**과 **세션 모델 상속 금지**를
   명문화하라(전역 CLAUDE.md 구속). **`skills/`가 생기는 순간 `validate-plugin.mjs`의 휴면 검사
   3계열이 처음 대상을 갖는다** — SKILL.md frontmatter 4종, `DOC_PATH_NOT_FOUND`, AC-18 접두사
   스캔. 각각이 실제로 FAIL을 내는지 관측하라. 쓰기·렌더는 이미 있으므로
   `write-artifact.mjs` → `render-markdown.mjs` 순으로 엔드투엔드 확인이 가능하다.
2. **콜드 리뷰 미반영 15건의 처리 회차를 정하라.** 위 Blockers의 첫 항목이 그 목록이다. 최소한
   Security 1건(경로 경계)과 Correctness 3건은 프롬프트 회차와 함께 보는 것이 싸다 — 프롬프트가
   그 CLI들을 부르기 시작하는 시점이기 때문이다. **리포트는 라운드 1 기록이므로 수정하지 마라;
   반영 후 `/deep-review f029375`를 다시 돌리면 라운드 2가 자동 감지되고 선행 지적이 조정된다.**
3. **구현 7단계 잔여** — 범위 확정 대화(`git shortlog -sne` → 저자 다중 선택 → HEAD/`--all`·머지·
   기간 확정 → `config.json` 저장)와 편집 병합의 사용자 대면 절차. 쓰기 쪽 기계 계약은 이번에 섰다.
4. **구현 8단계** — `skills/skill-gap/`. **여기서 (f)축이 처음으로 대상을 갖는다.** 구현 8단계 (d)의
   「L2·L3에서 `verification`이 무엇을 반증하는가」 정의를 프롬프트에 실제로 반영해야 잔여 위험이
   줄어든다. 렌더러·쓰기 경계 모두 계층 중립이므로 `LAYER_TITLES`와 진입점만 늘리면 된다.
5. **구현 9단계 착수 전에 C-1(오염 스위트 실행 모델)을 스펙에 명문화하라.** 스킬 실행 3회는 사람이
   수행해 산출물을 `tests/contamination/runs/<run-id>/`에 남기고 `--contamination`은 채점만 한다.
6. **구현 10단계 착수 전에 도그푸딩 대상 레포를 확정해 `spec.md`에 기재하라.**

## Definition of Done

**에픽 전체**: `slice_plan.md`의 3슬라이스가 모두 완료되고, 사용자 본인 Git 히스토리로 생성한 경력
기술서가 "이 정도면 실제로 쓸 수 있다" 수준이며, 갭 분석이 "공감되고 우선순위가 명확하다"고 느껴지고,
생성된 코테 문제가 실제 경력과 논리적으로 연결되며, 할루시네이션으로 인한 잘못된 지식 설명이 거의
없는 상태.

**슬라이스 B 단독**: `/devcareer-prep:career-from-git`과 `/devcareer-prep:skill-gap`이 동작하고,
오염 주입 스위트 40건이 `AC-8` 기준을 만족하며, 4게이트가 녹색인 상태.

**이 세션이 유지·추가한 완료 조건**:
- 새 제약을 넣을 때마다 **그 절이 실제로 FAIL을 내는 것을 절 단위로 관측한다.**
- **완화(제약을 넓히는 변경)는 허용 방향도 관측한다.**
- **구조적 변경(추출·단일화)은 소스 스캔으로 관측한다.**
- **계약 검사는 그 픽스처가 스키마를 실제로 통과하는지 함께 단언한다.**
- **리터럴 드리프트 가드의 닻은 그 리터럴을 정의한 모듈 밖에 둔다.**
- **(신규) 변이가 섹션을 예외로 중단시키면 관측 장치가 고장난 것이다.** 중단되면 어떤 단언이
  대응하는지 읽을 수 없다 — 파일·필드 부재를 예외가 아니라 각 단언의 FAIL로 떨어뜨려라(M5·M13·N2 실측).
- **(신규) 소스 스캔 단언은 「이름이 등장하는가」가 아니라 「호출 지점이 있는가」를 물어라.**
  import를 남긴 채 로직을 복제하면 이름 스캔은 통과한다(M17 실측).
- **(신규) 양방향 단언은 각자 **다른 것**을 보게 써라.** 둘 다 개수를 세면 정반대 변이가 둘 다
  같은 단언을 깨서 방향을 구별할 수 없다(M18·M19 실측).
- **(신규) 새 제약을 넣을 때 기존 스키마 제약과 곱해 보라.** M-1은 (g)의 조건과 스키마의
  `not-attempted → attempts const 0`이 곱해질 때 성립 불가가 되는 것을 보지 못해 생겼다.

## Reading Order

1. `docs/handoff/2026-08-19-slice-b-entrypoints-coldreview-fixed.md` — 이 문서. 현재 위치와 남은 것.
2. `docs/harness/f029375/review_report.md` — 콜드 리뷰 라운드 1 전량 20건. **미반영 15건이 다음
   회차의 입력이다.** 「오케스트레이터 실측 기록」 절에 M-1·M-2·M-3의 재현 절차가 있다.
3. `docs/devcareer-prep-plugin/slice_b_spec_review.md` — 뒤쪽 **'착수 전 게이트 체크리스트'**.
   B-1·B-2·B-3·B-4·B-5·C-1·C-2·C-5·C-6·E-1·E-2가 `[x]`, **E-3이 `[~]`(절반)**, **B-7이 신규 미결**.
4. `docs/devcareer-prep-plugin/slice_plan.md` — 3슬라이스 분할, 슬라이스 A 파일 수정
   예외 5건(전부 소비됨), **T4 14건의 슬라이스 C 이연 결정**.
5. `scripts/lib/artifact-contract.mjs` — 계약 정본. `checkAuthorshipContract`의 draft 절과
   `mergeArtifact`의 규칙 1~5 주석에 **M-1이 왜 생겼고 어떻게 닫혔는지**가 적혀 있다.
6. `scripts/write-artifact.mjs` — 쓰기 경계. 파일 헤더의 **5분기 종료 코드 계약**과 그 이유를 보라.
7. `scripts/project-ledger.mjs` — (f) 투영 진입점. 「왜 라이브러리 함수만으로는 부족한가」 절이
   프롬프트 회차의 E-3 작업 근거다.
8. `docs/devcareer-prep-plugin/spec.md` — 실행 스펙 정본(22 AC / 12 구현단계). 131KB이므로
   통독하지 말고 `awk '/^\*\*7\. /,/^\*\*8\. /'` 같은 방식으로 필요한 단계만 잘라 읽어라.
9. `tests/run-smoke.mjs`의 `runArtifactContractOracleSmoke`·`runLedgerProjectionOracleSmoke`·
   `runWriteArtifactOracleSmoke` — 절 단위 오라클 패턴. 5300줄이 넘으므로 함수 단위로 잘라 읽어라.
10. `docs/devcareer-prep-plugin/conventions.md` — 규약 문서(70줄). 이 레포엔 `CLAUDE.md`가
    없다 — 필요하면 레포 루트 `CLAUDE.md`로 승격을 검토하라.

## Do NOT

- **`/harness`를 쓰지 마라 — 이 프로젝트는 상태 기계 밖에서 진행한다(사용자 결정).**
- **`slice_plan.md`의 예외 5건 밖에서 슬라이스 A 파일을 수정하지 마라. 5건은 모두 소비됐다.**
  T4 나머지는 슬라이스 C로 이연됐다 — **그 항목이 그 회차 작업을 실제로 막을 때만** 예외를 받아라.
- **`review_report.md`를 수정하지 마라** — 라운드 1 기록이다. 반영 후 `/deep-review f029375`를
  다시 돌리면 라운드 2가 자동 감지되고 선행 지적이 조정된다.
- **draft 단계 출력에 `verification`을 담게 하지 마라.** 값이 아니라 **필드의 존재**가 금지다.
  값은 병합이 채운다 — 되돌리면 M-1의 3중 자기모순이 그대로 되살아난다.
- **`nodes` 비배열을 빈 배열로 강등하지 마라.** 기입 주체 검사와 병합 **양쪽**이 거부해야 한다 —
  한쪽만 되돌려도 CLI는 막히지만(N5·N6 실측) 그 파일을 직접 부르는 호출자에게는 구멍이 남는다.
- **새 검사를 넣고 "영역당 한 번" 변이로 관측했다고 보고하지 마라.** 절 단위로 하나씩 지워보고
  **대응하는 단언만** FAIL하는지 확인하라.
- **변이가 섹션을 중단시키는데 그대로 두지 마라.** 부재를 예외가 아니라 FAIL로 떨어뜨려라.
- **소스 스캔을 이름 존재로 쓰지 마라 — 호출 지점을 요구하라.**
- **양방향 단언이 둘 다 같은 것(개수)을 보게 쓰지 마라.**
- **계약 검사를 만들 때 그 픽스처가 스키마를 통과하는지 함께 단언하라.**
- **리터럴 드리프트 가드의 닻을 그 리터럴을 정의한 모듈 안에 두지 마라.**
- **단언을 전체 위반 수(`length === 0`)로 쓰지 마라.** 겨냥한 경로의 위반만 보라.
- **기존 단언이 새 변경을 반증하면 그 단언을 고쳐 맞추지 마라 — 변경을 좁혀라.** 예외는 그
  단언이 기술하던 **설계 자체가 모순임이 밝혀진** 경우이며(M-1), 그때는 바꾼 이유를 두 지점에
  적어라. 그 구별을 흐리지 마라.
- **배지를 `basis`에서 파생시키지 마라.** AC-13 (ii)가 금지한다 — `verification`에서만 파생한다.
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
- **에이전트 리포트를 그대로 받지 마라.** 이번 콜드 리뷰의 major 2건과 승격 1건은 전부 직접
  실행해 재현을 확인한 뒤에 반영했다.
- **도그푸딩 대상 레포 이름을 지어내지 마라.** 미확정이며 사용자가 정해야 한다.
- **원격에 푸시하지 마라** — 사용자가 명시적으로 보류를 선택했다.
- `LICENSE`(MIT)와 `.gitignore`를 수정하지 마라. `package.json`의 `npm test` 배선을 되돌리지 마라.
- **PowerShell here-string(`@'...'@`)을 Bash 도구에 쓰지 마라.** 긴 커밋 메시지는 파일에 쓰고
  `git commit -F <file>`로 넘겨라. **Python 스크립트를 콘솔로 돌릴 때는
  `sys.stdout.reconfigure(encoding="utf-8")`를 넣어라** — cp949가 em dash를 못 찍어 드라이버가 죽는다.

## Progress Ledger

| Epic | Slice | Status | Evidence | Notes |
|------|-------|--------|----------|-------|
| devcareer-prep-plugin | slice-a-deterministic-foundation | done | 97675e7b1a9204aa722584d9917d9cde07db89de | 구현 1~6단계 + 콜드 리뷰 T1·T2·P8 반영. 4게이트 녹색(lint 0 / 201 / 19 / 11). T3·T4 미반영. 원격 미푸시. |
| devcareer-prep-plugin | slice-b-gate-a-t3-prework | done | 299315b87a9cb827cb7861210debc0a3b4cc5750 | 슬라이스가 아니라 슬라이스 B **착수 전** 스펙·계약 개정. 심사 16건 → 게이트 A·B + T3 반영 → 적대 검증 4렌즈. 4게이트 녹색(lint 0 / 257 / 23 / 11). **위 slice-a 행의 Notes는 그 시점 기록이라 T3 미반영으로 남아 있으나 이 행 이후 T3는 반영됐다** — 근거 커밋만 보고 현재 트리를 판단하지 마라. |
| devcareer-prep-plugin | slice-b-p0-skill-layer | in-progress | 7e88aa63cec13bcc6259768647f0b27094f28db7 | **구현 7단계의 결정적 부분 완료 + 콜드 리뷰 1라운드 반영.** 이전 회차들이 예외 1~5(게이트 B-1·B-2·C-1·C-2·C-5·C-6 + 스키마 external)와 렌더 계약(m-3·E-1·E-2)을 닫았고, **이 세션이 결정적 진입점 3종(신규 파일, 슬라이스 A 수정 0건)을 세운 뒤 콜드 리뷰 20건 중 3건(M-1 계약 3중 자기모순 / M-2 exit 4 미관측 / M-3 조용한 노드 삭제)을 실측 재현 후 반영했다.** 4게이트 녹색(lint 0 / **402** / 27 / 11). 변이 33종으로 절 단위 관측. **미착수: 구현 7단계 ③(스킬 프롬프트 2종)·범위 확정 대화·8~10단계.** **콜드 리뷰 미반영 15건**(Security 1 · Correctness 3 · Architecture 2 · Maintainability 5 · Testing 3 · suggestion 잔여)이 다음 회차 입력. **게이트 E-3 절반 열림 · B-7 신규 미결 · `--stage` 자기 선언 미결.** T4 14건은 슬라이스 C 이연 확정. 도그푸딩 레포 미확정. 원격 미푸시(25커밋). |

## Resume
Run: `/handoff resume docs/handoff/2026-08-19-slice-b-entrypoints-coldreview-fixed.md`
