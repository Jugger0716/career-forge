# HANDOFF — DevCareer Prep 슬라이스 A 완료 + 콜드 리뷰 T1·T2 반영

**Date:** 2026-08-18  **Project:** career-forge (devcareer-prep 플러그인)
**Branch:** harness/devcareer-prep-plugin-2  **HEAD:** 97675e7b1a9204aa722584d9917d9cde07db89de — test: wire the advertised fixture oracles, or say plainly they are not wired
**Dirty:** clean  **Upstream:** 없음 (원격 `origin` = github.com/Jugger0716/career-forge. 원격 `main`은 `1c69398`에 머물러 있고 이 브랜치가 9커밋 앞섬 — 푸시하지 않음)

## Goal

개발자의 Git 히스토리를 분석해 경력 기술서 → 지식맵 → 갭 리포트 → 학습·코테 계획을 만드는
Claude Code 플러그인(`devcareer-prep`)을 구축한다. 핵심 가치는 **할루시네이션 방지** —
모든 사실적 주장이 실존하는 커밋 해시나 신뢰 가능한 출처로 뒷받침되어야 하고, 그 검증을
LLM 판단이 아니라 **결정적 스크립트**가 수행한다.

에픽은 `foundation-first` 3슬라이스로 분할됐다: ① 결정적 기반(스크립트·스키마·검증) →
② P0 스킬 계층(LLM) → ③ 확장·공개. 이 세션은 ①을 완료했다.

## Current State (verified)

- **슬라이스 A(구현 1~6단계) 완료** — `npm run lint` exit 0, `npm test` exit 0 (기본 스모크 201 PASS / `--negative` 19 PASS / `--golden` 11 PASS). 오케스트레이터가 직접 실행해 확인.
- **커밋 9개** (`88bbdc9` ~ `97675e7`) — `git log --oneline` 확인. 워킹 트리 클린, 원격 미푸시.
- **수집기가 실물 레포에서 동작** — `career-forge` 자신에 `collect-git-facts.mjs`를 돌려 `traversed=2 total=2 analyzed=2`, `samplingMethod="none:full-scan"`, 루트 커밋 `parents=[]` 산출. `--schema-check` 통과. 직접 실행해 확인.
- **수집기와 골든이 완전 일치** — 300커밋 픽스처에 `--identity owner@devcareer-fixture.test --max-commits 50 --merge-included` 로 실행 시 `coverage 300/250/50`, `dropped 200`, 선택 50개 해시가 `fixtures/golden/sampling-300.expected.json`과 한 건도 다르지 않음. 두 구현은 서로 다른 에이전트가 작성했고 골든 스크립트는 수집기를 참조조차 하지 않는다(작성 시점에 수집기가 없었다). 직접 대조해 확인.
- **변이 매트릭스 12종 전부 탐지** — `M-a`~`M-k` + `M-bd` + `M-g2`. 각 변이를 단독 주입해 4게이트를 돌린 뒤 바이트 동일 복구. 초기에는 5종 중 3종이 전 게이트를 녹색으로 통과했고(`viaMerge` 부여 누락, `--numstat`의 `-z` 제거, 커밋레벨 합계 필터 제거) 그것을 닫는 데 4라운드가 들었다.
- **스펙은 6라운드 적대적 심사를 거쳤다** — 원지적 44건 전량 반증 → 확정 7건에서 시작해 7→10→10→6→4→6건의 신규 결함을 순차 처리, 총 83건. Critical은 6라운드 연속 0건, 재개봉 0건. `plan_critic_findings.md`(round 6판)에 이력 표 보존.
- **앵커 없는 콜드 리뷰 완료** — 5렌즈, 원지적 57건 전량 반증 → 생존 54 → 병합 41건(Critical 5 / Major 20 / Minor 16). `cold_review.md`. **4게이트 녹색 + 변이 12종 전부 탐지 상태에서 Critical 5건이 나왔다** — 변이 테스트는 게이트에 이빨이 있는지를 재지, 코드가 옳은지를 재지 않는다는 것이 실측으로 확인됐다.
- **콜드 리뷰 T1(귀속 정확도·검증 무결성) 반영 완료** — `86b8e81`. 실세계 조건 재현 R1~R9 전부 PASS, 블로커 0건.
- **콜드 리뷰 T2(약속했는데 없는 방어) 반영 완료** — `9e1cdd2`. 실증 P1~P11 중 10건 PASS, P8만 남겼다가 `97675e7`에서 닫음.
- **`typechange`(T) Critical을 오케스트레이터가 직접 재현·확인** — 플럼빙(`git update-index --cacheinfo 120000` → `100644`)으로 리눅스산 레포를 재현. 수정 전 `[오류] 수집 실패 status="T"` + exit 1, 수정 후 exit 0 + `{"changeType":"M","rawChangeType":"T"}` 관측.
- **shallow clone Critical도 직접 확인** — `git clone --depth=1`로 만들어 `isShallowClone: true` 기록 + 경계 커밋 `excluded=true reason=shallow-boundary` 관측. 수정 전에는 그 커밋 1건이 코드베이스 전체를 신규 작성분으로 흡수했다(콜드 리뷰 실측 4.2배 부풀림).

## In Progress

Skill : harness
Task : DevCareer Prep — Claude Code 플러그인 개발 (Git 히스토리 → 경력 기술서 → 지식 갭 분석 → 학습/코테 계획)
Phase : plan_done
Mode : multi
Docs : docs/harness/devcareer-prep-plugin/

**위 `Phase` 값은 현실과 어긋나 있다.** 슬라이스 A 구현이 끝났는데도 harness 위상 기계는
`plan_done`에 멈춰 있다 — 에픽 경로를 택했고, §Step 8의 epic-exit(`.harness/` 삭제)을 실행하지
않은 채 상태를 살려 두고 구현을 이어갔기 때문이다. 이것이 아래 **Do NOT 첫 항목**과 직결된다.

## Blockers / Risks

- **가장 중요 — 구현 7~12단계(LLM 스킬 계층)는 스펙 검토가 0회다.** round 6 리포트가 스스로 적었다:
  *"구현 7~12단계 전반(스킬 3종 SKILL.md·templates, render-markdown.mjs, 사용자 편집 병합, 오프라인
  폴백, 도그푸딩) — 6라운드 내내 정면 검사 0회. 지적 총 83건이 전부 구현 0~6단계에 집중됐다."*
  **슬라이스 B가 정확히 그 영역이다.** 결정적 기반은 6번 두들겨 맞았지만 스킬 계층은 한 번도 검토되지
  않았다.
- **콜드 리뷰 T3·T4 미반영, 약 20건.** 특히:
  - **타인 커밋 PII** (Critical, 설계 재검토) — `excluded` 커밋을 원장에 전량 등재하는 것은
    `AC-7`·`AC-9` 관측 가능성 때문에 **스펙이 의도한 결정**이다. 그런데 동료 이메일·커밋 제목·변경
    경로가 공유 가능한 산출물에 들어가는 문제를 **스펙이 저울에 올린 적이 없다.** 스펙 위반이 아니라
    스펙 구멍이며, 사내 레포에서 돌리는 전제를 감안하면 `spec.md` 개정이 필요하다.
  - **성능** (Major) — `--max-commits` 예산이 실제 작업량을 제한하지 않는다. 순회 전량에 커밋당 git
    프로세스 2회를 스폰해 `O(N)`이다. `O(merges+K)`로 줄이려면 샘플링을 diff 수집 앞으로 옮겨야 한다.
    T1에서 `--since` 조기 절단을 포기한 결과 이 특성이 더 나빠졌다(구현자가 명시적으로 기록).
  - CLI 인자 미검증(실패가 exit 0 성공으로 보고될 수 있음), 산출물 원자성(부분 실패 시
    `evidence.json`과 `git-facts.json`이 서로 다른 실행 결과를 담음), `--storage repo` 옵트인이
    `.gitignore` 추가·경고 없이 PII 파일을 대상 레포에 씀, `%TEMP%` 픽스처 캐시 무한 누적(콜드 리뷰
    관측 25MB / 9,270 파일), `computeSampling`이 모집단 12만 5천 초과 시 `RangeError`.
- **미검사로 남은 영역** — round 5·6이 축소 범위였고 콜드 리뷰도 코드 중심이었다. `cold_review.md`의
  `unInspectedAreas`와 `plan_critic_findings.md`의 동명 절을 참조하라. **"결함 0건"이 "결함 없음"이
  아니라 "보지 않았음"인 영역이 있다.**
- **원격 미푸시** — 로컬 9커밋이 원격에 없다. 사용자가 "아직 푸시 안 함"을 명시적으로 선택했다
  (public 레포이고 슬라이스 B·C가 남은 미완성 상태이므로).
- **세션 한도 중단이 이 세션에서 5회 발생했다.** 워크플로를 3~5에이전트 조각으로 나누고 각 조각
  사이에 오케스트레이터가 직접 게이트를 확인하는 방식이 손실을 실제로 줄였다. 큰 한 덩어리로 돌리면
  중단 시 전부 날아간다. 중단 후에는 **부분 쓰기가 완성품인지 준비물인지 판별**해야 한다 — 준비물만
  남은 경우(예: import만 추가되고 단언 0개) 되돌리는 편이 낫다. `grep`이 "참조됨"으로 보고해 공백을
  가리기 때문이다.

## Next Steps

1. **슬라이스 B 착수 전에 그 영역의 스펙 검토를 먼저 하라.** 구현 7~12단계가 6라운드 동안 한 번도
   검토되지 않았으므로, 코드를 쓰기 전에 `spec.md`의 해당 단계를 적대적으로 심사하는 것이 슬라이스
   A에서 배운 순서다(검증 하네스를 스킬보다 먼저 — 같은 원리). 슬라이스 A는 스펙 심사 6라운드 후에도
   콜드 리뷰에서 Critical 5건이 나왔다.
2. 슬라이스 B 실행 — `slice_plan.md`의 해당 행 `Command`:
   `/harness "slice-b-p0-skill-layer" --output-dir docs/harness/devcareer-prep-plugin`
   (구현 7~10단계: `/devcareer-prep:career-from-git`, `/devcareer-prep:skill-gap`(자가진단 한정),
   오염 주입 스위트 40건, Phase 1 도그푸딩)
3. **선택지 — 슬라이스 B 전에 도그푸딩을 먼저 할 수도 있다.** 슬라이스 A만으로도
   `collect-git-facts` + `verify-evidence`는 실제 레포에서 동작한다. 사용자 실제 작업 레포에 돌려
   증거 원장이 쓸 만한지, 저자 정체성 게이트·볼륨 통제가 현실에서 맞는지를 스킬 계층을 만들기 **전에**
   알 수 있다. 계획 단계에서 이미 "도그푸딩을 Phase 4에서 Phase 1 직후로 당기라"고 수정됐다.
4. T3 설계 재검토(타인 커밋 PII)는 `spec.md` 개정을 동반하므로 슬라이스 B 스킬 설계와 함께 다루는
   것이 자연스럽다 — 스킬이 산출물을 사용자에게 보여주는 주체이기 때문이다.

## Definition of Done

**에픽 전체**: `slice_plan.md`의 3슬라이스가 모두 완료되고, 사용자 본인 Git 히스토리로 생성한 경력
기술서가 "이 정도면 실제로 쓸 수 있다" 수준이며, 갭 분석이 "공감되고 우선순위가 명확하다"고 느껴지고,
생성된 코테 문제가 실제 경력과 논리적으로 연결되며, 할루시네이션으로 인한 잘못된 지식 설명이 거의
없는 상태.

**슬라이스 B 단독**: `/devcareer-prep:career-from-git`과 `/devcareer-prep:skill-gap`이 동작하고,
오염 주입 스위트 40건이 `AC-8` 기준(기계 검증 3종은 3회 모두 100%, LLM 판정 1종은 3회 최저값 80%
이상)을 만족하며, 4게이트가 녹색인 상태.

## Reading Order

1. `docs/harness/handoff/2026-08-18-devcareer-prep-slice-a-complete.md` — 이 문서. 현재 위치와 남은 것.
2. `docs/harness/devcareer-prep-plugin/slice_plan.md` — 3슬라이스 분할과 각 슬라이스의 실행 명령.
3. `docs/harness/devcareer-prep-plugin/cold_review.md` — 콜드 리뷰 41건. `confidenceBasis`별로 섹션이 나뉘어 있다. T1·T2·P8로 닫힌 것과 남은 T3·T4를 구분해 읽어라.
4. `docs/harness/devcareer-prep-plugin/plan_critic_findings.md` — round 6 critic 리포트. **맨 앞 carry-over 체크리스트와 `unInspectedAreas` 목록이 핵심**이다. 슬라이스 B가 미검사 영역임을 여기서 확인하라.
5. `docs/harness/devcareer-prep-plugin/spec.md` — 실행 스펙 정본(22 AC / 12 구현단계). 슬라이스 B는 구현 7~10단계.
6. `scripts/collect-git-facts.mjs` + `scripts/lib/git.mjs` — 증거 원장을 만드는 주체. 슬라이스 B의 스킬은 이 산출물을 **소비만** 한다.
7. `scripts/verify-evidence.mjs` — 인용 무결성 집행 코드. 스킬이 만든 산출물이 이것을 통과해야 한다.
8. `README.md` — 현재 무엇이 되고 무엇이 안 되는지(스킬 계층 부재를 명시하고 있다).

## Do NOT

- **인자 없이 `/harness`를 실행하지 마라.** `state.json`이 `phase: plan_done` + `epic.boundaries` non-null이고, 이 조합이 harness의 **epic-exit 술어**다 — §Step 8 epic-exit 경로로 가서 **`.harness/`를 삭제한다.** 슬라이스 B를 시작할 때는 `slice_plan.md`의 명시적 `Command`(Next Steps 2번)를 쓰라.
- **`samplingMethod` 정본 리터럴을 한 곳만 고치지 마라.** 네 곳(`spec.md` 본문 · `schemas/evidence.schema.json` description · `scripts/lib/sampling.mjs` 상수 · `fixtures/golden/compute-sampling-golden.mjs` 하드코딩 사본)이 드리프트 가드로 묶여 있다.
- **`fixtures/golden/sampling-300.expected.json`을 수집기 출력으로 덮어쓰지 마라.** 골든은 정본 리터럴로부터의 **독립 재계산** 결과여야 한다. 수집기 출력을 스냅샷으로 쓰면 잘못 구현된 수집기가 스스로를 승인한다. `fixtures/golden/PROVENANCE.md`에 근거가 있다.
- **`excluded` 커밋의 원장 전량 등재를 프라이버시 이유로 되돌리지 마라.** `AC-7`·`AC-9`의 절단 실행 관측 가능성이 여기 걸려 있다. PII 문제는 별도 설계 재검토 사안이며 스펙 개정을 동반해야 한다.
- **`redact.mjs` 패턴을 손댈 때 "40자 hex 커밋 SHA는 마스킹되지 않는다" 단언을 지우지 마라.** 이 도구의 산출물은 커밋 해시로 가득하고, AWS 시크릿 키 패턴이 그것을 오탐해 파괴한 이력이 있다. **정탐 테스트만으로는 오탐 회귀를 절대 못 잡는다.**
- **"현재 픽스처에서 문제가 안 난다"를 회귀 없음의 근거로 쓰지 마라.** 이 세션 최악의 Critical(`T` typechange)이 정확히 그 추론에서 나왔다 — 픽스처에 `T`가 없었을 뿐인데 "회귀 없음"으로 결론지었다. **픽스처를 세계로 착각하지 마라.** 실세계 조건을 재현하는 픽스처를 만들어라.
- **자기충족 테스트를 만들지 마라.** 이 세션에서 세 번 발생했다 — 판별력 0인 positive 픽스처(전 값이 4토큰 미만이라 임계에 안 걸림), 합성 페이로드만 파서에 먹이는 `-z` 가드(호출자의 변이를 탐지 불가), 정렬 축만 덮고 파생식은 못 덮은 `computeSampling` 단위 테스트. **새 검사마다 그것이 실제로 FAIL을 내는 것을 관측하라.**
- **파괴적 변이 실험을 하는 리뷰 에이전트를 병렬로 돌리지 마라.** 이 세션에서 두 리뷰어를 병렬로 돌려 서로의 파일 변조가 간섭했다(한쪽이 "제3의 프로세스가 `git.mjs`를 반복 변조"로 감지). 순차로만.
- **원격에 푸시하지 마라** — 사용자가 명시적으로 보류를 선택했다. public 레포이고 슬라이스 B·C가 미완이다.
- `LICENSE`(MIT)와 `.gitignore`를 수정하지 마라. `package.json`의 `npm test` 배선(`run-smoke && --negative && --golden`)을 되돌리지 마라.

## Progress Ledger

| Epic | Slice | Status | Evidence | Notes |
|------|-------|--------|----------|-------|
| devcareer-prep-plugin | slice-a-deterministic-foundation | done | 97675e7b1a9204aa722584d9917d9cde07db89de | 구현 1~6단계 + 콜드 리뷰 T1·T2·P8 반영. 4게이트 녹색(lint 0 / 201 / 19 / 11). T3(설계 재검토 — 타인 커밋 PII, 성능 O(N))·T4(Minor 약 16건) 미반영. 원격 미푸시. |

## Resume
Run: `/handoff resume docs/harness/handoff/2026-08-18-devcareer-prep-slice-a-complete.md`
