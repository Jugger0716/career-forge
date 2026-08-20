# HANDOFF — 슬라이스 B: 슬라이스 A 파일 수정 예외 전량 종료 (게이트 B·C + 스키마)

**Date:** 2026-08-19  **Project:** career-forge (devcareer-prep 플러그인)
**Branch:** harness/devcareer-prep-plugin-2  **HEAD:** fb1e32d9e2327cd614f0e069ed0d10c262750045 — feat(store): single atomic-write implementation and a state/config IO contract
**Dirty:** clean  **Upstream:** 없음 (원격 `origin` = github.com/Jugger0716/career-forge. 이 브랜치가 원격 `main`보다 **20커밋** 앞섬 — 푸시하지 않음)

## Goal

개발자의 Git 히스토리를 분석해 경력 기술서 → 지식맵 → 갭 리포트 → 학습·코테 계획을 만드는
Claude Code 플러그인(`devcareer-prep`)을 구축한다. 핵심 가치는 **할루시네이션 방지** — 모든 사실적
주장이 실존하는 커밋 해시나 신뢰 가능한 출처로 뒷받침되어야 하고, 그 검증을 LLM 판단이 아니라
**결정적 스크립트**가 수행한다.

에픽은 `foundation-first` 3슬라이스로 분할됐다: ① 결정적 기반 → ② P0 스킬 계층(LLM) → ③ 확장·공개.
①은 완료됐다. **이 세션은 ②(슬라이스 B)를 실제로 시작했고**, 그중 「슬라이스 A 파일을 건드리는
작업」 전량을 끝냈다. 남은 것은 신규 파일만 만지는 구간이다.

## Current State (verified)

- **커밋 4개** — `38c337f`(게이트 C-1) → `ef9aedf`(게이트 C-2) → `5f71c32`(스키마 external) →
  `fb1e32d`(게이트 B-1·B-2). `git log --oneline 299315b..HEAD`로 확인. 워킹 트리 클린, 원격 미푸시.
- **4게이트 녹색** — `npm run lint` exit 0 / 스모크 **320 PASS** / `--negative` **27 PASS** /
  `--golden` **11 PASS**. 오케스트레이터가 직접 실행해 확인(세션 시작 시점은 0/257/23/11이었다).
- **`/harness` 상태 기계를 버리고 직접 구현 방식으로 전환했다(사용자 결정).** 근거는 실측이다:
  `changes.md`·`verify_report.md`·`qa_report.md`·`qa_notes.md`·`conventions.md`가
  `docs/devcareer-prep-plugin/`에 **레포 역사상 한 번도 커밋된 적이 없고**(`git log --all
  --diff-filter=A` 전건 공집합), `docs/`는 gitignore 대상도 아니다. 즉 슬라이스 A 11커밋 전체가
  이미 상태 기계 밖에서 손으로 진행됐다 — 방식을 바꾼 것이 아니라 하던 것을 계속하는 것이다.
- **`.harness/`를 삭제했다(사용자 지시).** `state.json`은 2026-08-13 에픽 계획 세션 기록이었고
  `phase: plan_done`에 멈춰 있었다. 삭제 전 `.harness/conventions.md`(70줄)를
  `docs/devcareer-prep-plugin/conventions.md`로 **보존**했다 — 이 레포에 `CLAUDE.md`가
  없어 사본이 어디에도 없었다. `proposals.json`·`scale_signals.json`은 Plan 단계 중간 산출물이라
  버렸다(결과는 `spec.md`·`plan_critic_findings.md`에 반영돼 있다).
- **게이트 C-1 닫힘** — `scripts/lib/secret-scan.mjs`(신규) + `validate-plugin.mjs --secret-scan`
  (`ARTIFACT_SECRET_LEAK`). 면제를 **(필드 × 패턴) 단위**로 좁게 준다: `format: email` 경로에서
  **값 전체가 단일 이메일일 때만** `email` 히트를 면제하고 나머지 패턴은 그대로 발화한다.
  negative 케이스 (23)은 `--schema-check`·`--lang-check` 둘 다 통과하고 이것만 잡는다(실측).
- **게이트 C-2 닫힘** — `references/sources.json`(신규 정본) + `verify-evidence.mjs`의 **(f)축**
  `checkExternalSources`. 대조는 문자열 prefix가 아니라 **origin 정확 일치 + pathname prefix +
  https 강제**다. allow-list를 못 읽어도 external 노드가 0건이면 무해하고 1건이라도 있으면 위반
  (fail-closed 양방향 관측). `summary.externalSourcesChecked`를 함께 보고한다 — 위반 0건이
  "통과"인지 "검사 대상 0건"인지 구별하기 위해서다(현재는 실제로 후자다).
- **스키마 수정: `basis: "external"`을 표현 가능하게 만들었다(예외 4번, 사용자 승인).** (f)축을
  만들고 나서 그 검사 대상을 만들어 보려 했더니 **어느 계층에서도 만들 수 없었다** — career·
  gap-report·plan은 `externalUrl`을 담을 자리가 없고(`additionalProperties: false`), 네 계층 모두
  「`evidence`가 비면 `basis`는 `insufficient`」 조건절에 `external` 예외가 없었다. 세 계층에
  `externalUrl` + 조건절을 넣고, 네 계층의 조건절을 `["insufficient","external"]`로 완화했다.
- **게이트 B-1·B-2 닫힘** — `writeJsonAtomic`을 `collect-git-facts.mjs`의 비공개 함수에서
  `store.mjs`로 추출하고, `readState`/`writeState`/`readConfig`/`writeConfig` +
  `toStorageRelative`/`fromStorageRelative`를 추가했다. 상대경로는 **항상 POSIX 구분자**를 쓰고
  루트 밖 탈출을 거부한다. 읽기는 부재·손상 모두 **예외를 던지지 않고** `{found, value, error}`로
  보고한다(구현 8단계의 "예외 중단 없이 정상 종료" 요구).
- **모든 신규 검사를 절 단위 변이로 관측했다** — 게이트 C-1 변이 7종(M1~M5·M7·M9), 게이트 C-2
  변이 8종(A~H), 스키마 변이 4종(P~S), store IO 변이 5종(T~X). 각 변이가 **대응하는 단언만**
  FAIL함을 실측했고, 원복 후 전량 PASS를 확인했다.

### 관측이 실제로 잡아낸 것 4건 (전부 "닫았다"고 보고할 뻔한 것들)

1. **시크릿 스캔 단언 2건이 공허했다.** 픽스처가 변이 지점이 있는 분기에 애초에 진입하지 않았다 —
   `format:email` 면제 분기를 검사한다면서 이메일이 아닌 값을 넣었고, 경로 단위 면제를 검사한다면서
   `isSingleEmail`이 거짓인 값을 넣었다. 두 변이 모두에서 FAIL 0건이 나와 드러났다.
2. **`basis: "external"`이 네 계층 어디서도 표현 불가였다.** 그대로 뒀다면 (f)축은 영원히 대상
   0건인 검사가 되고, 구현 8단계에서 KnowledgeMapper가 external 노드를 만들려는 순간 막힌다.
3. **추출은 동작 테스트로 관측할 수 없다.** 수집기에 `writeJsonAtomic` 사본이 남아 있어도 모든
   기능 단언이 통과한다. 소스 스캔 단언 2건을 넣고 사본을 되살리는 변이로 확인했다.
4. **무예외 계약이 섹션 abort로만 잡혔다.** 던지는 변이에서 섹션 전체가 중단돼 나머지 단언이
   실행되지 않았고, 실패가 아무 이름도 달지 않았다. try/catch로 감싼 겨냥 단언으로 바꿨다.

## In Progress

**`.harness/state.json`이 없다 — 이것은 결함이 아니라 이 세션의 결정이다.** 따라서 `/harness`
위상 기계·`Skill`/`Task`/`Phase`/`Mode`/`Docs` 고정 라벨 기록이 이 문서에 없다. `/handoff resume`의
Step 3.5 축소 검사가 "legacy handoff — task state not machine-verifiable"로 보고할 텐데, 그것이
정상이다.

이 세션에서 진행 중이던 것은 없다. 예외 3건 + 스키마 수정을 끝내고 4게이트 녹색·워킹 트리 클린
상태에서 정지했다.

## Blockers / Risks

- **도그푸딩 대상 레포가 미확정이다 — 사용자 결정이 필요하다.** 200커밋 이상·다중 저자·한글 커밋
  메시지가 있는 실제 레포가 필요하다. 구현 10단계에 "착수 전 확정 — 현재 미확정"으로만 적혀 있고
  이름을 지어내지 않았다. **이 단계가 타인 PII가 픽스처가 아니라 실물로 처음 흐르는 지점**이다.
- **(f)축의 잔여 위험 — 기계가 아니라 LLM 판정에 의존하는 구간이 생겼다.** allow-list 대조는 URL이
  **목록 소속인지만** 확인한다. 그 URL이 실제로 존재하는지·서술을 뒷받침하는지는 검사하지 않는다
  (네트워크 접근은 AC-1 「의존성 0」·오프라인 전제에 걸린다). 따라서 LLM이 allow-list 안의 아무
  URL이나 붙여 `insufficient` 강등을 회피할 수 있고, 그것을 막는 것은 2단 팩트체크(`verification`,
  구현 8단계 (d))뿐이다. `slice_plan.md` 예외 4번 근거 절과 스키마 description에 같은 문장을 적어
  뒀다. **이 제품의 핵심 명제와 정면으로 긴장하는 지점이므로 감추지 마라.**
- **스펙에만 적히고 코드는 없는 항목이 남아 있다** — C-1(오염 스위트 실행 모델), M-3(노드 id 재사용),
  M-4(`.bak`), M-6(쓰기 직전 자기 검증), m-1(`state.artifacts.evidence`를 쓰는 주체), m-2, m-3.
  **M-1·M-5·C-2는 이 세션에서 코드로 닫혔다** — `slice_b_spec_review.md`의 '반영 현황' 절과 게이트
  체크리스트가 그 구분을 갱신해 두었다.
- **`verify-evidence`의 "인용 0건 = PASS" fail-open은 손대지 않았다**(콜드 리뷰 B-1, 게이트 C-5).
  T4 반영과 같은 회차에 처리하는 것이 싸다.
- **`origin`·`verification` 기입 주체 규약에 집행 코드가 없다** — 스키마 description과 AC의 산문뿐.
  LLM이 스스로 `origin: "user"`를 적으면 언어 린트 자기면제가 되고, `verification: {status:
  "verified"}`를 적으면 2단 팩트체크를 자기 선언으로 우회한다. **구현 7단계에서 병합 로직을 만들 때
  정적 린트로 승격할지 판단해야 한다 — 그 시점이 마감이다.**
- **콜드 리뷰 T4(Minor 약 16건)는 여전히 미반영**이며 중복 제거도 되지 않았다.
- **미검사로 남은 영역** — `cold_review.md`의 `unInspectedAreas`와 `plan_critic_findings.md`의 동명
  절. **"결함 0건"이 "결함 없음"이 아니라 "보지 않았음"인 영역이 있다.**
- **원격 미푸시** — 로컬 20커밋이 원격에 없다. 사용자가 명시적으로 보류를 선택했다(public 레포이고
  슬라이스 B·C가 미완이다).

## Next Steps

1. **구현 7단계 — 결정적 부분을 먼저 만든다.** 순서가 중요하다: ① `scripts/render-markdown.mjs`
   (JSON → 사용자 대면 `.md`)와 그 **렌더 계약 검사**를 먼저 세운다 — 커버리지 3수치·`truncated`·
   `basis`·`verification.status`에서 파생한 '근거 부족 — 미검증' 배지가 출력에 실재하는지를 검사
   1건으로 관측한다(구현 7단계 렌더 계약). ② `store.mjs`에 `projectLedgerForSkills(evidence)`
   (`excluded: false` 커밋만 남긴 얕은 사본). ③ 그 뒤에 `skills/career-from-git/SKILL.md` +
   `templates/career-writer.md` + `templates/fact-checker.md`. **"하네스를 먼저"** — 프롬프트는
   기계 검증이 얇으므로 그 앞에 결정적 게이트를 세운다.
2. **구현 8단계** — `skills/skill-gap/` (SKILL.md + `knowledge-mapper.md` + `gap-analyzer.md`).
   여기서 (f)축이 처음으로 대상을 갖는다. 구현 8단계 (d)의 「L2·L3에서 `verification`이 무엇을
   반증하는가」 정의를 프롬프트에 실제로 반영해야 잔여 위험이 줄어든다.
3. **구현 9단계 착수 전에 C-1(오염 스위트 실행 모델)을 스펙에 명문화하라.** 스킬 실행 3회는 사람이
   수행해 산출물을 `tests/contamination/runs/<run-id>/`에 남기고 `--contamination`은 채점만 한다 —
   그 절차를 `tests/contamination/README.md`에 고정한다. **게이트 C-1·C-2는 이미 닫혔으므로
   마스킹 우회 10건과 allow-list 축은 채점할 REJECT 사유를 갖고 있다.**
4. **구현 10단계 착수 전에 도그푸딩 대상 레포를 확정해 `spec.md` 구현 10단계에 기재하라.**
5. 콜드 리뷰 T4(약 16건)와 게이트 C-5(fail-open)를 한 회차로 묶어 처리하는 것을 검토하라 — 둘 다
   `verify-evidence.mjs`를 건드린다.

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
- **완화(제약을 넓히는 변경)는 허용 방향도 관측한다.** 금지 방향만 보면 완화를 통째로 되돌려도
  아무 단언이 깨지지 않는다 — 슬라이스 A의 `coAuthors` 축소가 그렇게 미관측으로 남았다.
- **구조적 변경(추출·단일화)은 소스 스캔으로 관측한다.** 동작 테스트는 사본이 남아 있어도 통과한다.

## Reading Order

1. `docs/handoff/2026-08-19-slice-b-exceptions-closed.md` — 이 문서. 현재 위치와 남은 것.
2. `docs/devcareer-prep-plugin/slice_b_spec_review.md` — 심사 16건 + 맨 앞 '반영 현황' 절 +
   뒤쪽 **'착수 전 게이트 체크리스트'**(B-1·B-2·C-1·C-2가 `[x]`로 닫혔고 각각 무엇으로 닫혔는지
   기록돼 있다) + **'게이트 C-2 후속 — external basis의 표현 불가 문제'** 절.
3. `docs/devcareer-prep-plugin/slice_plan.md` — 3슬라이스 분할과 **슬라이스 A 파일 수정
   예외 4건**(4번은 이 세션에서 추가됐고 근거·관측·잔여 위험이 함께 적혀 있다). **예외 4건은 모두
   소비됐다 — 이후 슬라이스 A 파일 수정은 금지다.**
4. `docs/devcareer-prep-plugin/spec.md` — 실행 스펙 정본(22 AC / 12 구현단계). 슬라이스 B는
   구현 7~10단계. 구현 7단계 (a)~(g)와 8단계 (a)~(d)가 다음 작업의 지시서다.
5. `scripts/lib/secret-scan.mjs` — 게이트 C-1. 머리말이 "왜 전부 스캔이 틀렸고 왜 marker-only도
   틀렸는가"를 적고 있다. 새 검사기를 설계할 때 참고할 판단 구조다.
6. `scripts/verify-evidence.mjs`의 `checkExternalSources`/`matchesAllowlist` — 게이트 C-2 (f)축.
7. `scripts/lib/store.mjs` 하단 「원자적 쓰기 + state/config IO 계약」 — 구현 7·8단계가 소비할 API.
8. `tests/run-smoke.mjs`의 `runSecretScanOracleSmoke`·`runExternalSourceOracleSmoke`·
   `runStoreIoContractSmoke`·`runSchemaClauseOracleSmoke` — 절 단위 오라클 패턴 4종. **새 제약을
   넣을 때 이 표들에 행을 추가하는 것이 가장 싼 관측 방법이다.**
9. `docs/devcareer-prep-plugin/cold_review.md` / `plan_critic_findings.md` — 남은 T4와
   `unInspectedAreas`.
10. `docs/devcareer-prep-plugin/conventions.md` — 이 세션에 `.harness/`에서 보존한 규약
    문서(70줄). 이 레포엔 `CLAUDE.md`가 없다 — 필요하면 레포 루트 `CLAUDE.md`로 승격을 검토하라.

## Do NOT

- **`/harness`를 쓰지 마라 — 이 프로젝트는 상태 기계 밖에서 진행한다(사용자 결정).** `.harness/`가
  없으므로 `/harness generate` 같은 단계 진입은 `Run plan first`로 막히고, `slice_plan.md`의
  `Command`를 그대로 실행하면 **Plan 단계부터 새로 돌아 기존 `spec.md`와 별개의 스펙이 생긴다.**
- **새 검사를 넣고 "영역당 한 번" 변이로 관측했다고 보고하지 마라.** 절 단위로 하나씩 지워보고
  **대응하는 단언만** FAIL하는지 확인하라.
- **조건부 로직을 검사할 때 진입 조건을 만족하지 않는 픽스처를 쓰지 마라.** 이 세션에서 정확히 그
  실수를 두 번 했다 — 변이 지점이 분기 **안**에 있으면, 그 분기에 못 들어가는 픽스처의 단언은
  변이에도 통과한다(공허하게 참).
- **단언을 전체 위반 수(`length === 0`)로 쓰지 마라.** 같은 인스턴스의 무관한 필드가 오염원이 되어
  상관없는 변이에서도 함께 깨진다. **겨냥한 경로의 위반만** 보라.
- **완화(제약을 넓히는 변경)를 금지 방향만 관측하고 넘어가지 마라.** 허용 방향 단언이 없으면 완화를
  통째로 되돌려도 아무도 모른다.
- **구조적 변경을 동작 테스트로만 관측하지 마라.** 추출·단일화는 사본이 남아 있어도 기능 단언이
  전부 통과한다 — 소스 스캔 단언을 함께 두라.
- **`slice_plan.md`의 예외 4건 밖에서 슬라이스 A 파일을 수정하지 마라. 4건은 모두 소비됐다.**
- **`redact.mjs`·`schema-validate.mjs`·`lang-lint.mjs`를 수정하지 마라** — 예외 목록에 없다.
  `secret-scan.mjs`가 `FULL_EMAIL_RE`를 복제해 갖고 있는 것도 그 때문이며, 드리프트는 오라클이
  관측한다.
- **`--secret-scan`의 면제를 필드 단위로 넓히지 마라.** `format: email` 경로라도 email 패턴 하나만
  면제되고 나머지는 발화해야 한다. 값 전체가 단일 이메일일 때만 면제한다는 조건도 지워선 안 된다.
- **allow-list 대조를 문자열 prefix로 바꾸지 마라.** `https://developer.mozilla.org.evil.com/`이
  통과한다. origin 정확 일치 + pathname prefix + https 강제가 세트다.
- **조건부 제약을 최상위 `if/then`이나 `anyOf`로 쓰지 마라** — 이 레포의 관례는 `allOf` 원소다.
- **`excluded` 커밋의 원장 전량 등재를 되돌리지 마라. T3의 PII 3필드 축소도 되돌리지 마라.**
- **`samplingMethod` 정본 리터럴을 한 곳만 고치지 마라**(4곳이 드리프트 가드로 묶여 있다).
- **`fixtures/golden/sampling-300.expected.json`을 수집기 출력으로 덮어쓰지 마라.**
- **`redact.mjs` 패턴을 손댈 때 "40자 hex 커밋 SHA는 마스킹되지 않는다" 단언을 지우지 마라.**
  **정탐 테스트만으로는 오탐 회귀를 절대 못 잡는다.**
- **"현재 픽스처에서 문제가 안 난다"를 회귀 없음의 근거로 쓰지 마라. 픽스처를 세계로 착각하지 마라.**
- **자기충족 테스트를 만들지 마라.** 범용 오류 코드를 쓰는 케이스는 코드 일치만 보지 말고 위반
  메시지 조각까지 단언하라(`messageIncludes`).
- **파괴적 변이 실험을 하는 리뷰 에이전트를 병렬로 돌리려면 사본 격리를 프롬프트에 명시하라.**
- **도그푸딩 대상 레포 이름을 지어내지 마라.** 미확정이며 사용자가 정해야 한다.
- **원격에 푸시하지 마라** — 사용자가 명시적으로 보류를 선택했다.
- `LICENSE`(MIT)와 `.gitignore`를 수정하지 마라. `package.json`의 `npm test` 배선을 되돌리지 마라.
- **PowerShell here-string(`@'...'@`)을 Bash 도구에 쓰지 마라.** 이 세션에서 커밋 메시지가 한 번
  깨졌다. 긴 메시지는 파일에 쓰고 `git commit -F <file>`로 넘겨라.

## Progress Ledger

| Epic | Slice | Status | Evidence | Notes |
|------|-------|--------|----------|-------|
| devcareer-prep-plugin | slice-a-deterministic-foundation | done | 97675e7b1a9204aa722584d9917d9cde07db89de | 구현 1~6단계 + 콜드 리뷰 T1·T2·P8 반영. 4게이트 녹색(lint 0 / 201 / 19 / 11). T3(설계 재검토 — 타인 커밋 PII, 성능 O(N))·T4(Minor 약 16건) 미반영. 원격 미푸시. |
| devcareer-prep-plugin | slice-b-gate-a-t3-prework | done | 299315b87a9cb827cb7861210debc0a3b4cc5750 | 슬라이스가 아니라 슬라이스 B **착수 전** 스펙·계약 개정. 심사 16건(C4/M8/m4) → 게이트 A·B + T3 반영 → 적대 검증 4렌즈 → 관측 공백 보강. 4게이트 녹색(lint 0 / 257 / 23 / 11). **위 slice-a 행의 Notes는 그 시점 기록이라 T3 미반영으로 남아 있으나, 이 행 이후 T3는 반영됐고 슬라이스 A 파일도 수정됐다** — slice-a 행의 근거 커밋만 보고 현재 트리를 판단하지 마라. 성능 O(N)과 T4는 여전히 미반영. 도그푸딩 레포 미확정. 원격 미푸시. |
| devcareer-prep-plugin | slice-b-p0-skill-layer | in-progress | fb1e32d9e2327cd614f0e069ed0d10c262750045 | **슬라이스 B 착수함.** 「슬라이스 A 파일 수정 예외」 전량 종료 — 게이트 C-1(`--secret-scan`), C-2(allow-list (f)축), B-1·B-2(`writeJsonAtomic` 추출 + state/config IO 계약), 그리고 예외 4번으로 승인받은 스키마 수정(`basis:"external"` 표현 가능화). 4게이트 녹색(lint 0 / **320** / 27 / 11). 신규 검사 전량을 절 단위 변이(24종)로 관측했고 대응 단언만 FAIL함을 실측. **미착수: 구현 7~10단계 본체**(render-markdown·`projectLedgerForSkills`·skills 2종·오염 스위트·도그푸딩). `.harness/`는 삭제됐고 이 프로젝트는 `/harness` 상태 기계 밖에서 진행한다. **(f)축은 아직 대상 0건**이며 잔여 위험(allow-list 소속만 검사)이 열려 있다. T4·게이트 C-5·도그푸딩 레포 미확정은 그대로. 원격 미푸시(20커밋). |

## Resume
Run: `/handoff resume docs/handoff/2026-08-19-slice-b-exceptions-closed.md`
