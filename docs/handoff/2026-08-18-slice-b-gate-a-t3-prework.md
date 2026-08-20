# HANDOFF — 슬라이스 B 스펙 심사 + 게이트 A·B·T3 반영 (착수 전 정지)

**Date:** 2026-08-18  **Project:** career-forge (devcareer-prep 플러그인)
**Branch:** harness/devcareer-prep-plugin-2  **HEAD:** 299315b87a9cb827cb7861210debc0a3b4cc5750 — test: give the new schema constraints teeth, and correct the claim that they had them
**Dirty:** clean  **Upstream:** 없음 (원격 `origin` = github.com/Jugger0716/career-forge. 이 브랜치가 원격 `main`보다 12커밋 앞섬 — 푸시하지 않음)

## Goal

개발자의 Git 히스토리를 분석해 경력 기술서 → 지식맵 → 갭 리포트 → 학습·코테 계획을 만드는
Claude Code 플러그인(`devcareer-prep`)을 구축한다. 핵심 가치는 **할루시네이션 방지** — 모든 사실적
주장이 실존하는 커밋 해시나 신뢰 가능한 출처로 뒷받침되어야 하고, 그 검증을 LLM 판단이 아니라
**결정적 스크립트**가 수행한다.

에픽은 `foundation-first` 3슬라이스로 분할됐다: ① 결정적 기반 → ② P0 스킬 계층(LLM) → ③ 확장·공개.
①은 이전 세션에서 완료됐다. **이 세션은 슬라이스를 실행하지 않았다** — ②에 착수하기 전에 그 영역의
스펙을 적대적으로 심사하고, 심사가 지목한 착수 차단 항목(게이트 A·B)과 T3(타인 커밋 PII) 설계
재검토를 반영했다. 슬라이스 B는 아직 시작되지 않았다.

## Current State (verified)

- **커밋 3개** — `c8cfd7c`(심사 문서) → `a31bdca`(게이트 A·B·T3 반영) → `299315b`(적대 검증 지적 반영).
  `git log --oneline 53e8649..HEAD`로 확인. 워킹 트리 클린, 원격 미푸시.
- **4게이트 녹색** — `npm run lint` exit 0 / 스모크 **257 PASS** / `--negative` **23 PASS** /
  `--golden` **11 PASS**. 오케스트레이터가 직접 실행해 확인(세션 시작 시점은 201/19/11이었다).
- **슬라이스 B 스펙 심사 완료** — `slice_b_spec_review.md`, Critical 4 / Major 8 / Minor 4 = 16건.
  구현 7~12단계는 `plan_critic_findings.md`가 기록했듯 6라운드 내내 정면 검사 0회였던 영역이다.
- **심사 중 3건을 실측으로 재현했다** — (i) `nodes: []`인 career.json이 `--schema-check`·
  `--lang-check`·`verify-evidence` 셋 모두에서 exit 0(AC-13이 금지한 빈손 출력이 전 게이트 통과),
  (ii) `origin: "user"` 노드의 영문 자가진단이 `--lang-check`에서 exit 1(사용자 입력 필드 오탐),
  (iii) `verify-evidence.mjs`에 시크릿·마스킹 축 grep 히트 0건.
- **검증기(M-7) 수정과 그 관측** — `validateInstance`가 최상위 `if/then/else`와 `anyOf`를 평가한다.
  수정 전 검증기로 되돌려 새 오라클 2건이 FAIL(201/2), 수정 후 PASS(203/0)임을 실제로 실행해 확인.
- **T3 반영: 제외 커밋 PII 축소** — `excluded: true` 커밋의 `authorEmail`·`subject`는 `null`,
  `coAuthors`는 빈 배열로 **기록 시점에 축소**하고 `evidence.schema.json`이 조건부로 강제한다.
  근거는 정찰이 실측한 사실 — 그 세 필드를 읽는 검사가 슬라이스 A에 **하나도 없다**(검증기는
  `excluded` 판정에서 먼저 종료된다). 변조 공격 3종 재현으로 (a)축·AC-9·AC-6 불변식·머지 집합
  동치가 전부 그대로 성립함을 확인했다.
- **적대 검증이 내 반영 보고를 반증했고 그것을 고쳤다** — 4렌즈 병렬 검증(각자 자기 사본에서만 변이)
  결과 2건 blocking. 게이트 A가 넣은 스키마 제약 약 35개 중 **위반 시 게이트를 빨갛게 만드는 것은
  3개뿐**이었고 나머지 32개는 지워도 4게이트가 녹색이었다. `a31bdca`의 리뷰 문서가 "각 항목마다
  위반을 넣어 확인"이라고 적은 것은 영역당으로는 참, **절 단위로는 거짓**이었다.
- **관측 공백을 메웠다(`299315b`)** — `tests/run-smoke.mjs`에 **절 단위 인메모리 오라클**을 넣었다
  (계층별 기준 인스턴스에 절마다 변이 주입 → 그 절 고유 메시지 발화 확인, 41건 + 대조군 4건).
  사본에서 절 3개를 지워 정확히 대응하는 단언 3건만 FAIL함을 확인했다.
- **`coAuthors` 축소는 통째로 되돌려도 4게이트가 녹색이었다** — 유일한 관측 지점이 쓰던 픽스처
  (`buildMultiAuthor`)의 세 커밋에 `Co-authored-by` 트레일러가 0건이라 단언이 항상 공허하게
  참이었다. `buildCoAuthorTrailer`를 다른 identity로 수집해(전 커밋이 excluded가 된다) 대조군과
  함께 관측하도록 고쳤다.
- **언어 린트 `origin` 제외의 "파일 단위 과잉 제외" 변이가 생존했다** — 픽스처 쌍이 `origin` 값만
  달랐지 두 값을 **한 파일에** 담지 않아 노드 단위와 파일 단위를 구별할 수 없었다. 케이스 (20)에
  `origin: "user"` 영문 노드를 추가해 닫았다.
- **`knowledge-map`은 레포에 인스턴스가 0건이라 그 계층 제약 전부가 양방향 관측 불가였다** —
  `tests/fixtures-valid/knowledge-map.json`을 만들고 positive 스키마 검증 루프를 세 계층으로
  일반화했다.
- **회귀 렌즈는 clean** — 실제 레포 엔드투엔드 수집·`contentHash` 결정성·`git-facts.json`·
  `--all-identities`·머지 커밋·경계 케이스·lint 신규 경고 9개 축을 독립 재현했고 깨진 것이 없었다.

## In Progress

Skill : harness
Task : DevCareer Prep — Claude Code 플러그인 개발 (Git 히스토리 → 경력 기술서 → 지식 갭 분석 → 학습/코테 계획). SPEC.md 전문은 docs/devcareer-prep-plugin/SPEC.md 참조.
Phase : plan_done
Mode : multi
Docs : docs/devcareer-prep-plugin/

**위 `Phase` 값은 이전 세션과 마찬가지로 현실과 어긋나 있다.** 슬라이스 A 구현이 끝나고 이 세션이
게이트 작업까지 마쳤는데도 harness 위상 기계는 `plan_done`에 멈춰 있다 — 에픽 경로를 택했고
§Step 8의 epic-exit(`.harness/` 삭제)을 실행하지 않은 채 상태를 살려 뒀기 때문이다. 이것이 아래
**Do NOT 첫 항목**과 직결된다.

이 세션에서 진행 중이던 것은 없다. 게이트 A·B·T3 반영과 그 적대 검증까지 끝내고 슬라이스 B 착수
직전에서 정지했다.

## Blockers / Risks

- **도그푸딩 대상 레포가 미확정이다 — 사용자 결정이 필요하다.** 200커밋 이상·다중 저자·한글 커밋
  메시지가 있는 실제 레포가 필요하다. 구현 10단계에 "착수 전 확정 — 현재 미확정"으로만 적었고
  이름을 지어내지 않았다. 거명됐던 후보 둘은 각각 결격 사유가 함께 적혀 있다(문서 비중 과다 /
  사용자 커밋 9건). **이 단계가 타인 PII가 픽스처가 아니라 실물로 처음 흐르는 지점**이므로 T3
  정책이 여기서 실전 시험된다.
- **스펙에만 적히고 코드는 없는 항목이 9건 있다** — C-1(오염 스위트 실행 모델), C-2(`--secret-scan`),
  M-1(allow-list 집행), M-3(노드 id 재사용), M-4(`.bak`), M-5(store IO 계약 + `writeJsonAtomic`
  추출), M-6(쓰기 직전 자기 검증), m-2, m-3. 전부 **소유 파일을 지정**했으므로 `redact.mjs`가 죽은
  코드였던 형태는 아니지만, 선언과 집행이 아직 분리돼 있다. `slice_b_spec_review.md`의 '반영 현황'
  절이 코드로 닫힌 것과 스펙에만 적힌 것을 구분해 적고 있다.
- **`verify-evidence`의 "인용 0건 = PASS" fail-open은 손대지 않았다**(콜드 리뷰 B-1, 게이트 C-5).
  빈손 출력을 `minItems`로 막았지만, 인용이 0건인 산출물이 검증기에서 `[PASS]`가 나오는 성질은
  그대로다. T4 반영과 같은 회차에 처리하는 것이 싸다.
- **`origin`·`verification` 기입 주체 규약에 집행 코드가 없다** — 스키마 description과 AC의 산문뿐이다.
  LLM이 스스로 `origin: "user"`를 적으면 언어 린트 자기면제가 되고, `verification: {status:
  "verified"}`를 적으면 2단 팩트체크를 자기 선언으로 우회한다. 슬라이스 B가 병합 로직을 만들 때
  정적 린트로 승격할지 판단해야 한다.
- **`state.artifacts.evidence`를 쓰는 주체가 없다**(m-1). 수집기는 `state.json`을 쓰지 않고 구현
  7단계의 레지스트리 갱신 규정은 career 계층만 다룬다.
- **콜드 리뷰 T4(Minor 약 16건)는 여전히 미반영**이며, 이번 세션은 그것과의 중복 제거를 하지 않았다.
- **미검사로 남은 영역** — `cold_review.md`의 `unInspectedAreas`와 `plan_critic_findings.md`의 동명
  절을 참조하라. **"결함 0건"이 "결함 없음"이 아니라 "보지 않았음"인 영역이 있다.**
- **원격 미푸시** — 로컬 12커밋이 원격에 없다. 사용자가 명시적으로 보류를 선택했다(public 레포이고
  슬라이스 B·C가 미완이다).

## Next Steps

1. **슬라이스 B 실행** — `slice_plan.md`의 해당 행 `Command`:
   `/harness "slice-b-p0-skill-layer" --output-dir docs/harness/devcareer-prep-plugin`
   (구현 7~10단계: `/devcareer-prep:career-from-git`, `/devcareer-prep:skill-gap`(자가진단 한정),
   오염 주입 스위트 40건, Phase 1 도그푸딩). 게이트 A·B는 이미 닫혔으므로 착수 조건은 충족됐다.
2. **구현 9단계 착수 전에 게이트 C를 닫아라** — `--secret-scan`(C-2)과 allow-list 집행(M-1)은
   **스위트보다 먼저** 존재해야 스위트가 그것을 관측한다. 슬라이스 A에서 배운 "하네스를 먼저"와
   같은 순서다. 두 검사 지점은 슬라이스 A 파일에 들어가며 `slice_plan.md`의 예외 3건에 포함돼 있다.
3. **구현 10단계 착수 전에 도그푸딩 대상 레포를 확정해 `spec.md` 구현 10단계에 기재하라.**
   현재 그 자리에 "미확정"이라고 적혀 있다.
4. 콜드 리뷰 T4(약 16건)와 게이트 C-5(fail-open)를 한 회차로 묶어 처리하는 것을 검토하라 — 둘 다
   `verify-evidence.mjs`를 건드린다.

## Definition of Done

**에픽 전체**: `slice_plan.md`의 3슬라이스가 모두 완료되고, 사용자 본인 Git 히스토리로 생성한 경력
기술서가 "이 정도면 실제로 쓸 수 있다" 수준이며, 갭 분석이 "공감되고 우선순위가 명확하다"고 느껴지고,
생성된 코테 문제가 실제 경력과 논리적으로 연결되며, 할루시네이션으로 인한 잘못된 지식 설명이 거의
없는 상태.

**슬라이스 B 단독**: `/devcareer-prep:career-from-git`과 `/devcareer-prep:skill-gap`이 동작하고,
오염 주입 스위트 40건이 `AC-8` 기준(기계 검증 3종은 3회 모두 100%, LLM 판정 1종은 3회 최저값 80%
이상)을 만족하며, 4게이트가 녹색인 상태.

**이 세션이 추가한 완료 조건**: 슬라이스 B가 스키마에 새 제약을 넣을 때마다 **그 절이 실제로 FAIL을
내는 것을 절 단위로 관측**한다(영역당 한 번은 부족하다는 것이 이번 세션에서 실측됐다).

## Reading Order

1. `docs/handoff/2026-08-18-slice-b-gate-a-t3-prework.md` — 이 문서. 현재 위치와 남은 것.
2. `docs/devcareer-prep-plugin/slice_b_spec_review.md` — **가장 중요.** 슬라이스 B 심사 16건과
   맨 앞 '반영 현황' 절(코드로 닫힌 것 / 스펙에만 적힌 것 / 아직 열린 것의 구분, 그리고 내 첫 보고가
   왜 과대 진술이었는지의 정정). 뒤쪽 '착수 전 게이트 체크리스트'가 실행 가능한 부분이다.
3. `docs/devcareer-prep-plugin/slice_plan.md` — 3슬라이스 분할, 슬라이스 B 실행 명령,
   그리고 **슬라이스 A 파일 수정 예외 3건**(이걸 모르면 구현자가 경계를 지키려고 사본을 만든다).
4. `docs/devcareer-prep-plugin/spec.md` — 실행 스펙 정본(22 AC / 12 구현단계). 슬라이스 B는
   구현 7~10단계. 이 세션이 AC-6·8·9·12·13·14·16·19·21과 §6, 구현 7~10단계를 개정했다.
5. `docs/devcareer-prep-plugin/cold_review.md` — 콜드 리뷰 41건. T1·T2·P8·T3로 닫힌 것과
   남은 T4를 구분해 읽어라.
6. `docs/devcareer-prep-plugin/plan_critic_findings.md` — round 6 critic. **맨 앞 carry-over
   체크리스트와 `unInspectedAreas` 목록이 핵심**이다.
7. `schemas/career.schema.json` — `verification` 필드 계약과 조건절 3종. knowledge-map·gap-report도
   같은 형태로 복제돼 있다(세 파일을 함께 고쳐야 한다).
8. `tests/run-smoke.mjs`의 `runSchemaClauseOracleSmoke` — 절 단위 오라클 패턴. 새 제약을 넣을 때
   이 표에 행을 추가하는 것이 가장 싼 관측 방법이다.
9. `scripts/collect-git-facts.mjs`의 `finalCommits` 조립부 — T3 축소가 실제로 일어나는 지점.
10. `README.md` — 현재 무엇이 되고 무엇이 안 되는지 + 한계 고지(제외 커밋 PII 항목 포함).

## Do NOT

- **인자 없는 `/harness`를 실행하지 마라.** `state.json`이 `phase: plan_done` + `epic.boundaries`
  non-null이고, 이 조합이 harness의 **epic-exit 술어**다 — §Step 8 경로로 가서 **`.harness/`를
  삭제한다.** 슬라이스 B를 시작할 때는 `slice_plan.md`의 명시적 `Command`(Next Steps 1번)를 쓰라.
- **새 스키마 제약을 넣고 "영역당 한 번" 변이로 관측했다고 보고하지 마라.** 이번 세션에서 정확히
  그렇게 해서 35개 중 32개가 미관측인 채로 "관측됐다"고 적었고, 적대 검증이 그것을 반증했다.
  **절 단위로 하나씩 지워보고 대응하는 단언만 FAIL하는지 확인하라.**
- **조건부 제약을 최상위 `if/then`이나 `anyOf`로 쓰지 마라** — 이제 평가되지만, 이 레포의 관례는
  `allOf` 원소이고 기존 스키마가 전부 그 형태다. 관례를 깨면 다음 사람이 두 형태를 다 확인해야 한다.
- **슬라이스 A 파일을 `slice_plan.md`의 예외 3건 밖에서 수정하지 마라**(`writeJsonAtomic` 추출 /
  `--secret-scan` 추가 / allow-list 대조 축 추가).
- **`excluded` 커밋의 원장 전량 등재를 되돌리지 마라**(AC-7 (a)축·AC-9·머지 집합 동치가 걸려 있다).
  **동시에 T3의 PII 3필드 축소도 되돌리지 마라** — 그 세 필드를 읽는 검사가 없다는 것이 실측으로
  확인됐고, 되살리면 동료 이메일·커밋 제목이 다시 산출물 경로로 흐른다.
- **`samplingMethod` 정본 리터럴을 한 곳만 고치지 마라.** 네 곳(`spec.md` 본문 ·
  `schemas/evidence.schema.json` description · `scripts/lib/sampling.mjs` 상수 ·
  `fixtures/golden/compute-sampling-golden.mjs` 하드코딩 사본)이 드리프트 가드로 묶여 있다.
- **`fixtures/golden/sampling-300.expected.json`을 수집기 출력으로 덮어쓰지 마라.** 골든은 정본
  리터럴로부터의 **독립 재계산** 결과여야 한다. `fixtures/golden/PROVENANCE.md`에 근거가 있다.
- **`redact.mjs` 패턴을 손댈 때 "40자 hex 커밋 SHA는 마스킹되지 않는다" 단언을 지우지 마라.**
  **정탐 테스트만으로는 오탐 회귀를 절대 못 잡는다.**
- **"현재 픽스처에서 문제가 안 난다"를 회귀 없음의 근거로 쓰지 마라.** 이전 세션 최악의 Critical
  (`T` typechange)이 정확히 그 추론에서 나왔다. **픽스처를 세계로 착각하지 마라.**
- **자기충족 테스트를 만들지 마라.** 이전 세션에서 세 번, **이번 세션에서 한 번 더** 발생했다
  (`coAuthors` 단언이 트레일러 없는 픽스처를 써서 항상 공허하게 참이었다). **새 검사마다 그것이
  실제로 FAIL을 내는 것을 관측하라.** 범용 오류 코드(`SCHEMA_CHECK_VIOLATION`)를 쓰는 케이스는
  코드 일치만 보면 안 되고 위반 메시지 조각까지 단언하라(`messageIncludes`).
- **파괴적 변이 실험을 하는 리뷰 에이전트를 병렬로 돌리지 마라.** 이전 세션에서 두 리뷰어가 서로의
  파일 변조로 간섭했다. 이번 세션은 각 검증자에게 **자기 전용 사본**에서만 변이하도록 지시해
  병렬로 돌렸고 간섭이 없었다 — 병렬을 쓰려면 사본 격리를 프롬프트에 명시하라.
- **도그푸딩 대상 레포 이름을 지어내지 마라.** 미확정이며 사용자가 정해야 한다.
- **원격에 푸시하지 마라** — 사용자가 명시적으로 보류를 선택했다.
- `LICENSE`(MIT)와 `.gitignore`를 수정하지 마라. `package.json`의 `npm test` 배선
  (`run-smoke && --negative && --golden`)을 되돌리지 마라.

## Progress Ledger

| Epic | Slice | Status | Evidence | Notes |
|------|-------|--------|----------|-------|
| devcareer-prep-plugin | slice-a-deterministic-foundation | done | 97675e7b1a9204aa722584d9917d9cde07db89de | 구현 1~6단계 + 콜드 리뷰 T1·T2·P8 반영. 4게이트 녹색(lint 0 / 201 / 19 / 11). T3(설계 재검토 — 타인 커밋 PII, 성능 O(N))·T4(Minor 약 16건) 미반영. 원격 미푸시. |
| devcareer-prep-plugin | slice-b-gate-a-t3-prework | done | 299315b87a9cb827cb7861210debc0a3b4cc5750 | 슬라이스가 아니라 슬라이스 B **착수 전** 스펙·계약 개정. 심사 16건(C4/M8/m4) → 게이트 A·B + T3 반영 → 적대 검증 4렌즈 → 관측 공백 보강. 4게이트 녹색(lint 0 / 257 / 23 / 11). **위 slice-a 행의 Notes는 그 시점 기록이라 T3 미반영으로 남아 있으나, 이 행 이후 T3는 반영됐고 슬라이스 A 파일(schemas·schema-validate·lang-lint·collect-git-facts·tests)도 수정됐다** — slice-a 행의 근거 커밋만 보고 현재 트리를 판단하지 마라. 성능 O(N)과 T4는 여전히 미반영. 도그푸딩 레포 미확정. 원격 미푸시. |

`slice-b-p0-skill-layer`는 행을 두지 않았다 — `Status` enum(`done`/`in-progress`/`blocked`/`dropped`)에
'미착수'가 없어서 어떤 값을 적어도 사실과 어긋난다. 착수 상태는 Next Steps 1번이 정본이다.

## Resume
Run: `/handoff resume docs/handoff/2026-08-18-slice-b-gate-a-t3-prework.md`
